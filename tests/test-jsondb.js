/* JsonDb persistence test: start server in BLOB_LOCAL_FILE mode, create a
   user + lead, kill it, restart it, and verify the SAME cookie still
   authenticates and the lead is still there. This is the exact failure
   mode of /tmp SQLite on Vercel (account vanishing after signup). */
const { spawn } = require('child_process');
const fs = require('fs'); const path = require('path');
const ROOT = path.join(__dirname, '..'); const FILE = path.join(__dirname, 'test-jsondb.json');
const PORT = 3459; const BASE = `http://localhost:${PORT}`;
try { fs.unlinkSync(FILE); } catch {}
async function start() {
  const srv = spawn('node', ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), BLOB_LOCAL_FILE: FILE, AUTH_SECRET: 'json-test-secret' } });
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { try { up = (await fetch(BASE + '/api/health')).ok; } catch {} if (!up) await new Promise(r => setTimeout(r, 200)); }
  if (!up) throw new Error('server did not start');
  return srv;
}
async function req(p, method = 'GET', body, cookie) {
  const r = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({})); const sc = r.headers.get('set-cookie');
  return { status: r.status, body: j, cookie: sc ? sc.split(';')[0] : null };
}
(async () => {
  let pass = 0, fail = 0; const check = (n, c, e = '') => { if (c) { pass++; console.log('PASS', n); } else { fail++; console.log('FAIL', n, e); } };
  let srv = await start();
  const s = await req('/api/auth/signup', 'POST', { fullName: 'Json User', email: 'json@test.local', password: 'TestPass123!' });
  check('jsondb signup', s.status === 201); const cookie = s.cookie;
  const lead = await req('/api/leads', 'POST', { clientName: 'Json Lead', service: 'Website', budget: 400 }, cookie);
  check('jsondb lead created', lead.status === 201);
  const fp = await req('/api/auth/forgot-password', 'POST', { email: 'json@test.local' });
  check('jsondb forgot-password (fixed placeholder count)', fp.status === 200 && !!fp.body.devResetToken, JSON.stringify(fp.body).slice(0, 200));
  srv.kill(); await new Promise(r => setTimeout(r, 800));
  srv = await start();
  const me = await req('/api/auth/me', 'GET', null, cookie);
  check('jsondb SAME cookie works AFTER RESTART', me.status === 200 && me.body.data.email === 'json@test.local', JSON.stringify(me.body).slice(0, 200));
  const leads = await req('/api/leads', 'GET', null, cookie);
  check('jsondb lead persists AFTER RESTART', leads.body.data.length === 1 && leads.body.data[0].clientName === 'Json Lead', JSON.stringify(leads.body).slice(0, 200));
  srv.kill(); try { fs.unlinkSync(FILE); } catch {}
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
