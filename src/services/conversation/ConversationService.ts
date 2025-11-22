// src/services/conversation/ConversationService.ts

import { EventEmitter } from 'events';
import Groq, { GroqError,  } from 'groq-sdk';
import winston from 'winston';
import { v4 as uuidv4 } from 'uuid';
import { ConversationConfig, Message, MessageType, ToolResult } from './types';
import { ToolConfigManager } from '../tool/ToolConfigManager';
import { ProviderAwareToolFilter } from '../tool/ProviderAwareToolFilter';
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
    private providerAwareFilter?: ProviderAwareToolFilter;

    constructor(private config: ConversationConfig, providerAwareFilter?: ProviderAwareToolFilter) {
        super();
        if (!config.groqApiKey) throw new Error("Groq API key is missing.");
        this.client = new Groq({ apiKey: config.groqApiKey });
        this.model = config.model;
        this.maxTokens = config.maxTokens;
        this.toolConfigManager = new ToolConfigManager();
        this.providerAwareFilter = providerAwareFilter;
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
        
        const isSummaryMode = !userMessage;
        let toolsForStream: any[] = [];
        let initialUserQuery = '';

        if (!isSummaryMode) {
            const relevantCategories = getRelevantToolCategories(userMessage || history.at(-1)?.content || '');

            // Use provider-aware filtering if available and userId is provided
            let filteredToolConfigs;
            if (this.providerAwareFilter && _userId) {
                logger.info('Using provider-aware tool filtering', { userId: _userId, categories: relevantCategories });
                filteredToolConfigs = await this.providerAwareFilter.getToolsByCategoriesForUser(_userId, relevantCategories);
            } else {
                logger.warn('Provider-aware filtering not available, falling back to category-only filtering');
                filteredToolConfigs = this.toolConfigManager.getToolsByCategories(relevantCategories);
            }

            const groqTools = filteredToolConfigs.map(tool => {
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
            toolsForStream = [...(groqTools as any[]), PLANNER_META_TOOL];
            initialUserQuery = history.find(m => m.role === 'user')?.content || userMessage || '';
        } else {
            initialUserQuery = history.find(m => m.role === 'user')?.content || 'the previous actions';
        }

        const aggregatedToolCallsOutput: ProcessedMessageResult['aggregatedToolCalls'] = [];

        let conversationalResponseText = "";
        
        const conversationalStreamPromise = this.runConversationalStream(
            userMessage, initialUserQuery, sessionId, currentMessageId, messageProcessingId,
            toolsForStream, history, aggregatedToolCallsOutput, _userId
        ).then(result => {
            conversationalResponseText = result.text;
        });
        
        // The dedicated tool call stream is removed. All logic is now in runConversationalStream.
        await Promise.allSettled([conversationalStreamPromise]);

        logger.info('All ConversationService streams have settled.', {
            sessionId,
            finalAggregatedToolCount: aggregatedToolCallsOutput.length,
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
        currentUserMessage: string | null,
        initialUserQuery: string,
        sessionId: string,
        currentMessageId: string,
        messageProcessingId: string,
        toolsForThisStream: any[],
        historyForThisStream: Message[],
        aggregatedToolCallsOutput: ProcessedMessageResult['aggregatedToolCalls'],
        _userId?: string
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

            // Get provider context if available
            let providerContext = '';
            if (this.providerAwareFilter && _userId) {
                providerContext = await this.providerAwareFilter.getProviderContextForPrompt(_userId);
            }

            // In summary mode (no current message), make it explicit what the LLM should do
            const isSummaryMode = !currentUserMessage;
            const currentMessageText = isSummaryMode
                ? '[SUMMARY MODE] No new user message. Review the tool_calls in the previous assistant message and their corresponding tool results, then provide a warm, conversational summary of what was accomplished.'
                : currentUserMessage || '';

            const systemPromptContent = MAIN_CONVERSATIONAL_SYSTEM_PROMPT_TEMPLATE
                .replace('{{USER_INITIAL_QUERY}}', initialUserQuery)
                .replace('{{USER_CURRENT_MESSAGE}}', currentMessageText)
                .replace('{{PROVIDER_CONTEXT}}', providerContext);

            const messagesForApi: Message[] = [
                { role: 'system', content: systemPromptContent }
            ];
            const preparedHistory = this.prepareHistoryForLLM(historyForThisStream);
            messagesForApi.push(...preparedHistory);

            // Debug: Log the messages being sent to LLM, especially in summary mode
            if (isSummaryMode) {
                logger.info('Summary mode: Messages being sent to LLM', {
                    sessionId,
                    totalMessages: messagesForApi.length,
                    messageRoles: messagesForApi.map(m => m.role),
                    toolResultCount: messagesForApi.filter(m => m.role === 'tool').length,
                    toolResults: messagesForApi.filter(m => m.role === 'tool').map(m => ({
                        name: m.name,
                        hasContent: !!m.content,
                        contentLength: m.content?.length || 0
                    }))
                });
            }

            // Build API parameters conditionally based on whether tools are available
            // Only include tools and tool_choice when tools are actually available
            // This prevents confusing the LLM in summary mode
            let responseStream;
            if (toolsForThisStream.length > 0) {
                logger.info('Conversational stream: Calling LLM with tools', {
                    toolCount: toolsForThisStream.length,
                    sessionId,
                    model: this.model,
                    messageCount: messagesForApi.length,
                    hasToolChoice: true
                });
                responseStream = await this.client.chat.completions.create({
                    model: this.model,
                    messages: messagesForApi as any,
                    max_tokens: this.maxTokens,
                    tools: toolsForThisStream,
                    tool_choice: "auto",
                    stream: true,
                    temperature: 0.5,
                });
            } else {
                logger.info('Conversational stream: Calling LLM in summary mode (NO tools)', {
                    sessionId,
                    model: this.model,
                    messageCount: messagesForApi.length,
                    isSummaryMode: true,
                    hasToolChoice: false,
                    systemPromptLength: systemPromptContent.length
                });
                responseStream = await this.client.chat.completions.create({
                    model: this.model,
                    messages: messagesForApi as any,
                    max_tokens: this.maxTokens,
                    stream: true,
                    temperature: 0.5,
                });
            }

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

            // Process accumulated tool calls from this stream
            if (accumulatedToolCalls) {
                logger.info(`Conversational stream identified ${accumulatedToolCalls.length} tool calls.`, { sessionId });
                accumulatedToolCalls.forEach(tc => {
                    if (tc.id && tc.function.name) {
                        try {
                            // Check for duplicates before adding
                            if (!aggregatedToolCallsOutput.some(existing => existing.id === tc.id)) {
                                // DEBUG: raw toolcall from LLM (before any manipulation)
                                try {
                                    console.log("🔥 RAW_TOOLCALL_FROM_LLM:", JSON.stringify(tc, null, 2));
                                } catch (e) {
                                    console.log("🔥 RAW_TOOLCALL_FROM_LLM (stringify failed):", tc);
                                }


                                aggregatedToolCallsOutput.push({
                                    id: tc.id,
                                    name: tc.function.name,
                                    arguments: JSON.parse(tc.function.arguments || '{}'),
                                    streamType: 'conversational', // Mark the source stream
                                    function: undefined as any
                                });
                                logger.info('Collected tool_call from conversational stream', { name: tc.function.name });
                            }
                        } catch (e: any) {
                            logger.error("Failed to parse tool arguments from conversational stream", { 
                                args: tc.function.arguments, error: e.message 
                            });
                        }
                    }
                });
            }

            // Log the complete LLM response for debugging
            logger.info('Conversational stream: LLM response complete', {
                sessionId,
                streamId,
                contentLength: accumulatedText?.length || 0,
                hasContent: !!accumulatedText,
                hasToolCalls: !!(accumulatedToolCalls && accumulatedToolCalls.length > 0),
                toolCallCount: accumulatedToolCalls?.length || 0,
                isEmpty: !accumulatedText && (!accumulatedToolCalls || accumulatedToolCalls.length === 0)
            });

            // Warn if LLM returned completely empty response (neither text nor tool calls)
            if (!accumulatedText && (!accumulatedToolCalls || accumulatedToolCalls.length === 0)) {
                logger.warn('LLM returned empty response (no text, no tool calls)', {
                    sessionId,
                    streamId,
                    isSummaryMode,
                    messageCount: messagesForApi.length,
                    toolsAvailable: toolsForThisStream.length > 0
                });
            }

            // After the stream is complete, add the assistant's text response to history.
            // Include tool_calls if any were made - this is critical for the LLM to understand
            // the context when we later add tool results and generate a summary.
            const assistantResponse: Message = {
                role: 'assistant',
                content: accumulatedText || null,
                tool_calls: accumulatedToolCalls || null
            };
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
        return history.filter(msg => {
            // Exclude system messages (they're added separately)
            if (msg.role === 'system') return false;

            // Include tool result messages (role: 'tool') if they have content
            if (msg.role === 'tool' && msg.content) return true;

            // Include other messages (user/assistant) if they have content or tool calls
            return msg.content || (msg.tool_calls && msg.tool_calls.length > 0);
        });
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
        const toolMessage: Message = {
            role: 'tool',
            tool_call_id: toolCallId,
            name: toolName,
            content: JSON.stringify(resultData, null, 2),
        };
        history.push(toolMessage);
        this.conversationHistory.set(sessionId, this.trimHistory(history));
        logger.info('Added tool result message to history', { sessionId, toolName, toolCallId });
    }
}
