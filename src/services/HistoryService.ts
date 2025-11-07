// src/services/HistoryService.ts

import Redis from 'ioredis';
import winston from 'winston';
import { v4 as uuidv4 } from 'uuid';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [new winston.transports.Console()],
});

export enum HistoryItemType {
  PLAN = 'plan',
  TOOL_CALL = 'tool_call',
  MESSAGE = 'message',
}

export interface BaseHistoryItem {
  id: string;
  itemType: HistoryItemType;
  timestamp: string;
  userId: string;
  sessionId: string;
}

export interface PlanHistoryData {
  planTitle: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  actionCount: number;
  planId: string;
  actions?: Array<{
    toolName: string;
    description: string;
  }>;
}

export interface ToolCallHistoryData {
  toolName: string;
  status: 'success' | 'failed' | 'pending';
  summary: string;
  stepId?: string;
  planId?: string;
  arguments?: Record<string, any>;
  result?: any;
}

export interface MessageHistoryData {
  text: string;
  role: 'user' | 'assistant';
}

export interface HistoryItem extends BaseHistoryItem {
  data: PlanHistoryData | ToolCallHistoryData | MessageHistoryData;
}

export class HistoryService {
  private redis: Redis;
  private readonly HISTORY_KEY_PREFIX = 'user_history:';
  private readonly MAX_HISTORY_ITEMS = 100; // Keep last 100 items per user

  constructor(redisClient: Redis) {
    this.redis = redisClient;
    logger.info('HistoryService initialized');
  }

  /**
   * Add a history item for a user
   */
  async addHistoryItem(
    userId: string,
    itemType: HistoryItemType,
    data: PlanHistoryData | ToolCallHistoryData | MessageHistoryData,
    sessionId: string
  ): Promise<string> {
    const historyId = `hist_${uuidv4()}`;
    const timestamp = new Date().toISOString();

    const historyItem: HistoryItem = {
      id: historyId,
      itemType,
      timestamp,
      userId,
      sessionId,
      data,
    };

    try {
      const key = `${this.HISTORY_KEY_PREFIX}${userId}`;
      
      // Add to sorted set with timestamp as score for efficient retrieval
      await this.redis.zadd(
        key,
        Date.now(),
        JSON.stringify(historyItem)
      );

      // Trim to keep only recent items
      await this.redis.zremrangebyrank(key, 0, -(this.MAX_HISTORY_ITEMS + 1));

      logger.info('History item added', { userId, historyId, itemType });
      return historyId;
    } catch (error: any) {
      logger.error('Failed to add history item', { 
        userId, 
        itemType, 
        error: error.message 
      });
      throw error;
    }
  }

  /**
   * Get history for a user (newest first)
   */
  async getUserHistory(
    userId: string,
    limit: number = 50,
    offset: number = 0
  ): Promise<HistoryItem[]> {
    try {
      const key = `${this.HISTORY_KEY_PREFIX}${userId}`;
      
      // Get items in descending order (newest first)
      const items = await this.redis.zrevrange(
        key,
        offset,
        offset + limit - 1
      );

      const historyItems: HistoryItem[] = items.map(item => JSON.parse(item));
      
      logger.info('Retrieved user history', { 
        userId, 
        count: historyItems.length 
      });
      
      return historyItems;
    } catch (error: any) {
      logger.error('Failed to retrieve user history', { 
        userId, 
        error: error.message 
      });
      throw error;
    }
  }

  /**
   * Get a specific history item
   */
  async getHistoryItem(userId: string, historyId: string): Promise<HistoryItem | null> {
    try {
      const key = `${this.HISTORY_KEY_PREFIX}${userId}`;
      const items = await this.redis.zrange(key, 0, -1);
      
      const found = items.find(item => {
        const parsed = JSON.parse(item);
        return parsed.id === historyId;
      });

      return found ? JSON.parse(found) : null;
    } catch (error: any) {
      logger.error('Failed to get history item', { 
        userId, 
        historyId, 
        error: error.message 
      });
      return null;
    }
  }

  /**
   * Update an existing history item (e.g., when plan status changes)
   */
  async updateHistoryItem(
    userId: string,
    historyId: string,
    updates: Partial<PlanHistoryData | ToolCallHistoryData | MessageHistoryData>
  ): Promise<boolean> {
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

      const item: HistoryItem = JSON.parse(items[itemIndex]);
      item.data = { ...item.data, ...updates } as typeof item.data;

      // Remove old item
      await this.redis.zrem(key, items[itemIndex]);
      
      // Add updated item with same timestamp score
      const timestamp = new Date(item.timestamp).getTime();
      await this.redis.zadd(key, timestamp, JSON.stringify(item));

      logger.info('History item updated', { userId, historyId });
      return true;
    } catch (error: any) {
      logger.error('Failed to update history item', { 
        userId, 
        historyId, 
        error: error.message 
      });
      return false;
    }
  }

  /**
   * Delete user history
   */
  async deleteUserHistory(userId: string): Promise<boolean> {
    try {
      const key = `${this.HISTORY_KEY_PREFIX}${userId}`;
      await this.redis.del(key);
      logger.info('User history deleted', { userId });
      return true;
    } catch (error: any) {
      logger.error('Failed to delete user history', { 
        userId, 
        error: error.message 
      });
      return false;
    }
  }

  /**
   * Helper: Record a user message
   */
  async recordUserMessage(
    userId: string,
    sessionId: string,
    messageText: string
  ): Promise<string> {
    return this.addHistoryItem(
      userId,
      HistoryItemType.MESSAGE,
      {
        text: messageText,
        role: 'user',
      },
      sessionId
    );
  }

  /**
   * Helper: Record an assistant message
   */
  async recordAssistantMessage(
    userId: string,
    sessionId: string,
    messageText: string
  ): Promise<string> {
    return this.addHistoryItem(
      userId,
      HistoryItemType.MESSAGE,
      {
        text: messageText,
        role: 'assistant',
      },
      sessionId
    );
  }

  /**
   * Helper: Record a plan creation
   */
  async recordPlanCreation(
    userId: string,
    sessionId: string,
    planId: string,
    planTitle: string,
    actions: Array<{ toolName: string; description: string }>
  ): Promise<string> {
    return this.addHistoryItem(
      userId,
      HistoryItemType.PLAN,
      {
        planTitle,
        status: 'pending',
        actionCount: actions.length,
        planId,
        actions,
      },
      sessionId
    );
  }

  /**
   * Helper: Record a tool call
   */
  async recordToolCall(
    userId: string,
    sessionId: string,
    toolName: string,
    summary: string,
    args?: Record<string, any>,
    result?: any,
    status: 'success' | 'failed' | 'pending' = 'success',
    stepId?: string,
    planId?: string
  ): Promise<string> {
    return this.addHistoryItem(
      userId,
      HistoryItemType.TOOL_CALL,
      {
        toolName,
        status,
        summary,
        arguments: args,
        result,
        stepId,
        planId,
      },
      sessionId
    );
  }
}