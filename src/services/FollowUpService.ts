// src/services/FollowUpService.ts

import Groq from 'groq-sdk';
import winston from 'winston';
import { FOLLOW_UP_PROMPT_TEMPLATE } from './followUpPrompt';
import { ToolCall } from './tool/tool.types';
import { Run, ToolExecutionStep } from './tool/run.types';
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
    nextStep: ToolExecutionStep
  ): Promise<{ summary: string | null; nextToolCall: ToolCall | null }> {
    const lastCompletedStep = [...run.toolExecutionPlan].reverse().find(s => s.status === 'completed');
    if (!lastCompletedStep || !lastCompletedStep.result) {
      logger.warn('FollowUpService: Could not find a last completed step with a result.', { runId: run.id });
      return { summary: null, nextToolCall: null };
    }

    const toolResultJson = JSON.stringify(lastCompletedStep.result.data, null, 2);
    const nextToolName = nextStep.toolCall.name;
    // Assuming ToolConfigManager is available or we can get the schema from the step
    // For this example, we'll pass a simplified schema. A real implementation would fetch this.
    const nextToolParams = JSON.stringify(nextStep.toolCall.arguments, null, 2); // Placeholder for actual schema

    // 2. Construct a prompt for the LLM.
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
      if (!responseContent) {
        logger.warn('FollowUpService: LLM returned no content.', { runId: run.id });
        return { summary: "The action was successful.", nextToolCall: null };
      }

      const parsedResponse = JSON.parse(responseContent);
      const summary = parsedResponse.summary || null;
      const nextToolCallArgs = parsedResponse.nextToolCallArgs || null;

      const nextToolCall: ToolCall | null = nextToolCallArgs ? { ...nextStep.toolCall, arguments: nextToolCallArgs } : null;

      return { summary, nextToolCall };
    } catch (error) {
      logger.error('Failed to generate AI follow-up from Groq.', { error });
      return { summary: `The action '${lastCompletedStep.result.toolName}' completed successfully.`, nextToolCall: null };
    }
  }
}
