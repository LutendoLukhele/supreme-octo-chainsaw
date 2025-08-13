// runNangoServiceE2E.ts

import { NangoService } from '../src/services/NangoService'; // Adjust path to your NangoService.ts
import { CONFIG as AppConfig } from '../src/config'; // Adjust path to your config.ts

// ========================================================================
// --- E2E TEST CONFIGURATION ---
// IMPORTANT: REPLACE a_real_connection_id WITH YOUR ACTUAL NANGO CONNECTION ID
// AND sk_live_... WITH YOUR NANGO SECRET KEY.
// ========================================================================

const TEST_CONFIG = {
  CONNECTION_ID: 'fc42f4aa-560b-46aa-a60a-1c6a37e02f5c', // <--- REPLACE
  NANGO_SECRET_KEY: '7addd614-fda8-48a2-9c79-5443fda50a84' // <--- REPLACE
};

// Override the application's config with our test-specific values
AppConfig.CONNECTION_ID = TEST_CONFIG.CONNECTION_ID;
AppConfig.NANGO_SECRET_KEY = TEST_CONFIG.NANGO_SECRET_KEY;

// ========================================================================
// Test Runner
// ========================================================================

// A simple state object to pass IDs between test steps
const testState = {
  createdAccountId: '',
};

/**
 * A basic assertion helper to stop the script on failure.
 * @param condition The condition to check.
 * @param message The error message to display on failure.
 */
function assert(condition: any, message: string): void {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${message}`);
    process.exit(1);
  }
  console.log(`✅ Assertion Passed: ${message}`);
}

/**
 * Main test execution flow.
 */
async function main() {
  console.log('--- Starting E2E Test for NangoService ---');

  if (AppConfig.CONNECTION_ID === 'a_real_connection_id' || AppConfig.NANGO_SECRET_KEY === 'sk_live_or_test_your_real_key') {
      console.error('❌ CONFIGURATION ERROR: Please replace placeholder values in TEST_CONFIG before running.');
      return;
  }

  const nangoService = new NangoService();

  try {
    // --- STEP 1: CREATE ---
    console.log('\n--- 1. Testing CREATE Account ---');
    const uniqueAccountName = `E2E Test Account ${Date.now()}`;
    const createResponse = await nangoService.triggerSalesforceAction(
      'salesforce-2',
      AppConfig.CONNECTION_ID,
      'create',
      'Account',
      { name: uniqueAccountName, industry: 'Technology' }
    );
    console.log('CREATE Response:', JSON.stringify(createResponse, null, 2));
    assert(createResponse.success, 'Create operation should be successful.');
    assert(createResponse.id && createResponse.id.startsWith('001'), 'Response should contain a valid Salesforce Account ID.');
    testState.createdAccountId = createResponse.id;


    // --- STEP 2: FETCH (Read to Verify) ---
    console.log('\n--- 2. Testing FETCH Created Account ---');
    const fetchResponse = await nangoService.triggerSalesforceAction(
        'salesforce-2',
        AppConfig.CONNECTION_ID,
        'fetch',
        'Account',
        testState.createdAccountId // Use the ID from the create step
    );
    console.log('FETCH Response:', JSON.stringify(fetchResponse, null, 2));
    assert(fetchResponse.success, 'Fetch operation should be successful.');
    
    // **FIXED ASSERTION BLOCK**
    const fetchedRecord = fetchResponse.data?.records?.[0];
    assert(fetchedRecord, "Fetched data should contain at least one record.");
    assert(fetchedRecord.name === uniqueAccountName, `Fetched Account name should be "${uniqueAccountName}".`);


    // --- STEP 3: UPDATE ---
    console.log('\n--- 3. Testing UPDATE Account ---');
    const updatedAccountName = `E2E Updated Account ${Date.now()}`;
    const updateResponse = await nangoService.triggerSalesforceAction(
      'salesforce-2',
      AppConfig.CONNECTION_ID,
      'update',
      'Account',
      testState.createdAccountId, // identifier
      { name: updatedAccountName, phone: '555-999-8888' } // fields to update
    );
    console.log('UPDATE Response:', JSON.stringify(updateResponse, null, 2));
    assert(updateResponse.success, 'Update operation should be successful.');
    // You can add another fetch here to verify the updated name and phone number if you wish.
    console.log(`✅ Account successfully updated to name: "${updatedAccountName}"`);


    // --- STEP 4: DELETE (Cleanup) ---
    console.log('\n--- 4. Testing DELETE Account (Cleanup) ---');
    // IMPORTANT: This step requires you to have a 'delete' case in your NangoService
    // and a 'salesforce-delete-entity' action on Nango. See instructions below.
    const deleteResponse = await nangoService.triggerSalesforceAction(
        'salesforce-2',
        AppConfig.CONNECTION_ID,
        'delete', // This operation needs to be added to your service
        'Account',
        testState.createdAccountId // identifier
    );
    console.log('DELETE Response:', JSON.stringify(deleteResponse, null, 2));
    assert(deleteResponse.success, 'Delete operation should be successful.');

  } catch (error: any) {
    console.error('\n--- ❌ E2E TEST FAILED ---');
    if (error.response) {
      console.error('Error Response:', JSON.stringify(error.response, null, 2));
    } else {
      console.error('Error:', error);
    }
    process.exit(1);
  }

  console.log('\n--- ✅ E2E Test for NangoService Completed Successfully ---');
}

main();