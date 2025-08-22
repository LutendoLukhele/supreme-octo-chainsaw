"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ToolConfigManager = void 0;
const fs_1 = __importDefault(require("fs"));
const winston_1 = __importDefault(require("winston"));
const zod_1 = require("zod");
const dedicatedPlannerPrompt_1 = require("../conversation/prompts/dedicatedPlannerPrompt");
const config_1 = require("../../config");
const logger = winston_1.default.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston_1.default.format.combine(winston_1.default.format.timestamp(), winston_1.default.format.json()),
    defaultMeta: { service: 'ToolConfigManager' },
    transports: [
        new winston_1.default.transports.Console({
            format: winston_1.default.format.combine(winston_1.default.format.colorize(), winston_1.default.format.simple())
        }),
    ],
});
class ToolConfigManager {
    constructor() {
        this.toolMap = new Map();
        this.providers = {};
        this.configFilePath = config_1.CONFIG.TOOL_CONFIG_PATH;
        this.loadConfig();
    }
    loadConfig() {
        try {
            const configFile = fs_1.default.readFileSync(this.configFilePath, 'utf-8');
            this.toolConfig = JSON.parse(configFile);
            this.toolConfig.tools.forEach(tool => {
                this.toolMap.set(tool.name, tool);
            });
            this.providers = this.toolConfig.providers;
            logger.info('Tool configuration loaded successfully.', {
                toolCount: this.toolMap.size,
                providerCount: Object.keys(this.providers).length
            });
        }
        catch (error) {
            console.error('Failed to load tool-config.json:', error);
            this.toolConfig = { tools: [], providers: {} };
        }
    }
    getToolInputSchema(toolName) {
        const tool = this.getToolDefinition(toolName);
        if (!tool || !tool.parameters) {
            return undefined;
        }
        return tool.parameters;
    }
    findMissingRequiredParams(toolName, parsedArgs) {
        const inputSchema = this.getToolInputSchema(toolName);
        if (!inputSchema || !inputSchema.required) {
            return [];
        }
        const missingParams = [];
        for (const paramName of inputSchema.required) {
            const value = parsedArgs[paramName];
            const isMissing = value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
            if (isMissing) {
                missingParams.push(paramName);
            }
        }
        return missingParams;
    }
    getToolConfig(toolName) {
        const tool = this.toolMap.get(toolName);
        if (!tool)
            throw new Error(`Tool '${toolName}' not found.`);
        return tool;
    }
    getAllTools() {
        if (!this.toolMap) {
            logger.error("getAllTools called before toolMap was initialized.");
            return [];
        }
        return Array.from(this.toolMap.values());
    }
    getToolDefinition(toolName) {
        return this.toolMap.get(toolName);
    }
    getToolDisplayName(toolName) {
        const tool = this.getToolDefinition(toolName);
        return tool?.display_name || tool?.name.replace(/_/g, ' ');
    }
    getToolParameterProperty(toolName, paramName) {
        const inputSchema = this.getToolInputSchema(toolName);
        return inputSchema?.properties?.[paramName];
    }
    isParameterRequired(toolName, paramName) {
        const inputSchema = this.getToolInputSchema(toolName);
        return inputSchema?.required?.includes(paramName) ?? false;
    }
    canParameterBeDefaulted(toolName, paramName) {
        logger.debug('Checking default capability', { toolName, paramName });
        switch (toolName) {
        }
        logger.debug(`No default rule found... Assuming no default.`);
        return false;
    }
    findConditionallyMissingParams(toolName, parsedArgs) {
        const missing = [];
        if (!parsedArgs)
            return missing;
        if (toolName === 'create_entity') {
            const fields = parsedArgs.fields || {};
            const entityType = parsedArgs.entityType;
            switch (entityType) {
                case 'Account':
                    if (!fields.Name)
                        missing.push('fields.Name');
                    break;
                case 'Contact':
                    if (!fields.LastName)
                        missing.push('fields.LastName');
                    break;
                case 'Deal':
                    if (!fields.Name)
                        missing.push('fields.Name');
                    if (!fields.StageName)
                        missing.push('fields.StageName');
                    if (!fields.CloseDate)
                        missing.push('fields.CloseDate');
                    break;
                case 'Article':
                    if (!fields.Title)
                        missing.push('fields.Title');
                    if (!fields.UrlName)
                        missing.push('fields.UrlName');
                    break;
                case 'Case':
                    if (!fields.Subject)
                        missing.push('fields.Subject');
                    if (!fields.Status)
                        missing.push('fields.Status');
                    break;
                case 'Lead':
                    if (!fields.Company)
                        missing.push('fields.Company');
                    if (!fields.LastName)
                        missing.push('fields.LastName');
                    break;
                default:
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
        if (toolName === 'update_entity') {
            if (!parsedArgs.identifier) {
                missing.push('identifier');
            }
            if (!parsedArgs.fields || Object.keys(parsedArgs.fields).length === 0) {
                missing.push('fields (cannot be empty)');
            }
        }
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
    getToolDefinitionsForPlanner() {
        const plannerSpecificTools = ['fetch_entity', 'create_entity', 'update_entity'];
        const allTools = this.getAllTools();
        const filteredTools = allTools.filter(tool => plannerSpecificTools.includes(tool.name));
        logger.debug(`Tools selected for planner: ${filteredTools.map(t => t.name).join(', ')}`);
        return filteredTools;
    }
    getPlannerSystemPrompt(userInput, identifiedToolCalls) {
        const availableTools = this.getToolDefinitionsForPlanner();
        const toolDefinitionsJson = JSON.stringify(availableTools, null, 2);
        let identifiedToolsPromptSection = "No tools pre-identified.";
        if (identifiedToolCalls.length > 0) {
            identifiedToolsPromptSection = "The following tool calls were preliminarily identified (you should verify and integrate them into a coherent plan):\n";
            identifiedToolCalls.forEach(tc => {
                identifiedToolsPromptSection += `- Tool: ${tc.name}, Arguments: ${JSON.stringify(tc.arguments)}\n`;
            });
        }
        return dedicatedPlannerPrompt_1.DEDICATED_PLANNER_SYSTEM_PROMPT_TEMPLATE.replace('{{USER_CURRENT_MESSAGE}}', userInput).replace('{{TOOL_DEFINITIONS_JSON}}', toolDefinitionsJson).replace('{{PRE_IDENTIFIED_TOOLS_SECTION}}', identifiedToolsPromptSection);
    }
    validateToolArgsWithZod(toolName, args) {
        logger.info(`Validating args with Zod for ${toolName}`, { args });
        const inputSchema = this.getToolInputSchema(toolName);
        if (!inputSchema)
            throw new Error(`No input schema found for tool ${toolName}`);
        try {
            const zodSchema = this.createZodSchema(inputSchema);
            const validated = zodSchema.parse(args);
            logger.info(`Zod validation successful for ${toolName}`);
            return validated;
        }
        catch (error) {
            if (error instanceof zod_1.z.ZodError) {
                logger.error(`Zod validation failed for ${toolName}`, { errors: error.errors });
                const errorMessages = error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join('; ');
                throw new Error(`Invalid arguments for tool '${toolName}': ${errorMessages}`);
            }
            else {
                logger.error(`Unexpected validation error for ${toolName}`, { error: error.message || error });
                throw new Error(`Validation failed for tool '${toolName}': ${error.message}`);
            }
        }
    }
    getToolsByCategories(categories) {
        const allTools = this.getAllTools();
        return allTools.filter(tool => {
            const toolCategory = tool.category;
            return toolCategory === 'Meta' || categories.includes(toolCategory);
        });
    }
    createZodSchemaFromProperty(prop, propName) {
        let fieldSchema;
        switch (prop.type) {
            case 'string':
                fieldSchema = zod_1.z.string();
                if (prop.enum) {
                    const stringEnum = prop.enum.map(String);
                    if (stringEnum.length > 0) {
                        fieldSchema = zod_1.z.enum(stringEnum);
                    }
                    else {
                        logger.warn(`Enum for ${propName} is empty, using plain string.`);
                    }
                }
                break;
            case 'number':
            case 'integer':
                fieldSchema = zod_1.z.number();
                break;
            case 'boolean':
                fieldSchema = zod_1.z.boolean();
                break;
            case 'array':
                if (prop.items && typeof prop.items === 'object' && !Array.isArray(prop.items)) {
                    const itemSchema = this.createZodSchemaFromProperty(prop.items, `${propName}.items`);
                    fieldSchema = zod_1.z.array(itemSchema);
                }
                else {
                    logger.warn(`Array type for ${propName} has missing/invalid items definition, using z.array(z.any()).`);
                    fieldSchema = zod_1.z.array(zod_1.z.any());
                }
                break;
            case 'object':
                if (prop.properties) {
                    const nestedSchemaShape = {};
                    const nestedRequired = prop.required || [];
                    Object.entries(prop.properties).forEach(([nestedKey, nestedProp]) => {
                        let nestedFieldSchema = this.createZodSchemaFromProperty(nestedProp, `${propName}.${nestedKey}`);
                        if (!nestedRequired.includes(nestedKey)) {
                            nestedFieldSchema = nestedFieldSchema.optional().nullable();
                        }
                        nestedSchemaShape[nestedKey] = nestedFieldSchema;
                    });
                    fieldSchema = zod_1.z.object(nestedSchemaShape);
                }
                else {
                    logger.warn(`Object type for ${propName} has no properties defined, using z.record(z.any()).`);
                    fieldSchema = zod_1.z.record(zod_1.z.any());
                }
                break;
            default:
                logger.warn(`Unsupported parameter type '${prop.type}' for property '${propName}'. Using z.any().`);
                fieldSchema = zod_1.z.any();
                break;
        }
        return fieldSchema;
    }
    createZodSchema(inputSchema) {
        const schemaShape = {};
        const requiredParams = inputSchema.required || [];
        Object.entries(inputSchema.properties).forEach(([key, prop]) => {
            let fieldSchema = this.createZodSchemaFromProperty(prop, key);
            if (!requiredParams.includes(key)) {
                fieldSchema = fieldSchema.optional().nullable();
            }
            else if (prop.nullable) {
                fieldSchema = fieldSchema.nullable();
            }
            schemaShape[key] = fieldSchema;
        });
        return zod_1.z.object(schemaShape).strict();
    }
    getFormattedParametersForPrompt(toolName) {
        const inputSchema = this.getToolInputSchema(toolName);
        if (!inputSchema || !inputSchema.properties)
            return "    - No specific input parameters defined.";
        const requiredParams = inputSchema.required || [];
        const formatProps = (props, indent, reqList) => {
            return Object.entries(props)
                .map(([name, prop]) => {
                const isRequired = reqList.includes(name);
                const typeString = Array.isArray(prop.type) ? prop.type.join('|') : prop.type;
                const typeInfo = ` (${typeString}${isRequired ? ', required' : ''})`;
                let nested = '';
                const itemsIsObject = prop.items && typeof prop.items === 'object' && !Array.isArray(prop.items);
                const itemType = itemsIsObject ? prop.items.type : undefined;
                const itemProperties = itemsIsObject ? prop.items.properties : undefined;
                const itemRequired = itemsIsObject ? prop.items.required || [] : [];
                if (prop.type === 'object' && prop.properties) {
                    const nestedRequired = prop.required || [];
                    nested = ` (object properties):\n${formatProps(prop.properties, indent + '  ', nestedRequired)}`;
                }
                else if (prop.type === 'array' && itemsIsObject) {
                    if (itemType === 'object' && itemProperties) {
                        nested = ` (array of objects with properties):\n${formatProps(itemProperties, indent + '  ', itemRequired)}`;
                    }
                    else if (itemType) {
                        nested = ` (array of ${itemType})`;
                    }
                    else {
                        nested = ` (array of unknown type)`;
                    }
                }
                const description = prop.description || prop.hint || name;
                return `${indent}- ${name}${typeInfo}: ${description}${nested}`;
            })
                .join('\n');
        };
        return formatProps(inputSchema.properties, '    ', requiredParams);
    }
    getProviderConfigKeyForTool(toolName) {
        const tool = this.getToolDefinition(toolName);
        const key = tool?.providerConfigKey;
        if (key && key !== "__META__") {
            return key;
        }
        if (tool && toolName !== 'request_missing_parameters') {
            logger.warn(`'providerConfigKey' field missing or invalid for tool '${toolName}'.`);
        }
        return undefined;
    }
    formatToolsForLLMPrompt() {
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
    getGroqToolsDefinition() {
        const executableTools = this.getAllTools();
        return executableTools.map(tool => {
            const inputSchema = this.getToolInputSchema(tool.name);
            if (!inputSchema) {
                logger.warn(`Skipping Groq definition for ${tool.name}: No input schema found.`);
                return null;
            }
            return {
                type: "function",
                function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: inputSchema
                }
            };
        }).filter(t => t !== null);
    }
    getProviderConfig(providerName) {
        const provider = this.providers[providerName];
        if (!provider)
            throw new Error(`Provider '${providerName}' not found.`);
        return provider;
    }
    getProviderEndpoint(providerName) {
        return this.getProviderConfig(providerName).endpoint;
    }
    getProviderConfigKey(providerName) {
        return this.getProviderConfig(providerName).provider_config_key;
    }
    getConnectionId(providerName) {
        return this.getProviderConfig(providerName).connection_id;
    }
    getProviderObjects(provider) {
        return this.providers[provider]?.objects || [];
    }
    getAllProviders() {
        return Object.keys(this.providers);
    }
    getProviders() {
        return this.providers;
    }
    refreshConfig() { this.loadConfig(); }
    getParameterPrompt(toolName, paramPath) { return ''; }
    getParameterHint(toolName, paramPath) { return ''; }
    resolveParam(schema, path) { }
}
exports.ToolConfigManager = ToolConfigManager;
