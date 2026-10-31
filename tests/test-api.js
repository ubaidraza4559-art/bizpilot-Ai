/* BizPilot AI API tests — run with: npm test
   Spins up the server on a temp DB and checks: auth, isolation,
   lead CRUD + filters + plan limits, AI validation + usage limits,
   follow-ups, proposal totals, analytics formulas, template CRUD. */
const { spawn } = require('child_process');
const fs = require('fs'); const path = require('path');
const ROOT = path.join(__dirname, '..'); const DB = path.join(__dirname, 'test-bizpilot.db');
const PORT = 3457; const BASE = `http://localhost:${PORT}`;
try { fs.unlinkSync(DB); } catch {}
let pass = 0, fail = 0;
function check(name, cond, extra = '') { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${extra}`); } }
function run(cmd, args, env = {}) { return new Promise((res, rej) => { const p = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env } }); let out = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => out += d); p.on('close', c => res({ code: c, out })); p.on('error', rej); }); }
async function req(p, method = 'GET', body, cookie) { const r = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' }); const j = await r.json().catch(() => ({})); const sc = r.headers.get('set-cookie'); return { status: r.status, body: j, cookie: sc ? sc.split(';')[0] : null }; }
(async () => {
  const srv = spawn('node', ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), DATABASE_PATH: DB, AUTH_SECRET: 'test-secret-only' } });
  let up = false; for (let i = 0; i < 50 && !up; i++) { try { up = (await fetch(BASE + '/api/health')).ok; } catch {} if (!up) await new Promise(r => setTimeout(r, 200)); }
  check('server health', up);
  try {
    const plans = await req('/api/plans'); check('plans endpoint lists 4 plans', plans.status === 200 && plans.body.data.length === 4);
    check('free plan limits 25 leads / 10 AI', plans.body.data.find(p => p.id === 'FREE').maxLeads === 25 && plans.body.data.find(p => p.id === 'FREE').maxAiPerMonth === 10);
    const unauth = await req('/api/leads'); check('leads blocked without login', unauth.status === 401);
    const badSignup = await req('/api/auth/signup', 'POST', { fullName: '', email: 'bad', password: 'short' }); check('signup validation rejects bad input', badSignup.status === 400);
    const s1 = await req('/api/auth/signup', 'POST', { fullName: 'Test One', email: 'one@test.local', password: 'TestPass123!', businessName: 'One Studio' }); check('signup user 1', s1.status === 201 && s1.body.data.plan === 'FREE'); const c1 = s1.cookie;
    const s2 = await req('/api/auth/signup', 'POST', { fullName: 'Test Two', email: 'two@test.local', password: 'TestPass123!' }); check('signup user 2', s2.status === 201); const c2 = s2.cookie;
    const tpls = await req('/api/templates', 'GET', null, c1); check('7 starter templates seeded', tpls.body.data.length === 7, String(tpls.body.data.length));
    const badLead = await req('/api/leads', 'POST', { clientName: '', email: 'nope', budget: -5 }, c1); check('lead validation rejects bad input', badLead.status === 400);
    const lead = await req('/api/leads', 'POST', { clientName: 'Ayesha Khan', email: 'ayesha@example.com', company: 'Khan Boutique', service: 'Website', source: 'Website', budget: 500, status: 'New', priority: 'High' }, c1); check('lead created', lead.status === 201 && lead.body.data.clientName === 'Ayesha Khan'); const leadId = lead.body.data.id;
    const other = await req('/api/leads/' + leadId, 'GET', null, c2); check('user 2 CANNOT read user 1 lead (isolation)', other.status === 404);
    const otherPatch = await req('/api/leads/' + leadId, 'PATCH', { status: 'Won' }, c2); check('user 2 CANNOT patch user 1 lead', otherPatch.status === 404);
    const filt = await req('/api/leads?q=khan', 'GET', null, c1); check('lead search finds by name', filt.body.data.length === 1);
    const filt2 = await req('/api/leads?status=Won', 'GET', null, c1); check('lead status filter excludes New lead', filt2.body.data.length === 0);
    const patched = await req('/api/leads/' + leadId, 'PATCH', { status: 'Won' }, c1); check('lead status PATCH to Won', patched.body.data.status === 'Won');
    // AI validation + usage (template mode, no key)
    const badAi = await req('/api/ai/generate', 'POST', { inputText: '' }, c1); check('AI validation rejects empty input', badAi.status === 400);
    const ai = await req('/api/ai/generate', 'POST', { inputText: 'Hello, I need a website', outputType: 'Client reply', tone: 'Professional', language: 'English', length: 'Short' }, c1); check('AI template draft returned (no key, labelled)', ai.status === 200 && ai.body.data.provider === 'template' && ai.body.data.outputText.length > 20);
    const usage = await req('/api/ai/usage', 'GET', null, c1); check('AI usage counted = 1', usage.body.data.used === 1);
    const hist = await req('/api/ai/history', 'GET', null, c1); check('AI history saved', hist.body.data.length === 1);
    // Exhaust free AI limit (9 more) then expect 403
    for (let i = 0; i < 9; i++) await req('/api/ai/generate', 'POST', { inputText: 'test ' + i }, c1);
    const over = await req('/api/ai/generate', 'POST', { inputText: 'one too many' }, c1); check('AI free limit enforced (11th = 403)', over.status === 403, String(over.status));
    // Follow-ups
    const fu = await req('/api/follow-ups', 'POST', { title: 'Call Ayesha', leadId, dueDate: '2030-01-15' }, c1); check('follow-up created', fu.status === 201); const fuId = fu.body.data.id;
    const fuDone = await req('/api/follow-ups/' + fuId, 'PATCH', { status: 'Completed' }, c1); check('follow-up marked completed', fuDone.body.data.status === 'Completed' && !!fuDone.body.data.completedAt);
    // Proposals: 2 x 100 + 1 x 50 = 250 subtotal, discount 50, tax 10% = 220 total
    const prop = await req('/api/proposals', 'POST', { clientName: 'Ayesha Khan', title: 'Website Project', deliverables: [{ description: 'Design', qty: 2, price: 100 }, { description: 'Hosting setup', qty: 1, price: 50 }], taxRate: 10, discount: 50 }, c1); check('proposal totals: subtotal 250, total 220', prop.status === 201 && prop.body.data.subtotal === 250 && prop.body.data.total === 220, JSON.stringify(prop.body.data));
    const dup = await req('/api/proposals/' + prop.body.data.id + '/duplicate', 'POST', {}, c1); check('proposal duplicate is Draft copy', dup.status === 201 && dup.body.data.status === 'Draft' && dup.body.data.title.includes('(Copy)'));
    // Analytics: 1 won lead, 0 lost => conversion 100; pipeline excludes Won => 0
    const an = await req('/api/analytics/overview?range=all', 'GET', null, c1); check('analytics conversion 100 with 1 won / 0 lost', an.body.data.conversionRate === 100, JSON.stringify(an.body.data));
    check('analytics pipeline excludes won deals', an.body.data.pipelineValue === 0);
    const an2 = await req('/api/analytics/overview?range=all', 'GET', null, c2); check('analytics empty state: conversion null, not NaN', an2.body.data.conversionRate === null && an2.body.data.totalLeads === 0);
    // Lead limit: user2 has 0 leads; create 25 then 26th must fail — create quickly
    for (let i = 0; i < 25; i++) { const r = await req('/api/leads', 'POST', { clientName: 'Lead ' + i }, c2); if (r.status !== 201) check('lead limit setup', false, String(r.status)); }
    const overLead = await req('/api/leads', 'POST', { clientName: 'Lead 26' }, c2); check('free lead limit enforced (26th = 403)', overLead.status === 403, String(overLead.status));
    // Templates CRUD + delete account isolation
    const tpl = await req('/api/templates', 'POST', { title: 'My template', body: 'Hello {name}' }, c1); check('template created', tpl.status === 201);
    const delTpl = await req('/api/templates/' + tpl.body.data.id, 'DELETE', null, c1); check('template deleted', delTpl.status === 200);
    const delLead = await req('/api/leads/' + leadId, 'DELETE', null, c1); check('lead deleted by owner', delLead.status === 200);
    const logout = await req('/api/auth/logout', 'POST', {}, c1); check('logout works', logout.status === 200);
    const meAfter = await req('/api/auth/me', 'GET', null, c1); check('me blocked after logout', meAfter.status === 401);
    // Unit checks for proposal math via the same formula used by the server
    const { templateDraft } = require('../server.js');
    const draft = templateDraft({ outputType: 'Client reply', tone: 'Professional', language: 'Roman Urdu', businessName: 'Test Studio', service: 'Website', budget: '', inputText: 'Salam', length: 'Short' });
    check('template draft honours Roman Urdu greeting', draft.includes('Assalam-o-Alaikum'));
  } catch (e) { console.log('ERROR', e); fail++; }
  finally { srv.kill(); }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
