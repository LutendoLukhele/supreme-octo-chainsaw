// scripts/run-migration.ts
// Run Cortex database migrations

import { neon } from '@neondatabase/serverless';
import * as fs from 'fs';
import * as path from 'path';

const DATABASE_URL = process.env.DATABASE_URL
  ?.trim()
  .replace(/^(['"])(.*)\1$/, '$2');

if (!DATABASE_URL) {
  throw new Error('Missing required environment variable DATABASE_URL');
}

async function runMigration(migrationNumber: string = '001') {
  const sql = neon(DATABASE_URL);

  const migrationPath = path.join(__dirname, `../migrations/${String(migrationNumber).padStart(3, '0')}_cortex.sql`);
  
  // Handle 002_fix_provider_keys.sql
  const altMigrationPath = path.join(__dirname, `../migrations/${migrationNumber}_fix_provider_keys.sql`);
  const finalPath = fs.existsSync(migrationPath) ? migrationPath : altMigrationPath;
  
  if (!fs.existsSync(finalPath)) {
    console.error(`❌ Migration file not found:`, finalPath);
    process.exit(1);
  }

  const migrationSQL = fs.readFileSync(finalPath, 'utf-8');

  console.log(`Running migration ${migrationNumber}...`);
  console.log('Migration file:', finalPath);

  try {
    // For migration 002, handle DO blocks properly
    if (migrationNumber === '002') {
      console.log('\n📋 Migration steps:');
      
      // Step 1: Update provider keys
      console.log('  1️⃣  Updating provider keys from google-mail/gmail to google-mail-ynxw...');
      const updateResult = await sql.unsafe(`
        UPDATE connections
        SET provider = 'google-mail-ynxw'
        WHERE provider IN ('google-mail', 'gmail')
      `) as any;
      console.log(`     ✓ Updated connections`);
      
      // Step 2: Create index
      console.log('  2️⃣  Creating index for faster lookups...');
      await sql.unsafe(`
        CREATE INDEX IF NOT EXISTS idx_connections_user_provider
        ON connections(user_id, provider)
      `);
      console.log('     ✓ Index created');
      
      // Step 3: Verify
      console.log('  3️⃣  Verifying migration...');
      const connResult = await sql`
        SELECT 
          COUNT(*) as total,
          COUNT(CASE WHEN provider = 'google-mail-ynxw' THEN 1 END) as google_mail_count,
          STRING_AGG(DISTINCT provider, ', ' ORDER BY provider) as providers
        FROM connections
      `;
      
      const total = connResult[0]?.total || 0;
      const googleMailCount = connResult[0]?.google_mail_count || 0;
      const providers = connResult[0]?.providers || 'None';
      
      console.log(`     ✓ Total connections: ${total}`);
      console.log(`     ✓ With google-mail-ynxw: ${googleMailCount}`);
      console.log(`     ✓ Providers in use: ${providers}`);
      
      // Check for orphaned
      const orphaned = await sql`
        SELECT COUNT(*) as count
        FROM connections
        WHERE provider NOT IN (
          'google-mail-ynxw',
          'google-calendar',
          'salesforce-2',
          'outlook',
          'notion'
        )
      `;

      if (orphaned[0]?.count > 0) {
        console.log(`\n⚠️  WARNING: Found ${orphaned[0]?.count} connections with unrecognized provider keys`);
        const badConns = await sql`
          SELECT user_id, provider, connection_id
          FROM connections
          WHERE provider NOT IN (
            'google-mail-ynxw',
            'google-calendar',
            'salesforce-2',
            'outlook',
            'notion'
          )
        `;
        console.log('  Orphaned connections:');
        badConns.forEach(conn => {
          console.log(`    - user: ${conn.user_id}, provider: ${conn.provider}, connection: ${conn.connection_id}`);
        });
      } else {
        console.log(`\n✓ All connections have valid provider keys`);
      }
    } else {
      // Original migration handling
      const statements = migrationSQL
        .split(';')
        .map(s => s.trim())
        .filter(s => s.length > 0 && !s.startsWith('--'));

      for (const statement of statements) {
        if (statement.trim()) {
          await sql.unsafe(statement);
          console.log('✓ Executed:', statement.split('\n')[0].substring(0, 60) + '...');
        }
      }

      // Verify tables were created
      const tables = await sql`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
        AND table_name IN ('connections', 'units', 'runs', 'run_steps')
        ORDER BY table_name
      `;

      console.log('\nCortex tables:');
      tables.forEach(t => console.log('  -', t.table_name));
    }

    console.log('\n✅ Migration completed successfully!');

  } catch (error: any) {
    console.error('❌ Migration failed:', error.message);
    throw error;
  }
}

runMigration(process.argv[2] || '001').catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
