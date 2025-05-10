// src/services/user-seed-status.store.ts (New File)
import { createClient, RedisClientType } from '@redis/client';
import winston from 'winston'; // Assuming you use winston elsewhere

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  defaultMeta: { service: 'UserSeedStatusStore' },
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(winston.format.colorize(), winston.format.simple()),
    }),
    // Add file transports if needed
  ],
});

export class UserSeedStatusStore {
  private redisClient: RedisClientType;
  private readonly userSeedPrefix = 'userseed:status:'; // Namespace for these keys
  private readonly seededFlag = 'initial_seeded_v1'; // Value or subkey to indicate seeded

  constructor(redisUrl: string) {
    this.redisClient = createClient({ url: redisUrl });

    this.redisClient.on('error', (err:any) => {
      logger.error('UserSeedStatusStore: Redis Client Error', { error: err });
    });
    this.redisClient.on('connect', () => {
      logger.info('UserSeedStatusStore: Connected to Redis.');
    });
    this.redisClient.on('reconnecting', () => {
      logger.info('UserSeedStatusStore: Reconnecting to Redis...');
    });
  }

  public async connect(): Promise<void> {
    if (!this.redisClient.isOpen) {
      try {
        await this.redisClient.connect();
      } catch (err) {
        logger.error('UserSeedStatusStore: Failed to connect to Redis during explicit connect()', { error: err });
        // Depending on your app's startup, you might want to throw or handle this more gracefully
      }
    }
  }

  public async disconnect(): Promise<void> {
    if (this.redisClient.isOpen) {
      await this.redisClient.quit();
      logger.info('UserSeedStatusStore: Disconnected from Redis.');
    }
  }

  async hasUserBeenSeeded(userId: string): Promise<boolean> {
    if (!userId) return false;
    try {
      if (!this.redisClient.isOpen) await this.connect(); // Ensure connection
      const status = await this.redisClient.get(`${this.userSeedPrefix}${userId}`);
      return status === this.seededFlag;
    } catch (error) {
      logger.error(`UserSeedStatusStore: Error checking seed status for userId ${userId}`, { error });
      return false; // Fail safe: assume not seeded if Redis error
    }
  }

  async markUserAsSeeded(userId: string): Promise<void> {
    if (!userId) return;
    try {
      if (!this.redisClient.isOpen) await this.connect(); // Ensure connection
      // Set with a very long expiry, or no expiry if "initial seed" is truly once-ever.
      // Example: 90 days: 90 * 24 * 60 * 60
      await this.redisClient.set(`${this.userSeedPrefix}${userId}`, this.seededFlag, {
        // EX: 90 * 24 * 60 * 60, // 90 days in seconds
      });
      logger.info(`UserSeedStatusStore: Marked userId ${userId} as seeded.`);
    } catch (error) {
      logger.error(`UserSeedStatusStore: Error marking seed status for userId ${userId}`, { error });
    }
  }
}
