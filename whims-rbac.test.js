/*
 * WHIMS v4.5 — backend RBAC / user-management / validation test suite
 * ------------------------------------------------------------------
 * Loads the REAL Code.gs into a sandbox with in-memory stubs for the Apps
 * Script services, then drives the actual doGet/doPost dispatchers exactly as
 * an HTTP client would — so these are DIRECT API authorization tests, not UI
 * tests. Zero dependencies. Exits non-zero on any failure.
 *
 * Run:  node whims-rbac.test.js
 */
'use strict';
const fs = require('fs');
const vm = require('vm');

/* ---------- in-memory Apps Script service stubs ---------- */
function makeSandbox() {
  const props = {};                 // Script Properties
  const cache = {};                 // Script Cache
  let uuid = 0;
  const Utilities = {
    getUuid: () => 'uuid-' + (++uuid),
    DigestAlgorithm: { SHA_256: 'SHA_256' },
    Charset: { UTF_8: 'UTF_8' },
    // deterministic non-crypto digest → byte array; fine for tests (verifies
    // salted hashing + that plaintext is never stored, not crypto strength)
    computeDigest: (algo, text) => {
      const out = new Array(32).fill(0);
      for (let i = 0; i < text.length; i++) out[i % 32] = (out[i % 32] + text.charCodeAt(i) * (i + 7)) & 0xff;
      return out.map(b => (b > 127 ? b - 256 : b));
    },
    formatDate: (d, tz, fmt) => new Date(d).toISOString().slice(0, 19).replace('T', ' ')
  };
  const PropertiesService = { getScriptProperties: () => ({
    getProperty: k => (k in props ? props[k] : null),
    setProperty: (k, v) => { props[k] = String(v); },
    deleteProperty: k => { delete props[k]; }
  }) };
  const CacheService = { getScriptCache: () => ({
    get: k => (k in cache ? cache[k] : null),
    put: (k, v) => { cache[k] = String(v); },
    remove: k => { delete cache[k]; }
  }) };
  const LockService = { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) };
  const Session = { getScriptTimeZone: () => 'UTC' };
  const Logger = { log() {} };
  const ContentService = {
    MimeType: { JSON: 'JSON' },
    createTextOutput: s => ({ _s: s, getContent() { return this._s; }, setMimeType() { return this; } })
  };
  // Inventory sheet not needed for RBAC/validation tests; provide a throwing
  // stub so any accidental sheet access is obvious.
  const SpreadsheetApp = { getActiveSpreadsheet: () => { throw new Error('sheet access not stubbed in RBAC test'); } };

  const sandbox = { PropertiesService, CacheService, LockService, Session, Logger,
    Utilities, ContentService, SpreadsheetApp, console };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(__dirname + '/Code.gs', 'utf8'), sandbox, { filename: 'Code.gs' });
  return sandbox;
}

/* ---------- helpers to drive the real dispatchers ---------- */
function post(box, body) {
  const res = box.doPost({ postData: { contents: JSON.stringify(body) } });
  return JSON.parse(res.getContent());
}
function get(box, params) {
  return JSON.parse(box.doGet({ parameter: params }).getContent());
}
function loginAs(box, username, password) {
  const r = post(box, { action: 'login', username, password });
  if (!r.ok) throw new Error('login failed for ' + username + ': ' + r.error);
  return r.data.token;
}

/* ---------- test runner ---------- */
let pass = 0, fail = 0; const fails = [];
function ok(name, cond) { if (cond) pass++; else { fail++; fails.push(name); console.error('  ✗ ' + name); } }
function group(t) { console.log('\n• ' + t); }

/* ================================================================
 * Bootstrap a fresh backend with a known set of accounts.
 * ================================================================ */
function freshBox() {
  const box = makeSandbox();
  box.SET_MASTER_ADMIN = box.SET_MASTER_ADMIN; // (already defined) noop for clarity
  // master admin (editor-only bootstrap)
  box.upsertUser('master', 'masterpass1', 'MASTER_ADMIN');
  box.ADD_USER('admin1', 'adminpass1', 'ADMIN');
  box.ADD_USER('op1', 'operpass1', 'OPERATOR');
  box.ADD_USER('view1', 'viewpass1', 'VIEWER');
  return box;
}

/* ================================================================
 * 1. Role creation matrix + master protection (direct API)
 * ================================================================ */
group('User-management authorization (direct API)');
{
  const box = freshBox();
  const mtok = loginAs(box, 'master', 'masterpass1');
  const atok = loginAs(box, 'admin1', 'adminpass1');
  const otok = loginAs(box, 'op1', 'operpass1');
  const vtok = loginAs(box, 'view1', 'viewpass1');

  // 1–3 Master creates ADMIN/OPERATOR/VIEWER
  ok('1 master creates ADMIN', post(box, { action: 'createuser', token: mtok, username: 'newadmin', password: 'pw12345678', role: 'ADMIN' }).ok);
  ok('2 master creates OPERATOR', post(box, { action: 'createuser', token: mtok, username: 'newop', password: 'pw12345678', role: 'OPERATOR' }).ok);
  ok('3 master creates VIEWER', post(box, { action: 'createuser', token: mtok, username: 'newview', password: 'pw12345678', role: 'VIEWER' }).ok);

  // 4–5 Admin creates OPERATOR/VIEWER
  ok('4 admin creates OPERATOR', post(box, { action: 'createuser', token: atok, username: 'admop', password: 'pw12345678', role: 'OPERATOR' }).ok);
  ok('5 admin creates VIEWER', post(box, { action: 'createuser', token: atok, username: 'admview', password: 'pw12345678', role: 'VIEWER' }).ok);

  // 6 Admin cannot create ADMIN
  ok('6 admin CANNOT create ADMIN', post(box, { action: 'createuser', token: atok, username: 'x1', password: 'pw12345678', role: 'ADMIN' }).ok === false);
  // 7 Admin cannot create MASTER_ADMIN
  ok('7 admin CANNOT create MASTER_ADMIN', post(box, { action: 'createuser', token: atok, username: 'x2', password: 'pw12345678', role: 'MASTER_ADMIN' }).ok === false);
  // 7b Even MASTER cannot mint MASTER_ADMIN via API
  ok('7b master CANNOT create MASTER_ADMIN via API', post(box, { action: 'createuser', token: mtok, username: 'x3', password: 'pw12345678', role: 'MASTER_ADMIN' }).ok === false);

  // 8 Operator cannot create users
  ok('8 operator CANNOT create users', post(box, { action: 'createuser', token: otok, username: 'x4', password: 'pw12345678', role: 'VIEWER' }).ok === false);
  // 9 Viewer cannot create users
  ok('9 viewer CANNOT create users', post(box, { action: 'createuser', token: vtok, username: 'x5', password: 'pw12345678', role: 'VIEWER' }).ok === false);

  // 10 Admin cannot modify MASTER_ADMIN (role change)
  ok('10 admin CANNOT change master role', post(box, { action: 'changerole', token: atok, username: 'master', role: 'OPERATOR' }).ok === false);
  // 11 Admin cannot deactivate MASTER_ADMIN
  ok('11 admin CANNOT deactivate master', post(box, { action: 'deactivateuser', token: atok, username: 'master' }).ok === false);
  // 11b Master cannot deactivate/modify a MASTER_ADMIN via API either
  ok('11b master CANNOT deactivate master via API', post(box, { action: 'deactivateuser', token: mtok, username: 'master' }).ok === false);
  ok('11c master CANNOT changerole master via API', post(box, { action: 'changerole', token: mtok, username: 'master', role: 'ADMIN' }).ok === false);

  // 12 Frontend cannot promote itself/others to MASTER_ADMIN
  ok('12 changerole to MASTER_ADMIN rejected (master actor)', post(box, { action: 'changerole', token: mtok, username: 'admin1', role: 'MASTER_ADMIN' }).ok === false);
  ok('12b admin cannot self-promote to ADMIN', post(box, { action: 'changerole', token: atok, username: 'admin1', role: 'ADMIN' }).ok === false);

  // 13 Direct forbidden-role creation rejected (covered by 7/7b) — also unknown role
  ok('13 unknown role rejected', post(box, { action: 'createuser', token: mtok, username: 'x6', password: 'pw12345678', role: 'SUPERUSER' }).ok === false);

  // admin manages operator: allowed
  ok('admin can change operator→viewer', post(box, { action: 'changerole', token: atok, username: 'op1', role: 'VIEWER' }).ok);
  ok('admin CANNOT change an ADMIN target', post(box, { action: 'changerole', token: atok, username: 'newadmin', role: 'OPERATOR' }).ok === false);
}

/* ================================================================
 * 14. Legacy accounts migrate / default to OPERATOR
 * ================================================================ */
group('Role migration');
{
  const box = makeSandbox();
  // simulate a pre-role account written by the old backend: {salt, hash} only
  const salt = 'legacy-salt';
  const users = { legacy: { salt: salt, hash: box.hashPw(salt, 'legacypw1') } };
  box.PropertiesService.getScriptProperties().setProperty('WHIMS_USERS', JSON.stringify(users));

  ok('14a roleOf legacy defaults to OPERATOR', box.roleOf('legacy') === 'OPERATOR');
  const r = box.MIGRATE_ROLES();
  ok('14b MIGRATE_ROLES stamps 1 account', r.migrated === 1);
  const after = JSON.parse(box.PropertiesService.getScriptProperties().getProperty('WHIMS_USERS'));
  ok('14c migrated record has role OPERATOR', after.legacy.role === 'OPERATOR');
  ok('14d migrated record active=true', after.legacy.active === true);
  ok('14e legacy login still works after migrate', post(box, { action: 'login', username: 'legacy', password: 'legacypw1' }).ok);
  ok('14f login returns the role', post(box, { action: 'login', username: 'legacy', password: 'legacypw1' }).data.role === 'OPERATOR');
}

/* ================================================================
 * 15–16. Password never returned / never plaintext
 * ================================================================ */
group('Password security');
{
  const box = freshBox();
  const mtok = loginAs(box, 'master', 'masterpass1');
  const created = post(box, { action: 'createuser', token: mtok, username: 'secretuser', password: 'topsecret1', role: 'OPERATOR' });
  const blob = JSON.stringify(created);
  ok('15a createuser never returns the password', blob.indexOf('topsecret1') === -1);
  ok('15b createuser never returns hash/salt', !('hash' in created.data) && !('salt' in created.data));
  const list = post(box, { action: 'listusers', token: mtok });
  ok('15c listusers never leaks hash/salt', JSON.stringify(list).indexOf('hash') === -1 && JSON.stringify(list).indexOf('salt') === -1);
  // 16 stored value is a salted hash, never the plaintext
  const store = JSON.parse(box.PropertiesService.getScriptProperties().getProperty('WHIMS_USERS'));
  ok('16a stored record has salt+hash', !!store.secretuser.salt && !!store.secretuser.hash);
  ok('16b stored value is not the plaintext', store.secretuser.hash !== 'topsecret1' && JSON.stringify(store.secretuser).indexOf('topsecret1') === -1);
  // reset password
  const rp = post(box, { action: 'resetpassword', token: mtok, username: 'secretuser', password: 'brandnew12' });
  ok('17a resetpassword succeeds for authorised admin', rp.ok);
  ok('17b resetpassword never returns the password', JSON.stringify(rp).indexOf('brandnew12') === -1);
  ok('17c old password no longer works', post(box, { action: 'login', username: 'secretuser', password: 'topsecret1' }).ok === false);
  ok('17d new password works', post(box, { action: 'login', username: 'secretuser', password: 'brandnew12' }).ok);
  // operator cannot reset passwords
  const otok = loginAs(box, 'op1', 'operpass1');
  ok('17e operator CANNOT reset passwords', post(box, { action: 'resetpassword', token: otok, username: 'secretuser', password: 'hackpw1234' }).ok === false);
}

/* ================================================================
 * 18–19. Deactivate blocks login; reactivate restores it
 * ================================================================ */
group('Activation lifecycle');
{
  const box = freshBox();
  const mtok = loginAs(box, 'master', 'masterpass1');
  ok('18a op can log in before deactivation', post(box, { action: 'login', username: 'op1', password: 'operpass1' }).ok);
  ok('18b deactivate op', post(box, { action: 'deactivateuser', token: mtok, username: 'op1' }).ok);
  ok('18c deactivated user CANNOT log in', post(box, { action: 'login', username: 'op1', password: 'operpass1' }).ok === false);
  // existing session of a now-deactivated user is also blocked
  const box2 = freshBox();
  const m2 = loginAs(box2, 'master', 'masterpass1');
  const opTok = loginAs(box2, 'op1', 'operpass1');
  post(box2, { action: 'deactivateuser', token: m2, username: 'op1' });
  ok('18d deactivated user existing token is rejected', post(box2, { action: 'dispense', token: opTok, id: 'X', bottles: 1 }).ok === false);
  ok('19a reactivate op', post(box, { action: 'activateuser', token: mtok, username: 'op1' }).ok);
  ok('19b reactivated user CAN log in again', post(box, { action: 'login', username: 'op1', password: 'operpass1' }).ok);
  // cannot deactivate self
  ok('19c admin cannot deactivate self', post(box, { action: 'deactivateuser', token: loginAs(box, 'admin1', 'adminpass1'), username: 'admin1' }).ok === false);
}

/* ================================================================
 * Inventory-action RBAC (VIEWER no writes; ADMIN-only actions) — direct API
 * ================================================================ */
group('Inventory-action RBAC (direct API)');
{
  const box = freshBox();
  const vtok = loginAs(box, 'view1', 'viewpass1');
  const otok = loginAs(box, 'op1', 'operpass1');
  // VIEWER blocked on every write BEFORE any sheet access (Forbidden, not a sheet error)
  ['receive', 'dispense', 'adjust', 'archive', 'restore', 'priority', 'importmedicines'].forEach(a => {
    const r = post(box, { action: a, token: vtok, id: 'HOM001', bottles: 1, rows: [{ name: 'x' }] });
    ok('viewer blocked on ' + a, r.ok === false && /Forbidden/i.test(r.error));
  });
  // OPERATOR blocked on ADMIN-only actions (Forbidden), allowed to reach OPERATOR actions
  ['adjust', 'archive', 'restore', 'importmedicines'].forEach(a => {
    const r = post(box, { action: a, token: otok, id: 'HOM001', bottles: 1, rows: [{ name: 'x' }] });
    ok('operator blocked on admin-only ' + a, r.ok === false && /Forbidden/i.test(r.error));
  });
  // 5 (import) authorization: operator denied, admin passes the gate (then hits sheet stub)
  ok('operator denied import (Forbidden)', /Forbidden/i.test(post(box, { action: 'importmedicines', token: otok, rows: [{ name: 'x' }] }).error));
  const atok = loginAs(box, 'admin1', 'adminpass1');
  const impAdmin = post(box, { action: 'importmedicines', token: atok, rows: [{ name: 'x' }] });
  ok('admin passes import gate (fails later only at sheet stub)', impAdmin.ok === false && !/Forbidden/i.test(impAdmin.error));
  // operator IS allowed to reach receive/dispense/priority (passes gate, then sheet stub)
  const recOp = post(box, { action: 'priority', token: otok, id: 'HOM001', priority: 3 });
  ok('operator passes priority gate', recOp.ok === false && !/Forbidden/i.test(recOp.error));
}

/* ================================================================
 * Numeric validation (backend-independent of frontend)
 * ================================================================ */
group('Backend numeric validation');
{
  const box = freshBox();
  const otok = loginAs(box, 'op1', 'operpass1');
  // These pass the role gate (operator) and must be rejected by VALIDATION,
  // before any sheet write — so the error is the validation message, not a sheet error.
  const bad = (body, label, re) => {
    const r = post(box, Object.assign({ action: 'receive', token: otok, id: 'HOM001' }, body));
    ok(label, r.ok === false && re.test(r.error));
  };
  bad({ bottles: 'abc', unitCost: 100 }, 'reject non-numeric quantity', /valid number/i);
  bad({ bottles: 0, unitCost: 100 }, 'reject zero quantity', /greater than 0/i);
  bad({ bottles: -2, unitCost: 100 }, 'reject negative quantity', /greater than 0/i);
  bad({ bottles: 2.5, unitCost: 100 }, 'reject fractional quantity', /whole number/i);
  bad({ bottles: '1e3', unitCost: 100 }, 'reject malformed 1e3 quantity', /valid number/i);
  bad({ bottles: 3, unitCost: 'xyz' }, 'reject non-numeric unit cost', /valid number/i);
  bad({ bottles: 3, unitCost: -50 }, 'reject negative unit cost', /at least 0/i);
  // NaN-as-zero must NOT happen: 'abc' must never be treated as 0
  ok('NaN quantity is never silently 0', post(box, { action: 'receive', token: otok, id: 'HOM001', bottles: 'abc', unitCost: 10 }).ok === false);
  // parseNum unit checks
  ok('parseNum("abc") is NaN', Number.isNaN(box.parseNum('abc')));
  ok('parseNum("") is NaN', Number.isNaN(box.parseNum('')));
  ok('parseNum("3.5") = 3.5', box.parseNum('3.5') === 3.5);
  ok('parseNum(0) = 0 (valid)', box.parseNum(0) === 0);
  // zero unit cost is explicitly PERMITTED (documented) — passes validation, fails later at sheet stub only
  const zc = post(box, { action: 'receive', token: otok, id: 'HOM001', bottles: 2, unitCost: 0 });
  ok('zero unit cost permitted (no validation error)', zc.ok === false && !/number|at least|greater/i.test(zc.error));
}

/* ================================================================
 * Legacy total-cost compatibility (unit maths still correct)
 * ================================================================ */
group('Receiving cost helpers');
{
  const box = freshBox();
  ok('round2(3*150)=450', box.round2(3 * 150) === 450);
  ok('round2(5*125)=625', box.round2(5 * 125) === 625);
}

/* ================================================================
 * Existing login + role-spoof resistance + me endpoint
 * ================================================================ */
group('Session, role-spoofing, me');
{
  const box = freshBox();
  ok('20 existing login works', post(box, { action: 'login', username: 'op1', password: 'operpass1' }).ok);
  const otok = loginAs(box, 'op1', 'operpass1');
  // Role spoof: client sends role:MASTER_ADMIN in body — must be ignored; op still cannot manage users
  ok('role field in body is ignored (spoof fails)', post(box, { action: 'createuser', token: otok, role: 'MASTER_ADMIN', username: 'z', password: 'pw12345678', actorRole: 'MASTER_ADMIN' }).ok === false);
  // me returns SERVER role
  ok('me returns server role for operator', get(box, { action: 'me', token: otok }).data.role === 'OPERATOR');
  ok('unauthenticated me rejected', get(box, { action: 'me', token: 'bogus' }).ok === false);
  // WQE reserved + read-only
  const wqe = get(box, { action: 'smartsearch', token: otok });
  ok('WQE action reserved, read-only, not integrated', wqe.ok === false && /read-only/i.test(wqe.error));
}

/* ---------- summary ---------- */
console.log('\n' + '='.repeat(52));
console.log('WHIMS v4.5 RBAC/backend tests:  ' + pass + ' passed, ' + fail + ' failed');
if (fail) { console.log('FAILED:\n - ' + fails.join('\n - ')); process.exit(1); }
console.log('ALL GREEN ✓'); process.exit(0);
