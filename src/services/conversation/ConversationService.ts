// src/services/conversation/ConversationService.ts
import { EventEmitter } from 'events';
import Groq from 'groq-sdk';
import winston from 'winston';
import { v4 as uuidv4 } from 'uuid';
import { ConversationConfig, Message, LLMResponse, ToolResult } from './types';
import { ToolConfigManager } from '../tool/ToolConfigManager'; // Import manager
import { MarkdownStreamParser } from '@lixpi/markdown-stream-parser'; // Ensure this import is correct
import { StreamChunk } from '../stream/types';
import { CONVERSATIONAL_ARTEFACT_SYSTEM_PROMPT_TEMPLATE } from '../conversational_prompt_template'

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
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.json()
    ),
    transports: [new winston.transports.Console()],
  });

export class ConversationService extends EventEmitter {
    private client: Groq;
    private model: string;
    private maxTokens: number;
    // private logger: winston.Logger; // Use shared logger instead
    private conversationHistory: Map<string, Message[]> = new Map();
    private toolConfigManager: ToolConfigManager; // Instance of ToolConfigManager

    constructor(private config: ConversationConfig) {
        super(); // Call super() first in the constructor of a derived class
        if (!config.groqApiKey) throw new Error("Groq API key is missing in config.");
        this.client = new Groq({ apiKey: config.groqApiKey });
        this.model = config.model;
        this.maxTokens = config.maxTokens;


        // *** Initialize ToolConfigManager ***
        this.toolConfigManager = new ToolConfigManager(config.TOOL_CONFIG_PATH);
        logger.info('ToolConfigManager initialized.');
        // Optional: Log all tool names if helpful for debugging startup
        // logger.debug('All tool names from ToolConfigManager: ' + this.toolConfigManager.getAllToolNames().join(', '));
    }

    public async processMessage(userMessage: string, sessionId: string, incomingMessageId?: string): Promise<LLMResponse> {
        const messageProcessingId = uuidv4(); // For internal tracking
        const currentMessageId = incomingMessageId || uuidv4(); // ID for this user message and AI response cycle

        logger.info('Processing message with streaming', { sessionId, userMessage, messageProcessingId, currentMessageId });

        const history = this.getHistory(sessionId);
        history.push({ role: 'user', content: userMessage }); // Consider adding name: currentMessageId if useful for history

        // Initialize Markdown Parser
        const parserInstanceId = `conversation_${sessionId}_${currentMessageId}_${messageProcessingId}_parser`;
        const parser = MarkdownStreamParser.getInstance(parserInstanceId);
        let unsubscribeFromParser: (() => void) | null = null;
        let parserSuccessfullyCleanedUp = false;

        // Variables to accumulate the full response for history and return
        let fullTextResponse = '';
        let accumulatedToolCalls: Groq.Chat.Completions.ChatCompletionMessageToolCall[] | null = null;

        try {
            unsubscribeFromParser = parser.subscribeToTokenParse((parsedSegment: LixpiParsedSegment) => {
                logger.debug('Markdown parser emitted segment for conversation', { parserInstanceId, status: parsedSegment.status, type: parsedSegment.segment?.type });
                const isLastSegmentFromParser = parsedSegment.status === 'END_STREAM';

                this.emit('send_chunk', sessionId, {
                    type: 'parsed_markdown_segment',
                    content: parsedSegment,
                    messageId: currentMessageId,
                    isFinal: isLastSegmentFromParser, // This is final for this segment from parser
                } as StreamChunk);

                if (isLastSegmentFromParser) {
                    logger.info('Markdown parser (conversation) emitted END_STREAM. Cleaning up.', { parserInstanceId });
                    if (unsubscribeFromParser) { unsubscribeFromParser(); unsubscribeFromParser = null; }
                    MarkdownStreamParser.removeInstance(parserInstanceId);
                    parserSuccessfullyCleanedUp = true;
                }
            });

            parser.startParsing();

            // Format all tools (including meta-tool) for the prompt
            const availableToolsPrompt = this.toolConfigManager.formatToolsForLLMPrompt();
            logger.debug('Formatted tools for system prompt (availableToolsPrompt):', { data: availableToolsPrompt });

            const systemPrompt: Message = {
                role: 'system',
                content: `
You are a highly intelligent assistant responsible for understanding user requests and coordinating actions.

*** CRITICAL PROTOCOL - FOLLOW EXACTLY ***

1.  **Analyze User Intent:** Determine if the user's request is a direct command for a specific tool/action OR if it's a more general conversational query (seeking information, discussion, planning, creative generation like lists or summaries).

2.  **Decision Point - Mode Selection:**
    *   **IF the query is general, conversational, or seeks artefact generation (and NOT a direct command for an existing tool):**
        *   You MUST use the tool named 'trigger_conversational_mode'.
        *   Pass the user's original query to its 'user_query' parameter.
        *   DO NOT attempt to answer these general queries directly.
    *   **IF the query is a direct command for a specific executable tool:**
        *   Proceed to step 3 (Parameter Check).

3.  **Parameter Check (Only if it's a direct tool command):**
    *   Identify the selected tool and ALL its *required* parameters from its description.
    *   Verify if the user *explicitly* provided a value for *every single required parameter*. Check the tool's configuration.
    *   **IF ALL REQUIRED PARAMETERS ARE CLEARLY PROVIDED AND UNAMBIGUOUS:**
        *   You MAY call the intended tool directly with the provided arguments.
    *   **OTHERWISE (IF EVEN ONE REQUIRED PARAMETER IS MISSING, UNCLEAR, OR AMBIGUOUS for the intended tool):**
        *   **DO NOT CALL THE INTENDED TOOL.** This is a strict rule.
        *   **YOU MUST INSTEAD CALL THE TOOL NAMED 'request_missing_parameters'.** Use it to ask the user for the specific missing information needed for the *intended tool*.
        *   In the 'clarification_question' for 'request_missing_parameters', be very specific about what you need.

**Examples:**
*   User: "Help me plan my week." -> Call 'trigger_conversational_mode'.
*   User: "Send an email." (send_email needs 'to', 'subject', 'body') -> Call 'request_missing_parameters'.
*   User: "Fetch my deals." (fetch_entity needs 'entityType'='Deal', 'operation'='fetch' - these are clear from context) -> Call 'fetch_entity'.

**Available Tools (for this initial routing decision):**
${availableToolsPrompt} 

`
                // --- End Aggressive Prompt ---
            };

            const messagesForApi = [systemPrompt, ...history];

            // Get only executable tools for Groq API
            // IMPORTANT: If request_missing_parameters is intended to be called by the LLM,
            // it MUST be included here. Let's assume getGroqToolsDefinition can take a boolean
            // to include meta_tools, or you have another method for this.
            // Forcing inclusion for now for testing this hypothesis:
            const groqTools = this.toolConfigManager.getGroqToolsDefinition(); // Pass true to include meta-tools
            // const groqToolsOriginal = this.toolConfigManager.getGroqToolsDefinition(); // Original way
            logger.debug('Tools passed to Groq API (tools parameter):', { tools: JSON.stringify(groqTools, null, 2) });

            logger.debug("Sending request to Groq API", { sessionId, messageCount: messagesForApi.length, toolCount: groqTools?.length ?? 0 });
            const responseStream = await this.client.chat.completions.create({
                model: this.model,
                messages: messagesForApi as any,
                max_tokens: this.maxTokens,
                tools: groqTools, // Pass definitions EXCLUDING the meta-tool
                stream: true, // ENABLE STREAMING
                temperature: 0.1 // Adjust temperature as needed
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
                    if (!accumulatedToolCalls) accumulatedToolCalls = [];

                    for (const toolCallDelta of toolCallsDelta) {
                        if (typeof toolCallDelta.index === 'number') {
                            if (!accumulatedToolCalls[toolCallDelta.index]) {
                                accumulatedToolCalls[toolCallDelta.index] = {
                                    id: toolCallDelta.id || '', // ID might come first
                                    type: 'function', // Default, always 'function' for Groq
                                    function: { name: '', arguments: '' },
                                };
                            }
                            const currentToolCall = accumulatedToolCalls[toolCallDelta.index];
                            if (toolCallDelta.id) {
                                currentToolCall.id = toolCallDelta.id;
                            }
                            // type is always 'function', so no need to update if delta.type exists
                            if (toolCallDelta.function?.name) {
                                currentToolCall.function.name = toolCallDelta.function.name;
                            }
                            if (toolCallDelta.function?.arguments) {
                                currentToolCall.function.arguments += toolCallDelta.function.arguments;
                            }
                        }
                    }
                }

                const finishReason = chunk.choices[0]?.finish_reason;
                if (finishReason === 'tool_calls' || (finishReason === 'stop' && accumulatedToolCalls)) {
                    if (accumulatedToolCalls) {
                        accumulatedToolCalls.forEach(tc => {
                            // Check if it's the trigger for conversational mode
                            if (tc.function.name === 'trigger_conversational_mode') {
                                logger.info('LLM requested to trigger conversational mode.', { sessionId, toolCallId: tc.id, args: tc.function.arguments });
                                const args = JSON.parse(tc.function.arguments || '{}');
                                // We will handle this *after* the loop, as it involves a new LLM call.
                                // For now, just log and prepare. The return value will indicate this.
                                // We don't emit a 'tool_call' chunk for this meta-tool.
                                // Instead, the service will internally switch to the conversational handler.
                                // The `fullTextResponse` accumulated so far might be a lead-in from the LLM before deciding to switch.
                                // We'll pass the original userMessage that initiated this `processMessage` call.
                                return; // Skip emitting tool_call chunk for this meta-tool
                            }

                            if (tc.id && tc.function.name) { // Reasonably complete
                                this.emit('send_chunk', sessionId, {
                                    type: 'tool_call',
                                    content: {
                                        id: tc.id,
                                        function: { name: tc.function.name, arguments: tc.function.arguments }
                                    },
                                    messageId: currentMessageId,
                                    toolCallId: tc.id,
                                    isFinal: false, // A tool call itself isn't "final" for the markdown stream
                                } as StreamChunk);
                                logger.info('Emitted tool_call chunk', { sessionId, toolCallId: tc.id, name: tc.function.name });
                            }
                        });
                    }
                }

                if (finishReason === 'stop' || finishReason === 'length' || finishReason === 'tool_calls') {
                    logger.info(`LLM stream finished for conversation. Reason: ${finishReason}`, { sessionId, messageProcessingId, finishReason });
                    break;
                }
            }

            // Stop the parser after the LLM stream is fully processed
            if (parser.parsing && !parserSuccessfullyCleanedUp) {
                parser.stopParsing(); // This should trigger the END_STREAM in the subscriber
            }

            // After stream processing, check if conversational mode was triggered
            const conversationalModeTrigger = accumulatedToolCalls?.find(tc => tc.function.name === 'trigger_conversational_mode');
            if (conversationalModeTrigger) {
                logger.info('Switching to conversational mode handler.', { sessionId, messageProcessingId });
                const triggerArgs = JSON.parse(conversationalModeTrigger.function.arguments || '{}');
                // The `user_query` from the trigger_conversational_mode tool is the original query that the LLM decided was conversational.
                // We use `userMessage` which is the latest message from the user in this turn.
                return this.handleConversationalMode(userMessage, triggerArgs.user_query || userMessage, sessionId, currentMessageId, history);
            }

            // Ensure the AI response (text or non-trigger tool calls) is added to history
            const assistantToolCalls = accumulatedToolCalls?.filter(tc => tc.function.name !== 'trigger_conversational_mode') || [];
            const finalAiMessageForHistory: Message = {
                role: 'assistant',
                content: fullTextResponse || null, // Can be null if only tool_calls
                tool_calls: assistantToolCalls.length > 0 ? assistantToolCalls : [] // Ensure array, not null
            };
            // Always push the assistant's turn to history
            history.push(finalAiMessageForHistory);
            this.conversationHistory.set(sessionId, this.trimHistory(history)); // Save trimmed history

            logger.info('AI response processed and history updated (streaming)', {
                sessionId,
                messageProcessingId,
                responseLength: fullTextResponse.length,
                toolCallCount: assistantToolCalls.length,
            });

            // Map response to LLMResponse format
            return {
                content: fullTextResponse || null,
                toolCalls: assistantToolCalls.length > 0 ? assistantToolCalls.map(tc => ({
                    id: tc.id,
                    // type: tc.type, // 'function' is implied for LLMResponse toolCalls
                    function: {
                        name: tc.function.name,
                        arguments: tc.function.arguments,
                    }
                })) : [] // Ensure array, not null
            };
        } catch (error: any) {
            logger.error('Error processing message with Groq (streaming)', { error: error.message || error, details: error, sessionId, messageProcessingId });
            // history.pop(); // User message already pushed. AI response failed.

            this.emit('send_chunk', sessionId, {
                type: 'error',
                content: "Sorry, I encountered an error communicating with the AI. Please try again.",
                messageId: currentMessageId,
                isFinal: true,
            } as StreamChunk);

            if (parser.parsing && !parserSuccessfullyCleanedUp) {
                parser.stopParsing(); // Attempt graceful stop
            }
            if (!parserSuccessfullyCleanedUp) { // Ensure cleanup if stopParsing didn't trigger END_STREAM or if subscription failed
                 if (unsubscribeFromParser) unsubscribeFromParser();
                 MarkdownStreamParser.removeInstance(parserInstanceId);
                 // parserSuccessfullyCleanedUp = true; // Not strictly needed here as we are in catch
            }
            // Ensure toolCalls is an empty array in case of error too, consistent with LLMResponse type if not null
            return { content: "Sorry, I encountered an error communicating with the AI. Please try again.", toolCalls: [] };
        } finally {
            // Final safety net for parser cleanup
            if (!parserSuccessfullyCleanedUp) {
                logger.warn('Parser (conversation) not cleaned up by normal flow, forcing cleanup in finally.', { parserInstanceId });
                if (unsubscribeFromParser) {
                    unsubscribeFromParser();
                }
                if (parser.parsing) { // Check if it's still parsing before stopping
                    parser.stopParsing();
                }
                MarkdownStreamParser.removeInstance(parserInstanceId);
            }
        }
    }

    private async handleConversationalMode(
        currentUserMessage: string, // The most recent message from the user in this turn
        initialUserQueryForMode: string, // The query that LLM decided was conversational
        sessionId: string,
        currentMessageId: string, // ID for the overall interaction cycle
        history: Message[] // Current history up to this point
    ): Promise<LLMResponse> {
        const conversationalModeProcessingId = uuidv4();
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
                } as StreamChunk);
                if (isLastSegmentFromParser) {
                    logger.info('Markdown parser (conversational_mode) emitted END_STREAM. Cleaning up.', { parserInstanceId });
                    if (unsubscribeFromParser) { unsubscribeFromParser(); unsubscribeFromParser = null; }
                    MarkdownStreamParser.removeInstance(parserInstanceId);
                    parserSuccessfullyCleanedUp = true;
                }
            });
            parser.startParsing();

            const conversationalPrompt = CONVERSATIONAL_ARTEFACT_SYSTEM_PROMPT_TEMPLATE
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
        // Keep system prompt (if first) and the latest messages
        const systemPrompt = history[0]?.role === 'system' ? [history[0]] : [];
        const recentMessages = history.slice(-(maxLength - systemPrompt.length));
        return [...systemPrompt, ...recentMessages];
    }
}