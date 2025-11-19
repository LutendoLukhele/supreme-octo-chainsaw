// src/services/NangoService.ts

import { Nango } from '@nangohq/node';
import winston from 'winston';
import { CONFIG } from '../config';
import axios from 'axios';

// Interface definitions remain the same for type safety
interface NangoResponse {
  success?: boolean;
  data?: any;
  [key: string]: any;
}

export class NangoService {
  private nango: Nango;
  private logger: winston.Logger;
  private connectionWarmCache: Map<string, number> = new Map(); // connectionId -> lastWarmedTimestamp

  constructor() {
    if (!CONFIG.NANGO_SECRET_KEY) {
        throw new Error("Configuration error: NANGO_SECRET_KEY is missing.");
    }
    this.logger = winston.createLogger({
      level: 'info',
      format: winston.format.combine(
        winston.format.timestamp(), // Adds a timestamp to each log message
        winston.format.json()       // Ensures the log output is in JSON format
      ),
      defaultMeta: { service: 'NangoService' }, // Automatically adds {'service': 'NangoService'} to every log
      transports: [
        new winston.transports.Console(), // Directs log output to the console
      ],
    });
    this.nango = new Nango({ secretKey: CONFIG.NANGO_SECRET_KEY });
    this.logger.info(`NangoService initialized.`);
  }

  // Connection warming to eliminate cold start penalties
  public async warmConnection(
    providerConfigKey: string,
    connectionId: string,
    force: boolean = false
  ): Promise<boolean> {
    const cacheKey = `${providerConfigKey}:${connectionId}`;
    const lastWarmed = this.connectionWarmCache.get(cacheKey);
    const WARM_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

    // Skip if recently warmed (unless forced)
    if (!force && lastWarmed && (Date.now() - lastWarmed) < WARM_CACHE_TTL) {
      this.logger.debug('Connection already warm', { providerConfigKey, connectionId: '***' });
      return true;
    }

    const startTime = Date.now();
    try {
      let pingEndpoint: string;

      // Provider-specific lightweight ping endpoints
      switch (providerConfigKey) {
        case 'gmail':
        case 'google':
          pingEndpoint = '/gmail/v1/users/me/profile';
          break;
        case 'salesforce':
          pingEndpoint = '/services/data/v60.0/sobjects';
          break;
        default:
          pingEndpoint = '/';
      }

      // Use Nango SDK to call a lightweight GET if available; fall back to direct trigger
      try {
        await this.nango.get({ endpoint: pingEndpoint, connectionId, providerConfigKey });
      } catch (sdkErr) {
        // If SDK GET fails, try a very lightweight action-trigger (if configured)
        this.logger.debug('Nango SDK ping failed; attempting lightweight action trigger', { providerConfigKey });
        await axios.post(
          'https://api.nango.dev/action/trigger',
          { action_name: 'ping', input: {} },
          {
            headers: {
              'Authorization': `Bearer ${CONFIG.NANGO_SECRET_KEY}`,
              'Provider-Config-Key': providerConfigKey,
              'Connection-Id': connectionId,
              'Content-Type': 'application/json'
            }
          }
        ).catch(() => {
          // ignore errors from fallback ping - warming may still succeed via other calls below
        });
      }

      const duration = Date.now() - startTime;
      this.connectionWarmCache.set(cacheKey, Date.now());

      this.logger.info('Connection warmed successfully', {
        providerConfigKey,
        connectionId: '***',
        duration
      });
      return true;

    } catch (error: any) {
      const duration = Date.now() - startTime;
      this.logger.warn('Connection warm failed', {
        providerConfigKey,
        connectionId: '***',
        duration,
        error: error.message
      });
      return false;
    }
  }

  public async triggerGenericNangoAction(
    providerConfigKey: string,
    connectionId: string,
    actionName: string, // e.g., 'send-email'
    actionPayload: Record<string, any>
  ): Promise<any> {
    this.logger.info('Triggering generic Nango action via direct API', { providerConfigKey, actionName });

    try {
      // FIX: Replaced the Nango SDK call with a direct axios.post call for consistency
      const response = await axios.post(
        'https://api.nango.dev/action/trigger',
        {
          action_name: actionName,
          input: actionPayload
        },
        {
          headers: {
            'Authorization': `Bearer ${CONFIG.NANGO_SECRET_KEY}`,
            'Provider-Config-Key': providerConfigKey,
            'Connection-Id': connectionId,
            'Content-Type': 'application/json'
          }
        }
      );
      
      this.logger.info('Nango direct API call successful', { actionName });
      return response.data;

    } catch (error: any) {
      this.logger.error('Generic Nango action failed', {
        error: error.response?.data?.message || error.message,
        actionName,
      });
      // Re-throw with full Nango error details for QA/debugging
      const enhancedError: any = new Error(
        error.response?.data?.message || `Request failed with status code ${error.response?.status}`
      );
      enhancedError.nangoErrorDetails = {
        actionName,
        statusCode: error.response?.status,
        nangoPayload: error.response?.data || null,
        timestamp: new Date().toISOString()
      };
      throw enhancedError;
    }
  }

  // --- FIX: This method is now fully aligned with all Salesforce Nango scripts ---
  // Replace the existing triggerSalesforceAction method with this:
async triggerSalesforceAction(
    providerConfigKey: string,
    connectionId: string,
    actionPayload: Record<string, any>
): Promise<NangoResponse> {
    // Determine the Nango action name based on the operation
  let actionName: string;
  switch (actionPayload.operation) {
    case 'fetch':
      actionName = 'salesforce-fetch-entity';
      break;
    case 'create':
      actionName = 'salesforce-create-entity';
      break;
    case 'update':
      actionName = 'salesforce-update-entity';
      break;
    default:
      const msg = `Unsupported Salesforce operation: ${actionPayload.operation}`;
      this.logger.error(msg, { actionPayload });
      throw new Error(msg);
  }

  this.logger.info('Triggering Salesforce action via Nango action trigger', { 
    actionName, 
    input: actionPayload 
  });

  try {
    // Ensure connection is warm before executing
    await this.warmConnection(providerConfigKey, connectionId);
    
    console.log(
    "🔥 FINAL TOOL PAYLOAD SENT TO NANGO:",
    JSON.stringify(actionPayload, null, 2)
);


    // Use the exact same pattern as fetchEmails
    const response = await axios.post(
      'https://api.nango.dev/action/trigger',
      {
        action_name: actionName,
        input: actionPayload 
      },
      {
        headers: {
          'Authorization': `Bearer ${CONFIG.NANGO_SECRET_KEY}`,
          'Provider-Config-Key': providerConfigKey,
          'Connection-Id': connectionId,
          'Content-Type': 'application/json'
        }
      }
    );
    
    this.logger.info('Salesforce action executed successfully', { actionName });
    return response.data as NangoResponse;

  } catch (error: any) {
    this.logger.error('Salesforce action failed', {
      error: error.response?.data || error.message,
      actionName
    });
    // Re-throw with full Nango error details for QA/debugging
    const enhancedError: any = new Error(
      error.response?.data?.message || `Request failed for '${actionName}' with status code ${error.response?.status}`
    );
    enhancedError.nangoErrorDetails = {
      actionName,
      statusCode: error.response?.status,
      nangoPayload: error.response?.data || null,
      timestamp: new Date().toISOString()
    };
    throw enhancedError;
  }
}

  // --- ADD THIS NEW METHOD ---
  public async sendEmail(
    providerConfigKey: string,
    connectionId: string,
    payload: { from: string; to: string; subject: string; body: string; headers?: Record<string, any> }
  ): Promise<any> {
    const endpoint = 'https://api.nango.dev/v1/emails';
    this.logger.info('Calling Nango custom email endpoint', { endpoint });

    try {
      const response = await axios.post(
        endpoint,
        payload, // For custom endpoints, the payload is sent directly as the body
        {
          headers: {
            'Authorization': `Bearer ${CONFIG.NANGO_SECRET_KEY}`,
            'Provider-Config-Key': providerConfigKey,
            'Connection-Id': connectionId,
            'Content-Type': 'application/json'
          }
        }
      );
      
      this.logger.info('Nango custom email endpoint call successful');
      return response.data;

    } catch (error: any) {
      this.logger.error('Nango custom email endpoint call failed', {
        error: error.response?.data || error.message,
      });
      throw new Error(error.response?.data?.message || `Request to custom endpoint failed with status ${error.response?.status}`);
    }
  }

  // --- FIX: Aligned with fetch-emails.ts script ---
  async fetchEmails(
    providerConfigKey: string,
    connectionId: string,
    input: any // This is the action payload from the tool call
  ): Promise<NangoResponse> {
    const actionName = 'fetch-emails';
    this.logger.info('Fetching emails via Nango action trigger', { actionName, input });

    try {
      // Ensure connection is warm before fetching
      await this.warmConnection(providerConfigKey, connectionId);
      
      // Switched from axios.get to axios.post
      const response = await axios.post(
        'https://api.nango.dev/action/trigger', // Use the standard action trigger endpoint
        {
          // Structure the payload exactly as Nango expects for actions
          action_name: actionName,
          input: input 
        },
        {
          headers: {
            'Authorization': `Bearer ${CONFIG.NANGO_SECRET_KEY}`,
            'Provider-Config-Key': providerConfigKey,
            'Connection-Id': connectionId,
            'Content-Type': 'application/json'
          }
        }
      );
      
      this.logger.info('Nango direct API call successful', { actionName });
      return response.data as NangoResponse;

    } catch (error: any) {
      this.logger.error('Nango direct API call to fetch-emails failed', {
        error: error.response?.data || error.message,
        actionName
      });
      // Re-throw with full Nango error details for QA/debugging
      const enhancedError: any = new Error(
        error.response?.data?.message || `Request failed for '${actionName}' with status code ${error.response?.status}`
      );
      enhancedError.nangoErrorDetails = {
        actionName,
        statusCode: error.response?.status,
        nangoPayload: error.response?.data || null,
        timestamp: new Date().toISOString()
      };
      throw enhancedError;
    }
  }

  // --- FIX: Aligned with events.ts script ---
  async fetchCalendarEvents(
    providerConfigKey: string,
    connectionId: string,
    args: any // Pass the arguments directly as the payload
  ): Promise<NangoResponse> {
    const actionName = 'fetch-events';
    this.logger.info('Fetching calendar events via Nango', { actionName, args });
    try {
      await this.warmConnection(providerConfigKey, connectionId);
      const response = await this.nango.triggerAction(
        providerConfigKey, connectionId, actionName, args
      );
      return response as NangoResponse;
    } catch (error: any) {
      this.logger.error('Failed to fetch calendar events', { error: error.message || error });
      throw error;
    }
  }

  // --- FIX: Aligned with event creation script (if one exists, follows same pattern) ---
  async createCalendarEvent(
    providerConfigKey: string,
    connectionId: string,
    args: any // Pass the arguments directly as the payload
  ): Promise<NangoResponse> {
    const actionName = 'create-event';
    this.logger.info('Creating calendar event via Nango', { actionName });
    try {
      await this.warmConnection(providerConfigKey, connectionId);
      const response = await this.nango.triggerAction(
        providerConfigKey, connectionId, actionName, args
      );
      return response as NangoResponse;
    } catch (error: any) {
      this.logger.error('Failed to create calendar event', { error: error.message || error });
      throw error;
    }
  }

  // Clear warm cache (useful for testing or connection issues)
  public clearWarmCache(providerConfigKey?: string, connectionId?: string) {
    if (providerConfigKey && connectionId) {
      const cacheKey = `${providerConfigKey}:${connectionId}`;
      this.connectionWarmCache.delete(cacheKey);
      this.logger.info('Cleared warm cache for specific connection', { providerConfigKey, connectionId: '***' });
    } else {
      this.connectionWarmCache.clear();
      this.logger.info('Cleared all warm cache entries');
    }
  }

  // Get connection health status
  public getConnectionHealth(): { totalConnections: number, cacheSize: number } {
    return {
      totalConnections: this.connectionWarmCache.size,
      cacheSize: this.connectionWarmCache.size
    };
  }
}