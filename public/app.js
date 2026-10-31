/* BizPilot AI frontend — plain JS SPA, no build step.
   Every action goes through the server API; nothing is stored in
   localStorage except nothing at all (auth is an HttpOnly cookie). */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
let me = null, plans = [], currentApp = 'overview', leadsCache = [], aiLast = '';
let tplCache = {}, aiCache = {};
function useAiHistory(id) { const x = aiCache[id]; if (x) { $('#ai-output').value = x; window.scrollTo(0, 0); } }
function copyTpl(id) { if (tplCache[id]) copyText(tplCache[id]); }
function aiVariationById(id) { if (tplCache[id]) aiVariation(tplCache[id]); }
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n, cur = 'USD') => { try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur, maximumFractionDigits: 0 }).format(Number(n || 0)); } catch { return `${cur} ${Number(n || 0)}`; } };
const todayStr = () => new Date().toISOString().slice(0, 10);
function toast(msg) { const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; $('#toast-wrap').appendChild(t); setTimeout(() => t.remove(), 4500); }
async function api(path, method = 'GET', body) {
  const r = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || j.message || `Request failed (${r.status})`);
  return j;
}
function modal(html, wide = false) { $('#modal-root').innerHTML = `<div class="overlay" onclick="if(event.target===this)closeModal()"><div class="modal ${wide ? 'wide' : ''}"><button class="close" onclick="closeModal()">×</button>${html}</div></div>`; }
function closeModal() { $('#modal-root').innerHTML = ''; }
function showLegal(kind) {
  const texts = {
    privacy: `<h2>Privacy Policy</h2><p>BizPilot AI stores only what you enter: your profile, leads, follow-ups, proposals, templates and AI history. Records are scoped to your account on the server. AI generation sends only the fields needed for that task to the AI provider when configured — never passwords, payment details, or your whole database. You can delete your account from Settings, which deletes your user-owned records. This build has not been independently security-audited; do not store payment-card details or client passwords here.</p>`,
    terms: `<h2>Terms of Service</h2><p>BizPilot AI is provided as-is for managing your own business leads. AI output is a draft: review and edit it before sending, and do not treat AI prices, promises or guarantees as verified. Pricing shown is initial test pricing. Paid subscriptions are only activated after a payment provider is configured and verified server-side. You are responsible for the messages and proposals you send to clients.</p>`,
  };
  modal(texts[kind] + `<p style="margin-top:16px"><button class="btn btn-primary" onclick="closeModal()">Close</button></p>`);
}
// ---------- router ----------
const TITLES = { overview: 'Overview', leads: 'Leads', ai: 'AI Assistant', proposals: 'Proposal Builder', followups: 'Follow-ups', analytics: 'Analytics', templates: 'Message Templates', settings: 'Settings', billing: 'Billing' };
function navigate(path, push = true) { if (push) history.pushState({}, '', path); render(); }
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-nav]'); if (a) { e.preventDefault(); navigate(a.getAttribute('href')); return; }
  const b = e.target.closest('[data-app]'); if (b && $('#view-app') && !$('#view-app').classList.contains('hidden')) { e.preventDefault(); navigate('/dashboard/' + (b.dataset.app === 'overview' ? '' : b.dataset.app)); }
  const l = e.target.closest('[data-legal]'); if (l) showLegal(l.dataset.legal);
});
window.addEventListener('popstate', render);
async function render() {
  const path = location.pathname;
  const hideBoot = () => { const b = document.getElementById('boot-loading'); if (b) b.remove(); };
  $('#view-landing').classList.toggle('hidden', true); $('#view-auth').classList.toggle('hidden', true); $('#view-app').classList.toggle('hidden', true);
  if (path === '/' || path === '/features' || path === '/pricing' || path === '/faq' || path === '/privacy' || path === '/terms') {
    $('#view-landing').classList.remove('hidden'); hideBoot(); loadPricing();
    if (path === '/privacy') showLegal('privacy'); if (path === '/terms') showLegal('terms');
    if (path !== '/') setTimeout(() => { const el = document.querySelector(path === '/features' ? '#features' : path === '/pricing' ? '#pricing' : path === '/faq' ? '#faq' : null); el && el.scrollIntoView(); }, 50);
    return;
  }
  if (['/login', '/signup', '/forgot-password'].includes(path) || path.startsWith('/auth/callback')) {
    // RENDER-FIRST FIX (2026-10-30 evening): the login/signup form
    // must appear IMMEDIATELY, without waiting for the session check.
    // Previously render() hid every view, then awaited /api/auth/me
    // before showing anything — on a slow/cold server that meant a
    // blank white page (or a stuck "Loading…" screen) for up to
    // minutes, even though the form itself needs no server data.
    // Now the form is shown first, and the session check runs in the
    // background only to auto-redirect an already-logged-in user.
    $('#view-auth').classList.remove('hidden');
    ['login', 'signup', 'forgot', 'reset'].forEach(k => $('#auth-' + k).classList.add('hidden'));
    const view = path === '/signup' ? 'signup' : path === '/forgot-password' ? 'forgot' : path.startsWith('/auth/callback') ? 'reset' : 'login';
    $('#auth-' + view).classList.remove('hidden'); hideBoot();
    api('/api/auth/me').then(r => { me = r.data; if (location.pathname === path) navigate('/dashboard', false); }).catch(() => {});
    return;
  }
  // Protected app: show the app shell with a loading skeleton FIRST,
  // so the page is never blank white while the session check runs.
  // Only redirect to /login if the check actually fails.
  $('#view-app').classList.remove('hidden'); hideBoot();
  const seg0 = path.replace('/dashboard', '').replace(/^\//, '').split('/')[0];
  const app0 = TITLES[seg0] ? seg0 : 'overview';
  ['overview', 'leads', 'ai', 'proposals', 'followups', 'analytics', 'templates', 'settings', 'billing'].forEach(k => $('#app-' + k).classList.add('hidden'));
  $('#app-' + app0).classList.remove('hidden');
  $('#app-' + app0).innerHTML = '<div class="skeleton" style="height:120px"></div><div class="skeleton" style="height:200px;margin-top:14px"></div>';
  $('#page-title').textContent = TITLES[app0];
  try { me = (await api('/api/auth/me')).data; } catch { navigate('/login', false); return; }
  const seg = path.replace('/dashboard', '').replace(/^\//, '').split('/')[0];
  currentApp = TITLES[seg] ? seg : 'overview';
  $$('#side-nav button').forEach(b => b.classList.toggle('active', b.dataset.app === currentApp));
  $('#page-title').textContent = TITLES[currentApp];
  $('#profile-name').textContent = me.fullName.split(' ')[0] || 'Account';
  $('#workspace-label').textContent = 'Workspace: ' + (me.businessName || me.fullName);
  ['overview', 'leads', 'ai', 'proposals', 'followups', 'analytics', 'templates', 'settings', 'billing'].forEach(k => $('#app-' + k).classList.add('hidden'));
  $('#app-' + currentApp).classList.remove('hidden');
  if (currentApp === 'overview') loadOverview(); if (currentApp === 'leads') loadLeads(); if (currentApp === 'ai') loadAI(); if (currentApp === 'proposals') loadProposals(); if (currentApp === 'followups') loadFollowups(); if (currentApp === 'analytics') loadAnalytics(); if (currentApp === 'templates') loadTemplates(); if (currentApp === 'settings') loadSettings(); if (currentApp === 'billing') loadBilling();
  loadBell();
}
async function loadPricing() {
  try { plans = (await api('/api/plans')).data; } catch { return; }
  $('#pricing-cards').innerHTML = plans.map(p => `<div class="card" style="${p.id === 'PRO' ? 'border-color:var(--violet);box-shadow:0 8px 30px rgba(117,101,232,.15)' : ''}"><h3>${p.name}</h3><div class="price">$${p.price}<small>/month</small></div>${p.id === 'PRO' ? '<span class="badge">Most popular</span>' : ''}<ul style="color:var(--muted);padding-left:18px">${p.features.map(f => `<li>${esc(f)}</li>`).join('')}<li>${p.maxLeads.toLocaleString()} leads</li><li>${p.maxAiPerMonth} AI generations / month</li></ul><br><a class="btn ${p.id === 'PRO' ? 'btn-primary' : ''}" style="width:100%" href="/signup" data-nav>${p.id === 'FREE' ? 'Start Free' : 'Choose ' + p.name}</a></div>`).join('');
}
$('#demo-btn').addEventListener('click', () => modal(`<h2>Try the demo</h2><p>This is a live product, not a video. Create a free account and, from the dashboard, use <b>Load sample data</b> to add 4 clearly labelled sample leads. You can edit or delete them any time.</p><p><a class="btn btn-primary" href="/signup" data-nav>Create a free account</a> <button class="btn" onclick="closeModal()">Close</button></p>`));
// ---------- auth forms ----------
$('#login-form').addEventListener('submit', async (e) => { e.preventDefault(); const f = new FormData(e.target); try { await api('/api/auth/login', 'POST', { email: f.get('email'), password: f.get('password') }); toast('Welcome back!'); navigate('/dashboard'); } catch (err) { const el = $('#login-err'); el.textContent = err.message; el.classList.remove('hidden'); } });
$('#signup-form').addEventListener('submit', async (e) => { e.preventDefault(); const f = new FormData(e.target); try { const r = await api('/api/auth/signup', 'POST', { fullName: f.get('fullName'), email: f.get('email'), password: f.get('password'), businessName: f.get('businessName'), businessType: f.get('businessType') }); if (r.note) { const n = $('#signup-note'); n.textContent = r.note; n.classList.remove('hidden'); } toast('Account created — welcome to BizPilot AI!'); navigate('/dashboard'); } catch (err) { const el = $('#signup-err'); el.textContent = err.message; el.classList.remove('hidden'); } });
$('#forgot-form').addEventListener('submit', async (e) => { e.preventDefault(); const f = new FormData(e.target); try { const r = await api('/api/auth/forgot-password', 'POST', { email: f.get('email') }); const el = $('#forgot-msg'); el.textContent = r.message + (r.devResetToken ? ` Local test token: ${r.devResetToken} — paste it into /auth/callback?token=${r.devResetToken}` : ''); el.classList.remove('hidden'); } catch (err) { const el = $('#forgot-err'); el.textContent = err.message; el.classList.remove('hidden'); } });
$('#reset-form').addEventListener('submit', async (e) => { e.preventDefault(); const token = new URLSearchParams(location.search).get('token') || ''; const f = new FormData(e.target); try { const r = await api('/api/auth/reset-password', 'POST', { token, password: f.get('password') }); $('#reset-msg').textContent = r.message; $('#reset-msg').classList.remove('hidden'); setTimeout(() => navigate('/login'), 1200); } catch (err) { const el = $('#reset-err'); el.textContent = err.message; el.classList.remove('hidden'); } });
$('#logout-btn').addEventListener('click', async () => { try { await api('/api/auth/logout', 'POST', {}); } catch {} me = null; navigate('/login'); });
$('#profile-btn').addEventListener('click', () => $('#profile-menu').classList.toggle('hidden'));
document.addEventListener('click', (e) => { if (!e.target.closest('.profile-menu')) $('#profile-menu').classList.add('hidden'); });
$('#menu-btn').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
$('#top-search').addEventListener('keydown', (e) => { if (e.key === 'Enter') { const q = e.target.value; navigate('/dashboard/leads'); setTimeout(() => { const s = $('#lead-search'); if (s) { s.value = q; loadLeads(); } }, 100); } });
$('#demo-seed-btn').addEventListener('click', async () => { try { const r = await api('/api/demo/seed', 'POST', {}); toast(r.message); loadOverview(); } catch (err) { toast(err.message); } });
async function loadBell() { try { const fus = (await api('/api/follow-ups?filter=overdue')).data; const n = fus.length; $('#bell-count').textContent = n ? `(${n} overdue)` : ''; } catch {} }
$('#bell-btn').addEventListener('click', () => navigate('/dashboard/followups'));
// ---------- overview ----------
async function loadOverview() {
  const el = $('#app-overview'); el.innerHTML = '<div class="skeleton" style="height:120px"></div><div class="skeleton" style="height:200px;margin-top:14px"></div>';
  // Resilient load: the dashboard fires several API calls in parallel.
  // If ONE of them fails transiently (cold instance, brief network
  // hiccup), the whole Overview used to show "Please log in to
  // continue." and nothing else. Now we retry once, then render what
  // we have and show a small retry note for the failed part only —
  // a transient failure must never blank the entire dashboard.
  const loadAll = async () => {
    const r = await Promise.allSettled([api('/api/analytics/overview?range=all'), api('/api/leads?limit=5'), api('/api/follow-ups?filter=today'), api('/api/ai/history')]);
    return r;
  };
  let results = await loadAll();
  if (results.some(r => r.status === 'rejected')) {
    await new Promise(r => setTimeout(r, 800));
    const retry = await loadAll();
    results = results.map((r, i) => r.status === 'fulfilled' ? r : retry[i]);
  }
  try {
    const failed = results.filter(r => r.status === 'rejected');
    if (failed.length && results[0].status === 'rejected') {
      // Analytics is the core of Overview; if even the retry failed,
      // say so plainly and offer a retry, instead of a login error
      // for a session that /api/auth/me already proved valid.
      const msg = failed[0].reason && failed[0].reason.message ? failed[0].reason.message : 'Could not load overview.';
      el.innerHTML = `<div class="error">${esc(msg)}</div><p><button class="btn btn-primary" onclick="loadOverview()">Retry loading Overview</button></p>`;
      return;
    }
    const a = results[0].status === 'fulfilled' ? results[0].value : { data: { totalLeads: 0, newLeads: 0, dealsWon: 0, dealsLost: 0, conversionRate: null, pipelineValue: 0, avgLeadValue: 0, byStatus: {}, byDate: {}, followUpsOverdue: 0, followUpsCompleted: 0 } };
    const leads = results[1].status === 'fulfilled' ? results[1].value : { data: [] };
    const fus = results[2].status === 'fulfilled' ? results[2].value : { data: [] };
    const ai = results[3].status === 'fulfilled' ? results[3].value : { data: [] };
    const d = a.data;
    if (d.totalLeads === 0) { el.innerHTML = `<div class="empty card"><b>Your workspace is ready 🌱</b><p>No leads yet — that's normal for a new account. Add your first lead and your real metrics will appear here.</p><br><button class="btn btn-primary" onclick="openLeadForm()">Add your first lead</button> <button class="btn" onclick="document.getElementById('demo-seed-btn').click()">Load sample data</button></div>`; return; }
    const statusDonut = Object.entries(d.byStatus).filter(([, v]) => v > 0);
    const dates = Object.entries(d.byDate).sort().slice(-14);
    const maxD = Math.max(1, ...dates.map(([, v]) => v));
    el.innerHTML = `<div class="metrics">
      <div class="card metric"><span>Total leads</span><b>${d.totalLeads}</b></div>
      <div class="card metric"><span>New leads</span><b>${d.newLeads}</b></div>
      <div class="card metric"><span>Follow-ups overdue</span><b style="color:var(--err)">${d.followUpsOverdue}</b></div>
      <div class="card metric"><span>Deals won</span><b style="color:var(--success)">${d.dealsWon}</b></div>
      <div class="card metric"><span>Conversion rate</span><b>${d.conversionRate === null ? '— (no finalized deals yet)' : d.conversionRate + '%'}</b></div>
      <div class="card metric"><span>Estimated pipeline value</span><b>${fmt(d.pipelineValue)}</b><span>Estimate only — not guaranteed revenue.</span></div></div>
    <div class="grid2"><div class="card"><h3>Leads over time</h3>${dates.length ? dates.map(([dt, v]) => `<div class="bar-row"><span style="width:90px">${dt}</span><span class="bar" style="width:${Math.round(v / maxD * 100)}%"></span>${v}</div>`).join('') : '<p style="color:var(--muted)">No data in this range.</p>'}</div>
    <div class="card"><h3>Deal status</h3>${statusDonut.map(([s, v]) => `<div class="bar-row"><span style="width:120px">${esc(s)}</span><span class="bar" style="width:${Math.round(v / Math.max(1, d.totalLeads) * 100)}%;background:var(--teal)"></span>${v}</div>`).join('')}</div></div>
    <div class="grid2" style="margin-top:16px"><div class="card"><h3>Recent leads</h3>${leads.data.length ? leads.data.map(l => `<p><b>${esc(l.clientName)}</b> <span class="badge">${esc(l.status)}</span><br><span style="color:var(--muted);font-size:13px">${esc(l.service || '—')} · ${fmt(l.budget, l.currency)}</span></p>`).join('') : '<p style="color:var(--muted)">No leads yet.</p>'}<button class="btn btn-sm" onclick="navigate('/dashboard/leads')">View all leads</button></div>
    <div class="card"><h3>Today's follow-ups</h3>${fus.data.length ? fus.data.map(f => `<p><b>${esc(f.title)}</b><br><span style="color:var(--muted);font-size:13px">${esc(f.leadName || 'No lead linked')} · due ${esc(f.dueDate)}</span></p>`).join('') : '<p style="color:var(--muted)">Nothing due today. 🎉</p>'}
    <h3 style="margin-top:18px">Recent AI content</h3>${ai.data.slice(0, 3).map(h => `<p><span class="badge">${esc(h.outputType)}</span> <span style="color:var(--muted);font-size:13px">${h.provider === 'openai' ? 'AI' : 'Template draft'}</span><br>${esc(h.outputText.slice(0, 120))}…</p>`).join('') || '<p style="color:var(--muted)">No AI content yet.</p>'}</div></div>
    <div class="card" style="margin-top:16px"><h3>Quick actions</h3><div style="display:flex;gap:10px;flex-wrap:wrap"><button class="btn btn-primary" onclick="openLeadForm()">＋ Add Lead</button><button class="btn" onclick="navigate('/dashboard/ai')">✦ Generate Reply</button><button class="btn" onclick="openProposalForm()">📄 Create Proposal</button></div></div>`;
  } catch (err) { el.innerHTML = `<div class="error">${esc(err.message)}</div>`; }
}
// ---------- leads ----------
function statusBadge(s) { const m = { Won: 'green', Lost: 'red', New: '', Qualified: 'green', 'Proposal Sent': 'amber', Negotiation: 'amber', Contacted: 'grey' }; return `<span class="badge ${m[s] || ''}">${esc(s)}</span>`; }
async function loadLeads() {
  const el = $('#app-leads');
  el.innerHTML = `<div class="toolbar"><input id="lead-search" placeholder="Search name, company, email, service…" style="flex:1;min-width:200px">
  <select id="lead-status"><option value="">All statuses</option>${['New', 'Contacted', 'Qualified', 'Proposal Sent', 'Negotiation', 'Won', 'Lost'].map(s => `<option>${s}</option>`).join('')}</select>
  <select id="lead-priority"><option value="">All priorities</option><option>Low</option><option>Medium</option><option>High</option></select>
  <select id="lead-sort"><option value="created_at">Newest first</option><option value="client_name">Name A–Z</option><option value="budget">Highest budget</option></select>
  <button class="btn btn-primary" onclick="openLeadForm()">＋ Add Lead</button></div><div id="lead-results"><div class="skeleton" style="height:160px"></div></div>`;
  const run = async () => {
    const q = encodeURIComponent($('#lead-search').value); const st = $('#lead-status').value; const pr = $('#lead-priority').value; const so = $('#lead-sort').value;
    try {
      const r = await api(`/api/leads?q=${q}&status=${st}&priority=${pr}&sort=${so}&limit=50`); leadsCache = r.data;
      const res = $('#lead-results');
      if (!r.data.length) { res.innerHTML = `<div class="empty card"><b>No leads match</b><p>Try a different search or filter, or add your first lead.</p><button class="btn btn-primary" onclick="openLeadForm()">Add lead</button></div>`; return; }
      const rows = r.data.map(l => `<tr><td><b>${esc(l.clientName)}</b><br><span style="color:var(--muted)">${esc(l.company || '—')}</span></td><td>${esc(l.service || '—')}</td><td>${fmt(l.budget, l.currency)}</td><td>${statusBadge(l.status)}</td><td>${esc(l.priority)}</td><td>${l.nextFollowUp ? (l.nextFollowUp < todayStr() && !['Won', 'Lost'].includes(l.status) ? `<span style="color:var(--err);font-weight:700">Overdue ${esc(l.nextFollowUp)}</span>` : esc(l.nextFollowUp)) : '—'}</td><td><button class="btn btn-sm" onclick="openLeadDetail('${l.id}')">View</button> <button class="btn btn-sm" onclick="openLeadForm('${l.id}')">Edit</button> <button class="btn btn-sm btn-danger" onclick="deleteLead('${l.id}')">Delete</button></td></tr>`).join('');
      res.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Client</th><th>Service</th><th>Budget</th><th>Status</th><th>Priority</th><th>Follow-up</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table>
      <div class="mobile-cards">${r.data.map(l => `<div class="lead-card"><b>${esc(l.clientName)}</b> ${statusBadge(l.status)}<p style="color:var(--muted);margin:6px 0">${esc(l.service || '—')} · ${fmt(l.budget, l.currency)} · ${esc(l.priority)}</p><button class="btn btn-sm" onclick="openLeadDetail('${l.id}')">View</button> <button class="btn btn-sm" onclick="openLeadForm('${l.id}')">Edit</button> <button class="btn btn-sm btn-danger" onclick="deleteLead('${l.id}')">Delete</button></div>`).join('')}</div></div><p style="color:var(--muted);font-size:13px;margin-top:10px">${r.pagination.total} lead(s) · page ${r.pagination.page} of ${r.pagination.pages}</p>`;
    } catch (err) { $('#lead-results').innerHTML = `<div class="error">${esc(err.message)}</div>`; }
  };
  $('#lead-search').addEventListener('input', () => { clearTimeout(window._ls); window._ls = setTimeout(run, 300); });
  $('#lead-status').addEventListener('change', run); $('#lead-priority').addEventListener('change', run); $('#lead-sort').addEventListener('change', run);
  run();
}
function leadFormHTML(l = {}) { return `<h2>${l.id ? 'Edit lead' : 'Add lead'}</h2><p style="color:var(--muted)">* Required. Budget must be a number.</p><div id="lf-err" class="error hidden"></div>
<form id="lead-form"><div class="grid2"><div class="field"><label>Client name *</label><input name="clientName" value="${esc(l.clientName || '')}" required></div><div class="field"><label>Email</label><input name="email" type="email" value="${esc(l.email || '')}"></div><div class="field"><label>Phone</label><input name="phone" value="${esc(l.phone || '')}"></div><div class="field"><label>Company</label><input name="company" value="${esc(l.company || '')}"></div><div class="field"><label>Service requested</label><input name="service" value="${esc(l.service || '')}"></div><div class="field"><label>Lead source</label><select name="source">${['Website', 'Referral', 'Social Media', 'WhatsApp', 'Phone', 'Walk-in', 'Other'].map(s => `<option ${s === l.source ? 'selected' : ''}>${s}</option>`).join('')}</select></div><div class="field"><label>Budget</label><input name="budget" type="number" min="0" step="0.01" value="${l.budget ?? ''}"></div><div class="field"><label>Currency</label><input name="currency" value="${esc(l.currency || 'USD')}"></div><div class="field"><label>Status</label><select name="status">${['New', 'Contacted', 'Qualified', 'Proposal Sent', 'Negotiation', 'Won', 'Lost'].map(s => `<option ${s === l.status ? 'selected' : ''}>${s}</option>`).join('')}</select></div><div class="field"><label>Priority</label><select name="priority">${['Low', 'Medium', 'High'].map(s => `<option ${s === l.priority ? 'selected' : ''}>${s}</option>`).join('')}</select></div><div class="field"><label>Next follow-up date</label><input name="nextFollowUp" type="date" value="${esc(l.nextFollowUp || '')}"></div></div><div class="field"><label>Notes</label><textarea name="notes">${esc(l.notes || '')}</textarea></div><button class="btn btn-primary">${l.id ? 'Save changes' : 'Add lead'}</button> <button type="button" class="btn" onclick="closeModal()">Cancel</button></form>`; }
async function openLeadForm(id) {
  let l = {}; if (id) { try { l = (await api('/api/leads/' + id)).data; } catch (e) { toast(e.message); return; } }
  modal(leadFormHTML(l));
  $('#lead-form').addEventListener('submit', async (e) => { e.preventDefault(); const f = new FormData(e.target); const body = { clientName: f.get('clientName'), email: f.get('email'), phone: f.get('phone'), company: f.get('company'), service: f.get('service'), source: f.get('source'), budget: f.get('budget'), currency: f.get('currency'), status: f.get('status'), priority: f.get('priority'), nextFollowUp: f.get('nextFollowUp') || null, notes: f.get('notes') }; try { if (l.id) await api('/api/leads/' + l.id, 'PATCH', body); else await api('/api/leads', 'POST', body); closeModal(); toast(l.id ? 'Lead updated.' : 'Lead added.'); loadLeads(); if (currentApp === 'overview') loadOverview(); } catch (err) { const el = $('#lf-err'); el.textContent = err.message; el.classList.remove('hidden'); } });
}
async function openLeadDetail(id) { try { const l = (await api('/api/leads/' + id)).data; modal(`<h2>${esc(l.clientName)}</h2><p style="color:var(--muted)">${esc(l.company || '')} · ${esc(l.service || '')}</p><p><b>Email:</b> ${esc(l.email || '—')}<br><b>Phone:</b> ${esc(l.phone || '—')}<br><b>Source:</b> ${esc(l.source)}<br><b>Budget:</b> ${fmt(l.budget, l.currency)}<br><b>Status:</b> ${statusBadge(l.status)}<br><b>Priority:</b> ${esc(l.priority)}<br><b>Next follow-up:</b> ${esc(l.nextFollowUp || '—')}<br><b>Notes:</b><br>${esc(l.notes || '—')}</p><p><button class="btn btn-primary" onclick="closeModal();openLeadForm('${l.id}')">Edit</button> <button class="btn" onclick="closeModal();openFollowupForm('${l.id}')">Add follow-up</button> <button class="btn" onclick="closeModal()">Close</button></p>`); } catch (e) { toast(e.message); } }
async function deleteLead(id) { if (!confirm('Delete this lead? Its follow-ups will be unlinked. This cannot be undone.')) return; try { await api('/api/leads/' + id, 'DELETE'); toast('Lead deleted.'); loadLeads(); } catch (e) { toast(e.message); } }
// ---------- AI ----------
function loadAI(prefill) {
  $('#app-ai').innerHTML = `<div class="card"><h2 style="margin-top:0">AI Assistant</h2><p style="color:var(--muted)">Write a message, choose the tone and language, and review the draft before you send it. AI drafts are not verified facts — check prices and promises before sending.</p><div id="ai-banner" class="note hidden"></div><div id="ai-err" class="error hidden"></div>
  <div class="grid2"><div class="field"><label>Output type</label><select id="ai-type">${['Client reply', 'First-contact message', 'Follow-up message', 'Requirement questions', 'Proposal draft', 'Quotation description', 'Negotiation response', 'Project completion message'].map(s => `<option>${s}</option>`).join('')}</select></div><div class="field"><label>Tone</label><select id="ai-tone">${['Professional', 'Friendly', 'Persuasive', 'Formal', 'Concise'].map(s => `<option>${s}</option>`).join('')}</select></div><div class="field"><label>Language</label><select id="ai-lang"><option>English</option><option>Roman Urdu</option><option>Urdu</option></select></div><div class="field"><label>Length</label><select id="ai-len"><option>Short</option><option selected>Medium</option><option>Long</option></select></div><div class="field"><label>Business name</label><input id="ai-biz" value="${esc(me.businessName || '')}"></div><div class="field"><label>Service offered</label><input id="ai-service"></div><div class="field"><label>Budget (if known)</label><input id="ai-budget"></div></div>
  <div class="field"><label>Client message or project requirements *</label><textarea id="ai-input" placeholder="Paste the client's message or describe the project…">${esc(prefill || '')}</textarea></div>
  <button class="btn btn-primary" id="ai-generate">✦ Generate</button> <span id="ai-usage" style="color:var(--muted);font-size:13px"></span>
  <div class="field" style="margin-top:18px"><label>Generated output — edit before sending</label><textarea id="ai-output" style="min-height:180px" placeholder="Your generated draft will appear here…"></textarea></div>
  <div style="display:flex;gap:10px;flex-wrap:wrap"><button class="btn" id="ai-copy">Copy</button><button class="btn" id="ai-regen">Regenerate</button><button class="btn" id="ai-use-lead">Use in a lead (as note)</button></div></div>
  <div class="card" style="margin-top:16px"><h3>History</h3><div id="ai-history"></div></div>`;
  const refreshUsage = async () => { try { const u = (await api('/api/ai/usage')).data; $('#ai-usage').textContent = `${u.used} / ${u.limit} this month (${u.plan}) · ${u.aiConfigured ? 'OpenAI connected' : 'OpenAI key not set — template drafts only'}`; if (!u.aiConfigured) { const b = $('#ai-banner'); b.textContent = 'OPENAI_API_KEY is not configured. You will get a clearly labelled template draft. To enable real AI, add OPENAI_API_KEY to your .env file and restart the server (see README).'; b.classList.remove('hidden'); } } catch {} };
  const refreshHistory = async () => { try { const h = (await api('/api/ai/history')).data; h.forEach(x => aiCache[x.id] = x.outputText); $('#ai-history').innerHTML = h.length ? h.slice(0, 20).map(x => `<p><span class="badge">${esc(x.outputType)}</span> <span style="color:var(--muted);font-size:13px">${x.provider === 'openai' ? 'AI' : 'Template draft'} · ${esc(x.tone)} · ${esc(x.language)}</span><br>${esc(x.outputText.slice(0, 200))}… <button class="btn btn-sm" onclick="useAiHistory('${x.id}')">Use this</button></p>`).join('') : '<p style="color:var(--muted)">No history yet.</p>'; } catch {} };
  const gen = async () => { const btn = $('#ai-generate'); btn.disabled = true; btn.textContent = 'Generating…'; try { const r = await api('/api/ai/generate', 'POST', { inputText: $('#ai-input').value, outputType: $('#ai-type').value, tone: $('#ai-tone').value, language: $('#ai-lang').value, length: $('#ai-len').value, businessName: $('#ai-biz').value, service: $('#ai-service').value, budget: $('#ai-budget').value }); $('#ai-output').value = r.data.outputText; aiLast = r.data.outputText; if (r.note) toast(r.note); refreshUsage(); refreshHistory(); } catch (err) { const el = $('#ai-err'); el.textContent = err.message; el.classList.remove('hidden'); } finally { btn.disabled = false; btn.textContent = '✦ Generate'; } };
  $('#ai-generate').addEventListener('click', gen); $('#ai-regen').addEventListener('click', gen);
  $('#ai-copy').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('#ai-output').value); toast('Copied.'); } catch { toast('Select the text and copy it manually.'); } });
  $('#ai-use-lead').addEventListener('click', () => { closeModal(); openLeadForm(); setTimeout(() => { const ta = document.querySelector('#lead-form textarea[name="notes"]'); if (ta) ta.value = $('#ai-output').value; }, 100); });
  refreshUsage(); refreshHistory();
}
// ---------- proposals ----------
async function loadProposals() {
  const el = $('#app-proposals');
  el.innerHTML = `<div class="toolbar"><button class="btn btn-primary" onclick="openProposalForm()">＋ New Proposal</button><span style="color:var(--muted);font-size:13px">Totals are calculated on the server. Print / Save as PDF uses your browser's print dialog.</span></div><div id="prop-list"><div class="skeleton" style="height:160px"></div></div>`;
  try {
    const r = (await api('/api/proposals')).data;
    if (!r.length) { $('#prop-list').innerHTML = `<div class="empty card"><b>No proposals yet</b><p>Create a proposal, or generate a draft from the AI Assistant first.</p><button class="btn btn-primary" onclick="openProposalForm()">Create proposal</button></div>`; return; }
    $('#prop-list').innerHTML = `<div class="table-wrap"><table><thead><tr><th>Title</th><th>Client</th><th>Total</th><th>Status</th><th>Actions</th></tr></thead><tbody>${r.map(p => `<tr><td><b>${esc(p.title)}</b></td><td>${esc(p.clientName)}<br><span style="color:var(--muted)">${esc(p.clientCompany || '')}</span></td><td>${fmt(p.total, p.currency)}</td><td>${statusBadge(p.status)}</td><td><button class="btn btn-sm" onclick="openProposalView('${p.id}')">Preview</button> <button class="btn btn-sm" onclick="openProposalForm('${p.id}')">Edit</button> <button class="btn btn-sm" onclick="duplicateProposal('${p.id}')">Duplicate</button> <button class="btn btn-sm btn-danger" onclick="deleteProposal('${p.id}')">Delete</button></td></tr>`).join('')}</tbody></table><div class="mobile-cards">${r.map(p => `<div class="lead-card"><b>${esc(p.title)}</b> ${statusBadge(p.status)}<p style="color:var(--muted)">${esc(p.clientName)} · ${fmt(p.total, p.currency)}</p><button class="btn btn-sm" onclick="openProposalView('${p.id}')">Preview</button> <button class="btn btn-sm" onclick="openProposalForm('${p.id}')">Edit</button></div>`).join('')}</div></div>`;
  } catch (e) { $('#prop-list').innerHTML = `<div class="error">${esc(e.message)}</div>`; }
}
function proposalFormHTML(p = {}) {
  const items = p.deliverables && p.deliverables.length ? p.deliverables : [{ description: '', qty: 1, price: 0 }];
  return `<h2>${p.id ? 'Edit proposal' : 'New proposal'}</h2><div id="pf-err" class="error hidden"></div><form id="proposal-form">
  <div class="grid2"><div class="field"><label>Client name *</label><input name="clientName" value="${esc(p.clientName || '')}" required></div><div class="field"><label>Client company</label><input name="clientCompany" value="${esc(p.clientCompany || '')}"></div><div class="field"><label>Project title *</label><input name="title" value="${esc(p.title || '')}" required></div><div class="field"><label>Timeline</label><input name="timeline" value="${esc(p.timeline || '')}" placeholder="e.g. 2 weeks"></div><div class="field"><label>Currency</label><input name="currency" value="${esc(p.currency || 'USD')}"></div><div class="field"><label>Status</label><select name="status">${['Draft', 'Sent', 'Accepted', 'Rejected'].map(s => `<option ${s === p.status ? 'selected' : ''}>${s}</option>`).join('')}</select></div></div>
  <div class="field"><label>Project overview</label><textarea name="overview">${esc(p.overview || '')}</textarea></div>
  <div class="field"><label>Scope of work</label><textarea name="scope">${esc(p.scope || '')}</textarea></div>
  <h3>Deliverables / pricing</h3><div id="prop-items">${items.map((it, i) => `<div class="grid3" data-item><div class="field"><label>Description</label><input name="desc" value="${esc(it.description)}"></div><div class="field"><label>Qty</label><input name="qty" type="number" min="0" step="1" value="${it.qty}"></div><div class="field"><label>Price</label><input name="price" type="number" min="0" step="0.01" value="${it.price}"></div></div>`).join('')}</div>
  <button type="button" class="btn btn-sm" onclick="addPropItem()">＋ Add item</button>
  <div class="grid2" style="margin-top:14px"><div class="field"><label>Tax rate (%)</label><input name="taxRate" type="number" min="0" step="0.01" value="${p.taxRate ?? 0}"></div><div class="field"><label>Discount</label><input name="discount" type="number" min="0" step="0.01" value="${p.discount ?? 0}"></div></div>
  <div class="field"><label>Payment terms</label><textarea name="paymentTerms">${esc(p.paymentTerms || '')}</textarea></div>
  <div class="field"><label>Additional notes</label><textarea name="notes">${esc(p.notes || '')}</textarea></div>
  <p class="note">Nothing is sent to the client automatically. Mark a proposal Sent only after you have shared it yourself.</p>
  <button class="btn btn-primary">${p.id ? 'Save changes' : 'Save proposal'}</button> <button type="button" class="btn" onclick="closeModal()">Cancel</button></form>`;
}
function addPropItem() { const d = document.createElement('div'); d.className = 'grid3'; d.setAttribute('data-item', ''); d.innerHTML = `<div class="field"><label>Description</label><input name="desc"></div><div class="field"><label>Qty</label><input name="qty" type="number" min="0" value="1"></div><div class="field"><label>Price</label><input name="price" type="number" min="0" step="0.01" value="0"></div>`; $('#prop-items').appendChild(d); }
async function openProposalForm(id) {
  let p = {}; if (id) { try { p = (await api('/api/proposals/' + id)).data; } catch (e) { toast(e.message); return; } }
  modal(proposalFormHTML(p), true);
  $('#proposal-form').addEventListener('submit', async (e) => { e.preventDefault(); const f = new FormData(e.target); const deliverables = $$('[data-item]').map(d => ({ description: d.querySelector('[name=desc]').value, qty: Number(d.querySelector('[name=qty]').value || 0), price: Number(d.querySelector('[name=price]').value || 0) })).filter(x => x.description.trim()); const body = { clientName: f.get('clientName'), clientCompany: f.get('clientCompany'), title: f.get('title'), overview: f.get('overview'), scope: f.get('scope'), deliverables, timeline: f.get('timeline'), currency: f.get('currency'), taxRate: f.get('taxRate'), discount: f.get('discount'), paymentTerms: f.get('paymentTerms'), notes: f.get('notes'), status: f.get('status') }; try { if (p.id) await api('/api/proposals/' + p.id, 'PATCH', body); else await api('/api/proposals', 'POST', body); closeModal(); toast('Proposal saved.'); loadProposals(); if (currentApp === 'overview') loadOverview(); } catch (err) { const el = $('#pf-err'); el.textContent = err.message; el.classList.remove('hidden'); } });
}
async function openProposalView(id) { try { const p = (await api('/api/proposals/' + id)).data; modal(`<div id="proposal-print"><h2>${esc(p.title)}</h2><p><b>Prepared for:</b> ${esc(p.clientName)} ${p.clientCompany ? '(' + esc(p.clientCompany) + ')' : ''}<br><b>Status:</b> ${esc(p.status)} · <b>Timeline:</b> ${esc(p.timeline || '—')}</p><h3>Overview</h3><p>${esc(p.overview || '—')}</p><h3>Scope</h3><p>${esc(p.scope || '—')}</p><h3>Deliverables</h3><table style="min-width:0"><thead><tr><th>Item</th><th>Qty</th><th>Price</th><th>Amount</th></tr></thead><tbody>${p.deliverables.map(it => `<tr><td>${esc(it.description)}</td><td>${it.qty}</td><td>${fmt(it.price, p.currency)}</td><td>${fmt(it.qty * it.price, p.currency)}</td></tr>`).join('')}</tbody></table><p style="text-align:right"><b>Subtotal:</b> ${fmt(p.subtotal, p.currency)}<br><b>Discount:</b> ${fmt(p.discount, p.currency)}<br><b>Tax:</b> ${p.taxRate}%<br><b>Total:</b> ${fmt(p.total, p.currency)}</p><h3>Payment terms</h3><p>${esc(p.paymentTerms || '—')}</p><p>${esc(p.notes || '')}</p><p style="color:var(--muted);font-size:13px">Prices in this proposal are drafts until you verify them. This document was prepared with BizPilot AI.</p></div><p style="margin-top:16px"><button class="btn btn-primary" onclick="window.print()">🖨 Print / Save as PDF</button> <button class="btn" onclick="closeModal()">Close</button></p>`, true); } catch (e) { toast(e.message); } }
async function duplicateProposal(id) { try { await api('/api/proposals/' + id + '/duplicate', 'POST', {}); toast('Proposal duplicated as Draft.'); loadProposals(); } catch (e) { toast(e.message); } }
async function deleteProposal(id) { if (!confirm('Delete this proposal?')) return; try { await api('/api/proposals/' + id, 'DELETE'); toast('Proposal deleted.'); loadProposals(); } catch (e) { toast(e.message); } }
// ---------- follow-ups ----------
async function loadFollowups() {
  const el = $('#app-followups');
  el.innerHTML = `<div class="toolbar"><button class="btn btn-primary" onclick="openFollowupForm()">＋ Add Follow-up</button>
  <select id="fu-filter"><option value="">All</option><option value="today">Today</option><option value="upcoming">Upcoming</option><option value="overdue">Overdue</option><option value="completed">Completed</option></select></div><div id="fu-list"><div class="skeleton" style="height:160px"></div></div>`;
  const run = async () => { try { const f = $('#fu-filter').value; const r = (await api('/api/follow-ups' + (f ? '?filter=' + f : ''))).data; if (!r.length) { $('#fu-list').innerHTML = `<div class="empty card"><b>No follow-ups here</b><p>Add one from a lead, or from this page.</p></div>`; return; } $('#fu-list').innerHTML = r.map(x => `<div class="card" style="margin-bottom:12px"><b>${esc(x.title)}</b> ${x.status === 'Completed' ? '<span class="badge green">Completed</span>' : x.dueDate < todayStr() ? '<span class="badge red">Overdue</span>' : '<span class="badge">Pending</span>'}<p style="color:var(--muted);margin:6px 0">Lead: ${esc(x.leadName || '—')} · Due: ${esc(x.dueDate)}<br>${esc(x.notes || '')}</p><button class="btn btn-sm btn-teal" onclick="completeFu('${x.id}')">✓ Mark completed</button> <button class="btn btn-sm" onclick="openFollowupForm(null,'${x.id}')">Edit / Reschedule</button> <button class="btn btn-sm btn-danger" onclick="deleteFu('${x.id}')">Delete</button></div>`).join(''); } catch (e) { $('#fu-list').innerHTML = `<div class="error">${esc(e.message)}</div>`; } };
  $('#fu-filter').addEventListener('change', run); run();
}
async function openFollowupForm(leadId, id) {
  let f = {}; if (id) { try { const all = (await api('/api/follow-ups')).data; f = all.find(x => x.id === id) || {}; } catch (e) { toast(e.message); return; } }
  const leads = (await api('/api/leads?limit=100')).data;
  modal(`<h2>${f.id ? 'Edit follow-up' : 'Add follow-up'}</h2><div id="fu-err" class="error hidden"></div><form id="fu-form">
  <div class="field"><label>Title *</label><input name="title" value="${esc(f.title || '')}" required></div>
  <div class="field"><label>Lead</label><select name="leadId"><option value="">No lead linked</option>${leads.map(l => `<option value="${l.id}" ${l.id === (leadId || f.leadId) ? 'selected' : ''}>${esc(l.clientName)}</option>`).join('')}</select></div>
  <div class="field"><label>Due date *</label><input name="dueDate" type="date" value="${esc(f.dueDate || todayStr())}" required></div>
  <div class="field"><label>Notes</label><textarea name="notes">${esc(f.notes || '')}</textarea></div>
  <button class="btn btn-primary">${f.id ? 'Save changes' : 'Add follow-up'}</button> <button type="button" class="btn" onclick="closeModal()">Cancel</button></form>`);
  $('#fu-form').addEventListener('submit', async (e) => { e.preventDefault(); const fd = new FormData(e.target); const body = { title: fd.get('title'), leadId: fd.get('leadId') || null, dueDate: fd.get('dueDate'), notes: fd.get('notes') }; try { if (f.id) await api('/api/follow-ups/' + f.id, 'PATCH', body); else await api('/api/follow-ups', 'POST', body); closeModal(); toast('Follow-up saved.'); loadFollowups(); if (currentApp === 'overview') loadOverview(); } catch (err) { const el = $('#fu-err'); el.textContent = err.message; el.classList.remove('hidden'); } });
}
async function completeFu(id) { try { await api('/api/follow-ups/' + id, 'PATCH', { status: 'Completed' }); toast('Follow-up completed.'); loadFollowups(); } catch (e) { toast(e.message); } }
async function deleteFu(id) { if (!confirm('Delete this follow-up?')) return; try { await api('/api/follow-ups/' + id, 'DELETE'); toast('Follow-up deleted.'); loadFollowups(); } catch (e) { toast(e.message); } }
// ---------- analytics ----------
async function loadAnalytics() {
  const el = $('#app-analytics');
  el.innerHTML = `<div class="toolbar"><label>Range:</label><select id="an-range"><option value="7">Last 7 days</option><option value="30" selected>Last 30 days</option><option value="90">Last 90 days</option><option value="all">All time</option></select></div><div id="an-body"><div class="skeleton" style="height:200px"></div></div>`;
  const run = async () => { try { const d = (await api('/api/analytics/overview?range=' + $('#an-range').value)).data; $('#an-body').innerHTML = `<div class="metrics"><div class="card metric"><span>Total leads</span><b>${d.totalLeads}</b></div><div class="card metric"><span>Deals won / lost</span><b>${d.dealsWon} / ${d.dealsLost}</b></div><div class="card metric"><span>Conversion rate</span><b>${d.conversionRate === null ? '—' : d.conversionRate + '%'}</b><span>Won ÷ (Won + Lost) × 100. Shown as — when no finalized deals exist (no division by zero).</span></div><div class="card metric"><span>Pipeline value (open deals)</span><b>${fmt(d.pipelineValue)}</b><span>Estimate only.</span></div><div class="card metric"><span>Average lead value</span><b>${fmt(d.avgLeadValue)}</b></div><div class="card metric"><span>Follow-ups</span><b>${d.followUpsCompleted} completed · ${d.followUpsOverdue} overdue</b></div></div>
  <div class="grid2"><div class="card"><h3>Leads by status</h3>${Object.entries(d.byStatus).map(([s, v]) => `<div class="bar-row"><span style="width:120px">${esc(s)}</span><span class="bar" style="width:${d.totalLeads ? Math.round(v / d.totalLeads * 100) : 0}%;background:var(--teal)"></span>${v}</div>`).join('')}</div><div class="card"><h3>Leads by date</h3>${Object.entries(d.byDate).sort().map(([dt, v]) => `<div class="bar-row"><span style="width:90px">${dt}</span><span class="bar" style="width:${Math.min(100, v * 20)}%"></span>${v}</div>`).join('') || '<p style="color:var(--muted)">No leads in this range.</p>'}</div></div>`; } catch (e) { $('#an-body').innerHTML = `<div class="error">${esc(e.message)}</div>`; } };
  $('#an-range').addEventListener('change', run); run();
}
// ---------- templates ----------
async function loadTemplates() {
  const el = $('#app-templates');
  el.innerHTML = `<div class="toolbar"><input id="tpl-search" placeholder="Search templates…" style="flex:1;min-width:200px"><button class="btn btn-primary" onclick="openTemplateForm()">＋ New Template</button></div><div id="tpl-list"><div class="skeleton" style="height:160px"></div></div>`;
  const run = async () => { try { const r = (await api('/api/templates?q=' + encodeURIComponent($('#tpl-search').value))).data; r.forEach(t => tplCache[t.id] = t.body); $('#tpl-list').innerHTML = r.length ? r.map(t => `<div class="card" style="margin-bottom:12px"><b>${esc(t.title)}</b> <span class="badge">${esc(t.category)}</span><p style="white-space:pre-wrap">${esc(t.body)}</p><button class="btn btn-sm" onclick="copyTpl('${t.id}')">Copy</button> <button class="btn btn-sm" onclick="openTemplateForm('${t.id}')">Edit</button> <button class="btn btn-sm" onclick="aiVariationById('${t.id}')">AI variation</button> <button class="btn btn-sm btn-danger" onclick="deleteTemplate('${t.id}')">Delete</button></div>`).join('') : '<div class="empty card"><b>No templates yet</b><p>Create your first reusable message.</p></div>'; } catch (e) { $('#tpl-list').innerHTML = `<div class="error">${esc(e.message)}</div>`; } };
  $('#tpl-search').addEventListener('input', () => { clearTimeout(window._ts); window._ts = setTimeout(run, 300); }); run();
}
async function copyText(t) { try { await navigator.clipboard.writeText(t); toast('Copied.'); } catch { toast('Select the text and copy it manually.'); } }
function aiVariation(body) { navigate('/dashboard/ai'); setTimeout(() => loadAI(body + '\n\nPlease create a variation of the message above.'), 50); }
async function openTemplateForm(id) {
  let t = {}; if (id) { const all = (await api('/api/templates')).data; t = all.find(x => x.id === id) || {}; }
  modal(`<h2>${t.id ? 'Edit template' : 'New template'}</h2><div id="tp-err" class="error hidden"></div><form id="tpl-form"><div class="field"><label>Title *</label><input name="title" value="${esc(t.title || '')}" required></div><div class="field"><label>Category</label><select name="category">${['General', 'First contact', 'Follow-up', 'Negotiation', 'Requirements', 'Proposal', 'Completion', 'Review'].map(c => `<option ${c === t.category ? 'selected' : ''}>${c}</option>`).join('')}</select></div><div class="field"><label>Message *</label><textarea name="body" style="min-height:140px">${esc(t.body || '')}</textarea></div><p style="color:var(--muted);font-size:13px">Tip: use {name} and {service} as placeholders when you copy a template.</p><button class="btn btn-primary">Save template</button> <button type="button" class="btn" onclick="closeModal()">Cancel</button></form>`);
  $('#tpl-form').addEventListener('submit', async (e) => { e.preventDefault(); const f = new FormData(e.target); const body = { title: f.get('title'), category: f.get('category'), body: f.get('body') }; try { if (t.id) await api('/api/templates/' + t.id, 'PATCH', body); else await api('/api/templates', 'POST', body); closeModal(); toast('Template saved.'); loadTemplates(); } catch (err) { const el = $('#tp-err'); el.textContent = err.message; el.classList.remove('hidden'); } });
}
async function deleteTemplate(id) { if (!confirm('Delete this template?')) return; try { await api('/api/templates/' + id, 'DELETE'); toast('Template deleted.'); loadTemplates(); } catch (e) { toast(e.message); } }
// ---------- settings / billing ----------
function loadSettings() {
  $('#app-settings').innerHTML = `<div class="card" style="max-width:620px"><h2 style="margin-top:0">Profile &amp; settings</h2><div id="st-err" class="error hidden"></div><form id="settings-form">
  <div class="field"><label>Full name *</label><input name="fullName" value="${esc(me.fullName)}" required></div>
  <div class="field"><label>Email (cannot be changed here)</label><input value="${esc(me.email)}" disabled></div>
  <div class="grid2"><div class="field"><label>Business name</label><input name="businessName" value="${esc(me.businessName || '')}"></div><div class="field"><label>Business type</label><input name="businessType" value="${esc(me.businessType || '')}"></div></div>
  <div class="field"><label>Preferred language</label><select name="preferredLanguage"><option>English</option><option>Roman Urdu</option><option>Urdu</option></select></div>
  <button class="btn btn-primary">Save profile</button></form><hr style="border:0;border-top:1px solid var(--border);margin:24px 0">
  <h3>Delete account</h3><p style="color:var(--muted)">This permanently deletes your account and all your leads, proposals, templates and history.</p><button class="btn btn-danger" id="delete-account-btn">Delete my account</button></div>`;
  document.querySelector('#settings-form select').value = me.preferredLanguage || 'English';
  $('#settings-form').addEventListener('submit', async (e) => { e.preventDefault(); const f = new FormData(e.target); try { me = (await api('/api/profile', 'PATCH', { fullName: f.get('fullName'), businessName: f.get('businessName'), businessType: f.get('businessType'), preferredLanguage: f.get('preferredLanguage') })).data; toast('Profile saved.'); render(); } catch (err) { const el = $('#st-err'); el.textContent = err.message; el.classList.remove('hidden'); } });
  $('#delete-account-btn').addEventListener('click', async () => { if (!confirm('Permanently delete your account and all your data? This cannot be undone.')) return; if (!confirm('Are you really sure? Type OK in your head — click OK again to confirm.')) return; try { await api('/api/auth/delete-account', 'POST', { confirm: true }); me = null; navigate('/'); } catch (e) { toast(e.message); } });
}
async function loadBilling() {
  const el = $('#app-billing');
  try {
    const [u, leads, p] = await Promise.all([api('/api/ai/usage'), api('/api/leads?limit=1'), api('/api/plans')]);
    const plan = p.data.find(x => x.id === me.plan) || p.data[0];
    el.innerHTML = `<div class="card"><h2 style="margin-top:0">Billing &amp; usage</h2><p>Current plan: <b>${esc(plan.name)}</b> — $${plan.price}/month (initial test price).</p>
    <p>Leads used: <b>${leads.pagination.total} / ${plan.maxLeads}</b></p><div class="usage-bar"><i style="width:${Math.min(100, leads.pagination.total / plan.maxLeads * 100)}%"></i></div>
    <p style="margin-top:14px">AI generations this month: <b>${u.data.used} / ${u.data.limit}</b></p><div class="usage-bar"><i style="width:${Math.min(100, u.data.used / u.data.limit * 100)}%;background:var(--teal)"></i></div>
    <p class="note" style="margin-top:16px">Upgrade is not activated in this build: no payment provider (Stripe) is configured, so clicking Upgrade below does not charge you or change your plan. See README for the integration point.</p></div>
    <div class="cards" style="margin-top:16px">${p.data.map(x => `<div class="card"><h3>${x.name}</h3><div class="price">$${x.price}<small>/month</small></div><ul style="color:var(--muted);padding-left:18px">${x.features.map(f => `<li>${esc(f)}</li>`).join('')}</ul><button class="btn ${x.id === me.plan ? '' : 'btn-primary'}" ${x.id === me.plan ? 'disabled' : ''} onclick="upgradeInfo('${x.name}')">${x.id === me.plan ? 'Current plan' : 'Upgrade to ' + x.name}</button></div>`).join('')}</div>`;
  } catch (e) { el.innerHTML = `<div class="error">${esc(e.message)}</div>`; }
}
function upgradeInfo(name) { modal(`<h2>Upgrade to ${esc(name)}</h2><p>Payments are not configured in this build yet. To activate real billing, connect Stripe (or another provider), verify payments server-side, and only then update the subscription record — see the README, section 11.</p><p>No charge has been made and your plan has not changed.</p><button class="btn btn-primary" onclick="closeModal()">Got it</button>`); }
render();
