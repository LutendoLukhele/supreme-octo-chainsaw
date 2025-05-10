import winston from 'winston';
import { NangoService, EmailFilter } from '../NangoService';
import { EventEmitter } from 'events';
import { ScratchPadStore, ScratchEntry } from './ScratchPadStore';
import { UserSeedStatusStore } from '../user-seed-status.store'; // Added import
import { CONFIG } from '../../config';

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  defaultMeta: { service: 'ScratchPadService' },
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(winston.format.colorize(), winston.format.simple()),
    }),
  ],
});

export interface SeedConfigItem {
  sourceKey: string; // Unique key for this data in the scratchpad, e.g., "recent_leads"
  displayName: string; // User-friendly name for the UI, e.g., "Recent Leads"
  provider: 'salesforce' | 'google-mail' | 'outlook-mail' | string; // Nango provider type
  providerConfigKey: string; // Nango's provider_config_key e.g. "salesforce-2", "google-mail"
  connectionId?: string; // Nango connection ID, especially needed for email providers
  details: {
    entityType?: string; // For Salesforce (e.g., 'Lead', 'Opportunity')
    fetchFilters?: any; // Salesforce specific filters (e.g., { orderBy: [{field: 'LastModifiedDate', direction: 'DESC'}] })
    emailFilters?: EmailFilter; // For email providers
    limit: number;
  };
}


export class ScratchPadService extends EventEmitter {
  // To track sessions for which initial seeding is in progress
  private seedingInProgress = new Set<string>();

  // Define a default set of configurations for initial seeding if a session is new/empty.
  private defaultSeedConfigs: SeedConfigItem[] = [
    {
      sourceKey: "default_autoseed_recent_leads",
      displayName: "Recent Leads (Auto-Seeded)",
      provider: 'salesforce',
      // IMPORTANT: Ensure 'salesforce-default' matches a valid Nango provider_config_key
      // for your Salesforce connection. You might want to source this from CONFIG.
      providerConfigKey: CONFIG.PROVIDER_CONFIG_KEY || "salesforce-2",
      // connectionId for Salesforce is typically handled by NangoService based on providerConfigKey
      // or a global default. seedInitialData passes CONFIG.CONNECTION_ID for Salesforce.
      details: {
        entityType: 'Lead',
        fetchFilters: { orderBy: [{ field: 'LastModifiedDate', direction: 'DESC' }] },
        limit: 5, // Fetch 5 recent leads by default
      },
    },
  ];

  constructor(
    private nangoService: NangoService,
    private scratchPadStore: ScratchPadStore,
    private userSeedStatusStore: UserSeedStatusStore
  ) {
    super(); // Call EventEmitter constructor
    logger.info('ScratchPadService initialized.');
  }
  async seedInitialData(sessionId: string, seedConfigs: SeedConfigItem[]): Promise<void> {
    logger.info(`Starting initial data seeding for scratch pad. Session: ${sessionId}`, { count: seedConfigs.length });
    for (const config of seedConfigs) {
      try {
        let records: any[] = [];
        let summary = { count: 0 };

        if (config.provider === 'salesforce' && config.details.entityType) {
          const response = await this.nangoService.triggerSalesforceAction(
            config.providerConfigKey,
            CONFIG.CONNECTION_ID, // NangoService.triggerSalesforceAction uses its internal connectionId, but API requires a value here.
            'fetch',
            config.details.entityType,
            'all', // Identifier: 'all' to apply filters/limit broadly
            null,  // Fields: null, rely on includeFields in options if needed
            {
              limit: config.details.limit,
              filters: config.details.fetchFilters || { conditions: [] },
            },
          );
          if (response.success && Array.isArray(response.data)) {
            records = response.data;
            summary.count = response.data.length;
          } else {
            logger.warn(`Failed to fetch Salesforce data for ${config.displayName}`, { error: response.errors, config, sessionId });
          }
        } else if (config.provider === 'google-mail' || config.provider === 'outlook-mail') { // Example email providers
          const connectionIdToUse = config.connectionId || CONFIG.CONNECTION_ID; // Fallback to default if not specified
          if (!connectionIdToUse) {
            logger.error(`Connection ID missing for email provider ${config.providerConfigKey} and no default available.`, { config, sessionId });
            continue;
          }
          const response = await this.nangoService.fetchEmails(
            config.providerConfigKey,
            connectionIdToUse,
            {
              filters: {
                ...(config.details.emailFilters || {}),
                limit: config.details.limit,
              },
            },
          );
          if (response.success && Array.isArray(response.data)) {
            records = response.data;
            summary.count = response.data.length;
          } else {
            logger.warn(`Failed to fetch emails for ${config.displayName}`, { error: response.errors, config, sessionId });
          }
        } else {
          logger.warn(`Unsupported provider or configuration for seeding: ${config.provider}`, { config, sessionId });
          continue;
        }

        if (records.length > 0) {
          const entry: ScratchEntry = {
            source: `seed:${config.provider}:
            ${config.details.entityType || 'emails'}`,
            filters: { // Store context for UI and debugging
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
      } catch (error: any) {
        logger.error(`Error seeding data for '${config.displayName}' (${config.sourceKey}): ${error.message}`, { sessionId, config, error });
      }
    }
    logger.info(`Finished initial data seeding for scratch pad. Session: ${sessionId}`);
  }

  addToolResult(sessionId: string, toolName: string, toolArgs: any, resultData: any, executionId: string): void {
    const key = `tool_result:${toolName}:${executionId.substring(0, 8)}`;
    const entry: ScratchEntry = {
      source: `tool_result:${toolName}`,
      filters: { toolName, args: toolArgs, executionId, displayName: `Result: ${toolName}` },
      records: Array.isArray(resultData) ? resultData : [resultData], // Ensure records is an array
      summary: { count: Array.isArray(resultData) ? resultData.length : 1 },
      timestamp: new Date().toISOString(),
    };
    this.scratchPadStore.set(sessionId, key, entry);
    logger.info(`Added tool result for '${toolName}' to scratch pad.`, { sessionId, key });
  }

  addMarkdownContent(sessionId: string, title: string, markdown: string, relatedTo?: any): void {
    const key = `markdown:${title.replace(/\s+/g, '_').toLowerCase()}:${new Date().getTime()}`;
    const entry: ScratchEntry = {
      source: 'markdown_content',
      filters: { title, relatedTo, displayName: title },
      records: [{ type: 'markdown', content: markdown }],
      summary: { count: 1 },
      timestamp: new Date().toISOString(),
    };
    this.scratchPadStore.set(sessionId, key, entry);
    logger.info(`Added markdown content titled "${title}" to scratch pad.`, { sessionId, key });
  }

  private getPlaceholderLoadingEntry(): Record<string, ScratchEntry> {
    return {
      "system_initial_load_placeholder": { // A unique key for this placeholder
        source: 'system_placeholder',
        filters: { displayName: 'Initializing Workspace...' },
        records: [{ status: 'loading', message: 'Initial data is being fetched. This may take a moment.' }],
        summary: { count: 0 },
        timestamp: new Date().toISOString(),
      }
    };
  }

  async getScratchPadEntries(sessionId: string, userId: string): Promise<Record<string, ScratchEntry>> {
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
      } else {
        // Scratchpad is empty and no seeding in progress, so initiate it.
        this.seedingInProgress.add(sessionId);
        logger.info(`Scratchpad for session ${sessionId} (user ${userId}) is empty and user not yet seeded. Initiating default data seeding.`);

        // Launch seedInitialData but don't await it here.
        // It will run in the background and populate the store.
        this.seedInitialData(sessionId, this.defaultSeedConfigs)
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
            } else {
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

  clearScratchPadSession(sessionId: string): void {
    this.scratchPadStore.clearSession(sessionId);
    logger.info(`Cleared scratch pad for session.`, { sessionId });
  }
}