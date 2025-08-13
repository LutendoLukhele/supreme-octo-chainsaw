// src/services/tool/run.types.ts

import { ToolCall } from './tool.types';
import { ToolResult, Message } from '../conversation/types';

/**
 * Represents the overall status of a multi-tool execution run.
 */
export type RunStatus = 'pending' | 'running' | 'success' | 'partial_success' | 'failed';

/**
 * Extends the base ToolResult with execution timing and correlation IDs.
 * This is stored within the Run object.
 */
export interface RunToolResult extends ToolResult {
  toolCallId: string; // The ID of the tool call that produced this result
  startedAt: string;  // ISO string timestamp
  completedAt: string; // ISO string timestamp
}

/**
 * Metadata for a single tool execution within a larger run.
 * It tracks the lifecycle of one tool call from initiation to result.
 */
export interface ToolExecutionMeta {
  status: string;
  error: string | undefined;
  finishedAt: string;
  toolCall: ToolCall;
  intent?:any
  startedAt: string;      // ISO string timestamp
  completedAt?: string;     // ISO string timestamp
  result?: RunToolResult | undefined;
}

/**
 * The main Run object that tracks a complete multi-tool execution flow.
 * This is the object that will be stored and retrieved to display results.
 */
export interface Run {
  parentRunId: string;
  initiatedBy: string;
  id: string; // Unique run ID (e.g., "run_abc123")
  sessionId: string;
  userId: string;
  connectionId?: string; // Optional: The connection ID used for this run (e.g., Salesforce, Google)
  status: RunStatus;
  startedAt: string;      // ISO string timestamp
  completedAt?: string;     // ISO string timestamp
  tools: ToolExecutionMeta[]; // An array tracking each tool executed in the run
  
  // --- Narrative Context ---
  userInput?: string; // The specific user input that triggered this run.
  assistantResponse?: string; // The final text response from the assistant for this turn.
  contextMessages?: Message[]; // A snapshot of the conversation (e.g., last 5 messages) leading up to the run.
}
