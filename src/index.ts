// src/index.ts (Definitive, Final, Corrected Version)

import express from 'express';
import dotenv from 'dotenv';
dotenv.config();
import Redis from 'ioredis';


import { createServer } from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import winston from 'winston';
import { v4 as uuidv4 } from 'uuid';
import Groq from 'groq-sdk';
import * as storage from 'node-persist';

// --- Core Dependencies & Services ---
import { CONFIG } from './config';
import { auth as firebaseAdminAuth } from './firebase';
const redis = new Redis(CONFIG.REDIS_URL!);

import { ConversationService } from './services/conversation/ConversationService';
import { ToolOrchestrator } from './services/tool/ToolOrchestrator';
import { StreamManager } from './services/stream/StreamManager';
import { NangoService } from './services/NangoService';
import { FollowUpService } from './services/FollowUpService';
import { ToolConfigManager } from './services/tool/ToolConfigManager';
import { PlannerService, ActionPlan } from './services/PlannerService';
import { ActionLauncherService } from './action-launcher.service';
import { RunManager } from './services/tool/RunManager';
import { StreamChunk } from './services/stream/types';
import { ExecuteActionPayload } from './types/actionlaunchertypes';

// --- Types ---
import { Run, ToolExecutionStep, ToolCall } from './services/tool/run.types';
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
        const chunk = text.substring(i, Math.min(i + 10, text.length));
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

            const state = await sessionState.getItem(sessionId) as SessionState;
            if (!state) { throw new Error('Not authenticated'); }
            const { userId } = state;

            if (data.type === 'execute_action' && data.content) {
                const actionPayload = data.content as ExecuteActionPayload;
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

                let toolIndex = currentRun.toolExecutionPlan.findIndex((step: ToolExecutionStep) => step.toolCall.id === completedAction.id);

                if (toolIndex === -1) {
                    const newStep: ToolExecutionStep = {
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
                
                const allDone = currentRun.toolExecutionPlan.every((step: ToolExecutionStep) => step.status === 'completed' || step.status === 'failed');
                if (allDone) {
                    currentRun.status = 'completed';
                    (currentRun as any).completedAt = new Date().toISOString();
                }

                state.activeRun = currentRun;
                await sessionState.setItem(sessionId, state);
                streamManager.sendChunk(sessionId, { type: 'run_updated', content: currentRun });
                
                if (completedAction.status === 'completed') {
                    logger.info('Action completed, generating follow-up message.', { sessionId });
                    try {
                        const followUpResult = await followUpService.generateFollowUp(currentRun, sessionId, uuidv4());
                        const followUpText = followUpResult.summary;
                        if (followUpText && followUpText.trim().length > 0) {
                            await streamText(sessionId, uuidv4(), followUpText);
                        }
                    } catch (error: any) {
                        logger.error('Failed to generate follow-up message.', { error: error.message, sessionId });
                    }
                }

                } else if (data.type === 'update_active_connection' && data.content) {
                const { connectionId } = data.content;
                if (!userId || !connectionId) {
                    logger.warn('Received update_active_connection but missing userId or connectionId');
                    return;
                }
                
                // This is the key step: save the new connectionId to Redis for the user
                await redis.set(`active-connection:${userId}`, connectionId);
                logger.info(`Successfully set active Nango connection for user via client message`, { userId });

                // Optionally send a confirmation back to the client
                ws.send(JSON.stringify({ type: 'connection_updated_ack' }));

            // This is your existing 'content' handler
            } else if (data.type === 'content' && typeof data.content === 'string') 

            



 {
                const messageId = uuidv4();
                const processedResult = await conversationService.processMessageAndAggregateResults(data.content, sessionId, messageId, userId);
                const { aggregatedToolCalls, conversationalResponse } = processedResult;

                if (conversationalResponse && conversationalResponse.trim().length > 0) {
                    await streamText(sessionId, messageId, conversationalResponse);
                }

                const isPlanRequest = aggregatedToolCalls.some(tool => tool.name === 'planParallelActions');
                const executableToolCount = aggregatedToolCalls.filter(t => t.name !== 'planParallelActions').length;

                if (isPlanRequest || executableToolCount > 1) {
                    const run = RunManager.createRun({
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
                        function: undefined,
                    }];
                    const run = RunManager.createRun({
                        sessionId, userId, userInput: data.content,
                        toolExecutionPlan: []
                    });
                    state.activeRun = run;
                    
                    await sessionState.setItem(sessionId, state);
                    streamManager.sendChunk(sessionId, { type: 'run_updated', content: run });
                    await actionLauncherService.processActionPlan(singleStepPlan, sessionId, userId, messageId, run);
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