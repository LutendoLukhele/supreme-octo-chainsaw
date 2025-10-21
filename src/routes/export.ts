// src/routes/export.ts

import express, { Request, Response } from 'express';
import { exportService, ExportDestination, ExportFormat } from '../services/export.service';
import { InterpretiveResponse } from '../models/interpretive.model';

const router = express.Router();

router.post('/:destination', async (req: Request, res: Response) => {
    try {
        const destination = req.params.destination as ExportDestination;
        const { content, format, userId, config } = req.body as {
            content: InterpretiveResponse;
            format?: ExportFormat;
            userId: string;
            config?: Record<string, unknown>;
        };

        if (!content || !userId) {
            res.status(400).json({ error: 'content and userId are required' });
            return;
        }

        const result = await exportService.export(
            content,
            destination,
            format ?? 'markdown',
            userId,
            (config ?? {}) as any,
        );

        res.json(result);
    } catch (error: any) {
        res.status(500).json({
            success: false,
            error: error?.message ?? 'Export failed',
            message: 'Export failed',
            timestamp: new Date().toISOString(),
        });
    }
});

export default router;
