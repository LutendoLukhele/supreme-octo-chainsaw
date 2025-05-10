// src/services/FollowUpService.ts

import { EventEmitter } from 'events';
import { Groq } from 'groq-sdk';
import winston from 'winston';
import { v4 as uuidv4 } from 'uuid';
import { ToolResult } from './conversation/types'; // Ensure ToolResult is correctly defined
import { MarkdownStreamParser } from '@lixpi/markdown-stream-parser'; // Added import
import { StreamChunk } from './stream/types'; // Added import for StreamChunk

// Updated request structure - includes userId
interface FollowUpRequest {
  toolName: string;
  toolResult: ToolResult;
  sessionId: string; // WebSocket session ID
  messageId: string;
  toolCallId: string;
  userId: string;    // Added userId
}

// Define a type for the parsed segment from @lixpi/markdown-stream-parser
// Based on the library's README example output.
// If the library exports its own type (e.g., ParsedSegmentPayload), use that instead.
interface LixpiParsedSegment {
  status: 'STREAMING' | 'END_STREAM' | string;
  segment?: {
    segment: string;
    styles: string[];
    type: string;
    isBlockDefining?: boolean;
    isProcessingNewLine?: boolean;
  };
}

// Structure for the event carrying the final response for DB recording
interface FollowUpGeneratedPayload {
  userId: string; // Added userId
  sessionId: string;
  messageId: string;
  toolCallId: string;
  fullResponse: string;
}

export class FollowUpService extends EventEmitter {
  private client: Groq;
  private model: string;
  private maxTokens: number;
  private logger: winston.Logger;

  constructor(client: Groq, model: string, maxTokens: number) {
    super();
    this.client = client;
    this.model = model;
    this.maxTokens = maxTokens;

    // Simplified logger setup
    this.logger = winston.createLogger({
        level: 'info',
        format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
        defaultMeta: { service: 'FollowUpService' },
        transports: [new winston.transports.Console()],
    });
  }

  /**
   * Handles the follow-up response generation and streaming.
   * Now receives userId.
   */
  private async handleFollowUp(request: FollowUpRequest): Promise<void> {
    // Destructure all needed IDs including userId
    const { toolName, toolResult, sessionId, messageId, toolCallId, userId } = request;
    const followUpProcessingId = uuidv4();
    // Ensure parserInstanceId is unique for each call to handleFollowUp
    const parserInstanceId = `followup_${sessionId}_${toolCallId}_${followUpProcessingId}_parser`;

    this.logger.info('Generating follow-up response with markdown parsing', {
        followUpProcessingId, userId, sessionId, messageId, toolCallId, parserInstanceId
    });

    if (!userId) {
        this.logger.error('Cannot generate follow-up: userId is missing.', { followUpProcessingId, sessionId });
        // Optionally emit an error chunk or internal error event
        return;
    }

    const parser = MarkdownStreamParser.getInstance(parserInstanceId);
    let unsubscribeFromParser: (() => void) | null = null;
    let parserSuccessfullyCleanedUp = false;

    try {
      unsubscribeFromParser = parser.subscribeToTokenParse((parsedSegment: LixpiParsedSegment) => {
        this.logger.debug('Markdown parser emitted segment', { parserInstanceId, status: parsedSegment.status, type: parsedSegment.segment?.type });

        const isLastSegment = parsedSegment.status === 'END_STREAM';

        this.emit('send_chunk', sessionId, {
            type: 'parsed_markdown_segment', // New chunk type
            content: parsedSegment,          // Send the whole parsedSegment object
            toolCallId: toolCallId,
            messageId: messageId,
            isFinal: isLastSegment,
        } as StreamChunk);

        if (isLastSegment) {
            this.logger.info('Markdown parser emitted END_STREAM. Cleaning up.', { parserInstanceId });
            if (unsubscribeFromParser) { // Check if it hasn't been nulled by a concurrent cleanup
                unsubscribeFromParser(); 
                unsubscribeFromParser = null; // Prevent calling again in finally
            }
            MarkdownStreamParser.removeInstance(parserInstanceId);
            parserSuccessfullyCleanedUp = true;
        }
      });

      parser.startParsing();

      // Combine instructions, tool name, and tool result into a single system message
      // This addresses the "don't send two messages" point and aims for a more conversational LLM setup.
      const combinedSystemPrompt = `
You are providing a follow-up after an automated action (a 'tool') was performed on behalf of the user.
The tool that was executed is: "${toolName}".
The result of this tool execution is:
${JSON.stringify(toolResult, null, 2)}

Your main task is to explain this result to the user in a natural, conversational, and helpful way.
- If the tool action was successful, clearly state what was done and any key outcomes or information.
- If the tool action encountered an error or didn't go as planned, explain the issue clearly and gently. Offer alternatives or help if appropriate.
- Maintain a friendly and supportive tone. The goal is to make this interaction feel like a seamless part of our ongoing conversation.
- Avoid overly technical jargon unless it's essential and you explain it. Focus on what the user needs to know.
- Respond directly as the assistant; do not refer to yourself as a system processing a tool result. Just give the conversational explanation.
`;

      const followUpMessages = [
        {
          role: 'system' as const,
          content: combinedSystemPrompt
        }
      ];

      const followUpStream = await this.client.chat.completions.create({
        model: this.model,
        messages: followUpMessages, // Now using the single, combined system message
        max_tokens: this.maxTokens,
        stream: true,
        tool_choice: 'none', // Prevent follow-up from calling more tools
      });

      let fullResponse = '';

      for await (const chunk of followUpStream) {
        const contentDelta = chunk.choices[0]?.delta?.content;

        if (contentDelta) {
          fullResponse += contentDelta;
          if (parser.parsing && !parserSuccessfullyCleanedUp) { // Check if parser is still expecting tokens and not cleaned up
            parser.parseToken(contentDelta); // Feed token to the parser
          }
        }
      }

      // Signal end of LLM stream to the parser
      if (parser.parsing && !parserSuccessfullyCleanedUp) {
        parser.stopParsing(); // This should trigger END_STREAM and cleanup via the subscriber
      }

      this.logger.info('Follow-up LLM stream finished processing.', {
        followUpProcessingId, responseLength: fullResponse.length
      });

      // Emit the single event with the complete response for DB recording
      if (fullResponse) {
          this.emit('follow_up_generated', {
              userId, 
              sessionId,
              messageId,
              toolCallId,
              fullResponse: fullResponse.trim(),
          } as FollowUpGeneratedPayload);
          this.logger.info('Emitted follow_up_generated event', { followUpProcessingId, userId });
      } else {
          this.logger.warn('Follow-up generation resulted in empty response.', { followUpProcessingId, userId });
      }

    } catch (error: any) {
      this.logger.error('Follow-up response generation failed', {
        followUpProcessingId, userId, sessionId, messageId, toolCallId,
        error: error.message || 'Unknown error', stack: error.stack,
      });

      this.emit('send_chunk', sessionId, {
        type: 'error',
        content: `Error generating follow-up for tool ${toolName}: ${error.message || 'Unknown error'}`,
        toolCallId: toolCallId,
        messageId: messageId,
        isFinal: true, // Error implies finality for this stream
      } as StreamChunk);
    } finally {
        // Cleanup parser if it wasn't cleaned up through the END_STREAM event or other means
        if (!parserSuccessfullyCleanedUp) {
            this.logger.warn('Parser not cleaned up by END_STREAM, forcing cleanup in finally.', { parserInstanceId });
            if (unsubscribeFromParser) {
                unsubscribeFromParser();
            }
            // Ensure stopParsing is called if it's still in a parsing state
            if (parser.parsing) {
                 parser.stopParsing(); // Attempt to gracefully stop it.
            }
            MarkdownStreamParser.removeInstance(parserInstanceId); // Remove instance regardless
        }
    }
  }

  /**
   * Public method to trigger follow-up generation.
   * Expects userId in the request object.
   */
  public triggerFollowUp(request: FollowUpRequest): void {
    // Basic validation
     if (!request.userId) {
        this.logger.error('triggerFollowUp called without userId', { request });
        return;
     }
    this.handleFollowUp(request).catch(err => {
        this.logger.error('Unhandled error in handleFollowUp process triggered by triggerFollowUp', {
            userId: request.userId, sessionId: request.sessionId, messageId: request.messageId, toolCallId: request.toolCallId,
            error: err.message || 'Unknown error',
        });
    });
  }
}