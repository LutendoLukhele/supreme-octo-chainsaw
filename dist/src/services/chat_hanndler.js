"use strict";
// src/chat_hanndler.ts (ensure filename matches import in server.ts)
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleChatMessage = handleChatMessage;
exports.recordAiResponseAndToolCalls = recordAiResponseAndToolCalls;
exports.updateToolCallResult = updateToolCallResult;
exports.recordFollowUpResponse = recordFollowUpResponse;
const database_1 = require("firebase/database");
const winston_1 = __importDefault(require("winston"));
const firebase_1 = require("../firebase"); // Ensure path to initialized RTDB is correct
// Configure logger (Unchanged)
const logger = winston_1.default.createLogger({
    level: 'info', // Use 'debug' for more verbose logging during development
    format: winston_1.default.format.combine(winston_1.default.format.timestamp(), winston_1.default.format.json()),
    defaultMeta: { service: 'chat_handler' }, // Added default meta
    transports: [
        new winston_1.default.transports.Console(),
        new winston_1.default.transports.File({ filename: 'error.log', level: 'error' }),
    ]
});
/**
 * Handles a new chat message: Records user message and AI placeholder in Firebase.
 * Uses userId and sessionId for pathing.
 */
async function handleChatMessage(userId, // <-- Added userId
sessionId, userMessage) {
    logger.info(`handleChatMessage called`, { userId, sessionId });
    if (!userId || !sessionId) {
        const errorMsg = `Invalid arguments: userId or sessionId is empty.`;
        logger.error(errorMsg);
        throw new Error(errorMsg);
    }
    // 1. Save user message under chats/{userId}/{sessionId}/messages
    const messagesRef = (0, database_1.ref)(firebase_1.db, `chats/${userId}/${sessionId}/messages`);
    const userMessageRef = (0, database_1.push)(messagesRef);
    const messageId = userMessageRef.key;
    if (!messageId) {
        const errorMsg = 'Failed to generate message ID';
        logger.error(errorMsg, { userId, sessionId });
        throw new Error(errorMsg);
    }
    logger.info(`Generated messageId: ${messageId}`, { userId, sessionId });
    try {
        await (0, database_1.set)(userMessageRef, {
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
    // 2. Create initial AI response structure under chats/{userId}/{sessionId}/aiResponses
    const aiResponseRef = (0, database_1.ref)(firebase_1.db, `chats/${userId}/${sessionId}/aiResponses/${messageId}`);
    try {
        await (0, database_1.set)(aiResponseRef, {
            aiResponse: "Processing...",
            segments: [],
            showCardStack: false,
            currentIndex: 0,
            status: 'processing' // Indicates server is working on it
        });
        logger.info(`AI response placeholder recorded`, { userId, sessionId, messageId });
    }
    catch (error) {
        logger.error('Firebase error recording AI placeholder', { error: error.message, userId, sessionId, messageId });
        throw error;
    }
    return messageId;
}
/**
 * Records the final AI text response and registers pending tool calls in Firebase.
 * Uses userId and sessionId for pathing.
 */
async function recordAiResponseAndToolCalls(userId, // <-- Added userId
sessionId, messageId, aiResponse) {
    logger.info(`recordAiResponseAndToolCalls called`, { userId, sessionId, messageId, hasContent: !!aiResponse.content, toolCallCount: aiResponse.toolCalls?.length || 0 });
    if (!userId || !sessionId || !messageId) {
        const errorMsg = `Invalid arguments for recordAiResponseAndToolCalls.`;
        logger.error(errorMsg, { userId, sessionId, messageId });
        throw new Error(errorMsg);
    }
    try {
        // 1. Update AI Response content under chats/{userId}/{sessionId}/aiResponses
        const aiResponseRef = (0, database_1.ref)(firebase_1.db, `chats/${userId}/${sessionId}/aiResponses/${messageId}`);
        const aiUpdateData = {
            aiResponse: aiResponse.content || "",
            segments: aiResponse.content ? aiResponse.content.split('\n') : [], // Example segmentation
            showCardStack: !!(aiResponse.content && aiResponse.content.includes('\n')), // Example logic
            status: 'complete' // Mark generation as complete
        };
        await (0, database_1.update)(aiResponseRef, aiUpdateData);
        logger.info(`Updated AI response content`, { userId, sessionId, messageId });
        // 2. Record pending tool calls under chats/{userId}/{sessionId}/toolCalls
        if (aiResponse.toolCalls && aiResponse.toolCalls.length > 0) {
            logger.info(`Recording ${aiResponse.toolCalls.length} pending tool calls`, { userId, sessionId, messageId });
            const toolCallsRef = (0, database_1.ref)(firebase_1.db, `chats/${userId}/${sessionId}/toolCalls/${messageId}`);
            const pendingToolCalls = {};
            for (const toolCall of aiResponse.toolCalls) {
                if (toolCall) {
                    pendingToolCalls[toolCall.id] = {
                        id: toolCall.id,
                        name: toolCall.function.name,
                        arguments: toolCall.function.arguments,
                        status: 'pending', // Initial status
                        timestamp: Date.now()
                    };
                }
            }
            // const pendingToolCalls = aiResponse.toolCalls.reduce(
            //     (acc: Record<string, PendingToolCallData>, toolCall: LLMResponse['toolCalls'][number]) => {
            //         if (toolCall) {
            //             acc[toolCall.id] = {
            //         }
            //         return acc;
            //     },{} as Record<string, PendingToolCallData>);
            await (0, database_1.set)(toolCallsRef, pendingToolCalls); // Set the object for this messageId
            logger.info(`Recorded pending tool calls`, { userId, sessionId, messageId, toolCallIds: Object.keys(pendingToolCalls) });
        }
        else {
            logger.info(`No tool calls to record`, { userId, sessionId, messageId });
        }
    }
    catch (error) {
        logger.error('Failed to record AI response or tool calls', { error: error.message, userId, sessionId, messageId });
        const aiResponseRef = (0, database_1.ref)(firebase_1.db, `chats/${userId}/${sessionId}/aiResponses/${messageId}`);
        try {
            await (0, database_1.update)(aiResponseRef, {
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
/**
 * Updates the result and status of a specific tool call in Firebase.
 * Uses userId and sessionId for pathing.
 */
async function updateToolCallResult(userId, sessionId, messageId, toolCallId, result) {
    if (!userId || !sessionId || !messageId || !toolCallId) {
        throw new Error(`Invalid args for updateToolCallResult`);
    }
    // Build the path to this specific tool call
    const toolCallRef = (0, database_1.ref)(firebase_1.db, `chats/${userId}/${sessionId}/toolCalls/${messageId}/${toolCallId}`);
    // Extract the raw “data” payload from your ToolResult
    // (your orchestrator should set result.data = { count, data: [ … ] } )
    const raw = result.data;
    // Safely pull out the array of records; fallback to empty list
    const records = Array.isArray(raw?.data) ? raw.data : [];
    // Now push EVERYTHING the UI needs into RTDB:
    await (0, database_1.update)(toolCallRef, {
        status: result.status, // success / failed
        completedAt: Date.now(), // signal "done"
        // store the full raw “data” object under `result`
        result: raw ?? {},
        // AND explicitly expose the list of records for your ChatState mapper
        resultRecordList: records,
        // preserve any error text
        error: result.error ?? null,
    });
}
/**
 * Records the complete follow-up response text in Firebase under the specific tool call.
 * Uses userId and sessionId for pathing.
 */
async function recordFollowUpResponse(userId, // <-- Added userId
sessionId, messageId, fullContent, toolCallId // Now required
) {
    logger.info(`recordFollowUpResponse called`, { userId, sessionId, messageId, toolCallId });
    if (!userId || !sessionId || !messageId || !toolCallId) {
        const errorMsg = `Invalid arguments for recordFollowUpResponse.`;
        logger.error(errorMsg, { userId, sessionId, messageId, toolCallId });
        throw new Error(errorMsg);
    }
    try {
        // Path: chats/{userId}/{sessionId}/toolCalls/{messageId}/{toolCallId}/followUp
        const followUpRef = (0, database_1.ref)(firebase_1.db, `chats/${userId}/${sessionId}/toolCalls/${messageId}/${toolCallId}/followUp`);
        await (0, database_1.set)(followUpRef, {
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
