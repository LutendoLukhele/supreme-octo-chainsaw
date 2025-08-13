import { ChatCompletionMessageToolCall, ChatCompletionTool } from 'groq-sdk/resources/chat/completions';
import { ServiceConfig } from '../base/types';
import { Logger } from 'winston';

// Response chunk type for WebSocket communication
export type ResponseChunk = {
  type: 'content' | 'tool_call' | 'tool_result' | 'error' | 'final';
  content: string;
  toolCallId?: string;
};


export interface LLMResponse {
  content: string | null | undefined; // The text response from the LLM
  toolCalls: Array<{ // List of tool calls requested by the LLM
    id: string; // Unique ID for the tool call instance
    function: {
      name: string; // Name of the function/tool to call
      arguments: string; // JSON string of arguments for the function
    };
    // Add 'type: "function"' if your LLM response includes it
  }> | null | undefined;
}

// Tool function interface
export interface ToolFunction {
  name: string;
  arguments: string;
  entityType?: string;  // Added for Salesforce integration
  action?: string;      // Added for Salesforce integration
  parameters?: Record<string, any>;  // Added for Salesforce integration
}

// Tool call interface
export interface ToolCall {
  id: string;
  type: 'function';
  function: ToolFunction;
}

export interface ConversationResponse {
  content: string;
  toolCalls: ToolCall[];
  tools?: ChatCompletionTool[];
  type?: 'content' | 'tool_call' | 'tool_result' | 'final' | 'error';
  toolCallId?: string;
}

// Message interface
export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string| null;
  tool_calls?: ChatCompletionMessageToolCall[] | null; // <-- ADD THIS LINE

}

/**
 * Represents an action that has all its parameters validated and is ready
 * for user confirmation before execution.
 */
export interface PreparedAction {
  id: string;                   // The unique ID for this action instance
  toolName: string;             // The internal name of the tool (e.g., 'web_search')
  toolDisplayName: string;      // A user-friendly display name for the tool (e.g., "Search Web")
  arguments: Record<string, any>; // The fully resolved arguments for the tool
  argumentsDisplay?: Record<string, string>; // Optional: User-friendly representation of arguments (e.g., "Query: 'latest AI news'")
  status: 'pending_confirmation'; // Indicates the current state of this action object
  messageId: string;            // The ID of the assistant's message that proposed this action
  sessionId: string;            // The session ID this action belongs to
  userId: string;               // The user ID associated with this action
  // Any other relevant details for the client to display or for server-side tracking
}


// Configuration interface
export interface ConversationConfig extends ServiceConfig {
  TOOL_CONFIG_PATH: string;
  nangoService: import("../NangoService").NangoService;
  client: any;
  tools: any[];
  groqApiKey: string;
  model: string;
  maxTokens: number;
  logger: Logger;
}

// Tool result interface
export interface ToolResult {
  status: 'success' | 'failed';
  toolName: string;
  data: any;
  error?: string;
}