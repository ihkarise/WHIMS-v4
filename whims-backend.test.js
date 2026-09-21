/*
 * WHIMS v4.5 — CONSOLIDATED BACKEND regression suite
 * ------------------------------------------------------------------
 * Loads the real Code.gs into a sandbox with in-memory Apps Script service
 * stubs INCLUDING a working Sheets model, then drives doGet/doPost exactly as
 * an HTTP client would. This exercises the real business logic end-to-end
 * (inventory writes, Orders lifecycle, Intake approval, Packaging bridge,
 * append-only import) AND the full RBAC negative matrix (§15) via direct API.
 * Zero dependencies. Exits non-zero on any failure.
 *
 * Run:  node whims-backend.test.js
 */
'use strict';
const fs = require('fs');
const vm = require('vm');

/* ================= in-memory Sheets model ================= */
function makeSheet(name, rows) {
  const data = rows ? rows.map(r => r.slice()) : [];   // data[r][c], 0-indexed
  let maxCols = data.reduce((m, r) => Math.max(m, r.length), 0);
  const MAXROWS = 100000;
  function padTo(cols) { if (cols > maxCols) maxCols = cols; }
  function ensureCell(r0, c0) {
    while (data.length <= r0) data.push([]);
    if (c0 + 1 > maxCols) maxCols = c0 + 1;
  }
  function get(r0, c0) { const row = data[r0]; return row && row[c0] !== undefined && row[c0] !== null ? row[c0] : ''; }
  function set(r0, c0, v) { ensureCell(r0, c0); const row = data[r0]; while (row.length <= c0) row.push(''); row[c0] = v; }
  function lastRow() {
    for (let r = data.length - 1; r >= 0; r--) {
      const row = data[r] || [];
      for (let c = 0; c < row.length; c++) if (row[c] !== '' && row[c] !== null && row[c] !== undefined) return r + 1;
    }
    return 0;
  }
  function range(row, col, numRows, numCols) {
    const r1 = row - 1, c1 = col - 1;
    const nR = numRows === undefined ? 1 : numRows;
    const nC = numCols === undefined ? 1 : numCols;
    return {
      getValue() { return get(r1, c1); },
      setValue(v) { set(r1, c1, v); return this; },
      getValues() {
        const out = [];
        for (let r = 0; r < nR; r++) { const line = []; for (let c = 0; c < nC; c++) line.push(get(r1 + r, c1 + c)); out.push(line); }
        return out;
      },
      setValues(m) { for (let r = 0; r < m.length; r++) for (let c = 0; c < m[r].length; c++) set(r1 + r, c1 + c, m[r][c]); return this; },
      getFormula() { return ''; },
      copyTo() {}, setFontWeight() { return this; }, setNumberFormat() { return this; }
    };
  }
  return {
    _name: name, _data: data,
    getName() { return name; },
    getDataRange() { const last = lastRow(); return range(1, 1, Math.max(last, 1), Math.max(maxCols, 1)); },
    getLastRow() { return lastRow(); },
    getLastColumn() { return maxCols; },
    getMaxColumns() { return maxCols; },
    getMaxRows() { return MAXROWS; },
    getRange(r, c, nR, nC) { return range(r, c, nR, nC); },
    appendRow(arr) { const r = lastRow(); for (let c = 0; c < arr.length; c++) set(r, c, arr[c]); padTo(arr.length); },
    insertColumnsAfter(col, n) { padTo(col + n); },
    setFrozenRows() {}
  };
}

function INV_HEADERS() {
  return ['ID','Name','Pack','Potency','Category','Bottles','ML','Priority','Supplier1','Cost1',
    'Supplier2','Cost2','Cost/ML','Days','MFD','Expiry','Updated','Active','Status','Remarks','Barcode'];
}
function invRow(o) {
  const r = new Array(21).fill('');
  r[0]=o.id; r[1]=o.name; r[2]=o.pack||''; r[3]=o.potency||''; r[4]=o.category||'';
  r[5]=o.bottles==null?'':o.bottles; r[6]=o.ml==null?'':o.ml; r[7]=o.priority==null?0:o.priority;
  r[8]=o.supplier1||''; r[9]=o.cost1==null?'':o.cost1; r[17]=o.active||'YES'; r[19]=o.remarks||''; r[20]=o.barcode||'';
  return r;
}

function makeSandbox() {
  const props = {}; const cache = {}; let uuid = 0, rnd = 0;
  const sheets = {};
  sheets['Inventory'] = makeSheet('Inventory', [INV_HEADERS(),
    invRow({ id:'HOM001', name:'ARSENICUM ALBUM', potency:'30', pack:'15 ML', category:'HOMEO', bottles:5, cost1:60, supplier1:'SBL', active:'YES' }),
    invRow({ id:'HOM002', name:'BELLADONNA', potency:'30', pack:'15 ML', category:'HOMEO', bottles:3, cost1:55, supplier1:'SBL', active:'YES' }),
    invRow({ id:'COVER001', name:'MEDICINE COVER', potency:'', pack:'PACKET', category:'PACKAGING', bottles:100, cost1:2, supplier1:'PRINTER', active:'YES' })
  ]);
  sheets['Transactions'] = makeSheet('Transactions', [['TxID','DateTime','MedID','MedName','Action','Qty','PrevStock','NewStock','User','Remarks']]);

  const Utilities = {
    getUuid: () => 'uuid-' + (++uuid),
    DigestAlgorithm: { SHA_256: 'S' }, Charset: { UTF_8: 'U' },
    computeDigest: (a, text) => { const o = new Array(32).fill(0); for (let i=0;i<text.length;i++) o[i%32]=(o[i%32]+text.charCodeAt(i)*(i+7))&0xff; return o.map(b=>b>127?b-256:b); },
    formatDate: (d) => new Date(d).toISOString().slice(0,19).replace('T',' ')
  };
  const PropertiesService = { getScriptProperties: () => ({
    getProperty: k => (k in props ? props[k] : null), setProperty: (k,v) => { props[k]=String(v); }, deleteProperty: k => { delete props[k]; }
  }) };
  const CacheService = { getScriptCache: () => ({ get: k => (k in cache ? cache[k] : null), put: (k,v) => { cache[k]=String(v); }, remove: k => { delete cache[k]; } }) };
  const LockService = { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) };
  const Session = { getScriptTimeZone: () => 'UTC' };
  const Logger = { log() {} };
  const ContentService = { MimeType: { JSON: 'JSON' }, createTextOutput: s => ({ _s:s, getContent(){return this._s;}, setMimeType(){return this;} }) };
  const SpreadsheetApp = { getActiveSpreadsheet: () => ({
    getSheetByName: n => sheets[n] || null,
    insertSheet: n => { sheets[n] = makeSheet(n, []); return sheets[n]; }
  }) };
  // Math.random determinism not required; keep default.
  const sandbox = { PropertiesService, CacheService, LockService, Session, Logger, Utilities, ContentService, SpreadsheetApp, console, _sheets: sheets };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(__dirname + '/Code.gs', 'utf8'), sandbox, { filename: 'Code.gs' });
  return sandbox;
}

/* ---------- drivers ---------- */
function post(box, body) { return JSON.parse(box.doPost({ postData: { contents: JSON.stringify(body) } }).getContent()); }
function get(box, params) { return JSON.parse(box.doGet({ parameter: params }).getContent()); }
function loginAs(box, u, p) { const r = post(box, { action: 'login', username: u, password: p }); if (!r.ok) throw new Error('login ' + u + ': ' + r.error); return r.data.token; }
function stock(box, id) { const inv = get(box, { action: 'inventory', token: box.__tok }).data; const m = inv.find(x => x.id === id); return m ? m.bottles : null; }

let pass = 0, fail = 0; const fails = [];
function ok(name, cond) { if (cond) pass++; else { fail++; fails.push(name); console.error('  ✗ ' + name); } }
function grp(t) { console.log('\n• ' + t); }
function denied(res) { return res.ok === false && /permission denied/i.test(res.error); }

function fresh() {
  const box = makeSandbox();
  box.upsertUser('master', 'masterpass1', 'MASTER_ADMIN');
  box.ADD_USER('admin1', 'adminpass1', 'ADMIN');
  box.ADD_USER('op1', 'operpass1', 'OPERATOR');
  box.ADD_USER('view1', 'viewpass1', 'VIEWER');
  box.__tok = loginAs(box, 'admin1', 'adminpass1');   // for read helpers
  return box;
}

/* ================= INVENTORY writes + RBAC ================= */
grp('Inventory write RBAC + business logic');
{
  const box = fresh();
  const A = loginAs(box, 'admin1', 'adminpass1');
  const O = loginAs(box, 'op1', 'operpass1');
  const V = loginAs(box, 'view1', 'viewpass1');

  ok('admin receive increments stock', post(box, { action:'receive', token:A, id:'HOM001', bottles:5, unitCost:60 }).ok && stock(box,'HOM001')===10);
  ok('operator dispense decrements stock', post(box, { action:'dispense', token:O, id:'HOM001', bottles:2 }).ok && stock(box,'HOM001')===8);
  ok('admin adjust sets stock', post(box, { action:'adjust', token:A, id:'HOM001', bottles:7 }).ok && stock(box,'HOM001')===7);
  ok('operator receive allowed', post(box, { action:'receive', token:O, id:'HOM002', bottles:1, unitCost:55 }).ok);

  // §15 mandatory negatives — OPERATOR
  ok('OPERATOR → additem DENIED', denied(post(box, { action:'additem', token:O, id:'NEW1', name:'X' })));
  ok('OPERATOR → setcode DENIED', denied(post(box, { action:'setcode', token:O, id:'HOM001', code:'BC123' })));
  ok('OPERATOR → adjust DENIED', denied(post(box, { action:'adjust', token:O, id:'HOM001', bottles:5 })));
  ok('OPERATOR → archive DENIED', denied(post(box, { action:'archive', token:O, id:'HOM001' })));
  ok('OPERATOR → restore DENIED', denied(post(box, { action:'restore', token:O, id:'HOM001' })));
  ok('OPERATOR → undoapprove DENIED', denied(post(box, { action:'undoapprove', token:O, intakeId:'x' })));

  // §15 mandatory negatives — VIEWER
  ok('VIEWER → receive DENIED', denied(post(box, { action:'receive', token:V, id:'HOM001', bottles:1, unitCost:1 })));
  ok('VIEWER → dispense DENIED', denied(post(box, { action:'dispense', token:V, id:'HOM001', bottles:1 })));
  ok('VIEWER → adjust DENIED', denied(post(box, { action:'adjust', token:V, id:'HOM001', bottles:1 })));
  ok('VIEWER → priority (order write) DENIED', denied(post(box, { action:'priority', token:V, id:'HOM001', priority:3 })));
  ok('VIEWER → orderadd DENIED', denied(post(box, { action:'orderadd', token:V, id:'HOM001', qty:2 })));
  ok('VIEWER → stageintake DENIED', denied(post(box, { action:'stageintake', token:V, rows:[{ name:'x' }] })));
  ok('VIEWER → stagepackaging DENIED', denied(post(box, { action:'stagepackaging', token:V, items:[{ id:'COVER001', qty:1 }] })));
  ok('VIEWER → import DENIED', denied(post(box, { action:'importmedicines', token:V, rows:[{ name:'x' }] })));

  // ADMIN can additem
  ok('ADMIN additem creates row', post(box, { action:'additem', token:A, id:'NEWX1', name:'NEW REMEDY', pack:'15 ML', potency:'30', category:'HOMEO', bottles:2, cost1:50 }).ok && stock(box,'NEWX1')===2);
}

/* ================= ORDERS lifecycle ================= */
grp('Orders lifecycle (Cart → Ordered → Received auto-receives)');
{
  const box = fresh();
  const O = loginAs(box, 'op1', 'operpass1');
  const before = stock(box, 'HOM002');
  const add = post(box, { action:'orderadd', token:O, id:'HOM002', qty:4, supplier:'SBL', unitCost:55 });
  ok('orderadd creates a CART line', add.ok && add.data.status === 'CART');
  const place = post(box, { action:'orderplace', token:O, supplier:'SBL' });
  ok('orderplace → ORDERED', place.ok && place.data.count === 1);
  const orderId = place.data.orderId;
  const recv = post(box, { action:'orderstatus', token:O, orderId, status:'RECEIVED' });
  ok('orderstatus RECEIVED updates line', recv.ok);
  ok('RECEIVED auto-receives stock (+4)', stock(box,'HOM002') === before + 4);
  // qtyReceived recorded
  const orders = get(box, { action:'orders', token:O, status:'RECEIVED' }).data;
  ok('order line marked RECEIVED with qtyReceived', orders.some(l => l.orderId === orderId && l.qtyReceived === 4));
}

/* ================= INTAKE approval + ADD_NEW ADMIN-only ================= */
grp('Intake approval RBAC (RECEIVE ADMOP; ADD_NEW ADMIN-only)');
{
  const box = fresh();
  const A = loginAs(box, 'admin1', 'adminpass1');
  const O = loginAs(box, 'op1', 'operpass1');

  // stage a RECEIVE row (existing medicine) — OPERATOR may stage AND approve.
  // Real contract: items:[{intakeId,...}]; a bare {intakeId} reads action/qty from the sheet row.
  post(box, { action:'stageintake', token:O, rows:[{ source:'WISE_LENS', action:'RECEIVE', matchedId:'HOM001', name:'ARSENICUM ALBUM', qty:3, unitCost:60 }] });
  let q = get(box, { action:'readintake', token:O, status:'pending' }).data;
  const receiveRow = q.find(r => r.action === 'RECEIVE');
  const before = stock(box, 'HOM001');
  ok('OPERATOR approves RECEIVE (existing med) → stock up', post(box, { action:'approveintake', token:O, items:[{ intakeId: receiveRow.intakeId }] }).ok && stock(box,'HOM001') === before + 3);

  // stage an ADD_NEW row — OPERATOR approval must be DENIED (sheet-driven ADD_NEW guard), ADMIN allowed
  post(box, { action:'stageintake', token:O, rows:[{ source:'WISE_LENS', action:'ADD_NEW', name:'NEW LENS MED', pack:'30 ML', potency:'200', category:'HOMEO', qty:2, unitCost:70 }] });
  q = get(box, { action:'readintake', token:A, status:'pending' }).data;
  const addRow = q.find(r => r.action === 'ADD_NEW');
  const denAdd = post(box, { action:'approveintake', token:O, items:[{ intakeId: addRow.intakeId }] });
  ok('OPERATOR → approve ADD_NEW DENIED', denied(denAdd));
  ok('ADD_NEW row NOT approved after denial', get(box, { action:'readintake', token:A, status:'pending' }).data.some(r => r.intakeId === addRow.intakeId));
  const okAdd = post(box, { action:'approveintake', token:A, items:[{ intakeId: addRow.intakeId }] });
  ok('ADMIN → approve ADD_NEW creates medicine', okAdd.ok && okAdd.data.approved === 1);

  // reject
  post(box, { action:'stageintake', token:O, rows:[{ source:'WISE_LENS', action:'RECEIVE', matchedId:'HOM002', qty:1 }] });
  const rj = get(box, { action:'readintake', token:O, status:'pending' }).data[0];
  ok('OPERATOR reject intake', post(box, { action:'rejectintake', token:O, intakeId: rj.intakeId }).ok);
}

/* ================= PACKAGING bridge ================= */
grp('Packaging bridge (stage DISPENSE → approve reduces stock)');
{
  const box = fresh();
  const O = loginAs(box, 'op1', 'operpass1');
  const A = loginAs(box, 'admin1', 'adminpass1');
  const before = stock(box, 'COVER001');
  const stg = post(box, { action:'stagepackaging', token:O, prescriptionId:'RX1', items:[{ id:'COVER001', qty:5 }] });
  ok('OPERATOR stagepackaging stages a PENDING DISPENSE row', stg.ok && stg.data.staged === 1);
  const row = get(box, { action:'readintake', token:O, status:'pending' }).data.find(r => r.action === 'DISPENSE');
  ok('packaging staged as DISPENSE', !!row);
  ok('OPERATOR approves packaging DISPENSE → stock down', post(box, { action:'approveintake', token:O, items:[{ intakeId: row.intakeId }] }).ok && stock(box,'COVER001') === before - 5);
  // packaging never creates a medicine / bad id skipped
  const bad = post(box, { action:'stagepackaging', token:O, items:[{ id:'NOPE999', qty:1 }] });
  ok('packaging with unknown id fails cleanly (no ghost row)', bad.ok === false);
}

/* ================= IMPORT append-only + auth ================= */
grp('Database import (append-only, ADMIN+)');
{
  const box = fresh();
  const A = loginAs(box, 'admin1', 'adminpass1');
  const O = loginAs(box, 'op1', 'operpass1');
  ok('OPERATOR import DENIED', denied(post(box, { action:'importmedicines', token:O, rows:[{ name:'X' }] })));
  const imp = post(box, { action:'importmedicines', token:A, rows:[
    { name:'IMPORTED ONE', potency:'30', pack:'15 ML', category:'HOMEO', bottles:4, cost1:40 },   // new
    { name:'ARSENICUM ALBUM', potency:'30', pack:'15 ML', bottles:9 },                            // dup of existing → skip
    { name:'', potency:'30' }                                                                     // invalid → skip
  ] });
  ok('import adds only the new row', imp.ok && imp.data.added === 1 && imp.data.skipped === 2);
  ok('existing medicine stock untouched by import', stock(box,'HOM001') === 5);
  ok('imported medicine now present', get(box, { action:'inventory', token:A }).data.some(m => m.name === 'IMPORTED ONE'));
  // malformed numeric rejected per-row
  const imp2 = post(box, { action:'importmedicines', token:A, rows:[{ name:'BADNUM', bottles:'abc' }] });
  ok('import rejects malformed numeric row', imp2.ok && imp2.data.added === 0 && imp2.data.skipped === 1);
}

/* ================= MASTER_ADMIN protection + spoofing (direct API) ================= */
grp('Master protection + role spoofing (direct API)');
{
  const box = fresh();
  const A = loginAs(box, 'admin1', 'adminpass1');
  const O = loginAs(box, 'op1', 'operpass1');
  ok('ADMIN → create MASTER_ADMIN DENIED', post(box, { action:'createuser', token:A, username:'m2', password:'pw12345678', role:'MASTER_ADMIN' }).ok === false);
  ok('ADMIN → change MASTER_ADMIN DENIED', post(box, { action:'changerole', token:A, username:'master', role:'OPERATOR' }).ok === false);
  ok('ADMIN → deactivate MASTER_ADMIN DENIED', post(box, { action:'deactivateuser', token:A, username:'master' }).ok === false);
  // frontend role spoofing: OPERATOR claims ADMIN in body → still denied server-side
  ok('OPERATOR role-spoof in body → user mgmt still DENIED', post(box, { action:'listusers', token:O, role:'ADMIN' }).ok === false);
  ok('OPERATOR role-spoof → additem still DENIED', denied(post(box, { action:'additem', token:O, role:'MASTER_ADMIN', id:'Z1', name:'Z' })));
  // me returns server truth
  ok('me returns server role (OPERATOR)', get(box, { action:'me', token:O }).data.role === 'OPERATOR');
}

/* ================= numeric validation (backend-independent) ================= */
grp('Numeric validation (independent of frontend)');
{
  const box = fresh();
  const A = loginAs(box, 'admin1', 'adminpass1');
  ok('reject non-numeric qty', post(box, { action:'receive', token:A, id:'HOM001', bottles:'abc', unitCost:10 }).error.match(/valid number/i));
  ok('reject zero qty', post(box, { action:'receive', token:A, id:'HOM001', bottles:0, unitCost:10 }).error.match(/greater than 0/i));
  ok('reject negative qty', post(box, { action:'receive', token:A, id:'HOM001', bottles:-2, unitCost:10 }).error.match(/greater than 0/i));
  ok('reject negative unit cost', post(box, { action:'receive', token:A, id:'HOM001', bottles:2, unitCost:-5 }).error.match(/at least 0/i));
  const z = stock(box,'HOM001');
  ok('zero unit cost permitted (3×₹0)', post(box, { action:'receive', token:A, id:'HOM001', bottles:3, unitCost:0 }).ok && stock(box,'HOM001') === z + 3);
  // unit cost stored as per-bottle
  post(box, { action:'receive', token:A, id:'HOM002', bottles:5, unitCost:125 });
  ok('receive stores per-bottle cost (₹125)', get(box, { action:'inventory', token:A }).data.find(m=>m.id==='HOM002').cost1 === 125);
  // deactivated user blocked mid-session
  const O = loginAs(box, 'op1', 'operpass1');
  post(box, { action:'deactivateuser', token:A, username:'op1' });
  ok('deactivated user existing token rejected', post(box, { action:'dispense', token:O, id:'HOM001', bottles:1 }).ok === false);
  ok('deactivated user cannot log in', post(box, { action:'login', username:'op1', password:'operpass1' }).ok === false);
}

/* ---------- summary ---------- */
console.log('\n' + '='.repeat(54));
console.log('WHIMS v4.5 consolidated-backend tests:  ' + pass + ' passed, ' + fail + ' failed');
if (fail) { console.log('FAILED:\n - ' + fails.join('\n - ')); process.exit(1); }
console.log('ALL GREEN ✓'); process.exit(0);
