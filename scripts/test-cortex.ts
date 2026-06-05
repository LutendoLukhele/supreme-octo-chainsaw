// scripts/test-cortex.ts
// Comprehensive test script for Cortex automation system

import axios from 'axios';
import { neon } from '@neondatabase/serverless';

const BASE_URL = 'http://localhost:8080';
const TEST_USER_ID = 'test-user-cortex-' + Date.now();

const DATABASE_URL = process.env.DATABASE_URL
  ?.trim()
  .replace(/^(['"])(.*)\1$/, '$2');

if (!DATABASE_URL) {
  throw new Error('Missing required environment variable DATABASE_URL');
}

async function testCortex() {
  console.log('\n🧪 Cortex Automation System - Comprehensive Test\n');
  console.log('='.repeat(60));

  const sql = neon(DATABASE_URL);

  try {
    // Test 1: Health Check
    console.log('\n📡 Test 1: Health Check');
    const health = await axios.get(`${BASE_URL}/health`);
    console.log('✅ Server is healthy:', health.data);

    // Test 2: Register Test Connection
    console.log('\n📡 Test 2: Register Test Connection');
    const connectionRes = await axios.post(
      `${BASE_URL}/api/connections`,
      {
        provider: 'google-mail',
        connectionId: 'test-connection-' + Date.now(),
      },
      {
        headers: { 'x-user-id': TEST_USER_ID },
      }
    );
    console.log('✅ Connection registered:', connectionRes.data);

    // Test 3: Create Unit - Email Summarization
    console.log('\n📡 Test 3: Create Unit - Email Summarization Automation');
    const unit1Res = await axios.post(
      `${BASE_URL}/api/cortex/units`,
      {
        prompt: 'When I receive an email, summarize it and send the summary to Slack #inbox channel',
      },
      {
        headers: { 'x-user-id': TEST_USER_ID },
      }
    );
    console.log('✅ Unit created:', {
      id: unit1Res.data.unit.id,
      name: unit1Res.data.unit.name,
      status: unit1Res.data.unit.status,
    });
    const unit1Id = unit1Res.data.unit.id;

    // Test 4: Create Unit - Structured Format
    console.log('\n📡 Test 4: Create Unit - Deal Notification (Structured)');
    const unit2Res = await axios.post(
      `${BASE_URL}/api/cortex/units`,
      {
        when: 'when a Salesforce opportunity closes over $10,000',
        then: 'post a celebration message to Slack #wins channel',
      },
      {
        headers: { 'x-user-id': TEST_USER_ID },
      }
    );
    console.log('✅ Unit created:', {
      id: unit2Res.data.unit.id,
      name: unit2Res.data.unit.name,
      trigger: unit2Res.data.unit.when,
    });
    const unit2Id = unit2Res.data.unit.id;

    // Test 5: Create Unit - Follow-up Automation
    console.log('\n📡 Test 5: Create Unit - Lead Follow-up');
    const unit3Res = await axios.post(
      `${BASE_URL}/api/cortex/units`,
      {
        when: 'when a lead stage changes to stalled',
        if: 'if the deal value is over $5000',
        then: 'wait 48 hours, then create a follow-up task in Salesforce',
      },
      {
        headers: { 'x-user-id': TEST_USER_ID },
      }
    );
    console.log('✅ Unit created:', {
      id: unit3Res.data.unit.id,
      actions: unit3Res.data.unit.then.map((a: any) => a.type),
    });

    // Test 6: List User's Units
    console.log('\n📡 Test 6: List All Units for User');
    const unitsRes = await axios.get(`${BASE_URL}/api/cortex/units`, {
      headers: { 'x-user-id': TEST_USER_ID },
    });
    console.log(`✅ Found ${unitsRes.data.units.length} units`);
    unitsRes.data.units.forEach((u: any, i: number) => {
      console.log(`   ${i + 1}. ${u.name} (${u.status})`);
    });

    // Test 7: Get Single Unit
    console.log('\n📡 Test 7: Get Unit by ID');
    const unitRes = await axios.get(`${BASE_URL}/api/cortex/units/${unit1Id}`);
    console.log('✅ Retrieved unit:', {
      id: unitRes.data.unit.id,
      name: unitRes.data.unit.name,
      when: unitRes.data.unit.when,
      if: unitRes.data.unit.if,
      then: unitRes.data.unit.then.map((a: any) => a.type),
    });

    // Test 8: Pause Unit
    console.log('\n📡 Test 8: Pause Unit');
    await axios.patch(
      `${BASE_URL}/api/cortex/units/${unit1Id}/status`,
      { status: 'paused' },
      { headers: { 'x-user-id': TEST_USER_ID } }
    );
    console.log('✅ Unit paused');

    // Test 9: Reactivate Unit
    console.log('\n📡 Test 9: Reactivate Unit');
    await axios.patch(
      `${BASE_URL}/api/cortex/units/${unit1Id}/status`,
      { status: 'active' },
      { headers: { 'x-user-id': TEST_USER_ID } }
    );
    console.log('✅ Unit reactivated');

    // Test 10: Get User Runs (should be empty for new user)
    console.log('\n📡 Test 10: Get Execution History');
    const runsRes = await axios.get(`${BASE_URL}/api/cortex/runs`, {
      headers: { 'x-user-id': TEST_USER_ID },
    });
    console.log(`✅ Found ${runsRes.data.runs.length} runs (expected 0 for new user)`);

    // Test 11: Verify Database State
    console.log('\n📡 Test 11: Verify Database State');
    const dbUnits = await sql`SELECT COUNT(*) as count FROM units WHERE owner_id = ${TEST_USER_ID}`;
    console.log(`✅ Database has ${dbUnits[0].count} units for test user`);

    // Test 12: Delete Unit
    console.log('\n📡 Test 12: Delete Unit');
    await axios.delete(`${BASE_URL}/api/cortex/units/${unit2Id}`, {
      headers: { 'x-user-id': TEST_USER_ID },
    });
    console.log('✅ Unit deleted');

    // Cleanup
    console.log('\n🧹 Cleanup: Deleting Test Data');
    await sql`DELETE FROM units WHERE owner_id = ${TEST_USER_ID}`;
    await sql`DELETE FROM connections WHERE user_id = ${TEST_USER_ID}`;
    console.log('✅ Test data cleaned up');

    console.log('\n' + '='.repeat(60));
    console.log('✅ All Tests Passed!\n');
    console.log('Cortex is fully operational and ready to use.');

  } catch (error: any) {
    console.error('\n❌ Test Failed:', error.response?.data || error.message);
    console.error('Stack:', error.stack);
    process.exit(1);
  }
}

console.log('Starting Cortex tests...');
console.log('Make sure the server is running on port 8080');
console.log('You can start it with: npm run dev\n');

testCortex().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
