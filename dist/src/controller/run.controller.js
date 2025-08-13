"use strict";
// src/controllers/run.controller.ts
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
    toolOrchestrator;
    streamManager;
    router;
    logger;
    // Inject dependencies: ToolOrchestrator for execution, StreamManager for sending updates
    constructor(toolOrchestrator, streamManager) {
        this.toolOrchestrator = toolOrchestrator;
        this.streamManager = streamManager;
        this.router = (0, express_1.Router)();
        this.logger = winston_1.default.createLogger({
            level: 'info',
            format: winston_1.default.format.json(),
            transports: [new winston_1.default.transports.Console()],
        });
        this.initializeRoutes();
    }
    initializeRoutes() {
        // This route is for debugging, as the client should have the run data locally.
        this.router.get('/runs/:id', this.getRunById);
        this.router.post('/runs/export', this.handleExportAction);
    }
    /**
     * GET /runs/:id
     * This endpoint is now primarily for debugging purposes, as in the client-storage model,
     * the server is stateless regarding run history.
     */
    getRunById = (req, res) => {
        const runId = req.params.id;
        this.logger.warn(`Debug request for run: ${runId}. Note: Server is stateless; this endpoint is for debugging and may not find runs.`);
        // In a stateless model, we can't look up a run.
        // We could potentially implement a temporary cache for debugging if needed.
        res.status(404).json({ error: `Run not found. The server is stateless and does not store run history.` });
    };
    /**
     * POST /runs/export
     * Handles a user-initiated export action from a results screen.
     * The client must post the parent run object, as the server is stateless.
     */
    handleExportAction = async (req, res) => {
        const { parentRun, toolName, arguments: toolArgs, userId, sessionId, connectionId } = req.body;
        this.logger.info('Received export action request', { parentRunId: parentRun?.id, toolName, userId, sessionId });
        // Basic validation
        if (!parentRun || !toolName || !toolArgs || !userId || !sessionId) {
            res.status(400).json({ error: 'Missing required fields: parentRun, toolName, arguments, userId, sessionId' });
            return;
        }
        // 1. Create the ToolCall object for the export action
        const exportToolCall = {
            id: (0, uuid_1.v4)(),
            name: toolName,
            arguments: toolArgs,
            sessionId: sessionId,
            // --- Fill in other required fields from your ToolCall interface ---
            ToolName: '',
            args: {},
            result: {},
        };
        // 2. Create a new Run object in memory for this export action
        let exportRun = RunManager_1.RunManager.createRun({
            sessionId: sessionId,
            userId: userId,
            userInput: `User initiated export: ${toolName}`,
            toolExecutionPlan: [{ toolCall: exportToolCall, startedAt: new Date().toISOString() }],
            connectionId: connectionId || parentRun.connectionId,
            contextMessages: parentRun.contextMessages,
        });
        // Add linkage metadata
        exportRun.parentRunId = parentRun.id;
        exportRun.initiatedBy = 'user';
        // Immediately send the initial "pending" run object to the client
        this.streamManager.sendChunk(sessionId, { type: 'run_updated', content: exportRun });
        // Respond to the HTTP request immediately to acknowledge it
        res.status(202).json({ message: "Export run initiated.", runId: exportRun.id });
        // 3. Execute the action asynchronously and stream updates
        try {
            exportRun = RunManager_1.RunManager.startToolExecution(exportRun, exportToolCall.id);
            this.streamManager.sendChunk(sessionId, { type: 'run_updated', content: exportRun });
            const result = await this.toolOrchestrator.executeTool(exportToolCall);
            exportRun = RunManager_1.RunManager.recordToolResult(exportRun, exportToolCall.id, result);
            this.streamManager.sendChunk(sessionId, { type: 'run_updated', content: exportRun });
        }
        catch (error) {
            this.logger.error('Export tool execution failed', { error: error.message, runId: exportRun.id });
            const errorResult = { status: 'failed', toolName, data: null, error: error.message };
            exportRun = RunManager_1.RunManager.recordToolResult(exportRun, exportToolCall.id, errorResult);
        }
        finally {
            // 4. Finalize the run and send the last update
            exportRun = RunManager_1.RunManager.finalizeRun(exportRun);
            this.streamManager.sendChunk(sessionId, { type: 'run_updated', content: exportRun });
            this.logger.info('Export run processing finished.', { runId: exportRun.id, status: exportRun.status });
        }
    };
}
exports.RunController = RunController;
