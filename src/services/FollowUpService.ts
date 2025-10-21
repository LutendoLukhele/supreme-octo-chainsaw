// src/services/FollowUpService.ts

import Groq from 'groq-sdk';
import winston from 'winston';
import { FOLLOW_UP_PROMPT_TEMPLATE } from './followUpPrompt';
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
        private maxTokens: number
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
  const toolResultJson = JSON.stringify(data, null, 2);

  // 2. Construct a prompt for the LLM.
  // Using the more detailed prompt template to get a better summary.
  const prompt = FOLLOW_UP_PROMPT_TEMPLATE
    .replace('{{USER_INITIAL_QUERY}}', run.userInput)
    .replace('{{PREVIOUS_TOOL_RESULT_JSON}}', toolResultJson)
    // For now, we are only generating a summary, so we provide dummy data for the next tool.
    .replace('{{NEXT_TOOL_NAME}}', "n/a")
    .replace('{{NEXT_TOOL_DESCRIPTION}}', "Not applicable for this step.")
    .replace('{{NEXT_TOOL_PARAMETERS_JSON}}', "{}");

  // 3. Call the LLM to generate the conversational response.
  try {
    const chatCompletion = await this.client.chat.completions.create({
        messages: [{ role: 'user', content: prompt }],
        model: this.model,
        response_format: { type: "json_object" },
        max_tokens: this.maxTokens,
    });
    
    const responseContent = chatCompletion.choices[0]?.message?.content;
    if (!responseContent) return { summary: "The action was successful.", nextToolCall: null };

    const parsedResponse = JSON.parse(responseContent);
    const summary = parsedResponse.summary || "The action completed successfully.";
    return { summary, nextToolCall: null }; // nextToolCall can be implemented later

  } catch (error) {
    logger.error('Failed to generate AI follow-up from Groq.', { error });
    // Fallback to a simple summary if the AI call fails
    return { summary: `The action '${toolName}' completed successfully.`, nextToolCall: null };
  }
}
}