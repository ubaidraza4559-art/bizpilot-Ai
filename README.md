# BizPilot AI — Turn Every Enquiry Into an Opportunity

An AI-powered workspace that helps freelancers, digital agencies and small
businesses manage leads, communicate professionally, prepare proposals,
organise follow-ups and track sales performance.

## What is actually built (honest scope)

**Working today, in this repo, with no external account needed:**

- Landing page (hero, problem/solution, 6 features, how it works, pricing,
  FAQ, footer, privacy/terms) — no fake testimonials, logos or user counts.
- Real accounts: email + password signup, login, logout, session cookie,
  password reset, profile editing, account deletion. Passwords are
  scrypt-hashed, never stored in plaintext.
- Leads: full CRUD, search, filter by status/priority/source, sort,
  pagination, status update, overdue indicators, responsive table + mobile cards.
- AI Assistant: tone, language (English / Roman Urdu / Urdu), output type
  and length, editable output, copy, regenerate, history, monthly usage.
- Follow-ups: today / upcoming / overdue / completed, add, edit, reschedule,
  mark completed, linked to a lead.
- Proposals: deliverables editor, server-calculated subtotal/total
  (tax is applied to the discounted subtotal), statuses, duplicate,
  preview, and Print / Save as PDF via the browser print dialog.
- Templates: 7 starter templates on signup, plus create/edit/delete/search/copy
  and "AI variation".
- Analytics: real records only — leads by date/status, won/lost, conversion
  rate = Won / (Won + Lost) × 100 (shown as — when there are no finalized
  leads, never a division by zero), pipeline value (open budgets only,
  labelled as an estimate, not guaranteed revenue), average lead value,
  follow-ups completed/overdue.
- Plan limits enforced on the server: Free 25 leads / 10 AI per month,
  Starter 500 / 200, Pro 5000 / 1000, Agency 20000 / 5000. See `server.js`
  `PLANS` — the single source of truth, served by `GET /api/plans`.
- Ownership enforced on the server: every query is scoped to the logged-in
  user. Changing an ID in a request cannot read or change another user's data
  (covered by tests).

**Not configured yet — and never claimed otherwise:**

- **OpenAI:** if `OPENAI_API_KEY` is missing, AI generation returns a
  clearly labelled *template draft* (`provider: "template"`) and the UI shows
  a banner explaining the key is missing. It never pretends a template is AI.
  Set the key (section 7) for real generation, which is called only from
  the server.
- **Email verification / email sending / WhatsApp / push notifications:**
  no provider is configured. Signup works immediately and the UI says so.
  Follow-ups are in-app reminders. The architecture has integration points
  for these, but they are not claimed as sent.
- **Paid billing:** no payment provider is configured. Upgrade buttons
  explain this and do not charge or change your plan. See section 11.
- **Supabase / Next.js production target:** this runnable build uses
  Node + Express + SQLite (see "Stack note" below). The PostgreSQL schema,
  RLS migration and Prisma schema for the production target are in
  `supabase/migrations/` and `prisma/schema.prisma`, and the API contract
  matches the one in the brief (`/api/leads`, `/api/ai/generate`, etc.).

## Stack note — why Express + SQLite here

The brief asks for Next.js + Supabase + OpenAI. Those need external accounts
(Supabase project, OpenAI key, Vercel) and a build pipeline that is not
available in this workspace, and the brief itself says: *"Use the following
stack unless the environment requires a documented equivalent"* and
*"If a credential or external service is unavailable, implement the correct
integration structure and explain the exact setup steps. Do not fabricate
successful integrations."*

So this repo ships the documented equivalent that actually runs here —
Node 24 + Express + built-in SQLite (`node:sqlite`, no extra DB package) —
with the same routes, validation rules, plan limits and data model as the
production target. Moving to Next.js/Supabase means reusing the schema in
`supabase/` and `prisma/`, swapping the session check for Supabase Auth,
and keeping the frontend API calls unchanged.

## Live deployment (2026-10-30)

**https://bizpilot-ai-ubaid-3bf8.vercel.app/** — Vercel production deployment,
verified live on 2026-10-30: landing loads without a login wall, signup
works, lead creation persists, analytics returns real numbers, AI returns a
labelled template draft (no OpenAI key set), usage 1/10 on Free.

**Important fix on 2026-10-30:** the first Vercel deployment used a SQLite
file in `/tmp`, which is per-instance and unshared on serverless — accounts
could vanish between requests (signup → dashboard error). That deployment
was replaced with a shared persistent backend: `lib/jsondb.js` persisted
as one JSON document in the private Vercel Blob store `bizpilot-ai-db`
(`BLOB_READ_WRITE_TOKEN` is injected by Vercel, never stored in this repo).
Verified live after the fix: a new account + lead were still present
20+ seconds later, with analytics and templates intact. **Consequence:**
accounts created on the old /tmp deployment are gone and must be
re-created on the new persistent deployment — that old data was never
durable, which is exactly why it was replaced.

**Second fix, same day (the real root cause):** the first Blob version
still failed randomly in a real browser. Diagnosis, proved with a
temporary diagnostic endpoint (since removed): the Blob document held
only 1 user while several test accounts had been created, and a save
left the instance's dirty flag set. Cause: `@vercel/blob` `put()` throws
by default when the destination already exists, and our save did not pass
`allowOverwrite: true`. So the first Blob save succeeded and every later
save failed silently, while the API still answered "ok" — new accounts
lived only in the signup instance's memory until it froze, then vanished,
which is why parallel dashboard requests randomly returned 401.
Fix: `allowOverwrite: true` on every Blob save, plus a save that fails
now returns HTTP 500 instead of a false success, plus a per-request reload
of the shared document (a cold instance must never serve stale memory),
plus an Overview that retries once and never blanks the whole dashboard
for one transient API failure. Verified live after this fix: Blob
document grew from 3,796 to 7,844 bytes, 8/8 parallel diagnostic checks
found the session on two different instances, and 25/25 parallel
dashboard requests (me, analytics, leads, follow-ups, AI history × 5
rounds) succeeded with the lead and analytics intact. **Consequence:**
accounts created between the first Blob deployment and this fix were
never actually saved (their saves failed) and must be re-created once
on this fixed deployment; accounts created after this fix persist.
JsonDb limitation: concurrent writes from different instances can
overwrite each other (last save wins); user actions here are sequential,
so this is safe for normal use, but for heavy concurrent use migrate
to the Supabase/PostgreSQL schema in section 4.

**Postgres migration (wired 2026-10-31, awaiting Git-based deploy):** `lib/pgdb.js` is a
Postgres adapter for the same SQL server.js already uses (`?` → `$1`,
`$2`, …; COUNT results converted back to numbers). server.js now uses PgDb
when a connection string is present (checked in this order: `DATABASE_URL`,
`POSTGRES_URL`, `STORAGE_POSTGRES_URL`, `STORAGE_DATABASE_URL`,
`NEON_DATABASE_URL`, then non-pooling variants — Neon via Vercel uses the
`STORAGE_` prefix), otherwise it falls back to JsonDb/Blob, otherwise local
SQLite. All `db.prepare(...).get/all/run` call sites are `await`ed and
`authUser`/`requireAuth`/`seedTemplates`/`ownLead`/`ownProposal`/`ownFu`/`ownTpl`
are async, so the same code works on all three backends. On first Postgres
start, if Postgres users count is 0 and a Blob document is present, Blob data
(users, sessions, password_resets, leads, follow-ups, proposals, templates,
ai_history, ai_usage) is migrated inline in dependency order with
`ON CONFLICT (id) DO NOTHING`; if Postgres init fails, the server falls back
to JsonDb/Blob instead of going down. The standalone
`lib/migrate-blob-to-pg.js` script remains as a manual alternative. Live
database: Neon `neon-charcoal-engine` (Free plan, connected to project
bizpilot-ai in Vercel Storage) — do not claim Postgres is live until a
Git-based deployment with this code is verified live (signup → lead →
logout/login → reload across instances).

`AUTH_SECRET` is set as a sensitive Vercel env var; its value is never
stored in this repo.

## 1. Prerequisites

- Node.js 20+ (tested on Node 24) and npm.
- No database server, no Supabase account and no OpenAI key are needed
  to run the app locally.

## 2. Installation

```bash
cd bizpilot-ai
npm install
```

## 3. Environment setup

```bash
cp .env.example .env
# Edit .env — AUTH_SECRET is the only value you should set for local use.
# OPENAI_API_KEY is optional; without it you get labelled template drafts.
```

`.env.example` contains variable names and placeholders only — no real secrets.

## 4. Supabase project setup (production target only)

1. Create a project at supabase.com.
2. In the SQL Editor, run `supabase/migrations/001_init.sql` — it creates
   `profiles`, `leads`, `follow_ups`, `proposals`, `message_templates`,
   `ai_generation_history`, `ai_usage`, `subscriptions`, `workspaces` and
   `workspace_members`, with UUID keys, indexes and Row Level Security.
3. Enable Email auth in Authentication → Providers.
4. Copy the project URL and anon key into your Next.js `.env.local` as
   `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
   The service-role key must never be exposed to the frontend.

## 5. How to apply database migrations

- **Local (this build):** none needed. SQLite tables are created
  automatically on first start in `data/bizpilot.db`.
- **PostgreSQL / Supabase:** run `supabase/migrations/001_init.sql`
  (see section 4). To reset local data, stop the server and delete
  `data/bizpilot.db`, then restart.

## 6. How to create the first account

Start the server (section 8), open http://localhost:3000/signup, and
register with your email and a password of 8+ characters. You are logged
in immediately. There is no default admin password.

Or from the terminal (no password is stored in the repo):

```bash
node server.js --create-user you@example.com 'YourStrongPassword' "Your Name"
```

## 7. How to configure the OpenAI API

1. Get a key from platform.openai.com.
2. In `.env`, set:
   ```
   OPENAI_API_KEY=sk-...your-key...
   OPENAI_MODEL=gpt-4o-mini
   ```
3. Restart the server. The AI page will then show "OpenAI connected"
   instead of the template-draft banner, and history rows will be marked AI.
4. Only the fields needed for that generation (task, tone, language,
   business, service, budget if given, and your input text) are sent to
   OpenAI — never passwords, payment details or your whole database.
5. If OpenAI fails, you get a clear provider error and your monthly usage
   is not counted.

## 8. How to run locally

```bash
npm start
# → BizPilot AI running at http://localhost:3000
```

Open http://localhost:3000. Sign up, then from the dashboard use
**Load sample data** (sidebar card) to add 4 clearly labelled sample leads
into an empty workspace, or add your own lead with **＋ Add Lead**.
Refreshing a protected page keeps your session (HttpOnly cookie).

## 9. How to run tests

```bash
npm test
# 34 API tests: auth, isolation, lead CRUD/filters, AI validation + limits,
# follow-ups, proposal totals, analytics formulas, free-plan limits, templates.
```

Latest run in this workspace (2026-10-30): **34 passed, 0 failed.**
A live check also verified: landing loads, `/dashboard/leads` serves the
SPA, signup creates a Free account, lead creation persists, and analytics
returns real numbers (1 lead, conversion `null` with no finalized deals).

## 10. How to build for production

This build has no bundler step (plain JS + CSS served by Express), so
there is nothing to compile. For production:

```bash
NODE_ENV=production AUTH_SECRET=<long-random-secret> OPENAI_API_KEY=<key> npm start
```

Set `AUTH_SECRET` to a long random value, serve behind HTTPS, and use a
real `DATABASE_PATH` outside the repo if needed. For the Next.js target,
run `npm run build` in that project instead (see section 11).

## 11. How to deploy to Vercel (production target) / Stripe (billing)

**Vercel + Supabase (target):** deploy the Next.js version, set the
Supabase URL/anon key and `OPENAI_API_KEY` in Vercel environment variables,
run the migration in section 4, and point the domain at the deployment.

**Stripe (billing integration point, not yet active):**
1. Create Stripe products/prices matching the plan prices in `PLANS`.
2. Add `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` to the server env.
3. Add a checkout endpoint that creates a Stripe Checkout Session and a
   webhook endpoint that verifies the signature server-side and only then
   updates `subscriptions` / the user's plan.
4. Until steps 2–3 are done and verified, do not mark any plan as paid —
   the Billing page correctly refuses to pretend otherwise.

**This repo on a plain host (works today):** any host that runs Node
(Railway, Render, a VPS) — `npm install && npm start`, with `PORT`,
`AUTH_SECRET` and `DATABASE_PATH` set in the host's environment.

## 12. Common troubleshooting

| Problem | Fix |
|---|---|
| `AUTH_SECRET not set` warning | Set it in `.env`; sessions then survive restarts. |
| AI shows "template draft" banner | Expected without a key — set `OPENAI_API_KEY` (section 7) and restart. |
| "Too many requests" | Rate limits are per user/IP (login, signup, AI). Wait a minute and retry. |
| 403 on lead / AI creation | You hit your plan limit — check Billing for usage, or upgrade after Stripe is configured. |
| 404 on another user's lead | By design — records are owned per user. Log in as the owner. |
| Port already in use | Run with `PORT=3001 npm start`. |
| Forgot password, no email arrived | No email provider is configured. In non-production, the API returns a local test token — paste it into `/auth/callback?token=…` to reset. In production, configure an email provider first. |

## API reference (all require login except `/api/health` and `/api/plans`)

| Method | Route | Purpose |
|---|---|---|
| GET/PATCH | `/api/profile` | Current profile / update profile |
| GET/POST | `/api/leads` | List (search/filter/sort/page) / create |
| GET/PATCH/DELETE | `/api/leads/[id]` | Read / update / delete one lead |
| POST | `/api/ai/generate` | Generate (server-side OpenAI or labelled template) |
| GET | `/api/ai/history`, `/api/ai/usage` | History / monthly usage |
| GET/POST | `/api/follow-ups` | List (today/upcoming/overdue/completed) / create |
| PATCH/DELETE | `/api/follow-ups/[id]` | Update / delete |
| GET/POST | `/api/proposals` | List / create |
| GET/PATCH/DELETE | `/api/proposals/[id]` | Read / update / delete |
| POST | `/api/proposals/[id]/duplicate` | Duplicate as Draft |
| GET/POST | `/api/templates` | List / create |
| PATCH/DELETE | `/api/templates/[id]` | Update / delete |
| GET | `/api/analytics/overview?range=7\|30\|90\|all` | Real analytics |
| GET | `/api/plans` | Plan configuration |

All responses are `{ ok: true, data }` or `{ ok: false, error }`.
Errors never include secrets, stack traces or other users' data.

## Project structure

```
bizpilot-ai/
  server.js              Express + SQLite API, auth, plans, AI, analytics
  public/
    index.html           Landing + auth + dashboard SPA shell
    app.js               All dashboard logic (leads, AI, proposals, …)
    styles.css           Light theme: #F7F8FC, violet #7565E8, teal #20B8A6
  supabase/migrations/001_init.sql   PostgreSQL + RLS (production target)
  supabase/seed.sql      Synthetic sample data (clearly labelled)
  prisma/schema.prisma   PostgreSQL schema for migration
  tests/test-api.js      34 API tests (npm test)
  .env.example           Variable names only, no secrets
```
