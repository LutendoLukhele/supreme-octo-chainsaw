// src/services/tool/run.types.ts

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
  sessionId: string;
  userId: string;
}

export interface ToolResult {
  status: 'success' | 'failed';
  toolName: string;
  data: any;
  error?: string;
}

export interface ToolExecutionStep {
  stepId: string;
  toolCall: ToolCall;
  status: string; // e.g., 'pending', 'executing', 'completed', 'failed'
  startedAt: string;
  finishedAt?: string;
  result?: ToolResult;
}

export type RunStatus = 'pending' | 'completed' | 'failed' | 'running' | 'success'| 'partial_success';

export interface Run {
  planId: string;
  completedAt: string;
  id: string;
  sessionId: string;
  userId: string;
  userInput: string;
  status: RunStatus;

  startedAt: string;
  initiatedBy: 'user' | 'assistant';
  parentRunId?: string;
  toolExecutionPlan: ToolExecutionStep[]; // This is the crucial property
  connectionId?: string;
  contextMessages?: any[];
  assistantResponse?: string;
}