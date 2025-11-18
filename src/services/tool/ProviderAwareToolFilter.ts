import { ToolConfig, ToolConfigManager } from './ToolConfigManager';
import { NeonQueryFunction } from '@neondatabase/serverless';

/**
 * Service for filtering tools based on user's actual provider configurations
 * This reduces token usage by only including tools the user can actually execute
 */
export class ProviderAwareToolFilter {
  constructor(
    private toolConfigManager: ToolConfigManager,
    private sql: NeonQueryFunction<false, false>
  ) {}

  /**
   * Gets only tools that the user can actually execute
   * based on their configured providers in the database
   *
   * @param userId - The user's ID to check provider configurations for
   * @returns Array of tools that have active provider connections
   */
  async getAvailableToolsForUser(userId: string): Promise<ToolConfig[]> {
    try {
      // Query database for user's active providers
      const userProviders = await this.sql`
        SELECT DISTINCT provider
        FROM user_connections
        WHERE user_id = ${userId}
      `;

      // Create a set of active provider keys for O(1) lookup
      const activeProviders = new Set<string>(
        userProviders.map(row => row.provider as string)
      );

      // Get all tools from ToolConfigManager
      const allTools = this.toolConfigManager.getAllTools();

      // Filter to only tools whose providers are active
      const availableTools = allTools.filter(tool => {
        // Skip tools without a provider configuration key
        if (!tool.providerConfigKey) {
          return false;
        }

        // Only include if user has this provider configured
        return activeProviders.has(tool.providerConfigKey);
      });

      console.log(`[ProviderAwareToolFilter] User ${userId} has ${activeProviders.size} active providers`);
      console.log(`[ProviderAwareToolFilter] Filtered ${allTools.length} tools down to ${availableTools.length} available tools`);

      return availableTools;
    } catch (error) {
      console.error('[ProviderAwareToolFilter] Error getting available tools:', error);
      // Fallback to empty array on error to prevent showing unavailable tools
      return [];
    }
  }

  /**
   * Gets tools filtered by both categories and user's active providers
   * This is the main method to use for category-based tool selection
   *
   * @param userId - The user's ID to check provider configurations for
   * @param categories - Array of category names to filter by (e.g., ['Email', 'Calendar'])
   * @returns Array of tools matching the categories that the user can execute
   */
  async getToolsByCategoriesForUser(
    userId: string,
    categories: string[]
  ): Promise<ToolConfig[]> {
    // First get only tools the user has providers for
    const availableTools = await this.getAvailableToolsForUser(userId);

    // Then filter by requested categories
    const filteredTools = availableTools.filter(tool =>
      categories.includes(tool.category)
    );

    console.log(`[ProviderAwareToolFilter] Filtered to ${filteredTools.length} tools for categories: ${categories.join(', ')}`);

    return filteredTools;
  }

  /**
   * Gets the list of active providers for a user
   * Useful for debugging and understanding what providers are available
   *
   * @param userId - The user's ID
   * @returns Set of active provider keys
   */
  async getActiveProvidersForUser(userId: string): Promise<Set<string>> {
    try {
      const userProviders = await this.sql`
        SELECT DISTINCT provider
        FROM user_connections
        WHERE user_id = ${userId}
      `;

      return new Set<string>(userProviders.map(row => row.provider as string));
    } catch (error) {
      console.error('[ProviderAwareToolFilter] Error getting active providers:', error);
      return new Set();
    }
  }

  /**
   * Checks if a specific tool is available for a user
   *
   * @param userId - The user's ID
   * @param toolName - The name of the tool to check
   * @returns True if the tool is available, false otherwise
   */
  async isToolAvailableForUser(userId: string, toolName: string): Promise<boolean> {
    const availableTools = await this.getAvailableToolsForUser(userId);
    return availableTools.some(tool => tool.name === toolName);
  }
}
