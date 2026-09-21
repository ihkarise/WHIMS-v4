/**
 * WISE HOMEOPATHY INVENTORY MANAGEMENT SYSTEM (WHIMS)
 * Google Apps Script Backend — v4.5 (adds the Wise Printer Packaging Bridge
 * on top of v4.4's Entry-Source Analytics, Undo Approval and Manual AI
 * Assistant — see the v4.5 section at the very bottom; plus a DISPENSE
 * branch in approveOne so packaging approvals reduce stock via the existing
 * dispenseStock engine)
 *
 * HOW TO INSTALL THIS FILE
 * ------------------------
 * This is your ENTIRE backend — the original file plus everything new,
 * already combined. In the Apps Script editor:
 *   1. Open Code.gs
 *   2. Select everything in it (Ctrl/Cmd+A) and delete it
 *   3. Paste this whole file in
 *   4. Save (Ctrl/Cmd+S)
 *   5. Deploy → Manage deployments → pencil icon → Version: New version → Deploy
 * That's it. Nothing from your existing setup is removed — every original
 * function is byte-for-byte the same; only new functions were added at the
 * bottom, and 4 new lines were added inside doGet()/doPost() so the app
 * knows about the 3 new features below.
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
 *               R Active | S Status (formula) | T Remarks | U Barcode (scan aliases)
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
  EXPIRY: 16, UPDATED: 17, ACTIVE: 18, STATUS: 19, REMARKS: 20,
  BARCODE: 21   // U — scan aliases (SKU id + any linked barcodes), comma-separated
};

var USERS_KEY = 'WHIMS_USERS';

// ==================== RBAC (v4.5 consolidated) — server-side roles ====================
// FOUR roles. Roles live inside the same WHIMS_USERS Script Property as the
// salt/hash (username -> {salt, hash, role, active?, displayName?, created?,
// lastLogin?}); the browser NEVER supplies a role. A record with no role is
// treated as DEFAULT_ROLE (OPERATOR) so existing staff keep working.
//
//   MASTER_ADMIN — highest account. Created/recovered ONLY from this editor
//                  (SET_MASTER_ADMIN). It can NEVER be created, changed,
//                  deactivated or deleted through the frontend API.
//   ADMIN        — frontend administrator. Manages OPERATOR/VIEWER only.
//   OPERATOR     — normal staff (default for legacy accounts).
//   VIEWER       — read-only; no write capability whatsoever.

var ROLES = { MASTER_ADMIN: 'MASTER_ADMIN', ADMIN: 'ADMIN', OPERATOR: 'OPERATOR', VIEWER: 'VIEWER' };
var ROLE_RANK = { VIEWER: 1, OPERATOR: 2, ADMIN: 3, MASTER_ADMIN: 4 };
var DEFAULT_ROLE = 'OPERATOR';   // role for any user whose record has no explicit role

/** Canonical role string (accepts spaces/dashes → MASTER_ADMIN), else ''. */
function normalizeRole(role) {
  var r = String(role == null ? '' : role).trim().toUpperCase().replace(/[\s-]+/g, '_');
  return ROLES[r] ? r : '';
}
function rankOf(role) { return ROLE_RANK[normalizeRole(role)] || 0; }

/** Trusted server-side role lookup for an authenticated username. */
function getUserRole(username) {
  var u = String(username || '').trim().toLowerCase();
  var rec = loadUsers()[u];
  if (!rec) return DEFAULT_ROLE;          // authenticated token but record gone → least surprise, still gated below
  return normalizeRole(rec.role) || DEFAULT_ROLE;
}

/** Which roles an actor may CREATE/ASSIGN. MASTER_ADMIN is never assignable via API. */
function canAssignRole(actorRole, newRole) {
  var nr = normalizeRole(newRole);
  if (!nr || nr === 'MASTER_ADMIN') return false;
  if (normalizeRole(actorRole) === 'MASTER_ADMIN') return nr === 'ADMIN' || nr === 'OPERATOR' || nr === 'VIEWER';
  if (normalizeRole(actorRole) === 'ADMIN') return nr === 'OPERATOR' || nr === 'VIEWER';
  return false;
}
/** Whether an actor may manage a target of the given role. A MASTER_ADMIN
 *  target is untouchable via the API for every actor. */
function canManageTarget(actorRole, targetRole) {
  if (normalizeRole(targetRole) === 'MASTER_ADMIN') return false;
  if (normalizeRole(actorRole) === 'MASTER_ADMIN') return true;
  if (normalizeRole(actorRole) === 'ADMIN') return normalizeRole(targetRole) === 'OPERATOR' || normalizeRole(targetRole) === 'VIEWER';
  return false;
}

// ==================== USER STORE + EDITOR HELPERS ====================

function loadUsers() {
  var raw = PropertiesService.getScriptProperties().getProperty(USERS_KEY);
  return raw ? JSON.parse(raw) : {};
}
function saveUsers(users) {
  PropertiesService.getScriptProperties().setProperty(USERS_KEY, JSON.stringify(users));
}

function hashPw(salt, pw) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + '::' + pw, Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('');
}
function nowStamp() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
}

/** Create/update a user with a fresh salt+hash; preserves created/active/displayName. */
function upsertUser(username, password, role) {
  var users = loadUsers();
  var key = String(username).trim().toLowerCase();
  if (!key) throw new Error('Username required');
  var nr = normalizeRole(role) || DEFAULT_ROLE;
  var salt = Utilities.getUuid();
  var prev = users[key] || {};
  users[key] = {
    salt: salt, hash: hashPw(salt, password), role: nr,
    active: prev.active === undefined ? true : prev.active,
    displayName: prev.displayName || '',
    created: prev.created || nowStamp(),
    lastLogin: prev.lastLogin || ''
  };
  saveUsers(users);
  return key;
}

/**
 * Create / recover the MASTER_ADMIN. EDITOR-ONLY — the single secure bootstrap
 * for the highest account; never reachable from the frontend API.
 */
function SET_MASTER_ADMIN() {
  var MASTER_USERNAME = 'master';   // ← edit, then run
  var MASTER_PASSWORD = '';         // ← put password here, run, then blank it again
  if (!MASTER_USERNAME || !MASTER_PASSWORD) throw new Error('Fill in MASTER_USERNAME and MASTER_PASSWORD first.');
  if (MASTER_PASSWORD.length < 8) throw new Error('Use at least 8 characters.');
  upsertUser(MASTER_USERNAME, MASTER_PASSWORD, 'MASTER_ADMIN');
  Logger.log('MASTER_ADMIN "' + MASTER_USERNAME + '" created/updated. Now blank the MASTER_PASSWORD line.');
}

/** Editor helper: create/update a normal user. ADD_USER('jasmine','secretpw','OPERATOR'). */
function ADD_USER(username, password, role) {
  var USERNAME = username || 'ansal';   // ← edit, then run
  var PASSWORD = password || '';        // ← put password here, run, then blank it again
  var ROLE     = role || 'OPERATOR';    // ← ADMIN | OPERATOR | VIEWER (use SET_MASTER_ADMIN for the master)
  if (!USERNAME || !PASSWORD) throw new Error('Fill in USERNAME and PASSWORD first.');
  if (PASSWORD.length < 8) throw new Error('Use at least 8 characters.');
  if (normalizeRole(ROLE) === 'MASTER_ADMIN') throw new Error('Use SET_MASTER_ADMIN() for the master account.');
  if (!normalizeRole(ROLE)) throw new Error('ROLE must be one of ADMIN, OPERATOR, VIEWER.');
  upsertUser(USERNAME, PASSWORD, ROLE);
  Logger.log('User "' + USERNAME + '" created/updated as ' + normalizeRole(ROLE) + '. Now blank the PASSWORD line.');
}

function SET_ROLE(username, role) {
  var USERNAME = username || '';        // ← existing username
  var ROLE     = role || 'ADMIN';       // ← ADMIN | OPERATOR | VIEWER
  if (!USERNAME) throw new Error('Fill in USERNAME first.');
  var nr = normalizeRole(ROLE);
  if (!nr) throw new Error('ROLE must be one of MASTER_ADMIN, ADMIN, OPERATOR, VIEWER.');
  var users = loadUsers();
  var rec = users[USERNAME.toLowerCase()];
  if (!rec) throw new Error('No such user: ' + USERNAME);
  rec.role = nr;
  saveUsers(users);
  Logger.log('User "' + USERNAME + '" role set to ' + nr + '.');
}

function REMOVE_USER(username) {
  var USERNAME = username || '';        // ← edit, then run
  if (!USERNAME) throw new Error('Fill in USERNAME first.');
  var users = loadUsers();
  delete users[USERNAME.toLowerCase()];
  saveUsers(users);
  Logger.log('User "' + USERNAME + '" removed.');
}

function LIST_USERS() {
  var users = loadUsers();
  Logger.log('Users:\n' + (Object.keys(users).map(function (u) {
    return u + ' — ' + (normalizeRole(users[u].role) || DEFAULT_ROLE) + (users[u].active === false ? ' (inactive)' : '');
  }).join('\n') || '(none)'));
}

/** One-time migration: backfill role=OPERATOR + active:true on pre-RBAC records. Idempotent. */
function MIGRATE_ROLES() {
  var users = loadUsers();
  var changed = 0;
  Object.keys(users).forEach(function (u) {
    if (!normalizeRole(users[u].role)) { users[u].role = DEFAULT_ROLE; changed++; }
    if (users[u].active === undefined) users[u].active = true;
  });
  saveUsers(users);
  Logger.log('MIGRATE_ROLES: ' + changed + ' user(s) set to ' + DEFAULT_ROLE +
             '. Ensure at least one MASTER_ADMIN exists (SET_MASTER_ADMIN).');
  return { migrated: changed };
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
  if (rec.active === false) throw new Error('Account is deactivated. Contact an administrator.');

  cache.remove(failKey);
  var token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
  cache.put('tok_' + token, u, SESSION_HOURS * 3600); // auto-expires
  try { rec.lastLogin = nowStamp(); saveUsers(users); } catch (e) {}   // best-effort; never blocks auth
  // role is returned for FRONTEND display only (show/hide controls). The backend
  // re-derives the role server-side on every request; it never trusts this value.
  return { token: token, user: u, hours: SESSION_HOURS, role: getUserRole(u) };
}

function logout(body) {
  if (body.token) CacheService.getScriptCache().remove('tok_' + String(body.token));
  return { loggedOut: true };
}

/** Returns the username for a valid token, or throws. Also the single chokepoint
 *  that blocks a DEACTIVATED account whose session token is still live — every
 *  request path (doGet, doPost, WQE/extract/aiask wrappers) calls this. */
function requireAuth(token) {
  if (!token) throw new Error('Unauthorized — please log in');
  var u = CacheService.getScriptCache().get('tok_' + String(token));
  if (!u) throw new Error('Session expired — please log in again');
  var rec = loadUsers()[u];
  if (rec && rec.active === false) throw new Error('Account is deactivated');
  return u;
}

// ==================== AUTHORIZATION (v4.5 RBAC gate) ====================
// One authoritative permission policy for the whole backend (main router AND the
// Wise Query Engine wrappers). Straight from WHIMS-V4.5-RBAC-SPECIFICATION §5.
// Every write-capable action MUST have an entry here. `assertPermission` runs
// AFTER requireAuth and BEFORE the business function, so a denied call performs
// no sheet write, creates no transaction, and has no side effect.
//
// Two actions are CONDITIONAL:
//   • approveintake — base gate is ADMIN+OPERATOR (VIEWER denied); the ADD_NEW
//     subtype is ADMIN-only and is enforced authoritatively inside approveOne()
//     (where the effective action is known even if the payload omits it).
//   • orderstatus — every defined transition is ADMIN+OPERATOR; VIEWER denied.
//     The RECEIVED transition triggers receiveStock(), which only writes
//     stock/supplier/cost/mfd/expiry — never protected master identity fields.

// Role sets. MASTER_ADMIN is the superuser: it is a member of every set, so it
// clears every gate below; the finer user-management rules (never create/modify
// another MASTER_ADMIN, admins can't make admins) are enforced in the handlers.
var _R_ALL   = { MASTER_ADMIN: 1, ADMIN: 1, OPERATOR: 1, VIEWER: 1 };
var _R_ADMOP = { MASTER_ADMIN: 1, ADMIN: 1, OPERATOR: 1 };   // VIEWER denied
var _R_ADMIN = { MASTER_ADMIN: 1, ADMIN: 1 };                // ADMIN tier and up

var PERMISSIONS = {
  // read / health / auth (all roles)
  ping: _R_ALL, login: _R_ALL, logout: _R_ALL, me: _R_ALL,
  inventory: _R_ALL, transactions: _R_ALL, orders: _R_ALL,
  sourcestats: _R_ALL, sourceanalytics: _R_ALL, aiask: _R_ALL,
  // Wise Query Engine (all roles, read/analysis only)
  smartsearch: _R_ALL, medgroup: _R_ALL, medfacets: _R_ALL,
  planorder: _R_ALL, askwhims: _R_ALL,
  // operational (ADMIN + OPERATOR, + MASTER_ADMIN)
  receive: _R_ADMOP, dispense: _R_ADMOP, priority: _R_ADMOP,
  orderadd: _R_ADMOP, orderplace: _R_ADMOP, orderremove: _R_ADMOP, orderupdate: _R_ADMOP,
  orderstatus: _R_ADMOP,          // conditional — see note above
  stageintake: _R_ADMOP, readintake: _R_ADMOP, extract: _R_ADMOP,
  rejectintake: _R_ADMOP, recentapprovals: _R_ADMOP,
  approveintake: _R_ADMOP,        // conditional — ADD_NEW subtype is ADMIN-only (approveOne)
  stagepackaging: _R_ADMOP,       // v4.5 Wise Printer staging
  // high-risk / master lifecycle (ADMIN + MASTER_ADMIN)
  adjust: _R_ADMIN, archive: _R_ADMIN, restore: _R_ADMIN,
  additem: _R_ADMIN, setcode: _R_ADMIN, undoapprove: _R_ADMIN,
  importmedicines: _R_ADMIN,      // v4.5 append-only bulk import
  // user & role management (ADMIN + MASTER_ADMIN coarse gate; fine rules in handlers)
  listusers: _R_ADMIN, createuser: _R_ADMIN, updateuser: _R_ADMIN,
  changerole: _R_ADMIN, activateuser: _R_ADMIN, deactivateuser: _R_ADMIN, resetpassword: _R_ADMIN
};

function permDenied(role, action) {
  return 'Permission denied: ' + (role || 'UNKNOWN') + ' cannot perform ' + action;
}

/** True if an approveintake payload explicitly declares an ADD_NEW item. */
function approveDeclaresAddNew(body) {
  if (!body) return false;
  var items = (body.items && body.items.length) ? body.items : (body.intakeId ? [body] : []);
  for (var i = 0; i < items.length; i++) {
    if (up(items[i] && items[i].action) === 'ADD_NEW') return true;
  }
  return false;
}

/**
 * Throws Permission denied if `role` may not perform `action`.
 * Actions absent from PERMISSIONS are left for the router's own "Unknown action"
 * handling — every real write-capable action is present in PERMISSIONS above.
 */
function assertPermission(action, role, body) {
  var a = String(action || '').toLowerCase();
  var allowed = PERMISSIONS[a];
  if (!allowed) return;                                   // unknown → router reports it
  if (!allowed[role]) throw new Error(permDenied(role, a));
  // Conditional refinement: block the obvious direct ADD_NEW approval early.
  // ADD_NEW medicine creation requires ADMIN authority (ADMIN or MASTER_ADMIN).
  // (The authoritative guard is inside approveOne(), which also catches sheet-driven ADD_NEW.)
  if (a === 'approveintake' && rankOf(role) < ROLE_RANK.ADMIN && approveDeclaresAddNew(body)) {
    throw new Error(permDenied(role, 'approveintake(ADD_NEW medicine creation)'));
  }
}

// ==================== HTTP ENTRY POINTS ====================

function doGet(e) {
  var action = (e.parameter.action || 'inventory').toLowerCase();
  try {
    if (action === 'ping') return json({ ok: true, message: 'WHIMS backend is live', time: new Date().toISOString() });
    var _guser = requireAuth(e.parameter.token); // everything else needs a session
    assertPermission(action, getUserRole(_guser), e.parameter); // v4.5 RBAC — before any read of restricted queues
    if (action === 'inventory') return json({ ok: true, data: getInventory() });
    if (action === 'transactions') return json({ ok: true, data: getTransactions(Number(e.parameter.limit) || 100) });
    if (action === 'orders') return json({ ok: true, data: getOrders(e.parameter.status) }); // v4.1 purchase lifecycle
    if (action === 'readintake') return json({ ok: true, data: readIntake(e.parameter.status) }); // v4.2 Lens intake queue
    if (action === 'sourcestats') return json({ ok: true, data: sourceStats(e.parameter) });        // v4.3 entry-source analytics
    if (action === 'sourceanalytics') return json({ ok: true, data: sourceAnalytics(e.parameter) }); // NEW — range-aware analytics
    if (action === 'recentapprovals') return json({ ok: true, data: recentApprovals(e.parameter) }); // NEW — undoable approvals
    if (action === 'me') return json({ ok: true, data: { user: _guser, role: getUserRole(_guser) } }); // v4.5 — effective role (source of truth)
    return json({ ok: false, error: 'Unknown action: ' + action });
  } catch (err) {
    return json({ ok: false, error: String(err).replace('Error: ', '') });
  }
}

function doPost(e) {
  // --- Wise Lens (v4.2): 'extract' calls OpenRouter vision, touches NO sheet,
  //     and can take several seconds. Handle it BEFORE taking the script lock so
  //     a slow model call never blocks inventory writes from other devices. ---
  try {
    var peek = JSON.parse(e.postData.contents);
    var peekAction = String(peek.action || '').toLowerCase();
    if (peekAction === 'extract') {
      peek.user = requireAuth(peek.token);
      assertPermission('extract', getUserRole(peek.user), peek);   // v4.5 RBAC — VIEWER denied
      return json({ ok: true, data: lensExtract(peek) });
    }
    if (peekAction === 'aiask') {      // NEW — also slow, also touches no sheet
      peek.user = requireAuth(peek.token);
      assertPermission('aiask', getUserRole(peek.user), peek);     // v4.5 RBAC — all roles allowed
      return json({ ok: true, data: aiAssistantAsk(peek) });
    }
  } catch (err) {
    return json({ ok: false, error: String(err).replace('Error: ', '') });
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var body = JSON.parse(e.postData.contents);
    var action = (body.action || '').toLowerCase();

    if (action === 'login') return json({ ok: true, data: login(body) });
    if (action === 'logout') return json({ ok: true, data: logout(body) });

    body._reqRole = body.role;           // preserve any client-sent role PARAM (e.g. createuser/changerole target role) BEFORE we overwrite it
    body.user = requireAuth(body.token); // user identity comes from the session, not the client
    body.role = getUserRole(body.user);  // trusted server-side actor role — never from the client
    assertPermission(action, body.role, body); // v4.5 RBAC — reject BEFORE any write-capable function runs

    var result;
    if (action === 'receive')       result = receiveStock(body);
    else if (action === 'dispense') result = dispenseStock(body);
    else if (action === 'adjust')   result = adjustStock(body);
    else if (action === 'archive')  result = setActive(body, 'NO', 'ARCHIVE');
    else if (action === 'restore')  result = setActive(body, 'YES', 'RESTORE');
    else if (action === 'priority') result = setPriority(body);
    else if (action === 'additem')  result = addItem(body);   // create a brand-new inventory row (HoloScan)
    else if (action === 'setcode')  result = setCode(body);   // link a scanned barcode to an existing medicine
    // ---- v4.1 purchase lifecycle (Cart → Ordered → Purchased → Received) ----
    else if (action === 'orders')      result = getOrders(body.status);
    else if (action === 'orderadd')    result = orderAdd(body);     // add/merge a CART line (HoloScan & WHIMS)
    else if (action === 'orderplace')  result = orderPlace(body);   // CART → ORDERED (new PO id); optional supplier filter
    else if (action === 'orderstatus') result = orderStatus(body);  // advance a line/order; RECEIVED auto-receives stock
    else if (action === 'orderremove') result = orderRemove(body);  // soft-delete a line (→ VOID)
    else if (action === 'orderupdate') result = orderUpdate(body);  // NEW — edit Qty/Supplier/Priority/Notes on a line
    // ---- v4.2 Wise Lens (vision intake → Intake staging tab → live stock) ----
    else if (action === 'inventory')     result = getInventory();          // Lens reads stock to match against
    else if (action === 'stageintake')   result = stageIntake(body);       // Lens stages a reviewed batch (PENDING)
    else if (action === 'readintake')    result = readIntake(body.status); // WHIMS intake-review screen reads queue
    else if (action === 'approveintake') result = approveIntake(body);     // apply RECEIVE / ADD_NEW to live stock
    else if (action === 'rejectintake')  result = rejectIntake(body);      // soft-reject a pending intake row
    else if (action === 'sourcestats')   result = sourceStats(body);        // v4.3 entry-source analytics
    else if (action === 'undoapprove')   result = undoApproval(body);       // NEW — reverse a still-undoable approval
    // ---- v4.5 Wise Printer packaging bridge (stages DISPENSE rows into the same Intake queue) ----
    else if (action === 'stagepackaging') result = stagePackaging(body);    // v4.5 — Printer stages packaging consumption (PENDING)
    // ---- v4.5 database import (append-only, ADMIN+) ----
    else if (action === 'importmedicines') result = importMedicines(body);  // v4.5 — bulk append, never overwrites
    // ---- v4.5 user & role management (ADMIN + MASTER_ADMIN; handlers enforce fine rules) ----
    else if (USER_ADMIN_ACTIONS.indexOf(action) >= 0) result = userAdmin(action, body);
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
      remarks: str(v[COL.REMARKS - 1]),
      barcode: str(v[COL.BARCODE - 1]),
      // ---- v4.3 audit / provenance (empty on sheets that predate the audit columns) ----
      entrySource: str(v[ACOL.ENTRY - 1]),
      originalSource: str(v[ACOL.ORIG - 1]),
      lastModifiedSource: str(v[ACOL.MOD - 1]),
      captureMode: str(v[ACOL.CAPTURE - 1]),
      createdAt: str(v[ACOL.CREATED_AT - 1]),
      createdBy: str(v[ACOL.CREATED_BY - 1]),
      updatedAt: str(v[ACOL.UPDATED_AT - 1]),
      updatedBy: str(v[ACOL.UPDATED_BY - 1])
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
  // --- v4.5 validate the request BEFORE any sheet access (fail fast). Backend
  // validates independently of the frontend: malformed/NaN/<=0 quantity and
  // negative/malformed cost are rejected here. ---
  var addBottles = requireNumber(body.bottles, 'Received bottles', { gt: 0, integer: true });
  var addMl = null;
  if (body.ml !== undefined && body.ml !== null && body.ml !== '') addMl = requireNumber(body.ml, 'ML received', { min: 0 });
  // Cost rule (v4.5): per-bottle unitCost preferred; total is derived. ZERO cost
  // is PERMITTED (free stock/samples/cost-later); NEGATIVE and malformed REJECTED.
  // Backward compatible: a legacy total `amount` (older clients + internal callers
  // like orderStatus/approveOne) is accepted and per-bottle is derived from it.
  var amount, unitCost;
  if (body.unitCost !== undefined && body.unitCost !== null && body.unitCost !== '') {
    unitCost = requireNumber(body.unitCost, 'Cost per bottle', { min: 0 });
    amount = round2(unitCost * addBottles);
  } else if (body.amount !== undefined && body.amount !== null && body.amount !== '') {
    amount = requireNumber(body.amount, 'Amount', { min: 0 });
    unitCost = amount > 0 ? round2(amount / addBottles) : 0;
  } else {
    amount = 0; unitCost = 0;
  }

  var loc = findMedicine(body.id);
  var sh = loc.sheet, row = loc.row;
  var prevBottles = num(sh.getRange(row, COL.BOTTLES).getValue());
  var newBottles = prevBottles + addBottles;

  sh.getRange(row, COL.BOTTLES).setValue(newBottles);
  if (addMl !== null) {
    var prevMl = num(sh.getRange(row, COL.ML).getValue());
    sh.getRange(row, COL.ML).setValue(prevMl + addMl);
  }
  if (body.supplier) sh.getRange(row, COL.SUP1).setValue(body.supplier);   // company
  if (body.mfd) sh.getRange(row, COL.MFD).setValue(body.mfd);
  if (body.expiry) sh.getRange(row, COL.EXPIRY).setValue(body.expiry);

  // store per-bottle Primary Cost; log the total amount
  if (unitCost > 0) sh.getRange(row, COL.COST1).setValue(unitCost);
  stamp(sh, row);

  var rSrc = resolveSource(body, 'WHIMS'), rCap = resolveCapture(body);
  stampAudit(sh, row, { entrySource: rSrc, captureMode: rCap, user: body.user });
  logTx(loc.id, loc.name, 'RECEIVE', addBottles, prevBottles, newBottles, body.user,
    joinRemarks(body.supplier ? 'From ' + body.supplier : '', body.remarks), amount, rSrc, rCap);
  return { id: loc.id, prevStock: prevBottles, newStock: newBottles };
}

function dispenseStock(body) {
  var qty = requireNumber(body.bottles, 'Dispense quantity', { gt: 0, integer: true });
  var loc = findMedicine(body.id);
  var sh = loc.sheet, row = loc.row;
  var prevBottles = num(sh.getRange(row, COL.BOTTLES).getValue());
  if (qty > prevBottles) throw new Error('Only ' + prevBottles + ' bottle(s) in stock');
  var newBottles = prevBottles - qty;

  sh.getRange(row, COL.BOTTLES).setValue(newBottles);
  if (body.ml !== undefined && body.ml !== null && body.ml !== '') {
    var prevMl = num(sh.getRange(row, COL.ML).getValue());
    sh.getRange(row, COL.ML).setValue(Math.max(0, prevMl - num(body.ml)));
  }
  stamp(sh, row);

  var dSrc = resolveSource(body, 'WHIMS'), dCap = resolveCapture(body);
  stampAudit(sh, row, { entrySource: dSrc, captureMode: dCap, user: body.user });
  logTx(loc.id, loc.name, 'DISPENSE', qty, prevBottles, newBottles, body.user,
    body.remarks, num(body.amount), dSrc, dCap);
  return { id: loc.id, prevStock: prevBottles, newStock: newBottles };
}

function adjustStock(body) {
  var newBottles = requireNumber(body.bottles, 'Bottle count', { min: 0, integer: true });
  var loc = findMedicine(body.id);
  var sh = loc.sheet, row = loc.row;
  var prevBottles = num(sh.getRange(row, COL.BOTTLES).getValue());

  sh.getRange(row, COL.BOTTLES).setValue(newBottles);
  if (body.ml !== undefined && body.ml !== null && body.ml !== '') {
    sh.getRange(row, COL.ML).setValue(num(body.ml));
  }
  if (body.priority !== undefined && body.priority !== null && body.priority !== '') {
    sh.getRange(row, COL.PRIORITY).setValue(num(body.priority));
  }
  stamp(sh, row);

  var aSrc = resolveSource(body, 'WHIMS'), aCap = resolveCapture(body);
  stampAudit(sh, row, { entrySource: aSrc, captureMode: aCap, user: body.user });
  logTx(loc.id, loc.name, 'ADJUSTMENT', newBottles - prevBottles, prevBottles, newBottles, body.user, body.remarks, 0, aSrc, aCap);
  return { id: loc.id, prevStock: prevBottles, newStock: newBottles };
}

function setActive(body, flag, actionName) {
  var loc = findMedicine(body.id);
  var sh = loc.sheet, row = loc.row;
  var bottles = num(sh.getRange(row, COL.BOTTLES).getValue());
  sh.getRange(row, COL.ACTIVE).setValue(flag);
  stamp(sh, row);
  stampAudit(sh, row, { entrySource: resolveSource(body, 'WHIMS'), captureMode: resolveCapture(body), user: body.user });
  logTx(loc.id, loc.name, actionName, 0, bottles, bottles, body.user, body.remarks, 0, resolveSource(body, 'WHIMS'), resolveCapture(body));
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
  stampAudit(sh, row, { entrySource: resolveSource(body, 'WHIMS'), captureMode: resolveCapture(body), user: body.user });
  logTx(loc.id, loc.name, p > 0 ? 'ORDER-ADD' : 'ORDER-REMOVE', 0, bottles, bottles,
    body.user, body.remarks || ('Reorder priority set to ' + p), 0);
  return { id: loc.id, priority: p };
}

// ==================== HELPERS ====================

/** Finds a row by exact ID first, then by any linked barcode alias. Returns null if none. */
function locate(sh, code) {
  code = String(code || '').trim().toUpperCase();
  if (!code) return null;
  var last = sh.getLastRow();
  if (last < 2) return null;
  var cols = Math.min(COL.BARCODE, sh.getMaxColumns());
  var data = sh.getRange(2, 1, last - 1, cols).getValues();
  // pass 1: exact ID match
  for (var i = 0; i < data.length; i++) {
    if (String(data[i][COL.ID - 1]).trim().toUpperCase() === code) {
      return { row: i + 2, id: String(data[i][COL.ID - 1]).trim(), name: String(data[i][COL.NAME - 1]) };
    }
  }
  // pass 2: barcode alias match (comma/space/semicolon separated)
  for (var j = 0; j < data.length; j++) {
    var raw = (COL.BARCODE - 1) < data[j].length ? String(data[j][COL.BARCODE - 1] || '') : '';
    if (!raw) continue;
    var aliases = raw.toUpperCase().split(/[,;\s]+/);
    for (var a = 0; a < aliases.length; a++) {
      if (aliases[a] && aliases[a] === code) {
        return { row: j + 2, id: String(data[j][COL.ID - 1]).trim(), name: String(data[j][COL.NAME - 1]) };
      }
    }
  }
  return null;
}

function findMedicine(id) {
  if (!id) throw new Error('Medicine ID is required');
  var sh = sheet(INVENTORY_SHEET);
  var hit = locate(sh, id);
  if (!hit) throw new Error('Medicine not found: ' + id);
  return { sheet: sh, row: hit.row, id: hit.id, name: hit.name };
}

/** Make sure the Barcode column + header exist (added lazily, like Amount on Transactions). */
function ensureBarcodeHeader(sh) {
  if (sh.getMaxColumns() < COL.BARCODE) sh.insertColumnsAfter(sh.getMaxColumns(), COL.BARCODE - sh.getMaxColumns());
  if (str(sh.getRange(1, COL.BARCODE).getValue()) === '') sh.getRange(1, COL.BARCODE).setValue('Barcode');
}

/** Copies the live Status formula from the row above so a new row stays formula-driven (never a written value). */
function copyStatusFormula(sh, row) {
  if (row <= 2) return;
  var src = sh.getRange(row - 1, COL.STATUS);
  if (src.getFormula()) src.copyTo(sh.getRange(row, COL.STATUS));
}

/** CREATE — add a brand-new inventory row keyed by the scanned code. */
function addItem(body) {
  var code = String(body.id || '').trim().toUpperCase();
  if (!code) throw new Error('A scan code (ID) is required');
  var name = String(body.name || '').trim().toUpperCase();
  if (!name) throw new Error('Medicine name is required');
  var sh = sheet(INVENTORY_SHEET);
  ensureBarcodeHeader(sh);

  var clash = locate(sh, code);
  if (clash) throw new Error('Code ' + code + ' is already in WHIMS (' + clash.name + ')');

  var bottles = num(body.bottles);
  var row = sh.getLastRow() + 1;
  // Build A..R (1..ACTIVE). We deliberately never write S (Status): if the sheet
  // uses an ARRAYFORMULA, writing a literal there would #REF the whole column.
  var head = [];
  for (var c = 0; c < COL.ACTIVE; c++) head.push('');
  head[COL.ID - 1] = code;
  head[COL.NAME - 1] = name;
  head[COL.PACK - 1] = str(body.pack);
  head[COL.POTENCY - 1] = str(body.potency);
  head[COL.CATEGORY - 1] = String(body.category || '').trim().toUpperCase();
  head[COL.BOTTLES - 1] = bottles;
  head[COL.ML - 1] = (body.ml === undefined || body.ml === '') ? '' : num(body.ml);
  head[COL.PRIORITY - 1] = (body.priority === undefined || body.priority === '') ? 0 : num(body.priority);
  head[COL.SUP1 - 1] = str(body.supplier1);
  head[COL.COST1 - 1] = (body.cost1 === undefined || body.cost1 === '') ? '' : num(body.cost1);
  head[COL.SUP2 - 1] = str(body.supplier2);
  head[COL.COST2 - 1] = (body.cost2 === undefined || body.cost2 === '') ? '' : num(body.cost2);
  head[COL.MFD - 1] = str(body.mfd);
  head[COL.EXPIRY - 1] = str(body.expiry);
  head[COL.UPDATED - 1] = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
  head[COL.ACTIVE - 1] = 'YES';
  sh.getRange(row, 1, 1, COL.ACTIVE).setValues([head]);                         // A..R
  sh.getRange(row, COL.REMARKS, 1, 2).setValues([[str(body.remarks), code]]);   // T (remarks) + U (barcode), skipping S
  copyStatusFormula(sh, row);   // restores the live per-row Status formula if the sheet uses one

  var src = resolveSource(body, 'HOLOSCAN');   // additem's legacy caller is HoloScan; Lens passes WISE_LENS
  var cap = resolveCapture(body);
  stampAudit(sh, row, { isNew: true, entrySource: src, captureMode: cap, user: body.user });
  logTx(code, name, 'CREATE', bottles, 0, bottles, body.user,
    joinRemarks('New item · ' + (src || 'WHIMS'), body.remarks), num(body.cost1) || 0, src, cap);
  return { id: code, name: name, bottles: bottles };
}

/** LINK — attach a scanned barcode to an existing medicine (found by its current ID). */
function setCode(body) {
  var targetId = String(body.id || '').trim();
  var code = String(body.code || '').trim().toUpperCase();
  if (!targetId) throw new Error('Choose which medicine to link the code to');
  if (!code) throw new Error('No scan code provided');
  var sh = sheet(INVENTORY_SHEET);
  ensureBarcodeHeader(sh);

  var loc = findMedicine(targetId);
  var owner = locate(sh, code);
  if (owner && owner.row !== loc.row) throw new Error('Code ' + code + ' is already linked to ' + owner.name);

  var cell = sh.getRange(loc.row, COL.BARCODE);
  var cur = String(cell.getValue() || '').trim();
  var aliases = cur ? cur.split(/[,;\s]+/).filter(function (x) { return x; }) : [];
  var have = aliases.map(function (x) { return x.toUpperCase(); });
  if (have.indexOf(code) === -1) { aliases.push(code); cell.setValue(aliases.join(', ')); }
  stamp(sh, loc.row);
  stampAudit(sh, loc.row, { entrySource: resolveSource(body, 'HOLOSCAN'), captureMode: resolveCapture(body), user: body.user });

  logTx(loc.id, loc.name, 'LINK-CODE', 0, 0, 0, body.user, joinRemarks('Linked scan code ' + code, body.remarks), 0);
  return { id: loc.id, name: loc.name, code: code, barcodes: aliases.join(', ') };
}

function logTx(id, name, action, qty, prev, next, user, remarks, amount, source, capture) {
  var sh = sheet(TRANSACTIONS_SHEET);
  // make sure Amount (v2) + Source/Capture (v4.3) columns exist — added lazily, never reordered
  if (sh.getMaxColumns() < 13) sh.insertColumnsAfter(sh.getMaxColumns(), 13 - sh.getMaxColumns());
  if (str(sh.getRange(1, 11).getValue()) === '') sh.getRange(1, 11).setValue('Amount ₹');
  if (str(sh.getRange(1, 12).getValue()) === '') sh.getRange(1, 12).setValue('Source');
  if (str(sh.getRange(1, 13).getValue()) === '') sh.getRange(1, 13).setValue('Capture Mode');
  var txId = 'TXN' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMddHHmmss') + Math.floor(Math.random() * 90 + 10);
  sh.appendRow([txId, Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss'),
    id, name, action, qty, prev, next, user || 'Staff', remarks || '', num(amount) || '', source || '', capture || '']);
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

// ---- v4.5 strict numeric validation (never silently coerces junk to 0) ----
/** NaN for null/blank/malformed strings; a finite number otherwise. */
function parseNum(v) {
  if (v === null || v === undefined || v === '') return NaN;
  if (typeof v === 'number') return isFinite(v) ? v : NaN;
  var s = String(v).trim();
  if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(s)) return NaN;   // reject "abc","1.2.3","5x","1e3",""
  var n = Number(s);
  return isFinite(n) ? n : NaN;
}
/** Validate a required numeric input. opts: {gt, min, max, integer}. Throws on violation. */
function requireNumber(v, name, opts) {
  opts = opts || {};
  var n = parseNum(v);
  if (isNaN(n)) throw new Error(name + ' must be a valid number');
  if (opts.integer && n % 1 !== 0) throw new Error(name + ' must be a whole number');
  if (opts.gt !== undefined && !(n > opts.gt)) throw new Error(name + ' must be greater than ' + opts.gt);
  if (opts.min !== undefined && n < opts.min) throw new Error(name + ' must be at least ' + opts.min);
  if (opts.max !== undefined && n > opts.max) throw new Error(name + ' must be at most ' + opts.max);
  return n;
}
function round2(n) { return Math.round(n * 100) / 100; }

// ============================================================================
// v4.5 — DATABASE IMPORT  (append-only; never overwrites an existing row)
// ============================================================================
// SAFETY: a row whose ID already exists, or whose Name+Potency+Pack matches an
// existing medicine, is skipped. New rows are created through the existing
// addItem() engine (audit + Transactions CREATE), with IDs minted by the same
// mintCode() used by Lens ADD_NEW. Existing stock/IDs/history are untouched.
// ADMIN + MASTER_ADMIN only (gated in doPost via PERMISSIONS).
function importMedicines(body) {
  var rows = body.rows;
  if (!rows || !rows.length) throw new Error('No rows to import');
  if (rows.length > 2000) throw new Error('Too many rows in one import (max 2000)');
  var inv = sheet(INVENTORY_SHEET);
  ensureBarcodeHeader(inv);

  function nk(s) { return String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, ''); }
  function comboKey(r) { return nk(r.name) + '|' + nk(r.potency) + '|' + nk(r.pack); }

  var existing = getInventory();
  var haveCombo = {};
  existing.forEach(function (m) { haveCombo[comboKey(m)] = true; });

  var added = 0, skipped = 0, ids = [], errors = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i] || {};
    try {
      if (!r.name || String(r.name).trim() === '') { skipped++; errors.push({ row: i + 1, error: 'missing name' }); continue; }
      // numeric sanity — reject malformed, don't coerce to 0
      if (r.bottles !== undefined && r.bottles !== '' && r.bottles !== null) requireNumber(r.bottles, 'bottles', { min: 0 });
      if (r.cost1 !== undefined && r.cost1 !== '' && r.cost1 !== null) requireNumber(r.cost1, 'cost', { min: 0 });
      var providedId = String(r.id || '').trim().toUpperCase();
      if (providedId && locate(inv, providedId)) { skipped++; errors.push({ row: i + 1, error: 'id exists' }); continue; }
      if (haveCombo[comboKey(r)]) { skipped++; errors.push({ row: i + 1, error: 'duplicate name+potency+pack' }); continue; }

      var code = providedId || mintCode(r.category, r.pack, r.potency, inv);
      addItem({
        id: code, name: r.name, pack: r.pack, potency: r.potency, category: r.category,
        bottles: (r.bottles === '' || r.bottles == null) ? 0 : num(r.bottles),
        ml: r.ml, priority: r.priority,
        supplier1: r.supplier1, cost1: r.cost1, supplier2: r.supplier2, cost2: r.cost2,
        mfd: r.mfd, expiry: r.expiry, remarks: r.remarks,
        entrySource: 'IMPORT_TOOL', captureMode: 'IMPORT', user: body.user
      });
      haveCombo[comboKey(r)] = true;
      added++; ids.push(code);
    } catch (e) {
      skipped++; errors.push({ row: i + 1, error: String(e.message || e).replace('Error: ', '') });
    }
  }
  return { added: added, skipped: skipped, ids: ids, errors: errors };
}

// ============================================================================
// v4.5 — USER & ROLE MANAGEMENT  (frontend, authorised)
// ----------------------------------------------------------------------------
// Coarse gate (ADMIN + MASTER_ADMIN) is applied by PERMISSIONS/assertPermission
// in doPost. These handlers enforce the FINE rules: canAssignRole (an ADMIN may
// not create ADMINs; nobody may mint a MASTER_ADMIN via the API) and
// canManageTarget (a MASTER_ADMIN target is untouchable via the API). The actor
// is body.user with trusted role body.role; the REQUESTED role for
// create/changerole is body._reqRole (the client's role param, preserved before
// doPost overwrote body.role with the actor role).
// ============================================================================

var USER_ADMIN_ACTIONS = ['listusers', 'createuser', 'updateuser', 'changerole',
  'activateuser', 'deactivateuser', 'resetpassword'];

function userAdmin(action, body) {
  if (rankOf(body.role) < ROLE_RANK.ADMIN) throw new Error(permDenied(body.role, 'user management'));
  if (action === 'listusers') return listUsersApi(body);
  if (action === 'createuser') return createUser(body);
  if (action === 'updateuser') return updateUser(body);
  if (action === 'changerole') return changeRole(body);
  if (action === 'activateuser') return setUserActive(body, true);
  if (action === 'deactivateuser') return setUserActive(body, false);
  if (action === 'resetpassword') return resetPassword(body);
  throw new Error('Unknown action: ' + action);
}

/** Safe public view — NEVER includes salt, hash, or any secret. */
function publicUser(username, rec) {
  return {
    username: username, displayName: rec.displayName || '',
    role: normalizeRole(rec.role) || DEFAULT_ROLE, active: rec.active !== false,
    created: rec.created || '', lastLogin: rec.lastLogin || ''
  };
}

function listUsersApi(body) {
  var users = loadUsers();
  var out = Object.keys(users).sort().map(function (u) { return publicUser(u, users[u]); });
  return { users: out, actorRole: body.role };
}

function requireTargetName(body) {
  var key = String(body.username || '').trim().toLowerCase();
  if (!key) throw new Error('Username required');
  if (!/^[a-z0-9._-]{2,40}$/.test(key)) throw new Error('Username must be 2–40 chars: letters, digits, . _ -');
  return key;
}
function validatePassword(pw) {
  pw = String(pw == null ? '' : pw);
  if (pw.length < 8) throw new Error('Password must be at least 8 characters');
  if (pw.length > 200) throw new Error('Password is too long');
  return pw;
}

function createUser(body) {
  var key = requireTargetName(body);
  var role = normalizeRole(body._reqRole);
  if (!role) throw new Error('A valid role is required');
  if (!canAssignRole(body.role, role)) throw new Error(permDenied(body.role, 'create a ' + (normalizeRole(body._reqRole) || 'that') + ' account'));
  var pw = validatePassword(body.password);
  var users = loadUsers();
  if (users[key]) throw new Error('That username already exists');
  upsertUser(key, pw, role);
  if (body.displayName) { var u2 = loadUsers(); u2[key].displayName = String(body.displayName).slice(0, 80); saveUsers(u2); }
  return publicUser(key, loadUsers()[key]);   // no password / hash / salt
}

/** Load a target user, enforcing the manage-target rule. */
function loadManageableTarget(body) {
  var key = requireTargetName(body);
  var users = loadUsers();
  var rec = users[key];
  if (!rec) throw new Error('No such user');
  var targetRole = normalizeRole(rec.role) || DEFAULT_ROLE;
  if (!canManageTarget(body.role, targetRole)) throw new Error(permDenied(body.role, 'manage this account'));
  return { key: key, users: users, rec: rec, targetRole: targetRole };
}

function updateUser(body) {
  var t = loadManageableTarget(body);
  if (body.displayName !== undefined) t.rec.displayName = String(body.displayName || '').slice(0, 80);
  saveUsers(t.users);
  return publicUser(t.key, t.rec);
}

function changeRole(body) {
  var t = loadManageableTarget(body);
  var newRole = normalizeRole(body._reqRole);
  if (!newRole) throw new Error('A valid role is required');
  if (!canAssignRole(body.role, newRole)) throw new Error(permDenied(body.role, 'assign the ' + (normalizeRole(body._reqRole) || 'requested') + ' role'));
  t.rec.role = newRole;
  saveUsers(t.users);
  return publicUser(t.key, t.rec);
}

function setUserActive(body, active) {
  var t = loadManageableTarget(body);
  if (t.key === String(body.user).toLowerCase()) throw new Error('You cannot change your own active status');
  t.rec.active = !!active;
  saveUsers(t.users);
  return publicUser(t.key, t.rec);
}

function resetPassword(body) {
  var t = loadManageableTarget(body);
  var pw = validatePassword(body.password);
  var salt = Utilities.getUuid();
  t.rec.salt = salt;
  t.rec.hash = hashPw(salt, pw);
  saveUsers(t.users);
  return { username: t.key, reset: true };    // password NEVER returned
}

// ============================================================================
// v4.1 PURCHASE LIFECYCLE  (additive — new "Orders" tab, never touches col S)
// ============================================================================

var ORDERS_SHEET = 'Orders';
var OSTATUS = { CART: 0, ORDERED: 1, PURCHASED: 2, RECEIVED: 3, VOID: 99 };
var OCOL = {
  LINE_ID: 1, ORDER_ID: 2, CREATED: 3, MED_ID: 4, MED_NAME: 5, PACK: 6,
  SUPPLIER: 7, QTY_ORDERED: 8, QTY_RECEIVED: 9, UNIT_COST: 10, STATUS: 11,
  UPDATED: 12, UPDATED_BY: 13, REMARKS: 14, PRIORITY: 15
};
var OCOLS = 15;
var OHEADERS = ['Order Line ID', 'Order ID', 'Created', 'Medicine ID', 'Medicine Name',
  'Pack', 'Supplier', 'Qty Ordered', 'Qty Received', 'Unit Cost', 'Status',
  'Last Updated', 'Updated By', 'Remarks', 'Priority'];

function ensureOrdersSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(ORDERS_SHEET);
  if (!sh) sh = ss.insertSheet(ORDERS_SHEET);
  if (str(sh.getRange(1, 1).getValue()) === '') {
    sh.getRange(1, 1, 1, OCOLS).setValues([OHEADERS]);
  }
  return sh;
}

function oNow() { return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss'); }
function oStamp(sh, row, user) {
  sh.getRange(row, OCOL.UPDATED).setValue(oNow());
  sh.getRange(row, OCOL.UPDATED_BY).setValue(user || 'Staff');
}

function getOrders(status) {
  var sh = ensureOrdersSheet();
  var last = sh.getLastRow();
  if (last < 2) return [];
  var data = sh.getRange(2, 1, last - 1, OCOLS).getValues();
  var want = String(status || 'active').toUpperCase();
  var out = [];
  for (var i = 0; i < data.length; i++) {
    var v = data[i];
    if (!v[OCOL.LINE_ID - 1]) continue;
    var st = String(v[OCOL.STATUS - 1] || '').toUpperCase();
    if (want === 'ACTIVE' && st === 'VOID') continue;
    if (want !== 'ACTIVE' && want !== 'ALL' && st !== want) continue;
    out.push({
      lineId: str(v[OCOL.LINE_ID - 1]), orderId: str(v[OCOL.ORDER_ID - 1]),
      created: str(v[OCOL.CREATED - 1]), medId: str(v[OCOL.MED_ID - 1]),
      medName: str(v[OCOL.MED_NAME - 1]), pack: str(v[OCOL.PACK - 1]),
      supplier: str(v[OCOL.SUPPLIER - 1]), qtyOrdered: num(v[OCOL.QTY_ORDERED - 1]),
      qtyReceived: num(v[OCOL.QTY_RECEIVED - 1]), unitCost: num(v[OCOL.UNIT_COST - 1]),
      status: st, updated: str(v[OCOL.UPDATED - 1]), updatedBy: str(v[OCOL.UPDATED_BY - 1]),
      remarks: str(v[OCOL.REMARKS - 1]), priority: num(v[OCOL.PRIORITY - 1]), row: i + 2
    });
  }
  return out.reverse();
}

function bridgeSetPriority(medId, p, opts) {
  opts = opts || {};
  var inv = sheet(INVENTORY_SHEET);
  var hit = locate(inv, medId);
  if (!hit) return;
  var cur = num(inv.getRange(hit.row, COL.PRIORITY).getValue());
  var next = opts.atLeast ? Math.max(cur, p) : p;
  if (next !== cur) { inv.getRange(hit.row, COL.PRIORITY).setValue(next); stamp(inv, hit.row); }
}

function findCartLine(sh, medId) {
  var last = sh.getLastRow();
  if (last < 2) return null;
  var data = sh.getRange(2, 1, last - 1, OCOLS).getValues();
  var id = String(medId).trim().toUpperCase();
  for (var i = 0; i < data.length; i++) {
    if (String(data[i][OCOL.STATUS - 1] || '').toUpperCase() === 'CART' &&
        String(data[i][OCOL.MED_ID - 1]).trim().toUpperCase() === id) {
      return { row: i + 2 };
    }
  }
  return null;
}

function orderAdd(body) {
  var med = findMedicine(body.id);
  var inv = sheet(INVENTORY_SHEET);
  var pack = str(inv.getRange(med.row, COL.PACK).getValue());
  var sup = str(body.supplier) || str(inv.getRange(med.row, COL.SUP1).getValue());
  var qty = num(body.qty); if (qty <= 0) qty = 1;
  var cost = (body.unitCost === undefined || body.unitCost === '' || body.unitCost === null) ? '' : num(body.unitCost);
  var sh = ensureOrdersSheet();

  var existing = findCartLine(sh, med.id);
  var lineId, orderId = 'CART';
  if (existing) {
    var row = existing.row;
    sh.getRange(row, OCOL.QTY_ORDERED).setValue(qty);
    if (sup) sh.getRange(row, OCOL.SUPPLIER).setValue(sup);
    if (cost !== '') sh.getRange(row, OCOL.UNIT_COST).setValue(cost);
    if (body.remarks) sh.getRange(row, OCOL.REMARKS).setValue(str(body.remarks));
    oStamp(sh, row, body.user);
    lineId = str(sh.getRange(row, OCOL.LINE_ID).getValue());
  } else {
    lineId = 'OL' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMddHHmmss') + Math.floor(Math.random() * 90 + 10);
    sh.appendRow([lineId, orderId, oNow(), med.id, med.name, pack, sup, qty, '', cost, 'CART', oNow(), body.user || 'Staff', str(body.remarks), num(body.priority) || 0]);
  }
  bridgeSetPriority(med.id, 3, { atLeast: true });
  logTx(med.id, med.name, 'ORDER-ADD', qty, 0, 0, body.user, joinRemarks('Cart · qty ' + qty + (sup ? ' · ' + sup : ''), body.remarks), cost !== '' ? cost * qty : 0);
  return { lineId: lineId, orderId: orderId, medId: med.id, medName: med.name, qty: qty, supplier: sup, status: 'CART' };
}

function orderPlace(body) {
  var sh = ensureOrdersSheet();
  var supFilter = String(body.supplier || '').trim().toUpperCase();
  var last = sh.getLastRow();
  if (last < 2) throw new Error('Nothing in the cart to order');
  var data = sh.getRange(2, 1, last - 1, OCOLS).getValues();
  var orderId = 'PO' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMddHHmm') + Math.floor(Math.random() * 90 + 10);
  var count = 0;
  for (var i = 0; i < data.length; i++) {
    if (String(data[i][OCOL.STATUS - 1] || '').toUpperCase() !== 'CART') continue;
    if (supFilter && String(data[i][OCOL.SUPPLIER - 1] || '').trim().toUpperCase() !== supFilter) continue;
    var row = i + 2;
    sh.getRange(row, OCOL.ORDER_ID).setValue(orderId);
    sh.getRange(row, OCOL.STATUS).setValue('ORDERED');
    oStamp(sh, row, body.user);
    count++;
  }
  if (!count) throw new Error(supFilter ? 'No cart items for that supplier' : 'Nothing in the cart to order');
  return { orderId: orderId, count: count, supplier: supFilter || null };
}

function orderTargets(sh, body) {
  var last = sh.getLastRow();
  if (last < 2) return [];
  var data = sh.getRange(2, 1, last - 1, OCOLS).getValues();
  var lineId = String(body.lineId || '').trim();
  var orderId = String(body.orderId || '').trim();
  var rows = [];
  for (var i = 0; i < data.length; i++) {
    var v = data[i];
    if (lineId && String(v[OCOL.LINE_ID - 1]).trim() === lineId) rows.push({ row: i + 2, v: v });
    else if (!lineId && orderId && String(v[OCOL.ORDER_ID - 1]).trim() === orderId) rows.push({ row: i + 2, v: v });
  }
  return rows;
}

function medHasActiveOrder(sh, medId, exceptRow) {
  var last = sh.getLastRow(); if (last < 2) return false;
  var data = sh.getRange(2, 1, last - 1, OCOLS).getValues();
  var id = String(medId).trim().toUpperCase();
  for (var i = 0; i < data.length; i++) {
    if ((i + 2) === exceptRow) continue;
    var st = String(data[i][OCOL.STATUS - 1] || '').toUpperCase();
    if (String(data[i][OCOL.MED_ID - 1]).trim().toUpperCase() === id &&
        st !== 'VOID' && st !== 'RECEIVED') return true;
  }
  return false;
}

function orderStatus(body) {
  var next = String(body.status || '').trim().toUpperCase();
  if (!(next in OSTATUS)) throw new Error('Unknown status: ' + body.status);
  var sh = ensureOrdersSheet();
  var targets = orderTargets(sh, body);
  if (!targets.length) throw new Error('Order line not found');
  var updated = 0;
  for (var t = 0; t < targets.length; t++) {
    var row = targets[t].row, v = targets[t].v;
    var cur = String(v[OCOL.STATUS - 1] || 'CART').toUpperCase();
    if (cur === 'VOID') continue;
    if (next !== 'VOID' && OSTATUS[next] < OSTATUS[cur]) continue;
    if (next === cur && cur !== 'RECEIVED') { /* idempotent move */ }

    if (next === 'RECEIVED' && cur !== 'RECEIVED') {
      var medId = str(v[OCOL.MED_ID - 1]);
      var qty = num(v[OCOL.QTY_ORDERED - 1]) || 0;
      var cost = num(v[OCOL.UNIT_COST - 1]) || 0;
      if (qty > 0) {
        receiveStock({
          id: medId, bottles: qty, supplier: str(v[OCOL.SUPPLIER - 1]),
          amount: cost > 0 ? cost * qty : 0, user: body.user,
          remarks: joinRemarks('Received PO ' + str(v[OCOL.ORDER_ID - 1]), body.remarks)
        });
        sh.getRange(row, OCOL.QTY_RECEIVED).setValue(qty);
      }
      bridgeSetPriority(medId, 0);
    }
    if (next === 'VOID') {
      var mid = str(v[OCOL.MED_ID - 1]);
      if (!medHasActiveOrder(sh, mid, row)) bridgeSetPriority(mid, 0);
    }
    sh.getRange(row, OCOL.STATUS).setValue(next);
    oStamp(sh, row, body.user);
    updated++;
  }
  if (!updated) throw new Error('No lines changed (already at or past "' + next + '")');
  return { updated: updated, status: next };
}

function orderRemove(body) {
  body.status = 'VOID';
  return orderStatus(body);
}

/** UPDATE — Phase A Smart Order Engine: edit Quantity/Supplier/Priority/Notes on one
 *  line in place. Order-line fields only — never touches Inventory (no bridgeSetPriority,
 *  no stock write). Only allowed before the order is placed (CART) or while still ORDERED;
 *  PURCHASED/RECEIVED/VOID lines are historical and not editable. */
function orderUpdate(body) {
  var sh = ensureOrdersSheet();
  var targets = orderTargets(sh, { lineId: body.lineId });
  if (!targets.length) throw new Error('Order line not found');
  var row = targets[0].row, v = targets[0].v;
  var cur = String(v[OCOL.STATUS - 1] || 'CART').toUpperCase();
  if (cur === 'PURCHASED' || cur === 'RECEIVED' || cur === 'VOID') throw new Error('Cannot edit a ' + cur.toLowerCase() + ' line');

  if (body.qty !== undefined && body.qty !== '' && body.qty !== null) {
    var q = num(body.qty); if (q <= 0) throw new Error('Quantity must be greater than 0');
    sh.getRange(row, OCOL.QTY_ORDERED).setValue(q);
  }
  if (body.supplier !== undefined) sh.getRange(row, OCOL.SUPPLIER).setValue(str(body.supplier));
  if (body.priority !== undefined) {
    var p = num(body.priority);
    if (p < 0 || p > 5) throw new Error('Priority must be between 0 and 5');
    sh.getRange(row, OCOL.PRIORITY).setValue(p);
  }
  if (body.remarks !== undefined) sh.getRange(row, OCOL.REMARKS).setValue(str(body.remarks));
  if (body.unitCost !== undefined && body.unitCost !== '') sh.getRange(row, OCOL.UNIT_COST).setValue(num(body.unitCost));
  oStamp(sh, row, body.user);
  return { lineId: str(v[OCOL.LINE_ID - 1]), updated: true };
}

// ============================================================================
// v4.2  WISE LENS  (additive — vision intake → "Intake" staging tab → live stock)
// ============================================================================

var INTAKE_SHEET = 'Intake';
var LENS_MODEL_DEFAULT = 'google/gemini-2.5-flash';

const LENS_TOKEN_LIMITS = {
  bill: 1500,
  cover: 800,
  voice: 1000
};

var ICOL = {
  ID: 1, CAPTURED: 2, SOURCE: 3, ACTION: 4, MATCH_ID: 5, PROPOSED_ID: 6,
  NAME: 7, PACK: 8, POTENCY: 9, CATEGORY: 10, QTY: 11, UNIT_COST: 12,
  SUPPLIER: 13, MFD: 14, EXPIRY: 15, BARCODE: 16, CONFIDENCE: 17,
  STATUS: 18, RESULT_ID: 19, REVIEWED: 20, REVIEWED_BY: 21, NOTES: 22
};
var ICOLS = 22;
var IHEADERS = ['Intake ID', 'Captured At', 'Source', 'Action', 'Matched ID', 'Proposed ID',
  'Name', 'Pack', 'Potency', 'Category', 'Qty', 'Unit Cost', 'Supplier', 'MFD', 'Expiry',
  'Barcode', 'Confidence', 'Status', 'Result ID', 'Reviewed At', 'Reviewed By', 'Notes'];

var CODE_SEED = {
  MT: 372, MTS: 332, DL: 4207, DLXX: 4192, DLX: 3858, BC: 37,
  EX: 7, OIL: 5, CM: 5, GLYC: 1, LACTO: 1, SL: 3,
  LMTW: 8553, LMTH: 8553, LMEGT: 8550
};

function up(v) { return String(v == null ? '' : v).trim().toUpperCase(); }

function ensureIntakeSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(INTAKE_SHEET);
  if (!sh) {
    sh = ss.insertSheet(INTAKE_SHEET);
    sh.getRange(1, 1, 1, ICOLS).setValues([IHEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.getRange(2, ICOL.BARCODE, sh.getMaxRows() - 1, 1).setNumberFormat('@');
  } else if (str(sh.getRange(1, 1).getValue()) === '') {
    sh.getRange(1, 1, 1, ICOLS).setValues([IHEADERS]).setFontWeight('bold');
  }
  return sh;
}

function stageIntake(body) {
  var rows = body.rows || [];
  if (!rows.length) throw new Error('No rows to stage');
  var sh = ensureIntakeSheet();
  var ts = oNow();
  var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMddHHmmss');
  var ids = [];
  var matrix = rows.map(function (r, i) {
    var iid = 'INK' + stamp + ('0' + (i + 1)).slice(-2) + Math.floor(Math.random() * 900 + 100);
    ids.push(iid);
    return [
      iid, ts, str(r.source), up(r.action), up(r.matchedId), up(r.proposedId),
      str(r.name), str(r.pack), str(r.potency), up(r.category),
      (r.qty === '' || r.qty == null) ? '' : num(r.qty),
      (r.unitCost === '' || r.unitCost == null) ? '' : num(r.unitCost),
      str(r.supplier), str(r.mfd), str(r.expiry),
      r.barcode != null ? String(r.barcode) : '', str(r.confidence),
      'pending', '', '', '', str(r.notes)
    ];
  });
  sh.getRange(sh.getLastRow() + 1, 1, matrix.length, ICOLS).setValues(matrix);
  return { staged: matrix.length, intakeIds: ids };
}

function readIntake(status) {
  var sh = ensureIntakeSheet();
  var last = sh.getLastRow();
  if (last < 2) return [];
  var data = sh.getRange(2, 1, last - 1, ICOLS).getValues();
  var want = up(status || 'pending');
  var out = [];
  for (var i = 0; i < data.length; i++) {
    var v = data[i];
    if (!v[ICOL.ID - 1]) continue;
    var st = up(v[ICOL.STATUS - 1]) || 'PENDING';
    if (want !== 'ALL' && st !== want) continue;
    out.push({
      intakeId: str(v[ICOL.ID - 1]), captured: str(v[ICOL.CAPTURED - 1]),
      source: str(v[ICOL.SOURCE - 1]), action: str(v[ICOL.ACTION - 1]),
      matchedId: str(v[ICOL.MATCH_ID - 1]), proposedId: str(v[ICOL.PROPOSED_ID - 1]),
      name: str(v[ICOL.NAME - 1]), pack: str(v[ICOL.PACK - 1]),
      potency: str(v[ICOL.POTENCY - 1]), category: str(v[ICOL.CATEGORY - 1]),
      qty: num(v[ICOL.QTY - 1]), unitCost: num(v[ICOL.UNIT_COST - 1]),
      supplier: str(v[ICOL.SUPPLIER - 1]), mfd: str(v[ICOL.MFD - 1]),
      expiry: str(v[ICOL.EXPIRY - 1]), barcode: str(v[ICOL.BARCODE - 1]),
      confidence: str(v[ICOL.CONFIDENCE - 1]), status: st,
      resultId: str(v[ICOL.RESULT_ID - 1]), row: i + 2
    });
  }
  return out.reverse();
}

function locateIntake(sh, intakeId) {
  var id = String(intakeId || '').trim();
  if (!id) return null;
  var last = sh.getLastRow();
  if (last < 2) return null;
  var ids = sh.getRange(2, ICOL.ID, last - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]).trim() === id) return { row: i + 2, id: id };
  }
  return null;
}

// ---- v4.5 RBAC: intake-approval capability guard (shared by the atomic pre-pass
//      in approveIntake AND by approveOne itself, so it holds no matter how
//      approveOne is reached). Resolves the EFFECTIVE action/matchId/barcode from
//      the payload override OR the sheet row, then applies the ADD_NEW and barcode
//      rules. Read-only — never writes. Throws Permission denied when disallowed. ---
function assertApproveItemAllowed(sh, ref, ov) {
  var role = normalizeRole(ov && ov.role) || DEFAULT_ROLE;
  if (rankOf(role) >= ROLE_RANK.ADMIN) return;          // ADMIN / MASTER_ADMIN may do everything below
  var get = function (c) { return str(sh.getRange(ref.row, c).getValue()); };
  var has = function (k) { return ov[k] !== undefined && ov[k] !== null; };
  var action  = up(has('action') ? ov.action : get(ICOL.ACTION));
  var matchId = up(has('matchedId') ? ov.matchedId : get(ICOL.MATCH_ID));
  var barcode = up(has('barcode') ? ov.barcode : get(ICOL.BARCODE));
  if (action === 'ADD_NEW') {
    // Bypass 1 / Path A — new-medicine creation through Lens approval is ADMIN-only.
    throw new Error(permDenied(role, 'approveintake(ADD_NEW medicine creation)'));
  }
  if (barcode && matchId && barcode !== up(matchId) && !barcodeBelongsTo(matchId, barcode)) {
    // Bypass 2 / Path B — introducing/changing a barcode via approval is ADMIN-only,
    // unless the barcode already belongs to the matched medicine.
    throw new Error(permDenied(role, 'barcode assignment via Lens approval'));
  }
}

function approveIntake(body) {
  var sh = ensureIntakeSheet();
  var items = body.items && body.items.length ? body.items
            : (body.intakeId ? [body] : []);
  if (!items.length) throw new Error('No intake item to approve');

  // Pass 1 — resolve refs and AUTHORIZE EVERY item before executing ANY. This makes
  // a mixed batch (e.g. one RECEIVE + one sheet-driven ADD_NEW) fail atomically for
  // a non-ADMIN, so no earlier item's stock write can partially commit.
  var plan = [];
  for (var i = 0; i < items.length; i++) {
    var ov = items[i];
    ov.user = body.user;
    ov.role = body.role;   // trusted server-side role
    var ref = locateIntake(sh, ov.intakeId);
    plan.push({ ov: ov, ref: ref });
    if (ref) assertApproveItemAllowed(sh, ref, ov);   // throws → whole call denied, nothing written
  }

  // Pass 2 — execute (approveOne re-checks the same guard as defense in depth).
  var results = [];
  for (var j = 0; j < plan.length; j++) {
    if (!plan[j].ref) { results.push({ intakeId: plan[j].ov.intakeId, error: 'not found' }); continue; }
    results.push(approveOne(sh, plan[j].ref, plan[j].ov));
  }
  var done = results.filter(function (r) { return r.resultId; }).length;
  return { approved: done, results: results };
}

function approveOne(sh, ref, ov) {
  var row = ref.row;
  var get = function (c) { return str(sh.getRange(row, c).getValue()); };
  if (up(get(ICOL.STATUS)) !== 'PENDING') return { intakeId: ref.id, skipped: 'already ' + get(ICOL.STATUS) };

  var has = function (k) { return ov[k] !== undefined && ov[k] !== null; };
  var rec = {
    action:   up(has('action') ? ov.action : get(ICOL.ACTION)),
    matchId:  up(has('matchedId') ? ov.matchedId : get(ICOL.MATCH_ID)),
    name:     has('name') ? str(ov.name) : get(ICOL.NAME),
    pack:     has('pack') ? str(ov.pack) : get(ICOL.PACK),
    potency:  has('potency') ? str(ov.potency) : get(ICOL.POTENCY),
    category: has('category') ? str(ov.category) : get(ICOL.CATEGORY),
    qty:      num(has('qty') ? ov.qty : get(ICOL.QTY)),
    unitCost: num(has('unitCost') ? ov.unitCost : get(ICOL.UNIT_COST)),
    supplier: has('supplier') ? str(ov.supplier) : get(ICOL.SUPPLIER),
    mfd:      has('mfd') ? str(ov.mfd) : get(ICOL.MFD),
    expiry:   has('expiry') ? str(ov.expiry) : get(ICOL.EXPIRY),
    barcode:  has('barcode') ? str(ov.barcode) : get(ICOL.BARCODE)
  };

  // ---- v4.5 RBAC capability guard (authoritative; runs BEFORE any stock write so a
  //      denial never partially executes). Same shared check the approveIntake pre-pass
  //      uses — catches the indirect "OPERATOR approves a sheet-driven ADD_NEW" and
  //      unauthorized-barcode paths even if approveOne is reached by another route.
  assertApproveItemAllowed(sh, ref, ov);

  var lensCap = resolveCapture(ov) || 'CAMERA';
  var resultId;
  if (rec.action === 'DISPENSE') {
    // v4.5 — Wise Printer packaging consumption: approval REDUCES stock via the
    // existing dispenseStock() engine (same validation, audit and Transactions
    // logging as every other dispense). Source travels from the intake row so
    // Transactions show WISE_PRINTER; the prescription id rides in Supplier/Notes.
    if (!rec.matchId) throw new Error('Intake ' + ref.id + ': no matched item to dispense from');
    if (rec.qty <= 0) throw new Error('Intake ' + ref.id + ': quantity must be greater than 0');
    var rowSrc = up(str(sh.getRange(row, ICOL.SOURCE).getValue()));
    dispenseStock({
      id: rec.matchId, bottles: rec.qty, user: ov.user,
      entrySource: SOURCES[rowSrc] ? rowSrc : 'WISE_PRINTER', captureMode: resolveCapture(ov) || 'API',
      remarks: joinRemarks('Packaging · intake ' + ref.id, str(sh.getRange(row, ICOL.NOTES).getValue()))
    });
    resultId = rec.matchId;
  } else if (rec.action === 'RECEIVE') {
    if (!rec.matchId) throw new Error('Intake ' + ref.id + ': no matched medicine to receive into');
    if (rec.qty <= 0) throw new Error('Intake ' + ref.id + ': quantity must be greater than 0');
    var amount = (rec.unitCost > 0 && rec.qty > 0) ? rec.unitCost * rec.qty : 0;
    receiveStock({
      id: rec.matchId, bottles: rec.qty, supplier: rec.supplier,
      mfd: rec.mfd, expiry: rec.expiry, amount: amount, user: ov.user,
      entrySource: 'WISE_LENS', captureMode: lensCap,
      remarks: 'Lens intake ' + ref.id
    });
    resultId = rec.matchId;
  } else { // ADD_NEW
    if (!rec.name) throw new Error('Intake ' + ref.id + ': medicine name required');
    var inv = sheet(INVENTORY_SHEET);
    var code = mintCode(rec.category, rec.pack, rec.potency, inv);
    addItem({
      id: code, name: rec.name, pack: rec.pack, potency: rec.potency, category: rec.category,
      bottles: rec.qty, cost1: rec.unitCost, supplier1: rec.supplier,
      mfd: rec.mfd, expiry: rec.expiry, user: ov.user,
      entrySource: 'WISE_LENS', captureMode: lensCap,
      remarks: 'Lens intake ' + ref.id
    });
    resultId = code;
  }
  maybeLinkBarcode(resultId, rec.barcode, ov.user);

  sh.getRange(row, ICOL.STATUS).setValue('approved');
  sh.getRange(row, ICOL.RESULT_ID).setValue(resultId);
  sh.getRange(row, ICOL.REVIEWED).setValue(oNow());
  sh.getRange(row, ICOL.REVIEWED_BY).setValue(ov.user || 'Staff');
  return { intakeId: ref.id, action: rec.action, resultId: resultId };
}

function maybeLinkBarcode(id, barcode, user) {
  var bc = up(barcode);
  if (!bc || bc === up(id)) return;
  try { setCode({ id: id, code: bc, user: user }); } catch (e) { /* already linked / ignore */ }
}

/** True if `code` is already the ID of, or a linked barcode alias of, medicine `id`
 *  (or is empty). Used by the v4.5 RBAC guard to allow re-confirming an owned barcode. */
function barcodeBelongsTo(id, code) {
  var bc = up(code);
  if (!bc) return true;
  var owner = locate(sheet(INVENTORY_SHEET), bc);
  return !!(owner && up(owner.id) === up(id));
}

function rejectIntake(body) {
  var sh = ensureIntakeSheet();
  var list = body.intakeIds && body.intakeIds.length ? body.intakeIds
           : (body.intakeId ? [body.intakeId] : []);
  if (!list.length) throw new Error('No intake item to reject');
  var n = 0;
  for (var i = 0; i < list.length; i++) {
    var ref = locateIntake(sh, list[i]);
    if (!ref) continue;
    if (up(str(sh.getRange(ref.row, ICOL.STATUS).getValue())) !== 'PENDING') continue;
    sh.getRange(ref.row, ICOL.STATUS).setValue('rejected');
    sh.getRange(ref.row, ICOL.REVIEWED).setValue(oNow());
    sh.getRange(ref.row, ICOL.REVIEWED_BY).setValue(body.user || 'Staff');
    n++;
  }
  return { rejected: n };
}

function resolvePrefix(category, pack, potency) {
  var cat = up(category), pk = up(pack), pot = up(potency);
  var mlm = pk.match(/(\d+)\s*ML/);
  var ml = mlm ? mlm[1] : '';
  if (/CREAM|GEL|OINT|TUBE/.test(cat) || /CREAM|GEL|OINT/.test(pk)) return 'EX';
  if (cat === 'OIL' || /OIL/.test(pk)) return 'OIL';
  if (cat === 'MT' || pot === 'MT' || pot === 'Q') return ml === '30' ? 'MTS' : 'MT';
  if (cat === 'BC') return 'BC';
  if (ml === '15') return 'DLX';
  if (ml === '30') return 'DLXX';
  return 'DL';
}
function getCounters() {
  var raw = PropertiesService.getScriptProperties().getProperty('LENS_CODE_COUNTERS');
  return raw ? JSON.parse(raw) : {};
}
function setCounters(c) {
  PropertiesService.getScriptProperties().setProperty('LENS_CODE_COUNTERS', JSON.stringify(c));
}
function padNum(n, w) { var s = String(n); while (s.length < w) s = '0' + s; return s; }

function mintCode(category, pack, potency, invSheet) {
  var prefix = resolvePrefix(category, pack, potency);
  var counters = getCounters();
  var last = invSheet.getLastRow();
  var liveMax = 0;
  if (last >= 2) {
    var ids = invSheet.getRange(2, COL.ID, last - 1, 1).getValues();
    var re = new RegExp('^' + prefix + '(\\d+)$', 'i');
    for (var i = 0; i < ids.length; i++) {
      var m = re.exec(String(ids[i][0] || '').trim());
      if (m) { var v = parseInt(m[1], 10); if (v > liveMax) liveMax = v; }
    }
  }
  var n = Math.max(CODE_SEED[prefix] || 0, counters[prefix] || 0, liveMax) + 1;
  var code;
  do { code = prefix + padNum(n, 3); n++; } while (locate(invSheet, code));
  counters[prefix] = n - 1;
  setCounters(counters);
  return code;
}

var LENS_PROMPTS = {
  bill:
    'You read homeopathy supplier invoices/bills from a photo.\n' +
    'Return ONLY valid JSON, no markdown, no commentary.\n' +
    'Shape: {"supplier": string, "lines": [{"name": string, "potency": string, "pack": string, "qty": number, "unitCost": number}]}\n' +
    'Rules:\n' +
    '- One object per medicine line item.\n' +
    '- name: medicine name WITHOUT the potency (e.g. "Arnica Montana").\n' +
    '- potency: e.g. 30, 200, 1M, 6X, Q or MT. "" if absent.\n' +
    '- pack: e.g. "30 ML", "100 ML", "25 G". "" if absent.\n' +
    '- qty: number of bottles/units received (integer).\n' +
    '- unitCost: rate per single unit, plain number, no currency symbol.\n' +
    '- supplier: manufacturer/brand if shown (SBL, BAKSON, Reckeweg), else vendor.\n' +
    '- Missing values: "" for strings, null for numbers. Never invent values.',
  cover:
    'You read a single homeopathy medicine label/cover from a photo.\n' +
    'Return ONLY valid JSON, no markdown, no commentary.\n' +
    'Shape: {"name": string, "potency": string, "pack": string, "mfd": string, "expiry": string, "barcode": string, "batch": string, "brand": string}\n' +
    'Rules:\n' +
    '- name: medicine name WITHOUT the potency.\n' +
    '- potency: e.g. 30, 200, 1M, 6X, Q or MT.\n' +
    '- pack: e.g. "30 ML", "100 ML", "25 G".\n' +
    '- mfd / expiry: normalise to "YYYY-MM". "" if absent.\n' +
    '- barcode: printed EAN/UPC digits only. "" if none.\n' +
    '- batch: batch/lot exactly as printed. "" if absent.\n' +
    '- brand: manufacturer. Never invent values; use "" when unsure.'
};

function lensExtract(body) {
  var key = PropertiesService.getScriptProperties().getProperty('OPENROUTER_API_KEY');
  if (!key) throw new Error('OPENROUTER_API_KEY is not set in Script properties');
  if (!body.image) throw new Error('No image supplied');
  var kind = body.kind === 'cover' ? 'cover' : 'bill';
  var b64 = body.image.indexOf(',') >= 0 ? body.image.split(',').pop() : body.image;
  var model = PropertiesService.getScriptProperties().getProperty('MODEL') || LENS_MODEL_DEFAULT;

  var payload = {
    model: model, temperature: 0,
    max_tokens: LENS_TOKEN_LIMITS[kind] || 800,
    messages: [
      { role: 'system', content: LENS_PROMPTS[kind] },
      { role: 'user', content: [
        { type: 'text', text: kind === 'bill' ? 'Extract every line item from this supplier bill as JSON.' : 'Extract this medicine label as JSON.' },
        { type: 'image_url', image_url: { url: 'data:' + (body.mime || 'image/jpeg') + ';base64,' + b64 } }
      ] }
    ]
  };
  var res = UrlFetchApp.fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'post', contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + key, 'HTTP-Referer': 'https://ihkarise.github.io', 'X-Title': 'Wise Lens' },
    payload: JSON.stringify(payload), muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  if (code < 200 || code >= 300) throw new Error('OpenRouter ' + code + ': ' + res.getContentText().slice(0, 200));
  var bodyJson = JSON.parse(res.getContentText());
  var content = bodyJson && bodyJson.choices && bodyJson.choices[0] && bodyJson.choices[0].message && bodyJson.choices[0].message.content || '';
  var data = parseModelJson(content);
  if (!data) throw new Error('Could not read structured data from the photo');
  return shapeExtract(kind, data);
}

function parseModelJson(text) {
  if (!text) return null;
  var t = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(t); } catch (e) {}
  var m = t.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch (e2) {} }
  return null;
}
function firstOf() { for (var i = 0; i < arguments.length; i++) { var v = arguments[i]; if (v != null && String(v).trim() !== '') return v; } return ''; }
function numOrEmpty(v) { if (v == null || v === '') return ''; var x = parseFloat(String(v).replace(/[^0-9.\-]/g, '')); return isNaN(x) ? '' : x; }

function shapeExtract(kind, d) {
  if (kind === 'bill') {
    var raw = d.lines || d.items || [];
    var lines = [];
    for (var i = 0; i < raw.length; i++) {
      var l = raw[i];
      var nm = str(l.name).trim();
      if (!nm) continue;
      lines.push({
        name: nm, potency: str(l.potency).trim(), pack: str(l.pack).trim(),
        qty: numOrEmpty(firstOf(l.qty, l.quantity, l.units)),
        unitCost: numOrEmpty(firstOf(l.unitCost, l.rate, l.cost, l.price))
      });
    }
    return { supplier: str(firstOf(d.supplier, d.brand, d.vendor, d.manufacturer)).trim(), lines: lines };
  }
  return {
    name: str(d.name).trim(), potency: str(d.potency).trim(), pack: str(d.pack).trim(),
    mfd: str(firstOf(d.mfd, d.manufactured, d.mfg, d.mfgDate)).trim(),
    expiry: str(firstOf(d.expiry, d.exp, d.expiryDate, d.useBefore)).trim(),
    barcode: str(d.barcode).trim(), batch: str(firstOf(d.batch, d.batchNo, d.lot, d.lotNo)).trim(),
    brand: str(firstOf(d.brand, d.manufacturer, d.company)).trim()
  };
}

// ============================================================================
// v4.3  ENTRY-SOURCE AUDIT  (additive — audit columns V..AC on Inventory,
//        Source/Capture on Transactions, per-source analytics)
// ============================================================================

var ACOL = { ENTRY: 22, ORIG: 23, MOD: 24, CAPTURE: 25, CREATED_AT: 26, CREATED_BY: 27, UPDATED_AT: 28, UPDATED_BY: 29 };
var ACOLS_END = 29;
var AHEADERS = { 22: 'Entry Source', 23: 'Original Source', 24: 'Last Modified Source', 25: 'Capture Mode',
  26: 'Created At', 27: 'Created By', 28: 'Updated At', 29: 'Updated By' };

var SOURCES  = { WISE_LENS: 1, HOLOSCAN: 1, WHIMS: 1, VOICE_LENS: 1, WEB_PORTAL: 1, MOBILE_APP: 1, IMPORT_TOOL: 1, API_INTEGRATION: 1, PDF: 1, INVOICE: 1, WISE_PRINTER: 1 };
var CAPTURES = { CAMERA: 1, GALLERY: 1, VOICE: 1, PDF: 1, INVOICE: 1, IMPORT: 1, API: 1, MANUAL: 1, SCAN: 1 };

function resolveSource(body, fallback) { var s = up(body && body.entrySource); return SOURCES[s] ? s : (fallback || ''); }
function resolveCapture(body) { var c = up(body && body.captureMode); return CAPTURES[c] ? c : ''; }

function ensureAuditCols(sh) {
  if (sh.getMaxColumns() < ACOLS_END) sh.insertColumnsAfter(sh.getMaxColumns(), ACOLS_END - sh.getMaxColumns());
  for (var c = ACOL.ENTRY; c <= ACOLS_END; c++) {
    if (str(sh.getRange(1, c).getValue()) === '') sh.getRange(1, c).setValue(AHEADERS[c]);
  }
}

function stampAudit(sh, row, opts) {
  opts = opts || {};
  ensureAuditCols(sh);
  var now = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
  var src = opts.entrySource || '';
  var cap = opts.captureMode || '';
  var user = opts.user || 'Staff';
  if (opts.isNew) {
    sh.getRange(row, ACOL.ENTRY, 1, 8).setValues([[src, src, src, cap, now, user, now, user]]);
  } else {
    var entry = str(sh.getRange(row, ACOL.ENTRY).getValue());
    var orig = str(sh.getRange(row, ACOL.ORIG).getValue());
    if (!orig && entry) sh.getRange(row, ACOL.ORIG).setValue(entry);
    if (src) sh.getRange(row, ACOL.MOD).setValue(src);
    if (cap) sh.getRange(row, ACOL.CAPTURE).setValue(cap);
    sh.getRange(row, ACOL.UPDATED_AT).setValue(now);
    sh.getRange(row, ACOL.UPDATED_BY).setValue(user);
  }
}

function sourceStats(params) {
  var counts = { WHIMS: 0, WISE_LENS: 0, HOLOSCAN: 0, WISE_PRINTER: 0 };
  var sh = sheet(INVENTORY_SHEET);
  var last = sh.getLastRow();
  if (last < 2) return counts;

  if (sh.getMaxColumns() < ACOL.ENTRY) {
    counts.WHIMS = last - 1;
    return counts;
  }

  var col = sh.getRange(2, ACOL.ENTRY, last - 1, 1).getValues();
  for (var i = 0; i < col.length; i++) {
    var s = up(col[i][0]);
    if (s.indexOf('LENS') !== -1 || s.indexOf('CAMERA') !== -1)    counts.WISE_LENS++;
    else if (s.indexOf('HOLO') !== -1 || s.indexOf('SCAN') !== -1) counts.HOLOSCAN++;
    else if (s.indexOf('PRINTER') !== -1)                          counts.WISE_PRINTER++;
    else                                                          counts.WHIMS++;
  }
  return counts;
}

// ============================================================================
// NEW #1 — ENTRY-SOURCE ANALYTICS, RANGE-AWARE  (Today / Week / Month)
// ----------------------------------------------------------------------------
// sourceStats() above answers "what's the current MIX of my inventory by
// source" (a snapshot). This answers "how much ACTIVITY happened by source
// in the last day/week/month" — what the dashboard's Today/Week/Month panel
// actually needs. Reads the Transactions sheet's Source/Capture columns.
// ============================================================================

function sourceAnalytics(params) {
  params = params || {};
  var range = String(params.range || 'today').toLowerCase();
  var tz = Session.getScriptTimeZone();
  var now = new Date();
  var from;
  if (range === 'week')        from = new Date(now.getTime() - 7  * 86400000);
  else if (range === 'month')  from = new Date(now.getTime() - 30 * 86400000);
  else { range = 'today';      from = new Date(now.getFullYear(), now.getMonth(), now.getDate()); }

  var sh = sheet(TRANSACTIONS_SHEET);
  var last = sh.getLastRow();
  var bySource = {}, byCapture = {}, byAction = {}, total = 0;

  if (last >= 2) {
    var cols = Math.min(13, sh.getMaxColumns());
    var data = sh.getRange(2, 1, last - 1, cols).getValues();
    for (var i = 0; i < data.length; i++) {
      var v = data[i];
      var dt = parseTxDate(v[1]);
      if (!dt || dt < from || dt > now) continue;
      total++;
      var action = up(v[4]) || 'OTHER';
      byAction[action] = (byAction[action] || 0) + 1;
      var src = (cols >= 12 ? up(v[11]) : '') || 'WHIMS';
      bySource[src] = (bySource[src] || 0) + 1;
      var cap = cols >= 13 ? up(v[12]) : '';
      if (cap) byCapture[cap] = (byCapture[cap] || 0) + 1;
    }
  }

  return {
    range: range,
    from: Utilities.formatDate(from, tz, 'yyyy-MM-dd'),
    to: Utilities.formatDate(now, tz, 'yyyy-MM-dd'),
    total: total,
    bySource: bySource,
    byCapture: byCapture,
    byAction: byAction
  };
}

function parseTxDate(v) {
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  var s = String(v == null ? '' : v).trim();
  if (!s) return null;
  var m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  var d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

// ============================================================================
// NEW #2 — UNDO APPROVAL
// ----------------------------------------------------------------------------
// Lets staff reverse an Intake approval within a configurable time window.
// Restores Inventory (the full row), Transactions (via a NEW compensating
// entry — the original is never deleted), and Intake Status (back to
// pending). Script Property UNDO_WINDOW_MINUTES controls the window
// (default 10) — change it any time with no code edit.
// ============================================================================

var UNDO_SHEET = 'ApprovalUndo';
var UNDO_WINDOW_DEFAULT = 10;
var UCOL = { ID:1, INTAKE:2, RESULT:3, CREATED:4, EXPIRES:5, ACTION:6, SNAPSHOT:7,
  USED:8, UNDONE_AT:9, UNDONE_BY:10, APPROVED_BY:11 };
var UCOLS = 11;
var UHEADERS = ['Undo ID','Intake ID','Result ID','Created At','Expires At','Action',
  'Snapshot JSON','Used','Undone At','Undone By','Approved By'];

function ensureUndoSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(UNDO_SHEET);
  if (!sh) sh = ss.insertSheet(UNDO_SHEET);
  if (str(sh.getRange(1,1).getValue()) === '') {
    sh.getRange(1,1,1,UCOLS).setValues([UHEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function captureUndoSnapshot(sh, ref, ov) {
  var get = function (c) { return str(sh.getRange(ref.row, c).getValue()); };
  var has = function (k) { return ov[k] !== undefined && ov[k] !== null; };
  var action = up(has('action') ? ov.action : get(ICOL.ACTION));
  // RECEIVE and DISPENSE both change stock on an EXISTING row → snapshot that row
  // so undo restores it exactly. Anything else (ADD_NEW) archives the created row.
  if (action !== 'RECEIVE' && action !== 'DISPENSE') return { isNew: true };
  var matchId = up(has('matchedId') ? ov.matchedId : get(ICOL.MATCH_ID));
  if (!matchId) return null;
  var inv = sheet(INVENTORY_SHEET);
  var hit = locate(inv, matchId);
  if (!hit) return null;
  var width = inv.getMaxColumns();
  var before = inv.getRange(hit.row, 1, 1, width).getValues()[0];
  return { isNew: false, medRow: hit.row, width: width, before: before };
}

function finalizeUndoSnapshot(snap, result, ov) {
  if (!snap || !result || !result.resultId) return;
  var minutes = Number(PropertiesService.getScriptProperties().getProperty('UNDO_WINDOW_MINUTES')) || UNDO_WINDOW_DEFAULT;
  var tz = Session.getScriptTimeZone();
  var now = new Date();
  var expires = new Date(now.getTime() + minutes * 60000);
  var ush = ensureUndoSheet();
  var undoId = 'UNDO' + Utilities.formatDate(now, tz, 'yyyyMMddHHmmss') + Math.floor(Math.random() * 900 + 100);
  ush.appendRow([undoId, ov.intakeId, result.resultId, oNow(),
    Utilities.formatDate(expires, tz, 'yyyy-MM-dd HH:mm:ss'),
    result.action || (snap.isNew ? 'ADD_NEW' : 'RECEIVE'),
    JSON.stringify(snap), '', '', '', ov.user || 'Staff']);
  result.undoId = undoId;
  result.undoExpiresAt = Utilities.formatDate(expires, tz, "yyyy-MM-dd'T'HH:mm:ss");
  result.undoWindowMinutes = minutes;
}

(function () {
  var _origApproveOneForUndo = approveOne;
  approveOne = function (sh, ref, ov) {
    var snap;
    try { snap = captureUndoSnapshot(sh, ref, ov); } catch (e) { snap = null; }
    var result = _origApproveOneForUndo(sh, ref, ov);
    try { finalizeUndoSnapshot(snap, result, ov); } catch (e) { /* never block approval on undo bookkeeping */ }
    return result;
  };
})();

function undoApproval(body) {
  var ush = ensureUndoSheet();
  var last = ush.getLastRow();
  if (last < 2) throw new Error('Nothing to undo');
  var data = ush.getRange(2, 1, last - 1, UCOLS).getValues();
  var wantUndoId = String(body.undoId || '').trim();
  var wantIntake = String(body.intakeId || '').trim();
  var rowIdx = -1, rec = null;
  for (var i = data.length - 1; i >= 0; i--) {
    var v = data[i];
    if (wantUndoId) { if (str(v[UCOL.ID - 1]) !== wantUndoId) continue; }
    else if (wantIntake) { if (str(v[UCOL.INTAKE - 1]) !== wantIntake) continue; }
    else break;
    if (up(str(v[UCOL.USED - 1])) === 'YES') continue;
    rowIdx = i + 2; rec = v; break;
  }
  if (!rec) throw new Error('No undoable approval found — it may already be undone or the window has expired');
  var expires = parseTxDate(rec[UCOL.EXPIRES - 1]);
  if (expires && new Date() > expires) throw new Error('Undo window has expired for this approval');

  var snap = JSON.parse(str(rec[UCOL.SNAPSHOT - 1]));
  var resultId = str(rec[UCOL.RESULT - 1]);
  var intakeId = str(rec[UCOL.INTAKE - 1]);

  var inv = sheet(INVENTORY_SHEET);
  if (snap.isNew) {
    var hit = locate(inv, resultId);
    if (hit) {
      inv.getRange(hit.row, COL.ACTIVE).setValue('NO');
      stamp(inv, hit.row);
      logTx(resultId, str(inv.getRange(hit.row, COL.NAME).getValue()), 'UNDO-CREATE', 0, 0, 0,
        body.user, 'Undo of intake ' + intakeId + ' approval', 0);
    }
  } else {
    var beforeBottles = num(inv.getRange(snap.medRow, COL.BOTTLES).getValue());
    inv.getRange(snap.medRow, 1, 1, snap.width).setValues([snap.before]);
    var afterBottles = num(snap.before[COL.BOTTLES - 1]);
    var undoLabel = 'UNDO-' + (up(str(rec[UCOL.ACTION - 1])) || 'RECEIVE');   // UNDO-RECEIVE / UNDO-DISPENSE
    logTx(resultId, str(snap.before[COL.NAME - 1]), undoLabel, beforeBottles - afterBottles, beforeBottles, afterBottles,
      body.user, 'Undo of intake ' + intakeId + ' approval', 0);
  }

  var ish = ensureIntakeSheet();
  var iref = locateIntake(ish, intakeId);
  if (iref) {
    ish.getRange(iref.row, ICOL.STATUS).setValue('pending');
    ish.getRange(iref.row, ICOL.RESULT_ID).setValue('');
    var curNotes = str(ish.getRange(iref.row, ICOL.NOTES).getValue());
    ish.getRange(iref.row, ICOL.NOTES).setValue(joinRemarks(curNotes, 'Undone at ' + oNow() + ' by ' + (body.user || 'Staff')));
  }

  ush.getRange(rowIdx, UCOL.USED).setValue('YES');
  ush.getRange(rowIdx, UCOL.UNDONE_AT).setValue(oNow());
  ush.getRange(rowIdx, UCOL.UNDONE_BY).setValue(body.user || 'Staff');

  return { intakeId: intakeId, resultId: resultId, restored: !snap.isNew, archived: !!snap.isNew };
}

function recentApprovals(params) {
  var ush = ensureUndoSheet();
  var last = ush.getLastRow();
  if (last < 2) return [];
  var data = ush.getRange(2, 1, last - 1, UCOLS).getValues();
  var now = new Date();
  var out = [];
  for (var i = 0; i < data.length; i++) {
    var v = data[i];
    if (up(str(v[UCOL.USED - 1])) === 'YES') continue;
    var expires = parseTxDate(v[UCOL.EXPIRES - 1]);
    if (expires && now > expires) continue;
    out.push({
      undoId: str(v[UCOL.ID - 1]), intakeId: str(v[UCOL.INTAKE - 1]), resultId: str(v[UCOL.RESULT - 1]),
      action: str(v[UCOL.ACTION - 1]), createdAt: str(v[UCOL.CREATED - 1]), expiresAt: str(v[UCOL.EXPIRES - 1]),
      approvedBy: str(v[UCOL.APPROVED_BY - 1])
    });
  }
  return out.reverse();
}

// ============================================================================
// NEW #3 — MANUAL AI ASSISTANT
// ----------------------------------------------------------------------------
// Runs ONLY when staff tap "Ask AI" in the app and pick a question — never
// automatic, never scheduled. Read-only: makes one text-only call to
// OpenRouter (reusing the same OPENROUTER_API_KEY / MODEL as Wise Lens
// above) with NO tools/function-calling wired in, so the AI has no way to
// change anything — recommendations only, always.
// ============================================================================

var AI_ASSISTANT_MAX_TOKENS_DEFAULT = 700;
var AI_ASSISTANT_PROMPT =
  'You are Wise AI Assistant, an inventory analyst for Wise Homeopathy, a homeopathy clinic and dispensary.\n' +
  'You answer ONLY from the JSON inventory-analytics data provided in the user message — never invent numbers.\n' +
  'You give recommendations and analysis only. You have NO ability to modify inventory, place orders, approve' +
  ' anything, or take any action — never claim or imply that you did or will.\n' +
  'Currency is Indian Rupees (₹). Be concise, concrete, and practical for a small clinic owner — short paragraphs' +
  ' or a short bullet list, no more than roughly 200 words unless an executive summary was explicitly requested.\n' +
  'If the provided data does not support an answer, say so honestly rather than guessing.';

function aiAssistantAsk(body) {
  var key = PropertiesService.getScriptProperties().getProperty('OPENROUTER_API_KEY');
  if (!key) throw new Error('OPENROUTER_API_KEY is not set in Script properties');
  var question = String(body.question || '').trim();
  if (!question) throw new Error('No question provided');
  var context = body.context || {};
  var model = PropertiesService.getScriptProperties().getProperty('MODEL') || LENS_MODEL_DEFAULT;
  var maxTokens = Number(PropertiesService.getScriptProperties().getProperty('AI_ASSISTANT_MAX_TOKENS')) || AI_ASSISTANT_MAX_TOKENS_DEFAULT;

  var payload = {
    model: model, temperature: 0.3, max_tokens: maxTokens,
    messages: [
      { role: 'system', content: AI_ASSISTANT_PROMPT },
      { role: 'user', content: 'Question: ' + question + '\n\nInventory analytics data (JSON):\n' + JSON.stringify(context) }
    ]
  };
  var res = UrlFetchApp.fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'post', contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + key, 'HTTP-Referer': 'https://ihkarise.github.io', 'X-Title': 'Wise AI Assistant' },
    payload: JSON.stringify(payload), muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  if (code < 200 || code >= 300) throw new Error('OpenRouter ' + code + ': ' + res.getContentText().slice(0, 200));
  var bodyJson = JSON.parse(res.getContentText());
  var content = bodyJson && bodyJson.choices && bodyJson.choices[0] && bodyJson.choices[0].message && bodyJson.choices[0].message.content || '';
  if (!content) throw new Error('No answer returned — try again');
  return { answer: content.trim(), model: model, question: question };
}

// ============================================================================
// v4.5 — WISE PRINTER PACKAGING BRIDGE
// ----------------------------------------------------------------------------
// Wise Cover Printer consumes packaging materials (medicine covers, sachets,
// SOS sachets, bottles, stickers, boxes, outer covers) every time it prints.
// Those materials already live as Inventory rows here. After the user
// confirms printing, the Printer calls action 'stagepackaging' with the list
// of {id, qty} it consumed. This function NEVER touches the Inventory sheet:
// each item becomes one PENDING Intake row (source WISE_PRINTER, action
// DISPENSE) via the existing stageIntake() — exactly the Wise Lens workflow.
// Stock only moves when staff approve the rows in the normal Intake Approval
// screen, at which point approveOne()'s DISPENSE branch (above) calls the
// existing dispenseStock() engine. Reject works unchanged. Undo works
// unchanged (row snapshot). Nothing is hardcoded: any Inventory ID works —
// COVER###, SACHET###, SOSSACHET###, STICKERS###, BOX###, FINALCOVER###,
// BT/GB/BD bottle codes, and every future code.
//
// Payload: { action:'stagepackaging', token, prescriptionId, patientId,
//            items:[{id:'COVER001', qty:5}, ...] }
// Returns: { staged, intakeIds, prescriptionId, skipped:[{id, error}] }
// ============================================================================

function stagePackaging(body) {
  var items = body.items || [];
  if (!items.length) throw new Error('No packaging items to stage');
  var rxId = str(body.prescriptionId).trim();
  var patient = str(body.patientId).trim();
  var note = joinRemarks(rxId ? 'Rx ' + rxId : 'Wise Printer packaging',
                         patient ? 'Patient ' + patient : '');
  var inv = sheet(INVENTORY_SHEET);

  // Validate every ID against live inventory BEFORE staging anything —
  // a typo'd default should never create an unapprovable ghost row.
  var rows = [], skipped = [];
  for (var i = 0; i < items.length; i++) {
    var it = items[i] || {};
    var id = String(it.id || '').trim().toUpperCase();
    var qty = num(it.qty);
    if (!id) { skipped.push({ id: '', error: 'missing id' }); continue; }
    if (qty <= 0) { skipped.push({ id: id, error: 'quantity must be greater than 0' }); continue; }
    var hit = locate(inv, id);
    if (!hit) { skipped.push({ id: id, error: 'not in inventory' }); continue; }
    rows.push({
      source: 'WISE_PRINTER', action: 'DISPENSE',
      matchedId: hit.id, name: hit.name,
      qty: qty,
      unitCost: num(inv.getRange(hit.row, COL.COST1).getValue()) || '',
      confidence: 'confirmed',
      notes: note
    });
  }
  if (!rows.length) throw new Error('No valid packaging items — ' +
    (skipped.length ? skipped.map(function (s) { return s.id + ': ' + s.error; }).join('; ') : 'empty list'));

  var staged = stageIntake({ rows: rows });   // reuse — same sheet, same PENDING queue, same ids
  return { staged: staged.staged, intakeIds: staged.intakeIds, prescriptionId: rxId, skipped: skipped };
}


// ============================================================================
// v4.5  WISE QUERY ENGINE  (additive — two-tier search / suggest brain)
// ----------------------------------------------------------------------------
// Paste this whole block at the very BOTTOM of Code.gs. It:
//   • adds NOTHING destructive — every existing function stays byte-for-byte.
//   • wires itself into doGet/doPost the same way the Undo feature wraps
//     approveOne (an IIFE at load time) — so you edit no existing lines.
//   • NEVER writes to any sheet and NEVER touches column S — it only reads
//     through getInventory(). It cannot change stock, place orders, or approve.
//
// TIER 1  — ₹0, NO OpenRouter call, instant. Runs on the sheet in Apps Script.
//           Actions:  smartsearch · medgroup · medfacets
//           Covers: availability, did-you-mean spelling fix, variant grouping
//           (all potencies/packs/forms of one medicine), potency count,
//           rate count + range, similar names, form grouping.
//
// TIER 2  — costs tokens, fires ONLY when staff tap "Plan" or "Ask AI".
//           Actions:  planorder · askwhims
//           Tier 1 first boils the data down to a tiny digest; ONLY that
//           digest is sent to the model — never the whole 853-row sheet.
//
// New Script Properties (all optional; sensible defaults if unset):
//   WQE_PLAN_MAX_TOKENS   (default 900)   — token cap for the monthly plan
//   WQE_ASK_MAX_TOKENS    (default 700)   — token cap for Ask WHIMS
//   WQE_DIGEST_LIMIT      (default 40)    — max reorder lines sent to the AI
// Reuses your existing OPENROUTER_API_KEY and MODEL.
// ============================================================================

var WQE_PLAN_MAX_TOKENS_DEFAULT = 900;
var WQE_ASK_MAX_TOKENS_DEFAULT  = 700;
var WQE_DIGEST_LIMIT_DEFAULT    = 40;
var WQE_CACHE_TTL               = 45; // seconds — short cache to cut sheet reads

// ---------------------------------------------------------------- text utils
function wqeNorm(s) {
  return String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}
function wqeTokens(s) { var n = wqeNorm(s); return n ? n.split(' ') : []; }

/** Levenshtein edit distance (two-row, O(n) memory). */
function wqeLev(a, b) {
  a = String(a); b = String(b);
  var m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  var prev = [], cur = [], i, j;
  for (j = 0; j <= n; j++) prev[j] = j;
  for (i = 1; i <= m; i++) {
    cur[0] = i;
    for (j = 1; j <= n; j++) {
      var cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    for (j = 0; j <= n; j++) prev[j] = cur[j];
  }
  return prev[n];
}
/** 0..1 similarity from edit distance. */
function wqeSim(a, b) {
  a = wqeNorm(a); b = wqeNorm(b);
  if (!a && !b) return 1; if (!a || !b) return 0;
  var L = Math.max(a.length, b.length);
  return L ? (1 - wqeLev(a, b) / L) : 0;
}
/** Strip embedded "(pack) (potency)" and trailing dots from a medicine name so
 *  every potency of one medicine collapses to a single base name.
 *  "SILICEA (30 ML) (200)" → "SILICEA"  ·  "ALLIUM ursinum." → "ALLIUM ursinum" */
function wqeBaseName(name) {
  return String(name == null ? '' : name).replace(/\([^)]*\)/g, ' ').replace(/[.\s]+$/, '').replace(/\s+/g, ' ').trim();
}

/** Cheap, no-Levenshtein score: exact / substring / prefix only. */
function wqeCheapScore(qn, key) {
  if (!qn || !key) return 0;
  if (key === qn) return 1;
  if (key.indexOf(qn) !== -1) return 0.9;   // query is a prefix/substring of the name
  if (qn.indexOf(key) !== -1) return 0.82;  // name is contained in the query
  return 0;
}
/** Strict gate for type-ahead: only fuzzy-score keys that keep the first letter
 *  and are close in length. Keeps 853-row search fast. */
function wqeGate(qn, key) {
  var lq = qn.length, lk = key.length, maxd = Math.max(2, Math.ceil(Math.max(lq, lk) * 0.34));
  if (Math.abs(lq - lk) > maxd) return false;
  return qn.charAt(0) === key.charAt(0);
}
/** Looser gate (length only) for the rarer "did you mean?" fallback. */
function wqeGateLen(qn, key) {
  var lq = qn.length, lk = key.length, maxd = Math.max(3, Math.ceil(Math.max(lq, lk) * 0.5));
  return Math.abs(lq - lk) <= maxd;
}

/** Rank groups against a query: cheap pass first, Levenshtein only on gated keys. */
function wqeRankGroups(query, groups, lenient) {
  var qn = wqeNorm(query), out = [];
  for (var key in groups) {
    var cheap = wqeCheapScore(qn, key), sc;
    if (cheap > 0) sc = cheap;
    else if (lenient ? wqeGateLen(qn, key) : wqeGate(qn, key)) {
      sc = wqeScore(query, key);
      if (sc < 0.34) continue;
    } else continue;
    out.push({ key: key, g: groups[key], score: sc });
  }
  out.sort(function (a, b) { return b.score - a.score; });
  return out;
}

/** Combined match score of a candidate NAME against a typed QUERY (0..1). */
function wqeScore(query, name) {
  var q = wqeNorm(query), nm = wqeNorm(name);
  if (!q || !nm) return 0;
  if (nm === q) return 1;
  var sub = nm.indexOf(q) !== -1 ? 0.92 : (q.indexOf(nm) !== -1 ? 0.85 : 0);
  var qt = wqeTokens(q), nt = wqeTokens(nm), hit = 0;
  for (var i = 0; i < qt.length; i++) {
    for (var k = 0; k < nt.length; k++) {
      if (qt[i] === nt[k] || wqeSim(qt[i], nt[k]) >= 0.8) { hit++; break; }
    }
  }
  var tok = qt.length ? hit / qt.length : 0;
  var lev = wqeSim(q, nm);
  return Math.max(sub, tok * 0.9, lev);
}
/** How strongly a NAME is *mentioned inside* a free-text QUESTION (0..1).
 *  Unlike wqeScore (built for short name-like queries), this measures how many
 *  of the NAME's tokens appear in the question, so a long sentence doesn't dilute
 *  the match. Used by Ask WHIMS to pick which medicines a question is about. */
function wqeMentionScore(question, name) {
  var qn = wqeNorm(question), nm = wqeNorm(name);
  if (!qn || !nm) return 0;
  if (qn.indexOf(nm) !== -1) return 1;
  var qt = wqeTokens(qn), nt = wqeTokens(nm), hit = 0;
  for (var i = 0; i < nt.length; i++) {
    for (var j = 0; j < qt.length; j++) {
      if (nt[i] === qt[j] || wqeSim(nt[i], qt[j]) >= 0.8) { hit++; break; }
    }
  }
  return nt.length ? hit / nt.length : 0;
}
function wqeUniqNums(a) {
  var seen = {}, out = [];
  for (var i = 0; i < a.length; i++) { var key = String(a[i]); if (!seen[key]) { seen[key] = 1; out.push(a[i]); } }
  return out;
}

// ------------------------------------------------------- inventory (cached)
/** Slim, cached snapshot of live inventory. Guarded: skips cache if too big. */
function wqeInventory() {
  try {
    var raw = CacheService.getScriptCache().get('WQE_INV');
    if (raw) return JSON.parse(raw);
  } catch (e) { /* cache miss / oversize — fall through to a fresh read */ }
  var inv = getInventory();
  var slim = inv.map(function (x) {
    return {
      id: x.id, name: x.name, pack: x.pack, potency: x.potency, category: x.category,
      bottles: num(x.bottles), ml: num(x.ml), priority: num(x.priority),
      cost1: num(x.cost1), cost2: num(x.cost2), supplier1: x.supplier1, supplier2: x.supplier2,
      active: String(x.active || 'YES').toUpperCase(), status: x.status, barcode: x.barcode
    };
  });
  try {
    var s = JSON.stringify(slim);
    if (s.length < 95000) CacheService.getScriptCache().put('WQE_INV', s, WQE_CACHE_TTL);
  } catch (e2) { /* never fail a search over a cache write */ }
  return slim;
}

/** IN / LOW / OUT for one variant. */
function wqeAvail(item) {
  var b = num(item.bottles);
  var st = String(item.status || '').toUpperCase();
  if (b <= 0) return 'OUT';
  if (st.indexOf('LOW') !== -1 || st.indexOf('REORDER') !== -1 || st.indexOf('CRITICAL') !== -1) return 'LOW';
  return 'IN';
}

/** Group all ACTIVE items by normalised name → { KEY: {name, variants:[...]} }. */
function wqeGroupAll(inv) {
  var map = {};
  for (var i = 0; i < inv.length; i++) {
    var it = inv[i];
    if (String(it.active || 'YES').toUpperCase() !== 'YES') continue;
    var display = wqeBaseName(it.name);   // "SILICEA (30 ML) (200)" → "SILICEA"
    var key = wqeNorm(display);
    if (!key) continue;
    if (!map[key]) map[key] = { name: display, variants: [] };
    map[key].variants.push(it);
  }
  return map;
}

/** Potency / rate / pack / form / supplier facets for a set of variants. */
function wqeFacets(variants) {
  var pots = {}, rates = [], packs = {}, sups = {}, forms = {}, totalB = 0, inStock = false;
  for (var i = 0; i < variants.length; i++) {
    var v = variants[i];
    var p = String(v.potency || '').trim().toUpperCase(); if (p) pots[p] = 1;
    var r1 = num(v.cost1); if (r1 > 0) rates.push(r1);
    var r2 = num(v.cost2); if (r2 > 0) rates.push(r2);
    var pk = String(v.pack || '').trim().toUpperCase(); if (pk) packs[pk] = 1;
    var s1 = String(v.supplier1 || '').trim(); if (s1) sups[s1.toUpperCase()] = s1;
    var s2 = String(v.supplier2 || '').trim(); if (s2) sups[s2.toUpperCase()] = s2;
    var f = String(v.category || v.pack || '').trim().toUpperCase(); if (f) forms[f] = 1;
    totalB += num(v.bottles);
    if (num(v.bottles) > 0) inStock = true;
  }
  var rl = wqeUniqNums(rates).sort(function (a, b) { return a - b; });
  return {
    potencies: { count: Object.keys(pots).length, list: Object.keys(pots) },
    rates: { count: rl.length, min: rl.length ? rl[0] : 0, max: rl.length ? rl[rl.length - 1] : 0, list: rl },
    packs: { count: Object.keys(packs).length, list: Object.keys(packs) },
    forms: { count: Object.keys(forms).length, list: Object.keys(forms) },
    suppliers: { count: Object.keys(sups).length, list: Object.keys(sups).map(function (k) { return sups[k]; }) },
    totalBottles: totalB, inStock: inStock, variantCount: variants.length
  };
}

/** Closest base-names to a query (for "did you mean?"). */
function wqeDidYouMean(query, groups, n) {
  var ranked = wqeRankGroups(query, groups, true);
  var out = [];
  for (var i = 0; i < ranked.length && out.length < (n || 5); i++) if (ranked[i].score >= 0.34) out.push(ranked[i].g.name);
  return out;
}

// ============================== TIER 1 ACTIONS (₹0) ==========================

/** medgroup — every potency/pack/form of ONE medicine across the whole DB. */
function wqeMedGroup(params) {
  var name = String(params.name || params.q || params.query || '').trim();
  if (!name) throw new Error('Provide a medicine name');
  var inv = wqeInventory();
  var groups = wqeGroupAll(inv);
  var ranked = wqeRankGroups(name, groups, false);
  if (!ranked.length || ranked[0].score < 0.4) return { found: false, query: name, didYouMean: wqeDidYouMean(name, groups, 5) };
  var best = ranked[0].key, g = ranked[0].g;
  return {
    found: true, query: name, corrected: wqeNorm(name) !== best, name: g.name,
    facets: wqeFacets(g.variants),
    variants: g.variants.map(function (v) {
      return {
        id: v.id, potency: v.potency, pack: v.pack, category: v.category,
        bottles: num(v.bottles), ml: num(v.ml), cost1: num(v.cost1), cost2: num(v.cost2),
        supplier1: v.supplier1, supplier2: v.supplier2, priority: num(v.priority),
        availability: wqeAvail(v)
      };
    })
  };
}

/** medfacets — just the counts: how many potencies, how many rates + range. */
function wqeMedFacets(params) {
  var g = wqeMedGroup(params);
  if (!g.found) return g;
  return {
    found: true, name: g.name,
    potencies: g.facets.potencies, rates: g.facets.rates, packs: g.facets.packs,
    forms: g.facets.forms, suppliers: g.facets.suppliers,
    totalBottles: g.facets.totalBottles, inStock: g.facets.inStock, variants: g.facets.variantCount
  };
}

/** smartsearch — the everyday brain: availability + suggestions + did-you-mean. */
function wqeSmartSearch(params) {
  var q = String(params.q || params.query || params.name || '').trim();
  if (!q) throw new Error('Type something to search');
  var limit = Math.min(num(params.limit) || 6, 20);
  var inv = wqeInventory();
  var qU = q.toUpperCase();

  // cheap exact ID / barcode hit first
  var idHit = null;
  for (var i = 0; i < inv.length; i++) {
    if (String(inv[i].id).toUpperCase() === qU) { idHit = inv[i]; break; }
    var bc = String(inv[i].barcode || '').toUpperCase();
    if (bc && bc.split(/[,;\s]+/).indexOf(qU) !== -1) { idHit = inv[i]; break; }
  }

  var groups = wqeGroupAll(inv);
  var scored = wqeRankGroups(q, groups, false);   // cheap pass + gated fuzzy only

  var top = scored.slice(0, limit).filter(function (s) { return s.score >= 0.4; });
  var qNorm = wqeNorm(q);
  var matchType = 'none';
  if (idHit) {
    matchType = 'exact';
  } else if (top.length) {
    var topKey = top[0].key;                        // normalised name of the best hit
    if (topKey === qNorm) matchType = 'exact';       // typed the name exactly
    else if (topKey.indexOf(qNorm) !== -1) matchType = 'partial'; // clean prefix / substring
    else matchType = 'fuzzy';                         // a typo we resolved
  }

  function slimVariants(vs) {
    return vs.map(function (v) {
      return {
        id: v.id, potency: v.potency, pack: v.pack, category: v.category,
        bottles: num(v.bottles), availability: wqeAvail(v), cost1: num(v.cost1), supplier1: v.supplier1
      };
    });
  }

  var results = top.map(function (s) {
    return { name: s.g.name, score: Math.round(s.score * 100) / 100, facets: wqeFacets(s.g.variants), variants: slimVariants(s.g.variants) };
  });

  if (idHit) {
    var k = wqeNorm(idHit.name);
    var present = results.some(function (r) { return wqeNorm(r.name) === k; });
    if (!present && groups[k]) {
      results.unshift({ name: groups[k].name, score: 1, facets: wqeFacets(groups[k].variants), variants: slimVariants(groups[k].variants) });
    }
  }

  var corrected = matchType === 'fuzzy' && results.length;
  var didYouMean = matchType === 'none' ? wqeDidYouMean(q, groups, 5) : [];
  var similar = [];
  for (var t = 1; t < scored.length && similar.length < 5; t++) {
    if (scored[t].score >= 0.45 && scored[t].score < 0.9) similar.push(scored[t].g.name);
  }

  return { query: q, matchType: matchType, corrected: !!corrected, results: results, didYouMean: didYouMean, similar: similar };
}

// =============================== TIER 2 (tokens) =============================

/** Build a COMPACT reorder digest (low / out / priority items only, capped). */
function wqeOrderDigest(inv, limit) {
  limit = limit || (Number(PropertiesService.getScriptProperties().getProperty('WQE_DIGEST_LIMIT')) || WQE_DIGEST_LIMIT_DEFAULT);
  var cand = [];
  for (var i = 0; i < inv.length; i++) {
    var it = inv[i];
    if (String(it.active || 'YES').toUpperCase() !== 'YES') continue;
    var b = num(it.bottles), pr = num(it.priority);
    var st = String(it.status || '').toUpperCase();
    var low = b <= 0 || pr > 0 || st.indexOf('LOW') !== -1 || st.indexOf('REORDER') !== -1 ||
              st.indexOf('CRITICAL') !== -1 || st.indexOf('OUT') !== -1;
    if (!low) continue;
    var urg = (b <= 0 ? 100 : 0) + pr * 10 + (st.indexOf('CRITICAL') !== -1 ? 20 : 0) + (st.indexOf('LOW') !== -1 ? 5 : 0);
    cand.push({
      id: it.id, name: it.name, potency: it.potency, pack: it.pack, category: it.category,
      bottles: b, priority: pr, cost1: num(it.cost1), supplier1: it.supplier1, status: it.status, _u: urg
    });
  }
  cand.sort(function (a, b) { return b._u - a._u; });
  var items = cand.slice(0, limit).map(function (x) { delete x._u; return x; });
  return { totalCandidates: cand.length, included: items.length, items: items };
}

function wqeOpenRouter(key, payload, title) {
  var res = UrlFetchApp.fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'post', contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + key, 'HTTP-Referer': 'https://ihkarise.github.io', 'X-Title': title || 'Wise Query Engine' },
    payload: JSON.stringify(payload), muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  if (code < 200 || code >= 300) throw new Error('OpenRouter ' + code + ': ' + res.getContentText().slice(0, 200));
  var j = JSON.parse(res.getContentText());
  var content = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content || '';
  if (!content) throw new Error('No answer returned — try again');
  return content.trim();
}

var WQE_PLAN_PROMPT =
  'You are Wise AI, planning a MONTHLY purchase for Wise Homeopathy, a homeopathy clinic and dispensary.\n' +
  'You are given a JSON list of reorder candidates (low stock, out of stock, or flagged priority) with current bottles, priority, per-unit cost (Rs), pack, potency and supplier.\n' +
  'Produce a practical monthly buy plan. Rules:\n' +
  '- Group items by supplier so orders can be placed together.\n' +
  '- For each item suggest a sensible order quantity (higher priority or lower stock = order more).\n' +
  '- Where several potencies / packs / forms of the SAME medicine appear, point out if they can be consolidated into one order.\n' +
  '- Give an approximate total in Rs per supplier and an overall total, using only the costs provided.\n' +
  '- Use ONLY the data given; never invent medicines or prices. Currency is Indian Rupees.\n' +
  '- Be concise: a short per-supplier list, then one total line. You CANNOT place orders — recommendations only.';

/** planorder (Tier 2) — monthly purchase plan from the compact digest only. */
function wqePlanOrder(body) {
  var key = PropertiesService.getScriptProperties().getProperty('OPENROUTER_API_KEY');
  if (!key) throw new Error('OPENROUTER_API_KEY is not set in Script properties');
  var inv = wqeInventory();
  var digest = wqeOrderDigest(inv, num(body.limit) || 0);
  if (!digest.items.length) {
    return { plan: 'Nothing needs reordering right now — no low, out-of-stock or priority items.', digest: digest, aiCalled: false };
  }
  var model = PropertiesService.getScriptProperties().getProperty('MODEL') || LENS_MODEL_DEFAULT;
  var maxTokens = Number(PropertiesService.getScriptProperties().getProperty('WQE_PLAN_MAX_TOKENS')) || WQE_PLAN_MAX_TOKENS_DEFAULT;
  var focus = body.supplier ? ('\nFocus only on supplier: ' + String(body.supplier)) : '';
  var payload = {
    model: model, temperature: 0.2, max_tokens: maxTokens,
    messages: [
      { role: 'system', content: WQE_PLAN_PROMPT },
      { role: 'user', content: 'Reorder candidates (JSON):\n' + JSON.stringify(digest.items) + focus }
    ]
  };
  return { plan: wqeOpenRouter(key, payload, 'Wise Order Planner'), digest: digest, model: model, aiCalled: true };
}

var WQE_ASK_PROMPT =
  'You are Wise AI, an inventory assistant for Wise Homeopathy (homeopathy clinic and dispensary).\n' +
  'Answer the question ONLY from the JSON facts provided (matched medicines with their potencies, rates in Rs, packs, forms and stock). Never invent data.\n' +
  'Be concise and practical for a small clinic owner. Currency is Indian Rupees. You CANNOT change stock or place orders — recommendations only.\n' +
  'If the provided facts do not cover the question, say so plainly.';

/** askwhims (Tier 2) — free-text question; Tier 1 attaches only the relevant facts. */
function wqeAskWhims(body) {
  var key = PropertiesService.getScriptProperties().getProperty('OPENROUTER_API_KEY');
  if (!key) throw new Error('OPENROUTER_API_KEY is not set in Script properties');
  var q = String(body.question || body.q || '').trim();
  if (!q) throw new Error('No question provided');
  var inv = wqeInventory();
  var groups = wqeGroupAll(inv);
  var scored = [];
  for (var key2 in groups) scored.push({ g: groups[key2], score: wqeMentionScore(q, groups[key2].name) });
  scored.sort(function (a, b) { return b.score - a.score; });
  var facts = [];
  for (var i = 0; i < scored.length && facts.length < 6; i++) {
    if (scored[i].score < 0.34) break;
    var f = wqeFacets(scored[i].g.variants);
    facts.push({
      name: scored[i].g.name, potencies: f.potencies.list, rates: f.rates.list,
      priceRange: { min: f.rates.min, max: f.rates.max }, packs: f.packs.list,
      forms: f.forms.list, totalBottles: f.totalBottles, inStock: f.inStock
    });
  }
  var model = PropertiesService.getScriptProperties().getProperty('MODEL') || LENS_MODEL_DEFAULT;
  var maxTokens = Number(PropertiesService.getScriptProperties().getProperty('WQE_ASK_MAX_TOKENS')) || WQE_ASK_MAX_TOKENS_DEFAULT;
  var payload = {
    model: model, temperature: 0.3, max_tokens: maxTokens,
    messages: [
      { role: 'system', content: WQE_ASK_PROMPT },
      { role: 'user', content: 'Question: ' + q + '\n\nMatched inventory facts (JSON):\n' + JSON.stringify(facts) }
    ]
  };
  return { answer: wqeOpenRouter(key, payload, 'Wise Ask'), facts: facts, model: model, aiCalled: true };
}

// ===================== ROUTER (wraps doGet/doPost at load) ====================
// Same self-wiring trick the Undo feature uses on approveOne — no existing
// line is edited. Tier-1 actions are read-only, so they also answer over GET.

(function () {
  var _wqeOrigDoPost = doPost;
  var WQE_POST = { smartsearch: 1, medgroup: 1, medfacets: 1, planorder: 1, askwhims: 1 };
  doPost = function (e) {
    try {
      var peek = JSON.parse(e.postData.contents);
      var act = String(peek.action || '').toLowerCase();
      if (WQE_POST[act]) {
        peek.user = requireAuth(peek.token);
        assertPermission(act, getUserRole(peek.user), peek); // v4.5 RBAC — one policy; WQE = all roles, still gated by the same authority
        peek.role = getUserRole(peek.user);
        var data;
        if (act === 'smartsearch')      data = wqeSmartSearch(peek);
        else if (act === 'medgroup')    data = wqeMedGroup(peek);
        else if (act === 'medfacets')   data = wqeMedFacets(peek);
        else if (act === 'planorder')   data = wqePlanOrder(peek);
        else if (act === 'askwhims')    data = wqeAskWhims(peek);
        return json({ ok: true, data: data });
      }
    } catch (err) {
      return json({ ok: false, error: String(err).replace('Error: ', '') });
    }
    return _wqeOrigDoPost(e);
  };
})();

(function () {
  var _wqeOrigDoGet = doGet;
  var WQE_GET = { smartsearch: 1, medgroup: 1, medfacets: 1 }; // Tier 1 only over GET
  doGet = function (e) {
    var act = String(e.parameter.action || '').toLowerCase();
    if (WQE_GET[act]) {
      try {
        var _wu = requireAuth(e.parameter.token);
        assertPermission(act, getUserRole(_wu), e.parameter); // v4.5 RBAC — same authority as the main router
        var p = e.parameter;
        var data = act === 'smartsearch' ? wqeSmartSearch(p) : act === 'medgroup' ? wqeMedGroup(p) : wqeMedFacets(p);
        return json({ ok: true, data: data });
      } catch (err) {
        return json({ ok: false, error: String(err).replace('Error: ', '') });
      }
    }
    return _wqeOrigDoGet(e);
  };
})();