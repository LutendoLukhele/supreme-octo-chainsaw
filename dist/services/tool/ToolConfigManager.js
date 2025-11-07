"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ToolConfigManager = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const winston_1 = __importDefault(require("winston"));
const ajv_1 = __importDefault(require("ajv"));
const logger = winston_1.default.createLogger({
    level: 'info',
    format: winston_1.default.format.combine(winston_1.default.format.timestamp(), winston_1.default.format.json()),
    transports: [new winston_1.default.transports.Console()],
});
class ToolConfigManager {
    constructor(configPath) {
        this.toolConfigs = {};
        this.ajv = new ajv_1.default({ allErrors: true });
        this.loadToolConfigs(configPath);
        this.validateToolConfiguration();
    }
    loadToolConfigs(configPath) {
        const defaultPath = path_1.default.join(process.cwd(), 'config', 'tool-config.json');
        const finalPath = configPath || defaultPath;
        try {
            const configData = fs_1.default.readFileSync(finalPath, 'utf-8');
            const parsedConfig = JSON.parse(configData);
            logger.info('ToolConfigManager: Loading tool configuration', {
                path: finalPath,
                configStructure: Object.keys(parsedConfig)
            });
            if (parsedConfig.tools && Array.isArray(parsedConfig.tools)) {
                logger.info('ToolConfigManager: Detected flat tools array structure');
                parsedConfig.tools.forEach((tool) => {
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
            }
            else if (typeof parsedConfig === 'object') {
                logger.info('ToolConfigManager: Detected legacy category-based structure');
                this.toolConfigs = parsedConfig;
            }
            else {
                throw new Error('Invalid tool configuration structure');
            }
        }
        catch (error) {
            logger.error('ToolConfigManager: Failed to load tool configuration', {
                path: finalPath,
                error: error.message
            });
            throw error;
        }
    }
    validateToolConfiguration() {
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
        const criticalTools = [
            { name: 'fetch_emails', category: 'Email' },
            { name: 'send_email', category: 'Email' },
            { name: 'fetch_entity', category: 'CRM' }
        ];
        const missingCritical = [];
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
        }
        else {
            logger.info('✅ All critical tools validated successfully', {
                toolCount: allTools.length,
                tools: allTools.map(t => ({ name: t.name, category: t.category }))
            });
        }
    }
    getToolDefinitionsForPlanner() {
        const allTools = [];
        for (const [category, tools] of Object.entries(this.toolConfigs)) {
            tools.forEach((tool) => {
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
        const hasFetchEmails = allTools.some(t => t.name === 'fetch_emails');
        const hasSendEmail = allTools.some(t => t.name === 'send_email');
        if (!hasFetchEmails || !hasSendEmail) {
            logger.error('❌ CRITICAL: Email tools missing from planner tools!', {
                hasFetchEmails,
                hasSendEmail,
                availableTools: allTools.map(t => t.name)
            });
        }
        else {
            logger.info('✅ Email tools confirmed in planner tools');
        }
        return allTools;
    }
    getToolsByCategories(categories) {
        const filtered = [];
        categories.forEach(category => {
            const tools = this.toolConfigs[category];
            if (tools && Array.isArray(tools)) {
                filtered.push(...tools);
            }
            else {
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
    getToolInputSchema(toolName) {
        const tool = this.getToolDefinition(toolName);
        return tool?.parameters || null;
    }
    getToolDefinition(toolName) {
        return this.getAllTools().find(t => t.name === toolName);
    }
    getToolDisplayName(toolName) {
        const tool = this.getToolDefinition(toolName);
        return tool?.display_name || tool?.name || null;
    }
    getProviderConfigKeyForTool(toolName) {
        const tool = this.getToolDefinition(toolName);
        return tool?.providerConfigKey;
    }
    toolExists(toolName) {
        return this.getAllTools().some(t => t.name === toolName);
    }
    getAllTools() {
        const allTools = [];
        for (const tools of Object.values(this.toolConfigs)) {
            if (Array.isArray(tools)) {
                allTools.push(...tools);
            }
        }
        return allTools;
    }
    validateToolArgsWithZod(toolName, args) {
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
    findMissingRequiredParams(toolName, args) {
        const schema = this.getToolInputSchema(toolName);
        if (!schema || !schema.required)
            return [];
        return schema.required.filter(param => {
            const value = args[param];
            return value === undefined || value === null || value === '';
        });
    }
    findConditionallyMissingParams(toolName, args) {
        const schema = this.getToolInputSchema(toolName);
        if (!schema || !schema.properties)
            return [];
        const conditionallyMissing = [];
        for (const [paramName, paramDef] of Object.entries(schema.properties)) {
            if (schema.required?.includes(paramName))
                continue;
            if ((paramDef.prompt || paramDef.hint) && !args[paramName]) {
                conditionallyMissing.push(paramName);
            }
        }
        return conditionallyMissing;
    }
}
exports.ToolConfigManager = ToolConfigManager;
