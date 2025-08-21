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

    const truncatedContext = params.contextMessages?.map(msg => ({
        ...msg,
        content: msg.content ? msg.content.substring(0, 500) + (msg.content.length > 500 ? '...' : '') : null,
    })).slice(-10);

    const run: Run = {
      id: runId,
      sessionId: params.sessionId,
      userId: params.userId,
      connectionId: params.connectionId,
      userInput: params.userInput,
      contextMessages: truncatedContext,
      status: 'pending',
      startedAt: now,
      tools: params.toolExecutionPlan,
      initiatedBy: 'assistant',
      parentRunId: '',
      toolExecutionPlan: [],
      completedAt: ''
    };

    logger.info(`Run object created in memory.`, { runId,  status: 'pending' });
    return run;
  }

  public static addToolResult(run: Run, toolCallId: string, result: ToolResult): Run {
        const toolIndex = run.tools.findIndex((t: { toolCall: { id: string; }; }) => t.toolCall.id === toolCallId);
        if (toolIndex !== -1) {
            run.tools[toolIndex].status = result.status;
            run.tools[toolIndex].result = result.data; // <<< Store the result data
            run.tools[toolIndex].error = result.error;
            run.tools[toolIndex].finishedAt = new Date().toISOString();
        }
        return run;
    }

  /**
   * Updates a tool's metadata within a run when its execution begins.
   */
  public static startToolExecution(run: Run, toolCallId: string): Run {
    const toolMeta = run.tools.find((t: { toolCall: { id: string; }; }) => t.toolCall.id === toolCallId);
    if (toolMeta) {
      toolMeta.startedAt = new Date().toISOString();
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
    const toolMeta = run.tools.find((t: { toolCall: { id: string; }; }) => t.toolCall.id === toolCallId);

    if (!toolMeta) {
      logger.warn(`Could not find tool with toolCallId "${toolCallId}" in run "${run.id}" to record result.`);
      return run;
    }

    const now = new Date().toISOString();
    toolMeta.completedAt = now;
    toolMeta.result = { ...result, toolCallId, startedAt: toolMeta.startedAt, completedAt: now };

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
    const allToolsCompleted = run.tools.every((t: { result: any; }) => !!t.result);
    if (!allToolsCompleted) {
        logger.info(`Run ${run.id} will not be finalized yet; waiting for more tool results.`);
        return run;
    }

    const now = new Date().toISOString();
    run.completedAt = now;

    const results = run.tools.map((t: { result: { status: any; }; }) => t.result?.status);
    const successCount = results.filter((r: string) => r === 'success').length;

    if (results.length === 0) run.status = 'failed';
    else if (successCount === results.length) run.status = 'success';
    else if (successCount > 0) run.status = 'partial_success';
    else run.status = 'failed';

    logger.info(`Updated run in memory: run finalized.`, { runId: run.id, finalStatus: run.status });
    return run;
  }
}
