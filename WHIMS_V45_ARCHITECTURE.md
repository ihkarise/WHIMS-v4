# WHIMS v4.5 — Architecture & RBAC Review

Branch: `claude/cool-bell-1xitau` · Status: **review only** (no PR, no merge, no
GitLab, no domain, no deploy). This document is the requested end-of-phase
report.

---

## A. What is actually implemented in this branch

**Seven smart-inventory features** (client logic in `whims-v45.js`, UI in
`whims-v45-ui.js`):
- A Smart layered/fuzzy search + autosuggest + closest-match fallback
- B Related pack-size / potency variants (stock never merged)
- C Database import with preview / validation / append-only commit
- D Order quantity + unit-aware Copy/WhatsApp messages
- E "Dispensed This Week" dashboard panel
- F Unit-cost receiving (quantity × cost-per-bottle, money-safe)
- G Multi-supplier contacts + WhatsApp ordering

**Full server-side RBAC + two-tier user management** (`Code.gs`, UI in
`whims-users.js`):
- Roles MASTER_ADMIN / ADMIN / OPERATOR / VIEWER, all authority enforced in
  `Code.gs` (never trusting the token payload, request body, localStorage, or
  hidden buttons).
- MASTER_ADMIN is backend/editor-only and cannot be created, changed,
  deactivated, or deleted through the frontend API.
- Frontend User Management panel for ADMIN / MASTER_ADMIN.
- Strict numeric validation on all stock writes.
- Append-only, ADMIN-only import.

**Tests:** 196 assertions across three runnable suites (see §G).

---

## B. What existing WHIMS functionality is present (and preserved)

Present and working in this repository, untouched except where explicitly
extended:
- **Frontend app** (`app.js`) — dashboard, search, detail sheet, receive,
  dispense, adjust, archive/restore, orders (priority + copy/WhatsApp),
  history, settings, **login/logout + session tokens**.
- **v4.1 layer** (`whims-v41.js`) — autocomplete, add-new-medicine sheet,
  correction sheet, daily stats, theme/sound/backup, history filter.
- **v4.2 Core** (`whims-core.js`) — util, Intelligence analytics, fuzzy Search,
  Bulk processor, Plugins/event bus.
- **Feature modules** — `whims-orders.js` (advanced order board + per-supplier
  WhatsApp), `whims-intake.js` (intake review + undo), `whims-dashboard.js`
  (intelligence cards), `whims-source.js` / `source-analytics-fix.js` (Wise
  Lens source analytics), `whims-ai.js` (AI assistant trigger),
  `whims-workflow.js` (workflow engine).
- **Backend** (`Code.gs`) — inventory/transaction read, receive/dispense/adjust/
  archive/restore/priority writes, login/session/lockout, salted SHA-256 auth.

Nothing above was removed, renamed, or rebuilt.

---

## C. What is MISSING from the complete v4.5 specification (important)

This repository ships a **reduced backend**. The frontend modules reference
backend capabilities that **do not exist in this `Code.gs`**. They must be
integrated from the correct existing/full WHIMS backend — they were **not**
recreated here (recreating a reduced version would risk diverging from the
real system):

| Subsystem | Frontend present? | Backend in this `Code.gs`? | Action |
|-----------|-------------------|----------------------------|--------|
| Orders (qty cart, PO lifecycle) | Yes (`whims-orders.js`) | **No** (only reorder `priority`) | Integrate from real backend |
| Intake (pending stock review) | Yes (`whims-intake.js`, app.js) | **No** (`readintake`/`approveintake`/`rejectintake` absent) | Integrate from real backend |
| Approval / ApprovalUndo | Yes (intake UI has undo) | **No** | Integrate from real backend |
| Packaging bridge | Not in this repo | **No** | Integrate; must not create medicines |
| Wise Query Engine (WQE) | `whims-ai.js` trigger only | **No** (reserved read-only stubs) | Integrate from real backend |
| v4.4 backend behaviours | — | **No** | Confirm against real backend |

**Do not treat WHIMS v4.5 as complete** until these are integrated. This branch
delivers the seven features + RBAC/user-management cleanly and additively; it
does **not** contain the Orders/Intake/Approval/Packaging/WQE backends.

**RBAC coverage note:** the RBAC gating in this branch protects the actions that
exist in this backend. Actions that live in the *full* backend (intake approval
types, packaging DISPENSE, order operations) must reuse the same
`authContext()` + `requireCapability()` / capability map when integrated — the
mechanism is in place and documented for them.

---

## D. Every file changed

| File | New? | Purpose |
|------|------|---------|
| `whims-v45.js` | new | Pure, tested logic for the 7 features |
| `whims-v45.test.js` | new | 104-assertion unit suite |
| `whims-v45-ui.js` | new | Additive UI wiring for the 7 features |
| `whims-v45.css` | new | Styles (features + User Management panel) |
| `whims-users.js` | new | Frontend User Management panel (RBAC-gated) |
| `whims-rbac.test.js` | new | 76-assertion backend RBAC/validation suite (drives real `Code.gs`) |
| `whims-v45.integration.test.js` | new | 16-check jsdom integration suite |
| `WHIMS_V45_NOTES.md` | new | Feature implementation notes |
| `WHIMS_V45_ARCHITECTURE.md` | new | This report |
| `Code.gs` | edited | RBAC, user management, numeric validation, unit-cost receive, append-only import, `me`, WQE reservation |
| `app.js` | edited | Unit-cost receive handler; role capture/refresh/broadcast |
| `index.html` | edited | Receive cost field; script/style includes |

---

## E. Every API action (this backend)

**doGet (all roles may read):** `ping` (public), `inventory`, `transactions`,
`me`; reserved read-only `smartsearch` / `medgroup` / `medfacets` / `planorder`
/ `askwhims` (WQE — return "not integrated").

**doPost — public:** `login`, `logout`.

**doPost — authenticated, role-gated:**

| Action | Min role | Notes |
|--------|----------|-------|
| `receive` | OPERATOR | validated qty × unit cost |
| `dispense` | OPERATOR | validated qty |
| `priority` | OPERATOR | reorder priority 0–5 |
| `adjust` | ADMIN | validated bottle count |
| `archive` | ADMIN | |
| `restore` | ADMIN | |
| `importmedicines` | ADMIN | append-only, never overwrites |
| `listusers` | ADMIN | no salt/hash returned |
| `createuser` | ADMIN | `canAssignRole` enforced |
| `updateuser` | ADMIN | `canManageTarget` enforced |
| `changerole` | ADMIN | `canManageTarget` + `canAssignRole` |
| `activateuser` / `deactivateuser` | ADMIN | not self, not MASTER_ADMIN |
| `resetpassword` | ADMIN | password never returned |

VIEWER (rank 1) is rejected on **every** write with `Forbidden` before any
sheet access.

---

## F. RBAC permission matrix

### Role hierarchy
`MASTER_ADMIN (4) > ADMIN (3) > OPERATOR (2) > VIEWER (1)`
MASTER_ADMIN is a **protected security level**, not an ordinary selectable role.

### Inventory / operational actions

| Action | MASTER_ADMIN | ADMIN | OPERATOR | VIEWER |
|--------|:---:|:---:|:---:|:---:|
| Inventory / transaction read, analytics, search | ✅ | ✅ | ✅ | ✅ |
| Receive (existing medicine) | ✅ | ✅ | ✅ | ❌ |
| Dispense | ✅ | ✅ | ✅ | ❌ |
| Reorder priority / order ops | ✅ | ✅ | ✅ | ❌ |
| Stock adjustment | ✅ | ✅ | ❌ | ❌ |
| Archive / restore | ✅ | ✅ | ❌ | ❌ |
| Add medicine / master-data / database import | ✅ | ✅ | ❌ | ❌ |
| Undo approval, ADD_NEW intake approval¹ | ✅ | ✅ | ❌ | ❌ |
| Existing-medicine RECEIVE approval, packaging DISPENSE¹ | ✅ | ✅ | ✅ | ❌ |

¹ These live in the full backend (not this repo). They must adopt the same
capability map on integration — documented, not yet wired here.

### User management

| Capability | MASTER_ADMIN | ADMIN | OPERATOR | VIEWER |
|------------|:---:|:---:|:---:|:---:|
| Open User Management | ✅ | ✅ | ❌ | ❌ |
| Create ADMIN | ✅ | ❌ | ❌ | ❌ |
| Create OPERATOR / VIEWER | ✅ | ✅ | ❌ | ❌ |
| Create MASTER_ADMIN | ❌ (editor only) | ❌ | ❌ | ❌ |
| Change ADMIN role | ✅ | ❌ | ❌ | ❌ |
| Change OPERATOR / VIEWER role | ✅ | ✅ | ❌ | ❌ |
| Deactivate / reset ADMIN | ✅ | ❌ | ❌ | ❌ |
| Deactivate / reset OPERATOR / VIEWER | ✅ | ✅ | ❌ | ❌ |
| Change / delete / deactivate MASTER_ADMIN | ❌ (editor only) | ❌ | ❌ | ❌ |
| Assign MASTER_ADMIN role | ❌ (editor only) | ❌ | ❌ | ❌ |

Enforced by `canAssignRole(actorRole, newRole)` and
`canManageTarget(actorRole, targetRole)` in `Code.gs`; a MASTER_ADMIN target is
untouchable via the API for every actor.

---

## Master Admin protection mechanism

- Created/recovered **only** from the Apps Script editor via
  `SET_MASTER_ADMIN()` (edit constants → run ▶ → blank the password). This is
  the sole path that mints a MASTER_ADMIN.
- `canAssignRole()` returns `false` for `MASTER_ADMIN` for **every** actor, so
  neither `createuser` nor `changerole` can ever produce one.
- `canManageTarget()` returns `false` when the target is MASTER_ADMIN, so no API
  actor can change its role, deactivate it, or reset it.
- The credentials/salt/hash are never sent to the frontend; the panel shows the
  master row as `🔒 protected` with no actions.

## User migration mechanism

- Legacy records `{salt, hash}` are read as-is. `roleOf()` returns `OPERATOR`
  for any account without a role, so **existing users keep working immediately**
  without recreation.
- `MIGRATE_ROLES()` (editor) persists `role: "OPERATOR"` and `active: true` onto
  pre-role accounts once; it never changes an existing role and never touches a
  MASTER_ADMIN. Verified by `whims-rbac.test.js` (§14).

## Password security mechanism

- Passwords are validated (≥8 chars) and hashed server-side with a unique
  per-user salt (SHA-256). Only `{salt, hash}` is stored — never plaintext.
- No API response ever returns a password, hash, or salt (`listusers`,
  `createuser`, `resetpassword` all verified clean).
- Reset password: admin supplies a new/temporary value; the backend re-salts and
  re-hashes; the API returns only success. Passwords are never logged.

---

## G. Tests

All three suites are runnable and were run on this branch:

```
node whims-v45.test.js            → 104 passed, 0 failed   (unit: 7 features)
node whims-rbac.test.js           →  76 passed, 0 failed   (backend RBAC/validation, direct API)
node whims-v45.integration.test.js→  16 passed, 0 failed   (jsdom; needs `npm i jsdom`, else skips)
------------------------------------------------------------
TOTAL                                196 passed, 0 failed, 0 skipped*
```
\* integration suite skips cleanly (counts as not-run) if jsdom is absent; it
was run here with jsdom installed.

**RBAC/user-management coverage** (`whims-rbac.test.js` drives the real
`doGet`/`doPost`, i.e. direct-API authorization, not UI):
1–3 master creates ADMIN/OPERATOR/VIEWER · 4–5 admin creates OPERATOR/VIEWER ·
6 admin ✗ADMIN · 7/7b admin & master ✗MASTER_ADMIN via API · 8 operator ✗users ·
9 viewer ✗users · 10 admin ✗change master · 11/11b/11c ✗deactivate/change master
(admin & master via API) · 12/12b ✗promote to MASTER_ADMIN / self-promote ·
13 ✗unknown role · 14 legacy→OPERATOR migration + login still works ·
15–16 password never returned / never plaintext · 17 reset password (authorised
only) · 18 deactivated cannot log in (incl. existing token) · 19 reactivate
restores + cannot deactivate self · VIEWER blocked on every write · OPERATOR
blocked on ADMIN-only · numeric validation (non-numeric/zero/negative/fractional/
`1e3`/negative-cost rejected; zero cost permitted) · legacy total-cost maths ·
role-spoof in body ignored · `me` returns server role · WQE reserved read-only.

---

## H. Remaining work (future phases — not started)

1. **Integrate the full backend** for Orders, Intake, Approval, ApprovalUndo,
   Packaging, and WQE from the real WHIMS backend (see §C). Apply the same
   `authContext()` + capability map to their write actions.
2. **Live Apps Script QA** of `Code.gs` (run `SET_MASTER_ADMIN`, `MIGRATE_ROLES`;
   smoke-test each action end-to-end on the deployment).
3. **On-device mobile QA** (desktop + phone) of the new panels/sheets.
4. **WQE integration** (`smartsearch`/`medgroup`/`medfacets`/`planorder`/
   `askwhims`) — must remain read/analysis-only.
5. **Packaging integration** (`stagepackaging → Intake → DISPENSE approval →
   dispenseStock`); packaging must not create medicines.
6. GitLab migration · GitLab Pages · custom domain `whims.wisehomeopathy.com` ·
   DNS · production deploy — **explicitly out of scope; do not start**.

---

## Remaining security concerns / notes

- **No open privilege-escalation path found** in this backend: authority is
  resolved from the server-side user store per request; body/token role fields
  are never trusted; MASTER_ADMIN is unreachable via the API. Verified by
  direct-API tests.
- **Session role staleness:** the token stores only the username; the role is
  re-resolved from the store every request, so role changes / deactivations take
  effect immediately (no stale-token escalation).
- **Cache-backed sessions/lockout** rely on Apps Script `CacheService`, which can
  evict early under memory pressure — acceptable (worst case = re-login), same as
  the pre-existing design.
- **Error messages** are intentionally generic (`Forbidden — …`, `Wrong username
  or password`) and never leak whether a username exists on the failed-login
  path (existing behaviour preserved).
- **Rate-limiting** covers login (5 tries / 10 min). User-management endpoints
  are ADMIN-gated but not separately rate-limited — consider adding if exposed
  broadly.
- **Transport/CORS:** unchanged from the existing design (text/plain POST to the
  Apps Script Web App). Review during the hosting phase.
- **Live-backend caveat:** the backend logic is verified under Node stubs, not on
  a live Apps Script deployment — item H.2 must be completed before production.
