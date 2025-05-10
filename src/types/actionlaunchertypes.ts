// src/action-launcher.types.ts
import { ToolInputSchema } from '../services/tool/ToolConfigManager'; // Import if needed
import { LLMResponse } from '../services/conversation/types'; // Import if needed

// Defines the structure for a single parameter needed by an action
export interface ParameterDefinition {
  name: string;
  description: string;
  required: boolean;
  type: string | string[]; // Use string from schema
  currentValue?: any; // Managed client-side or pre-filled
}

// Defines a potential action identified by the analysis step or validation failure
export interface LaunchableAction {
  id: string; // Unique UUID for this action instance
  action: string; // Verb (e.g., "fetch", "update", "execute")
  object: string; // Noun (e.g., tool name like "fetch_entity")
  toolName: string; // The actual backend tool name
  description: string; // User-friendly description or clarification question
  parameters: ParameterDefinition[]; // Full parameter list for UI rendering
  missingParameters: string[]; // REQUIRED parameters needing input
  status: 'pending_analysis' | 'collecting_parameters' | 'ready' | 'executing' | 'completed' | 'failed';
  messageId?: string; // Link back to the original user message ID
  bgColor?: string; // Optional UI hint
  icon?: string; // Optional UI hint
  result?: any; // Stores ToolResult on completion/failure
  error?: string; // Stores error message if failed
}

// Defines the overall response sent to client when parameters are needed
export interface ActionLauncherResponse {
    actions: LaunchableAction[]; // List of actions needing input/confirmation
    analysis: string; // Analysis text or clarification question
    isVagueQuery: boolean; // Usually false in this flow, but kept for potential use
    messageId?: string; // Link back to original message
}

// --- Payloads for Client -> Server WS Messages ---
export interface UpdateParameterPayload {
    actionId: string; // ID of the LaunchableAction being updated
    paramName: string; // Name of the parameter
    value: any; // New value from user input
}

export interface ExecuteActionPayload {
    actionId: string; // ID of the LaunchableAction to execute
}

// --- Internal Type for Validation Results ---
// (Could also reside in server.ts or a validation utility file)
export interface InvalidToolCallInfo {
    originalToolCall: NonNullable<LLMResponse['toolCalls']>[number]; // The raw call from LLM
    missingParams: string[]; // List of required params not found/valid/defaultable
    toolSchema?: ToolInputSchema; // Schema used for validation (optional)
}