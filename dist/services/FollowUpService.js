"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.FollowUpService = void 0;
const winston_1 = __importDefault(require("winston"));
const logger = winston_1.default.createLogger({
    level: 'info',
    format: winston_1.default.format.combine(winston_1.default.format.timestamp(), winston_1.default.format.json()),
    transports: [new winston_1.default.transports.Console()],
});
class FollowUpService {
    constructor(client, model, maxTokens, toolConfigManager) {
        this.client = client;
        this.model = model;
        this.maxTokens = maxTokens;
        this.toolConfigManager = toolConfigManager;
    }
    async generateFollowUp(run, sessionId, messageId) {
        const lastStep = run.toolExecutionPlan[run.toolExecutionPlan.length - 1];
        if (!lastStep || lastStep.status !== 'completed' || !lastStep.result) {
            return { summary: null, nextToolCall: null };
        }
        const { toolName, data } = lastStep.result;
        let toolOutputSummary = `The action '${toolName}' completed successfully.`;
        if (toolName === 'fetch_emails' && data?.emails) {
            const emailCount = data.emails.length;
            const firstEmailSubject = emailCount > 0 ? data.emails[0].subject : 'N/A';
            toolOutputSummary = `I just ran the 'fetch_emails' tool and found ${emailCount} emails. The subject of the most recent email is "${firstEmailSubject}".`;
        }
        else if (toolName === 'fetch_entity' && data?.data?.records) {
            const recordCount = data.data.records.length;
            const firstRecordName = recordCount > 0 ? data.data.records[0].name : 'N/A';
            toolOutputSummary = `I just ran the 'fetch_entity' tool and found ${recordCount} records. The first record is named "${firstRecordName}".`;
        }
        const prompt = `
    You are an AI assistant. A tool has just been successfully executed on your behalf.
    The user's original request was: "${run.userInput}"
    Tool Execution Result: "${toolOutputSummary}"
    
    Based on this, formulate a brief, natural, and helpful follow-up message for the user.
    Summarize what you found and ask what they would like to do next with the information.
    Do not mention that a "tool" was run. Just speak naturally.
  `;
        try {
            const chatCompletion = await this.client.chat.completions.create({
                messages: [{ role: 'user', content: prompt }],
                model: this.model,
                max_tokens: this.maxTokens,
            });
            const summary = chatCompletion.choices[0]?.message?.content || null;
            return { summary, nextToolCall: null };
        }
        catch (error) {
            logger.error('Failed to generate AI follow-up from Groq.', { error });
            return { summary: toolOutputSummary, nextToolCall: null };
        }
    }
}
exports.FollowUpService = FollowUpService;
