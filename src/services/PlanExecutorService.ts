
import { ToolConfigManager } from './tool/ToolConfigManager';
import winston from 'winston';
import { ActionLauncherService } from '../action-launcher.service';
import { StreamManager } from './stream/StreamManager';
import { ToolOrchestrator } from './tool/ToolOrchestrator';
import { Run, ToolExecutionStep } from './tool/run.types';
import Groq from 'groq-sdk';

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

  private _resolvePlaceholders(args: any, run: Run): any {
    const resolvedArgs = JSON.parse(JSON.stringify(args)); // Deep copy

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
    return resolvedArgs;
  }

  private async _fixArgumentsWithLlm(
    toolName: string,
    invalidArgs: Record<string, any>,
    validationError: string
  ): Promise<Record<string, any>> {
    logger.info('Attempting to fix arguments with LLM using structured output', { toolName, validationError });
    const toolSchema = this.toolConfigManager.getToolInputSchema(toolName);
    if (!toolSchema) {
      throw new Error(`Cannot fix arguments: No schema found for tool ${toolName}`);
    }

    // The schema for a tool's arguments might not have all properties as required.
    // The structured output feature requires all properties in the provided schema to be required.
    // We create a deep copy and modify it to enforce this constraint for the LLM call.
    const strictToolSchema = JSON.parse(JSON.stringify(toolSchema));
    if (strictToolSchema.properties) {
        strictToolSchema.required = Object.keys(strictToolSchema.properties);
        // Also ensure all nested objects are strict
        const makeStrict = (schema: any) => {
            if (schema.properties) {
                schema.required = Object.keys(schema.properties);
                schema.additionalProperties = false;
                for (const key in schema.properties) {
                    if (schema.properties[key].type === 'object') {
                        makeStrict(schema.properties[key]);
                    } else if (schema.properties[key].type === 'array' && schema.properties[key].items?.type === 'object') {
                        makeStrict(schema.properties[key].items);
                    }
                }
            }
        };
        makeStrict(strictToolSchema);
    }

    const systemPrompt = `You are an expert at correcting tool arguments. A tool call failed due to a validation error. Your task is to correct the provided arguments to match the tool's JSON schema.

Tool Name: ${toolName}
Tool Schema:
${JSON.stringify(toolSchema, null, 2)}

Invalid Arguments:
${JSON.stringify(invalidArgs, null, 2)}

Validation Error:
${validationError}

Instructions:
1. Analyze the validation error and the schema.
2. Correct the invalid arguments to conform to the schema.
3. Output ONLY the corrected JSON object for the arguments. Do not include any other text, explanations, or markdown.`;

    try {
      const response = await this.groqClient.chat.completions.create({
        model: 'openai/gpt-oss-20b', // Model that supports json_schema
        messages: [{ role: 'system', content: systemPrompt }],
        max_tokens: 2048,
        temperature: 0.1,
        response_format: { type: "json_object" },
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

      try {
        let resolvedArguments = this._resolvePlaceholders(step.toolCall.arguments, run);

        try {
          this.toolConfigManager.validateToolArgsWithZod(step.toolCall.name, resolvedArguments);
        } catch (error: any) {
          logger.warn('Zod validation failed, attempting LLM fallback.', {
            runId: run.id,
            stepId: step.stepId,
            error: error.message,
          });
          
          resolvedArguments = await this._fixArgumentsWithLlm(step.toolCall.name, resolvedArguments, error.message);

          // Re-validate after LLM correction
          try {
            this.toolConfigManager.validateToolArgsWithZod(step.toolCall.name, resolvedArguments);
            logger.info('LLM-corrected arguments passed validation.', { runId: run.id, stepId: step.stepId });
          } catch (finalError: any) {
            logger.error('Validation failed even after LLM correction. Halting step.', {
              runId: run.id,
              stepId: step.stepId,
              error: finalError.message,
            });
            throw finalError; // Propagate the error to halt the plan
          }
        }

        const payload = {
          actionId: step.toolCall.id,
          toolName: step.toolCall.name,
          arguments: resolvedArguments,
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
          this.streamManager.sendChunk(run.sessionId, { type: 'run_updated', content: run });
          return run;
        }
      } catch (error: any) {
        logger.error('An unexpected error occurred during step execution, halting plan.', {
          runId: run.id,
          stepId: step.stepId,
          error: error.message,
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
