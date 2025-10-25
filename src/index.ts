// src/index.ts (Definitive, Final, Corrected Version with Connection Warming and Enhanced Planning)

import express from 'express';
import dotenv from 'dotenv';
dotenv.config();
import Redis from 'ioredis';
import cors from 'cors';

import { createServer, IncomingMessage } from 'http';
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
import { PlannerService, ActionPlan, ActionStep } from './services/PlannerService';
import { ActionLauncherService } from './action-launcher.service';
import { RunManager } from './services/tool/RunManager';
import { StreamChunk } from './services/stream/types';
import { ExecuteActionPayload } from './types/actionlaunchertypes';

// --- Types ---
import { Run, ToolExecutionStep, ToolCall } from './services/tool/run.types';
import { BeatEngine } from './BeatEngine';

import { DataDependencyService } from './services/data/DataDependencyService';
import { Resolver } from './services/data/Resolver';

import { PlanExecutorService } from './services/PlanExecutorService';
// Import interpretive search services for WS support
import { routerService } from './services/router.service';
import { promptGeneratorService } from './services/prompt-generator.service';
import { groqService } from './services/groq.service';
import { responseParserService } from './services/response-parser.service';
import { documentService } from './services/document.service';
import { artifactGeneratorService } from './services/artifact-generator.service';
import artifactsRouter from './routes/artifacts';
import documentsRouter from './routes/documents';
import exportRouter from './routes/export';
import interpretRouter from './routes/interpret';
import sessionsRouter from './routes/sessions';

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
const toolOrchestrator = new ToolOrchestrator({ logger, nangoService, toolConfigManager, dataDependencyService, resolver, redisClient: redis });
const plannerService = new PlannerService(CONFIG.GROQ_API_KEY, CONFIG.MAX_TOKENS, toolConfigManager);
const beatEngine = new BeatEngine(toolConfigManager);
const followUpService = new FollowUpService(groqClient, CONFIG.MODEL_NAME, 150);

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

const planExecutorService = new PlanExecutorService(actionLauncherService, toolOrchestrator, streamManager, toolConfigManager, groqClient);

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

// --- Middleware Setup ---
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// --- API Routes ---
app.use('/api/artifacts', artifactsRouter);
app.use('/api/documents', documentsRouter);
app.use('/api/export', exportRouter);
app.use('/api/interpret', interpretRouter);
app.use('/api/sessions', sessionsRouter);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

const server = createServer(app);
const wss = new WebSocketServer({ server });

actionLauncherService.on('send_chunk', (sessionId: string, chunk: StreamChunk) => {
    streamManager.sendChunk(sessionId, chunk);
});

// Connect PlannerService to StreamManager
plannerService.on('send_chunk', (sessionId: string, chunk: StreamChunk) => {
    streamManager.sendChunk(sessionId, chunk);
});

wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const sessionId = req.url?.slice(1) || uuidv4();
    streamManager.addConnection(sessionId, ws);
    logger.info('Client connected', { sessionId });

    ws.on('message', async (message: string) => {
    try {
        const data = JSON.parse(message);

        // --- INIT / AUTH ---
        if (data.type === 'init') {
    let userId: string;
    if (data.idToken) {
        const decodedToken = await firebaseAdminAuth.verifyIdToken(data.idToken);
        userId = decodedToken.uid;
        await sessionState.setItem(sessionId, { userId });
        ws.send(JSON.stringify({ type: 'auth_success' })); // ✅ Direct send
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
    } else {
        // Handle unauthenticated session for development/testing
        userId = `unauthenticated-user-${uuidv4()}`;
        await sessionState.setItem(sessionId, { userId });
        ws.send(JSON.stringify({ type: 'auth_success', content: { userId } })); // ✅ Direct send
        logger.info('Unauthenticated session created', { userId, sessionId });
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
                    stepId: `step_${uuidv4()}`,
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
                currentRun.completedAt = new Date().toISOString();
            }

            state.activeRun = currentRun;
            await sessionState.setItem(sessionId, state);
            streamManager.sendChunk(sessionId, { type: 'run_updated', content: currentRun });

            // --- NEW CONTEXT-AWARE FOLLOW-UP LOGIC ---
            // Instead of a separate follow-up service, we now feed the tool result back into the main conversation
            // to generate a more contextually aware response.
            if (completedAction.status === 'completed' && currentRun.toolExecutionPlan.every(s => s.status === 'completed' || s.status === 'failed')) {
                 logger.info('All actions complete, generating final context-aware response.', { sessionId });
                 
                 // 1. Add the tool results to the conversation history.
                 const lastStep = currentRun.toolExecutionPlan.find(s => s.toolCall.id === completedAction.id);
                 if (lastStep && lastStep.result) {
                     conversationService.addToolResultMessageToHistory(
                         sessionId,
                         lastStep.toolCall.id,
                         lastStep.toolCall.name,
                         lastStep.result.data
                     );
                 }

                 // 2. Call the conversation service again, but with no new user message.
                 // This prompts the LLM to generate a response based on the tool results it now sees in the history.
                 const finalResponseResult = await conversationService.processMessageAndAggregateResults(
                     null, // No new user message
                     sessionId,
                     uuidv4()
                 );

                 // 3. Stream the final, summary response.
                 if (finalResponseResult.conversationalResponse?.trim()) {
                     await streamText(sessionId, uuidv4(), finalResponseResult.conversationalResponse);
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
                streamManager.sendChunk(sessionId, { type: 'connection_updated_ack', content: { warmed: warmSuccess } });
            } catch (error: any) {
                logger.error('Connection warming on update failed', { userId, connectionId: '***', error: error.message });
                streamManager.sendChunk(sessionId, { type: 'connection_updated_ack', content: { warmed: false } });
            }
            return;
        }

        // --- RERUN SAVED PLAN ---
        if (data.type === 'rerun_plan' && data.content && data.content.plan) {
            const savedPlan = data.content.plan as any[];
            const messageId = uuidv4();
            logger.info('Rerunning saved plan', { sessionId, userId, messageId, planSize: savedPlan.length });

            // 1. Clear old actions to ensure a clean state
            actionLauncherService.clearActions(sessionId);

            // 2. Create a new Run for this execution
            const run = RunManager.createRun({
                sessionId,
                userId,
                userInput: `Rerun of a saved plan with ${savedPlan.length} steps.`,
                toolExecutionPlan: []
            });
            state.activeRun = run;
            await sessionState.setItem(sessionId, state);
            streamManager.sendChunk(sessionId, { type: 'run_updated', content: run });

            // 3. Create a new ActionPlan with fresh IDs from the saved plan
            const newActionPlan: ActionPlan = savedPlan.map(step => ({
                id: uuidv4(), // Generate a new, unique ID for the new execution step
                tool: step.toolName,
                intent: step.description,
                arguments: step.arguments || {},
                status: 'ready', // Corrected status
            }));

            // 4. Send the regenerated (and enriched) plan back to the client so it can update its UI
            const enrichedPlan = newActionPlan.map((step: ActionStep) => {
                const toolDef: any = toolConfigManager.getToolDefinition(step.tool);
                const toolDisplayName = toolDef?.display_name || toolDef?.displayName || toolDef?.name || step.tool.replace(/_/g, ' ').split(' ').map((word: string) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
                
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
                
                return {
                    id: step.id,
                    messageId: messageId,
                    toolName: step.tool,
                    toolDisplayName,
                    description: step.intent,
                status: step.status, // CRITICAL FIX: Use the actual status from the plan
                    arguments: step.arguments || {},
                    parameters,
                    missingParameters: [],
                    error: null,
                    result: null
                };
            });

            streamManager.sendChunk(sessionId, {
                type: 'plan_generated',
                content: {
                    messageId,
                    planOverview: enrichedPlan,
                    analysis: `Rerunning saved plan with ${enrichedPlan.length} actions.`
                },
                messageId,
                isFinal: true,
            } as StreamChunk);

            // 5. Process the new action plan to store it and determine next steps
            await actionLauncherService.processActionPlan(
                newActionPlan,
                sessionId,
                userId,
                messageId,
                toolOrchestrator,
                run
            );

            // 6. Update the active run with the full tool execution plan
            run.toolExecutionPlan = newActionPlan.map((step: ActionStep) => ({
                stepId: step.id,
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

            // 7. Check if the plan can be auto-executed
            const actions = actionLauncherService.getActiveActions(sessionId);
            const needsUserInput = actions.some(a => a.status === 'collecting_parameters');

            if (!needsUserInput && actions.length > 0) {
                logger.info('No user input needed for rerun, starting auto-execution.', { sessionId, runId: run.id });
                await planExecutorService.executePlan(run, userId);
                // After auto-execution, generate a final summary response.
                if (run.status === 'completed') {
                    logger.info('Rerun plan auto-execution complete, generating final response.', { sessionId });

                    // Add all tool results to history
                    run.toolExecutionPlan.forEach(step => {
                        if (step.status === 'completed' && step.result) {
                            conversationService.addToolResultMessageToHistory(sessionId, step.toolCall.id, step.toolCall.name, step.result.data);
                        }
                    });

                    // Get the final summary from the LLM
                    const finalResponseResult = await conversationService.processMessageAndAggregateResults(
                        null, // No new user message
                        sessionId,
                        uuidv4()
                    );

                    if (finalResponseResult.conversationalResponse?.trim()) {
                        await streamText(sessionId, uuidv4(), finalResponseResult.conversationalResponse);
                    }
                }
            } else {
                logger.info('Rerun plan requires user input before execution.', { sessionId });
            }

            return;
        }

        // --- CONTENT HANDLER / PLAN GENERATION ---
        if (data.type === 'content' && typeof data.content === 'string') {
            const messageId = uuidv4();
            logger.info('Processing user message', { sessionId, userId, messageId });

            const processedResult = await conversationService.processMessageAndAggregateResults(
                data.content,
                sessionId, // Corrected: Pass only required args
                messageId
            );

            const { aggregatedToolCalls, conversationalResponse } = processedResult;

            // Stream any conversational response
            if (conversationalResponse?.trim()) {
                await streamText(sessionId, messageId, conversationalResponse);
            }

            const isPlanRequest = aggregatedToolCalls.some(tool => tool.name === 'planParallelActions');
            const executableToolCount = aggregatedToolCalls.filter(t => t.name !== 'planParallelActions').length;

            if (isPlanRequest || executableToolCount > 1) {
                // --- COMPLEX FLOW: Use Planner for multiple steps or explicit plan requests ---
                logger.info(`Complex request identified. Routing to PlannerService.`, { sessionId, isPlanRequest, executableToolCount });
                
                const run = RunManager.createRun({ sessionId, userId, userInput: data.content, toolExecutionPlan: [] });
                state.activeRun = run;
                await sessionState.setItem(sessionId, state);
                streamManager.sendChunk(sessionId, { type: 'run_updated', content: run });

                const toolsForPlanning = aggregatedToolCalls.filter(t => t.name !== 'planParallelActions');
                const actionPlan: ActionPlan = await plannerService.generatePlanWithStepAnnouncements(data.content, toolsForPlanning, sessionId, messageId);

                if (actionPlan && actionPlan.length > 0) {
                    await actionLauncherService.processActionPlan(actionPlan, sessionId, userId, messageId, toolOrchestrator, run);
                    
                    const actions = actionLauncherService.getActiveActions(sessionId);
                    const needsUserInput = actions.some(a => a.status === 'collecting_parameters');

                    if (!needsUserInput && actions.length > 0) {
                        logger.info('No user input needed for plan, starting auto-execution.', { sessionId, runId: run.id });
                        await planExecutorService.executePlan(run, userId);
                        
                        // After auto-execution, generate a final summary response.
                        if (run.status === 'completed') {
                            logger.info('Plan auto-execution complete, generating final response.', { sessionId });
                            
                            // Add all tool results to history
                            run.toolExecutionPlan.forEach(step => {
                                if (step.status === 'completed' && step.result) {
                                    conversationService.addToolResultMessageToHistory(sessionId, step.toolCall.id, step.toolCall.name, step.result.data);
                                }
                            });

                            // Get the final summary from the LLM
                            const finalResponseResult = await conversationService.processMessageAndAggregateResults(
                                null, // No new user message
                                sessionId,
                                uuidv4()
                            );

                            if (finalResponseResult.conversationalResponse?.trim()) {
                                await streamText(sessionId, uuidv4(), finalResponseResult.conversationalResponse);
                            }
                        }

                    } else {
                        logger.info('Plan requires user input before execution.', { sessionId });
                    }

                    const enrichedPlan = actionPlan.map((step: ActionStep) => {
                        const toolDef: any = toolConfigManager.getToolDefinition(step.tool);
                        const toolDisplayName = toolDef?.display_name || toolDef?.name || step.tool;
                        const parameters: any[] = [];
                        if (toolDef?.parameters?.properties) {
                            const props = toolDef.parameters.properties;
                            const required = toolDef.parameters.required || [];
                            Object.keys(props).forEach((paramName) => {
                                const prop = props[paramName];
                                parameters.push({
                                    name: paramName, type: prop.type || 'string', description: prop.description || '',
                                    required: required.includes(paramName), hint: prop.hint || null,
                                    enumValues: prop.enum || null, currentValue: step.arguments?.[paramName] || null
                                });
                            });
                        }
                        return {
                            id: step.id, messageId, toolName: step.tool, toolDisplayName,
                            description: step.intent, status: step.status, arguments: step.arguments || {},
                            parameters, missingParameters: [], error: null, result: null
                        };
                    });

                    streamManager.sendChunk(sessionId, {
                        type: 'plan_generated',
                        content: { messageId, planOverview: enrichedPlan, analysis: `Plan generated with ${enrichedPlan.length} actions.` },
                        messageId, isFinal: true,
                    } as StreamChunk);

                    run.toolExecutionPlan = actionPlan.map((step: ActionStep) => ({
                        stepId: step.id,
                        toolCall: { id: step.id, name: step.tool, arguments: step.arguments, sessionId, userId },
                        status: 'pending', startedAt: new Date().toISOString(),
                    }));
                    await sessionState.setItem(sessionId, state);

                } else if (!conversationalResponse) {
                    await streamText(sessionId, messageId, "I was unable to formulate a plan for your request.");
                }

            } else if (executableToolCount === 1) {
                // --- SIMPLE FLOW: Bypass Planner for a single, direct action ---
                const singleToolCall = aggregatedToolCalls.find(t => t.name !== 'planParallelActions')!;
                logger.info(`Single tool call '${singleToolCall.name}' identified. Bypassing planner.`, { sessionId });

                const run = RunManager.createRun({ sessionId, userId, userInput: data.content, toolExecutionPlan: [] });
                state.activeRun = run;
                await sessionState.setItem(sessionId, state);
                streamManager.sendChunk(sessionId, { type: 'run_updated', content: run });

                // Create a single-step plan manually
                const singleStepPlan: ActionPlan = [{
                    id: singleToolCall.id || uuidv4(),
                    intent: `Execute the ${singleToolCall.name} tool.`,
                    tool: singleToolCall.name,
                    arguments: singleToolCall.arguments,
                    status: 'ready', // Assume ready, ActionLauncher will verify
                }];

                // Announce the single action to the user for better feedback
                await plannerService.streamSingleActionAnnouncement(singleStepPlan[0], sessionId);

                // CRITICAL FIX: Populate the run object's plan *before* execution.
                run.toolExecutionPlan = singleStepPlan.map((step: ActionStep) => ({
                    stepId: step.id,
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

                // Process this mini-plan
                await actionLauncherService.processActionPlan(singleStepPlan, sessionId, userId, messageId, toolOrchestrator, run);

                const actions = actionLauncherService.getActiveActions(sessionId);
                const needsUserInput = actions.some(a => a.status === 'collecting_parameters');

                // Enrich the plan for client UI, regardless of whether input is needed
                const enrichedPlan = singleStepPlan.map((step: ActionStep) => {
                    const toolDef: any = toolConfigManager.getToolDefinition(step.tool);
                    const toolDisplayName = toolDef?.display_name || toolDef?.name || step.tool;
                    const parameters: any[] = [];
                    if (toolDef?.parameters?.properties) {
                        const props = toolDef.parameters.properties;
                        const required = toolDef.parameters.required || [];
                        Object.keys(props).forEach((paramName) => {
                            const prop = props[paramName];
                            parameters.push({
                                name: paramName, type: prop.type || 'string', description: prop.description || '',
                                required: required.includes(paramName), hint: prop.hint || null,
                                enumValues: prop.enum || null, currentValue: step.arguments?.[paramName] || null
                            });
                        });
                    }
                    // If there are active actions, use their state for enrichment
                    const activeAction = actions.find(a => a.id === step.id);
                    return {
                        id: step.id, messageId, toolName: step.tool, toolDisplayName,
                        description: activeAction?.description || step.intent, 
                        status: activeAction?.status || step.status, 
                        arguments: activeAction?.arguments || step.arguments || {},
                        parameters: activeAction?.parameters || parameters, 
                        missingParameters: activeAction?.missingParameters || [], 
                        error: null, 
                        result: null
                    };
                });

                // Send the simulated plan to the client
                streamManager.sendChunk(sessionId, {
                    type: 'plan_generated',
                    content: { messageId, planOverview: enrichedPlan, analysis: `Preparing to execute action.` },
                    messageId, isFinal: true,
                } as StreamChunk);


                if (!needsUserInput && actions.length > 0) {
                    logger.info('No user input needed for single action, starting auto-execution.', { sessionId, runId: run.id });
                    await planExecutorService.executePlan(run, userId);
                } else if (actions.length > 0) {
                    logger.info('Single action requires user input before execution.', { sessionId });
                    // The 'parameter_collection_required' event is fired by ActionLauncherService,
                    // and we have already sent the plan_generated event above.
                }

            } else if (!conversationalResponse) {
                // Fallback if no tools were identified and no conversational response was generated
                await streamText(sessionId, messageId, "I'm not sure how to help with that. Could you rephrase?");
            }

            // --- UNIFIED FINAL RESPONSE LOGIC ---
            // This block runs after any auto-execution (single or multi-step) is complete.
            const finalRunState = (await sessionState.getItem(sessionId) as SessionState)?.activeRun;
            if (finalRunState && finalRunState.status === 'completed' && !finalRunState.assistantResponse) {
                logger.info('Auto-execution complete, generating final context-aware response.', { sessionId, runId: finalRunState.id });

                // Add all completed tool results to history if not already there
                finalRunState.toolExecutionPlan.forEach(step => {
                    if (step.status === 'completed' && step.result) {
                        conversationService.addToolResultMessageToHistory(sessionId, step.toolCall.id, step.toolCall.name, step.result.data);
                    }
                });

                // Get the final summary from the LLM
                const finalResponseResult = await conversationService.processMessageAndAggregateResults(
                    null, // No new user message, forces summary mode
                    sessionId,
                    uuidv4()
                );

                if (finalResponseResult.conversationalResponse?.trim()) {
                    await streamText(sessionId, uuidv4(), finalResponseResult.conversationalResponse);
                    finalRunState.assistantResponse = finalResponseResult.conversationalResponse; // Mark that response was generated
                    await sessionState.setItem(sessionId, { userId, activeRun: finalRunState });
                }
            }

            return;
        }

        // --- INTERPRETIVE SEARCH OVER WS (legacy) ---
        if (data.type === 'interpret') {
            const { query, sessionId: incomingSessionId, documentIds, enableArtifacts, searchSettings } = data.content || {};
            const wsMessageId = uuidv4();
            const sessionIdForWS = incomingSessionId || uuidv4();

            streamManager.sendChunk(sessionIdForWS, { type: 'interpret_started', messageId: wsMessageId });

            try {
                const sessionCtx = incomingSessionId ? await sessionState.getItem(incomingSessionId) : null;
                let documentContext = [] as any[];
                if (Array.isArray(documentIds) && documentIds.length > 0) {
                    documentContext = await documentService.getDocuments(documentIds);
                }

                const { mode, entities } = await routerService.detectIntent(query);
                const groqPrompt = promptGeneratorService.generatePrompt(mode, query, entities, {
                    sessionContext: null as any,
                    documentContext,
                    enableArtifacts,
                });

                const groqResponse = await groqService.executeSearch(groqPrompt, { searchSettings });
                const interpretiveResponse = responseParserService.parseGroqResponse(groqResponse.content, mode, groqResponse);

                // Stream hero first
                streamManager.sendChunk(sessionIdForWS, { type: 'interpret_segment', messageId: wsMessageId, content: { kind: 'hero', data: interpretiveResponse.hero } });
                // Stream segments
                for (const seg of interpretiveResponse.segments) {
                    streamManager.sendChunk(sessionIdForWS, { type: 'interpret_segment', messageId: wsMessageId, content: { kind: 'segment', data: seg } });
                }
                // Stream sources
                streamManager.sendChunk(sessionIdForWS, { type: 'interpret_segment', messageId: wsMessageId, content: { kind: 'sources', data: interpretiveResponse.sources } });

                // Optionally attach artifact
                if (enableArtifacts) {
                    const should = ((): boolean => {
                        const q = String(query || '').toLowerCase();
                        return ['generate', 'script', 'analyze', 'visualize', 'plot', 'chart', 'calculate'].some(k => q.includes(k));
                    })();
                    if (should) {
                        const artifact = await artifactGeneratorService.generateCodeArtifact({
                            prompt: query,
                            language: 'python',
                            context: interpretiveResponse,
                        });
                        (interpretiveResponse as any).artifact = artifact;
                        streamManager.sendChunk(sessionIdForWS, { type: 'interpret_segment', messageId: wsMessageId, content: { kind: 'artifact', data: artifact } });
                    }
                }

                streamManager.sendChunk(sessionIdForWS, { type: 'interpret_complete', messageId: wsMessageId, content: interpretiveResponse, isFinal: true });
            } catch (err: any) {
                streamManager.sendChunk(sessionIdForWS, { type: 'error', messageId: wsMessageId, content: { code: 'INTERPRET_ERROR', message: err?.message || 'Unknown error' }, isFinal: true });
            }
            return;
        }

        // --- INTERPRETIVE STREAM (unified events over WS) ---
        if (data.type === 'interpret_stream' && data.content) {
            const { query, sessionId: incomingSessionId, documentIds, enableArtifacts, searchSettings } = data.content || {};
            if (!query || typeof query !== 'string') {
                streamManager.sendChunk(sessionId, { type: 'interpret_event', event: 'error', data: { message: 'Query is required' } });
                return;
            }

            const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
            const startTime = Date.now();

            const send = (event: string, dataObj: any) => {
                streamManager.sendChunk(sessionId, { type: 'interpret_event', event, data: dataObj });
            };

            try {
                send('start', { requestId, status: 'loading' });

                const sessionContext = null;
                const docCtx = Array.isArray(documentIds) && documentIds.length
                    ? await documentService.getDocuments(documentIds)
                    : [];
                const { mode, entities } = await routerService.detectIntent(query);
                const groqPrompt = promptGeneratorService.generatePrompt(mode, query, entities, {
                    sessionContext,
                    documentContext: docCtx,
                    enableArtifacts,
                });

                // Stream Groq tokens
                let combinedContent = '';
                let reasoning = '';
                let model = '';
                let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

                try {
                    const stream = groqService.executeSearchStream(groqPrompt, { searchSettings });
                    for await (const chunk of stream) {
                        if (chunk.model) model = chunk.model;
                        // Type guard for usage property
                        if ('usage' in chunk && chunk.usage) {
                            usage = { ...usage, ...chunk.usage };
                        }
                        const choice = chunk.choices?.[0];
                        const delta: any = choice?.delta ?? {};
                        if (typeof delta?.content === 'string' && delta.content.length) {
                            combinedContent += delta.content;
                            send('token', { chunk: delta.content });
                        }
                        if (typeof delta?.reasoning === 'string' && delta.reasoning.length) {
                            reasoning += delta.reasoning;
                            send('reasoning', { text: delta.reasoning });
                        }
                    }
                } catch (streamErr: any) {
                    // fall back to non-streaming call
                    const resp = await groqService.executeSearch(groqPrompt, { searchSettings });
                    combinedContent = resp.content;
                    model = resp.model;
                    usage = resp.usage as any;
                    reasoning = resp.reasoning || '';
                }

                // Parse with guard-rails
                let groqResponse = { content: combinedContent, model, usage, reasoning } as any;
                let interpretiveResponse;
                try {
                    interpretiveResponse = responseParserService.parseGroqResponse(combinedContent, mode, groqResponse);
                } catch (parseError: any) {
                    send('warning', { type: 'parse_error', message: parseError?.message || 'Failed to parse Groq JSON' });
                    interpretiveResponse = responseParserService.buildFallbackResponse(combinedContent, mode, groqResponse, parseError?.message || 'Failed to parse Groq JSON');
                }

                interpretiveResponse.metadata.processingTimeMs = Date.now() - startTime;

                // Enrichments (sequential to emit progress)
                const enrichmentDefs: {
                    key: 'cultural' | 'social' | 'visual';
                    searchSettings: { include_domains: string[] };
                }[] = [
                    {
                        key: 'cultural',
                        searchSettings: { include_domains: ['*.museum', '*.gallery', '*.art', 'cosmos.co', 'www.metmuseum.org'] }
                    },
                    {
                        key: 'social',
                        searchSettings: { include_domains: ['*.substack.com', 'www.reddit.com', 'www.threads.net', 'www.tumblr.com'] }
                    },
                    {
                        key: 'visual',
                        searchSettings: { include_domains: ['cosmos.co', '*.gallery', 'www.metmuseum.org', 'www.moma.org', 'www.wikiart.org'] }
                    },
                ];

                for (const def of enrichmentDefs) {
                    send('enrichment_start', { key: def.key });
                    try {
                        const enrichPrompt = promptGeneratorService.generateEnrichmentPrompt(def.key as any, query, entities);
                        const resp = await groqService.executeSearch(enrichPrompt, { searchSettings: def.searchSettings });
                        const parsed = responseParserService.parseEnrichmentResponse(resp.content);

                        // Merge sources
                        const localToGlobal = new Map<number, number>();
                        parsed.sources.forEach((s, idx) => {
                            const exIndex = interpretiveResponse.sources.findIndex((e: any) => e.url === s.url);
                            if (exIndex >= 0) {
                                localToGlobal.set(idx + 1, exIndex + 1);
                            } else {
                                interpretiveResponse.sources.push({ ...s, index: interpretiveResponse.sources.length + 1 });
                                localToGlobal.set(idx + 1, interpretiveResponse.sources.length);
                            }
                        });

                        // Merge segments and re-map indices
                        parsed.segments.forEach((seg) => {
                            if (seg.type === 'context' && Array.isArray((seg as any).sourceIndices)) {
                                (seg as any).sourceIndices = (seg as any).sourceIndices.map((i: number) => localToGlobal.get(i) ?? i);
                            }
                            if (seg.type === 'quote' && typeof (seg as any).sourceIndex === 'number') {
                                (seg as any).sourceIndex = localToGlobal.get((seg as any).sourceIndex) ?? (seg as any).sourceIndex;
                            }
                            interpretiveResponse.segments.push(seg);
                        });

                        send('enrichment_complete', { key: def.key, segmentsAdded: parsed.segments.length, sourcesAdded: parsed.sources.length });
                    } catch (enrichErr: any) {
                        send('enrichment_error', { key: def.key, message: enrichErr?.message || 'enrichment failed' });
                    }
                }

                // Finalize counts
                interpretiveResponse.sources = interpretiveResponse.sources
                    .filter((s: any, i: number, self: any[]) => self.findIndex((x) => x.url === s.url) === i)
                    .map((s: any, i: number) => ({ ...s, index: i + 1 }));
                interpretiveResponse.metadata.segmentCount = interpretiveResponse.segments.length;
                interpretiveResponse.metadata.sourceCount = interpretiveResponse.sources.length;

                // Optional artifact
                if (enableArtifacts) {
                    const lower = query.toLowerCase();
                    const should = ['write code', 'generate script', 'create function', 'analyze data', 'visualize', 'plot', 'chart', 'calculate']
                        .some(k => lower.includes(k));
                    if (should) {
                        const artifact = await artifactGeneratorService.generateCodeArtifact({
                            prompt: query,
                            language: 'python',
                            context: interpretiveResponse,
                        });
                        (interpretiveResponse as any).artifact = artifact;
                        send('artifact_generated', { hasArtifact: true });
                    }
                }

                send('complete', { requestId, status: 'complete', payload: interpretiveResponse });
            } catch (err: any) {
                send('error', { requestId, status: 'error', message: err?.message || 'Unknown error' });
            }
            return;
        }

        // --- INTERPRETIVE SEARCH OVER WS (legacy) ---
        if (data.type === 'interpret') {
            const { query, sessionId: incomingSessionId, documentIds, enableArtifacts, searchSettings } = data.content || {};
            const wsMessageId = uuidv4();
            const sessionIdForWS = incomingSessionId || uuidv4();

            streamManager.sendChunk(sessionIdForWS, { type: 'interpret_started', messageId: wsMessageId });

            try {
                const sessionCtx = incomingSessionId ? await sessionState.getItem(incomingSessionId) : null;
                let documentContext = [] as any[];
                if (Array.isArray(documentIds) && documentIds.length > 0) {
                    documentContext = await documentService.getDocuments(documentIds);
                }

                const { mode, entities } = await routerService.detectIntent(query);
                const groqPrompt = promptGeneratorService.generatePrompt(mode, query, entities, {
                    sessionContext: null as any,
                    documentContext,
                    enableArtifacts,
                });

                const groqResponse = await groqService.executeSearch(groqPrompt, { searchSettings });
                const interpretiveResponse = responseParserService.parseGroqResponse(groqResponse.content, mode, groqResponse);

                // Stream hero first
                streamManager.sendChunk(sessionIdForWS, { type: 'interpret_segment', messageId: wsMessageId, content: { kind: 'hero', data: interpretiveResponse.hero } });
                // Stream segments
                for (const seg of interpretiveResponse.segments) {
                    streamManager.sendChunk(sessionIdForWS, { type: 'interpret_segment', messageId: wsMessageId, content: { kind: 'segment', data: seg } });
                }
                // Stream sources
                streamManager.sendChunk(sessionIdForWS, { type: 'interpret_segment', messageId: wsMessageId, content: { kind: 'sources', data: interpretiveResponse.sources } });

                // Optionally attach artifact
                if (enableArtifacts) {
                    const should = ((): boolean => {
                        const q = String(query || '').toLowerCase();
                        return ['generate', 'script', 'analyze', 'visualize', 'plot', 'chart', 'calculate'].some(k => q.includes(k));
                    })();
                    if (should) {
                        const artifact = await artifactGeneratorService.generateCodeArtifact({
                            prompt: query,
                            language: 'python',
                            context: interpretiveResponse,
                        });
                        (interpretiveResponse as any).artifact = artifact;
                        streamManager.sendChunk(sessionIdForWS, { type: 'interpret_segment', messageId: wsMessageId, content: { kind: 'artifact', data: artifact } });
                    }
                }

                streamManager.sendChunk(sessionIdForWS, { type: 'interpret_complete', messageId: wsMessageId, content: interpretiveResponse, isFinal: true });
            } catch (err: any) {
                streamManager.sendChunk(sessionIdForWS, { type: 'error', messageId: wsMessageId, content: { code: 'INTERPRET_ERROR', message: err?.message || 'Unknown error' }, isFinal: true });
            }
            return;
        }

        // --- INTERPRETIVE STREAM (unified events over WS) ---
        if (data.type === 'interpret_stream' && data.content) {
            const { query, sessionId: incomingSessionId, documentIds, enableArtifacts, searchSettings } = data.content || {};
            if (!query || typeof query !== 'string') {
                streamManager.sendChunk(sessionId, { type: 'interpret_event', event: 'error', data: { message: 'Query is required' } });
                return;
            }

            const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
            const startTime = Date.now();

            const send = (event: string, dataObj: any) => {
                streamManager.sendChunk(sessionId, { type: 'interpret_event', event, data: dataObj });
            };

            try {
                send('start', { requestId, status: 'loading' });

                const sessionContext = null;
                const docCtx = Array.isArray(documentIds) && documentIds.length
                    ? await documentService.getDocuments(documentIds)
                    : [];
                const { mode, entities } = await routerService.detectIntent(query);
                const groqPrompt = promptGeneratorService.generatePrompt(mode, query, entities, {
                    sessionContext,
                    documentContext: docCtx,
                    enableArtifacts,
                });

                // Stream Groq tokens
                let combinedContent = '';
                let reasoning = '';
                let model = '';
                let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

                try {
                    const stream = groqService.executeSearchStream(groqPrompt, { searchSettings });
                    for await (const chunk of stream) {
                        if (chunk.model) model = chunk.model;
                        // Type guard for usage property
                        if ('usage' in chunk && chunk.usage) {
                            usage = { ...usage, ...chunk.usage };
                        }
                        const choice = chunk.choices?.[0];
                        const delta: any = choice?.delta ?? {};
                        if (typeof delta?.content === 'string' && delta.content.length) {
                            combinedContent += delta.content;
                            send('token', { chunk: delta.content });
                        }
                        if (typeof delta?.reasoning === 'string' && delta.reasoning.length) {
                            reasoning += delta.reasoning;
                            send('reasoning', { text: delta.reasoning });
                        }
                    }
                } catch (streamErr: any) {
                    // fall back to non-streaming call
                    const resp = await groqService.executeSearch(groqPrompt, { searchSettings });
                    combinedContent = resp.content;
                    model = resp.model;
                    usage = resp.usage as any;
                    reasoning = resp.reasoning || '';
                }

                // Parse with guard-rails
                let groqResponse = { content: combinedContent, model, usage, reasoning } as any;
                let interpretiveResponse;
                try {
                    interpretiveResponse = responseParserService.parseGroqResponse(combinedContent, mode, groqResponse);
                } catch (parseError: any) {
                    send('warning', { type: 'parse_error', message: parseError?.message || 'Failed to parse Groq JSON' });
                    interpretiveResponse = responseParserService.buildFallbackResponse(combinedContent, mode, groqResponse, parseError?.message || 'Failed to parse Groq JSON');
                }

                interpretiveResponse.metadata.processingTimeMs = Date.now() - startTime;

                // Enrichments (sequential to emit progress)
                const enrichmentDefs: {
                    key: 'cultural' | 'social' | 'visual';
                    searchSettings: { include_domains: string[] };
                }[] = [
                    {
                        key: 'cultural',
                        searchSettings: { include_domains: ['*.museum', '*.gallery', '*.art', 'cosmos.co', 'www.metmuseum.org'] }
                    },
                    {
                        key: 'social',
                        searchSettings: { include_domains: ['*.substack.com', 'www.reddit.com', 'www.threads.net', 'www.tumblr.com'] }
                    },
                    {
                        key: 'visual',
                        searchSettings: { include_domains: ['cosmos.co', '*.gallery', 'www.metmuseum.org', 'www.moma.org', 'www.wikiart.org'] }
                    },
                ];

                for (const def of enrichmentDefs) {
                    send('enrichment_start', { key: def.key });
                    try {
                        const enrichPrompt = promptGeneratorService.generateEnrichmentPrompt(def.key as any, query, entities);
                        const resp = await groqService.executeSearch(enrichPrompt, { searchSettings: def.searchSettings });
                        const parsed = responseParserService.parseEnrichmentResponse(resp.content);

                        // Merge sources
                        const localToGlobal = new Map<number, number>();
                        parsed.sources.forEach((s, idx) => {
                            const exIndex = interpretiveResponse.sources.findIndex((e: any) => e.url === s.url);
                            if (exIndex >= 0) {
                                localToGlobal.set(idx + 1, exIndex + 1);
                            } else {
                                interpretiveResponse.sources.push({ ...s, index: interpretiveResponse.sources.length + 1 });
                                localToGlobal.set(idx + 1, interpretiveResponse.sources.length);
                            }
                        });

                        // Merge segments and re-map indices
                        parsed.segments.forEach((seg) => {
                            if (seg.type === 'context' && Array.isArray((seg as any).sourceIndices)) {
                                (seg as any).sourceIndices = (seg as any).sourceIndices.map((i: number) => localToGlobal.get(i) ?? i);
                            }
                            if (seg.type === 'quote' && typeof (seg as any).sourceIndex === 'number') {
                                (seg as any).sourceIndex = localToGlobal.get((seg as any).sourceIndex) ?? (seg as any).sourceIndex;
                            }
                            interpretiveResponse.segments.push(seg);
                        });

                        send('enrichment_complete', { key: def.key, segmentsAdded: parsed.segments.length, sourcesAdded: parsed.sources.length });
                    } catch (enrichErr: any) {
                        send('enrichment_error', { key: def.key, message: enrichErr?.message || 'enrichment failed' });
                    }
                }

                // Finalize counts
                interpretiveResponse.sources = interpretiveResponse.sources
                    .filter((s: any, i: number, self: any[]) => self.findIndex((x) => x.url === s.url) === i)
                    .map((s: any, i: number) => ({ ...s, index: i + 1 }));
                interpretiveResponse.metadata.segmentCount = interpretiveResponse.segments.length;
                interpretiveResponse.metadata.sourceCount = interpretiveResponse.sources.length;

                // Optional artifact
                if (enableArtifacts) {
                    const lower = query.toLowerCase();
                    const should = ['write code', 'generate script', 'create function', 'analyze data', 'visualize', 'plot', 'chart', 'calculate']
                        .some(k => lower.includes(k));
                    if (should) {
                        const artifact = await artifactGeneratorService.generateCodeArtifact({
                            prompt: query,
                            language: 'python',
                            context: interpretiveResponse,
                        });
                        (interpretiveResponse as any).artifact = artifact;
                        send('artifact_generated', { hasArtifact: true });
                    }
                }

                send('complete', { requestId, status: 'complete', payload: interpretiveResponse });
            } catch (err: any) {
                send('error', { requestId, status: 'error', message: err?.message || 'Unknown error' });
            }
            return;
        }

    } catch (error: any) {
        logger.error('Fatal error in WebSocket handler', { error: error.message, stack: error.stack, sessionId });
        if (ws.readyState === ws.OPEN) {
            streamManager.sendChunk(sessionId, { type: 'error', content: `Server Error: ${error.message}` });
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
