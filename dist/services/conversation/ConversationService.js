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
const types_1 = require("./types");
const ToolConfigManager_1 = require("../tool/ToolConfigManager");
const markdown_stream_parser_1 = require("@lixpi/markdown-stream-parser");
const mainConversationalPrompt_1 = require("./prompts/mainConversationalPrompt");
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
                function: { name: tool.name, description: tool.description, parameters: inputSchema }
            };
        }).filter(Boolean);
        const initialUserQuery = history.find(m => m.role === 'user')?.content || userMessage;
        const aggregatedToolCallsOutput = [];
        let conversationalResponseText = "";
        let hasConversationalToolCalls = false;
        let hasToolStreamCalls = false;
        const conversationalStreamPromise = this.runConversationalStream(userMessage, initialUserQuery, sessionId, currentMessageId, messageProcessingId, filteredGroqTools, [...history], aggregatedToolCallsOutput).then(result => {
            conversationalResponseText = result.text;
            hasConversationalToolCalls = result.hasToolCalls;
        });
        const toolCallStreamPromise = this.runToolCallStream(userMessage, sessionId, currentMessageId, messageProcessingId, [...history], aggregatedToolCallsOutput, filteredGroqTools).then(result => {
            hasToolStreamCalls = result.hasToolCalls;
        });
        await Promise.allSettled([conversationalStreamPromise, toolCallStreamPromise]);
        const hasAnyToolCalls = aggregatedToolCallsOutput.length > 0;
        if (hasAnyToolCalls && conversationalResponseText.trim().length === 0) {
            const toolExecutionMessageId = (0, uuid_1.v4)();
            await this.streamToolExecutionResponse(aggregatedToolCallsOutput, userMessage, sessionId, toolExecutionMessageId);
            logger.info('No conversational text - showing tool execution message', { sessionId });
        }
        else if (hasAnyToolCalls && conversationalResponseText.trim().length > 0) {
            logger.info('Tool calls WITH conversational text - showing actual conversational response', {
                sessionId,
                responseLength: conversationalResponseText.length
            });
        }
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
    async streamToolExecutionResponse(toolCalls, userRequest, sessionId, messageId) {
        logger.info('Streaming tool execution response', {
            toolCount: toolCalls.length,
            tools: toolCalls.map(tc => tc.name),
            messageId
        });
        const toolDescriptions = toolCalls.map(tc => {
            const toolConfig = this.toolConfigManager.getToolByName(tc.name);
            const friendlyName = this.getToolFriendlyName(tc.name);
            const paramDetails = this.formatToolParameters(tc.name, tc.arguments);
            return `${friendlyName}${paramDetails}`;
        }).join(' and ');
        const executionPrompt = `You are acknowledging that you're executing specific tool actions. The user requested: "${userRequest}"

You are executing: ${toolDescriptions}

Generate a brief, natural response (max 40 words) that specifically mentions what you're doing.
Examples:
- "I'm fetching your recent emails for you."
- "I'm sending that email to john@example.com with the Q3 report."
- "Creating a meeting with Sarah tomorrow at 2 PM."

Be specific and natural. Don't just say "I'm working on it" - say WHAT you're doing.`;
        try {
            this.emit('send_chunk', sessionId, {
                type: 'conversational_text_segment',
                content: { status: 'START_STREAM' },
                messageId: messageId,
                messageType: types_1.MessageType.TOOL_EXECUTION,
                isToolExecution: true
            });
            const responseStream = await this.client.chat.completions.create({
                model: 'llama-3.1-8b-instant',
                messages: [{ role: 'system', content: executionPrompt }],
                max_tokens: 50,
                stream: true,
                temperature: 0.6,
            });
            let fullText = '';
            for await (const chunk of responseStream) {
                const contentDelta = chunk.choices[0]?.delta?.content;
                if (contentDelta) {
                    fullText += contentDelta;
                    this.emit('send_chunk', sessionId, {
                        type: 'conversational_text_segment',
                        content: {
                            status: 'STREAMING',
                            segment: {
                                segment: contentDelta,
                                styles: [],
                                type: 'text'
                            }
                        },
                        messageId: messageId,
                        messageType: types_1.MessageType.TOOL_EXECUTION,
                        isToolExecution: true
                    });
                }
            }
            this.emit('send_chunk', sessionId, {
                type: 'conversational_text_segment',
                content: { status: 'END_STREAM' },
                messageId: messageId,
                isFinal: true,
                messageType: types_1.MessageType.TOOL_EXECUTION,
                isToolExecution: true
            });
            this.emit('send_chunk', sessionId, {
                type: 'stream_end',
                streamType: 'conversational',
                messageId: messageId,
                isFinal: true
            });
            logger.info('Streamed tool execution response', {
                sessionId,
                messageId,
                content: fullText,
                toolsExecuted: toolCalls.map(tc => tc.name)
            });
            const history = this.getHistory(sessionId);
            history.push({
                role: 'assistant',
                content: fullText,
                metadata: {
                    type: 'tool_execution',
                    tools: toolCalls,
                    messageId
                }
            });
            this.conversationHistory.set(sessionId, history);
        }
        catch (error) {
            logger.error('Failed to stream tool execution response', { error, sessionId });
            const fallbackText = `Executing ${toolCalls.map(tc => this.getToolFriendlyName(tc.name)).join(' and ')} now.`;
            this.emit('send_chunk', sessionId, {
                type: 'conversational_text_segment',
                content: { status: 'START_STREAM' },
                messageId: messageId,
                messageType: types_1.MessageType.TOOL_EXECUTION
            });
            this.emit('send_chunk', sessionId, {
                type: 'conversational_text_segment',
                content: {
                    status: 'STREAMING',
                    segment: { segment: fallbackText, styles: [], type: 'text' }
                },
                messageId: messageId,
                messageType: types_1.MessageType.TOOL_EXECUTION
            });
            this.emit('send_chunk', sessionId, {
                type: 'conversational_text_segment',
                content: { status: 'END_STREAM' },
                messageId: messageId,
                isFinal: true,
                messageType: types_1.MessageType.TOOL_EXECUTION
            });
            this.emit('send_chunk', sessionId, {
                type: 'stream_end',
                streamType: 'conversational',
                messageId: messageId,
                isFinal: true
            });
        }
    }
    getToolFriendlyName(toolName) {
        const friendlyNames = {
            'fetch_emails': 'fetching emails',
            'sendEmail': 'sending an email',
            'createCalendarEvent': 'creating a calendar event',
            'updateSalesforceContact': 'updating Salesforce contact',
            'searchContacts': 'searching contacts',
        };
        return friendlyNames[toolName] || toolName.replace(/_/g, ' ');
    }
    formatToolParameters(toolName, params) {
        if (!params || Object.keys(params).length === 0)
            return '';
        switch (toolName) {
            case 'sendEmail':
                return params.to ? ` to ${params.to}` : '';
            case 'createCalendarEvent':
                return params.title ? ` "${params.title}"` : '';
            case 'fetch_emails':
                return params.count ? ` (last ${params.count})` : '';
            default:
                return '';
        }
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
                    streamType: 'conversational',
                    messageType: types_1.MessageType.STANDARD
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
            if (accumulatedToolCalls && accumulatedToolCalls.length > 0) {
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
                            logger.info('Conversational stream collected potential_tool_call', {
                                sessionId,
                                streamId,
                                toolCallId: tc.id,
                                name: tc.function.name
                            });
                        }
                        catch (parseError) {
                            logger.error("Failed to parse tool arguments", {
                                toolCallId: tc.id,
                                error: parseError.message
                            });
                        }
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
                logger.warn('Tool call stream has no tools to process', { sessionId });
                return { hasToolCalls: false };
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
                            logger.info('Dedicated tool stream collected tool_call', {
                                name: tc.function.name
                            });
                        }
                        catch (e) {
                            logger.error("Failed to parse tool arguments", {
                                args: tc.function.arguments
                            });
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
        return {
            hasToolCalls: !!(accumulatedToolCalls && accumulatedToolCalls.length > 0)
        };
    }
    accumulateToolCallDeltas(currentToolCalls, toolCallDeltas) {
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
    async getActionAnalysis(analysisPrompt, sessionId) {
        logger.info('Performing action analysis', { sessionId });
        try {
            const messagesForApi = [{ role: 'system', content: analysisPrompt }];
            const response = await this.client.chat.completions.create({
                model: this.model,
                messages: messagesForApi,
                max_tokens: this.maxTokens,
                temperature: 0.1,
                response_format: { type: "json_object" },
                tools: undefined,
                tool_choice: undefined,
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
}
exports.ConversationService = ConversationService;
