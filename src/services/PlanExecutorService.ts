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
    private plannerService: PlannerService,
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
    const resolvedArgs = JSON.parse(JSON.stringify(args));
    let placeholdersResolved = false;

    const replacer = (obj: any) => {
      for (const key in obj) {
        if (typeof obj[key] === 'string') {
          const originalString = obj[key];
          const match = originalString.match(/^{{(.+?)}}$/);          

          if (match) {
            const placeholder = match[1];
            const [stepId, ...pathParts] = placeholder.split('.');
            
            if (pathParts[0] === 'result') {
              pathParts.shift();
            }
            const path = pathParts.join('.');
            const sourceStep = run.toolExecutionPlan.find(s => s.stepId === stepId);

            if (sourceStep && sourceStep.result) {
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
2.  **Analyze the Error**: The "Validation Error" tells you exactly what's wrong.
3.  **Find the Missing Data**: Look at the "Previous Step's Result" for needed data.
4.  **Construct the Final Arguments**: Create a complete, valid JSON object.
5.  **Output ONLY the corrected JSON object.** No other text or markdown.`;

    try {
      const response = await this.groqClient.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'system', content: systemPrompt }],
        max_tokens: 2048,
        temperature: 0.1,
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
      throw new Error(`Argument validation failed: ${validationError}`);
    }
  }

  public async executePlan(run: Run, userId: string): Promise<Run> {
    logger.info('Starting automatic plan execution', { runId: run.id, planId: run.planId });

    this.streamManager.sendChunk(run.sessionId, {
      type: 'run_updated',
      content: { ...run, status: 'running' },
    });

    for (const step of run.toolExecutionPlan) {
      const stepIndex = run.toolExecutionPlan.findIndex(s => s.stepId === step.stepId);

      // --- REFACTORED: Simplified handling of completed steps ---
      if (step.status === 'completed') {
        logger.info(`Step already completed: ${step.stepId}`, { runId: run.id, toolName: step.toolCall.name });
        // Don't continue - let the follow-up logic at the end of loop handle this
      } else {
        // --- EXECUTE PENDING STEP ---
        logger.info(`Executing step: ${step.stepId}`, { runId: run.id, toolName: step.toolCall.name });
        step.status = 'running';
        this.streamManager.sendChunk(run.sessionId, { type: 'run_updated', content: run });

        try {
          const { resolvedArgs, placeholdersResolved } = this._resolvePlaceholders(step.toolCall.arguments, run);
          step.toolCall.arguments = resolvedArgs;
          
          const stepIndexToUpdate = run.toolExecutionPlan.findIndex(s => s.stepId === step.stepId);
          if (stepIndexToUpdate !== -1) {
              run.toolExecutionPlan[stepIndexToUpdate].toolCall.arguments = resolvedArgs;
          }
          
          const stepForAnnouncement: ActionStep = {
            id: step.stepId,
            intent: step.toolCall.name,
            tool: step.toolCall.name,
            arguments: resolvedArgs,
            status: 'executing',
          };
          await this.plannerService.streamStepAnnouncement(stepForAnnouncement, run.sessionId, placeholdersResolved);
          this.streamManager.sendChunk(run.sessionId, { type: 'run_updated', content: run });

          try {
            this.toolConfigManager.validateToolArgsWithZod(step.toolCall.name, resolvedArgs);
          } catch (error: any) {
            logger.warn('Zod validation failed, attempting LLM fallback.', {
              runId: run.id,
              stepId: step.stepId,
              error: error.message,
            });
            
            const fixedArguments = await this._fixArgumentsWithLlm(step, run, resolvedArgs, error.message);

            try {
              this.toolConfigManager.validateToolArgsWithZod(step.toolCall.name, fixedArguments);
              logger.info('LLM-corrected arguments passed validation.', { runId: run.id, stepId: step.stepId });
            } catch (finalError: any) {
              logger.error('Validation failed even after LLM correction. Halting step.', {
                runId: run.id,
                stepId: step.stepId,
                error: finalError.message,
              });
              throw finalError;
            }
            run.toolExecutionPlan[stepIndexToUpdate].toolCall.arguments = fixedArguments;
          }

          const payload = {
            actionId: step.toolCall.id,
            toolName: step.toolCall.name,
            arguments: run.toolExecutionPlan[stepIndexToUpdate].toolCall.arguments,
          };

          logger.info('PlanExecutorService: Executing step with resolved arguments', {
            runId: run.id,
            stepId: step.stepId,
            toolName: step.toolCall.name,
            arguments: JSON.stringify(payload.arguments, null, 2)
          });

          const completedAction = await this.actionLauncherService.executeAction(
            run.sessionId,
            userId,
            payload,
            this.toolOrchestrator,
            run.planId,
            step.stepId
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
            const stepForCompletion: ActionStep = {
              id: step.stepId,
              intent: step.toolCall.name,
              tool: step.toolCall.name,
              arguments: step.toolCall.arguments,
              status: 'failed',
            };
            await this.plannerService.streamStepCompletion(stepForCompletion, { error: completedAction.error }, run.sessionId);
            this.streamManager.sendChunk(run.sessionId, {
              type: 'error',
              content: `Action '${step.toolCall.name}' failed: ${completedAction.error || 'An unknown error occurred.'}`,
              messageId: step.toolCall.id,
              isFinal: true,
            });
            this.streamManager.sendChunk(run.sessionId, { type: 'run_updated', content: run });
            return run;
          }
        } catch (error: any) {
          logger.error('An unexpected error occurred during step execution, halting plan.', {
            runId: run.id,
            stepId: step.stepId,
            error: error.message,
          });
          const stepForCompletion: ActionStep = {
              id: step.stepId,
              intent: step.toolCall.name,
              tool: step.toolCall.name,
              arguments: step.toolCall.arguments,
              status: 'failed',
          };
          await this.plannerService.streamStepCompletion(stepForCompletion, { error: error.message }, run.sessionId);
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

      // --- UNIFIED FOLLOW-UP LOGIC: Runs after EVERY completed step ---
      const isLastStep = stepIndex === run.toolExecutionPlan.length - 1;
      if (step.status === 'completed' && !isLastStep) {
        const nextStep = run.toolExecutionPlan[stepIndex + 1];
        logger.info('Generating follow-up after completed step', { 
          currentStepId: step.stepId, 
          nextStepId: nextStep.stepId 
        });
        
        try {
          const { summary, nextToolCall } = await this.followUpService.generateFollowUp(run, nextStep);
          
          // CRITICAL FIX: Use a UNIQUE message ID for the follow-up summary
          // Don't use step.toolCall.id or nextStep.toolCall.id - create a new one!
          const followUpMessageId = `${step.stepId}_followup`;
          
          if (summary) {
            this.streamManager.sendChunk(run.sessionId, { 
              type: 'conversational_text_segment', 
              content: { status: 'START_STREAM' }, 
              messageId: followUpMessageId  // UNIQUE ID for follow-up
            });
            this.streamManager.sendChunk(run.sessionId, { 
              type: 'conversational_text_segment', 
              content: { 
                status: 'STREAMING', 
                segment: { segment: summary, styles: [], type: 'text' } 
              }, 
              messageId: followUpMessageId 
            });
            this.streamManager.sendChunk(run.sessionId, { 
              type: 'conversational_text_segment', 
              content: { status: 'END_STREAM' }, 
              messageId: followUpMessageId, 
              isFinal: true 
            });
            logger.info('Streamed follow-up summary', { stepId: step.stepId, summary, messageId: followUpMessageId });
          }
          
          // Then update the next step's arguments if they were resolved
          if (nextToolCall && nextToolCall.arguments) {
            nextStep.toolCall.arguments = nextToolCall.arguments;
            logger.info('FollowUpService resolved arguments for next step', { 
              nextStepId: nextStep.stepId, 
              resolvedArgs: nextToolCall.arguments 
            });
            this.streamManager.sendChunk(run.sessionId, { type: 'run_updated', content: run });
          }
        } catch (followUpError: any) {
          logger.error('Follow-up generation failed, but continuing execution', {
            stepId: step.stepId,
            error: followUpError.message
          });
          // Don't halt the plan for follow-up failures
        }
      }
    }

    logger.info('Plan execution completed successfully.', { runId: run.id });
    run.status = 'completed';
    run.completedAt = new Date().toISOString();
    this.streamManager.sendChunk(run.sessionId, { type: 'run_updated', content: run });
    return run;
  }
}