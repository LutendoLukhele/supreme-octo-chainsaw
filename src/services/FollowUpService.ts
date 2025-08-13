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
        sessionId: string,
        run: Run,
        completedAction: ActiveAction
    ): Promise<{ summary: string | null; nextToolCall: ToolCall | null }> {
        
        const currentActionIndex = run.tools.findIndex(t => t.toolCall.id === completedAction.id);
        const nextToolInPlan = run.tools[currentActionIndex + 1];

        if (!nextToolInPlan) {
            return { summary: "All steps in the plan are complete!", nextToolCall: null };
        }

        const nextToolDef = this.toolConfigManager.getToolDefinition(nextToolInPlan.toolCall.name);
        if (!nextToolDef) {
            logger.warn(`FollowUpService: Could not find definition for next tool '${nextToolInPlan.toolCall.name}'.`, { sessionId });
            return { summary: null, nextToolCall: null };
        }

        // --- FIX: Add a null check for run.userInput before calling .replace() ---
        const userInput = run.userInput || ''; // Default to an empty string if undefined

        const prompt = FOLLOW_UP_PROMPT_TEMPLATE
            .replace('{{USER_INITIAL_QUERY}}', userInput)
            .replace('{{PREVIOUS_TOOL_RESULT_JSON}}', JSON.stringify(completedAction.result, null, 2))
            .replace('{{NEXT_TOOL_NAME}}', nextToolDef.name)
            .replace('{{NEXT_TOOL_DESCRIPTION}}', nextToolDef.description)
            .replace('{{NEXT_TOOL_PARAMETERS_JSON}}', JSON.stringify(nextToolDef.parameters, null, 2));

        try {
            const response = await this.client.chat.completions.create({
                model: this.model,
                messages: [{ role: 'system', content: prompt }],
                max_tokens: this.maxTokens,
                temperature: 0.3,
                response_format: { type: "json_object" },
            });

            const responseObject = JSON.parse(response.choices[0]?.message?.content || '{}');
            
            const summary = responseObject.summary || null;
            const generatedArgs = responseObject.nextToolCallArgs || {};
            
            const nextToolCall: ToolCall = {
                id: nextToolInPlan.toolCall.id,
                name: nextToolInPlan.toolCall.name,
                arguments: generatedArgs,

                sessionId: '',
                userId: ''
            };

            return { summary, nextToolCall };

        } catch (error: any) {
            logger.error('Error in FollowUpService generating next step', { error: error.message });
            return { summary: "I encountered an issue while preparing the next step.", nextToolCall: null };
        }
    }
}