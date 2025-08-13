"use strict";
// src/services/FollowUpService.ts
Object.defineProperty(exports, "__esModule", { value: true });
exports.FollowUpService = void 0;
const events_1 = require("events");
class FollowUpService extends events_1.EventEmitter {
    client;
    model;
    maxTokens;
    constructor(client, model, maxTokens) {
        super();
        this.client = client;
        this.model = model;
        this.maxTokens = maxTokens;
    }
    // The triggerFollowUp method now accepts the updated FollowUpRequest type
    async triggerFollowUp(request) {
        const { userId, sessionId, messageId, toolCallId, toolName, toolResult, runId } = request;
        // Example prompt, can be made more sophisticated
        const prompt = `The tool "${toolName}" has finished with status "${toolResult.status}". The result is: ${JSON.stringify(toolResult.data, null, 2).substring(0, 1000)}. Provide a brief, natural language summary of this outcome for the user.`;
        try {
            const responseStream = await this.client.chat.completions.create({
                model: this.model,
                messages: [{ role: 'system', content: prompt }],
                max_tokens: this.maxTokens,
                stream: true,
            });
            let fullResponse = '';
            for await (const chunk of responseStream) {
                const contentDelta = chunk.choices[0]?.delta?.content;
                if (contentDelta) {
                    fullResponse += contentDelta;
                    // Stream the follow-up back to the client
                    this.emit('send_chunk', sessionId, {
                        type: 'parsed_markdown_segment', // Or a dedicated follow_up_chunk type
                        content: { segment: { segment: contentDelta, styles: [], type: 'text' } },
                        messageId: messageId,
                        toolCallId: toolCallId,
                        isFinal: false,
                    });
                }
            }
            // Emit an event when the full response is generated
            this.emit('follow_up_generated', { userId, sessionId, messageId, toolCallId, fullResponse, runId });
        }
        catch (error) {
            console.error('Error generating follow-up:', error);
        }
    }
    emit(event, ...args) {
        return super.emit(event, ...args);
    }
    on(event, listener) {
        return super.on(event, listener);
    }
}
exports.FollowUpService = FollowUpService;
