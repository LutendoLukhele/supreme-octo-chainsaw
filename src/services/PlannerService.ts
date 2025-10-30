import { DEDICATED_PLANNER_SYSTEM_PROMPT_TEMPLATE } from './conversation/prompts/dedicatedPlannerPrompt';
import Groq from 'groq-sdk';
import { v4 as uuidv4 } from 'uuid';
import winston from 'winston';
import { ToolConfigManager } from './tool/ToolConfigManager';
import { EventEmitter } from 'events';
import { StreamChunk } from './stream/types';
import { ChatCompletionMessageParam } from 'groq-sdk/resources/chat/completions';
import { MessageType } from './conversation/types';
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
}

export type ActionPlan = ActionStep[];

type PlannerStatusChunk = {
  type: 'planner_status';
  content: string;
  messageId: string;
  streamType: 'planner_feedback';
  isFinal: true;
};

export class PlannerService extends EventEmitter {
  private groqClient: Groq;
  private maxTokens: number;
  private toolConfigManager: ToolConfigManager;

  // Using Llama 3.3 70B - the most capable model on Groq
  private static readonly MODEL = 'llama-3.3-70b-versatile';

  constructor(
    groqApiKey: string,
    maxTokens: number,
    toolConfigManager: ToolConfigManager
  ) {
    super();
    
    // Debug logging
    logger.info('PlannerService constructor called', {
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
      apiKey: groqApiKey.trim() // Trim any whitespace
    });
    this.maxTokens = maxTokens;
    this.toolConfigManager = toolConfigManager;
    
    logger.info('PlannerService initialized with Groq', { 
      model: PlannerService.MODEL,
      maxTokens,
      apiKeyValid: true
    });
  }

  async generatePlanWithStepAnnouncements(
    userInput: string,
    toolCalls: any[],
    sessionId: string,
    messageId: string
  ): Promise<ActionPlan> {
    const plan = await this.generatePlan(userInput, toolCalls, sessionId, messageId);

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

      const response = await this.groqClient.chat.completions.create({
        model: PlannerService.MODEL,
        messages: [{ role: 'system', content: summaryPrompt }],
        max_tokens: 100,
        stream: true,
        temperature: 0.5,
      });

      let fullSummary = '';
      for await (const chunk of response) {
        const content = chunk.choices[0]?.delta?.content;
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

      const response = await this.groqClient.chat.completions.create({
        model: PlannerService.MODEL,
        messages: [{ role: 'system', content: announcementPrompt }],
        max_tokens: 80,
        stream: true,
        temperature: 0.5,
      });

      for await (const chunk of response) {
        const content = chunk.choices[0]?.delta?.content;
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

      const response = await this.groqClient.chat.completions.create({
        model: PlannerService.MODEL,
        messages: [{ role: 'system', content: completionPrompt }],
        max_tokens: 60,
        stream: true,
        temperature: 0.5,
      });

      for await (const chunk of response) {
        const content = chunk.choices[0]?.delta?.content;
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

      const response = await this.groqClient.chat.completions.create({
        model: PlannerService.MODEL,
        messages: [{ role: 'system', content: announcementPrompt }],
        max_tokens: 80,
        stream: true,
        temperature: 0.5,
      });

      for await (const chunk of response) {
        const content = chunk.choices[0]?.delta?.content;
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
  clientMessageId: string
): Promise<ActionPlan> {
  logger.info('PlannerService: Generating action plan using structured output', {
    sessionId,
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

  const availableTools = this.toolConfigManager.getToolDefinitionsForPlanner();
  const toolDefinitionsJson = JSON.stringify(availableTools, null, 2);

  let identifiedToolsPromptSection = "No tools pre-identified.";
  if (identifiedToolCalls.length > 0) {
    identifiedToolsPromptSection = "The following tool calls were preliminarily identified:\n";
    identifiedToolCalls.forEach(tc => {
      identifiedToolsPromptSection += `- Tool: ${tc.name}, Arguments: ${JSON.stringify(tc.arguments)}\n`;
    });
  }

  const systemPromptContent = DEDICATED_PLANNER_SYSTEM_PROMPT_TEMPLATE
    .replace('{{USER_CURRENT_MESSAGE}}', userInput)
    .replace('{{TOOL_DEFINITIONS_JSON}}', toolDefinitionsJson)
    .replace('{{PRE_IDENTIFIED_TOOLS_SECTION}}', identifiedToolsPromptSection);

  logger.info('PlannerService: Constructed system prompt for planner', {
    sessionId,
    availableToolNames: availableTools.map(t => t.name),
  });

  const messagesForApi: ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPromptContent }, 
    { role: 'user', content: userInput }
  ];

  try {
    const response = await this.groqClient.chat.completions.create({
      model: PlannerService.MODEL,
      messages: messagesForApi as any,
      max_tokens: this.maxTokens,
      temperature: 0.1,
      response_format: { type: "json_object" },
    });

    const content = response.choices[0]?.message?.content;
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