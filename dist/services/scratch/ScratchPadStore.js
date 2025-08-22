"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ScratchPadStore = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const winston_1 = __importDefault(require("winston"));
const logger = winston_1.default.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston_1.default.format.combine(winston_1.default.format.timestamp(), winston_1.default.format.json()),
    defaultMeta: { service: 'ScratchPadStore' },
    transports: [
        new winston_1.default.transports.Console({ format: winston_1.default.format.simple() }),
    ],
});
const dataDir = path_1.default.join(process.cwd(), '.data');
const storeFilePath = path_1.default.join(dataDir, 'scratchpad-store.json');
class ScratchPadStore {
    constructor() {
        this.store = new Map();
        this.ensureDataDirExists();
        this.loadFromFile();
        logger.info('ScratchPadStore initialized with file-based persistence.');
    }
    ensureDataDirExists() {
        if (!fs_1.default.existsSync(dataDir)) {
            fs_1.default.mkdirSync(dataDir, { recursive: true });
            logger.info(`Created data directory: ${dataDir}`);
        }
    }
    loadFromFile() {
        try {
            if (fs_1.default.existsSync(storeFilePath)) {
                const data = fs_1.default.readFileSync(storeFilePath, 'utf-8');
                const plainObject = JSON.parse(data);
                this.store = new Map(Object.entries(plainObject));
                logger.info(`Loaded scratchpad data from ${storeFilePath}`);
            }
            else {
                logger.info(`No existing scratchpad data file found at ${storeFilePath}. Starting fresh.`);
            }
        }
        catch (error) {
            logger.error(`Error loading scratchpad data from ${storeFilePath}: ${error.message}`, { error });
        }
    }
    saveToFile() {
        try {
            const plainObject = Object.fromEntries(this.store);
            fs_1.default.writeFileSync(storeFilePath, JSON.stringify(plainObject, null, 2), 'utf-8');
        }
        catch (error) {
            logger.error(`Error saving scratchpad data to ${storeFilePath}: ${error.message}`, { error });
        }
    }
    set(sessionId, key, entry) {
        const sessionData = this.store.get(sessionId) || {};
        sessionData[key] = entry;
        this.store.set(sessionId, sessionData);
        this.saveToFile();
    }
    get(sessionId) {
        return this.store.get(sessionId) || {};
    }
    clearSession(sessionId) {
        this.store.delete(sessionId);
        this.saveToFile();
    }
}
exports.ScratchPadStore = ScratchPadStore;
