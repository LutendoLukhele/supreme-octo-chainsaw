"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PlannerService = void 0;
const dedicatedPlannerPrompt_1 = require("./conversation/prompts/dedicatedPlannerPrompt");
const groq_sdk_1 = __importDefault(require("groq-sdk"));
const uuid_1 = require("uuid");
const winston_1 = __importDefault(require("winston"));
const events_1 = require("events");
const types_1 = require("./conversation/types");
const logger = winston_1.default.createLogger({
    level: 'info',
    format: winston_1.default.format.combine(winston_1.default.format.timestamp(), winston_1.default.format.json()),
    transports: [new winston_1.default.transports.Console()],
});
class PlannerService extends events_1.EventEmitter {
    constructor(groqApiKey, maxTokens, toolConfigManager, providerAwareFilter) {
        super();
        logger.info('PlannerService constructor called', {
            apiKeyProvided: !!groqApiKey,
            apiKeyLength: groqApiKey?.length || 0,
            apiKeyPrefix: groqApiKey?.substring(0, 10) || 'NONE',
            apiKeyType: typeof groqApiKey
        });
        if (!groqApiKey || groqApiKey.trim() === '') {
            throw new Error('GROQ_API_KEY is required but was not provided');
        }
        if (!groqApiKey.startsWith('gsk_')) {
            logger.error('Invalid Groq API key format - must start with gsk_', {
                receivedPrefix: groqApiKey.substring(0, 4)
            });
            throw new Error('Invalid Groq API key format - must start with gsk_');
        }
        this.groqClient = new groq_sdk_1.default({
            apiKey: groqApiKey.trim()
        });
        this.maxTokens = maxTokens;
        this.toolConfigManager = toolConfigManager;
        this.providerAwareFilter = providerAwareFilter;
        logger.info('PlannerService initialized with Groq', {
            model: PlannerService.MODEL,
            maxTokens,
            apiKeyValid: true
        });
    }
    async generatePlanWithStepAnnouncements(userInput, toolCalls, sessionId, messageId, userId) {
        const plan = await this.generatePlan(userInput, toolCalls, sessionId, messageId, userId);
        if (plan && plan.length > 0) {
            plan.forEach((step, index) => {
                step.stepNumber = index + 1;
                step.totalSteps = plan.length;
            });
            await this.streamPlanSummary(userInput, plan, sessionId);
        }
        return plan;
    }
    async streamPlanSummary(userInput, plan, sessionId) {
        const summaryMessageId = (0, uuid_1.v4)();
        const planDescriptions = plan.map(step => this.getToolFriendlyName(step.tool));
        const summaryPrompt = `Generate a brief, natural summary (max 30 words) of this execution plan.
User request: "${userInput}"
Actions to execute: ${planDescriptions.join(', ')}

Be specific but concise. Example: "I'll fetch your recent emails and then create a meeting with the team for tomorrow."`;
        try {
            this.emit('send_chunk', sessionId, {
                type: 'conversational_text_segment',
                content: { status: 'START_STREAM' },
                messageId: summaryMessageId,
                messageType: types_1.MessageType.PLAN_SUMMARY
            });
            const response = await this.groqClient.chat.completions.create({
                model: PlannerService.MODEL,
                messages: [{ role: 'system', content: summaryPrompt }],
                max_tokens: 100,
                stream: true,
                temperature: 0.5,
            });
            let fullSummary = '';
            for await (const chunk of response) {
                const content = chunk.choices[0]?.delta?.content;
                if (content) {
                    fullSummary += content;
                    this.emit('send_chunk', sessionId, {
                        type: 'conversational_text_segment',
                        content: {
                            status: 'STREAMING',
                            segment: { segment: content, styles: [], type: 'text' }
                        },
                        messageId: summaryMessageId,
                        messageType: types_1.MessageType.PLAN_SUMMARY
                    });
                }
            }
            this.emit('send_chunk', sessionId, {
                type: 'conversational_text_segment',
                content: { status: 'END_STREAM' },
                messageId: summaryMessageId,
                isFinal: true,
                messageType: types_1.MessageType.PLAN_SUMMARY
            });
            logger.info('Streamed plan summary', { sessionId, summary: fullSummary });
        }
        catch (error) {
            logger.error('Failed to generate plan summary', { error, sessionId });
        }
    }
    async streamStepAnnouncement(step, sessionId, placeholdersResolved = false) {
        const stepMessageId = (0, uuid_1.v4)();
        const totalSteps = step.totalSteps ?? 1;
        const stepPrefix = totalSteps > 1
            ? `Step ${step.stepNumber} of ${totalSteps}: `
            : '';
        const dataResolutionMessage = placeholdersResolved
            ? `I've used the results from the previous step to prepare the arguments. `
            : '';
        const announcementPrompt = `Generate a brief, specific action announcement (max 25 words).
${stepPrefix}Executing: ${step.tool}
${dataResolutionMessage}
Intent: ${step.intent}
Key parameters: ${JSON.stringify(step.arguments, null, 2).slice(0, 200)}

Be specific about what's being done.`;
        try {
            this.emit('send_chunk', sessionId, {
                type: 'conversational_text_segment',
                content: { status: 'START_STREAM' },
                messageId: stepMessageId,
                messageType: types_1.MessageType.STEP_ANNOUNCEMENT,
                metadata: { stepNumber: step.stepNumber, totalSteps: step.totalSteps }
            });
            const response = await this.groqClient.chat.completions.create({
                model: PlannerService.MODEL,
                messages: [{ role: 'system', content: announcementPrompt }],
                max_tokens: 80,
                stream: true,
                temperature: 0.5,
            });
            for await (const chunk of response) {
                const content = chunk.choices[0]?.delta?.content;
                if (content) {
                    this.emit('send_chunk', sessionId, {
                        type: 'conversational_text_segment',
                        content: {
                            status: 'STREAMING',
                            segment: { segment: content, styles: [], type: 'text' }
                        },
                        messageId: stepMessageId,
                        messageType: types_1.MessageType.STEP_ANNOUNCEMENT
                    });
                }
            }
            this.emit('send_chunk', sessionId, {
                type: 'conversational_text_segment',
                content: { status: 'END_STREAM' },
                messageId: stepMessageId,
                isFinal: true,
                messageType: types_1.MessageType.STEP_ANNOUNCEMENT
            });
        }
        catch (error) {
            logger.error('Failed to generate step announcement', { error, sessionId });
            const fallbackText = `${stepPrefix}Executing ${this.getToolFriendlyName(step.tool)}...`;
            this.streamSimpleMessage(sessionId, stepMessageId, fallbackText, types_1.MessageType.STEP_ANNOUNCEMENT);
        }
    }
    async streamStepCompletion(step, result, sessionId) {
        const completionMessageId = (0, uuid_1.v4)();
        const completionPrompt = `Generate a brief success confirmation (max 20 words) for this completed action:
Tool: ${step.tool}
Original intent: ${step.intent}
Result summary: ${JSON.stringify(result).slice(0, 300)}`;
        try {
            this.emit('send_chunk', sessionId, {
                type: 'conversational_text_segment',
                content: { status: 'START_STREAM' },
                messageId: completionMessageId,
                messageType: types_1.MessageType.STEP_COMPLETE
            });
            const response = await this.groqClient.chat.completions.create({
                model: PlannerService.MODEL,
                messages: [{ role: 'system', content: completionPrompt }],
                max_tokens: 60,
                stream: true,
                temperature: 0.5,
            });
            for await (const chunk of response) {
                const content = chunk.choices[0]?.delta?.content;
                if (content) {
                    this.emit('send_chunk', sessionId, {
                        type: 'conversational_text_segment',
                        content: {
                            status: 'STREAMING',
                            segment: { segment: content, styles: ['success'], type: 'text' }
                        },
                        messageId: completionMessageId,
                        messageType: types_1.MessageType.STEP_COMPLETE
                    });
                }
            }
            this.emit('send_chunk', sessionId, {
                type: 'conversational_text_segment',
                content: { status: 'END_STREAM' },
                messageId: completionMessageId,
                isFinal: true,
                messageType: types_1.MessageType.STEP_COMPLETE
            });
        }
        catch (error) {
            logger.error('Failed to generate completion message', { error, sessionId });
            const fallbackText = `✓ ${this.getToolFriendlyName(step.tool)} completed`;
            this.streamSimpleMessage(sessionId, completionMessageId, fallbackText, types_1.MessageType.STEP_COMPLETE);
        }
    }
    async streamSingleActionAnnouncement(step, sessionId) {
        const messageId = (0, uuid_1.v4)();
        const announcementPrompt = `Generate a brief, specific action announcement (max 25 words) for a single action.
Executing: ${step.tool}
Intent: ${step.intent}
Key parameters: ${JSON.stringify(step.arguments, null, 2).slice(0, 200)}

Be specific about what's being done. Example: "Okay, sending an email to John Doe."`;
        try {
            this.emit('send_chunk', sessionId, {
                type: 'conversational_text_segment',
                content: { status: 'START_STREAM' },
                messageId: messageId,
                messageType: types_1.MessageType.TOOL_EXECUTION,
            });
            const response = await this.groqClient.chat.completions.create({
                model: PlannerService.MODEL,
                messages: [{ role: 'system', content: announcementPrompt }],
                max_tokens: 80,
                stream: true,
                temperature: 0.5,
            });
            for await (const chunk of response) {
                const content = chunk.choices[0]?.delta?.content;
                if (content) {
                    this.emit('send_chunk', sessionId, {
                        type: 'conversational_text_segment',
                        content: {
                            status: 'STREAMING',
                            segment: { segment: content, styles: [], type: 'text' }
                        },
                        messageId: messageId,
                        messageType: types_1.MessageType.TOOL_EXECUTION
                    });
                }
            }
            this.emit('send_chunk', sessionId, {
                type: 'conversational_text_segment',
                content: { status: 'END_STREAM' },
                messageId: messageId,
                isFinal: true,
                messageType: types_1.MessageType.TOOL_EXECUTION
            });
        }
        catch (error) {
            logger.error('Failed to generate single action announcement', { error, sessionId });
            const fallbackText = `Executing ${this.getToolFriendlyName(step.tool)}...`;
            this.streamSimpleMessage(sessionId, messageId, fallbackText, types_1.MessageType.TOOL_EXECUTION);
        }
    }
    streamSimpleMessage(sessionId, messageId, text, messageType) {
        this.emit('send_chunk', sessionId, {
            type: 'conversational_text_segment',
            content: { status: 'START_STREAM' },
            messageId,
            messageType
        });
        this.emit('send_chunk', sessionId, {
            type: 'conversational_text_segment',
            content: { status: 'STREAMING', segment: { segment: text, styles: [], type: 'text' } },
            messageId,
            messageType
        });
        this.emit('send_chunk', sessionId, {
            type: 'conversational_text_segment',
            content: { status: 'END_STREAM' },
            messageId,
            isFinal: true,
            messageType
        });
    }
    getToolFriendlyName(toolName) {
        const friendlyNames = {
            'fetch_emails': 'email fetching',
            'sendEmail': 'email sending',
            'createCalendarEvent': 'calendar event creation',
            'updateSalesforceContact': 'Salesforce update',
            'searchContacts': 'contact search',
        };
        return friendlyNames[toolName] || toolName.replace(/_/g, ' ');
    }
    async generatePlan(userInput, identifiedToolCalls, sessionId, clientMessageId, userId) {
        logger.info('PlannerService: Generating action plan using structured output', {
            sessionId,
            userId,
            userInputLength: userInput.length,
            numIdentifiedTools: identifiedToolCalls.length,
            identifiedToolNames: identifiedToolCalls.map(tc => tc.name)
        });
        const plannerStatus = {
            type: 'planner_status',
            content: 'Analyzing your request...',
            messageId: clientMessageId,
            streamType: 'planner_feedback',
            isFinal: true,
        };
        this.emit('send_chunk', sessionId, plannerStatus);
        let availableTools;
        if (this.providerAwareFilter && userId) {
            logger.info('PlannerService: Using provider-aware tool filtering', { userId });
            const filteredTools = await this.providerAwareFilter.getAvailableToolsForUser(userId);
            availableTools = filteredTools.map(tool => ({
                name: tool.name,
                description: tool.description,
                category: tool.category,
                parameters: tool.parameters
            }));
        }
        else {
            logger.warn('PlannerService: Provider-aware filtering not available, using all tools');
            availableTools = this.toolConfigManager.getToolDefinitionsForPlanner();
        }
        const toolDefinitionsJson = JSON.stringify(availableTools, null, 2);
        let identifiedToolsPromptSection = "No tools pre-identified.";
        if (identifiedToolCalls.length > 0) {
            identifiedToolsPromptSection = "The following tool calls were preliminarily identified:\n";
            identifiedToolCalls.forEach(tc => {
                identifiedToolsPromptSection += `- Tool: ${tc.name}, Arguments: ${JSON.stringify(tc.arguments)}\n`;
            });
        }
        const systemPromptContent = dedicatedPlannerPrompt_1.DEDICATED_PLANNER_SYSTEM_PROMPT_TEMPLATE
            .replace('{{USER_CURRENT_MESSAGE}}', userInput)
            .replace('{{TOOL_DEFINITIONS_JSON}}', toolDefinitionsJson)
            .replace('{{PRE_IDENTIFIED_TOOLS_SECTION}}', identifiedToolsPromptSection);
        logger.info('PlannerService: Constructed system prompt for planner', {
            sessionId,
            availableToolNames: availableTools.map(t => t.name),
        });
        const messagesForApi = [
            { role: 'system', content: systemPromptContent },
            { role: 'user', content: userInput }
        ];
        try {
            const response = await this.groqClient.chat.completions.create({
                model: PlannerService.MODEL,
                messages: messagesForApi,
                max_tokens: this.maxTokens,
                temperature: 0.1,
                response_format: { type: "json_object" },
            });
            const content = response.choices[0]?.message?.content;
            if (!content) {
                logger.error('PlannerService: No content from planning LLM', { sessionId });
                throw new Error('No content from planning LLM');
            }
            const responseObject = JSON.parse(content);
            logger.info('PlannerService: Raw plan from LLM', {
                sessionId,
                planObject: JSON.stringify(responseObject, null, 2)
            });
            if (!responseObject.plan || !Array.isArray(responseObject.plan)) {
                logger.error('PlannerService: Invalid response format from structured output', {
                    sessionId,
                    responseObject: JSON.stringify(responseObject)
                });
                throw new Error('Planner LLM response is not in the expected format despite using json_schema.');
            }
            const availableToolNames = new Set(availableTools.map(t => t.name));
            const invalidTools = [];
            responseObject.plan.forEach((item, idx) => {
                if (!availableToolNames.has(item.tool)) {
                    invalidTools.push(item.tool);
                    logger.error('PlannerService: Invalid tool in plan', {
                        sessionId,
                        stepNumber: idx + 1,
                        invalidTool: item.tool,
                        availableTools: Array.from(availableToolNames)
                    });
                }
            });
            if (invalidTools.length > 0) {
                const errorMsg = `Plan contains invalid tools: ${invalidTools.join(', ')}. Available tools: ${Array.from(availableToolNames).join(', ')}`;
                logger.error('PlannerService: Plan validation failed', {
                    sessionId,
                    invalidTools,
                    availableTools: Array.from(availableToolNames)
                });
                throw new Error(errorMsg);
            }
            const actionPlan = responseObject.plan.map((item, idx) => {
                const actionId = item.id || (0, uuid_1.v4)();
                logger.info('PlannerService: Creating action step', {
                    sessionId,
                    stepNumber: idx + 1,
                    actionId,
                    tool: item.tool,
                    intent: item.intent,
                    arguments: item.arguments
                });
                return {
                    id: actionId,
                    intent: item.intent,
                    tool: item.tool,
                    arguments: item.arguments || {},
                    status: 'ready',
                    stepNumber: idx + 1,
                    totalSteps: responseObject.plan.length
                };
            });
            try {
                console.log("🔥 PLANNER_CREATED_STEP:", JSON.stringify(actionPlan, null, 2));
            }
            catch (e) {
                console.log("🔥 PLANNER_CREATED_STEP (raw):", actionPlan);
            }
            logger.info('PlannerService: Complete plan with validated tools', {
                sessionId,
                planLength: actionPlan.length,
                actionIds: actionPlan.map(step => ({ id: step.id, tool: step.tool })),
            });
            this.emit('send_chunk', sessionId, {
                type: 'plan_generated',
                messageId: clientMessageId,
                content: {
                    summary: `Plan contains ${actionPlan.length} actions.`,
                    steps: actionPlan
                },
                streamType: 'planner_feedback',
                isFinal: true
            });
            return actionPlan;
        }
        catch (error) {
            logger.error('PlannerService: Error generating action plan', {
                error: error.message,
                errorStack: error.stack,
                sessionId
            });
            return [];
        }
    }
}
exports.PlannerService = PlannerService;
PlannerService.MODEL = 'llama-3.3-70b-versatile';
