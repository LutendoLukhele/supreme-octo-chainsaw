"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ToolOrchestrator = void 0;
const BaseService_1 = require("../base/BaseService");
const winston_1 = __importDefault(require("winston"));
const uuid_1 = require("uuid");
const config_1 = require("../../config");
const ioredis_1 = __importDefault(require("ioredis"));
const serverless_1 = require("@neondatabase/serverless");
const logger = winston_1.default.createLogger({
    level: 'info',
    format: winston_1.default.format.combine(winston_1.default.format.timestamp(), winston_1.default.format.json()),
    transports: [new winston_1.default.transports.Console()],
});
const redis = new ioredis_1.default(config_1.CONFIG.REDIS_URL);
const sql = (0, serverless_1.neon)('postgresql://neondb_owner:npg_DZ9VLGrHc7jf@ep-hidden-field-advbvi8f-pooler.c-2.us-east-1.aws.neon.tech/neondb?sslmode=require');
class ToolOrchestrator extends BaseService_1.BaseService {
    constructor(config) {
        super({ logger: config.logger });
        this.nangoService = config.nangoService;
        this.toolConfigManager = config.toolConfigManager;
        logger.info("ToolOrchestrator initialized with Redis + Postgres fallback.");
    }
    async executeTool(toolCall, planId, stepId) {
        const executionId = toolCall.id || (0, uuid_1.v4)();
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
            let finalData;
            if (nangoResult && typeof nangoResult.truncated_response === 'string') {
                try {
                    finalData = JSON.parse(nangoResult.truncated_response);
                }
                catch {
                    finalData = { error: 'Failed to parse truncated response.', raw: nangoResult.truncated_response };
                }
            }
            else if (nangoResult?.success === false) {
                return { status: 'failed', toolName, data: null, error: nangoResult.message };
            }
            else {
                finalData = nangoResult;
            }
            return { status: 'success', toolName, data: finalData, error: '' };
        }
        catch (error) {
            logger.error('Tool execution failed unexpectedly in orchestrator', { error: error.message, stack: error.stack, toolCall });
            const errorResponse = {
                status: 'failed',
                toolName: toolCall.name,
                data: null,
                error: error.message || 'Unknown error'
            };
            if (error.nangoErrorDetails) {
                errorResponse.errorDetails = error.nangoErrorDetails;
            }
            return errorResponse;
        }
    }
    _normalizeFetchEntityArgs(args) {
        const wrapIfPresent = (value) => {
            if (value === undefined)
                return undefined;
            return { type: value, nullable: value == null };
        };
        const identifierWrapped = (() => {
            if (args.identifier === 'all')
                return { type: 'all', nullable: false };
            return wrapIfPresent(args.identifier);
        })();
        const filters = (args.filters && Object.keys(args.filters).length > 0) ? args.filters : undefined;
        return {
            operation: args.operation || 'fetch',
            entityType: args.entityType,
            identifier: identifierWrapped,
            identifierType: wrapIfPresent(args.identifierType),
            timeFrame: wrapIfPresent(args.timeFrame),
            filters: filters,
            format: wrapIfPresent(args.format),
            countOnly: { type: !!args.countOnly, nullable: false },
            limit: wrapIfPresent(args.limit)
        };
    }
    async resolveConnectionId(userId, providerConfigKey) {
        this.logger.info(`Querying database for connectionId`, { userId, providerConfigKey });
        const rows = await sql `
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
    async executeNangoActionDispatcher(toolCall) {
        const { name: toolName, arguments: args, userId } = toolCall;
        const providerConfigKey = this.toolConfigManager.getProviderConfigKeyForTool(toolName);
        if (!providerConfigKey)
            throw new Error(`Missing providerConfigKey for tool: ${toolName}`);
        const connectionId = await this.resolveConnectionId(userId, providerConfigKey);
        if (!connectionId)
            throw new Error(`No active connectionId found for user ${userId} for provider ${providerConfigKey}`);
        this.logger.info(`Dispatching tool`, { toolName, userId, providerConfigKey, connectionId });
        switch (toolName) {
            case 'send_email':
                return this.nangoService.sendEmail(providerConfigKey, connectionId, args);
            case 'fetch_emails':
                return this.nangoService.fetchEmails(providerConfigKey, connectionId, args);
            case 'create_entity':
            case 'update_entity':
            case 'fetch_entity':
                return this.nangoService.triggerSalesforceAction(providerConfigKey, connectionId, args);
            case 'create_zoom_meeting':
                return this.nangoService.triggerGenericNangoAction(providerConfigKey, connectionId, toolName, args);
            default:
                throw new Error(`No Nango handler for tool: ${toolName}`);
        }
    }
}
exports.ToolOrchestrator = ToolOrchestrator;
