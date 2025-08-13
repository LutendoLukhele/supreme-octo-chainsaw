import { NangoAction } from '../../models'; // NangoAction is fine to import
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid'; // For generating 'id' in the output

// ====================================================
// Type Definitions
// ====================================================

// Define the EntityType
type EntityType = 'Account' | 'Contact' | 'Deal' | 'Article' | 'Case' | 'Lead';
// Define the IdentifierType
type IdentifierType = 'Id' | 'Name' | 'Email' | 'CaseNumber' | 'None'; // Keep local for Zod, ensure Zod schema handles 'None'

// Define filter operators
type FilterOperator = 'equals' | 'notEquals' | 'contains' | 'startsWith' | 'endsWith' | 
                     'greaterThan' | 'lessThan' | 'greaterOrEqual' | 'lessOrEqual' | 
                     'in' | 'notIn' | 'isNull' | 'isNotNull';

// Filter condition interface
interface FilterCondition {
  field: string;
  operator: FilterOperator; // This is already required
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
  timeFrame?: 'recent' | 'lastWeek' | 'lastMonth' | 'lastQuarter' | 'all_time'; // Keep local for Zod, ensure Zod schema handles 'all_time'
  groupBy?: string[];
  aggregate?: AggregateFunction[];
  includeDeleted?: boolean;
}

// Aggregate function interface
interface AggregateFunction {
  function: 'count' | 'sum' | 'avg' | 'min' | 'max';
  field: string;
  alias: string;
}

// FetchEntityInput Interface
interface FetchEntityInput {
  operation: 'fetch';
  entityType: EntityType;
  // Traditional single entity fetch
  identifier?: string;
  identifierType?: IdentifierType; // Uses local enum
  timeFrame?: 'recent' | 'lastWeek' | 'lastMonth' | 'lastQuarter';
  // Advanced filtering
  filters?: Filters;
  // Output format
  format?: 'detailed' | 'simple' | 'raw';
  // Return count only
  countOnly?: boolean;
  // Maximum fetch limit
  limit?: number;
}

// Local FetchEntitySchema interface for the script's return type promise
// This uses direct types, matching what the script naturally produces.
// Nango platform will validate the JSON output against its YAML definition.
interface FetchEntitySchema {
  id: string; // Added id based on Nango dashboard expectation
  success: boolean;
  errors: string[] | null;
  data: Record<string, any> | any[]; // Allow object for single record/wrapped list, or array for raw list
  count: number; // Changed from optional
  totalCount: number; // Changed from optional
  hasMore: boolean; // Changed from optional
  nextOffset?: number | null; // Allow null
  aggregates?: Record<string, any> | null; // Allow null
  message: string;
}

// Salesforce record interface - making Id optional to handle count results
interface SalesforceRecord {
  Id?: string;
  [key: string]: any;
}


// ====================================================
// Mapping and Configuration Constants
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

// Default field mapping for response formatting
const responseFieldMappings: Record<EntityType, Record<string, string>> = {
  Account: {
    Id: "id",
    Name: "name",
    Website: "website",
    Description: "description",
    NumberOfEmployees: "no_employees",
    Industry: "industry",
    Phone: "phone",
    LastModifiedDate: "last_modified_date"
  },
  Contact: {
    Id: "id",
    FirstName: "first_name",
    LastName: "last_name",
    Email: "email",
    AccountId: "account_id",
    Phone: "phone",
    LastModifiedDate: "last_modified_date"
  },
  Deal: {
    Id: "id",
    Name: "name",
    Amount: "amount",
    StageName: "stage",
    AccountId: "account_id",
    CloseDate: "close_date",
    LastModifiedDate: "last_modified_date"
  },
  Article: {
    Id: "id",
    Title: "title",
    UrlName: "url_name",
    Summary: "summary",
    LastModifiedDate: "last_modified_date"
  },
  Case: {
    Id: "id",
    CaseNumber: "case_number",
    Subject: "subject",
    Status: "status",
    Priority: "priority",
    AccountId: "account_id",
    ContactId: "contact_id",
    LastModifiedDate: "last_modified_date"
  },
  Lead: {
    Id: "id",
    FirstName: "first_name",
    LastName: "last_name",
    Email: "email",
    Company: "company",
    Status: "status",
    Phone: "phone",
    Rating: "rating",
    LastModifiedDate: "last_modified_date"
  }
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
  value: z.any().optional(), // value is optional for 'isNull', 'isNotNull', 'in', 'notIn'
  values: z.array(z.any()).optional() // values is optional, but required if operator is 'in' or 'notIn'
}).refine(data => {
  if ((data.operator === 'in' || data.operator === 'notIn') && (!data.values || !Array.isArray(data.values))) {
    // For 'in'/'notIn', 'values' array must be present and non-empty
    return false;
  }
  if (!['isNull', 'isNotNull', 'in', 'notIn'].includes(data.operator) && data.value === undefined) {
    // For other operators (not 'isNull', 'isNotNull', 'in', 'notIn'), 'value' must be present
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

// Validation schema for aggregate functions
const aggregateFunctionSchema = z.object({
  function: z.enum(['count', 'sum', 'avg', 'min', 'max']),
  field: z.string().min(1, "Field name is required"),
  alias: z.string().min(1, "Alias is required")
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
  timeFrame: z.enum(['recent', 'lastWeek', 'lastMonth', 'lastQuarter', 'all_time']).optional(), // Added 'all_time'
  groupBy: z.array(z.string()).optional(),
  aggregate: z.array(aggregateFunctionSchema).optional(),
  includeDeleted: z.boolean().optional()
});

// Validation schema for the fetch input
const fetchEntityInputSchema = z.object({
  operation: z.literal('fetch'),
  entityType: z.enum(['Account', 'Contact', 'Deal', 'Article', 'Case', 'Lead']),
  identifier: z.object({
    type: z.string().optional(),
    nullable: z.boolean().optional()
  }).optional(),
  identifierType: z.object({
    type: z.enum(['Id', 'Name', 'Email', 'CaseNumber', 'None']).optional(),
    nullable: z.boolean().optional()
  }).optional(),
  timeFrame: z.object({
    type: z.enum(['recent', 'lastWeek', 'lastMonth', 'lastQuarter', 'all_time']).optional(),
    nullable: z.boolean().optional()
  }).optional(),
  filters: filtersSchema.optional(), // This uses the local Filters interface to define the Zod schema
  // NangoService sends filters as { type: { actual_filters_object }, nullable: true }
  // The script's Zod schema for 'filters' should expect the actual_filters_object directly.
  // If Nango platform passes filters: { type: { actual_filters_object }... } to the script,
  // then this Zod schema needs to change to:
  // filters: z.object({ type: filtersSchema.optional(), nullable: z.boolean().optional() }).optional(),
  // For now, assuming Nango unwraps filters.type before sending to script.

  format: z.object({
    type: z.enum(['detailed', 'simple', 'raw']).optional(),
    nullable: z.boolean().optional()
  }).optional(),
  countOnly: z.object({
    type: z.boolean().optional(),
    nullable: z.boolean().optional()
  }).optional(),
  limit: z.object({
    type: z.number().int().positive().max(2000).optional(),
    nullable: z.boolean().optional()
  }).optional()
}).refine(data => {
  // Either identifier + identifierType OR filters must be provided
  // Unless it's countOnly, which can work with just entityType
  return (data.identifier && data.identifierType) || 
         data.filters || (data.identifier && data.identifier.toLowerCase() === 'all') || // Allow identifier='all'
         data.countOnly?.type === true;
}, {
  message: "Either (identifier + identifierType) OR filters OR (identifier.type='all') must be provided (unless countOnly.type is true)"
}).refine(data => {
  // If identifier is provided (and not 'all'), identifierType must also be provided (and not 'None')
  return !data.identifier?.type || (data.identifier.type.toLowerCase() === 'all') || (data.identifier?.type && data.identifierType?.type && data.identifierType.type !== 'None');
}, {
  message: "If a specific identifier (not 'all') is provided, identifierType (not 'None') must also be provided (check .type property)"
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
// Main fetchEntity Function
// ====================================================

export default async function fetchEntity(
  nango: NangoAction,
  input: FetchEntityInput
): Promise<FetchEntitySchema> {
  const actionInstanceId = uuidv4(); // For the output 'id' field
  console.log(`Executing fetchEntity (ID: ${actionInstanceId}) with input:`, JSON.stringify(input, null, 2));

  try {
    // Validate Input using Zod
    const validatedInput = fetchEntityInputSchema.parse(input);

    const { 
      operation, 
      entityType, 
      // These will now be objects like { type: 'value', nullable: true } or undefined
      identifier: identifierWrapper, 
      identifierType: identifierTypeWrapper, 
      timeFrame: timeFrameWrapper,
      filters, 
      format: formatWrapper,
      countOnly: countOnlyWrapper,
      limit: limitWrapper,
    } = validatedInput;

    // Extract actual values from wrappers
    const identifier = identifierWrapper?.type;
    const identifierType = identifierTypeWrapper?.type;
    const timeFrame = timeFrameWrapper?.type;
    const format = formatWrapper?.type || 'detailed';
    const countOnly = countOnlyWrapper?.type || false;
    const limitFromInput = limitWrapper?.type;

    const effectiveLimit = limitFromInput || (filters as Filters)?.limit || 50;

    console.log("Operation:", operation);
    // Build the query based on input type
    let query: string;
    let isCountQuery = false;
    let isAggregateQuery = false;

    if (countOnly) {
      // Count-only query
      query = buildCountQuery(entityType, filters);
      isCountQuery = true;
    } else if (filters?.aggregate && filters.aggregate.length > 0) {
      // Aggregate query
      query = buildAggregateQuery(entityType, filters);
      isAggregateQuery = true;
    } else if (identifier && identifierType && identifierType !== 'None' && identifier.toLowerCase() !== 'all') { // Use unwrapped values
      // Single entity query by a specific identifier
      query = buildIdentifierQuery(entityType, identifierType, identifier, timeFrame, effectiveLimit, filters);
    } else if (filters || (identifier && identifier.toLowerCase() === 'all')) {
      // Advanced filtered query OR "fetch all"
      query = buildFilteredQuery(entityType, filters, effectiveLimit, identifier?.toLowerCase() === 'all');
    } else {
      throw new ValidationError("Invalid input: either identifier+identifierType or filters must be provided");
    }

    // Execute the query
    const records = await fetchRecords(nango, query);
    
    // Process the results based on query type
    if (isCountQuery) {
      // For count queries, return only the count
      const count = records.length > 0 && records[0] ? (records[0]['expr0'] || 0) : 0;
      
      return {
        id: actionInstanceId,
        success: true,
        errors: null,
        data: {}, // data is Record<string, any> or any[]
        count: count,
        totalCount: count,
        hasMore: false,
        nextOffset: null,
        aggregates: null,
        message: `Found ${count} ${entityType} record(s)`
      };
    } else if (isAggregateQuery) {
      // For aggregate queries, format the aggregate results
      const aggregateResults = formatAggregateResults(records);
      return {
        id: actionInstanceId,
        success: true,
        errors: null,
        data: aggregateResults, // data is Record<string, any> or any[]
        count: records.length, // Number of aggregate groups
        totalCount: records.length,
        hasMore: false,
        nextOffset: null,
        aggregates: aggregateResults,
        message: `Successfully executed aggregate query on ${entityType}`
      };
    } else {
      // For normal queries, format the records based on the requested format
      const formattedRecords = formatRecords(entityType, records, format);
      const recordCount = formattedRecords.length;

      const hasMoreRecords = recordCount >= effectiveLimit;
      const currentOffset = (filters as Filters)?.offset || 0;
      const nextOffsetValue = hasMoreRecords ? (currentOffset + recordCount) : null;
      
      return {
        id: actionInstanceId,
        success: true,
        errors: null,
        data: { records: formattedRecords }, // Wrap list in an object to satisfy Record<string,any> if needed by Nango
        count: recordCount,
        totalCount: recordCount, 
        hasMore: hasMoreRecords,
        nextOffset: nextOffsetValue,
        aggregates: null,
        message: `Successfully fetched ${formattedRecords.length} ${entityType} record(s)`
      };
    }
  } catch (error: any) {
    console.error('Error in fetchEntity:', error);

    let errorMessages: string[] = [String(error.message || 'An unexpected error occurred.')];
    let detailedMessage = `Failed to fetch ${input.entityType}.`; // Use original input for message

    if (error instanceof z.ZodError) { // This will now show paths like 'identifier.type' if Zod fails on the inner type
      errorMessages = error.errors.map(err => `${err.path.join('.')}: ${err.message}`);
      detailedMessage += ` Input validation failed.`;
    } else if (error instanceof ValidationError || error instanceof SalesforceError) {
      errorMessages = [error.message];
      if (error.details) {
        errorMessages.push(JSON.stringify(error.details));
      }
      detailedMessage += ` ${error.name}: ${error.message}`;
    } else if (error.response && error.response.data) {
      // Handle Salesforce API errors
      const salesforceErrorDetails = Array.isArray(error.response.data) ? error.response.data : [error.response.data];
      errorMessages = salesforceErrorDetails.map((sfError: any) => sfError.message || JSON.stringify(sfError));
      detailedMessage += ` Salesforce API Error: ${errorMessages.join('; ')}`;
    } else {
      detailedMessage += ` Error: ${errorMessages.join('; ')}`;
    }

    return {
      id: actionInstanceId,
      success: false,
      errors: errorMessages.length > 0 ? errorMessages : null,
      data: {}, // Empty object for error cases
      count: 0,
      totalCount: 0,
      hasMore: false,
      nextOffset: null,
      aggregates: null,
      message: detailedMessage,
    };
  }
}

// ====================================================
// Query Building Functions
// ====================================================

/**
 * Builds a count query
 */
function buildCountQuery(
  entityType: EntityType,
  filters?: Filters
): string {
  // Simple count query
  const salesforceObject = salesforceObjectMapping[entityType];
  let query = `SELECT COUNT() FROM ${salesforceObject}`;
  
  // Add WHERE clause if filters provided
  if (filters && filters.conditions && filters.conditions.length > 0) {
    const whereClause = buildWhereClause(filters);
    if (whereClause) {
      query += ` WHERE ${whereClause}`;
    }
  }
  
  console.log('Built Count SOQL Query:', query);
  return query;
}

/**
 * Builds an aggregate query
 */
function buildAggregateQuery(
  entityType: EntityType,
  filters: Filters
): string {
  // Determine the Salesforce object name
  const salesforceObject = salesforceObjectMapping[entityType];
  
  // Build aggregate functions
  let aggregateFunctions: string[] = [];
  
  if (filters.aggregate && filters.aggregate.length > 0) {
    aggregateFunctions = filters.aggregate.map(agg => {
      return `${agg.function.toUpperCase()}(${agg.field}) ${agg.alias}`;
    });
  } else {
    // Default to count if no aggregates specified
    aggregateFunctions = ['COUNT(Id) count'];
  }
  
  let query = `SELECT ${aggregateFunctions.join(', ')}`;
  
  // Add FROM clause
  query += ` FROM ${salesforceObject}`;
  
  // Add WHERE clause
  const whereClause = buildWhereClause(filters);
  if (whereClause) {
    query += ` WHERE ${whereClause}`;
  }
  
  // Add GROUP BY clause if provided
  if (filters.groupBy && filters.groupBy.length > 0) {
    query += ` GROUP BY ${filters.groupBy.join(', ')}`;
  }
  
  // Add ORDER BY for aggregates (usually on one of the aggregate results)
  if (filters.orderBy && filters.orderBy.length > 0) {
    query += ' ORDER BY ' + filters.orderBy
      .map(order => `${order.field} ${order.direction}`)
      .join(', ');
  }
  
  console.log('Built Aggregate SOQL Query:', query);
  return query;
}

/**
 * Builds a query to fetch records by identifier
 */
function buildIdentifierQuery(
  entityType: EntityType,
  identifierType: IdentifierType,
  identifier: string,
  timeFrame?: string,
  limit?: number,
  filters?: Filters // For includeFields
): string {
  // Use buildFieldSelection to honor includeFields from filters if present
  let baseQuery = buildFieldSelection(entityType, filters?.includeFields, filters?.excludeFields);

  // buildFieldSelection should handle default entity fields.
  // baseQuery += getEntityFieldsClause(entityType); 

  // Determine the Salesforce object name
  const salesforceObject = salesforceObjectMapping[entityType];

  baseQuery += ` FROM ${salesforceObject}`;

  // Add WHERE clause based on identifierType
  const sanitizedIdentifier = sanitizeValue(identifier);

  if (identifierType === 'Id') {
    baseQuery += ` WHERE Id = '${sanitizedIdentifier}'`;
  } else {
    baseQuery += ` WHERE ${identifierType} = '${sanitizedIdentifier}'`;
  }

  // Add TimeFrame condition if provided and not 'all_time'
  if (timeFrame && timeFrame !== 'recent' && timeFrame !== 'all_time') {
    const dateCondition = getDateCondition(timeFrame);
    if (dateCondition) {
      baseQuery += ` AND LastModifiedDate ${dateCondition}`;
    }
  }

  baseQuery += ` ORDER BY LastModifiedDate DESC LIMIT ${limit || 50}`;

  console.log('Built Identifier SOQL Query:', baseQuery);
  return baseQuery;
}

/**
 * Builds a SOQL query based on filters
 */
function buildFilteredQuery(
  entityType: EntityType,
  filters: Filters | undefined,
  limit: number,
  isFetchAll: boolean = false
): string {
  if (!filters) {
    filters = {};
  }
  
  // Start with field selection
  let baseQuery = buildFieldSelection(entityType, filters.includeFields, filters.excludeFields); // Uses filters.includeFields
  
  // Add FROM clause
  const salesforceObject = salesforceObjectMapping[entityType];
  baseQuery += ` FROM ${salesforceObject}`;
  
  // Build WHERE clause
  const whereClause = buildWhereClause(filters);
  if (whereClause && !isFetchAll) {
    baseQuery += ` WHERE ${whereClause}`;
  }
  
  // Add GROUP BY clause if provided
  if (filters.groupBy && filters.groupBy.length > 0) {
    baseQuery += ` GROUP BY ${filters.groupBy.join(', ')}`;
  }
  
  // Add ORDER BY
  if (filters.orderBy && filters.orderBy.length > 0) {
    baseQuery += ' ORDER BY ' + filters.orderBy
      .map(order => `${order.field} ${order.direction}`)
      .join(', ');
  } else {
    baseQuery += ' ORDER BY LastModifiedDate DESC';
  }
  
  // Add LIMIT and OFFSET
  // const limit = filters.limit || 50; // limit is now a parameter
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
  
  // Add TimeFrame condition if provided and not 'all_time'
  if (filters.timeFrame && filters.timeFrame !== 'recent' && filters.timeFrame !== 'all_time') {
    const dateCondition = getDateCondition(filters.timeFrame);
    if (dateCondition) {
      whereParts.push(`LastModifiedDate ${dateCondition}`);
    }
  }
  
  // Include deleted records if requested
  if (filters.includeDeleted) {
    // This actually requires a different endpoint in Salesforce API
    // We'd need to use queryAll instead of query
    console.log('Note: includeDeleted requires using queryAll endpoint');
  }
  
  return whereParts.join(' AND ');
}

/**
 * Build field selection part of query
 */
function buildFieldSelection(
  entityType: EntityType, 
  includeFields?: string[], 
  excludeFields?: string[]
): string {
  // Start with mandatory fields
  let fields = new Set(['Id', 'Name', 'LastModifiedDate']);
  
  // Add entity-specific fields
  const entityFields = getEntityFields(entityType);
  entityFields.forEach(field => fields.add(field));
  
  // Add user-specified fields
  if (includeFields && includeFields.length > 0) {
    includeFields.forEach(field => fields.add(field));
  }
  
  // Remove excluded fields
  if (excludeFields && excludeFields.length > 0) {
    excludeFields.forEach(field => fields.delete(field));
  }
  
  // Ensure Id is always included
  fields.add('Id');
  
  return 'SELECT ' + Array.from(fields).join(', ');
}

/**
 * Get entity-specific fields for queries
 */
function getEntityFieldsClause(entityType: EntityType): string {
  let additionalFields = '';
  
  switch (entityType) {
    case 'Account':
      additionalFields = `, Website, Description, NumberOfEmployees, Industry, Phone`;
      break;
    case 'Contact':
      additionalFields = `, Email, FirstName, LastName, AccountId, Phone, Title`;
      break;
    case 'Deal':
      additionalFields = `, Amount, StageName, AccountId, CloseDate, Probability`;
      break;
    case 'Article':
      additionalFields = `, Title, UrlName, Summary, PublishStatus`;
      break;
    case 'Case':
      additionalFields = `, CaseNumber, Subject, Status, Priority, AccountId, ContactId`;
      break;
    case 'Lead':
      additionalFields = `, Email, FirstName, LastName, Company, Status, Phone, Rating`;
      break;
  }
  
  return additionalFields;
}

/**
 * Get default fields for each entity type
 */
function getEntityFields(entityType: EntityType): string[] {
  switch (entityType) {
    case 'Account':
      return ['Website', 'Description', 'NumberOfEmployees', 'Industry', 'Phone'];
    case 'Contact':
      return ['Email', 'FirstName', 'LastName', 'AccountId', 'Phone', 'Title'];
    case 'Deal':
      return ['Amount', 'StageName', 'AccountId', 'CloseDate', 'Probability'];
    case 'Article':
      return ['Title', 'UrlName', 'Summary', 'PublishStatus'];
    case 'Case':
      return ['CaseNumber', 'Subject', 'Status', 'Priority', 'AccountId', 'ContactId'];
    case 'Lead':
      return ['Email', 'FirstName', 'LastName', 'Company', 'Status', 'Phone', 'Rating'];
    default:
      return [];
  }
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
    case 'all_time': // Handle 'all_time'
      return ''; // No date condition for all_time
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
// Record Fetching and Formatting Functions
// ====================================================

/**
 * Fetches records from Salesforce using the provided SOQL query.
 */
async function fetchRecords(
  nango: NangoAction, 
  query: string
): Promise<SalesforceRecord[]> {
  // Use the queryAll endpoint if includeDeleted is true and the query starts with SELECT
  const useQueryAll = query.toLowerCase().includes('isdeleted = true') && 
                      query.trim().toLowerCase().startsWith('select');
                     
  const endpoint = useQueryAll ? 
    '/services/data/v60.0/queryAll' : 
    '/services/data/v60.0/query';

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

    // For count queries, Salesforce returns a totalSize property but no records
    if (query.toLowerCase().includes('count()') && !response.data.records) {
      // Create a count result that works with our interface
      return [{ 'expr0': response.data.totalSize, 'Id': 'count-result' }];
    }

    return response.data.records || [];
  } catch (error: any) {
    console.error('Error fetching records from Salesforce:', error);
    throw new Error(error.message || 'Failed to fetch records from Salesforce');
  }
}

/**
 * Formats records based on the requested format.
 */
function formatRecords(
  entityType: EntityType,
  records: SalesforceRecord[],
  format: 'detailed' | 'simple' | 'raw'
): any[] {
  if (format === 'raw') {
    return records;
  }
  
  if (format === 'simple') {
    return records.map(record => {
      return {
        id: record['Id'],
        name: record['Name'] || record['Title'] || record['CaseNumber'] || 
              (record['FirstName'] && record['LastName'] ? 
               `${record['FirstName']} ${record['LastName']}`.trim() : 
               record['LastName'] || 'Unnamed'),
        type: entityType
      };
    });
  }
  
  // Detailed format (default)
  const mapping = responseFieldMappings[entityType] || {};
  
  return records.map(record => {
    const formattedRecord: Record<string, any> = {};
    
    // Map fields according to the mapping
    Object.entries(record).forEach(([key, value]) => {
      // Skip the attributes field Salesforce adds
      if (key === 'attributes') return;
      
      const mappedKey = mapping[key];
      if (mappedKey) {
        formattedRecord[mappedKey] = value;
      } else if (!key.endsWith('__r') && !key.endsWith('__c')) {
        // For standard fields not in mapping, convert to snake_case
        const snakeCaseKey = key.replace(/([A-Z])/g, '_$1').toLowerCase();
        formattedRecord[snakeCaseKey] = value;
      } else {
        // For custom fields, keep as is
        formattedRecord[key] = value;
      }
    });
    
    // Ensure last_modified_date is properly formatted
    if (record['LastModifiedDate']) {
      formattedRecord['last_modified_date'] = new Date(record['LastModifiedDate']).toISOString();
    }
    
    return formattedRecord;
  });
}

/**
 * Formats aggregate query results.
 */
function formatAggregateResults(
  records: SalesforceRecord[]
): Record<string, any> {
  if (!records || records.length === 0) {
    return {};
  }
  
  // Safe check for records[0]
  const firstRecord = records[0];
  if (!firstRecord) return {};
  
  if (records.length === 1 && !firstRecord['Id']) {
    // Single aggregate result
    // Filter out the attributes property that Salesforce adds
    const result: Record<string, any> = {};
    
    // Safely copy over properties
    Object.entries(firstRecord).forEach(([key, value]) => {
      if (key !== 'attributes') {
        result[key] = value;
      }
    });
    
    return result;
  }
  
  // Group by aggregate results
  const formattedRecords = records.map(record => {
    const result: Record<string, any> = {};
    
    // Safely copy over properties
    Object.entries(record).forEach(([key, value]) => {
      if (key !== 'attributes') {
        result[key] = value;
      }
    });
    
    return result;
  });
  
  const result: Record<string, any> = {
    records: formattedRecords
  };
  
  // Extract the first aggregate field and add as a total if records[0] exists
  if (firstRecord) {
    // Find the first numeric field that's not Id or attributes
    const firstAggField = Object.entries(firstRecord)
      .find(([key, value]) => 
        key !== 'Id' && 
        key !== 'attributes' && 
        typeof value === 'number'
      )?.[0];
    
    if (firstAggField) {
      result['total'] = records.reduce((sum, record) => {
        const value = record[firstAggField];
        return sum + (typeof value === 'number' ? value : 0);
      }, 0);
    }
  }
  
  return result;
}