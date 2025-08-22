"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.UserSeedStatusStore = void 0;
const client_1 = require("@redis/client");
const winston_1 = __importDefault(require("winston"));
const logger = winston_1.default.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston_1.default.format.combine(winston_1.default.format.timestamp(), winston_1.default.format.json()),
    defaultMeta: { service: 'UserSeedStatusStore' },
    transports: [
        new winston_1.default.transports.Console({
            format: winston_1.default.format.combine(winston_1.default.format.colorize(), winston_1.default.format.simple()),
        }),
    ],
});
class UserSeedStatusStore {
    constructor(redisUrl) {
        this.userSeedPrefix = 'userseed:status:';
        this.seededFlag = 'initial_seeded_v1';
        this.redisClient = (0, client_1.createClient)({ url: redisUrl });
        this.redisClient.on('error', (err) => {
            logger.debug('UserSeedStatusStore: Redis Client Error', { error: err });
        });
        this.redisClient.on('connect', () => {
            logger.info('UserSeedStatusStore: Connected to Redis.');
        });
        this.redisClient.on('reconnecting', () => {
            logger.debug('UserSeedStatusStore: Reconnecting to Redis...');
        });
    }
    async connect() {
        if (!this.redisClient.isOpen) {
            try {
                await this.redisClient.connect();
            }
            catch (err) {
                logger.debug('UserSeedStatusStore: Failed to connect to Redis during explicit connect()', { error: err });
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
                await this.connect();
            const status = await this.redisClient.get(`${this.userSeedPrefix}${userId}`);
            return status === this.seededFlag;
        }
        catch (error) {
            logger.debug(`UserSeedStatusStore: Error checking seed status for userId ${userId}`, { error });
            return false;
        }
    }
    async markUserAsSeeded(userId) {
        if (!userId)
            return;
        try {
            if (!this.redisClient.isOpen)
                await this.connect();
            await this.redisClient.set(`${this.userSeedPrefix}${userId}`, this.seededFlag, {});
            logger.info(`UserSeedStatusStore: Marked userId ${userId} as seeded.`);
        }
        catch (error) {
            logger.debug(`UserSeedStatusStore: Error marking seed status for userId ${userId}`, { error });
        }
    }
}
exports.UserSeedStatusStore = UserSeedStatusStore;
