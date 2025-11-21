import Redis from 'ioredis';
import winston from 'winston';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [new winston.transports.Console()],
});

/**
 * Service for tracking active WebSocket sessions per user
 * Enables broadcasting updates to all of a user's active sessions
 */
export class SessionRegistry {
  private readonly SESSION_KEY_PREFIX = 'active_sessions:';
  private readonly SESSION_TTL = 7200; // 2 hours in seconds

  constructor(private redis: Redis) {}

  /**
   * Register a user's active WebSocket session
   *
   * @param userId - The user's ID
   * @param sessionId - The WebSocket session ID
   */
  async registerUserSession(userId: string, sessionId: string): Promise<void> {
    try {
      const key = `${this.SESSION_KEY_PREFIX}${userId}`;

      // Add session to user's set
      await this.redis.sadd(key, sessionId);

      // Update TTL to keep active sessions alive
      await this.redis.expire(key, this.SESSION_TTL);

      const sessionCount = await this.redis.scard(key);
      logger.info('[SessionRegistry] Registered user session', {
        userId,
        sessionId,
        totalActiveSessions: sessionCount,
      });
    } catch (error) {
      logger.error('[SessionRegistry] Error registering session', {
        userId,
        sessionId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Get all active sessions for a user
   *
   * @param userId - The user's ID
   * @returns Array of active session IDs
   */
  async getActiveSessionsForUser(userId: string): Promise<string[]> {
    try {
      const key = `${this.SESSION_KEY_PREFIX}${userId}`;
      const sessions = await this.redis.smembers(key);

      logger.info('[SessionRegistry] Retrieved active sessions', {
        userId,
        sessionCount: sessions.length,
      });

      return sessions;
    } catch (error) {
      logger.error('[SessionRegistry] Error getting active sessions', {
        userId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return [];
    }
  }

  /**
   * Unregister a user's WebSocket session
   * Call this when a session disconnects
   *
   * @param userId - The user's ID
   * @param sessionId - The WebSocket session ID
   */
  async unregisterUserSession(userId: string, sessionId: string): Promise<void> {
    try {
      const key = `${this.SESSION_KEY_PREFIX}${userId}`;

      // Remove session from user's set
      const removed = await this.redis.srem(key, sessionId);

      const sessionCount = await this.redis.scard(key);
      logger.info('[SessionRegistry] Unregistered user session', {
        userId,
        sessionId,
        wasRemoved: removed > 0,
        remainingActiveSessions: sessionCount,
      });

      // If no more sessions, delete the key
      if (sessionCount === 0) {
        await this.redis.del(key);
        logger.info('[SessionRegistry] Removed empty session set', { userId });
      }
    } catch (error) {
      logger.error('[SessionRegistry] Error unregistering session', {
        userId,
        sessionId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Check if a user has any active sessions
   *
   * @param userId - The user's ID
   * @returns True if user has active sessions
   */
  async hasActiveSessions(userId: string): Promise<boolean> {
    try {
      const key = `${this.SESSION_KEY_PREFIX}${userId}`;
      const count = await this.redis.scard(key);
      return count > 0;
    } catch (error) {
      logger.error('[SessionRegistry] Error checking active sessions', {
        userId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return false;
    }
  }

  /**
   * Get statistics about active sessions
   */
  async getSessionStats(): Promise<{
    totalActiveUsers: number;
    totalActiveSessions: number;
    usersWithMultipleSessions: number;
  }> {
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
    } catch (error) {
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

  /**
   * Clean up expired sessions (optional maintenance task)
   * Redis automatically handles TTL, but this can be used for manual cleanup
   */
  async cleanupExpiredSessions(): Promise<number> {
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
    } catch (error) {
      logger.error('[SessionRegistry] Error cleaning up sessions', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return 0;
    }
  }
}
