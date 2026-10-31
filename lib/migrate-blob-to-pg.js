/**
 * Migrate BizPilot data from the Vercel Blob JSON document to Postgres.
 *
 * Usage (run once, from ~/workspace/bizpilot-ai, after PgDb is wired in
 * and DATABASE_URL is set in the environment):
 *   BLOB_LOCAL_FILE=/path/to/bizpilot-db.json DATABASE_URL='postgres://...' \
 *     node lib/migrate-blob-to-pg.js
 *
 * Or, if the Blob document is only in Vercel Blob (not a local file),
 * download it first via the Vercel dashboard / Blob API and save it as
 * JSON, then point BLOB_LOCAL_FILE at it.
 *
 * Behaviour:
 *   * Reads the Blob JSON tables (users, sessions, password_resets,
 *     leads, follow_ups, proposals, message_templates, ai_history,
 *     ai_usage) in dependency order (users first, so foreign keys hold).
 *   * Inserts each row with INSERT ... ON CONFLICT (id) DO NOTHING, so
 *     re-running the script is safe and never overwrites newer rows.
 *   * Prints a count per table. It never deletes anything from Blob.
 *   * Sessions are migrated too, so users stay logged in across the
 *     migration — provided AUTH_SECRET is unchanged (it is a Vercel
 *     env var, not part of this script).
 */
const fs = require('fs');

const TABLES_IN_ORDER = [
  'users', 'sessions', 'password_resets', 'leads', 'follow_ups',
  'proposals', 'message_templates', 'ai_history', 'ai_usage',
];

async function main() {
  const file = process.env.BLOB_LOCAL_FILE;
  if (!file) throw new Error('Set BLOB_LOCAL_FILE to the downloaded Blob JSON document');
  if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL to the target Postgres connection string');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const { PgDb } = require('./pgdb');
  const db = new PgDb(process.env.DATABASE_URL);
  await db.init();
  for (const table of TABLES_IN_ORDER) {
    const rows = Array.isArray(data[table]) ? data[table] : [];
    let inserted = 0;
    for (const row of rows) {
      const cols = Object.keys(row);
      if (!cols.length) continue;
      const placeholders = cols.map((_, i) => '$' + (i + 1)).join(',');
      const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES (${placeholders}) ON CONFLICT (id) DO NOTHING`;
      const r = await db.prepare(sql).run(...cols.map((c) => row[c]));
      inserted += r.changes || 0;
    }
    console.log(`${table}: ${rows.length} in Blob, ${inserted} newly inserted`);
  }
  await db.close();
  console.log('Migration complete. Verify with a fresh signup + login on the Postgres deployment before switching traffic.');
}

if (require.main === module) main().catch((e) => { console.error('Migration failed:', e.message); process.exit(1); });
module.exports = { TABLES_IN_ORDER };
