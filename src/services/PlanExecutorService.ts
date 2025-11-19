import { ToolConfigManager } from './tool/ToolConfigManager';
import winston from 'winston';
import { ActionLauncherService } from '../action-launcher.service';
import { StreamManager } from './stream/StreamManager';
import { ToolOrchestrator } from './tool/ToolOrchestrator';
import { Run, ToolExecutionStep } from './tool/run.types';
import Groq from 'groq-sdk';
import { ActionStep, PlannerService } from './PlannerService';
import { FollowUpService } from './FollowUpService';

import { HistoryService } from './HistoryService';

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
    private followUpService: FollowUpService,
    private historyService: HistoryService
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
                logger.warn(`Could not resolve placeholder: ${originalString}`, { runId: run.id });
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
                  logger.warn(`Could not resolve placeholder: ${match}`, { runId: run.id });
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
    logger.info('Attempting to fix arguments with LLM', { toolName, validationError });
    const toolSchema = this.toolConfigManager.getToolInputSchema(toolName);
    if (!toolSchema) {
      throw new Error(`Cannot fix arguments: No schema found for tool ${toolName}`);
    }

    const currentStepIndex = run.toolExecutionPlan.findIndex(s => s.stepId === currentStep.stepId);
    const previousStep = currentStepIndex > 0 ? run.toolExecutionPlan[currentStepIndex - 1] : null;

    let previousStepResultJson = "No previous step result available.";
    if (previousStep && previousStep.status === 'completed' && previousStep.result) {
        previousStepResultJson = JSON.stringify(previousStep.result.data, null, 2);
    }

    const systemPrompt = `You are an expert AI agent data resolver. Fix these invalid tool arguments.

User's Request: ${run.userInput}
Tool: ${toolName}
Schema: ${JSON.stringify(toolSchema, null, 2)}
Previous Result: ${previousStepResultJson}
Invalid Arguments: ${JSON.stringify(invalidArgs, null, 2)}
Error: ${validationError}

Output ONLY valid JSON with corrected arguments. No explanation.`;

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
      logger.info('LLM corrected arguments', { toolName, correctedArgs });
      return correctedArgs;
    } catch (llmError: any) {
      logger.error('LLM correction failed', { toolName, error: llmError.message });
      throw new Error(`Argument validation failed: ${validationError}`);
    }
  }

  public async executePlan(run: Run, userId: string): Promise<Run> {
    logger.info('Starting plan execution', { 
      runId: run.id,
      totalSteps: run.toolExecutionPlan.length,
      steps: run.toolExecutionPlan.map(s => ({ 
        id: s.stepId, 
        tool: s.toolCall.name, 
        status: s.status 
      }))
    });

    this.streamManager.sendChunk(run.sessionId, {
      type: 'run_updated',
      content: { ...run, status: 'running' },
    });

    for (let i = 0; i < run.toolExecutionPlan.length; i++) {
      const step = run.toolExecutionPlan[i];
      const stepIndex = i;

      logger.info(`Processing step ${stepIndex + 1}/${run.toolExecutionPlan.length}`, {
        stepId: step.stepId,
        tool: step.toolCall.name,
        status: step.status
      });

      // === HANDLE ALREADY COMPLETED STEPS ===
      if (step.status === 'completed') {
        logger.info('Step already completed', { stepId: step.stepId });
        
        // Generate completion message for this step
        const completionStep: ActionStep = {
          id: step.stepId,
          intent: step.toolCall.name,
          tool: step.toolCall.name,
          arguments: step.toolCall.arguments,
          status: 'completed',
        };
        
        await this.plannerService.streamStepCompletion(
          completionStep, 
          step.result?.data || {}, 
          run.sessionId
        );
        
        // Fall through to follow-up logic
      } 
      // === EXECUTE PENDING STEPS ===
      else if (step.status === 'pending' || step.status === 'ready') {
        logger.info('Executing step', { stepId: step.stepId });
        step.status = 'running';
        this.streamManager.sendChunk(run.sessionId, { type: 'run_updated', content: run });

        try {
          // Resolve placeholders
          const { resolvedArgs, placeholdersResolved } = this._resolvePlaceholders(
            step.toolCall.arguments, 
            run
          );
          step.toolCall.arguments = resolvedArgs;
          
          // Announce the step
          const announcementStep: ActionStep = {
            id: step.stepId,
            intent: step.toolCall.name,
            tool: step.toolCall.name,
            arguments: resolvedArgs,
            status: 'executing',
          };
          await this.plannerService.streamStepAnnouncement(
            announcementStep, 
            run.sessionId, 
            placeholdersResolved
          );
          this.streamManager.sendChunk(run.sessionId, { type: 'run_updated', content: run });

          // Validate arguments
          try {
            this.toolConfigManager.validateToolArgsWithZod(step.toolCall.name, resolvedArgs);
          } catch (error: any) {
            logger.warn('Validation failed, attempting LLM fix', { 
              stepId: step.stepId, 
              error: error.message 
            });
            
            const fixedArguments = await this._fixArgumentsWithLlm(
              step, 
              run, 
              resolvedArgs, 
              error.message
            );

            // Re-validate
            this.toolConfigManager.validateToolArgsWithZod(step.toolCall.name, fixedArguments);
            step.toolCall.arguments = fixedArguments;
          }

          // Execute the tool
          const payload = {
            actionId: step.toolCall.id,
            toolName: step.toolCall.name,
            arguments: step.toolCall.arguments,
          };
          
          // DEBUG: action about to be stored/enqueued (immediately before DB write / enqueue)
          try {
            console.log("🔥 ACTION_BEFORE_STORE:", JSON.stringify(payload, null, 2));
          } catch (e) {
            console.log("🔥 ACTION_BEFORE_STORE (raw):", payload);
          }



          logger.info('Executing tool', {
            stepId: step.stepId,
            tool: step.toolCall.name,
            arguments: payload.arguments
          });

          const completedAction = await this.actionLauncherService.executeAction(
            run.sessionId,
            userId,
            payload,
            this.toolOrchestrator,
            run.planId,
            step.stepId
          );

          // Update step result
          step.status = completedAction.status;
          step.result = {
            status: completedAction.status === 'completed' ? 'success' : 'failed',
            toolName: completedAction.toolName,
            data: completedAction.result,
            error: completedAction.error,
            // Include enhanced Nango error details for QA/debugging if available
            errorDetails: (completedAction as any).errorDetails || null,
          };
          step.finishedAt = new Date().toISOString();
          
          this.streamManager.sendChunk(run.sessionId, { type: 'run_updated', content: run });

          // Handle failure
          if (completedAction.status === 'failed') {
            logger.error('Step failed', { stepId: step.stepId, error: completedAction.error });
            run.status = 'failed';

            try {
              await this.historyService.recordToolCall(
                userId,
                run.sessionId,
                step.toolCall.name,
                `Failed: ${completedAction.error || 'Unknown error'}`,
                step.toolCall.arguments,
                null,
                'failed',
                step.stepId,
                run.id
              );
            } catch (error: any) {
              logger.warn('Failed to record failed tool call', { error: error.message });
            }
            
            const failureStep: ActionStep = {
              id: step.stepId,
              intent: step.toolCall.name,
              tool: step.toolCall.name,
              arguments: step.toolCall.arguments,
              status: 'failed',
            };
            await this.plannerService.streamStepCompletion(
              failureStep, 
              { error: completedAction.error }, 
              run.sessionId
            );
            
            this.streamManager.sendChunk(run.sessionId, {
              type: 'error',
              content: `Action '${step.toolCall.name}' failed: ${completedAction.error}`,
              messageId: step.toolCall.id,
              isFinal: true,
            });
            this.streamManager.sendChunk(run.sessionId, { type: 'run_updated', content: run });
            return run;
          }

          try {
            await this.historyService.recordToolCall(
              userId,
              run.sessionId,
              step.toolCall.name,
              `Executed ${step.toolCall.name}`,
              step.toolCall.arguments,
              completedAction.result,
              'success',
              step.stepId,
              run.id
            );
            logger.info('Tool execution recorded in history', { 
              stepId: step.stepId, 
              tool: step.toolCall.name 
            });
          } catch (error: any) {
            logger.warn('Failed to record tool call in history', { 
              error: error.message,
              stepId: step.stepId 
            });
          }

          // Generate completion message
          const successStep: ActionStep = {
            id: step.stepId,
            intent: step.toolCall.name,
            tool: step.toolCall.name,
            arguments: step.toolCall.arguments,
            status: 'completed',
          };
          await this.plannerService.streamStepCompletion(
            successStep, 
            completedAction.result, 
            run.sessionId
          );

        } catch (error: any) {
          logger.error('Step execution error', { stepId: step.stepId, error: error.message });
          
          const errorStep: ActionStep = {
            id: step.stepId,
            intent: step.toolCall.name,
            tool: step.toolCall.name,
            arguments: step.toolCall.arguments,
            status: 'failed',
          };
          await this.plannerService.streamStepCompletion(
            errorStep, 
            { error: error.message }, 
            run.sessionId
          );
          
          this.streamManager.sendChunk(run.sessionId, {
            type: 'error',
            content: `Execution failed: ${error.message}`,
            messageId: step.toolCall.id,
            isFinal: true,
          });
          
          run.status = 'failed';
          this.streamManager.sendChunk(run.sessionId, { type: 'run_updated', content: run });
          return run;
        }
      }

      // === FOLLOW-UP LOGIC ===
      const isLastStep = stepIndex === run.toolExecutionPlan.length - 1;
      
      if (step.status === 'completed' && !isLastStep) {
        const nextStep = run.toolExecutionPlan[stepIndex + 1];
        
        logger.info('Generating follow-up', { 
          currentStep: step.stepId,
          nextStep: nextStep.stepId 
        });
        
        try {
          const { summary, nextToolCall } = await this.followUpService.generateFollowUp(
            run, 
            nextStep
          );
          
          // Stream follow-up with unique message ID
          if (summary) {
            const followUpMessageId = `${step.stepId}_followup`;
            
            logger.info('Streaming follow-up', { 
              stepId: step.stepId, 
              messageId: followUpMessageId,
              summary 
            });
            
            this.streamManager.sendChunk(run.sessionId, { 
              type: 'conversational_text_segment', 
              content: { status: 'START_STREAM' }, 
              messageId: followUpMessageId
            });
            
            await new Promise(resolve => setTimeout(resolve, 100));
            
            this.streamManager.sendChunk(run.sessionId, { 
              type: 'conversational_text_segment', 
              content: { 
                status: 'STREAMING', 
                segment: { segment: summary, styles: [], type: 'text' } 
              }, 
              messageId: followUpMessageId 
            });
            
            await new Promise(resolve => setTimeout(resolve, 100));
            
            this.streamManager.sendChunk(run.sessionId, { 
              type: 'conversational_text_segment', 
              content: { status: 'END_STREAM' }, 
              messageId: followUpMessageId, 
              isFinal: true 
            });
            
            logger.info('Follow-up streamed', { messageId: followUpMessageId });
          }
          
          // Update next step arguments if resolved
          if (nextToolCall?.arguments) {
            nextStep.toolCall.arguments = nextToolCall.arguments;
            logger.info('Arguments resolved for next step', { 
              nextStepId: nextStep.stepId, 
              resolvedArgs: nextToolCall.arguments 
            });
            this.streamManager.sendChunk(run.sessionId, { type: 'run_updated', content: run });
          }
        } catch (followUpError: any) {
          logger.error('Follow-up generation failed', {
            stepId: step.stepId,
            error: followUpError.message
          });
          // Continue execution despite follow-up failure
        }
      }
    }

    // Plan completed
    logger.info('Plan execution completed', { runId: run.id });
    run.status = 'completed';
    run.completedAt = new Date().toISOString();

    if ((run as any).historyId) {
      try {
        await this.historyService.updateHistoryItem(
          userId,
          (run as any).historyId,
          {
            status: 'completed',
          } as any
        );
        logger.info('Plan status updated in history', { 
          runId: run.id, 
          historyId: (run as any).historyId 
        });
      } catch (error: any) {
        logger.warn('Failed to update plan status in history', { 
          error: error.message,
          runId: run.id 
        });
      }
    }

    this.streamManager.sendChunk(run.sessionId, { type: 'run_updated', content: run });
    return run;
  }
}