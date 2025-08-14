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

        // This service now assumes the tool call has been validated by a higher-level service
        // like ActionLauncherService. Its only job is to execute.
        this.logger.info(`Orchestrator executing validated tool: '${toolName}'`, { executionId, toolName });

        try {
            const nangoResult = await this.executeNangoActionDispatcher(toolCall);
            
            const isSuccess = (nangoResult as any).success === true || ((nangoResult as any).success === undefined && (nangoResult as any).data !== undefined);

            if (isSuccess) {
                this.logger.info(`Tool execution successful`, { tool: toolName, executionId });
                return {
                    status: 'success',
                    toolName: toolName,
                    data: (nangoResult as any).hasOwnProperty('data') ? (nangoResult as any).data : nangoResult,
                    error: ''
                };
            } else {
                const errorMessage = (nangoResult as any).message || `Tool '${toolName}' failed.`;
                this.logger.warn(`Tool execution failed`, { tool: toolName, executionId, errors: (nangoResult as any).errors, message: errorMessage });
                return {
                    status: 'failed', toolName: toolName, data: null, error: errorMessage
                };
            }
        } catch (error: any) {
            logger.error('Tool execution failed unexpectedly in orchestrator', { error: error.message, stack: error.stack, toolCall });
            return {
                status: 'failed', toolName: toolName, data: null,
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

     private async executeNangoActionDispatcher(toolCall: ToolCall): Promise<any> {
    const { name: toolName, arguments: args, userId } = toolCall;

    const providerConfigKey = this.toolConfigManager.getProviderConfigKeyForTool(toolName);
    if (!providerConfigKey) {
        throw new Error(`Configuration missing 'providerConfigKey' for tool: ${toolName}`);
    }

    const connectionId = await redis.get(`active-connection:${userId}`);
        if (!connectionId) {
             throw new Error(`No active Nango connection found to execute tool '${toolName}'.`);
        }

    // A mapping from your tool names to the script names in Nango
    const actionNameMap: Record<string, string> = {
  // Salesforce Tools
  'create_entity': 'create-entity',
  'update_entity': 'update-entity',
  'fetch_entity': 'fetch-entity',

  // Zoom Tool
  'create_zoom_meeting': 'create-meeting',

  // --- ADD THESE MISSING GMAIL TOOLS ---
  'fetch_emails': 'fetch-emails', // Assumes Nango script is named 'fetch-emails'
  'send_email': 'send-email'      // Assumes Nango script is named 'send-email'
};;

    const actionName = actionNameMap[toolName];
    if (!actionName) {
      throw new Error(`No Nango action script name mapped for tool: ${toolName}`);
    }

    // Simplified logic: All tools now use the generic Nango service method
    return await this.nangoService.triggerGenericNangoAction(
      providerConfigKey,
      connectionId,
      actionName,
      args // Pass the entire arguments object
    );
}
}




