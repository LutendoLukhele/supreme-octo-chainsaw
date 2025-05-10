import { v4 as uuidv4 } from 'uuid';
import winston from 'winston';
import { ConversationService } from './services/conversation/ConversationService';
import { ToolConfigManager, ToolInputSchema, ToolParameterProperty } from './services/tool/ToolConfigManager'; // Import necessary types from ToolConfigManager
import { ToolOrchestrator } from './services/tool/ToolOrchestrator'; // Assuming ToolOrchestrator is correctly imported
import { LaunchableAction, ActionLauncherResponse, ParameterDefinition, UpdateParameterPayload, ExecuteActionPayload, InvalidToolCallInfo } from '../src/types/actionlaunchertypes'; // Adjust path if needed
import { CONFIG } from './config';
import { BeatEngine } from './BeatEngine'; // Assuming for invoking beats

import { ScratchPadService } from './services/scratch/ScratchPadService'; // Adjust path as needed
import { ToolResult } from './services/conversation/types';

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.json()
    ),
    transports: [new winston.transports.Console()],
  });


export class ActionLauncherService {
  private activeActions: Map<string, Map<string, LaunchableAction>> = new Map();

  // BeatEngine is injected
  constructor(
      private conversationService: ConversationService,
      private toolConfigManager: ToolConfigManager,
      private beatEngine: BeatEngine,
      private scratchPadService: ScratchPadService // Injected ScratchPadService
  ) {
     logger.info("ActionLauncherService initialized.");
  }

  public createLauncherResponseForParameterRequest(
      intendedToolName: string,
      missingParamsList: string[],
      clarificationQuestion: string,
      sessionId: string, // Session ID
      originalUserMessageId: string // ID of the user's message that led to this
  ): ActionLauncherResponse {
      logger.info(`Creating ActionLauncher response from LLM's 'request_missing_parameters' call`, { sessionId, originalUserMessageId, intendedToolName });

      const actionId = uuidv4(); // Generate a unique ID for this parameter collection action
      const toolSchema = this.toolConfigManager.getToolInputSchema(intendedToolName); // Use getToolInputSchema
      let parameters: ParameterDefinition[] = [];
      let validatedMissingParams: string[] = [];

      if (toolSchema?.properties) {
          parameters = Object.entries(toolSchema.properties).map(([name, prop]: [string, ToolParameterProperty]) => { // Type prop
             // Safely access properties
             const propDesc = prop.prompt ?? prop.description ?? name; // Prefer prompt for UI
             const propType = Array.isArray(prop.type) ? prop.type.join('|') : (prop.type || 'string');
             const propRequired = toolSchema.required?.includes(name) ?? false; // Use required from inputSchema
             return { name: name, description: propDesc, required: propRequired, type: propType, currentValue: undefined, hint: prop.hint };
          });
          validatedMissingParams = parameters
             .filter(p => p.required && missingParamsList.includes(p.name))
             .map(p => p.name);
      } else {
          parameters = missingParamsList.map(name => ({ name: name, description: `Missing: ${name}`, required: true, type: 'string', currentValue: undefined }));
          validatedMissingParams = missingParamsList;
          logger.warn("No input schema found for intended tool when creating response for parameter request", { intendedToolName, sessionId });
      }

      if (validatedMissingParams.length === 0) {
           logger.warn("LLM requested parameters but no validated required params missing!", { intendedToolName, sessionId, originalUserMessageId });
           // This case should ideally not happen if the LLM follows instructions.
           // We could return an empty action list or an error/clarification.
           return { actions: [], analysis: "It seems I have all the information I need. What would you like to do next?", isVagueQuery: false, messageId: originalUserMessageId };
      }

      const action: LaunchableAction = this._createAndStoreAction({
          sessionId, messageId: originalUserMessageId, // Use originalUserMessageId
          actionId: actionId, // Pass the generated actionId
          actionVerb: "execute", objectNoun: intendedToolName,
          toolName: intendedToolName, description: clarificationQuestion,
          parameters: parameters, missingParameters: validatedMissingParams,
          initialStatus: 'collecting_parameters',
      });

      // This response is what the client will receive.
      // It should match the structure your client expects for 'parameter_collection_required'.
      // The 'action' object created above is already in the LaunchableAction format.
      return {
          actions: [action],
          analysis: clarificationQuestion,
          isVagueQuery: false, // Or determine this based on context
          messageId: originalUserMessageId // The ID of the user's message that triggered this
      };
  }

  // This method is called when the server itself (not the LLM) detects missing parameters
  // after an LLM tool call attempt.
  public async initiateServerSideParameterCollection(
    sessionId: string,
    userId: string, // Assuming userId is available
    originalUserMessageId: string,
    intendedToolName: string,
    allMissingParams: string[],
    llmProvidedArgs: Record<string, any> // Arguments LLM tried to use
): Promise<Array<{ type: string; payload?: any; content?: any; messageId?: string }>> { // Returns messages to send
    logger.info(`Server initiating parameter collection for ${intendedToolName}. Missing: ${allMissingParams.join(', ')}`, { sessionId });
    const parameterCollectionActionId = uuidv4(); // Unique ID for this collection step
    const messagesToSend: Array<{ type: string; payload?: any; content?: any; messageId?: string }> = [];

    // 1. Prepare PENDING_PARAMETER_COLLECTION message
    messagesToSend.push({
        type: "PENDING_PARAMETER_COLLECTION",
        payload: {
            actionId: parameterCollectionActionId,
            messageId: originalUserMessageId, // ID of the user's message
            intendedToolName: intendedToolName,
            missingParamsHint: allMissingParams
        },
        // No specific messageId for this system message, client handles correlation via actionId
    });

    // 2. Invoke pre-tool-call_beat to get the clarification question
    let clarificationQuestion = `I need a bit more information for the '${intendedToolName.replace(/_/g, ' ')}' action. Specifically, I'm missing: ${allMissingParams.join(', ')}. Can you provide these?`; // Default

    try {
        // Assume invokeBeat might be mistyped as returning Promise<void>
        // but can actually return an object with a prompt or undefined.
        // We use a type assertion to guide TypeScript.
        const beatResponse = await this.beatEngine.invokeBeat('pre-tool-call_beat', {
            sessionId,
            messageId: originalUserMessageId,
            intendedToolName: intendedToolName,
            missingParams: allMissingParams
        }) as unknown as ({ prompt?: string } | undefined);

        if (beatResponse && typeof beatResponse.prompt === 'string' && beatResponse.prompt.trim() !== '') {
            clarificationQuestion = beatResponse.prompt;
        } else if (beatResponse) {
            logger.warn(`pre-tool-call_beat for ${intendedToolName} returned a response but no valid prompt.`, { beatResponse, sessionId });
        }
    } catch (beatError: any) {
        logger.error(`Error invoking pre-tool-call_beat for ${intendedToolName}`, { error: beatError.message || beatError, sessionId });
    }

    // 3. Prepare parameters for the client, including current values if LLM provided some
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
                currentValue: llmProvidedArgs[name], // Pre-fill with what LLM provided
                hint: prop.hint
            };
        });
    } else {
        clientParameters = allMissingParams.map(name => ({
            name: name, description: `Missing: ${name}`, required: true, type: 'string',
            currentValue: llmProvidedArgs[name], hint: undefined
        }));
        logger.warn("No input schema found for intended tool during server-side param collection", 
            { intendedToolName, sessionId });
    }

    // Create and store the action state on the server
    const actionForClient = this._createAndStoreAction({
        sessionId,
        messageId: originalUserMessageId,
        actionId: parameterCollectionActionId, // Use the same actionId
        actionVerb: "execute", // Or "collect_parameters" if you have a specific verb
        objectNoun: intendedToolName,
        toolName: intendedToolName,
        description: clarificationQuestion,
        parameters: clientParameters,
        missingParameters: allMissingParams,
        initialStatus: 'collecting_parameters',
    });

    // 4. Send the actual parameter collection request to the client
    // Prepare the 'parameter_collection_required' message
    messagesToSend.push({
        type: "parameter_collection_required", // Match client expectation
        content: { // Use 'content' key for consistency with client expectations
            // to create an ActionParameterInfo object.
            // The 'actionForClient' created above is a LaunchableAction.
            // Your client might expect a list of actions, even if it's just one.
            actions: [actionForClient], // Send it as a list
            analysis: clarificationQuestion,
            isVagueQuery: false, // Or determine this
            messageId: originalUserMessageId // ID of the user's message
        },
        messageId: originalUserMessageId // Associate with the original user message
    });

    return messagesToSend;
}

  public createLauncherResponseForIncompleteTools(
      invalidCallsInfo: InvalidToolCallInfo[],
      analysisText: string,
      sessionId: string,
      messageId: string
  ): ActionLauncherResponse {
      logger.info(`Creating ActionLauncher response for ${invalidCallsInfo.length} incomplete calls`, 
        { sessionId, messageId });

      const actions: LaunchableAction[] = invalidCallsInfo.map(info => {
          const actionId = uuidv4();
          const toolName = info.originalToolCall.function.name;
          const schema = info.toolSchema as ToolInputSchema | undefined; // Cast schema if passed from validation
          let parameters: ParameterDefinition[] = [];
          const validatedMissingParams = info.missingParams;

          if (schema?.properties) {
              parameters = Object.entries(schema.properties).map(([name, prop]: [string, ToolParameterProperty]) => {
                  const propDesc = prop.prompt ?? prop.description ?? name;
                  const propType = Array.isArray(prop.type) ? prop.type.join('|') : (prop.type || 'string');
                  const propRequired = schema.required?.includes(name) ?? false;
                  return { name: name, description: propDesc, required: propRequired, type: propType, currentValue: undefined, hint: prop.hint };
              });
          } else {
             parameters = validatedMissingParams.map(name => ({ name: name, description: `Missing: ${name}`, required: true, type: 'string', currentValue: undefined, hint: undefined }));
             logger.warn("No schema info provided for incomplete tool, creating params from missing list", { toolName, sessionId });
          }

          let parsedArgs: Record<string, any> = {};
          try { if (info.originalToolCall.function.arguments) parsedArgs = JSON.parse(info.originalToolCall.function.arguments); } catch {}
          parameters.forEach(p => { if (parsedArgs.hasOwnProperty(p.name)) p.currentValue = parsedArgs[p.name]; });

          const description = `Action '${toolName}' requires input for: ${validatedMissingParams.join(', ')}.`;

          return this._createAndStoreAction({
                sessionId, messageId, actionId, actionVerb: "execute", objectNoun: toolName, toolName,
                description, parameters, missingParameters: validatedMissingParams,
                initialStatus: 'collecting_parameters',
          });
      }).filter((a): a is LaunchableAction => a !== null);

      return { actions: actions, analysis: analysisText, isVagueQuery: false, messageId: messageId };
  }

  updateParameterValue(sessionId: string, payload: UpdateParameterPayload): LaunchableAction | null {
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

       if (isRequired && hasValue && missingIndex >= 0) action.missingParameters.splice(missingIndex, 1);
       else if (isRequired && !hasValue && missingIndex < 0) action.missingParameters.push(paramName);

       const stillMissingRequired = action.parameters.some(p => p.required && action.missingParameters.includes(p.name));
       action.status = stillMissingRequired ? 'collecting_parameters' : 'ready';

       logger.info(`Action status updated`, { sessionId, actionId, newStatus: action.status });
       return action;
  }

  async executeAction(sessionId: string, payload: ExecuteActionPayload, toolOrchestrator: ToolOrchestrator): Promise<LaunchableAction> {
      const { actionId } = payload;
      logger.info('Executing action via launcher', { sessionId, actionId });

      const action = this.getAction(sessionId, actionId);
      if (!action) throw new Error(`Action ${actionId} not found`);
      if (action.status !== 'ready') throw new Error(`Action '${action.toolName}' not ready`);

      const args: Record<string, any> = {};
      let conversionError = false;
      action.parameters.forEach(param => {
          if (param.currentValue !== undefined && param.currentValue !== null) {
              let value = param.currentValue;
              if (param.type === 'number' && typeof value !== 'number') value = Number(value);
              if (param.type === 'boolean' && typeof value !== 'boolean') value = ['true', '1', 'yes'].includes(String(value).toLowerCase());
              if (isNaN(value) && param.type === 'number') { conversionError = true; }
              args[param.name] = value;
          }
      });
      if (conversionError) throw new Error("Parameter type conversion failed.");

      logger.info(`Executing tool '${action.toolName}' with args`, { sessionId, actionId, args });
      action.status = 'executing';

      try {
          const nangoConnectionId = CONFIG.CONNECTION_ID; // Use correct config key
          if (!nangoConnectionId) throw new Error("Server config error: Nango ID missing.");

          // Explicitly define the options object matching ToolCall
          const toolOptions = {
              name: action.toolName,
              arguments: args, // Pass the parsed arguments
              sessionId: sessionId,
              id: uuidv4(), // New execution ID for this specific call
              ToolName: '',
              args: {},
              result: {},
          };

          // @ts-ignore
          const result: ToolResult = await toolOrchestrator.executeTool(toolOptions); // Pass the typed options

          action.result = result;
          action.status = result.status === 'success' ? 'completed' : 'failed';
          action.error = result.status === 'failed' ? result.error : undefined;
          logger.info(`Action execution finished`, { sessionId, actionId, finalStatus: action.status });

          // Add successful tool results to scratch pad
          if (action.status === 'completed' && result.data) {
            this.scratchPadService.addToolResult(
              sessionId,
              action.toolName,
              args,
              result.data, // Assuming result.data contains the primary output of the tool
              toolOptions.id // The unique ID of this tool execution
            );
          }

          return action;

      } catch (error: any) {
          logger.error('ToolOrchestrator execution failed', { error: error.message, sessionId, actionId });
          action.status = 'failed';
          action.error = error instanceof Error ? error.message : String(error);
          action.result = null;
          throw error;
      }
  }

  getActiveActions(sessionId: string): LaunchableAction[] {
    const sessionActionMap = this.activeActions.get(sessionId);
    return sessionActionMap ? Array.from(sessionActionMap.values()) : []; // Added return
  }

  getAction(sessionId: string, actionId: string): LaunchableAction | null {
    return this.activeActions.get(sessionId)?.get(actionId) || null; // Added return
  }

  clearActions(sessionId: string): void {
    this.activeActions.delete(sessionId); // Added implementation
    logger.info('Cleared actions for session', { sessionId });
  }

  // Implemented clearAllActions
  public clearAllActions(): void {
     this.activeActions.clear();
     logger.info("Cleared all active actions for all sessions.");
 }

  findMessageIdForAction(sessionId: string, actionId: string): string | undefined {
      const action = this.getAction(sessionId, actionId);
      return action?.messageId; // Added return
  }

  // --- Private Helpers ---
  // Define the type for the 'details' parameter inline or import if defined elsewhere
  private _createAndStoreAction(details: {
      sessionId: string; messageId: string; actionId: string; actionVerb: string;
      objectNoun: string; toolName: string; description: string;
      parameters: ParameterDefinition[]; missingParameters: string[];
      initialStatus: 'collecting_parameters' | 'ready';
  }): LaunchableAction {
      // const actionId = uuidv4(); // REMOVE THIS: Use details.actionId passed in
      const colorMap: Record<string, string> = { /* ... */ };
      const iconMap: Record<string, string> = { /* ... */ };

      const newAction: LaunchableAction = {
          id: details.actionId, // Use the provided actionId
          action: details.actionVerb, object: details.objectNoun, toolName: details.toolName,
          description: details.description, parameters: details.parameters,
          missingParameters: details.missingParameters, status: details.initialStatus,
          messageId: details.messageId,
          bgColor: colorMap[details.actionVerb.toLowerCase()] || '#9E9E9E',
          icon: iconMap[details.toolName] || 'help_outline',
          result: null, error: undefined
      };

      let sessionActionMap = this.activeActions.get(details.sessionId);
      if (!sessionActionMap) { sessionActionMap = new Map(); this.activeActions.set(details.sessionId, sessionActionMap); }
      sessionActionMap.set(details.actionId, newAction); // Store using the passed-in actionId
      logger.info(`Stored new action`, { sessionId: details.sessionId, actionId: details.actionId, toolName: details.toolName });
      return newAction; // Added return
  }

  // Optional: Keep these if analyzeQuery is ever used as a fallback
  private _parseAndValidateAnalysisResponse(content: string | null): ActionLauncherResponse { /* ... Implementation ... */ return {actions:[], analysis:'', isVagueQuery:true}; } // Placeholder return
  private _enhanceAndInitializeActions(response: ActionLauncherResponse, sessionId: string): ActionLauncherResponse { /* ... Implementation ... */ return response;} // Placeholder return
}