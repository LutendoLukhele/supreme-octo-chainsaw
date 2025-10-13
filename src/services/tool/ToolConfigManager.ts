// src/services/tool/ToolConfigManager.ts
import fs from 'fs';
import path from 'path';
import winston from 'winston'; // Changed from namespace import to default import
import { z } from 'zod';
import { ToolConfig, ProviderConfig, EntityType } from './tool.types'; // Your existing types
import { DEDICATED_PLANNER_SYSTEM_PROMPT_TEMPLATE } from '../conversation/prompts/dedicatedPlannerPrompt';
import { CONFIG } from '../../config'// --- Interfaces for internal schema structure ---
export interface ToolParameterProperty {
    type: string | string[];
    description?: string;
    prompt?: string;
    hint?: string;
    enum?: string[];
    optional?: boolean;
    properties?: { [key: string]: ToolParameterProperty }; // For nested objects
    // Correctly define items for arrays
    items?: ToolParameterProperty | { type: string; properties?: { [key: string]: ToolParameterProperty }; required?: string[] };
    additionalProperties?: boolean | ToolParameterProperty;
    minProperties?: number;
    nullable?: boolean;
    metadata?: {
        entityTypeSpecific?: Record<string, any>;
        validation?: any;
    };
}

export interface ToolInputSchema {
    type: "object";
    properties: { [key: string]: ToolParameterProperty };
    required?: string[];
}

export interface ToolTopLevelParameters {
    type: "object";
    properties: { input: ToolInputSchema };
    required?: string[];
}

// Assuming ToolConfig from tool.types includes name, description, parameters
// export interface SimpleToolDefinition extends ToolConfig {} // Not strictly needed if ToolConfig is used

export interface ToolsConfigFile {
    tools: ToolConfig[];
    providers: Record<string, ProviderConfig>;
}

// --- Logger Setup (Define it here if not imported) ---
// If you have a shared logger in `src/utils/logger.ts`, fix the import path.
// Otherwise, create the logger instance here.
const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info', // Use environment variable or default
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    defaultMeta: { service: 'ToolConfigManager' },
    transports: [
        new winston.transports.Console({
             format: winston.format.combine(
                winston.format.colorize(),
                winston.format.simple()
            )
        }),
        // Add file transports if needed
        // new winston.transports.File({ filename: 'error.log', level: 'error' }),
        // new winston.transports.File({ filename: 'combined.log' })
    ],
});
// --- End Logger Setup ---




export class ToolConfigManager {
    private configFilePath: string;
    private toolMap: Map<string, ToolConfig> = new Map();
    private providers: Record<string, ProviderConfig> = {};
    // --- FIX 1: Use the correct type for the config object ---
    private toolConfig!: ToolsConfigFile;

    constructor() {
        this.configFilePath = CONFIG.TOOL_CONFIG_PATH ;
        this.loadConfig();
    }

    private loadConfig(): void {
        try {
            const configFile = fs.readFileSync(this.configFilePath, 'utf-8');
            // By casting here, you ensure type safety for the loaded data
            this.toolConfig = JSON.parse(configFile) as ToolsConfigFile;
            
            this.toolConfig.tools.forEach(tool => {
                this.toolMap.set(tool.name, tool);
            });
            this.providers = this.toolConfig.providers;
            
            logger.info('Tool configuration loaded successfully.', {
                toolCount: this.toolMap.size,
                providerCount: Object.keys(this.providers).length
            });

        } catch (error) {
            console.error('Failed to load tool-config.json:', error);
            this.toolConfig = { tools: [], providers: {} };
        }
    }

    // --- FIX 2: Implement the method correctly ---
   public getToolInputSchema(toolName: string): ToolInputSchema | undefined {
        const tool = this.getToolDefinition(toolName);
        if (!tool || !tool.parameters) {
            return undefined;
        }

        // The schema for ALL tools is now directly in the 'parameters' property.
        // We no longer need to check for a nested 'input' object.
        return tool.parameters as ToolInputSchema;
    }

    // Now, any other method can safely use this.toolConfig
  

    // --- START: NEW METHOD FOR STRATEGY 2.5 ---
    /**
     * Retrieves tools based on a list of categories.
     * Always includes tools from the 'Meta' category for essential functions like asking for missing parameters.
     * @param categories An array of category names to include.
     * @returns A filtered array of ToolConfig objects.
     */
   
    // --- END: NEW METHOD FOR STRATEGY 2.5 ---


    

    // --- IMPLEMENTED: This method provides robust validation for the ActionLauncherService ---
    public findMissingRequiredParams(toolName: string, parsedArgs: Record<string, any>): string[] {
        const inputSchema = this.getToolInputSchema(toolName);
        if (!inputSchema || !inputSchema.required) {
            return []; // No required parameters to check.
        }

        

        const missingParams: string[] = [];
        for (const paramName of inputSchema.required) {
            const value = parsedArgs[paramName];
            const isMissing = value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
            if (isMissing) {
                missingParams.push(paramName);
            }
        }
        return missingParams;

    }


    public getToolConfig(toolName: string): ToolConfig {
        const tool = this.toolMap.get(toolName);
        if (!tool) throw new Error(`Tool '${toolName}' not found.`);
        return tool;
    }

    public getAllTools(): ToolConfig[] {
        if (!this.toolMap) {
            logger.error("getAllTools called before toolMap was initialized.");
            return []; // Return an empty array to prevent a crash
        }
        return Array.from(this.toolMap.values());
    }

    // --- Schema and Parameter Accessors ---


    public getToolDefinition(toolName: string): ToolConfig | undefined { // Return ToolConfig type
        return this.toolMap.get(toolName);
    }

    public getToolByName(toolName: string): ToolConfig | undefined {
        return this.toolMap.get(toolName);
    }
    

    public getToolDisplayName(toolName: string): string | undefined {
        const tool = this.getToolDefinition(toolName);
        return (tool as any)?.display_name || tool?.name.replace(/_/g, ' '); // Fallback to formatted name
    }

    public getToolParameterProperty(toolName: string, paramName: string): ToolParameterProperty | undefined {
        const inputSchema = this.getToolInputSchema(toolName);
        return inputSchema?.properties?.[paramName];
    }

    public isParameterRequired(toolName: string, paramName: string): boolean {
        const inputSchema = this.getToolInputSchema(toolName);
        return inputSchema?.required?.includes(paramName) ?? false;
    }

    // --- Default Parameter Logic ---
    public canParameterBeDefaulted(toolName: string, paramName: string): boolean {
        // *** Keep your refined logic here ***
        logger.debug('Checking default capability', { toolName, paramName });
        switch (toolName) { /* ... Your cases ... */ }
        logger.debug(`No default rule found... Assuming no default.`);
        return false;
    }

    // --- Validation ---



    public findConditionallyMissingParams(toolName: string, parsedArgs: Record<string, any>): string[] {
    const missing: string[] = [];
    if (!parsedArgs) return missing;

    // --- Validation for 'create_entity' with all entity cases ---
    if (toolName === 'create_entity') {
        const fields = parsedArgs.fields || {};
        const entityType = parsedArgs.entityType;

        switch (entityType) {
            case 'Account':
                if (!fields.Name) missing.push('fields.Name');
                break;
            case 'Contact':
                if (!fields.LastName) missing.push('fields.LastName');
                break;
            case 'Deal':
                if (!fields.Name) missing.push('fields.Name');
                if (!fields.StageName) missing.push('fields.StageName');
                if (!fields.CloseDate) missing.push('fields.CloseDate');
                break;
            case 'Article':
                if (!fields.Title) missing.push('fields.Title');
                if (!fields.UrlName) missing.push('fields.UrlName');
                break;
            case 'Case':
                if (!fields.Subject) missing.push('fields.Subject');
                if (!fields.Status) missing.push('fields.Status');
                break;
            case 'Lead':
                if (!fields.Company) missing.push('fields.Company');
                if (!fields.LastName) missing.push('fields.LastName');
                break;
            default:
                // No specific conditional validation for this entity type in the script
                break;
        }
    }

    if (toolName === 'create_zoom_meeting') {
        const type = parsedArgs.type;
        if ((type === 'scheduled' || type === 'recurring') && !parsedArgs.start_time) {
            missing.push('start_time');
        }
        if (type === 'recurring' && !parsedArgs.recurrence) {
            missing.push('recurrence');
        }
    }


    // --- Validation for 'update_entity' ---
    if (toolName === 'update_entity') {
        if (!parsedArgs.identifier) {
            missing.push('identifier');
        }
        if (!parsedArgs.fields || Object.keys(parsedArgs.fields).length === 0) {
            missing.push('fields (cannot be empty)');
        }
    }

    // --- Validation for 'fetch_entity' ---
    if (toolName === 'fetch_entity') {
        const hasSpecificIdentifier = parsedArgs.identifier && parsedArgs.identifierType;
        const hasFilters = parsedArgs.filters && Object.keys(parsedArgs.filters).length > 0;
        const isFetchAll = typeof parsedArgs.identifier === 'string' && parsedArgs.identifier.toLowerCase() === 'all';

        if (!hasSpecificIdentifier && !hasFilters && !isFetchAll) {
            missing.push('A valid fetch criteria: (identifier + identifierType), a filters object, or an identifier of "all"');
        }
    }

    return missing;
}

    // Method to get tool definitions suitable for the planner prompt
    public getToolDefinitionsForPlanner(): ToolConfig[] {
        // ONLY include the core entity manipulation tools for the planner.
        // The planner's job is to decide which of these to use and with what arguments (like filters).
        const plannerSpecificTools = ['fetch_entity', 'create_entity', 'update_entity'];
        const allTools = this.getAllTools();
        const filteredTools = allTools.filter(tool => plannerSpecificTools.includes(tool.name));
        logger.debug(`Tools selected for planner: ${filteredTools.map(t => t.name).join(', ')}`);
        return filteredTools;
    }
    // Helper to get the planner system prompt content
    public getPlannerSystemPrompt(userInput: string, identifiedToolCalls: { name: string; arguments: Record<string, any>; id?: string }[]): string {
        const availableTools = this.getToolDefinitionsForPlanner();
        const toolDefinitionsJson = JSON.stringify(availableTools, null, 2);

        let identifiedToolsPromptSection = "No tools pre-identified.";
        if (identifiedToolCalls.length > 0) {
            identifiedToolsPromptSection = "The following tool calls were preliminarily identified (you should verify and integrate them into a coherent plan):\n";
            identifiedToolCalls.forEach(tc => {
                identifiedToolsPromptSection += `- Tool: ${tc.name}, Arguments: ${JSON.stringify(tc.arguments)}\n`;
            });
        }
        return DEDICATED_PLANNER_SYSTEM_PROMPT_TEMPLATE.replace('{{USER_CURRENT_MESSAGE}}', userInput).replace('{{TOOL_DEFINITIONS_JSON}}', toolDefinitionsJson).replace('{{PRE_IDENTIFIED_TOOLS_SECTION}}', identifiedToolsPromptSection);
    }
     // Zod validation (Keep if needed)
     public validateToolArgsWithZod(toolName: string, args: Record<string, any>): Record<string, any> {
        logger.info(`Validating args with Zod for ${toolName}`, { args });
        const inputSchema = this.getToolInputSchema(toolName);
        if (!inputSchema) throw new Error(`No input schema found for tool ${toolName}`);
        try {
            const zodSchema = this.createZodSchema(inputSchema);
            const validated = zodSchema.parse(args);
            logger.info(`Zod validation successful for ${toolName}`);
            return validated;
        } catch (error: any) {
            // Check if it's a ZodError for more specific logging
            if (error instanceof z.ZodError) {
                 logger.error(`Zod validation failed for ${toolName}`, { errors: error.errors });
                 // Construct a user-friendly message from Zod errors
                 const errorMessages = error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join('; ');
                 throw new Error(`Invalid arguments for tool '${toolName}': ${errorMessages}`);
            } else {
                logger.error(`Unexpected validation error for ${toolName}`, { error: error.message || error });
                throw new Error(`Validation failed for tool '${toolName}': ${error.message}`);
            }
        }
    }

    public getToolsByCategories(categories: string[]): ToolConfig[] {
        const allTools = this.getAllTools();
        return allTools.filter(tool => {
            const toolCategory = (tool as any).category;
            return toolCategory === 'Meta' || categories.includes(toolCategory);
        });
    }

    // Helper function to create Zod schema for a single property
    private createZodSchemaFromProperty(prop: ToolParameterProperty, propName: string): z.ZodTypeAny {
        let fieldSchema: z.ZodTypeAny;

        switch (prop.type) {
            case 'string':
                fieldSchema = z.string();
                if (prop.enum) {
                    const stringEnum = prop.enum.map(String);
                    if (stringEnum.length > 0) {
                        // Zod requires at least one value for enum
                        fieldSchema = z.enum(stringEnum as [string, ...string[]]);
                    } else {
                        logger.warn(`Enum for ${propName} is empty, using plain string.`);
                    }
                }
                break;
            case 'number':
            case 'integer': // Treat integer as number for Zod validation
                fieldSchema = z.number();
                break;
            case 'boolean':
                fieldSchema = z.boolean();
                break;
            case 'array':
                // Check if prop.items is defined and is an object (not an array itself)
                if (prop.items && typeof prop.items === 'object' && !Array.isArray(prop.items)) {
                    // Recursively create schema for array items
                    const itemSchema = this.createZodSchemaFromProperty(prop.items as ToolParameterProperty, `${propName}.items`);
                    fieldSchema = z.array(itemSchema);
                } else {
                    logger.warn(`Array type for ${propName} has missing/invalid items definition, using z.array(z.any()).`);
                    fieldSchema = z.array(z.any()); // Fallback for unknown items
                }
                break;
            case 'object':
                if (prop.properties) {
                    const nestedSchemaShape: Record<string, z.ZodTypeAny> = {};
                    const nestedRequired = (prop as any).required || []; // Assuming nested objects can have 'required'
                    Object.entries(prop.properties).forEach(([nestedKey, nestedProp]) => {
                        let nestedFieldSchema = this.createZodSchemaFromProperty(nestedProp, `${propName}.${nestedKey}`);
                        if (!nestedRequired.includes(nestedKey)) {
                            nestedFieldSchema = nestedFieldSchema.optional().nullable();
                        }
                        nestedSchemaShape[nestedKey] = nestedFieldSchema;
                    });
                    fieldSchema = z.object(nestedSchemaShape);
                } else {
                    logger.warn(`Object type for ${propName} has no properties defined, using z.record(z.any()).`);
                    fieldSchema = z.record(z.any()); // Fallback for object without defined properties
                }
                break;
            // --- FIX START ---
            default:
                // Handle unknown types gracefully
                logger.warn(`Unsupported parameter type '${prop.type}' for property '${propName}'. Using z.any().`);
                fieldSchema = z.any();
                break;
            // --- FIX END ---
        }
        return fieldSchema;
    }


    private createZodSchema(inputSchema: ToolInputSchema): z.ZodObject<any> {
        const schemaShape: Record<string, z.ZodTypeAny> = {};
        const requiredParams = inputSchema.required || [];

        Object.entries(inputSchema.properties).forEach(([key, prop]) => {
            // Use the helper function
            let fieldSchema = this.createZodSchemaFromProperty(prop, key); // Now guaranteed to be assigned

            // Apply optional/nullable based on top-level requirement
            if (!requiredParams.includes(key)) {
                // Make it optional AND nullable if not required
                fieldSchema = fieldSchema.optional().nullable();
            } else if (prop.nullable) {
                 // If explicitly allowed to be nullable even when required
                 fieldSchema = fieldSchema.nullable();
            }

            schemaShape[key] = fieldSchema;
        });

        // Use .strict() to disallow extra properties not defined in the schema
        return z.object(schemaShape).strict();
    }

    // --- Prompt Formatting Helpers ---
    public getFormattedParametersForPrompt(toolName: string): string {
        const inputSchema = this.getToolInputSchema(toolName);
        if (!inputSchema || !inputSchema.properties) return "    - No specific input parameters defined.";
        const requiredParams = inputSchema.required || [];

        const formatProps = (props: { [key: string]: ToolParameterProperty }, indent: string, reqList: string[]): string => {
             return Object.entries(props)
              .map(([name, prop]) => {
                const isRequired = reqList.includes(name);
                const typeString = Array.isArray(prop.type) ? prop.type.join('|') : prop.type;
                const typeInfo = ` (${typeString}${isRequired ? ', required' : ''})`;
                let nested = '';

                // Check if prop.items is an object and has a 'type' property before accessing further
                const itemsIsObject = prop.items && typeof prop.items === 'object' && !Array.isArray(prop.items);
                const itemType = itemsIsObject ? (prop.items as { type: string }).type : undefined;
                const itemProperties = itemsIsObject ? (prop.items as { properties?: any }).properties : undefined;
                const itemRequired = itemsIsObject ? (prop.items as { required?: string[] }).required || [] : [];


                if (prop.type === 'object' && prop.properties) {
                    const nestedRequired = (prop as any).required as string[] | undefined || [];
                    nested = ` (object properties):\n${formatProps(prop.properties, indent + '  ', nestedRequired)}`;
                } else if (prop.type === 'array' && itemsIsObject) { // Check itemsIsObject
                     if (itemType ==='object' && itemProperties) {
                         nested = ` (array of objects with properties):\n${formatProps(itemProperties, indent + '  ', itemRequired)}`;
                     } else if(itemType) { // Check itemType before using
                         nested = ` (array of ${itemType})`;
                     } else {
                          nested = ` (array of unknown type)`; // Fallback
                     }
                }
                const description = prop.description || prop.hint || name;
                return `${indent}- ${name}${typeInfo}: ${description}${nested}`;
              })
              .join('\n');
        };
        return formatProps(inputSchema.properties, '    ', requiredParams);
    }

    public getProviderConfigKeyForTool(toolName: string): string | undefined {
        const tool = this.getToolDefinition(toolName);
        const key = tool?.providerConfigKey;
        // Return undefined for meta-tools or if key is missing/invalid
        if (key && key !== "__META__") {
             return key;
        }
        if (tool && toolName !== 'request_missing_parameters') {
            logger.warn(`'providerConfigKey' field missing or invalid for tool '${toolName}'.`);
        }
        return undefined;
    }

    public formatToolsForLLMPrompt(): string {
        // Use getAllTools() to include the meta-tool
        return this.getAllTools().map(tool => {
            const paramText = this.getFormattedParametersForPrompt(tool.name);
            return `---
Tool Name: ${tool.name}
Description: ${tool.description}
Input Parameters Schema:
${paramText}
---`;
        }).join('\n');
    }

    public getGroqToolsDefinition(): any[] | undefined {

         const executableTools = this.getAllTools()
         return executableTools.map(tool => {
            const inputSchema = this.getToolInputSchema(tool.name);
            if (!inputSchema) {
                logger.warn(`Skipping Groq definition for ${tool.name}: No input schema found.`);
                return null;
            }
            // Ensure the schema structure matches Groq's expectation
            // (usually type: object, properties: {...}, required: [...])
            return {
                type: "function",
                function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: inputSchema // Pass the input schema directly
                }
            };
         }).filter(t => t !== null);
     }

    // --- Provider Methods (Need return statements) ---
    public getProviderConfig(providerName: string): ProviderConfig {
        const provider = this.providers[providerName];
        if (!provider) throw new Error(`Provider '${providerName}' not found.`);
        return provider; // Added return
    }
    public getProviderEndpoint(providerName: string): string {
        return this.getProviderConfig(providerName).endpoint; // Added return
    }
    public getProviderConfigKey(providerName: string): string {
        return this.getProviderConfig(providerName).provider_config_key; // Added return
    }
    public getConnectionId(providerName: string): string {
        return this.getProviderConfig(providerName).connection_id; // Added return
    }
    public getProviderObjects(provider: string): string[] {
        return this.providers[provider]?.objects || []; // Added return, handle missing provider
    }
    public getAllProviders(): string[] {
        return Object.keys(this.providers); // Added return
    }
    public getProviders(): Record<string, ProviderConfig> {
        return this.providers; // Added return
    }

    // --- Other Utility Methods (Keep as is, ensure they work with schema) ---
    public refreshConfig(): void { this.loadConfig(); } // Reloads config
    public getParameterPrompt(toolName: string, paramPath: string): string { /* Keep impl */ return ''; }
    public getParameterHint(toolName: string, paramPath: string): string { /* Keep impl */ return ''; }
    private resolveParam(schema: any, path: string): any { /* Keep impl */ }
}
