"use strict";
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
    constructor() {
        if (!config_1.CONFIG.NANGO_SECRET_KEY) {
            throw new Error("Configuration error: NANGO_SECRET_KEY is missing.");
        }
        this.logger = winston_1.default.createLogger({});
        this.nango = new node_1.Nango({ secretKey: config_1.CONFIG.NANGO_SECRET_KEY });
        this.logger.info(`NangoService initialized.`);
    }
    async triggerGenericNangoAction(providerConfigKey, connectionId, actionName, actionPayload) {
        this.logger.info('Triggering generic Nango action', { providerConfigKey, actionName });
        try {
            const response = await this.nango.triggerAction(providerConfigKey, connectionId, actionName, actionPayload);
            return response;
        }
        catch (error) {
            this.logger.error('Generic Nango action failed', {
                error: error.message || 'An unknown error occurred',
                actionName,
            });
            throw error;
        }
    }
    async triggerSalesforceAction(providerConfigKey, connectionId, actionPayload) {
        this.logger.info('Executing Salesforce action', { providerConfigKey, connectionId: '***', operation: actionPayload.operation, entityType: actionPayload.entityType });
        let actionName;
        switch (actionPayload.operation) {
            case 'create':
                actionName = 'salesforce-create-entity';
                break;
            case 'update':
                actionName = 'salesforce-update-entity';
                break;
            case 'fetch':
                actionName = 'salesforce-fetch-entity';
                break;
            default:
                const errorMessage = `Unsupported Salesforce operation: ${actionPayload.operation}`;
                this.logger.error(errorMessage, { operation: actionPayload.operation });
                throw new Error(errorMessage);
        }
        this.logger.info('Triggering Nango action via direct API call', { actionName });
        try {
            const response = await axios_1.default.post('https://api.nango.dev/action/trigger', {
                action_name: actionName,
                input: actionPayload
            }, {
                headers: {
                    'Authorization': `Bearer ${config_1.CONFIG.NANGO_SECRET_KEY}`,
                    'Provider-Config-Key': providerConfigKey,
                    'Connection-Id': connectionId,
                    'Content-Type': 'application/json'
                }
            });
            this.logger.info('Nango direct API call successful', { actionName });
            return response.data;
        }
        catch (error) {
            this.logger.error('Nango direct API call failed', {
                error: error.response?.data || error.message,
                actionName
            });
            throw new Error(error.response?.data?.message || `Request failed with status code ${error.response?.status}`);
        }
    }
    async fetchEmails(providerConfigKey, connectionId, input) {
        const actionName = 'fetch-emails';
        this.logger.info('Fetching emails via Nango custom endpoint', { actionName, input });
        try {
            const response = await axios_1.default.get('https://api.nango.dev/v1/fetch-emails', {
                params: input,
                headers: {
                    'Authorization': `Bearer ${config_1.CONFIG.NANGO_SECRET_KEY}`,
                    'Provider-Config-Key': providerConfigKey,
                    'Connection-Id': connectionId,
                    'Content-Type': 'application/json'
                }
            });
            this.logger.info('Nango direct API call successful', { actionName });
            return response.data;
        }
        catch (error) {
            this.logger.error('Nango direct API call to fetch-emails failed', {
                error: error.response?.data || error.message,
                actionName
            });
            throw new Error(error.response?.data?.message || `Request failed with status code ${error.response?.status}`);
        }
    }
    async fetchCalendarEvents(providerConfigKey, connectionId, args) {
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
    async createCalendarEvent(providerConfigKey, connectionId, args) {
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
