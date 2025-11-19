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
        this.connectionWarmCache = new Map();
        if (!config_1.CONFIG.NANGO_SECRET_KEY) {
            throw new Error("Configuration error: NANGO_SECRET_KEY is missing.");
        }
        this.logger = winston_1.default.createLogger({
            level: 'info',
            format: winston_1.default.format.combine(winston_1.default.format.timestamp(), winston_1.default.format.json()),
            defaultMeta: { service: 'NangoService' },
            transports: [
                new winston_1.default.transports.Console(),
            ],
        });
        this.nango = new node_1.Nango({ secretKey: config_1.CONFIG.NANGO_SECRET_KEY });
        this.logger.info(`NangoService initialized.`);
    }
    async warmConnection(providerConfigKey, connectionId, force = false) {
        const cacheKey = `${providerConfigKey}:${connectionId}`;
        const lastWarmed = this.connectionWarmCache.get(cacheKey);
        const WARM_CACHE_TTL = 5 * 60 * 1000;
        if (!force && lastWarmed && (Date.now() - lastWarmed) < WARM_CACHE_TTL) {
            this.logger.debug('Connection already warm', { providerConfigKey, connectionId: '***' });
            return true;
        }
        const startTime = Date.now();
        try {
            let pingEndpoint;
            switch (providerConfigKey) {
                case 'gmail':
                case 'google':
                    pingEndpoint = '/gmail/v1/users/me/profile';
                    break;
                case 'salesforce':
                    pingEndpoint = '/services/data/v60.0/sobjects';
                    break;
                default:
                    pingEndpoint = '/';
            }
            try {
                await this.nango.get({ endpoint: pingEndpoint, connectionId, providerConfigKey });
            }
            catch (sdkErr) {
                this.logger.debug('Nango SDK ping failed; attempting lightweight action trigger', { providerConfigKey });
                await axios_1.default.post('https://api.nango.dev/action/trigger', { action_name: 'ping', input: {} }, {
                    headers: {
                        'Authorization': `Bearer ${config_1.CONFIG.NANGO_SECRET_KEY}`,
                        'Provider-Config-Key': providerConfigKey,
                        'Connection-Id': connectionId,
                        'Content-Type': 'application/json'
                    }
                }).catch(() => {
                });
            }
            const duration = Date.now() - startTime;
            this.connectionWarmCache.set(cacheKey, Date.now());
            this.logger.info('Connection warmed successfully', {
                providerConfigKey,
                connectionId: '***',
                duration
            });
            return true;
        }
        catch (error) {
            const duration = Date.now() - startTime;
            this.logger.warn('Connection warm failed', {
                providerConfigKey,
                connectionId: '***',
                duration,
                error: error.message
            });
            return false;
        }
    }
    async triggerGenericNangoAction(providerConfigKey, connectionId, actionName, actionPayload) {
        this.logger.info('Triggering generic Nango action via direct API', { providerConfigKey, actionName });
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
            this.logger.error('Generic Nango action failed', {
                error: error.response?.data?.message || error.message,
                actionName,
            });
            const enhancedError = new Error(error.response?.data?.message || `Request failed with status code ${error.response?.status}`);
            enhancedError.nangoErrorDetails = {
                actionName,
                statusCode: error.response?.status,
                nangoPayload: error.response?.data || null,
                timestamp: new Date().toISOString()
            };
            throw enhancedError;
        }
    }
    async triggerSalesforceAction(providerConfigKey, connectionId, actionPayload) {
        let actionName;
        switch (actionPayload.operation) {
            case 'fetch':
                actionName = 'salesforce-fetch-entity';
                break;
            case 'create':
                actionName = 'salesforce-create-entity';
                break;
            case 'update':
                actionName = 'salesforce-update-entity';
                break;
            default:
                const msg = `Unsupported Salesforce operation: ${actionPayload.operation}`;
                this.logger.error(msg, { actionPayload });
                throw new Error(msg);
        }
        this.logger.info('Triggering Salesforce action via Nango action trigger', {
            actionName,
            input: actionPayload
        });
        try {
            await this.warmConnection(providerConfigKey, connectionId);
            console.log("🔥 FINAL TOOL PAYLOAD SENT TO NANGO:", JSON.stringify(actionPayload, null, 2));
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
            this.logger.info('Salesforce action executed successfully', { actionName });
            return response.data;
        }
        catch (error) {
            this.logger.error('Salesforce action failed', {
                error: error.response?.data || error.message,
                actionName
            });
            const enhancedError = new Error(error.response?.data?.message || `Request failed for '${actionName}' with status code ${error.response?.status}`);
            enhancedError.nangoErrorDetails = {
                actionName,
                statusCode: error.response?.status,
                nangoPayload: error.response?.data || null,
                timestamp: new Date().toISOString()
            };
            throw enhancedError;
        }
    }
    async sendEmail(providerConfigKey, connectionId, payload) {
        const endpoint = 'https://api.nango.dev/v1/emails';
        this.logger.info('Calling Nango custom email endpoint', { endpoint });
        try {
            const response = await axios_1.default.post(endpoint, payload, {
                headers: {
                    'Authorization': `Bearer ${config_1.CONFIG.NANGO_SECRET_KEY}`,
                    'Provider-Config-Key': providerConfigKey,
                    'Connection-Id': connectionId,
                    'Content-Type': 'application/json'
                }
            });
            this.logger.info('Nango custom email endpoint call successful');
            return response.data;
        }
        catch (error) {
            this.logger.error('Nango custom email endpoint call failed', {
                error: error.response?.data || error.message,
            });
            throw new Error(error.response?.data?.message || `Request to custom endpoint failed with status ${error.response?.status}`);
        }
    }
    async fetchEmails(providerConfigKey, connectionId, input) {
        const actionName = 'fetch-emails';
        this.logger.info('Fetching emails via Nango action trigger', { actionName, input });
        try {
            await this.warmConnection(providerConfigKey, connectionId);
            const response = await axios_1.default.post('https://api.nango.dev/action/trigger', {
                action_name: actionName,
                input: input
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
            this.logger.error('Nango direct API call to fetch-emails failed', {
                error: error.response?.data || error.message,
                actionName
            });
            const enhancedError = new Error(error.response?.data?.message || `Request failed for '${actionName}' with status code ${error.response?.status}`);
            enhancedError.nangoErrorDetails = {
                actionName,
                statusCode: error.response?.status,
                nangoPayload: error.response?.data || null,
                timestamp: new Date().toISOString()
            };
            throw enhancedError;
        }
    }
    async fetchCalendarEvents(providerConfigKey, connectionId, args) {
        const actionName = 'fetch-events';
        this.logger.info('Fetching calendar events via Nango', { actionName, args });
        try {
            await this.warmConnection(providerConfigKey, connectionId);
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
            await this.warmConnection(providerConfigKey, connectionId);
            const response = await this.nango.triggerAction(providerConfigKey, connectionId, actionName, args);
            return response;
        }
        catch (error) {
            this.logger.error('Failed to create calendar event', { error: error.message || error });
            throw error;
        }
    }
    clearWarmCache(providerConfigKey, connectionId) {
        if (providerConfigKey && connectionId) {
            const cacheKey = `${providerConfigKey}:${connectionId}`;
            this.connectionWarmCache.delete(cacheKey);
            this.logger.info('Cleared warm cache for specific connection', { providerConfigKey, connectionId: '***' });
        }
        else {
            this.connectionWarmCache.clear();
            this.logger.info('Cleared all warm cache entries');
        }
    }
    getConnectionHealth() {
        return {
            totalConnections: this.connectionWarmCache.size,
            cacheSize: this.connectionWarmCache.size
        };
    }
}
exports.NangoService = NangoService;
