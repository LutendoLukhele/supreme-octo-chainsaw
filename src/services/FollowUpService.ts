// src/services/FollowUpService.ts

import Groq from 'groq-sdk';
import winston from 'winston';
import { FOLLOW_UP_PROMPT_TEMPLATE } from './followUpPrompt';
import { ToolConfigManager } from './tool/ToolConfigManager';
import { ToolCall } from './tool/tool.types';
import { Run } from './tool/run.types';
import { ActiveAction } from '../action-launcher.service';

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
    transports: [new winston.transports.Console()],
});

export class FollowUpService {
  groqClient: any;
    constructor(
        private client: Groq,
        private model: string,
        private maxTokens: number,
        private toolConfigManager: ToolConfigManager
    ) {}

    /**
     * Analyzes the result of a completed action to generate a conversational summary
     * and intelligently pre-fill the arguments for the next action in a plan.
     */
  public async generateFollowUp(
  run: Run,
  sessionId: string,
  messageId: string
): Promise<{ summary: string | null; nextToolCall: ToolCall | null; }> {
  
  const lastStep = run.toolExecutionPlan[run.toolExecutionPlan.length - 1];
  if (!lastStep || lastStep.status !== 'completed' || !lastStep.result) {
    return { summary: null, nextToolCall: null };
  }

  const { toolName, data } = lastStep.result;
  
  // --- START OF ENHANCED LOGIC ---

  // 1. Create a summary of the tool's output for the AI.
  let toolOutputSummary = `The action '${toolName}' completed successfully.`;
  if (toolName === 'fetch_emails' && data?.emails) {
    const emailCount = data.emails.length;
    const firstEmailSubject = emailCount > 0 ? data.emails[0].subject : 'N/A';
    toolOutputSummary = `I just ran the 'fetch_emails' tool and found ${emailCount} emails. The subject of the most recent email is "${firstEmailSubject}".`;
  } else if (toolName === 'fetch_entity' && data?.data?.records) {
    const recordCount = data.data.records.length;
    const firstRecordName = recordCount > 0 ? data.data.records[0].name : 'N/A';
    toolOutputSummary = `I just ran the 'fetch_entity' tool and found ${recordCount} records. The first record is named "${firstRecordName}".`;
  }

  // 2. Construct a prompt for the LLM.
  const prompt = `
    You are an AI assistant. A tool has just been successfully executed on your behalf.
    The user's original request was: "${run.userInput}"
    Tool Execution Result: "${toolOutputSummary}"
    
    Based on this, formulate a brief, natural, and helpful follow-up message for the user.
    Summarize what you found and ask what they would like to do next with the information.
    Do not mention that a "tool" was run. Just speak naturally.
  `;

  // 3. Call the LLM to generate the conversational response.
  try {
    const chatCompletion = await this.client.chat.completions.create({
        messages: [{ role: 'user', content: prompt }],
        model: this.model,
        max_tokens: this.maxTokens,
    });
    
    const summary = chatCompletion.choices[0]?.message?.content || null;
    return { summary, nextToolCall: null };

  } catch (error) {
    logger.error('Failed to generate AI follow-up from Groq.', { error });
    // Fallback to the simple summary if the AI call fails
    return { summary: toolOutputSummary, nextToolCall: null };
  }
}
}