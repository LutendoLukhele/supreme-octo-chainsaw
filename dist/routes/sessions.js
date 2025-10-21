"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const session_service_1 = require("../services/session.service");
const router = express_1.default.Router();
router.post('/', async (req, res) => {
    try {
        const { userId, initialQuery } = req.body;
        if (!userId) {
            res.status(400).json({ error: 'userId is required' });
            return;
        }
        const session = await session_service_1.sessionService.createSession(userId, initialQuery);
        res.json(session);
    }
    catch (error) {
        res.status(500).json({ error: error?.message ?? 'Failed to create session' });
    }
});
router.get('/:sessionId', async (req, res) => {
    try {
        const session = await session_service_1.sessionService.getSession(req.params.sessionId);
        if (!session) {
            res.status(404).json({ error: 'Session not found' });
            return;
        }
        res.json(session);
    }
    catch (error) {
        res.status(500).json({ error: error?.message ?? 'Failed to fetch session' });
    }
});
router.get('/user/:userId', async (req, res) => {
    try {
        const sessions = await session_service_1.sessionService.getUserSessions(req.params.userId);
        res.json(sessions);
    }
    catch (error) {
        res.status(500).json({ error: error?.message ?? 'Failed to fetch user sessions' });
    }
});
router.patch('/:sessionId', async (req, res) => {
    try {
        const session = await session_service_1.sessionService.updateSession(req.params.sessionId, req.body);
        res.json(session);
    }
    catch (error) {
        res.status(500).json({ error: error?.message ?? 'Failed to update session' });
    }
});
router.delete('/:sessionId', async (req, res) => {
    try {
        await session_service_1.sessionService.deleteSession(req.params.sessionId);
        res.json({ success: true });
    }
    catch (error) {
        res.status(500).json({ error: error?.message ?? 'Failed to delete session' });
    }
});
router.post('/:sessionId/messages', async (req, res) => {
    try {
        const session = await session_service_1.sessionService.addMessage(req.params.sessionId, req.body);
        res.json(session);
    }
    catch (error) {
        res.status(500).json({ error: error?.message ?? 'Failed to add message to session' });
    }
});
exports.default = router;
