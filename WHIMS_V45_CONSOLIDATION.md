# WHIMS v4.5 — Backend Consolidation Report

Branch: `claude/cool-bell-1xitau` · **Review only** — no PR, no merge, no deploy,
no GitLab, no domain, no DNS. This is the deliverable required before any PR.

The complete existing WHIMS Apps Script backend (supplied as the source of
truth) has been consolidated into the branch under the accepted authoritative
RBAC. It is a **merge, not a rewrite**: the supplied backend is the `Code.gs`
base and every business function is preserved verbatim; only the RBAC /
validation / new-action surfaces were edited.

---

## A. Complete backend action inventory

**doGet (reads; all roles unless noted):** `ping` (public), `inventory`,
`transactions`, `orders`, `readintake`, `sourcestats`, `sourceanalytics`,
`recentapprovals`, `me`, plus WQE Tier-1 over GET (`smartsearch`, `medgroup`,
`medfacets`).

**doPost — public:** `login`, `logout`.

**doPost — authenticated + gated:**

| Action | Capability (min) | Business function |
|--------|------------------|-------------------|
| `receive` | STOCK_RECEIVE (OPER+) | receiveStock (validated qty×unitCost) |
| `dispense` | STOCK_DISPENSE (OPER+) | dispenseStock (validated) |
| `priority` | ORDER_PRIORITY (OPER+) | setPriority |
| `orderadd/orderplace/orderstatus/orderremove/orderupdate` | ORDER_OPS (OPER+) | Orders lifecycle |
| `orders` | read (ALL) | getOrders |
| `stageintake` | INTAKE_STAGE (OPER+) | stageIntake |
| `readintake` | INTAKE_READ (OPER+) | readIntake |
| `extract` | LENS_EXTRACT (OPER+) | lensExtract (pre-lock) |
| `approveintake` | INTAKE_APPROVE (OPER+; **ADD_NEW = ADMIN-only**) | approveIntake/approveOne |
| `rejectintake` | INTAKE_REJECT (OPER+) | rejectIntake |
| `recentapprovals` | read (OPER+) | recentApprovals |
| `undoapprove` | UNDO_APPROVE (ADMIN+) | undoApproval |
| `stagepackaging` | PACKAGING_STAGE (OPER+) | stagePackaging → Intake |
| `adjust` | STOCK_ADJUST (ADMIN+) | adjustStock (validated) |
| `archive/restore` | STOCK_LIFECYCLE (ADMIN+) | setActive |
| `additem` | INVENTORY_MASTER_WRITE (ADMIN+) | addItem |
| `setcode` | INVENTORY_MASTER_WRITE (ADMIN+) | setCode (barcode link) |
| `importmedicines` | DATABASE_IMPORT (ADMIN+) | importMedicines (append-only) |
| `aiask` | AI_READ (ALL) | aiAssistantAsk (pre-lock, read-only) |
| `smartsearch/medgroup/medfacets/planorder/askwhims` | WQE_READ (ALL) | Wise Query Engine (read/analysis-only) |
| `listusers/createuser/updateuser/changerole/activateuser/deactivateuser/resetpassword` | USER_ADMIN (ADMIN+; fine rules in handlers) | user management |

"OPER+" = OPERATOR, ADMIN, MASTER_ADMIN. "ADMIN+" = ADMIN, MASTER_ADMIN.
VIEWER = read-only everywhere. Enforcement is the single `PERMISSIONS` map +
`assertPermission`, run after `requireAuth` and **before** any business
function, in the main router **and** the WQE / extract / aiask wrappers.

## B. Complete RBAC matrix

Role hierarchy: `MASTER_ADMIN (4) > ADMIN (3) > OPERATOR (2) > VIEWER (1)`.

| Action group | VIEWER | OPERATOR | ADMIN | MASTER_ADMIN |
|--------------|:---:|:---:|:---:|:---:|
| Reads (inventory, transactions, orders, analytics, WQE, me) | ✅ | ✅ | ✅ | ✅ |
| receive, dispense, priority | ❌ | ✅ | ✅ | ✅ |
| order ops (add/place/status/remove/update) | ❌ | ✅ | ✅ | ✅ |
| intake stage/read/approve(RECEIVE\|DISPENSE)/reject | ❌ | ✅ | ✅ | ✅ |
| packaging stage; packaging DISPENSE approval | ❌ | ✅ | ✅ | ✅ |
| **approve ADD_NEW** (creates a medicine) | ❌ | ❌ | ✅ | ✅ |
| **barcode assignment via approval** | ❌ | ❌ | ✅ | ✅ |
| adjust, archive, restore | ❌ | ❌ | ✅ | ✅ |
| additem, setcode (master-data) | ❌ | ❌ | ✅ | ✅ |
| database import | ❌ | ❌ | ✅ | ✅ |
| undo approval | ❌ | ❌ | ✅ | ✅ |
| user management (list/create/update/activate/deactivate/reset) | ❌ | ❌ | ✅ | ✅ |
| create ADMIN | ❌ | ❌ | ❌ | ✅ |
| create/assign OPERATOR, VIEWER | ❌ | ❌ | ✅ | ✅ |
| create/assign/modify **MASTER_ADMIN** | ❌ | ❌ | ❌ | ❌ (editor only) |

## C. Imported legacy functions (from the supplied backend, preserved verbatim)

Auth/util: `login`, `logout`, `requireAuth`, `loadUsers`, `hashPw`, `getUserRole`,
`normalizeRole`, `assertPermission`, `permDenied`, `json`, `str`, `num`, `up`,
`sheet`, `stamp`, `logTx`, `joinRemarks`.
Inventory: `getInventory`, `getTransactions`, `receiveStock`, `dispenseStock`,
`adjustStock`, `setActive`, `setPriority`, `findMedicine`, `locate`, `addItem`,
`setCode`, `ensureBarcodeHeader`, `copyStatusFormula`.
Orders: `getOrders`, `ensureOrdersSheet`, `orderAdd`, `orderPlace`,
`orderStatus`, `orderRemove`, `orderUpdate`, `orderTargets`, `findCartLine`,
`bridgeSetPriority`, `medHasActiveOrder`, `oNow`, `oStamp`.
Intake/Lens: `stageIntake`, `readIntake`, `approveIntake`, `approveOne`,
`assertApproveItemAllowed`, `rejectIntake`, `locateIntake`, `mintCode`,
`resolvePrefix`, `lensExtract`, `shapeExtract`, `parseModelJson`,
`maybeLinkBarcode`, `barcodeBelongsTo`.
Audit/Analytics: `ACOL`/`stampAudit`/`ensureAuditCols`, `resolveSource`,
`resolveCapture`, `sourceStats`, `sourceAnalytics`.
Undo: `ensureUndoSheet`, `captureUndoSnapshot`, `finalizeUndoSnapshot`,
`undoApproval`, `recentApprovals` (+ the self-wrapping `approveOne` snapshot).
AI: `aiAssistantAsk`. Packaging: `stagePackaging`.
WQE: `wqeSmartSearch`, `wqeMedGroup`, `wqeMedFacets`, `wqePlanOrder`,
`wqeAskWhims` and helpers, plus the self-wrapping `doGet`/`doPost` routers.

All of the above are **unchanged** except the two ADD_NEW/barcode guards, which
switched from `role === ADMIN` to `rankOf(role) >= ADMIN` so MASTER_ADMIN also
passes (a widening for the new superuser only; OPERATOR/VIEWER still blocked).

## D. Conflicting functions and how they were resolved

| Conflict | Supplied backend | Branch (accepted) | Resolution |
|----------|------------------|-------------------|------------|
| RBAC model | 3 roles + `PERMISSIONS` map | 4 roles + rank/capability | **Keep** the supplied `PERMISSIONS`/`assertPermission` as the single map (§4); **extend** to 4 roles + new actions. Dropped the branch's parallel `ROLE_RANK`/`ACTION_MIN_RANK` gate to avoid two policies. |
| `ADD_USER`/`SET_ROLE`/`MIGRATE_ROLES` | present (3-role) | richer (4-role, active) | Superseded with the 4-role versions; still default OPERATOR, never invalidate. |
| `login` | returns role | + active check + lastLogin | Merged: supplied login + deactivation block + best-effort lastLogin. |
| `requireAuth` | token→username | + deactivation block | Extended to reject deactivated accounts (single chokepoint). |
| `receiveStock` cost | `num(amount)` total→per-bottle | unit-cost path + strict validation | Merged: unitCost preferred, legacy `amount` kept for internal callers (orderStatus/approveOne) and old clients; zero cost permitted, negative/NaN rejected. |
| `dispense`/`adjust` numeric | `num()`→0 | strict `requireNumber` | Replaced coercion with validation, before sheet access. |
| Import | (none) | append-only | Added, reusing `addItem` + `mintCode`; never overwrites. |
| User management | editor-only | frontend API + MASTER_ADMIN | Added the frontend API on top; MASTER_ADMIN stays editor-only. |
| `body.role` | actor role (for approve) | requested role (for createuser) | Preserved client role as `body._reqRole` **before** overwriting `body.role` with the trusted actor role — both needs met, no collision. |

No conflict was left silently resolved; each is listed above.

## E. Final Code.gs architecture

```
Frontend ──HTTP──> doPost / doGet
                     │
                     ├─ requireAuth(token)            ← session valid? account active?
                     ├─ getUserRole(user)             ← trusted server-side role (never from client)
                     ├─ assertPermission(action,role) ← single PERMISSIONS capability map
                     │                                  (+ ADD_NEW/barcode fine guards)
                     └─ business function              ← Orders / Intake / Packaging / Import /
                                                         User mgmt / WQE(read-only) / Inventory
                                                              │
                                                         Google Sheets (Inventory, Transactions,
                                                         Orders, Intake, ApprovalUndo) + Script
                                                         Properties (WHIMS_USERS, counters, keys)
```
One authentication system, one session model, one capability map, one copy of
each business function. WQE/extract/aiask self-wrap the routers but funnel
through the same `requireAuth` + `assertPermission`.

## F. Sheet / schema dependencies

| Sheet | Columns | Created by |
|-------|---------|-----------|
| Inventory | A–U (adds **U Barcode**) + lazy audit V–AC | pre-exists; barcode/audit added lazily, never reordered |
| Transactions | A–J + lazy **K Amount, L Source, M Capture** | pre-exists; extra cols added lazily |
| Orders | 15 cols (LineID…Priority) | `ensureOrdersSheet` auto-creates |
| Intake | 22 cols (IntakeID…Notes) | `ensureIntakeSheet` auto-creates |
| ApprovalUndo | 11 cols (UndoID…ApprovedBy) | `ensureUndoSheet` auto-creates |
| Script Property `WHIMS_USERS` | `{username:{salt,hash,role,active?,displayName?,created?,lastLogin?}}` | editor + user-mgmt API |

**No production column was renamed, reordered, or deleted.** New fields are
additive (`role`, `active`, etc.) and default safely for legacy rows. No
destructive migration is required; `MIGRATE_ROLES()` is additive and idempotent.

## G. Tests

All suites are runnable and were run on this branch (0 failed):

```
node whims-v45.test.js             → 104 passed   (feature logic: search/variants/import/qty/weekly/cost/suppliers)
node whims-rbac.test.js            →  77 passed   (auth + user-management, direct API vs real Code.gs)
node whims-backend.test.js         →  52 passed   (consolidated backend business logic + RBAC via a Sheets model)
node whims-v45.integration.test.js →  16 passed   (jsdom frontend; skips cleanly without jsdom)
------------------------------------------------------------------------
TOTAL                                249 passed, 0 failed, 0 skipped*
```
\* the integration suite counts as not-run (skipped) when jsdom is absent; it
was run here with jsdom installed.

`whims-backend.test.js` drives the **real** `doGet`/`doPost` through an
in-memory Google Sheets model, so it exercises genuine business logic:
inventory writes changing stock, the Orders Cart→Ordered→Received lifecycle
(RECEIVED auto-receives stock), Intake approval (RECEIVE increments; ADD_NEW is
ADMIN-only via the sheet-driven guard; reject), the Packaging bridge (stage
DISPENSE → approve reduces stock), and append-only import (adds new, skips
duplicates and existing).

## H. Security tests (all via direct API — not UI)

Mandatory negatives (all pass):
- OPERATOR → additem / setcode / adjust / archive / restore / undoapprove → **DENIED**
- OPERATOR → approve ADD_NEW → **DENIED** (sheet-driven guard, not just payload)
- VIEWER → receive / dispense / adjust / order write / intake write / packaging / import → **DENIED**
- ADMIN → create MASTER_ADMIN / change MASTER_ADMIN / deactivate MASTER_ADMIN → **DENIED**
- Frontend role spoofing (role in body) → **DENIED** (server re-derives role from the store)
- Direct API role spoofing (`role`/`_reqRole` in body on additem) → **DENIED**
- Deactivated user: existing token rejected + cannot re-login
- Passwords never returned by any API; never stored in plaintext (salted SHA-256)
- `me` returns the server-side role, not the client's

Reviewed for: privilege escalation, role spoofing, frontend-only checks,
localStorage role manipulation, direct-API bypass, MASTER_ADMIN creation/
deletion via API, password/token leakage, plaintext storage, insecure errors.
No issue found in the consolidated backend (details in §J).

## I. Remaining gaps

1. **Live Apps Script QA not yet run** — logic is verified under Node stubs +
   Sheets model, not on a live deployment. See §K checklist. Do this before prod.
2. **Legacy `app.js` approve path**: app.js's fallback `approveintake` sends a
   single top-level `{intakeId}`; the real intake UI (`whims-intake.js`) uses the
   `items:[{…}]` contract the backend is designed for. The `items[]` path is what
   the app uses and what is tested. (No change made — behavioural note only.)
3. **Frontend Lens/AI/WQE UI** beyond the existing `whims-ai.js` trigger is out of
   scope here; the backend actions exist and are RBAC-gated.
4. **OpenRouter-dependent actions** (`extract`, `aiask`, `planorder`, `askwhims`)
   need `OPENROUTER_API_KEY` in Script Properties to function live.
5. Rate-limiting covers login only; user-management endpoints are ADMIN-gated but
   not separately throttled.

## J. Security review notes

- **Single trust boundary**: identity from the session token, role from the
  server-side store, both re-resolved every request. `body.role` is overwritten
  with the trusted actor role; a client `role`/`_reqRole` is only ever a
  *requested* parameter validated against the actor's authority.
- **MASTER_ADMIN** is unreachable via the API for create/change/deactivate/delete
  (`canAssignRole` never yields it; `canManageTarget` returns false for a
  MASTER_ADMIN target). It exists only via the editor (`SET_MASTER_ADMIN`).
- **ADD_NEW / barcode** creation through approval is ADMIN-only and enforced
  authoritatively inside `approveOne` (defense in depth beyond the router gate),
  catching both payload-declared and sheet-driven ADD_NEW.
- **Deactivation** takes effect immediately (login + `requireAuth`).
- **No secret leaves the backend**: `publicUser` omits salt/hash; reset/login
  never echo the password; keys live in Script Properties.
- Error strings are generic (`Permission denied: …`, `Wrong username or
  password`) and do not leak account existence or internals.

## K. Live Apps Script QA checklist (perform against a TEST Sheet — do NOT deploy to prod)

> Copy `Code.gs` into a **test** Apps Script bound to a **copy** of the Sheet.
> Run `SET_MASTER_ADMIN` (then blank the password), `MIGRATE_ROLES`, and create
> one ADMIN / OPERATOR / VIEWER via the app. Deploy as a **test** Web App.

1. **Auth** — `?action=ping` returns live; login as each role returns a token + role; wrong password locks after 5; deactivated account cannot log in.
2. **Role resolution** — `?action=me&token=…` returns the server role for each account; changing a role in the app takes effect on the next request.
3. **Inventory read** — `?action=inventory` and `?action=transactions` return data for all roles.
4. **Receive** — OPERATOR receives `qty × unitCost`; Inventory stock rises; Primary Cost = unit cost; Transactions logs the total; VIEWER denied.
5. **Dispense/Adjust** — OPERATOR dispenses; ADMIN adjusts; OPERATOR adjust denied; VIEWER both denied; malformed qty rejected with a clear error.
6. **Orders** — orderadd → orderplace → orderstatus RECEIVED auto-receives stock and sets Qty Received; VIEWER order writes denied.
7. **Intake** — stageintake; approve a RECEIVE (OPERATOR) raises stock; approve an ADD_NEW as OPERATOR is **denied**, as ADMIN creates the medicine; reject works; undo (ADMIN) within the window restores stock.
8. **Packaging** — stagepackaging (OPERATOR) creates a PENDING DISPENSE Intake row; approving it reduces the packaging-material stock; a bad id is skipped, not staged.
9. **WQE** — smartsearch/medgroup/medfacets return results for all roles; planorder/askwhims return recommendations (need `OPENROUTER_API_KEY`); none can write.
10. **Import** — ADMIN imports a small CSV: new rows added, duplicates/existing skipped, existing stock untouched; OPERATOR/VIEWER denied.
11. **User management** — MASTER_ADMIN creates an ADMIN; ADMIN creates OPERATOR/VIEWER but not ADMIN/MASTER_ADMIN; deactivate/reset a staff account; confirm no password/hash is ever returned; confirm the master row is unmanageable from the app.
12. **Regression** — existing login, inventory, receive/dispense still work for pre-existing accounts (which read as OPERATOR until promoted).

Record actual results per step; do not report live QA as passed unless it was
actually performed against Apps Script.

## L. Files changed & commits (this consolidation)

Changed this phase: `Code.gs` (supplied backend base + surgical RBAC/validation/
new-action merge), `whims-rbac.test.js` (retargeted), `whims-backend.test.js`
(new Sheets-model suite), `WHIMS_V45_CONSOLIDATION.md` (this report).
Frontend (`app.js`, `whims-users.js`, `whims-v45*.js/css`, `index.html`) is
unchanged from the earlier accepted RBAC phase and remains compatible.

Commits on `claude/cool-bell-1xitau` (newest first):
```
feat(backend): consolidate full WHIMS backend under authoritative 4-role RBAC
docs: add v4.5 architecture & RBAC review report
feat(rbac-ui): role-aware login + User Management panel
feat(rbac): server-side roles + 2-tier user management in Code.gs
feat(import): add append-only bulk import backend action
feat(ui): wire v4.5 smart-inventory features into the app
feat(receiving): calculate total from quantity x unit cost
feat(core): add tested WHIMS v4.5 logic library
```
(plus this report's docs commit).

---

**Not done, by instruction:** no PR, no merge, no deploy, no production Apps
Script change, no production Sheet change, no GitLab, no GitLab Pages, no DNS,
no `whims.wisehomeopathy.com`. Awaiting your review of this consolidation.
