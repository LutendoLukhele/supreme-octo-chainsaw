"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const artifact_generator_service_1 = require("../services/artifact-generator.service");
const code_interpreter_service_1 = require("../services/code-interpreter.service");
const session_service_1 = require("../services/session.service");
const router = express_1.default.Router();
router.post('/generate/code', async (req, res) => {
    try {
        const { prompt, language, context, sessionId, userId } = req.body;
        const artifact = await artifact_generator_service_1.artifactGeneratorService.generateCodeArtifact({
            prompt,
            language,
            context,
        });
        if (userId)
            artifact.userId = userId;
        if (sessionId)
            artifact.sessionId = sessionId;
        if (sessionId) {
            await session_service_1.sessionService.addArtifact(sessionId, artifact);
        }
        res.json(artifact);
    }
    catch (error) {
        res.status(500).json({ error: error?.message ?? 'Failed to generate code artifact' });
    }
});
router.post('/generate/analysis', async (req, res) => {
    try {
        const { data, analysisType, context, sessionId, userId } = req.body;
        const artifact = await artifact_generator_service_1.artifactGeneratorService.generateAnalysisArtifact({
            data,
            analysisType,
            context,
        });
        if (userId)
            artifact.userId = userId;
        if (sessionId)
            artifact.sessionId = sessionId;
        if (sessionId) {
            await session_service_1.sessionService.addArtifact(sessionId, artifact);
        }
        res.json(artifact);
    }
    catch (error) {
        res.status(500).json({ error: error?.message ?? 'Failed to generate analysis artifact' });
    }
});
router.post('/generate/visualization', async (req, res) => {
    try {
        const { data, chartType, title, sessionId, userId } = req.body;
        const artifact = await artifact_generator_service_1.artifactGeneratorService.generateVisualizationArtifact({
            data,
            chartType,
            title,
        });
        if (userId)
            artifact.userId = userId;
        if (sessionId)
            artifact.sessionId = sessionId;
        if (sessionId) {
            await session_service_1.sessionService.addArtifact(sessionId, artifact);
        }
        res.json(artifact);
    }
    catch (error) {
        res.status(500).json({ error: error?.message ?? 'Failed to generate visualization artifact' });
    }
});
router.post('/:artifactId/execute', async (req, res) => {
    try {
        const { artifactId } = req.params;
        const { artifact, context } = req.body;
        if (!artifact) {
            res.status(400).json({ error: 'Artifact payload missing' });
            return;
        }
        const result = await code_interpreter_service_1.codeInterpreterService.execute({
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
    }
    catch (error) {
        res.status(500).json({ error: error?.message ?? 'Failed to execute artifact' });
    }
});
exports.default = router;
