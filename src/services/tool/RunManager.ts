// src/services/tool/RunManager.ts

import { Run, RunStatus, ToolExecutionStep } from './run.types';
import { ToolResult, Message } from '../conversation/types';
import { v4 as uuidv4 } from 'uuid';
import winston from 'winston';

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.json(),
    transports: [new winston.transports.Console()],
});

/**
 * Manages the lifecycle of Run objects IN MEMORY.
 * This class modifies the Run object before it's streamed to the client.
 */
export class RunManager {
  

  /**
   * Creates a new Run object representing a plan of one or more actions.
   */
  public static createRun(params: {
    sessionId: string;
    userId: string;
    userInput: string;
    toolExecutionPlan: ToolExecutionStep[];
    contextMessages?: Message[];
    connectionId?: string;
  }): Run {
    const now = new Date().toISOString();
    const runId = `run_${uuidv4()}`;
    const planId = `plan_${uuidv4()}`;

    const truncatedContext = params.contextMessages?.map(msg => ({
        ...msg,
        content: msg.content ? msg.content.substring(0, 500) + (msg.content.length > 500 ? '...' : '') : null,
    })).slice(-10);

    const toolsWithStepIds = params.toolExecutionPlan.map((step, index) => ({
        ...step,
        stepId: step.stepId ?? `step_${index + 1}`,
    }));

    const run: Run = {
      id: runId,
      planId,
      sessionId: params.sessionId,
      userId: params.userId,
      connectionId: params.connectionId,
      userInput: params.userInput,
      contextMessages: truncatedContext,
      status: 'pending',
      startedAt: now,
      initiatedBy: 'assistant',
      parentRunId: '',
      toolExecutionPlan: toolsWithStepIds, // Correctly use toolExecutionPlan
      completedAt: ''
    };

    logger.info(`Run object created in memory.`, { runId, planId, status: 'pending' });
    return run;
  }

  public static addToolResult(run: Run, toolCallId: string, result: ToolResult): Run {
    const toolIndex = run.toolExecutionPlan.findIndex((t: ToolExecutionStep) => t.toolCall.id === toolCallId);
    if (toolIndex !== -1) {
      run.toolExecutionPlan[toolIndex].status = result.status === 'success' ? 'completed' : 'failed';
      run.toolExecutionPlan[toolIndex].result = result;
      run.toolExecutionPlan[toolIndex].finishedAt = new Date().toISOString();
    }
    return run;
  }

  /**
   * Updates a tool's metadata within a run when its execution begins.
   */
  public static startToolExecution(run: Run, toolCallId: string): Run {
    const toolMeta = run.toolExecutionPlan.find((t: ToolExecutionStep) => t.toolCall.id === toolCallId);
    if (toolMeta) {
      toolMeta.startedAt = new Date().toISOString();
      toolMeta.status = 'running';
      run.status = 'running';
      logger.info(`Updated run in memory: tool execution started.`, { runId: run.id, toolCallId });
    }
    return run;
  }

  /**
   * FIX: Corrected method signature to accept only 3 arguments.
   * The calling context (e.g., index.ts) is responsible for sending WebSocket updates.
   */
  public static recordToolResult(run: Run, toolCallId: string, result: ToolResult): Run {
    const toolMeta = run.toolExecutionPlan.find((t: ToolExecutionStep) => t.toolCall.id === toolCallId);

    if (!toolMeta) {
      logger.warn(`Could not find tool with toolCallId "${toolCallId}" in run "${run.id}" to record result.`);
      return run;
    }

    const now = new Date().toISOString();
    toolMeta.finishedAt = now;
    toolMeta.status = result.status === 'success' ? 'completed' : 'failed';
    toolMeta.result = result;

    logger.info(`Updated run in memory: tool result recorded.`, { runId: run.id, toolCallId, status: result.status });
    return run;
  }

  /**
   * Updates the run with the final assistant text response.
   */
  public static addAssistantResponse(run: Run, assistantResponse: string): Run {
      run.assistantResponse = assistantResponse;
      logger.info(`Updated run in memory: assistant response added.`, { runId: run.id });
      return run;
  }

  /**
   * Finalizes a Run. This should be called after the last expected event.
   */
  public static finalizeRun(run: Run): Run {
    const allToolsCompleted = run.toolExecutionPlan.every((t: ToolExecutionStep) => !!t.result);
    if (!allToolsCompleted) {
        logger.info(`Run ${run.id} will not be finalized yet; waiting for more tool results.`);
        return run;
    }

    const now = new Date().toISOString();
    run.completedAt = now;

    const results = run.toolExecutionPlan
      .map((t: ToolExecutionStep) => t.result?.status)
      .filter((status): status is 'success' | 'failed' => !!status);
    const successCount = results.filter((r) => r === 'success').length;

    if (results.length === 0) {
      run.status = 'failed';
    } else if (successCount === results.length) {
      run.status = 'completed';
    } else if (successCount > 0) {
      run.status = 'partial_success';
    } else {
      run.status = 'failed';
    }

    logger.info(`Updated run in memory: run finalized.`, { runId: run.id, finalStatus: run.status });
    return run;
  }
}
