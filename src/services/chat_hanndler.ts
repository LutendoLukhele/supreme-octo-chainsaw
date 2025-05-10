// src/chat_hanndler.ts (ensure filename matches import in server.ts)

import { ref, push, set, update } from 'firebase/database';
import winston from 'winston';
import { db } from '../firebase'; // Ensure path to initialized RTDB is correct
import { LLMResponse, ToolResult } from './conversation/types'; // Import necessary types

// Define structure for pending tool calls if not already globally defined
interface PendingToolCallData {
    id: string;
    name: string;
    arguments: string;
    status: 'pending';
    timestamp: number;
}

// Configure logger (Unchanged)
const logger = winston.createLogger({
  level: 'info', // Use 'debug' for more verbose logging during development
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  defaultMeta: { service: 'chat_handler' }, // Added default meta
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
  ]
});

/**
 * Handles a new chat message: Records user message and AI placeholder in Firebase.
 * Uses userId and sessionId for pathing.
 */
export async function handleChatMessage(
  userId: string, // <-- Added userId
  sessionId: string,
  userMessage: string
): Promise<string> {
  logger.info(`handleChatMessage called`, { userId, sessionId });

  if (!userId || !sessionId) {
      const errorMsg = `Invalid arguments: userId or sessionId is empty.`;
      logger.error(errorMsg);
      throw new Error(errorMsg);
  }

  // 1. Save user message under chats/{userId}/{sessionId}/messages
  const messagesRef = ref(db, `chats/${userId}/${sessionId}/messages`);
  const userMessageRef = push(messagesRef);
  const messageId = userMessageRef.key;

  if (!messageId) {
      const errorMsg = 'Failed to generate message ID';
      logger.error(errorMsg, { userId, sessionId });
      throw new Error(errorMsg);
  }
  logger.info(`Generated messageId: ${messageId}`, { userId, sessionId });

  try {
    await set(userMessageRef, {
      content: userMessage,
      sender: 'user',
      type: 'text',
      timestamp: Date.now(),
      status: 'complete'
    });
    logger.info(`User message recorded`, { userId, sessionId, messageId });
  } catch (error: any) {
    logger.error('Firebase error recording user message', { error: error.message, userId, sessionId, messageId });
    throw error;
  }

  // 2. Create initial AI response structure under chats/{userId}/{sessionId}/aiResponses
  const aiResponseRef = ref(db, `chats/${userId}/${sessionId}/aiResponses/${messageId}`);
  try {
    await set(aiResponseRef, {
      aiResponse: "Processing...",
      segments: [],
      showCardStack: false,
      currentIndex: 0,
      status: 'processing' // Indicates server is working on it
    });
    logger.info(`AI response placeholder recorded`, { userId, sessionId, messageId });
  } catch (error: any) {
    logger.error('Firebase error recording AI placeholder', { error: error.message, userId, sessionId, messageId });
    throw error;
  }

  return messageId;
}

/**
 * Records the final AI text response and registers pending tool calls in Firebase.
 * Uses userId and sessionId for pathing.
 */
export async function recordAiResponseAndToolCalls(
    userId: string, // <-- Added userId
    sessionId: string,
    messageId: string,
    aiResponse: LLMResponse
): Promise<void> {
    logger.info(`recordAiResponseAndToolCalls called`, { userId, sessionId, messageId, hasContent: !!aiResponse.content, toolCallCount: aiResponse.toolCalls?.length || 0 });
    if (!userId || !sessionId || !messageId) {
        const errorMsg = `Invalid arguments for recordAiResponseAndToolCalls.`;
        logger.error(errorMsg, { userId, sessionId, messageId });
        throw new Error(errorMsg);
    }

    try {
        // 1. Update AI Response content under chats/{userId}/{sessionId}/aiResponses
        const aiResponseRef = ref(db, `chats/${userId}/${sessionId}/aiResponses/${messageId}`);
        const aiUpdateData = {
            aiResponse: aiResponse.content || "",
            segments: aiResponse.content ? aiResponse.content.split('\n') : [], // Example segmentation
            showCardStack: !!(aiResponse.content && aiResponse.content.includes('\n')), // Example logic
            status: 'complete' // Mark generation as complete
        };
        await update(aiResponseRef, aiUpdateData);
        logger.info(`Updated AI response content`, { userId, sessionId, messageId });

        // 2. Record pending tool calls under chats/{userId}/{sessionId}/toolCalls
        if (aiResponse.toolCalls && aiResponse.toolCalls.length > 0) {
            logger.info(`Recording ${aiResponse.toolCalls.length} pending tool calls`, { userId, sessionId, messageId });
            const toolCallsRef = ref(db, `chats/${userId}/${sessionId}/toolCalls/${messageId}`);
            const pendingToolCalls: Record<string, PendingToolCallData> = {};
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
            await set(toolCallsRef, pendingToolCalls); // Set the object for this messageId
            logger.info(`Recorded pending tool calls`, { userId, sessionId, messageId, toolCallIds: Object.keys(pendingToolCalls) });
        } else {
            logger.info(`No tool calls to record`, { userId, sessionId, messageId });
        }
    } catch (error: any) {
        logger.error('Failed to record AI response or tool calls', { error: error.message, userId, sessionId, messageId });
        const aiResponseRef = ref(db, `chats/${userId}/${sessionId}/aiResponses/${messageId}`);
        try {
            await update(aiResponseRef, {
                status: 'error',
                error: `Failed to record response details: ${error instanceof Error ? error.message : String(error)}`
            });
        } catch (updateError: any) {
             logger.error("Failed to update AI response status to error", { updateError: updateError.message, userId, sessionId, messageId });
        }
       throw error;
    }
}

/**
 * Updates the result and status of a specific tool call in Firebase.
 * Uses userId and sessionId for pathing.
 */
export async function updateToolCallResult(
  userId: string,
  sessionId: string,
  messageId: string,
  toolCallId: string,
  result: ToolResult
): Promise<void> {
  if (!userId || !sessionId || !messageId || !toolCallId) {
    throw new Error(`Invalid args for updateToolCallResult`);
  }

  // Build the path to this specific tool call
  const toolCallRef = ref(
    db,
    `chats/${userId}/${sessionId}/toolCalls/${messageId}/${toolCallId}`
  );

  // Extract the raw “data” payload from your ToolResult
  // (your orchestrator should set result.data = { count, data: [ … ] } )
  const raw = result.data as any;
  // Safely pull out the array of records; fallback to empty list
  const records = Array.isArray(raw?.data) ? raw.data : [];

  // Now push EVERYTHING the UI needs into RTDB:
  await update(toolCallRef, {
    status:      result.status,           // success / failed
    completedAt: Date.now(),              // signal "done"
    // store the full raw “data” object under `result`
    result:      raw ?? {},
    // AND explicitly expose the list of records for your ChatState mapper
    resultRecordList: records,
    // preserve any error text
    error:       result.error ?? null,
  });
}

/**
 * Records the complete follow-up response text in Firebase under the specific tool call.
 * Uses userId and sessionId for pathing.
 */
export async function recordFollowUpResponse(
  userId: string, // <-- Added userId
  sessionId: string,
  messageId: string,
  fullContent: string,
  toolCallId: string // Now required
): Promise<void> {
  logger.info(`recordFollowUpResponse called`, { userId, sessionId, messageId, toolCallId });
   if (!userId || !sessionId || !messageId || !toolCallId) {
        const errorMsg = `Invalid arguments for recordFollowUpResponse.`;
        logger.error(errorMsg, { userId, sessionId, messageId, toolCallId });
        throw new Error(errorMsg);
    }
  try {
    // Path: chats/{userId}/{sessionId}/toolCalls/{messageId}/{toolCallId}/followUp
    const followUpRef = ref(db, `chats/${userId}/${sessionId}/toolCalls/${messageId}/${toolCallId}/followUp`);
    await set(followUpRef, {
      content: fullContent,
      timestamp: Date.now()
    });
    logger.info('Successfully recorded follow-up response', { userId, sessionId, messageId, toolCallId });
  } catch (error: any) {
    logger.error('Failed to record follow-up response', {
      error: error.message, userId, sessionId, messageId, toolCallId
    });
    throw error;
  }
}