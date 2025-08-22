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
        const truncatedContext = params.contextMessages?.map(msg => ({
            ...msg,
            content: msg.content ? msg.content.substring(0, 500) + (msg.content.length > 500 ? '...' : '') : null,
        })).slice(-10);
        const run = {
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
        logger.info(`Run object created in memory.`, { runId, status: 'pending' });
        return run;
    }
    static addToolResult(run, toolCallId, result) {
        const toolIndex = run.tools.findIndex((t) => t.toolCall.id === toolCallId);
        if (toolIndex !== -1) {
            run.tools[toolIndex].status = result.status;
            run.tools[toolIndex].result = result.data;
            run.tools[toolIndex].error = result.error;
            run.tools[toolIndex].finishedAt = new Date().toISOString();
        }
        return run;
    }
    static startToolExecution(run, toolCallId) {
        const toolMeta = run.tools.find((t) => t.toolCall.id === toolCallId);
        if (toolMeta) {
            toolMeta.startedAt = new Date().toISOString();
            run.status = 'running';
            logger.info(`Updated run in memory: tool execution started.`, { runId: run.id, toolCallId });
        }
        return run;
    }
    static recordToolResult(run, toolCallId, result) {
        const toolMeta = run.tools.find((t) => t.toolCall.id === toolCallId);
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
    static addAssistantResponse(run, assistantResponse) {
        run.assistantResponse = assistantResponse;
        logger.info(`Updated run in memory: assistant response added.`, { runId: run.id });
        return run;
    }
    static finalizeRun(run) {
        const allToolsCompleted = run.tools.every((t) => !!t.result);
        if (!allToolsCompleted) {
            logger.info(`Run ${run.id} will not be finalized yet; waiting for more tool results.`);
            return run;
        }
        const now = new Date().toISOString();
        run.completedAt = now;
        const results = run.tools.map((t) => t.result?.status);
        const successCount = results.filter((r) => r === 'success').length;
        if (results.length === 0)
            run.status = 'failed';
        else if (successCount === results.length)
            run.status = 'success';
        else if (successCount > 0)
            run.status = 'partial_success';
        else
            run.status = 'failed';
        logger.info(`Updated run in memory: run finalized.`, { runId: run.id, finalStatus: run.status });
        return run;
    }
}
exports.RunManager = RunManager;
