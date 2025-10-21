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
        this.dataDependencyService = config.dataDependencyService;
        this.resolver = config.resolver;
        logger.info("ToolOrchestrator initialized to use Redis for connection lookups.");
    }
    async executeTool(toolCall, planId, stepId) {
        const executionId = toolCall.id || (0, uuid_1.v4)();
        const { name: toolName, arguments: args } = toolCall;
        this.logger.info(`Orchestrator executing validated tool: '${toolName}'`, { executionId, toolName });
        const stepResult = {
            planId,
            stepId,
            status: 'running',
            startedAt: new Date(),
            rawOutput: null,
        };
        try {
            const resolvedArgs = await this.resolver.resolve(planId, args);
            const sanitizedArgs = this.sanitizeToolArgs(toolName, resolvedArgs);
            toolCall.arguments = sanitizedArgs;
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
                stepResult.status = 'failed';
                stepResult.endedAt = new Date();
                this.dataDependencyService.saveStepResult(stepResult);
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
            stepResult.status = 'completed';
            stepResult.rawOutput = finalData;
            stepResult.endedAt = new Date();
            this.dataDependencyService.saveStepResult(stepResult);
            return {
                status: 'success',
                toolName: toolName,
                data: finalData,
                error: ''
            };
        }
        catch (error) {
            logger.error('Tool execution failed unexpectedly in orchestrator', { error: error.message, stack: error.stack, toolCall });
            stepResult.status = 'failed';
            stepResult.endedAt = new Date();
            this.dataDependencyService.saveStepResult(stepResult);
            return {
                status: 'failed',
                toolName: toolName,
                data: null,
                error: error instanceof Error ? error.message : 'Unknown orchestrator exception'
            };
        }
    }
    sanitizeToolArgs(toolName, args) {
        if (!args || typeof args !== 'object') {
            return args;
        }
        switch (toolName) {
            case 'fetch_emails':
                return this.sanitizeFetchEmailsArgs(args);
            default:
                return args;
        }
    }
    sanitizeFetchEmailsArgs(args) {
        const sanitizedArgs = { ...args };
        if (!sanitizedArgs.operation) {
            sanitizedArgs.operation = 'fetch';
        }
        const filters = (sanitizedArgs.filters && typeof sanitizedArgs.filters === 'object')
            ? { ...sanitizedArgs.filters }
            : {};
        const numericLimit = this.parseNumeric(filters.limit);
        if (numericLimit === null || !Number.isFinite(numericLimit) || numericLimit <= 0) {
            filters.limit = 7;
        }
        else if (numericLimit > 50) {
            filters.limit = 50;
        }
        else {
            filters.limit = Math.floor(numericLimit);
        }
        const dateRange = (filters.dateRange && typeof filters.dateRange === 'object')
            ? { ...filters.dateRange }
            : undefined;
        if (dateRange) {
            const afterTimestamp = this.parseDate(dateRange.after);
            const beforeTimestamp = this.parseDate(dateRange.before);
            const sanitizedDateRange = {};
            if (afterTimestamp) {
                sanitizedDateRange.after = new Date(afterTimestamp).toISOString();
            }
            else if (dateRange.after) {
                this.logger.debug('Dropping invalid fetch_emails dateRange.after', { provided: dateRange.after });
            }
            if (beforeTimestamp && (!afterTimestamp || beforeTimestamp > afterTimestamp)) {
                sanitizedDateRange.before = new Date(beforeTimestamp).toISOString();
            }
            else if (dateRange.before) {
                this.logger.debug('Dropping invalid fetch_emails dateRange.before', { provided: dateRange.before });
            }
            if (Object.keys(sanitizedDateRange).length > 0) {
                filters.dateRange = sanitizedDateRange;
            }
            else {
                delete filters.dateRange;
            }
        }
        const sanitizedFilterKeys = Object.keys(filters).filter(key => {
            const value = filters[key];
            if (value === undefined || value === null) {
                return false;
            }
            if (typeof value === 'object' && Object.keys(value).length === 0) {
                return false;
            }
            return true;
        });
        if (sanitizedFilterKeys.length > 0) {
            sanitizedArgs.filters = filters;
        }
        else {
            delete sanitizedArgs.filters;
        }
        return sanitizedArgs;
    }
    parseNumeric(value) {
        if (typeof value === 'number') {
            return value;
        }
        if (typeof value === 'string') {
            const parsed = Number(value);
            return Number.isFinite(parsed) ? parsed : null;
        }
        return null;
    }
    parseDate(value) {
        if (typeof value !== 'string') {
            return null;
        }
        const trimmed = value.trim();
        if (!trimmed) {
            return null;
        }
        const timestamp = Date.parse(trimmed);
        if (Number.isNaN(timestamp)) {
            return null;
        }
        const MIN_VALID_TIMESTAMP = Date.parse('2000-01-01T00:00:00Z');
        if (timestamp < MIN_VALID_TIMESTAMP) {
            return null;
        }
        return timestamp;
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
