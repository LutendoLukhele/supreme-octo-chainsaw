"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProviderAwareToolFilter = void 0;
class ProviderAwareToolFilter {
    constructor(toolConfigManager, sql) {
        this.toolConfigManager = toolConfigManager;
        this.sql = sql;
    }
    async getAvailableToolsForUser(userId) {
        try {
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
}
exports.ProviderAwareToolFilter = ProviderAwareToolFilter;
