// src/services/conversation/ConversationService.ts
import { EventEmitter } from 'events';
import Groq from 'groq-sdk';
import winston from 'winston';
import { v4 as uuidv4 } from 'uuid';
import { ConversationConfig, Message, LLMResponse } from './types';
import { ToolConfigManager } from '../tool/ToolConfigManager'; // Import manager
import { MarkdownStreamParser } from '@lixpi/markdown-stream-parser'; // Ensure this import is correct
import { StreamChunk } from '../stream/types';
// Import new prompt templates
import { MAIN_CONVERSATIONAL_SYSTEM_PROMPT_TEMPLATE } from './prompts/mainConversationalPrompt';
import { MARKDOWN_ARTEFACT_SYSTEM_PROMPT_TEMPLATE } from './prompts/markdownArtefactPrompt';
import { DEDICATED_TOOL_CALL_SYSTEM_PROMPT_TEMPLATE } from './prompts/dedicatedToolCallPrompt';

// Define LixpiParsedSegment if not globally available or exported by the library
interface LixpiParsedSegment {
  status: 'STREAMING' | 'END_STREAM' | string;
  segment?: {
    segment: string;
    styles: string[];
    type: string;
    isBlockDefining?: boolean;
    isProcessingNewLine?: boolean;
  };
}

// New return type for the main processing method
export interface ProcessedMessageResult {
    toolCalls: boolean;
    aggregatedToolCalls: Array<{
      function: any; id?: string; name: string; arguments: Record<string, any>; streamType: string 
    }>;
    conversationalResponse: string; // <-- FIX: Add this property
}

const PLANNER_META_TOOL = {
  type: "function" as const,
  function: {
    name: "planParallelActions",
    description: "Use this when a user's request is complex and requires multiple steps or actions to be planned. This triggers the main planning process.",
    parameters: {
      type: "object" as const,
      properties: {
        userInput: {
          type: "string" as const,
          description: "The original, full text of the user's complex request."
        },
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
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.json()
    ),
    transports: [new winston.transports.Console()],
  });



  const KEYWORD_TO_CATEGORY_MAP: Record<string, string> = {
    'email': 'Email',
    'emails': 'Email',
    'send': 'Email', // Can be refined to include other categories if needed
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

    if (detectedCategories.size === 0) {
        // If no keywords are found, fall back to a default set.
        // An empty array would mean only 'Meta' tools are sent.
        // Sending all is a safe default during development.
        return ['Email', 'Calendar', 'CRM'];
    }

    return Array.from(detectedCategories);
}

export class ConversationService extends EventEmitter {
    [x: string]: any;
    private client: Groq;
    private model: string;
    private maxTokens: number;
    private conversationHistory: Map<string, Message[]> = new Map();
    private toolConfigManager: ToolConfigManager;

    constructor(private config: ConversationConfig) {
        super();
        if (!config.groqApiKey) throw new Error("Groq API key is missing in config.");
        this.client = new Groq({ apiKey: config.groqApiKey });
        this.model = config.model;
        this.maxTokens = config.maxTokens;

        // --- FIX: Call the new, argument-less constructor ---
        this.toolConfigManager = new ToolConfigManager();
        logger.info('ToolConfigManager initialized within ConversationService.');
    }

    /**
     * Processes the user message, runs internal LLM streams, and returns aggregated tool calls.
     * Text, markdown, and tool call announcements are streamed to the client via 'send_chunk' events.
     */
    public async processMessageAndAggregateResults(
        userMessage: string, sessionId: string, incomingMessageId?: string, _userId?: string
    ): Promise<ProcessedMessageResult> {
        const messageProcessingId = uuidv4()as any;
        const currentMessageId = incomingMessageId || uuidv4();
        logger.info('Processing message, will aggregate results', { sessionId });

        const history = this.getHistory(sessionId);
        history.push({ role: 'user', content: userMessage });
        this.conversationHistory.set(sessionId, history);

        const relevantCategories = getRelevantToolCategories(userMessage);
        const filteredToolConfigs = this.toolConfigManager.getToolsByCategories(relevantCategories);
        const filteredGroqTools = filteredToolConfigs.map(tool => {
            const inputSchema = this.toolConfigManager.getToolInputSchema(tool.name);
            if (!inputSchema) {
                logger.warn(`Skipping Groq definition for ${tool.name}: No input schema found.`);
                return null;
            }
            return {
                type: "function",
                function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: inputSchema
                }
            };
        }).filter(Boolean);


        console.log('Tools being processed:');

        const initialUserQuery = history.find(m => m.role === 'user')?.content || userMessage;
        const aggregatedToolCallsOutput: ProcessedMessageResult['aggregatedToolCalls'] = [] as any;
        
        let conversationalResponseText = "";

        // --- FIX: The argument list now has the correct 7 arguments ---
        const conversationalStreamPromise = this.runConversationalStream(
            userMessage,                 // currentUserMessage
            initialUserQuery,          // initialUserQuery
            sessionId,                 // sessionId
            currentMessageId,          // currentMessageId
            messageProcessingId,       // messageProcessingId
            filteredGroqTools,         // toolsForThisStream
            [...history],              // historyForThisStream
            aggregatedToolCallsOutput
        ).then(responseText => {
            conversationalResponseText = responseText;
        });

        const toolCallStreamPromise = this.runToolCallStream(
            userMessage,
            sessionId,
            currentMessageId,
            messageProcessingId,
            [...history],
            aggregatedToolCallsOutput,
            filteredGroqTools
        );
        await Promise.allSettled([conversationalStreamPromise, toolCallStreamPromise]);

        logger.info('All ConversationService streams have settled.', { sessionId });
        
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
        aggregatedToolCallsOutput: ProcessedMessageResult['aggregatedToolCalls'] // To collect tool calls
    ) {
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
                    streamType: 'conversational'
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

        // 2. --- THIS IS THE FIX: Dynamically inject the planner meta-tool ---
        // Since this is the "smart" stream, we always give it the option to escalate to the planner.
        toolsForThisStream.push(PLANNER_META_TOOL);


            // Add this debug log:
            logger.debug('Tools being sent to Groq API (Conversational Stream):', {
                sessionId, 
                messageId: currentMessageId,
                tools: JSON.stringify(toolsForThisStream, null, 2) // Stringify for readability
            });
            const responseStream = await this.client.chat.completions.create({
                model: this.model,
                messages: messagesForApi as any,
                max_tokens: this.maxTokens,
                tools: toolsForThisStream,
                stream: true,
                temperature: 0.5, // More conversational
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

            if (accumulatedToolCalls) {
                accumulatedToolCalls.forEach(tc => {
                    if (tc.id && tc.function.name) {
                        try {
                            aggregatedToolCallsOutput.push({
                                id: tc.id,
                                name: tc.function.name,
                                arguments: JSON.parse(tc.function.arguments || '{}'),
                                streamType: 'conversational',
                                function: undefined
                            });
                            logger.info('Conversational stream collected potential_tool_call', { sessionId, streamId, toolCallId: tc.id, name: tc.function.name });
                        } catch (parseError: any) {
                            logger.error("Failed to parse tool arguments from conversational stream for aggregation", { toolCallId: tc.id, args: tc.function.arguments, error: parseError.message });
                        }
                        // Still emit for client visibility / original flow if desired
                        this.emit('send_chunk', sessionId, {
                            type: 'potential_tool_call', 
                            content: { id: tc.id, function: { name: tc.function.name, arguments: tc.function.arguments } },
                            messageId: currentMessageId,
                            toolCallId: tc.id,
                            isFinal: false,
                            streamType: 'conversational'
                        } as StreamChunk);
                    }
                });
            }

            const assistantResponse: Message = {
                role: 'assistant',
                content: accumulatedText || null,
                tool_calls: accumulatedToolCalls || []
            };
            const currentHistory = this.getHistory(sessionId);
            currentHistory.push(assistantResponse);
            this.conversationHistory.set(sessionId, this.trimHistory(currentHistory));

        } catch (error: any) {
            logger.error('Error in conversational stream', { error: error.message, sessionId, streamId });
            this.emit('send_chunk', sessionId, {
                type: 'error',
                content: "Error in conversational stream.",
                messageId: currentMessageId,
                isFinal: true,
                streamType: 'conversational'
            } as StreamChunk);
            if (parser.parsing && !parserSuccessfullyCleanedUp) parser.stopParsing();
        } finally {
            if (!parserSuccessfullyCleanedUp) {
                if (unsubscribeFromParser) unsubscribeFromParser();
                if (parser.parsing) parser.stopParsing();
                MarkdownStreamParser.removeInstance(parserInstanceId);
            }
            this.emit('send_chunk', sessionId, { type: 'stream_end', streamType: 'conversational', messageId: currentMessageId, isFinal: true } as StreamChunk);
            logger.info('Conversational stream processing complete.', { sessionId, streamId });
        }

        return accumulatedText;
    }

     private async runToolCallStream(
        currentUserMessage: string,
        sessionId: string,
        currentMessageId: string,
        messageProcessingId: string,
        historyForThisStream: Message[], // This parameter was missing
        aggregatedToolCallsOutput: ProcessedMessageResult['aggregatedToolCalls'],
        toolsForThisStream: any[]
    ) {
        const streamId = `tool_call_${messageProcessingId}`;
        logger.info('Starting dedicated tool identification stream', { sessionId, streamId });
        
        let accumulatedToolCalls: Groq.Chat.Completions.ChatCompletionMessageToolCall[] | null = null;
        try {
            const systemPromptContent = DEDICATED_TOOL_CALL_SYSTEM_PROMPT_TEMPLATE
                .replace('{{USER_CURRENT_MESSAGE}}', currentUserMessage);
            
            const messagesForApi: Message[] = [
                { role: 'system', content: systemPromptContent },
                // The tool call stream only needs the current message, not the full history
                { role: 'user', content: currentUserMessage } 
            ];

            if (!toolsForThisStream || toolsForThisStream.length === 0) {
                logger.warn('Tool call stream has no tools to process after filtering.', { sessionId });
                return;
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
                                function: undefined
                            });
                            logger.info('Dedicated tool stream collected tool_call', { name: tc.function.name });
                        } catch (e) {
                            logger.error("Failed to parse tool arguments from dedicated stream", { args: tc.function.arguments });
                        }
                    }
                });
            }
        } catch (error: any) {
            logger.error('Error in tool call stream', { error: error.message, sessionId, streamId });
        } finally {
            logger.info('Tool call stream processing complete.', { sessionId, streamId });
        }
    }

    private async runMarkdownArtefactStream(
        currentUserMessage: string,
        initialUserQuery: string,
        sessionId: string,
        currentMessageId: string,
        messageProcessingId: string,
        historyForThisStream: Message[]
    ) {
        const streamId = `markdown_artefact_${messageProcessingId}`;
        logger.info('Starting Markdown artefact stream', { sessionId, streamId });

        const parserInstanceId = `md_artefact_parser_${sessionId}_${currentMessageId}`;
        const parser = MarkdownStreamParser.getInstance(parserInstanceId);
        let unsubscribeFromParser: (() => void) | null = null;
        let parserSuccessfullyCleanedUp = false;

        try {
            unsubscribeFromParser = parser.subscribeToTokenParse((parsedSegment: LixpiParsedSegment) => {
                const isLastSegmentFromParser = parsedSegment.status === 'END_STREAM';
                this.emit('send_chunk', sessionId, {
                    type: 'markdown_artefact_segment',
                    content: parsedSegment,
                    messageId: currentMessageId,
                    isFinal: isLastSegmentFromParser,
                    streamType: 'markdown_artefact'
                } as StreamChunk);

                if (isLastSegmentFromParser) {
                    if (unsubscribeFromParser) { unsubscribeFromParser(); unsubscribeFromParser = null; }
                    MarkdownStreamParser.removeInstance(parserInstanceId);
                    parserSuccessfullyCleanedUp = true;
                }
            });
            parser.startParsing();

            const historySnippet = this.prepareHistoryForLLM(historyForThisStream)
                .slice(-3) // Last 3 turns for snippet
                .map(m => `${m.role}: ${m.content?.substring(0, 75) || (m.tool_calls ? 'tool_call' : 'no text content')}...`)
                .join('\n');

            const systemPromptContent = MARKDOWN_ARTEFACT_SYSTEM_PROMPT_TEMPLATE
                .replace('{{USER_INITIAL_QUERY}}', initialUserQuery)
                .replace('{{USER_CURRENT_MESSAGE}}', currentUserMessage)
                .replace('{{CONVERSATION_HISTORY_SNIPPET}}', historySnippet);

            const messagesForApi: Message[] = [{ role: 'system', content: systemPromptContent }];

            const responseStream = await this.client.chat.completions.create({
                model: this.model,
                messages: messagesForApi as any,
                max_tokens: 150, // For 50-100 token artefact, plus buffer
                stream: true,
                temperature: 0.3,
            });

            for await (const chunk of responseStream) {
                const contentDelta = chunk.choices[0]?.delta?.content;
                if (contentDelta) {
                    if (parser.parsing && !parserSuccessfullyCleanedUp) {
                        parser.parseToken(contentDelta);
                    }
                }
                const finishReason = chunk.choices[0]?.finish_reason;
                if (finishReason) {
                    logger.info(`Markdown artefact stream finished. Reason: ${finishReason}`, { sessionId, streamId, finishReason });
                    break;
                }
            }
            if (parser.parsing && !parserSuccessfullyCleanedUp) {
                parser.stopParsing();
            }

        } catch (error: any) {
            logger.error('Error in Markdown artefact stream', { error: error.message, sessionId, streamId });
            this.emit('send_chunk', sessionId, {
                type: 'error',
                content: "Error in Markdown thoughts stream.",
                messageId: currentMessageId,
                isFinal: true,
                streamType: 'markdown_artefact'
            } as StreamChunk);
            if (parser.parsing && !parserSuccessfullyCleanedUp) parser.stopParsing();
        } finally {
             if (!parserSuccessfullyCleanedUp) {
                if (unsubscribeFromParser) unsubscribeFromParser();
                if (parser.parsing) parser.stopParsing();
                MarkdownStreamParser.removeInstance(parserInstanceId);
            }
            this.emit('send_chunk', sessionId, { type: 'stream_end', streamType: 'markdown_artefact', messageId: currentMessageId, isFinal: true } as StreamChunk);
            logger.info('Markdown artefact stream processing complete.', { sessionId, streamId });
        }
    }

    private accumulateToolCallDeltas(
        currentToolCalls: Groq.Chat.Completions.ChatCompletionMessageToolCall[],
        toolCallDeltas: Groq.Chat.Completions.ChatCompletionChunk.Choice.Delta.ToolCall[]
    ) {
        for (const toolCallDelta of toolCallDeltas) {
            if (typeof toolCallDelta.index === 'number') {
                while (currentToolCalls.length <= toolCallDelta.index) {
                    currentToolCalls.push({ id: '', type: 'function', function: { name: '', arguments: '' } });
                }
                if (!currentToolCalls[toolCallDelta.index]) { // Should not happen due to while loop
                     currentToolCalls[toolCallDelta.index] = { id: toolCallDelta.id || '', type: 'function', function: { name: '', arguments: '' } };
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
                if (toolCallDelta.type) { // Should always be 'function'
                    currentToolCalls[toolCallDelta.index].type = toolCallDelta.type as 'function';
                }
            }
        }
    }

    private prepareHistoryForLLM(history: Message[]): Message[] {
        const filteredHistory = history.filter(msg =>
            msg.role !== 'system' &&
            (msg.content || (msg.tool_calls && msg.tool_calls.length > 0))
        );
        return this.trimHistory(filteredHistory);
    }
    
    private async handleConversationalMode(
        currentUserMessage: string, // The most recent message from the user in this turn
        initialUserQueryForMode: string, // The query that LLM decided was conversational
        sessionId: string,
        currentMessageId: string, // ID for the overall interaction cycle
        history: Message[] // Current history up to this point
    ): Promise<LLMResponse> {
        const conversationalModeProcessingId = uuidv4(); // This method will be removed or heavily refactored
        logger.info('Entering conversational mode handler', { sessionId, conversationalModeProcessingId, currentMessageId, initialUserQueryForMode, currentUserMessage });

        const parserInstanceId = `conv_mode_${sessionId}_${currentMessageId}_${conversationalModeProcessingId}_parser`;
        const parser = MarkdownStreamParser.getInstance(parserInstanceId);
        let unsubscribeFromParser: (() => void) | null = null;
        let parserSuccessfullyCleanedUp = false;

        let fullTextResponse = '';
        let accumulatedToolCallsFromConversational: Groq.Chat.Completions.ChatCompletionMessageToolCall[] | null = null;

        try {
            unsubscribeFromParser = parser.subscribeToTokenParse((parsedSegment: LixpiParsedSegment) => {
                logger.debug('Markdown parser emitted segment for conversational mode', { parserInstanceId, status: parsedSegment.status, type: parsedSegment.segment?.type });
                const isLastSegmentFromParser = parsedSegment.status === 'END_STREAM';
                this.emit('send_chunk', sessionId, {
                    type: 'parsed_markdown_segment',
                    content: parsedSegment,
                    messageId: currentMessageId,
                    isFinal: isLastSegmentFromParser,
                } as unknown as StreamChunk);
                if (isLastSegmentFromParser) {
                    logger.info('Markdown parser (conversational_mode) emitted END_STREAM. Cleaning up.', { parserInstanceId });
                    if (unsubscribeFromParser) { unsubscribeFromParser(); unsubscribeFromParser = null; }
                    MarkdownStreamParser.removeInstance(parserInstanceId);
                    parserSuccessfullyCleanedUp = true;
                }
            });
            parser.startParsing();

            // This was the old way, now the main conversational stream handles this with its own prompt.
            const conversationalPrompt = MAIN_CONVERSATIONAL_SYSTEM_PROMPT_TEMPLATE // Example: using new main prompt
                .replace('{{USER_INITIAL_QUERY}}', initialUserQueryForMode)
                .replace('{{USER_CURRENT_MESSAGE}}', currentUserMessage);

            const messagesForApi: Message[] = [
                { role: 'system', content: conversationalPrompt },
                ...history.filter(msg => msg.role !== 'system'), // Use current history, but replace system prompt
                // The last user message is already in history
            ];

            // Tools available to this LLM: request_tool_execution and request_missing_parameters
            // Assuming getGroqToolsDefinition() returns all tools, and the prompt guides the LLM.
            // If ToolConfigManager needs to filter, this call would need adjustment.
            const conversationalTools = this.toolConfigManager.getGroqToolsDefinition();
            if (!conversationalTools || conversationalTools.length === 0) {
                logger.warn(`Conversational mode LLM has no tools defined. Functionality will be limited.`, { sessionId });
            }

            const responseStream = await this.client.chat.completions.create({
                model: this.model, // Or a different model for conversational tasks
                messages: messagesForApi as any,
                max_tokens: this.maxTokens,
                tools: conversationalTools, // Only 'request_tool_execution'
                stream: true,
                temperature: 0.5, // Potentially higher for more creative/conversational responses
            });

            for await (const chunk of responseStream) {
                const contentDelta = chunk.choices[0]?.delta?.content;
                const toolCallsDelta = chunk.choices[0]?.delta?.tool_calls;

                if (contentDelta) {
                    fullTextResponse += contentDelta;
                    if (parser.parsing && !parserSuccessfullyCleanedUp) {
                        parser.parseToken(contentDelta);
                    }
                }
                if (toolCallsDelta) {
                    if (!accumulatedToolCallsFromConversational) accumulatedToolCallsFromConversational = [];
                    for (const toolCallDelta of toolCallsDelta) {
                        if (typeof toolCallDelta.index === 'number') {
                             // Ensure the array is large enough
                            while (accumulatedToolCallsFromConversational.length <= toolCallDelta.index) {
                                accumulatedToolCallsFromConversational.push({ id: uuidv4(), type: 'function', function: { name: '', arguments: '' } });
                            }
                            if (!accumulatedToolCallsFromConversational[toolCallDelta.index]) {
                                accumulatedToolCallsFromConversational[toolCallDelta.index] = { id: toolCallDelta.id || uuidv4(), type: 'function', function: { name: '', arguments: '' } };
                            }
                            const currentToolCall = accumulatedToolCallsFromConversational[toolCallDelta.index];
                            if (toolCallDelta.id) currentToolCall.id = toolCallDelta.id;
                            if (toolCallDelta.function?.name) currentToolCall.function.name = toolCallDelta.function.name;
                            if (toolCallDelta.function?.arguments) currentToolCall.function.arguments += toolCallDelta.function.arguments;
                        }
                    }
                }

                 const finishReason = chunk.choices[0]?.finish_reason;
                 if (finishReason) break; // stop, length, or tool_calls
            }

            if (parser.parsing && !parserSuccessfullyCleanedUp) {
                parser.stopParsing();
            }

            const convModeToolCalls = accumulatedToolCallsFromConversational || [];
            const aiResponseMessage: Message = {
                role: 'assistant',
                content: fullTextResponse || null,
                tool_calls: convModeToolCalls.length > 0 ? convModeToolCalls : [] // Ensure array, not null
            };
            // if (accumulatedToolCallsFromConversational && accumulatedToolCallsFromConversational.length > 0) {
            //     aiResponseMessage.tool_calls = accumulatedToolCallsFromConversational;
                // If LLM generated text before calling request_tool_execution, that text is part of fullTextResponse
                // and will be sent via markdown parser. The 'Okay, I'll try...' part should be in the prompt example.
            // }
            history.push(aiResponseMessage); // Add this conversational turn's AI response
            this.conversationHistory.set(sessionId, this.trimHistory(history));

            if (convModeToolCalls.length > 0) {
                logger.info('Conversational mode LLM made tool calls. Returning to main processor.', { sessionId, toolCalls: convModeToolCalls });
                // The main `processMessage` will receive these tool calls (e.g. request_tool_execution or request_missing_parameters)
                // and process them in its next iteration or logic.
                return {
                    content: fullTextResponse, // Content generated before deciding to call tool
                    toolCalls: convModeToolCalls // Already in correct format for LLMResponse
                };
            }
            return { content: fullTextResponse, toolCalls: [] }; // Ensure array, not null

        } catch (error: any) {
            logger.error('Error in handleConversationalMode', { error: error.message, sessionId, conversationalModeProcessingId });
            // Similar error handling as processMessage
            this.emit('send_chunk', sessionId, { type: 'error', content: "Error in conversational mode.", messageId: currentMessageId, isFinal: true } as StreamChunk);
            if (parser.parsing && !parserSuccessfullyCleanedUp) parser.stopParsing();
            if (!parserSuccessfullyCleanedUp && unsubscribeFromParser) { unsubscribeFromParser(); MarkdownStreamParser.removeInstance(parserInstanceId); }
            return { content: "Sorry, an error occurred in conversational mode.", toolCalls: [] }; // Ensure array
        } finally {
            if (!parserSuccessfullyCleanedUp) {
                logger.warn('Parser (conversational_mode) not cleaned up by normal flow, forcing cleanup in finally.', { parserInstanceId });
                if (unsubscribeFromParser) unsubscribeFromParser();
                if (parser.parsing) parser.stopParsing();
                MarkdownStreamParser.removeInstance(parserInstanceId);
            }
        }
    }

    // Keep getActionAnalysis for potential future use
    public async getActionAnalysis(analysisPrompt: string, sessionId: string): Promise<string> {
       logger.info('Performing action analysis (getActionAnalysis called)', { sessionId });
        try {
            const messagesForApi: Message[] = [{ role: 'system', content: analysisPrompt }];
            const response = await this.client.chat.completions.create({
                model: this.model, messages: messagesForApi as any,
                max_tokens: this.maxTokens, temperature: 0.1,
                response_format: { type: "json_object" }, // Request JSON
                tools: undefined, tool_choice: undefined,
            });
            const content = response.choices[0]?.message?.content;
            if (!content) throw new Error('No content from action analysis LLM');
            return content;
        } catch (error: any) {
            logger.error('Error generating action analysis', { error: error.message, sessionId });
            throw new Error(`Failed action analysis: ${error.message}`);
        }
    }

    // --- Helper Methods ---
    private getHistory(sessionId: string): Message[] {
        return this.conversationHistory.get(sessionId) || [];
    }

    // Simple history trimming example (adjust as needed)
    private trimHistory(history: Message[], maxLength: number = 20): Message[] {
        if (history.length <= maxLength) {
            return history;
        }
        // System prompt is handled per-stream. This trim is for user/assistant messages.
        const systemPrompt = history[0]?.role === 'system' ? [history[0]] : [];
        const recentMessages = history.slice(-(maxLength - systemPrompt.length));
        return [...systemPrompt, ...recentMessages];
    }
}