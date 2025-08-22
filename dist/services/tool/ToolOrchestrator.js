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
const logger = winston_1.default.createLogger({
    level: 'info',
    format: winston_1.default.format.combine(winston_1.default.format.timestamp(), winston_1.default.format.json()),
    transports: [new winston_1.default.transports.Console()],
});
const redis = new ioredis_1.default(config_1.CONFIG.REDIS_URL);
class ToolOrchestrator extends BaseService_1.BaseService {
    constructor(config) {
        super({ logger: config.logger });
        this.nangoService = config.nangoService;
        this.toolConfigManager = config.toolConfigManager;
        logger.info("ToolOrchestrator initialized to use Redis for connection lookups.");
    }
    async executeTool(toolCall) {
        const executionId = toolCall.id || (0, uuid_1.v4)();
        const { name: toolName } = toolCall;
        this.logger.info(`Orchestrator executing validated tool: '${toolName}'`, { executionId, toolName });
        try {
            const nangoResult = await this.executeNangoActionDispatcher(toolCall);
            let finalData;
            if (nangoResult && typeof nangoResult.truncated_response === 'string') {
                this.logger.warn('Nango returned a truncated_response. Parsing partial data.', { tool: toolName });
                try {
                    finalData = JSON.parse(nangoResult.truncated_response);
                }
                catch (parseError) {
                    this.logger.error('Failed to parse truncated_response from Nango.', { parseError, tool: toolName });
                    finalData = {
                        error: 'Failed to parse truncated response from Nango. Data may be incomplete.',
                        raw: nangoResult.truncated_response
                    };
                }
            }
            else if (nangoResult?.success === false) {
                const errorMessage = nangoResult.message || `Tool '${toolName}' failed.`;
                this.logger.warn(`Tool execution failed`, { tool: toolName, executionId, errors: nangoResult.errors, message: errorMessage });
                return {
                    status: 'failed',
                    toolName: toolName,
                    data: null,
                    error: errorMessage
                };
            }
            else {
                finalData = nangoResult;
            }
            this.logger.info(`Tool execution successful`, { tool: toolName, executionId });
            return {
                status: 'success',
                toolName: toolName,
                data: finalData,
                error: ''
            };
        }
        catch (error) {
            logger.error('Tool execution failed unexpectedly in orchestrator', { error: error.message, stack: error.stack, toolCall });
            return {
                status: 'failed',
                toolName: toolName,
                data: null,
                error: error instanceof Error ? error.message : 'Unknown orchestrator exception'
            };
        }
    }
    _normalizeFetchEntityArgs(args) {
        if (args.identifier && typeof args.identifier.type === 'object' && args.identifier.type !== null) {
            this.logger.warn('Malformed fetch_entity arguments detected. Applying normalization patch.', { originalArgs: args });
            const nestedArgs = args.identifier.type;
            const newArgs = {
                operation: nestedArgs.operation || 'fetch',
                entityType: nestedArgs.entityType,
                filters: nestedArgs.filters,
                ...args.fields
            };
            this.logger.info('Arguments have been successfully normalized.', { newArgs });
            return newArgs;
        }
        return args;
    }
    async executeNangoActionDispatcher(toolCall) {
        const { name: toolName, arguments: args, userId } = toolCall;
        const providerConfigKey = this.toolConfigManager.getProviderConfigKeyForTool(toolName);
        if (!providerConfigKey) {
            throw new Error(`Configuration missing 'providerConfigKey' for tool: ${toolName}`);
        }
        const connectionId = await redis.get(`active-connection:${userId}`);
        if (!connectionId) {
            throw new Error(`No active Nango connection found to execute tool '${toolName}'.`);
        }
        this.logger.info(`Dispatching tool '${toolName}' with correct IDs.`, { providerConfigKey });
        switch (toolName) {
            case 'fetch_emails':
                return this.nangoService.fetchEmails(providerConfigKey, connectionId, args);
            case 'create_zoom_meeting':
                return this.nangoService.createCalendarEvent(providerConfigKey, connectionId, args);
            case 'create_entity':
            case 'update_entity':
            case 'fetch_entity':
                return this.nangoService.triggerSalesforceAction(providerConfigKey, connectionId, args);
            default:
                throw new Error(`No Nango action handler mapped for tool: ${toolName}`);
        }
    }
}
exports.ToolOrchestrator = ToolOrchestrator;
