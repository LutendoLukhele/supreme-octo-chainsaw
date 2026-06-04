// scripts/fix-gmail-connection.ts
// Fix the Gmail connection ID for the specific user

import { neon } from '@neondatabase/serverless';

function requiredEnv(name: string): string {
  const value = process.env[name]
    ?.trim()
    .replace(/^(['"])(.*)\1$/, '$2');
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

const sql = neon(requiredEnv('DATABASE_URL'));
const USER_ID = requiredEnv('ASO_TARGET_USER_ID');
const CORRECT_CONNECTION_ID = requiredEnv('ASO_TARGET_CONNECTION_ID');
const PROVIDER = process.env.ASO_TARGET_PROVIDER?.trim() || 'google-mail-ynxw';

async function fixGmailConnection() {
  console.log('🔧 Fixing Gmail connection...\n');

  // Check current state
  const before = await sql`
    SELECT connection_id, provider, user_id 
    FROM connections 
    WHERE user_id = ${USER_ID} AND provider = ${PROVIDER}
  `;

  console.log('Current state:');
  console.log(before);

  if (before.length === 0) {
    console.log('❌ No connection found for this user/provider');
    return;
  }

  // Update the connection ID
  const result = await sql`
    UPDATE connections 
    SET connection_id = ${CORRECT_CONNECTION_ID}
    WHERE user_id = ${USER_ID} AND provider = ${PROVIDER}
    RETURNING *
  `;

  console.log('\n✅ Updated connection:');
  console.log(result);

  // Verify
  const after = await sql`
    SELECT connection_id, provider, user_id 
    FROM connections 
    WHERE user_id = ${USER_ID} AND provider = ${PROVIDER}
  `;

  console.log('\nNew state:');
  console.log(after);

  if (after[0]?.connection_id === CORRECT_CONNECTION_ID) {
    console.log('\n✅ Connection ID successfully updated!');
  } else {
    console.log('\n❌ Update verification failed');
  }
}

fixGmailConnection()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
