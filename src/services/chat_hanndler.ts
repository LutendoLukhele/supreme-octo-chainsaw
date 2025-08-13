// src/chat_hanndler.ts (ensure filename matches import in server.ts)

import winston from 'winston';
import { db } from '../firebase'; // Ensure path to initialized RTDB is correct
import { LLMResponse, ToolResult } from './conversation/types'; // Import necessary types
import { ref } from 'process';

// Define structure for pending tool calls if not already globally defined
interface PendingToolCallData {
    id: string;
    name: string;
    arguments: string;
    // sourceStream?: string; // Optional: to track if it came from 'conversational' or 'dedicated_tool' stream
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
  const messagesRef = db.ref(`chats/${userId}/${sessionId}/messages`);
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
  } catch (error: any) {
    logger.error('Firebase error recording user message', { error: error.message, userId, sessionId, messageId });
    throw error;
  }

  // 2. Create initial AI response structure under chats/{userId}/{sessionId}/aiResponses
  const aiResponseRef = db.ref(`chats/${userId}/${sessionId}/aiResponses/${messageId}`);
  try {
    await aiResponseRef.set({
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
 * NOTE: With the multi-stream ConversationService, this function's role changes.
 * AI text is primarily handled by the conversational stream. Tool calls come from multiple streams.
 * This function might be refactored to only handle AI text, or be replaced by more specific functions
 * called by listeners to ConversationService events/chunks (e.g., when 'conversational' stream ends).
 * Uses userId and sessionId for pathing.
 */
export async function recordAiResponseAndToolCalls(
    userId: string,
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
        // This part is relevant for recording the AI's main textual response.
        // It should be called with the final, aggregated text from the conversational stream.
        const aiResponseRef = db.ref(`chats/${userId}/${sessionId}/aiResponses/${messageId}`);
        const aiUpdateData = {
            aiResponse: aiResponse.content || "",
            segments: aiResponse.content ? aiResponse.content.split('\n') : [], // Example segmentation
            showCardStack: !!(aiResponse.content && aiResponse.content.includes('\n')), // Example logic
            status: 'complete' // Mark generation as complete
        }; // TODO: Ensure aiResponse.content is the correct final text from the conversational stream.
        await aiResponseRef.update(aiUpdateData);
        logger.info(`Updated AI response content`, { userId, sessionId, messageId });

        // 2. Record pending tool calls under chats/{userId}/{sessionId}/toolCalls
        if (aiResponse.toolCalls && aiResponse.toolCalls.length > 0) {
            logger.info(`Recording ${aiResponse.toolCalls.length} pending tool calls`, { userId, sessionId, messageId });
            const toolCallsRef = db.ref(`chats/${userId}/${sessionId}/toolCalls/${messageId}`);
            // This assumes aiResponse.toolCalls are all the tool calls for this messageId. // TODO: This was changed, remove this comment if no longer true
            // With multiple streams, tool calls are now recorded individually by `recordToolCallIntent`.
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
            await toolCallsRef.set(pendingToolCalls); // Set the object for this messageId
            logger.info(`Recorded pending tool calls`, { userId, sessionId, messageId, toolCallIds: Object.keys(pendingToolCalls) });
        } else {
            logger.info(`No tool calls to record`, { userId, sessionId, messageId });
        }
    } catch (error: any) {
        logger.error('Failed to record AI response or tool calls', { error: error.message, userId, sessionId, messageId });
        const aiResponseRef = db.ref(`chats/${userId}/${sessionId}/aiResponses/${messageId}`);
        try {
            await aiResponseRef.update({
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
 * Records a single tool call intent in Firebase, typically when identified by a specific stream.
 */
export async function recordToolCallIntent(
  userId: string,
  sessionId: string,
  messageId: string,
  toolCall: { id: string; function: { name: string; arguments: string } },
  sourceStream: string // e.g., 'potential_tool_call', 'dedicated_tool_call', 'conversational'
): Promise<void> {
  logger.info(`recordToolCallIntent called`, { userId, sessionId, messageId, toolCallId: toolCall.id, sourceStream });
  if (!userId || !sessionId || !messageId || !toolCall || !toolCall.id) {
    const errorMsg = `Invalid arguments for recordToolCallIntent.`;
    logger.error(errorMsg, { userId, sessionId, messageId, toolCallId: toolCall?.id });
    throw new Error(errorMsg);
  }

  try {
    const toolCallDbRef = db.ref(`chats/${userId}/${sessionId}/toolCalls/${messageId}/${toolCall.id}`);
    const pendingToolCallData: PendingToolCallData = {
      id: toolCall.id,
      name: toolCall.function.name,
      arguments: toolCall.function.arguments,
      status: 'pending',
      timestamp: Date.now(),
    };
    await toolCallDbRef.set(pendingToolCallData);
    logger.info(`Recorded pending tool call intent from ${sourceStream}`, { userId, sessionId, messageId, toolCallId: toolCall.id, name: toolCall.function.name });
  } catch (error: any) {
    logger.error('Failed to record tool call intent', { error: error.message, userId, sessionId, messageId, toolCallId: toolCall.id });
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
  const toolCallRef = db.ref(
    `chats/${userId}/${sessionId}/toolCalls/${messageId}/${toolCallId}`
  );

  // Extract the raw “data” payload from your ToolResult
  // (your orchestrator should set result.data = { count, data: [ … ] } )
  const raw = result.data as any;
  // Safely pull out the array of records; fallback to empty list
  const records = Array.isArray(raw?.data) ? raw.data : [];

  // Now push EVERYTHING the UI needs into RTDB:
  await toolCallRef.update({
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
    const followUpRef = db.ref(`chats/${userId}/${sessionId}/toolCalls/${messageId}/${toolCallId}/followUp`);
    await followUpRef.set({
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