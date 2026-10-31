/**
 * PgDb — Postgres backend for BizPilot AI (PREPARATION, not yet live).
 *
 * Why this exists: the live site currently persists its whole database
 * as ONE JSON document in Vercel Blob (lib/jsondb.js). That works, but
 * it is not a real relational database: every API request downloads the
 * whole document, and concurrent writes from different serverless
 * instances can overwrite each other (last save wins). A managed
 * Postgres database (Supabase or Neon, free tier) fixes both: each
 * request runs one indexed query instead of downloading everything,
 * and the database itself serialises concurrent writes.
 *
 * How it is used (once a DATABASE_URL is available):
 *   const { PgDb } = require('./lib/pgdb');
 *   db = new PgDb(process.env.DATABASE_URL);
 *   await db.init(); // creates tables if missing, same column order
 *                    // as the SQLite schema in server.js
 *   // then server.js call sites change from sync to async:
 *   //   db.prepare('SELECT * FROM leads WHERE user_id=?').get(id)
 *   // becomes:
 *   //   await db.prepare('SELECT * FROM leads WHERE user_id=?').get(id)
 *   // (await binds to the whole .get() promise, so only an `await`
 *   //  prefix and an async enclosing function are needed.)
 *
 * Conversion rules (kept deliberately small, so the existing SQL in
 * server.js works unchanged):
 *   * `?` placeholders become $1, $2, ... in order.
 *   * COUNT(*) results come back from Postgres as strings; the `c`
 *     column is converted back to a Number, matching SQLite.
 *   * email_verified / used stay INTEGER (0/1) in the Postgres schema,
 *     matching the SQLite schema, so `!!value` checks keep working.
 *   * Dates stay TEXT ISO strings, same as SQLite.
 *
 * Do NOT deploy this as the live backend until it has been tested
 * against a real Postgres instance and the Blob data has been migrated
 * with lib/migrate-blob-to-pg.js. Until DATABASE_URL is set, the live
 * site keeps using JsonDb/Blob, unchanged.
 */
function convertSql(sql) {
  let i = 0;
  // No `?` appears inside a string literal in server.js SQL, so a
  // plain positional replacement is safe here.
  return String(sql).replace(/\?/g, () => '$' + (++i));
}

class PgDb {
  constructor(connectionString, poolFactory) {
    if (!connectionString && !poolFactory) throw new Error('PgDb needs DATABASE_URL or a pool factory');
    this.connectionString = connectionString;
    this.poolFactory = poolFactory;
    this.pool = null;
  }
  async _pool() {
    if (this.pool) return this.pool;
    if (this.poolFactory) { this.pool = this.poolFactory(); return this.pool; }
    const { Pool } = require('pg');
    this.pool = new Pool({ connectionString: this.connectionString, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 8000, idleTimeoutMillis: 30000, max: 5, keepAlive: true });
    return this.pool;
  }
  static _fixRow(row) {
    if (!row || typeof row !== 'object') return row;
    if (row.c !== undefined && typeof row.c === 'string' && /^\d+$/.test(row.c)) row.c = Number(row.c);
    return row;
  }
  prepare(sql) {
    const pgSql = convertSql(sql);
    const self = this;
    return {
      get: async (...params) => {
        const pool = await self._pool();
        const r = await pool.query(pgSql, params);
        return PgDb._fixRow(r.rows[0]);
      },
      all: async (...params) => {
        const pool = await self._pool();
        const r = await pool.query(pgSql, params);
        return r.rows.map(PgDb._fixRow);
      },
      run: async (...params) => {
        const pool = await self._pool();
        const r = await pool.query(pgSql, params);
        return { changes: r.rowCount };
      },
    };
  }
  async exec(sql) {
    const pool = await this._pool();
    await pool.query(sql);
  }
  async init() {
    await this.exec(`
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, full_name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, business_name TEXT NOT NULL DEFAULT '', business_type TEXT NOT NULL DEFAULT '', preferred_language TEXT NOT NULL DEFAULT 'English', plan TEXT NOT NULL DEFAULT 'FREE', email_verified INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, token_hash TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS password_resets(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, token_hash TEXT NOT NULL, expires_at TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS leads(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, client_name TEXT NOT NULL, email TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', company TEXT NOT NULL DEFAULT '', service TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT 'Other', budget DOUBLE PRECISION NOT NULL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'USD', status TEXT NOT NULL DEFAULT 'New', priority TEXT NOT NULL DEFAULT 'Medium', notes TEXT NOT NULL DEFAULT '', next_follow_up TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS follow_ups(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, lead_id TEXT REFERENCES leads(id) ON DELETE SET NULL, title TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', due_date TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'Pending', completed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS proposals(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, lead_id TEXT REFERENCES leads(id) ON DELETE SET NULL, client_name TEXT NOT NULL, client_company TEXT NOT NULL DEFAULT '', title TEXT NOT NULL, overview TEXT NOT NULL DEFAULT '', scope TEXT NOT NULL DEFAULT '', deliverables TEXT NOT NULL DEFAULT '[]', timeline TEXT NOT NULL DEFAULT '', currency TEXT NOT NULL DEFAULT 'USD', tax_rate DOUBLE PRECISION NOT NULL DEFAULT 0, discount DOUBLE PRECISION NOT NULL DEFAULT 0, payment_terms TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'Draft', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS message_templates(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, title TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'General', body TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ai_history(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, output_type TEXT NOT NULL, tone TEXT NOT NULL DEFAULT 'Professional', language TEXT NOT NULL DEFAULT 'English', input_text TEXT NOT NULL DEFAULT '', output_text TEXT NOT NULL, provider TEXT NOT NULL DEFAULT 'template', created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ai_usage(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, month TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, UNIQUE(user_id, month));
      CREATE INDEX IF NOT EXISTS idx_leads_user ON leads(user_id);
      CREATE INDEX IF NOT EXISTS idx_followups_due ON follow_ups(user_id, due_date, status);
      CREATE INDEX IF NOT EXISTS idx_proposals_user ON proposals(user_id);
      CREATE INDEX IF NOT EXISTS idx_templates_user ON message_templates(user_id);
      CREATE INDEX IF NOT EXISTS idx_ai_user ON ai_history(user_id, created_at);
    `);
  }
  async close() { if (this.pool && this.pool.end) await this.pool.end(); }
}

module.exports = { PgDb, convertSql };
