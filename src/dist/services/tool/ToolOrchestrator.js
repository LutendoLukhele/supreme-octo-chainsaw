"use strict";
// src/services/tool/ToolOrchestrator.ts
Object.defineProperty(exports, "__esModule", { value: true });
exports.ToolOrchestrator = void 0;
const BaseService_1 = require("../base/BaseService");
class ToolOrchestrator extends BaseService_1.BaseService {
    activeTools;
    nangoService;
    constructor(config) {
        // Merge a default logger if one isn't provided in config.
        const defaultLogger = {
            info: console.log,
            error: console.error,
            warn: console.warn,
            debug: console.debug,
        };
        const serviceConfig = { ...config, logger: config.logger || defaultLogger };
        super(serviceConfig);
        this.activeTools = new Map();
        this.nangoService = config.nangoService;
    }
    async executeTool(toolCall) {
        try {
            this.logger.info('Executing tool', { tool: toolCall.name, args: toolCall.arguments });
            this.activeTools.set(toolCall.sessionId, toolCall);
            const result = await this.executeNangoAction(toolCall);
            this.activeTools.delete(toolCall.sessionId);
            return {
                status: 'success',
                toolName: toolCall.name,
                data: result
            };
        }
        catch (error) {
            this.logger.error('Tool execution failed', { error: error.message || error, toolCall });
            this.activeTools.delete(toolCall.sessionId);
            return {
                status: 'failed',
                toolName: toolCall.name,
                data: null,
                error: error instanceof Error ? error.message : 'Unknown error'
            };
        }
    }
    async executeNangoAction(toolCall) {
        const { name, arguments: args } = toolCall;
        const { operation, entityType, identifier, fields, 
        // New parameters
        records, checkDuplicates, duplicateFilters, useTemplate, templateParams, identifierType, filters, batchOptions, timeFrame, format, countOnly, limit, 
        // Email specific parameters
        backfillPeriodMs } = args;
        // Basic validation
        if (name.includes('entity') && (!operation || !entityType)) {
            throw new Error('Missing required fields: operation and entityType');
        }
        this.logger.info('Executing tool action', {
            tool: name,
            entityType,
            operation,
            identifier,
            fields,
            filters
        });
        // Prepare options object with all the new parameters
        const options = {
            records,
            checkDuplicates,
            duplicateFilters,
            useTemplate,
            templateParams,
            identifierType,
            filters,
            batchOptions,
            timeFrame,
            format,
            countOnly,
            limit
        };
        switch (name) {
            case 'create_entity':
                // Updated validation for create to handle different ways to create entities
                if (!fields && !records && !useTemplate) {
                    throw new Error('Missing required fields: either fields, records, or useTemplate must be provided for create_entity');
                }
                return await this.nangoService.triggerSalesforceAction(operation, entityType, fields || {}, // Default to empty object if not provided
                null, // No fields parameter needed for create
                options);
            case 'update_entity':
                // Updated validation for update to handle identifier or filters
                if ((!identifier && !filters) || !fields) {
                    throw new Error('Missing required fields: either identifier or filters, and fields for update_entity');
                }
                return await this.nangoService.triggerSalesforceAction(operation, entityType, identifier || '', // Default to empty string if using filters
                fields, options);
            case 'fetch_entity':
                // Updated validation for fetch to handle identifier or filters
                if (!identifier && !filters) {
                    throw new Error('Missing required field: either identifier or filters for fetch_entity');
                }
                return await this.nangoService.triggerSalesforceAction(operation, entityType, identifier || 'all', // Default to 'all' if using filters
                fields || [], options);
            // Handle existing specific tools with the new options
            case 'salesforce.createContact':
                return await this.nangoService.triggerSalesforceAction('create', 'Contact', fields || {}, null, options);
            case 'salesforce.updateContact':
                return await this.nangoService.triggerSalesforceAction('update', 'Contact', identifier || '', fields, options);
            case 'salesforce.fetchContact':
                return await this.nangoService.triggerSalesforceAction('fetch', 'Contact', identifier || 'all', fields || [], options);
            case 'salesforce.fetchEmails':
            case 'fetch_emails':
                // Extract email-specific parameters
                const emailOptions = {
                    backfillPeriodMs: args.backfillPeriodMs,
                    filters: args.filters
                };
                return await this.nangoService.fetchEmails(toolCall.sessionId, emailOptions);
            default:
                throw new Error(`Unknown tool: ${name}`);
        }
    }
    getActiveTools() {
        return new Map(this.activeTools);
    }
}
exports.ToolOrchestrator = ToolOrchestrator;
