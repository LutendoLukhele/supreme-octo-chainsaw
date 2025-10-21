"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleChatMessage = handleChatMessage;
exports.recordAiResponseAndToolCalls = recordAiResponseAndToolCalls;
exports.recordToolCallIntent = recordToolCallIntent;
exports.updateToolCallResult = updateToolCallResult;
exports.recordFollowUpResponse = recordFollowUpResponse;
const winston_1 = __importDefault(require("winston"));
const uuid_1 = require("uuid");
const logger = winston_1.default.createLogger({
    level: 'info',
    format: winston_1.default.format.combine(winston_1.default.format.timestamp(), winston_1.default.format.json()),
    defaultMeta: { service: 'chat_handler' },
    transports: [
        new winston_1.default.transports.Console(),
        new winston_1.default.transports.File({ filename: 'error.log', level: 'error' }),
    ]
});
async function handleChatMessage(userId, sessionId, userMessage) {
    logger.info(`handleChatMessage called`, { userId, sessionId, userMessage });
    if (!userId || !sessionId) {
        const errorMsg = `Invalid arguments: userId or sessionId is empty.`;
        logger.error(errorMsg);
        throw new Error(errorMsg);
    }
    const messageId = (0, uuid_1.v4)();
    logger.info(`Generated messageId: ${messageId}`, { userId, sessionId });
    logger.info(`User message would be recorded`, { userId, sessionId, messageId, content: userMessage });
    logger.info(`AI response placeholder would be created`, { userId, sessionId, messageId });
    return messageId;
}
async function recordAiResponseAndToolCalls(userId, sessionId, messageId, aiResponse) {
    logger.info(`recordAiResponseAndToolCalls called`, { userId, sessionId, messageId, hasContent: !!aiResponse.content, toolCallCount: aiResponse.toolCalls?.length || 0 });
    if (!userId || !sessionId || !messageId) {
        const errorMsg = `Invalid arguments for recordAiResponseAndToolCalls.`;
        logger.error(errorMsg, { userId, sessionId, messageId });
        throw new Error(errorMsg);
    }
    logger.info(`AI response content would be updated`, { userId, sessionId, messageId, content: aiResponse.content });
    if (aiResponse.toolCalls && aiResponse.toolCalls.length > 0) {
        const toolCallIds = aiResponse.toolCalls.map(tc => tc.id);
        logger.info(`Pending tool calls would be recorded`, { userId, sessionId, messageId, toolCallIds });
    }
    else {
        logger.info(`No tool calls to record`, { userId, sessionId, messageId });
    }
}
async function recordToolCallIntent(userId, sessionId, messageId, toolCall, sourceStream) {
    logger.info(`recordToolCallIntent called`, { userId, sessionId, messageId, toolCallId: toolCall.id, sourceStream });
    if (!userId || !sessionId || !messageId || !toolCall || !toolCall.id) {
        const errorMsg = `Invalid arguments for recordToolCallIntent.`;
        logger.error(errorMsg, { userId, sessionId, messageId, toolCallId: toolCall?.id });
        throw new Error(errorMsg);
    }
    logger.info(`Pending tool call intent from ${sourceStream} would be recorded`, { userId, sessionId, messageId, toolCallId: toolCall.id, name: toolCall.function.name });
}
async function updateToolCallResult(userId, sessionId, messageId, toolCallId, result) {
    if (!userId || !sessionId || !messageId || !toolCallId) {
        throw new Error(`Invalid args for updateToolCallResult`);
    }
    logger.info(`Tool call result would be updated`, { userId, sessionId, messageId, toolCallId, result });
}
async function recordFollowUpResponse(userId, sessionId, messageId, fullContent, toolCallId) {
    logger.info(`recordFollowUpResponse called`, { userId, sessionId, messageId, toolCallId });
    if (!userId || !sessionId || !messageId || !toolCallId) {
        const errorMsg = `Invalid arguments for recordFollowUpResponse.`;
        logger.error(errorMsg, { userId, sessionId, messageId, toolCallId });
        throw new Error(errorMsg);
    }
    logger.info('Follow-up response would be recorded', { userId, sessionId, messageId, toolCallId, content: fullContent });
}
