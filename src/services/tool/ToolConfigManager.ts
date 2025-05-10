// src/services/tool/ToolConfigManager.ts
import fs from 'fs';
import path from 'path';
import winston from 'winston'; // Import winston directly
import { z } from 'zod';
import { ToolConfig, ProviderConfig, EntityType } from './tool.types'; // Your existing types

// --- Interfaces for internal schema structure ---
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
    getToolParametersSchema(intendedToolName: string) {
        throw new Error('Method not implemented.');
    }
    private configFilePath: string;
    private tools: Record<string, ToolConfig> = {};
    private providers: Record<string, ProviderConfig> = {};
    private toolMap: Map<string, ToolConfig> = new Map();

    constructor(configFilePath: string) {
        this.configFilePath = configFilePath || './src/config/tool-config.json'; // Ensure path is valid
        this.loadConfig();
    }

    private loadConfig(): void {
        try {
            const fullPath = path.resolve(this.configFilePath);
            logger.info(`Loading tool configuration from: ${fullPath}`);
            if (!fs.existsSync(fullPath)) throw new Error(`Tool config file not found at ${fullPath}`);

            const fileContent = fs.readFileSync(fullPath, 'utf-8');
            const configData = JSON.parse(fileContent) as ToolsConfigFile;

            if (!configData || !Array.isArray(configData.tools) || !configData.providers) {
                throw new Error('Invalid configuration structure: tools array or providers missing.');
            }

            this.tools = {}; this.toolMap.clear();
            configData.tools.forEach((tool: ToolConfig) => {
                // Basic validation of tool structure before adding
                if (!tool.name || !tool.description || !tool.parameters) {
                   logger.warn("Skipping tool due to missing required fields (name, description, parameters)", { toolName: tool.name });
                   return;
                }
                // Add further validation if necessary
                this.tools[tool.name] = tool;
                this.toolMap.set(tool.name, tool);
            });

            // Add meta-tool definition programmatically
            const metaToolName = "request_missing_parameters";
            if (!this.tools[metaToolName]) {
                 const metaTool: ToolConfig = {
                     name: metaToolName,
                     description: "Use this tool ONLY when required parameters for another tool are missing...",
                     parameters: {
                         type: "object",
                         properties: {
                             input: {
                                 type: "object",
                                 properties: {
                                     intended_tool_name: { type: "string", description: "The intended tool name." },
                                     missing_params: { type: "array", items: { type: "string" }, description: "REQUIRED missing parameter names." },
                                     clarification_question: { type: "string", description: "Question to ask the user." }
                                 },
                                 required: ["intended_tool_name", "missing_params", "clarification_question"]
                             }
                         },
                         required: ["input"]
                     },
                     // Add other REQUIRED fields from ToolConfig if any (e.g., input/output schemas might be optional)
                     // If input/output are required in ToolConfig, provide placeholder/empty schemas
                     input: {},
                     nangoService: undefined,
                     default_params: {},
                     providerConfigKey: ''
                 };
                 this.tools[metaToolName] = metaTool;
                 this.toolMap.set(metaToolName, metaTool);
                 logger.info(`Added meta-tool '${metaToolName}' definition.`);
            }

            this.providers = configData.providers;
            logger.info(`ToolConfigManager loaded ${Object.keys(this.tools).length} tools.`);

        } catch (error: any) {
            logger.error(`Error loading/parsing tool configuration: ${error.message}`, { path: this.configFilePath });
            throw new Error(`Failed to initialize ToolConfigManager: ${error.message}`);
        }
    }

    // --- Tool Accessors ---
    public getToolConfig(toolName: string): ToolConfig {
        const tool = this.toolMap.get(toolName);
        if (!tool) throw new Error(`Tool '${toolName}' not found.`);
        return tool;
    }

    public getAllTools(): ToolConfig[] {
        return Array.from(this.toolMap.values());
    }

    // --- Schema and Parameter Accessors ---
    public getToolInputSchema(toolName: string): ToolInputSchema | undefined {
         const tool = this.getToolDefinition(toolName); // Use existing getter
         const params = tool?.parameters as ToolTopLevelParameters | undefined;
         return params?.properties?.input;
    }

    public getToolDefinition(toolName: string): ToolConfig | undefined { // Return ToolConfig type
        return this.toolMap.get(toolName);
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
    public findMissingRequiredParams(toolName: string, parsedArgs: Record<string, any>): string[] {
        const inputSchema = this.getToolInputSchema(toolName);
        const requiredParams = inputSchema?.required || [];
        const missingThatNeedInput: string[] = [];
         for (const paramName of requiredParams) {
             const value = parsedArgs[paramName];
             const isMissingValue = value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
             if (isMissingValue && !this.canParameterBeDefaulted(toolName, paramName)) {
                 missingThatNeedInput.push(paramName);
             }
         }
         if (missingThatNeedInput.length > 0) logger.warn(`Validation: Missing required params for ${toolName}`, { missingThatNeedInput });
         return missingThatNeedInput;
    }



    public findConditionallyMissingParams(toolName: string, parsedArgs: Record<string, any>): string[] {
        const missing: string[] = [];
        if (!parsedArgs) return missing;
    
        if (toolName === 'fetch_entity') {
            const { identifier, filters, operation } = parsedArgs;
            if (operation === 'fetch') {
                // Case 1: User explicitly wants to fetch "all"
                const isFetchingAll = identifier && typeof identifier === 'string' && identifier.toLowerCase() === 'all';
                // Case 2: User provides a specific identifier (that is not "all" and not empty)
                const hasSpecificNonAllIdentifier = identifier && typeof identifier === 'string' && identifier.toLowerCase() !== 'all' && identifier.trim() !== '';
                // Case 3: User provides filters
                const hasFilters = filters && typeof filters === 'object' && Object.keys(filters).length > 0;
    
                // If none of the valid conditions are met (not fetching "all", no specific non-"all" ID, and no filters),
                // then a parameter is considered missing.
                if (!isFetchingAll && !hasSpecificNonAllIdentifier && !hasFilters) {
                    logger.warn(`[ConditionalValidation] fetch_entity: To fetch data, provide a specific 'identifier' (e.g., an ID), 'filters', or set 'identifier' to "all" to fetch everything. Suggesting 'filters'.`, { parsedArgs });
                    missing.push('filters'); // Suggesting 'filters' as a general way to specify criteria
                }
            }
        }
        // Add for update_entity too
        if (toolName === 'update_entity') {
            const { identifier, filters, operation } = parsedArgs; // fields is already in 'required'
            if (operation === 'update') {
                const hasIdentifier = identifier && typeof identifier === 'string' && identifier.trim() !== '';
                const hasFilters = filters && typeof filters === 'object' && Object.keys(filters).length > 0;
                if (!hasIdentifier && !hasFilters) {
                    logger.warn(`[ConditionalValidation] update_entity is missing identifier or filters to specify record(s). Suggesting 'identifier'.`, { parsedArgs });
                    missing.push('identifier'); // Or 'filters'
                }
            }
        }
        return missing;
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