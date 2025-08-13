"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = createEntity;
const zod_1 = require("zod");
// Mapping of EntityType to Salesforce Object Names
const salesforceObjectMapping = {
    Account: "Account",
    Contact: "Contact",
    Deal: "Opportunity",
    Article: "Knowledge__kav", // Assuming Knowledge articles
    Case: "Case",
    Lead: "Lead"
};
// Define required fields for each EntityType during creation
const requiredCreateFields = {
    Account: {
        name: zod_1.z.string().min(1, "Name is required"),
    },
    Contact: {
        last_name: zod_1.z.string().min(1, "Last name is required"),
        email: zod_1.z.string().email("Invalid email format"),
    },
    Deal: {
        name: zod_1.z.string().min(1, "Name is required"),
        stage: zod_1.z.string().min(1, "Stage is required"),
        close_date: zod_1.z.string().min(1, "Close date is required"), // Consider using date validation
    },
    Article: {
        title: zod_1.z.string().min(1, "Title is required"),
        url_name: zod_1.z.string().min(1, "URL name is required"),
        content: zod_1.z.string().min(1, "Content is required"),
    },
    Case: {
        subject: zod_1.z.string().min(1, "Subject is required"),
        status: zod_1.z.string().min(1, "Status is required"),
    },
    Lead: {
        last_name: zod_1.z.string().min(1, "Last name is required"),
        email: zod_1.z.string().email("Invalid email format"),
        company: zod_1.z.string().min(1, "Company is required"),
    },
};
// Zod Schema for CreateEntityInput
const createEntityInputSchema = zod_1.z.object({
    operation: zod_1.z.literal('create'),
    entityType: zod_1.z.enum(['Account', 'Contact', 'Deal', 'Article', 'Case', 'Lead']),
    fields: zod_1.z.record(zod_1.z.string(), zod_1.z.any()).refine((data) => Object.keys(data).length >= 1, "At least one field must be provided for creation")
});
// ====================================================
// Main createEntity Function
// ====================================================
async function createEntity(nango, input) {
    console.log('Received input:', JSON.stringify(input, null, 2));
    try {
        // Validate Input using Zod
        createEntityInputSchema.parse(input);
        const { operation, entityType, fields } = input;
        console.log("Operation:", operation); // Now used for logging
        // Define the Salesforce object name
        const salesforceObject = salesforceObjectMapping[entityType];
        // Validate required fields based on entityType
        const requiredFields = requiredCreateFields[entityType];
        // Combine required fields with any additional fields
        const entitySchema = zod_1.z.object({
            ...requiredFields,
            ...getAdditionalFieldsSchema(entityType),
        });
        // Parse and validate the fields
        const validatedFields = entitySchema.parse(fields);
        // Map and prepare fields for Salesforce API
        const salesforceFields = mapFieldsToSalesforce(entityType, validatedFields);
        // Create the entity in Salesforce
        const createResponse = await nango.post({
            endpoint: `/services/data/v60.0/sobjects/${salesforceObject}`,
            data: salesforceFields,
        });
        if (!createResponse.data.id) {
            throw new SalesforceError('Salesforce did not return an ID for the created entity', createResponse.data);
        }
        console.log(`Created ${entityType} with ID: ${createResponse.data.id}`);
        // Fetch the created entity data for confirmation
        const createdEntityData = await fetchEntityData(nango, salesforceObject, createResponse.data.id);
        const result = {
            id: createResponse.data.id,
            success: true,
            errors: null,
            input: fields,
            created: createdEntityData,
            message: `Successfully created ${entityType} with ID: ${createResponse.data.id}`,
        };
        console.log('Create result:', JSON.stringify(result, null, 2));
        return result;
    }
    catch (error) {
        console.error('Error details:', error);
        let resultErrors = [];
        if (error instanceof zod_1.z.ZodError) {
            resultErrors = error.errors.map(err => err.message);
        }
        else if (error instanceof SalesforceError) {
            resultErrors = [error.message];
            if (error.details) {
                resultErrors.push(JSON.stringify(error.details));
            }
        }
        else if (error.response && error.response.data) {
            // Handle Salesforce API errors
            const salesforceErrors = error.response.data.errors || [error.response.data.message || 'Unknown Salesforce error'];
            resultErrors = salesforceErrors.map((err) => err.message || err);
        }
        else {
            resultErrors = [error.message || 'An unexpected error occurred'];
        }
        return {
            id: '',
            success: false,
            errors: resultErrors,
            input: input.fields,
            created: {},
            message: `Failed to create ${input.entityType}. Error: ${resultErrors.join('; ')}`,
        };
    }
}
// ====================================================
// Helper Functions
// ====================================================
/**
 * Retrieves additional fields schemas based on entityType.
 * This function can be expanded to include more specific validations.
 * @param _entityType - The type of Salesforce entity.
 * @returns A Zod schema object for additional fields.
 */
function getAdditionalFieldsSchema(_entityType) {
    // Define additional schemas as needed
    // For simplicity, allow any additional fields without strict validation
    return {}; // Modify this to include specific field validations if necessary
}
/**
 * Fetches the full record data from Salesforce.
 * @param nango - The NangoAction instance.
 * @param salesforceObject - The Salesforce object name.
 * @param id - The Salesforce record ID.
 * @returns A promise that resolves to the record data.
 */
async function fetchEntityData(nango, salesforceObject, id) {
    try {
        const endpoint = `/services/data/v60.0/sobjects/${salesforceObject}/${id}`;
        const response = await nango.get({ endpoint });
        // Check for Salesforce errors
        if (response.data.errors) {
            const errorMessages = response.data.errors.map((err) => err.message || 'Unknown error');
            throw new Error(errorMessages.join('; '));
        }
        return response.data;
    }
    catch (error) {
        console.error(`Failed to fetch ${salesforceObject} data with ID ${id}:`, error);
        return {};
    }
}
/**
 * Maps internal field names to Salesforce API field names based on entityType.
 * @param entityType - The type of Salesforce entity.
 * @param fields - The fields to be created.
 * @returns A record object with Salesforce API field names and corresponding values.
 */
function mapFieldsToSalesforce(entityType, fields) {
    let salesforceFields = {};
    switch (entityType) {
        case 'Deal':
            const dealFieldMapping = {
                name: "Name",
                amount: "Amount",
                stage: "StageName",
                close_date: "CloseDate",
                account_id: "AccountId",
            };
            salesforceFields = mapSpecificFields(fields, dealFieldMapping);
            break;
        // Add specific field mappings for other entityTypes if necessary
        case 'Account':
        case 'Contact':
        case 'Lead':
        case 'Article':
        case 'Case':
        default:
            salesforceFields = fields; // Assuming field names match Salesforce API field names
            break;
    }
    console.log(`Mapped Fields for ${entityType}:`, JSON.stringify(salesforceFields, null, 2));
    return salesforceFields;
}
/**
 * Helper function to map specific field names.
 * @param fields - The fields to be mapped.
 * @param fieldMapping - The mapping from internal to Salesforce field names.
 * @returns A new object with mapped field names.
 */
function mapSpecificFields(fields, fieldMapping) {
    return Object.entries(fields).reduce((acc, [key, value]) => {
        const salesforceField = fieldMapping[key] || key;
        acc[salesforceField] = value;
        return acc;
    }, {});
}
// ====================================================
// Custom Error Classes
// ====================================================
class SalesforceError extends Error {
    details;
    constructor(message, details) {
        super(message);
        this.name = 'SalesforceError';
        this.details = details;
    }
}
