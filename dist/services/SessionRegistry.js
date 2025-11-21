"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SessionRegistry = void 0;
const winston_1 = __importDefault(require("winston"));
const logger = winston_1.default.createLogger({
    level: 'info',
    format: winston_1.default.format.combine(winston_1.default.format.timestamp(), winston_1.default.format.json()),
    transports: [new winston_1.default.transports.Console()],
});
class SessionRegistry {
    constructor(redis) {
        this.redis = redis;
        this.SESSION_KEY_PREFIX = 'active_sessions:';
        this.SESSION_TTL = 7200;
    }
    async registerUserSession(userId, sessionId) {
        try {
            const key = `${this.SESSION_KEY_PREFIX}${userId}`;
            await this.redis.sadd(key, sessionId);
            await this.redis.expire(key, this.SESSION_TTL);
            const sessionCount = await this.redis.scard(key);
            logger.info('[SessionRegistry] Registered user session', {
                userId,
                sessionId,
                totalActiveSessions: sessionCount,
            });
        }
        catch (error) {
            logger.error('[SessionRegistry] Error registering session', {
                userId,
                sessionId,
                error: error instanceof Error ? error.message : 'Unknown error',
            });
        }
    }
    async getActiveSessionsForUser(userId) {
        try {
            const key = `${this.SESSION_KEY_PREFIX}${userId}`;
            const sessions = await this.redis.smembers(key);
            logger.info('[SessionRegistry] Retrieved active sessions', {
                userId,
                sessionCount: sessions.length,
            });
            return sessions;
        }
        catch (error) {
            logger.error('[SessionRegistry] Error getting active sessions', {
                userId,
                error: error instanceof Error ? error.message : 'Unknown error',
            });
            return [];
        }
    }
    async unregisterUserSession(userId, sessionId) {
        try {
            const key = `${this.SESSION_KEY_PREFIX}${userId}`;
            const removed = await this.redis.srem(key, sessionId);
            const sessionCount = await this.redis.scard(key);
            logger.info('[SessionRegistry] Unregistered user session', {
                userId,
                sessionId,
                wasRemoved: removed > 0,
                remainingActiveSessions: sessionCount,
            });
            if (sessionCount === 0) {
                await this.redis.del(key);
                logger.info('[SessionRegistry] Removed empty session set', { userId });
            }
        }
        catch (error) {
            logger.error('[SessionRegistry] Error unregistering session', {
                userId,
                sessionId,
                error: error instanceof Error ? error.message : 'Unknown error',
            });
        }
    }
    async hasActiveSessions(userId) {
        try {
            const key = `${this.SESSION_KEY_PREFIX}${userId}`;
            const count = await this.redis.scard(key);
            return count > 0;
        }
        catch (error) {
            logger.error('[SessionRegistry] Error checking active sessions', {
                userId,
                error: error instanceof Error ? error.message : 'Unknown error',
            });
            return false;
        }
    }
    async getSessionStats() {
        try {
            const pattern = `${this.SESSION_KEY_PREFIX}*`;
            const keys = await this.redis.keys(pattern);
            let totalSessions = 0;
            let usersWithMultiple = 0;
            for (const key of keys) {
                const count = await this.redis.scard(key);
                totalSessions += count;
                if (count > 1) {
                    usersWithMultiple++;
                }
            }
            return {
                totalActiveUsers: keys.length,
                totalActiveSessions: totalSessions,
                usersWithMultipleSessions: usersWithMultiple,
            };
        }
        catch (error) {
            logger.error('[SessionRegistry] Error getting session stats', {
                error: error instanceof Error ? error.message : 'Unknown error',
            });
            return {
                totalActiveUsers: 0,
                totalActiveSessions: 0,
                usersWithMultipleSessions: 0,
            };
        }
    }
    async cleanupExpiredSessions() {
        try {
            const pattern = `${this.SESSION_KEY_PREFIX}*`;
            const keys = await this.redis.keys(pattern);
            let cleaned = 0;
            for (const key of keys) {
                const count = await this.redis.scard(key);
                if (count === 0) {
                    await this.redis.del(key);
                    cleaned++;
                }
            }
            if (cleaned > 0) {
                logger.info('[SessionRegistry] Cleaned up empty session sets', {
                    cleanedCount: cleaned,
                });
            }
            return cleaned;
        }
        catch (error) {
            logger.error('[SessionRegistry] Error cleaning up sessions', {
                error: error instanceof Error ? error.message : 'Unknown error',
            });
            return 0;
        }
    }
}
exports.SessionRegistry = SessionRegistry;
