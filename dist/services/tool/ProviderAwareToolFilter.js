"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProviderAwareToolFilter = void 0;
class ProviderAwareToolFilter {
    constructor(toolConfigManager, sql, cacheService) {
        this.toolConfigManager = toolConfigManager;
        this.sql = sql;
        this.cacheService = cacheService;
    }
    async getAvailableToolsForUser(userId) {
        try {
            if (this.cacheService) {
                const cachedTools = await this.cacheService.getCachedAvailableTools(userId);
                if (cachedTools) {
                    console.log(`[ProviderAwareToolFilter] Using cached tools for user ${userId}`);
                    return cachedTools;
                }
            }
            console.log(`[ProviderAwareToolFilter] Fetching tools from database for user ${userId}`);
            const userProviders = await this.sql `
        SELECT DISTINCT provider
        FROM user_connections
        WHERE user_id = ${userId}
      `;
            const activeProviders = new Set(userProviders.map(row => row.provider));
            const allTools = this.toolConfigManager.getAllTools();
            const availableTools = allTools.filter(tool => {
                if (!tool.providerConfigKey) {
                    return false;
                }
                return activeProviders.has(tool.providerConfigKey);
            });
            console.log(`[ProviderAwareToolFilter] User ${userId} has ${activeProviders.size} active providers`);
            console.log(`[ProviderAwareToolFilter] Filtered ${allTools.length} tools down to ${availableTools.length} available tools`);
            if (this.cacheService) {
                await this.cacheService.setCachedAvailableTools(userId, availableTools);
            }
            return availableTools;
        }
        catch (error) {
            console.error('[ProviderAwareToolFilter] Error getting available tools:', error);
            return [];
        }
    }
    async getToolsByCategoriesForUser(userId, categories) {
        const availableTools = await this.getAvailableToolsForUser(userId);
        const filteredTools = availableTools.filter(tool => categories.includes(tool.category));
        console.log(`[ProviderAwareToolFilter] Filtered to ${filteredTools.length} tools for categories: ${categories.join(', ')}`);
        return filteredTools;
    }
    async getActiveProvidersForUser(userId) {
        try {
            const userProviders = await this.sql `
        SELECT DISTINCT provider
        FROM user_connections
        WHERE user_id = ${userId}
      `;
            return new Set(userProviders.map(row => row.provider));
        }
        catch (error) {
            console.error('[ProviderAwareToolFilter] Error getting active providers:', error);
            return new Set();
        }
    }
    async isToolAvailableForUser(userId, toolName) {
        const availableTools = await this.getAvailableToolsForUser(userId);
        return availableTools.some(tool => tool.name === toolName);
    }
    async getProviderContextForPrompt(userId) {
        try {
            const activeProviders = await this.getActiveProvidersForUser(userId);
            if (activeProviders.size === 0) {
                return "No integrations configured. User cannot use any tools requiring external services.";
            }
            const providerDescriptions = {
                'google-mail': '✓ Gmail - Email operations (fetch, send)',
                'google-calendar': '✓ Google Calendar - Calendar events (fetch, create, update)',
                'outlook': '✓ Microsoft Outlook - Email, calendar events, and contacts',
                'salesforce-2': '✓ Salesforce - CRM operations (accounts, contacts, leads, deals, cases)',
                'notion': '✓ Notion - Page and database operations',
            };
            const descriptions = [];
            const providerArray = Array.from(activeProviders).sort();
            for (const provider of providerArray) {
                const description = providerDescriptions[provider];
                if (description) {
                    descriptions.push(description);
                }
                else {
                    descriptions.push(`✓ ${provider} - Integration available`);
                }
            }
            let guidance = '\n\nIMPORTANT TOOL SELECTION RULES:\n';
            const hasGoogleCalendar = activeProviders.has('google-calendar');
            const hasOutlook = activeProviders.has('outlook');
            if (hasGoogleCalendar && hasOutlook) {
                guidance += '- For CALENDAR operations: User has both Google Calendar and Outlook. Ask which one to use, or default to Google Calendar.\n';
            }
            else if (hasGoogleCalendar) {
                guidance += '- For CALENDAR operations: Use Google Calendar tools only (fetch_calendar_events, create_calendar_event, update_calendar_event).\n';
            }
            else if (hasOutlook) {
                guidance += '- For CALENDAR operations: Use Outlook tools only (create_outlook_entity, fetch_outlook_entity with entityType="Event").\n';
            }
            const hasGmail = activeProviders.has('google-mail');
            if (hasGmail && hasOutlook) {
                guidance += '- For EMAIL operations: User has both Gmail and Outlook. Ask which one to use, or default to Gmail.\n';
            }
            else if (hasGmail) {
                guidance += '- For EMAIL operations: Use Gmail tools only (fetch_emails, send_email).\n';
            }
            else if (hasOutlook) {
                guidance += '- For EMAIL operations: Use Outlook tools only (create_outlook_entity, fetch_outlook_entity with entityType="Message").\n';
            }
            if (activeProviders.has('salesforce-2')) {
                guidance += '- For CRM operations: Use Salesforce tools (fetch_entity, create_entity, update_entity).\n';
            }
            if (activeProviders.has('notion')) {
                guidance += '- For NOTE/DOCUMENT operations: Use Notion tools (fetch_notion_page, create_notion_page, update_notion_page).\n';
            }
            return `USER'S CONFIGURED INTEGRATIONS:\n${descriptions.join('\n')}${guidance}`;
        }
        catch (error) {
            console.error('[ProviderAwareToolFilter] Error getting provider context:', error);
            return "Unable to determine user's integrations. Proceed with caution.";
        }
    }
}
exports.ProviderAwareToolFilter = ProviderAwareToolFilter;
