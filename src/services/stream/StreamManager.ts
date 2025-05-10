// src/services/stream/StreamManager.ts
import { BaseService } from '../base/BaseService';
import { StreamConfig, StreamChunk } from './types'; // Ensure StreamChunk is defined { type: string, content: any, ... }
import { WebSocket } from 'ws';
import winston from 'winston'; // Assuming BaseService provides or you import logger

export class StreamManager extends BaseService {
  // Map to store active WebSocket connections keyed by sessionId
  private connections: Map<string, WebSocket>;
  private readonly chunkSize: number;

  constructor(config: StreamConfig) {
    // Ensure logger is initialized correctly, either via BaseService or directly
    // super({ logger: config.logger }); // Assuming BaseService handles logger setup
    // If BaseService doesn't handle logger, initialize it here or ensure config provides it.
    // this.logger = config.logger || winston.createLogger({...}); // Example
    super(config); // Assuming BaseService constructor handles config/logger

    this.connections = new Map();
    this.chunkSize = config.chunkSize || 512; // Default chunk size if not provided
    this.logger.info('StreamManager initialized', { chunkSize: this.chunkSize });
  }

  /**
   * Adds a new WebSocket connection associated with a sessionId.
   * Sets up handlers to automatically remove the connection on close/error.
   * @param sessionId - The unique identifier for the session/connection.
   * @param ws - The WebSocket instance.
   */
  addConnection(sessionId: string, ws: WebSocket): void {
     if (this.connections.has(sessionId)) {
        this.logger.warn('Attempted to add duplicate connection for sessionId', { sessionId });
        // Optionally close the old connection first? Or reject the new one?
        // For now, let's overwrite, assuming the old one might be stale.
        const oldWs = this.connections.get(sessionId);
        oldWs?.terminate(); // Force close the old one if it exists
     }
    this.connections.set(sessionId, ws);
    this.logger.info('WebSocket connection added', { sessionId, readyState: ws.readyState });
    this.setupConnectionHandlers(sessionId, ws);
  }

  /**
   * Removes a WebSocket connection for a given sessionId.
   * @param sessionId - The identifier of the connection to remove.
   * @returns boolean - True if a connection was found and removed, false otherwise.
   */
  removeConnection(sessionId: string): boolean {
    const ws = this.connections.get(sessionId);
    if (ws) {
        // Optional: Explicitly close the connection if it's still open,
        // though 'close' handler should also trigger removal.
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
           ws.close(1001, 'Server removing connection'); // Graceful close if possible
        }
        const deleted = this.connections.delete(sessionId);
        if (deleted) {
           this.logger.info('WebSocket connection removed', { sessionId });
        }
        return deleted;
    }
     this.logger.debug('Attempted to remove non-existent connection', { sessionId });
    return false;
  }

  /**
   * Checks if an active connection exists for a given sessionId.
   * @param sessionId - The identifier to check.
   * @returns boolean - True if an open connection exists, false otherwise.
   */
  hasConnection(sessionId: string): boolean {
     const ws = this.connections.get(sessionId);
     // Check if connection exists AND is in an open state
     return !!ws && ws.readyState === WebSocket.OPEN;
  }


  /**
   * Sets up 'close' and 'error' handlers for a WebSocket connection
   * to ensure cleanup in the connections map.
   * @param sessionId - The session ID associated with the WebSocket.
   * @param ws - The WebSocket instance.
   */
  private setupConnectionHandlers(sessionId: string, ws: WebSocket): void {
    ws.on('close', (code, reason) => {
      // Ensure removal from the map when the connection closes for any reason
      const reasonString = reason ? reason.toString() : 'No reason given';
      this.logger.info('WebSocket connection closed', { sessionId, code, reason: reasonString });
      this.connections.delete(sessionId); // Use delete directly here
    });

    ws.on('error', (error) => {
      // Ensure removal from the map on error
      this.logger.error('WebSocket error occurred', { sessionId, error: error.message });
      this.connections.delete(sessionId); // Use delete directly here
      // Optionally attempt to close the socket if error doesn't auto-close it
      if (ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
         ws.terminate();
      }
    });

     // Optional: Add pong handler for keep-alive checks if using pings
     ws.on('pong', () => {
        this.logger.debug('Received pong', { sessionId });
        // Handle keep-alive logic if needed
     });
  }


  /**
   * Sends a data chunk to a specific client via WebSocket.
   * @param sessionId - The target session ID.
   * @param chunk - The data chunk object to send (must be serializable to JSON).
   */
  sendChunk(sessionId: string, chunk: StreamChunk | any): void { // Allow any object type for flexibility
    const ws = this.connections.get(sessionId);
    // Check if connection exists and is open before sending
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(chunk));
         this.logger.debug('Sent chunk', { sessionId, type: chunk?.type });
      } catch (error: any) {
         this.logger.error('Failed to stringify or send chunk', { sessionId, type: chunk?.type, error: error.message });
         // Optionally try to remove the connection if sending fails persistently
         // this.removeConnection(sessionId);
      }
    } else {
       this.logger.warn('Attempted to send chunk to non-existent or closed connection', { sessionId, type: chunk?.type, readyState: ws?.readyState });
    }
  }

  /**
   * Generates chunks from a string based on the configured chunkSize.
   * This is useful for streaming large text content.
   * @param content - The string content to chunk.
   * @returns An asynchronous generator yielding StreamChunk objects.
   */
  async *createStream(content: string | null | undefined): AsyncGenerator<StreamChunk> {
   if (!content) return;
   const len = content.length;
   for (let i = 0; i < len; i += this.chunkSize) {
     const chunkContent = content.slice(i, i + this.chunkSize);
     const isLast = i + this.chunkSize >= len;
     yield {
       type:    'content',
       content: chunkContent,
       isFinal: isLast,
     };
   }
 }

  // Optional: Method to send a message to all connected clients
  broadcast(chunk: StreamChunk | any): void {
     const message = JSON.stringify(chunk);
     this.logger.info('Broadcasting message to all clients', { type: chunk?.type, count: this.connections.size });
     this.connections.forEach((ws, sessionId) => {
        if (ws.readyState === WebSocket.OPEN) {
           try {
              ws.send(message);
           } catch (error: any) {
               this.logger.error('Failed to broadcast to client', { sessionId, error: error.message });
           }
        }
     });
  }

  // Optional: Method to get the number of active connections
  getActiveConnectionCount(): number {
     let count = 0;
     this.connections.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) {
           count++;
        }
     });
     return count;
     // Or simply: return this.connections.size; (if map cleanup is perfectly reliable)
  }
}

// Ensure StreamConfig and StreamChunk types are defined correctly, e.g., in types.ts
// export interface StreamConfig {
//   logger: winston.Logger;
//   chunkSize: number;
// }
// export interface StreamChunk {
//   type: string;
//   content: any;
//   [key: string]: any; // Allow other properties like toolCallId, messageId, isFinal
// }