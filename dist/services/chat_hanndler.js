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
const firebase_1 = require("../firebase");
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
    logger.info(`handleChatMessage called`, { userId, sessionId });
    if (!userId || !sessionId) {
        const errorMsg = `Invalid arguments: userId or sessionId is empty.`;
        logger.error(errorMsg);
        throw new Error(errorMsg);
    }
    const messagesRef = firebase_1.db.ref(`chats/${userId}/${sessionId}/messages`);
    const userMessageRef = messagesRef.push();
    const messageId = userMessageRef.key;
    if (!messageId) {
        const errorMsg = 'Failed to generate message ID';
        logger.error(errorMsg, { userId, sessionId });
        throw new Error(errorMsg);
    }
    logger.info(`Generated messageId: ${messageId}`, { userId, sessionId });
    try {
        await userMessageRef.set({
            content: userMessage,
            sender: 'user',
            type: 'text',
            timestamp: Date.now(),
            status: 'complete'
        });
        logger.info(`User message recorded`, { userId, sessionId, messageId });
    }
    catch (error) {
        logger.error('Firebase error recording user message', { error: error.message, userId, sessionId, messageId });
        throw error;
    }
    const aiResponseRef = firebase_1.db.ref(`chats/${userId}/${sessionId}/aiResponses/${messageId}`);
    try {
        await aiResponseRef.set({
            aiResponse: "Processing...",
            segments: [],
            showCardStack: false,
            currentIndex: 0,
            status: 'processing'
        });
        logger.info(`AI response placeholder recorded`, { userId, sessionId, messageId });
    }
    catch (error) {
        logger.error('Firebase error recording AI placeholder', { error: error.message, userId, sessionId, messageId });
        throw error;
    }
    return messageId;
}
async function recordAiResponseAndToolCalls(userId, sessionId, messageId, aiResponse) {
    logger.info(`recordAiResponseAndToolCalls called`, { userId, sessionId, messageId, hasContent: !!aiResponse.content, toolCallCount: aiResponse.toolCalls?.length || 0 });
    if (!userId || !sessionId || !messageId) {
        const errorMsg = `Invalid arguments for recordAiResponseAndToolCalls.`;
        logger.error(errorMsg, { userId, sessionId, messageId });
        throw new Error(errorMsg);
    }
    try {
        const aiResponseRef = firebase_1.db.ref(`chats/${userId}/${sessionId}/aiResponses/${messageId}`);
        const aiUpdateData = {
            aiResponse: aiResponse.content || "",
            segments: aiResponse.content ? aiResponse.content.split('\n') : [],
            showCardStack: !!(aiResponse.content && aiResponse.content.includes('\n')),
            status: 'complete'
        };
        await aiResponseRef.update(aiUpdateData);
        logger.info(`Updated AI response content`, { userId, sessionId, messageId });
        if (aiResponse.toolCalls && aiResponse.toolCalls.length > 0) {
            logger.info(`Recording ${aiResponse.toolCalls.length} pending tool calls`, { userId, sessionId, messageId });
            const toolCallsRef = firebase_1.db.ref(`chats/${userId}/${sessionId}/toolCalls/${messageId}`);
            const pendingToolCalls = {};
            for (const toolCall of aiResponse.toolCalls) {
                if (toolCall) {
                    pendingToolCalls[toolCall.id] = {
                        id: toolCall.id,
                        name: toolCall.function.name,
                        arguments: toolCall.function.arguments,
                        status: 'pending',
                        timestamp: Date.now()
                    };
                }
            }
            await toolCallsRef.set(pendingToolCalls);
            logger.info(`Recorded pending tool calls`, { userId, sessionId, messageId, toolCallIds: Object.keys(pendingToolCalls) });
        }
        else {
            logger.info(`No tool calls to record`, { userId, sessionId, messageId });
        }
    }
    catch (error) {
        logger.error('Failed to record AI response or tool calls', { error: error.message, userId, sessionId, messageId });
        const aiResponseRef = firebase_1.db.ref(`chats/${userId}/${sessionId}/aiResponses/${messageId}`);
        try {
            await aiResponseRef.update({
                status: 'error',
                error: `Failed to record response details: ${error instanceof Error ? error.message : String(error)}`
            });
        }
        catch (updateError) {
            logger.error("Failed to update AI response status to error", { updateError: updateError.message, userId, sessionId, messageId });
        }
        throw error;
    }
}
async function recordToolCallIntent(userId, sessionId, messageId, toolCall, sourceStream) {
    logger.info(`recordToolCallIntent called`, { userId, sessionId, messageId, toolCallId: toolCall.id, sourceStream });
    if (!userId || !sessionId || !messageId || !toolCall || !toolCall.id) {
        const errorMsg = `Invalid arguments for recordToolCallIntent.`;
        logger.error(errorMsg, { userId, sessionId, messageId, toolCallId: toolCall?.id });
        throw new Error(errorMsg);
    }
    try {
        const toolCallDbRef = firebase_1.db.ref(`chats/${userId}/${sessionId}/toolCalls/${messageId}/${toolCall.id}`);
        const pendingToolCallData = {
            id: toolCall.id,
            name: toolCall.function.name,
            arguments: toolCall.function.arguments,
            status: 'pending',
            timestamp: Date.now(),
        };
        await toolCallDbRef.set(pendingToolCallData);
        logger.info(`Recorded pending tool call intent from ${sourceStream}`, { userId, sessionId, messageId, toolCallId: toolCall.id, name: toolCall.function.name });
    }
    catch (error) {
        logger.error('Failed to record tool call intent', { error: error.message, userId, sessionId, messageId, toolCallId: toolCall.id });
        throw error;
    }
}
async function updateToolCallResult(userId, sessionId, messageId, toolCallId, result) {
    if (!userId || !sessionId || !messageId || !toolCallId) {
        throw new Error(`Invalid args for updateToolCallResult`);
    }
    const toolCallRef = firebase_1.db.ref(`chats/${userId}/${sessionId}/toolCalls/${messageId}/${toolCallId}`);
    const raw = result.data;
    const records = Array.isArray(raw?.data) ? raw.data : [];
    await toolCallRef.update({
        status: result.status,
        completedAt: Date.now(),
        result: raw ?? {},
        resultRecordList: records,
        error: result.error ?? null,
    });
}
async function recordFollowUpResponse(userId, sessionId, messageId, fullContent, toolCallId) {
    logger.info(`recordFollowUpResponse called`, { userId, sessionId, messageId, toolCallId });
    if (!userId || !sessionId || !messageId || !toolCallId) {
        const errorMsg = `Invalid arguments for recordFollowUpResponse.`;
        logger.error(errorMsg, { userId, sessionId, messageId, toolCallId });
        throw new Error(errorMsg);
    }
    try {
        const followUpRef = firebase_1.db.ref(`chats/${userId}/${sessionId}/toolCalls/${messageId}/${toolCallId}/followUp`);
        await followUpRef.set({
            content: fullContent,
            timestamp: Date.now()
        });
        logger.info('Successfully recorded follow-up response', { userId, sessionId, messageId, toolCallId });
    }
    catch (error) {
        logger.error('Failed to record follow-up response', {
            error: error.message, userId, sessionId, messageId, toolCallId
        });
        throw error;
    }
}
