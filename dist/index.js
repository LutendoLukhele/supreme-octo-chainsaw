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
const toolOrchestrator = new ToolOrchestrator_1.ToolOrchestrator({ logger, nangoService, toolConfigManager, dataDependencyService, resolver });
const plannerService = new PlannerService_1.PlannerService(config_1.CONFIG.OPEN_AI_API_KEY, config_1.CONFIG.MAX_TOKENS, toolConfigManager);
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
const planExecutorService = new PlanExecutorService_1.PlanExecutorService(actionLauncherService, toolOrchestrator, streamManager);
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
app.use((0, cors_1.default)());
app.use(express_1.default.json({ limit: '50mb' }));
app.use(express_1.default.urlencoded({ extended: true, limit: '50mb' }));
app.use('/api/artifacts', artifacts_1.default);
app.use('/api/documents', documents_1.default);
app.use('/api/export', export_1.default);
app.use('/api/interpret', interpret_1.default);
app.use('/api/sessions', sessions_1.default);
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
wss.on('connection', (ws) => {
    const sessionId = (0, uuid_1.v4)();
    streamManager.addConnection(sessionId, ws);
    logger.info('Client connected', { sessionId });
    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            if (data.type === 'init') {
                const decodedToken = await firebase_1.auth.verifyIdToken(data.idToken);
                const userId = decodedToken.uid;
                await sessionState.setItem(sessionId, { userId });
                ws.send(JSON.stringify({ type: 'auth_success' }));
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
                if (!currentRun.toolExecutionPlan)
                    currentRun.toolExecutionPlan = [];
                let toolIndex = currentRun.toolExecutionPlan.findIndex(step => step.toolCall.id === completedAction.id ||
                    (step.toolCall.name === completedAction.toolName && step.status === 'pending'));
                if (toolIndex === -1) {
                    const newStep = {
                        stepId: `step_${(0, uuid_1.v4)()}`,
                        toolCall: {
                            id: completedAction.id || (0, uuid_1.v4)(),
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
                if (completedAction.status === 'completed') {
                    try {
                        const followUpResult = await followUpService.generateFollowUp(currentRun, sessionId, (0, uuid_1.v4)());
                        const followUpText = followUpResult.summary;
                        if (followUpText?.trim())
                            await streamText(sessionId, (0, uuid_1.v4)(), followUpText);
                    }
                    catch (error) {
                        logger.error('Failed to generate follow-up message.', { error: error.message, sessionId });
                    }
                }
                return;
            }
            if (data.type === 'update_active_connection' && data.content) {
                const { connectionId } = data.content;
                if (!userId || !connectionId)
                    return;
                await redis.set(`active-connection:${userId}`, connectionId);
                logger.info(`Successfully set active Nango connection for user`, { userId });
                try {
                    const warmSuccess = await nangoService.warmConnection('gmail', connectionId);
                    ws.send(JSON.stringify({ type: 'connection_updated_ack', content: { warmed: warmSuccess } }));
                }
                catch (error) {
                    logger.error('Connection warming on update failed', { userId, connectionId: '***', error: error.message });
                    ws.send(JSON.stringify({ type: 'connection_updated_ack', content: { warmed: false } }));
                }
                return;
            }
            if (data.type === 'content' && typeof data.content === 'string') {
                const messageId = (0, uuid_1.v4)();
                logger.info('Processing user message', { sessionId, userId, messageId });
                const processedResult = await conversationService.processMessageAndAggregateResults(data.content, sessionId, messageId, userId);
                const { aggregatedToolCalls, conversationalResponse } = processedResult;
                if (conversationalResponse?.trim()) {
                    await streamText(sessionId, messageId, conversationalResponse);
                }
                const isPlanRequest = aggregatedToolCalls.some(tool => tool.name === 'planParallelActions');
                const executableToolCount = aggregatedToolCalls.filter(t => t.name !== 'planParallelActions').length;
                if (isPlanRequest || executableToolCount > 1) {
                    const run = RunManager_1.RunManager.createRun({
                        sessionId,
                        userId,
                        userInput: data.content,
                        toolExecutionPlan: []
                    });
                    state.activeRun = run;
                    await sessionState.setItem(sessionId, state);
                    streamManager.sendChunk(sessionId, { type: 'run_updated', content: run });
                    const toolsForPlanning = aggregatedToolCalls.filter(t => t.name !== 'planParallelActions');
                    const actionPlan = await plannerService.generatePlanWithStepAnnouncements(data.content, toolsForPlanning, sessionId, messageId);
                    if (actionPlan && actionPlan.length > 0) {
                        logger.info('Storing action plan in ActionLauncherService', {
                            sessionId,
                            planLength: actionPlan.length,
                            actionIds: actionPlan.map(s => s.id)
                        });
                        await actionLauncherService.processActionPlan(actionPlan, sessionId, userId, messageId, run);
                        logger.info('Action plan stored successfully', { sessionId });
                        const actions = actionLauncherService.getActiveActions(sessionId);
                        const needsUserInput = actions.some(a => a.status === 'collecting_parameters');
                        if (!needsUserInput && actions.length > 0) {
                            logger.info('No user input needed, starting auto-execution.', { sessionId, runId: run.id });
                            planExecutorService.executePlan(run, userId);
                        }
                        else {
                            logger.info('Plan requires user input before execution.', { sessionId });
                        }
                        const enrichedPlan = actionPlan.map((step) => {
                            const toolDef = toolConfigManager.getToolDefinition(step.tool);
                            const toolDisplayName = toolDef?.display_name ||
                                toolDef?.displayName ||
                                toolDef?.name ||
                                step.tool.replace(/_/g, ' ')
                                    .split(' ')
                                    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
                                    .join(' ');
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
                        logger.info('Sending enriched plan to Flutter client', {
                            sessionId,
                            planCount: enrichedPlan.length,
                            sampleStep: JSON.stringify(enrichedPlan[0], null, 2)
                        });
                        streamManager.sendChunk(sessionId, {
                            type: 'plan_generated',
                            content: {
                                messageId,
                                planOverview: enrichedPlan,
                                analysis: `Plan generated successfully with ${enrichedPlan.length} actions.`
                            },
                            messageId,
                            isFinal: true,
                        });
                        run.toolExecutionPlan = actionPlan.map((step, index) => ({
                            stepId: step.id || `step_${index + 1}`,
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
                    }
                    else if (!conversationalResponse) {
                        await streamText(sessionId, messageId, "I was unable to formulate a plan for your request.");
                    }
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
