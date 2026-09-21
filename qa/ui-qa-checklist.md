# WHIMS v4.5 — Manual UI QA checklist (browser)

Run against the **TEST** frontend pointed at the **TEST** `/exec` URL (Settings →
Apps Script URL). Do all of this on desktop width and re-check the starred (*)
rows at phone width. Mark each PASS / FAIL / NOT TESTED.

Log in with the test accounts seeded in the runbook (`qa_master` / `qa_admin` /
`qa_oper` / `qa_view`).

## §4 — User Management panel (visual + role-gated)

| # | Step | Expected | Result |
|---|------|----------|--------|
| 4.1 | Log in as `qa_master` → Settings | "User Management" card is visible; user list loads with roles + status | |
| 4.2 | Add User form as master | Role dropdown shows **ADMIN, OPERATOR, VIEWER** only (never MASTER_ADMIN) | |
| 4.3 | Create an ADMIN, an OPERATOR, a VIEWER | Each appears in the list with the right role | |
| 4.4 | Change a role; deactivate then reactivate; reset a password | Each succeeds; no password/hash ever shown | |
| 4.5 | The `qa_master` row | Shows "🔒 protected"; no action buttons | |
| 4.6 | Log in as `qa_admin` → Settings | Panel visible; Add-User role dropdown shows **OPERATOR, VIEWER** only | |
| 4.7 | As admin, try to see/assign ADMIN or MASTER_ADMIN | Not offered in the UI (and backend rejects — see API QA §5) | |
| 4.8* | Log in as `qa_oper` → Settings | **No** User Management card | |
| 4.9* | Log in as `qa_view` → Settings | **No** User Management card | |

## §6 — Search (fuzzy / exact / typo / variants)

| # | Step | Expected | Result |
|---|------|----------|--------|
| 6.1 | Search `arsenicum album` | ARSENICUM ALBUM is the top result | |
| 6.2 | Search `arsen` | Both ARSENICUM ALBUM and ARSENICUM IODATUM appear | |
| 6.3 | Type `bel` | Autosuggest dropdown lists Belladonna entries; clicking one opens its detail | |
| 6.4 | Search `belladona` (typo) | Belladonna still found (closest-match fallback) | |
| 6.5 | Search `hair black` | SUNNY HAIR COLOR BLACK found (multi-word) | |
| 6.6 | Open BELLADONNA 30 / 15 ML detail | "Other pack sizes" shows 30 ML; "Other potencies" shows 200 and 1M; stock shown per item, not merged | |
| 6.7 | Search `zzzxqq` | "Nothing found" (no false matches) | |

## §14 — Suppliers & WhatsApp

| # | Step | Expected | Result |
|---|------|----------|--------|
| 14.1 | Open a medicine detail (e.g. BELLADONNA 30/15 ML) | "Suppliers & WhatsApp ordering" section lists SBL/BAKSON from the record | |
| 14.2 | Add a supplier contact (name + a valid number) | Appears in the list; saved on this device | |
| 14.3 | Click a WhatsApp button | Opens wa.me with the number and a prefilled order message | |
| 14.4 | Orders view → set a quantity → Copy list / WhatsApp | Message includes quantity + unit ("… — N bottles/packets") | |

## §15 — Intelligence: Dispensed This Week

| # | Step | Expected | Result |
|---|------|----------|--------|
| 15.1 | Dispense a couple of test medicines (e.g. via detail → Dispense), then open the dashboard | "Dispensed This Week" panel lists those medicines with quantities, from real transactions | |
| 15.2 | Confirm the week boundary | Counts only this week's DISPENSE rows (Monday-start); receives/adjusts excluded | |

## Cross-cutting

| # | Step | Expected | Result |
|---|------|----------|--------|
| X.1 | Log out / log back in | Session ends; role re-resolved from server on login | |
| X.2* | Phone width | Search, detail sheet, User Management, Orders all usable; no horizontal scroll | |
