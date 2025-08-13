"use strict";
// src/services/NangoService.ts
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.NangoService = void 0;
const node_1 = require("@nangohq/node");
const winston_1 = __importDefault(require("winston"));
const config_1 = require("../config");
const axios_1 = __importDefault(require("axios"));
class NangoService {
    nango;
    logger;
    constructor() {
        if (!config_1.CONFIG.NANGO_SECRET_KEY) {
            throw new Error("Configuration error: NANGO_SECRET_KEY is missing.");
        }
        this.logger = winston_1.default.createLogger({ /* ... */});
        this.nango = new node_1.Nango({ secretKey: config_1.CONFIG.NANGO_SECRET_KEY });
        this.logger.info(`NangoService initialized.`);
    }
    // --- FIX: This method is now fully aligned with all Salesforce Nango scripts ---
    async triggerSalesforceAction(providerConfigKey, connectionId, operation, entityType, identifierOrFields, fields, options) {
        this.logger.info('Executing Salesforce action', { providerConfigKey, operation, entityType });
        let actionName;
        // The payload now includes the operation and entityType at the top level, as expected by the scripts
        let payload = { operation, entityType, ...options };
        switch (operation) {
            case 'create':
                actionName = 'salesforce-create-entity';
                // The script expects a 'records' array for batch creation.
                // If we are creating a single entity, we wrap the 'fields' object in an array.
                if (options?.records) {
                    payload.records = options.records;
                }
                else if (identifierOrFields) {
                    payload.records = [identifierOrFields]; // Wrap single object
                }
                break;
            case 'update':
                actionName = 'salesforce-update-entity';
                payload.identifier = identifierOrFields;
                payload.fields = fields;
                break;
            case 'fetch':
                actionName = 'salesforce-fetch-entity';
                // The script expects the identifier to be a string, not an object
                payload.identifier = { type: identifierOrFields };
                if (fields) {
                    payload.filters = { ...(payload.filters || {}), includeFields: fields };
                }
                break;
            default:
                throw new Error(`Unsupported Salesforce operation: ${operation}`);
        }
        this.logger.info('Triggering Nango action via direct API call', { actionName, payload });
        try {
            const response = await axios_1.default.post('https://api.nango.dev/action/trigger', { action_name: actionName, input: payload }, {
                headers: {
                    'Authorization': `Bearer ${config_1.CONFIG.NANGO_SECRET_KEY}`,
                    'Provider-Config-Key': providerConfigKey,
                    'Connection-Id': connectionId,
                    'Content-Type': 'application/json'
                }
            });
            return response.data;
        }
        catch (error) {
            this.logger.error('Nango direct API call failed', {
                error: error.response?.data || error.message, actionName
            });
            throw new Error(error.response?.data?.message || `Request failed with status code ${error.response?.status}`);
        }
    }
    // --- FIX: Aligned with fetch-emails.ts script ---
    async fetchEmails(providerConfigKey, connectionId, input // The entire input from the tool call is the payload
    ) {
        const actionName = 'fetch-emails';
        this.logger.info('Fetching emails via Nango', { actionName, input });
        try {
            const response = await this.nango.triggerAction(providerConfigKey, connectionId, actionName, input);
            return response;
        }
        catch (error) {
            this.logger.error('Failed to fetch emails via Nango', { error: error.message || error });
            throw error;
        }
    }
    // --- FIX: Aligned with events.ts script ---
    async fetchCalendarEvents(providerConfigKey, connectionId, args // Pass the arguments directly as the payload
    ) {
        const actionName = 'fetch-events';
        this.logger.info('Fetching calendar events via Nango', { actionName, args });
        try {
            const response = await this.nango.triggerAction(providerConfigKey, connectionId, actionName, args);
            return response;
        }
        catch (error) {
            this.logger.error('Failed to fetch calendar events', { error: error.message || error });
            throw error;
        }
    }
    // --- FIX: Aligned with event creation script (if one exists, follows same pattern) ---
    async createCalendarEvent(providerConfigKey, connectionId, args // Pass the arguments directly as the payload
    ) {
        const actionName = 'create-event';
        this.logger.info('Creating calendar event via Nango', { actionName });
        try {
            const response = await this.nango.triggerAction(providerConfigKey, connectionId, actionName, args);
            return response;
        }
        catch (error) {
            this.logger.error('Failed to create calendar event', { error: error.message || error });
            throw error;
        }
    }
}
exports.NangoService = NangoService;
