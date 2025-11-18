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
const cors_1 = __importDefault(require("cors"));
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
const DataDependencyService_1 = require("./services/data/DataDependencyService");
const Resolver_1 = require("./services/data/Resolver");
const session_service_1 = require("./services/session.service");
const PlanExecutorService_1 = require("./services/PlanExecutorService");
const router_service_1 = require("./services/router.service");
const prompt_generator_service_1 = require("./services/prompt-generator.service");
const groq_service_1 = require("./services/groq.service");
const response_parser_service_1 = require("./services/response-parser.service");
const document_service_1 = require("./services/document.service");
const artifact_generator_service_1 = require("./services/artifact-generator.service");
const artifacts_1 = __importDefault(require("./routes/artifacts"));
const documents_1 = __importDefault(require("./routes/documents"));
const export_1 = __importDefault(require("./routes/export"));
const interpret_1 = __importDefault(require("./routes/interpret"));
const sessions_1 = __importDefault(require("./routes/sessions"));
const HistoryService_1 = require("./services/HistoryService");
const history_1 = __importDefault(require("./routes/history"));
const logger = winston_1.default.createLogger({
    level: 'info',
    format: winston_1.default.format.combine(winston_1.default.format.timestamp(), winston_1.default.format.json()),
    transports: [new winston_1.default.transports.Console()],
});
const groqClient = new groq_sdk_1.default({ apiKey: config_1.CONFIG.GROQ_API_KEY });
const toolConfigManager = new ToolConfigManager_1.ToolConfigManager();
const nangoService = new NangoService_1.NangoService();
const streamManager = new StreamManager_1.StreamManager({ logger });
const dataDependencyService = new DataDependencyService_1.DataDependencyService();
const resolver = new Resolver_1.Resolver(dataDependencyService);
const followUpService = new FollowUpService_1.FollowUpService(groqClient, config_1.CONFIG.MODEL_NAME, config_1.CONFIG.MAX_TOKENS);
const toolOrchestrator = new ToolOrchestrator_1.ToolOrchestrator({ logger, nangoService, toolConfigManager, dataDependencyService, resolver, redisClient: redis });
const plannerService = new PlannerService_1.PlannerService(config_1.CONFIG.GROQ_API_KEY, config_1.CONFIG.MAX_TOKENS, toolConfigManager);
const beatEngine = new BeatEngine_1.BeatEngine(toolConfigManager);
const historyService = new HistoryService_1.HistoryService(redis);
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
const planExecutorService = new PlanExecutorService_1.PlanExecutorService(actionLauncherService, toolOrchestrator, streamManager, toolConfigManager, groqClient, plannerService, followUpService, historyService);
const sessionState = storage.create({ dir: 'sessions' });
(async () => {
    await sessionState.init();
    await session_service_1.sessionService.init();
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
app.use((0, cors_1.default)());
app.use(express_1.default.json({ limit: '50mb' }));
app.use(express_1.default.urlencoded({ extended: true, limit: '50mb' }));
app.use('/api/artifacts', artifacts_1.default);
app.use('/api/documents', documents_1.default);
app.use('/api/export', export_1.default);
app.use('/api/interpret', interpret_1.default);
app.use('/api/sessions', sessions_1.default);
app.locals.historyService = historyService;
app.use('/history', history_1.default);
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});
const server = (0, http_1.createServer)(app);
const wss = new ws_1.WebSocketServer({ server });
actionLauncherService.on('send_chunk', (sessionId, chunk) => {
    streamManager.sendChunk(sessionId, chunk);
});
plannerService.on('send_chunk', (sessionId, chunk) => {
    streamManager.sendChunk(sessionId, chunk);
});
wss.on('connection', (ws, req) => {
    const sessionId = req.url?.slice(1) || (0, uuid_1.v4)();
    streamManager.addConnection(sessionId, ws);
    logger.info('Client connected', { sessionId });
    const sessionConfig = {
        sessionId: sessionId,
        tools: toolConfigManager.getToolDefinitionsForPlanner(),
    };
    streamManager.sendChunk(sessionId, {
        type: 'session_init',
        content: sessionConfig
    });
    streamManager.sendChunk(sessionId, { type: 'connection_ack', content: { sessionId } });
    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            if (data.type === 'init') {
                let userId;
                if (data.idToken) {
                    const decodedToken = await firebase_1.auth.verifyIdToken(data.idToken);
                    userId = decodedToken.uid;
                    await sessionState.setItem(sessionId, { userId });
                    streamManager.sendChunk(sessionId, { type: 'auth_success', content: { userId } });
                    logger.info('Client authenticated', { userId, sessionId });
                    try {
                        const activeConnectionId = await redis.get(`active-connection:${userId}`);
                        if (activeConnectionId) {
                            logger.info('Warming connection post-auth', { userId, connectionId: '***' });
                            await nangoService.warmConnection('gmail', activeConnectionId);
                        }
                    }
                    catch (warmError) {
                        logger.warn('Post-auth connection warming failed', { userId, error: warmError.message });
                    }
                }
                else {
                    userId = `unauthenticated-user-${(0, uuid_1.v4)()}`;
                    await sessionState.setItem(sessionId, { userId });
                    streamManager.sendChunk(sessionId, { type: 'auth_success', content: { userId } });
                    logger.info('Unauthenticated session created', { userId, sessionId });
                }
                return;
            }
            const state = (await sessionState.getItem(sessionId));
            if (!state)
                throw new Error('Not authenticated');
            const { userId } = state;
            if (data.type === 'execute_action' && data.content) {
                const actionPayload = data.content;
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
                const stepIndex = currentRun.toolExecutionPlan.findIndex(s => s.stepId === step.stepId);
                if (stepIndex !== -1) {
                    currentRun.toolExecutionPlan[stepIndex].status = completedAction.status;
                    currentRun.toolExecutionPlan[stepIndex].result = { status: completedAction.status === 'completed' ? 'success' : 'failed', toolName: completedAction.toolName, data: completedAction.result, error: completedAction.error };
                    currentRun.toolExecutionPlan[stepIndex].finishedAt = new Date().toISOString();
                }
                const completedRun = await planExecutorService.executePlan(currentRun, userId);
                state.activeRun = completedRun;
                await sessionState.setItem(sessionId, state);
            }
            if (data.type === 'update_active_connection' && data.content) {
                const { connectionId } = data.content;
                if (!userId || !connectionId)
                    return;
                await redis.set(`active-connection:${userId}`, connectionId);
                logger.info(`Successfully set active Nango connection for user`, { userId });
                try {
                    const warmSuccess = await nangoService.warmConnection('gmail', connectionId);
                    streamManager.sendChunk(sessionId, { type: 'connection_updated_ack', content: { warmed: warmSuccess } });
                }
                catch (error) {
                    logger.error('Connection warming on update failed', { userId, connectionId: '***', error: error.message });
                    streamManager.sendChunk(sessionId, { type: 'connection_updated_ack', content: { warmed: false } });
                }
                return;
            }
            if (data.type === 'rerun_plan' && data.content && data.content.plan) {
                const savedPlan = data.content.plan;
                const messageId = (0, uuid_1.v4)();
                logger.info('Rerunning saved plan', { sessionId, userId, messageId, planSize: savedPlan.length });
                actionLauncherService.clearActions(sessionId);
                const run = RunManager_1.RunManager.createRun({
                    sessionId,
                    userId,
                    userInput: `Rerun of a saved plan with ${savedPlan.length} steps.`,
                    toolExecutionPlan: []
                });
                state.activeRun = run;
                await sessionState.setItem(sessionId, state);
                streamManager.sendChunk(sessionId, { type: 'run_updated', content: run });
                const newActionPlan = savedPlan.map(step => ({
                    id: (0, uuid_1.v4)(),
                    tool: step.toolName,
                    intent: step.description,
                    arguments: step.arguments || {},
                    status: 'ready',
                }));
                const enrichedPlan = newActionPlan.map((step) => {
                    const toolDef = toolConfigManager.getToolDefinition(step.tool);
                    const toolDisplayName = toolDef?.display_name || toolDef?.displayName || toolDef?.name || step.tool.replace(/_/g, ' ').split(' ').map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
                    const parameters = [];
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
                        status: step.status,
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
                });
                try {
                    const planTitle = `Rerun: ${savedPlan.length} actions`;
                    const actions = savedPlan.map((step) => ({
                        toolName: step.toolName,
                        description: step.description
                    }));
                    const historyId = await historyService.recordPlanCreation(userId, sessionId, run.id, planTitle, actions);
                    run.historyId = historyId;
                }
                catch (error) {
                    logger.warn('Failed to record rerun in history', { error: error.message });
                }
                await actionLauncherService.processActionPlan(newActionPlan, sessionId, userId, messageId, toolOrchestrator, run);
                run.toolExecutionPlan = newActionPlan.map((step) => ({
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
                const actions = actionLauncherService.getActiveActions(sessionId);
                const needsUserInput = actions.some(a => a.status === 'collecting_parameters');
                if (!needsUserInput && actions.length > 0) {
                    logger.info('No user input needed for rerun, starting auto-execution.', { sessionId, runId: run.id });
                    await planExecutorService.executePlan(run, userId);
                    if (run.status === 'completed') {
                        logger.info('Rerun plan auto-execution complete, generating final response.', { sessionId });
                        run.toolExecutionPlan.forEach(step => {
                            if (step.status === 'completed' && step.result) {
                                conversationService.addToolResultMessageToHistory(sessionId, step.toolCall.id, step.toolCall.name, step.result.data);
                            }
                        });
                        const finalResponseResult = await conversationService.processMessageAndAggregateResults(null, sessionId, (0, uuid_1.v4)());
                        if (finalResponseResult.conversationalResponse?.trim()) {
                            await streamText(sessionId, (0, uuid_1.v4)(), finalResponseResult.conversationalResponse);
                        }
                    }
                }
                else {
                    logger.info('Rerun plan requires user input before execution.', { sessionId });
                }
                return;
            }
            if (data.type === 'content' && typeof data.content === 'string') {
                const messageId = (0, uuid_1.v4)();
                logger.info('Processing user message', { sessionId, userId, messageId });
                try {
                    await historyService.recordUserMessage(userId, sessionId, data.content);
                }
                catch (error) {
                    logger.warn('Failed to record user message in history', { error: error.message });
                }
                const processedResult = await conversationService.processMessageAndAggregateResults(data.content, sessionId, messageId);
                const { aggregatedToolCalls, conversationalResponse } = processedResult;
                if (conversationalResponse?.trim()) {
                    await streamText(sessionId, messageId, conversationalResponse);
                }
                const isPlanRequest = aggregatedToolCalls.some(tool => tool.name === 'planParallelActions');
                const executableToolCount = aggregatedToolCalls.filter(t => t.name !== 'planParallelActions').length;
                if (isPlanRequest || executableToolCount > 1) {
                    logger.info(`Complex request identified. Routing to PlannerService.`, { sessionId, isPlanRequest, executableToolCount });
                    const run = RunManager_1.RunManager.createRun({ sessionId, userId, userInput: data.content, toolExecutionPlan: [] });
                    state.activeRun = run;
                    await sessionState.setItem(sessionId, state);
                    streamManager.sendChunk(sessionId, { type: 'run_updated', content: run });
                    const toolsForPlanning = aggregatedToolCalls.filter(t => t.name !== 'planParallelActions');
                    const actionPlan = await plannerService.generatePlanWithStepAnnouncements(data.content, toolsForPlanning, sessionId, messageId);
                    if (actionPlan && actionPlan.length > 0) {
                        await actionLauncherService.processActionPlan(actionPlan, sessionId, userId, messageId, toolOrchestrator, run);
                        try {
                            const planTitle = data.content.substring(0, 100);
                            const actions = actionPlan.map(step => ({
                                toolName: step.tool,
                                description: step.intent
                            }));
                            const historyId = await historyService.recordPlanCreation(userId, sessionId, run.id, planTitle, actions);
                            run.historyId = historyId;
                            logger.info('Plan recorded in history', { sessionId, historyId, planId: run.id });
                        }
                        catch (error) {
                            logger.warn('Failed to record plan in history', { error: error.message });
                        }
                        const actions = actionLauncherService.getActiveActions(sessionId);
                        const needsUserInput = actions.some(a => a.status === 'collecting_parameters');
                        if (!needsUserInput && actions.length > 0) {
                            logger.info('No user input needed for plan, starting auto-execution.', { sessionId, runId: run.id });
                            const completedRun = await planExecutorService.executePlan(run, userId);
                            state.activeRun = completedRun;
                            await sessionState.setItem(sessionId, state);
                        }
                        else {
                            logger.info('Plan requires user input before execution.', { sessionId });
                        }
                        const enrichedPlan = actionPlan.map((step) => {
                            const toolDef = toolConfigManager.getToolDefinition(step.tool);
                            const toolDisplayName = toolDef?.display_name || toolDef?.name || step.tool;
                            const parameters = [];
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
                        });
                        run.toolExecutionPlan = actionPlan.map((step) => ({
                            stepId: step.id,
                            toolCall: { id: step.id, name: step.tool, arguments: step.arguments, sessionId, userId },
                            status: 'pending', startedAt: new Date().toISOString(),
                        }));
                        await sessionState.setItem(sessionId, state);
                    }
                    else if (!conversationalResponse) {
                        await streamText(sessionId, messageId, "I was unable to formulate a plan for your request.");
                    }
                }
                else if (executableToolCount === 1) {
                    const singleToolCall = aggregatedToolCalls.find(t => t.name !== 'planParallelActions');
                    logger.info(`Single tool call '${singleToolCall.name}' identified. Bypassing planner.`, { sessionId });
                    const run = RunManager_1.RunManager.createRun({ sessionId, userId, userInput: data.content, toolExecutionPlan: [] });
                    state.activeRun = run;
                    await sessionState.setItem(sessionId, state);
                    streamManager.sendChunk(sessionId, { type: 'run_updated', content: run });
                    const singleStepPlan = [{
                            id: singleToolCall.id || (0, uuid_1.v4)(),
                            intent: `Execute the ${singleToolCall.name} tool.`,
                            tool: singleToolCall.name,
                            arguments: singleToolCall.arguments,
                            status: 'ready',
                        }];
                    await plannerService.streamSingleActionAnnouncement(singleStepPlan[0], sessionId);
                    run.toolExecutionPlan = singleStepPlan.map((step) => ({
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
                    await actionLauncherService.processActionPlan(singleStepPlan, sessionId, userId, messageId, toolOrchestrator, run);
                    const actions = actionLauncherService.getActiveActions(sessionId);
                    const needsUserInput = actions.some(a => a.status === 'collecting_parameters');
                    const enrichedPlan = singleStepPlan.map((step) => {
                        const toolDef = toolConfigManager.getToolDefinition(step.tool);
                        const toolDisplayName = toolDef?.display_name || toolDef?.name || step.tool;
                        const parameters = [];
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
                    streamManager.sendChunk(sessionId, {
                        type: 'plan_generated',
                        content: { messageId, planOverview: enrichedPlan, analysis: `Preparing to execute action.` },
                        messageId, isFinal: true,
                    });
                    if (!needsUserInput && actions.length > 0) {
                        logger.info('No user input needed for single action, starting auto-execution.', { sessionId, runId: run.id });
                        const completedRunAfterExec = await planExecutorService.executePlan(run, userId);
                        state.activeRun = completedRunAfterExec;
                        await sessionState.setItem(sessionId, state);
                    }
                    else if (actions.length > 0) {
                        logger.info('Single action requires user input before execution.', { sessionId });
                    }
                }
                const finalRunState = (await sessionState.getItem(sessionId))?.activeRun;
                if (finalRunState && finalRunState.status === 'completed' && !finalRunState.assistantResponse) {
                    logger.info('Auto-execution complete, generating final context-aware response.', {
                        sessionId,
                        runId: finalRunState.id,
                        planLength: finalRunState.toolExecutionPlan.length
                    });
                    finalRunState.toolExecutionPlan.forEach(step => {
                        if (step.status === 'completed' && step.result) {
                            logger.info('Adding tool result to history', {
                                stepId: step.stepId,
                                toolName: step.toolCall.name
                            });
                            conversationService.addToolResultMessageToHistory(sessionId, step.toolCall.id, step.toolCall.name, step.result.data);
                        }
                    });
                    logger.info('Requesting final summary from LLM', { sessionId });
                    const finalResponseResult = await conversationService.processMessageAndAggregateResults(null, sessionId, (0, uuid_1.v4)());
                    logger.info('Final response result received', {
                        sessionId,
                        hasResponse: !!finalResponseResult.conversationalResponse,
                        responseLength: finalResponseResult.conversationalResponse?.length || 0
                    });
                    if (finalResponseResult.conversationalResponse?.trim()) {
                        await streamText(sessionId, (0, uuid_1.v4)(), finalResponseResult.conversationalResponse);
                        try {
                            await historyService.recordAssistantMessage(userId, sessionId, finalResponseResult.conversationalResponse);
                            logger.info('Final response recorded in history', { sessionId });
                        }
                        catch (error) {
                            logger.warn('Failed to record assistant message', { error: error.message });
                        }
                        finalRunState.assistantResponse = finalResponseResult.conversationalResponse;
                        await sessionState.setItem(sessionId, { userId, activeRun: finalRunState });
                        logger.info('Run state updated with assistant response', { sessionId });
                    }
                    else {
                        logger.warn('No final conversational response generated after tool execution', {
                            sessionId,
                            runId: finalRunState.id
                        });
                    }
                }
                else if (!conversationalResponse && executableToolCount === 0 && !isPlanRequest) {
                    logger.warn('No tools or conversational response generated for user message.', {
                        sessionId,
                        userMessage: data.content,
                        hasFinalRunState: !!finalRunState,
                        finalRunStatus: finalRunState?.status,
                        hasAssistantResponse: !!finalRunState?.assistantResponse
                    });
                    await streamText(sessionId, messageId, "I'm not sure how to help with that. Could you rephrase or provide more details?");
                }
                return;
            }
            if (data.type === 'interpret') {
                const { query, sessionId: incomingSessionId, documentIds, enableArtifacts, searchSettings } = data.content || {};
                const wsMessageId = (0, uuid_1.v4)();
                const sessionIdForWS = incomingSessionId || (0, uuid_1.v4)();
                streamManager.sendChunk(sessionIdForWS, { type: 'interpret_started', messageId: wsMessageId });
                try {
                    const sessionCtx = incomingSessionId ? await sessionState.getItem(incomingSessionId) : null;
                    let documentContext = [];
                    if (Array.isArray(documentIds) && documentIds.length > 0) {
                        documentContext = await document_service_1.documentService.getDocuments(documentIds);
                    }
                    const { mode, entities } = await router_service_1.routerService.detectIntent(query);
                    const groqPrompt = prompt_generator_service_1.promptGeneratorService.generatePrompt(mode, query, entities, {
                        sessionContext: null,
                        documentContext,
                        enableArtifacts,
                    });
                    const groqResponse = await groq_service_1.groqService.executeSearch(groqPrompt, { searchSettings });
                    const interpretiveResponse = response_parser_service_1.responseParserService.parseGroqResponse(groqResponse.content, mode, groqResponse);
                    streamManager.sendChunk(sessionIdForWS, { type: 'interpret_segment', messageId: wsMessageId, content: { kind: 'hero', data: interpretiveResponse.hero } });
                    for (const seg of interpretiveResponse.segments) {
                        streamManager.sendChunk(sessionIdForWS, { type: 'interpret_segment', messageId: wsMessageId, content: { kind: 'segment', data: seg } });
                    }
                    streamManager.sendChunk(sessionIdForWS, { type: 'interpret_segment', messageId: wsMessageId, content: { kind: 'sources', data: interpretiveResponse.sources } });
                    if (enableArtifacts) {
                        const should = (() => {
                            const q = String(query || '').toLowerCase();
                            return ['generate', 'script', 'analyze', 'visualize', 'plot', 'chart', 'calculate'].some(k => q.includes(k));
                        })();
                        if (should) {
                            const artifact = await artifact_generator_service_1.artifactGeneratorService.generateCodeArtifact({
                                prompt: query,
                                language: 'python',
                                context: interpretiveResponse,
                            });
                            interpretiveResponse.artifact = artifact;
                            streamManager.sendChunk(sessionIdForWS, { type: 'interpret_segment', messageId: wsMessageId, content: { kind: 'artifact', data: artifact } });
                        }
                    }
                    streamManager.sendChunk(sessionIdForWS, { type: 'interpret_complete', messageId: wsMessageId, content: interpretiveResponse, isFinal: true });
                }
                catch (err) {
                    streamManager.sendChunk(sessionIdForWS, { type: 'error', messageId: wsMessageId, content: { code: 'INTERPRET_ERROR', message: err?.message || 'Unknown error' }, isFinal: true });
                }
                return;
            }
            if (data.type === 'interpret_stream' && data.content) {
                const { query, sessionId: incomingSessionId, documentIds, enableArtifacts, searchSettings } = data.content || {};
                if (!query || typeof query !== 'string') {
                    streamManager.sendChunk(sessionId, { type: 'interpret_event', event: 'error', data: { message: 'Query is required' } });
                    return;
                }
                const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
                const startTime = Date.now();
                const send = (event, dataObj) => {
                    streamManager.sendChunk(sessionId, { type: 'interpret_event', event, data: dataObj });
                };
                try {
                    send('start', { requestId, status: 'loading' });
                    const sessionContext = null;
                    const docCtx = Array.isArray(documentIds) && documentIds.length
                        ? await document_service_1.documentService.getDocuments(documentIds)
                        : [];
                    const { mode, entities } = await router_service_1.routerService.detectIntent(query);
                    const groqPrompt = prompt_generator_service_1.promptGeneratorService.generatePrompt(mode, query, entities, {
                        sessionContext,
                        documentContext: docCtx,
                        enableArtifacts,
                    });
                    let combinedContent = '';
                    let reasoning = '';
                    let model = '';
                    let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
                    try {
                        const stream = groq_service_1.groqService.executeSearchStream(groqPrompt, { searchSettings });
                        for await (const chunk of stream) {
                            if (chunk.model)
                                model = chunk.model;
                            if ('usage' in chunk && chunk.usage) {
                                usage = { ...usage, ...chunk.usage };
                            }
                            const choice = chunk.choices?.[0];
                            const delta = choice?.delta ?? {};
                            if (typeof delta?.content === 'string' && delta.content.length) {
                                combinedContent += delta.content;
                                send('token', { chunk: delta.content });
                            }
                            if (typeof delta?.reasoning === 'string' && delta.reasoning.length) {
                                reasoning += delta.reasoning;
                                send('reasoning', { text: delta.reasoning });
                            }
                        }
                    }
                    catch (streamErr) {
                        const resp = await groq_service_1.groqService.executeSearch(groqPrompt, { searchSettings });
                        combinedContent = resp.content;
                        model = resp.model;
                        usage = resp.usage;
                        reasoning = resp.reasoning || '';
                    }
                    let groqResponse = { content: combinedContent, model, usage, reasoning };
                    let interpretiveResponse;
                    try {
                        interpretiveResponse = response_parser_service_1.responseParserService.parseGroqResponse(combinedContent, mode, groqResponse);
                    }
                    catch (parseError) {
                        send('warning', { type: 'parse_error', message: parseError?.message || 'Failed to parse Groq JSON' });
                        interpretiveResponse = response_parser_service_1.responseParserService.buildFallbackResponse(combinedContent, mode, groqResponse, parseError?.message || 'Failed to parse Groq JSON');
                    }
                    interpretiveResponse.metadata.processingTimeMs = Date.now() - startTime;
                    const enrichmentDefs = [
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
                            const enrichPrompt = prompt_generator_service_1.promptGeneratorService.generateEnrichmentPrompt(def.key, query, entities);
                            const resp = await groq_service_1.groqService.executeSearch(enrichPrompt, { searchSettings: def.searchSettings });
                            const parsed = response_parser_service_1.responseParserService.parseEnrichmentResponse(resp.content);
                            const localToGlobal = new Map();
                            parsed.sources.forEach((s, idx) => {
                                const exIndex = interpretiveResponse.sources.findIndex((e) => e.url === s.url);
                                if (exIndex >= 0) {
                                    localToGlobal.set(idx + 1, exIndex + 1);
                                }
                                else {
                                    interpretiveResponse.sources.push({ ...s, index: interpretiveResponse.sources.length + 1 });
                                    localToGlobal.set(idx + 1, interpretiveResponse.sources.length);
                                }
                            });
                            parsed.segments.forEach((seg) => {
                                if (seg.type === 'context' && Array.isArray(seg.sourceIndices)) {
                                    seg.sourceIndices = seg.sourceIndices.map((i) => localToGlobal.get(i) ?? i);
                                }
                                if (seg.type === 'quote' && typeof seg.sourceIndex === 'number') {
                                    seg.sourceIndex = localToGlobal.get(seg.sourceIndex) ?? seg.sourceIndex;
                                }
                                interpretiveResponse.segments.push(seg);
                            });
                            send('enrichment_complete', { key: def.key, segmentsAdded: parsed.segments.length, sourcesAdded: parsed.sources.length });
                        }
                        catch (enrichErr) {
                            send('enrichment_error', { key: def.key, message: enrichErr?.message || 'enrichment failed' });
                        }
                    }
                    interpretiveResponse.sources = interpretiveResponse.sources
                        .filter((s, i, self) => self.findIndex((x) => x.url === s.url) === i)
                        .map((s, i) => ({ ...s, index: i + 1 }));
                    interpretiveResponse.metadata.segmentCount = interpretiveResponse.segments.length;
                    interpretiveResponse.metadata.sourceCount = interpretiveResponse.sources.length;
                    if (enableArtifacts) {
                        const lower = query.toLowerCase();
                        const should = ['write code', 'generate script', 'create function', 'analyze data', 'visualize', 'plot', 'chart', 'calculate']
                            .some(k => lower.includes(k));
                        if (should) {
                            const artifact = await artifact_generator_service_1.artifactGeneratorService.generateCodeArtifact({
                                prompt: query,
                                language: 'python',
                                context: interpretiveResponse,
                            });
                            interpretiveResponse.artifact = artifact;
                            send('artifact_generated', { hasArtifact: true });
                        }
                    }
                    send('complete', { requestId, status: 'complete', payload: interpretiveResponse });
                }
                catch (err) {
                    send('error', { requestId, status: 'error', message: err?.message || 'Unknown error' });
                }
                return;
            }
            if (data.type === 'interpret') {
                const { query, sessionId: incomingSessionId, documentIds, enableArtifacts, searchSettings } = data.content || {};
                const wsMessageId = (0, uuid_1.v4)();
                const sessionIdForWS = incomingSessionId || (0, uuid_1.v4)();
                streamManager.sendChunk(sessionIdForWS, { type: 'interpret_started', messageId: wsMessageId });
                try {
                    const sessionCtx = incomingSessionId ? await sessionState.getItem(incomingSessionId) : null;
                    let documentContext = [];
                    if (Array.isArray(documentIds) && documentIds.length > 0) {
                        documentContext = await document_service_1.documentService.getDocuments(documentIds);
                    }
                    const { mode, entities } = await router_service_1.routerService.detectIntent(query);
                    const groqPrompt = prompt_generator_service_1.promptGeneratorService.generatePrompt(mode, query, entities, {
                        sessionContext: null,
                        documentContext,
                        enableArtifacts,
                    });
                    const groqResponse = await groq_service_1.groqService.executeSearch(groqPrompt, { searchSettings });
                    const interpretiveResponse = response_parser_service_1.responseParserService.parseGroqResponse(groqResponse.content, mode, groqResponse);
                    streamManager.sendChunk(sessionIdForWS, { type: 'interpret_segment', messageId: wsMessageId, content: { kind: 'hero', data: interpretiveResponse.hero } });
                    for (const seg of interpretiveResponse.segments) {
                        streamManager.sendChunk(sessionIdForWS, { type: 'interpret_segment', messageId: wsMessageId, content: { kind: 'segment', data: seg } });
                    }
                    streamManager.sendChunk(sessionIdForWS, { type: 'interpret_segment', messageId: wsMessageId, content: { kind: 'sources', data: interpretiveResponse.sources } });
                    if (enableArtifacts) {
                        const should = (() => {
                            const q = String(query || '').toLowerCase();
                            return ['generate', 'script', 'analyze', 'visualize', 'plot', 'chart', 'calculate'].some(k => q.includes(k));
                        })();
                        if (should) {
                            const artifact = await artifact_generator_service_1.artifactGeneratorService.generateCodeArtifact({
                                prompt: query,
                                language: 'python',
                                context: interpretiveResponse,
                            });
                            interpretiveResponse.artifact = artifact;
                            streamManager.sendChunk(sessionIdForWS, { type: 'interpret_segment', messageId: wsMessageId, content: { kind: 'artifact', data: artifact } });
                        }
                    }
                    streamManager.sendChunk(sessionIdForWS, { type: 'interpret_complete', messageId: wsMessageId, content: interpretiveResponse, isFinal: true });
                }
                catch (err) {
                    streamManager.sendChunk(sessionIdForWS, { type: 'error', messageId: wsMessageId, content: { code: 'INTERPRET_ERROR', message: err?.message || 'Unknown error' }, isFinal: true });
                }
                return;
            }
            if (data.type === 'interpret_stream' && data.content) {
                const { query, sessionId: incomingSessionId, documentIds, enableArtifacts, searchSettings } = data.content || {};
                if (!query || typeof query !== 'string') {
                    streamManager.sendChunk(sessionId, { type: 'interpret_event', event: 'error', data: { message: 'Query is required' } });
                    return;
                }
                const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
                const startTime = Date.now();
                const send = (event, dataObj) => {
                    streamManager.sendChunk(sessionId, { type: 'interpret_event', event, data: dataObj });
                };
                try {
                    send('start', { requestId, status: 'loading' });
                    const sessionContext = null;
                    const docCtx = Array.isArray(documentIds) && documentIds.length
                        ? await document_service_1.documentService.getDocuments(documentIds)
                        : [];
                    const { mode, entities } = await router_service_1.routerService.detectIntent(query);
                    const groqPrompt = prompt_generator_service_1.promptGeneratorService.generatePrompt(mode, query, entities, {
                        sessionContext,
                        documentContext: docCtx,
                        enableArtifacts,
                    });
                    let combinedContent = '';
                    let reasoning = '';
                    let model = '';
                    let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
                    try {
                        const stream = groq_service_1.groqService.executeSearchStream(groqPrompt, { searchSettings });
                        for await (const chunk of stream) {
                            if (chunk.model)
                                model = chunk.model;
                            if ('usage' in chunk && chunk.usage) {
                                usage = { ...usage, ...chunk.usage };
                            }
                            const choice = chunk.choices?.[0];
                            const delta = choice?.delta ?? {};
                            if (typeof delta?.content === 'string' && delta.content.length) {
                                combinedContent += delta.content;
                                send('token', { chunk: delta.content });
                            }
                            if (typeof delta?.reasoning === 'string' && delta.reasoning.length) {
                                reasoning += delta.reasoning;
                                send('reasoning', { text: delta.reasoning });
                            }
                        }
                    }
                    catch (streamErr) {
                        const resp = await groq_service_1.groqService.executeSearch(groqPrompt, { searchSettings });
                        combinedContent = resp.content;
                        model = resp.model;
                        usage = resp.usage;
                        reasoning = resp.reasoning || '';
                    }
                    let groqResponse = { content: combinedContent, model, usage, reasoning };
                    let interpretiveResponse;
                    try {
                        interpretiveResponse = response_parser_service_1.responseParserService.parseGroqResponse(combinedContent, mode, groqResponse);
                    }
                    catch (parseError) {
                        send('warning', { type: 'parse_error', message: parseError?.message || 'Failed to parse Groq JSON' });
                        interpretiveResponse = response_parser_service_1.responseParserService.buildFallbackResponse(combinedContent, mode, groqResponse, parseError?.message || 'Failed to parse Groq JSON');
                    }
                    interpretiveResponse.metadata.processingTimeMs = Date.now() - startTime;
                    const enrichmentDefs = [
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
                            const enrichPrompt = prompt_generator_service_1.promptGeneratorService.generateEnrichmentPrompt(def.key, query, entities);
                            const resp = await groq_service_1.groqService.executeSearch(enrichPrompt, { searchSettings: def.searchSettings });
                            const parsed = response_parser_service_1.responseParserService.parseEnrichmentResponse(resp.content);
                            const localToGlobal = new Map();
                            parsed.sources.forEach((s, idx) => {
                                const exIndex = interpretiveResponse.sources.findIndex((e) => e.url === s.url);
                                if (exIndex >= 0) {
                                    localToGlobal.set(idx + 1, exIndex + 1);
                                }
                                else {
                                    interpretiveResponse.sources.push({ ...s, index: interpretiveResponse.sources.length + 1 });
                                    localToGlobal.set(idx + 1, interpretiveResponse.sources.length);
                                }
                            });
                            parsed.segments.forEach((seg) => {
                                if (seg.type === 'context' && Array.isArray(seg.sourceIndices)) {
                                    seg.sourceIndices = seg.sourceIndices.map((i) => localToGlobal.get(i) ?? i);
                                }
                                if (seg.type === 'quote' && typeof seg.sourceIndex === 'number') {
                                    seg.sourceIndex = localToGlobal.get(seg.sourceIndex) ?? seg.sourceIndex;
                                }
                                interpretiveResponse.segments.push(seg);
                            });
                            send('enrichment_complete', { key: def.key, segmentsAdded: parsed.segments.length, sourcesAdded: parsed.sources.length });
                        }
                        catch (enrichErr) {
                            send('enrichment_error', { key: def.key, message: enrichErr?.message || 'enrichment failed' });
                        }
                    }
                    interpretiveResponse.sources = interpretiveResponse.sources
                        .filter((s, i, self) => self.findIndex((x) => x.url === s.url) === i)
                        .map((s, i) => ({ ...s, index: i + 1 }));
                    interpretiveResponse.metadata.segmentCount = interpretiveResponse.segments.length;
                    interpretiveResponse.metadata.sourceCount = interpretiveResponse.sources.length;
                    if (enableArtifacts) {
                        const lower = query.toLowerCase();
                        const should = ['write code', 'generate script', 'create function', 'analyze data', 'visualize', 'plot', 'chart', 'calculate']
                            .some(k => lower.includes(k));
                        if (should) {
                            const artifact = await artifact_generator_service_1.artifactGeneratorService.generateCodeArtifact({
                                prompt: query,
                                language: 'python',
                                context: interpretiveResponse,
                            });
                            interpretiveResponse.artifact = artifact;
                            send('artifact_generated', { hasArtifact: true });
                        }
                    }
                    send('complete', { requestId, status: 'complete', payload: interpretiveResponse });
                }
                catch (err) {
                    send('error', { requestId, status: 'error', message: err?.message || 'Unknown error' });
                }
                return;
            }
        }
        catch (error) {
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
