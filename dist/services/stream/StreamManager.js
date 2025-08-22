"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.StreamManager = void 0;
const BaseService_1 = require("../base/BaseService");
const ws_1 = require("ws");
class StreamManager extends BaseService_1.BaseService {
    constructor(config) {
        super(config);
        this.connections = new Map();
        this.chunkSize = config.chunkSize || 512;
        this.logger.info('StreamManager initialized', { chunkSize: this.chunkSize });
    }
    addConnection(sessionId, ws) {
        if (this.connections.has(sessionId)) {
            this.logger.warn('Attempted to add duplicate connection for sessionId', { sessionId });
            const oldWs = this.connections.get(sessionId);
            oldWs?.terminate();
        }
        this.connections.set(sessionId, ws);
        this.logger.info('WebSocket connection added', { sessionId, readyState: ws.readyState });
        this.setupConnectionHandlers(sessionId, ws);
    }
    removeConnection(sessionId) {
        const ws = this.connections.get(sessionId);
        if (ws) {
            if (ws.readyState === ws_1.WebSocket.OPEN || ws.readyState === ws_1.WebSocket.CONNECTING) {
                ws.close(1001, 'Server removing connection');
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
    hasConnection(sessionId) {
        const ws = this.connections.get(sessionId);
        return !!ws && ws.readyState === ws_1.WebSocket.OPEN;
    }
    setupConnectionHandlers(sessionId, ws) {
        ws.on('close', (code, reason) => {
            const reasonString = reason ? reason.toString() : 'No reason given';
            this.logger.info('WebSocket connection closed', { sessionId, code, reason: reasonString });
            this.connections.delete(sessionId);
        });
        ws.on('error', (error) => {
            this.logger.error('WebSocket error occurred', { sessionId, error: error.message });
            this.connections.delete(sessionId);
            if (ws.readyState !== ws_1.WebSocket.CLOSED && ws.readyState !== ws_1.WebSocket.CLOSING) {
                ws.terminate();
            }
        });
        ws.on('pong', () => {
            this.logger.debug('Received pong', { sessionId });
        });
    }
    sendChunk(sessionId, chunk) {
        const ws = this.connections.get(sessionId);
        if (ws && ws.readyState === ws_1.WebSocket.OPEN) {
            try {
                ws.send(JSON.stringify(chunk));
                this.logger.debug('Sent chunk', { sessionId, type: chunk?.type });
            }
            catch (error) {
                this.logger.error('Failed to stringify or send chunk', { sessionId, type: chunk?.type, error: error.message });
            }
        }
        else {
            this.logger.warn('Attempted to send chunk to non-existent or closed connection', { sessionId, type: chunk?.type, readyState: ws?.readyState });
        }
    }
    async *createStream(content) {
        if (!content)
            return;
        const len = content.length;
        for (let i = 0; i < len; i += this.chunkSize) {
            const chunkContent = content.slice(i, i + this.chunkSize);
            const isLast = i + this.chunkSize >= len;
            yield {
                type: 'content',
                content: chunkContent,
                isFinal: isLast,
            };
        }
    }
    broadcast(chunk) {
        const message = JSON.stringify(chunk);
        this.logger.info('Broadcasting message to all clients', { type: chunk?.type, count: this.connections.size });
        this.connections.forEach((ws, sessionId) => {
            if (ws.readyState === ws_1.WebSocket.OPEN) {
                try {
                    ws.send(message);
                }
                catch (error) {
                    this.logger.error('Failed to broadcast to client', { sessionId, error: error.message });
                }
            }
        });
    }
    getActiveConnectionCount() {
        let count = 0;
        this.connections.forEach(ws => {
            if (ws.readyState === ws_1.WebSocket.OPEN) {
                count++;
            }
        });
        return count;
    }
}
exports.StreamManager = StreamManager;
