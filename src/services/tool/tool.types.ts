// src/services/tool/tool.types.ts

// Existing type definitions
export interface ToolConfig {
    name: string;
    description: string;
    nangoService: any;
    default_params: {};
    providerConfigKey: string;
    configPath?: string; // Add this
    parameters: any;
    input?: {
        entityType?: {
            enum: string[];
        };
        fields?: {
            required: string[];
            properties: Record<string, any>;
        };
    };
}

export interface ToolCall {
    id: string;
    name: string;
    arguments: Record<string, any>;
    sessionId: string;
    userId: string;
}


export enum EntityType {
    Account = 'Account',
    Contact = 'Contact',
    Lead = 'Lead',
    Opportunity = 'Opportunity',
    Campaign = 'Campaign',
    Case = 'Case',
    Task = 'Task',
    Event = 'Event',
    // Add other entity types as needed
}

export interface ProviderConfig {
    endpoint: string;
    provider_config_key: string;
    connection_id: string;
    objects: string[];
}

// New type definitions for advanced inputs

// Define Filters interface
export interface Filters {
    conditions?: {
        field: string;
        operator: string;
        value?: any;
        values?: any[];
    }[];
    logic?: string;
    orderBy?: {
        field: string;
        direction: string;
    }[];
    limit?: number;
    offset?: number;
    includeFields?: string[];
    excludeFields?: string[];
    timeFrame?: string;
    groupBy?: string[];
    aggregate?: {
        function: string;
        field: string;
        alias: string;
    }[];
    includeDeleted?: boolean;
}

// Define BatchOptions interface
export interface BatchOptions {
    allOrNothing?: boolean;
    batchSize?: number;
}

// Define CreateEntityInput interface
export interface CreateEntityInput {
    operation: string;
    entityType: string;
    fields?: Record<string, any>;
    records?: Record<string, any>[];
    checkDuplicates?: boolean;
    duplicateFilters?: Filters;
    useTemplate?: string;
    templateParams?: Record<string, any>;
}

// Define UpdateEntityInput interface
export interface UpdateEntityInput {
    operation: string;
    entityType: string;
    identifier?: string;
    identifierType?: string;
    filters?: Filters;
    fields: Record<string, any>;
    batchOptions?: BatchOptions;
}

// Define FetchEntityInput interface
export interface FetchEntityInput {
    operation: string;
    entityType: string;
    identifier?: string;
    identifierType?: string;
    filters?: Filters;
    fields?: string[];
    // Add any other fetch-specific options
}

// Define EmailFilter interface for email filtering
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
        after?: string;
        before?: string;
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

// Define FetchEmailsInput interface
export interface FetchEmailsInput {
    backfillPeriodMs?: number;
    filters?: EmailFilter;
}