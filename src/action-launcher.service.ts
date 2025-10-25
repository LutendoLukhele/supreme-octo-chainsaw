import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import winston from 'winston';
import { ConversationService } from './services/conversation/ConversationService';
import { ToolConfigManager, ToolInputSchema, ToolParameterProperty } from './services/tool/ToolConfigManager';
import { ToolOrchestrator } from './services/tool/ToolOrchestrator';
import { LaunchableAction, ActionLauncherResponse, ParameterDefinition, UpdateParameterPayload, ExecuteActionPayload } from '../src/types/actionlaunchertypes';
import { BeatEngine } from './BeatEngine';
import { ToolCall } from './services/tool/tool.types';
import { ToolResult } from './services/conversation/types';
import { StreamChunk } from './services/stream/types';
import { Run } from './services/tool/run.types';
import { RunManager } from './services/tool/RunManager';
import { ActionPlan } from './services/PlannerService';

export interface ActiveAction extends LaunchableAction {
  llmToolCallId?: string;
  arguments?: Record<string, any>;
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
  private activeActions: Map<string, Map<string, ActiveAction>> = new Map();

  constructor(
    private conversationService: ConversationService,
    private toolConfigManager: ToolConfigManager,
    private beatEngine: BeatEngine
  ) {
    super();
    logger.info("ActionLauncherService initialized.");
  }

  public async processActionPlan(
    actionPlan: ActionPlan,
    sessionId: string,
    userId: string,
    messageId: string,
    toolOrchestrator: ToolOrchestrator,
    activeRun?: Run
  ): Promise<void> {
    logger.info('ActionLauncher: Processing action plan', { 
      sessionId, 
      numItems: actionPlan.length,
      planIds: actionPlan.map(p => ({ id: p.id, tool: p.tool }))
    });

    const clientActionsToConfirm: ActiveAction[] = [];
    const clientActionsNeedingParams: ActiveAction[] = [];
    const autoExecutionPromises: Promise<ActiveAction>[] = [];

    for (const planItem of actionPlan) {
      const toolName = planItem.tool;
      const actualToolArgs = planItem.arguments || {};
      
      // FIX: Use the ID from the plan - DON'T generate a new one
      const actionId = planItem.id;
      
      logger.info('ActionLauncher: Processing plan item', {
        sessionId,
        actionId,
        toolName,
        arguments: actualToolArgs
      });

      const missingRequired = this.toolConfigManager.findMissingRequiredParams(toolName, actualToolArgs);
      const missingConditional = this.toolConfigManager.findConditionallyMissingParams(toolName, actualToolArgs);
      const serverSideMissingParams = [...new Set([...missingRequired, ...missingConditional])];
      const serverDeterminedStatus: ActiveAction['status'] = 
        serverSideMissingParams.length > 0 ? 'collecting_parameters' : 'ready';

      // FIX: Pass the existing actionId, not a generated one
      const newActiveAction = this._createAndStoreAction({
        sessionId, 
        messageId,
        actionId: actionId,
        toolName: toolName,
        description: planItem.intent,
        arguments: actualToolArgs,
        missingParameters: serverSideMissingParams,
        initialStatus: serverDeterminedStatus,
        parameters: []
      });
      
      logger.info('ActionLauncher: Stored action with ID', {
        sessionId,
        storedActionId: newActiveAction.id,
        toolName: newActiveAction.toolName,
        status: newActiveAction.status
      });
      
      if (serverDeterminedStatus === 'collecting_parameters') {
        clientActionsNeedingParams.push(newActiveAction);
      } else if (serverDeterminedStatus === 'ready') {
        const toolSchema = this.toolConfigManager.getToolInputSchema(toolName);
        const hasParams = toolSchema?.properties && Object.keys(toolSchema.properties).length > 0;

        if (hasParams) {
            // Suppress confirmation for single-step auto-executing plans.
            if (actionPlan.length > 1) {
                clientActionsToConfirm.push(newActiveAction);
            } else {
                logger.info('ActionLauncher: Suppressing confirmation for single auto-executing action.', { sessionId, actionId: newActiveAction.id });
            }
        } else {
            logger.info('ActionLauncher: Auto-executing parameter-less action', { sessionId, actionId: newActiveAction.id });
            const promise = this.executeAction(
                sessionId,
                userId,
                { // Corrected payload to include arguments
                  actionId: newActiveAction.id,
                  toolName: newActiveAction.toolName,
                  arguments: newActiveAction.arguments
                },
                toolOrchestrator,
                planItem.id,
                planItem.id
            );
            autoExecutionPromises.push(promise);
        }
      }
    }

    // Log all stored action IDs for debugging
    logger.info('ActionLauncher: All actions stored', {
      sessionId,
      storedActionIds: this.getActiveActions(sessionId).map(a => ({ id: a.id, tool: a.toolName }))
    });

    if (autoExecutionPromises.length > 0) {
        try {
            const executedActions = await Promise.all(autoExecutionPromises);
            logger.info('ActionLauncher: Auto-executed actions finished', { sessionId, count: executedActions.length });
            // Optionally emit an event for each or for all
            this.emit('actions_auto_executed', { sessionId, actions: executedActions });
        } catch (error) {
            logger.error('ActionLauncher: Error during auto-execution of actions', { sessionId, error });
            // Decide how to handle partial failures. For now, just log.
        }
    }

    if (clientActionsNeedingParams.length > 0) {
      const analysisText = `I need a bit more information for the '${clientActionsNeedingParams[0].toolDisplayName}' action.`;
      this.emit('send_chunk', sessionId, {
        type: 'parameter_collection_required',
        content: { actions: clientActionsNeedingParams, analysis: analysisText, messageId },
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
        name: name, 
        description: `Missing: ${name}`, 
        required: true, 
        type: 'string',
        currentValue: llmProvidedArgs[name], 
        hint: undefined
      }));
    }

    const actionForClient = this._createAndStoreAction({
      sessionId,
      messageId: originalUserMessageId,
      actionId: parameterCollectionActionId,
      toolName: intendedToolName,
      description: clarificationQuestion,
      parameters: clientParameters,
      missingParameters: allMissingParams,
      initialStatus: 'collecting_parameters',
      arguments: llmProvidedArgs
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
    if (!action) { 
      logger.warn('Action not found for update', { sessionId, actionId }); 
      return null; 
    }
    
    const paramIndex = action.parameters.findIndex(p => p.name === paramName);
    if (paramIndex < 0) { 
      logger.warn('Parameter not found', { sessionId, actionId, paramName }); 
      return null; 
    }

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

  public async executeAction(
    sessionId: string,
    userId: string,
    payload: ExecuteActionPayload,
    toolOrchestrator: ToolOrchestrator,
    planId: string, // Added planId
    stepId: string  // Added stepId
  ): Promise<ActiveAction> {
    const { actionId, toolName } = payload;
    
    logger.info('ActionLauncher: Executing action', { 
      sessionId, 
      actionId, 
      toolName,
      userId,
      planId, // Log for traceability
      stepId, // Log for traceability
      availableActionIds: Array.from(this.activeActions.get(sessionId)?.keys() || [])
    });

    const action = this.getAction(sessionId, actionId);
    
    if (!action) {
      logger.error('ActionLauncher: Action not found', {
        sessionId,
        requestedActionId: actionId,
        availableActions: this.getActiveActions(sessionId).map(a => ({ id: a.id, tool: a.toolName }))
      });
      throw new Error(`Action ${actionId} not found`);
    }
    
    // Use the arguments stored in the action object
    const finalArgs = action.arguments || {};
    
    logger.info('ActionLauncher: Using stored arguments', {
      sessionId,
      actionId,
      toolName,
      arguments: finalArgs
    });

    action.status = 'executing';
    
    try {
      const toolCall: ToolCall = {
        name: toolName,
        arguments: finalArgs,
        sessionId: sessionId,
        id: actionId,
        userId: userId,
      };

      // Pass planId and stepId to the orchestrator
      const result: ToolResult = await toolOrchestrator.executeTool(toolCall, planId, stepId);

      action.result = result.data;
      action.status = result.status === 'success' ? 'completed' : 'failed';
      action.error = result.status === 'failed' ? result.error : undefined;
      
      // Added for debugging data dependencies
      logger.info('ActionLauncher: Action completed with result', {
        sessionId,
        actionId,
        status: action.status,
        result: JSON.stringify(action.result, null, 2)
      });

      return action;

    } catch (error: any) {
      action.status = 'failed';
      action.error = error instanceof Error ? error.message : String(error);
      action.result = null;
      
      logger.error('ActionLauncher: Action execution failed', {
        sessionId,
        actionId,
        error: action.error
      });
      
      throw error;
    }
  }

    getActiveActions(sessionId: string): ActiveAction[] {
        const sessionActions = this.activeActions.get(sessionId);
        return sessionActions ? Array.from(sessionActions.values()) : [];
    }

    clearActiveActions(sessionId: string): void {
        this.activeActions.delete(sessionId);
        logger.info('Cleared active actions for session', { sessionId });
    }

  public getAction(sessionId: string, actionId: string): ActiveAction | null {
    return this.activeActions.get(sessionId)?.get(actionId) || null;
  }

  public clearActions(sessionId: string): void {
    this.activeActions.delete(sessionId);
    logger.info('Cleared actions for session', { sessionId });
  }

  private _createAndStoreAction(details: {
    sessionId: string; 
    messageId: string; 
    actionId: string; 
    arguments: Record<string, any>;
    toolName: string; 
    description: string;
    parameters: ParameterDefinition[]; 
    missingParameters: string[];
    initialStatus: 'collecting_parameters' | 'ready';
  }): ActiveAction {
    const iconMap: Record<string, string> = {
      'fetch_emails': 'mail',
      'sendEmail': 'send',
      'createCalendarEvent': 'calendar',
      'updateSalesforceContact': 'contact',
      'searchContacts': 'search',
    };

    const newAction: ActiveAction = {
      id: details.actionId,
      arguments: details.arguments,
      toolName: details.toolName,
      description: details.description,
      parameters: details.parameters,
      missingParameters: details.missingParameters,
      status: details.initialStatus,
      messageId: details.messageId,
      bgColor: '#6366f1',
      icon: iconMap[details.toolName] || 'settings',
      result: null,
      error: undefined,
      toolDisplayName: this.toolConfigManager.getToolDisplayName(details.toolName) || details.toolName.replace(/_/g, ' '),
      action: '',
      object: ''
    };

    let sessionActionMap = this.activeActions.get(details.sessionId);
    if (!sessionActionMap) {
      sessionActionMap = new Map();
      this.activeActions.set(details.sessionId, sessionActionMap);
    }
    
    sessionActionMap.set(details.actionId, newAction);
    
    logger.info('ActionLauncher: Stored new action', { 
      sessionId: details.sessionId, 
      actionId: details.actionId, 
      toolName: details.toolName,
      hasArguments: Object.keys(details.arguments).length > 0
    });
    
    return newAction;
  }
}