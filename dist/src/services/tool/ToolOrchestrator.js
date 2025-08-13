"use strict";
// src/services/tool/ToolOrchestrator.ts
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
    nangoService;
    toolConfigManager;
    constructor(config) {
        super({ logger: config.logger });
        this.nangoService = config.nangoService;
        this.toolConfigManager = config.toolConfigManager;
        logger.info("ToolOrchestrator initialized to use Redis for connection lookups.");
    }
    async executeTool(toolCall) {
        const executionId = toolCall.id || (0, uuid_1.v4)();
        const { name: toolName } = toolCall;
        // This service now assumes the tool call has been validated by a higher-level service
        // like ActionLauncherService. Its only job is to execute.
        this.logger.info(`Orchestrator executing validated tool: '${toolName}'`, { executionId, toolName });
        try {
            const nangoResult = await this.executeNangoActionDispatcher(toolCall);
            const isSuccess = nangoResult.success === true || (nangoResult.success === undefined && nangoResult.data !== undefined);
            if (isSuccess) {
                this.logger.info(`Tool execution successful`, { tool: toolName, executionId });
                return {
                    status: 'success',
                    toolName: toolName,
                    data: nangoResult.hasOwnProperty('data') ? nangoResult.data : nangoResult,
                    error: ''
                };
            }
            else {
                const errorMessage = nangoResult.message || `Tool '${toolName}' failed.`;
                this.logger.warn(`Tool execution failed`, { tool: toolName, executionId, errors: nangoResult.errors, message: errorMessage });
                return {
                    status: 'failed', toolName: toolName, data: null, error: errorMessage
                };
            }
        }
        catch (error) {
            logger.error('Tool execution failed unexpectedly in orchestrator', { error: error.message, stack: error.stack, toolCall });
            return {
                status: 'failed', toolName: toolName, data: null,
                error: error instanceof Error ? error.message : 'Unknown orchestrator exception'
            };
        }
    }
    async executeNangoActionDispatcher(toolCall) {
        const { name: toolName, arguments: args, sessionId, userId } = toolCall;
        if (!userId) {
            throw new Error(`User ID is missing from the tool call for tool '${toolName}'.`);
        }
        const providerConfigKey = this.toolConfigManager.getProviderConfigKeyForTool(toolName);
        if (!providerConfigKey || providerConfigKey === '__META__') {
            // This should ideally never be reached now that ActionLauncherService handles meta tools.
            throw new Error(`Attempted to execute a tool with an invalid providerConfigKey: ${toolName}`);
        }
        const activeConnectionKey = `active-connection:${userId}`;
        const connectionId = await redis.get(activeConnectionKey);
        if (!connectionId) {
            throw new Error(`No active Nango connection found to execute tool '${toolName}'.`);
        }
        switch (toolName) {
            case 'create_entity':
            case 'update_entity':
            case 'fetch_entity':
                return await this.nangoService.triggerSalesforceAction(providerConfigKey, connectionId, args.operation, args.entityType, args.identifier || args.fields || args, args.fields, args);
            case 'fetch_emails':
                return await this.nangoService.fetchEmails(providerConfigKey, connectionId, args);
            case 'fetch_calendar_events':
                return await this.nangoService.fetchCalendarEvents(providerConfigKey, connectionId, args);
            case 'create_calendar_event':
                return await this.nangoService.createCalendarEvent(providerConfigKey, connectionId, args);
            default:
                throw new Error(`Unknown or unhandled tool in orchestrator: ${toolName}`);
        }
    }
}
exports.ToolOrchestrator = ToolOrchestrator;
