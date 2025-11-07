// src/routes/history.ts

import express, { Request, Response } from 'express';
import { HistoryService, HistoryItemType } from '../services/HistoryService';
import { auth as firebaseAdminAuth } from '../firebase';
import winston from 'winston';

const router = express.Router();

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [new winston.transports.Console()],
});

// Middleware to verify Firebase token and extract userId
async function authenticateUser(req: Request, res: Response, next: Function) {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized: No token provided' });
    }

    const idToken = authHeader.split('Bearer ')[1];
    const decodedToken = await firebaseAdminAuth.verifyIdToken(idToken);
    
    // Attach userId to request
    (req as any).userId = decodedToken.uid;
    
    next();
  } catch (error: any) {
    logger.error('Authentication failed', { error: error.message });
    return res.status(401).json({ error: 'Unauthorized: Invalid token' });
  }
}

// Apply authentication middleware to all routes
router.use(authenticateUser);

/**
 * GET /api/history
 * Get user's history items
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;
    
    // historyService will be injected when mounting the router
    const historyService = (req.app as any).locals.historyService as HistoryService;
    
    if (!historyService) {
      throw new Error('HistoryService not initialized');
    }

    const history = await historyService.getUserHistory(userId, limit, offset);
    
    // Format response according to frontend contract
    const response = {
      history: history.map(item => ({
        id: item.id,
        itemType: item.itemType,
        timestamp: item.timestamp,
        sessionId: item.sessionId,
        data: item.data,
      })),
      pagination: {
        limit,
        offset,
        total: history.length,
      }
    };

    res.json(response);
  } catch (error: any) {
    logger.error('Failed to fetch user history', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});

/**
 * GET /api/history/:historyId
 * Get a specific history item
 */
router.get('/:historyId', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const { historyId } = req.params;
    
    const historyService = (req.app as any).locals.historyService as HistoryService;
    
    const item = await historyService.getHistoryItem(userId, historyId);
    
    if (!item) {
      return res.status(404).json({ error: 'History item not found' });
    }

    res.json(item);
  } catch (error: any) {
    logger.error('Failed to fetch history item', { 
      error: error.message,
      historyId: req.params.historyId 
    });
    res.status(500).json({ error: 'Failed to fetch history item' });
  }
});

/**
 * DELETE /api/history
 * Delete all history for the user
 */
router.delete('/', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const historyService = (req.app as any).locals.historyService as HistoryService;
    
    const success = await historyService.deleteUserHistory(userId);
    
    if (success) {
      res.json({ message: 'History deleted successfully' });
    } else {
      res.status(500).json({ error: 'Failed to delete history' });
    }
  } catch (error: any) {
    logger.error('Failed to delete user history', { error: error.message });
    res.status(500).json({ error: 'Failed to delete history' });
  }
});

/**
 * POST /api/history/replay/:historyId
 * Replay a plan from history
 */
router.post('/replay/:historyId', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const { historyId } = req.params;
    
    const historyService = (req.app as any).locals.historyService as HistoryService;
    const item = await historyService.getHistoryItem(userId, historyId);
    
    if (!item || item.itemType !== HistoryItemType.PLAN) {
      return res.status(404).json({ error: 'Plan not found in history' });
    }

    // Return the plan data so the frontend can replay it
    res.json({
      message: 'Plan ready for replay',
      plan: item.data,
      historyItem: item,
    });
  } catch (error: any) {
    logger.error('Failed to replay plan', { error: error.message });
    res.status(500).json({ error: 'Failed to replay plan' });
  }
});

export default router