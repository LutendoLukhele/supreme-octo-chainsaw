import { BaseService } from '../base/BaseService';
import { ToolCall } from './tool.types';
import { NangoService } from '../NangoService';
import { ToolResult } from '../conversation/types';
import winston from 'winston';
import { ToolConfigManager } from './ToolConfigManager';
import { v4 as uuidv4 } from 'uuid';
import { CONFIG } from '../../config';
import Redis from 'ioredis';
import { Run } from './run.types';
import { neon } from '@neondatabase/serverless';

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
    transports: [new winston.transports.Console()],
});

const redis = new Redis(CONFIG.REDIS_URL!);
const sql = neon('postgresql://neondb_owner:npg_DZ9VLGrHc7jf@ep-hidden-field-advbvi8f-pooler.c-2.us-east-1.aws.neon.tech/neondb?sslmode=require');

export class ToolOrchestrator extends BaseService {
    private nangoService: NangoService;
    private toolConfigManager: ToolConfigManager;
    logger: any;

    constructor(config: { logger: winston.Logger; nangoService: NangoService; toolConfigManager: ToolConfigManager; [key: string]: any; }) {
        super({ logger: config.logger });
        this.nangoService = config.nangoService;
        this.toolConfigManager = config.toolConfigManager;
        logger.info("ToolOrchestrator initialized with Redis + Postgres fallback.");
    }

    async executeTool(toolCall: ToolCall, planId: string, stepId: string): Promise<ToolResult> {
        const executionId = toolCall.id || uuidv4();
        const { name: toolName, arguments: originalArgs } = toolCall;

        this.logger.info(`Executing tool: '${toolName}'`, { executionId, toolName, userId: toolCall.userId });

        try {
            const toolCallToExecute = { ...toolCall };
            const originalArgs = toolCall.arguments?.input || toolCall.arguments || {};

            if (toolName === 'fetch_entity') {
                this.logger.info('Applying fetch_entity normalization logic.');
                toolCallToExecute.arguments = this._normalizeFetchEntityArgs(originalArgs);
            }

            const nangoResult = await this.executeNangoActionDispatcher(toolCallToExecute);

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

            return { status: 'success', toolName, data: finalData, error: '' };

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

    return {
        operation: args.operation || 'fetch',
        // entityType must be a plain string (don't wrap it)
        entityType: args.entityType,
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


    private async resolveConnectionId(userId: string, providerConfigKey: string): Promise<string | null> {
        this.logger.info(`Querying database for connectionId`, { userId, providerConfigKey });
    
        const rows = await sql`
            SELECT connection_id FROM user_connections 
            WHERE user_id = ${userId} AND provider = ${providerConfigKey}
        `;
    
        if (rows.length > 0 && rows[0].connection_id) {
            const connectionId = rows[0].connection_id;
            this.logger.info(`Resolved connectionId from database`, { userId, providerConfigKey, connectionId: '***' });
            return connectionId;
        }
    
        this.logger.error(`No connectionId found for user and provider`, { userId, providerConfigKey });
        return null;
    }


    private async executeNangoActionDispatcher(toolCall: ToolCall): Promise<any> {
        const { name: toolName, arguments: args, userId } = toolCall;
        const providerConfigKey = this.toolConfigManager.getProviderConfigKeyForTool(toolName);

        if (!providerConfigKey) throw new Error(`Missing providerConfigKey for tool: ${toolName}`);

        const connectionId = await this.resolveConnectionId(userId, providerConfigKey);
        if (!connectionId) throw new Error(`No active connectionId found for user ${userId} for provider ${providerConfigKey}`);

        this.logger.info(`Dispatching tool`, { toolName, userId, providerConfigKey, connectionId });

        switch (toolName) {
            case 'send_email':
                return this.nangoService.sendEmail(providerConfigKey, connectionId, args as any);
            case 'fetch_emails':
                return this.nangoService.fetchEmails(providerConfigKey, connectionId, args);
            case 'create_entity':
            case 'update_entity':
            case 'fetch_entity':
                return this.nangoService.triggerSalesforceAction(providerConfigKey, connectionId, args as any);
            case 'create_zoom_meeting':
                return this.nangoService.triggerGenericNangoAction(providerConfigKey, connectionId, toolName, args);
            default:
                throw new Error(`No Nango handler for tool: ${toolName}`);
        }
    }
}
