"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RunController = void 0;
const express_1 = require("express");
const RunManager_1 = require("../services/tool/RunManager");
const winston_1 = __importDefault(require("winston"));
const uuid_1 = require("uuid");
class RunController {
    constructor(toolOrchestrator, streamManager) {
        this.toolOrchestrator = toolOrchestrator;
        this.streamManager = streamManager;
        this.getRunById = (req, res) => {
            const runId = req.params.id;
            this.logger.warn(`Debug request for run: ${runId}. Note: Server is stateless; this endpoint is for debugging and may not find runs.`);
            res.status(404).json({ error: `Run not found. The server is stateless and does not store run history.` });
        };
        this.handleExportAction = async (req, res) => {
            const { parentRun, toolName, arguments: toolArgs, userId, sessionId, connectionId } = req.body;
            this.logger.info('Received export action request', { parentRunId: parentRun?.id, toolName, userId, sessionId });
            if (!parentRun || !toolName || !toolArgs || !userId || !sessionId) {
                res.status(400).json({ error: 'Missing required fields: parentRun, toolName, arguments, userId, sessionId' });
                return;
            }
            const exportToolCall = {
                id: (0, uuid_1.v4)(),
                name: toolName,
                arguments: toolArgs,
                sessionId: sessionId,
                userId: ''
            };
            const initialStep = {
                stepId: 'step_1',
                toolCall: exportToolCall,
                status: 'pending',
                startedAt: new Date().toISOString(),
            };
            let exportRun = RunManager_1.RunManager.createRun({
                sessionId: sessionId,
                userId: userId,
                userInput: `User initiated export: ${toolName}`,
                toolExecutionPlan: [initialStep],
                connectionId: connectionId || parentRun.connectionId,
                contextMessages: parentRun.contextMessages,
            });
            exportRun.parentRunId = parentRun.id;
            exportRun.initiatedBy = 'user';
            this.streamManager.sendChunk(sessionId, { type: 'run_updated', content: exportRun });
            res.status(202).json({ message: "Export run initiated.", runId: exportRun.id });
            try {
                const planStep = exportRun.toolExecutionPlan.find(step => step.toolCall.id === exportToolCall.id) ?? exportRun.toolExecutionPlan[0];
                const planStepId = planStep?.stepId ?? 'step_1';
                exportRun = RunManager_1.RunManager.startToolExecution(exportRun, exportToolCall.id);
                this.streamManager.sendChunk(sessionId, { type: 'run_updated', content: exportRun });
                const result = await this.toolOrchestrator.executeTool(exportToolCall, exportRun.planId, planStepId);
                exportRun = RunManager_1.RunManager.recordToolResult(exportRun, exportToolCall.id, result);
                this.streamManager.sendChunk(sessionId, { type: 'run_updated', content: exportRun });
            }
            catch (error) {
                this.logger.error('Export tool execution failed', { error: error.message, runId: exportRun.id });
                const errorResult = { status: 'failed', toolName, data: null, error: error.message };
                exportRun = RunManager_1.RunManager.recordToolResult(exportRun, exportToolCall.id, errorResult);
            }
            finally {
                exportRun = RunManager_1.RunManager.finalizeRun(exportRun);
                this.streamManager.sendChunk(sessionId, { type: 'run_updated', content: exportRun });
                this.logger.info('Export run processing finished.', { runId: exportRun.id, status: exportRun.status });
            }
        };
        this.router = (0, express_1.Router)();
        this.logger = winston_1.default.createLogger({
            level: 'info',
            format: winston_1.default.format.json(),
            transports: [new winston_1.default.transports.Console()],
        });
        this.initializeRoutes();
    }
    initializeRoutes() {
        this.router.get('/runs/:id', this.getRunById);
        this.router.post('/runs/export', this.handleExportAction);
    }
}
exports.RunController = RunController;
