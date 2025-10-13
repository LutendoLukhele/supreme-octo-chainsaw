// src/index.ts (Definitive, Final, Corrected Version with Connection Warming and Enhanced Planning)

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
import { PlannerService, ActionPlan, ActionStep } from './services/PlannerService';import { ActionLauncherService } from './action-launcher.service';
import { RunManager } from './services/tool/RunManager';
import { StreamChunk } from './services/stream/types';
import { ExecuteActionPayload } from './types/actionlaunchertypes';

// --- Types ---
import { Run, ToolExecutionStep, ToolCall } from './services/tool/run.types';
import { BeatEngine } from './BeatEngine';

import { DataDependencyService } from './services/data/DataDependencyService';
import { Resolver } from './services/data/Resolver';

import { PlanExecutorService } from './services/PlanExecutorService';

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
const dataDependencyService = new DataDependencyService();
const resolver = new Resolver(dataDependencyService);
const toolOrchestrator = new ToolOrchestrator({ logger, nangoService, toolConfigManager, dataDependencyService, resolver });
const plannerService = new PlannerService(CONFIG.OPEN_AI_API_KEY, CONFIG.MAX_TOKENS, toolConfigManager);
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

const planExecutorService = new PlanExecutorService(actionLauncherService, toolOrchestrator, streamManager);

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

// Connect PlannerService to StreamManager
plannerService.on('send_chunk', (sessionId: string, chunk: StreamChunk) => {
    streamManager.sendChunk(sessionId, chunk);
});

wss.on('connection', (ws: WebSocket) => {
    const sessionId = uuidv4();
    streamManager.addConnection(sessionId, ws);
    logger.info('Client connected', { sessionId });

    ws.on('message', async (message: string) => {
    try {
        const data = JSON.parse(message);

        // --- INIT / AUTH ---
        if (data.type === 'init') {
            const decodedToken = await firebaseAdminAuth.verifyIdToken(data.idToken);
            const userId = decodedToken.uid;
            await sessionState.setItem(sessionId, { userId });
            ws.send(JSON.stringify({ type: 'auth_success' }));
            logger.info('Client authenticated', { userId, sessionId });

            // Warm connections
            try {
                const activeConnectionId = await redis.get(`active-connection:${userId}`);
                if (activeConnectionId) {
                    logger.info('Warming connection post-auth', { userId, connectionId: '***' });
                    await nangoService.warmConnection('gmail', activeConnectionId);
                }
            } catch (warmError: any) {
                logger.warn('Post-auth connection warming failed', { userId, error: warmError.message });
            }
            return;
        }

        // --- GET SESSION STATE ---
        const state = (await sessionState.getItem(sessionId)) as SessionState;
        if (!state) throw new Error('Not authenticated');
        const { userId } = state;

        // --- EXECUTE ACTION (CONFIRMED BY CLIENT) ---
        if (data.type === 'execute_action' && data.content) {
            const actionPayload = data.content as ExecuteActionPayload;
            const currentRun = state.activeRun;
            if (!currentRun) {
                logger.error('Cannot execute action without an active run.', { sessionId });
                streamManager.sendChunk(sessionId, { type: 'error', content: 'No active run found to execute action.' });
                return;
            }

            const actionId = actionPayload.actionId;
            const step = currentRun.toolExecutionPlan.find(s => s.toolCall.id === actionId);
            if (!step) {
                logger.error('Could not find matching step in run for action', { sessionId, actionId });
                streamManager.sendChunk(sessionId, { type: 'error', content: 'Internal error: Could not match action to run step.' });
                return;
            }

            streamManager.sendChunk(sessionId, {
                type: 'action_status',
                content: { actionId, status: 'starting', message: `Starting ${actionPayload.toolName}...` },
                messageId: actionId,
            });

            const completedAction = await actionLauncherService.executeAction(sessionId, userId, actionPayload, toolOrchestrator, currentRun.planId, step.stepId);

            // Update toolExecutionPlan
            if (!currentRun.toolExecutionPlan) currentRun.toolExecutionPlan = [];
            let toolIndex = currentRun.toolExecutionPlan.findIndex(step =>
                step.toolCall.id === completedAction.id ||
                (step.toolCall.name === completedAction.toolName && step.status === 'pending')
            );

            if (toolIndex === -1) {
                const newStep: ToolExecutionStep = {
                    toolCall: {
                        id: completedAction.id || uuidv4(),
                        name: completedAction.toolName,
                        arguments: completedAction.arguments || {},
                        sessionId,
                        userId,
                    },
                    status: 'pending',
                    startedAt: new Date().toISOString(),
                };
                currentRun.toolExecutionPlan.push(newStep);
                toolIndex = currentRun.toolExecutionPlan.length - 1;
            }

            currentRun.toolExecutionPlan[toolIndex].status = completedAction.status;
            currentRun.toolExecutionPlan[toolIndex].result = {
                status: completedAction.status === 'completed' ? 'success' : 'failed',
                toolName: completedAction.toolName,
                data: { records: completedAction.result },
                error: completedAction.error,
            };
            currentRun.toolExecutionPlan[toolIndex].finishedAt = new Date().toISOString();

            const allDone = currentRun.toolExecutionPlan.every(step => step.status === 'completed' || step.status === 'failed');
            if (allDone) {
                currentRun.status = 'completed';
                (currentRun as any).completedAt = new Date().toISOString();
            }

            state.activeRun = currentRun;
            await sessionState.setItem(sessionId, state);
            streamManager.sendChunk(sessionId, { type: 'run_updated', content: currentRun });

            // Follow-up message
            if (completedAction.status === 'completed') {
                try {
                    const followUpResult = await followUpService.generateFollowUp(currentRun, sessionId, uuidv4());
                    const followUpText = followUpResult.summary;
                    if (followUpText?.trim()) await streamText(sessionId, uuidv4(), followUpText);
                } catch (error: any) {
                    logger.error('Failed to generate follow-up message.', { error: error.message, sessionId });
                }
            }
            return;
        }

        // --- UPDATE ACTIVE CONNECTION ---
        if (data.type === 'update_active_connection' && data.content) {
            const { connectionId } = data.content;
            if (!userId || !connectionId) return;

            await redis.set(`active-connection:${userId}`, connectionId);
            logger.info(`Successfully set active Nango connection for user`, { userId });

            try {
                const warmSuccess = await nangoService.warmConnection('gmail', connectionId);
                ws.send(JSON.stringify({ type: 'connection_updated_ack', content: { warmed: warmSuccess } }));
            } catch (error: any) {
                logger.error('Connection warming on update failed', { userId, connectionId: '***', error: error.message });
                ws.send(JSON.stringify({ type: 'connection_updated_ack', content: { warmed: false } }));
            }
            return;
        }

        // --- CONTENT HANDLER / PLAN GENERATION ---
        if (data.type === 'content' && typeof data.content === 'string') {
            const messageId = uuidv4();
            logger.info('Processing user message', { sessionId, userId, messageId });

            const processedResult = await conversationService.processMessageAndAggregateResults(
                data.content,
                sessionId,
                messageId,
                userId
            );

            const { aggregatedToolCalls, conversationalResponse } = processedResult;

            // Stream any conversational response
            if (conversationalResponse?.trim()) {
                await streamText(sessionId, messageId, conversationalResponse);
            }

            const isPlanRequest = aggregatedToolCalls.some(tool => tool.name === 'planParallelActions');
            const executableToolCount = aggregatedToolCalls.filter(t => t.name !== 'planParallelActions').length;

// Replace the entire plan generation section in index.ts (around lines 230-300)
// with this complete, working version:

if (isPlanRequest || executableToolCount > 1) {
    // --- CREATE RUN ---
    const run = RunManager.createRun({ 
        sessionId, 
        userId, 
        userInput: data.content, 
        toolExecutionPlan: [] 
    });
    state.activeRun = run;
    await sessionState.setItem(sessionId, state);
    streamManager.sendChunk(sessionId, { type: 'run_updated', content: run });

    const toolsForPlanning = aggregatedToolCalls.filter(t => t.name !== 'planParallelActions');

    // --- GENERATE PLAN ---
    const actionPlan: ActionPlan = await plannerService.generatePlanWithStepAnnouncements(
        data.content,
        toolsForPlanning,
        sessionId,
        messageId
    );

    if (actionPlan && actionPlan.length > 0) {
        
        // 🔥 CRITICAL FIX: Store actions in ActionLauncherService BEFORE sending to client
        logger.info('Storing action plan in ActionLauncherService', {
            sessionId,
            planLength: actionPlan.length,
            actionIds: actionPlan.map(s => s.id)
        });
        
        await actionLauncherService.processActionPlan(
            actionPlan,
            sessionId,
            userId,
            messageId,
            run
        );
        
        logger.info('Action plan stored successfully', { sessionId });

        // Auto-execution logic
        const actions = actionLauncherService.getActiveActions(sessionId);
        const needsUserInput = actions.some(a => a.status === 'collecting_parameters');

        if (!needsUserInput && actions.length > 0) {
            logger.info('No user input needed, starting auto-execution.', { sessionId, runId: run.id });
            // This is non-blocking
            planExecutorService.executePlan(run, userId);
        } else {
            logger.info('Plan requires user input before execution.', { sessionId });
        }

        // ✨ ENRICH each step - FLUTTER-COMPATIBLE FORMAT
        const enrichedPlan = actionPlan.map((step: ActionStep) => {
            const toolDef: any = toolConfigManager.getToolDefinition(step.tool);
            
            // Extract display name
            const toolDisplayName = toolDef?.display_name || 
                                   toolDef?.displayName || 
                                   toolDef?.name || 
                                   step.tool.replace(/_/g, ' ')
                                        .split(' ')
                                        .map((word: string) => word.charAt(0).toUpperCase() + word.slice(1))
                                        .join(' ');
            
            // Build parameters as an array matching Flutter's ToolParameter model
            const parameters: any[] = [];
            if (toolDef?.parameters?.properties) {
                const props = toolDef.parameters.properties;
                const required = toolDef.parameters.required || [];
                
                Object.keys(props).forEach((paramName) => {
                    const prop = props[paramName];
                    parameters.push({
                        name: paramName,
                        type: Array.isArray(prop.type) ? prop.type[0] : (prop.type || 'string'),
                        description: prop.description || '',
                        required: required.includes(paramName),
                        hint: prop.hint || prop.prompt || null,
                        enumValues: prop.enum || null,
                        currentValue: step.arguments?.[paramName] || null
                    });
                });
            }
            
            // CRITICAL: Match Flutter's ActiveAction field names exactly
            return {
                id: step.id,
                messageId: messageId,
                toolName: step.tool,
                toolDisplayName,
                description: step.intent,
                status: step.status,
                arguments: step.arguments || {},
                parameters,
                missingParameters: [],
                error: null,
                result: null
            };
        });

        // Log for debugging
        logger.info('Sending enriched plan to Flutter client', {
            sessionId,
            planCount: enrichedPlan.length,
            sampleStep: JSON.stringify(enrichedPlan[0], null, 2)
        });

        // --- SEND plan_generated MESSAGE ---
        streamManager.sendChunk(sessionId, {
            type: 'plan_generated',
            content: {
                messageId,
                planOverview: enrichedPlan,
                analysis: `Plan generated successfully with ${enrichedPlan.length} actions.`
            },
            messageId,
            isFinal: true,
        } as StreamChunk);

        // Save to activeRun for later execution
        run.toolExecutionPlan = actionPlan.map((step: ActionStep) => ({
            toolCall: {
                id: step.id,
                name: step.tool,
                arguments: step.arguments,
                sessionId,
                userId,
            },
            status: 'pending',
            startedAt: new Date().toISOString(),
        }));

        await sessionState.setItem(sessionId, state);

    } else if (!conversationalResponse) {
        await streamText(sessionId, messageId, "I was unable to formulate a plan for your request.");
    }
}


            return;
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