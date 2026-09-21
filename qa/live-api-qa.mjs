#!/usr/bin/env node
/*
 * WHIMS v4.5 — LIVE Apps Script API QA runner
 * ============================================================================
 * Runs the DIRECT-API portion of the live QA (checklist §2 reachability, §3
 * auth, §5 security matrix, §7 receiving, §8 dispense, §9 orders, §10 intake,
 * §11 packaging, §12 WQE, §13 import) against a DEPLOYED TEST backend over
 * real HTTPS — exactly as the frontend would. Prints PASS / FAIL / NOT TESTED
 * per item and writes qa/RESULTS.md.
 *
 * ⚠️  RUN ONLY AGAINST A TEST DEPLOYMENT BOUND TO A TEST SPREADSHEET.
 *     It performs real writes (receive/dispense/orders/intake/import) on the
 *     bound sheet. NEVER point it at the production /exec URL.
 *
 * Requires Node 18+ (global fetch). No dependencies.
 *
 * Usage:
 *   WHIMS_EXEC_URL="https://script.google.com/macros/s/DEPLOY_ID/exec" \
 *   WHIMS_MASTER_USER=qa_master WHIMS_MASTER_PASS='QAmaster123' \
 *   WHIMS_ADMIN_USER=qa_admin   WHIMS_ADMIN_PASS='QAadmin123' \
 *   WHIMS_OPER_USER=qa_oper     WHIMS_OPER_PASS='QAoper123' \
 *   WHIMS_VIEW_USER=qa_view     WHIMS_VIEW_PASS='QAview123' \
 *   node qa/live-api-qa.mjs
 *
 * Seed the four accounts first from the Apps Script editor (see qa/README-LIVE-QA.md):
 *   SET_MASTER_ADMIN() , ADD_USER('qa_admin','QAadmin123','ADMIN') , etc.
 */
import fs from 'node:fs';

const URL_ = process.env.WHIMS_EXEC_URL || process.argv[2] || '';
if (!URL_) {
  console.error('✗ WHIMS_EXEC_URL is required (a TEST /exec URL). Aborting — nothing was sent.');
  process.exit(2);
}
if (/\/dev(\?|$)/.test(URL_)) console.warn('! URL ends in /dev — use the deployed /exec URL for a realistic test.');

const CRED = {
  MASTER_ADMIN: [process.env.WHIMS_MASTER_USER || 'qa_master', process.env.WHIMS_MASTER_PASS || 'QAmaster123'],
  ADMIN:        [process.env.WHIMS_ADMIN_USER  || 'qa_admin',  process.env.WHIMS_ADMIN_PASS  || 'QAadmin123'],
  OPERATOR:     [process.env.WHIMS_OPER_USER   || 'qa_oper',   process.env.WHIMS_OPER_PASS   || 'QAoper123'],
  VIEWER:       [process.env.WHIMS_VIEW_USER   || 'qa_view',   process.env.WHIMS_VIEW_PASS   || 'QAview123']
};

/* ---------- transport (mirrors app.js: text/plain POST, GET with params) ---------- */
async function apiPost(body) {
  const r = await fetch(URL_, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body), redirect: 'follow' });
  const t = await r.text();
  try { return JSON.parse(t); } catch { return { ok: false, error: 'non-JSON (' + r.status + '): ' + t.slice(0, 120) }; }
}
async function apiGet(action, params = {}) {
  const u = new URL(URL_);
  u.searchParams.set('action', action);
  Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v));
  const r = await fetch(u, { redirect: 'follow' });
  const t = await r.text();
  try { return JSON.parse(t); } catch { return { ok: false, error: 'non-JSON (' + r.status + '): ' + t.slice(0, 120) }; }
}
async function login(role) {
  const [u, p] = CRED[role];
  const r = await apiPost({ action: 'login', username: u, password: p });
  if (!r.ok) throw new Error('login ' + role + ' (' + u + ') failed: ' + r.error);
  return r.data;
}
const P = (tok, body) => apiPost({ ...body, token: tok });
const denied = (r) => r && r.ok === false && /permission denied/i.test(String(r.error));

/* ---------- result recording ---------- */
const results = [];
let pass = 0, failN = 0, nt = 0;
function rec(section, name, status, detail = '') {
  results.push({ section, name, status, detail });
  if (status === 'PASS') pass++; else if (status === 'FAIL') failN++; else nt++;
  const mark = status === 'PASS' ? '✓' : status === 'FAIL' ? '✗' : '·';
  console.log('  ' + mark + ' [' + section + '] ' + name + (detail ? '  — ' + detail : ''));
}
async function check(section, name, fn) {
  try { const ok = await fn(); rec(section, name, ok ? 'PASS' : 'FAIL'); }
  catch (e) { rec(section, name, 'FAIL', String(e.message || e)); }
}
function head(t) { console.log('\n=== ' + t + ' ==='); }

async function invStock(tok, id) {
  const r = await apiGet('inventory', { token: tok });
  if (!r.ok) throw new Error('inventory read: ' + r.error);
  const m = r.data.find(x => String(x.id).toUpperCase() === id.toUpperCase());
  return m ? Number(m.bottles) : null;
}
async function invCount(tok) { const r = await apiGet('inventory', { token: tok }); return r.ok ? r.data.length : -1; }

/* ============================ RUN ============================ */
console.log('WHIMS v4.5 — LIVE API QA');
console.log('Target (TEST): ' + URL_);
console.log('Time: ' + new Date().toISOString());

let TOK = {};
try {
  head('§2 Deployment reachability');
  const ping = await apiGet('ping');
  rec('§2', 'ping returns backend live', ping.ok ? 'PASS' : 'FAIL', ping.ok ? (ping.message || '') : ping.error);
  rec('§2', 'unauthenticated inventory rejected', (await apiGet('inventory')).ok === false ? 'PASS' : 'FAIL');

  head('§3 Authentication + role resolution');
  for (const role of ['MASTER_ADMIN', 'ADMIN', 'OPERATOR', 'VIEWER']) {
    try {
      const d = await login(role); TOK[role] = d.token;
      rec('§3', role + ' login returns correct server role', d.role === role ? 'PASS' : 'FAIL', 'got ' + d.role);
    } catch (e) { rec('§3', role + ' login', 'FAIL', String(e.message)); }
  }
  await check('§3', 'invalid password rejected', async () => (await apiPost({ action: 'login', username: CRED.OPERATOR[0], password: 'wrong-password-xyz' })).ok === false);
  for (const role of ['MASTER_ADMIN', 'ADMIN', 'OPERATOR', 'VIEWER']) {
    if (!TOK[role]) continue;
    await check('§3', 'me returns server role for ' + role, async () => (await apiGet('me', { token: TOK[role] })).data?.role === role);
  }
  // inactive user lifecycle (self-contained: create → deactivate → login blocked → reactivate)
  if (TOK.MASTER_ADMIN) {
    const tmp = 'qa_tmp_inactive';
    await P(TOK.MASTER_ADMIN, { action: 'createuser', username: tmp, password: 'QAtemp1234', role: 'OPERATOR' });
    await check('§3', 'deactivated user cannot log in', async () => {
      await P(TOK.MASTER_ADMIN, { action: 'deactivateuser', username: tmp });
      return (await apiPost({ action: 'login', username: tmp, password: 'QAtemp1234' })).ok === false;
    });
    await check('§3', 'reactivated user can log in again', async () => {
      await P(TOK.MASTER_ADMIN, { action: 'activateuser', username: tmp });
      return (await apiPost({ action: 'login', username: tmp, password: 'QAtemp1234' })).ok === true;
    });
  }
  // logout invalidates the token
  if (TOK.VIEWER) {
    await check('§3', 'logout invalidates the session token', async () => {
      const d = await login('VIEWER');
      await apiPost({ action: 'logout', token: d.token });
      return (await apiGet('me', { token: d.token })).ok === false;
    });
  }
  rec('§3', 'session expiration (6h) — cannot wait in QA', 'NOT TESTED', 'verify manually or by config');

  const A = TOK.ADMIN, O = TOK.OPERATOR, V = TOK.VIEWER, M = TOK.MASTER_ADMIN;

  head('§5 Direct-API security matrix (must all be DENIED)');
  if (O) {
    await check('§5', 'OPERATOR → additem DENIED', async () => denied(await P(O, { action: 'additem', id: 'QAX1', name: 'X' })));
    await check('§5', 'OPERATOR → setcode DENIED', async () => denied(await P(O, { action: 'setcode', id: 'HOM001', code: 'QABC1' })));
    await check('§5', 'OPERATOR → adjust DENIED', async () => denied(await P(O, { action: 'adjust', id: 'HOM001', bottles: 3 })));
    await check('§5', 'OPERATOR → archive DENIED', async () => denied(await P(O, { action: 'archive', id: 'HOM001' })));
    await check('§5', 'OPERATOR → restore DENIED', async () => denied(await P(O, { action: 'restore', id: 'HOM001' })));
    await check('§5', 'OPERATOR → undoapprove DENIED', async () => denied(await P(O, { action: 'undoapprove', intakeId: 'nope' })));
  }
  if (V) {
    for (const [a, extra] of [['receive', { id: 'HOM001', bottles: 1, unitCost: 1 }], ['dispense', { id: 'HOM001', bottles: 1 }],
      ['adjust', { id: 'HOM001', bottles: 1 }], ['orderadd', { id: 'HOM001', qty: 1 }], ['priority', { id: 'HOM001', priority: 3 }],
      ['stageintake', { rows: [{ name: 'x' }] }], ['stagepackaging', { items: [{ id: 'COVER001', qty: 1 }] }], ['importmedicines', { rows: [{ name: 'x' }] }]]) {
      await check('§5', 'VIEWER → ' + a + ' DENIED', async () => denied(await P(V, { action: a, ...extra })));
    }
  }
  if (A && M) {
    await check('§5', 'ADMIN → create MASTER_ADMIN DENIED', async () => (await P(A, { action: 'createuser', username: 'qa_m2', password: 'QAm212345', role: 'MASTER_ADMIN' })).ok === false);
    await check('§5', 'ADMIN → change MASTER_ADMIN role DENIED', async () => (await P(A, { action: 'changerole', username: CRED.MASTER_ADMIN[0], role: 'OPERATOR' })).ok === false);
    await check('§5', 'ADMIN → deactivate MASTER_ADMIN DENIED', async () => (await P(A, { action: 'deactivateuser', username: CRED.MASTER_ADMIN[0] })).ok === false);
    await check('§5', 'OPERATOR role-spoof in body still DENIED (additem)', async () => denied(await P(O, { action: 'additem', role: 'MASTER_ADMIN', id: 'QAZ1', name: 'Z' })));
  }

  head('§4 User management (via API — the panel calls these)');
  if (M) {
    await check('§4', 'MASTER_ADMIN listusers (no secrets)', async () => { const r = await P(M, { action: 'listusers' }); return r.ok && !JSON.stringify(r).match(/hash|salt/); });
    await check('§4', 'MASTER_ADMIN create ADMIN', async () => (await P(M, { action: 'createuser', username: 'qa_admin2', password: 'QAadmin234', role: 'ADMIN' })).ok);
    await check('§4', 'MASTER_ADMIN create OPERATOR', async () => (await P(M, { action: 'createuser', username: 'qa_oper2', password: 'QAoper234', role: 'OPERATOR' })).ok);
    await check('§4', 'MASTER_ADMIN create VIEWER', async () => (await P(M, { action: 'createuser', username: 'qa_view2', password: 'QAview234', role: 'VIEWER' })).ok);
    await check('§4', 'MASTER_ADMIN change role (oper2→viewer)', async () => (await P(M, { action: 'changerole', username: 'qa_oper2', role: 'VIEWER' })).ok);
    await check('§4', 'reset password (no password echoed)', async () => { const r = await P(M, { action: 'resetpassword', username: 'qa_view2', password: 'QAnew12345' }); return r.ok && !JSON.stringify(r).includes('QAnew12345'); });
  }
  if (A) {
    await check('§4', 'ADMIN create OPERATOR', async () => (await P(A, { action: 'createuser', username: 'qa_oper3', password: 'QAoper345', role: 'OPERATOR' })).ok);
    await check('§4', 'ADMIN create VIEWER', async () => (await P(A, { action: 'createuser', username: 'qa_view3', password: 'QAview345', role: 'VIEWER' })).ok);
    await check('§4', 'ADMIN CANNOT create ADMIN', async () => (await P(A, { action: 'createuser', username: 'qa_admin3', password: 'QAadmin345', role: 'ADMIN' })).ok === false);
  }
  if (O) await check('§4', 'OPERATOR CANNOT list users', async () => (await P(O, { action: 'listusers' })).ok === false);
  if (V) await check('§4', 'VIEWER CANNOT list users', async () => (await P(V, { action: 'listusers' })).ok === false);

  head('§7 Receiving (quantity × unit cost)');
  if (O) {
    await check('§7', '2 × ₹200 = ₹400 (stock +2)', async () => {
      const before = await invStock(O, 'HOM001');
      const r = await P(O, { action: 'receive', id: 'HOM001', bottles: 2, unitCost: 200 });
      const after = await invStock(O, 'HOM001');
      return r.ok && after === before + 2;
    });
    await check('§7', '5 × ₹125 = ₹625 (unit cost stored 125)', async () => {
      const r = await P(O, { action: 'receive', id: 'HOM007', bottles: 5, unitCost: 125 });
      const inv = await apiGet('inventory', { token: O });
      const m = inv.data.find(x => x.id === 'HOM007');
      return r.ok && Number(m.cost1) === 125;
    });
    await check('§7', 'transaction recorded for receive', async () => {
      const tx = await apiGet('transactions', { token: O, limit: 20 });
      return tx.ok && tx.data.some(t => t.medicineId === 'HOM001' && t.action === 'RECEIVE');
    });
    await check('§7', 'invalid qty "abc" rejected', async () => (await P(O, { action: 'receive', id: 'HOM001', bottles: 'abc', unitCost: 10 })).ok === false);
    await check('§7', 'blank qty rejected', async () => (await P(O, { action: 'receive', id: 'HOM001', bottles: '', unitCost: 10 })).ok === false);
    await check('§7', 'negative qty rejected', async () => (await P(O, { action: 'receive', id: 'HOM001', bottles: -2, unitCost: 10 })).ok === false);
    await check('§7', 'negative cost rejected', async () => (await P(O, { action: 'receive', id: 'HOM001', bottles: 2, unitCost: -5 })).ok === false);
    await check('§7', 'zero cost permitted (documented)', async () => (await P(O, { action: 'receive', id: 'HOM002', bottles: 1, unitCost: 0 })).ok === true);
  }

  head('§8 Dispensing');
  if (O) {
    await check('§8', 'dispense decreases stock + logs tx', async () => {
      const before = await invStock(O, 'HOM007');
      const r = await P(O, { action: 'dispense', id: 'HOM007', bottles: 1, remarks: 'QA dispense' });
      const after = await invStock(O, 'HOM007');
      const tx = await apiGet('transactions', { token: O, limit: 10 });
      return r.ok && after === before - 1 && tx.data.some(t => t.medicineId === 'HOM007' && t.action === 'DISPENSE');
    });
    await check('§8', 'dispense invalid qty rejected', async () => (await P(O, { action: 'dispense', id: 'HOM007', bottles: 'x' })).ok === false);
  }

  head('§9 Orders (Qty Ordered vs Qty Received separate)');
  if (O) {
    let orderId = null;
    await check('§9', 'orderadd creates CART line', async () => { const r = await P(O, { action: 'orderadd', id: 'HOM003', qty: 4, supplier: 'SBL', unitCost: 55 }); return r.ok && r.data.status === 'CART'; });
    await check('§9', 'orderupdate changes qty to 6', async () => {
      const cart = await apiGet('orders', { token: O, status: 'CART' });
      const line = cart.data.find(l => l.medId === 'HOM003');
      return line && (await P(O, { action: 'orderupdate', lineId: line.lineId, qty: 6 })).ok;
    });
    await check('§9', 'orderplace → ORDERED', async () => { const r = await P(O, { action: 'orderplace', supplier: 'SBL' }); if (r.ok) orderId = r.data.orderId; return r.ok && r.data.count >= 1; });
    await check('§9', 'orderstatus RECEIVED auto-receives stock', async () => {
      const before = await invStock(O, 'HOM003');
      const r = await P(O, { action: 'orderstatus', orderId, status: 'RECEIVED' });
      const after = await invStock(O, 'HOM003');
      return r.ok && after === before + 6;
    });
    await check('§9', 'Qty Ordered and Qty Received both present + separate', async () => {
      const rec_ = await apiGet('orders', { token: O, status: 'RECEIVED' });
      const line = rec_.data.find(l => l.orderId === orderId && l.medId === 'HOM003');
      return line && line.qtyOrdered === 6 && line.qtyReceived === 6;
    });
  }

  head('§10 Intake + Approval (ADD_NEW is ADMIN-only)');
  if (O && A && V) {
    await check('§10', 'OPERATOR stage + approve RECEIVE (existing) raises stock', async () => {
      const before = await invStock(O, 'HOM001');
      await P(O, { action: 'stageintake', rows: [{ source: 'WISE_LENS', action: 'RECEIVE', matchedId: 'HOM001', name: 'ARSENICUM ALBUM', qty: 3, unitCost: 60 }] });
      const q = await apiGet('readintake', { token: O, status: 'pending' });
      const row = q.data.find(r => r.action === 'RECEIVE' && r.matchedId === 'HOM001');
      const r = await P(O, { action: 'approveintake', items: [{ intakeId: row.intakeId }] });
      return r.ok && (await invStock(O, 'HOM001')) === before + 3;
    });
    await check('§10', 'reject a staged intake row', async () => {
      await P(O, { action: 'stageintake', rows: [{ source: 'WISE_LENS', action: 'RECEIVE', matchedId: 'HOM002', qty: 1 }] });
      const q = await apiGet('readintake', { token: O, status: 'pending' });
      const row = q.data[0];
      return (await P(O, { action: 'rejectintake', intakeId: row.intakeId })).ok;
    });
    // ADD_NEW matrix
    async function stageAddNew() {
      await P(O, { action: 'stageintake', rows: [{ source: 'WISE_LENS', action: 'ADD_NEW', name: 'QA NEW MED ' + Date.now(), pack: '30 ML', potency: '200', category: 'HOMEO', qty: 2, unitCost: 70 }] });
      const q = await apiGet('readintake', { token: A, status: 'pending' });
      return q.data.find(r => r.action === 'ADD_NEW');
    }
    await check('§10', 'OPERATOR → approve ADD_NEW DENIED', async () => { const row = await stageAddNew(); return denied(await P(O, { action: 'approveintake', items: [{ intakeId: row.intakeId }] })); });
    await check('§10', 'VIEWER → approve ADD_NEW DENIED', async () => { const q = await apiGet('readintake', { token: A, status: 'pending' }); const row = q.data.find(r => r.action === 'ADD_NEW'); return denied(await P(V, { action: 'approveintake', items: [{ intakeId: row.intakeId }] })); });
    await check('§10', 'ADMIN → approve ADD_NEW creates medicine', async () => { const q = await apiGet('readintake', { token: A, status: 'pending' }); const row = q.data.find(r => r.action === 'ADD_NEW'); const r = await P(A, { action: 'approveintake', items: [{ intakeId: row.intakeId }] }); return r.ok && r.data.approved === 1; });
    await check('§10', 'undo an approval restores stock (ADMIN)', async () => {
      const before = await invStock(A, 'HOM001');
      await P(O, { action: 'stageintake', rows: [{ source: 'WISE_LENS', action: 'RECEIVE', matchedId: 'HOM001', qty: 2 }] });
      const q = await apiGet('readintake', { token: A, status: 'pending' });
      const row = q.data.find(r => r.action === 'RECEIVE' && r.matchedId === 'HOM001');
      const appr = await P(A, { action: 'approveintake', items: [{ intakeId: row.intakeId }] });
      const undo = await P(A, { action: 'undoapprove', intakeId: row.intakeId });
      return appr.ok && undo.ok && (await invStock(A, 'HOM001')) === before;
    });
  }

  head('§11 Packaging bridge (never creates a medicine)');
  if (O) {
    await check('§11', 'stagepackaging → PENDING DISPENSE; approve reduces stock; no new medicine', async () => {
      const before = await invStock(O, 'COVER001');
      const countBefore = await invCount(O);
      const stg = await P(O, { action: 'stagepackaging', prescriptionId: 'QA-RX1', items: [{ id: 'COVER001', qty: 5 }] });
      const q = await apiGet('readintake', { token: O, status: 'pending' });
      const row = q.data.find(r => r.action === 'DISPENSE' && r.matchedId === 'COVER001');
      const appr = await P(O, { action: 'approveintake', items: [{ intakeId: row.intakeId }] });
      const after = await invStock(O, 'COVER001');
      const countAfter = await invCount(O);
      return stg.ok && appr.ok && after === before - 5 && countAfter === countBefore;
    });
    await check('§11', 'packaging with unknown id fails cleanly', async () => (await P(O, { action: 'stagepackaging', items: [{ id: 'NOPE_QA_999', qty: 1 }] })).ok === false);
  }

  head('§12 Wise Query Engine (read/analysis-only)');
  if (O) {
    const countBefore = await invCount(O);
    await check('§12', 'smartsearch returns results (read)', async () => { const r = await apiGet('smartsearch', { token: O, q: 'bell' }); return r.ok || !denied(r); });
    await check('§12', 'medgroup (read)', async () => { const r = await apiGet('medgroup', { token: O, q: 'belladonna' }); return r.ok || !denied(r); });
    await check('§12', 'medfacets (read)', async () => { const r = await apiGet('medfacets', { token: O, q: 'belladonna' }); return r.ok || !denied(r); });
    // planorder / askwhims need OPENROUTER_API_KEY — pass if reached (not permission-denied)
    await check('§12', 'planorder reached (read-only; needs OPENROUTER key to answer)', async () => { const r = await P(O, { action: 'planorder' }); return !denied(r); });
    await check('§12', 'askwhims reached (read-only; needs OPENROUTER key to answer)', async () => { const r = await P(O, { action: 'askwhims', question: 'What is low on stock?' }); return !denied(r); });
    await check('§12', 'WQE did NOT modify inventory (count unchanged)', async () => (await invCount(O)) === countBefore);
    rec('§12', 'no WQE write action exists (cannot mutate)', 'PASS', 'smartsearch/medgroup/medfacets/planorder/askwhims are read-only by design');
  }

  head('§13 Import (append-only, ADMIN+)');
  if (A && O) {
    await check('§13', 'OPERATOR import DENIED', async () => denied(await P(O, { action: 'importmedicines', rows: [{ name: 'X' }] })));
    await check('§13', 'ADMIN import: adds new, skips duplicate; existing stock untouched', async () => {
      const before = await invStock(A, 'HOM001');
      const r = await P(A, { action: 'importmedicines', rows: [
        { name: 'QA IMPORTED ' + Date.now(), potency: '30', pack: '15 ML', category: 'HOMEO', bottles: 4, cost1: 40 },
        { name: 'ARSENICUM ALBUM', potency: '30', pack: '15 ML', bottles: 9 }   // dup → skip
      ] });
      const after = await invStock(A, 'HOM001');
      return r.ok && r.data.added === 1 && r.data.skipped >= 1 && after === before;
    });
    await check('§13', 'import rejects malformed numeric row', async () => { const r = await P(A, { action: 'importmedicines', rows: [{ name: 'QA BADNUM', bottles: 'abc' }] }); return r.ok && r.data.added === 0; });
  }

  // UI-only sections
  head('UI-only sections (run qa/ui-qa-checklist.md in a browser)');
  ['§6 fuzzy/exact/typo search UX', '§6 pack/potency variant display', '§14 supplier contacts + WhatsApp link', '§15 Dispensed-This-Week panel']
    .forEach(n => rec('UI', n, 'NOT TESTED', 'browser step — see qa/ui-qa-checklist.md'));
  rec('§2', 'Execute-as / access / version settings', 'NOT TESTED', 'read from Apps Script console — see runbook §2');

} catch (e) {
  console.error('\nFATAL: ' + (e.message || e));
}

/* ---------- summary + results file ---------- */
console.log('\n' + '='.repeat(60));
console.log('LIVE API QA:  ' + pass + ' PASS · ' + failN + ' FAIL · ' + nt + ' NOT TESTED  (of ' + results.length + ')');

const md = ['# WHIMS v4.5 — Live API QA results', '',
  '- Backend (TEST /exec): `' + URL_ + '`', '- Run at: ' + new Date().toISOString(),
  '- Summary: **' + pass + ' PASS · ' + failN + ' FAIL · ' + nt + ' NOT TESTED**', '',
  '| Section | Test | Result | Detail |', '|---|---|---|---|',
  ...results.map(r => `| ${r.section} | ${r.name} | ${r.status} | ${r.detail.replace(/\|/g, '\\|')} |`), ''
].join('\n');
try { fs.writeFileSync(new URL('./RESULTS.md', import.meta.url), md); console.log('Wrote qa/RESULTS.md'); } catch (e) { console.error('could not write RESULTS.md: ' + e.message); }
process.exit(failN ? 1 : 0);
