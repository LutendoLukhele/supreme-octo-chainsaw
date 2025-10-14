// src/services/tool/ToolOrchestrator.ts

import { BaseService } from '../base/BaseService';
import { DataDependencyService } from '../data/DataDependencyService';
import { Resolver } from '../data/Resolver';
import { StepResult } from '../../types/data';
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
    dataDependencyService: DataDependencyService;
    resolver: Resolver;
}

export class ToolOrchestrator extends BaseService {
    private nangoService: NangoService;
    private toolConfigManager: ToolConfigManager.ToolConfigManager;
    private dataDependencyService: DataDependencyService;
    private resolver: Resolver;

    constructor(config: OrchestratorConfig) {
        super({ logger: config.logger });
        this.nangoService = config.nangoService;
        this.toolConfigManager = config.toolConfigManager;
        this.dataDependencyService = config.dataDependencyService;
        this.resolver = config.resolver;
        logger.info("ToolOrchestrator initialized to use Redis for connection lookups.");
    }

    async executeTool(toolCall: ToolCall, planId: string, stepId: string): Promise<ToolResult> {
        const executionId = toolCall.id || uuidv4();
        const { name: toolName, arguments: args } = toolCall;

        this.logger.info(`Orchestrator executing validated tool: '${toolName}'`, { executionId, toolName });

        const stepResult: StepResult = {
            planId,
            stepId,
            status: 'running',
            startedAt: new Date(),
            rawOutput: null,
        };

        try {
            const resolvedArgs = await this.resolver.resolve(planId, args);
            const sanitizedArgs = this.sanitizeToolArgs(toolName, resolvedArgs);
            toolCall.arguments = sanitizedArgs;

            const nangoResult = await this.executeNangoActionDispatcher(toolCall);
            let finalData: any;

            if (nangoResult && typeof nangoResult.truncated_response === 'string') {
                this.logger.warn('Nango returned a truncated_response. Parsing partial data.', { tool: toolName });
                try {
                    finalData = JSON.parse(nangoResult.truncated_response);
                } catch (parseError) {
                    this.logger.error('Failed to parse truncated_response from Nango.', { parseError, tool: toolName });
                    finalData = { 
                        error: 'Failed to parse truncated response from Nango. Data may be incomplete.',
                        raw: nangoResult.truncated_response 
                    };
                }
            } else if ((nangoResult as any)?.success === false) {
                const errorMessage = (nangoResult as any).message || `Tool '${toolName}' failed.`;
                this.logger.warn(`Tool execution failed`, { tool: toolName, executionId, errors: (nangoResult as any).errors, message: errorMessage });
                stepResult.status = 'failed';
                stepResult.endedAt = new Date();
                this.dataDependencyService.saveStepResult(stepResult);
                return {
                    status: 'failed',
                    toolName: toolName,
                    data: null,
                    error: errorMessage
                };
            } else {
                finalData = nangoResult;
            }

            this.logger.info(`Tool execution successful`, { tool: toolName, executionId });
            stepResult.status = 'completed';
            stepResult.rawOutput = finalData;
            stepResult.endedAt = new Date();
            this.dataDependencyService.saveStepResult(stepResult);

            return {
                status: 'success',
                toolName: toolName,
                data: finalData,
                error: ''
            };

        } catch (error: any) {
            logger.error('Tool execution failed unexpectedly in orchestrator', { error: error.message, stack: error.stack, toolCall });
            stepResult.status = 'failed';
            stepResult.endedAt = new Date();
            this.dataDependencyService.saveStepResult(stepResult);
            return {
                status: 'failed',
                toolName: toolName,
                data: null,
                error: error instanceof Error ? error.message : 'Unknown orchestrator exception'
            };
        }
    }

    private sanitizeToolArgs(toolName: string, args: Record<string, any>): Record<string, any> {
        if (!args || typeof args !== 'object') {
            return args;
        }

        switch (toolName) {
            case 'fetch_emails':
                return this.sanitizeFetchEmailsArgs(args);
            default:
                return args;
        }
    }

    private sanitizeFetchEmailsArgs(args: Record<string, any>): Record<string, any> {
        const sanitizedArgs: Record<string, any> = { ...args };

        if (!sanitizedArgs.operation) {
            sanitizedArgs.operation = 'fetch';
        }

        const filters = (sanitizedArgs.filters && typeof sanitizedArgs.filters === 'object')
            ? { ...sanitizedArgs.filters }
            : {};

        const numericLimit = this.parseNumeric(filters.limit);
        if (numericLimit === null || !Number.isFinite(numericLimit) || numericLimit <= 0) {
            filters.limit = 7;
        } else if (numericLimit > 50) {
            filters.limit = 50;
        } else {
            filters.limit = Math.floor(numericLimit);
        }

        const dateRange = (filters.dateRange && typeof filters.dateRange === 'object')
            ? { ...filters.dateRange }
            : undefined;

        if (dateRange) {
            const afterTimestamp = this.parseDate(dateRange.after);
            const beforeTimestamp = this.parseDate(dateRange.before);

            const sanitizedDateRange: Record<string, string> = {};

            if (afterTimestamp) {
                sanitizedDateRange.after = new Date(afterTimestamp).toISOString();
            } else if (dateRange.after) {
                this.logger.debug('Dropping invalid fetch_emails dateRange.after', { provided: dateRange.after });
            }

            if (beforeTimestamp && (!afterTimestamp || beforeTimestamp > afterTimestamp)) {
                sanitizedDateRange.before = new Date(beforeTimestamp).toISOString();
            } else if (dateRange.before) {
                this.logger.debug('Dropping invalid fetch_emails dateRange.before', { provided: dateRange.before });
            }

            if (Object.keys(sanitizedDateRange).length > 0) {
                filters.dateRange = sanitizedDateRange;
            } else {
                delete filters.dateRange;
            }
        }

        const sanitizedFilterKeys = Object.keys(filters).filter(key => {
            const value = (filters as any)[key];
            if (value === undefined || value === null) {
                return false;
            }
            if (typeof value === 'object' && Object.keys(value).length === 0) {
                return false;
            }
            return true;
        });

        if (sanitizedFilterKeys.length > 0) {
            sanitizedArgs.filters = filters;
        } else {
            delete sanitizedArgs.filters;
        }

        return sanitizedArgs;
    }

    private parseNumeric(value: any): number | null {
        if (typeof value === 'number') {
            return value;
        }
        if (typeof value === 'string') {
            const parsed = Number(value);
            return Number.isFinite(parsed) ? parsed : null;
        }
        return null;
    }

    private parseDate(value: any): number | null {
        if (typeof value !== 'string') {
            return null;
        }

        const trimmed = value.trim();
        if (!trimmed) {
            return null;
        }

        const timestamp = Date.parse(trimmed);
        if (Number.isNaN(timestamp)) {
            return null;
        }

        const MIN_VALID_TIMESTAMP = Date.parse('2000-01-01T00:00:00Z');
        if (timestamp < MIN_VALID_TIMESTAMP) {
            return null;
        }

        return timestamp;
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

