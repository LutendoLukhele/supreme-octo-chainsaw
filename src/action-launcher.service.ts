import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import winston from 'winston';
import { ConversationService } from './services/conversation/ConversationService';
import { ToolConfigManager, ToolInputSchema, ToolParameterProperty } from './services/tool/ToolConfigManager';
import {  ToolOrchestrator } from './services/tool/ToolOrchestrator';
import { LaunchableAction, ActionLauncherResponse, ParameterDefinition, UpdateParameterPayload, ExecuteActionPayload } from '../src/types/actionlaunchertypes';
import { BeatEngine } from './BeatEngine';
import { ToolCall } from './services/tool/tool.types';

import {  ToolResult } from './services/conversation/types';
import { StreamChunk } from './services/stream/types';
import { Run } from './services/tool/run.types';
import { RunManager } from './services/tool/RunManager';
import { ActionPlan } from './services/PlannerService';

export interface ActiveAction extends LaunchableAction {
  llmToolCallId?: string;
  arguments?: Record<string, any>; // <-- ADD THIS LINE
}

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.json()
    ),
    transports: [new winston.transports.Console()],
  });


export class ActionLauncherService extends EventEmitter {
public async processActionPlan(
    actionPlan: ActionPlan,
    sessionId: string,
    userId: string,
    messageId: string,
    activeRun?: Run
  ): Promise<void> {
    logger.info(`Processing action plan for session ${sessionId}.`, { numItems: actionPlan.length });

    const clientActionsToConfirm: ActiveAction[] = [];
    const clientActionsNeedingParams: ActiveAction[] = [];

    for (const planItem of actionPlan) {
      const toolName = planItem.tool;
      let actualToolArgs = planItem.arguments || {};
      
      

      const missingRequired = this.toolConfigManager.findMissingRequiredParams(toolName, actualToolArgs);
      const missingConditional = this.toolConfigManager.findConditionallyMissingParams(toolName, actualToolArgs);
      const serverSideMissingParams = [...new Set([...missingRequired, ...missingConditional])];
      const serverDeterminedStatus: ActiveAction['status'] = serverSideMissingParams.length > 0 ? 'collecting_parameters' : 'ready';

      const newActiveAction = this._createAndStoreAction({
    sessionId, messageId,
    actionId: planItem.id || uuidv4(),
    toolName: toolName,
    description: planItem.intent,
    arguments: planItem.arguments || {}, // <-- ADD THIS LINE to pass the arguments
    missingParameters: serverSideMissingParams,
    initialStatus: serverDeterminedStatus,
    actionVerb: '',
    objectNoun: '',
    parameters: []
})
      
      if (serverDeterminedStatus === 'collecting_parameters') {
        clientActionsNeedingParams.push(newActiveAction);
      } else if (serverDeterminedStatus === 'ready') {
        clientActionsToConfirm.push(newActiveAction);
      }
    }

    if (clientActionsNeedingParams.length > 0) {
        const analysisText = `I need a bit more information for the '${clientActionsNeedingParams[0].toolDisplayName}' action.`;
        this.emit('send_chunk', sessionId, {
            type: 'parameter_collection_required',
            content: { actions: clientActionsNeedingParams, analysis: analysisText, messageId ,},
        } as StreamChunk);
    }

    if (clientActionsToConfirm.length > 0) {
        const analysisText = `The '${clientActionsToConfirm[0].toolDisplayName}' action is ready. Please review and confirm.`;
        this.emit('send_chunk', sessionId, {
            type: 'action_confirmation_required',
            content: { actions: clientActionsToConfirm, analysis: analysisText, messageId },
        } as StreamChunk);
    }
  }
  private activeActions: Map<string, Map<string, ActiveAction>> = new Map();

  constructor(
      private conversationService: ConversationService,
      private toolConfigManager: ToolConfigManager,
      private beatEngine: BeatEngine
  ) {
     super();
     logger.info("ActionLauncherService initialized.");
  }

  

  public async initiateServerSideParameterCollection(
    sessionId: string,
    userId: string,
    originalUserMessageId: string,
    intendedToolName: string,
    allMissingParams: string[],
    llmProvidedArgs: Record<string, any>
): Promise<Array<{ type: string; payload?: any; content?: any; messageId?: string }>> {
    logger.info(`Server initiating parameter collection for ${intendedToolName}. Missing: ${allMissingParams.join(', ')}`, { sessionId });
    const parameterCollectionActionId = uuidv4();
    const messagesToSend: Array<{ type: string; payload?: any; content?: any; messageId?: string }> = [];

    messagesToSend.push({
        type: "PENDING_PARAMETER_COLLECTION",
        payload: {
            actionId: parameterCollectionActionId,
            messageId: originalUserMessageId,
            intendedToolName: intendedToolName,
            missingParamsHint: allMissingParams
        },
    });

    let clarificationQuestion = `I need a bit more information for the '${intendedToolName.replace(/_/g, ' ')}' action. Specifically, I'm missing: ${allMissingParams.join(', ')}. Can you provide these?`;

    try {
        const beatResponse = await this.beatEngine.invokeBeat('pre-tool-call_beat', {
            sessionId,
            messageId: originalUserMessageId,
            intendedToolName: intendedToolName,
            missingParams: allMissingParams
        }) as unknown as ({ prompt?: string } | undefined);

        if (beatResponse && typeof beatResponse.prompt === 'string' && beatResponse.prompt.trim() !== '') {
            clarificationQuestion = beatResponse.prompt;
        }
    } catch (beatError: any) {
        logger.error(`Error invoking pre-tool-call_beat for ${intendedToolName}`, { error: beatError.message || beatError, sessionId });
    }

    const toolSchema = this.toolConfigManager.getToolInputSchema(intendedToolName);
    let clientParameters: ParameterDefinition[] = [];

    if (toolSchema?.properties) {
        clientParameters = Object.entries(toolSchema.properties).
        map(([name, prop]: [string, ToolParameterProperty]) => {
            const propDesc = prop.prompt ?? prop.description ?? name;
            const propType = Array.isArray(prop.type) ? prop.type.join('|') : (prop.type || 'string');
            const propRequired = toolSchema.required?.includes(name) ?? false;
            return {
                name: name,
                description: propDesc,
                required: propRequired,
                type: propType,
                currentValue: llmProvidedArgs[name],
                hint: prop.hint
            };
        });
    } else {
        clientParameters = allMissingParams.map(name => ({
            name: name, description: `Missing: ${name}`, required: true, type: 'string',
            currentValue: llmProvidedArgs[name], hint: undefined
        }));
    }

    const actionForClient = this._createAndStoreAction({
      sessionId,
      messageId: originalUserMessageId,
      actionId: parameterCollectionActionId,
      actionVerb: "execute",
      objectNoun: intendedToolName,
      toolName: intendedToolName,
      description: clarificationQuestion,
      parameters: clientParameters,
      missingParameters: allMissingParams,
      initialStatus: 'collecting_parameters',
      arguments: {}
    });

    messagesToSend.push({
        type: "parameter_collection_required",
        content: {
            actions: [actionForClient],
            analysis: clarificationQuestion,
            isVagueQuery: false,
            messageId: originalUserMessageId
        },
        messageId: originalUserMessageId
    });

    return messagesToSend;
}


  public updateParameterValue(sessionId: string, payload: UpdateParameterPayload): ActiveAction | null {
       const { actionId, paramName, value } = payload;
       logger.info('Updating parameter value', { sessionId, actionId, paramName });
       const action = this.getAction(sessionId, actionId);
       if (!action) { logger.warn('Action not found for update', { sessionId, actionId }); return null; }
       const paramIndex = action.parameters.findIndex(p => p.name === paramName);
       if (paramIndex < 0) { logger.warn('Parameter not found', { sessionId, actionId, paramName }); return null; }

       action.parameters[paramIndex].currentValue = value;

       const missingIndex = action.missingParameters.indexOf(paramName);
       const isRequired = action.parameters[paramIndex].required;
       const hasValue = value !== null && value !== undefined && String(value).trim() !== '';

       if (isRequired && hasValue && missingIndex >= 0) {
            action.missingParameters.splice(missingIndex, 1);
       } else if (isRequired && !hasValue && missingIndex < 0) {
           action.missingParameters.push(paramName);
       }

       const stillMissingRequired = action.parameters.some(p => p.required && action.missingParameters.includes(p.name));
       action.status = stillMissingRequired ? 'collecting_parameters' : 'ready';

       logger.info(`Action status updated to ${action.status}`, { sessionId, actionId });

       if (!stillMissingRequired && action.status === 'ready') {
           logger.info(`Action ${actionId} is now ready after parameter update. Emitting 'action_ready_for_confirmation'.`, { sessionId, actionId });
           this.emit('action_ready_for_confirmation', { sessionId, actionId, messageId: action.messageId });
       }
       return action;
  }


  // src/action-launcher.service.ts

  public async executeAction(
  sessionId: string,
  userId: string,
  payload: ExecuteActionPayload,
  toolOrchestrator: ToolOrchestrator
): Promise<ActiveAction> {
  const { actionId, toolName } = payload; // We don't need payload.arguments anymore
  logger.info('Executing action via launcher', { sessionId, actionId, userId });

  const action = this.getAction(sessionId, actionId);
  if (!action) throw new Error(`Action ${actionId} not found`);
  
  // --- FIX ---
  // Use the reliable arguments stored in the action object, not the untrusted client payload.
  const finalArgs = action.arguments || {}; 

  action.status = 'executing';
  
  try {
    const toolCall: ToolCall = {
      name: toolName,
      arguments: finalArgs, // <-- Use the corrected finalArgs
      sessionId: sessionId,
      id: actionId,
      userId: userId,
    };

      const result: ToolResult = await toolOrchestrator.executeTool(toolCall);

      action.result = result.data;
      action.status = result.status === 'success' ? 'completed' : 'failed';
      action.error = result.status === 'failed' ? result.error : undefined;
      
      // --- FIX: The redundant call to scratchPadService has been removed. ---
      // The result is now handled exclusively by the RunManager in index.ts.

      return action;

    } catch (error: any) {
      action.status = 'failed';
      action.error = error instanceof Error ? error.message : String(error);
      action.result = null;
      throw error;
    }
  }

  public getActiveActions(sessionId: string): ActiveAction[] {
    const sessionActionMap = this.activeActions.get(sessionId);
    return sessionActionMap ? Array.from(sessionActionMap.values()) : [];
  }

  public getAction(sessionId: string, actionId: string): ActiveAction | null {
    return this.activeActions.get(sessionId)?.get(actionId) || null;
  }

  public clearActions(sessionId: string): void {
    this.activeActions.delete(sessionId);
    logger.info('Cleared actions for session', { sessionId });
  }

  private _createAndStoreAction(details: {
      sessionId: string; messageId: string; actionId: string; actionVerb: string;
          arguments: Record<string, any>; // <-- ADD THIS LINE

      objectNoun: string; toolName: string; description: string;
      parameters: ParameterDefinition[]; missingParameters: string[];
      initialStatus: 'collecting_parameters' | 'ready';
  }): ActiveAction {
      const colorMap: Record<string, string> = {};
      const iconMap: Record<string, string> = {};

      const newAction: ActiveAction = {
          id: details.actionId,
                  arguments: details.arguments, // <-- ADD THIS LINE to store the arguments

          action: details.actionVerb, object: details.objectNoun, toolName: details.toolName,
          description: details.description, parameters: details.parameters,
          missingParameters: details.missingParameters, status: details.initialStatus,
          messageId: details.messageId,
          bgColor: colorMap[details.actionVerb.toLowerCase()] || '#9E9E9E',
          icon: iconMap[details.toolName] || 'settings',
          result: null, error: undefined,
          toolDisplayName: this.toolConfigManager.getToolDisplayName(details.toolName) || details.toolName.replace(/_/g, ' ')
      };

      let sessionActionMap = this.activeActions.get(details.sessionId);
      if (!sessionActionMap) {
          sessionActionMap = new Map();
          this.activeActions.set(details.sessionId, sessionActionMap);
      }
      sessionActionMap.set(details.actionId, newAction);
      logger.info(`Stored new action`, { sessionId: details.sessionId, actionId: details.actionId, toolName: details.toolName });
      return newAction;
  }
}
