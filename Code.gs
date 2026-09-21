/**
 * WISE HOMEOPATHY INVENTORY MANAGEMENT SYSTEM (WHIMS)
 * Google Apps Script Backend — v4.5 (login + session tokens + amounts + RBAC)
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
 * ROLE-BASED ACCESS CONTROL (v4.5)
 * --------------------------------
 * Roles, highest authority first:
 *   MASTER_ADMIN — the highest account. Created / recovered ONLY from this
 *                  Apps Script editor (SET_MASTER_ADMIN). It can NEVER be
 *                  created, changed, deactivated or deleted through the normal
 *                  frontend API — the frontend cannot manufacture one.
 *   ADMIN        — a frontend administrator. Created by a MASTER_ADMIN. May
 *                  manage OPERATOR / VIEWER accounts only.
 *   OPERATOR     — normal working staff (receive, dispense, orders, intake…).
 *   VIEWER       — read-only. No write capability whatsoever.
 *
 * • Authority is decided ENTIRELY server-side here. The frontend role value,
 *   hidden buttons and localStorage are UI conveniences only and are never
 *   trusted. Every request resolves the caller's role from the server-side
 *   user store (not from the token or the request body) and checks it.
 * • Existing users that predate roles default to OPERATOR (see MIGRATE_ROLES).
 *
 * FIRST-TIME SETUP (do once, from the editor):
 * 1. Edit the MASTER_* constants inside SET_MASTER_ADMIN() and run it (▶).
 *    Then blank the password line again. This is the ONLY way a MASTER_ADMIN
 *    is ever created.
 * 2. Run MIGRATE_ROLES() once to stamp OPERATOR onto any pre-role accounts.
 * 3. From then on, the MASTER_ADMIN creates ADMINs in the app's User
 *    Management panel, and ADMINs create OPERATOR / VIEWER staff.
 * ADD_USER / SET_ROLE / LIST_USERS / REMOVE_USER remain as editor helpers.
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
var USERS_KEY = 'WHIMS_USERS';

var COL = {
  ID: 1, NAME: 2, PACK: 3, POTENCY: 4, CATEGORY: 5,
  BOTTLES: 6, ML: 7, PRIORITY: 8, SUP1: 9, COST1: 10,
  SUP2: 11, COST2: 12, COST_ML: 13, DAYS: 14, MFD: 15,
  EXPIRY: 16, UPDATED: 17, ACTIVE: 18, STATUS: 19, REMARKS: 20
};

// Role authority ranking. Higher rank = more authority. MASTER_ADMIN is a
// protected security level, never an ordinary selectable role in the frontend.
var ROLE_RANK = { VIEWER: 1, OPERATOR: 2, ADMIN: 3, MASTER_ADMIN: 4 };
var DEFAULT_ROLE = 'OPERATOR';   // legacy accounts without a role become this

/** Minimum role rank required for each write action. Reads are not listed
 *  here — any authenticated account may read. VIEWER (rank 1) fails every
 *  entry below, so VIEWER has no write capability at all. */
var ACTION_MIN_RANK = {
  receive: ROLE_RANK.OPERATOR,
  dispense: ROLE_RANK.OPERATOR,
  priority: ROLE_RANK.OPERATOR,
  adjust: ROLE_RANK.ADMIN,
  archive: ROLE_RANK.ADMIN,
  restore: ROLE_RANK.ADMIN,
  importmedicines: ROLE_RANK.ADMIN
};

// ==================== USER MANAGEMENT (run from editor) ====================

/**
 * Create / recover the MASTER_ADMIN. EDITOR-ONLY. This is the single, secure
 * bootstrap for the highest account — it is never reachable from the frontend
 * API. Edit the two constants, run from the ▶ toolbar, then blank the password.
 */
function SET_MASTER_ADMIN() {
  var MASTER_USERNAME = 'master';   // ← edit, then run
  var MASTER_PASSWORD = '';         // ← put password here, run, then blank it again
  if (!MASTER_USERNAME || !MASTER_PASSWORD) throw new Error('Fill in MASTER_USERNAME and MASTER_PASSWORD first.');
  if (MASTER_PASSWORD.length < 8) throw new Error('Use at least 8 characters.');
  upsertUser(MASTER_USERNAME, MASTER_PASSWORD, 'MASTER_ADMIN');
  Logger.log('MASTER_ADMIN "' + MASTER_USERNAME + '" created/updated. Now blank the MASTER_PASSWORD line.');
}

/** Editor helper: create/update a normal user with an explicit role.
 *  ADD_USER('jasmine','secretpw','OPERATOR') — or edit the constants and run. */
function ADD_USER(username, password, role) {
  var USERNAME = username || 'jasmine';   // ← edit, then run
  var PASSWORD = password || '';          // ← put password here, run, then blank it again
  var ROLE = role || 'OPERATOR';
  if (!USERNAME || !PASSWORD) throw new Error('Fill in USERNAME and PASSWORD first.');
  if (PASSWORD.length < 8) throw new Error('Use at least 8 characters.');
  if (String(ROLE).toUpperCase() === 'MASTER_ADMIN') throw new Error('Use SET_MASTER_ADMIN() for the master account.');
  upsertUser(USERNAME, PASSWORD, ROLE);
  Logger.log('User "' + USERNAME + '" (' + normalizeRole(ROLE) + ') created/updated. Now blank the PASSWORD line.');
}

/** Editor helper: change a user's role. SET_ROLE('jasmine','ADMIN'). */
function SET_ROLE(username, role) {
  var USERNAME = username || '';   // ← edit, then run
  var ROLE = role || 'OPERATOR';
  if (!USERNAME) throw new Error('Fill in USERNAME first.');
  var users = loadUsers();
  var rec = users[USERNAME.toLowerCase()];
  if (!rec) throw new Error('No such user: ' + USERNAME);
  var nr = normalizeRole(ROLE);
  if (!nr) throw new Error('Unknown role: ' + ROLE);
  rec.role = nr;
  saveUsers(users);
  Logger.log('Role of "' + USERNAME + '" set to ' + nr + '.');
}

function REMOVE_USER(username) {
  var USERNAME = username || '';               // ← edit, then run
  if (!USERNAME) throw new Error('Fill in USERNAME first.');
  var users = loadUsers();
  delete users[USERNAME.toLowerCase()];
  saveUsers(users);
  Logger.log('User "' + USERNAME + '" removed.');
}

function LIST_USERS() {
  var users = loadUsers();
  var lines = Object.keys(users).map(function (u) {
    return u + ' — ' + (normalizeRole(users[u].role) || DEFAULT_ROLE) +
      (users[u].active === false ? ' (inactive)' : '');
  });
  Logger.log('Users:\n' + (lines.join('\n') || '(none)'));
}

/**
 * One-off migration: stamp DEFAULT_ROLE (OPERATOR) and active:true onto any
 * account that predates roles. Never changes an existing role, never touches
 * a MASTER_ADMIN, never invalidates or recreates accounts.
 */
function MIGRATE_ROLES() {
  var users = loadUsers();
  var changed = 0;
  Object.keys(users).forEach(function (u) {
    var rec = users[u];
    if (!normalizeRole(rec.role)) { rec.role = DEFAULT_ROLE; changed++; }
    if (rec.active === undefined) rec.active = true;
  });
  saveUsers(users);
  Logger.log('MIGRATE_ROLES: ' + changed + ' account(s) defaulted to ' + DEFAULT_ROLE + '.');
  return { migrated: changed };
}

function loadUsers() {
  var raw = PropertiesService.getScriptProperties().getProperty(USERS_KEY);
  return raw ? JSON.parse(raw) : {};
}
function saveUsers(users) {
  PropertiesService.getScriptProperties().setProperty(USERS_KEY, JSON.stringify(users));
}

/** Create or update a user record with a fresh salt+hash. Shared by editor
 *  helpers and the authorised frontend actions. Preserves created/active. */
function upsertUser(username, password, role) {
  var users = loadUsers();
  var key = String(username).trim().toLowerCase();
  if (!key) throw new Error('Username required');
  var nr = normalizeRole(role) || DEFAULT_ROLE;
  var salt = Utilities.getUuid();
  var prev = users[key] || {};
  users[key] = {
    salt: salt,
    hash: hashPw(salt, password),
    role: nr,
    active: prev.active === undefined ? true : prev.active,
    displayName: prev.displayName || '',
    created: prev.created || nowStamp(),
    lastLogin: prev.lastLogin || ''
  };
  saveUsers(users);
  return key;
}

function hashPw(salt, pw) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + '::' + pw, Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('');
}

function nowStamp() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
}

// ==================== ROLE / AUTHORIZATION CORE ====================

/** Canonical role string, or '' if unrecognised. */
function normalizeRole(r) {
  var s = String(r == null ? '' : r).toUpperCase().replace(/[\s-]+/g, '_');
  return ROLE_RANK[s] ? s : '';
}
function rankOf(role) { return ROLE_RANK[normalizeRole(role)] || 0; }

/** The stored role for a username (default OPERATOR for legacy accounts). */
function roleOf(username) {
  var rec = loadUsers()[String(username).toLowerCase()];
  if (!rec) return '';
  return normalizeRole(rec.role) || DEFAULT_ROLE;
}

/** Which roles a given actor may CREATE or ASSIGN. MASTER_ADMIN is never
 *  assignable through the API — only SET_MASTER_ADMIN in the editor makes one. */
function canAssignRole(actorRole, newRole) {
  var nr = normalizeRole(newRole);
  if (!nr || nr === 'MASTER_ADMIN') return false;          // frontend can never mint a master
  if (normalizeRole(actorRole) === 'MASTER_ADMIN') return nr === 'ADMIN' || nr === 'OPERATOR' || nr === 'VIEWER';
  if (normalizeRole(actorRole) === 'ADMIN') return nr === 'OPERATOR' || nr === 'VIEWER';   // admins cannot make admins
  return false;
}

/** Whether an actor may manage (edit/role/deactivate/reset) a target account
 *  of the given current role. A MASTER_ADMIN target is untouchable via the API. */
function canManageTarget(actorRole, targetRole) {
  if (normalizeRole(targetRole) === 'MASTER_ADMIN') return false;   // master is editor-only
  if (normalizeRole(actorRole) === 'MASTER_ADMIN') return true;     // over ADMIN/OPERATOR/VIEWER
  if (normalizeRole(actorRole) === 'ADMIN') {
    return normalizeRole(targetRole) === 'OPERATOR' || normalizeRole(targetRole) === 'VIEWER';
  }
  return false;
}

/** Gate an inventory/stock write action by role rank. Throws on refusal. */
function requireCapability(role, action) {
  var need = ACTION_MIN_RANK[action];
  if (need == null) return;                        // not a gated write (e.g. read)
  if (rankOf(role) < need) throw new Error('Forbidden — your role is not permitted to ' + action);
}

// ==================== NUMERIC VALIDATION ====================

/** Strict numeric parse: returns NaN for null/blank/malformed strings. Unlike
 *  the display helper num(), this NEVER silently coerces junk to 0. */
function parseNum(v) {
  if (v === null || v === undefined || v === '') return NaN;
  if (typeof v === 'number') return isFinite(v) ? v : NaN;
  var s = String(v).trim();
  if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(s)) return NaN;   // reject "abc", "1.2.3", "5x", ""
  var n = Number(s);
  return isFinite(n) ? n : NaN;
}

/** Validate a required numeric input. opts: {gt, min, max, integer}. Throws a
 *  clear (non-leaky) error on any violation. */
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
  // record last login (best-effort; never blocks auth)
  try { rec.lastLogin = nowStamp(); saveUsers(users); } catch (e) {}
  return { token: token, user: u, role: normalizeRole(rec.role) || DEFAULT_ROLE, hours: SESSION_HOURS };
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

/**
 * Resolve the authenticated caller AND their current server-side role from the
 * user store — not from the token payload or the request body. A role changed
 * or an account deactivated takes effect immediately on the next request.
 * Returns { user, role }. Throws for missing/expired sessions or deactivated
 * accounts. THIS is the trust boundary for every privileged action.
 */
function authContext(token) {
  var username = requireAuth(token);
  var rec = loadUsers()[username];
  if (!rec) throw new Error('Session expired — please log in again');
  if (rec.active === false) throw new Error('Account is deactivated');
  return { user: username, role: normalizeRole(rec.role) || DEFAULT_ROLE };
}

// ==================== HTTP ENTRY POINTS ====================

// Read/analysis-only WQE actions. RESERVED here so the contract is fixed and
// read-only, but the analytical engine itself is NOT part of this backend (see
// WHIMS_V45_NOTES.md → architecture). They must be integrated from the real
// WQE backend; until then they return a clear "not integrated" error and can
// never write.
var WQE_ACTIONS = ['smartsearch', 'medgroup', 'medfacets', 'planorder', 'askwhims'];

function doGet(e) {
  var action = (e.parameter.action || 'inventory').toLowerCase();
  try {
    if (action === 'ping') return json({ ok: true, message: 'WHIMS backend is live', time: new Date().toISOString() });
    var ctx = authContext(e.parameter.token); // everything else needs a session
    // All roles may read.
    if (action === 'inventory') return json({ ok: true, data: getInventory() });
    if (action === 'transactions') return json({ ok: true, data: getTransactions(Number(e.parameter.limit) || 100) });
    if (action === 'me') return json({ ok: true, data: { user: ctx.user, role: ctx.role } });
    if (WQE_ACTIONS.indexOf(action) >= 0) {
      return json({ ok: false, error: 'WQE (' + action + ') is read-only and not integrated in this backend yet' });
    }
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

    // Identity AND the caller's authority come from the server-side
    // session/user store (ctx), never from the client. Authorization decisions
    // below use ctx.role only — a `role` field in the request body is treated
    // purely as a REQUESTED parameter (e.g. the role to assign a new user) and
    // is always validated against ctx.role, so a spoofed role cannot escalate.
    var ctx = authContext(body.token);
    body.user = ctx.user;

    // ---- user & role management (each handler enforces its own authority) ----
    if (USER_ADMIN_ACTIONS.indexOf(action) >= 0) {
      return json({ ok: true, data: userAdmin(action, ctx, body) });
    }

    // ---- inventory / stock actions: gate by role rank ----
    requireCapability(ctx.role, action);   // no-op for reads; blocks VIEWER on every write
    var result;
    if (action === 'receive')       result = receiveStock(body);
    else if (action === 'dispense') result = dispenseStock(body);
    else if (action === 'adjust')   result = adjustStock(body);
    else if (action === 'archive')  result = setActive(body, 'NO', 'ARCHIVE');
    else if (action === 'restore')  result = setActive(body, 'YES', 'RESTORE');
    else if (action === 'priority') result = setPriority(body);
    else if (action === 'importmedicines') result = importMedicines(body);
    else throw new Error('Unknown action: ' + action);
    return json({ ok: true, data: result });
  } catch (err) {
    return json({ ok: false, error: String(err).replace('Error: ', '') });
  } finally {
    lock.releaseLock();
  }
}

// ==================== USER & ROLE MANAGEMENT (frontend, authorised) ====================

var USER_ADMIN_ACTIONS = ['listusers', 'createuser', 'updateuser', 'changerole',
  'activateuser', 'deactivateuser', 'resetpassword'];

/** Dispatch + require the caller to be at least ADMIN for any user management.
 *  Individual handlers apply the finer target/role rules. */
function userAdmin(action, ctx, body) {
  if (rankOf(ctx.role) < ROLE_RANK.ADMIN) throw new Error('Forbidden — user management requires administrator access');
  if (action === 'listusers') return listUsersApi(ctx);
  if (action === 'createuser') return createUser(ctx, body);
  if (action === 'updateuser') return updateUser(ctx, body);
  if (action === 'changerole') return changeRole(ctx, body);
  if (action === 'activateuser') return setUserActive(ctx, body, true);
  if (action === 'deactivateuser') return setUserActive(ctx, body, false);
  if (action === 'resetpassword') return resetPassword(ctx, body);
  throw new Error('Unknown action: ' + action);
}

/** Safe public view of a user — NEVER includes salt, hash, or any secret. */
function publicUser(username, rec) {
  return {
    username: username,
    displayName: rec.displayName || '',
    role: normalizeRole(rec.role) || DEFAULT_ROLE,
    active: rec.active !== false,
    created: rec.created || '',
    lastLogin: rec.lastLogin || ''
  };
}

function listUsersApi(ctx) {
  var users = loadUsers();
  var out = Object.keys(users).sort().map(function (u) { return publicUser(u, users[u]); });
  return { users: out, actorRole: ctx.role };
}

function requireUsername(body) {
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

function createUser(ctx, body) {
  var key = requireUsername(body);
  var role = normalizeRole(body.role);
  if (!role) throw new Error('A valid role is required');
  // Backend rejects any forbidden role regardless of what the UI sent.
  if (!canAssignRole(ctx.role, role)) throw new Error('Forbidden — you may not create a ' + (normalizeRole(body.role) || 'that') + ' account');
  var pw = validatePassword(body.password);
  var users = loadUsers();
  if (users[key]) throw new Error('That username already exists');
  upsertUser(key, pw, role);
  if (body.displayName) { var u2 = loadUsers(); u2[key].displayName = String(body.displayName).slice(0, 80); saveUsers(u2); }
  return publicUser(key, loadUsers()[key]);   // no password / hash / salt returned
}

/** Load a target user for a management op, enforcing the manage-target rule. */
function loadManageableTarget(ctx, body) {
  var key = requireUsername(body);
  var users = loadUsers();
  var rec = users[key];
  if (!rec) throw new Error('No such user');
  var targetRole = normalizeRole(rec.role) || DEFAULT_ROLE;
  if (!canManageTarget(ctx.role, targetRole)) throw new Error('Forbidden — you may not manage this account');
  return { key: key, users: users, rec: rec, targetRole: targetRole };
}

function updateUser(ctx, body) {
  var t = loadManageableTarget(ctx, body);
  if (body.displayName !== undefined) t.rec.displayName = String(body.displayName || '').slice(0, 80);
  saveUsers(t.users);
  return publicUser(t.key, t.rec);
}

function changeRole(ctx, body) {
  var t = loadManageableTarget(ctx, body);
  var newRole = normalizeRole(body.role);
  if (!newRole) throw new Error('A valid role is required');
  // Cannot assign a role the actor isn't allowed to (incl. never MASTER_ADMIN).
  if (!canAssignRole(ctx.role, newRole)) throw new Error('Forbidden — you may not assign the ' + (normalizeRole(body.role) || 'requested') + ' role');
  t.rec.role = newRole;
  saveUsers(t.users);
  return publicUser(t.key, t.rec);
}

function setUserActive(ctx, body, active) {
  var t = loadManageableTarget(ctx, body);
  if (t.key === ctx.user) throw new Error('You cannot change your own active status');
  t.rec.active = !!active;
  saveUsers(t.users);
  return publicUser(t.key, t.rec);
}

function resetPassword(ctx, body) {
  var t = loadManageableTarget(ctx, body);
  var pw = validatePassword(body.password);   // admin supplies the new/temporary password
  var salt = Utilities.getUuid();
  t.rec.salt = salt;
  t.rec.hash = hashPw(salt, pw);
  saveUsers(t.users);
  return { username: t.key, reset: true };    // password is NEVER returned
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
  // ---- validate the request BEFORE any sheet access (fail fast, no wasted
  // reads). Backend validates independently of the frontend — malformed/NaN/
  // <=0 quantities and negative/malformed costs are rejected here. ----
  var addBottles = requireNumber(body.bottles, 'Received bottles', { gt: 0, integer: true });
  var addMl = null;
  if (body.ml !== undefined && body.ml !== null && body.ml !== '') addMl = requireNumber(body.ml, 'ML received', { min: 0 });
  // Cost rule: unit cost must be numeric and >= 0. ZERO IS PERMITTED (free
  // stock, samples, or cost recorded later); NEGATIVE and malformed are REJECTED.
  // Backward compatible: if only a legacy total `amount` arrives (older
  // clients), derive per-bottle = amount / bottles.
  var amount, unitCost;
  if (body.unitCost !== undefined && body.unitCost !== null && body.unitCost !== '') {
    unitCost = requireNumber(body.unitCost, 'Cost per bottle', { min: 0 });
    amount = round2(unitCost * addBottles);                   // total = qty × unit cost
  } else if (body.amount !== undefined && body.amount !== null && body.amount !== '') {
    amount = requireNumber(body.amount, 'Amount', { min: 0 });  // legacy total path
    unitCost = amount > 0 ? round2(amount / addBottles) : 0;
  } else {
    amount = 0; unitCost = 0;                                   // no cost provided — allowed
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

  if (unitCost > 0) sh.getRange(row, COL.COST1).setValue(unitCost);
  stamp(sh, row);

  logTx(loc.id, loc.name, 'RECEIVE', addBottles, prevBottles, newBottles, body.user,
    joinRemarks(body.supplier ? 'From ' + body.supplier : '', body.remarks), amount);
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

  logTx(loc.id, loc.name, 'DISPENSE', qty, prevBottles, newBottles, body.user,
    body.remarks, num(body.amount));
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

/**
 * Append-only bulk import (v4.5). SAFETY: never overwrites an existing row —
 * a record whose ID already exists, or whose Name+Potency+Pack already matches
 * an active medicine, is skipped. Missing IDs are auto-generated. Existing
 * stock, history and IDs are left completely untouched.
 * body.rows: [{ name, pack?, potency?, category?, bottles?, ml?, priority?,
 *               supplier1?, cost1?, supplier2?, cost2?, mfd?, expiry?, remarks?, id? }]
 * Returns { added, skipped, ids: [...] }.
 */
function importMedicines(body) {
  var rows = body.rows;
  if (!rows || !rows.length) throw new Error('No rows to import');
  if (rows.length > 2000) throw new Error('Too many rows in one import (max 2000)');
  var sh = sheet(INVENTORY_SHEET);
  var existing = getInventory();

  function idKey(v) { return String(v == null ? '' : v).trim().toUpperCase(); }
  function nk(s) { return String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, ''); }
  function comboKey(r) { return nk(r.name) + '|' + nk(r.potency) + '|' + nk(r.pack); }

  var haveId = {}, haveCombo = {}, maxNum = 0;
  existing.forEach(function (m) {
    haveId[idKey(m.id)] = true;
    haveCombo[comboKey(m)] = true;
    var mm = String(m.id).match(/(\d+)\s*$/);
    if (mm) maxNum = Math.max(maxNum, Number(mm[1]));
  });

  var cols = Math.max(20, sh.getLastColumn());
  var added = 0, skipped = 0, ids = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i] || {};
    if (!r.name || String(r.name).trim() === '') { skipped++; continue; }
    var rid = idKey(r.id);
    if (rid && haveId[rid]) { skipped++; continue; }          // never overwrite an existing ID
    if (haveCombo[comboKey(r)]) { skipped++; continue; }       // name+potency+pack already present

    var id = rid || ('GEN' + ('000' + (++maxNum)).slice(-4));
    var rowArr = new Array(cols).fill('');
    rowArr[COL.ID - 1] = id;
    rowArr[COL.NAME - 1] = String(r.name).trim();
    rowArr[COL.PACK - 1] = str(r.pack);
    rowArr[COL.POTENCY - 1] = str(r.potency);
    rowArr[COL.CATEGORY - 1] = str(r.category);
    rowArr[COL.BOTTLES - 1] = r.bottles === '' || r.bottles == null ? '' : num(r.bottles);
    rowArr[COL.ML - 1] = r.ml === '' || r.ml == null ? '' : num(r.ml);
    rowArr[COL.PRIORITY - 1] = r.priority === '' || r.priority == null ? 0 : num(r.priority);
    rowArr[COL.SUP1 - 1] = str(r.supplier1);
    rowArr[COL.COST1 - 1] = r.cost1 === '' || r.cost1 == null ? '' : num(r.cost1);
    rowArr[COL.SUP2 - 1] = str(r.supplier2);
    rowArr[COL.COST2 - 1] = r.cost2 === '' || r.cost2 == null ? '' : num(r.cost2);
    rowArr[COL.MFD - 1] = str(r.mfd);
    rowArr[COL.EXPIRY - 1] = str(r.expiry);
    rowArr[COL.UPDATED - 1] = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
    rowArr[COL.ACTIVE - 1] = 'YES';
    rowArr[COL.REMARKS - 1] = str(r.remarks) || 'Imported ' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
    sh.appendRow(rowArr);
    haveId[idKey(id)] = true; haveCombo[comboKey(r)] = true;
    added++; ids.push(id);
    logTx(id, String(r.name).trim(), 'IMPORT', num(r.bottles), 0, num(r.bottles), body.user, 'Bulk import', 0);
  }
  return { added: added, skipped: skipped, ids: ids };
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
