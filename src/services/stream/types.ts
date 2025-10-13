import winston from 'winston';

export interface StreamConfig {
  logger: winston.Logger;
  chunkSize?: number;
}
// Defines the structure for parsed Markdown segments, e.g., from @lixpi/markdown-stream-parser
export interface LixpiParsedSegment {
  status: 'STREAMING' | 'END_STREAM' | string; // Allow for other statuses if any
  segment?: {
    segment: string; // The actual text content of the segment
    styles: string[]; // e.g., ['BOLD', 'ITALIC']
    type: string; // e.g., 'TEXT', 'H1', 'LIST_ITEM'
    isBlockDefining?: boolean; // If this segment defines a new block
    isProcessingNewLine?: boolean; // Internal parser state
  };
}



export interface plan_generated {
    messageId: string;
    planOverview: Array<{
        id: string;
        intent: string;
        tool: string;
        status: 'ready' | 'conditional';
    }>;
    analysis?: string; // Optional: A brief message from the server/planner
}


// Defines the structure for a chunk of data sent over WebSocket stream
export interface StreamChunk {
  type:
    | 'conversational_text_segment'
    | 'potential_tool_call'
    | 'dedicated_tool_call'
    | 'markdown_artefact_segment'
    | 'parsed_markdown_segment'
    | 'beat'
    | 'parameter_collection_required'
    | 'PENDING_PARAMETER_COLLECTION'
    | 'parameter_updated'
    | 'action_confirmation_required'
    | 'action_executed'
    | 'plan_generated'
    | 'tool_call'
    | 'tool_result'
    | 'tool_status_update'
    | 'tool_status'
    | 'seed_data_response'
    | 'content'
    | 'error'
    | 'stream_end'
    | 'planner_status'; // ✅ add this
  content?: any;
  messageId?: string;
  isFinal?: boolean;
  toolCallId?: string;
  streamType?: 'conversational' | 'tool_call' | 'markdown_artefact' | 'follow_up' | 'system' | 'beat_engine' | 'action_launcher' | 'scratchpad' | 'planner_feedback';
  payload?: any;
  data?: any;
  status?: string;
  toolName?: string;
  result?: any;
}


// Adding StreamChunkType separately for StatusService, though StreamChunk.type is the primary
export type StreamChunkType =
  | 'conversational_text_segment' | 'potential_tool_call' | 'dedicated_tool_call'
  | 'markdown_artefact_segment' | 'parsed_markdown_segment' | 'beat'
  | 'parameter_collection_required' | 'PENDING_PARAMETER_COLLECTION' | 'parameter_updated'
  | 'action_executed' | 'tool_call' | 'tool_result' | 'tool_status_update' | 'tool_status'
  | 'seed_data_response' | 'error' | 'stream_end' | 'content'; // Added 'content' here as well
