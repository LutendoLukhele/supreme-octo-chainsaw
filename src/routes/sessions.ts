// src/routes/sessions.ts

import express, { Request, Response } from 'express';
import { sessionService } from '../services/session.service';

const router = express.Router();

router.post('/', async (req: Request, res: Response) => {
    try {
        const { userId, initialQuery } = req.body as { userId: string; initialQuery?: string };
        if (!userId) {
            res.status(400).json({ error: 'userId is required' });
            return;
        }

        const session = await sessionService.createSession(userId, initialQuery);
        res.json(session);
    } catch (error: any) {
        res.status(500).json({ error: error?.message ?? 'Failed to create session' });
    }
});

router.get('/:sessionId', async (req: Request, res: Response) => {
    try {
        const session = await sessionService.getSession(req.params.sessionId);
        if (!session) {
            res.status(404).json({ error: 'Session not found' });
            return;
        }
        res.json(session);
    } catch (error: any) {
        res.status(500).json({ error: error?.message ?? 'Failed to fetch session' });
    }
});

router.get('/user/:userId', async (req: Request, res: Response) => {
    try {
        const sessions = await sessionService.getUserSessions(req.params.userId);
        res.json(sessions);
    } catch (error: any) {
        res.status(500).json({ error: error?.message ?? 'Failed to fetch user sessions' });
    }
});

router.patch('/:sessionId', async (req: Request, res: Response) => {
    try {
        const session = await sessionService.updateSession(req.params.sessionId, req.body);
        res.json(session);
    } catch (error: any) {
        res.status(500).json({ error: error?.message ?? 'Failed to update session' });
    }
});

router.delete('/:sessionId', async (req: Request, res: Response) => {
    try {
        await sessionService.deleteSession(req.params.sessionId);
        res.json({ success: true });
    } catch (error: any) {
        res.status(500).json({ error: error?.message ?? 'Failed to delete session' });
    }
});

router.post('/:sessionId/messages', async (req: Request, res: Response) => {
    try {
        const session = await sessionService.addMessage(req.params.sessionId, req.body);
        res.json(session);
    } catch (error: any) {
        res.status(500).json({ error: error?.message ?? 'Failed to add message to session' });
    }
});

export default router;
