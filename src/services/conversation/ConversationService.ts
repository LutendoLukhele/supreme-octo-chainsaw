// src/services/conversation/ConversationService.ts

import { EventEmitter } from 'events';
import Groq, { GroqError,  } from 'groq-sdk';
import winston from 'winston';
import { v4 as uuidv4 } from 'uuid';
import { ConversationConfig, Message, MessageType, ToolResult } from './types';
import { ToolConfigManager } from '../tool/ToolConfigManager';
import { MarkdownStreamParser } from '@lixpi/markdown-stream-parser';
import { StreamChunk } from '../stream/types';
import { MAIN_CONVERSATIONAL_SYSTEM_PROMPT_TEMPLATE } from './prompts/mainConversationalPrompt';
import { DEDICATED_TOOL_CALL_SYSTEM_PROMPT_TEMPLATE } from './prompts/dedicatedToolCallPrompt';

// Interfaces remain the same
interface LixpiParsedSegment { 
    status: 'STREAMING' | 'END_STREAM' | string;
    segment?: { segment: string; styles: string[]; type: string; };
}
interface ConversationalStreamResult {
    text: string;
    hasToolCalls: boolean;
}

interface ToolCallStreamResult {
    hasToolCalls: boolean;
}
export interface ProcessedMessageResult {
    toolCalls: boolean;
    aggregatedToolCalls: Array<{ name: string; arguments: Record<string, any>; id?: string; function: any; streamType: string; }>;
    conversationalResponse: string;
}

const PLANNER_META_TOOL = {
    type: "function" as const,
    function: {
        name: "planParallelActions",
        description: "Use this when a user's request is complex and requires multiple steps or actions to be planned. This triggers the main planning process.",
        parameters: {
            type: "object" as const,
            properties: {
                userInput: { type: "string" as const, description: "The original, full text of the user's complex request." },
                preliminaryToolCalls: {
                    type: "array" as const,
                    description: "A list of potential tool calls already identified.",
                    items: { "type": "object" as const }
                }
            },
            required: ["userInput"]
        }
    }
};

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
    transports: [new winston.transports.Console()],
});

const KEYWORD_TO_CATEGORY_MAP: Record<string, string> = {
    'email': 'Email',
    'emails': 'Email',
    'send': 'Email',
    'calendar': 'Calendar',
    'event': 'Calendar',
    'meeting': 'Calendar',
    'schedule': 'Calendar',
    'salesforce': 'CRM',
    'deal': 'CRM',
    'contact': 'CRM',
    'account': 'CRM',
    'lead': 'CRM'
};

function getRelevantToolCategories(userInput: string): string[] {
    const detectedCategories = new Set<string>();
    const lowerInput = userInput.toLowerCase();
    for (const keyword in KEYWORD_TO_CATEGORY_MAP) {
        if (lowerInput.includes(keyword)) {
            detectedCategories.add(KEYWORD_TO_CATEGORY_MAP[keyword]);
        }
    }
    return detectedCategories.size > 0 ? Array.from(detectedCategories) : ['Email', 'Calendar', 'CRM'];
}
export class ConversationService extends EventEmitter {
    private client: Groq;
    private model: string;
    private maxTokens: number;
    private conversationHistory: Map<string, Message[]> = new Map();
    private toolConfigManager: ToolConfigManager;

    constructor(private config: ConversationConfig) {
        super();
        if (!config.groqApiKey) throw new Error("Groq API key is missing.");
        this.client = new Groq({ apiKey: config.groqApiKey });
        this.model = config.model;
        this.maxTokens = config.maxTokens;
        this.toolConfigManager = new ToolConfigManager();
    }

    public async processMessageAndAggregateResults(
        userMessage: string | null, 
        sessionId: string,
        incomingMessageId?: string,
        _userId?: string
    ): Promise<ProcessedMessageResult> {
        const messageProcessingId = uuidv4();
        const currentMessageId = incomingMessageId || uuidv4();
        logger.info('Processing message, will aggregate results', { sessionId });

        const history = this.getHistory(sessionId);
        // Only add a user message to history if one was provided.
        if (userMessage) {
            history.push({ role: 'user', content: userMessage });
            this.conversationHistory.set(sessionId, history);
        }

        const relevantCategories = getRelevantToolCategories(userMessage || history.at(-1)?.content || '');
        const filteredToolConfigs = this.toolConfigManager.getToolsByCategories(relevantCategories);
        const filteredGroqTools = filteredToolConfigs.map(tool => {
            const inputSchema = this.toolConfigManager.getToolInputSchema(tool.name);
            if (!inputSchema) {
                logger.warn(`Skipping Groq definition for ${tool.name}: No input schema found.`);
                return null;
            }
            return {
                type: "function" as const,
                function: { name: tool.name, description: tool.description, parameters: inputSchema }
            };
        }).filter(Boolean);

        const initialUserQuery = history.find(m => m.role === 'user')?.content || userMessage || '';
        const aggregatedToolCallsOutput: ProcessedMessageResult['aggregatedToolCalls'] = [];

        let conversationalResponseText = "";
        
        const conversationalStreamPromise = this.runConversationalStream(
            userMessage || '', initialUserQuery, sessionId, currentMessageId,
            messageProcessingId, filteredGroqTools as any, [...history], aggregatedToolCallsOutput
        ).then(result => {
            conversationalResponseText = result.text;
        });
        
        const toolCallStreamPromise = this.runToolCallStream(
            userMessage, sessionId, currentMessageId, messageProcessingId,
            [...history], aggregatedToolCallsOutput, filteredGroqTools as any
        );
        
        await Promise.allSettled([conversationalStreamPromise, toolCallStreamPromise]);

        logger.info('All ConversationService streams have settled.', {
            sessionId,
            totalToolCalls: aggregatedToolCallsOutput.length,
            conversationalResponseLength: conversationalResponseText.length
        });

        return {
            toolCalls: aggregatedToolCallsOutput.length > 0,
            aggregatedToolCalls: aggregatedToolCallsOutput,
            conversationalResponse: conversationalResponseText
        };
    }

    private async runConversationalStream(
        currentUserMessage: string,
        initialUserQuery: string,
        sessionId: string,
        currentMessageId: string,
        messageProcessingId: string,
        _toolsForThisStream: any[],
        historyForThisStream: Message[],
        aggregatedToolCallsOutput: ProcessedMessageResult['aggregatedToolCalls']
    ): Promise<ConversationalStreamResult> {
        const streamId = `conversational_${messageProcessingId}`;
        logger.info('Starting main conversational stream', { sessionId, streamId });

        const parserInstanceId = `conv_parser_${sessionId}_${currentMessageId}`;
        const parser = MarkdownStreamParser.getInstance(parserInstanceId);
        let unsubscribeFromParser: (() => void) | null = null;
        let parserSuccessfullyCleanedUp = false;

        let accumulatedText = "";
        let accumulatedToolCalls: Groq.Chat.Completions.ChatCompletionMessageToolCall[] | null = null;

        try {
            unsubscribeFromParser = parser.subscribeToTokenParse((parsedSegment: LixpiParsedSegment) => {
                const isLastSegmentFromParser = parsedSegment.status === 'END_STREAM';
                this.emit('send_chunk', sessionId, {
                    type: 'conversational_text_segment',
                    content: parsedSegment,
                    messageId: currentMessageId,
                    isFinal: isLastSegmentFromParser,
                    streamType: 'conversational',
                    messageType: MessageType.STANDARD
                } as StreamChunk);
                if (isLastSegmentFromParser) {
                    if (unsubscribeFromParser) { unsubscribeFromParser(); unsubscribeFromParser = null; }
                    MarkdownStreamParser.removeInstance(parserInstanceId);
                    parserSuccessfullyCleanedUp = true;
                }
            });
            parser.startParsing();

            const systemPromptContent = MAIN_CONVERSATIONAL_SYSTEM_PROMPT_TEMPLATE
                .replace('{{USER_INITIAL_QUERY}}', initialUserQuery)
                .replace('{{USER_CURRENT_MESSAGE}}', currentUserMessage);

            const messagesForApi: Message[] = [
                { role: 'system', content: systemPromptContent },
                ...this.prepareHistoryForLLM(historyForThisStream)
            ];

            const toolsForThisStream = this.toolConfigManager.getGroqToolsDefinition() || [];
            toolsForThisStream.push(PLANNER_META_TOOL);
            
            const responseStream = await this.client.chat.completions.create({
                model: this.model,
                messages: messagesForApi as any,
                max_tokens: this.maxTokens,
                tools: toolsForThisStream,
                stream: true,
                temperature: 0.5,
            });

            for await (const chunk of responseStream) {
                const contentDelta = chunk.choices[0]?.delta?.content;
                const toolCallsDelta = chunk.choices[0]?.delta?.tool_calls;

                if (contentDelta) {
                    accumulatedText += contentDelta;
                    if (parser.parsing && !parserSuccessfullyCleanedUp) {
                        parser.parseToken(contentDelta);
                    }
                }

                if (toolCallsDelta) {
                    if (!accumulatedToolCalls) accumulatedToolCalls = [];
                    this.accumulateToolCallDeltas(accumulatedToolCalls, toolCallsDelta);
                }

                const finishReason = chunk.choices[0]?.finish_reason;
                if (finishReason) {
                    logger.info(`Conversational stream finished. Reason: ${finishReason}`, { sessionId, streamId, finishReason });
                    break;
                }
            }

            if (parser.parsing && !parserSuccessfullyCleanedUp) {
                parser.stopParsing();
            }

            // After the stream is complete, add the assistant's text response to history.
            // Tool calls will be handled by the dedicated tool stream.
            const assistantResponse: Message = { role: 'assistant', content: accumulatedText || null };
            historyForThisStream.push(assistantResponse);
            this.conversationHistory.set(sessionId, this.trimHistory(historyForThisStream));

        } finally {
            if (!parserSuccessfullyCleanedUp) {
                if (unsubscribeFromParser) unsubscribeFromParser();
                if (parser.parsing) parser.stopParsing();
                MarkdownStreamParser.removeInstance(parserInstanceId);
            }
            this.emit('send_chunk', sessionId, { 
                type: 'stream_end', 
                streamType: 'conversational', 
                messageId: currentMessageId, 
                isFinal: true 
            });
            logger.info('Conversational stream processing complete.', { sessionId, streamId });
        }

        return {
            text: accumulatedText,
            hasToolCalls: !!(accumulatedToolCalls && accumulatedToolCalls.length > 0)
        };
    }

    private async runToolCallStream(
        currentUserMessage: string | null,
        sessionId: string,
        currentMessageId: string,
        messageProcessingId: string,
        _historyForThisStream: Message[],
        aggregatedToolCallsOutput: ProcessedMessageResult['aggregatedToolCalls'],
        toolsForThisStream: any[]
    ): Promise<ToolCallStreamResult> {
        const streamId = `tool_call_${messageProcessingId}`;
        logger.info('Starting dedicated tool identification stream', { sessionId, streamId });
        
        let accumulatedToolCalls: Groq.Chat.Completions.ChatCompletionMessageToolCall[] | null = null;
        try {
            // If there's no new user message, we are likely in a follow-up call after a tool result.
            // In this case, we don't need to run the tool stream again.
            if (!currentUserMessage) {
                logger.info('No user message provided; skipping tool call stream.', { sessionId, streamId });
                return { hasToolCalls: false };
            }

            const systemPromptContent = DEDICATED_TOOL_CALL_SYSTEM_PROMPT_TEMPLATE
                .replace('{{USER_CURRENT_MESSAGE}}', currentUserMessage)
                .replace('{{TOOL_DEFINITIONS_JSON}}', JSON.stringify(toolsForThisStream, null, 2));
            
            const messagesForApi: Message[] = [
                { role: 'system', content: systemPromptContent },
                { role: 'user', content: currentUserMessage }
            ];

            if (!toolsForThisStream || toolsForThisStream.length === 0) {
                logger.warn('Tool call stream has no tools to process', { sessionId });
                return { hasToolCalls: false };
            }

            const responseStream = await this.client.chat.completions.create({
                model: this.model,
                messages: messagesForApi as any,
                tools: toolsForThisStream,
                tool_choice: "auto",
                stream: true,
            });

            for await (const chunk of responseStream) {
                const toolCallsDelta = chunk.choices[0]?.delta?.tool_calls;
                if (toolCallsDelta) {
                    if (!accumulatedToolCalls) accumulatedToolCalls = [];
                    this.accumulateToolCallDeltas(accumulatedToolCalls, toolCallsDelta);
                }
                const finishReason = chunk.choices[0]?.finish_reason;
                if (finishReason) {
                    logger.info(`Tool call stream finished. Reason: ${finishReason}`, { sessionId, streamId });
                    break;
                }
            }

            if (accumulatedToolCalls) {
                accumulatedToolCalls.forEach(tc => {
                    if (tc.id && tc.function.name) {
                        try {
                            aggregatedToolCallsOutput.push({
                                id: tc.id,
                                name: tc.function.name,
                                arguments: JSON.parse(tc.function.arguments || '{}'),
                                streamType: 'tool_call',
                                function: undefined as any
                            });
                            logger.info('Dedicated tool stream collected tool_call', { 
                                name: tc.function.name 
                            });
                        } catch (e: any) {
                            logger.error("Failed to parse tool arguments", { 
                                args: tc.function.arguments,
                                error: e.message
                            });
                        }
                    }
                });
            }
        } catch (error: any) {
            logger.error('Error in tool call stream', { error: error.message, sessionId, streamId });
        } finally {
            // Add the tool calls to history AFTER they have been identified
            if (accumulatedToolCalls && accumulatedToolCalls.length > 0) {
                const history = this.getHistory(sessionId);
                const lastMessage = history[history.length - 1];
                if (lastMessage && lastMessage.role === 'assistant') {
                    lastMessage.tool_calls = accumulatedToolCalls;
                }
            }
            logger.info('Tool call stream processing complete.', { sessionId, streamId });
        }

        return {
            hasToolCalls: !!(accumulatedToolCalls && accumulatedToolCalls.length > 0)
        };
    }

    private accumulateToolCallDeltas(
        currentToolCalls: Groq.Chat.Completions.ChatCompletionMessageToolCall[],
        toolCallDeltas: Groq.Chat.Completions.ChatCompletionChunk.Choice.Delta.ToolCall[]
    ) {
        for (const toolCallDelta of toolCallDeltas) {
            if (typeof toolCallDelta.index === 'number') {
                while (currentToolCalls.length <= toolCallDelta.index) {
                    currentToolCalls.push({ 
                        id: '', 
                        type: 'function', 
                        function: { name: '', arguments: '' } 
                    });
                }
                
                const currentFn = currentToolCalls[toolCallDelta.index].function;
                if (toolCallDelta.id && !currentToolCalls[toolCallDelta.index].id) {
                    currentToolCalls[toolCallDelta.index].id = toolCallDelta.id;
                }
                if (toolCallDelta.function?.name) {
                    currentFn.name += toolCallDelta.function.name;
                }
                if (toolCallDelta.function?.arguments) {
                    currentFn.arguments += toolCallDelta.function.arguments;
                }
                if (toolCallDelta.type) {
                    currentToolCalls[toolCallDelta.index].type = toolCallDelta.type as 'function';
                }
            }
        }
    }
    private prepareHistoryForLLM(history: Message[]): Message[] {
        return history.filter(msg => msg.role !== 'system' && (msg.content || (msg.tool_calls && msg.tool_calls.length > 0)));
    }

    private getHistory(sessionId: string): Message[] {
        return this.conversationHistory.get(sessionId) || [];
    }

    private trimHistory(history: Message[], maxLength: number = 20): Message[] {
        if (history.length <= maxLength) return history;
        const systemPrompts = history.filter(h => h.role === 'system');
        const nonSystem = history.filter(h => h.role !== 'system');
        const trimmed = nonSystem.slice(-maxLength + systemPrompts.length);
        return [...systemPrompts, ...trimmed];
    }

    public addAssistantMessageToHistory(sessionId: string, content: string, metadata?: Record<string, any>): void {
        const history = this.getHistory(sessionId);
        const assistantMessage: Message = {
            role: 'assistant',
            content: content,
        };
        history.push(assistantMessage);
        this.conversationHistory.set(sessionId, this.trimHistory(history));
        logger.info('Added assistant message to history programmatically', { sessionId });
    }

    public addToolResultMessageToHistory(sessionId: string, toolCallId: string, toolName: string, resultData: any): void {
        const history = this.getHistory(sessionId);
        const toolMessage = {
            role: 'tool' as any, // Cast because 'tool' is not in the standard Message role yet
            tool_call_id: toolCallId,
            name: toolName,
            content: JSON.stringify(resultData, null, 2),
        };
        // The official pattern is to add a `tool` message, not append to assistant.
        // However, Groq might expect it on the assistant message. Let's try the official pattern first.
        history.push(toolMessage as Message);
        this.conversationHistory.set(sessionId, this.trimHistory(history));
        logger.info('Added tool result message to history', { sessionId, toolName, toolCallId });
    }
}
