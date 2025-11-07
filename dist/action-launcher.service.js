"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ActionLauncherService = void 0;
const events_1 = require("events");
const uuid_1 = require("uuid");
const winston_1 = __importDefault(require("winston"));
const logger = winston_1.default.createLogger({
    level: 'info',
    format: winston_1.default.format.combine(winston_1.default.format.timestamp(), winston_1.default.format.json()),
    transports: [new winston_1.default.transports.Console()],
});
class ActionLauncherService extends events_1.EventEmitter {
    constructor(conversationService, toolConfigManager, beatEngine) {
        super();
        this.conversationService = conversationService;
        this.toolConfigManager = toolConfigManager;
        this.beatEngine = beatEngine;
        this.activeActions = new Map();
        logger.info("ActionLauncherService initialized.");
    }
    async processActionPlan(actionPlan, sessionId, userId, messageId, toolOrchestrator, activeRun) {
        logger.info('ActionLauncher: Processing action plan', {
            sessionId,
            numItems: actionPlan.length,
            planIds: actionPlan.map(p => ({ id: p.id, tool: p.tool }))
        });
        const clientActionsToConfirm = [];
        const clientActionsNeedingParams = [];
        for (const planItem of actionPlan) {
            const toolName = planItem.tool;
            const actualToolArgs = planItem.arguments || {};
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
            const serverDeterminedStatus = serverSideMissingParams.length > 0 ? 'collecting_parameters' : 'ready';
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
            }
            else if (serverDeterminedStatus === 'ready') {
                const toolSchema = this.toolConfigManager.getToolInputSchema(toolName);
                const hasParams = toolSchema?.properties && Object.keys(toolSchema.properties).length > 0;
                if (hasParams) {
                    if (actionPlan.length > 1) {
                        clientActionsToConfirm.push(newActiveAction);
                    }
                }
            }
        }
        if (clientActionsNeedingParams.length > 0) {
            const analysisText = `I need a bit more information for the '${clientActionsNeedingParams[0].toolDisplayName}' action.`;
            this.emit('send_chunk', sessionId, {
                type: 'parameter_collection_required',
                content: { actions: clientActionsNeedingParams, analysis: analysisText, messageId },
            });
        }
        if (clientActionsToConfirm.length > 0) {
            const analysisText = `The '${clientActionsToConfirm[0].toolDisplayName}' action is ready. Please review and confirm.`;
            this.emit('send_chunk', sessionId, {
                type: 'action_confirmation_required',
                content: { actions: clientActionsToConfirm, analysis: analysisText, messageId },
            });
        }
    }
    async initiateServerSideParameterCollection(sessionId, userId, originalUserMessageId, intendedToolName, allMissingParams, llmProvidedArgs) {
        logger.info(`Server initiating parameter collection for ${intendedToolName}. Missing: ${allMissingParams.join(', ')}`, { sessionId });
        const parameterCollectionActionId = (0, uuid_1.v4)();
        const messagesToSend = [];
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
            });
            if (beatResponse && typeof beatResponse.prompt === 'string' && beatResponse.prompt.trim() !== '') {
                clarificationQuestion = beatResponse.prompt;
            }
        }
        catch (beatError) {
            logger.error(`Error invoking pre-tool-call_beat for ${intendedToolName}`, { error: beatError.message || beatError, sessionId });
        }
        const toolSchema = this.toolConfigManager.getToolInputSchema(intendedToolName);
        let clientParameters = [];
        if (toolSchema?.properties) {
            clientParameters = Object.entries(toolSchema.properties).
                map(([name, prop]) => {
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
        }
        else {
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
    updateParameterValue(sessionId, payload) {
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
        }
        else if (isRequired && !hasValue && missingIndex < 0) {
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
    async executeAction(sessionId, userId, payload, toolOrchestrator, planId, stepId) {
        const { actionId, toolName } = payload;
        logger.info('ActionLauncher: Executing action', {
            sessionId,
            actionId,
            toolName,
            userId,
            planId,
            stepId,
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
        const finalArgs = action.arguments || {};
        logger.info('ActionLauncher: Using stored arguments', {
            sessionId,
            actionId,
            toolName,
            arguments: finalArgs
        });
        action.status = 'executing';
        try {
            const toolCall = {
                name: toolName,
                arguments: finalArgs,
                sessionId: sessionId,
                id: actionId,
                userId: userId,
            };
            const result = await toolOrchestrator.executeTool(toolCall, planId, stepId);
            action.result = result.data;
            action.status = result.status === 'success' ? 'completed' : 'failed';
            action.error = result.status === 'failed' ? result.error : undefined;
            logger.info('ActionLauncher: Action completed with result', {
                sessionId,
                actionId,
                status: action.status,
                result: JSON.stringify(action.result, null, 2)
            });
            return action;
        }
        catch (error) {
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
    getActiveActions(sessionId) {
        const sessionActions = this.activeActions.get(sessionId);
        return sessionActions ? Array.from(sessionActions.values()) : [];
    }
    clearActiveActions(sessionId) {
        this.activeActions.delete(sessionId);
        logger.info('Cleared active actions for session', { sessionId });
    }
    getAction(sessionId, actionId) {
        return this.activeActions.get(sessionId)?.get(actionId) || null;
    }
    clearActions(sessionId) {
        this.activeActions.delete(sessionId);
        logger.info('Cleared actions for session', { sessionId });
    }
    _createAndStoreAction(details) {
        const iconMap = {
            'fetch_emails': 'mail',
            'sendEmail': 'send',
            'createCalendarEvent': 'calendar',
            'updateSalesforceContact': 'contact',
            'searchContacts': 'search',
        };
        const newAction = {
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
exports.ActionLauncherService = ActionLauncherService;
