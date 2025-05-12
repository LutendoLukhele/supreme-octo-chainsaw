// src/services/stream/types.ts
import { ServiceConfig } from '../base/types';

export interface StreamConfig extends ServiceConfig {
  chunkSize: number;
}



export type StreamChunkType = 'error' | 'tool_result' | 'content' | 'tool_status' | 'tool_call' | 'parsed_markdown_segment' | 'conversational_text_part' | 'markdown_artefact_part' | 'message_end';

export interface StreamChunk {
  type: StreamChunkType;
  content: any; // Changed from string to any to allow objects like parsed markdown
  isFinal:boolean;
  messageId?: string;
  toolCallId?: string;
}