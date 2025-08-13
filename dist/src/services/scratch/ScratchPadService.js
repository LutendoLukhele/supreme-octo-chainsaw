"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ScratchPadService = void 0;
const winston_1 = __importDefault(require("winston"));
const events_1 = require("events");
const config_1 = require("../../config");
const logger = winston_1.default.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston_1.default.format.combine(winston_1.default.format.timestamp(), winston_1.default.format.json()),
    defaultMeta: { service: 'ScratchPadService' },
    transports: [
        new winston_1.default.transports.Console({
            format: winston_1.default.format.combine(winston_1.default.format.colorize(), winston_1.default.format.simple()),
        }),
    ],
});
class ScratchPadService extends events_1.EventEmitter {
    nangoService;
    scratchPadStore;
    userSeedStatusStore;
    // To track sessions for which initial seeding is in progress
    seedingInProgress = new Set();
    // Define a default set of configurations for initial seeding if a session is new/empty.
    defaultSeedConfigs = [
        {
            sourceKey: "default_autoseed_recent_leads",
            displayName: "Recent Leads (Auto-Seeded)",
            provider: 'salesforce',
            // IMPORTANT: Ensure 'salesforce-default' matches a valid Nango provider_config_key
            // for your Salesforce connection. You might want to source this from CONFIG.
            providerConfigKey: config_1.CONFIG.PROVIDER_CONFIG_KEY || "salesforce-2",
            // connectionId for Salesforce is typically handled by NangoService based on providerConfigKey
            // or a global default. seedInitialData passes CONFIG.CONNECTION_ID for Salesforce.
            details: {
                entityType: 'Lead',
                fetchFilters: { orderBy: [{ field: 'LastModifiedDate', direction: 'DESC' }] },
                limit: 5, // Fetch 5 recent leads by default
            },
        },
    ];
    constructor(nangoService, scratchPadStore, userSeedStatusStore) {
        super(); // Call EventEmitter constructor
        this.nangoService = nangoService;
        this.scratchPadStore = scratchPadStore;
        this.userSeedStatusStore = userSeedStatusStore;
        logger.info('ScratchPadService initialized.');
    }
    async seedInitialData(sessionId, seedConfigs, nangoConnectionId) {
        logger.info(`Starting initial data seeding for scratch pad. Session: ${sessionId}`, { count: seedConfigs.length });
        for (const config of seedConfigs) {
            try {
                let records = [];
                let summary = { count: 0 };
                const connectionIdToUseForSeed = config.connectionId || nangoConnectionId;
                if (config.provider === 'salesforce' && config.details.entityType) {
                    // CONFIG.CONNECTION_ID is no longer the primary source.
                    // We rely on nangoConnectionId passed in, or one specified in the seedConfig itself.
                    if (!connectionIdToUseForSeed) {
                        logger.error(`Salesforce Connection ID is not available for seeding ${config.displayName}. Skipping.`, { config, sessionId });
                        continue; // Skip this config item if the required connection ID is missing
                    }
                    const response = await this.nangoService.triggerSalesforceAction(config.providerConfigKey, connectionIdToUseForSeed, // Use the dynamic connection ID
                    'fetch', config.details.entityType, 'all', // Identifier: 'all' to apply filters/limit broadly
                    null, // Fields: null, rely on includeFields in options if needed
                    {
                        limit: config.details.limit,
                        filters: config.details.fetchFilters || { conditions: [] },
                    });
                    if (response.success && Array.isArray(response.data)) {
                        records = response.data;
                        summary.count = response.data.length;
                    }
                    else {
                        logger.warn(`Failed to fetch Salesforce data for ${config.displayName}`, { error: response.errors, config, sessionId });
                    }
                }
                else if (config.provider === 'google-mail' || config.provider === 'outlook-mail') { // Example email providers
                    // Use connectionIdToUseForSeed which prioritizes config.connectionId then the passed nangoConnectionId
                    if (!connectionIdToUseForSeed) {
                        logger.error(`Connection ID missing for email provider ${config.providerConfigKey} and no default available.`, { config, sessionId });
                        continue;
                    }
                    const response = await this.nangoService.fetchEmails(config.providerConfigKey, connectionIdToUseForSeed, // Use the dynamic connection ID
                    {
                        filters: {
                            ...(config.details.emailFilters || {}),
                        },
                    });
                    if (response.success && Array.isArray(response.data)) {
                        records = response.data;
                        summary.count = response.data.length;
                    }
                    else {
                        logger.warn(`Failed to fetch emails for ${config.displayName}`, { error: response.errors, config, sessionId });
                    }
                }
                else {
                    logger.warn(`Unsupported provider or configuration for seeding: ${config.provider}`, { config, sessionId });
                    continue;
                }
                if (records.length > 0) {
                    const entry = {
                        source: `seed:${config.provider}:
            ${config.details.entityType || 'emails'}`,
                        filters: {
                            displayName: config.displayName,
                            provider: config.provider,
                            providerConfigKey: config.providerConfigKey,
                            entityType: config.details.entityType,
                            queryDetails: config.details,
                        },
                        records: records,
                        summary: summary,
                        timestamp: new Date().toISOString(),
                    };
                    this.scratchPadStore.set(sessionId, config.sourceKey, entry);
                    logger.info(`Seeded ${records.length}
             records for '${config.displayName}' (${config.sourceKey}) 
             into scratch pad.`, { sessionId });
                }
            }
            catch (error) {
                logger.error(`Error seeding data for '${config.displayName}' (${config.sourceKey}): ${error.message}`, { sessionId, config, error });
            }
        }
        logger.info(`Finished initial data seeding for scratch pad. Session: ${sessionId}`);
    }
    addToolResult(sessionId, toolName, toolArgs, resultData, executionId) {
        const key = `tool_result:${toolName}:${executionId.substring(0, 8)}`;
        const entry = {
            source: `tool_result:${toolName}`,
            filters: { toolName, args: toolArgs, executionId, displayName: `Result: ${toolName}` },
            records: Array.isArray(resultData) ? resultData : [resultData], // Ensure records is an array
            summary: { count: Array.isArray(resultData) ? resultData.length : 1 },
            timestamp: new Date().toISOString(),
        };
        this.scratchPadStore.set(sessionId, key, entry);
        logger.info(`Added tool result for '${toolName}' to scratch pad.`, { sessionId, key });
    }
    addMarkdownContent(sessionId, title, markdown, relatedTo) {
        const key = `markdown:${title.replace(/\s+/g, '_').toLowerCase()}:${new Date().getTime()}`;
        const entry = {
            source: 'markdown_content',
            filters: { title, relatedTo, displayName: title },
            records: [{ type: 'markdown', content: markdown }],
            summary: { count: 1 },
            timestamp: new Date().toISOString(),
        };
        this.scratchPadStore.set(sessionId, key, entry);
        logger.info(`Added markdown content titled "${title}" to scratch pad.`, { sessionId, key });
    }
    getPlaceholderLoadingEntry() {
        return {
            "system_initial_load_placeholder": {
                source: 'system_placeholder',
                filters: { displayName: 'Initializing Workspace...' },
                records: [{ status: 'loading', message: 'Initial data is being fetched. This may take a moment.' }],
                summary: { count: 0 },
                timestamp: new Date().toISOString(),
            }
        };
    }
    async getScratchPadEntries(sessionId, userId, nangoConnectionId) {
        let entries = this.scratchPadStore.get(sessionId);
        // Check if the session's scratchpad is empty.
        if (Object.keys(entries).length === 0) {
            // First, check if the user (not just the session) has already been seeded
            const userAlreadySeeded = await this.userSeedStatusStore.hasUserBeenSeeded(userId);
            if (userAlreadySeeded) {
                logger.info(`User ${userId} (session ${sessionId}) has already been seeded. Skipping default seed.`);
                // Return empty or only truly session-specific data if any.
                // Client will use its local cache for previously seeded items.
                return {};
            }
            // User not seeded yet, proceed with session-based seeding logic
            if (this.seedingInProgress.has(sessionId)) {
                // Seeding is already in progress for this session, return the placeholder
                logger.info(`Initial data seeding already in progress for session ${sessionId}. Returning placeholder.`);
                return this.getPlaceholderLoadingEntry();
            }
            else {
                // Scratchpad is empty and no seeding in progress, so initiate it.
                this.seedingInProgress.add(sessionId);
                logger.info(`Scratchpad for session ${sessionId} (user ${userId}) is empty and user not yet seeded. Initiating default data seeding.`);
                // Launch seedInitialData but don't await it here.
                // It will run in the background and populate the store.
                this.seedInitialData(sessionId, this.defaultSeedConfigs, nangoConnectionId) // Pass nangoConnectionId
                    .then(() => {
                    // This block executes after seedInitialData has attempted to populate the store
                    const freshEntries = this.scratchPadStore.get(sessionId); // Get the now populated entries
                    logger.info(`Background default data seeding attempt completed for session ${sessionId} (user ${userId}).`);
                    // Check if any actual entries were added by the defaultSeedConfigs.
                    // The placeholder key is "system_initial_load_placeholder".
                    const actualSeededEntryKeys = Object.keys(freshEntries).filter(key => key !== "system_initial_load_placeholder");
                    if (actualSeededEntryKeys.length > 0) {
                        logger.info(`Successfully seeded ${actualSeededEntryKeys.length} new entry types for user ${userId} (session ${sessionId}).`);
                        logger.debug(`Seeded entries for ${sessionId}:`, freshEntries);
                        // Mark user as seeded ONLY if actual data was added
                        return this.userSeedStatusStore.markUserAsSeeded(userId)
                            .then(() => {
                            logger.info(`User ${userId} marked as seeded.`);
                            this.emit('scratchpadSeeded', sessionId, freshEntries); // Emit with the actual entries
                        });
                    }
                    else {
                        logger.warn(`Default data seeding for user ${userId} (session ${sessionId}) resulted in no new entries. User will NOT be marked as seeded. Check seed configurations and Nango responses.`);
                        // Do not mark user as seeded and do not emit 'scratchpadSeeded' if no actual data was populated.
                    }
                })
                    .catch((error) => {
                    logger.error(`Error during background default data seeding process for session ${sessionId} (user ${userId}): ${error.message}`, { error });
                    // Do not mark as seeded on error.
                })
                    .finally(() => {
                    this.seedingInProgress.delete(sessionId);
                });
                // Return the placeholder immediately
                return this.getPlaceholderLoadingEntry();
            }
        }
        // If entries were not empty, or if seeding has completed and populated them.
        return entries;
    }
    clearScratchPadSession(sessionId) {
        this.scratchPadStore.clearSession(sessionId);
        logger.info(`Cleared scratch pad for session.`, { sessionId });
    }
}
exports.ScratchPadService = ScratchPadService;
