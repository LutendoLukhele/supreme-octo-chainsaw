"use strict";
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
const ioredis_1 = __importDefault(require("ioredis"));
const http_1 = require("http");
const ws_1 = require("ws");
const winston_1 = __importDefault(require("winston"));
const uuid_1 = require("uuid");
const groq_sdk_1 = __importDefault(require("groq-sdk"));
const storage = __importStar(require("node-persist"));
const config_1 = require("./config");
const firebase_1 = require("./firebase");
const redis = new ioredis_1.default(config_1.CONFIG.REDIS_URL);
const ConversationService_1 = require("./services/conversation/ConversationService");
const ToolOrchestrator_1 = require("./services/tool/ToolOrchestrator");
const StreamManager_1 = require("./services/stream/StreamManager");
const NangoService_1 = require("./services/NangoService");
const FollowUpService_1 = require("./services/FollowUpService");
const ToolConfigManager_1 = require("./services/tool/ToolConfigManager");
const PlannerService_1 = require("./services/PlannerService");
const action_launcher_service_1 = require("./action-launcher.service");
const RunManager_1 = require("./services/tool/RunManager");
const BeatEngine_1 = require("./BeatEngine");
const logger = winston_1.default.createLogger({
    level: 'info',
    format: winston_1.default.format.combine(winston_1.default.format.timestamp(), winston_1.default.format.json()),
    transports: [new winston_1.default.transports.Console()],
});
const groqClient = new groq_sdk_1.default({ apiKey: config_1.CONFIG.GROQ_API_KEY });
const toolConfigManager = new ToolConfigManager_1.ToolConfigManager();
const nangoService = new NangoService_1.NangoService();
const streamManager = new StreamManager_1.StreamManager({ logger });
const toolOrchestrator = new ToolOrchestrator_1.ToolOrchestrator({ logger, nangoService, toolConfigManager });
const plannerService = new PlannerService_1.PlannerService(config_1.CONFIG.OPEN_AI_API_KEY, config_1.CONFIG.MODEL_NAME, config_1.CONFIG.MAX_TOKENS, toolConfigManager);
const beatEngine = new BeatEngine_1.BeatEngine(toolConfigManager);
const followUpService = new FollowUpService_1.FollowUpService(groqClient, config_1.CONFIG.MODEL_NAME, 150, toolConfigManager);
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
const actionLauncherService = new action_launcher_service_1.ActionLauncherService(conversationService, toolConfigManager, beatEngine);
const sessionState = storage.create({ dir: 'sessions' });
(async () => {
    await sessionState.init();
    logger.info('Persistent session storage initialized.');
})();
async function streamText(sessionId, messageId, text) {
    streamManager.sendChunk(sessionId, { type: 'conversational_text_segment', content: { status: 'START_STREAM' }, messageId });
    const delay = (ms) => new Promise(res => setTimeout(res, ms));
    for (let i = 0; i < text.length; i += 10) {
        const chunk = text.substring(i, Math.min(i + 10, text.length));
        streamManager.sendChunk(sessionId, { type: 'conversational_text_segment', content: { status: 'STREAMING', segment: { segment: chunk, styles: [], type: 'text' } }, messageId });
        await delay(20);
    }
    streamManager.sendChunk(sessionId, { type: 'conversational_text_segment', content: { status: 'END_STREAM' }, messageId, isFinal: true });
    streamManager.sendChunk(sessionId, { type: 'stream_end', isFinal: true, messageId, streamType: 'conversational' });
}
const app = (0, express_1.default)();
const server = (0, http_1.createServer)(app);
const wss = new ws_1.WebSocketServer({ server });
actionLauncherService.on('send_chunk', (sessionId, chunk) => {
    streamManager.sendChunk(sessionId, chunk);
});
wss.on('connection', (ws) => {
    const sessionId = (0, uuid_1.v4)();
    streamManager.addConnection(sessionId, ws);
    logger.info('Client connected', { sessionId });
    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            if (data.type === 'init') {
                const decodedToken = await firebase_1.auth.verifyIdToken(data.idToken);
                await sessionState.setItem(sessionId, { userId: decodedToken.uid });
                ws.send(JSON.stringify({ type: 'auth_success' }));
                logger.info('Client authenticated', { userId: decodedToken.uid, sessionId });
                return;
            }
            const state = await sessionState.getItem(sessionId);
            if (!state) {
                throw new Error('Not authenticated');
            }
            const { userId } = state;
            if (data.type === 'execute_action' && data.content) {
                const actionPayload = data.content;
                let currentRun = state.activeRun;
                if (!currentRun) {
                    logger.error('Cannot execute action without an active run.', { sessionId });
                    streamManager.sendChunk(sessionId, { type: 'error', content: 'No active run found to execute action.' });
                    return;
                }
                const completedAction = await actionLauncherService.executeAction(sessionId, userId, actionPayload, toolOrchestrator);
                if (!currentRun.toolExecutionPlan) {
                    currentRun.toolExecutionPlan = [];
                }
                let toolIndex = currentRun.toolExecutionPlan.findIndex((step) => step.toolCall.id === completedAction.id);
                if (toolIndex === -1) {
                    const newStep = {
                        toolCall: {
                            id: completedAction.id, name: completedAction.toolName,
                            arguments: completedAction.arguments || {}, sessionId: sessionId, userId: userId,
                        },
                        status: 'pending', startedAt: new Date().toISOString()
                    };
                    currentRun.toolExecutionPlan.push(newStep);
                    toolIndex = currentRun.toolExecutionPlan.length - 1;
                }
                currentRun.toolExecutionPlan[toolIndex].status = completedAction.status;
                currentRun.toolExecutionPlan[toolIndex].result = {
                    status: completedAction.status === 'completed' ? 'success' : 'failed',
                    toolName: completedAction.toolName, data: completedAction.result, error: completedAction.error
                };
                currentRun.toolExecutionPlan[toolIndex].finishedAt = new Date().toISOString();
                const allDone = currentRun.toolExecutionPlan.every((step) => step.status === 'completed' || step.status === 'failed');
                if (allDone) {
                    currentRun.status = 'completed';
                    currentRun.completedAt = new Date().toISOString();
                }
                state.activeRun = currentRun;
                await sessionState.setItem(sessionId, state);
                streamManager.sendChunk(sessionId, { type: 'run_updated', content: currentRun });
                if (completedAction.status === 'completed') {
                    logger.info('Action completed, generating follow-up message.', { sessionId });
                    try {
                        const followUpResult = await followUpService.generateFollowUp(currentRun, sessionId, (0, uuid_1.v4)());
                        const followUpText = followUpResult.summary;
                        if (followUpText && followUpText.trim().length > 0) {
                            await streamText(sessionId, (0, uuid_1.v4)(), followUpText);
                        }
                    }
                    catch (error) {
                        logger.error('Failed to generate follow-up message.', { error: error.message, sessionId });
                    }
                }
            }
            else if (data.type === 'update_active_connection' && data.content) {
                const { connectionId } = data.content;
                if (!userId || !connectionId) {
                    logger.warn('Received update_active_connection but missing userId or connectionId');
                    return;
                }
                await redis.set(`active-connection:${userId}`, connectionId);
                logger.info(`Successfully set active Nango connection for user via client message`, { userId });
                ws.send(JSON.stringify({ type: 'connection_updated_ack' }));
            }
            else if (data.type === 'content' && typeof data.content === 'string') {
                const messageId = (0, uuid_1.v4)();
                const processedResult = await conversationService.processMessageAndAggregateResults(data.content, sessionId, messageId, userId);
                const { aggregatedToolCalls, conversationalResponse } = processedResult;
                if (conversationalResponse && conversationalResponse.trim().length > 0) {
                    await streamText(sessionId, messageId, conversationalResponse);
                }
                const isPlanRequest = aggregatedToolCalls.some(tool => tool.name === 'planParallelActions');
                const executableToolCount = aggregatedToolCalls.filter(t => t.name !== 'planParallelActions').length;
                if (isPlanRequest || executableToolCount > 1) {
                    const run = RunManager_1.RunManager.createRun({
                        sessionId, userId, userInput: data.content,
                        toolExecutionPlan: []
                    });
                    state.activeRun = run;
                    await sessionState.setItem(sessionId, state);
                    streamManager.sendChunk(sessionId, { type: 'run_updated', content: run });
                    const toolsForPlanning = aggregatedToolCalls.filter(tool => tool.name !== 'planParallelActions');
                    const actionPlan = await plannerService.generatePlan(data.content, toolsForPlanning, sessionId, messageId);
                    if (actionPlan && actionPlan.length > 0) {
                        await actionLauncherService.processActionPlan(actionPlan, sessionId, userId, messageId, run);
                    }
                    else if (!conversationalResponse) {
                        await streamText(sessionId, messageId, "I was unable to formulate a plan for your request.");
                    }
                }
                else if (aggregatedToolCalls.length > 0) {
                    const singleToolCall = aggregatedToolCalls[0];
                    const singleStepPlan = [{
                            id: singleToolCall.id || (0, uuid_1.v4)(),
                            intent: `Execute the ${singleToolCall.name} tool.`,
                            tool: singleToolCall.name,
                            arguments: singleToolCall.arguments,
                            status: 'ready',
                            function: undefined,
                        }];
                    const run = RunManager_1.RunManager.createRun({
                        sessionId, userId, userInput: data.content,
                        toolExecutionPlan: []
                    });
                    state.activeRun = run;
                    await sessionState.setItem(sessionId, state);
                    streamManager.sendChunk(sessionId, { type: 'run_updated', content: run });
                    await actionLauncherService.processActionPlan(singleStepPlan, sessionId, userId, messageId, run);
                }
                else if (!conversationalResponse) {
                    await streamText(sessionId, messageId, "I'm not sure how to help. Please rephrase.");
                }
            }
        }
        catch (error) {
            logger.error('Fatal error in WebSocket handler', { error: error.message, stack: error.stack, sessionId });
            if (ws.readyState === ws.OPEN) {
                ws.send(JSON.stringify({ type: 'error', content: `Server Error: ${error.message}` }));
            }
        }
    });
    ws.on('close', async () => {
        logger.info('Client disconnected', { sessionId });
        streamManager.removeConnection(sessionId);
        await sessionState.removeItem(sessionId);
    });
});
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`🚀 Server is listening on port ${PORT}`));
