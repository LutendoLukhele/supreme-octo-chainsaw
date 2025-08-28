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

  constructor() {
    if (!CONFIG.NANGO_SECRET_KEY) {
        throw new Error("Configuration error: NANGO_SECRET_KEY is missing.");
    }
    this.logger = winston.createLogger({ /* ... */ });
    this.nango = new Nango({ secretKey: CONFIG.NANGO_SECRET_KEY });
    this.logger.info(`NangoService initialized.`);
  }

  public async triggerGenericNangoAction(
  providerConfigKey: string,
  connectionId: string,
  actionName: string, // e.g., 'create-meeting'
  actionPayload: Record<string, any>
): Promise<any> { // Using `any` for a generic response type
  this.logger.info('Triggering generic Nango action', { providerConfigKey, actionName });

  try {
    const response = await this.nango.triggerAction(
        providerConfigKey,
        connectionId,
        actionName,
        actionPayload
    );
    return response;
  } catch (error: any) {
    this.logger.error('Generic Nango action failed', {
      error: error.message || 'An unknown error occurred',
      actionName,
    });
    throw error;
  }
}

  // --- FIX: This method is now fully aligned with all Salesforce Nango scripts ---
  async triggerSalesforceAction(
  providerConfigKey: string, 
  connectionId: string,
  actionPayload: Record<string, any>
): Promise<NangoResponse> {
    
    this.logger.info('Executing Salesforce action', { providerConfigKey, connectionId: '***', operation: actionPayload.operation, entityType: actionPayload.entityType });

    let actionName: string;

    // Determine the action name from the payload's operation
    switch (actionPayload.operation) {
      case 'create':
        actionName = 'salesforce-create-entity';
        break;
      case 'update':
        actionName = 'salesforce-update-entity';
        break;
      case 'fetch':
        actionName = 'salesforce-fetch-entity';
        break;
      default:
        const errorMessage = `Unsupported Salesforce operation: ${actionPayload.operation}`;
        this.logger.error(errorMessage, { operation: actionPayload.operation });
        throw new Error(errorMessage);
    }

    this.logger.info('Triggering Nango action via direct API call', { actionName });

    try {
      const response = await axios.post(
        'https://api.nango.dev/action/trigger',
        {
          action_name: actionName,
          // The 'input' is now the clean payload passed directly into this function
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
      return response.data as NangoResponse;

    } catch (error: any) {
      this.logger.error('Nango direct API call failed', { 
        error: error.response?.data || error.message, 
        actionName 
      });
      // Re-throw the error with details from Nango's response if available
      throw new Error(error.response?.data?.message || `Request failed with status code ${error.response?.status}`);
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
      // Re-throw a descriptive error
      throw new Error(error.response?.data?.message || `Request failed for '${actionName}' with status code ${error.response?.status}`);
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
      const response = await this.nango.triggerAction(
        providerConfigKey, connectionId, actionName, args
      );
      return response as NangoResponse;
    } catch (error: any) {
      this.logger.error('Failed to create calendar event', { error: error.message || error });
      throw error;
    }
  }
}