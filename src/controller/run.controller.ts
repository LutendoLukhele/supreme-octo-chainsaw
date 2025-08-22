// src/controllers/run.controller.ts

import { Router, Request, Response } from 'express';
import { RunManager } from '../services/tool/RunManager';
import { ToolOrchestrator } from '../services/tool/ToolOrchestrator';
import { StreamManager } from '../services/stream/StreamManager'; // Import StreamManager
import { ToolCall } from '../services/tool/tool.types';
import { Run } from '../services/tool/run.types'; // Import Run type
import winston from 'winston';
import { v4 as uuidv4 } from 'uuid';

export class RunController {
    public router: Router;
    private logger: winston.Logger;

    // Inject dependencies: ToolOrchestrator for execution, StreamManager for sending updates
    constructor(
        private toolOrchestrator: ToolOrchestrator,
        private streamManager: StreamManager
    ) {
        this.router = Router();
        this.logger = winston.createLogger({
            level: 'info',
            format: winston.format.json(),
            transports: [new winston.transports.Console()],
        });
        this.initializeRoutes();
    }

    private initializeRoutes(): void {
        // This route is for debugging, as the client should have the run data locally.
        this.router.get('/runs/:id', this.getRunById);
        this.router.post('/runs/export', this.handleExportAction);
    }

    /**
     * GET /runs/:id
     * This endpoint is now primarily for debugging purposes, as in the client-storage model,
     * the server is stateless regarding run history.
     */
    private getRunById = (req: Request, res: Response): void => {
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
    private handleExportAction = async (req: Request, res: Response): Promise<void> => {
        const { parentRun, toolName, arguments: toolArgs, userId, sessionId, connectionId } = req.body as {
            parentRun: Run;
            toolName: string;
            arguments: any;
            userId: string;
            sessionId: string;
            connectionId?: string;
        };

        this.logger.info('Received export action request', { parentRunId: parentRun?.id, toolName, userId, sessionId });

        // Basic validation
        if (!parentRun || !toolName || !toolArgs || !userId || !sessionId) {
            res.status(400).json({ error: 'Missing required fields: parentRun, toolName, arguments, userId, sessionId' });
            return;
        }

        // 1. Create the ToolCall object for the export action
        const exportToolCall: ToolCall = {
            id: uuidv4(),
            name: toolName,
            arguments: toolArgs,
            sessionId: sessionId,
            userId: ''
        };

        // 2. Create a new Run object in memory for this export action
        let exportRun = RunManager.createRun({
            sessionId: sessionId,
            userId: userId,
            userInput: `User initiated export: ${toolName}`,
            toolExecutionPlan: [{
                toolCall: exportToolCall, startedAt: new Date().toISOString(),
                status: '',
                finishedAt: ''
            }],
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
            exportRun = RunManager.startToolExecution(exportRun, exportToolCall.id);
            this.streamManager.sendChunk(sessionId, { type: 'run_updated', content: exportRun });

            const result = await this.toolOrchestrator.executeTool(exportToolCall);
            
            exportRun = RunManager.recordToolResult(exportRun, exportToolCall.id, result);
            this.streamManager.sendChunk(sessionId, { type: 'run_updated', content: exportRun });

        } catch (error: any) {
            this.logger.error('Export tool execution failed', { error: error.message, runId: exportRun.id });
            const errorResult = { status: 'failed', toolName, data: null, error: error.message } as const;
            exportRun = RunManager.recordToolResult(exportRun, exportToolCall.id, errorResult);
        } finally {
            // 4. Finalize the run and send the last update
            exportRun = RunManager.finalizeRun(exportRun);
            this.streamManager.sendChunk(sessionId, { type: 'run_updated', content: exportRun });
            this.logger.info('Export run processing finished.', { runId: exportRun.id, status: exportRun.status });
        }
    };
}
