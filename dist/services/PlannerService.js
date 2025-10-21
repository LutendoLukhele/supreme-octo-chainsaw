"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PlannerService = void 0;
const openai_1 = require("openai");
const uuid_1 = require("uuid");
const winston_1 = __importDefault(require("winston"));
const events_1 = require("events");
const types_1 = require("./conversation/types");
const dedicatedPlannerPrompt_1 = require("./conversation/prompts/dedicatedPlannerPrompt");
const logger = winston_1.default.createLogger({
    level: 'info',
    format: winston_1.default.format.combine(winston_1.default.format.timestamp(), winston_1.default.format.json()),
    transports: [new winston_1.default.transports.Console()],
});
class PlannerService extends events_1.EventEmitter {
    constructor(openaiApiKey, maxTokens, toolConfigManager) {
        super();
        this.openaiClient = new openai_1.OpenAI({ apiKey: openaiApiKey });
        this.maxTokens = maxTokens;
        this.toolConfigManager = toolConfigManager;
    }
    async generatePlanWithStepAnnouncements(userInput, toolCalls, sessionId, messageId) {
        const plan = await this.generatePlan(userInput, toolCalls, sessionId, messageId);
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
            const response = await this.openaiClient.chat.completions.create({
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
    async streamStepAnnouncement(step, sessionId) {
        const stepMessageId = (0, uuid_1.v4)();
        const totalSteps = step.totalSteps ?? 1;
        const stepPrefix = totalSteps > 1
            ? `Step ${step.stepNumber} of ${totalSteps}: `
            : '';
        const announcementPrompt = `Generate a brief, specific action announcement (max 25 words).
${stepPrefix}Executing: ${step.tool}
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
            const response = await this.openaiClient.chat.completions.create({
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
        const plannerStatus = {
            type: 'planner_status',
            content: `${stepPrefix}Executing ${this.getToolFriendlyName(step.tool)}...`,
            messageId: stepMessageId,
            streamType: 'planner_feedback',
            isFinal: true,
        };
        return plannerStatus;
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
            const response = await this.openaiClient.chat.completions.create({
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
    async generatePlan(userInput, identifiedToolCalls, sessionId, clientMessageId) {
        logger.info('PlannerService: Generating action plan', {
            sessionId,
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
        const availableTools = this.toolConfigManager.getToolDefinitionsForPlanner();
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
        const messagesForApi = [
            { role: 'system', content: systemPromptContent }
        ];
        let accumulatedContent = "";
        try {
            const responseStream = await this.openaiClient.chat.completions.create({
                model: PlannerService.MODEL,
                messages: messagesForApi,
                max_tokens: this.maxTokens,
                temperature: 0.1,
                response_format: { type: "json_object" },
                stream: true,
            });
            for await (const chunk of responseStream) {
                const contentDelta = chunk.choices[0]?.delta?.content;
                if (contentDelta)
                    accumulatedContent += contentDelta;
                if (chunk.choices[0]?.finish_reason)
                    break;
            }
            if (!accumulatedContent) {
                logger.error('PlannerService: No content from planning LLM', { sessionId });
                throw new Error('No content from planning LLM');
            }
            const responseObject = JSON.parse(accumulatedContent);
            if (!responseObject.plan || !Array.isArray(responseObject.plan)) {
                logger.error('PlannerService: Invalid response format', {
                    sessionId,
                    responseObject: JSON.stringify(responseObject)
                });
                throw new Error('Planner LLM response is not in the expected format.');
            }
            const actionPlan = responseObject.plan.map((item, idx) => {
                const actionId = (0, uuid_1.v4)();
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
            logger.info('PlannerService: Complete plan with all IDs', {
                sessionId,
                planLength: actionPlan.length,
                actionIds: actionPlan.map(step => ({ id: step.id, tool: step.tool })),
                fullPlan: JSON.stringify(actionPlan, null, 2)
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
                accumulatedContent: accumulatedContent?.substring(0, 1000),
                sessionId
            });
            return [];
        }
    }
}
exports.PlannerService = PlannerService;
PlannerService.MODEL = 'gpt-4o-mini';
