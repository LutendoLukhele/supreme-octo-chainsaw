/**
 * IToolProvider - Abstract interface for tool definition sources
 * 
 * This interface decouples services that need tool definitions from
 * the concrete storage mechanism (JSON file, database, API, etc.)
 * 
 * @package @aso/interfaces
 */

// ============================================================================
// Tool Configuration Types
// ============================================================================

export interface ToolParameterProperty {
  type: string | string[];
  description?: string;
  prompt?: string;
  hint?: string;
  enum?: string[];
  optional?: boolean;
  default?: any;
  properties?: Record<string, ToolParameterProperty>;
  items?: ToolParameterProperty;
}

export interface ToolInputSchema {
  type: string; // Typically 'object', but allows flexibility
  properties: Record<string, ToolParameterProperty>;
  required?: string[];
}

/**
 * Complete tool configuration
 * This is the canonical shape for tool definitions across ASO
 */
export interface ToolConfig {
  /** Unique tool identifier (e.g., 'fetch_emails', 'create_lead') */
  name: string;
  
  /** Human-readable description for LLM context */
  description: string;
  
  /** Tool category for grouping (e.g., 'Email', 'CRM', 'Calendar') */
  category: string;
  
  /** Display name for UI (optional, defaults to name) */
  display_name?: string;
  
  /** Provider configuration key (e.g., 'google-mail', 'salesforce-ybzg') */
  providerConfigKey?: string;
  
  /** Parameter schema for tool invocation */
  parameters?: ToolInputSchema;
  
  /** Data source: reads, provider actions, local desktop actions, or internal actions */
  source?: 'cache' | 'action' | 'desktop' | 'internal';
  
  /** Cache model name for 'cache' source tools */
  cache_model?: string;
  
  /** Connection ID pattern (if dynamic per user) */
  connectionIdPattern?: string;
}

// ============================================================================
// Tool Categories (for type safety)
// ============================================================================

export type ToolCategory = 
  | 'Email'
  | 'Calendar'
  | 'CRM'
  | 'Messaging'
  | 'Notes'
  | 'Search'
  | 'General';

// ============================================================================
// IToolProvider Interface
// ============================================================================

/**
 * Abstract interface for tool definition providers
 * 
 * @example
 * ```typescript
 * // JSON file implementation
 * const toolProvider: IToolProvider = new ToolConfigManager('./config/tools.json');
 * 
 * // Database implementation
 * const toolProvider: IToolProvider = new DatabaseToolProvider(db);
 * 
 * // Inject into PlannerService
 * const planner = new PlannerService({ llmClient, toolProvider, ... });
 * ```
 */
export interface IToolProvider {
  /**
   * Get all available tool configurations
   * 
   * @returns Array of all tool configs
   */
  getAllTools(): ToolConfig[];

  /**
   * Get a specific tool by name
   * 
   * @param name - Tool name (e.g., 'fetch_emails')
   * @returns Tool config or undefined if not found
   */
  getToolByName(name: string): ToolConfig | undefined;

  /**
   * Get tools filtered by category
   * 
   * @param category - Category name (e.g., 'Email', 'CRM')
   * @returns Array of tools in that category
   */
  getToolsByCategory(category: string): ToolConfig[];

  /**
   * Get tools filtered by multiple categories
   * 
   * @param categories - Array of category names
   * @returns Array of tools matching any of the categories
   */
  getToolsByCategories(categories: string[]): ToolConfig[];

  /**
   * Get tools for a specific provider
   * 
   * @param providerKey - Provider config key (e.g., 'google-mail', 'salesforce')
   * @returns Array of tools for that provider
   */
  getToolsByProvider(providerKey: string): ToolConfig[];

  /**
   * Get all unique categories
   * 
   * @returns Array of category names
   */
  getCategories(): string[];

  /**
   * Get all unique provider keys
   * 
   * @returns Array of provider config keys
   */
  getProviders(): string[];

  /**
   * Convert tools to LLM-compatible format (for tool_choice)
   * 
   * @param tools - Array of tool configs
   * @returns Tools formatted for LLM API
   */
  formatToolsForLLM(tools: ToolConfig[]): any[];

  /**
   * Reload tool configurations (if supported)
   * Useful for hot-reloading in development
   * 
   * @returns Promise resolving when reload is complete
   */
  reload?(): Promise<void>;
}

// ============================================================================
// Validation Helpers
// ============================================================================

/**
 * Validates tool arguments against the tool's parameter schema
 * 
 * @param tool - Tool configuration
 * @param args - Arguments to validate
 * @returns Validation result
 */
export interface ToolValidationResult {
  valid: boolean;
  errors?: string[];
  missingRequired?: string[];
}

export interface IToolValidator {
  validate(tool: ToolConfig, args: Record<string, any>): ToolValidationResult;
}
