// src/index.ts (Final, Corrected Version with Persistent Sessions)

import express from 'express';
import dotenv from 'dotenv';
dotenv.config();

import { createServer } from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import winston from 'winston';
import { v4 as uuidv4 } from 'uuid';
import Groq from 'groq-sdk';
import * as storage from 'node-persist';

// --- Core Dependencies & Services ---
import { CONFIG } from './config';
import { auth as firebaseAdminAuth } from './firebase';
import { ConversationService, ProcessedMessageResult } from './services/conversation/ConversationService';
import { ToolOrchestrator } from './services/tool/ToolOrchestrator';
import { StreamManager } from './services/stream/StreamManager';
import { NangoService } from './services/NangoService';
import { FollowUpService } from './services/FollowUpService';
import { ToolConfigManager } from './services/tool/ToolConfigManager';
import { PlannerService, ActionPlan } from './services/PlannerService';
import { ActionLauncherService } from './action-launcher.service';
import { ScratchPadStore } from './services/scratch/ScratchPadStore';
import { UserSeedStatusStore } from './services/user-seed-status.store';
import { RunManager } from './services/tool/RunManager';
import { StreamChunk } from './services/stream/types';
import { ExecuteActionPayload } from './types/actionlaunchertypes';

// --- Types ---
import { Run } from './services/tool/run.types';
import { ToolResult } from './services/conversation/types';
import { ToolCall } from './services/tool/tool.types';
import { BeatEngine } from './BeatEngine';

// --- Logger Setup ---
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
    transports: [new winston.transports.Console()],
});

// --- Service Initialization ---
const groqClient = new Groq({ apiKey: CONFIG.GROQ_API_KEY });
const toolConfigManager = new ToolConfigManager();
const nangoService = new NangoService();
const streamManager = new StreamManager({ logger });
const toolOrchestrator = new ToolOrchestrator({ logger, nangoService, toolConfigManager });
const plannerService = new PlannerService(CONFIG.OPEN_AI_API_KEY, CONFIG.MODEL_NAME, CONFIG.MAX_TOKENS, toolConfigManager);
const scratchPadStore = new ScratchPadStore();
const userSeedStatusStore = new UserSeedStatusStore(CONFIG.REDIS_URL!);
const beatEngine = new BeatEngine(toolConfigManager);
const followUpService = new FollowUpService(groqClient, CONFIG.MODEL_NAME, 150, toolConfigManager);

const conversationService = new ConversationService({
    groqApiKey: CONFIG.GROQ_API_KEY,
    model: CONFIG.MODEL_NAME,
    maxTokens: CONFIG.MAX_TOKENS,
    TOOL_CONFIG_PATH: CONFIG.TOOL_CONFIG_PATH,
    nangoService: nangoService,
    logger: logger,
    client: groqClient,
    tools: [],
});

const actionLauncherService = new ActionLauncherService(
    conversationService,
    toolConfigManager,
    beatEngine,
);

// --- Session State Management ---
interface SessionState {
    userId: string;
    activeRun?: Run;
}
const sessionState: storage.LocalStorage = storage.create({ dir: 'sessions' });
(async () => {
    await sessionState.init();
    logger.info('Persistent session storage initialized.');
})();

// --- Helper Functions ---
async function streamText(sessionId: string, messageId: string, text: string) {
    streamManager.sendChunk(sessionId, { type: 'conversational_text_segment', content: { status: 'START_STREAM' }, messageId } as StreamChunk);
    const delay = (ms: number) => new Promise(res => setTimeout(res, ms));
    for (let i = 0; i < text.length; i += 10) {
        const chunk = text.substring(i, i + 10);
        streamManager.sendChunk(sessionId, { type: 'conversational_text_segment', content: { status: 'STREAMING', segment: { segment: chunk, styles: [], type: 'text' } }, messageId } as StreamChunk);
        await delay(20);
    }
    streamManager.sendChunk(sessionId, { type: 'conversational_text_segment', content: { status: 'END_STREAM' }, messageId, isFinal: true } as StreamChunk);
    streamManager.sendChunk(sessionId, { type: 'stream_end', isFinal: true, messageId, streamType: 'conversational' } as StreamChunk);
}

// --- WebSocket Server Setup ---
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

actionLauncherService.on('send_chunk', (sessionId: string, chunk: StreamChunk) => {
    streamManager.sendChunk(sessionId, chunk);
});

wss.on('connection', (ws: WebSocket) => {
    const sessionId = uuidv4();
    streamManager.addConnection(sessionId, ws);
    logger.info('Client connected', { sessionId });

    ws.on('message', async (message: string) => {
        try {
            const data = JSON.parse(message);
            
            if (data.type === 'init') {
                const decodedToken = await firebaseAdminAuth.verifyIdToken(data.idToken);
                await sessionState.setItem(sessionId, { userId: decodedToken.uid });
                ws.send(JSON.stringify({ type: 'auth_success' }));
                logger.info('Client authenticated', { userId: decodedToken.uid, sessionId });
                return;
            }

            const state = await sessionState.getItem(sessionId);
            if (!state) { throw new Error('Not authenticated'); }
            const { userId } = state;

            if (data.type === 'execute_action' && data.content) {
                const actionPayload = data.content as ExecuteActionPayload;
                let currentRun = state.activeRun;
                if (!currentRun) {
                    logger.warn(`No active run found for single action execution. Creating a new run.`, { sessionId });
                    const userInput = `Executing action: ${actionPayload.toolName}`;
                    currentRun = RunManager.createRun({ sessionId, userId, userInput, toolExecutionPlan: [] });
                }
                const updatedAction = await actionLauncherService.executeAction(sessionId, userId, actionPayload, toolOrchestrator);
                currentRun = RunManager.addToolResult(currentRun, updatedAction.id, {
                    status: updatedAction.status === 'completed' ? 'success' : 'failed',
                    toolName: updatedAction.toolName,
                    data: updatedAction.result,
                    error: updatedAction.error,
                });
                state.activeRun = currentRun;
                await sessionState.setItem(sessionId, state);
                streamManager.sendChunk(sessionId, { type: 'run_updated', content: currentRun });

            } else if (data.type === 'content' && typeof data.content === 'string') {
                const messageId = uuidv4();
                const processedResult = await conversationService.processMessageAndAggregateResults(data.content, sessionId, messageId, userId);
                const { aggregatedToolCalls, conversationalResponse } = processedResult;

                if (conversationalResponse && conversationalResponse.trim().length > 0) {
                    await streamText(sessionId, messageId, conversationalResponse);
                }

                const isPlanRequest = aggregatedToolCalls.some(tool => tool.name === 'planParallelActions');
                const executableToolCount = aggregatedToolCalls.filter(t => t.name !== 'planParallelActions').length;

                if (isPlanRequest || executableToolCount > 1) {
                    logger.info(`Complex request identified. Routing to PlannerService.`, { sessionId });
                    const run = RunManager.createRun({ sessionId, userId, userInput: data.content, toolExecutionPlan: [] });
                    state.activeRun = run;
                    await sessionState.setItem(sessionId, state);
                    streamManager.sendChunk(sessionId, { type: 'run_updated', content: run });

                    const toolsForPlanning = aggregatedToolCalls.filter(tool => tool.name !== 'planParallelActions');
                    const actionPlan = await plannerService.generatePlan(data.content, toolsForPlanning, sessionId, messageId);

                    if (actionPlan && actionPlan.length > 0) {
                        await actionLauncherService.processActionPlan(actionPlan, sessionId, userId, messageId, run);
                    } else if (!conversationalResponse) {
                        await streamText(sessionId, messageId, "I was unable to formulate a plan for your request.");
                    }
                } else if (aggregatedToolCalls.length > 0) {
                    const singleToolCall = aggregatedToolCalls[0];
                    const singleStepPlan: ActionPlan = [{
                        id: singleToolCall.id || uuidv4(),
                        intent: `Execute the ${singleToolCall.name} tool.`,
                        tool: singleToolCall.name,
                        arguments: singleToolCall.arguments,
                        status: 'ready',
                        function: undefined
                    }];
                    await actionLauncherService.processActionPlan(singleStepPlan, sessionId, userId, messageId, state.activeRun);
                } else if (!conversationalResponse) {
                    await streamText(sessionId, messageId, "I'm not sure how to help. Please rephrase.");
                }
            }
        } catch (error: any) {
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