import { OpenAI } from 'openai';
import { v4 as uuidv4 } from 'uuid';
import winston from 'winston';
import { ToolConfigManager } from './tool/ToolConfigManager';
import { EventEmitter } from 'events';
import { StreamChunk } from './stream/types';
import { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { MessageType } from './conversation/types';
import { DEDICATED_PLANNER_SYSTEM_PROMPT_TEMPLATE } from './conversation/prompts/dedicatedPlannerPrompt';

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
  private openaiClient: OpenAI;
  private maxTokens: number;
  private toolConfigManager: ToolConfigManager;

  private static readonly MODEL = 'gpt-4o-mini';

  constructor(
    openaiApiKey: string,
    maxTokens: number,
    toolConfigManager: ToolConfigManager
  ) {
    super();
    this.openaiClient = new OpenAI({ apiKey: openaiApiKey });
    this.maxTokens = maxTokens;
    this.toolConfigManager = toolConfigManager;
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

      const response = await this.openaiClient.chat.completions.create({
        model: PlannerService.MODEL,
        messages: [{ role: 'system', content: summaryPrompt }],
        max_tokens: 100,
        stream: true,
        temperature:0.5,
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
    sessionId: string
  ): Promise<StreamChunk> {
    const stepMessageId = uuidv4();
    const totalSteps = step.totalSteps ?? 1;
    const stepPrefix = totalSteps > 1
      ? `Step ${step.stepNumber} of ${totalSteps}: `
      : '';

    const announcementPrompt = `Generate a brief, specific action announcement (max 25 words).
${stepPrefix}Executing: ${step.tool}
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

      const response = await this.openaiClient.chat.completions.create({
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

    const plannerStatus: PlannerStatusChunk = {
      type: 'planner_status',
      content: `${stepPrefix}Executing ${this.getToolFriendlyName(step.tool)}...`,
      messageId: stepMessageId,
      streamType: 'planner_feedback',
      isFinal: true,
    };

    return plannerStatus as StreamChunk;
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

      const response = await this.openaiClient.chat.completions.create({
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

  public async generatePlan(
  userInput: string,
  identifiedToolCalls: { name: string; arguments: Record<string, any>; id?: string }[],
  sessionId: string,
  clientMessageId: string
): Promise<ActionPlan> {
  logger.info('PlannerService: Generating action plan', {
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

  const messagesForApi: ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPromptContent }
  ];

  let accumulatedContent = "";

  try {
    const responseStream = await this.openaiClient.chat.completions.create({
      model: PlannerService.MODEL,
      messages: messagesForApi as any,
      max_tokens: this.maxTokens,
      temperature: 0.1,
      response_format: { type: "json_object" },
      stream: true,
    });

    for await (const chunk of responseStream) {
      const contentDelta = chunk.choices[0]?.delta?.content;
      if (contentDelta) accumulatedContent += contentDelta;
      if (chunk.choices[0]?.finish_reason) break;
    }
    
    if (!accumulatedContent) {
      logger.error('PlannerService: No content from planning LLM', { sessionId });
      throw new Error('No content from planning LLM');
    }

    const responseObject = JSON.parse(accumulatedContent);

    if (!responseObject.plan || !Array.isArray(responseObject.plan)) {
      logger.error('PlannerService: Invalid response format', {
        sessionId,
        responseObject: JSON.stringify(responseObject)
      });
      throw new Error('Planner LLM response is not in the expected format.');
    }

    // FIX: ALWAYS generate UUIDs here and log them
    const actionPlan: ActionPlan = responseObject.plan.map((item: any, idx: number) => {
      const actionId = uuidv4(); // Always generate new UUID
      
      logger.info('PlannerService: Creating action step', {
        sessionId,
        stepNumber: idx + 1,
        actionId, // Log the generated ID
        tool: item.tool,
        intent: item.intent,
        arguments: item.arguments
      });
      
      return {
        id: actionId, // Use the generated UUID
        intent: item.intent,
        tool: item.tool,
        arguments: item.arguments || {}, // Ensure arguments exist
        status: 'ready' as const,
        stepNumber: idx + 1,
        totalSteps: responseObject.plan.length
      };
    });

    logger.info('PlannerService: Complete plan with all IDs', {
      sessionId,
      planLength: actionPlan.length,
      actionIds: actionPlan.map(step => ({ id: step.id, tool: step.tool })),
      fullPlan: JSON.stringify(actionPlan, null, 2)
    });

    // Emit the plan with the generated IDs
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
      accumulatedContent: accumulatedContent?.substring(0, 1000),
      sessionId
    });
    return [];
  }
}
}
