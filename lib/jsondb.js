/**
 * JsonDb — a small, synchronous-looking database that implements exactly
 * the SQL patterns used by server.js, over plain JSON tables.
 *
 * WHY THIS EXISTS: Vercel serverless functions are stateless and their
 * /tmp filesystem is NOT shared between instances. A SQLite file in /tmp
 * therefore vanishes (or differs) from one request to the next: a user
 * created on instance A could be "not found" on instance B, which is
 * exactly the signup -> dashboard error reported on the live site.
 * JsonDb persists the whole database as ONE JSON document in a shared
 * store (Vercel Blob in production, a local file when BLOB_LOCAL_FILE
 * is set for testing), so every instance loads the same data.
 *
 * LIMITATION (documented, not hidden): two different instances that
 * load the same document, write different rows, and save concurrently
 * can overwrite each other — last save wins. User actions in this app
 * are sequential (one form at a time), and reads never write, so this
 * is a large improvement over /tmp SQLite, but it is NOT a replacement
 * for PostgreSQL under heavy concurrent writes. For that, use the
 * Supabase/PostgreSQL schema in supabase/migrations/001_init.sql.
 */
const fs = require('fs');

const SCHEMAS = {
  users: ['id', 'full_name', 'email', 'password_hash', 'business_name', 'business_type', 'preferred_language', 'plan', 'email_verified', 'created_at', 'updated_at'],
  sessions: ['id', 'user_id', 'token_hash', 'expires_at', 'created_at'],
  password_resets: ['id', 'user_id', 'token_hash', 'expires_at', 'used', 'created_at'],
  leads: ['id', 'user_id', 'client_name', 'email', 'phone', 'company', 'service', 'source', 'budget', 'currency', 'status', 'priority', 'notes', 'next_follow_up', 'created_at', 'updated_at'],
  follow_ups: ['id', 'user_id', 'lead_id', 'title', 'notes', 'due_date', 'status', 'completed_at', 'created_at', 'updated_at'],
  proposals: ['id', 'user_id', 'lead_id', 'client_name', 'client_company', 'title', 'overview', 'scope', 'deliverables', 'timeline', 'currency', 'tax_rate', 'discount', 'payment_terms', 'notes', 'status', 'created_at', 'updated_at'],
  message_templates: ['id', 'user_id', 'title', 'category', 'body', 'created_at', 'updated_at'],
  ai_history: ['id', 'user_id', 'output_type', 'tone', 'language', 'input_text', 'output_text', 'provider', 'created_at'],
  ai_usage: ['id', 'user_id', 'month', 'count'],
};
const emptyTables = () => { const t = {}; for (const k of Object.keys(SCHEMAS)) t[k] = []; return t; };
const norm = (sql) => String(sql).replace(/\s+/g, ' ').trim();
const stripAlias = (c) => c.replace(/^[a-z_][a-z0-9_]*\./i, '');

function parseWhere(where, params) {
  // Returns {conds: [{col, value}], } — supports col=? (param, in order)
  // and col=<literal> (e.g. used=0). Params are consumed in order.
  if (!where) return [];
  const parts = where.split(/\s+AND\s+/i);
  const conds = []; let pi = 0;
  for (const p of parts) {
    const m = p.trim().match(/^([a-z_][a-z0-9_.]*)\s*=\s*(\?|'([^']*)'|(\d+))$/i);
    if (!m) throw new Error(`Unsupported WHERE condition: ${p}`);
    if (m[2] === '?') conds.push({ col: stripAlias(m[1]), value: params[pi++] });
    else if (m[3] !== undefined) conds.push({ col: stripAlias(m[1]), value: m[3] });
    else conds.push({ col: stripAlias(m[1]), value: Number(m[4]) });
  }
  return conds;
}
const matches = (row, conds) => conds.every((c) => row[c.col] === c.value);

class JsonDb {
  constructor() { this.tables = emptyTables(); this.dirty = false; this.loaded = false; this.lastLoad = { ok: false, reason: 'not-loaded' }; }
  exec() { /* CREATE TABLE / PRAGMA / INDEX are no-ops: tables are fixed above */ }

  async loadPersisted() {
    try {
      let text = null;
      if (process.env.BLOB_LOCAL_FILE) {
        if (fs.existsSync(process.env.BLOB_LOCAL_FILE)) text = fs.readFileSync(process.env.BLOB_LOCAL_FILE, 'utf8');
      } else if (process.env.BLOB_READ_WRITE_TOKEN) {
        const { get } = require('@vercel/blob');
        const res = await get('bizpilot-db.json', { access: 'private', useCache: false });
        if (res && res.stream) text = await new Response(res.stream).text();
        else this.lastLoad = { ok: false, reason: res ? 'get-returned-no-stream' : 'get-returned-null', streamType: res && res.stream ? typeof res.stream : 'none' };
      }
      if (text) {
        const data = JSON.parse(text);
        if (data && typeof data === 'object') {
          for (const k of Object.keys(SCHEMAS)) if (Array.isArray(data[k])) this.tables[k] = data[k];
          this.lastLoad = { ok: true, reason: 'loaded', users: this.tables.users.length, sessions: this.tables.sessions.length, textLen: text.length };
        }
      } else if (!this.lastLoad || this.lastLoad.reason === 'not-loaded') {
        this.lastLoad = { ok: false, reason: 'no-text-from-store' };
      }
    } catch (e) { console.error('[jsondb] load failed, starting empty:', e.message); this.lastLoad = { ok: false, reason: 'error:' + String(e.message).slice(0, 120) }; }
    this.loaded = true;
  }

  async savePersisted() {
    const text = JSON.stringify(this.tables);
    if (process.env.BLOB_LOCAL_FILE) {
      fs.mkdirSync(require('path').dirname(process.env.BLOB_LOCAL_FILE), { recursive: true });
      fs.writeFileSync(process.env.BLOB_LOCAL_FILE, text);
      return;
    }
    if (process.env.BLOB_READ_WRITE_TOKEN) {
      const { put } = require('@vercel/blob');
      // allowOverwrite is REQUIRED: @vercel/blob throws by default when
      // the destination already exists. Without it, the FIRST save
      // succeeds and EVERY later save fails silently — new accounts
      // then live only in one instance's memory until it freezes,
      // which is exactly the random signup -> dashboard 401 bug.
      await put('bizpilot-db.json', text, { access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json' });
    }
  }

  prepare(sql) {
    const s = norm(sql);
    const self = this;
    // ---- CREATE / PRAGMA / INDEX ----
    if (/^(CREATE|PRAGMA)/i.test(s)) return { get: () => undefined, all: () => [], run: () => ({}) };
    // ---- INSERT ----
    let m = s.match(/^INSERT INTO (\w+) VALUES \(([^)]+)\)$/i);
    if (m) {
      const table = m[1]; const cols = SCHEMAS[table]; if (!cols) throw new Error(`Unknown table ${table}`);
      return {
        run: (...params) => {
          const row = {};
          cols.forEach((c, i) => { row[c] = i < params.length ? params[i] : null; });
          self.tables[table].push(row); self.dirty = true; return {};
        },
        get: () => undefined, all: () => [],
      };
    }
    // ---- COUNT ----
    m = s.match(/^SELECT COUNT\(\*\) (\w+) FROM (\w+)(?: WHERE (.+))?$/i);
    if (m) {
      const [, alias, table, where] = m;
      return {
        get: (...params) => ({ [alias]: self.tables[table].filter((r) => matches(r, parseWhere(where, params))).length }),
        all: (...params) => [{ [alias]: self.tables[table].filter((r) => matches(r, parseWhere(where, params))).length }],
        run: () => ({}),
      };
    }
    // ---- follow_ups JOIN (the only JOIN in the app) ----
    if (/FROM follow_ups f LEFT JOIN leads l/i.test(s)) {
      return {
        all: (...params) => {
          const whereMatch = s.match(/WHERE (.+?)(?: ORDER BY .+)?$/i);
          const conds = parseWhere(whereMatch ? whereMatch[1] : null, params);
          let rows = self.tables.follow_ups.filter((r) => matches(r, conds)).map((r) => {
            const lead = self.tables.leads.find((l) => l.id === r.lead_id);
            return { ...r, lead_name: lead ? lead.client_name : null };
          });
          if (/ORDER BY .*due_date ASC/i.test(s)) rows.sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)));
          return rows;
        },
        get: (...params) => {
          const whereMatch = s.match(/WHERE (.+?)(?: ORDER BY .+)?$/i);
          const conds = parseWhere(whereMatch ? whereMatch[1] : null, params);
          const r = self.tables.follow_ups.find((x) => matches(x, conds));
          if (!r) return undefined;
          const lead = self.tables.leads.find((l) => l.id === r.lead_id);
          return { ...r, lead_name: lead ? lead.client_name : null };
        },
        run: () => ({}),
      };
    }
    // ---- SELECT ----
    m = s.match(/^SELECT .* FROM (\w+)(?: WHERE (.+?))?(?: ORDER BY ([a-z_][a-z0-9_.]*)(?: (ASC|DESC))?)?(?: LIMIT (\d+))?$/i);
    if (m) {
      const [, table, where, orderCol, orderDir, limit] = m;
      const runSelect = (...params) => {
        let rows = self.tables[table].filter((r) => matches(r, parseWhere(where, params)));
        if (orderCol) {
          const col = stripAlias(orderCol);
          rows = [...rows].sort((a, b) => {
            const cmp = String(a[col] ?? '').localeCompare(String(b[col] ?? ''));
            return (orderDir || 'ASC').toUpperCase() === 'DESC' ? -cmp : cmp;
          });
        }
        if (limit) rows = rows.slice(0, Number(limit));
        return rows;
      };
      return { get: (...p) => runSelect(...p)[0], all: (...p) => runSelect(...p), run: () => ({}) };
    }
    // ---- UPDATE ----
    m = s.match(/^UPDATE (\w+) SET (.+?) WHERE (.+)$/i);
    if (m) {
      const [, table, setPart, wherePart] = m;
      return {
        run: (...params) => {
          const setCols = setPart.split(',').map((x) => x.trim());
          // count=count+1 is the only non-placeholder set expression
          const isIncrement = setCols.length === 1 && /count\s*=\s*count\s*\+\s*1/i.test(setCols[0]);
          let pi = 0; const sets = {};
          if (!isIncrement) for (const sc of setCols) { const cm = sc.match(/^([a-z_][a-z0-9_]*)\s*=\s*\?$/i); sets[cm[1]] = params[pi++]; }
          const conds = parseWhere(wherePart, params.slice(pi));
          for (const row of self.tables[table]) {
            if (!matches(row, conds)) continue;
            if (isIncrement) row.count = (Number(row.count) || 0) + 1; else Object.assign(row, sets);
          }
          self.dirty = true; return {};
        },
        get: () => undefined, all: () => [],
      };
    }
    // ---- DELETE ----
    m = s.match(/^DELETE FROM (\w+) WHERE (.+)$/i);
    if (m) {
      const [, table, wherePart] = m;
      return {
        run: (...params) => {
          const conds = parseWhere(wherePart, params);
          const removed = self.tables[table].filter((r) => matches(r, conds));
          self.tables[table] = self.tables[table].filter((r) => !matches(r, conds));
          if (table === 'users') {
            for (const id of removed.map((r) => r.id)) {
              for (const t of Object.keys(self.tables)) {
                if (t === 'users') continue;
                self.tables[t] = self.tables[t].filter((r) => r.user_id !== id);
              }
            }
          }
          if (table === 'leads') {
            for (const id of removed.map((r) => r.id)) {
              for (const r of self.tables.follow_ups) if (r.lead_id === id) r.lead_id = null;
              for (const r of self.tables.proposals) if (r.lead_id === id) r.lead_id = null;
            }
          }
          self.dirty = true; return {};
        },
        get: () => undefined, all: () => [],
      };
    }
    throw new Error(`Unsupported SQL in JsonDb: ${sql}`);
  }
}
module.exports = { JsonDb, SCHEMAS };
