/**
 * WISE HOMEOPATHY INVENTORY MANAGEMENT SYSTEM (WHIMS)
 * Google Apps Script Backend — v2.0 (login + session tokens + amounts)
 *
 * SECURITY MODEL
 * --------------
 * • Usernames + salted SHA-256 password hashes live in Script Properties —
 *   Google's private vault for this script. They are NOT in this file, NOT
 *   in the frontend, NOT on GitHub. Nothing secret ships with the app.
 * • Login returns a random session token valid for 6 hours. Every other
 *   request must carry a valid token or it gets "Unauthorized".
 * • 5 wrong passwords locks that username out for 10 minutes.
 *
 * FIRST-TIME SETUP (do once):
 * 1. Edit USERNAME / PASSWORD inside ADD_USER() below.
 * 2. Run ADD_USER from the editor toolbar (▶). Check the log says "created".
 * 3. IMPORTANT: change the PASSWORD line back to '' afterwards. The hash is
 *    already stored; the plain text is no longer needed anywhere.
 * Repeat for each staff member. LIST_USERS / REMOVE_USER manage them.
 *
 * Sheet structure expected (do not reorder columns):
 * Inventory:    A ID | B Name | C Pack | D Potency | E Category | F Bottles |
 *               G ML | H Priority | I Supplier1 | J Cost1 | K Supplier2 |
 *               L Cost2 | M Cost/ML | N Days | O MFD | P Expiry | Q Updated |
 *               R Active | S Status (formula) | T Remarks
 * Transactions: A TxID | B DateTime | C MedID | D MedName | E Action |
 *               F Qty | G PrevStock | H NewStock | I User | J Remarks |
 *               K Amount ₹  (added automatically by this version)
 */

var INVENTORY_SHEET = 'Inventory';
var TRANSACTIONS_SHEET = 'Transactions';
var SESSION_HOURS = 6;

var COL = {
  ID: 1, NAME: 2, PACK: 3, POTENCY: 4, CATEGORY: 5,
  BOTTLES: 6, ML: 7, PRIORITY: 8, SUP1: 9, COST1: 10,
  SUP2: 11, COST2: 12, COST_ML: 13, DAYS: 14, MFD: 15,
  EXPIRY: 16, UPDATED: 17, ACTIVE: 18, STATUS: 19, REMARKS: 20
};

// ==================== USER MANAGEMENT (run from editor) ====================

function ADD_USER() {
  var USERNAME = 'jasmine';        // ← edit, then run
  var PASSWORD = '';               // ← put password here, run, then blank it again
  if (!USERNAME || !PASSWORD) throw new Error('Fill in USERNAME and PASSWORD first.');
  if (PASSWORD.length < 8) throw new Error('Use at least 8 characters.');
  var users = loadUsers();
  var salt = Utilities.getUuid();
  users[USERNAME.toLowerCase()] = { salt: salt, hash: hashPw(salt, PASSWORD) };
  PropertiesService.getScriptProperties().setProperty('WHIMS_USERS', JSON.stringify(users));
  Logger.log('User "' + USERNAME + '" created/updated. Now blank the PASSWORD line.');
}

function REMOVE_USER() {
  var USERNAME = '';               // ← edit, then run
  if (!USERNAME) throw new Error('Fill in USERNAME first.');
  var users = loadUsers();
  delete users[USERNAME.toLowerCase()];
  PropertiesService.getScriptProperties().setProperty('WHIMS_USERS', JSON.stringify(users));
  Logger.log('User "' + USERNAME + '" removed.');
}

function LIST_USERS() {
  Logger.log('Users: ' + Object.keys(loadUsers()).join(', ') || '(none)');
}

function loadUsers() {
  var raw = PropertiesService.getScriptProperties().getProperty('WHIMS_USERS');
  return raw ? JSON.parse(raw) : {};
}

function hashPw(salt, pw) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + '::' + pw, Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('');
}

// ==================== AUTH CORE ====================

function login(body) {
  var u = String(body.username || '').trim().toLowerCase();
  var p = String(body.password || '');
  if (!u || !p) throw new Error('Enter username and password');

  var cache = CacheService.getScriptCache();
  var failKey = 'fails_' + u;
  var fails = Number(cache.get(failKey) || 0);
  if (fails >= 5) throw new Error('Too many failed attempts. Try again in 10 minutes.');

  var users = loadUsers();
  var rec = users[u];
  if (!rec || hashPw(rec.salt, p) !== rec.hash) {
    cache.put(failKey, String(fails + 1), 600); // 10-min lockout window
    throw new Error('Wrong username or password');
  }

  cache.remove(failKey);
  var token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
  cache.put('tok_' + token, u, SESSION_HOURS * 3600); // auto-expires
  return { token: token, user: u, hours: SESSION_HOURS };
}

function logout(body) {
  if (body.token) CacheService.getScriptCache().remove('tok_' + String(body.token));
  return { loggedOut: true };
}

/** Returns the username for a valid token, or throws. */
function requireAuth(token) {
  if (!token) throw new Error('Unauthorized — please log in');
  var u = CacheService.getScriptCache().get('tok_' + String(token));
  if (!u) throw new Error('Session expired — please log in again');
  return u;
}

// ==================== HTTP ENTRY POINTS ====================

function doGet(e) {
  var action = (e.parameter.action || 'inventory').toLowerCase();
  try {
    if (action === 'ping') return json({ ok: true, message: 'WHIMS backend is live', time: new Date().toISOString() });
    requireAuth(e.parameter.token); // everything else needs a session
    if (action === 'inventory') return json({ ok: true, data: getInventory() });
    if (action === 'transactions') return json({ ok: true, data: getTransactions(Number(e.parameter.limit) || 100) });
    return json({ ok: false, error: 'Unknown action: ' + action });
  } catch (err) {
    return json({ ok: false, error: String(err).replace('Error: ', '') });
  }
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var body = JSON.parse(e.postData.contents);
    var action = (body.action || '').toLowerCase();

    if (action === 'login') return json({ ok: true, data: login(body) });
    if (action === 'logout') return json({ ok: true, data: logout(body) });

    body.user = requireAuth(body.token); // user identity comes from the session, not the client

    var result;
    if (action === 'receive')       result = receiveStock(body);
    else if (action === 'dispense') result = dispenseStock(body);
    else if (action === 'adjust')   result = adjustStock(body);
    else if (action === 'archive')  result = setActive(body, 'NO', 'ARCHIVE');
    else if (action === 'restore')  result = setActive(body, 'YES', 'RESTORE');
    else if (action === 'priority') result = setPriority(body);
    else throw new Error('Unknown action: ' + action);
    return json({ ok: true, data: result });
  } catch (err) {
    return json({ ok: false, error: String(err).replace('Error: ', '') });
  } finally {
    lock.releaseLock();
  }
}

// ==================== READ ====================

function getInventory() {
  var sh = sheet(INVENTORY_SHEET);
  var values = sh.getDataRange().getValues();
  var out = [];
  for (var r = 1; r < values.length; r++) {
    var v = values[r];
    if (!v[COL.ID - 1] && !v[COL.NAME - 1]) continue;
    out.push({
      id: String(v[COL.ID - 1]),
      name: String(v[COL.NAME - 1]),
      pack: str(v[COL.PACK - 1]),
      potency: str(v[COL.POTENCY - 1]),
      category: str(v[COL.CATEGORY - 1]),
      bottles: num(v[COL.BOTTLES - 1]),
      ml: num(v[COL.ML - 1]),
      priority: num(v[COL.PRIORITY - 1]),
      supplier1: str(v[COL.SUP1 - 1]),
      cost1: num(v[COL.COST1 - 1]),
      supplier2: str(v[COL.SUP2 - 1]),
      cost2: num(v[COL.COST2 - 1]),
      mfd: str(v[COL.MFD - 1]),
      expiry: str(v[COL.EXPIRY - 1]),
      updated: str(v[COL.UPDATED - 1]),
      active: String(v[COL.ACTIVE - 1] || 'YES').toUpperCase(),
      status: str(v[COL.STATUS - 1]),
      remarks: str(v[COL.REMARKS - 1])
    });
  }
  return out;
}

function getTransactions(limit) {
  var sh = sheet(TRANSACTIONS_SHEET);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var rows = Math.min(limit, last - 1);
  var cols = Math.min(11, sh.getMaxColumns());
  var values = sh.getRange(last - rows + 1, 1, rows, cols).getValues();
  var out = values.map(function (v) {
    return {
      txId: str(v[0]), dateTime: str(v[1]), medicineId: str(v[2]),
      medicineName: str(v[3]), action: str(v[4]), quantity: num(v[5]),
      prevStock: num(v[6]), newStock: num(v[7]), user: str(v[8]),
      remarks: str(v[9]), amount: v.length > 10 ? num(v[10]) : 0
    };
  });
  return out.reverse(); // newest first
}

// ==================== WRITE ====================

function receiveStock(body) {
  var loc = findMedicine(body.id);
  var sh = loc.sheet, row = loc.row;
  var prevBottles = num(sh.getRange(row, COL.BOTTLES).getValue());
  var addBottles = num(body.bottles);
  if (addBottles <= 0) throw new Error('Received bottles must be greater than 0');
  var newBottles = prevBottles + addBottles;

  sh.getRange(row, COL.BOTTLES).setValue(newBottles);
  if (body.ml !== undefined && body.ml !== null && body.ml !== '') {
    var prevMl = num(sh.getRange(row, COL.ML).getValue());
    sh.getRange(row, COL.ML).setValue(prevMl + num(body.ml));
  }
  if (body.supplier) sh.getRange(row, COL.SUP1).setValue(body.supplier);   // company
  if (body.mfd) sh.getRange(row, COL.MFD).setValue(body.mfd);
  if (body.expiry) sh.getRange(row, COL.EXPIRY).setValue(body.expiry);

  // amount paid: log it, and refresh Primary Cost with the per-bottle price
  var amount = num(body.amount);
  if (amount > 0) {
    sh.getRange(row, COL.COST1).setValue(Math.round((amount / addBottles) * 100) / 100);
  }
  stamp(sh, row);

  logTx(loc.id, loc.name, 'RECEIVE', addBottles, prevBottles, newBottles, body.user,
    joinRemarks(body.supplier ? 'From ' + body.supplier : '', body.remarks), amount);
  return { id: loc.id, prevStock: prevBottles, newStock: newBottles };
}

function dispenseStock(body) {
  var loc = findMedicine(body.id);
  var sh = loc.sheet, row = loc.row;
  var prevBottles = num(sh.getRange(row, COL.BOTTLES).getValue());
  var qty = num(body.bottles);
  if (qty <= 0) throw new Error('Dispense quantity must be greater than 0');
  if (qty > prevBottles) throw new Error('Only ' + prevBottles + ' bottle(s) in stock');
  var newBottles = prevBottles - qty;

  sh.getRange(row, COL.BOTTLES).setValue(newBottles);
  if (body.ml !== undefined && body.ml !== null && body.ml !== '') {
    var prevMl = num(sh.getRange(row, COL.ML).getValue());
    sh.getRange(row, COL.ML).setValue(Math.max(0, prevMl - num(body.ml)));
  }
  stamp(sh, row);

  logTx(loc.id, loc.name, 'DISPENSE', qty, prevBottles, newBottles, body.user,
    body.remarks, num(body.amount));
  return { id: loc.id, prevStock: prevBottles, newStock: newBottles };
}

function adjustStock(body) {
  var loc = findMedicine(body.id);
  var sh = loc.sheet, row = loc.row;
  var prevBottles = num(sh.getRange(row, COL.BOTTLES).getValue());
  var newBottles = num(body.bottles);
  if (newBottles < 0) throw new Error('Stock cannot be negative');

  sh.getRange(row, COL.BOTTLES).setValue(newBottles);
  if (body.ml !== undefined && body.ml !== null && body.ml !== '') {
    sh.getRange(row, COL.ML).setValue(num(body.ml));
  }
  if (body.priority !== undefined && body.priority !== null && body.priority !== '') {
    sh.getRange(row, COL.PRIORITY).setValue(num(body.priority));
  }
  stamp(sh, row);

  logTx(loc.id, loc.name, 'ADJUSTMENT', newBottles - prevBottles, prevBottles, newBottles, body.user, body.remarks, 0);
  return { id: loc.id, prevStock: prevBottles, newStock: newBottles };
}

function setActive(body, flag, actionName) {
  var loc = findMedicine(body.id);
  var sh = loc.sheet, row = loc.row;
  var bottles = num(sh.getRange(row, COL.BOTTLES).getValue());
  sh.getRange(row, COL.ACTIVE).setValue(flag);
  stamp(sh, row);
  logTx(loc.id, loc.name, actionName, 0, bottles, bottles, body.user, body.remarks, 0);
  return { id: loc.id, active: flag };
}

/** Sets ONLY the reorder priority — used by the +/− order buttons. */
function setPriority(body) {
  var loc = findMedicine(body.id);
  var sh = loc.sheet, row = loc.row;
  var bottles = num(sh.getRange(row, COL.BOTTLES).getValue());
  var p = num(body.priority);
  if (p < 0 || p > 5) throw new Error('Priority must be between 0 and 5');
  sh.getRange(row, COL.PRIORITY).setValue(p);
  stamp(sh, row);
  logTx(loc.id, loc.name, p > 0 ? 'ORDER-ADD' : 'ORDER-REMOVE', 0, bottles, bottles,
    body.user, body.remarks || ('Reorder priority set to ' + p), 0);
  return { id: loc.id, priority: p };
}

// ==================== HELPERS ====================

function findMedicine(id) {
  if (!id) throw new Error('Medicine ID is required');
  var sh = sheet(INVENTORY_SHEET);
  var ids = sh.getRange(2, COL.ID, sh.getLastRow() - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]).trim() === String(id).trim()) {
      var row = i + 2;
      return { sheet: sh, row: row, id: String(id).trim(), name: String(sh.getRange(row, COL.NAME).getValue()) };
    }
  }
  throw new Error('Medicine not found: ' + id);
}

function logTx(id, name, action, qty, prev, next, user, remarks, amount) {
  var sh = sheet(TRANSACTIONS_SHEET);
  // make sure the Amount column exists (added in v2)
  if (sh.getMaxColumns() < 11) sh.insertColumnsAfter(sh.getMaxColumns(), 11 - sh.getMaxColumns());
  if (str(sh.getRange(1, 11).getValue()) === '') sh.getRange(1, 11).setValue('Amount ₹');
  var txId = 'TXN' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMddHHmmss') + Math.floor(Math.random() * 90 + 10);
  sh.appendRow([txId, Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss'),
    id, name, action, qty, prev, next, user || 'Staff', remarks || '', num(amount) || '']);
}

function joinRemarks(a, b) {
  return [a, b].filter(function (x) { return x; }).join(' · ');
}

function stamp(sh, row) {
  sh.getRange(row, COL.UPDATED).setValue(Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm'));
}

function sheet(name) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) throw new Error('Sheet not found: ' + name + '. Check the tab name.');
  return sh;
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function str(v) { return v === null || v === undefined ? '' : String(v); }
function num(v) { var n = Number(v); return isNaN(n) ? 0 : n; }
