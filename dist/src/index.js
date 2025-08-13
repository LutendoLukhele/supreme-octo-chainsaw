"use strict";
// src/index.ts (Final, Corrected Version with Persistent Sessions)
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const http_1 = require("http");
const ws_1 = require("ws");
const winston_1 = __importDefault(require("winston"));
const uuid_1 = require("uuid");
const groq_sdk_1 = __importDefault(require("groq-sdk"));
const storage = __importStar(require("node-persist")); // <<< ADDED for persistent storage
// --- Core Dependencies & Services ---
const config_1 = require("./config");
const firebase_1 = require("./firebase");
const ConversationService_1 = require("./services/conversation/ConversationService");
const ToolOrchestrator_1 = require("./services/tool/ToolOrchestrator");
const StreamManager_1 = require("./services/stream/StreamManager");
const NangoService_1 = require("./services/NangoService");
const ToolConfigManager_1 = require("./services/tool/ToolConfigManager");
const PlannerService_1 = require("./services/PlannerService");
const action_launcher_service_1 = require("./action-launcher.service");
const ScratchPadStore_1 = require("./services/scratch/ScratchPadStore");
const ScratchPadService_1 = require("./services/scratch/ScratchPadService");
const user_seed_status_store_1 = require("./services/user-seed-status.store");
const RunManager_1 = require("./services/tool/RunManager");
const BeatEngine_1 = require("./BeatEngine");
// --- Logger Setup ---
const logger = winston_1.default.createLogger({
    level: 'info',
    format: winston_1.default.format.combine(winston_1.default.format.timestamp(), winston_1.default.format.json()),
    transports: [new winston_1.default.transports.Console()],
});
// --- Service Initialization ---
const groqClient = new groq_sdk_1.default({ apiKey: config_1.CONFIG.GROQ_API_KEY });
const toolConfigManager = new ToolConfigManager_1.ToolConfigManager(config_1.CONFIG.TOOL_CONFIG_PATH);
const nangoService = new NangoService_1.NangoService();
const streamManager = new StreamManager_1.StreamManager({ logger });
const toolOrchestrator = new ToolOrchestrator_1.ToolOrchestrator({ logger, nangoService, toolConfigManager });
const plannerService = new PlannerService_1.PlannerService(config_1.CONFIG.OPEN_AI_API_KEY, config_1.CONFIG.MODEL_NAME, config_1.CONFIG.MAX_TOKENS, toolConfigManager);
const scratchPadStore = new ScratchPadStore_1.ScratchPadStore();
const userSeedStatusStore = new user_seed_status_store_1.UserSeedStatusStore(config_1.CONFIG.REDIS_URL);
const scratchPadService = new ScratchPadService_1.ScratchPadService(nangoService, scratchPadStore, userSeedStatusStore);
const beatEngine = new BeatEngine_1.BeatEngine(toolConfigManager);
const conversationService = new ConversationService_1.ConversationService({
    groqApiKey: config_1.CONFIG.GROQ_API_KEY,
    model: config_1.CONFIG.MODEL_NAME,
    maxTokens: config_1.CONFIG.MAX_TOKENS,
    TOOL_CONFIG_PATH: config_1.CONFIG.TOOL_CONFIG_PATH,
    nangoService: nangoService,
    logger: logger,
    client: groqClient,
    tools: [],
});
const actionLauncherService = new action_launcher_service_1.ActionLauncherService(conversationService, toolConfigManager, beatEngine, scratchPadService);
actionLauncherService.on('send_chunk', (sessionId, chunk) => {
    logger.info(`Forwarding chunk from ActionLauncherService to client.`, { sessionId, type: chunk.type });
    streamManager.sendChunk(sessionId, chunk);
});
// --- FIX: Use the correct 'LocalStorage' type from the node-persist library ---
const sessionState = storage.create({
    dir: 'sessions', // Directory to store session files
    stringify: JSON.stringify,
    parse: JSON.parse,
    encoding: 'utf8',
    ttl: false, // Sessions do not expire
});
(async () => {
    await sessionState.init();
    logger.info('Persistent session storage initialized.');
})();
// --- Helper Functions (streamText, createDataStub, etc. remain the same) ---
async function streamText(sessionId, messageId, text) {
    // 1. Send the required START_STREAM message first.
    streamManager.sendChunk(sessionId, {
        type: 'conversational_text_segment',
        content: { status: 'START_STREAM' },
        messageId: messageId,
        isFinal: false,
    });
    const delay = (ms) => new Promise(res => setTimeout(res, ms));
    const chunkSize = 10;
    for (let i = 0; i < text.length; i += chunkSize) {
        const chunk = text.substring(i, i + chunkSize);
        // 2. Include the 'STREAMING' status with each segment.
        streamManager.sendChunk(sessionId, {
            type: 'conversational_text_segment',
            content: { status: 'STREAMING', segment: { segment: chunk, styles: [], type: 'text' } },
            messageId: messageId,
            isFinal: false,
        });
        await delay(20);
    }
    // --- FIX: Add the missing END_STREAM message ---
    // This tells the client to finalize and display the complete message.
    streamManager.sendChunk(sessionId, {
        type: 'conversational_text_segment',
        content: { status: 'END_STREAM' },
        messageId: messageId,
        isFinal: true, // Mark this chunk as final for this segment type
    });
    // --- END OF FIX ---
    // The overall stream_end message is still important.
    streamManager.sendChunk(sessionId, {
        type: 'stream_end',
        isFinal: true,
        messageId: messageId,
        streamType: 'conversational',
    });
}
// --- WebSocket Server Setup ---
const app = (0, express_1.default)();
const server = (0, http_1.createServer)(app);
const wss = new ws_1.WebSocketServer({ server });
wss.on('connection', async (ws, req) => {
    const sessionId = (0, uuid_1.v4)();
    logger.info('Client connected', { sessionId });
    streamManager.addConnection(sessionId, ws);
    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            if (data.type === 'init') {
                try {
                    const decodedToken = await firebase_1.auth.verifyIdToken(data.idToken);
                    const userId = decodedToken.uid;
                    // --- MODIFIED: Use async setItem ---
                    await sessionState.setItem(sessionId, { userId });
                    ws.send(JSON.stringify({ type: 'auth_success', content: 'Authenticated successfully' }));
                    logger.info('Client authenticated', { userId, sessionId });
                }
                catch (error) {
                    logger.warn('Auth failed', { error: error.message });
                    ws.send(JSON.stringify({ type: 'auth_fail', content: 'Invalid token' }));
                    ws.close();
                }
                return;
            }
            // --- MODIFIED: Use async getItem ---
            const state = await sessionState.getItem(sessionId);
            if (!state) {
                ws.send(JSON.stringify({ type: 'error', content: 'Not authenticated' }));
                return;
            }
            const { userId } = state;
            if (data.type === 'execute_action' && data.content) {
                const actionPayload = data.content;
                await actionLauncherService.executeAction(sessionId, userId, actionPayload, toolOrchestrator);
            }
            else if (data.type === 'content' && typeof data.content === 'string') {
                const messageId = (0, uuid_1.v4)();
                const processedResult = await conversationService.processMessageAndAggregateResults(data.content, sessionId, messageId, userId);
                const { aggregatedToolCalls, conversationalResponse } = processedResult;
                // --- FIX #1: Always stream the conversational response first ---
                if (conversationalResponse && conversationalResponse.trim().length > 0) {
                    logger.info('Streaming conversational response to client.', { sessionId });
                    await streamText(sessionId, messageId, conversationalResponse);
                }
                const isPlanRequest = aggregatedToolCalls.some(tool => tool.name === 'planParallelActions');
                const executableToolCount = aggregatedToolCalls.filter(t => t.name !== 'planParallelActions').length;
                if (isPlanRequest || executableToolCount > 1) {
                    logger.info(`Complex request identified. Routing to PlannerService.`, { sessionId });
                    // --- FIX #2: Create the Run object as soon as the plan is requested ---
                    const run = RunManager_1.RunManager.createRun({ sessionId, userId, userInput: data.content, toolExecutionPlan: [] });
                    state.activeRun = run;
                    await sessionState.setItem(sessionId, state);
                    streamManager.sendChunk(sessionId, { type: 'run_updated', content: run });
                    const toolsForPlanning = aggregatedToolCalls.filter(tool => tool.name !== 'planParallelActions');
                    const actionPlan = await plannerService.generatePlan(data.content, toolsForPlanning, sessionId, messageId);
                    if (actionPlan && actionPlan.length > 0) {
                        await actionLauncherService.processActionPlan(actionPlan, sessionId, userId, messageId);
                    }
                    else if (!conversationalResponse) {
                        await streamText(sessionId, messageId, "I was unable to formulate a plan for your request.");
                    }
                }
                else if (aggregatedToolCalls.length > 0) {
                    // For single tool calls, the run object is created inside the ActionLauncherService flow.
                    // But for consistency, we can create it here as well.
                    const run = RunManager_1.RunManager.createRun({ sessionId, userId, userInput: data.content, toolExecutionPlan: [] });
                    state.activeRun = run;
                    await sessionState.setItem(sessionId, state);
                    streamManager.sendChunk(sessionId, { type: 'run_updated', content: run });
                    const singleToolCall = aggregatedToolCalls[0];
                    logger.info(`Single tool call '${singleToolCall.name}' identified. Routing to ActionLauncherService.`, { sessionId });
                    const singleStepPlan = [{
                            id: singleToolCall.id || (0, uuid_1.v4)(),
                            intent: `Execute the ${singleToolCall.name} tool.`,
                            tool: singleToolCall.name,
                            arguments: singleToolCall.arguments,
                            status: 'ready',
                            function: undefined
                        }];
                    await actionLauncherService.processActionPlan(singleStepPlan, sessionId, userId, messageId);
                }
                else if (!conversationalResponse || conversationalResponse.trim().length === 0) {
                    logger.warn('No tools or conversational response from service, sending fallback.', { sessionId });
                    await streamText(sessionId, messageId, "I'm not sure how to help with that. Could you rephrase?");
                }
            }
        }
        catch (error) {
            logger.error('Fatal message processing error in WebSocket handler', { error: error.message, stack: error.stack, sessionId });
            ws.send(JSON.stringify({ type: 'error', content: `Server Error: ${error.message}` }));
        }
    });
    ws.on('close', async () => {
        logger.info('Client disconnected', { sessionId });
        streamManager.removeConnection(sessionId);
        // --- MODIFIED: Use async removeItem ---
        await sessionState.removeItem(sessionId);
    });
});
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`🚀 Server is listening on port ${PORT}`));
