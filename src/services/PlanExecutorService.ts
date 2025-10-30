
import { ToolConfigManager } from './tool/ToolConfigManager';
import winston from 'winston';
import { ActionLauncherService } from '../action-launcher.service';
import { StreamManager } from './stream/StreamManager';
import { ToolOrchestrator } from './tool/ToolOrchestrator';
import { Run, ToolExecutionStep } from './tool/run.types';
import Groq from 'groq-sdk';
import { ActionStep, PlannerService } from './PlannerService';
import { FollowUpService } from './FollowUpService';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [new winston.transports.Console()],
});

export class PlanExecutorService {
  constructor(
    private actionLauncherService: ActionLauncherService,
    private toolOrchestrator: ToolOrchestrator,
    private streamManager: StreamManager,
    private toolConfigManager: ToolConfigManager,
    private groqClient: Groq,
    private plannerService: PlannerService, // Add PlannerService
    private followUpService: FollowUpService
  ) {}

  private _get(obj: any, path: string, defaultValue: any = undefined) {
    const pathArray = path.replace(/\[(\w+)\]/g, '.$1').replace(/^\./, '').split('.');
    let current = obj;
    for (let i = 0; i < pathArray.length; i++) {
      const key = pathArray[i];
      if (current === null || current === undefined) {
        return defaultValue;
      }
      current = current[key];
    }
    return current === undefined ? defaultValue : current;
  }

  private _resolvePlaceholders(args: any, run: Run): { resolvedArgs: any, placeholdersResolved: boolean } {
    const resolvedArgs = JSON.parse(JSON.stringify(args)); // Deep copy
    let placeholdersResolved = false;

    const replacer = (obj: any) => {
      for (const key in obj) {
        if (typeof obj[key] === 'string') {
          const originalString = obj[key];
          const match = originalString.match(/^{{(.+?)}}$/);          

          if (match) {
            // Handle full string replacement
            const placeholder = match[1];
            const [stepId, ...pathParts] = placeholder.split('.');
            
            if (pathParts[0] === 'result') {
              pathParts.shift();
            }
            const path = pathParts.join('.');
            const sourceStep = run.toolExecutionPlan.find(s => s.stepId === stepId);

            if (sourceStep && sourceStep.result) {
              // Assuming the path in the placeholder is relative to the 'data' property of the result.
              const value = this._get(sourceStep.result.data, path);
              if (value !== undefined) {
                obj[key] = value;
                placeholdersResolved = true;
              } else {
                logger.warn(`Could not resolve placeholder: ${originalString}. Path '${path}' not found in step ${stepId}.`, { runId: run.id });
              }
            } else {
              logger.warn(`Could not resolve placeholder: ${originalString}. Step not found.`, { runId: run.id });
            }
          } else {
            // Handle partial string replacement
            obj[key] = originalString.replace(/{{(.+?)}}/g, (match: string, placeholder: string) => {
              const [stepId, ...pathParts] = placeholder.split('.');
              
              if (pathParts[0] === 'result') {
                pathParts.shift();
              }
              const path = pathParts.join('.');
              const sourceStep = run.toolExecutionPlan.find(s => s.stepId === stepId);

              if (sourceStep && sourceStep.result) {
                const value = this._get(sourceStep.result.data, path);
                if (value !== undefined) {
                  placeholdersResolved = true;
                  return String(value);
                } else {
                  logger.warn(`Could not resolve placeholder: ${match}. Path '${path}' not found in step ${stepId}.`, { runId: run.id });
                  return match;
                }
              } else {
                logger.warn(`Could not resolve placeholder: ${match}. Step not found.`, { runId: run.id });
                return match;
              }
            });
          }
        } else if (typeof obj[key] === 'object' && obj[key] !== null) {
          replacer(obj[key]);
        }
      }
    };

    replacer(resolvedArgs);
    return { resolvedArgs, placeholdersResolved };
  }

  private async _fixArgumentsWithLlm(
    currentStep: ToolExecutionStep,
    run: Run,
    invalidArgs: Record<string, any>,
    validationError: string
  ): Promise<Record<string, any>> {
    const toolName = currentStep.toolCall.name;
    logger.info('Attempting to fix arguments with LLM using previous step context.', { toolName, validationError });
    const toolSchema = this.toolConfigManager.getToolInputSchema(toolName);
    if (!toolSchema) {
      throw new Error(`Cannot fix arguments: No schema found for tool ${toolName}`);
    }

    // Find the previous step to provide its result as context
    const currentStepIndex = run.toolExecutionPlan.findIndex(s => s.stepId === currentStep.stepId);
    const previousStep = currentStepIndex > 0 ? run.toolExecutionPlan[currentStepIndex - 1] : null;

    let previousStepResultJson = "No previous step result available. You must infer missing arguments from the user's original request.";
    if (previousStep && previousStep.status === 'completed' && previousStep.result) {
        previousStepResultJson = JSON.stringify(previousStep.result.data, null, 2);
    }

    const systemPrompt = `You are an expert AI agent data resolver. A tool call is about to fail because its arguments are invalid or missing required data. Your task is to fix them.

**User's Original Request:**
${run.userInput}

Tool Name: ${toolName}
Tool Schema:
${JSON.stringify(toolSchema, null, 2)}

**Previous Step's Result (JSON Data):**
${previousStepResultJson}

**Current Invalid Arguments:**
${JSON.stringify(invalidArgs, null, 2)}

**Validation Error Message:**
${validationError}

Instructions:
1.  **Analyze the Goal**: Understand the user's original request.
2.  **Analyze the Error**: The "Validation Error" tells you exactly what's wrong (e.g., 'to' is required, 'id' must be a number).
3.  **Find the Missing Data**: Look at the "Previous Step's Result". This JSON contains the data needed to fix the error. For example, if the 'to' address is missing for 'send_email', find the sender's email address from the 'fetch_emails' result.
4.  **Construct the Final Arguments**: Create a complete, valid JSON object for the arguments. Combine the valid arguments from "Current Invalid Arguments" with the missing data you found.
5.  **Output ONLY the corrected JSON object.** Do not include any other text, explanations, or markdown. Your entire response must be the valid JSON.`;

    try {
      const response = await this.groqClient.chat.completions.create({
        model: 'llama-3.3-70b-versatilef', // A more capable model for reasoning
        messages: [{ role: 'system', content: systemPrompt }],
        max_tokens: 2048,
        temperature: 0.1,
        response_format: { type: 'json_object' },
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error('LLM returned no content for argument correction.');
      }

      const correctedArgs = JSON.parse(content);
      logger.info('LLM provided corrected arguments.', { toolName, correctedArgs });
      return correctedArgs;
    } catch (llmError: any) {
      logger.error('LLM-based argument correction failed.', { toolName, error: llmError.message });
      // Re-throw the original validation error if LLM fails
      throw new Error(`Argument validation failed: ${validationError}`);
    }
  }

  public async executePlan(run: Run, userId: string): Promise<Run> { // Ensure the method signature reflects the return
    logger.info('Starting automatic plan execution', { runId: run.id, planId: run.planId });

    this.streamManager.sendChunk(run.sessionId, {
      type: 'run_updated',
      content: { ...run, status: 'running' },
    });

    for (const step of run.toolExecutionPlan) {
      if (step.status === 'completed') {
        logger.info(`Skipping already completed step: ${step.stepId}`, { runId: run.id, toolName: step.toolCall.name });
        continue;
      }

      logger.info(`Executing step: ${step.stepId}`, { runId: run.id, toolName: step.toolCall.name });
      step.status = 'running';
      this.streamManager.sendChunk(run.sessionId, { type: 'run_updated', content: run });

      try {
        // The FollowUpService now handles argument resolution between steps.
        // For the first step, we use the arguments directly from the plan.
        // For subsequent steps, the arguments will have been pre-resolved by the FollowUpService
        // in the previous iteration of this loop.
        const { resolvedArgs, placeholdersResolved } = this._resolvePlaceholders(step.toolCall.arguments, run);
        step.toolCall.arguments = resolvedArgs;
        
        // --- This block remains to update the client with the resolved arguments ---
        const stepIndexToUpdate = run.toolExecutionPlan.findIndex(s => s.stepId === step.stepId);
        if (stepIndexToUpdate !== -1) {
            run.toolExecutionPlan[stepIndexToUpdate].toolCall.arguments = resolvedArgs;
        }
        
        // Announce the step with resolved arguments before executing
        const stepForAnnouncement: ActionStep = {
          id: step.stepId,
          intent: step.toolCall.name, // Using tool name as intent for announcement
          tool: step.toolCall.name,
          arguments: resolvedArgs,
          status: 'executing',
        };
        // Pass the new flag to the announcement service
        await this.plannerService.streamStepAnnouncement(stepForAnnouncement, run.sessionId, placeholdersResolved);
        this.streamManager.sendChunk(run.sessionId, { type: 'run_updated', content: run });

        try {
          // Validate the now-resolved arguments
          this.toolConfigManager.validateToolArgsWithZod(step.toolCall.name, resolvedArgs);
        } catch (error: any) {
          logger.warn('Zod validation failed, attempting LLM fallback.', {
            runId: run.id,
            stepId: step.stepId,
            error: error.message,
          });
          
          const fixedArguments = await this._fixArgumentsWithLlm(step, run, resolvedArgs, error.message);

          // Re-validate after LLM correction
          try {
            this.toolConfigManager.validateToolArgsWithZod(step.toolCall.name, fixedArguments);
            logger.info('LLM-corrected arguments passed validation.', { runId: run.id, stepId: step.stepId });
          } catch (finalError: any) {
            logger.error('Validation failed even after LLM correction. Halting step.', {
              runId: run.id,
              stepId: step.stepId,
              error: finalError.message,
            });
            throw finalError; // Propagate the error to halt the plan
          }
          // If fixed, update the arguments in the run object again
          run.toolExecutionPlan[stepIndexToUpdate].toolCall.arguments = fixedArguments;
        }

        const payload = {
          actionId: step.toolCall.id,
          toolName: step.toolCall.name,
          arguments: run.toolExecutionPlan[stepIndexToUpdate].toolCall.arguments,
        };

        // Added for debugging data dependencies
        logger.info('PlanExecutorService: Executing step with resolved arguments', {
          runId: run.id,
          stepId: step.stepId,
          toolName: step.toolCall.name,
          arguments: JSON.stringify(payload.arguments, null, 2)
        });

        // Directly call the action launcher to execute the step
        const completedAction = await this.actionLauncherService.executeAction(
          run.sessionId,
          userId,
          payload,
          this.toolOrchestrator,
          run.planId,
          step.stepId
        );

        // Update the step in the run object
        const stepIndex = run.toolExecutionPlan.findIndex(
          (planStep: ToolExecutionStep) => planStep.stepId === step.stepId
        );
        if (stepIndex > -1) {
          run.toolExecutionPlan[stepIndex].status = completedAction.status;
          run.toolExecutionPlan[stepIndex].result = {
            status: completedAction.status === 'completed' ? 'success' : 'failed',
            toolName: completedAction.toolName,
            data: completedAction.result,
            error: completedAction.error,
          };
          run.toolExecutionPlan[stepIndex].finishedAt = new Date().toISOString();
        }
        
        this.streamManager.sendChunk(run.sessionId, { type: 'run_updated', content: run });

        if (completedAction.status === 'failed') {
          logger.error('Step failed, halting plan execution.', { runId: run.id, stepId: step.stepId, error: completedAction.error });
          run.status = 'failed';
          // --- FIX: Announce step failure conversationally ---
          const stepForCompletion: ActionStep = {
            id: step.stepId,
            intent: step.toolCall.name,
            tool: step.toolCall.name,
            arguments: step.toolCall.arguments,
            status: 'failed',
          };
          await this.plannerService.streamStepCompletion(stepForCompletion, { error: completedAction.error }, run.sessionId);
          // --- END OF FIX ---
          // Send a clear failure message to the client
          this.streamManager.sendChunk(run.sessionId, {
            type: 'error',
            content: `Action '${step.toolCall.name}' failed: ${completedAction.error || 'An unknown error occurred.'}`,
            messageId: step.toolCall.id,
            isFinal: true,
          });
          this.streamManager.sendChunk(run.sessionId, { type: 'run_updated', content: run });
          return run;
        } else {
          // Announce step completion
          const stepForCompletion: ActionStep = {
            id: step.stepId,
            intent: step.toolCall.name, // Using tool name as intent for announcement
            tool: step.toolCall.name,
            arguments: step.toolCall.arguments, // Use the original arguments or resolved ones if needed
            status: 'completed',
          };
          await this.plannerService.streamStepCompletion(stepForCompletion, completedAction.result, run.sessionId);

          // --- FIX: Generate conversational follow-up and resolve next step's args ---
          const isLastStep = stepIndex === run.toolExecutionPlan.length - 1;
          if (!isLastStep) {
            const nextStep = run.toolExecutionPlan[stepIndex + 1];
            const { summary, nextToolCall } = await this.followUpService.generateFollowUp(run, nextStep);

            if (summary) {
              // Stream the conversational summary
              this.streamManager.sendChunk(run.sessionId, { type: 'conversational_text_segment', content: { status: 'START_STREAM' }, messageId: nextStep.toolCall.id });
              this.streamManager.sendChunk(run.sessionId, { type: 'conversational_text_segment', content: { status: 'STREAMING', segment: { segment: summary, styles: [], type: 'text' } }, messageId: nextStep.toolCall.id });
              this.streamManager.sendChunk(run.sessionId, { type: 'conversational_text_segment', content: { status: 'END_STREAM' }, messageId: nextStep.toolCall.id, isFinal: true });
            }

            if (nextToolCall) {
              // Update the run object with the newly resolved arguments for the next step
              nextStep.toolCall.arguments = nextToolCall.arguments;
              logger.info('FollowUpService resolved arguments for the next step.', { nextStepId: nextStep.stepId, resolvedArgs: nextToolCall.arguments });
              // Send the updated run to the client so it sees the resolved args
              this.streamManager.sendChunk(run.sessionId, { type: 'run_updated', content: run });
            }
          }
          // --- END OF FIX ---
        }
      } catch (error: any) {
        logger.error('An unexpected error occurred during step execution, halting plan.', {
          runId: run.id,
          stepId: step.stepId,
          error: error.message,
        });
        // --- FIX: Announce step failure conversationally on exception ---
        const stepForCompletion: ActionStep = {
            id: step.stepId,
            intent: step.toolCall.name,
            tool: step.toolCall.name,
            arguments: step.toolCall.arguments,
            status: 'failed',
        };
        await this.plannerService.streamStepCompletion(stepForCompletion, { error: error.message }, run.sessionId);
        // --- END OF FIX ---
        // Send a clear failure message to the client
        this.streamManager.sendChunk(run.sessionId, {
            type: 'error',
            content: `Execution of '${step.toolCall.name}' failed: ${error.message || 'An unexpected error occurred.'}`,
            messageId: step.toolCall.id,
            isFinal: true,
        });
        run.status = 'failed';
        this.streamManager.sendChunk(run.sessionId, { type: 'run_updated', content: run });
        return run;
      }
    }

    logger.info('Plan execution completed successfully.', { runId: run.id });
    run.status = 'completed';
    run.completedAt = new Date().toISOString();
    this.streamManager.sendChunk(run.sessionId, { type: 'run_updated', content: run });
    return run;
  }
}
