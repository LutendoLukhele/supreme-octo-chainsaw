// src/server.ts (Fully Updated with Action Launcher Logic)

// --- Existing Imports ---
import express, { response } from 'express';

import { createServer, IncomingMessage } from 'http';
import WebSocket from 'ws';
import winston from 'winston';
import { v4 as uuidv4 } from 'uuid';

// --- Core Dependencies ---
import { CONFIG } from './config'; // Ensure GROQ_API_KEY, TOOL_CONFIG_PATH, NANGO_CONNECTION_ID, etc.
import { db } from './firebase';

// --- Services ---
import { ConversationService } from './services/conversation/ConversationService';
import { ToolOrchestrator } from './services/tool/ToolOrchestrator';
import { StreamManager } from './services/stream/StreamManager';
import { NangoService } from './services/NangoService';
import { FollowUpService } from './services/FollowUpService';
import { ToolConfigManager } from './services/tool/ToolConfigManager'; // Import ToolConfigManager
import { ActionLauncherService } from './action-launcher.service'; // Import ActionLauncherService

import { BeatEngine }      from './BeatEngine'; // Added BeatEngine import
import { ScratchPadStore, ScratchEntry } from './services/scratch/ScratchPadStore'; // Added ScratchPadStore & ScratchEntry import
// --- Types ---
import { ConversationConfig, LLMResponse, ToolResult } from './services/conversation/types';
import { UpdateParameterPayload, ExecuteActionPayload, InvalidToolCallInfo } from './types/actionlaunchertypes'; // Import Action Launcher Types

// --- External SDKs ---
import Groq from 'groq-sdk';
import { recordFollowUpResponse, handleChatMessage, recordAiResponseAndToolCalls, updateToolCallResult } from './services/chat_hanndler';
import { ScratchPadService } from './services/scratch/ScratchPadService';
import { UserSeedStatusStore } from './services/user-seed-status.store'
import { request } from 'https';

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.json()
    ),
    transports: [new winston.transports.Console()],
  });

// --- Critical Config Validation ---
if (!CONFIG.GROQ_API_KEY) {
  logger.error("CRITICAL ERROR: GROQ_API_KEY is not defined in environment variables. Application cannot start.");
  process.exit(1); // Exit if critical config is missing
}
if (!CONFIG.OPEN_AI_API_KEY) { // Good to check this one too if it's critical
  logger.error("CRITICAL ERROR: OPEN_AI_API_KEY is not defined in environment variables. Application cannot start.");
  process.exit(1);
}
// --- Service Initialization ---
logger.info("Initializing services...");
const nangoService = new NangoService();
const toolConfigManager = new ToolConfigManager(CONFIG.TOOL_CONFIG_PATH); // Initialize Tool Manager FIRST

// Initialize ScratchPadStore and BeatEngine
const scratchPadStore = new ScratchPadStore();
const beatEngine      = new BeatEngine(toolConfigManager);
logger.info("ScratchPadStore and BeatEngine initialized.");

const conversationConfig: ConversationConfig = {
    groqApiKey: CONFIG.GROQ_API_KEY, // Now guaranteed to be a string due to the check above
    // openAIApiKey: CONFIG.OPEN_AI_API_KEY, // If ConversationConfig needs this, add it similarly
    model: CONFIG.MODEL_NAME, maxTokens: CONFIG.MAX_TOKENS,
    nangoService: nangoService, client: undefined, tools: [], logger,
    TOOL_CONFIG_PATH: 'config/tool-config.json'
};
// Pass ToolConfigManager instance if ConversationService needs it, otherwise it creates its own

const res = response
const req =   request

const userSeedStatusStore = new UserSeedStatusStore(CONFIG.REDIS_URL || "")

const scratchPadService = new ScratchPadService(nangoService, scratchPadStore, userSeedStatusStore);

const conversationService = new ConversationService(conversationConfig);

const followUpService = new FollowUpService( new Groq({ apiKey: CONFIG.GROQ_API_KEY }), CONFIG.MODEL_NAME, CONFIG.MAX_TOKENS );

const toolOrchestrator = new ToolOrchestrator({
    logger: logger, // Pass the logger instance
    toolConfigManager: toolConfigManager, // Inject the ToolConfigManager instance
    nangoService: nangoService, // Pass the NangoService instance
});

const streamManager = new StreamManager({ logger, chunkSize: CONFIG.STREAM_CHUNK_SIZE || 512 });

// Initialize ActionLauncherService AFTER dependencies are ready
const actionLauncherService = new ActionLauncherService(conversationService, toolConfigManager, beatEngine, scratchPadService);
logger.info("All services initialized.");

// Listen for scratchpad seeded events to push updates via WebSocket
scratchPadService.on('scratchpadSeeded', (sessionId: string, entries: Record<string, ScratchEntry>) => {
  // This event signifies the initial seed data is ready for a new user.
  if (streamManager.hasConnection(sessionId)) { // Check if client is still connected
    logger.info(`Sending 'seed_data_response' (initial seed) via WebSocket for session ${sessionId}. Entry count: ${Object.keys(entries).length}`);
    streamManager.sendChunk(sessionId, {
      type: 'seed_data_response', // Matches client expectation for initial seed
      data: entries,              // Matches client expectation for payload field ('data' or 'payload')
    });
  } else {
    logger.info(`Client for session ${sessionId} not connected via WebSocket. Cannot send scratchpad_update for seeded data.`);
  }
});


// --- State Maps ---
const sessionUserIdMap = new Map<string, string>(); // Map<sessionId, userId>

// --- Event Handlers ---
followUpService.on('follow_up_generated', ({ userId, sessionId, messageId, toolCallId, fullResponse }) => {
  // Ensure chat_handler functions are imported and paths are correct
  if (!userId) { logger.error('Follow-up event missing userId', {sessionId}); return; }
  logger.info('Received follow_up_generated', { userId, sessionId, messageId, toolCallId });
  // Ensure chat_handler functions expect userId as first arg
  recordFollowUpResponse(userId, sessionId, messageId, fullResponse, toolCallId) // userId FIRST
    .catch(err => logger.error('Failed recording follow-up', { error: err.message, userId, sessionId }));
});

followUpService.on('send_chunk', (sessionId, chunk) => {
  if (!chunk || typeof chunk !== 'object' || !sessionId) { logger.error("Invalid send_chunk data", {sessionId}); return; }
  streamManager.sendChunk(sessionId, chunk);
});

// --- Express App & Server ---
const app = express();
app.use(express.json());
const server = createServer(app);

// --- API Endpoints ---
app.get('/api/sessions/:sessionId/scratchpad', async (req, res) => {
  const { sessionId } = req.params;
  logger.info(`[API /scratchpad] Request received for session ID: ${sessionId}`);

  if (!sessionId) {
    logger.warn('[API /scratchpad] Bad Request: sessionId is missing');
    res.status(400).send({ message: 'You are not valid for this website.' }); return;
  }

  try {
    logger.info(`[API /scratchpad] Calling scratchPadService.getScratchPadEntries for session: ${sessionId}`);
    const entries = await scratchPadService.getScratchPadEntries(sessionId, sessionUserIdMap.get(sessionId) || 'unknown');
    logger.info(`[API /scratchpad] Returned from scratchPadService.getScratchPadEntries for session: ${sessionId}. Entry count: ${Object.keys(entries).length}`);
    res.json(entries);
    logger.info(`[API /scratchpad] Response sent for session: ${sessionId}`);
  } catch (error: any) {
    logger.error(`[API /scratchpad] Error fetching scratchpad for session ${sessionId}: ${error.message}`, { stack: error.stack });
    res.status(500).json({ error: 'Failed to fetch scratchpad data', details: error.message });
  }
});


// --- WebSocket Server ---
const wss = new WebSocket.Server({ server });
logger.info("WebSocket server started.");

wss.on('connection', async (ws: WebSocket, req: IncomingMessage) => {
  const urlParts = req.url?.split('/') ?? [];
  const sessionId = urlParts.pop(); // Use last part of path as sessionId
  if (!sessionId || sessionId.length < 5) { logger.error('Connection rejected: Invalid sessionId'); ws.close(1008); return; }
  logger.info('Client connection attempt', { sessionId });

  streamManager.addConnection(sessionId, ws);
  logger.info(`Client connected`, { sessionId });

  let isInitialized = false;
  let currentUserId: string | null = null;

  // --- Message Handling Logic ---
  ws.on('message', async (message: Buffer) => {
    let messageId: string | null = null;
    try {
      const messageString = message.toString();
      let data: any;
      try { data = JSON.parse(messageString); }
      catch (e: any) { logger.error("Failed WS JSON parse", {sessionId, error: e.message }); return; }
      // logger.debug('RAW_MESSAGE_RECEIVED', { sessionId, type: data.type });

      // --- Handle Initialization Message ---
      if (data.type === 'init') {
         if (data.userId && typeof data.userId === 'string') {
            currentUserId = data.userId;
            sessionUserIdMap.set(sessionId, currentUserId!); // Corrected: data.userId
            isInitialized = true;
            logger.info('Client initialized', { sessionId, userId: currentUserId });

            // --- Proactively trigger scratchpad check/seeding ---
            // This call initiates the seeding process if needed for the new user.
            // The actual seeded data will be sent via WebSocket when 'scratchpadSeeded' event fires.
            try {
                logger.info(`Proactively calling getScratchPadEntries for new session/user.`, { sessionId, userId: currentUserId });
                scratchPadService.getScratchPadEntries(sessionId, currentUserId!)
                    .then(initialEntries => {
                        // This .then block is mostly for logging the immediate outcome of the call.
                        // The actual data push relies on the 'scratchpadSeeded' event.
                        if (Object.keys(initialEntries).some(key => key === "system_initial_load_placeholder")) {
                            logger.info(`getScratchPadEntries returned placeholder for session ${sessionId}. Waiting for 'scratchpadSeeded' event to send data.`);
                        } else if (Object.keys(initialEntries).length > 0) {
                            logger.info(`getScratchPadEntries returned ${Object.keys(initialEntries).length} entries for session ${sessionId}. User might have been already seeded or seeding was very fast. Client should rely on local cache or 'scratchpadSeeded' event.`);
                        } else {
                             logger.info(`getScratchPadEntries returned no immediate entries for session ${sessionId} (user: ${currentUserId}). This is expected if user was already seeded. Waiting for 'scratchpadSeeded' if new seeding occurs.`);
                        }
                    })
                    .catch(err => {
                        logger.error(`Error during proactive call to getScratchPadEntries for session ${sessionId}: ${err.message}`, { error: err });
                    });
            } catch (e: any) {
                logger.error(`Synchronous error trying to trigger getScratchPadEntries for session ${sessionId}: ${e.message}`, { error: e });
            }

             // --- INIT: session-start beat ---
             // Send kickoff beat (this can happen in parallel or after triggering the scratchpad check)
             const kickoffBeats = await beatEngine.generateBeats('session-start', {
               sessionId,
               messageId: 'init', // Use a specific identifier for init
               scratchSummary: scratchPadStore.get(sessionId) // Pass current scratchpad summary
             });
             kickoffBeats.forEach(b =>
               streamManager.sendChunk(sessionId, { type: 'beat', content: b })
             );
             logger.info(`Sent ${kickoffBeats.length} session-start beats`, { sessionId, userId: currentUserId });
         } else { logger.error('Init failed: userId missing/invalid', { sessionId }); ws.close(1008); return; }
         return;
      }

      // --- Check if initialized ---
      if (!isInitialized || !currentUserId) { logger.warn('Msg before init', { sessionId }); ws.close(1008); return; }

      // --- Handle Action Launcher Client Messages ---
      switch (data.type) {
          case 'update_parameter':
              if (data.content && typeof data.content === 'object') {
                  logger.info('Received update_parameter', { userId: currentUserId, sessionId });
                  const payload = data.content as UpdateParameterPayload;
                  const updatedAction = actionLauncherService.updateParameterValue(sessionId, payload);
                  if (updatedAction) streamManager.sendChunk(sessionId, { type: 'parameter_updated', content: updatedAction });
                  else logger.warn('Parameter update failed', { sessionId, payload });
              } else { logger.warn('Invalid update_parameter format', { sessionId }); }
              return;

          case 'execute_action':
               if (data.content && typeof data.content === 'object') {
                   logger.info('Received execute_action', { userId: currentUserId, sessionId });
                   const payload = data.content as ExecuteActionPayload;
                   try {
                       const executedAction = await actionLauncherService.executeAction(sessionId, payload, toolOrchestrator);
                       streamManager.sendChunk(sessionId, { type: 'action_executed', content: executedAction });
                       logger.info('Action executed via Launcher', { sessionId, actionId: payload.actionId, status: executedAction.status });

                       // Trigger Follow-up after successful Action Launcher execution
                       if (executedAction.status === 'completed' && executedAction.result) {
                            const originalMessageId = actionLauncherService.findMessageIdForAction(sessionId, payload.actionId);
                            if(originalMessageId) {
                                logger.info("Triggering follow-up after execute_action", {actionId: payload.actionId, originalMessageId})
                                followUpService.triggerFollowUp({
                                    userId: currentUserId, sessionId, messageId: originalMessageId,
                                    toolCallId: executedAction.id, // Use action ID
                                    toolName: executedAction.toolName, toolResult: executedAction.result
                                });
                            } else { logger.warn("Cannot trigger follow-up, original messageId link missing.", {actionId: payload.actionId}); }
                       }
                   } catch(execError: any) {
                        logger.error('execute_action failed', { error: execError.message, sessionId, actionId: payload.actionId });
                        const failedAction = actionLauncherService.getAction(sessionId, payload.actionId);
                         streamManager.sendChunk(sessionId, { type: 'action_executed', content: failedAction ?? { id: payload.actionId, status: 'failed', error: execError.message } });
                   }
               } else { logger.warn('Invalid execute_action format', { sessionId }); }
               return;
      }

      // --- Process Regular Chat Message ('content' type implied) ---
      if (data.content && typeof data.content === 'string') {
          logger.info('MESSAGE_RECEIVED (content)', { userId: currentUserId, sessionId });

          // 1. Record User Msg & Placeholder (Pass userId)
          messageId = await handleChatMessage(currentUserId, sessionId, data.content);
          logger.info('User message/placeholder recorded', { userId: currentUserId, sessionId, messageId });

          // 2. Process Message (Single LLM Call)
          const aiResponse: LLMResponse = await conversationService.processMessage(data.content, sessionId);
          logger.info('AI processing complete', { userId: currentUserId, sessionId, messageId });

          // 3. Record Initial AI Response & Pending Tools (Pass userId)
          // Ensure chat_handler functions expect userId
          await recordAiResponseAndToolCalls(currentUserId, sessionId, messageId, aiResponse);
          logger.info('Initial AI response/pending tools recorded', { userId: currentUserId, sessionId, messageId });

          // --- PRE-TOOL-CALL: beat generation if any tool call requested ---
          if (aiResponse.toolCalls && aiResponse.toolCalls.length > 0) {
            const intendedToolName = aiResponse.toolCalls[0].function.name; // Assuming first tool is primary intent for now
            logger.info('Generating pre-tool-call beats', { sessionId, messageId, intendedToolName });
            const preBeats = await beatEngine.generateBeats('pre-tool-call', {
              sessionId,
              messageId,
              intendedToolName: intendedToolName,
              missingParams: [] // Placeholder: Validation logic below will determine actual missing params if needed
            });
            preBeats.forEach(b =>
              streamManager.sendChunk(sessionId, { type: 'beat', content: b })
            );
          }

          // --- DECISION & EXECUTION ---
          const toolCalls = aiResponse.toolCalls;
          let aiContentToStream = aiResponse.content;

          if (toolCalls && toolCalls.length > 0) {
              const isParamRequest = toolCalls.length === 1 && toolCalls[0].function.name === 'request_missing_parameters';
              const regularCalls = toolCalls.filter(tc => tc.function.name !== 'request_missing_parameters');

              if (isParamRequest) {
                  // 4a. Handle LLM Parameter Request
                  logger.info('LLM requested parameters via meta-tool', { sessionId, messageId });
                  try {
                      const args = JSON.parse(toolCalls[0].function.arguments || '{}');
                      const { intended_tool_name, missing_params, clarification_question } = args;
                      if (!intended_tool_name || !missing_params || !clarification_question) throw new Error("Invalid request_missing_parameters args");

                      // SCENARIO A: LLM called request_missing_parameters
                      const response = actionLauncherService.createLauncherResponseForParameterRequest(
                          intended_tool_name, missing_params, clarification_question,
                          sessionId, messageId // Pass original messageId
                      );
                      logger.debug('SERVER SENDING (LLM param req):', { sessionId, messageId, type: 'parameter_collection_required', content: JSON.stringify(response, null, 2) });
                      streamManager.sendChunk(sessionId, { type: 'parameter_collection_required', content: response, messageId });
                      aiContentToStream = null; // Don't stream original text
                  } catch (e: any) {
                       logger.error('Failed handling param request tool', {error: e.message, args: toolCalls[0].function.arguments});
                       streamManager.sendChunk(sessionId, {type: 'error', content: 'Problem processing parameter request.'});
                       // Keep aiContentToStream to show the original AI text in case of error? Or null? Let's null it.
                       aiContentToStream = null;
                  }

              } else if (regularCalls.length > 0) {
                  // 4b. Validate and Execute Regular Tools
                  logger.info(`Processing ${regularCalls.length} regular tool calls with server-side validation`, { sessionId, messageId });

                  let allToolCallsProceededWithoutNeedingParams = true;

                  for (const toolCall of regularCalls) {
                      const toolName = toolCall.function.name;
                      let parsedArgs: Record<string, any> = {};
                      try {
                          if (toolCall.function.arguments) parsedArgs = JSON.parse(toolCall.function.arguments);
                      } catch (e) {
                          logger.warn("Arg parse failed before server-side validation", { toolCallId: toolCall.id, args: toolCall.function.arguments, sessionId, messageId });
                          const allRequired = toolConfigManager.getToolInputSchema(toolName)?.required || [];
                          await actionLauncherService.initiateServerSideParameterCollection(sessionId, currentUserId, messageId, toolName, allRequired, {});
                          allToolCallsProceededWithoutNeedingParams = false;
                          continue; // Move to next tool call if any
                      }

                      const missingRequired = toolConfigManager.findMissingRequiredParams(toolName, parsedArgs);
                      const missingConditional = toolConfigManager.findConditionallyMissingParams(toolName, parsedArgs);
                      const allMissingParams = [...new Set([...missingRequired, ...missingConditional])];

                      if (allMissingParams.length > 0) {
                          logger.info(`Server-side validation found missing params for ${toolName}: ${allMissingParams.join(', ')}`, { sessionId, messageId });
                          const messagesToClient = await actionLauncherService.initiateServerSideParameterCollection(
                              sessionId, currentUserId, messageId, toolName, allMissingParams, parsedArgs
                          );
                          messagesToClient.forEach((msg: any) => streamManager.sendChunk(sessionId, msg));
                          allToolCallsProceededWithoutNeedingParams = false;
                      } else {
                          logger.info(`All params validated server-side for ${toolName}. Proceeding to execution.`, { sessionId, messageId });
                          await handleToolCalls([toolCall], currentUserId, sessionId, messageId); // Pass as array
                      }
                  }
                  // If any tool call triggered parameter collection, don't stream original AI text
                  if (!allToolCallsProceededWithoutNeedingParams) {
                      aiContentToStream = null;
                  }
              }
          }

          // 4c/4d. Stream Remaining AI Text or Default Message
          if (aiContentToStream) {
            logger.info('Streaming final AI text response', { sessionId, messageId });
            for await (const chunk of streamManager.createStream(aiContentToStream)) {
              streamManager.sendChunk(sessionId, {
                ...chunk,
                messageId,              // attach the chat message ID
              });
            }
          }

      } else { logger.warn('Received initialized message with unknown type/content', { sessionId }); }

    } catch (error: any) {
         logger.error('Outer message processing error', { error: error.message, stack: error.stack, sessionId, userId: currentUserId, messageId });
         try { streamManager.sendChunk(sessionId, { type: 'error', content: `Server error: ${error.message || 'Unknown error'}`, messageId }); }
         catch (sendError: any) { logger.error("Failed sending error chunk", { sessionId }); }
    }
  }); // End ws.on('message')

  // --- Connection Close/Error Handling ---
   ws.on('close', (code, reason) => {
       const reasonString = reason ? reason.toString('utf8') : 'N/A';
       logger.info('Client disconnected (close event)', { sessionId, userId: sessionUserIdMap.get(sessionId), code, reason: reasonString });
       streamManager.removeConnection(sessionId); // Use added method
       sessionUserIdMap.delete(sessionId);
       actionLauncherService.clearActions(sessionId);
       logger.info('Cleaned up session map and actions on close', { sessionId });
   });
   ws.on('error', (error) => {
       logger.error('WebSocket error event', { sessionId, userId: sessionUserIdMap.get(sessionId), error: error.message || error });
       streamManager.removeConnection(sessionId); // Use added method
       sessionUserIdMap.delete(sessionId);
       actionLauncherService.clearActions(sessionId);
       logger.info('Cleaned up session maps and actions after WS error', { sessionId });
       // ws.terminate(); // Ensure connection is truly closed on error
   });

}); // End wss.on('connection')


// --- Helper Function for Tool Call Validation ---
// Defined outside connection handler for clarity
async function validateToolCalls(
    toolCalls: NonNullable<LLMResponse['toolCalls']>,
    configManager: ToolConfigManager // Pass instance
): Promise<{ validToolCalls: NonNullable<LLMResponse['toolCalls']>, invalidToolCallsInfo: InvalidToolCallInfo[] }> {
    const validToolCalls: NonNullable<LLMResponse['toolCalls']> = [];
    const invalidToolCallsInfo: InvalidToolCallInfo[] = [];

    for (const toolCall of toolCalls) {
        let parsedArgs: Record<string, any> = {}; let parseError = false;
        try { if (toolCall.function.arguments) parsedArgs = JSON.parse(toolCall.function.arguments); }
        catch (e) { parseError = true; logger.warn("Arg parse failed in validation", {toolCallId: toolCall.id}); }

        // Use ToolConfigManager method to find missing required & non-defaultable params
        const missingParams = parseError
             ? (configManager.getToolInputSchema(toolCall.function.name)?.required || []) // Assume all required missing if parse failed
             : configManager.findMissingRequiredParams(toolCall.function.name, parsedArgs);

        if (missingParams.length === 0) {
            validToolCalls.push(toolCall); // Valid or defaults handled
        } else {
            invalidToolCallsInfo.push({ // Needs user input
                originalToolCall: toolCall,
                missingParams: missingParams,
                toolSchema: configManager.getToolInputSchema(toolCall.function.name) // Include schema for context
            });
        }
    }
    return { validToolCalls, invalidToolCallsInfo };
}

// --- Tool Call Handling Function (Handles *validated* direct calls) ---
// Passed userId, sessionId, messageId
async function handleToolCalls(
    validToolCalls: NonNullable<LLMResponse['toolCalls']>,
    userId: string, sessionId: string, messageId: string
): Promise<void> {
    logger.info(`Executing ${validToolCalls.length} validated direct tool calls`, { userId, sessionId, messageId });
    const nangoConnectionId = CONFIG.CONNECTION_ID; // Get Nango ID from config
    if (!nangoConnectionId) {
        logger.error("Nango Connection ID missing!", { userId, sessionId });
        streamManager.sendChunk(sessionId, { type: 'error', content: 'Server tool configuration error.' });
        return;
    }
    for (const toolCall of validToolCalls) {
       logger.info('Executing validated tool', { tool: toolCall.function.name, toolCallId: toolCall.id });
       streamManager.sendChunk(sessionId, {type: 'tool_call', content: `Executing: ${toolCall.function.name}...`, toolCallId: toolCall.id, messageId});
       try {
           let parsedArgs = {};
               try { if (toolCall.function.arguments) parsedArgs = JSON.parse(toolCall.function.arguments); } catch(e){ logger.warn("Failed to parse tool arguments for scratchpad filters", {toolCallId: toolCall.id, args: toolCall.function.arguments}) }

           // Execute Tool
           const result: ToolResult = await toolOrchestrator.executeTool({
                   name: toolCall.function.name, arguments: parsedArgs, sessionId, id: toolCall.id, // Pass parsedArgs here too
               ToolName: '',
               args: {},
               result: {},
           });

           // Update DB (Pass userId)
           await updateToolCallResult(userId, sessionId, messageId, toolCall.id, result);
           streamManager.sendChunk(sessionId, {
            type: 'tool_result',
            messageId: messageId,
            toolCallId: toolCall.id,
            toolName:   toolCall.function.name,
            // result.data should be your { count, data: [...] } object
            result:     result.data 
          });

           // --- Write to ScratchPad ---
           const scratchEntry: ScratchEntry = {
               source:    toolCall.function.name, // Tool name as the source
               filters:   parsedArgs,             // Arguments used as filters
               records:   result.data,            // The actual result data
               summary:   { // Match the expected { count: number } structure
                            count: Array.isArray(result.data)
                                     ? (result.data?.length ?? 0)
                                     : (result.data ? 1 : 0) },
               timestamp: new Date().toISOString()
           };
           scratchPadStore.set(sessionId, toolCall.function.name, scratchEntry);
           logger.info('Wrote tool result to scratchpad', { sessionId, toolName: toolCall.function.name, toolCallId: toolCall.id });

           // --- POST-TOOL-CALL: refocus beat after each tool result ---
           // (Placed after scratchpad write and streaming tool_result)
           // Send WS Status Update
           streamManager.sendChunk(sessionId, {type: 'tool_status_update', status: result.status, toolCallId: toolCall.id, messageId, error: result.error});

           // Trigger Follow-up on Success (Pass userId)
           if (result.status === 'success') {
               logger.info("Triggering follow-up for direct tool call", {toolCallId: toolCall.id})
               followUpService.triggerFollowUp({userId, sessionId, messageId, toolCallId: toolCall.id, toolName: toolCall.function.name, toolResult: result});
           }
       } catch (toolError: any) {
           logger.error('Direct tool execution failed', { error: toolError.message, toolCallId: toolCall.id });
           const errorResult: ToolResult = { status: 'failed', toolName: toolCall.function.name, data: null, error: toolError.message };
           try { await updateToolCallResult(userId, sessionId, messageId, toolCall.id, errorResult); } catch (dbError: any) { /* log */ }
           streamManager.sendChunk(sessionId, {type: 'tool_status_update', status: 'failed', toolCallId: toolCall.id, messageId, error: errorResult.error});
       }
    }
    logger.info(`Finished executing validated direct tool calls`, { userId, sessionId, messageId });
}
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`🚀 Server is listening on port ${PORT}`);
});

// --- Health & Server Start ---
// Use the PORT environment variable. Cloud Run automatically sets this.
// For local development, you can set it in your .env file or it will default to 8080.




// --- Graceful Shutdown ---
process.on('SIGTERM', () => {
    logger.info('SIGTERM received. Shutting down gracefully...');
    const shutdownTimeoutMs = 10000;
    const shutdownTimeout = setTimeout(() => { logger.warn(`Graceful shutdown timed out.`); process.exit(1); }, shutdownTimeoutMs);
    let httpServerClosed = false; let wsServerClosed = false;
    const checkAndExit = () => { if (httpServerClosed && wsServerClosed) { clearTimeout(shutdownTimeout); logger.info('Shutdown complete.'); process.exit(0); }};
    logger.info('Closing WebSocket server...');
    wss.close((wsErr) => { if (wsErr) logger.error('WSS close error:', wsErr); wss.clients.forEach((wsClient) => wsClient.terminate()); sessionUserIdMap.clear(); actionLauncherService.clearAllActions(); wsServerClosed = true; checkAndExit(); }); // Clear actions map
    logger.info('Closing HTTP server...');
    server.close((httpErr) => { if (httpErr) logger.error('HTTP close error:', httpErr); httpServerClosed = true; checkAndExit(); });
});

// Add helper to ActionLauncherService to clear all actions on shutdown
// In action-launcher.service.ts:
// public clearAllActions(): void { this.activeActions.clear(); logger.info("Cleared all active actions."); }