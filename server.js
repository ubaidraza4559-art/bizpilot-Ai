/**
 * BizPilot AI — full-stack SaaS workspace (runnable MVP)
 * ----------------------------------------------------------------
 * RUNNABLE STACK (this environment): Node.js 24 + Express + SQLite
 * (node:sqlite, built-in, no extra DB dependency). Data persists in
 * data/bizpilot.db. All business rules below are enforced on the server:
 * ownership (every row is scoped to req.user.id), plan limits, AI monthly
 * usage, validation, and rate limits. Never trust a userId from the client.
 *
 * PRODUCTION TARGET (documented in README + supabase/ + prisma/):
 * Next.js App Router + Supabase Auth + PostgreSQL + RLS + OpenAI.
 * The API contract here mirrors that target exactly:
 *   GET/PATCH /api/profile, /api/leads, /api/ai/generate, /api/ai/history,
 *   /api/ai/usage, /api/follow-ups, /api/proposals, /api/templates,
 *   GET /api/analytics/overview, GET /api/plans
 * So the frontend can move to Next.js/Supabase without changing routes.
 *
 * AI: POST /api/ai/generate calls OpenAI ONLY from the server when
 * OPENAI_API_KEY is set. When it is missing, the server returns a clearly
 * labelled template draft (provider:"template") and the UI shows a banner
 * saying the key is not configured. It never pretends a template is AI.
 * Only the fields needed for the task are sent to OpenAI — never the
 * whole lead database, passwords, or payment details.
 *
 * EMAIL / WHATSAPP / PAYMENTS: not configured in this MVP. The forgot-
 * password flow, billing upgrade buttons and reminder integrations are
 * honest placeholders with documented integration points (see README).
 * No email, WhatsApp message or paid subscription is ever claimed to
 * have been sent or activated.
 *
 * Run:  npm install && npm start   (then open http://localhost:3000)
 * Test: npm test
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { DatabaseSync } = require('node:sqlite');

// ---------- env ----------
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  }
} catch {}
const PORT = parseInt(process.env.PORT || '3000', 10);
const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, 'data', 'bizpilot.db');
const AUTH_SECRET = process.env.AUTH_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.AUTH_SECRET) console.warn('[warn] AUTH_SECRET not set — sessions will not survive a restart. Set it in .env for production.');
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const IS_PROD = process.env.NODE_ENV === 'production';

// ---------- plans (single source of truth; the frontend fetches /api/plans) ----------
const PLANS = {
  FREE:    { id: 'FREE',    name: 'Free',    price: 0,  maxLeads: 25,    maxAiPerMonth: 10,   features: ['Basic lead management', 'Basic templates', 'Follow-up tracking'] },
  STARTER: { id: 'STARTER', name: 'Starter', price: 5,  maxLeads: 500,   maxAiPerMonth: 200,  features: ['AI replies and proposals', 'Follow-up management', 'All Free features'] },
  PRO:     { id: 'PRO',     name: 'Pro',     price: 12, maxLeads: 5000,  maxAiPerMonth: 1000, features: ['Advanced analytics', 'Proposal exports (print/PDF)', 'Expanded AI usage'] },
  AGENCY:  { id: 'AGENCY',  name: 'Agency',  price: 29, maxLeads: 20000, maxAiPerMonth: 5000, features: ['Multi-user workspace support', 'Team permissions', 'Highest usage limits'] },
};
const planOf = (u) => PLANS[u.plan] || PLANS.FREE;

// ---------- db ----------
// Two backends, one API (db.prepare/exec):
//  * Local / default: SQLite (node:sqlite) in data/bizpilot.db — fast, tested.
//  * Vercel / Blob mode (BLOB_READ_WRITE_TOKEN or BLOB_LOCAL_FILE set):
//    JsonDb (lib/jsondb.js) persisted as one JSON document in a SHARED
//    store. This is REQUIRED on Vercel: serverless /tmp is per-instance
//    and unshared, so a SQLite file there makes accounts vanish between
//    requests (signup on instance A, dashboard on instance B = 401/error).
//    JsonDb is not a Postgres replacement for heavy concurrent writes;
//    see lib/jsondb.js for its documented limitation.
// Postgres (Neon via Vercel) takes priority when a connection string is
// present. Neon via Vercel adds variables with the custom prefix chosen
// at install time (STORAGE_ in this project), so check the pooled URL
// under every plausible name before falling back to a non-pooling URL.
// If Postgres init fails for any reason, fall back to JsonDb/Blob so
// the site stays up on its previous store instead of going down.
const PG_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.STORAGE_POSTGRES_URL || process.env.STORAGE_DATABASE_URL || process.env.NEON_DATABASE_URL || process.env.POSTGRES_URL_NON_POOLING || process.env.STORAGE_POSTGRES_URL_NON_POOLING || '';
const USE_PG = !!PG_URL;
const USE_JSON_DB = !USE_PG && !!(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_LOCAL_FILE);
let db; let dbReady = Promise.resolve();
async function migrateBlobToPgIfEmpty() {
  if (!process.env.BLOB_READ_WRITE_TOKEN && !process.env.BLOB_LOCAL_FILE) return;
  try {
    const row = await db.prepare('SELECT COUNT(*) c FROM users').get();
    if (row && row.c > 0) return; // Postgres already has data; never overwrite it
    const { JsonDb } = require('./lib/jsondb');
    const blob = new JsonDb(); await blob.loadPersisted();
    const order = ['users', 'sessions', 'password_resets', 'leads', 'follow_ups', 'proposals', 'message_templates', 'ai_history', 'ai_usage'];
    for (const table of order) {
      const rows = blob.tables[table] || [];
      for (const r of rows) {
        const cols = Object.keys(r); if (!cols.length) continue;
        const ph = cols.map(() => '?').join(',');
        await db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${ph}) ON CONFLICT (id) DO NOTHING`).run(...cols.map((c) => r[c]));
      }
      console.log(`[pgdb] migrated ${table}: ${rows.length} rows from Blob`);
    }
  } catch (e) { console.error('[pgdb] Blob migration skipped/failed:', e.message); }
}
if (USE_PG) {
  const { PgDb } = require('./lib/pgdb');
  db = new PgDb(PG_URL);
  dbReady = (async () => {
    try { await db.init(); await migrateBlobToPgIfEmpty(); }
    catch (e) {
      console.error('[pgdb] init failed, falling back to JsonDb/Blob:', e.message);
      const { JsonDb } = require('./lib/jsondb');
      db = new JsonDb(); await db.loadPersisted().catch(() => {});
    }
  })();
} else if (USE_JSON_DB) {
  const { JsonDb } = require('./lib/jsondb');
  db = new JsonDb();
  dbReady = db.loadPersisted().catch((e) => console.error('[jsondb] initial load failed:', e.message));
} else {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new DatabaseSync(DB_PATH);
}
if (!USE_PG) db.exec('PRAGMA foreign_keys = ON');
if (!USE_PG) db.exec(`
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, full_name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, business_name TEXT NOT NULL DEFAULT '', business_type TEXT NOT NULL DEFAULT '', preferred_language TEXT NOT NULL DEFAULT 'English', plan TEXT NOT NULL DEFAULT 'FREE', email_verified INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, token_hash TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS password_resets(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, token_hash TEXT NOT NULL, expires_at TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS leads(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, client_name TEXT NOT NULL, email TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', company TEXT NOT NULL DEFAULT '', service TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT 'Other', budget REAL NOT NULL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'USD', status TEXT NOT NULL DEFAULT 'New', priority TEXT NOT NULL DEFAULT 'Medium', notes TEXT NOT NULL DEFAULT '', next_follow_up TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS follow_ups(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, lead_id TEXT REFERENCES leads(id) ON DELETE SET NULL, title TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', due_date TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'Pending', completed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS proposals(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, lead_id TEXT REFERENCES leads(id) ON DELETE SET NULL, client_name TEXT NOT NULL, client_company TEXT NOT NULL DEFAULT '', title TEXT NOT NULL, overview TEXT NOT NULL DEFAULT '', scope TEXT NOT NULL DEFAULT '', deliverables TEXT NOT NULL DEFAULT '[]', timeline TEXT NOT NULL DEFAULT '', currency TEXT NOT NULL DEFAULT 'USD', tax_rate REAL NOT NULL DEFAULT 0, discount REAL NOT NULL DEFAULT 0, payment_terms TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'Draft', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS message_templates(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, title TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'General', body TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ai_history(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, output_type TEXT NOT NULL, tone TEXT NOT NULL DEFAULT 'Professional', language TEXT NOT NULL DEFAULT 'English', input_text TEXT NOT NULL DEFAULT '', output_text TEXT NOT NULL, provider TEXT NOT NULL DEFAULT 'template', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ai_usage(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, month TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, UNIQUE(user_id, month));
CREATE INDEX IF NOT EXISTS idx_leads_user ON leads(user_id);
CREATE INDEX IF NOT EXISTS idx_leads_search ON leads(user_id, client_name, company, email, service);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(user_id, status);
CREATE INDEX IF NOT EXISTS idx_followups_due ON follow_ups(user_id, due_date, status);
CREATE INDEX IF NOT EXISTS idx_proposals_user ON proposals(user_id);
CREATE INDEX IF NOT EXISTS idx_templates_user ON message_templates(user_id);
CREATE INDEX IF NOT EXISTS idx_ai_user ON ai_history(user_id, created_at);
`);
const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();
const monthKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
const clean = (v) => (typeof v === 'string' ? v.trim() : v);

// ---------- auth helpers ----------
function hashPassword(pw) { const salt = crypto.randomBytes(16).toString('hex'); return `${salt}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`; }
function verifyPassword(pw, stored) { try { const [salt, h] = stored.split(':'); return crypto.timingSafeEqual(Buffer.from(h, 'hex'), crypto.scryptSync(pw, salt, 64)); } catch { return false; } }
const sha = (s) => crypto.createHash('sha256').update(String(s) + AUTH_SECRET).digest('hex');
function parseCookies(req) { const out = {}; (req.headers.cookie || '').split(';').forEach((p) => { const i = p.indexOf('='); if (i > -1) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); }); return out; }
async function authUser(req) {
  const token = parseCookies(req).bp_session; if (!token) return null;
  const s = await db.prepare('SELECT * FROM sessions WHERE token_hash=?').get(sha(token));
  if (!s || new Date(s.expires_at) < new Date()) return null;
  return (await db.prepare('SELECT * FROM users WHERE id=?').get(s.user_id)) || null;
}
function publicUser(u) { return u ? { id: u.id, fullName: u.full_name, email: u.email, businessName: u.business_name, businessType: u.business_type, preferredLanguage: u.preferred_language, plan: u.plan, emailVerified: !!u.email_verified, createdAt: u.created_at } : null; }
async function requireAuth(req, res, next) {
  const u = await authUser(req); if (!u) return res.status(401).json({ ok: false, error: 'Please log in to continue.' });
  if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method) && req.headers.origin) {
    try { const o = new URL(req.headers.origin); if (o.host !== (req.headers.host || '')) return res.status(403).json({ ok: false, error: 'Origin not allowed.' }); } catch {}
  }
  req.user = u; next();
}

// ---------- rate limiting (in-memory, per user/IP) ----------
const buckets = new Map();
function rateLimit(key, max, windowMs) {
  return (req, res, next) => {
    const who = req.user ? `u:${req.user.id}` : `ip:${req.ip}`;
    const k = `${key}:${who}`; const t = Date.now();
    const arr = (buckets.get(k) || []).filter((x) => t - x < windowMs);
    if (arr.length >= max) return res.status(429).json({ ok: false, error: 'Too many requests. Please try again in a moment.' });
    arr.push(t); buckets.set(k, arr); next();
  };
}

// ---------- validation ----------
const isEmail = (e) => typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());
function reqStr(v, max, label, errors) { const s = clean(v); if (!s) errors.push(`${label} is required.`); else if (s.length > max) errors.push(`${label} is too long.`); return s || ''; }
function optStr(v, max, label, errors) { const s = clean(v); if (s && s.length > max) errors.push(`${label} is too long.`); return s || ''; }
function numVal(v, label, errors) { if (v === '' || v === null || v === undefined) return 0; const n = Number(v); if (!Number.isFinite(n) || n < 0) errors.push(`${label} must be a positive number.`); return Number.isFinite(n) && n >= 0 ? n : 0; }
const LEAD_STATUSES = ['New', 'Contacted', 'Qualified', 'Proposal Sent', 'Negotiation', 'Won', 'Lost'];
const PRIORITIES = ['Low', 'Medium', 'High'];
const SOURCES = ['Website', 'Referral', 'Social Media', 'WhatsApp', 'Phone', 'Walk-in', 'Other'];
const TONES = ['Professional', 'Friendly', 'Persuasive', 'Formal', 'Concise'];
const LANGUAGES = ['English', 'Roman Urdu', 'Urdu'];
const OUTPUT_TYPES = ['Client reply', 'First-contact message', 'Follow-up message', 'Requirement questions', 'Proposal draft', 'Quotation description', 'Negotiation response', 'Project completion message'];
const LENGTHS = ['Short', 'Medium', 'Long'];

// ---------- row mappers ----------
const leadRow = (r) => r ? { id: r.id, clientName: r.client_name, email: r.email, phone: r.phone, company: r.company, service: r.service, source: r.source, budget: r.budget, currency: r.currency, status: r.status, priority: r.priority, notes: r.notes, nextFollowUp: r.next_follow_up, createdAt: r.created_at, updatedAt: r.updated_at } : null;
const fuRow = (r) => r ? { id: r.id, leadId: r.lead_id, title: r.title, notes: r.notes, dueDate: r.due_date, status: r.status, completedAt: r.completed_at, createdAt: r.created_at, leadName: r.lead_name || null } : null;
function proposalRow(r) {
  if (!r) return null;
  let items = []; try { items = JSON.parse(r.deliverables || '[]'); } catch {}
  const subtotal = items.reduce((s, it) => s + (Number(it.qty || 0) * Number(it.price || 0)), 0);
  const taxable = Math.max(0, subtotal - Number(r.discount || 0));
  const total = taxable + (taxable * Number(r.tax_rate || 0)) / 100;
  return { id: r.id, leadId: r.lead_id, clientName: r.client_name, clientCompany: r.client_company, title: r.title, overview: r.overview, scope: r.scope, deliverables: items, timeline: r.timeline, currency: r.currency, taxRate: r.tax_rate, discount: r.discount, paymentTerms: r.payment_terms, notes: r.notes, status: r.status, subtotal: Math.round(subtotal * 100) / 100, total: Math.round(total * 100) / 100, createdAt: r.created_at, updatedAt: r.updated_at };
}
const tplRow = (r) => r ? { id: r.id, title: r.title, category: r.category, body: r.body, createdAt: r.created_at } : null;
const aiRow = (r) => r ? { id: r.id, outputType: r.output_type, tone: r.tone, language: r.language, inputText: r.input_text, outputText: r.output_text, provider: r.provider, createdAt: r.created_at } : null;
const DEFAULT_TEMPLATES = [
  ['First client contact', 'First contact', 'Hello {name}, thank you for reaching out about {service}. I would love to help. Could you please share a little more about your goals, timeline, and budget so I can prepare a clear plan for you?'],
  ['Follow-up after no response', 'Follow-up', 'Hi {name}, just checking in on my last message about {service}. No pressure at all — whenever you are ready, I can share the next steps and a simple quotation.'],
  ['Price negotiation', 'Negotiation', 'Thank you for sharing your budget, {name}. I understand the concern about price. Here is what I can include at that level, and what would change if we adjust the scope — so you can choose with full clarity.'],
  ['Requirement collection', 'Requirements', 'Hi {name}, before I prepare your proposal, could you please confirm: 1) Your main goal, 2) Must-have features, 3) Preferred timeline, 4) Any examples you like? This helps me quote accurately.'],
  ['Proposal delivery', 'Proposal', 'Hi {name}, your proposal for {service} is ready. It covers the scope, timeline, and pricing in one place. Please review it and let me know any changes — I am happy to adjust it.'],
  ['Project completion', 'Completion', 'Hi {name}, your project is now complete. Thank you for trusting me with it. Please review the final delivery, and if you are happy, a short review would mean a lot.'],
  ['Review request', 'Review', 'Hi {name}, thank you for working with me on {service}. If you had a good experience, would you mind leaving a short review? It really helps other clients find me.'],
];
async function seedTemplates(userId) {
  for (const [title, cat, body] of DEFAULT_TEMPLATES) await db.prepare('INSERT INTO message_templates VALUES (?,?,?,?,?,?,?)').run(uid(), userId, title, cat, body, now(), now());
}
const SAMPLE_LEADS = [
  ['Ayesha Khan', 'ayesha@example.com', '+92 300 1234567', 'Khan Boutique', 'Website design', 'Instagram', 450, 'USD', 'New', 'High', 'Needs a new online store before Eid season.'],
  ['Bilal Ahmed', 'bilal@example.com', '', 'Ahmed Traders', 'Logo and branding', 'Referral', 200, 'USD', 'Contacted', 'Medium', 'Wants a modern logo, 3 concepts requested.'],
  ['Sara Malik', 'sara@example.com', '', 'Malik Salon', 'Social media management', 'Website', 300, 'USD', 'Qualified', 'High', 'Monthly package, 12 posts per month.'],
  ['Usman Tariq', 'usman@example.com', '', 'Tariq Foods', 'Menu website', 'WhatsApp', 600, 'USD', 'Proposal Sent', 'Medium', 'Proposal sent, waiting for feedback.'],
];

// ---------- app ----------
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '200kb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});
// BLANK-PAGE FIX (2026-10-30 evening): static files must NEVER wait
// for the database. Previously every request — including /, /app.js,
// /styles.css and /login — first waited for the shared Blob document
// to download, and the login/dashboard views are hidden in the HTML
// until app.js runs and render() finishes. On a cold serverless
// instance that meant up to ~15 seconds of pure white page, with no
// error text, even though sign-in itself had succeeded. Now static
// files are served first, and the database middleware below runs
// ONLY for /api/* requests.
app.use(express.static(path.join(__dirname, 'public')));
//
// CRITICAL FIX (2026-10-30, browser-flow bug): loading only once at
// startup is NOT enough on Vercel. The dashboard fires 5-6 API requests
// in parallel, and Vercel can route each one to a DIFFERENT instance.
// An instance that started before a signup saved will still hold the
// OLD document in memory, so its /api/auth/me or /api/analytics call
// returns 401 ("Please log in to continue.") even though the session
// is valid on another instance. So in JsonDb mode we reload the shared
// document on EVERY request (unless this instance still has unsaved
// changes, which we must not overwrite). Reads are cheap compared to
// a broken dashboard, and writes are still saved before responding.
app.use(async (req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  try { await dbReady; } catch {}
  if (db && db.loadPersisted && !db.dirty) {
    try { await db.loadPersisted(); } catch (e) { console.error('[jsondb] per-request reload failed, using in-memory copy:', e.message); }
  }
  next();
});
app.use((req, res, next) => {
    const origJson = res.json.bind(res);
    res.json = async (body) => {
      if (db && db.savePersisted && db.dirty) {
        try { await db.savePersisted(); db.dirty = false; } catch (e) {
          console.error('[jsondb] save failed, NOT confirming write:', e.message);
          // Never tell the user a signup/lead was saved when it was
          // not. A failed save must surface as an error, not a silent
          // success that vanishes when the instance freezes.
          // Use origJson here, not res.json, to avoid recursing into
          // this same wrapper (dirty is still true).
          res.status(500);
          return origJson({ ok: false, error: 'Could not save your changes. Please try again.' });
        }
      }
      return origJson(body);
    };
    next();
});
app.get('/api/health', async (req, res) => res.json({ ok: true, aiConfigured: !!OPENAI_API_KEY }));
app.get('/api/plans', async (req, res) => res.json({ ok: true, data: Object.values(PLANS) }));

// ---------- auth ----------
app.post('/api/auth/signup', rateLimit('signup', 20, 60 * 1000), async (req, res) => {
  const errors = [];
  const fullName = reqStr(req.body?.fullName, 100, 'Full name', errors);
  const email = clean(req.body?.email || '').toLowerCase();
  if (!isEmail(email)) errors.push('Enter a valid email address.');
  const pw = req.body?.password || '';
  if (typeof pw !== 'string' || pw.length < 8) errors.push('Password must be at least 8 characters.');
  const businessName = optStr(req.body?.businessName, 120, 'Business name', errors);
  const businessType = optStr(req.body?.businessType, 80, 'Business type', errors);
  const language = LANGUAGES.includes(req.body?.preferredLanguage) ? req.body.preferredLanguage : 'English';
  if (errors.length) return res.status(400).json({ ok: false, error: errors.join(' ') });
  if (await db.prepare('SELECT id FROM users WHERE email=?').get(email)) return res.status(409).json({ ok: false, error: 'An account with this email already exists. Please log in.' });
  const id = uid(); const t = now();
  await db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id, fullName, email, hashPassword(pw), businessName, businessType, language, 'FREE', 0, t, t);
  await seedTemplates(id);
  // Email verification: no email provider is configured in this MVP, so the
  // account is usable immediately and verification is marked honestly below.
  // In production (Supabase Auth) verification email is sent by Supabase.
  const token = crypto.randomBytes(32).toString('hex');
  await db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?)').run(uid(), id, sha(token), new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(), t);
  res.cookie('bp_session', token, { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 30 * 24 * 3600 * 1000, ...(IS_PROD ? { secure: true } : {}) });
  res.status(201).json({ ok: true, data: publicUser(await db.prepare('SELECT * FROM users WHERE id=?').get(id)), note: 'Email verification is not configured in this local build (no email provider). Your account is active immediately; in production Supabase sends a verification email.' });
});
app.post('/api/auth/login', rateLimit('login', 30, 60 * 1000), async (req, res) => {
  const email = clean(req.body?.email || '').toLowerCase();
  const u = await db.prepare('SELECT * FROM users WHERE email=?').get(email);
  if (!u || !verifyPassword(req.body?.password || '', u.password_hash)) return res.status(401).json({ ok: false, error: 'Email or password is incorrect.' });
  const token = crypto.randomBytes(32).toString('hex');
  await db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?)').run(uid(), u.id, sha(token), new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(), now());
  res.cookie('bp_session', token, { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 30 * 24 * 3600 * 1000, ...(IS_PROD ? { secure: true } : {}) });
  res.json({ ok: true, data: publicUser(u) });
});
app.post('/api/auth/logout', requireAuth, async (req, res) => {
  const token = parseCookies(req).bp_session; if (token) await db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha(token));
  res.clearCookie('bp_session', { path: '/' }); res.json({ ok: true });
});
app.get('/api/auth/me', requireAuth, async (req, res) => res.json({ ok: true, data: publicUser(req.user) }));
app.post('/api/auth/forgot-password', rateLimit('forgot', 10, 60 * 1000), async (req, res) => {
  const email = clean(req.body?.email || '').toLowerCase();
  const u = email ? await db.prepare('SELECT * FROM users WHERE email=?').get(email) : null;
  if (!u) return res.json({ ok: true, message: 'If an account exists for this email, a reset link will be sent. (No email provider is configured in this local build.)' });
  const token = crypto.randomBytes(32).toString('hex');
  await db.prepare('INSERT INTO password_resets VALUES (?,?,?,?,?,?)').run(uid(), u.id, sha(token), new Date(Date.now() + 3600 * 1000).toISOString(), 0, now());
  // No email provider: in non-production the token is returned so the flow
  // can actually be completed locally. In production it is never returned.
  if (!IS_PROD) return res.json({ ok: true, message: 'No email provider is configured, so the reset token is shown here for local testing only.', devResetToken: token });
  return res.json({ ok: true, message: 'If an account exists for this email, a reset link has been sent.' });
});
app.post('/api/auth/reset-password', rateLimit('reset', 10, 60 * 1000), async (req, res) => {
  const pw = req.body?.password || '';
  if (typeof pw !== 'string' || pw.length < 8) return res.status(400).json({ ok: false, error: 'Password must be at least 8 characters.' });
  const row = await db.prepare('SELECT * FROM password_resets WHERE token_hash=? AND used=0').get(sha(req.body?.token || ''));
  if (!row || new Date(row.expires_at) < new Date()) return res.status(400).json({ ok: false, error: 'This reset link is invalid or expired.' });
  await db.prepare('UPDATE users SET password_hash=?, updated_at=? WHERE id=?').run(hashPassword(pw), now(), row.user_id);
  await db.prepare('UPDATE password_resets SET used=1 WHERE id=?').run(row.id);
  await db.prepare('DELETE FROM sessions WHERE user_id=?').run(row.user_id);
  res.json({ ok: true, message: 'Password updated. Please log in with your new password.' });
});
app.post('/api/auth/delete-account', requireAuth, async (req, res) => {
  if (req.body?.confirm !== true) return res.status(400).json({ ok: false, error: 'Please confirm account deletion.' });
  await db.prepare('DELETE FROM users WHERE id=?').run(req.user.id);
  res.clearCookie('bp_session', { path: '/' }); res.json({ ok: true });
});

// ---------- profile ----------
app.get('/api/profile', requireAuth, async (req, res) => res.json({ ok: true, data: publicUser(req.user) }));
app.patch('/api/profile', requireAuth, async (req, res) => {
  const errors = [];
  const fullName = reqStr(req.body?.fullName, 100, 'Full name', errors);
  const businessName = optStr(req.body?.businessName, 120, 'Business name', errors);
  const businessType = optStr(req.body?.businessType, 80, 'Business type', errors);
  const language = LANGUAGES.includes(req.body?.preferredLanguage) ? req.body.preferredLanguage : req.user.preferred_language;
  if (errors.length) return res.status(400).json({ ok: false, error: errors.join(' ') });
  await db.prepare('UPDATE users SET full_name=?, business_name=?, business_type=?, preferred_language=?, updated_at=? WHERE id=?').run(fullName, businessName, businessType, language, now(), req.user.id);
  res.json({ ok: true, data: publicUser(await db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id)) });
});

// ---------- demo seed (logged-in user only, clearly labelled SAMPLE) ----------
app.post('/api/demo/seed', requireAuth, async (req, res) => {
  const existing = (await db.prepare('SELECT COUNT(*) c FROM leads WHERE user_id=?').get(req.user.id)).c;
  if (existing > 0) return res.status(400).json({ ok: false, error: 'Sample data can only be loaded into an empty workspace. Delete your leads first, or use a new account.' });
  const t = now();
  for (const [name, email, phone, company, service, source, budget, currency, status, priority, notes] of SAMPLE_LEADS) {
    const leadId = uid();
    await db.prepare('INSERT INTO leads VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(leadId, req.user.id, name, email, phone, company, service, source, budget, currency, status, priority, notes, new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10), t, t);
    await db.prepare('INSERT INTO follow_ups VALUES (?,?,?,?,?,?,?,?,?,?)').run(uid(), req.user.id, leadId, `Follow up with ${name}`, 'Sample follow-up — created by the demo seed.', new Date(Date.now() + 86400000).toISOString().slice(0, 10), 'Pending', null, t, t);
  }
  res.json({ ok: true, message: '4 sample leads and follow-ups added. They are sample data — edit or delete them any time.' });
});

// ---------- leads ----------
function leadFilters(req) {
  const q = (req.query.q || '').toString().trim().toLowerCase();
  const status = req.query.status ? req.query.status.toString() : '';
  const priority = req.query.priority ? req.query.priority.toString() : '';
  const source = req.query.source ? req.query.source.toString() : '';
  const sort = ['created_at', 'client_name', 'budget'].includes(req.query.sort) ? req.query.sort : 'created_at';
  const page = Math.max(1, parseInt(req.query.page || '1', 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || '20', 10) || 20));
  return { q, status, priority, source, sort, page, limit };
}
app.get('/api/leads', requireAuth, async (req, res) => {
  const { q, status, priority, source, sort, page, limit } = leadFilters(req);
  let rows = await db.prepare('SELECT * FROM leads WHERE user_id=? ORDER BY created_at DESC').all(req.user.id);
  if (q) rows = rows.filter((r) => [r.client_name, r.company, r.email, r.service].join(' ').toLowerCase().includes(q));
  if (status) rows = rows.filter((r) => r.status === status);
  if (priority) rows = rows.filter((r) => r.priority === priority);
  if (source) rows = rows.filter((r) => r.source === source);
  if (sort === 'client_name') rows.sort((a, b) => a.client_name.localeCompare(b.client_name));
  if (sort === 'budget') rows.sort((a, b) => b.budget - a.budget);
  const total = rows.length;
  rows = rows.slice((page - 1) * limit, page * limit);
  res.json({ ok: true, data: rows.map(leadRow), pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) } });
});
app.post('/api/leads', requireAuth, async (req, res) => {
  const plan = planOf(req.user);
  const count = (await db.prepare('SELECT COUNT(*) c FROM leads WHERE user_id=?').get(req.user.id)).c;
  if (count >= plan.maxLeads) return res.status(403).json({ ok: false, error: `Your ${plan.name} plan allows ${plan.maxLeads} leads. Upgrade to add more.` });
  const errors = [];
  const clientName = reqStr(req.body?.clientName, 120, 'Client name', errors);
  const email = optStr(req.body?.email, 150, 'Email', errors);
  if (email && !isEmail(email)) errors.push('Enter a valid email address.');
  const budget = numVal(req.body?.budget, 'Budget', errors);
  const status = LEAD_STATUSES.includes(req.body?.status) ? req.body.status : 'New';
  const priority = PRIORITIES.includes(req.body?.priority) ? req.body.priority : 'Medium';
  const source = SOURCES.includes(req.body?.source) ? req.body.source : 'Other';
  const currency = optStr(req.body?.currency, 10, 'Currency', errors) || 'USD';
  if (errors.length) return res.status(400).json({ ok: false, error: errors.join(' ') });
  const id = uid(); const t = now();
  await db.prepare('INSERT INTO leads VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, req.user.id, clientName, email, optStr(req.body?.phone, 40, 'Phone', errors), optStr(req.body?.company, 120, 'Company', errors), optStr(req.body?.service, 150, 'Service', errors), source, budget, currency, status, priority, optStr(req.body?.notes, 2000, 'Notes', errors), req.body?.nextFollowUp ? String(req.body.nextFollowUp).slice(0, 10) : null, t, t);
  res.status(201).json({ ok: true, data: leadRow(await db.prepare('SELECT * FROM leads WHERE id=?').get(id)) });
});
async function ownLead(req, res) {
  const row = await db.prepare('SELECT * FROM leads WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!row) { res.status(404).json({ ok: false, error: 'Lead not found.' }); return null; }
  return row;
}
app.get('/api/leads/:id', requireAuth, async (req, res) => { const r = await ownLead(req, res); if (r) res.json({ ok: true, data: leadRow(r) }); });
app.patch('/api/leads/:id', requireAuth, async (req, res) => {
  const row = await ownLead(req, res); if (!row) return;
  const errors = [];
  const b = req.body || {};
  const clientName = b.clientName !== undefined ? reqStr(b.clientName, 120, 'Client name', errors) : row.client_name;
  const email = b.email !== undefined ? optStr(b.email, 150, 'Email', errors) : row.email;
  if (email && !isEmail(email)) errors.push('Enter a valid email address.');
  const budget = b.budget !== undefined ? numVal(b.budget, 'Budget', errors) : row.budget;
  const status = b.status !== undefined ? (LEAD_STATUSES.includes(b.status) ? b.status : (errors.push('Invalid status.'), row.status)) : row.status;
  const priority = b.priority !== undefined ? (PRIORITIES.includes(b.priority) ? b.priority : (errors.push('Invalid priority.'), row.priority)) : row.priority;
  const source = b.source !== undefined ? (SOURCES.includes(b.source) ? b.source : (errors.push('Invalid source.'), row.source)) : row.source;
  if (errors.length) return res.status(400).json({ ok: false, error: errors.join(' ') });
  await db.prepare('UPDATE leads SET client_name=?, email=?, phone=?, company=?, service=?, source=?, budget=?, currency=?, status=?, priority=?, notes=?, next_follow_up=?, updated_at=? WHERE id=?').run(
    clientName, email, b.phone !== undefined ? optStr(b.phone, 40, 'Phone', errors) : row.phone, b.company !== undefined ? optStr(b.company, 120, 'Company', errors) : row.company, b.service !== undefined ? optStr(b.service, 150, 'Service', errors) : row.service, source, budget, b.currency !== undefined ? (optStr(b.currency, 10, 'Currency', errors) || 'USD') : row.currency, status, priority, b.notes !== undefined ? optStr(b.notes, 2000, 'Notes', errors) : row.notes, b.nextFollowUp !== undefined ? (b.nextFollowUp ? String(b.nextFollowUp).slice(0, 10) : null) : row.next_follow_up, now(), row.id);
  res.json({ ok: true, data: leadRow(await db.prepare('SELECT * FROM leads WHERE id=?').get(row.id)) });
});
app.delete('/api/leads/:id', requireAuth, async (req, res) => { const row = await ownLead(req, res); if (!row) return; await db.prepare('DELETE FROM leads WHERE id=?').run(row.id); res.json({ ok: true }); });

// ---------- follow-ups ----------
app.get('/api/follow-ups', requireAuth, async (req, res) => {
  const filter = (req.query.filter || '').toString(); // today | upcoming | overdue | completed | all
  const today = new Date().toISOString().slice(0, 10);
  let rows = await db.prepare('SELECT f.*, l.client_name AS lead_name FROM follow_ups f LEFT JOIN leads l ON l.id=f.lead_id WHERE f.user_id=? ORDER BY f.due_date ASC').all(req.user.id);
  if (req.query.leadId) rows = rows.filter((r) => r.lead_id === req.query.leadId);
  if (req.query.status) rows = rows.filter((r) => r.status === req.query.status);
  if (filter === 'today') rows = rows.filter((r) => r.due_date === today && r.status !== 'Completed');
  if (filter === 'upcoming') rows = rows.filter((r) => r.due_date > today && r.status !== 'Completed');
  if (filter === 'overdue') rows = rows.filter((r) => r.due_date < today && r.status !== 'Completed');
  if (filter === 'completed') rows = rows.filter((r) => r.status === 'Completed');
  res.json({ ok: true, data: rows.map(fuRow) });
});
app.post('/api/follow-ups', requireAuth, async (req, res) => {
  const errors = [];
  const title = reqStr(req.body?.title, 150, 'Title', errors);
  const dueDate = clean(req.body?.dueDate || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) errors.push('Due date is required (YYYY-MM-DD).');
  let leadId = req.body?.leadId ? String(req.body.leadId) : null;
  if (leadId && !await db.prepare('SELECT id FROM leads WHERE id=? AND user_id=?').get(leadId, req.user.id)) errors.push('Selected lead was not found.');
  if (errors.length) return res.status(400).json({ ok: false, error: errors.join(' ') });
  const id = uid(); const t = now();
  await db.prepare('INSERT INTO follow_ups VALUES (?,?,?,?,?,?,?,?,?,?)').run(id, req.user.id, leadId, title, optStr(req.body?.notes, 2000, 'Notes', errors), dueDate, 'Pending', null, t, t);
  res.status(201).json({ ok: true, data: fuRow(await db.prepare('SELECT f.*, l.client_name AS lead_name FROM follow_ups f LEFT JOIN leads l ON l.id=f.lead_id WHERE f.id=?').get(id)) });
});
async function ownFu(req, res) { const r = await db.prepare('SELECT * FROM follow_ups WHERE id=? AND user_id=?').get(req.params.id, req.user.id); if (!r) res.status(404).json({ ok: false, error: 'Follow-up not found.' }); return r || null; }
app.patch('/api/follow-ups/:id', requireAuth, async (req, res) => {
  const row = await ownFu(req, res); if (!row) return;
  const b = req.body || {}; const errors = [];
  const status = b.status !== undefined ? (['Pending', 'Completed'].includes(b.status) ? b.status : (errors.push('Invalid status.'), row.status)) : row.status;
  const dueDate = b.dueDate !== undefined ? (String(b.dueDate).slice(0, 10)) : row.due_date;
  if (errors.length) return res.status(400).json({ ok: false, error: errors.join(' ') });
  await db.prepare('UPDATE follow_ups SET title=?, notes=?, due_date=?, status=?, completed_at=?, updated_at=? WHERE id=?').run(
    b.title !== undefined ? reqStr(b.title, 150, 'Title', errors) || row.title : row.title, b.notes !== undefined ? optStr(b.notes, 2000, 'Notes', errors) : row.notes, dueDate, status, status === 'Completed' ? (row.completed_at || now()) : null, now(), row.id);
  res.json({ ok: true, data: fuRow(await db.prepare('SELECT f.*, l.client_name AS lead_name FROM follow_ups f LEFT JOIN leads l ON l.id=f.lead_id WHERE f.id=?').get(row.id)) });
});
app.delete('/api/follow-ups/:id', requireAuth, async (req, res) => { const row = await ownFu(req, res); if (!row) return; await db.prepare('DELETE FROM follow_ups WHERE id=?').run(row.id); res.json({ ok: true }); });

// ---------- proposals ----------
function validItems(raw, errors) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 50).map((it) => {
    const desc = optStr(it?.description, 200, 'Item description', errors) || 'Item';
    const qty = Math.max(0, Number(it?.qty) || 0); const price = Math.max(0, Number(it?.price) || 0);
    return { description: desc, qty, price };
  });
}
app.get('/api/proposals', requireAuth, async (req, res) => {
  let rows = await db.prepare('SELECT * FROM proposals WHERE user_id=? ORDER BY created_at DESC').all(req.user.id);
  if (req.query.status) rows = rows.filter((r) => r.status === req.query.status);
  res.json({ ok: true, data: rows.map(proposalRow) });
});
app.post('/api/proposals', requireAuth, async (req, res) => {
  const errors = [];
  const clientName = reqStr(req.body?.clientName, 120, 'Client name', errors);
  const title = reqStr(req.body?.title, 150, 'Project title', errors);
  const items = validItems(req.body?.deliverables, errors);
  const status = ['Draft', 'Sent', 'Accepted', 'Rejected'].includes(req.body?.status) ? req.body.status : 'Draft';
  let leadId = req.body?.leadId ? String(req.body.leadId) : null;
  if (leadId && !await db.prepare('SELECT id FROM leads WHERE id=? AND user_id=?').get(leadId, req.user.id)) leadId = null;
  if (errors.length) return res.status(400).json({ ok: false, error: errors.join(' ') });
  const id = uid(); const t = now();
  await db.prepare('INSERT INTO proposals VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, req.user.id, leadId, clientName, optStr(req.body?.clientCompany, 120, 'Company', errors), title, optStr(req.body?.overview, 3000, 'Overview', errors), optStr(req.body?.scope, 3000, 'Scope', errors), JSON.stringify(items), optStr(req.body?.timeline, 200, 'Timeline', errors), optStr(req.body?.currency, 10, 'Currency', errors) || 'USD', numVal(req.body?.taxRate, 'Tax rate', errors), numVal(req.body?.discount, 'Discount', errors), optStr(req.body?.paymentTerms, 1000, 'Payment terms', errors), optStr(req.body?.notes, 2000, 'Notes', errors), status, t, t);
  res.status(201).json({ ok: true, data: proposalRow(await db.prepare('SELECT * FROM proposals WHERE id=?').get(id)) });
});
async function ownProposal(req, res) { const r = await db.prepare('SELECT * FROM proposals WHERE id=? AND user_id=?').get(req.params.id, req.user.id); if (!r) res.status(404).json({ ok: false, error: 'Proposal not found.' }); return r || null; }
app.get('/api/proposals/:id', requireAuth, async (req, res) => { const r = await ownProposal(req, res); if (r) res.json({ ok: true, data: proposalRow(r) }); });
app.patch('/api/proposals/:id', requireAuth, async (req, res) => {
  const row = await ownProposal(req, res); if (!row) return;
  const b = req.body || {}; const errors = [];
  const items = b.deliverables !== undefined ? validItems(b.deliverables, errors) : JSON.parse(row.deliverables || '[]');
  const status = b.status !== undefined ? (['Draft', 'Sent', 'Accepted', 'Rejected'].includes(b.status) ? b.status : (errors.push('Invalid status.'), row.status)) : row.status;
  if (errors.length) return res.status(400).json({ ok: false, error: errors.join(' ') });
  await db.prepare('UPDATE proposals SET client_name=?, client_company=?, title=?, overview=?, scope=?, deliverables=?, timeline=?, currency=?, tax_rate=?, discount=?, payment_terms=?, notes=?, status=?, updated_at=? WHERE id=?').run(
    b.clientName !== undefined ? reqStr(b.clientName, 120, 'Client name', errors) || row.client_name : row.client_name,
    b.clientCompany !== undefined ? optStr(b.clientCompany, 120, 'Company', errors) : row.client_company,
    b.title !== undefined ? reqStr(b.title, 150, 'Project title', errors) || row.title : row.title,
    b.overview !== undefined ? optStr(b.overview, 3000, 'Overview', errors) : row.overview,
    b.scope !== undefined ? optStr(b.scope, 3000, 'Scope', errors) : row.scope,
    JSON.stringify(items), b.timeline !== undefined ? optStr(b.timeline, 200, 'Timeline', errors) : row.timeline,
    b.currency !== undefined ? (optStr(b.currency, 10, 'Currency', errors) || 'USD') : row.currency,
    b.taxRate !== undefined ? numVal(b.taxRate, 'Tax rate', errors) : row.tax_rate,
    b.discount !== undefined ? numVal(b.discount, 'Discount', errors) : row.discount,
    b.paymentTerms !== undefined ? optStr(b.paymentTerms, 1000, 'Payment terms', errors) : row.payment_terms,
    b.notes !== undefined ? optStr(b.notes, 2000, 'Notes', errors) : row.notes, status, now(), row.id);
  res.json({ ok: true, data: proposalRow(await db.prepare('SELECT * FROM proposals WHERE id=?').get(row.id)) });
});
app.delete('/api/proposals/:id', requireAuth, async (req, res) => { const row = await ownProposal(req, res); if (!row) return; await db.prepare('DELETE FROM proposals WHERE id=?').run(row.id); res.json({ ok: true }); });
app.post('/api/proposals/:id/duplicate', requireAuth, async (req, res) => {
  const row = await ownProposal(req, res); if (!row) return;
  const id = uid(); const t = now();
  await db.prepare('INSERT INTO proposals VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, req.user.id, row.lead_id, row.client_name, row.client_company, `${row.title} (Copy)`, row.overview, row.scope, row.deliverables, row.timeline, row.currency, row.tax_rate, row.discount, row.payment_terms, row.notes, 'Draft', t, t);
  res.status(201).json({ ok: true, data: proposalRow(await db.prepare('SELECT * FROM proposals WHERE id=?').get(id)) });
});

// ---------- templates ----------
app.get('/api/templates', requireAuth, async (req, res) => {
  let rows = await db.prepare('SELECT * FROM message_templates WHERE user_id=? ORDER BY created_at ASC').all(req.user.id);
  const q = (req.query.q || '').toString().trim().toLowerCase();
  if (q) rows = rows.filter((r) => `${r.title} ${r.body}`.toLowerCase().includes(q));
  if (req.query.category) rows = rows.filter((r) => r.category === req.query.category);
  res.json({ ok: true, data: rows.map(tplRow) });
});
app.post('/api/templates', requireAuth, async (req, res) => {
  const errors = []; const title = reqStr(req.body?.title, 120, 'Title', errors); const body = reqStr(req.body?.body, 3000, 'Message', errors);
  if (errors.length) return res.status(400).json({ ok: false, error: errors.join(' ') });
  const id = uid(); const t = now();
  await db.prepare('INSERT INTO message_templates VALUES (?,?,?,?,?,?,?)').run(id, req.user.id, title, optStr(req.body?.category, 60, 'Category', errors) || 'General', body, t, t);
  res.status(201).json({ ok: true, data: tplRow(await db.prepare('SELECT * FROM message_templates WHERE id=?').get(id)) });
});
async function ownTpl(req, res) { const r = await db.prepare('SELECT * FROM message_templates WHERE id=? AND user_id=?').get(req.params.id, req.user.id); if (!r) res.status(404).json({ ok: false, error: 'Template not found.' }); return r || null; }
app.patch('/api/templates/:id', requireAuth, async (req, res) => { const row = await ownTpl(req, res); if (!row) return; const b = req.body || {}; await db.prepare('UPDATE message_templates SET title=?, category=?, body=?, updated_at=? WHERE id=?').run(b.title || row.title, b.category || row.category, b.body || row.body, now(), row.id); res.json({ ok: true, data: tplRow(await db.prepare('SELECT * FROM message_templates WHERE id=?').get(row.id)) }); });
app.delete('/api/templates/:id', requireAuth, async (req, res) => { const row = await ownTpl(req, res); if (!row) return; await db.prepare('DELETE FROM message_templates WHERE id=?').run(row.id); res.json({ ok: true }); });

// ---------- AI ----------
function templateDraft({ outputType, tone, language, businessName, service, budget, inputText, length }) {
  const len = length === 'Short' ? 'Keep it to 2–3 short sentences.' : length === 'Long' ? 'Write a complete, detailed message with clear next steps.' : 'Write a clear message of about one short paragraph.';
  const budgetLine = budget ? ` The budget mentioned is ${budget}.` : '';
  const open = language === 'Roman Urdu' ? `Assalam-o-Alaikum, main ${businessName || 'BizPilot AI'} se baat kar raha hoon.` : language === 'Urdu' ? 'السلام علیکم،' : `Hello, this is ${businessName || 'BizPilot AI'}.`;
  return `${open}\n\n[${outputType} — ${tone} tone, ${language}. ${len}]\n\nThank you for your message about ${service || 'your project'}. ${inputText ? `You mentioned: "${inputText.slice(0, 500)}". ` : ''}I would be happy to help and can share a clear plan and next steps.${budgetLine}\n\nPlease let me know a good time to discuss this further, and I will prepare everything for you.\n\n— Please review and edit this draft before sending. Prices, promises and client facts in AI drafts are not verified.`;
}
async function callOpenAI({ outputType, tone, language, businessName, service, budget, inputText, length }) {
  const maxOut = length === 'Short' ? 180 : length === 'Long' ? 600 : 350;
  const system = 'You are a professional business communication assistant for freelancers and small agencies. Write only the message itself, no explanations. Never invent prices, guarantees, deadlines or client facts that were not provided. Keep it honest and professional.';
  const userMsg = `Task: ${outputType}\nTone: ${tone}\nLanguage: ${language}\nBusiness: ${businessName || '(not provided)'}\nService: ${service || '(not provided)'}${budget ? `\nBudget (if known): ${budget}` : ''}\nLength: ${length} (about ${maxOut} tokens max)\nClient message / requirements:\n${inputText}`;
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({ model: OPENAI_MODEL, messages: [{ role: 'system', content: system }, { role: 'user', content: userMsg }], max_tokens: maxOut, temperature: 0.7 }),
  });
  if (!r.ok) { const t = await r.text().catch(() => ''); throw new Error(`OpenAI request failed (${r.status}). ${t.slice(0, 200)}`); }
  const j = await r.json();
  const text = j?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('OpenAI returned an empty response.');
  return text;
}
app.post('/api/ai/generate', requireAuth, rateLimit('ai', 20, 60 * 1000), async (req, res) => {
  try {
    const b = req.body || {}; const errors = [];
    const inputText = reqStr(b.inputText, 4000, 'Client message or requirements', errors);
    const outputType = OUTPUT_TYPES.includes(b.outputType) ? b.outputType : 'Client reply';
    const tone = TONES.includes(b.tone) ? b.tone : 'Professional';
    const language = LANGUAGES.includes(b.language) ? b.language : 'English';
    const length = LENGTHS.includes(b.length) ? b.length : 'Medium';
    const businessName = optStr(b.businessName, 120, 'Business name', errors) || req.user.business_name;
    const service = optStr(b.service, 150, 'Service', errors);
    const budget = optStr(b.budget, 60, 'Budget', errors);
    if (errors.length) return res.status(400).json({ ok: false, error: errors.join(' ') });
    // Server-side monthly limit — check and record in one synchronous block.
    const plan = planOf(req.user); const mk = monthKey();
    const usage = await db.prepare('SELECT * FROM ai_usage WHERE user_id=? AND month=?').get(req.user.id, mk);
    const used = usage ? usage.count : 0;
    if (used >= plan.maxAiPerMonth) return res.status(403).json({ ok: false, error: `Your ${plan.name} plan allows ${plan.maxAiPerMonth} AI generations per month. You have used ${used}. Upgrade to generate more.` });
    let outputText; let provider = 'template';
    if (OPENAI_API_KEY) { try { outputText = await callOpenAI({ outputType, tone, language, businessName, service, budget, inputText, length }); provider = 'openai'; } catch (e) { return res.status(502).json({ ok: false, error: `AI provider error: ${e.message}. Your usage was not counted. Check OPENAI_API_KEY and try again.` }); } }
    else outputText = templateDraft({ outputType, tone, language, businessName, service, budget, inputText, length });
    const id = uid();
    await db.prepare('INSERT INTO ai_history VALUES (?,?,?,?,?,?,?,?,?)').run(id, req.user.id, outputType, tone, language, inputText, outputText, provider, now());
    if (usage) await db.prepare('UPDATE ai_usage SET count=count+1 WHERE id=?').run(usage.id); else await db.prepare('INSERT INTO ai_usage VALUES (?,?,?,?)').run(uid(), req.user.id, mk, 1);
    res.json({ ok: true, data: { id, outputText, provider, aiConfigured: !!OPENAI_API_KEY, usage: { used: used + 1, limit: plan.maxAiPerMonth, plan: plan.name } }, note: provider === 'template' ? 'OPENAI_API_KEY is not configured, so this is a template draft — not an AI response. Set OPENAI_API_KEY in .env to enable real AI generation.' : 'Review and edit this draft before sending. AI drafts are not verified facts.' });
  } catch (e) { console.error(e); res.status(500).json({ ok: false, error: 'AI generation failed. Please try again.' }); }
});
app.get('/api/ai/history', requireAuth, async (req, res) => {
  let rows = await db.prepare('SELECT * FROM ai_history WHERE user_id=? ORDER BY created_at DESC LIMIT 100').all(req.user.id);
  if (req.query.type) rows = rows.filter((r) => r.output_type === req.query.type);
  res.json({ ok: true, data: rows.map(aiRow) });
});
app.get('/api/ai/usage', requireAuth, async (req, res) => {
  const plan = planOf(req.user); const mk = monthKey();
  const row = await db.prepare('SELECT * FROM ai_usage WHERE user_id=? AND month=?').get(req.user.id, mk);
  res.json({ ok: true, data: { used: row ? row.count : 0, limit: plan.maxAiPerMonth, plan: plan.name, month: mk, aiConfigured: !!OPENAI_API_KEY } });
});

// ---------- analytics ----------
app.get('/api/analytics/overview', requireAuth, async (req, res) => {
  const range = ['7', '30', '90', 'all'].includes(String(req.query.range)) ? String(req.query.range) : '30';
  const leads = await db.prepare('SELECT * FROM leads WHERE user_id=?').all(req.user.id);
  const cutoff = range === 'all' ? null : new Date(Date.now() - Number(range) * 86400000);
  const inRange = leads.filter((l) => !cutoff || new Date(l.created_at) >= cutoff);
  const byStatus = {}; for (const s of LEAD_STATUSES) byStatus[s] = 0; for (const l of inRange) byStatus[l.status] = (byStatus[l.status] || 0) + 1;
  const won = inRange.filter((l) => l.status === 'Won').length;
  const lost = inRange.filter((l) => l.status === 'Lost').length;
  const finalized = won + lost;
  const conversionRate = finalized === 0 ? null : Math.round((won / finalized) * 1000) / 10;
  const pipelineValue = inRange.filter((l) => !['Won', 'Lost'].includes(l.status)).reduce((s, l) => s + Number(l.budget || 0), 0);
  const avgLeadValue = inRange.length ? Math.round((inRange.reduce((s, l) => s + Number(l.budget || 0), 0) / inRange.length) * 100) / 100 : 0;
  const byDate = {};
  for (const l of inRange) { const d = l.created_at.slice(0, 10); byDate[d] = (byDate[d] || 0) + 1; }
  const today = new Date().toISOString().slice(0, 10);
  const fus = await db.prepare('SELECT * FROM follow_ups WHERE user_id=?').all(req.user.id);
  const fuCompleted = fus.filter((f) => f.status === 'Completed').length;
  const fuOverdue = fus.filter((f) => f.status !== 'Completed' && f.due_date < today).length;
  res.json({ ok: true, data: { range, totalLeads: inRange.length, newLeads: inRange.filter((l) => l.status === 'New').length, dealsWon: won, dealsLost: lost, conversionRate, pipelineValue, avgLeadValue, byStatus, byDate, followUpsCompleted: fuCompleted, followUpsOverdue: fuOverdue, note: 'Pipeline value is an estimate of open budgets, not guaranteed revenue. Conversion rate = Won / (Won + Lost) × 100; null when no finalized leads.' } });
});

// ---------- static + SPA fallback ----------
app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ ok: false, error: 'API route not found.' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ ok: false, error: 'Something went wrong. Please try again.' }); });

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args[0] === '--create-user' && args[1] && args[2]) {
    (async () => {
      const email = args[1].toLowerCase(); const name = args[3] || 'BizPilot User';
      if (await db.prepare('SELECT id FROM users WHERE email=?').get(email)) { console.log('User already exists.'); process.exit(0); }
      const id = uid(); const t = now();
      await db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id, name, email, hashPassword(args[2]), '', '', 'English', 'FREE', 0, t, t);
      await seedTemplates(id); console.log(`Created user ${email}`); process.exit(0);
    })();
  } else {
    app.listen(PORT, () => console.log(`BizPilot AI running at http://localhost:${PORT}`));
  }
}
module.exports = { app, db, dbReady, PLANS, templateDraft, proposalRow };
