"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PlannerService = void 0;
const events_1 = require("events");
const openai_1 = __importDefault(require("openai"));
const winston_1 = __importDefault(require("winston"));
const dedicatedPlannerPrompt_1 = require("./conversation/prompts/dedicatedPlannerPrompt");
const logger = winston_1.default.createLogger({
    level: 'info',
    format: winston_1.default.format.combine(winston_1.default.format.timestamp(), winston_1.default.format.json()),
    transports: [new winston_1.default.transports.Console()],
});
class PlannerService extends events_1.EventEmitter {
    constructor(openAIApiKey, model, maxTokens, toolConfigManager) {
        super();
        this.client = new openai_1.default({ apiKey: openAIApiKey });
        this.model = model;
        this.maxTokens = maxTokens;
        this.toolConfigManager = toolConfigManager;
        logger.info('PlannerService initialized with self-managed OpenAI client.');
    }
    async generatePlan(userInput, identifiedToolCalls, sessionId, clientMessageId) {
        logger.info('PlannerService: Generating action plan', {
            sessionId,
            userInputLength: userInput.length,
            numIdentifiedTools: identifiedToolCalls.length,
            identifiedToolNames: identifiedToolCalls.map(tc => tc.name)
        });
        this.emit('send_chunk', sessionId, {
            type: 'planner_status',
            content: 'Formulating a detailed plan...',
            messageId: clientMessageId,
            streamType: 'planner_feedback',
            isFinal: true
        });
        const availableTools = this.toolConfigManager.getToolDefinitionsForPlanner();
        const toolDefinitionsJson = JSON.stringify(availableTools, null, 2);
        let identifiedToolsPromptSection = "No tools pre-identified.";
        if (identifiedToolCalls.length > 0) {
            identifiedToolsPromptSection = "The following tool calls were preliminarily identified (you should verify and integrate them into a coherent plan):\n";
            identifiedToolCalls.forEach(tc => {
                identifiedToolsPromptSection += `- Tool: ${tc.name}, Arguments: ${JSON.stringify(tc.arguments)}\n`;
            });
        }
        const systemPromptContent = dedicatedPlannerPrompt_1.DEDICATED_PLANNER_SYSTEM_PROMPT_TEMPLATE
            .replace('{{USER_CURRENT_MESSAGE}}', userInput)
            .replace('{{TOOL_DEFINITIONS_JSON}}', toolDefinitionsJson)
            .replace('{{PRE_IDENTIFIED_TOOLS_SECTION}}', identifiedToolsPromptSection);
        const messagesForApi = [
            { role: 'system', content: systemPromptContent },
        ];
        let accumulatedContent = "";
        try {
            const responseStream = await this.client.chat.completions.create({
                model: 'gpt-4.1-nano-2025-04-14',
                messages: messagesForApi,
                max_tokens: this.maxTokens,
                temperature: 0.1,
                response_format: { type: "json_object" },
                stream: true,
            });
            for await (const chunk of responseStream) {
                const contentDelta = chunk.choices[0]?.delta?.content;
                if (contentDelta) {
                    accumulatedContent += contentDelta;
                }
                const finishReason = chunk.choices[0]?.finish_reason;
                if (finishReason) {
                    logger.info(`Planner LLM stream finished. Reason: ${finishReason}`, { sessionId, finishReason });
                    break;
                }
            }
            if (!accumulatedContent) {
                logger.error('PlannerService: No content from planning LLM', { sessionId });
                throw new Error('No content from planning LLM');
            }
            const responseObject = JSON.parse(accumulatedContent);
            if (!responseObject.plan || !Array.isArray(responseObject.plan)) {
                logger.error('PlannerService: LLM response is not in the expected format { "plan": [...] }', { sessionId, response: accumulatedContent });
                throw new Error('Planner LLM response is not in the expected format.');
            }
            const actionPlan = responseObject.plan;
            logger.info(`PlannerService: Plan generated with ${actionPlan.length} actions.`, {
                sessionId,
                generatedPlan: JSON.stringify(actionPlan, null, 2)
            });
            return actionPlan;
        }
        catch (error) {
            logger.error('PlannerService: Error generating action plan', { error: error.message, sessionId });
            return [];
        }
    }
    emit(event, ...args) {
        return super.emit(event, ...args);
    }
    on(event, listener) {
        return super.on(event, listener);
    }
}
exports.PlannerService = PlannerService;
