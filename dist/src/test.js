"use strict";
// salesforce-update-tests.ts
// This script tests the enhanced update capabilities 
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_1 = require("@nangohq/node");
const winston_1 = __importDefault(require("winston"));
// Create a logger for testing
const logger = winston_1.default.createLogger({
    level: 'info',
    format: winston_1.default.format.combine(winston_1.default.format.colorize(), winston_1.default.format.simple()),
    transports: [new winston_1.default.transports.Console()]
});
// Define the connection ID - replace with your valid connection ID
const CONNECTION_ID = '42c5be6f-ffb9-4e99-9d77-daef88fe598f';
// Create Nango instance 
const nango = new node_1.Nango({ secretKey: '7addd614-fda8-48a2-9c79-5443fda50a84' });
// Implementation similar to your NangoService.triggerSalesforceAction
async function triggerSalesforceAction(operation, entityType, actionOptions) {
    let actionName;
    let payload = { operation, entityType, ...actionOptions };
    switch (operation) {
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
            throw new Error(`Unsupported operation: ${operation}`);
    }
    logger.info('Triggering Salesforce action via Nango', {
        actionName,
        payload: JSON.stringify(payload, null, 2)
    });
    try {
        const response = await nango.triggerAction("salesforce-2", // Provider Key as configured in Nango
        CONNECTION_ID, actionName, payload);
        logger.info('Salesforce action triggered successfully');
        return response;
    }
    catch (error) {
        logger.error('Failed to trigger Salesforce action via Nango', {
            error: error.message || error,
            actionName
        });
        throw error;
    }
}
// Helper to fetch an account ID for testing
async function fetchAccountIdForTesting() {
    try {
        // Fetch a test account
        const accounts = await triggerSalesforceAction('fetch', 'Account', {
            filters: {
                conditions: [
                    {
                        field: "Name",
                        operator: "contains",
                        value: "Test"
                    }
                ],
                limit: 1
            }
        });
        if (accounts && accounts.data && accounts.data.length > 0) {
            logger.info(`Found test account: ${accounts.data[0].name} with ID: ${accounts.data[0].id}`);
            return accounts.data[0].id;
        }
        else {
            logger.warn('No test accounts found');
            return null;
        }
    }
    catch (error) {
        logger.error('Error fetching test account:', error);
        return null;
    }
}
// Main test function for enhanced update operations
async function testEnhancedUpdates() {
    logger.info('Testing enhanced Salesforce update capabilities');
    try {
        // Get a test account ID to use for updates
        const testAccountId = await fetchAccountIdForTesting();
        if (!testAccountId) {
            logger.error('Cannot proceed with update tests - no test account found');
            return;
        }
        // Test 1: Simple ID-based update
        logger.info('\n--- Test 1: Basic Single Record Update ---');
        const updateResult = await triggerSalesforceAction('update', 'Account', {
            identifier: testAccountId,
            identifierType: 'Id',
            fields: {
                Description: `Updated via API test at ${new Date().toISOString()}`
            }
        });
        if (updateResult.success) {
            logger.info(`Successfully updated account ${testAccountId}`);
            logger.info(`Before update: ${JSON.stringify(updateResult.before?.Description || 'N/A')}`);
            logger.info(`After update: ${JSON.stringify(updateResult.after?.Description || 'N/A')}`);
        }
        else {
            logger.error('Update failed:', updateResult.errors);
        }
        // Test 2: Filter-based update
        logger.info('\n--- Test 2: Filter-Based Batch Update ---');
        const batchUpdateResult = await triggerSalesforceAction('update', 'Account', {
            filters: {
                conditions: [
                    {
                        field: "Industry",
                        operator: "equals",
                        value: "Technology"
                    },
                    {
                        field: "NumberOfEmployees",
                        operator: "lessThan",
                        value: 100
                    }
                ],
                limit: 3
            },
            fields: {
                Description: `Batch updated via filter at ${new Date().toISOString()}`
            },
            batchOptions: {
                allOrNothing: false,
                batchSize: 3
            }
        });
        if (batchUpdateResult.success) {
            logger.info(`Successfully batch-updated ${batchUpdateResult.records?.successful || 0} accounts`);
            logger.info(`Failed updates: ${batchUpdateResult.records?.failed || 0}`);
        }
        else {
            logger.error('Batch update failed:', batchUpdateResult.errors);
        }
        // Test 3: Complex filter with custom logic
        logger.info('\n--- Test 3: Complex Filter Logic Update ---');
        const complexUpdateResult = await triggerSalesforceAction('update', 'Account', {
            filters: {
                conditions: [
                    {
                        field: "Industry",
                        operator: "equals",
                        value: "Technology"
                    },
                    {
                        field: "Industry",
                        operator: "equals",
                        value: "Healthcare"
                    },
                    {
                        field: "NumberOfEmployees",
                        operator: "greaterThan",
                        value: 0
                    }
                ],
                logic: "(1 OR 2) AND 3",
                limit: 2
            },
            fields: {
                Rating: "Hot",
                Description: `Updated with complex filter at ${new Date().toISOString()}`
            }
        });
        if (complexUpdateResult.success) {
            logger.info(`Successfully updated ${complexUpdateResult.records?.successful || 0} accounts with complex filter`);
        }
        else {
            logger.error('Complex update failed:', complexUpdateResult.errors);
        }
        // Test 4: Update with allOrNothing set to true
        logger.info('\n--- Test 4: Batch Update with allOrNothing=true ---');
        const allOrNothingResult = await triggerSalesforceAction('update', 'Account', {
            filters: {
                conditions: [
                    {
                        field: "Industry",
                        operator: "equals",
                        value: "Technology"
                    }
                ],
                limit: 2
            },
            fields: {
                Description: `Updated with allOrNothing at ${new Date().toISOString()}`
            },
            batchOptions: {
                allOrNothing: true,
                batchSize: 2
            }
        });
        if (allOrNothingResult.success) {
            logger.info(`Successfully updated ${allOrNothingResult.records?.successful || 0} accounts with allOrNothing`);
        }
        else {
            logger.error('AllOrNothing update failed:', allOrNothingResult.errors);
        }
        logger.info('\nAll update tests completed!');
    }
    catch (error) {
        logger.error('Error testing enhanced updates:', error);
    }
}
// Run the test
testEnhancedUpdates().catch(error => {
    logger.error('Unhandled error in test script:', error);
});
