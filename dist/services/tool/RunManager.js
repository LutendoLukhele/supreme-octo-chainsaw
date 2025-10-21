"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RunManager = void 0;
const uuid_1 = require("uuid");
const winston_1 = __importDefault(require("winston"));
const logger = winston_1.default.createLogger({
    level: 'info',
    format: winston_1.default.format.json(),
    transports: [new winston_1.default.transports.Console()],
});
class RunManager {
    static createRun(params) {
        const now = new Date().toISOString();
        const runId = `run_${(0, uuid_1.v4)()}`;
        const planId = `plan_${(0, uuid_1.v4)()}`;
        const truncatedContext = params.contextMessages?.map(msg => ({
            ...msg,
            content: msg.content ? msg.content.substring(0, 500) + (msg.content.length > 500 ? '...' : '') : null,
        })).slice(-10);
        const toolsWithStepIds = params.toolExecutionPlan.map((step, index) => ({
            ...step,
            stepId: step.stepId ?? `step_${index + 1}`,
        }));
        const run = {
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
            toolExecutionPlan: toolsWithStepIds,
            completedAt: ''
        };
        logger.info(`Run object created in memory.`, { runId, planId, status: 'pending' });
        return run;
    }
    static addToolResult(run, toolCallId, result) {
        const toolIndex = run.toolExecutionPlan.findIndex((t) => t.toolCall.id === toolCallId);
        if (toolIndex !== -1) {
            run.toolExecutionPlan[toolIndex].status = result.status === 'success' ? 'completed' : 'failed';
            run.toolExecutionPlan[toolIndex].result = result;
            run.toolExecutionPlan[toolIndex].finishedAt = new Date().toISOString();
        }
        return run;
    }
    static startToolExecution(run, toolCallId) {
        const toolMeta = run.toolExecutionPlan.find((t) => t.toolCall.id === toolCallId);
        if (toolMeta) {
            toolMeta.startedAt = new Date().toISOString();
            toolMeta.status = 'running';
            run.status = 'running';
            logger.info(`Updated run in memory: tool execution started.`, { runId: run.id, toolCallId });
        }
        return run;
    }
    static recordToolResult(run, toolCallId, result) {
        const toolMeta = run.toolExecutionPlan.find((t) => t.toolCall.id === toolCallId);
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
    static addAssistantResponse(run, assistantResponse) {
        run.assistantResponse = assistantResponse;
        logger.info(`Updated run in memory: assistant response added.`, { runId: run.id });
        return run;
    }
    static finalizeRun(run) {
        const allToolsCompleted = run.toolExecutionPlan.every((t) => !!t.result);
        if (!allToolsCompleted) {
            logger.info(`Run ${run.id} will not be finalized yet; waiting for more tool results.`);
            return run;
        }
        const now = new Date().toISOString();
        run.completedAt = now;
        const results = run.toolExecutionPlan
            .map((t) => t.result?.status)
            .filter((status) => !!status);
        const successCount = results.filter((r) => r === 'success').length;
        if (results.length === 0) {
            run.status = 'failed';
        }
        else if (successCount === results.length) {
            run.status = 'completed';
        }
        else if (successCount > 0) {
            run.status = 'partial_success';
        }
        else {
            run.status = 'failed';
        }
        logger.info(`Updated run in memory: run finalized.`, { runId: run.id, finalStatus: run.status });
        return run;
    }
}
exports.RunManager = RunManager;
