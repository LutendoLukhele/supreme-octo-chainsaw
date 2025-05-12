"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.UserSeedStatusStore = void 0;
// src/services/user-seed-status.store.ts (New File)
const client_1 = require("@redis/client");
const winston_1 = __importDefault(require("winston")); // Assuming you use winston elsewhere
const logger = winston_1.default.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston_1.default.format.combine(winston_1.default.format.timestamp(), winston_1.default.format.json()),
    defaultMeta: { service: 'UserSeedStatusStore' },
    transports: [
        new winston_1.default.transports.Console({
            format: winston_1.default.format.combine(winston_1.default.format.colorize(), winston_1.default.format.simple()),
        }),
        // Add file transports if needed
    ],
});
class UserSeedStatusStore {
    redisClient;
    userSeedPrefix = 'userseed:status:'; // Namespace for these keys
    seededFlag = 'initial_seeded_v1'; // Value or subkey to indicate seeded
    constructor(redisUrl) {
        this.redisClient = (0, client_1.createClient)({ url: redisUrl });
        this.redisClient.on('error', (err) => {
            logger.error('UserSeedStatusStore: Redis Client Error', { error: err });
        });
        this.redisClient.on('connect', () => {
            logger.info('UserSeedStatusStore: Connected to Redis.');
        });
        this.redisClient.on('reconnecting', () => {
            logger.info('UserSeedStatusStore: Reconnecting to Redis...');
        });
    }
    async connect() {
        if (!this.redisClient.isOpen) {
            try {
                await this.redisClient.connect();
            }
            catch (err) {
                logger.error('UserSeedStatusStore: Failed to connect to Redis during explicit connect()', { error: err });
                // Depending on your app's startup, you might want to throw or handle this more gracefully
            }
        }
    }
    async disconnect() {
        if (this.redisClient.isOpen) {
            await this.redisClient.quit();
            logger.info('UserSeedStatusStore: Disconnected from Redis.');
        }
    }
    async hasUserBeenSeeded(userId) {
        if (!userId)
            return false;
        try {
            if (!this.redisClient.isOpen)
                await this.connect(); // Ensure connection
            const status = await this.redisClient.get(`${this.userSeedPrefix}${userId}`);
            return status === this.seededFlag;
        }
        catch (error) {
            logger.error(`UserSeedStatusStore: Error checking seed status for userId ${userId}`, { error });
            return false; // Fail safe: assume not seeded if Redis error
        }
    }
    async markUserAsSeeded(userId) {
        if (!userId)
            return;
        try {
            if (!this.redisClient.isOpen)
                await this.connect(); // Ensure connection
            // Set with a very long expiry, or no expiry if "initial seed" is truly once-ever.
            // Example: 90 days: 90 * 24 * 60 * 60
            await this.redisClient.set(`${this.userSeedPrefix}${userId}`, this.seededFlag, {
            // EX: 90 * 24 * 60 * 60, // 90 days in seconds
            });
            logger.info(`UserSeedStatusStore: Marked userId ${userId} as seeded.`);
        }
        catch (error) {
            logger.error(`UserSeedStatusStore: Error marking seed status for userId ${userId}`, { error });
        }
    }
}
exports.UserSeedStatusStore = UserSeedStatusStore;
