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
const PLANNER_META_TOOL = {
    type: "function",
    function: {
        name: "planParallelActions",
        description: "Use this when a user's request is complex and requires multiple steps or actions to be planned. This triggers the main planning process.",
        parameters: {
            type: "object",
            properties: {
                userInput: { type: "string", description: "The original, full text of the user's complex request." },
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
    return detectedCategories.size > 0 ? Array.from(detectedCategories) : ['Email', 'Calendar', 'CRM'];
}
class ConversationService extends events_1.EventEmitter {
    constructor(config) {
        super();
        this.config = config;
        this.conversationHistory = new Map();
        if (!config.groqApiKey)
            throw new Error("Groq API key is missing.");
        this.client = new groq_sdk_1.default({ apiKey: config.groqApiKey });
        this.model = config.model;
        this.maxTokens = config.maxTokens;
        this.toolConfigManager = new ToolConfigManager_1.ToolConfigManager();
    }
    async processMessageAndAggregateResults(userMessage, sessionId, incomingMessageId, _userId) {
        const messageProcessingId = (0, uuid_1.v4)();
        const currentMessageId = incomingMessageId || (0, uuid_1.v4)();
        logger.info('Processing message, will aggregate results', { sessionId });
        const history = this.getHistory(sessionId);
        if (userMessage) {
            history.push({ role: 'user', content: userMessage });
            this.conversationHistory.set(sessionId, history);
        }
        const isSummaryMode = !userMessage;
        let toolsForStream = [];
        let initialUserQuery = '';
        if (!isSummaryMode) {
            const relevantCategories = getRelevantToolCategories(userMessage || history.at(-1)?.content || '');
            const filteredToolConfigs = this.toolConfigManager.getToolsByCategories(relevantCategories);
            const groqTools = filteredToolConfigs.map(tool => {
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
            toolsForStream = [...groqTools, PLANNER_META_TOOL];
            initialUserQuery = history.find(m => m.role === 'user')?.content || userMessage || '';
        }
        else {
            initialUserQuery = history.find(m => m.role === 'user')?.content || 'the previous actions';
        }
        const aggregatedToolCallsOutput = [];
        let conversationalResponseText = "";
        const conversationalStreamPromise = this.runConversationalStream(userMessage, initialUserQuery, sessionId, currentMessageId, messageProcessingId, toolsForStream, history, aggregatedToolCallsOutput).then(result => {
            conversationalResponseText = result.text;
        });
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
    async runConversationalStream(currentUserMessage, initialUserQuery, sessionId, currentMessageId, messageProcessingId, toolsForThisStream, historyForThisStream, aggregatedToolCallsOutput) {
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
                .replace('{{USER_CURRENT_MESSAGE}}', currentUserMessage || '');
            const messagesForApi = [
                { role: 'system', content: systemPromptContent }
            ];
            messagesForApi.push(...this.prepareHistoryForLLM(historyForThisStream));
            const finalToolsForStream = [...toolsForThisStream, PLANNER_META_TOOL];
            logger.info('Conversational stream running with tools enabled.', { toolCount: finalToolsForStream?.length });
            const responseStream = await this.client.chat.completions.create({
                model: this.model,
                messages: messagesForApi,
                max_tokens: this.maxTokens,
                tools: toolsForThisStream.length > 0 ? toolsForThisStream : undefined,
                tool_choice: "auto",
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
                logger.info(`Conversational stream identified ${accumulatedToolCalls.length} tool calls.`, { sessionId });
                accumulatedToolCalls.forEach(tc => {
                    if (tc.id && tc.function.name) {
                        try {
                            if (!aggregatedToolCallsOutput.some(existing => existing.id === tc.id)) {
                                aggregatedToolCallsOutput.push({
                                    id: tc.id,
                                    name: tc.function.name,
                                    arguments: JSON.parse(tc.function.arguments || '{}'),
                                    streamType: 'conversational',
                                    function: undefined
                                });
                                logger.info('Collected tool_call from conversational stream', { name: tc.function.name });
                            }
                        }
                        catch (e) {
                            logger.error("Failed to parse tool arguments from conversational stream", {
                                args: tc.function.arguments, error: e.message
                            });
                        }
                    }
                });
            }
            const assistantResponse = { role: 'assistant', content: accumulatedText || null };
            historyForThisStream.push(assistantResponse);
            this.conversationHistory.set(sessionId, this.trimHistory(historyForThisStream));
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
        return history.filter(msg => msg.role !== 'system' && (msg.content || (msg.tool_calls && msg.tool_calls.length > 0)));
    }
    getHistory(sessionId) {
        return this.conversationHistory.get(sessionId) || [];
    }
    trimHistory(history, maxLength = 20) {
        if (history.length <= maxLength)
            return history;
        const systemPrompts = history.filter(h => h.role === 'system');
        const nonSystem = history.filter(h => h.role !== 'system');
        const trimmed = nonSystem.slice(-maxLength + systemPrompts.length);
        return [...systemPrompts, ...trimmed];
    }
    addAssistantMessageToHistory(sessionId, content, metadata) {
        const history = this.getHistory(sessionId);
        const assistantMessage = {
            role: 'assistant',
            content: content,
        };
        history.push(assistantMessage);
        this.conversationHistory.set(sessionId, this.trimHistory(history));
        logger.info('Added assistant message to history programmatically', { sessionId });
    }
    addToolResultMessageToHistory(sessionId, toolCallId, toolName, resultData) {
        const history = this.getHistory(sessionId);
        const toolMessage = {
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
exports.ConversationService = ConversationService;
