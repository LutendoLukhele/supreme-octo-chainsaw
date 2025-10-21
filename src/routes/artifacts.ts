// src/routes/artifacts.ts

import express, { Request, Response } from 'express';
import { artifactGeneratorService } from '../services/artifact-generator.service';
import { codeInterpreterService } from '../services/code-interpreter.service';
import { sessionService } from '../services/session.service';

const router = express.Router();

router.post('/generate/code', async (req: Request, res: Response) => {
    try {
        const { prompt, language, context, sessionId, userId } = req.body as {
            prompt: string;
            language: string;
            context?: unknown;
            sessionId?: string;
            userId?: string;
        };

        const artifact = await artifactGeneratorService.generateCodeArtifact({
            prompt,
            language,
            context,
        });

        if (userId) artifact.userId = userId;
        if (sessionId) artifact.sessionId = sessionId;

        if (sessionId) {
            await sessionService.addArtifact(sessionId, artifact);
        }

        res.json(artifact);
    } catch (error: any) {
        res.status(500).json({ error: error?.message ?? 'Failed to generate code artifact' });
    }
});

router.post('/generate/analysis', async (req: Request, res: Response) => {
    try {
        const { data, analysisType, context, sessionId, userId } = req.body as {
            data: unknown;
            analysisType: string;
            context?: unknown;
            sessionId?: string;
            userId?: string;
        };

        const artifact = await artifactGeneratorService.generateAnalysisArtifact({
            data,
            analysisType,
            context,
        });

        if (userId) artifact.userId = userId;
        if (sessionId) artifact.sessionId = sessionId;

        if (sessionId) {
            await sessionService.addArtifact(sessionId, artifact);
        }

        res.json(artifact);
    } catch (error: any) {
        res.status(500).json({ error: error?.message ?? 'Failed to generate analysis artifact' });
    }
});

router.post('/generate/visualization', async (req: Request, res: Response) => {
    try {
        const { data, chartType, title, sessionId, userId } = req.body as {
            data: unknown;
            chartType: string;
            title: string;
            sessionId?: string;
            userId?: string;
        };

        const artifact = await artifactGeneratorService.generateVisualizationArtifact({
            data,
            chartType,
            title,
        });

        if (userId) artifact.userId = userId;
        if (sessionId) artifact.sessionId = sessionId;

        if (sessionId) {
            await sessionService.addArtifact(sessionId, artifact);
        }

        res.json(artifact);
    } catch (error: any) {
        res.status(500).json({ error: error?.message ?? 'Failed to generate visualization artifact' });
    }
});

router.post('/:artifactId/execute', async (req: Request, res: Response) => {
    try {
        const { artifactId } = req.params;
        const { artifact, context } = req.body as {
            artifact: {
                content: string;
                language: string;
                status?: string;
                metadata?: Record<string, any>;
            };
            context?: unknown;
        };

        if (!artifact) {
            res.status(400).json({ error: 'Artifact payload missing' });
            return;
        }

        const result = await codeInterpreterService.execute({
            code: artifact.content,
            language: artifact.language,
            context,
        });

        const updatedArtifact = {
            ...artifact,
            id: artifactId,
            executionResult: result,
            status: result.success ? 'completed' : 'error',
            metadata: {
                ...(artifact.metadata || {}),
                executionTimeMs: result.executionTime ?? null,
            },
        };

        res.json(updatedArtifact);
    } catch (error: any) {
        res.status(500).json({ error: error?.message ?? 'Failed to execute artifact' });
    }
});

export default router;
