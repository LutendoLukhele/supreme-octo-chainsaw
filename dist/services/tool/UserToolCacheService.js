"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.UserToolCacheService = void 0;
const winston_1 = __importDefault(require("winston"));
const logger = winston_1.default.createLogger({
    level: 'info',
    format: winston_1.default.format.combine(winston_1.default.format.timestamp(), winston_1.default.format.json()),
    transports: [new winston_1.default.transports.Console()],
});
class UserToolCacheService {
    constructor(redis) {
        this.redis = redis;
        this.CACHE_KEY_PREFIX = 'user_tools:';
        this.CACHE_TTL = 300;
    }
    async getCachedAvailableTools(userId) {
        try {
            const cacheKey = `${this.CACHE_KEY_PREFIX}${userId}`;
            const cached = await this.redis.get(cacheKey);
            if (cached) {
                logger.info('[UserToolCacheService] Cache hit for user tools', { userId });
                return JSON.parse(cached);
            }
            logger.info('[UserToolCacheService] Cache miss for user tools', { userId });
            return null;
        }
        catch (error) {
            logger.error('[UserToolCacheService] Error getting cached tools', {
                userId,
                error: error instanceof Error ? error.message : 'Unknown error',
            });
            return null;
        }
    }
    async setCachedAvailableTools(userId, tools) {
        try {
            const cacheKey = `${this.CACHE_KEY_PREFIX}${userId}`;
            await this.redis.setex(cacheKey, this.CACHE_TTL, JSON.stringify(tools));
            logger.info('[UserToolCacheService] Cached user tools', {
                userId,
                toolCount: tools.length,
                ttl: this.CACHE_TTL,
            });
        }
        catch (error) {
            logger.error('[UserToolCacheService] Error caching tools', {
                userId,
                error: error instanceof Error ? error.message : 'Unknown error',
            });
        }
    }
    async invalidateUserToolCache(userId) {
        try {
            const cacheKey = `${this.CACHE_KEY_PREFIX}${userId}`;
            const deleted = await this.redis.del(cacheKey);
            logger.info('[UserToolCacheService] Invalidated user tool cache', {
                userId,
                wasDeleted: deleted > 0,
            });
        }
        catch (error) {
            logger.error('[UserToolCacheService] Error invalidating cache', {
                userId,
                error: error instanceof Error ? error.message : 'Unknown error',
            });
        }
    }
    async getCacheStats() {
        try {
            const pattern = `${this.CACHE_KEY_PREFIX}*`;
            const keys = await this.redis.keys(pattern);
            return {
                totalCachedUsers: keys.length,
                cacheKeys: keys,
            };
        }
        catch (error) {
            logger.error('[UserToolCacheService] Error getting cache stats', {
                error: error instanceof Error ? error.message : 'Unknown error',
            });
            return {
                totalCachedUsers: 0,
                cacheKeys: [],
            };
        }
    }
    async clearAllCaches() {
        try {
            const pattern = `${this.CACHE_KEY_PREFIX}*`;
            const keys = await this.redis.keys(pattern);
            if (keys.length === 0) {
                logger.info('[UserToolCacheService] No caches to clear');
                return 0;
            }
            const deleted = await this.redis.del(...keys);
            logger.info('[UserToolCacheService] Cleared all tool caches', {
                deletedCount: deleted,
            });
            return deleted;
        }
        catch (error) {
            logger.error('[UserToolCacheService] Error clearing all caches', {
                error: error instanceof Error ? error.message : 'Unknown error',
            });
            return 0;
        }
    }
}
exports.UserToolCacheService = UserToolCacheService;
