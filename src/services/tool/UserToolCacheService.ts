import Redis from 'ioredis';
import winston from 'winston';
import { ToolConfig } from './ToolConfigManager';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [new winston.transports.Console()],
});

/**
 * Service for caching user's available tools in Redis
 * Reduces database load by caching tool lists with TTL
 */
export class UserToolCacheService {
  private readonly CACHE_KEY_PREFIX = 'user_tools:';
  private readonly CACHE_TTL = 300; // 5 minutes in seconds

  constructor(private redis: Redis) {}

  /**
   * Get cached available tools for a user
   *
   * @param userId - The user's ID
   * @returns Cached tool configurations or null if not cached
   */
  async getCachedAvailableTools(userId: string): Promise<ToolConfig[] | null> {
    try {
      const cacheKey = `${this.CACHE_KEY_PREFIX}${userId}`;
      const cached = await this.redis.get(cacheKey);

      if (cached) {
        logger.info('[UserToolCacheService] Cache hit for user tools', { userId });
        return JSON.parse(cached) as ToolConfig[];
      }

      logger.info('[UserToolCacheService] Cache miss for user tools', { userId });
      return null;
    } catch (error) {
      logger.error('[UserToolCacheService] Error getting cached tools', {
        userId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return null; // Fail gracefully, will query database
    }
  }

  /**
   * Cache available tools for a user
   *
   * @param userId - The user's ID
   * @param tools - Array of tool configurations to cache
   */
  async setCachedAvailableTools(userId: string, tools: ToolConfig[]): Promise<void> {
    try {
      const cacheKey = `${this.CACHE_KEY_PREFIX}${userId}`;
      await this.redis.setex(
        cacheKey,
        this.CACHE_TTL,
        JSON.stringify(tools)
      );

      logger.info('[UserToolCacheService] Cached user tools', {
        userId,
        toolCount: tools.length,
        ttl: this.CACHE_TTL,
      });
    } catch (error) {
      logger.error('[UserToolCacheService] Error caching tools', {
        userId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      // Don't throw - caching failures shouldn't break the application
    }
  }

  /**
   * Invalidate cached tools for a user
   * Call this when user's provider connections change
   *
   * @param userId - The user's ID
   */
  async invalidateUserToolCache(userId: string): Promise<void> {
    try {
      const cacheKey = `${this.CACHE_KEY_PREFIX}${userId}`;
      const deleted = await this.redis.del(cacheKey);

      logger.info('[UserToolCacheService] Invalidated user tool cache', {
        userId,
        wasDeleted: deleted > 0,
      });
    } catch (error) {
      logger.error('[UserToolCacheService] Error invalidating cache', {
        userId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Get cache statistics for monitoring
   */
  async getCacheStats(): Promise<{
    totalCachedUsers: number;
    cacheKeys: string[];
  }> {
    try {
      const pattern = `${this.CACHE_KEY_PREFIX}*`;
      const keys = await this.redis.keys(pattern);

      return {
        totalCachedUsers: keys.length,
        cacheKeys: keys,
      };
    } catch (error) {
      logger.error('[UserToolCacheService] Error getting cache stats', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return {
        totalCachedUsers: 0,
        cacheKeys: [],
      };
    }
  }

  /**
   * Clear all cached tools (useful for maintenance)
   */
  async clearAllCaches(): Promise<number> {
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
    } catch (error) {
      logger.error('[UserToolCacheService] Error clearing all caches', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return 0;
    }
  }
}
