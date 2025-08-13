import { NangoAction } from '../../models';
import { z } from 'zod';

// ====================================================
// Type Definitions
// ====================================================

// Define the EntityType
type EntityType = 'Account' | 'Contact' | 'Deal' | 'Article' | 'Case' | 'Lead';

// Define the IdentifierType
type IdentifierType = 'Id' | 'Name' | 'Email' | 'CaseNumber';

// Define filter operators
type FilterOperator = 'equals' | 'notEquals' | 'contains' | 'startsWith' | 'endsWith' | 
                     'greaterThan' | 'lessThan' | 'greaterOrEqual' | 'lessOrEqual' | 
                     'in' | 'notIn' | 'isNull' | 'isNotNull';

// Filter condition interface
interface FilterCondition {
  field: string;
  operator: FilterOperator;
  value?: any;
  values?: any[];
}

// Order by clause interface
interface OrderByClause {
  field: string;
  direction: 'ASC' | 'DESC';
}

// Enhanced filters interface
interface Filters {
  conditions?: FilterCondition[];
  logic?: string;
  orderBy?: OrderByClause[];
  limit?: number;
  offset?: number;
  includeFields?: string[];
  excludeFields?: string[];
  timeFrame?: 'recent' | 'lastWeek' | 'lastMonth' | 'lastQuarter';
}

// Batch options interface
interface BatchOptions {
  allOrNothing?: boolean;
  batchSize?: number;
}

// Interface for Salesforce record
interface SalesforceRecord {
  Id: string;
  [key: string]: any;
}

// Record result interface for batch operations
interface RecordResult {
  id: string | null;
  success: boolean;
  errors: string[] | null;
  before?: any;
  after?: any;
}

// Batch results interface
interface BatchResults {
  total: number;
  successful: number;
  failed: number;
  results: RecordResult[];
}

// UpdateEntityInput Interface with enhanced capabilities
interface UpdateEntityInput {
  operation: 'update';
  entityType: EntityType;
  // Single record identification
  identifier?: string;
  identifierType?: IdentifierType;
  // Filter-based record selection
  filters?: Filters;
  // Fields to update (required)
  fields: Record<string, any>;
  // Batch update options
  batchOptions?: BatchOptions;
}

// UpdateEntitySchema Interface for response
interface UpdateEntitySchema {
  success: boolean;
  errors: string[] | null;
  // Single record result
  id?: string;
  before?: any;
  after?: any;
  // Batch update results
  records?: BatchResults;
  message: string;
}

// ====================================================
// Mappings and Configuration Constants
// ====================================================

// Mapping of EntityType to Salesforce Object Names
const salesforceObjectMapping: Record<EntityType, string> = {
  Account: "Account",
  Contact: "Contact",
  Deal: "Opportunity",
  Article: "Knowledge__kav",
  Case: "Case",
  Lead: "Lead"
};

// Mapping of EntityType to allowed IdentifierTypes
const entityIdentifierMap: Record<EntityType, IdentifierType[]> = {
  Account: ['Id', 'Name'],
  Contact: ['Id', 'Email'],
  Lead: ['Id', 'Email'],
  Deal: ['Id'],
  Article: ['Id'],
  Case: ['Id', 'CaseNumber'],
};

// Default field mapping for each entity type
const fieldMappings: Record<EntityType, Record<string, string>> = {
  Deal: {
    name: "Name",
    amount: "Amount",
    stage: "StageName",
    close_date: "CloseDate",
    account_id: "AccountId",
  },
  // Add mappings for other entity types as needed
  Account: {},
  Contact: {},
  Lead: {},
  Article: {},
  Case: {}
};

// ====================================================
// Validation Schemas with Zod
// ====================================================

// Validation schema for filter conditions
const filterConditionSchema = z.object({
  field: z.string().min(1, "Field name is required"),
  operator: z.enum([
    'equals', 'notEquals', 'contains', 'startsWith', 'endsWith',
    'greaterThan', 'lessThan', 'greaterOrEqual', 'lessOrEqual',
    'in', 'notIn', 'isNull', 'isNotNull'
  ]),
  value: z.any().optional(),
  values: z.array(z.any()).optional()
}).refine(data => {
  // Ensure values array is provided for 'in' and 'notIn' operators
  if ((data.operator === 'in' || data.operator === 'notIn') && (!data.values || !Array.isArray(data.values))) {
    return false;
  }
  // Ensure value is provided for operators that need it
  if (!['isNull', 'isNotNull'].includes(data.operator) && data.value === undefined) {
    return false;
  }
  return true;
}, {
  message: "Invalid combination of operator and values"
});

// Validation schema for orderBy clauses
const orderBySchema = z.object({
  field: z.string().min(1, "Field name is required"),
  direction: z.enum(['ASC', 'DESC'])
});

// Validation schema for filters
const filtersSchema = z.object({
  conditions: z.array(filterConditionSchema).optional(),
  logic: z.string().optional(),
  orderBy: z.array(orderBySchema).optional(),
  limit: z.number().int().positive().max(2000).optional(),
  offset: z.number().int().nonnegative().optional(),
  includeFields: z.array(z.string()).optional(),
  excludeFields: z.array(z.string()).optional(),
  timeFrame: z.enum(['recent', 'lastWeek', 'lastMonth', 'lastQuarter']).optional()
});

// Validation schema for batch options
const batchOptionsSchema = z.object({
  allOrNothing: z.boolean().optional(),
  batchSize: z.number().int().positive().max(200).optional()
});

// Validation schema for UpdateEntityInput
const updateEntityInputSchema = z.object({
  operation: z.literal('update'),
  entityType: z.enum(['Account', 'Contact', 'Deal', 'Article', 'Case', 'Lead']),
  identifier: z.string().optional(),
  identifierType: z.enum(['Id', 'Name', 'Email', 'CaseNumber']).optional(),
  filters: filtersSchema.optional(),
  fields: z.record(z.string(), z.any()).refine(
    (data) => Object.keys(data).length >= 1,
    "At least one field must be provided for update"
  ),
  batchOptions: batchOptionsSchema.optional()
}).refine(data => {
  // Either identifier + identifierType OR filters must be provided
  return (data.identifier && data.identifierType) || data.filters;
}, {
  message: "Either identifier + identifierType OR filters must be provided"
}).refine(data => {
  // If identifier is provided, identifierType must also be provided
  return !data.identifier || (data.identifier && data.identifierType);
}, {
  message: "If identifier is provided, identifierType must also be provided"
});

// ====================================================
// Error Classes
// ====================================================

class ValidationError extends Error {
  details: any;
  constructor(message: string, details?: any) {
    super(message);
    this.name = 'ValidationError';
    this.details = details;
  }
}

class SalesforceError extends Error {
  details: any;
  constructor(message: string, details?: any) {
    super(message);
    this.name = 'SalesforceError';
    this.details = details;
  }
}

// ====================================================
// Main updateEntity Function
// ====================================================

export default async function updateEntity(
  nango: NangoAction,
  input: UpdateEntityInput
): Promise<UpdateEntitySchema> {
  console.log('Received update input:', JSON.stringify(input, null, 2));

  try {
    // Validate Input using Zod
    updateEntityInputSchema.parse(input);

    const { 
      operation, 
      entityType, 
      identifier, 
      identifierType, 
      filters,
      fields,
      batchOptions = { allOrNothing: false, batchSize: 50 }
    } = input;

    console.log("Operation:", operation);

    // Define the Salesforce object name
    // Moved below to the if blocks where it's actually used

    // Check if we're doing a single record update or a filtered batch update
    if (identifier && identifierType) {
      // Single record update
      return await updateSingleRecord(nango, entityType, identifierType, identifier, fields);
    } else if (filters) {
      // Filtered batch update
      return await updateBatchRecords(nango, entityType, filters, fields, batchOptions);
    } else {
      throw new ValidationError("Invalid input: either identifier+identifierType or filters must be provided");
    }
  } catch (error: any) {
    console.error('Error in updateEntity:', error);

    let resultErrors: string[] = [];

    if (error instanceof z.ZodError) {
      resultErrors = error.errors.map(err => err.message);
    } else if (error instanceof ValidationError || error instanceof SalesforceError) {
      resultErrors = [error.message];
      if (error.details) {
        resultErrors.push(JSON.stringify(error.details));
      }
    } else if (error.response && error.response.data) {
      // Handle Salesforce API errors
      const salesforceErrors = error.response.data.errors || [error.response.data.message || 'Unknown Salesforce error'];
      resultErrors = salesforceErrors.map((err: any) => err.message || err);
    } else {
      resultErrors = [error.message || 'An unexpected error occurred'];
    }

    return {
      success: false,
      errors: resultErrors,
      message: `Failed to update ${input.entityType}. Error: ${resultErrors.join('; ')}`,
    };
  }
}

// ====================================================
// Helper Functions for Single Record Update
// ====================================================

/**
 * Updates a single record in Salesforce
 */
async function updateSingleRecord(
  nango: NangoAction,
  entityType: EntityType,
  identifierType: IdentifierType,
  identifier: string,
  fields: Record<string, any>
): Promise<UpdateEntitySchema> {
  // Check if identifierType is valid for the given entityType
  if (!entityIdentifierMap[entityType].includes(identifierType)) {
    throw new ValidationError(`Invalid identifierType: ${identifierType} for entityType: ${entityType}`);
  }

  // Construct SOQL query to fetch the record ID based on identifier
  const query = buildIdentifierQuery(entityType, identifierType, identifier);

  // Fetch the existing record
  const records = await fetchRecords(nango, query);

  if (records.length === 0) {
    throw new SalesforceError(`No ${entityType} found with ${identifierType} = '${identifier}'`);
  }

  if (records.length > 1 && identifierType !== 'Id') {
    throw new SalesforceError(`Multiple ${entityType} records found with ${identifierType} = '${identifier}'. Please use a unique identifier.`);
  }

  if (!records?.[0]) {
    throw new Error("No records found for update");
  }
  
  const recordId = records[0].Id;
  const salesforceObject = salesforceObjectMapping[entityType];

  // Fetch the existing record data for 'before' state
  const beforeData = await fetchEntityData(nango, salesforceObject, recordId);

  // Map and prepare fields for Salesforce API
  const salesforceFields = mapFieldsToSalesforce(entityType, fields);

  // Update the record in Salesforce
  await nango.patch({
    endpoint: `/services/data/v60.0/sobjects/${salesforceObject}/${recordId}`,
    data: salesforceFields,
  });

  console.log(`Updated ${entityType} with ID: ${recordId}`);

  // Fetch the updated record data for 'after' state
  const afterData = await fetchEntityData(nango, salesforceObject, recordId);

  return {
    success: true,
    errors: null,
    id: recordId,
    before: beforeData,
    after: afterData,
    message: `Successfully updated ${entityType} with ID: ${recordId}`,
  };
}

/**
 * Builds a query to fetch a record by identifier
 */
function buildIdentifierQuery(
  entityType: EntityType,
  identifierType: IdentifierType,
  identifier: string
): string {
  const salesforceObject = salesforceObjectMapping[entityType];
  const sanitizedIdentifier = sanitizeValue(identifier);

  let query = `SELECT Id FROM ${salesforceObject} WHERE`;
  
  if (identifierType === 'Id') {
    query += ` Id = '${sanitizedIdentifier}'`;
  } else {
    query += ` ${identifierType} = '${sanitizedIdentifier}'`;
  }
  
  query += ` LIMIT 1`;
  
  console.log('Built Identifier SOQL Query:', query);
  return query;
}

// ====================================================
// Helper Functions for Batch Record Updates
// ====================================================

/**
 * Updates multiple records based on filter criteria
 */
async function updateBatchRecords(
  nango: NangoAction,
  entityType: EntityType,
  filters: Filters,
  fields: Record<string, any>,
  batchOptions: BatchOptions
): Promise<UpdateEntitySchema> {
  const salesforceObject = salesforceObjectMapping[entityType];
  const allOrNothing = batchOptions.allOrNothing || false;
  const batchSize = batchOptions.batchSize || 50;
  
  // Build query to find records that match the filter criteria
  const query = buildFilteredQuery(entityType, filters);
  
  // Fetch records that match the filter
  const records = await fetchRecords(nango, query);
  
  if (records.length === 0) {
    return {
      success: true,
      errors: null,
      records: {
        total: 0,
        successful: 0,
        failed: 0,
        results: []
      },
      message: `No ${entityType} records found matching the filter criteria.`,
    };
  }
  
  console.log(`Found ${records.length} ${entityType} records to update.`);
  
  // Map fields to Salesforce format
  const salesforceFields = mapFieldsToSalesforce(entityType, fields);
  
  // Prepare batch results
  const batchResults: BatchResults = {
    total: records.length,
    successful: 0,
    failed: 0,
    results: []
  };
  
  // For small batches, fetch before state and perform individual updates
  if (records.length <= 5) {
    for (const record of records) {
      try {
        // Fetch before state
        const beforeData = await fetchEntityData(nango, salesforceObject, record.Id);
        
        // Update the record
        await nango.patch({
          endpoint: `/services/data/v60.0/sobjects/${salesforceObject}/${record.Id}`,
          data: salesforceFields,
        });
        
        // Fetch after state
        const afterData = await fetchEntityData(nango, salesforceObject, record.Id);
        
        // Add result
        batchResults.successful++;
        batchResults.results.push({
          id: record.Id,
          success: true,
          errors: null,
          before: beforeData,
          after: afterData
        });
      } catch (error: any) {
        batchResults.failed++;
        batchResults.results.push({
          id: record.Id,
          success: false,
          errors: [error.message || 'Unknown error during update'],
        });
        
        // If allOrNothing is true, abort the entire batch on first failure
        if (allOrNothing) {
          throw new SalesforceError(`Failed to update record ${record.Id}. Aborting batch due to allOrNothing=true.`, error);
        }
      }
    }
  } else {
    // For larger batches, use batch API for better performance
    // Process in chunks of batchSize
    const chunks = [];
    for (let i = 0; i < records.length; i += batchSize) {
      chunks.push(records.slice(i, i + batchSize));
    }
    
    for (const chunk of chunks) {
      try {
        // Prepare batch requests for Salesforce Composite API
        const batchRequests = chunk.map(record => ({
          method: 'PATCH',
          url: `/services/data/v60.0/sobjects/${salesforceObject}/${record.Id}`,
          richInput: salesforceFields
        }));
        
        // Execute batch update
        const batchResponse = await nango.post({
          endpoint: '/services/data/v60.0/composite/batch',
          data: {
            batchRequests,
            haltOnError: allOrNothing
          }
        });
        
        // Process batch results
        if (batchResponse.data && batchResponse.data.results) {
          batchResponse.data.results.forEach((result: any, index: number) => {
            const record = chunk[index];
            if (typeof record === 'undefined' || record === null) {
              console.warn(`Record at index ${index} is undefined, skipping this result`);
             
            }
            // Use type assertion to convince TypeScript that record is defined
            const recordId = (record as SalesforceRecord).Id;
            
            if (result.statusCode >= 200 && result.statusCode < 300) {
              batchResults.successful++;
              batchResults.results.push({
                id: recordId,
                success: true,
                errors: null
              });
            } else {
              batchResults.failed++;
              batchResults.results.push({
                id: recordId,
                success: false,
                errors: [result.errorMessage || 'Unknown error']
              });
            }
          });
        }
      } catch (error: any) {
        // Handle batch failure
        for (const record of chunk) {
          batchResults.failed++;
          batchResults.results.push({
            id: record.Id,
            success: false,
            errors: [error.message || 'Batch update failed']
          });
        }
        
        if (allOrNothing) {
          throw new SalesforceError('Batch update failed and allOrNothing=true', error);
        }
      }
    }
  }
  
  const message = batchResults.failed > 0 
    ? `Updated ${batchResults.successful} out of ${batchResults.total} ${entityType} records. ${batchResults.failed} failed.`
    : `Successfully updated ${batchResults.successful} ${entityType} records.`;
  
  return {
    success: batchResults.failed === 0,
    errors: batchResults.failed > 0 ? [`${batchResults.failed} records failed to update`] : null,
    records: batchResults,
    message
  };
}

/**
 * Builds a SOQL query based on filters
 */
function buildFilteredQuery(
  entityType: EntityType,
  filters?: Filters
): string {
  if (!filters) {
    filters = {};
  }
  
  // Always select Id for updates
  let baseQuery = 'SELECT Id';
  
  // Add FROM clause
  const salesforceObject = salesforceObjectMapping[entityType];
  baseQuery += ` FROM ${salesforceObject}`;
  
  // Build WHERE clause
  const whereClause = buildWhereClause(filters);
  if (whereClause) {
    baseQuery += ` WHERE ${whereClause}`;
  }
  
  // Add ORDER BY
  if (filters.orderBy && filters.orderBy.length > 0) {
    baseQuery += ' ORDER BY ' + filters.orderBy
      .map(order => `${order.field} ${order.direction}`)
      .join(', ');
  } else {
    baseQuery += ' ORDER BY Id ASC';
  }
  
  // Add LIMIT and OFFSET
  const limit = filters.limit || 200; // Default to 200 for batch updates
  baseQuery += ` LIMIT ${limit}`;
  
  if (filters.offset && filters.offset > 0) {
    baseQuery += ` OFFSET ${filters.offset}`;
  }
  
  console.log('Built Filtered SOQL Query:', baseQuery);
  return baseQuery;
}

/**
 * Builds a WHERE clause from filters
 */
function buildWhereClause(filters: Filters): string {
  const whereParts: string[] = [];
  
  // Add conditions if provided
  if (filters.conditions && filters.conditions.length > 0) {
    // Generate condition clauses with indexes
    const conditions = filters.conditions.map((condition) => {
      return buildConditionClause(condition);
    });
    
    // Apply logic string if provided, otherwise join with AND
    if (filters.logic) {
      // Replace condition numbers with actual conditions
      let whereClause = filters.logic;
      conditions.forEach((condition, index) => {
        whereClause = whereClause.replace(new RegExp(`\\b${index + 1}\\b`, 'g'), `(${condition})`);
      });
      whereParts.push(whereClause);
    } else {
      whereParts.push(conditions.join(' AND '));
    }
  }
  
  // Add TimeFrame condition if provided
  if (filters.timeFrame && filters.timeFrame !== 'recent') {
    const dateCondition = getDateCondition(filters.timeFrame);
    if (dateCondition) {
      whereParts.push(`LastModifiedDate ${dateCondition}`);
    }
  }
  
  return whereParts.join(' AND ');
}

/**
 * Build a single condition clause
 */
function buildConditionClause(condition: FilterCondition): string {
  const { field, operator, value, values } = condition;
  
  // Sanitize field name to prevent SOQL injection
  const sanitizedField = field.replace(/[^\w\.\_]/g, '');
  
  // Handle different operators
  switch (operator) {
    case 'equals':
      return `${sanitizedField} = '${sanitizeValue(value)}'`;
      
    case 'notEquals':
      return `${sanitizedField} != '${sanitizeValue(value)}'`;
      
    case 'contains':
      return `${sanitizedField} LIKE '%${sanitizeValue(value)}%'`;
      
    case 'startsWith':
      return `${sanitizedField} LIKE '${sanitizeValue(value)}%'`;
      
    case 'endsWith':
      return `${sanitizedField} LIKE '%${sanitizeValue(value)}'`;
      
    case 'greaterThan':
      return `${sanitizedField} > ${isNaN(value) ? `'${sanitizeValue(value)}'` : value}`;
      
    case 'lessThan':
      return `${sanitizedField} < ${isNaN(value) ? `'${sanitizeValue(value)}'` : value}`;
      
    case 'greaterOrEqual':
      return `${sanitizedField} >= ${isNaN(value) ? `'${sanitizeValue(value)}'` : value}`;
      
    case 'lessOrEqual':
      return `${sanitizedField} <= ${isNaN(value) ? `'${sanitizeValue(value)}'` : value}`;
      
    case 'in':
      if (!values || !Array.isArray(values)) return `${sanitizedField} = '${sanitizeValue(value)}'`;
      return `${sanitizedField} IN (${values.map(v => `'${sanitizeValue(v)}'`).join(', ')})`;
      
    case 'notIn':
      if (!values || !Array.isArray(values)) return `${sanitizedField} != '${sanitizeValue(value)}'`;
      return `${sanitizedField} NOT IN (${values.map(v => `'${sanitizeValue(v)}'`).join(', ')})`;
      
    case 'isNull':
      return `${sanitizedField} = NULL`;
      
    case 'isNotNull':
      return `${sanitizedField} != NULL`;
      
    default:
      return `${sanitizedField} = '${sanitizeValue(value)}'`;
  }
}

/**
 * Generates a date condition string for SOQL queries based on the timeframe.
 */
function getDateCondition(timeFrame: string): string {
  const now = new Date();
  let date = new Date();

  switch (timeFrame) {
    case 'lastWeek':
      date.setDate(now.getDate() - 7);
      break;
    case 'lastMonth':
      date.setMonth(now.getMonth() - 1);
      break;
    case 'lastQuarter':
      date.setMonth(now.getMonth() - 3);
      break;
    default:
      return '';
  }

  // Format date to ISO string without milliseconds and timezone
  const isoDate = date.toISOString().split('.')[0] + 'Z';
  return `>= ${isoDate}`;
}

/**
 * Sanitize values to prevent SOQL injection
 */
function sanitizeValue(value: any): string {
  if (value === null || value === undefined) return '';
  
  // Convert to string and escape single quotes
  return String(value).replace(/'/g, "\\'");
}

// ====================================================
// Shared Utility Functions
// ====================================================

/**
 * Fetches records from Salesforce using the provided SOQL query.
 */
async function fetchRecords(nango: NangoAction, query: string): Promise<SalesforceRecord[]> {
  const endpoint = '/services/data/v60.0/query';

  try {
    const response = await nango.get({
      endpoint,
      params: { q: query },
    });

    // Check for Salesforce errors
    if (response.data.errors) {
      const errorMessages = response.data.errors.map((err: any) => err.message || 'Unknown error');
      throw new Error(errorMessages.join('; '));
    }

    return response.data.records || [];
  } catch (error: any) {
    console.error('Error fetching records from Salesforce:', error);
    throw new Error(error.message || 'Failed to fetch records from Salesforce');
  }
}

/**
 * Fetches the full record data from Salesforce.
 */
async function fetchEntityData(nango: NangoAction, salesforceObject: string, id: string): Promise<any> {
  try {
    const endpoint = `/services/data/v60.0/sobjects/${salesforceObject}/${id}`;
    const response = await nango.get({ endpoint });

    // Check for Salesforce errors
    if (response.data.errors) {
      const errorMessages = response.data.errors.map((err: any) => err.message || 'Unknown error');
      throw new Error(errorMessages.join('; '));
    }

    return response.data;
  } catch (error: any) {
    console.error(`Failed to fetch ${salesforceObject} data with ID ${id}:`, error);
    return {};
  }
}

/**
 * Maps internal field names to Salesforce API field names based on entityType.
 */
function mapFieldsToSalesforce(entityType: EntityType, fields: Record<string, any>): Record<string, any> {
  // Get entity-specific field mapping
  const mapping = fieldMappings[entityType] || {};
  
  // Map fields using the mapping
  if (Object.keys(mapping).length > 0) {
    return Object.entries(fields).reduce((acc, [key, value]) => {
      const salesforceField = mapping[key] || key;
      acc[salesforceField] = value;
      return acc;
    }, {} as Record<string, any>);
  }
  
  // If no specific mapping, return fields as-is
  return fields;
}