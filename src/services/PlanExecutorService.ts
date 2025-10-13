
import winston from 'winston';
import { ActionLauncherService } from '../action-launcher.service';
import { StreamManager } from './stream/StreamManager';
import { ToolOrchestrator } from './tool/ToolOrchestrator';
import { Run, ToolExecutionStep } from './tool/run.types';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [new winston.transports.Console()],
});

export class PlanExecutorService {
  constructor(
    private actionLauncherService: ActionLauncherService,
    private toolOrchestrator: ToolOrchestrator,
    private streamManager: StreamManager
  ) {}

  public async executePlan(run: Run, userId: string): Promise<void> {
    logger.info('Starting automatic plan execution', { runId: run.id, planId: run.planId });

    this.streamManager.sendChunk(run.sessionId, {
      type: 'run_updated',
      content: { ...run, status: 'running' },
    });

    for (const step of run.toolExecutionPlan) {
      logger.info(`Executing step: ${step.stepId}`, { runId: run.id, toolName: step.toolCall.name });

      try {
        const payload = {
          actionId: step.toolCall.id,
          toolName: step.toolCall.name,
          arguments: step.toolCall.arguments,
        };

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
          return;
        }
      } catch (error: any) {
        logger.error('An unexpected error occurred during step execution, halting plan.', {
          runId: run.id,
          stepId: step.stepId,
          error: error.message,
        });
        run.status = 'failed';
        this.streamManager.sendChunk(run.sessionId, { type: 'run_updated', content: run });
        return;
      }
    }

    logger.info('Plan execution completed successfully.', { runId: run.id });
    run.status = 'completed';
    run.completedAt = new Date().toISOString();
    this.streamManager.sendChunk(run.sessionId, { type: 'run_updated', content: run });
  }
}
