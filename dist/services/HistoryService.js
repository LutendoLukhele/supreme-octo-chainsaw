"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.HistoryService = exports.HistoryItemType = void 0;
const winston_1 = __importDefault(require("winston"));
const uuid_1 = require("uuid");
const logger = winston_1.default.createLogger({
    level: 'info',
    format: winston_1.default.format.combine(winston_1.default.format.timestamp(), winston_1.default.format.json()),
    transports: [new winston_1.default.transports.Console()],
});
var HistoryItemType;
(function (HistoryItemType) {
    HistoryItemType["PLAN"] = "plan";
    HistoryItemType["TOOL_CALL"] = "tool_call";
    HistoryItemType["MESSAGE"] = "message";
})(HistoryItemType || (exports.HistoryItemType = HistoryItemType = {}));
class HistoryService {
    constructor(redisClient) {
        this.HISTORY_KEY_PREFIX = 'user_history:';
        this.MAX_HISTORY_ITEMS = 100;
        this.redis = redisClient;
        logger.info('HistoryService initialized');
    }
    async addHistoryItem(userId, itemType, data, sessionId) {
        const historyId = `hist_${(0, uuid_1.v4)()}`;
        const timestamp = new Date().toISOString();
        const historyItem = {
            id: historyId,
            itemType,
            timestamp,
            userId,
            sessionId,
            data,
        };
        try {
            const key = `${this.HISTORY_KEY_PREFIX}${userId}`;
            await this.redis.zadd(key, Date.now(), JSON.stringify(historyItem));
            await this.redis.zremrangebyrank(key, 0, -(this.MAX_HISTORY_ITEMS + 1));
            logger.info('History item added', { userId, historyId, itemType });
            return historyId;
        }
        catch (error) {
            logger.error('Failed to add history item', {
                userId,
                itemType,
                error: error.message
            });
            throw error;
        }
    }
    async getUserHistory(userId, limit = 50, offset = 0) {
        try {
            const key = `${this.HISTORY_KEY_PREFIX}${userId}`;
            const items = await this.redis.zrevrange(key, offset, offset + limit - 1);
            const historyItems = items.map(item => JSON.parse(item));
            logger.info('Retrieved user history', {
                userId,
                count: historyItems.length
            });
            return historyItems;
        }
        catch (error) {
            logger.error('Failed to retrieve user history', {
                userId,
                error: error.message
            });
            throw error;
        }
    }
    async getHistoryItem(userId, historyId) {
        try {
            const key = `${this.HISTORY_KEY_PREFIX}${userId}`;
            const items = await this.redis.zrange(key, 0, -1);
            const found = items.find(item => {
                const parsed = JSON.parse(item);
                return parsed.id === historyId;
            });
            return found ? JSON.parse(found) : null;
        }
        catch (error) {
            logger.error('Failed to get history item', {
                userId,
                historyId,
                error: error.message
            });
            return null;
        }
    }
    async updateHistoryItem(userId, historyId, updates) {
        try {
            const key = `${this.HISTORY_KEY_PREFIX}${userId}`;
            const items = await this.redis.zrange(key, 0, -1);
            const itemIndex = items.findIndex(item => {
                const parsed = JSON.parse(item);
                return parsed.id === historyId;
            });
            if (itemIndex === -1) {
                logger.warn('History item not found for update', { userId, historyId });
                return false;
            }
            const item = JSON.parse(items[itemIndex]);
            item.data = { ...item.data, ...updates };
            await this.redis.zrem(key, items[itemIndex]);
            const timestamp = new Date(item.timestamp).getTime();
            await this.redis.zadd(key, timestamp, JSON.stringify(item));
            logger.info('History item updated', { userId, historyId });
            return true;
        }
        catch (error) {
            logger.error('Failed to update history item', {
                userId,
                historyId,
                error: error.message
            });
            return false;
        }
    }
    async deleteUserHistory(userId) {
        try {
            const key = `${this.HISTORY_KEY_PREFIX}${userId}`;
            await this.redis.del(key);
            logger.info('User history deleted', { userId });
            return true;
        }
        catch (error) {
            logger.error('Failed to delete user history', {
                userId,
                error: error.message
            });
            return false;
        }
    }
    async recordUserMessage(userId, sessionId, messageText) {
        return this.addHistoryItem(userId, HistoryItemType.MESSAGE, {
            text: messageText,
            role: 'user',
        }, sessionId);
    }
    async recordAssistantMessage(userId, sessionId, messageText) {
        return this.addHistoryItem(userId, HistoryItemType.MESSAGE, {
            text: messageText,
            role: 'assistant',
        }, sessionId);
    }
    async recordPlanCreation(userId, sessionId, planId, planTitle, actions) {
        return this.addHistoryItem(userId, HistoryItemType.PLAN, {
            planTitle,
            status: 'pending',
            actionCount: actions.length,
            planId,
            actions,
        }, sessionId);
    }
    async recordToolCall(userId, sessionId, toolName, summary, args, result, status = 'success', stepId, planId) {
        return this.addHistoryItem(userId, HistoryItemType.TOOL_CALL, {
            toolName,
            status,
            summary,
            arguments: args,
            result,
            stepId,
            planId,
        }, sessionId);
    }
}
exports.HistoryService = HistoryService;
