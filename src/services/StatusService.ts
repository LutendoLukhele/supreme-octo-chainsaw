// src/services/StatusService.ts

import winston from 'winston';
import { StreamManager } from './stream/StreamManager';
import { StreamChunk, StreamChunkType } from './stream/types';

interface StatusUpdatePayload {
  toolCallId: string;
  status: 'initiated' | 'in_progress' | 'completed' | 'failed';
  message?: string;
}

export class StatusService {
  private streamManager: StreamManager;
  private logger: winston.Logger;

  constructor(streamManager: StreamManager) {
    this.streamManager = streamManager;

    this.logger = winston.createLogger({
      level: 'info',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
      ),
      transports: [new winston.transports.Console()],
    });
  }

  /**
   * Sends a status update to the client.
   * @param sessionId - The unique session identifier.
   * @param toolCallId - The unique tool call identifier.
   * @param status - The current status of the tool call.
   * @param message - Optional additional message.
   */
  public sendStatusUpdate(
    sessionId: string,
    toolCallId: string,
    status: StatusUpdatePayload['status'],
    message?: string
  ) {
    const statusUpdate: StreamChunk = {
      type: 'tool_status' as StreamChunkType,
      content: JSON.stringify({
        toolCallId,
        status,
        message,
      }),
      isFinal: false
    };

    this.streamManager.sendChunk(sessionId, statusUpdate);
    this.logger.info('Sent status update', { sessionId, toolCallId, status, message });
  }
}
