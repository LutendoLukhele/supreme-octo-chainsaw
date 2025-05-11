"use strict";
// Enhanced src/services/FollowUpService.ts
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.FollowUpService = void 0;
const events_1 = require("events");
const winston_1 = __importDefault(require("winston"));
const uuid_1 = require("uuid");
class FollowUpService extends events_1.EventEmitter {
    client;
    model;
    maxTokens;
    logger;
    constructor(client, model, maxTokens) {
        super();
        this.client = client;
        this.model = model;
        this.maxTokens = maxTokens;
        this.logger = winston_1.default.createLogger({
            level: 'info',
            format: winston_1.default.format.combine(winston_1.default.format.timestamp(), winston_1.default.format.json()),
            transports: [new winston_1.default.transports.Console()],
        });
        // Listen for follow-up requests
        this.on('generate_follow_up', this.handleFollowUp);
    }
    /**
     * Handles the follow-up response generation.
     */
    async handleFollowUp(request) {
        const { toolName, toolResult, sessionId } = request;
        const followUpId = (0, uuid_1.v4)();
        try {
            this.logger.info('Generating follow-up response', { followUpId, sessionId });
            // Construct follow-up messages
            const followUpMessages = [
                {
                    role: 'system',
                    content: 'Process the tool result and provide a natural response that explains the results to the user. If the tool execution failed, explain what went wrong and suggest alternatives.'
                },
                {
                    role: 'function',
                    name: toolName,
                    content: JSON.stringify(toolResult)
                }
            ];
            // Create a follow-up stream using the chat client
            const followUpStream = await this.client.chat.completions.create({
                model: this.model,
                messages: followUpMessages,
                max_tokens: this.maxTokens,
                stream: true
            });
            // Send initial message
            this.emit('send_chunk', sessionId, {
                type: 'content',
                content: JSON.stringify({ text: "Here's what I found:" })
            });
            // Stream the response
            let buffer = '';
            for await (const chunk of followUpStream) {
                const followUpDelta = chunk.choices[0]?.delta;
                if (followUpDelta?.content) {
                    buffer += followUpDelta.content;
                    // Send chunks at natural breaks or when buffer gets large
                    if (buffer.match(/[.!?]\s/) || buffer.length > 50) {
                        this.emit('send_chunk', sessionId, {
                            type: 'content',
                            content: buffer.trim()
                        });
                        buffer = '';
                    }
                }
            }
            // Send any remaining buffer
            if (buffer) {
                this.emit('send_chunk', sessionId, {
                    type: 'content',
                    content: buffer.trim()
                });
            }
            this.logger.info('Follow-up response generated successfully', { followUpId, sessionId });
        }
        catch (error) {
            this.logger.error('Follow-up response generation failed:', {
                error: error.message || 'Unknown error',
                followUpId,
                sessionId
            });
            this.emit('send_chunk', sessionId, {
                type: 'error',
                content: JSON.stringify({
                    message: 'Error generating follow-up response',
                    error: error instanceof Error ? error.message : 'Unknown error'
                }),
                toolCallId: followUpId
            });
        }
    }
    /**
     * Triggers follow-up response generation for a given tool execution result.
     */
    triggerFollowUp(request) {
        this.emit('generate_follow_up', request);
    }
}
exports.FollowUpService = FollowUpService;
