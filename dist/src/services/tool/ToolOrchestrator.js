"use strict";
// src/services/tool/ToolOrchestrator.ts
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ToolOrchestrator = void 0;
const BaseService_1 = require("../base/BaseService"); // Assuming BaseService exists and provides logger
const winston_1 = __importDefault(require("winston"));
const uuid_1 = require("uuid");
const config_1 = require("../../config");
const logger = winston_1.default.createLogger({
    level: 'info',
    format: winston_1.default.format.combine(winston_1.default.format.timestamp(), winston_1.default.format.json()),
    transports: [new winston_1.default.transports.Console()],
});
class ToolOrchestrator extends BaseService_1.BaseService {
    // Remove activeTools map if not used for tracking/cancellation
    // private activeTools: Map<string, ToolCall>;
    nangoService;
    toolConfigManager; // Store instance
    constructor(config) {
        super({ logger: config.logger, }); // Pass name and description
        // this.activeTools = new Map();
        this.nangoService = config.nangoService;
        this.toolConfigManager = config.toolConfigManager; // Store injected manager
        logger.info("ToolOrchestrator initialized.");
    }
    /**
     * Executes a tool call, routes to Nango, maps the result.
     */
    async executeTool(toolCall) {
        const sessionId = toolCall.sessionId || 'unknown-session';
        const executionId = toolCall.id || (0, uuid_1.v4)(); // Use provided ID or generate one
        try {
            this.logger.info('Executing tool', { tool: toolCall.name, args: toolCall.arguments, sessionId, executionId });
            // this.activeTools.set(sessionId, toolCall); // Removed tracking map
            // --- Call internal dispatcher ---
            const nangoResult = await this.executeNangoActionDispatcher(toolCall);
            // --- End Nango Call ---
            logger.debug(`Raw Nango response for ${toolCall.name}`, { executionId, response: nangoResult });
            // --- Check Nango response success/failure ---
            const isSuccess = nangoResult.success === true;
            const errors = nangoResult.errors;
            let errorMessage = nangoResult.message;
            if (errors && ((Array.isArray(errors) && errors.length > 0) || typeof errors === 'string')) {
                errorMessage = Array.isArray(errors) ? errors.map(e => typeof e === 'string' ? e : JSON.stringify(e)).join('; ') : errors;
            }
            // --- End Check ---
            // --- Return Correct ToolResult ---
            if (isSuccess) {
                this.logger.info(`Tool execution successful`, { tool: toolCall.name, executionId });
                return {
                    status: 'success', toolName: toolCall.name,
                    data: nangoResult.hasOwnProperty('data') ? nangoResult.data : nangoResult,
                    error: ''
                };
            }
            else {
                this.logger.warn(`Tool execution failed according to Nango`, { tool: toolCall.name, executionId, nangoSuccess: nangoResult.success, errors: errors, message: nangoResult.message });
                return {
                    status: 'failed', toolName: toolCall.name, data: null,
                    error: errorMessage || `Tool '${toolCall.name}' failed.`
                };
            }
            // --- End Return ---
        }
        catch (error) {
            logger.error('Tool execution failed unexpectedly in orchestrator', { error: error.message, stack: error.stack, toolCall });
            // this.activeTools.delete(sessionId); // Removed tracking map
            return {
                status: 'failed', toolName: toolCall.name, data: null,
                error: error instanceof Error ? error.message : 'Unknown orchestrator exception'
            };
        }
        // finally { // Optional cleanup if needed
        //     this.activeTools.delete(sessionId);
        // }
    }
    /**
     * Internal function to map tool calls to specific NangoService methods.
     * This is where the dispatch logic belongs.
     */
    async executeNangoActionDispatcher(toolCall) {
        const { name: toolName, arguments: args } = toolCall;
        const { operation, entityType, identifier, fields, /* ... */ } = args;
        // --- Determine Provider Config Key & Connection ID ---
        // STEP 1: Get Nango Provider Config Key DIRECTLY using the Tool Name
        // **** REVERTED TO DIRECT LOOKUP ****
        const providerConfigKey = this.toolConfigManager.getProviderConfigKeyForTool(toolName);
        logger.debug(`Dispatcher: Looked up provider config key for tool '${toolName}': ${providerConfigKey}`);
        if (!providerConfigKey) {
            // This error means toolName not found or its providerConfigKey is missing/invalid in JSON
            logger.error(`Configuration error: Cannot find Nango provider config key for tool: ${toolName}`);
            throw new Error(`Configuration missing 'providerConfigKey' for tool: ${toolName}`);
        }
        // STEP 2: Get Connection ID (Placeholder - Needs dynamic lookup passed from server.ts)
        // *** This lookup MUST eventually be dynamic based on the providerConfigKey and user session ***
        let connectionId;
        if (providerConfigKey === 'salesforce-2') { // Example Mapping
            connectionId = config_1.CONFIG.CONNECTION_ID; // Get specific ID
        }
        else if (providerConfigKey === 'google-mail') {
            connectionId = config_1.CONFIG.CONNECTION_ID; // Get specific ID
        }
        else {
            connectionId = config_1.CONFIG.CONNECTION_ID; // Fallback to generic? Less ideal.
            logger.warn(`Using default NANGO_CONNECTION_ID for provider key ${providerConfigKey}`);
        }
        // const connectionId = CONFIG.NANGO_CONNECTION_ID; // Old placeholder
        if (!connectionId) {
            logger.error(`Connection ID could not be determined for provider key ${providerConfigKey}`);
            throw new Error(`Connection ID could not be determined for provider key ${providerConfigKey}.`);
        }
        logger.debug(`Dispatcher: Using Connection ID: ${connectionId ? '***' : 'N/A'}`);
        // --- End ID Lookup ---
        logger.info('Dispatching Nango action call', { tool: toolName, providerConfigKey });
        // --- Switch on Tool Name ---
        switch (toolName) {
            case 'create_entity':
            case 'update_entity':
            case 'fetch_entity':
                if (!operation || !entityType)
                    throw new Error(`Missing op/entityType for ${toolName}`);
                // Pass the looked-up providerConfigKey and connectionId
                return await this.nangoService.triggerSalesforceAction(providerConfigKey, connectionId, operation, entityType, identifier || fields || args, fields, args);
            case 'fetch_emails':
                // Pass the looked-up providerConfigKey and connectionId
                return await this.nangoService.fetchEmails(providerConfigKey, args);
            // case 'send_email': ...
            default:
                throw new Error(`Unknown or unhandled tool: ${toolName}`);
        }
    }
}
exports.ToolOrchestrator = ToolOrchestrator;
