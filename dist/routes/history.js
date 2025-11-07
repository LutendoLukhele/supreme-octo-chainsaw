"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const HistoryService_1 = require("../services/HistoryService");
const firebase_1 = require("../firebase");
const winston_1 = __importDefault(require("winston"));
const router = express_1.default.Router();
const logger = winston_1.default.createLogger({
    level: 'info',
    format: winston_1.default.format.combine(winston_1.default.format.timestamp(), winston_1.default.format.json()),
    transports: [new winston_1.default.transports.Console()],
});
async function authenticateUser(req, res, next) {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Unauthorized: No token provided' });
        }
        const idToken = authHeader.split('Bearer ')[1];
        const decodedToken = await firebase_1.auth.verifyIdToken(idToken);
        req.userId = decodedToken.uid;
        next();
    }
    catch (error) {
        logger.error('Authentication failed', { error: error.message });
        return res.status(401).json({ error: 'Unauthorized: Invalid token' });
    }
}
router.use(authenticateUser);
router.get('/', async (req, res) => {
    try {
        const userId = req.userId;
        const limit = parseInt(req.query.limit) || 50;
        const offset = parseInt(req.query.offset) || 0;
        const historyService = req.app.locals.historyService;
        if (!historyService) {
            throw new Error('HistoryService not initialized');
        }
        const history = await historyService.getUserHistory(userId, limit, offset);
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
    }
    catch (error) {
        logger.error('Failed to fetch user history', { error: error.message });
        res.status(500).json({ error: 'Failed to fetch history' });
    }
});
router.get('/:historyId', async (req, res) => {
    try {
        const userId = req.userId;
        const { historyId } = req.params;
        const historyService = req.app.locals.historyService;
        const item = await historyService.getHistoryItem(userId, historyId);
        if (!item) {
            return res.status(404).json({ error: 'History item not found' });
        }
        res.json(item);
    }
    catch (error) {
        logger.error('Failed to fetch history item', {
            error: error.message,
            historyId: req.params.historyId
        });
        res.status(500).json({ error: 'Failed to fetch history item' });
    }
});
router.delete('/', async (req, res) => {
    try {
        const userId = req.userId;
        const historyService = req.app.locals.historyService;
        const success = await historyService.deleteUserHistory(userId);
        if (success) {
            res.json({ message: 'History deleted successfully' });
        }
        else {
            res.status(500).json({ error: 'Failed to delete history' });
        }
    }
    catch (error) {
        logger.error('Failed to delete user history', { error: error.message });
        res.status(500).json({ error: 'Failed to delete history' });
    }
});
router.post('/replay/:historyId', async (req, res) => {
    try {
        const userId = req.userId;
        const { historyId } = req.params;
        const historyService = req.app.locals.historyService;
        const item = await historyService.getHistoryItem(userId, historyId);
        if (!item || item.itemType !== HistoryService_1.HistoryItemType.PLAN) {
            return res.status(404).json({ error: 'Plan not found in history' });
        }
        res.json({
            message: 'Plan ready for replay',
            plan: item.data,
            historyItem: item,
        });
    }
    catch (error) {
        logger.error('Failed to replay plan', { error: error.message });
        res.status(500).json({ error: 'Failed to replay plan' });
    }
});
exports.default = router;
