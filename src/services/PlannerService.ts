import { DEDICATED_PLANNER_SYSTEM_PROMPT_TEMPLATE } from './conversation/prompts/dedicatedPlannerPrompt';
import Groq from 'groq-sdk';
import { v4 as uuidv4 } from 'uuid';
import winston from 'winston';
import { ToolConfigManager } from './tool/ToolConfigManager';
import { ProviderAwareToolFilter } from './tool/ProviderAwareToolFilter';
import { EventEmitter } from 'events';
import { StreamChunk } from './stream/types';
import { ChatCompletionMessageParam } from 'groq-sdk/resources/chat/completions';
import { MessageType } from './conversation/types';
import { ILLMClient, IToolProvider, IToolFilter, ChatMessage } from './interfaces';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [new winston.transports.Console()],
});

export interface ActionStep {
  id: string;
  intent: string;
  tool: string;
  arguments: any;
  status: 'ready' | 'executing' | 'completed' | 'failed';
  function?: any;
  stepNumber?: number;
  totalSteps?: number;
  description?: string;
  dependsOn?: string[];
  workflowStepId?: string;
  artifactSpecId?: string;
}

export type ActionPlan = ActionStep[];

type PlannerStatusChunk = {
  type: 'planner_status';
  content: string;
  messageId: string;
  streamType: 'planner_feedback';
  isFinal: true;
};

// ============================================================
// Configuration Interface for Dependency Injection
// ============================================================

/**
 * Configuration for PlannerService with interface-based dependencies
 * Enables swapping implementations (e.g., different LLM providers)
 */
export interface PlannerConfig {
  /** LLM client for chat completions (required) */
  llmClient: ILLMClient;
  
  /** Tool definition provider (required) */
  toolProvider: IToolProvider;
  
  /** Optional user capability filter */
  toolFilter?: IToolFilter;
  
  /** Maximum tokens for LLM response */
  maxTokens: number;
  
  /** Model name override (optional) */
  model?: string;
  
  /** Custom prompt template (optional) */
  promptTemplate?: string;
}

/**
 * Legacy configuration for backward compatibility
 */
export interface LegacyPlannerConfig {
  groqApiKey: string;
  maxTokens: number;
  toolConfigManager: ToolConfigManager;
  providerAwareFilter?: ProviderAwareToolFilter;
}

export class PlannerService extends EventEmitter {
  // Interface-based dependencies
  private llmClient: ILLMClient;
  private toolProvider: IToolProvider;
  private toolFilter?: IToolFilter;
  private maxTokens: number;
  private model: string;
  
  // Legacy support - keep reference if using legacy constructor
  private groqClient?: Groq;
  private toolConfigManager?: ToolConfigManager;
  private providerAwareFilter?: ProviderAwareToolFilter;

  // Default model
  private static readonly DEFAULT_MODEL = 'llama-3.3-70b-versatile';

  /**
   * New interface-based constructor
   * @param config - Configuration with injected dependencies
   */
  constructor(config: PlannerConfig);
  
  /**
   * Legacy constructor for backward compatibility
   * @deprecated Use new PlannerService({ llmClient, toolProvider, ... }) instead
   */
  constructor(
    groqApiKey: string,
    maxTokens: number,
    toolConfigManager: ToolConfigManager,
    providerAwareFilter?: ProviderAwareToolFilter
  );
  
  constructor(
    configOrApiKey: PlannerConfig | string,
    maxTokens?: number,
    toolConfigManager?: ToolConfigManager,
    providerAwareFilter?: ProviderAwareToolFilter
  ) {
    super();

    // Detect which constructor signature is being used
    if (typeof configOrApiKey === 'object' && 'llmClient' in configOrApiKey) {
      // New interface-based constructor
      const config = configOrApiKey as PlannerConfig;
      
      this.llmClient = config.llmClient;
      this.toolProvider = config.toolProvider;
      this.toolFilter = config.toolFilter;
      this.maxTokens = config.maxTokens;
      this.model = config.model || PlannerService.DEFAULT_MODEL;
      
      logger.info('PlannerService initialized with interface-based config', {
        model: this.model,
        maxTokens: this.maxTokens,
        hasToolFilter: !!this.toolFilter
      });
    } else {
      // Legacy constructor - maintain backward compatibility
      const groqApiKey = configOrApiKey as string;
      
      // Debug logging
      logger.info('PlannerService legacy constructor called', {
        apiKeyProvided: !!groqApiKey,
        apiKeyLength: groqApiKey?.length || 0,
        apiKeyPrefix: groqApiKey?.substring(0, 10) || 'NONE',
        apiKeyType: typeof groqApiKey
      });

      // Validate API key
      if (!groqApiKey || groqApiKey.trim() === '') {
        throw new Error('GROQ_API_KEY is required but was not provided');
      }

      // Validate it starts with gsk_
      if (!groqApiKey.startsWith('gsk_')) {
        logger.error('Invalid Groq API key format - must start with gsk_', {
          receivedPrefix: groqApiKey.substring(0, 4)
        });
        throw new Error('Invalid Groq API key format - must start with gsk_');
      }

      this.groqClient = new Groq({
        apiKey: groqApiKey.trim()
      });
      this.maxTokens = maxTokens!;
      this.toolConfigManager = toolConfigManager;
      this.providerAwareFilter = providerAwareFilter;
      this.model = PlannerService.DEFAULT_MODEL;
      
      // Create legacy adapter wrapper for ILLMClient
      this.llmClient = this.createLegacyLLMAdapter(this.groqClient);
      this.toolProvider = toolConfigManager!;
      this.toolFilter = providerAwareFilter;

      logger.info('PlannerService initialized with legacy Groq config', {
        model: this.model,
        maxTokens: this.maxTokens,
        apiKeyValid: true
      });
    }
  }
  
  /**
   * Creates an ILLMClient adapter wrapping the legacy Groq client
   * Used for backward compatibility with existing code
   */
  private createLegacyLLMAdapter(groq: Groq): ILLMClient {
    const model = this.model;
    
    return {
      defaultModel: model,
      providerName: 'groq',
      
      chat: async (options) => {
        const response = await groq.chat.completions.create({
          model: options.model || model,
          messages: options.messages.map(m => ({
            role: m.role as any,
            content: m.content
          })),
          max_tokens: options.maxTokens,
          temperature: options.temperature ?? 0.1,
          response_format: options.responseFormat,
          tools: options.tools,
          tool_choice: options.toolChoice || options.tool_choice
        });
        
        const choice = response.choices[0];
        return {
          content: choice?.message?.content || null,
          toolCalls: choice?.message?.tool_calls?.map(tc => ({
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.function.name,
              arguments: tc.function.arguments
            }
          })) || null,
          finishReason: (choice?.finish_reason as any) || 'stop',
          usage: response.usage ? {
            promptTokens: response.usage.prompt_tokens,
            completionTokens: response.usage.completion_tokens,
            totalTokens: response.usage.total_tokens
          } : undefined
        };
      },
      
      chatStream: async function* (options) {
        const stream = await groq.chat.completions.create({
          model: options.model || model,
          messages: options.messages.map(m => ({
            role: m.role as any,
            content: m.content
          })),
          max_tokens: options.maxTokens,
          temperature: options.temperature ?? 0.5,
          stream: true
        });
        
        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta;
          const finishReason = chunk.choices[0]?.finish_reason;
          yield {
            content: delta?.content || null,
            finishReason: finishReason as any || null,
            done: !!finishReason
          };
        }
      },
      
      healthCheck: async () => {
        try {
          await groq.chat.completions.create({
            model,
            messages: [{ role: 'user', content: 'ping' }],
            max_tokens: 1
          });
          return { healthy: true };
        } catch (error: any) {
          return { healthy: false, error: error.message };
        }
      }
    };
  }

  async generatePlanWithStepAnnouncements(
    userInput: string,
    toolCalls: any[],
    sessionId: string,
    messageId: string,
    userId?: string
  ): Promise<ActionPlan> {
    const plan = await this.generatePlan(userInput, toolCalls, sessionId, messageId, userId);

    if (plan && plan.length > 0) {
      plan.forEach((step, index) => {
        step.stepNumber = index + 1;
        step.totalSteps = plan.length;
      });

      await this.streamPlanSummary(userInput, plan, sessionId);
    }

    return plan;
  }

  private async streamPlanSummary(
    userInput: string,
    plan: ActionPlan,
    sessionId: string
  ): Promise<void> {
    const summaryMessageId = uuidv4();
    const planDescriptions = plan.map(step => this.getToolFriendlyName(step.tool));

    const summaryPrompt = `Generate a brief, natural summary (max 30 words) of this execution plan.
User request: "${userInput}"
Actions to execute: ${planDescriptions.join(', ')}

Be specific but concise. Example: "I'll fetch your recent emails and then create a meeting with the team for tomorrow."`;

    try {
      this.emit('send_chunk', sessionId, {
        type: 'conversational_text_segment',
        content: { status: 'START_STREAM' },
        messageId: summaryMessageId,
        messageType: MessageType.PLAN_SUMMARY
      });

      // Use interface-based streaming
      const streamGenerator = this.llmClient.chatStream({
        messages: [{ role: 'system', content: summaryPrompt }],
        maxTokens: 100,
        temperature: 0.5,
        model: this.model
      });

      let fullSummary = '';
      for await (const chunk of streamGenerator) {
        const content = chunk.content;
        if (content) {
          fullSummary += content;
          this.emit('send_chunk', sessionId, {
            type: 'conversational_text_segment',
            content: {
              status: 'STREAMING',
              segment: { segment: content, styles: [], type: 'text' }
            },
            messageId: summaryMessageId,
            messageType: MessageType.PLAN_SUMMARY
          });
        }
      }

      this.emit('send_chunk', sessionId, {
        type: 'conversational_text_segment',
        content: { status: 'END_STREAM' },
        messageId: summaryMessageId,
        isFinal: true,
        messageType: MessageType.PLAN_SUMMARY
      });

      logger.info('Streamed plan summary', { sessionId, summary: fullSummary });
    } catch (error) {
      logger.error('Failed to generate plan summary', { error, sessionId });
    }
  }

  async streamStepAnnouncement(
    step: ActionStep,
    sessionId: string,
    placeholdersResolved: boolean = false // New parameter to indicate if placeholders were resolved
  ): Promise<void> { // Changed return type to void as it's primarily streaming
    const stepMessageId = uuidv4();
    const totalSteps = step.totalSteps ?? 1;
    const stepPrefix = totalSteps > 1
      ? `Step ${step.stepNumber} of ${totalSteps}: `
      : '';
    
    const dataResolutionMessage = placeholdersResolved
      ? `I've used the results from the previous step to prepare the arguments. `
      : '';

    const announcementPrompt = `Generate a brief, specific action announcement (max 25 words).
${stepPrefix}Executing: ${step.tool}
${dataResolutionMessage}
Intent: ${step.intent}
Key parameters: ${JSON.stringify(step.arguments, null, 2).slice(0, 200)}

Be specific about what's being done.`;

    try {
      this.emit('send_chunk', sessionId, {
        type: 'conversational_text_segment',
        content: { status: 'START_STREAM' },
        messageId: stepMessageId,
        messageType: MessageType.STEP_ANNOUNCEMENT,
        metadata: { stepNumber: step.stepNumber, totalSteps: step.totalSteps }
      });

      // Use interface-based streaming
      const streamGenerator = this.llmClient.chatStream({
        messages: [{ role: 'system', content: announcementPrompt }],
        maxTokens: 80,
        temperature: 0.5,
        model: this.model
      });

      for await (const chunk of streamGenerator) {
        const content = chunk.content;
        if (content) {
          this.emit('send_chunk', sessionId, {
            type: 'conversational_text_segment',
            content: {
              status: 'STREAMING',
              segment: { segment: content, styles: [], type: 'text' }
            },
            messageId: stepMessageId,
            messageType: MessageType.STEP_ANNOUNCEMENT
          });
        }
      }

      this.emit('send_chunk', sessionId, {
        type: 'conversational_text_segment',
        content: { status: 'END_STREAM' },
        messageId: stepMessageId,
        isFinal: true,
        messageType: MessageType.STEP_ANNOUNCEMENT
      });
    } catch (error) {
      logger.error('Failed to generate step announcement', { error, sessionId });
      const fallbackText = `${stepPrefix}Executing ${this.getToolFriendlyName(step.tool)}...`;
      this.streamSimpleMessage(sessionId, stepMessageId, fallbackText, MessageType.STEP_ANNOUNCEMENT);
    }
  }

  async streamStepCompletion(
    step: ActionStep,
    result: any,
    sessionId: string
  ): Promise<void> {
    const completionMessageId = uuidv4();
    const completionPrompt = `Generate a brief success confirmation (max 20 words) for this completed action:
Tool: ${step.tool}
Original intent: ${step.intent}
Result summary: ${JSON.stringify(result).slice(0, 300)}`;

    try {
      this.emit('send_chunk', sessionId, {
        type: 'conversational_text_segment',
        content: { status: 'START_STREAM' },
        messageId: completionMessageId,
        messageType: MessageType.STEP_COMPLETE
      });

      // Use interface-based streaming
      const streamGenerator = this.llmClient.chatStream({
        messages: [{ role: 'system', content: completionPrompt }],
        maxTokens: 60,
        temperature: 0.5,
        model: this.model
      });

      for await (const chunk of streamGenerator) {
        const content = chunk.content;
        if (content) {
          this.emit('send_chunk', sessionId, {
            type: 'conversational_text_segment',
            content: {
              status: 'STREAMING',
              segment: { segment: content, styles: ['success'], type: 'text' }
            },
            messageId: completionMessageId,
            messageType: MessageType.STEP_COMPLETE
          });
        }
      }

      this.emit('send_chunk', sessionId, {
        type: 'conversational_text_segment',
        content: { status: 'END_STREAM' },
        messageId: completionMessageId,
        isFinal: true,
        messageType: MessageType.STEP_COMPLETE
      });
    } catch (error) {
      logger.error('Failed to generate completion message', { error, sessionId });
      const fallbackText = `✓ ${this.getToolFriendlyName(step.tool)} completed`;
      this.streamSimpleMessage(sessionId, completionMessageId, fallbackText, MessageType.STEP_COMPLETE);
    }
  }

 

  async streamSingleActionAnnouncement(
    step: ActionStep,
    sessionId: string
  ): Promise<void> {
    const messageId = uuidv4();
    const announcementPrompt = `Generate a brief, specific action announcement (max 25 words) for a single action.
Executing: ${step.tool}
Intent: ${step.intent}
Key parameters: ${JSON.stringify(step.arguments, null, 2).slice(0, 200)}

Be specific about what's being done. Example: "Okay, sending an email to John Doe."`;

    try {
      this.emit('send_chunk', sessionId, {
        type: 'conversational_text_segment',
        content: { status: 'START_STREAM' },
        messageId: messageId,
        messageType: MessageType.TOOL_EXECUTION, // Using TOOL_EXECUTION as requested
      });

      // Use interface-based streaming
      const streamGenerator = this.llmClient.chatStream({
        messages: [{ role: 'system', content: announcementPrompt }],
        maxTokens: 80,
        temperature: 0.5,
        model: this.model
      });

      for await (const chunk of streamGenerator) {
        const content = chunk.content;
        if (content) {
          this.emit('send_chunk', sessionId, {
            type: 'conversational_text_segment',
            content: {
              status: 'STREAMING',
              segment: { segment: content, styles: [], type: 'text' }
            },
            messageId: messageId,
            messageType: MessageType.TOOL_EXECUTION
          });
        }
      }

      this.emit('send_chunk', sessionId, {
        type: 'conversational_text_segment',
        content: { status: 'END_STREAM' },
        messageId: messageId,
        isFinal: true,
        messageType: MessageType.TOOL_EXECUTION
      });
    } catch (error) {
      logger.error('Failed to generate single action announcement', { error, sessionId });
      const fallbackText = `Executing ${this.getToolFriendlyName(step.tool)}...`;
      this.streamSimpleMessage(sessionId, messageId, fallbackText, MessageType.TOOL_EXECUTION);
    }
  }


  private streamSimpleMessage(
    sessionId: string,
    messageId: string,
    text: string,
    messageType: MessageType
  ): void {
    this.emit('send_chunk', sessionId, {
      type: 'conversational_text_segment',
      content: { status: 'START_STREAM' },
      messageId,
      messageType
    });

    this.emit('send_chunk', sessionId, {
      type: 'conversational_text_segment',
      content: { status: 'STREAMING', segment: { segment: text, styles: [], type: 'text' } },
      messageId,
      messageType
    });

    this.emit('send_chunk', sessionId, {
      type: 'conversational_text_segment',
      content: { status: 'END_STREAM' },
      messageId,
      isFinal: true,
      messageType
    });
  }

  private getToolFriendlyName(toolName: string): string {
    const friendlyNames: Record<string, string> = {
      'fetch_emails': 'email fetching',
      'sendEmail': 'email sending',
      'createCalendarEvent': 'calendar event creation',
      'updateSalesforceContact': 'Salesforce update',
      'searchContacts': 'contact search',
    };
    return friendlyNames[toolName] || toolName.replace(/_/g, ' ');
  }

  // Add this method to PlannerService class to validate tool names

public async generatePlan(
  userInput: string,
  identifiedToolCalls: { name: string; arguments: Record<string, any>; id?: string }[],
  sessionId: string,
  clientMessageId: string,
  userId?: string
): Promise<ActionPlan> {
  logger.info('PlannerService: Generating action plan using structured output', {
    sessionId,
    userId,
    userInputLength: userInput.length,
    numIdentifiedTools: identifiedToolCalls.length,
    identifiedToolNames: identifiedToolCalls.map(tc => tc.name)
  });

  const plannerStatus: PlannerStatusChunk = {
    type: 'planner_status',
    content: 'Analyzing your request...',
    messageId: clientMessageId,
    streamType: 'planner_feedback',
    isFinal: true,
  };

  this.emit('send_chunk', sessionId, plannerStatus as StreamChunk);

  // Use provider-aware filtering if available and userId is provided
  let availableTools;
  if (this.toolFilter && userId) {
    logger.info('PlannerService: Using provider-aware tool filtering', { userId });
    const filteredTools = await this.toolFilter.getAvailableToolsForUser(userId);

    if (filteredTools.length === 0) {
      // Don't fall back to all tools - user has no connected providers
      // Return a message telling them to connect integrations
      logger.warn('PlannerService: User has no connected providers - cannot generate plan', { userId });
      
      // Emit a friendly error message instead of crashing with rate limit
      const noProvidersError: StreamChunk = {
        type: 'error',
        content: 'It looks like you haven\'t connected any integrations yet. To help you with tasks like fetching emails, managing calendars, or working with Salesforce, please connect your accounts in the Integrations settings.'
      };
      this.emit('send_chunk', sessionId, noProvidersError);
      return [];
    } else {
      availableTools = filteredTools.map(tool => ({
        name: tool.name,
        description: tool.description,
        category: tool.category,
        parameters: tool.parameters
      }));
    }
  } else {
    logger.warn('PlannerService: Provider-aware filtering not available, using all tools');
    availableTools = this.toolProvider.getAllTools().map(tool => ({
      name: tool.name,
      description: tool.description,
      category: tool.category,
      parameters: tool.parameters
    }));
  }

  const toolDefinitionsJson = JSON.stringify(availableTools, null, 2);

  let identifiedToolsPromptSection = "No tools pre-identified.";
  if (identifiedToolCalls.length > 0) {
    identifiedToolsPromptSection = "The following tool calls were preliminarily identified:\n";
    identifiedToolCalls.forEach(tc => {
      identifiedToolsPromptSection += `- Tool: ${tc.name}, Arguments: ${JSON.stringify(tc.arguments)}\n`;
    });
  }

  // Get provider context if available (for legacy ProviderAwareToolFilter)
  let providerContext = '';
  if (this.providerAwareFilter && userId) {
    providerContext = await this.providerAwareFilter.getProviderContextForPrompt(userId);
  }

  const systemPromptContent = DEDICATED_PLANNER_SYSTEM_PROMPT_TEMPLATE
    .replace('{{USER_CURRENT_MESSAGE}}', userInput)
    .replace('{{TOOL_DEFINITIONS_JSON}}', toolDefinitionsJson)
    .replace('{{PRE_IDENTIFIED_TOOLS_SECTION}}', identifiedToolsPromptSection)
    .replace('{{PROVIDER_CONTEXT}}', providerContext);

  logger.info('PlannerService: Constructed system prompt for planner', {
    sessionId,
    availableToolNames: availableTools.map(t => t.name),
  });

  const messagesForApi: ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPromptContent }, 
    { role: 'user', content: userInput }
  ];

  try {
    // Use interface-based chat completion
    const response = await this.llmClient.chat({
      model: this.model,
      messages: [
        { role: 'system', content: systemPromptContent },
        { role: 'user', content: userInput }
      ],
      maxTokens: this.maxTokens,
      temperature: 0.1,
      responseFormat: { type: "json_object" },
    });

    const content = response.content;
    if (!content) {
      logger.error('PlannerService: No content from planning LLM', { sessionId });
      throw new Error('No content from planning LLM');
    }

    const responseObject = JSON.parse(content);

    logger.info('PlannerService: Raw plan from LLM', {
      sessionId,
      planObject: JSON.stringify(responseObject, null, 2)
    });

    if (!responseObject.plan || !Array.isArray(responseObject.plan)) {
      logger.error('PlannerService: Invalid response format from structured output', {
        sessionId,
        responseObject: JSON.stringify(responseObject)
      });
      throw new Error('Planner LLM response is not in the expected format despite using json_schema.');
    }

    // CRITICAL FIX: Validate that all tools in the plan actually exist
    const availableToolNames = new Set(availableTools.map(t => t.name));
    const invalidTools: string[] = [];
    
    responseObject.plan.forEach((item: any, idx: number) => {
      if (!availableToolNames.has(item.tool)) {
        invalidTools.push(item.tool);
        logger.error('PlannerService: Invalid tool in plan', {
          sessionId,
          stepNumber: idx + 1,
          invalidTool: item.tool,
          availableTools: Array.from(availableToolNames)
        });
      }
    });

    if (invalidTools.length > 0) {
      const errorMsg = `Plan contains invalid tools: ${invalidTools.join(', ')}. Available tools: ${Array.from(availableToolNames).join(', ')}`;
      logger.error('PlannerService: Plan validation failed', {
        sessionId,
        invalidTools,
        availableTools: Array.from(availableToolNames)
      });
      throw new Error(errorMsg);
    }

    const actionPlan: ActionPlan = responseObject.plan.map((item: any, idx: number) => {
      const actionId = item.id || uuidv4();
      
      logger.info('PlannerService: Creating action step', {
        sessionId,
        stepNumber: idx + 1,
        actionId,
        tool: item.tool,
        intent: item.intent,
        arguments: item.arguments
      });
      
      return {
        id: actionId,
        intent: item.intent,
        tool: item.tool,
        arguments: item.arguments || {},
        status: 'ready' as const,
        stepNumber: idx + 1,
        totalSteps: responseObject.plan.length
      };
    });

    // DEBUG: plan step created by planner (before persisting/hand-off)
    try {
      console.log("🔥 PLANNER_CREATED_STEP:", JSON.stringify(actionPlan, null, 2));
    } catch (e) {
      console.log("🔥 PLANNER_CREATED_STEP (raw):", actionPlan);
    }


    logger.info('PlannerService: Complete plan with validated tools', {
      sessionId,
      planLength: actionPlan.length,
      actionIds: actionPlan.map(step => ({ id: step.id, tool: step.tool })),
    });

    this.emit('send_chunk', sessionId, {
      type: 'plan_generated',
      messageId: clientMessageId,
      content: {
        summary: `Plan contains ${actionPlan.length} actions.`,
        steps: actionPlan
      },
      streamType: 'planner_feedback',
      isFinal: true
    } as unknown as StreamChunk);

    return actionPlan;

  } catch (error: any) {
    logger.error('PlannerService: Error generating action plan', {
      error: error.message,
      errorStack: error.stack,
      sessionId
    });
    return [];
  }
}
}
