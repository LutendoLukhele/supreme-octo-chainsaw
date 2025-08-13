"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConversationService = void 0;
// src/services/conversation/ConversationService.ts
const events_1 = require("events");
const groq_sdk_1 = __importDefault(require("groq-sdk"));
const winston_1 = __importDefault(require("winston"));
const uuid_1 = require("uuid");
const ToolConfigManager_1 = require("../tool/ToolConfigManager"); // Import manager
const markdown_stream_parser_1 = require("@lixpi/markdown-stream-parser"); // Ensure this import is correct
// Import new prompt templates
const mainConversationalPrompt_1 = require("./prompts/mainConversationalPrompt");
const markdownArtefactPrompt_1 = require("./prompts/markdownArtefactPrompt");
const dedicatedToolCallPrompt_1 = require("./prompts/dedicatedToolCallPrompt");
const logger = winston_1.default.createLogger({
    level: 'info',
    format: winston_1.default.format.combine(winston_1.default.format.timestamp(), winston_1.default.format.json()),
    transports: [new winston_1.default.transports.Console()],
});
const KEYWORD_TO_CATEGORY_MAP = {
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
function getRelevantToolCategories(userInput) {
    const detectedCategories = new Set();
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
class ConversationService extends events_1.EventEmitter {
    config;
    client;
    model;
    maxTokens;
    // private logger: winston.Logger; // Use shared logger instead
    conversationHistory = new Map();
    toolConfigManager; // Instance of ToolConfigManager
    constructor(config) {
        super(); // Call super() first in the constructor of a derived class
        this.config = config;
        if (!config.groqApiKey)
            throw new Error("Groq API key is missing in config.");
        this.client = new groq_sdk_1.default({ apiKey: config.groqApiKey });
        this.model = config.model;
        this.maxTokens = config.maxTokens;
        // *** Initialize ToolConfigManager ***
        this.toolConfigManager = new ToolConfigManager_1.ToolConfigManager(config.TOOL_CONFIG_PATH);
        logger.info('ToolConfigManager initialized.');
        // Optional: Log all tool names if helpful for debugging startup
        // logger.debug('All tool names from ToolConfigManager: ' + this.toolConfigManager.getAllToolNames().join(', '));
    }
    /**
     * Processes the user message, runs internal LLM streams, and returns aggregated tool calls.
     * Text, markdown, and tool call announcements are streamed to the client via 'send_chunk' events.
     */
    async processMessageAndAggregateResults(userMessage, sessionId, incomingMessageId, userId) {
        const messageProcessingId = (0, uuid_1.v4)();
        const currentMessageId = incomingMessageId || (0, uuid_1.v4)();
        logger.info('Processing message, will aggregate results', { sessionId, messageProcessingId, currentMessageId });
        const history = this.getHistory(sessionId);
        history.push({ role: 'user', content: userMessage });
        this.conversationHistory.set(sessionId, history);
        const relevantCategories = getRelevantToolCategories(userMessage);
        // 2. Get the filtered list of ToolConfig objects.
        const filteredToolConfigs = this.toolConfigManager.getToolsByCategories(relevantCategories);
        // 3. Convert the filtered ToolConfig objects to the Groq-compatible format.
        const filteredGroqTools = filteredToolConfigs.map(tool => {
            const inputSchema = this.toolConfigManager.getToolInputSchema(tool.name);
            if (!inputSchema)
                return null;
            return {
                type: "function",
                function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: inputSchema
                }
            };
        }).filter(t => t !== null);
        const initialUserQuery = history.find(m => m.role === 'user')?.content || userMessage;
        const aggregatedToolCallsOutput = [];
        // --- This variable will hold the text from the conversational stream ---
        let conversationalResponseText = "";
        const conversationalStreamPromise = this.runConversationalStream(userMessage, initialUserQuery, sessionId, currentMessageId, messageProcessingId, aggregatedToolCallsOutput, [...history], aggregatedToolCallsOutput).then(responseText => {
            // --- FIX: Capture the accumulated text when the stream finishes ---
            conversationalResponseText = responseText;
        });
        const toolCallStreamPromise = this.runToolCallStream(userMessage, sessionId, currentMessageId, messageProcessingId, [...history], aggregatedToolCallsOutput);
        // --- Stream 3: Markdown Artefact Stream (Disabled) ---
        // const markdownArtefactStreamPromise = this.runMarkdownArtefactStream(
        //     userMessage,
        //     initialUserQuery,
        //     sessionId,
        //     currentMessageId,
        //     messageProcessingId,
        //     [...history]
        // );
        await Promise.allSettled([conversationalStreamPromise, toolCallStreamPromise,]);
        logger.info('All ConversationService streams have settled. Returning aggregated results.', { sessionId });
        // --- FIX: Include the captured text in the final return object ---
        return {
            toolCalls: aggregatedToolCallsOutput.length > 0,
            aggregatedToolCalls: aggregatedToolCallsOutput,
            conversationalResponse: conversationalResponseText
        };
    }
    async runConversationalStream(currentUserMessage, initialUserQuery, sessionId, currentMessageId, messageProcessingId, toolsForThisStream, historyForThisStream, aggregatedToolCallsOutput // To collect tool calls
    ) {
        const streamId = `conversational_${messageProcessingId}`;
        logger.info('Starting main conversational stream', { sessionId, streamId });
        const parserInstanceId = `conv_parser_${sessionId}_${currentMessageId}`;
        const parser = markdown_stream_parser_1.MarkdownStreamParser.getInstance(parserInstanceId);
        let unsubscribeFromParser = null;
        let parserSuccessfullyCleanedUp = false;
        let accumulatedText = "";
        let accumulatedToolCalls = null;
        try {
            unsubscribeFromParser = parser.subscribeToTokenParse((parsedSegment) => {
                const isLastSegmentFromParser = parsedSegment.status === 'END_STREAM';
                this.emit('send_chunk', sessionId, {
                    type: 'conversational_text_segment',
                    content: parsedSegment,
                    messageId: currentMessageId,
                    isFinal: isLastSegmentFromParser,
                    streamType: 'conversational'
                });
                if (isLastSegmentFromParser) {
                    if (unsubscribeFromParser) {
                        unsubscribeFromParser();
                        unsubscribeFromParser = null;
                    }
                    markdown_stream_parser_1.MarkdownStreamParser.removeInstance(parserInstanceId);
                    parserSuccessfullyCleanedUp = true;
                }
            });
            parser.startParsing();
            const systemPromptContent = mainConversationalPrompt_1.MAIN_CONVERSATIONAL_SYSTEM_PROMPT_TEMPLATE
                .replace('{{USER_INITIAL_QUERY}}', initialUserQuery)
                .replace('{{USER_CURRENT_MESSAGE}}', currentUserMessage);
            const messagesForApi = [
                { role: 'system', content: systemPromptContent },
                ...this.prepareHistoryForLLM(historyForThisStream)
            ];
            const toolsForThisStream = this.toolConfigManager.getGroqToolsDefinition();
            // Add this debug log:
            logger.debug('Tools being sent to Groq API (Conversational Stream):', {
                sessionId,
                messageId: currentMessageId,
                tools: JSON.stringify(toolsForThisStream, null, 2) // Stringify for readability
            });
            const responseStream = await this.client.chat.completions.create({
                model: this.model,
                messages: messagesForApi,
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
                    if (!accumulatedToolCalls)
                        accumulatedToolCalls = [];
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
                        }
                        catch (parseError) {
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
                        });
                    }
                });
            }
            const assistantResponse = {
                role: 'assistant',
                content: accumulatedText || null,
                tool_calls: accumulatedToolCalls || []
            };
            const currentHistory = this.getHistory(sessionId);
            currentHistory.push(assistantResponse);
            this.conversationHistory.set(sessionId, this.trimHistory(currentHistory));
        }
        catch (error) {
            logger.error('Error in conversational stream', { error: error.message, sessionId, streamId });
            this.emit('send_chunk', sessionId, {
                type: 'error',
                content: "Error in conversational stream.",
                messageId: currentMessageId,
                isFinal: true,
                streamType: 'conversational'
            });
            if (parser.parsing && !parserSuccessfullyCleanedUp)
                parser.stopParsing();
        }
        finally {
            if (!parserSuccessfullyCleanedUp) {
                if (unsubscribeFromParser)
                    unsubscribeFromParser();
                if (parser.parsing)
                    parser.stopParsing();
                markdown_stream_parser_1.MarkdownStreamParser.removeInstance(parserInstanceId);
            }
            this.emit('send_chunk', sessionId, { type: 'stream_end', streamType: 'conversational', messageId: currentMessageId, isFinal: true });
            logger.info('Conversational stream processing complete.', { sessionId, streamId });
        }
        return accumulatedText;
    }
    async runToolCallStream(currentUserMessage, sessionId, currentMessageId, messageProcessingId, historyForThisStream, // Not used by current prompt but available
    aggregatedToolCallsOutput // To collect tool calls
    ) {
        const streamId = `tool_call_${messageProcessingId}`;
        logger.info('Starting dedicated tool identification stream', { sessionId, streamId });
        let accumulatedToolCalls = null;
        let accumulatedTextFromToolStream = "";
        try {
            // This prompt is specifically for identifying *any* potential tool calls,
            // not just the planner tool.
            const systemPromptContent = dedicatedToolCallPrompt_1.DEDICATED_TOOL_CALL_SYSTEM_PROMPT_TEMPLATE
                .replace('{{USER_CURRENT_MESSAGE}}', currentUserMessage);
            const messagesForApi = [
                { role: 'system', content: systemPromptContent },
                { role: 'user', content: currentUserMessage } // Reinforce current message
            ];
            const allTools = this.toolConfigManager.getGroqToolsDefinition();
            if (!allTools || allTools.length === 0) {
                logger.warn('Tool call stream has no tools defined.', { sessionId, streamId });
                this.emit('send_chunk', sessionId, { type: 'stream_end', streamType: 'tool_call', messageId: currentMessageId, isFinal: true }); // Ensure stream_end is sent
                return;
            }
            // Add this debug log:
            logger.debug('Tools being sent to Groq API (Tool Call Stream):', {
                sessionId,
                messageId: currentMessageId,
                tools: JSON.stringify(allTools, null, 2) // Stringify for readability
            });
            const responseStream = await this.client.chat.completions.create({
                model: this.model,
                messages: messagesForApi,
                tools: allTools,
                tool_choice: "auto",
                stream: true,
                temperature: 0.0, // Strict
                max_tokens: 500, // Generous for tool args, but not for chatting
            });
            for await (const chunk of responseStream) {
                const toolCallsDelta = chunk.choices[0]?.delta?.tool_calls;
                const contentDelta = chunk.choices[0]?.delta?.content;
                if (contentDelta) {
                    accumulatedTextFromToolStream += contentDelta;
                }
                if (toolCallsDelta) {
                    if (!accumulatedToolCalls)
                        accumulatedToolCalls = [];
                    this.accumulateToolCallDeltas(accumulatedToolCalls, toolCallsDelta);
                }
                const finishReason = chunk.choices[0]?.finish_reason;
                if (finishReason) {
                    logger.info(`Dedicated tool identification stream finished. Reason: ${finishReason}`, { sessionId, streamId, finishReason });
                    break;
                }
            }
            if (accumulatedTextFromToolStream.trim() === "No tool applicable.") {
                logger.info('Dedicated tool stream explicitly stated no tool applicable.', { sessionId, streamId });
            }
            else if (accumulatedTextFromToolStream.trim() !== "") {
                logger.warn('Tool call stream generated unexpected text content', { sessionId, streamId, content: accumulatedTextFromToolStream });
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
                            logger.info('Dedicated tool stream collected tool_call', { sessionId, streamId, toolCallId: tc.id, name: tc.function.name });
                        }
                        catch (parseError) {
                            logger.error("Failed to parse tool arguments from dedicated tool stream for aggregation", { toolCallId: tc.id, args: tc.function.arguments, error: parseError.message });
                        }
                        // Still emit for client visibility / original flow if desired
                        this.emit('send_chunk', sessionId, {
                            type: 'dedicated_tool_call',
                            content: { id: tc.id, function: { name: tc.function.name, arguments: tc.function.arguments } },
                            messageId: currentMessageId,
                            toolCallId: tc.id,
                            isFinal: false,
                            streamType: 'tool_call'
                        });
                    }
                });
            }
            else if (accumulatedTextFromToolStream.trim() !== "No tool applicable.") { // Only log if no calls AND no explicit "No tool" text
                logger.info('Dedicated tool stream did not identify any tool calls.', { sessionId, streamId });
            }
        }
        catch (error) {
            logger.error('Error in tool call stream', { error: error.message, sessionId, streamId });
            this.emit('send_chunk', sessionId, {
                type: 'error',
                content: "Error in tool processing stream.",
                messageId: currentMessageId,
                isFinal: true,
                streamType: 'tool_call'
            });
        }
        finally {
            this.emit('send_chunk', sessionId, { type: 'stream_end', streamType: 'tool_call', messageId: currentMessageId, isFinal: true }); // Ensure stream_end is sent
            logger.info('Tool call stream processing complete.', { sessionId, streamId });
        }
    }
    async runMarkdownArtefactStream(currentUserMessage, initialUserQuery, sessionId, currentMessageId, messageProcessingId, historyForThisStream) {
        const streamId = `markdown_artefact_${messageProcessingId}`;
        logger.info('Starting Markdown artefact stream', { sessionId, streamId });
        const parserInstanceId = `md_artefact_parser_${sessionId}_${currentMessageId}`;
        const parser = markdown_stream_parser_1.MarkdownStreamParser.getInstance(parserInstanceId);
        let unsubscribeFromParser = null;
        let parserSuccessfullyCleanedUp = false;
        try {
            unsubscribeFromParser = parser.subscribeToTokenParse((parsedSegment) => {
                const isLastSegmentFromParser = parsedSegment.status === 'END_STREAM';
                this.emit('send_chunk', sessionId, {
                    type: 'markdown_artefact_segment',
                    content: parsedSegment,
                    messageId: currentMessageId,
                    isFinal: isLastSegmentFromParser,
                    streamType: 'markdown_artefact'
                });
                if (isLastSegmentFromParser) {
                    if (unsubscribeFromParser) {
                        unsubscribeFromParser();
                        unsubscribeFromParser = null;
                    }
                    markdown_stream_parser_1.MarkdownStreamParser.removeInstance(parserInstanceId);
                    parserSuccessfullyCleanedUp = true;
                }
            });
            parser.startParsing();
            const historySnippet = this.prepareHistoryForLLM(historyForThisStream)
                .slice(-3) // Last 3 turns for snippet
                .map(m => `${m.role}: ${m.content?.substring(0, 75) || (m.tool_calls ? 'tool_call' : 'no text content')}...`)
                .join('\n');
            const systemPromptContent = markdownArtefactPrompt_1.MARKDOWN_ARTEFACT_SYSTEM_PROMPT_TEMPLATE
                .replace('{{USER_INITIAL_QUERY}}', initialUserQuery)
                .replace('{{USER_CURRENT_MESSAGE}}', currentUserMessage)
                .replace('{{CONVERSATION_HISTORY_SNIPPET}}', historySnippet);
            const messagesForApi = [{ role: 'system', content: systemPromptContent }];
            const responseStream = await this.client.chat.completions.create({
                model: this.model,
                messages: messagesForApi,
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
        }
        catch (error) {
            logger.error('Error in Markdown artefact stream', { error: error.message, sessionId, streamId });
            this.emit('send_chunk', sessionId, {
                type: 'error',
                content: "Error in Markdown thoughts stream.",
                messageId: currentMessageId,
                isFinal: true,
                streamType: 'markdown_artefact'
            });
            if (parser.parsing && !parserSuccessfullyCleanedUp)
                parser.stopParsing();
        }
        finally {
            if (!parserSuccessfullyCleanedUp) {
                if (unsubscribeFromParser)
                    unsubscribeFromParser();
                if (parser.parsing)
                    parser.stopParsing();
                markdown_stream_parser_1.MarkdownStreamParser.removeInstance(parserInstanceId);
            }
            this.emit('send_chunk', sessionId, { type: 'stream_end', streamType: 'markdown_artefact', messageId: currentMessageId, isFinal: true });
            logger.info('Markdown artefact stream processing complete.', { sessionId, streamId });
        }
    }
    accumulateToolCallDeltas(currentToolCalls, toolCallDeltas) {
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
                    currentToolCalls[toolCallDelta.index].type = toolCallDelta.type;
                }
            }
        }
    }
    prepareHistoryForLLM(history) {
        const filteredHistory = history.filter(msg => msg.role !== 'system' &&
            (msg.content || (msg.tool_calls && msg.tool_calls.length > 0)));
        return this.trimHistory(filteredHistory);
    }
    async handleConversationalMode(currentUserMessage, // The most recent message from the user in this turn
    initialUserQueryForMode, // The query that LLM decided was conversational
    sessionId, currentMessageId, // ID for the overall interaction cycle
    history // Current history up to this point
    ) {
        const conversationalModeProcessingId = (0, uuid_1.v4)(); // This method will be removed or heavily refactored
        logger.info('Entering conversational mode handler', { sessionId, conversationalModeProcessingId, currentMessageId, initialUserQueryForMode, currentUserMessage });
        const parserInstanceId = `conv_mode_${sessionId}_${currentMessageId}_${conversationalModeProcessingId}_parser`;
        const parser = markdown_stream_parser_1.MarkdownStreamParser.getInstance(parserInstanceId);
        let unsubscribeFromParser = null;
        let parserSuccessfullyCleanedUp = false;
        let fullTextResponse = '';
        let accumulatedToolCallsFromConversational = null;
        try {
            unsubscribeFromParser = parser.subscribeToTokenParse((parsedSegment) => {
                logger.debug('Markdown parser emitted segment for conversational mode', { parserInstanceId, status: parsedSegment.status, type: parsedSegment.segment?.type });
                const isLastSegmentFromParser = parsedSegment.status === 'END_STREAM';
                this.emit('send_chunk', sessionId, {
                    type: 'parsed_markdown_segment',
                    content: parsedSegment,
                    messageId: currentMessageId,
                    isFinal: isLastSegmentFromParser,
                });
                if (isLastSegmentFromParser) {
                    logger.info('Markdown parser (conversational_mode) emitted END_STREAM. Cleaning up.', { parserInstanceId });
                    if (unsubscribeFromParser) {
                        unsubscribeFromParser();
                        unsubscribeFromParser = null;
                    }
                    markdown_stream_parser_1.MarkdownStreamParser.removeInstance(parserInstanceId);
                    parserSuccessfullyCleanedUp = true;
                }
            });
            parser.startParsing();
            // This was the old way, now the main conversational stream handles this with its own prompt.
            const conversationalPrompt = mainConversationalPrompt_1.MAIN_CONVERSATIONAL_SYSTEM_PROMPT_TEMPLATE // Example: using new main prompt
                .replace('{{USER_INITIAL_QUERY}}', initialUserQueryForMode)
                .replace('{{USER_CURRENT_MESSAGE}}', currentUserMessage);
            const messagesForApi = [
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
                messages: messagesForApi,
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
                    if (!accumulatedToolCallsFromConversational)
                        accumulatedToolCallsFromConversational = [];
                    for (const toolCallDelta of toolCallsDelta) {
                        if (typeof toolCallDelta.index === 'number') {
                            // Ensure the array is large enough
                            while (accumulatedToolCallsFromConversational.length <= toolCallDelta.index) {
                                accumulatedToolCallsFromConversational.push({ id: (0, uuid_1.v4)(), type: 'function', function: { name: '', arguments: '' } });
                            }
                            if (!accumulatedToolCallsFromConversational[toolCallDelta.index]) {
                                accumulatedToolCallsFromConversational[toolCallDelta.index] = { id: toolCallDelta.id || (0, uuid_1.v4)(), type: 'function', function: { name: '', arguments: '' } };
                            }
                            const currentToolCall = accumulatedToolCallsFromConversational[toolCallDelta.index];
                            if (toolCallDelta.id)
                                currentToolCall.id = toolCallDelta.id;
                            if (toolCallDelta.function?.name)
                                currentToolCall.function.name = toolCallDelta.function.name;
                            if (toolCallDelta.function?.arguments)
                                currentToolCall.function.arguments += toolCallDelta.function.arguments;
                        }
                    }
                }
                const finishReason = chunk.choices[0]?.finish_reason;
                if (finishReason)
                    break; // stop, length, or tool_calls
            }
            if (parser.parsing && !parserSuccessfullyCleanedUp) {
                parser.stopParsing();
            }
            const convModeToolCalls = accumulatedToolCallsFromConversational || [];
            const aiResponseMessage = {
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
        }
        catch (error) {
            logger.error('Error in handleConversationalMode', { error: error.message, sessionId, conversationalModeProcessingId });
            // Similar error handling as processMessage
            this.emit('send_chunk', sessionId, { type: 'error', content: "Error in conversational mode.", messageId: currentMessageId, isFinal: true });
            if (parser.parsing && !parserSuccessfullyCleanedUp)
                parser.stopParsing();
            if (!parserSuccessfullyCleanedUp && unsubscribeFromParser) {
                unsubscribeFromParser();
                markdown_stream_parser_1.MarkdownStreamParser.removeInstance(parserInstanceId);
            }
            return { content: "Sorry, an error occurred in conversational mode.", toolCalls: [] }; // Ensure array
        }
        finally {
            if (!parserSuccessfullyCleanedUp) {
                logger.warn('Parser (conversational_mode) not cleaned up by normal flow, forcing cleanup in finally.', { parserInstanceId });
                if (unsubscribeFromParser)
                    unsubscribeFromParser();
                if (parser.parsing)
                    parser.stopParsing();
                markdown_stream_parser_1.MarkdownStreamParser.removeInstance(parserInstanceId);
            }
        }
    }
    // Keep getActionAnalysis for potential future use
    async getActionAnalysis(analysisPrompt, sessionId) {
        logger.info('Performing action analysis (getActionAnalysis called)', { sessionId });
        try {
            const messagesForApi = [{ role: 'system', content: analysisPrompt }];
            const response = await this.client.chat.completions.create({
                model: this.model, messages: messagesForApi,
                max_tokens: this.maxTokens, temperature: 0.1,
                response_format: { type: "json_object" }, // Request JSON
                tools: undefined, tool_choice: undefined,
            });
            const content = response.choices[0]?.message?.content;
            if (!content)
                throw new Error('No content from action analysis LLM');
            return content;
        }
        catch (error) {
            logger.error('Error generating action analysis', { error: error.message, sessionId });
            throw new Error(`Failed action analysis: ${error.message}`);
        }
    }
    // --- Helper Methods ---
    getHistory(sessionId) {
        return this.conversationHistory.get(sessionId) || [];
    }
    // Simple history trimming example (adjust as needed)
    trimHistory(history, maxLength = 20) {
        if (history.length <= maxLength) {
            return history;
        }
        // System prompt is handled per-stream. This trim is for user/assistant messages.
        const systemPrompt = history[0]?.role === 'system' ? [history[0]] : [];
        const recentMessages = history.slice(-(maxLength - systemPrompt.length));
        return [...systemPrompt, ...recentMessages];
    }
}
exports.ConversationService = ConversationService;
