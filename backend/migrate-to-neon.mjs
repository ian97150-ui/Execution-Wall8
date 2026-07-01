/**
 * migrate-to-neon.mjs
 * Copies all data from Railway Postgres → Neon.
 * Usage: node migrate-to-neon.mjs "postgresql://postgres:PASS@host:PORT/railway"
 */

import pg from 'pg';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const { Client } = pg;

// Load Neon URL from backend/.env
const __dir = dirname(fileURLToPath(import.meta.url));
const envFile = readFileSync(join(__dir, '.env'), 'utf8');
const neonUrl = envFile.match(/DATABASE_URL="?([^"\n]+)"?/)?.[1];
if (!neonUrl) { console.error('Could not read DATABASE_URL from .env'); process.exit(1); }

const railwayUrl = process.argv[2];
if (!railwayUrl) {
  console.error('Usage: node migrate-to-neon.mjs "postgresql://postgres:PASS@host:PORT/railway"');
  process.exit(1);
}

// Tables in safe migration order (no FK deps in this schema)
const TABLES = [
  'users',
  'execution_settings',
  'execution_schedules',
  'trade_intents',
  'ticker_configs',
  'executions',
  'audit_logs',
  'positions',
  'webhook_logs',
  'wall_events',
  'sim_tickers',
  'live_considered',
  'live_trades',
];

async function migrate() {
  console.log('Connecting to Railway Postgres...');
  const src = new Client({ connectionString: railwayUrl, ssl: false });
  await src.connect();

  console.log('Connecting to Neon...');
  const dst = new Client({ connectionString: neonUrl, ssl: { rejectUnauthorized: false } });
  await dst.connect();

  for (const table of TABLES) {
    // Check table exists on source
    const existsRes = await src.query(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name=$1)`, [table]
    );
    if (!existsRes.rows[0].exists) {
      console.log(`  ⏭  ${table} — not found on source, skipping`);
      continue;
    }

    const countRes = await src.query(`SELECT COUNT(*) FROM "${table}"`);
    const total = parseInt(countRes.rows[0].count, 10);
    if (total === 0) {
      console.log(`  ○  ${table} — empty, skipping`);
      continue;
    }

    console.log(`  → ${table} (${total} rows)...`);

    // Fetch all rows
    const rows = (await src.query(`SELECT * FROM "${table}"`)).rows;
    if (rows.length === 0) continue;

    const cols = Object.keys(rows[0]);
    let inserted = 0;
    let skipped = 0;

    for (const row of rows) {
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
      const values = cols.map(c => row[c]);
      const colList = cols.map(c => `"${c}"`).join(', ');

      try {
        await dst.query(
          `INSERT INTO "${table}" (${colList}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
          values
        );
        inserted++;
      } catch (err) {
        // Log first failure per table but keep going
        if (skipped === 0) console.warn(`    ⚠ first error on ${table}: ${err.message}`);
        skipped++;
      }
    }

    console.log(`  ✓  ${table} — ${inserted} inserted, ${skipped} skipped`);
  }

  await src.end();
  await dst.end();
  console.log('\n✅ Migration complete.');
}

migrate().catch(err => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
