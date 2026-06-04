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
import path from 'path';

// --- Monitoring & Observability ---
import { initializeTelemetry } from './monitoring/telemetry';
import { 
  traceContextMiddleware, 
  httpLoggingMiddleware, 
  createStructuredLogger, 
  logWithContext 
} from './monitoring/logging';
import {
  securityHeadersMiddleware,
  globalRateLimiter,
  authRateLimiter,
  validateTokenExpiry,
  corsOptionsSecure,
  secureErrorHandler,
} from './monitoring/security';
import { 
  httpRequestDuration, 
  httpRequestsTotal, 
  httpRequestSize, 
  httpResponseSize,
  errorCounter,
  uptime as uptimeMetric
} from './monitoring/metrics';
import { createHealthRouter } from './monitoring/health';
import { CircuitBreaker, withRetry, ErrorType, ErrorSeverity, createAppError } from './monitoring/error-handling';
import { 
  setupBootstrapMiddleware, 
  createStandardRateLimiter,
  createLLMRateLimiter,
  createWebhookRateLimiter,
  circuitBreaker as bootstrapCircuitBreaker 
} from './middleware/bootstrap-rate-limiting';
import { bootstrapMonitor } from './monitoring/bootstrap-capacity-monitor';

// Initialize OpenTelemetry
initializeTelemetry();

// Create structured logger for this service
const logger = createStructuredLogger('beat-engine-backend');

// --- Core Dependencies & Services ---
import { CONFIG } from './config';
import { auth as firebaseAdminAuth } from './firebase';
const redis = new Redis(CONFIG.REDIS_URL!);

import { ConversationService } from './services/conversation/ConversationService';
import { ToolOrchestrator } from './services/tool/ToolOrchestrator';
import { ProviderAwareToolFilter } from './services/tool/ProviderAwareToolFilter';
import { UserToolCacheService } from './services/tool/UserToolCacheService';
import { SessionRegistry } from './services/SessionRegistry';
import { StreamManager } from './services/stream/StreamManager';
import { NangoService } from './services/NangoService';
import { FollowUpService } from './services/FollowUpService';
import { ToolConfigManager } from './services/tool/ToolConfigManager';
import { PlannerService, ActionPlan, ActionStep } from './services/PlannerService';
import { ActionLauncherService } from './action-launcher.service';
import { RunManager } from './services/tool/RunManager';
import { StreamChunk } from './services/stream/types';
import { ExecuteActionPayload } from './types/actionlaunchertypes';
import { neon } from '@neondatabase/serverless';

// --- Types ---
import { Run, ToolExecutionStep, ToolCall } from './services/tool/run.types';
import { BeatEngine } from './BeatEngine';

import { DataDependencyService } from './services/data/DataDependencyService';
import { Resolver } from './services/data/Resolver';

import { sessionService } from './services/session.service';
import { PlanExecutorService } from './services/PlanExecutorService';
import { ExecutionDecisionService } from './services/ExecutionDecisionService';
// Import interpretive search services for WS support
import { routerService } from './services/router.service';
import { promptGeneratorService } from './services/prompt-generator.service';
import { groqService } from './services/groq.service';
import { responseParserService } from './services/response-parser.service';
import { documentService } from './services/document.service';
import { artifactGeneratorService } from './services/artifact-generator.service';
import { createArtifactsRouter } from './routes/artifacts';
import documentsRouter from './routes/documents';
import exportRouter from './routes/export';
import interpretRouter from './routes/interpret';
import sessionsRouter from './routes/sessions';
import { HistoryService, HistoryItemType } from './services/HistoryService';
import historyRouter from './routes/history';
import { stripeService } from './services/StripeService';
import { revenueCatService } from './services/RevenueCatService';
import { subscriptionService } from './services/SubscriptionService';
import { createWorkflowsRouter } from './routes/workflows';
import { WorkflowComposeRequestSchema, WorkflowSpec } from '@aso/workflow-contracts';
import { WorkflowCatalogService } from './services/workflow/WorkflowCatalogService';
import { WorkflowSpecFactory } from './services/workflow/WorkflowSpecFactory';
import { WorkflowCompilerService } from './services/workflow/WorkflowCompilerService';
import { WorkflowStore } from './services/workflow/WorkflowStore';
import { ArtifactStore } from './services/workflow/ArtifactStore';
import { IntentClassifierService, resolveClassifierModelDirs } from './services/intent/IntentClassifierService';

// --- Service Initialization ---
const groqClient = new Groq({ apiKey: CONFIG.GROQ_API_KEY });
const toolConfigManager = new ToolConfigManager();

// Initialize database connection for provider-aware filtering
if (!CONFIG.DATABASE_URL) {
    logger.error("FATAL: DATABASE_URL environment variable is not set. The application cannot start without it.");
    throw new Error("DATABASE_URL environment variable is not set.");
}
const sql = neon(CONFIG.DATABASE_URL);

// Initialize caching and session tracking services
const userToolCacheService = new UserToolCacheService(redis);
const sessionRegistry = new SessionRegistry(redis);

// Initialize provider-aware filter with cache support
const providerAwareFilter = new ProviderAwareToolFilter(toolConfigManager, sql, userToolCacheService);

const nangoService = new NangoService();
const streamManager = new StreamManager({ logger });
const dataDependencyService = new DataDependencyService();
const resolver = new Resolver(dataDependencyService);
const followUpService = new FollowUpService(groqClient, CONFIG.MODEL_NAME, CONFIG.MAX_TOKENS, redis);
const toolOrchestrator = new ToolOrchestrator({ 
    logger, 
    nangoService, 
    toolConfigManager, 
    dataDependencyService, 
    resolver, 
    redisClient: redis 
});
const plannerService = new PlannerService(CONFIG.GROQ_API_KEY, CONFIG.MAX_TOKENS, toolConfigManager, providerAwareFilter);
const beatEngine = new BeatEngine(toolConfigManager);
const historyService = new HistoryService(redis);
const workflowCatalogService = new WorkflowCatalogService();
const workflowSpecFactory = new WorkflowSpecFactory(workflowCatalogService);
const workflowCompilerService = new WorkflowCompilerService();
const workflowStore = new WorkflowStore(sql);
const workflowArtifactStore = new ArtifactStore(sql);
const workflowIntentClassifier = new IntentClassifierService(path.join(process.cwd(), 'config', 'plan-templates'));
const { intentModelDir, nerModelDir } = resolveClassifierModelDirs();
void workflowIntentClassifier.loadONNXModel(intentModelDir, nerModelDir);

// Initialize circuit breakers for external APIs
const nangoCircuitBreaker = new CircuitBreaker(logger, { failureThreshold: 5, timeout: 60000 });
const groqCircuitBreaker = new CircuitBreaker(logger, { failureThreshold: 5, timeout: 60000 });
const stripeCircuitBreaker = new CircuitBreaker(logger, { failureThreshold: 5, timeout: 60000 });

const conversationService = new ConversationService({
    groqApiKey: CONFIG.GROQ_API_KEY,
    model: CONFIG.MODEL_NAME,
    maxTokens: CONFIG.MAX_TOKENS,
    TOOL_CONFIG_PATH: CONFIG.TOOL_CONFIG_PATH,
    nangoService: nangoService,
    logger: logger,
    redisClient: redis,
    client: groqClient,
    tools: [],
}, providerAwareFilter);

const actionLauncherService = new ActionLauncherService(
    conversationService,
    toolConfigManager,
    beatEngine,
);

const planExecutorService = new PlanExecutorService(actionLauncherService, toolOrchestrator, streamManager, toolConfigManager, groqClient, plannerService, followUpService, historyService);
const executionDecisionService = new ExecutionDecisionService();

// --- CORTEX: Event Automation System ---
import { HybridStore } from './cortex/store';
import { Compiler } from './cortex/compiler';
import { Matcher } from './cortex/matcher';
import { Runtime } from './cortex/runtime';
import { createCortexRouter } from './cortex/routes';
import { CortexToolExecutor } from './cortex/tools';
import { Event as CortexEvent } from './cortex/types';
import { EventShaper } from './cortex/event-shaper';

const cortexStore = new HybridStore(redis, sql);
const cortexCompiler = new Compiler(CONFIG.GROQ_API_KEY);
const cortexMatcher = new Matcher(cortexStore, CONFIG.GROQ_API_KEY);

const toolExecutor = new CortexToolExecutor(toolOrchestrator);
const cortexRuntime = new Runtime(cortexStore, CONFIG.GROQ_API_KEY, toolExecutor, logger);

// Event processor
async function processCortexEvent(event: CortexEvent): Promise<void> {
  try {
    const written = await cortexStore.writeEvent(event);
    if (!written) return; // Deduplicated

    const runs = await cortexMatcher.match(event);

    for (const run of runs) {
      cortexRuntime.execute(run).catch(err => {
        logger.error('Run execution failed', { run_id: run.id, error: err.message });
      });
    }

    logger.info('Event processed', { event_id: event.id, source: event.source, event: event.event, runs: runs.length });
  } catch (err: any) {
    logger.error('Event processing error', { error: err.message });
  }
}

// Initialize EventShaper for webhook-based event generation
const eventShaper = new EventShaper(
  CONFIG.NANGO_SECRET_KEY,
  redis,
  sql,
  processCortexEvent
);

// Scheduler for waiting runs (check every 60 seconds)
setInterval(() => {
  cortexRuntime.resumeWaitingRuns().catch(err => {
    logger.error('Resume waiting runs failed', { error: err.message });
  });
}, 60_000);

// --- Session State Management ---
interface PendingPlan {
    actionPlan: ActionPlan;
    messageId: string;
    runId: string;
    enrichedPlan: any[];
    workflowId?: string;
}

interface SessionState {
    userId: string;
    activeRun?: Run;
    pendingPlan?: PendingPlan;
}
const sessionState: storage.LocalStorage = storage.create({ dir: 'sessions' });
(async () => {
    await sessionState.init();
    await sessionService.init();
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

function buildWorkflowPlanOverview(actionPlan: ActionPlan, messageId: string): any[] {
    return actionPlan.map((step: ActionStep) => {
        const toolDef: any = toolConfigManager.getToolDefinition(step.tool);
        return {
            id: step.id,
            messageId,
            toolName: step.tool,
            toolDisplayName: toolDef?.display_name || toolDef?.name || step.tool,
            description: step.intent,
            status: step.status,
            arguments: step.arguments || {},
            parameters: [],
            missingParameters: [],
            error: null,
            result: null,
            dependsOn: step.dependsOn ?? [],
            workflowStepId: step.workflowStepId,
            artifactSpecId: step.artifactSpecId,
        };
    });
}

async function prepareWorkflowPlan(
    workflow: WorkflowSpec,
    sessionId: string,
    userId: string,
    messageId: string,
    activeConnectionId?: string,
): Promise<{ actionPlan: ActionPlan; run: Run; enrichedPlan: any[] }> {
    const { compiledPlan, actionPlan, artifactSpecs } = workflowCompilerService.compile(workflow);
    await workflowStore.saveWorkflow(workflow, compiledPlan);
    await workflowArtifactStore.saveArtifacts(artifactSpecs);

    const run = RunManager.createRun({
        sessionId,
        userId,
        userInput: workflow.displayText,
        toolExecutionPlan: [],
        connectionId: activeConnectionId,
    });
    run.workflowId = workflow.id;
    run.executionMode = 'dag';
    run.toolExecutionPlan = actionPlan.map((step: ActionStep) => ({
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
        dependsOn: step.dependsOn ?? [],
        workflowStepId: step.workflowStepId,
        artifactSpecId: step.artifactSpecId,
    }));

    return {
        actionPlan,
        run,
        enrichedPlan: buildWorkflowPlanOverview(actionPlan, messageId),
    };
}

// --- WebSocket Server Setup ---
const app = express();

// --- Monitoring Middleware ---
app.use(traceContextMiddleware);
app.use(securityHeadersMiddleware());
app.use(httpLoggingMiddleware(logger));
app.use(globalRateLimiter);
app.use(validateTokenExpiry(logger));

// --- Bootstrap Rate Limiting & Capacity Monitoring ---
setupBootstrapMiddleware(app, redis);

// --- CORS Setup ---
app.use(cors(corsOptionsSecure()));

// --- Body Parser Middleware ---
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// --- Health Check Routes (before other routes) ---
const healthChecks = new Map<string, () => Promise<boolean>>();
healthChecks.set('database', async () => {
  try {
    const result = await sql`SELECT 1`;
    return !!result;
  } catch (err) {
    logger.error('Database health check failed', err as Error);
    return false;
  }
});

healthChecks.set('redis', async () => {
  try {
    await redis.ping();
    return true;
  } catch (err) {
    logger.error('Redis health check failed', err as Error);
    return false;
  }
});

app.use(createHealthRouter(logger, healthChecks));

// --- Bootstrap Monitoring Endpoints ---
app.get('/metrics/bootstrap', (req, res) => {
  try {
    const metrics = bootstrapMonitor.getMetrics();
    res.json({ metrics, timestamp: Date.now() });
  } catch (err) {
    logger.error('Failed to get bootstrap metrics', err as Error);
    res.status(500).json({ error: 'Failed to retrieve metrics' });
  }
});

app.get('/bootstrap-status', (req, res) => {
  try {
    const metrics = bootstrapMonitor.getMetrics();
    const healthStatus = bootstrapMonitor.getHealthStatus();
    const scaling = bootstrapMonitor.getScalingRecommendation();
    res.json({
      status: healthStatus,
      metrics,
      scaling,
      timestamp: Date.now(),
      uptime: process.uptime()
    });
  } catch (err) {
    logger.error('Failed to get bootstrap status', err as Error);
    res.status(500).json({ error: 'Failed to retrieve status' });
  }
});

app.get('/health/detailed', (req, res) => {
  try {
    const metrics = bootstrapMonitor.getMetrics();
    const healthStatus = bootstrapMonitor.getHealthStatus();
    res.json({
      status: 'healthy',
      checks: {
        cpu: { status: metrics.cpu.percent < 85 ? 'ok' : 'warning', value: `${metrics.cpu.percent}%` },
        memory: { status: metrics.memory.percent < 92 ? 'ok' : 'warning', value: `${metrics.memory.percent}%` },
        database: { status: 'ok', connections: metrics.database.active_connections },
        redis: { status: 'ok' },
        uptime: { value: `${Math.floor(process.uptime())}s` }
      },
      metrics,
      timestamp: Date.now()
    });
  } catch (err) {
    logger.error('Failed to get detailed health', err as Error);
    res.status(500).json({ error: 'Health check failed' });
  }
});

// --- API Routes ---
app.use('/api/artifacts', createArtifactsRouter(sql));
app.use('/api/documents', documentsRouter);
app.use('/api/export', exportRouter);
app.use('/api/interpret', interpretRouter);
app.use('/api/sessions', sessionsRouter);
app.locals.historyService = historyService;
app.use('/history', historyRouter);
app.use('/api/workflows', createWorkflowsRouter(sql));

// --- Cortex Routes ---
app.use('/api/cortex', createCortexRouter(cortexStore, cortexCompiler, cortexRuntime));

const CONNECTION_OWNER_TTL_SECONDS = 60 * 60; // 1 hour
const getConnectionOwnerCacheKey = (connectionId: string) => `connection-owner:${connectionId}`;
const getDefaultEmailProviderKey = () => toolConfigManager.getToolDefinition('fetch_emails')?.providerConfigKey || 'google-mail-ynxw';

async function registerConnectionForUser(
    userId: string,
    providerKey: string | undefined,
    connectionId: string
): Promise<{ providerKey: string; providerExists: boolean }> {
    const normalizedProvider = providerKey?.trim();
    const finalProviderKey = normalizedProvider || getDefaultEmailProviderKey();
    const providerExists = toolConfigManager.getAllTools()
        .map(tool => tool.providerConfigKey)
        .filter(Boolean)
        .includes(finalProviderKey);

    await sql`
        INSERT INTO connections (user_id, provider, connection_id)
        VALUES (${userId}, ${finalProviderKey}, ${connectionId})
        ON CONFLICT (user_id, provider) DO UPDATE SET
            connection_id = EXCLUDED.connection_id,
            enabled = true,
            error_count = 0,
            last_poll_at = NOW()
    `;

    await redis.setex(getConnectionOwnerCacheKey(connectionId), CONNECTION_OWNER_TTL_SECONDS, userId);

    return { providerKey: finalProviderKey, providerExists };
}

// Register provider connection
app.post('/api/connections', async (req, res) => {
    try {
        const userId = req.headers['x-user-id'] as string;
        const { provider, connectionId } = req.body;

        if (!userId || !connectionId) {
            return res.status(400).json({ error: 'Missing required fields: userId and connectionId' });
        }

        const { providerKey, providerExists } = await registerConnectionForUser(userId, provider, connectionId);

        if (!providerExists) {
            logger.warn('Provider key not found in tool config', {
                provider: providerKey,
                connectionId: '***',
                userId,
                availableProviders: toolConfigManager.getAllTools()
                    .map(t => t.providerConfigKey)
                    .filter(Boolean)
            });
        }

        logger.info('Connection registered', {
            userId,
            provider: providerKey,
            connectionId: '***',
            providerValid: providerExists
        });

        res.json({ success: true });
    } catch (err: any) {
        logger.error('Connection registration failed', { error: err.message });
        res.status(500).json({ error: err.message });
    }
});

// Get user connections
app.get('/api/connections', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'] as string;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const connections = await sql`
      SELECT id, provider, connection_id, enabled, last_poll_at, error_count, created_at
      FROM connections
      WHERE user_id = ${userId}
    `;

    res.json({ connections });
  } catch (err: any) {
    logger.error('Failed to fetch connections', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// --- Nango Webhook Endpoint ---
// Receives webhooks from Nango when syncs complete
// ENHANCED: Returns 202 Accepted immediately, processes webhook asynchronously
app.post('/api/webhooks/nango', async (req, res) => {
  try {
    const payload = req.body;

    logger.info('Nango webhook received (202 Accepted - async processing)', {
      type: payload.type,
      connectionId: payload.connectionId,
      model: payload.model,
      syncName: payload.syncName,
      hasResponseResults: !!payload.responseResults,
      responseResultsKeys: payload.responseResults ? Object.keys(payload.responseResults) : [],
      addedCount: payload.responseResults?.added?.length || 0,
      updatedCount: payload.responseResults?.updated?.length || 0,
      deletedCount: payload.responseResults?.deleted?.length || 0,
    });

    // ENHANCEMENT 1: Return 202 Accepted immediately (before any processing)
    // This is the key UX improvement - webhook returns to Nango instantly
    // User perceives latency <200ms instead of 2-5 seconds
    res.status(202).json({ 
      status: 'accepted',
      message: 'Webhook received and queued for processing'
    });

    // Process webhook asynchronously in background
    // This doesn't block the 202 response to Nango
    if (payload.type === 'sync') {
      // Fire-and-forget: Process webhook without awaiting
      eventShaper.handleWebhook(payload)
        .then(result => {
          logger.info('Webhook processed successfully (async)', { 
            events_generated: result.processed,
            connectionId: payload.connectionId,
            model: payload.model
          });
        })
        .catch(err => {
          // Log error but don't crash - 202 already sent to Nango
          logger.error('Webhook processing failed (async)', { 
            error: err.message, 
            stack: err.stack,
            connectionId: payload.connectionId,
            model: payload.model,
            type: err.constructor.name
          });
          // TODO: Implement exponential backoff retry queue for failed webhooks
          // Store failed webhook to cortex_webhook_failures table for manual inspection
        });
    } else if (payload.type === 'auth') {
      // Handle auth webhooks - auto-register new connections
      // This ensures connections are always registered even if frontend fails to call /api/connections
      (async () => {
        try {
          const { connectionId, providerConfigKey } = payload;
          
          if (!connectionId || !providerConfigKey) {
            logger.warn('Auth webhook missing required fields', { payload });
            return;
          }

          // Get the userId from the connection via Nango API or Redis cache
          const cachedUserId = await redis.get(`connection-owner:${connectionId}`);
          
          if (cachedUserId) {
            logger.info('Auto-registering connection from auth webhook', {
              userId: cachedUserId,
              connectionId: connectionId.substring(0, 12) + '...',
              provider: providerConfigKey
            });

            // Register the connection
            await registerConnectionForUser(cachedUserId, providerConfigKey, connectionId);

            // Invalidate user's tool cache
            await userToolCacheService.invalidateUserToolCache(cachedUserId);

            logger.info('Connection auto-registered successfully from auth webhook', {
              userId: cachedUserId,
              provider: providerConfigKey
            });
          } else {
            logger.warn('No cached userId found for connection from auth webhook', {
              connectionId: connectionId.substring(0, 12) + '...',
              hint: 'Frontend should call /api/connections POST after OAuth'
            });
          }
        } catch (err: any) {
          logger.error('Failed to auto-register connection from auth webhook', {
            error: err.message,
            stack: err.stack
          });
        }
      })();
    } else {
      logger.warn('Received non-sync webhook type', { type: payload.type });
    }
  } catch (err: any) {
    // Only errors before sending 202 will result in error response
    logger.error('Nango webhook error', { error: err.message, stack: err.stack });
    res.status(500).json({ error: err.message });
  }
});

// --- Create Payment Link Endpoint ---
// Simplified architecture: RevenueCat reads metadata from Stripe subscriptions
// Flow: Frontend → Backend creates link → Stripe → RevenueCat (direct webhook)
app.post('/api/create-payment-link', async (req, res) => {
  try {
    // Extract Firebase ID token from Authorization header
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ 
        success: false,
        error: 'Unauthorized - No token provided' 
      });
    }

    const idToken = authHeader.split('Bearer ')[1];
    
    // Verify the Firebase token
    const decodedToken = await firebaseAdminAuth.verifyIdToken(idToken);
    const firebaseUid = decodedToken.uid;
    const email = decodedToken.email;

    if (!email) {
      return res.status(400).json({
        success: false,
        error: 'Email not found in Firebase token'
      });
    }

        logger.info('Creating payment link', {
            firebaseUid,
            email,
        });

        // Create Stripe payment link with Firebase UID in metadata
        // RevenueCat will read revenuecat_user_id from subscription metadata
        const paymentUrl = await stripeService.createPaymentLinkForUser(
            firebaseUid,
            email
        );

    res.status(200).json({
      success: true,
      url: paymentUrl
    });

  } catch (error: any) {
    logger.error('Failed to create payment link', {
      error: error.message,
      stack: error.stack
    });
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to create payment link'
    });
  }
});

// ============================================
// Public Payment Link Endpoint (Landing Page)
// ============================================
app.post('/api/create-payment-link-public', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email || !email.includes('@')) {
            return res.status(400).json({ error: 'Valid email required' });
        }
        logger.info(`🌐 Public payment link request for: ${email}`);
        // Generate a temporary ID for tracking
        const tempUserId = `temp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        // Create payment link with temporary ID
        const urlWithEmail = await stripeService.createPaymentLinkWithMetadata(
            tempUserId,
            email,
            'landing_page'
        );
        logger.info(`✅ Created public payment link: ${tempUserId}`);
        res.json({ success: true, url: urlWithEmail });
    } catch (error: any) {
        logger.error('Public payment link error', { error: error.message });
        res.status(500).json({ error: 'Failed to create payment link', details: error.message });
    }
});

// ============================================
// Link Subscription After User Signs In
// ============================================
app.post('/api/link-subscription', async (req, res) => {
    try {
        const { firebaseUid, email, tempUserId } = req.body;
        // Verify Firebase token
        const authHeader = req.headers.authorization;
        if (!authHeader?.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Missing authorization token' });
        }
        const token = authHeader.split('Bearer ')[1];
        const decodedToken = await firebaseAdminAuth.verifyIdToken(token);
        if (decodedToken.uid !== firebaseUid) {
            return res.status(403).json({ error: 'Unauthorized' });
        }
        logger.info(`🔗 Linking subscription for ${email} to ${firebaseUid}`);
        // Call RevenueCat API to transfer subscription from temp ID to real Firebase UID
        // This requires RevenueCat's REST API and secret key
        const revenuecatSecret = process.env.REVENUECAT_SECRET_KEY || process.env.REVENUCAT_API_KEY;
        if (!revenuecatSecret) {
            logger.error('REVENUECAT_SECRET_KEY is not set');
            return res.status(500).json({ error: 'RevenueCat secret key not configured' });
        }
        // Transfer all subscriptions from tempUserId to firebaseUid
        const transferUrl = `https://api.revenuecat.com/v1/subscribers/${tempUserId}/alias`;
        const transferResp = await fetch(transferUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${revenuecatSecret}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ new_app_user_id: firebaseUid })
        });
        if (!transferResp.ok) {
            const errText = await transferResp.text();
            logger.error('RevenueCat transfer failed', { status: transferResp.status, errText });
            return res.status(500).json({ error: 'Failed to link subscription', details: errText });
        }
        // Optionally, update email attribute
        const attrUrl = `https://api.revenuecat.com/v1/subscribers/${firebaseUid}/attributes`;
        await fetch(attrUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${revenuecatSecret}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ attributes: { email: { value: email } } })
        });
        res.json({ success: true });
    } catch (error: any) {
        logger.error('Link subscription error', { error: error.message });
        res.status(500).json({ error: 'Failed to link subscription', details: error.message });
    }
});

// --- Success Page Endpoint ---
app.get('/success', (req, res) => {
  try {
    const email = req.query.email ? `?email=${encodeURIComponent(req.query.email as string)}` : '';
    // Serve the success page - in production, this would be served from a React build
    // For now, return HTML with embedded React component or redirect to frontend
    const html = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Purchase Successful!</title>
        <link rel="stylesheet" href="/success.css">
      </head>
      <body>
        <div id="root"></div>
        <script src="/success.js"></script>
      </body>
      </html>
    `;
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (error: any) {
    logger.error('Success page error', { error: error.message });
    res.status(500).json({ error: 'Failed to load success page' });
  }
});

// --- Stripe Webhook Endpoint (Optional - For Audit Logging Only) ---
// NOTE: In simplified architecture, main webhooks go directly to RevenueCat
// This endpoint is optional and only for local audit logging if needed
app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const signature = req.headers['stripe-signature'] as string;
    const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);

    // Verify webhook came from Stripe (optional)
    const event = stripeService.verifyWebhookSignature(body, signature);
    if (!event) {
      logger.warn('Stripe webhook signature verification failed');
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Log the event for audit purposes
    logger.info('Stripe webhook received (audit log only)', {
      eventType: event.type,
      eventId: event.id,
      note: 'Main processing happens in RevenueCat'
    });

    // Return 200 OK immediately
    res.status(200).json({ received: true });

  } catch (err: any) {
    logger.error('Stripe webhook error', {
      error: err.message,
      stack: err.stack
    });
    // Always return 200 to prevent Stripe retries
    res.status(200).json({ error: 'processed with error' });
  }
});

// --- Subscription Info Endpoint (Optional) ---
// In simplified architecture, frontend should check RevenueCat SDK directly
// This endpoint is optional and mainly for debugging
app.get('/api/subscription', async (req, res) => {
  try {
    // Extract Firebase token
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized - No token provided' });
    }

    const idToken = authHeader.split('Bearer ')[1];
    const decodedToken = await firebaseAdminAuth.verifyIdToken(idToken);
    const firebaseUid = decodedToken.uid;

    // Check RevenueCat for entitlements (source of truth)
    const isSubscribed = await revenueCatService.isUserSubscribed(firebaseUid);
    const activeEntitlements = await revenueCatService.getActiveEntitlements(firebaseUid);

    res.json({
      success: true,
      isSubscribed,
      entitlements: activeEntitlements
    });
  } catch (err: any) {
    logger.error('Failed to get subscription info', { error: err.message });
    res.status(500).json({ 
      success: false,
      error: err.message 
    });
  }
});

// --- Debug Endpoint: Force Sync ---
// Manually trigger a Nango sync for testing
app.post('/api/debug/force-sync', async (req, res) => {
  try {
    const { provider, connectionId, syncName } = req.body;

    if (!provider || !connectionId || !syncName) {
      return res.status(400).json({
        error: 'Missing required fields: provider, connectionId, syncName',
      });
    }

    // Skip actual Nango call for test connections
    if (connectionId.startsWith('test-connection')) {
      logger.info('Skipping Nango API call for test connection', { connectionId });
      return res.json({
        success: true,
        message: `Test sync "${syncName}" acknowledged (no actual sync triggered).`,
      });
    }

    logger.info('Manually triggering sync', { provider, connectionId, syncName });

    await nangoService.triggerSync(provider, connectionId, syncName);

    res.json({
      success: true,
      message: `Sync "${syncName}" triggered successfully. Check webhook endpoint for results.`,
    });
  } catch (err: any) {
    logger.error('Force sync failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Add HTTP metrics middleware
app.use((req, res, next) => {
  const contentLength = parseInt(req.get('content-length') || '0');
  if (contentLength > 0) {
    httpRequestSize.observe({ method: req.method, route: req.path }, contentLength);
  }

  const originalSend = res.send;
  res.send = function (data) {
    const responseSize = Buffer.byteLength(JSON.stringify(data));
    httpResponseSize.observe(
      { method: req.method, route: req.path, status_code: res.statusCode },
      responseSize
    );
    return originalSend.call(this, data);
  };

  const start = Date.now();
  res.on('finish', () => {
    const duration = (Date.now() - start) / 1000;
    httpRequestDuration.observe(
      { method: req.method, route: req.path, status_code: res.statusCode },
      duration
    );
    httpRequestsTotal.inc({ method: req.method, route: req.path, status_code: res.statusCode });
  });

  next();
});

// Global error handler
app.use(secureErrorHandler(logger));

const server = createServer(app);
const wss = new WebSocketServer({ server });

actionLauncherService.on('send_chunk', (sessionId: string, chunk: StreamChunk) => {
    streamManager.sendChunk(sessionId, chunk);
});

// Connect PlannerService to StreamManager
plannerService.on('send_chunk', (sessionId: string, chunk: StreamChunk) => {
    streamManager.sendChunk(sessionId, chunk);
});

// Connect ConversationService to StreamManager
conversationService.on('send_chunk', (sessionId: string, chunk: StreamChunk) => {
    streamManager.sendChunk(sessionId, chunk);
});

// Helper function to notify user of tool changes across all their active sessions
async function notifyUserOfToolChanges(userId: string): Promise<void> {
    try {
        const activeSessions = await sessionRegistry.getActiveSessionsForUser(userId);
        const availableTools = await providerAwareFilter.getAvailableToolsForUser(userId);

        logger.info('Notifying user of tool changes', {
            userId,
            sessionCount: activeSessions.length,
            toolCount: availableTools.length,
        });

        for (const sessionId of activeSessions) {
            streamManager.sendChunk(sessionId, {
                type: 'tools_updated',
                content: { tools: availableTools }
            } as unknown as StreamChunk);
        }
    } catch (error) {
        logger.error('Error notifying user of tool changes', {
            userId,
            error: error instanceof Error ? error.message : 'Unknown error',
        });
    }
}

wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const sessionId = req.url?.slice(1) || uuidv4();
    streamManager.addConnection(sessionId, ws);
    logger.info('Client connected', { sessionId });

    // Send connection confirmation to the client
    // Note: Tools will be sent after authentication when we know the userId
    streamManager.sendChunk(sessionId, { type: 'connection_ack', content: { sessionId } } as unknown as StreamChunk);

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

        // Register session for this user
        await sessionRegistry.registerUserSession(userId, sessionId);

        streamManager.sendChunk(sessionId, { type: 'auth_success', content: { userId } } as unknown as StreamChunk);
        logger.info('Client authenticated', { userId, sessionId });

        // Send provider-aware tools to the client
        try {
            const availableTools = await providerAwareFilter.getAvailableToolsForUser(userId);
            streamManager.sendChunk(sessionId, {
                type: 'session_init',
                content: {
                    sessionId: sessionId,
                    tools: availableTools,
                }
            } as unknown as StreamChunk);
            logger.info('Sent provider-aware tools to client', { userId, toolCount: availableTools.length });
        } catch (toolError: any) {
            logger.error('Error sending provider-aware tools', { userId, error: toolError.message });
        }

        // Warm connections
        try {
            const activeConnectionId = await redis.get(`active-connection:${userId}`);
            if (activeConnectionId) {
                // Get the actual provider config key for gmail tools from tool-config.json
                const emailTool = toolConfigManager.getToolDefinition('fetch_emails');
                const gmailProviderKey = emailTool?.providerConfigKey || 'google-mail-ynxw';

                logger.info('Warming Gmail connection post-auth', {
                    userId,
                    connectionId: '***',
                    providerKey: gmailProviderKey
                });

                await nangoService.warmConnection(gmailProviderKey, activeConnectionId);
            }
        } catch (warmError: any) {
            logger.warn('Post-auth connection warming failed', { userId, error: warmError.message });
        }
    } else {
        // Handle unauthenticated session for development/testing
        userId = `unauthenticated-user-${uuidv4()}`;
        await sessionState.setItem(sessionId, { userId });

        // Register session for unauthenticated user
        await sessionRegistry.registerUserSession(userId, sessionId);

        streamManager.sendChunk(sessionId, { type: 'auth_success', content: { userId } } as unknown as StreamChunk);
        logger.info('Unauthenticated session created', { userId, sessionId });

        // Send empty tools for unauthenticated users
        streamManager.sendChunk(sessionId, {
            type: 'session_init',
            content: {
                sessionId: sessionId,
                tools: [],
            }
        } as unknown as StreamChunk);
    }
    return;
}

        // --- GET SESSION STATE ---
        const state = (await sessionState.getItem(sessionId)) as SessionState;
        if (!state) throw new Error('Not authenticated');
        const { userId } = state;

        // --- CONFIRM WORKFLOW PLAN ---
        if (data.type === 'confirm_plan') {
            const pending = state.pendingPlan;
            const run = state.activeRun;
            if (!pending || !run) {
                streamManager.sendChunk(sessionId, {
                    type: 'error',
                    content: 'No pending plan to confirm.',
                } as unknown as StreamChunk);
                return;
            }

            state.pendingPlan = undefined;
            await sessionState.setItem(sessionId, state);
            await actionLauncherService.processActionPlan(
                pending.actionPlan,
                sessionId,
                userId,
                pending.messageId,
                toolOrchestrator,
                run,
            );

            const completedRun = await planExecutorService.executePlan(run, userId);
            state.activeRun = completedRun;
            await sessionState.setItem(sessionId, state);
            return;
        }

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

            // 1. Execute just the single action that was confirmed.
            const completedAction = await actionLauncherService.executeAction(
                sessionId,
                userId,
                actionPayload,
                toolOrchestrator,
                currentRun.planId, // Pass planId
                step.stepId         // Pass stepId
            );

            // 2. Find and update the specific step in the run object with the result.
            const stepIndex = currentRun.toolExecutionPlan.findIndex(s => s.stepId === step.stepId);
            if (stepIndex !== -1) {
                currentRun.toolExecutionPlan[stepIndex].status = completedAction.status;
                currentRun.toolExecutionPlan[stepIndex].result = { status: completedAction.status === 'completed' ? 'success' : 'failed', toolName: completedAction.toolName, data: completedAction.result, error: completedAction.error };
                currentRun.toolExecutionPlan[stepIndex].finishedAt = new Date().toISOString();
            }

            // 3. Hand off the updated run to the PlanExecutorService to continue the rest of the plan.
            // The executor is smart enough to skip the step that was just completed.
            const completedRun = await planExecutorService.executePlan(currentRun, userId);

            // 4. Save the final state of the run after the entire plan is complete.
            state.activeRun = completedRun;
            await sessionState.setItem(sessionId, state);
            
            // 5. Generate final summary if plan is complete
            if (completedRun.status === 'completed' && !completedRun.assistantResponse) {
                logger.info('Execute action: Plan completed, generating final summary', {
                    sessionId,
                    runId: completedRun.id,
                    planLength: completedRun.toolExecutionPlan.length
                });

                // Add tool results to history
                completedRun.toolExecutionPlan.forEach(step => {
                    if (step.result) {
                        logger.info('Adding tool result to history', {
                            stepId: step.stepId,
                            toolName: step.toolCall.name,
                            status: step.status
                        });

                        const resultData = step.status === 'failed'
                            ? {
                                status: 'failed',
                                error: step.result.error || 'Unknown error',
                                errorDetails: step.result.errorDetails,
                                ...step.result.data
                            }
                            : step.result.data;

                        conversationService.addToolResultMessageToHistory(
                            sessionId,
                            step.toolCall.id,
                            step.toolCall.name,
                            resultData
                        );
                    }
                });

                // Generate summary
                logger.info('Requesting final summary from LLM', { sessionId });
                const finalResponseResult = await conversationService.processMessageAndAggregateResults(
                    null, // No new user message, forces summary mode
                    sessionId,
                    uuidv4(),
                    userId
                );

                logger.info('Final response result received', {
                    sessionId,
                    hasResponse: !!finalResponseResult.conversationalResponse,
                    responseLength: finalResponseResult.conversationalResponse?.length || 0
                });

                if (finalResponseResult.conversationalResponse?.trim()) {
                    await streamText(sessionId, uuidv4(), finalResponseResult.conversationalResponse);

                    try {
                        await historyService.recordAssistantMessage(
                            userId,
                            sessionId,
                            finalResponseResult.conversationalResponse
                        );
                        logger.info('Final response recorded in history', { sessionId });
                    } catch (error: any) {
                        logger.warn('Failed to record assistant message', { error: error.message });
                    }

                    // Mark that response was generated
                    completedRun.assistantResponse = finalResponseResult.conversationalResponse;
                    state.activeRun = completedRun;
                    await sessionState.setItem(sessionId, state);
                }
            }
        }

        // --- UPDATE PARAMETER (FROM CLIENT) ---
        if (data.type === 'update_parameter' && data.content) {
            // This calls the method in ActionLauncherService which will validate the parameter,
            // update the action's state, and emit an 'action_ready_for_confirmation' or
            // 'parameter_collection_required' event back to the client.
            actionLauncherService.updateParameterValue(sessionId, data.content);
            // No need to send anything back here; the service emits the necessary events.
            return;
        }

        // --- UPDATE ACTIVE CONNECTION ---
        if (data.type === 'update_active_connection' && data.content) {
            const { connectionId, provider, providerConfigKey } = data.content as { connectionId?: string; provider?: string; providerConfigKey?: string };
            if (!userId || !connectionId) return;

            await redis.set(`active-connection:${userId}`, connectionId);
            logger.info('Successfully set active Nango connection for user', { userId });

            // Invalidate user's tool cache since connections changed
            await userToolCacheService.invalidateUserToolCache(userId);

            // Fetch fresh available tools
            const availableTools = await providerAwareFilter.getAvailableToolsForUser(userId);

            // Ensure we persist this connection in the canonical table before warming it
            let providerKeyToWarm = provider ?? providerConfigKey;
            try {
                const registration = await registerConnectionForUser(userId, providerKeyToWarm, connectionId);
                providerKeyToWarm = registration.providerKey;

                if (!registration.providerExists) {
                    logger.warn('Active connection uses unknown provider key', {
                        userId,
                        provider: providerKeyToWarm,
                        connectionId: '***'
                    });
                }
            } catch (registrationError: any) {
                providerKeyToWarm = getDefaultEmailProviderKey();
                logger.error('Failed to persist active connection', {
                    userId,
                    connectionId: '***',
                    error: registrationError.message
                });
            }

            try {
                logger.info('Warming active connection', {
                    userId,
                    connectionId: '***',
                    providerKey: providerKeyToWarm
                });

                const warmSuccess = await nangoService.warmConnection(providerKeyToWarm, connectionId);

                // Send updated tools and connection status to client
                streamManager.sendChunk(sessionId, {
                    type: 'tools_updated',
                    content: {
                        tools: availableTools,
                        warmed: warmSuccess
                    }
                } as unknown as StreamChunk);

                logger.info('Connection updated and tools refreshed', {
                    userId,
                    toolCount: availableTools.length,
                    warmed: warmSuccess
                });

                // Notify all other active sessions for this user
                await notifyUserOfToolChanges(userId);
            } catch (error: any) {
                logger.error('Connection warming on update failed', {
                    userId,
                    connectionId: '***',
                    providerKey: providerKeyToWarm,
                    error: error.message
                });
                streamManager.sendChunk(sessionId, {
                    type: 'tools_updated',
                    content: {
                        tools: availableTools,
                        warmed: false
                    }
                } as unknown as StreamChunk);
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

            try {
                const planTitle = `Rerun: ${savedPlan.length} actions`;
                const actions = savedPlan.map((step: any) => ({
                    toolName: step.toolName,
                    description: step.description
                }));
                
                const historyId = await historyService.recordPlanCreation(
                    userId,
                    sessionId,
                    run.id,
                    planTitle,
                    actions
                );
                
                (run as any).historyId = historyId;
            } catch (error: any) {
                logger.warn('Failed to record rerun in history', { error: error.message });
            }

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

            // 7. Check if the plan can be auto-executed using centralized decision logic
            const actions = actionLauncherService.getActiveActions(sessionId);
            const planAnalysis = executionDecisionService.analyzePlan(
              actions.map(a => ({
                name: a.toolName,
                status: a.status,
                arguments: a.arguments || a.parameters
              }))
            );
            const decision = executionDecisionService.shouldAutoExecute(planAnalysis);

            logger.info('Rerun execution decision', {
                sessionId,
                decision,
                actionCount: actions.length
            });

            if (decision.shouldAutoExecute) {
                logger.info('Auto-executing rerun plan', {
                    sessionId,
                    runId: run.id,
                    reason: decision.reason
                });
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

        // --- TYPED WORKFLOW HANDLER ---
        if (data.type === 'workflow_compose') {
            const messageId = uuidv4();
            const parsed = WorkflowComposeRequestSchema.safeParse(data.content ?? data.workflow);
            if (!parsed.success) {
                streamManager.sendChunk(sessionId, {
                    type: 'error',
                    content: `Invalid workflow payload: ${parsed.error.issues.map(issue => issue.message).join(', ')}`,
                    messageId,
                    isFinal: true,
                } as StreamChunk);
                return;
            }

            try {
                const activeConnectionId = await redis.get(`active-connection:${userId}`) || undefined;
                const workflow = workflowSpecFactory.fromComposeRequest(parsed.data, { userId, sessionId });
                const { actionPlan, run, enrichedPlan } = await prepareWorkflowPlan(
                    workflow,
                    sessionId,
                    userId,
                    messageId,
                    activeConnectionId,
                );

                state.activeRun = run;
                state.pendingPlan = {
                    actionPlan,
                    messageId,
                    runId: run.id,
                    enrichedPlan,
                    workflowId: workflow.id,
                };
                await sessionState.setItem(sessionId, state);
                streamManager.sendChunk(sessionId, { type: 'run_updated', content: run });
                streamManager.sendChunk(sessionId, {
                    type: 'plan_generated',
                    content: {
                        messageId,
                        workflowId: workflow.id,
                        workflowSpec: workflow,
                        planOverview: enrichedPlan,
                        analysis: `${enrichedPlan.length} actions ready from typed workflow. Review and confirm to run.`,
                        requiresConfirmation: true,
                        runId: run.id,
                    },
                    messageId,
                    isFinal: true,
                } as StreamChunk);
            } catch (error: any) {
                logger.error('Failed to prepare typed workflow', { sessionId, userId, error: error?.message ?? error });
                streamManager.sendChunk(sessionId, {
                    type: 'error',
                    content: 'Unable to prepare this workflow right now.',
                    messageId,
                    isFinal: true,
                } as StreamChunk);
            }
            return;
        }

        // --- CONTENT HANDLER / PLAN GENERATION ---
        if (data.type === 'content' && typeof data.content === 'string') {
            const messageId = uuidv4();
            logger.info('Processing user message', { sessionId, userId, messageId });

            try {
                await historyService.recordUserMessage(userId, sessionId, data.content);
            } catch (error: any) {
                logger.warn('Failed to record user message in history', { error: error.message });
            }

            const classifiedWorkflow = await workflowIntentClassifier.classifyKnownWorkflow(data.content);
            const recoveredWorkflow = classifiedWorkflow && classifiedWorkflow.confidence >= 0.85
                ? workflowSpecFactory.fromClassification(classifiedWorkflow, data.content, { userId, sessionId })
                : null;

            if (recoveredWorkflow) {
                const activeConnectionId = await redis.get(`active-connection:${userId}`) || undefined;
                const { actionPlan, run, enrichedPlan } = await prepareWorkflowPlan(
                    recoveredWorkflow,
                    sessionId,
                    userId,
                    messageId,
                    activeConnectionId,
                );

                state.activeRun = run;
                state.pendingPlan = {
                    actionPlan,
                    messageId,
                    runId: run.id,
                    enrichedPlan,
                    workflowId: recoveredWorkflow.id,
                };
                await sessionState.setItem(sessionId, state);
                streamManager.sendChunk(sessionId, { type: 'run_updated', content: run });
                streamManager.sendChunk(sessionId, {
                    type: 'plan_generated',
                    content: {
                        messageId,
                        workflowId: recoveredWorkflow.id,
                        workflowSpec: recoveredWorkflow,
                        planOverview: enrichedPlan,
                        analysis: `${enrichedPlan.length} actions ready from recognized workflow. Review and confirm to run.`,
                        requiresConfirmation: true,
                        runId: run.id,
                    },
                    messageId,
                    isFinal: true,
                } as StreamChunk);
                return;
            }

            const processedResult = await conversationService.processMessageAndAggregateResults(
                data.content,
                sessionId,
                messageId,
                userId  // Pass userId for provider-aware filtering
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
                // CRITICAL FIX: Pass the full user message to the planner so it can see ALL relevant context
                // The planner's internal prompt will handle tool selection based on the full request
                const actionPlan: ActionPlan = await plannerService.generatePlanWithStepAnnouncements(
                  data.content,  // Full user message
                  toolsForPlanning,
                  sessionId,
                  messageId,
                  userId  // Pass userId for provider-aware filtering
                );

                if (actionPlan && actionPlan.length > 0) {
                    await actionLauncherService.processActionPlan(actionPlan, sessionId, userId, messageId, toolOrchestrator, run);
                    
                    try {
                        const planTitle = data.content.substring(0, 100); // Use first 100 chars of request
                        const actions = actionPlan.map(step => ({
                            toolName: step.tool,
                            description: step.intent
                        }));
                        
                        const historyId = await historyService.recordPlanCreation(
                            userId,
                            sessionId,
                            run.id,
                            planTitle,
                            actions
                        );
                        
                        (run as any).historyId = historyId;
                        logger.info('Plan recorded in history', { sessionId, historyId, planId: run.id });
                    } catch (error: any) {
                        logger.warn('Failed to record plan in history', { error: error.message });
                    }

                    const actions = actionLauncherService.getActiveActions(sessionId);
                    const planAnalysis = executionDecisionService.analyzePlan(
                      actions.map(a => ({
                        name: a.toolName,
                        status: a.status,
                        arguments: a.arguments || a.parameters
                      }))
                    );
                    const decision = executionDecisionService.shouldAutoExecute(planAnalysis);

                    logger.info('Multi-step plan execution decision', {
                        sessionId,
                        decision,
                        actionCount: actions.length
                    });

                    if (decision.shouldAutoExecute) {
                        logger.info('Auto-executing multi-step plan', {
                            sessionId,
                            runId: run.id,
                            reason: decision.reason
                        });
                        // --- FIX: Capture the completed run object and update session state ---
                        const completedRun = await planExecutorService.executePlan(run, userId);
                        state.activeRun = completedRun;
                        await sessionState.setItem(sessionId, state);
                        
                        // After auto-execution, generate a final summary response.
                        // This check is now handled by the UNIFIED FINAL RESPONSE LOGIC block
                        /*
                        if (completedRun.status === 'completed') {
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
                        }*/

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
                const planAnalysis = executionDecisionService.analyzePlan(
                  actions.map(a => ({
                    name: a.toolName,
                    status: a.status,
                    arguments: a.arguments || a.parameters
                  }))
                );
                const decision = executionDecisionService.shouldAutoExecute(planAnalysis);

                logger.info('Single-step plan execution decision', {
                    sessionId,
                    decision,
                    actionCount: actions.length
                });

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


                if (decision.shouldAutoExecute) {
                    logger.info('Auto-executing single action', {
                        sessionId,
                        runId: run.id,
                        reason: decision.reason
                    });
                    // Capture the updated run object returned by the executor
                    // --- FIX: Capture the completed run object and update session state ---
                    const completedRunAfterExec = await planExecutorService.executePlan(run, userId);
                    state.activeRun = completedRunAfterExec;
                    await sessionState.setItem(sessionId, state);
                    // --- END OF FIX ---

                } else if (decision.needsUserInput) {
                    logger.info('Single action requires user input before execution', {
                        sessionId,
                        reason: decision.reason
                    });
                    // The 'parameter_collection_required' event is fired by ActionLauncherService,
                    // and we have already sent the plan_generated event above.
                } else if (decision.needsConfirmation) {
                    logger.info('Single action requires user confirmation', {
                        sessionId,
                        reason: decision.reason
                    });
                    // Send confirmation required event with execute button
                    streamManager.sendChunk(sessionId, {
                        type: 'action_confirmation_required',
                        plan_id: run.id,
                        actions: enrichedPlan,
                        message: decision.reason,
                        showExecuteButton: true,
                        autoExecute: false
                    } as StreamChunk);
                }

            }

            // --- UNIFIED FINAL RESPONSE LOGIC ---
            // This block runs after any auto-execution (single or multi-step) is complete.
            const finalRunState = (await sessionState.getItem(sessionId) as SessionState)?.activeRun;

            // Handle completed runs that need a final response
            if (finalRunState && finalRunState.status === 'completed' && !finalRunState.assistantResponse) {
                logger.info('Auto-execution complete, generating final context-aware response.', {
                    sessionId,
                    runId: finalRunState.id,
                    planLength: finalRunState.toolExecutionPlan.length
                });

                // Add ALL tool results to history (including failures) to give LLM complete context
                finalRunState.toolExecutionPlan.forEach(step => {
                    if (step.result) {
                        logger.info('Adding tool result to history', {
                            stepId: step.stepId,
                            toolName: step.toolCall.name,
                            status: step.status
                        });

                        // Include error details for failed steps so LLM can provide context
                        const resultData = step.status === 'failed'
                            ? {
                                status: 'failed',
                                error: step.result.error || 'Unknown error',
                                errorDetails: step.result.errorDetails,
                                ...step.result.data
                            }
                            : step.result.data;

                        conversationService.addToolResultMessageToHistory(
                            sessionId,
                            step.toolCall.id,
                            step.toolCall.name,
                            resultData
                        );
                    }
                });

                // Get the final summary from the LLM
                logger.info('Requesting final summary from LLM', { sessionId });
                let finalResponseResult = await conversationService.processMessageAndAggregateResults(
                    null, // No new user message, forces summary mode
                    sessionId,
                    uuidv4(),
                    userId
                );

                logger.info('Final response result received', {
                    sessionId,
                    hasResponse: !!finalResponseResult.conversationalResponse,
                    responseLength: finalResponseResult.conversationalResponse?.length || 0
                });

                // If LLM returned empty response, retry once with explicit prompt
                if (!finalResponseResult.conversationalResponse?.trim()) {
                    logger.warn('First summary attempt returned empty, retrying with explicit prompt', {
                        sessionId,
                        runId: finalRunState.id
                    });

                    finalResponseResult = await conversationService.processMessageAndAggregateResults(
                        "Please provide a warm, conversational summary of what you just accomplished based on the tool results above.",
                        sessionId,
                        uuidv4(),
                        userId
                    );

                    logger.info('Retry response result received', {
                        sessionId,
                        hasResponse: !!finalResponseResult.conversationalResponse,
                        responseLength: finalResponseResult.conversationalResponse?.length || 0
                    });
                }

                if (finalResponseResult.conversationalResponse?.trim()) {
                    await streamText(sessionId, uuidv4(), finalResponseResult.conversationalResponse);

                    try {
                        await historyService.recordAssistantMessage(
                            userId,
                            sessionId,
                            finalResponseResult.conversationalResponse
                        );
                        logger.info('Final response recorded in history', { sessionId });
                    } catch (error: any) {
                        logger.warn('Failed to record assistant message', { error: error.message });
                    }

                    finalRunState.assistantResponse = finalResponseResult.conversationalResponse; // Mark that response was generated
                    await sessionState.setItem(sessionId, { userId, activeRun: finalRunState });
                    logger.info('Run state updated with assistant response', { sessionId });
                } else {
                    // LLM failed to generate a summary, provide a simple fallback
                    logger.warn('No final conversational response generated after tool execution, using fallback', {
                        sessionId,
                        runId: finalRunState.id
                    });

                    const fallbackMessage = "The actions have been completed successfully.";
                    await streamText(sessionId, uuidv4(), fallbackMessage);

                    try {
                        await historyService.recordAssistantMessage(
                            userId,
                            sessionId,
                            fallbackMessage
                        );
                    } catch (error: any) {
                        logger.warn('Failed to record fallback message', { error: error.message });
                    }

                    finalRunState.assistantResponse = fallbackMessage;
                    await sessionState.setItem(sessionId, { userId, activeRun: finalRunState });
                }
            } else if (!conversationalResponse && executableToolCount === 0 && !isPlanRequest) {
                // Only show fallback if no conversational response was generated, no tools were called,
                // and there's no completed run waiting for a response
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

                // --- PROGRESSIVE STREAMING: Emit title as soon as available ---
                if (interpretiveResponse.hero?.headline) {
                    send('title_generated', { title: interpretiveResponse.hero.headline });
                }

                // --- PROGRESSIVE STREAMING: Emit subtitle if available ---
                if (interpretiveResponse.hero?.subheadline) {
                    send('subtitle_generated', { subtitle: interpretiveResponse.hero.subheadline });
                }

                // --- PROGRESSIVE STREAMING: Emit hero image if available ---
                if (interpretiveResponse.hero?.imageUrl) {
                    send('hero_image_set', { hero: interpretiveResponse.hero });
                }

                // --- PROGRESSIVE STREAMING: Emit each initial segment individually ---
                for (const segment of interpretiveResponse.segments || []) {
                    send('segment_added', { segment });
                }

                // --- PROGRESSIVE STREAMING: Emit each initial source individually ---
                for (const source of interpretiveResponse.sources || []) {
                    send('source_added', { source });
                }

                // --- PROGRESSIVE STREAMING: Emit image segments as they are found ---
                const imageSegments = (interpretiveResponse.segments || []).filter(s => s.type === 'image');
                for (const imageSegment of imageSegments) {
                    send('image_added', { image: imageSegment });
                }

                // --- PROGRESSIVE STREAMING: Emit image candidates from hero ---
                if (Array.isArray(interpretiveResponse.hero?.imageCandidates)) {
                    for (const imageCandidate of interpretiveResponse.hero.imageCandidates) {
                        send('image_added', { image: imageCandidate });
                    }
                }

                // --- PROGRESSIVE STREAMING: Send initial metadata ---
                const imageCount = imageSegments.length + (interpretiveResponse.hero?.imageCandidates?.length || 0);
                send('metadata_update', {
                    metadata: {
                        segmentCount: interpretiveResponse.segments?.length || 0,
                        sourceCount: interpretiveResponse.sources?.length || 0,
                        imageCount,
                        processingTimeMs: interpretiveResponse.metadata.processingTimeMs
                    }
                });

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

                        // --- PROGRESSIVE STREAMING: Track newly added sources and segments ---
                        let newSourcesCount = 0;
                        let newSegmentsCount = 0;

                        // Merge sources and emit events for new ones
                        const localToGlobal = new Map<number, number>();
                        parsed.sources.forEach((s, idx) => {
                            const exIndex = interpretiveResponse.sources.findIndex((e: any) => e.url === s.url);
                            if (exIndex >= 0) {
                                localToGlobal.set(idx + 1, exIndex + 1);
                            } else {
                                const newSource = { ...s, index: interpretiveResponse.sources.length + 1 };
                                interpretiveResponse.sources.push(newSource);
                                localToGlobal.set(idx + 1, interpretiveResponse.sources.length);

                                // --- PROGRESSIVE STREAMING: Emit new source immediately ---
                                send('source_added', { source: newSource });
                                newSourcesCount++;
                            }
                        });

                        // Merge segments, re-map indices, and emit events for new ones
                        parsed.segments.forEach((seg) => {
                            // Re-map source indices
                            if (seg.type === 'context' && Array.isArray((seg as any).sourceIndices)) {
                                (seg as any).sourceIndices = (seg as any).sourceIndices.map((i: number) => localToGlobal.get(i) ?? i);
                            }
                            if (seg.type === 'quote' && typeof (seg as any).sourceIndex === 'number') {
                                (seg as any).sourceIndex = localToGlobal.get((seg as any).sourceIndex) ?? (seg as any).sourceIndex;
                            }

                            interpretiveResponse.segments.push(seg);

                            // --- PROGRESSIVE STREAMING: Emit new segment immediately ---
                            send('segment_added', { segment: seg });
                            newSegmentsCount++;

                            // --- PROGRESSIVE STREAMING: If it's an image segment, emit image_added too ---
                            if (seg.type === 'image') {
                                send('image_added', { image: seg });
                            }
                        });

                        // --- PROGRESSIVE STREAMING: Emit image candidates from enrichment ---
                        if (Array.isArray(parsed.imageCandidates)) {
                            for (const imageCandidate of parsed.imageCandidates) {
                                send('image_added', { image: imageCandidate });
                            }
                        }

                        send('enrichment_complete', { key: def.key, segmentsAdded: newSegmentsCount, sourcesAdded: newSourcesCount });
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
                        send('artifact_generated', { hasArtifact: true, artifact });
                    }
                }

                // --- PROGRESSIVE STREAMING: Send final metadata update ---
                const finalImageCount = (interpretiveResponse.segments || []).filter(s => s.type === 'image').length +
                    (interpretiveResponse.hero?.imageCandidates?.length || 0);
                send('metadata_update', {
                    metadata: {
                        segmentCount: interpretiveResponse.metadata.segmentCount,
                        sourceCount: interpretiveResponse.metadata.sourceCount,
                        imageCount: finalImageCount,
                        processingTimeMs: Date.now() - startTime,
                        groqModel: interpretiveResponse.metadata.groqModel,
                        groqTokens: interpretiveResponse.metadata.groqTokens
                    }
                });

                // --- PROGRESSIVE STREAMING: Lightweight complete event (no duplicate payload) ---
                send('complete', {
                    requestId,
                    status: 'complete',
                    responseId: interpretiveResponse.id,
                    timestamp: interpretiveResponse.timestamp
                });
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

    } catch (error: any) {
        logger.error('Fatal error in WebSocket handler', { error: error.message, stack: error.stack, sessionId });
        if (ws.readyState === ws.OPEN) {
            streamManager.sendChunk(sessionId, { type: 'error', content: `Server Error: ${error.message}` });
        }
    }
});


    ws.on('close', async () => {
        logger.info('Client disconnected', { sessionId });

        // Get user ID before removing session state
        const state = (await sessionState.getItem(sessionId)) as SessionState;
        if (state?.userId) {
            // Unregister session from SessionRegistry
            await sessionRegistry.unregisterUserSession(state.userId, sessionId);
            logger.info('Session unregistered from registry', { userId: state.userId, sessionId });
        }

        streamManager.removeConnection(sessionId);
        await sessionState.removeItem(sessionId);
    });
});

const PORT = process.env.PORT || 8080;

// Resource metrics collection
setInterval(() => {
  const memUsage = process.memoryUsage();
  const { memoryUsageBytes } = require('./monitoring/metrics');
  
  if (memoryUsageBytes && typeof memoryUsageBytes.set === 'function') {
    memoryUsageBytes.set({ type: 'heapUsed' }, memUsage.heapUsed);
    memoryUsageBytes.set({ type: 'heapTotal' }, memUsage.heapTotal);
    memoryUsageBytes.set({ type: 'external' }, memUsage.external);
    memoryUsageBytes.set({ type: 'rss' }, memUsage.rss);
  }

  if (uptimeMetric && typeof uptimeMetric.set === 'function') {
    uptimeMetric.set(process.uptime());
  }
}, 30000); // Update every 30 seconds

server.listen(PORT, () => console.log(`🚀 Server is listening on port ${PORT}`));

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  logger.info('SIGINT signal received: closing HTTP server');
  server.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });
});
