// src/services/tool/ToolOrchestrator.ts

import { BaseService } from '../base/BaseService';
import { ToolCall } from './tool.types';
import { NangoService } from '../NangoService';
import { ToolResult } from '../conversation/types';
import winston from 'winston';
import * as ToolConfigManager from './ToolConfigManager';
import { v4 as uuidv4 } from 'uuid';
import { CONFIG } from '../../config';
import Redis from 'ioredis';
import { Run } from './run.types';

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
    transports: [new winston.transports.Console()],
});

const redis = new Redis(CONFIG.REDIS_URL!);

interface NangoActionResponse {
  success?: boolean;
  data?: any;
  [key: string]: any;
}

interface OrchestratorConfig  {
    logger: winston.Logger;
    nangoService: NangoService;
    toolConfigManager: ToolConfigManager.ToolConfigManager;
}

export class ToolOrchestrator extends BaseService {
    private nangoService: NangoService;
    private toolConfigManager: ToolConfigManager.ToolConfigManager;

    constructor(config: any) {
        super({ logger: config.logger });
        this.nangoService = config.nangoService;
        this.toolConfigManager = config.toolConfigManager;
        logger.info("ToolOrchestrator initialized to use Redis for connection lookups.");
    }

    async executeTool(toolCall: ToolCall): Promise<ToolResult> {
    const executionId = toolCall.id || uuidv4();
    const { name: toolName } = toolCall;

    this.logger.info(`Orchestrator executing validated tool: '${toolName}'`, { executionId, toolName });

    try {
        const nangoResult = await this.executeNangoActionDispatcher(toolCall);
        let finalData: any;

        // This logic correctly handles the "truncated_response" key from Nango
        if (nangoResult && typeof nangoResult.truncated_response === 'string') {
            this.logger.warn('Nango returned a truncated_response. Parsing partial data.', { tool: toolName });
            try {
                // Attempt to parse the partial JSON string
                finalData = JSON.parse(nangoResult.truncated_response);
            } catch (parseError) {
                this.logger.error('Failed to parse truncated_response from Nango.', { parseError, tool: toolName });
                // If parsing fails, return an error object but still mark as success to avoid a failed run
                finalData = { 
                    error: 'Failed to parse truncated response from Nango. Data may be incomplete.',
                    raw: nangoResult.truncated_response 
                };
            }
        } else if ((nangoResult as any)?.success === false) {
            // Handles explicit failures from Nango
            const errorMessage = (nangoResult as any).message || `Tool '${toolName}' failed.`;
            this.logger.warn(`Tool execution failed`, { tool: toolName, executionId, errors: (nangoResult as any).errors, message: errorMessage });
            return {
                status: 'failed',
                toolName: toolName,
                data: null,
                error: errorMessage
            };
        } else {
            // Handles a normal, non-truncated, successful response
            finalData = nangoResult;
        }

        // If we get here, the tool execution is considered a success.
        this.logger.info(`Tool execution successful`, { tool: toolName, executionId });
        return {
            status: 'success',
            toolName: toolName,
            data: finalData,
            error: ''
        };

    } catch (error: any) {
        logger.error('Tool execution failed unexpectedly in orchestrator', { error: error.message, stack: error.stack, toolCall });
        return {
            status: 'failed',
            toolName: toolName,
            data: null,
            error: error instanceof Error ? error.message : 'Unknown orchestrator exception'
        };
    }
}

    // Add this function inside the ToolOrchestrator class in ToolOrchestrator.ts

    /**
     * A patch to correct malformed 'fetch_entity' arguments from the LLM.
     * It checks for arguments incorrectly nested under 'identifier.type'
     * and flattens them to the correct top-level structure.
     * @param args The raw arguments from the tool call.
     * @returns A corrected, flat arguments object.
     */
    private _normalizeFetchEntityArgs(args: Record<string, any>): Record<string, any> {
        // Check for the specific malformed structure: an object inside 'identifier.type'
        if (args.identifier && typeof args.identifier.type === 'object' && args.identifier.type !== null) {
            
            this.logger.warn('Malformed fetch_entity arguments detected. Applying normalization patch.', { originalArgs: args });

            const nestedArgs = args.identifier.type;

            // Create a new, flat object with the correct structure.
            const newArgs = {
                operation: nestedArgs.operation || 'fetch',
                entityType: nestedArgs.entityType,
                filters: nestedArgs.filters,
                // Copy any other potential top-level fields that might be correct
                ...args.fields
            };
            
            this.logger.info('Arguments have been successfully normalized.', { newArgs });
            return newArgs;
        }

        // If the structure is already correct, return the original arguments without change.
        return args;
    }

     // In src/services/tool/ToolOrchestrator.ts

private async executeNangoActionDispatcher(toolCall: ToolCall): Promise<any> {
    const { name: toolName, arguments: args, userId } = toolCall;

    // 1. This correctly gets the Provider Key (e.g., 'google-mail')
    const providerConfigKey = this.toolConfigManager.getProviderConfigKeyForTool(toolName);
    if (!providerConfigKey) {
        throw new Error(`Configuration missing 'providerConfigKey' for tool: ${toolName}`);
    }

    // 2. This correctly gets the user's unique Connection ID from Redis
    const connectionId = await redis.get(`active-connection:${userId}`);
    if (!connectionId) {
        throw new Error(`No active Nango connection found to execute tool '${toolName}'.`);
    }

    this.logger.info(`Dispatching tool '${toolName}' with correct IDs.`, { providerConfigKey });

    switch (toolName) {
        case 'fetch_emails':
            // --- THIS IS THE FIX ---
            // Ensure the dynamic 'connectionId' from Redis is passed as the second argument,
            // and 'providerConfigKey' is passed as the first.
            return this.nangoService.fetchEmails(providerConfigKey, connectionId, args);

        case 'create_zoom_meeting':
            return this.nangoService.createCalendarEvent(providerConfigKey, connectionId, args);
        
        case 'create_entity':
        case 'update_entity':
        case 'fetch_entity':
            return this.nangoService.triggerSalesforceAction(
                providerConfigKey,
                connectionId,
                args
            );

        default:
            throw new Error(`No Nango action handler mapped for tool: ${toolName}`);
    }
}
}




