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
class NangoService {
    executeTool(toolCall) {
        throw new Error('Method not implemented.');
    }
    nango;
    logger;
    connectionId;
    constructor() {
        this.connectionId = config_1.CONFIG.CONNECTION_ID;
        // Initialize Nango with the secret key
        this.nango = new node_1.Nango({ secretKey: '7addd614-fda8-48a2-9c79-5443fda50a84' });
        this.logger = winston_1.default.createLogger({
            level: 'info',
            format: winston_1.default.format.json(),
            transports: [
                new winston_1.default.transports.Console(),
                // Add other transports if needed, e.g., File transport
            ],
        });
    }
    // Enhanced method to trigger Salesforce actions using Nango SDK with support for advanced options
    async triggerSalesforceAction(operation, entityType, identifierOrFieldsOrPayload, fields, options) {
        let actionName;
        let payload = { operation, entityType };
        switch (operation) {
            case 'create':
                actionName = 'salesforce-create-entity';
                // Handle complete payload object if provided
                if (typeof identifierOrFieldsOrPayload === 'object') {
                    payload.fields = identifierOrFieldsOrPayload;
                }
                else {
                    throw new Error('Fields must be provided as an object for create operation.');
                }
                // Add new options for create operation
                if (options) {
                    if (options.records)
                        payload.records = options.records;
                    if (options.checkDuplicates !== undefined)
                        payload.checkDuplicates = options.checkDuplicates;
                    if (options.duplicateFilters)
                        payload.duplicateFilters = options.duplicateFilters;
                    if (options.useTemplate)
                        payload.useTemplate = options.useTemplate;
                    if (options.templateParams)
                        payload.templateParams = options.templateParams;
                }
                break;
            case 'update':
                actionName = 'salesforce-update-entity';
                // Handle case where we use filters instead of a direct identifier
                if (options?.filters) {
                    payload.filters = options.filters;
                }
                else if (typeof identifierOrFieldsOrPayload === 'string') {
                    payload.identifier = identifierOrFieldsOrPayload;
                    if (options?.identifierType) {
                        payload.identifierType = options.identifierType;
                    }
                }
                else {
                    throw new Error('Either identifier or filters must be provided for update operation.');
                }
                // Add fields for update operation
                if (typeof fields === 'object' && !Array.isArray(fields)) {
                    payload.fields = fields;
                }
                else {
                    throw new Error('Fields must be an object for update operation.');
                }
                // Add batch options if provided
                if (options?.batchOptions) {
                    payload.batchOptions = options.batchOptions;
                }
                break;
            case 'fetch':
                actionName = 'salesforce-fetch-entity';
                // Handle case where third parameter is a complete payload object
                if (typeof identifierOrFieldsOrPayload === 'object' && !Array.isArray(identifierOrFieldsOrPayload)) {
                    // Use the provided payload directly
                    payload = {
                        operation,
                        entityType,
                        ...identifierOrFieldsOrPayload
                    };
                }
                else if (options?.filters) {
                    // Use structured filters for fetching multiple records
                    payload.filters = options.filters;
                }
                else if (typeof identifierOrFieldsOrPayload === 'string') {
                    // Handle traditional string identifier
                    // Special case for 'all' identifier - use empty filters
                    if (identifierOrFieldsOrPayload === 'all') {
                        payload.filters = { conditions: [] }; // Empty conditions array to fetch all records
                    }
                    else {
                        // For normal identifier, add both identifier and identifierType
                        payload.identifier = identifierOrFieldsOrPayload;
                        payload.identifierType = options?.identifierType || 'Id'; // Default to 'Id' as the identifier type
                    }
                }
                else {
                    throw new Error('Either identifier or filters must be provided for fetch operation.');
                }
                // Add additional fetch options
                if (options) {
                    if (options.timeFrame)
                        payload.timeFrame = options.timeFrame;
                    if (options.format)
                        payload.format = options.format;
                    if (options.countOnly !== undefined)
                        payload.countOnly = options.countOnly;
                    if (options.limit !== undefined)
                        payload.limit = options.limit;
                }
                // Add fields if provided
                if (Array.isArray(fields) && fields.length > 0) {
                    payload.includeFields = fields;
                }
                else if (fields && typeof fields === 'object') {
                    // If fields is an object, it might contain additional options
                    payload.includeFields = Object.keys(fields);
                }
                break;
            default:
                throw new Error(`Unsupported operation: ${operation}`);
        }
        this.logger.info('Triggering Salesforce action via Nango', {
            actionName,
            connectionId: this.connectionId,
            payload,
        });
        try {
            const response = await this.nango.triggerAction('salesforce-2', // Provider Key as configured in Nango
            this.connectionId, actionName, payload);
            this.logger.info('Salesforce action triggered successfully', { response });
            return response;
        }
        catch (error) {
            this.logger.error('Failed to trigger Salesforce action via Nango', {
                error: error.message || error,
                actionName,
                payload,
            });
            throw error;
        }
    }
    // Enhanced method to fetch emails with filter support
    async fetchEmails(sessionId, options) {
        const actionName = 'fetch-emails';
        const payload = {};
        // Add backfill period if provided
        if (options?.backfillPeriodMs) {
            payload.backfillPeriodMs = options.backfillPeriodMs;
        }
        // Add filters if provided
        if (options?.filters) {
            payload.filters = options.filters;
            // Log specific filter options for debugging
            this.logger.info('Email filters applied', {
                filters: options.filters,
                sessionId
            });
        }
        this.logger.info('Fetching emails via Nango', {
            actionName,
            connectionId: this.connectionId,
            sessionId,
            payload
        });
        try {
            const response = await this.nango.triggerAction('google-mail', // Provider Key as configured in Nango
            this.connectionId, actionName, payload);
            const dataLength = Array.isArray(response?.data) ? response.data.length : 0;
            this.logger.info('Email fetch completed successfully', {
                count: dataLength,
                sessionId
            });
            return response;
        }
        catch (error) {
            this.logger.error('Failed to fetch emails via Nango', {
                error: error.message || error,
                sessionId,
                payload,
            });
            throw error;
        }
    }
}
exports.NangoService = NangoService;
