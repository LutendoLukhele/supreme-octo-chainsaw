"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConversationService = void 0;
const events_1 = require("events");
const groq_sdk_1 = __importDefault(require("groq-sdk"));
const winston_1 = __importDefault(require("winston"));
const uuid_1 = require("uuid");
const ToolConfigManager_1 = require("../tool/ToolConfigManager");
const markdown_stream_parser_1 = require("@lixpi/markdown-stream-parser");
const mainConversationalPrompt_1 = require("./prompts/mainConversationalPrompt");
const markdownArtefactPrompt_1 = require("./prompts/markdownArtefactPrompt");
const dedicatedToolCallPrompt_1 = require("./prompts/dedicatedToolCallPrompt");
const PLANNER_META_TOOL = {
    type: "function",
    function: {
        name: "planParallelActions",
        description: "Use this when a user's request is complex and requires multiple steps or actions to be planned. This triggers the main planning process.",
        parameters: {
            type: "object",
            properties: {
                userInput: {
                    type: "string",
                    description: "The original, full text of the user's complex request."
                },
                preliminaryToolCalls: {
                    type: "array",
                    description: "A list of potential tool calls already identified.",
                    items: { "type": "object" }
                }
            },
            required: ["userInput"]
        }
    }
};
const logger = winston_1.default.createLogger({
    level: 'info',
    format: winston_1.default.format.combine(winston_1.default.format.timestamp(), winston_1.default.format.json()),
    transports: [new winston_1.default.transports.Console()],
});
const KEYWORD_TO_CATEGORY_MAP = {
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
function getRelevantToolCategories(userInput) {
    const detectedCategories = new Set();
    const lowerInput = userInput.toLowerCase();
    for (const keyword in KEYWORD_TO_CATEGORY_MAP) {
        if (lowerInput.includes(keyword)) {
            detectedCategories.add(KEYWORD_TO_CATEGORY_MAP[keyword]);
        }
    }
    if (detectedCategories.size === 0) {
        return ['Email', 'Calendar', 'CRM'];
    }
    return Array.from(detectedCategories);
}
class ConversationService extends events_1.EventEmitter {
    constructor(config) {
        super();
        this.config = config;
        this.conversationHistory = new Map();
        if (!config.groqApiKey)
            throw new Error("Groq API key is missing in config.");
        this.client = new groq_sdk_1.default({ apiKey: config.groqApiKey });
        this.model = config.model;
        this.maxTokens = config.maxTokens;
        this.toolConfigManager = new ToolConfigManager_1.ToolConfigManager();
        logger.info('ToolConfigManager initialized within ConversationService.');
    }
    async processMessageAndAggregateResults(userMessage, sessionId, incomingMessageId, _userId) {
        const messageProcessingId = (0, uuid_1.v4)();
        const currentMessageId = incomingMessageId || (0, uuid_1.v4)();
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
        const aggregatedToolCallsOutput = [];
        let conversationalResponseText = "";
        const conversationalStreamPromise = this.runConversationalStream(userMessage, initialUserQuery, sessionId, currentMessageId, messageProcessingId, filteredGroqTools, [...history], aggregatedToolCallsOutput).then(responseText => {
            conversationalResponseText = responseText;
        });
        const toolCallStreamPromise = this.runToolCallStream(userMessage, sessionId, currentMessageId, messageProcessingId, [...history], aggregatedToolCallsOutput, filteredGroqTools);
        await Promise.allSettled([conversationalStreamPromise, toolCallStreamPromise]);
        logger.info('All ConversationService streams have settled.', { sessionId });
        return {
            toolCalls: aggregatedToolCallsOutput.length > 0,
            aggregatedToolCalls: aggregatedToolCallsOutput,
            conversationalResponse: conversationalResponseText
        };
    }
    async runConversationalStream(currentUserMessage, initialUserQuery, sessionId, currentMessageId, messageProcessingId, _toolsForThisStream, historyForThisStream, aggregatedToolCallsOutput) {
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
            const toolsForThisStream = this.toolConfigManager.getGroqToolsDefinition() || [];
            toolsForThisStream.push(PLANNER_META_TOOL);
            logger.debug('Tools being sent to Groq API (Conversational Stream):', {
                sessionId,
                messageId: currentMessageId,
                tools: JSON.stringify(toolsForThisStream, null, 2)
            });
            const responseStream = await this.client.chat.completions.create({
                model: this.model,
                messages: messagesForApi,
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
    async runToolCallStream(currentUserMessage, sessionId, currentMessageId, messageProcessingId, historyForThisStream, aggregatedToolCallsOutput, toolsForThisStream) {
        const streamId = `tool_call_${messageProcessingId}`;
        logger.info('Starting dedicated tool identification stream', { sessionId, streamId });
        let accumulatedToolCalls = null;
        try {
            const systemPromptContent = dedicatedToolCallPrompt_1.DEDICATED_TOOL_CALL_SYSTEM_PROMPT_TEMPLATE
                .replace('{{USER_CURRENT_MESSAGE}}', currentUserMessage);
            const messagesForApi = [
                { role: 'system', content: systemPromptContent },
                { role: 'user', content: currentUserMessage }
            ];
            if (!toolsForThisStream || toolsForThisStream.length === 0) {
                logger.warn('Tool call stream has no tools to process after filtering.', { sessionId });
                return;
            }
            const responseStream = await this.client.chat.completions.create({
                model: this.model,
                messages: messagesForApi,
                tools: toolsForThisStream,
                tool_choice: "auto",
                stream: true,
            });
            for await (const chunk of responseStream) {
                const toolCallsDelta = chunk.choices[0]?.delta?.tool_calls;
                if (toolCallsDelta) {
                    if (!accumulatedToolCalls)
                        accumulatedToolCalls = [];
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
                        }
                        catch (e) {
                            logger.error("Failed to parse tool arguments from dedicated stream", { args: tc.function.arguments });
                        }
                    }
                });
            }
        }
        catch (error) {
            logger.error('Error in tool call stream', { error: error.message, sessionId, streamId });
        }
        finally {
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
                .slice(-3)
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
                max_tokens: 150,
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
                if (!currentToolCalls[toolCallDelta.index]) {
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
                if (toolCallDelta.type) {
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
    async handleConversationalMode(currentUserMessage, initialUserQueryForMode, sessionId, currentMessageId, history) {
        const conversationalModeProcessingId = (0, uuid_1.v4)();
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
            const conversationalPrompt = mainConversationalPrompt_1.MAIN_CONVERSATIONAL_SYSTEM_PROMPT_TEMPLATE
                .replace('{{USER_INITIAL_QUERY}}', initialUserQueryForMode)
                .replace('{{USER_CURRENT_MESSAGE}}', currentUserMessage);
            const messagesForApi = [
                { role: 'system', content: conversationalPrompt },
                ...history.filter(msg => msg.role !== 'system'),
            ];
            const conversationalTools = this.toolConfigManager.getGroqToolsDefinition();
            if (!conversationalTools || conversationalTools.length === 0) {
                logger.warn(`Conversational mode LLM has no tools defined. Functionality will be limited.`, { sessionId });
            }
            const responseStream = await this.client.chat.completions.create({
                model: this.model,
                messages: messagesForApi,
                max_tokens: this.maxTokens,
                tools: conversationalTools,
                stream: true,
                temperature: 0.5,
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
                    break;
            }
            if (parser.parsing && !parserSuccessfullyCleanedUp) {
                parser.stopParsing();
            }
            const convModeToolCalls = accumulatedToolCallsFromConversational || [];
            const aiResponseMessage = {
                role: 'assistant',
                content: fullTextResponse || null,
                tool_calls: convModeToolCalls.length > 0 ? convModeToolCalls : []
            };
            history.push(aiResponseMessage);
            this.conversationHistory.set(sessionId, this.trimHistory(history));
            if (convModeToolCalls.length > 0) {
                logger.info('Conversational mode LLM made tool calls. Returning to main processor.', { sessionId, toolCalls: convModeToolCalls });
                return {
                    content: fullTextResponse,
                    toolCalls: convModeToolCalls
                };
            }
            return { content: fullTextResponse, toolCalls: [] };
        }
        catch (error) {
            logger.error('Error in handleConversationalMode', { error: error.message, sessionId, conversationalModeProcessingId });
            this.emit('send_chunk', sessionId, { type: 'error', content: "Error in conversational mode.", messageId: currentMessageId, isFinal: true });
            if (parser.parsing && !parserSuccessfullyCleanedUp)
                parser.stopParsing();
            if (!parserSuccessfullyCleanedUp && unsubscribeFromParser) {
                unsubscribeFromParser();
                markdown_stream_parser_1.MarkdownStreamParser.removeInstance(parserInstanceId);
            }
            return { content: "Sorry, an error occurred in conversational mode.", toolCalls: [] };
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
    async getActionAnalysis(analysisPrompt, sessionId) {
        logger.info('Performing action analysis (getActionAnalysis called)', { sessionId });
        try {
            const messagesForApi = [{ role: 'system', content: analysisPrompt }];
            const response = await this.client.chat.completions.create({
                model: this.model, messages: messagesForApi,
                max_tokens: this.maxTokens, temperature: 0.1,
                response_format: { type: "json_object" },
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
    getHistory(sessionId) {
        return this.conversationHistory.get(sessionId) || [];
    }
    trimHistory(history, maxLength = 20) {
        if (history.length <= maxLength) {
            return history;
        }
        const systemPrompt = history[0]?.role === 'system' ? [history[0]] : [];
        const recentMessages = history.slice(-(maxLength - systemPrompt.length));
        return [...systemPrompt, ...recentMessages];
    }
}
exports.ConversationService = ConversationService;
