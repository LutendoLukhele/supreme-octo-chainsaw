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
    // From ConversationService
    | 'conversational_text_segment' // Content: LixpiParsedSegment
    | 'potential_tool_call'       // Content: { id, function: { name, arguments } }
    | 'dedicated_tool_call'       // Content: { id, function: { name, arguments } }
    | 'markdown_artefact_segment' // Content: LixpiParsedSegment
    // From FollowUpService
    | 'parsed_markdown_segment'   // Content: LixpiParsedSegment (used by FollowUpService)
    // From BeatEngine (via StreamManager)
    | 'beat'                      // Content: Beat object
    // From ActionLauncherService (via StreamManager or direct WebSocket messages)
    | 'parameter_collection_required' // Content: ActionLauncherResponse
    | 'PENDING_PARAMETER_COLLECTION'  // Payload: { actionId, messageId, intendedToolName, missingParamsHint }
    | 'parameter_updated'    
          | 'action_confirmation_required' // <<< ADD THIS LINE
     // Content: LaunchableAction
    | 'action_executed'           // Content: LaunchableAction (with result/error)
    // From general tool handling in index.ts
    | 'tool_call'                 // Content: { id, function: { name, arguments } } or string message
    | 'tool_result'               // Content: ToolResult-like structure, toolCallId, toolName
    | 'tool_status_update'        // Content: string message, toolCallId, status, error?
    | 'tool_status'               // From StatusService, content is stringified JSON
    // From ScratchPadService
    | 'seed_data_response'        // Data: Record<string, ScratchEntry>
    // General
    | 'content'                   // For generic content streaming from StreamManager.createStream
    | 'error'                     // Content: string (error message)
    | 'stream_end';               // Signals an individual LLM/processing stream has finished
  content?: any;
  messageId?: string; // ID of the user message this chunk relates to
  isFinal?: boolean; // True if this is the last chunk for this specific segment/event OR for the stream if type is stream_end
  toolCallId?: string; // If type is tool_call related
  streamType?: 'conversational' | 'tool_call' | 'markdown_artefact' | 'follow_up' | 'system' | 'beat_engine' | 'action_launcher' | 'scratchpad';
  payload?: any; // For specific chunk types like PENDING_PARAMETER_COLLECTION
  data?: any; // For specific chunk types like seed_data_response
  status?: string; // For status updates
  toolName?: string; // For tool_result
  result?: any; // For tool_result, action_executed
}

// Adding StreamChunkType separately for StatusService, though StreamChunk.type is the primary
export type StreamChunkType =
  | 'conversational_text_segment' | 'potential_tool_call' | 'dedicated_tool_call'
  | 'markdown_artefact_segment' | 'parsed_markdown_segment' | 'beat'
  | 'parameter_collection_required' | 'PENDING_PARAMETER_COLLECTION' | 'parameter_updated'
  | 'action_executed' | 'tool_call' | 'tool_result' | 'tool_status_update' | 'tool_status'
  | 'seed_data_response' | 'error' | 'stream_end' | 'content'; // Added 'content' here as well