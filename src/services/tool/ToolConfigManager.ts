// Complete ToolConfigManager.ts with proper loading for your config structure

import fs from 'fs';
import path from 'path';
import winston from 'winston';
import Ajv from 'ajv';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [new winston.transports.Console()],
});

export interface ToolParameterProperty {
  type: string | string[];
  description?: string;
  prompt?: string;
  hint?: string;
  enum?: string[];
  optional?: boolean;
  properties?: Record<string, ToolParameterProperty>;
  items?: ToolParameterProperty;
}

export interface ToolInputSchema {
  type: string;
  properties: Record<string, ToolParameterProperty>;
  required?: string[];
}

export interface ToolConfig {
  name: string;
  description: string;
  category: string;
  display_name?: string;
  providerConfigKey?: string;
  parameters?: ToolInputSchema;
}

export class ToolConfigManager {
  private toolConfigs: Record<string, ToolConfig[]> = {};
  private ajv: InstanceType<typeof Ajv>;

  constructor(configPath?: string) {
    this.ajv = new Ajv({ allErrors: true });
    this.loadToolConfigs(configPath);
    this.validateToolConfiguration();
  }

  private loadToolConfigs(configPath?: string): void {
    const defaultPath = path.join(process.cwd(), 'src', 'config', 'toolConfig.json');
    const finalPath = configPath || defaultPath;

    try {
      const configData = fs.readFileSync(finalPath, 'utf-8');
      const parsedConfig = JSON.parse(configData);

      logger.info('ToolConfigManager: Loading tool configuration', {
        path: finalPath,
        configStructure: Object.keys(parsedConfig)
      });

      // CRITICAL FIX: Handle your flat array structure
      if (parsedConfig.tools && Array.isArray(parsedConfig.tools)) {
        // Your config has { "tools": [...] } structure
        logger.info('ToolConfigManager: Detected flat tools array structure');
        
        // Group tools by category
        parsedConfig.tools.forEach((tool: any) => {
          const category = tool.category || 'General';
          
          if (!this.toolConfigs[category]) {
            this.toolConfigs[category] = [];
          }
          
          this.toolConfigs[category].push({
            name: tool.name,
            description: tool.description,
            category: category,
            display_name: tool.display_name || tool.name,
            providerConfigKey: tool.providerConfigKey,
            parameters: tool.parameters
          });
        });

        logger.info('ToolConfigManager: Grouped tools by category', {
          categories: Object.keys(this.toolConfigs),
          toolsByCategory: Object.entries(this.toolConfigs).map(([cat, tools]) => ({
            category: cat,
            count: tools.length,
            names: tools.map(t => t.name)
          }))
        });
      } else if (typeof parsedConfig === 'object') {
        // Legacy structure: { "Email": [...], "CRM": [...] }
        logger.info('ToolConfigManager: Detected legacy category-based structure');
        this.toolConfigs = parsedConfig;
      } else {
        throw new Error('Invalid tool configuration structure');
      }

    } catch (error: any) {
      logger.error('ToolConfigManager: Failed to load tool configuration', {
        path: finalPath,
        error: error.message
      });
      throw error;
    }
  }

  private validateToolConfiguration(): void {
    const allTools = this.getAllTools();
    
    logger.info('ToolConfigManager: Validation on init', {
      totalCategories: Object.keys(this.toolConfigs).length,
      categories: Object.keys(this.toolConfigs),
      totalTools: allTools.length,
      toolsByCategory: Object.entries(this.toolConfigs).map(([cat, tools]) => ({
        category: cat,
        count: tools.length,
        names: tools.map(t => t.name)
      }))
    });

    // Check for critical tools
    const criticalTools = [
      { name: 'fetch_emails', category: 'Email' },
      { name: 'send_email', category: 'Email' },
      { name: 'fetch_entity', category: 'CRM' }
    ];

    const missingCritical: string[] = [];
    criticalTools.forEach(({ name, category }) => {
      if (!this.toolExists(name)) {
        missingCritical.push(`${name} (expected in ${category})`);
      }
    });

    if (missingCritical.length > 0) {
      logger.error('❌ CRITICAL: Missing required tools at initialization!', {
        missingTools: missingCritical,
        loadedTools: allTools.map(t => t.name)
      });
    } else {
      logger.info('✅ All critical tools validated successfully', {
        toolCount: allTools.length,
        tools: allTools.map(t => ({ name: t.name, category: t.category }))
      });
    }
  }

  /**
   * Get ALL tools for the planner - returns everything
   */
  public getToolDefinitionsForPlanner(): Array<{
    name: string;
    description: string;
    category: string;
    parameters?: any;
  }> {
    const allTools: Array<{
      name: string;
      description: string;
      category: string;
      parameters?: any;
    }> = [];

    // Iterate through ALL categories and ALL tools
    for (const [category, tools] of Object.entries(this.toolConfigs)) {
      tools.forEach((tool: ToolConfig) => {
        allTools.push({
          name: tool.name,
          description: tool.description,
          category: category,
          parameters: tool.parameters
        });
      });
    }

    logger.info('ToolConfigManager: Providing ALL tools to planner', {
      totalTools: allTools.length,
      byCategory: Object.entries(this.toolConfigs).map(([cat, tools]) => ({
        category: cat,
        count: tools.length
      })),
      allToolNames: allTools.map(t => t.name)
    });

    // Verification
    const hasFetchEmails = allTools.some(t => t.name === 'fetch_emails');
    const hasSendEmail = allTools.some(t => t.name === 'send_email');
    
    if (!hasFetchEmails || !hasSendEmail) {
      logger.error('❌ CRITICAL: Email tools missing from planner tools!', {
        hasFetchEmails,
        hasSendEmail,
        availableTools: allTools.map(t => t.name)
      });
    } else {
      logger.info('✅ Email tools confirmed in planner tools');
    }

    return allTools;
  }

  /**
   * Get tools by categories (for ConversationService filtering)
   */
  public getToolsByCategories(categories: string[]): ToolConfig[] {
    const filtered: ToolConfig[] = [];
    
    categories.forEach(category => {
      const tools = this.toolConfigs[category];
      if (tools && Array.isArray(tools)) {
        filtered.push(...tools);
      } else {
        logger.warn('ToolConfigManager: Category not found', { 
          requestedCategory: category,
          availableCategories: Object.keys(this.toolConfigs)
        });
      }
    });

    logger.info('ToolConfigManager: Filtered tools by categories', {
      requestedCategories: categories,
      foundCount: filtered.length,
      toolNames: filtered.map(t => t.name)
    });

    return filtered;
  }

  /**
   * Get input schema for a specific tool
   */
  public getToolInputSchema(toolName: string): ToolInputSchema | null {
    const tool = this.getToolDefinition(toolName);
    return tool?.parameters || null;
  }

  /**
   * Get a specific tool definition
   */
  public getToolDefinition(toolName: string): ToolConfig | undefined {
    return this.getAllTools().find(t => t.name === toolName);
  }

  /**
   * Get tool display name
   */
  public getToolDisplayName(toolName: string): string | null {
    const tool = this.getToolDefinition(toolName);
    return tool?.display_name || tool?.name || null;
  }

  /**
   * Check if a tool exists
   */
  public toolExists(toolName: string): boolean {
    return this.getAllTools().some(t => t.name === toolName);
  }

  /**
   * Get all tools from all categories
   */
  private getAllTools(): ToolConfig[] {
    const allTools: ToolConfig[] = [];
    for (const tools of Object.values(this.toolConfigs)) {
      if (Array.isArray(tools)) {
        allTools.push(...tools);
      }
    }
    return allTools;
  }

  /**
   * Validate tool arguments using Zod-like validation
   */
  public validateToolArgsWithZod(toolName: string, args: Record<string, any>): void {
    const schema = this.getToolInputSchema(toolName);
    
    if (!schema) {
      throw new Error(`No schema found for tool: ${toolName}`);
    }

    const validate = this.ajv.compile(schema);
    const valid = validate(args);

    if (!valid) {
      const errors = validate.errors?.map(e => `${e.dataPath} ${e.message}`).join(', ') || 'Validation failed';
      logger.warn('Validation failed', { toolName, args, errors });
      throw new Error(errors);
    }

    logger.info('Validation passed', { toolName });
  }

  /**
   * Find missing required parameters
   */
  public findMissingRequiredParams(toolName: string, args: Record<string, any>): string[] {
    const schema = this.getToolInputSchema(toolName);
    if (!schema || !schema.required) return [];

    return schema.required.filter(param => {
      const value = args[param];
      return value === undefined || value === null || value === '';
    });
  }

  /**
   * Find conditionally missing parameters
   */
  public findConditionallyMissingParams(toolName: string, args: Record<string, any>): string[] {
    const schema = this.getToolInputSchema(toolName);
    if (!schema || !schema.properties) return [];

    const conditionallyMissing: string[] = [];
    
    for (const [paramName, paramDef] of Object.entries(schema.properties)) {
      // Skip if it's a required param (handled separately)
      if (schema.required?.includes(paramName)) continue;

      // Check if the param has a prompt/hint suggesting it's important
      if ((paramDef.prompt || paramDef.hint) && !args[paramName]) {
        conditionallyMissing.push(paramName);
      }
    }

    return conditionallyMissing;
  }
}