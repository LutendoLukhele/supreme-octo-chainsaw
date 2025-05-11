"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ToolConfigManager = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const winston_1 = __importDefault(require("winston"));
const zod_1 = require("zod");
const tool_types_1 = require("./tool.types");
const logger = winston_1.default.createLogger({
    level: 'info',
    format: winston_1.default.format.json(),
    defaultMeta: { service: 'ToolConfigManager' },
    transports: [
        new winston_1.default.transports.Console(),
        new winston_1.default.transports.File({
            filename: 'combined.log',
            maxsize: 1024 * 1024 * 10 // 10MB
        })
    ],
    rejectionHandlers: [
        new winston_1.default.transports.File({ filename: 'rejections.log' })
    ]
});
class ToolConfigManager {
    static getAllRequiredParams() {
        throw new Error('Method not implemented.');
    }
    configFilePath;
    tools;
    providers;
    objects;
    toolDescriptionCache = null;
    constructor(configFilePath) {
        this.configFilePath = './src/config/tool-config.json'; // or use an absolute path
        this.tools = {};
        this.providers = {};
        this.objects = {};
        this.loadConfig();
    }
    loadConfig() {
        try {
            logger.info(`Loading configuration from ${this.configFilePath}`);
            const configData = JSON.parse(fs_1.default.readFileSync(path_1.default.resolve(this.configFilePath), 'utf-8'));
            // Validate config structure
            if (!configData || !configData.tools || !configData.providers) {
                throw new Error('Invalid configuration structure: tools or providers are missing.');
            }
            logger.info('Successfully loaded configuration file', { config: configData });
            configData.tools.forEach((tool) => {
                this.tools[tool.name] = tool;
            });
            Object.entries(configData.providers).forEach(([providerName, providerData]) => {
                this.providers[providerName] = providerData;
                this.objects[providerName] = providerData.objects;
            });
        }
        catch (error) {
            logger.error(`Error loading configuration: ${error.message}`, { error });
            throw new Error(`Error loading configuration: ${error.message}`);
        }
    }
    validateToolArgs(toolName, args) {
        logger.info(`Validating arguments for tool ${toolName}`, { args });
        const toolConfig = this.getToolConfig(toolName);
        try {
            // Create dynamic schema based on tool parameters
            const schema = this.createZodSchema(toolConfig.parameters);
            const validated = schema.parse(args);
            // Specific validations for entity operations
            if (toolName.includes('entity') && 'entityType' in args) {
                this.validateEntityType(args.entityType);
            }
            logger.info(`Validation successful for ${toolName}`, { validated });
            return validated;
        }
        catch (error) {
            logger.error(`Validation failed for ${toolName}`, { error });
            throw new Error(`Invalid arguments for tool '${toolName}': ${error.message}`);
        }
    }
    validateEntityType(entityType) {
        if (!Object.values(tool_types_1.EntityType).includes(entityType)) {
            throw new Error(`Invalid entity type: ${entityType}`);
        }
    }
    createZodSchema(parameters) {
        const schemaShape = {};
        Object.entries(parameters.properties).forEach(([key, prop]) => {
            let fieldSchema;
            switch (prop.type) {
                case 'string':
                    fieldSchema = zod_1.z.string();
                    if (prop.enum) {
                        fieldSchema = zod_1.z.enum(prop.enum);
                    }
                    break;
                case 'integer':
                    fieldSchema = zod_1.z.number().int();
                    break;
                case 'number':
                    fieldSchema = zod_1.z.number();
                    break;
                case 'boolean':
                    fieldSchema = zod_1.z.boolean();
                    break;
                case 'object':
                    fieldSchema = zod_1.z.record(zod_1.z.any());
                    break;
                case 'array':
                    fieldSchema = zod_1.z.array(zod_1.z.any());
                    break;
                default:
                    fieldSchema = zod_1.z.any();
            }
            if (!parameters.required?.includes(key)) {
                fieldSchema = fieldSchema.optional();
            }
            schemaShape[key] = fieldSchema;
        });
        return zod_1.z.object(schemaShape);
    }
    // Tool-related methods
    getToolConfig(toolName) {
        const tool = this.tools[toolName];
        if (!tool) {
            throw new Error(`Tool '${toolName}' not found in configuration`);
        }
        return tool;
    }
    getToolNames() {
        return Object.keys(this.tools);
    }
    getToolParameters(toolName) {
        return this.getToolConfig(toolName).parameters;
    }
    isValidTool(toolName) {
        return toolName in this.tools;
    }
    getToolRequiredParams(toolName) {
        const tool = this.getToolConfig(toolName);
        const requiredParams = [];
        if (tool.input?.fields?.required) {
            requiredParams.push(...tool.input.fields.required);
        }
        if (tool.input?.entityType?.enum) {
            requiredParams.push('entityType');
        }
        return requiredParams;
    }
    // NEW: Returns an array of all tool configurations.
    getAllTools() {
        return Object.values(this.tools);
    }
    // NEW: Returns a mapping of each tool's name to its required parameters.
    getAllRequiredParams() {
        const result = {};
        Object.entries(this.tools).forEach(([toolName, tool]) => {
            let requiredParams = [];
            if (tool.input?.fields?.required) {
                requiredParams = [...tool.input.fields.required]; // clone array
            }
            if (tool.input?.entityType?.enum) {
                requiredParams.push('entityType');
            }
            result[toolName] = requiredParams;
        });
        return result;
    }
    getFieldConfig(entityType, fieldName) {
        const toolConfig = Object.values(this.tools).find((tool) => tool.input?.entityType?.enum.includes(entityType));
        return toolConfig?.input?.fields?.properties[fieldName];
    }
    getRequiredFields(entityType) {
        const toolConfig = Object.values(this.tools).find((tool) => tool.input?.entityType?.enum.includes(entityType));
        return toolConfig?.input?.fields?.required || [];
    }
    getEntityTypeConfig(toolName) {
        return this.getToolConfig(toolName)?.input?.entityType;
    }
    // Provider-related methods
    getProviderConfig(providerName) {
        const provider = this.providers[providerName];
        if (!provider) {
            throw new Error(`Provider '${providerName}' not found in configuration`);
        }
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
        return this.objects[provider] || [];
    }
    getAllProviders() {
        return Object.keys(this.providers);
    }
    getProviders() {
        return this.providers;
    }
    // Tool description methods
    getToolDescriptions() {
        if (this.toolDescriptionCache) {
            return this.toolDescriptionCache;
        }
        this.toolDescriptionCache = Object.values(this.tools).map(tool => ({
            type: 'function',
            function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
            },
        }));
        return this.toolDescriptionCache;
    }
    // Utility methods
    refreshConfig() {
        this.toolDescriptionCache = null;
        this.loadConfig();
    }
    getParameterPrompt(toolName, paramPath) {
        const tool = this.getToolConfig(toolName);
        const param = this.resolveParam(tool.parameters, paramPath);
        return param?.prompt || `Please provide ${paramPath.split('.').pop()}`;
    }
    getParameterHint(toolName, paramPath) {
        const tool = this.getToolConfig(toolName);
        const param = this.resolveParam(tool.parameters, paramPath);
        return param?.hint || 'Enter value';
    }
    resolveParam(schema, path) {
        return path.split('.').reduce((obj, key) => obj?.properties?.[key], schema);
    }
}
exports.ToolConfigManager = ToolConfigManager;
