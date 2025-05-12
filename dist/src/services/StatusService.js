"use strict";
// src/services/StatusService.ts
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.StatusService = void 0;
const winston_1 = __importDefault(require("winston"));
class StatusService {
    streamManager;
    logger;
    constructor(streamManager) {
        this.streamManager = streamManager;
        this.logger = winston_1.default.createLogger({
            level: 'info',
            format: winston_1.default.format.combine(winston_1.default.format.timestamp(), winston_1.default.format.json()),
            transports: [new winston_1.default.transports.Console()],
        });
    }
    /**
     * Sends a status update to the client.
     * @param sessionId - The unique session identifier.
     * @param toolCallId - The unique tool call identifier.
     * @param status - The current status of the tool call.
     * @param message - Optional additional message.
     */
    sendStatusUpdate(sessionId, toolCallId, status, message) {
        const statusUpdate = {
            type: 'tool_status',
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
exports.StatusService = StatusService;
