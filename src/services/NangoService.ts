// src/services/NangoService.ts

import { Nango } from '@nangohq/node';
import winston from 'winston';
import { CONFIG } from '../config'; // Ensure CONFIG.CONNECTION_ID and CONFIG.NANGO_SECRET_KEY exist
import { ToolCall } from './conversation/types'; // Assuming ToolCall type exists

// --- Interface Definitions ---

interface FilterCondition {
  field: string;
  operator: string;
  value?: any;
  values?: any[];
}

interface OrderByClause {
  field: string;
  direction: 'ASC' | 'DESC' | string; // Allow ASC/DESC specifically
}

interface AggregateFunction {
  function: 'SUM' | 'AVG' | 'COUNT' | 'MIN' | 'MAX' | string; // Allow specific functions
  field: string;
  alias: string;
}

interface Filters {
  conditions?: FilterCondition[];
  logic?: string;
  orderBy?: OrderByClause[];
  limit?: number;
  offset?: number;
  includeFields?: string[];
  excludeFields?: string[];
  timeFrame?: string;
  groupBy?: string[];
  aggregate?: AggregateFunction[];
  includeDeleted?: boolean;
}

interface BatchOptions {
  allOrNothing?: boolean;
  batchSize?: number;
}

export interface EmailFilter {
  sender?: string | string[];
  recipient?: string | string[];
  subject?: {
    contains?: string[];
    startsWith?: string;
    endsWith?: string;
    exact?: string;
  };
  dateRange?: {
    after?: string; // ISO 8601 format expected
    before?: string; // ISO 8601 format expected
  };
  hasAttachment?: boolean;
  labels?: string[];
  includeBody?: boolean;
  excludeCategories?: string[];
  isRead?: boolean;
  isImportant?: boolean;
  includeSpam?: boolean;
  includeTrash?: boolean;
  limit?: number;
  offset?: number;
}

interface SalesforceActionOptions {
  includeFields?: string[]; // Changed from 'any' to 'string[]' for clarity
  offset?: number; // Changed from 'undefined' to 'number | undefined'
  records?: Record<string, any>[]; // For batch create
  checkDuplicates?: boolean;
  duplicateFilters?: Filters;
  useTemplate?: string;
  templateParams?: Record<string, any>;
  identifierType?: string; // For fetch/update with non-ID identifier
  filters?: Filters; // For fetch/update multiple records
  batchOptions?: BatchOptions; // For update
  timeFrame?: string; // For fetch
  format?: string; // For fetch
  countOnly?: boolean; // For fetch
  limit?: number; // For fetch
  // Note: includeFields/excludeFields handled by 'fields' parameter in triggerSalesforceAction
  // Note: groupBy/aggregate/includeDeleted are part of Filters interface
}

// Define a response interface for Nango API responses
interface NangoResponse {
  success?: boolean; // Standard success indicator from Nango actions
  data?: any; // Can be array, object, etc. depending on action
  errors?: string[] | null; // Standard errors array
  message?: string; // Standard message field
  [key: string]: any; // Allow other properties Nango might return
}

export class NangoService {
  // This method signature doesn't match how it's used, likely should be removed or implemented
  // executeTool(toolCall: ToolCall) {
  //   throw new Error('Method not implemented.');
  // }

  private nango: Nango;
  private logger: winston.Logger;
  // Stores the SINGLE connection ID from config used for ALL calls in this version
  private connectionId: string;

  constructor() {
    // Ensure required config values exist
    if (!CONFIG.CONNECTION_ID) {
        throw new Error("Configuration error: CONNECTION_ID is missing.");
    }
     if (!CONFIG.NANGO_SECRET_KEY) {
        throw new Error("Configuration error: NANGO_SECRET_KEY is missing.");
    }

    // Use specific config key if available, otherwise fallback
    this.connectionId = CONFIG.CONNECTION_ID; // Removed fallback to itself
    if (!this.connectionId) {
         throw new Error("Configuration error: CONNECTION_ID is missing."); // Simplified error message
    }


    this.nango = new Nango({ secretKey: CONFIG.NANGO_SECRET_KEY });

    // Initialize logger instance
    this.logger = winston.createLogger({
      level: process.env.LOG_LEVEL || 'info',
      format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
      defaultMeta: { service: 'NangoService' },
      transports: [
        new winston.transports.Console({
             format: winston.format.combine(winston.format.colorize(), winston.format.simple())
        }),
        // Add file transports if needed
      ],
    });
    this.logger.info("NangoService initialized.");
  }

  /**
   * Triggers Salesforce actions via Nango SDK.
   * NOTE: This version includes the explicit parameter reassignment patch.
   * NOTE: This version uses the single connectionId stored during construction.
   */
  async triggerSalesforceAction(
    providerConfigKey_received: string, // Expects Nango Key ('salesforce-2')
    connectionId_received: string,    // Expects Connection ID (but uses internal this.connectionId below)
    operation_received: string,       // Expects Operation ('fetch', 'update', 'create')
    entityType_received: string,      // Expects Entity Type ('Account', 'Lead')
    identifierOrFieldsOrPayload_received: string | Record<string, any>,
    fields_received?: Record<string, any> | string[] | null,
    options_received?: SalesforceActionOptions // Type is SalesforceActionOptions | undefined
  ): Promise<NangoResponse> {

    // Explicit parameter reassignment (The Patch)
    const providerConfigKey = providerConfigKey_received; // Should be 'salesforce-2'
    // const connectionId = connectionId_received; // Use internal this.connectionId instead
    const operation = operation_received; // Should be 'fetch', 'update', or 'create'
    const entityType = entityType_received;
    const identifierOrFieldsOrPayload = identifierOrFieldsOrPayload_received;
    const fields = fields_received;
    const options = options_received; // options is potentially undefined here

    this.logger.info('Inside triggerSalesforceAction - Values used:', { providerConfigKey: providerConfigKey, internalConnectionIdUsed: this.connectionId ? '***' : 'MISSING', operation: operation, entityType: entityType });

    let actionName: string;
    let payload: Record<string, any> = { operation, entityType }; // Use reassigned operation/entityType

    switch (operation) { // Use reassigned operation
      case 'create':
        actionName = 'salesforce-create-entity';
        if (typeof identifierOrFieldsOrPayload === 'object' && !Array.isArray(identifierOrFieldsOrPayload)) {
          payload.fields = identifierOrFieldsOrPayload;
        } else { throw new Error('Fields object required for create.'); }
        if (options?.records) payload.records = options.records; // Use optional chaining
        if (options?.checkDuplicates !== undefined) payload.checkDuplicates = options.checkDuplicates; // Use optional chaining
        if (options?.duplicateFilters) payload.duplicateFilters = options.duplicateFilters; // Use optional chaining
        if (options?.useTemplate) payload.useTemplate = options.useTemplate; // Use optional chaining
        if (options?.templateParams) payload.templateParams = options.templateParams; // Use optional chaining
        break;

      case 'update':
        actionName = 'salesforce-update-entity';
        if (options?.filters) { // Use optional chaining
          payload.filters = options.filters;
        } else if (typeof identifierOrFieldsOrPayload === 'string' && identifierOrFieldsOrPayload.trim() !== '') {
          payload.identifier = identifierOrFieldsOrPayload;
          payload.identifierType = options?.identifierType || 'Id'; // Use optional chaining
        } else { throw new Error('Identifier string or filters object required for update.'); }
        if (typeof fields === 'object' && !Array.isArray(fields) && fields !== null) {
          payload.fields = fields;
        } else { throw new Error('Fields object required for update.'); }
        if (options?.batchOptions) payload.batchOptions = options.batchOptions; // Use optional chaining
        break;

      case 'fetch':
        actionName = 'salesforce-fetch-entity';
        // Use reassigned variables for payload construction
        if (typeof identifierOrFieldsOrPayload === 'object' && !Array.isArray(identifierOrFieldsOrPayload)) {
            payload = { operation, entityType, ...identifierOrFieldsOrPayload };
        } else if (options?.filters) { // Use optional chaining
            payload.filters = options.filters;
        } else if (typeof identifierOrFieldsOrPayload === 'string') {
            if (identifierOrFieldsOrPayload === 'all') {
                payload.filters = { conditions: [] };
            } else if (identifierOrFieldsOrPayload.trim() !== ''){
                payload.identifier = identifierOrFieldsOrPayload;
                payload.identifierType = options?.identifierType || 'Id'; // Use optional chaining
            } else {
                 this.logger.warn("Empty identifier string received, assuming fetch 'all'.", {entityType});
                 payload.filters = { conditions: [] };
            }
        } else {
             this.logger.warn("No identifier or filters provided, assuming fetch 'all'.", {entityType});
             payload.filters = { conditions: [] };
        }
        // Add optional fields using optional chaining directly on 'options'
        // FIX: Use optional chaining `?.` to safely access properties on potentially undefined 'options'
        const effectiveFields = (Array.isArray(fields) && fields.length > 0) ? fields : options?.includeFields;
        if (options?.limit !== undefined) payload.limit = options.limit;
        if (options?.offset !== undefined) payload.offset = options.offset;
        if (effectiveFields && Array.isArray(effectiveFields) && effectiveFields.length > 0) payload.includeFields = effectiveFields;
        // Add other optional fetch params using optional chaining
        if (options?.timeFrame) payload.timeFrame = options.timeFrame;
        if (options?.format) payload.format = options.format;
        if (options?.countOnly !== undefined) payload.countOnly = options.countOnly;
        break;

      default:
        // This error check uses the reassigned 'operation'
        this.logger.error(`NangoService received unsupported operation AFTER internal reassignment`, { operation_received, operation });
        throw new Error(`Unsupported operation (post-reassign): ${operation}`);
    }

    this.logger.info('Triggering Salesforce action via Nango', {
      actionName,
      connectionId: this.connectionId ? '***' : 'MISSING', // Use internal connectionId
      payload: JSON.stringify(payload).substring(0,200)+"..." // Log truncated payload
    });

    try {
      const response = await this.nango.triggerAction(
        providerConfigKey, // Use the Nango key (e.g., 'salesforce-2')
        this.connectionId, // Use the connection ID stored in this service instance
        actionName,
        payload
      );
      this.logger.info('Nango action response received', { actionName, connectionId: this.connectionId ? '***' : 'MISSING'});
      return response as NangoResponse;
    } catch (error: any) {
      this.logger.error('Nango triggerAction failed', { error: error.message, actionName, connectionId: this.connectionId ? '***' : 'MISSING' });
      throw error; // Re-throw for orchestrator
    }
  }

  /**
   * Fetches emails via Nango SDK.
   * Corrected signature to accept providerConfigKey and connectionId.
   */
  async fetchEmails(
      providerConfigKey: string, // e.g., 'google-mail'
      connectionId: string,    // specific connection ID
      options?: { backfillPeriodMs?: number; filters?: EmailFilter }
    ): Promise<NangoResponse> {
    const actionName = 'fetch-emails';
    const payload: Record<string, any> = {};
    if (options?.backfillPeriodMs) payload.backfillPeriodMs = options.backfillPeriodMs;
    if (options?.filters) payload.filters = options.filters;

    this.logger.info('Fetching emails via Nango', { actionName, connectionId: connectionId ? '***' : 'MISSING' });

    try {
      const response = await this.nango.triggerAction(
        providerConfigKey, // Use passed Nango key
        connectionId,    // Use passed connection ID
        actionName,
        payload
      );
      const dataLength = Array.isArray((response as any)?.data) ? (response as any).data.length : 0;
      this.logger.info('Email fetch completed successfully', { count: dataLength, connectionId: connectionId ? '***' : 'MISSING' });
      return response as NangoResponse;
    } catch (error: any) {
      this.logger.error('Failed to fetch emails via Nango', { error: error.message || error, connectionId: connectionId ? '***' : 'MISSING' });
      throw error;
    }
  }

   // Add generic proxy method if needed elsewhere
   async proxy(params: { providerConfigKey: string; connectionId: string; method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; endpoint: string; data?: Record<string, unknown>; headers?: Record<string, string>; retries?: number; })
    : Promise<NangoResponse>
   {
       this.logger.info(`Proxying request via Nango`, { provider: params.providerConfigKey, method: params.method });
       try {
          const response = await this.nango.proxy(params);
          return response as NangoResponse;
       } catch (error: any) {
          this.logger.error('Nango proxy request failed', { error: error.message, provider: params.providerConfigKey });
          throw error;
       }
   }
}
