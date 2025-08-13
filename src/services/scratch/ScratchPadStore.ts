import fs from 'fs';
import path from 'path';
import winston from 'winston';

// Basic logger for the store
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  defaultMeta: { service: 'ScratchPadStore' },
  transports: [
    new winston.transports.Console({ format: winston.format.simple() }),
  ],
});

// Define the path for the data file
const dataDir = path.join(process.cwd(), '.data');
const storeFilePath = path.join(dataDir, 'scratchpad-store.json');

export interface ScratchEntry {
    source: string;
    filters: any;
    records: any[];
    summary: { count: number };
    timestamp: string;
}

export class ScratchPadStore {
  private store: Map<string, Record<string, ScratchEntry>>;

  constructor() {
    this.store = new Map<string, Record<string, ScratchEntry>>();
    this.ensureDataDirExists();
    this.loadFromFile();
    logger.info('ScratchPadStore initialized with file-based persistence.');
  }

  private ensureDataDirExists() {
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
      logger.info(`Created data directory: ${dataDir}`);
    }
  }

  private loadFromFile(): void {
    try {
      if (fs.existsSync(storeFilePath)) {
        const data = fs.readFileSync(storeFilePath, 'utf-8');
        const plainObject = JSON.parse(data);
        this.store = new Map(Object.entries(plainObject));
        logger.info(`Loaded scratchpad data from ${storeFilePath}`);
      } else {
        logger.info(`No existing scratchpad data file found at ${storeFilePath}. Starting fresh.`);
      }
    } catch (error: any) {
      logger.error(`Error loading scratchpad data from ${storeFilePath}: ${error.message}`, { error });
    }
  }

  private saveToFile(): void {
    try {
      const plainObject = Object.fromEntries(this.store);
      fs.writeFileSync(storeFilePath, JSON.stringify(plainObject, null, 2), 'utf-8');
    } catch (error: any) {
      logger.error(`Error saving scratchpad data to ${storeFilePath}: ${error.message}`, { error });
    }
  }

  set(sessionId: string, key: string, entry: ScratchEntry): void {
    const sessionData = this.store.get(sessionId) || {};
    sessionData[key] = entry;
    this.store.set(sessionId, sessionData);
    this.saveToFile();
  }

  get(sessionId: string): Record<string, ScratchEntry> {
    return this.store.get(sessionId) || {};
  }

  clearSession(sessionId: string): void {
    this.store.delete(sessionId);
    this.saveToFile();
  }
}