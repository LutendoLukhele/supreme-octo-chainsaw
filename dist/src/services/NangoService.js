"use strict";
// src/services/NangoService.ts
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.NangoService = void 0;
const node_1 = require("@nangohq/node");
const winston_1 = __importDefault(require("winston"));
const config_1 = require("../config"); // Ensure CONFIG.CONNECTION_ID and CONFIG.NANGO_SECRET_KEY exist
class NangoService {
    // This method signature doesn't match how it's used, likely should be removed or implemented
    // executeTool(toolCall: ToolCall) {
    //   throw new Error('Method not implemented.');
    // }
    nango;
    logger;
    // Stores the SINGLE connection ID from config used for ALL calls in this version
    connectionId;
    constructor() {
        // Ensure required config values exist
        if (!config_1.CONFIG.CONNECTION_ID) {
            throw new Error("Configuration error: CONNECTION_ID is missing.");
        }
        if (!config_1.CONFIG.NANGO_SECRET_KEY) {
            throw new Error("Configuration error: NANGO_SECRET_KEY is missing.");
        }
        // Use specific config key if available, otherwise fallback
        this.connectionId = config_1.CONFIG.CONNECTION_ID; // Removed fallback to itself
        if (!this.connectionId) {
            throw new Error("Configuration error: CONNECTION_ID is missing."); // Simplified error message
        }
        this.nango = new node_1.Nango({ secretKey: config_1.CONFIG.NANGO_SECRET_KEY });
        // Initialize logger instance
        this.logger = winston_1.default.createLogger({
            level: process.env.LOG_LEVEL || 'info',
            format: winston_1.default.format.combine(winston_1.default.format.timestamp(), winston_1.default.format.json()),
            defaultMeta: { service: 'NangoService' },
            transports: [
                new winston_1.default.transports.Console({
                    format: winston_1.default.format.combine(winston_1.default.format.colorize(), winston_1.default.format.simple())
                }),
                // Add file transports if needed
            ],
        });
        this.logger.info("NangoService initialized.");
    }
    /**
     * Triggers Salesforce actions via Nango SDK.
     * NOTE: This version includes the explicit parameter reassignment patch.
     * NOTE: This version uses the single connectionId stored during construction.
     */
    async triggerSalesforceAction(providerConfigKey_received, // Expects Nango Key ('salesforce-2')
    connectionId_received, // Expects Connection ID (but uses internal this.connectionId below)
    operation_received, // Expects Operation ('fetch', 'update', 'create')
    entityType_received, // Expects Entity Type ('Account', 'Lead')
    identifierOrFieldsOrPayload_received, fields_received, options_received // Type is SalesforceActionOptions | undefined
    ) {
        // Explicit parameter reassignment (The Patch)
        const providerConfigKey = providerConfigKey_received; // Should be 'salesforce-2'
        // const connectionId = connectionId_received; // Use internal this.connectionId instead
        const operation = operation_received; // Should be 'fetch', 'update', or 'create'
        const entityType = entityType_received;
        const identifierOrFieldsOrPayload = identifierOrFieldsOrPayload_received;
        const fields = fields_received;
        const options = options_received; // options is potentially undefined here
        this.logger.info('Inside triggerSalesforceAction - Values used:', { providerConfigKey: providerConfigKey, internalConnectionIdUsed: this.connectionId ? '***' : 'MISSING', operation: operation, entityType: entityType });
        let actionName;
        let payload = { operation, entityType }; // Use reassigned operation/entityType
        switch (operation) { // Use reassigned operation
            case 'create':
                actionName = 'salesforce-create-entity';
                if (typeof identifierOrFieldsOrPayload === 'object' && !Array.isArray(identifierOrFieldsOrPayload)) {
                    payload.fields = identifierOrFieldsOrPayload;
                }
                else {
                    throw new Error('Fields object required for create.');
                }
                if (options?.records)
                    payload.records = options.records; // Use optional chaining
                if (options?.checkDuplicates !== undefined)
                    payload.checkDuplicates = options.checkDuplicates; // Use optional chaining
                if (options?.duplicateFilters)
                    payload.duplicateFilters = options.duplicateFilters; // Use optional chaining
                if (options?.useTemplate)
                    payload.useTemplate = options.useTemplate; // Use optional chaining
                if (options?.templateParams)
                    payload.templateParams = options.templateParams; // Use optional chaining
                break;
            case 'update':
                actionName = 'salesforce-update-entity';
                if (options?.filters) { // Use optional chaining
                    payload.filters = options.filters;
                }
                else if (typeof identifierOrFieldsOrPayload === 'string' && identifierOrFieldsOrPayload.trim() !== '') {
                    payload.identifier = identifierOrFieldsOrPayload;
                    payload.identifierType = options?.identifierType || 'Id'; // Use optional chaining
                }
                else {
                    throw new Error('Identifier string or filters object required for update.');
                }
                if (typeof fields === 'object' && !Array.isArray(fields) && fields !== null) {
                    payload.fields = fields;
                }
                else {
                    throw new Error('Fields object required for update.');
                }
                if (options?.batchOptions)
                    payload.batchOptions = options.batchOptions; // Use optional chaining
                break;
            case 'fetch':
                actionName = 'salesforce-fetch-entity';
                // Use reassigned variables for payload construction
                if (typeof identifierOrFieldsOrPayload === 'object' && !Array.isArray(identifierOrFieldsOrPayload)) {
                    payload = { operation, entityType, ...identifierOrFieldsOrPayload };
                }
                else if (options?.filters) { // Use optional chaining
                    payload.filters = options.filters;
                }
                else if (typeof identifierOrFieldsOrPayload === 'string') {
                    if (identifierOrFieldsOrPayload === 'all') {
                        payload.filters = { conditions: [] };
                    }
                    else if (identifierOrFieldsOrPayload.trim() !== '') {
                        payload.identifier = identifierOrFieldsOrPayload;
                        payload.identifierType = options?.identifierType || 'Id'; // Use optional chaining
                    }
                    else {
                        this.logger.warn("Empty identifier string received, assuming fetch 'all'.", { entityType });
                        payload.filters = { conditions: [] };
                    }
                }
                else {
                    this.logger.warn("No identifier or filters provided, assuming fetch 'all'.", { entityType });
                    payload.filters = { conditions: [] };
                }
                // Add optional fields using optional chaining directly on 'options'
                // FIX: Use optional chaining `?.` to safely access properties on potentially undefined 'options'
                const effectiveFields = (Array.isArray(fields) && fields.length > 0) ? fields : options?.includeFields;
                if (options?.limit !== undefined)
                    payload.limit = options.limit;
                if (options?.offset !== undefined)
                    payload.offset = options.offset;
                if (effectiveFields && Array.isArray(effectiveFields) && effectiveFields.length > 0)
                    payload.includeFields = effectiveFields;
                // Add other optional fetch params using optional chaining
                if (options?.timeFrame)
                    payload.timeFrame = options.timeFrame;
                if (options?.format)
                    payload.format = options.format;
                if (options?.countOnly !== undefined)
                    payload.countOnly = options.countOnly;
                break;
            default:
                // This error check uses the reassigned 'operation'
                this.logger.error(`NangoService received unsupported operation AFTER internal reassignment`, { operation_received, operation });
                throw new Error(`Unsupported operation (post-reassign): ${operation}`);
        }
        this.logger.info('Triggering Salesforce action via Nango', {
            actionName,
            connectionId: this.connectionId ? '***' : 'MISSING', // Use internal connectionId
            payload: JSON.stringify(payload).substring(0, 200) + "..." // Log truncated payload
        });
        try {
            const response = await this.nango.triggerAction(providerConfigKey, // Use the Nango key (e.g., 'salesforce-2')
            this.connectionId, // Use the connection ID stored in this service instance
            actionName, payload);
            this.logger.info('Nango action response received', { actionName, connectionId: this.connectionId ? '***' : 'MISSING' });
            return response;
        }
        catch (error) {
            this.logger.error('Nango triggerAction failed', { error: error.message, actionName, connectionId: this.connectionId ? '***' : 'MISSING' });
            throw error; // Re-throw for orchestrator
        }
    }
    /**
     * Fetches emails via Nango SDK.
     * Corrected signature to accept providerConfigKey and connectionId.
     */
    async fetchEmails(providerConfigKey, // e.g., 'google-mail'
    connectionId, // specific connection ID
    options) {
        const actionName = 'fetch-emails';
        const payload = {};
        if (options?.backfillPeriodMs)
            payload.backfillPeriodMs = options.backfillPeriodMs;
        if (options?.filters)
            payload.filters = options.filters;
        this.logger.info('Fetching emails via Nango', { actionName, connectionId: connectionId ? '***' : 'MISSING' });
        try {
            const response = await this.nango.triggerAction(providerConfigKey, // Use passed Nango key
            connectionId, // Use passed connection ID
            actionName, payload);
            const dataLength = Array.isArray(response?.data) ? response.data.length : 0;
            this.logger.info('Email fetch completed successfully', { count: dataLength, connectionId: connectionId ? '***' : 'MISSING' });
            return response;
        }
        catch (error) {
            this.logger.error('Failed to fetch emails via Nango', { error: error.message || error, connectionId: connectionId ? '***' : 'MISSING' });
            throw error;
        }
    }
    // Add generic proxy method if needed elsewhere
    async proxy(params) {
        this.logger.info(`Proxying request via Nango`, { provider: params.providerConfigKey, method: params.method });
        try {
            const response = await this.nango.proxy(params);
            return response;
        }
        catch (error) {
            this.logger.error('Nango proxy request failed', { error: error.message, provider: params.providerConfigKey });
            throw error;
        }
    }
}
exports.NangoService = NangoService;
