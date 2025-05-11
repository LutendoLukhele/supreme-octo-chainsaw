"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.StreamManager = void 0;
// src/services/stream/StreamManager.ts
const BaseService_1 = require("../base/BaseService");
const ws_1 = require("ws");
class StreamManager extends BaseService_1.BaseService {
    connections;
    chunkSize;
    constructor(config) {
        super(config);
        this.connections = new Map();
        this.chunkSize = config.chunkSize;
    }
    addConnection(sessionId, ws) {
        this.connections.set(sessionId, ws);
        this.setupConnectionHandlers(sessionId, ws);
    }
    async *createStream(content) {
        const chunks = this.chunkContent(content);
        for (const chunk of chunks) {
            yield {
                type: 'content',
                content: chunk
            };
        }
    }
    chunkContent(content) {
        const chunks = [];
        for (let i = 0; i < content.length; i += this.chunkSize) {
            chunks.push(content.slice(i, i + this.chunkSize));
        }
        return chunks;
    }
    setupConnectionHandlers(sessionId, ws) {
        ws.on('close', () => {
            this.connections.delete(sessionId);
            this.logger.info('Connection closed', { sessionId });
        });
        ws.on('error', (error) => {
            this.logger.error('WebSocket error', { error, sessionId });
            this.connections.delete(sessionId);
        });
    }
    sendChunk(sessionId, chunk) {
        const ws = this.connections.get(sessionId);
        if (ws?.readyState === ws_1.WebSocket.OPEN) {
            ws.send(JSON.stringify(chunk));
        }
    }
}
exports.StreamManager = StreamManager;
