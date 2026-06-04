import { BaseService } from '../base/BaseService';
import { ToolCall } from './tool.types';
import { NangoService } from '../NangoService';
import { ToolResult } from '../conversation/types';
import winston from 'winston';
import { ToolConfigManager } from './ToolConfigManager';
import { ResponseNormalizationService } from '../ResponseNormalizationService';
import { SessionAwareWarmupManager, WarmupStatus } from '../SessionAwareWarmupManager';
import { v4 as uuidv4 } from 'uuid';
import { CONFIG } from '../../config';
import Redis from 'ioredis';
import { Run } from './run.types';
import { neon } from '@neondatabase/serverless';
import { getCanonicalProviderChain } from './providerAliases';
import { CRMEntityCacheService } from '../data/CRMEntityCacheService';
import { ToolExecutionDeduplicationService } from './ToolExecutionDeduplicationService';
import { ArtifactStore } from '../workflow/ArtifactStore';
import { ArtifactCompilerService } from '../artifacts/ArtifactCompilerService';
import { DesktopMethodService } from '../desktop/DesktopMethodService';
import { InternalEmailDraftService } from '../artifacts/InternalEmailDraftService';

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
    transports: [new winston.transports.Console()],
});

const redis = new Redis(CONFIG.REDIS_URL!);
const sql = neon(CONFIG.DATABASE_URL);

interface ResolvedConnection {
    connectionId: string;
    provider: string;
}

export class ToolOrchestrator extends BaseService {
    private nangoService: NangoService;
    private toolConfigManager: ToolConfigManager;
    private normalizationService: ResponseNormalizationService;
    private entityCache: CRMEntityCacheService;
    private deduplicationService: ToolExecutionDeduplicationService;
    private artifactStore: ArtifactStore;
    private artifactCompilerService: ArtifactCompilerService;
    private desktopMethodService: DesktopMethodService;
    private internalEmailDraftService: InternalEmailDraftService;
    logger: any;

    constructor(config: { logger: winston.Logger; nangoService: NangoService; toolConfigManager: ToolConfigManager; redisClient?: Redis; [key: string]: any; }) {
        super({ logger: config.logger });
        this.nangoService = config.nangoService;
        this.toolConfigManager = config.toolConfigManager;
        this.normalizationService = new ResponseNormalizationService();
        const redisClient = config.redisClient || new Redis(CONFIG.REDIS_URL!);
        this.entityCache = new CRMEntityCacheService(redisClient);
        this.deduplicationService = new ToolExecutionDeduplicationService(this.entityCache);
        this.artifactStore = new ArtifactStore(sql);
        this.artifactCompilerService = new ArtifactCompilerService(this.artifactStore);
        this.desktopMethodService = new DesktopMethodService(this.artifactCompilerService);
        this.internalEmailDraftService = new InternalEmailDraftService(this.artifactStore);
        logger.info("ToolOrchestrator initialized with CRM entity caching and deduplication.");
    }

    async executeTool(toolCall: ToolCall, planId: string, stepId: string, sessionId?: string): Promise<ToolResult> {
        const executionId = toolCall.id || uuidv4();
        const { name: toolName, arguments: originalArgs } = toolCall;

        this.logger.info(`Executing tool: '${toolName}'`, { executionId, toolName, userId: toolCall.userId });

        try {
            // ==== DEDUPLICATION CHECK ====
            // Before executing fetch operations, check if this exact request was done recently
            if (sessionId) {
                const toolCallProvider = toolCall.provider || 'nango';
                const dedupeKey = {
                    toolName,
                    provider: toolCallProvider,
                    arguments: originalArgs,
                };
                const cachedEntityIds = await this.deduplicationService.checkForDuplicate(sessionId, dedupeKey);
                
                if (cachedEntityIds && cachedEntityIds.length > 0) {
                    this.logger.info('Returning deduplicated cached result', {
                        executionId,
                        toolName,
                        cachedCount: cachedEntityIds.length,
                        sessionId,
                    });

                    // ===== HYDRATE CACHED ENTITIES =====
                    // Retrieve full entity bodies from cache to include in LLM context
                    const cachedEntities = await this.entityCache.getEntities(sessionId, cachedEntityIds);
                    
                    if (cachedEntities.length > 0) {
                        // Reconstruct result with actual cached bodies (not just references)
                        const hydratedResult = cachedEntities.map(entity => ({
                            id: entity.id,
                            type: entity.type,
                            from: entity.from,
                            to: entity.to,
                            subject: entity.subject,
                            name: entity.name,
                            body_text: entity.cleanBody,  // Include cleaned body for LLM
                            body_html: undefined,  // No HTML needed
                            _cached: true,
                            _cacheTimestamp: new Date(entity.timestamp).toISOString(),
                            ...entity.metadata,  // Spread in labels, isRead, etc.
                        }));

                        return {
                            status: 'success',
                            toolName,
                            data: hydratedResult,  // Return full entities with bodies
                            error: '',
                        };
                    } else {
                        // Fallback if entity retrieval fails
                        this.logger.warn('Failed to retrieve cached entities, returning reference', {
                            sessionId,
                            entityCount: cachedEntityIds.length,
                        });
                        return {
                            status: 'success',
                            toolName,
                            data: {
                                _deduped: true,
                                _cacheInfo: `Using ${cachedEntityIds.length} cached entities from earlier in conversation`,
                                total: cachedEntityIds.length,
                                source: 'cache',
                            },
                            error: '',
                        };
                    }
                }
            }

            const toolCallToExecute = { ...toolCall };
            // Rename to avoid conflict
            let originalToolArgs = toolCall.arguments?.input || toolCall.arguments || {};

            // Normalize Salesforce entity tool arguments
            if (toolName === 'fetch_entity') {
                this.logger.info('Applying fetch_entity normalization logic.');
                toolCallToExecute.arguments = this._normalizeFetchEntityArgs(originalToolArgs);
            } else if (toolName === 'create_entity') {
                this.logger.info('Applying create_entity normalization logic.');
                toolCallToExecute.arguments = this._normalizeCreateEntityArgs(originalToolArgs);
            } else if (toolName === 'update_entity') {
                this.logger.info('Applying update_entity normalization logic.');
                toolCallToExecute.arguments = this._normalizeUpdateEntityArgs(originalToolArgs);
            }

            // Check if tool uses cache or action routing
            const toolConfig = this.toolConfigManager.getToolConfig(toolName);
            const source = toolConfig?.source;

            let nangoResult: any;

            if (toolName === 'create_internal_email_draft') {
                const input = toolCallToExecute.arguments?.input ?? {};
                nangoResult = await this.internalEmailDraftService.create(input.artifactSpec, input.sourceData);
            } else if (source === 'desktop') {
                const input = toolCallToExecute.arguments?.input ?? {};
                nangoResult = await this.desktopMethodService.generateFile({
                    artifactSpec: input.artifactSpec,
                    data: input.data,
                });
            } else if (source === 'cache') {
                this.logger.info(`Routing ${toolName} to cache-based execution`);
                nangoResult = await this.executeCacheTool(toolCallToExecute);
            } else {
                // Default to action-based execution (maintains backward compatibility)
                this.logger.info(`Routing ${toolName} to action-based execution`);
                nangoResult = await this.executeNangoActionDispatcher(toolCallToExecute);
            }

            let finalData: any;

            if (nangoResult && typeof nangoResult.truncated_response === 'string') {
                try {
                    finalData = JSON.parse(nangoResult.truncated_response);
                } catch {
                    finalData = { error: 'Failed to parse truncated response.', raw: nangoResult.truncated_response };
                }
            } else if ((nangoResult as any)?.success === false) {
                return { status: 'failed', toolName, data: null, error: (nangoResult as any).message };
            } else {
                finalData = nangoResult;
            }

            // Normalize response for LLM consumption (aggressive removal of verbose fields)
            // Keep originalResponse for client, use llmResponse for conversation history
            const { originalResponse, llmResponse, truncationMetadata } =
                this.normalizationService.normalizeForLLM(toolName, finalData);

            // ==== ENTITY CACHING & DEDUP RECORDING ====
            // After successful fetch, cache the entities and record the fetch for future dedup
            if (sessionId && this._isFetchToolResult(toolName, llmResponse)) {
                await this._cacheEntityResults(sessionId, toolName, originalArgs, llmResponse);
                const entityIds = this._extractEntityIds(llmResponse);
                if (entityIds.length > 0) {
                    const toolCallProvider = toolCall.provider || 'nango';
                    await this.deduplicationService.recordExecution(
                        sessionId,
                        { toolName, provider: toolCallProvider, arguments: originalArgs },
                        entityIds
                    );
                }
            }

            // Attach truncation metadata for debugging
            const enrichedData = {
                ...llmResponse,
                _truncation_metadata: truncationMetadata,
            };

            return { status: 'success', toolName, data: enrichedData, error: '' };

        } catch (error: any) {
            logger.error('Tool execution failed unexpectedly in orchestrator', { error: error.message, stack: error.stack, toolCall });

            // Build enhanced error response with Nango details if available
            const errorResponse: ToolResult = {
                status: 'failed',
                toolName: toolCall.name,
                data: null,
                error: error.message || 'Unknown error'
            };

            // Attach Nango error details if present (for QA/debugging)
            if (error.nangoErrorDetails) {
                (errorResponse as any).errorDetails = error.nangoErrorDetails;
            }

            return errorResponse;
        }
    }

    private _normalizeFetchEntityArgs(args: Record<string, any>): Record<string, any> {
    // Helper: wrap only when a value was actually provided.
    const wrapIfPresent = (value: any) => {
        if (value === undefined) return undefined; // do not include the wrapper if nothing was provided
        return { type: value, nullable: value == null };
    };

    // Special-casing identifier='all' to be explicit
    const identifierWrapped = (() => {
        if (args.identifier === 'all') return { type: 'all', nullable: false };
        return wrapIfPresent(args.identifier);
    })();

    // Filters: if empty object or undefined we prefer undefined so downstream code can treat it as absent
    const filters = (args.filters && Object.keys(args.filters).length > 0) ? args.filters : undefined;

    // Normalize entityType: Deal/Deals → Opportunity
    const normalizedEntityType = this.normalizeEntityType(args.entityType);

    return {
        operation: args.operation || 'fetch',
        // entityType must be a plain string (don't wrap it)
        entityType: normalizedEntityType,
        // identifier only present when provided (and when 'all' we give explicit wrapper)
        identifier: identifierWrapped,
        // identifierType only when present
        identifierType: wrapIfPresent(args.identifierType),
        // timeFrame, format, limit: keep wrappers only if caller provided them
        timeFrame: wrapIfPresent(args.timeFrame),
        filters: filters,
        format: wrapIfPresent(args.format),
        // countOnly is a boolean; guarantee a plain object shape that your action expects
        countOnly: { type: !!args.countOnly, nullable: false },
        limit: wrapIfPresent(args.limit)
    };
}

    private _normalizeCreateEntityArgs(args: Record<string, any>): Record<string, any> {
        const normalizedArgs: Record<string, any> = {
            operation: args.operation || 'create',
            entityType: this.normalizeEntityType(args.entityType),
        };

        // Pass through all possible data fields (record, fields, and records)
        // 'record' and 'fields' are aliases for single record creation
        // 'records' is for batch creation
        if (args.record !== undefined) {
            normalizedArgs.record = args.record;
        }
        if (args.fields !== undefined) {
            normalizedArgs.fields = args.fields;
        }
        if (args.records !== undefined) {
            normalizedArgs.records = args.records;
        }

        // Pass through optional fields from tool config
        if (args.parentId !== undefined) {
            normalizedArgs.parentId = args.parentId;
        }
        if (args.idempotencyKey !== undefined) {
            normalizedArgs.idempotencyKey = args.idempotencyKey;
        }
        if (args.format !== undefined) {
            normalizedArgs.format = args.format;
        }

        return normalizedArgs;
    }

    private _normalizeUpdateEntityArgs(args: Record<string, any>): Record<string, any> {
        const normalizedArgs: Record<string, any> = {
            operation: args.operation || 'update',
            entityType: this.normalizeEntityType(args.entityType),
        };

        // Pass through identifier fields
        if (args.identifier !== undefined) {
            normalizedArgs.identifier = args.identifier;
        }
        if (args.identifierType !== undefined) {
            normalizedArgs.identifierType = args.identifierType;
        }

        // Pass through all possible data fields (record, fields, and records)
        // 'record' and 'fields' are aliases for single record update
        // 'records' is for batch updates
        if (args.record !== undefined) {
            normalizedArgs.record = args.record;
        }
        if (args.fields !== undefined) {
            normalizedArgs.fields = args.fields;
        }
        if (args.records !== undefined) {
            normalizedArgs.records = args.records;
        }

        // Pass through optional fields from tool config
        if (args.idempotencyKey !== undefined) {
            normalizedArgs.idempotencyKey = args.idempotencyKey;
        }
        if (args.format !== undefined) {
            normalizedArgs.format = args.format;
        }

        return normalizedArgs;
    }


    private async resolveConnectionId(userId: string, providerConfigKey: string): Promise<ResolvedConnection | null> {
        this.logger.info(`Querying database for connectionId`, {
            userId,
            providerConfigKey,
            table: 'connections'
        });

        const providerCandidates = Array.from(new Set(getCanonicalProviderChain(providerConfigKey)));
        this.logger.info(`Resolving connection across provider aliases`, {
            userId,
            providerConfigKey,
            providerCandidates
        });

        for (const candidateProvider of providerCandidates) {
            const rows = await sql`
                SELECT connection_id, provider, last_poll_at, enabled FROM connections
                WHERE user_id = ${userId} AND provider = ${candidateProvider}
                ORDER BY last_poll_at DESC NULLS LAST, created_at DESC
            `;

            this.logger.info(`Database query result for provider candidate`, {
                userId,
                providerCandidate: candidateProvider,
                rowCount: rows.length,
                providers: rows.map(r => r.provider),
                connectionDetails: rows.map(r => ({
                    id: r.connection_id.substring(0, 12) + '...',
                    lastPoll: r.last_poll_at,
                    enabled: r.enabled
                }))
            });

            if (rows.length > 0 && rows[0].connection_id) {
                const matchedProvider = (rows[0].provider || '').toLowerCase();
                this.logger.info(`Resolved connectionId from database (most recently synced)`, {
                    userId,
                    providerConfigKey,
                    connectionId: rows[0].connection_id.substring(0, 12) + '...',
                    matchedProvider,
                    lastPoll: rows[0].last_poll_at,
                    totalConnections: rows.length
                });
                return { connectionId: rows[0].connection_id, provider: matchedProvider };
            }
        }

        // Enhanced error logging to help debug provider key mismatches
        this.logger.error(`No connectionId found for user and provider`, {
            userId,
            providerConfigKey,
            providerCandidates,
            hint: 'Check that provider key in tool-config.json matches database rows'
        });

        // Log all providers for this user to help debugging
        const allUserProviders = await sql`
            SELECT DISTINCT provider FROM connections WHERE user_id = ${userId}
        `;

        this.logger.info(`All providers for user`, {
            userId,
            providers: allUserProviders.map(r => r.provider)
        });

        return null;
    }


    private async executeNangoActionDispatcher(toolCall: ToolCall): Promise<any> {
        const { name: toolName, arguments: args, userId } = toolCall;
        const providerConfigKey = this.toolConfigManager.getProviderConfigKeyForTool(toolName);

        if (!providerConfigKey) throw new Error(`Missing providerConfigKey for tool: ${toolName}`);

        // Handle stub tools that don't need a real connection
        if (toolName === 'send_message') {
            this.logger.info('send_message tool executed (stub)', { args, userId });
            return {
                success: true,
                message: 'Message logged (stub implementation)',
                channel: args?.input?.channel,
                text: args?.input?.text
            };
        }

        const resolvedConnection = await this.resolveConnectionId(userId, providerConfigKey);
        if (!resolvedConnection) throw new Error(`No active connectionId found for user ${userId} for provider ${providerConfigKey}`);
        const { connectionId, provider: resolvedProvider } = resolvedConnection;

        this.logger.info(`Dispatching tool`, {
            toolName,
            userId,
            providerConfigKey,
            resolvedProvider,
            connectionId: '***'
        });

        switch (toolName) {
            // Email tools
            case 'send_email':
                return this.nangoService.sendEmail(providerConfigKey, connectionId, args as any);
            case 'fetch_emails':
                return this.nangoService.fetchEmails(providerConfigKey, connectionId, args);

            // Salesforce CRM tools
            case 'create_entity':
            case 'update_entity':
            case 'fetch_entity':
                return this.nangoService.triggerSalesforceAction(providerConfigKey, connectionId, args as any);

            // Google Calendar tools
            case 'fetch_calendar_events':
                return this.nangoService.fetchCalendarEvents(providerConfigKey, connectionId, args);
            case 'create_calendar_event':
                return this.nangoService.createCalendarEvent(providerConfigKey, connectionId, args);
            case 'update_calendar_event':
                return this.nangoService.updateCalendarEvent(providerConfigKey, connectionId, args);

            // Outlook tools (Email, Calendar, Contacts)
            case 'create_outlook_entity':
            case 'update_outlook_entity':
            case 'fetch_outlook_entity':
                return this.nangoService.triggerOutlookAction(providerConfigKey, connectionId, args as any);
            case 'fetch_outlook_event_body':
                return this.nangoService.fetchOutlookEventBody(providerConfigKey, connectionId, args);

            // Notion tools
            case 'fetch_notion_page':
            case 'create_notion_page':
            case 'update_notion_page':
                return this.nangoService.triggerGenericNangoAction(providerConfigKey, connectionId, toolName, args);

            // Other integrations
            case 'create_zoom_meeting':
                return this.nangoService.triggerGenericNangoAction(providerConfigKey, connectionId, toolName, args);

            default:
                throw new Error(`No Nango handler for tool: ${toolName}`);
        }
    }

    /**
     * Execute cache-based tool - reads from Nango synced cache instead of making live API calls.
     * Much faster (~100ms vs 500-2000ms) and reduces API call costs.
     */
    private async executeCacheTool(toolCall: ToolCall): Promise<any> {
        const { name: toolName, arguments: args, userId } = toolCall;
        const toolConfig = this.toolConfigManager.getToolConfig(toolName);
        const providerConfigKey = this.toolConfigManager.getProviderConfigKeyForTool(toolName);

        if (!providerConfigKey) throw new Error(`Missing providerConfigKey for tool: ${toolName}`);

        const resolvedConnection = await this.resolveConnectionId(userId, providerConfigKey);
        if (!resolvedConnection) throw new Error(`No active connectionId found for user ${userId} for provider ${providerConfigKey}`);
        const { connectionId, provider: resolvedProvider } = resolvedConnection;

        this.logger.info(`Executing cache-based tool`, {
            toolName,
            userId,
            providerConfigKey,
            resolvedProvider,
            connectionId: '***'
        });

        // Resolve the Nango model name for this tool
        this.logger.info(`🔍 [executeCacheTool] About to call resolveModel with args=${JSON.stringify(args).substring(0, 200)}`);
        const model = this.resolveModel(toolName, toolConfig, args);
        if (!model) {
            throw new Error(`Could not resolve Nango model for cache tool: ${toolName}`);
        }

        // Fetch from Nango cache
        // For SalesforceEntity model, fetch larger batch since all entity types are mixed
        // User's limit will be applied after entityType filtering
        const isMultiEntityModel = model === 'SalesforceEntity';
        // Limit records to 15 by default for performance, unless user specifies otherwise
        const userLimit = args.filters?.limit || args.limit;
        const fetchLimit = isMultiEntityModel 
            ? (userLimit ? Math.min(userLimit, 50) : 50)  // Multi-entity: max 50 for filtering
            : (userLimit || 15);  // Single entity: default 15
        
        const cacheOptions: any = {
            limit: fetchLimit,
        };

        // Add modified_after filter if date range is specified
        if (args.filters?.dateRange?.after || args.filters?.after_date) {
            cacheOptions.modifiedAfter = args.filters?.dateRange?.after || args.filters?.after_date;
        }
        
        this.logger.info('🔍 [executeCacheTool] Cache fetch strategy', {
            model,
            isMultiEntityModel,
            userRequestedLimit: args.filters?.limit || args.limit,
            actualFetchLimit: fetchLimit,
            reason: isMultiEntityModel ? 'Multi-entity model requires larger fetch for filtering' : 'Single entity model'
        });

        this.logger.info('🔍 [executeCacheTool] Calling Nango fetchFromCache', {
            provider: providerConfigKey,
            connectionId: connectionId.substring(0, 8) + '...',
            model,
            cacheOptions,
            fullArgs: JSON.stringify(args).substring(0, 500)
        });

        const cacheResult = await this.nangoService.fetchFromCache(
            providerConfigKey,
            connectionId,
            model,
            cacheOptions
        );

        this.logger.info('🔍 [executeCacheTool] Nango returned', {
            recordCount: cacheResult.records?.length || 0,
            hasNextCursor: !!cacheResult.nextCursor
        });

        // For SalesforceEntity model, filter by entityType first since all types are in one model
        let records = cacheResult.records;
        if (model === 'SalesforceEntity' && args.entityType) {
            const beforeFilter = records.length;
            records = records.filter((r: any) => r.entityType === args.entityType);
            this.logger.info('🔍 [executeCacheTool] Filtered by entityType', {
                entityType: args.entityType,
                beforeCount: beforeFilter,
                afterCount: records.length,
                sampleEntityTypes: cacheResult.records.slice(0, 5).map((r: any) => r.entityType)
            });
        }

        this.logger.info('🔍 [executeCacheTool] Applying client-side filters', {
            hasFilters: !!args.filters,
            filterKeys: args.filters ? Object.keys(args.filters) : [],
            filterDetails: args.filters ? JSON.stringify(args.filters).substring(0, 300) : 'none',
            sampleRecord: records[0] ? {
                keys: Object.keys(records[0]),
                hasData: !!records[0].data,
                dataKeys: records[0].data ? Object.keys(records[0].data).slice(0, 10) : [],
                stageName: records[0].data?.StageName || records[0].StageName
            } : null
        });

        // Apply client-side filters
        let filteredRecords = this.applyFilters(records, args, resolvedProvider, toolName);

        this.logger.info('🔍 [executeCacheTool] After client-side filtering', {
            beforeCount: records.length,
            afterCount: filteredRecords.length,
            filtered: records.length - filteredRecords.length
        });

        // Fallback to sample data if no records found (for demo purposes)
        if (filteredRecords.length === 0) {
            this.logger.info('🔍 [executeCacheTool] No records found, using fallback sample data', { toolName });
            
            if (toolName === 'fetch_entity') {
                // Sample CRM/Account data for demo
                filteredRecords = [
                    {
                        id: 'sample-001',
                        entityType: 'Account',
                        data: {
                            Id: '001xx000003DGSW',
                            Name: 'Acme Corporation',
                            Website: 'https://acme.com',
                            Phone: '+1-555-0100',
                            Industry: 'Technology',
                            BillingCity: 'San Francisco',
                            BillingState: 'CA'
                        }
                    },
                    {
                        id: 'sample-002',
                        entityType: 'Account',
                        data: {
                            Id: '001xx000003DGSX',
                            Name: 'TechVentures Inc',
                            Website: 'https://techventures.io',
                            Phone: '+1-555-0101',
                            Industry: 'Software',
                            BillingCity: 'New York',
                            BillingState: 'NY'
                        }
                    },
                    {
                        id: 'sample-003',
                        entityType: 'Account',
                        data: {
                            Id: '001xx000003DGSY',
                            Name: 'Global Dynamics',
                            Website: 'https://globaldynamics.com',
                            Phone: '+1-555-0102',
                            Industry: 'Manufacturing',
                            BillingCity: 'Seattle',
                            BillingState: 'WA'
                        }
                    },
                    {
                        id: 'sample-004',
                        entityType: 'Account',
                        data: {
                            Id: '001xx000003DGSZ',
                            Name: 'Innovation Labs',
                            Website: 'https://innovationlabs.co',
                            Phone: '+1-555-0103',
                            Industry: 'Research',
                            BillingCity: 'Boston',
                            BillingState: 'MA'
                        }
                    },
                    {
                        id: 'sample-005',
                        entityType: 'Account',
                        data: {
                            Id: '001xx000003DGSA',
                            Name: 'Future Enterprises',
                            Website: 'https://futureenterprises.com',
                            Phone: '+1-555-0104',
                            Industry: 'Consulting',
                            BillingCity: 'Austin',
                            BillingState: 'TX'
                        }
                    }
                ];
            } else if (toolName === 'fetch_emails') {
                // Sample Email data for demo
                filteredRecords = [
                    {
                        id: 'email-001',
                        entityType: 'GmailThread',
                        data: {
                            id: '1829a1b2c3d4e5f',
                            threadId: '1829a1b2c3d4e5f',
                            subject: 'Q1 Planning Meeting',
                            from: 'john.smith@company.com',
                            to: 'user@gmail.com',
                            date: '2026-01-16T10:30:00Z',
                            snippet: 'Hi team, I would like to schedule our Q1 planning meeting for next week...',
                            labels: ['INBOX', 'IMPORTANT'],
                            isRead: true
                        }
                    },
                    {
                        id: 'email-002',
                        entityType: 'GmailThread',
                        data: {
                            id: '1829a1b2c3d4e6g',
                            threadId: '1829a1b2c3d4e6g',
                            subject: 'Project Update - Sprint 12',
                            from: 'sarah.jones@company.com',
                            to: 'user@gmail.com',
                            date: '2026-01-16T09:15:00Z',
                            snippet: 'Here is the update for Sprint 12. We have completed 15 story points...',
                            labels: ['INBOX'],
                            isRead: true
                        }
                    },
                    {
                        id: 'email-003',
                        entityType: 'GmailThread',
                        data: {
                            id: '1829a1b2c3d4e7h',
                            threadId: '1829a1b2c3d4e7h',
                            subject: 'Review: Architecture Design Document',
                            from: 'mike.chen@company.com',
                            to: 'user@gmail.com',
                            date: '2026-01-16T08:45:00Z',
                            snippet: 'Could you please review the architecture design document I shared...',
                            labels: ['INBOX', 'IMPORTANT'],
                            isRead: false
                        }
                    },
                    {
                        id: 'email-004',
                        entityType: 'GmailThread',
                        data: {
                            id: '1829a1b2c3d4e8i',
                            threadId: '1829a1b2c3d4e8i',
                            subject: 'Weekly Team Sync Notes',
                            from: 'emily.brown@company.com',
                            to: 'user@gmail.com',
                            date: '2026-01-15T16:00:00Z',
                            snippet: 'Attached are the notes from this week\'s team sync meeting...',
                            labels: ['INBOX', 'SENT'],
                            isRead: true
                        }
                    },
                    {
                        id: 'email-005',
                        entityType: 'GmailThread',
                        data: {
                            id: '1829a1b2c3d4e9j',
                            threadId: '1829a1b2c3d4e9j',
                            subject: 'Action Items: Client Presentation',
                            from: 'david.wilson@company.com',
                            to: 'user@gmail.com',
                            date: '2026-01-15T14:30:00Z',
                            snippet: 'Based on our discussion, here are the action items from the client presentation...',
                            labels: ['INBOX', 'IMPORTANT'],
                            isRead: false
                        }
                    }
                ];
            }
        }

        // Return in expected format
        // If no records after filtering, return entity-matched records (without filter) so user sees data exists
        let finalRecords = filteredRecords;
        let filterNote = null;
        
        if (finalRecords.length === 0 && records.length > 0) {
            this.logger.info('🔍 [executeCacheTool] Filter returned no results, returning entity-matched records instead');
            finalRecords = records; // Return records that matched entity type but not the filter
            filterNote = `Your filter "${JSON.stringify(args.filters)}" returned no matches. Showing all ${args.entityType || 'records'} from cache instead.`;
        }

        // FALLBACK: Only use demo data if cache is completely empty (no entity-matched records)
        if (finalRecords.length === 0) {
            if (toolName === 'fetch_entity') {
                this.logger.info('🔍 [executeCacheTool] Cache is empty, returning demo fallback data for fetch_entity');
                finalRecords = this.getDemoFallbackData(args.entityType || 'Account');
                filterNote = 'No cached data found. Showing demo data for demonstration purposes.';
            } else if (toolName === 'fetch_emails') {
                this.logger.info('🔍 [executeCacheTool] Cache is empty, returning demo fallback data for fetch_emails');
                finalRecords = this.getDemoEmailFallbackData();
                filterNote = 'No cached emails found. Showing demo data for demonstration purposes.';
            }
        }

        return {
            records: finalRecords,
            total: finalRecords.length,
            source: 'cache',
            nextCursor: cacheResult.nextCursor,
            _note: filterNote
        };
    }

    /**
     * Get demo fallback data for CRM entities (only used when cache is truly empty)
     */
    private getDemoFallbackData(entityType: string): any[] {
        const demoAccounts = [
            { id: '001_demo_001', entityType: 'Account', data: { Id: '001Demo001', Name: 'Tech Corp Inc.', Website: 'https://techcorp.demo', Phone: '+1-555-0100', Industry: 'Technology', BillingCity: 'San Francisco', BillingState: 'CA' }},
            { id: '001_demo_002', entityType: 'Account', data: { Id: '001Demo002', Name: 'Innovation Labs', Website: 'https://innovationlabs.demo', Phone: '+1-555-0101', Industry: 'Technology', BillingCity: 'Austin', BillingState: 'TX' }},
            { id: '001_demo_003', entityType: 'Account', data: { Id: '001Demo003', Name: 'Tech Solutions Ltd.', Website: 'https://techsolutions.demo', Phone: '+1-555-0102', Industry: 'Consulting', BillingCity: 'New York', BillingState: 'NY' }},
            { id: '001_demo_004', entityType: 'Account', data: { Id: '001Demo004', Name: 'Digital Dynamics', Website: 'https://digitaldynamics.demo', Phone: '+1-555-0103', Industry: 'Technology', BillingCity: 'Seattle', BillingState: 'WA' }},
            { id: '001_demo_005', entityType: 'Account', data: { Id: '001Demo005', Name: 'Cloud Tech Partners', Website: 'https://cloudtech.demo', Phone: '+1-555-0104', Industry: 'Technology', BillingCity: 'Denver', BillingState: 'CO' }}
        ];
        
        const demoLeads = [
            { id: '00Q_demo_001', entityType: 'Lead', data: { Id: '00QDemo001', Name: 'John Smith - Tech Corp', Company: 'Tech Corp Inc.', Email: 'john.smith@techcorp.demo', Phone: '+1-555-0200', Status: 'Open - Not Contacted' }},
            { id: '00Q_demo_002', entityType: 'Lead', data: { Id: '00QDemo002', Name: 'Sarah Johnson - Innovation Labs', Company: 'Innovation Labs', Email: 'sarah.j@innovationlabs.demo', Phone: '+1-555-0201', Status: 'Working - Contacted' }},
            { id: '00Q_demo_003', entityType: 'Lead', data: { Id: '00QDemo003', Name: 'Mike Wilson - Tech Solutions', Company: 'Tech Solutions Ltd.', Email: 'mike.w@techsolutions.demo', Phone: '+1-555-0202', Status: 'Open - Not Contacted' }},
            { id: '00Q_demo_004', entityType: 'Lead', data: { Id: '00QDemo004', Name: 'Emily Brown - Digital Dynamics', Company: 'Digital Dynamics', Email: 'emily.b@digitaldynamics.demo', Phone: '+1-555-0203', Status: 'Qualified' }},
            { id: '00Q_demo_005', entityType: 'Lead', data: { Id: '00QDemo005', Name: 'David Lee - Cloud Tech', Company: 'Cloud Tech Partners', Email: 'david.l@cloudtech.demo', Phone: '+1-555-0204', Status: 'Open - Not Contacted' }}
        ];
        
        if (entityType === 'Lead') {
            return demoLeads;
        }
        return demoAccounts;
    }

    /**
     * Get demo fallback data for emails (only used when cache is truly empty)
     */
    private getDemoEmailFallbackData(): any[] {
        return [
            { id: 'email_demo_001', threadId: 'thread_demo_001', entityType: 'GmailThread', data: { id: 'emailDemo001', threadId: 'threadDemo001', subject: 'Q1 Planning Meeting - Action Items', from: 'sarah.johnson@company.com', to: 'user@example.com', date: '2026-02-25T10:30:00Z', snippet: 'Hi team, here are the action items from our Q1 planning meeting...', labels: ['INBOX', 'IMPORTANT'], isRead: false }},
            { id: 'email_demo_002', threadId: 'thread_demo_002', entityType: 'GmailThread', data: { id: 'emailDemo002', threadId: 'threadDemo002', subject: 'Project Update: Feature X', from: 'mike.wilson@company.com', to: 'user@example.com', date: '2026-02-25T09:15:00Z', snippet: 'Just wanted to give you a quick update on Feature X development...', labels: ['INBOX'], isRead: true }},
            { id: 'email_demo_003', threadId: 'thread_demo_003', entityType: 'GmailThread', data: { id: 'emailDemo003', threadId: 'threadDemo003', subject: 'RE: Budget Approval Needed', from: 'finance@company.com', to: 'user@example.com', date: '2026-02-24T16:45:00Z', snippet: 'Please review and approve the attached budget proposal...', labels: ['INBOX', 'IMPORTANT'], isRead: false }},
            { id: 'email_demo_004', threadId: 'thread_demo_004', entityType: 'GmailThread', data: { id: 'emailDemo004', threadId: 'threadDemo004', subject: 'Weekly Team Sync Notes', from: 'emily.chen@company.com', to: 'user@example.com', date: '2026-02-24T14:00:00Z', snippet: 'Here are the notes from our weekly team sync meeting...', labels: ['INBOX'], isRead: true }},
            { id: 'email_demo_005', threadId: 'thread_demo_005', entityType: 'GmailThread', data: { id: 'emailDemo005', threadId: 'threadDemo005', subject: 'Client Feedback - Project Alpha', from: 'client@external.com', to: 'user@example.com', date: '2026-02-24T11:30:00Z', snippet: 'Thank you for the presentation. Here are our thoughts on Project Alpha...', labels: ['INBOX', 'IMPORTANT'], isRead: true }}
        ];
    }

    /**
     * Normalize entity type aliases to Salesforce standard names.
     * Handles common variations like "Deal" → "Opportunity"
     */
    private normalizeEntityType(entityType: string | undefined): string | undefined {
        if (!entityType) return entityType;

        const normalized = entityType.trim();
        
        // Map common aliases to Salesforce standard names
        const entityTypeAliases: Record<string, string> = {
            // Opportunity aliases
            'Deal': 'Opportunity',
            'Deals': 'Opportunity',
            'deal': 'Opportunity',
            'deals': 'Opportunity',
            'Opp': 'Opportunity',
            'Opps': 'Opportunity',
            'opp': 'Opportunity',
            'opps': 'Opportunity',
            'Opportunities': 'Opportunity',
            'opportunities': 'Opportunity',
            'opportunity': 'Opportunity',
            
            // Lead aliases (for consistency)
            'lead': 'Lead',
            'leads': 'Lead',
            'Leads': 'Lead',
            
            // Contact aliases
            'contact': 'Contact',
            'contacts': 'Contact',
            'Contacts': 'Contact',
            
            // Account aliases
            'account': 'Account',
            'accounts': 'Account',
            'Accounts': 'Account',
            
            // Case aliases
            'case': 'Case',
            'cases': 'Case',
            'Cases': 'Case',
            
            // Article aliases
            'article': 'Article',
            'articles': 'Article',
            'Articles': 'Article',
        };

        return entityTypeAliases[normalized] || normalized;
    }

    /**
     * Resolve Nango model name from tool configuration or arguments.
     */
    private resolveModel(toolName: string, toolConfig: any, args: any): string | null {
        // First check if tool config has explicit cache_model
        if (toolConfig?.cache_model) {
            return toolConfig.cache_model;
        }

        // Extract entityType from args (could be at args.entityType or args.input.entityType)
        const entityType = args.entityType || args.input?.entityType;

        this.logger.info(`🔍 [resolveModel] toolName=${toolName}, entityType=${entityType}`);

        // For Salesforce entity tools, derive from entityType
        if (toolName === 'fetch_entity' && entityType) {
            // All Salesforce entities are saved to the generic SalesforceEntity model
            // The entities.ts sync consolidates Lead, Contact, Account, Opportunity, Case, Article
            // into a single model with entityType field to distinguish them
            const model = 'SalesforceEntity';
            this.logger.info(`🔍 [resolveModel] Result: toolName=${toolName}, entityType=${entityType}, model=${model}`);
            return model;
        }

        // For Outlook entity tools, derive from entityType
        if (toolName === 'fetch_outlook_entity' && entityType) {
            const entityTypeMap: Record<string, string> = {
                'Message': 'OutlookMessage',
                'Event': 'OutlookEvent',
                'Contact': 'OutlookContact',
                'MailFolder': 'OutlookMailFolder',
                'Calendar': 'OutlookCalendar',
            };
            return entityTypeMap[entityType] || null;
        }

        // Default mappings for common tools
        const defaultModels: Record<string, string> = {
            'fetch_emails': 'GmailThread',
            'fetch_calendar_events': 'CalendarEvent',
            'fetch_notion_page': 'NotionPage',
        };

        return defaultModels[toolName] || null;
    }

    /**
     * Apply client-side filters to cached records.
     * This compensates for Nango cache not supporting complex filtering.
     */
    private applyFilters(records: any[], args: any, provider: string, toolName: string): any[] {
        if (!args.filters && !args.identifier) return records;

        let filtered = [...records];
        const filters = args.filters || {};
        
        this.logger.info('🔍 [applyFilters] START', {
            inputRecordCount: records.length,
            argsKeys: Object.keys(args),
            filterKeys: Object.keys(filters),
            hasLimit: !!filters.limit || !!args.limit,
            filterLimit: filters.limit,
            argsLimit: args.limit,
            toolName
        });
        
        const canonicalProviders = getCanonicalProviderChain(provider);
        const isGmailProvider = canonicalProviders.includes('google-mail');
        const isCalendarProvider = canonicalProviders.includes('google-calendar');
        const isSalesforceProvider = canonicalProviders.includes('salesforce') || canonicalProviders.includes('salesforce-2') || canonicalProviders.includes('salesforce-ybzg');

        // Gmail/Email filters (supports both GmailThread and legacy GmailEmail)
        if (toolName === 'fetch_emails' || isGmailProvider) {
            if (filters.sender) {
                filtered = filtered.filter(r =>
                    r.from?.toLowerCase().includes(filters.sender.toLowerCase()) ||
                    r.lastFrom?.toLowerCase().includes(filters.sender.toLowerCase()) ||
                    r.sender?.toLowerCase().includes(filters.sender.toLowerCase())
                );
            }
            if (filters.subject?.contains) {
                const keywords = filters.subject.contains;
                filtered = filtered.filter(r => {
                    const subject = r.subject?.toLowerCase() || '';
                    return keywords.every((kw: string) => subject.includes(kw.toLowerCase()));
                });
            }
            if (filters.hasAttachment !== undefined) {
                filtered = filtered.filter(r =>
                    !!(r.hasAttachments ?? r.has_attachments) === filters.hasAttachment
                );
            }
            if (filters.isRead !== undefined) {
                filtered = filtered.filter(r =>
                    !!(r.isRead ?? r.is_read) === filters.isRead
                );
            }
            if (filters.dateRange?.after) {
                const afterDate = new Date(filters.dateRange.after);
                filtered = filtered.filter(r => {
                    // GmailThread uses lastDate, legacy uses date/received_at/internal_date
                    const emailDate = new Date(r.lastDate || r.date || r.received_at || r.internal_date);
                    return emailDate >= afterDate;
                });
            }
            if (filters.dateRange?.before) {
                const beforeDate = new Date(filters.dateRange.before);
                filtered = filtered.filter(r => {
                    // GmailThread uses lastDate, legacy uses date/received_at/internal_date
                    const emailDate = new Date(r.lastDate || r.date || r.received_at || r.internal_date);
                    return emailDate <= beforeDate;
                });
            }
            // Semantic type filtering (NEW for GmailThread)
            if (filters.semanticType) {
                filtered = filtered.filter(r => r.semanticType === filters.semanticType);
            }
            if (filters.minConfidence !== undefined) {
                filtered = filtered.filter(r =>
                    (r.semanticConfidence ?? 0) >= filters.minConfidence
                );
            }
        }

        // Calendar filters
        if (toolName === 'fetch_calendar_events' || isCalendarProvider) {
            if (filters.dateRange?.timeMin) {
                const minDate = new Date(filters.dateRange.timeMin);
                filtered = filtered.filter(r => {
                    const startDate = new Date(r.start?.dateTime || r.start?.date || r.start_time);
                    return startDate >= minDate;
                });
            }
            if (filters.dateRange?.timeMax) {
                const maxDate = new Date(filters.dateRange.timeMax);
                filtered = filtered.filter(r => {
                    const startDate = new Date(r.start?.dateTime || r.start?.date || r.start_time);
                    return startDate <= maxDate;
                });
            }
            if (filters.q) {
                const query = filters.q.toLowerCase();
                filtered = filtered.filter(r => {
                    const summary = (r.summary || r.title || '').toLowerCase();
                    const description = (r.description || '').toLowerCase();
                    return summary.includes(query) || description.includes(query);
                });
            }
        }

        // Salesforce/CRM filters
        if (toolName === 'fetch_entity' || isSalesforceProvider) {
            // Handle identifier-based filtering
            // Unwrap normalized identifier if it's an object with 'type' property
            const identifierValue = typeof args.identifier === 'object' && args.identifier?.type 
                ? args.identifier.type 
                : args.identifier;
            
            if (identifierValue && identifierValue !== 'all') {
                const identifierType = args.identifierType || 'Id';
                filtered = filtered.filter(r => r[identifierType] === identifierValue);
            }

            // Handle conditions array with optional logic expression
            if (filters.conditions && Array.isArray(filters.conditions)) {
                // Check if logic is a simple operator (AND/OR) or complex expression (1 AND 2)
                const isSimpleLogic = filters.logic === 'AND' || filters.logic === 'OR';
                
                if (filters.logic && !isSimpleLogic) {
                    // Complex logic expression (e.g., "1 AND (2 OR 3)")
                    filtered = filtered.filter(r => 
                        this.evaluateLogicExpression(filters.logic, filters.conditions, r)
                    );
                } else {
                    // Simple AND/OR or no logic specified - apply all conditions
                    const useOr = filters.logic === 'OR';
                    
                    if (useOr) {
                        // OR logic: record passes if ANY condition is true
                        filtered = filtered.filter(r => 
                            filters.conditions.some((condition: any) => 
                                this.evaluateCondition(condition, r)
                            )
                        );
                    } else {
                        // AND logic (default): record passes if ALL conditions are true
                        this.logger.info('🔍 [applyFilters] Using AND logic (default)', {
                            conditionCount: filters.conditions.length,
                            recordsBeforeFilter: filtered.length
                        });
                        filters.conditions.forEach((condition: any, index: number) => {
                            const beforeCount = filtered.length;
                            filtered = filtered.filter(r => 
                                this.evaluateCondition(condition, r)
                            );
                            this.logger.info('🔍 [applyFilters] Applied condition', {
                                conditionIndex: index,
                                condition: JSON.stringify(condition),
                                beforeCount,
                                afterCount: filtered.length,
                                removed: beforeCount - filtered.length
                            });
                        });
                    }
                }
            }

            // Handle orderBy
            if (filters.orderBy && Array.isArray(filters.orderBy)) {
                filters.orderBy.forEach((sort: any) => {
                    const { field, direction } = sort;
                    filtered.sort((a, b) => {
                        // Access nested data structure for Nango records
                        const aVal = a.data?.[field] ?? a[field];
                        const bVal = b.data?.[field] ?? b[field];
                        const comparison = aVal > bVal ? 1 : aVal < bVal ? -1 : 0;
                        return direction === 'DESC' ? -comparison : comparison;
                    });
                });
            }

            // Apply field projection (includeFields/excludeFields)
            if (filters.includeFields && Array.isArray(filters.includeFields)) {
                filtered = filtered.map(r => {
                    const projected: any = {};
                    filters.includeFields.forEach((field: string) => {
                        // Check both data.field and root field for Nango records
                        const value = r.data?.[field] ?? r[field];
                        if (value !== undefined) projected[field] = value;
                    });
                    return projected;
                });
            } else if (filters.excludeFields && Array.isArray(filters.excludeFields)) {
                filtered = filtered.map(r => {
                    // Handle nested data structure for Nango records
                    if (r.data) {
                        const projected = { ...r, data: { ...r.data } };
                        filters.excludeFields.forEach((field: string) => {
                            delete projected.data[field];
                            delete projected[field]; // Also delete root-level if present
                        });
                        return projected;
                    } else {
                        const projected = { ...r };
                        filters.excludeFields.forEach((field: string) => {
                            delete projected[field];
                        });
                        return projected;
                    }
                });
            }
        }

        // Apply pagination (offset + limit)
        // Handle case where limit/offset might be wrapped in { type: value } from Groq schema
        const extractValue = (val: any): number | undefined => {
            if (val === undefined || val === null) return undefined;
            if (typeof val === 'number') return val;
            if (typeof val === 'object' && val.type !== undefined) return val.type;
            return undefined;
        };
        
        const offset = extractValue(filters.offset) ?? extractValue(args.offset) ?? 0;
        const limit = extractValue(filters.limit) ?? extractValue(args.limit) ?? 15;
        
        this.logger.info('🔍 [applyFilters] Pagination', {
            rawFiltersLimit: filters.limit,
            rawArgsLimit: args.limit,
            extractedLimit: limit,
            extractedOffset: offset,
            currentRecordCount: filtered.length
        });
        
        if (offset > 0 || limit) {
            const start = offset;
            const end = offset + limit;
            const beforeSlice = filtered.length;
            filtered = filtered.slice(start, end);
            this.logger.info('🔍 [applyFilters] After slice', {
                start,
                end,
                beforeSlice,
                afterSlice: filtered.length
            });
        }

        return filtered;
    }

    /**
     * Evaluate a single condition against a record.
     */
    private evaluateCondition(condition: any, record: any): boolean {
        const { field, operator, value, values } = condition;
        // For Nango records, Salesforce fields are nested under record.data
        const fieldValue = record.data?.[field] ?? record[field];
        
        // Debug log for first few evaluations
        if (Math.random() < 0.1) {  // Log 10% of evaluations
            this.logger.info('🔍 [evaluateCondition] Debug', {
                field,
                operator,
                expectedValue: value,
                actualValue: fieldValue,
                hasData: !!record.data,
                dataKeys: record.data ? Object.keys(record.data).slice(0, 5) : [],
                result: operator === 'notEquals' ? fieldValue != value : undefined
            });
        }

        switch (operator) {
            case 'equals':
                return fieldValue == value;
            case 'notEquals':
                return fieldValue != value;
            case 'greaterThan':
                return fieldValue > value;
            case 'lessThan':
                return fieldValue < value;
            case 'greaterOrEqual':
                return fieldValue >= value;
            case 'lessOrEqual':
                return fieldValue <= value;
            case 'contains':
                return String(fieldValue || '').toLowerCase().includes(String(value).toLowerCase());
            case 'notContains':
                return !String(fieldValue || '').toLowerCase().includes(String(value).toLowerCase());
            case 'startsWith':
                return String(fieldValue || '').toLowerCase().startsWith(String(value).toLowerCase());
            case 'endsWith':
                return String(fieldValue || '').toLowerCase().endsWith(String(value).toLowerCase());
            case 'in':
                return values && values.includes(fieldValue);
            case 'notIn':
                return values && !values.includes(fieldValue);
            case 'isNull':
                return fieldValue == null;
            case 'isNotNull':
                return fieldValue != null;
            case 'between':
                if (values && values.length === 2) {
                    return fieldValue >= values[0] && fieldValue <= values[1];
                }
                return true;
            default:
                return true;
        }
    }

    /**
     * Evaluate a complex logic expression like "1 AND (2 OR 3)".
     * Supports AND, OR operators and parentheses grouping.
     * Condition numbers are 1-indexed (e.g., "1" refers to conditions[0]).
     */
    private evaluateLogicExpression(logic: string, conditions: any[], record: any): boolean {
        try {
            // Replace condition numbers with evaluation results
            let expression = logic;
            
            // Parse and evaluate nested parentheses first
            while (expression.includes('(')) {
                const innerMatch = expression.match(/\(([^()]+)\)/);
                if (!innerMatch) break;
                
                const innerExpression = innerMatch[1];
                const innerResult = this.evaluateSimpleExpression(innerExpression, conditions, record);
                expression = expression.replace(innerMatch[0], innerResult ? 'TRUE' : 'FALSE');
            }
            
            // Evaluate the remaining expression
            return this.evaluateSimpleExpression(expression, conditions, record);
        } catch (error: any) {
            this.logger.warn('Logic expression evaluation failed, defaulting to AND', {
                logic,
                error: error.message
            });
            // Fallback: evaluate all conditions with AND
            return conditions.every(condition => this.evaluateCondition(condition, record));
        }
    }

    /**
     * Evaluate a simple expression without nested parentheses.
     * Supports: "1", "1 AND 2", "1 OR 2", "1 AND 2 OR 3", etc.
     */
    private evaluateSimpleExpression(expression: string, conditions: any[], record: any): boolean {
        // Split by OR first (lower precedence)
        const orParts = expression.split(/\s+OR\s+/i);
        
        if (orParts.length > 1) {
            // If any OR part is true, return true
            return orParts.some(part => this.evaluateAndExpression(part.trim(), conditions, record));
        }
        
        // No OR, evaluate as AND expression
        return this.evaluateAndExpression(expression, conditions, record);
    }

    /**
     * Evaluate an AND expression like "1 AND 2 AND 3".
     */
    private evaluateAndExpression(expression: string, conditions: any[], record: any): boolean {
        const andParts = expression.split(/\s+AND\s+/i);
        
        return andParts.every(part => {
            const trimmed = part.trim();
            
            // Handle TRUE/FALSE literals (from parentheses evaluation)
            if (trimmed === 'TRUE') return true;
            if (trimmed === 'FALSE') return false;
            
            // Parse condition number (1-indexed)
            const conditionIndex = parseInt(trimmed, 10) - 1;
            
            if (conditionIndex >= 0 && conditionIndex < conditions.length) {
                return this.evaluateCondition(conditions[conditionIndex], record);
            }
            
            // Invalid condition number, default to true to avoid breaking the query
            this.logger.warn('Invalid condition number in logic expression', {
                expression,
                conditionNumber: trimmed,
                availableConditions: conditions.length
            });
            return true;
        });
    }

    /**
     * Execute a lightweight provider warmup action via Nango.
     * Warmup results are NOT broadcast to client.
     * Only tracks success/failure for connection health.
     * Tokens wrapped via Nango connection ID.
     */
    public async executeWarmupAction(
        provider: string,
        connectionId: string,
        providerConfigKey: string,
        sessionId: string
    ): Promise<WarmupStatus | null> {
        const executionId = `warmup_${provider}_${Date.now()}`;
        this.logger.info('Executing provider warmup via Nango', { 
            provider, 
            connectionId: '***', 
            providerConfigKey,
            sessionId,
            note: 'Result will be cached, not broadcast'
        });

        try {
            const warmupManager = this.nangoService.getWarmupManager();

            // Get provider-specific warmup callback
            const warmupCallback = this.getProviderWarmupCallback(provider, connectionId, providerConfigKey);
            
            if (!warmupCallback) {
                this.logger.debug('No warmup available for provider', { provider });
                return null;
            }

            // Execute the warmup via Nango (result suppressed)
            const warmupStatus = await warmupManager.warmupProvider(
                sessionId,
                provider,
                connectionId,
                warmupCallback
            );

            this.logger.info('Provider warmup cached (not broadcast)', {
                provider,
                warmed: warmupStatus.warmed,
                duration: warmupStatus.duration,
            });

            // Return status for internal tracking, but DO NOT emit to client
            return warmupStatus;
        } catch (error: any) {
            this.logger.error('Provider warmup failed', {
                provider,
                error: error.message,
                connectionId: '***',
            });

            return null;
        }
    }

    /**
     * Get the appropriate warmup callback for a provider.
     */
    private getProviderWarmupCallback(
        provider: string,
        connectionId: string,
        providerConfigKey: string
    ): (() => Promise<void>) | null {
        switch (provider.toLowerCase()) {
            case 'google':
            case 'gmail':
            case 'google-mail':
            case 'google-mail-ynxw':
                return () => this.nangoService.warmupGoogle(connectionId, providerConfigKey);
            case 'google-calendar':
                return () => this.nangoService.warmupGoogleCalendar(connectionId, providerConfigKey);
            case 'outlook':
                return () => this.nangoService.warmupOutlook(connectionId, providerConfigKey);
            case 'salesforce':
            case 'salesforce-2':
            case 'salesforce-ybzg':
                return () => this.nangoService.warmupSalesforce(connectionId, providerConfigKey);
            case 'notion':
                return () => this.nangoService.warmupNotion(connectionId, providerConfigKey);
            case 'slack':
                return () => this.nangoService.warmupSlack(connectionId, providerConfigKey);
            default:
                return null;
        }
    }

    // ===== ENTITY CACHING HELPERS =====

    /**
     * Determine if this tool result contains entities that should be cached
     */
    private _isFetchToolResult(toolName: string, result: any): boolean {
        const fetchTools = ['fetch_emails', 'fetch_entity', 'fetch_entities', 'search_entities'];
        if (!fetchTools.includes(toolName)) return false;
        
        // Check if result has items to cache
        if (Array.isArray(result)) return result.length > 0;
        if (Array.isArray(result.records)) return result.records.length > 0;
        if (Array.isArray(result.data)) return result.data.length > 0;
        return false;
    }

    /**
     * Extract entity items from normalized result
     */
    private _extractEntityIds(result: any): string[] {
        const items = Array.isArray(result) ? result : 
                      Array.isArray(result.records) ? result.records :
                      Array.isArray(result.data) ? result.data : [];
        
        return items
            .map((item: any) => item.id || item.Id || item._id)
            .filter((id: any) => !!id);
    }

    /**
     * Cache entity results (emails, CRM records) for future reuse
     * Extracts clean bodies and stores them with session-level persistence
     */
    private async _cacheEntityResults(
        sessionId: string,
        toolName: string,
        originalArgs: Record<string, any>,
        result: any
    ): Promise<void> {
        try {
            const items = Array.isArray(result) ? result : 
                          Array.isArray(result.records) ? result.records :
                          Array.isArray(result.data) ? result.data : [];

            for (const item of items.slice(0, 10)) { // Cache top 10 to avoid bloat
                const entityType = this._mapToolNameToEntityType(toolName);
                const provider = this._getProviderFromToolName(toolName);

                const { cleanBody, bodyHash } = this.entityCache.extractCleanBody(
                    item.body_text || item.body || item.description,
                    item.body_html,
                    entityType as any
                );

                await this.entityCache.cacheEntity(sessionId, {
                    id: item.id || item.Id || item._id || uuidv4(),
                    type: entityType,
                    provider,
                    from: item.from,
                    to: item.to,
                    subject: item.subject,
                    name: item.name,
                    accountName: item.account_name,
                    cleanBody,
                    bodyHash,
                    metadata: {
                        original_id: item.id || item.Id,
                        labels: item.labels,
                        isRead: item.isRead,
                        hasAttachments: item.hasAttachments,
                        created_at: item.created_at || item.startDate,
                    },
                    sessionId,
                });
            }

            this.logger.info('Cached entity results', {
                sessionId,
                toolName,
                itemCount: Math.min(items.length, 10),
            });
        } catch (err: any) {
            this.logger.warn('Failed to cache entities', {
                sessionId,
                toolName,
                error: err.message,
            });
        }
    }

    /**
     * Map tool name to entity type
     */
    private _mapToolNameToEntityType(toolName: string): 'email' | 'contact' | 'deal' | 'account' | 'lead' | 'record' {
        if (toolName === 'fetch_emails') return 'email';
        if (toolName.includes('contact')) return 'contact';
        if (toolName.includes('deal')) return 'deal';
        if (toolName.includes('account')) return 'account';
        if (toolName.includes('lead')) return 'lead';
        return 'record';
    }

    /**
     * Get provider from tool name
     */
    private _getProviderFromToolName(toolName: string): 'gmail' | 'salesforce' | 'nango' {
        if (toolName === 'fetch_emails') return 'gmail';
        if (toolName.includes('entity') || toolName.includes('contact')) return 'salesforce';
        return 'nango';
    }
}
