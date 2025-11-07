"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.FollowUpService = void 0;
const winston_1 = __importDefault(require("winston"));
const followUpPrompt_1 = require("./followUpPrompt");
const ToolConfigManager_1 = require("./tool/ToolConfigManager");
const logger = winston_1.default.createLogger({
    level: 'info',
    format: winston_1.default.format.combine(winston_1.default.format.timestamp(), winston_1.default.format.json()),
    transports: [new winston_1.default.transports.Console()],
});
class FollowUpService {
    constructor(client, model, maxTokens) {
        this.client = client;
        this.model = model;
        this.maxTokens = maxTokens;
        this.toolConfigManager = new ToolConfigManager_1.ToolConfigManager();
    }
    async generateFollowUp(run, nextStep) {
        const lastCompletedStep = [...run.toolExecutionPlan].reverse().find(s => s.status === 'completed');
        if (!lastCompletedStep || !lastCompletedStep.result) {
            logger.warn('FollowUpService: Could not find a last completed step with a result.', { runId: run.id });
            return { summary: null, nextToolCall: null };
        }
        const toolResultJson = JSON.stringify(lastCompletedStep.result.data, null, 2);
        const nextToolName = nextStep.toolCall.name;
        const nextToolSchema = this.toolConfigManager.getToolInputSchema(nextToolName);
        const nextToolDescription = this.toolConfigManager.getToolDefinition(nextToolName)?.description || 'No description available.';
        const prompt = followUpPrompt_1.FOLLOW_UP_PROMPT_TEMPLATE
            .replace('{{USER_INITIAL_QUERY}}', run.userInput)
            .replace('{{PREVIOUS_TOOL_RESULT_JSON}}', toolResultJson)
            .replace('{{NEXT_TOOL_NAME}}', nextToolName)
            .replace('{{NEXT_TOOL_DESCRIPTION}}', nextToolDescription)
            .replace('{{NEXT_TOOL_PARAMETERS_JSON}}', JSON.stringify(nextToolSchema, null, 2));
        try {
            const chatCompletion = await this.client.chat.completions.create({
                messages: [{ role: 'user', content: prompt }],
                model: this.model,
                response_format: { type: "json_object" },
                max_tokens: this.maxTokens,
            });
            const responseContent = chatCompletion.choices[0]?.message?.content;
            if (!responseContent) {
                logger.warn('FollowUpService: LLM returned no content.', { runId: run.id });
                return { summary: "The action was successful.", nextToolCall: null };
            }
            const parsedResponse = JSON.parse(responseContent);
            const summary = parsedResponse.summary || null;
            const nextToolCallArgs = parsedResponse.nextToolCallArgs || null;
            const nextToolCall = nextToolCallArgs ? { ...nextStep.toolCall, arguments: nextToolCallArgs } : null;
            return { summary, nextToolCall };
        }
        catch (error) {
            logger.error('Failed to generate AI follow-up from Groq.', { error });
            return { summary: `The action '${lastCompletedStep.result.toolName}' completed successfully.`, nextToolCall: null };
        }
    }
}
exports.FollowUpService = FollowUpService;
