# WHIMS v4.5 — QA runner validation against the LOCAL harness

> Evidence that qa/live-api-qa.mjs runs correctly against the real consolidated
> Code.gs over HTTP. This is NOT an Apps Script live-QA result — it ran against
> qa/local-mock-server.mjs (in-memory Sheets model), not a deployed web app.
> The live run must be performed against a TEST /exec URL.

- Backend (TEST /exec): `http://127.0.0.1:8787`
- Run at: 2026-09-21T17:01:07.243Z
- Summary: **76 PASS · 0 FAIL · 6 NOT TESTED**

| Section | Test | Result | Detail |
|---|---|---|---|
| §2 | ping returns backend live | PASS | WHIMS backend is live |
| §2 | unauthenticated inventory rejected | PASS |  |
| §3 | MASTER_ADMIN login returns correct server role | PASS | got MASTER_ADMIN |
| §3 | ADMIN login returns correct server role | PASS | got ADMIN |
| §3 | OPERATOR login returns correct server role | PASS | got OPERATOR |
| §3 | VIEWER login returns correct server role | PASS | got VIEWER |
| §3 | invalid password rejected | PASS |  |
| §3 | me returns server role for MASTER_ADMIN | PASS |  |
| §3 | me returns server role for ADMIN | PASS |  |
| §3 | me returns server role for OPERATOR | PASS |  |
| §3 | me returns server role for VIEWER | PASS |  |
| §3 | deactivated user cannot log in | PASS |  |
| §3 | reactivated user can log in again | PASS |  |
| §3 | logout invalidates the session token | PASS |  |
| §3 | session expiration (6h) — cannot wait in QA | NOT TESTED | verify manually or by config |
| §5 | OPERATOR → additem DENIED | PASS |  |
| §5 | OPERATOR → setcode DENIED | PASS |  |
| §5 | OPERATOR → adjust DENIED | PASS |  |
| §5 | OPERATOR → archive DENIED | PASS |  |
| §5 | OPERATOR → restore DENIED | PASS |  |
| §5 | OPERATOR → undoapprove DENIED | PASS |  |
| §5 | VIEWER → receive DENIED | PASS |  |
| §5 | VIEWER → dispense DENIED | PASS |  |
| §5 | VIEWER → adjust DENIED | PASS |  |
| §5 | VIEWER → orderadd DENIED | PASS |  |
| §5 | VIEWER → priority DENIED | PASS |  |
| §5 | VIEWER → stageintake DENIED | PASS |  |
| §5 | VIEWER → stagepackaging DENIED | PASS |  |
| §5 | VIEWER → importmedicines DENIED | PASS |  |
| §5 | ADMIN → create MASTER_ADMIN DENIED | PASS |  |
| §5 | ADMIN → change MASTER_ADMIN role DENIED | PASS |  |
| §5 | ADMIN → deactivate MASTER_ADMIN DENIED | PASS |  |
| §5 | OPERATOR role-spoof in body still DENIED (additem) | PASS |  |
| §4 | MASTER_ADMIN listusers (no secrets) | PASS |  |
| §4 | MASTER_ADMIN create ADMIN | PASS |  |
| §4 | MASTER_ADMIN create OPERATOR | PASS |  |
| §4 | MASTER_ADMIN create VIEWER | PASS |  |
| §4 | MASTER_ADMIN change role (oper2→viewer) | PASS |  |
| §4 | reset password (no password echoed) | PASS |  |
| §4 | ADMIN create OPERATOR | PASS |  |
| §4 | ADMIN create VIEWER | PASS |  |
| §4 | ADMIN CANNOT create ADMIN | PASS |  |
| §4 | OPERATOR CANNOT list users | PASS |  |
| §4 | VIEWER CANNOT list users | PASS |  |
| §7 | 2 × ₹200 = ₹400 (stock +2) | PASS |  |
| §7 | 5 × ₹125 = ₹625 (unit cost stored 125) | PASS |  |
| §7 | transaction recorded for receive | PASS |  |
| §7 | invalid qty "abc" rejected | PASS |  |
| §7 | blank qty rejected | PASS |  |
| §7 | negative qty rejected | PASS |  |
| §7 | negative cost rejected | PASS |  |
| §7 | zero cost permitted (documented) | PASS |  |
| §8 | dispense decreases stock + logs tx | PASS |  |
| §8 | dispense invalid qty rejected | PASS |  |
| §9 | orderadd creates CART line | PASS |  |
| §9 | orderupdate changes qty to 6 | PASS |  |
| §9 | orderplace → ORDERED | PASS |  |
| §9 | orderstatus RECEIVED auto-receives stock | PASS |  |
| §9 | Qty Ordered and Qty Received both present + separate | PASS |  |
| §10 | OPERATOR stage + approve RECEIVE (existing) raises stock | PASS |  |
| §10 | reject a staged intake row | PASS |  |
| §10 | OPERATOR → approve ADD_NEW DENIED | PASS |  |
| §10 | VIEWER → approve ADD_NEW DENIED | PASS |  |
| §10 | ADMIN → approve ADD_NEW creates medicine | PASS |  |
| §10 | undo an approval restores stock (ADMIN) | PASS |  |
| §11 | stagepackaging → PENDING DISPENSE; approve reduces stock; no new medicine | PASS |  |
| §11 | packaging with unknown id fails cleanly | PASS |  |
| §12 | smartsearch returns results (read) | PASS |  |
| §12 | medgroup (read) | PASS |  |
| §12 | medfacets (read) | PASS |  |
| §12 | planorder reached (read-only; needs OPENROUTER key to answer) | PASS |  |
| §12 | askwhims reached (read-only; needs OPENROUTER key to answer) | PASS |  |
| §12 | WQE did NOT modify inventory (count unchanged) | PASS |  |
| §12 | no WQE write action exists (cannot mutate) | PASS | smartsearch/medgroup/medfacets/planorder/askwhims are read-only by design |
| §13 | OPERATOR import DENIED | PASS |  |
| §13 | ADMIN import: adds new, skips duplicate; existing stock untouched | PASS |  |
| §13 | import rejects malformed numeric row | PASS |  |
| UI | §6 fuzzy/exact/typo search UX | NOT TESTED | browser step — see qa/ui-qa-checklist.md |
| UI | §6 pack/potency variant display | NOT TESTED | browser step — see qa/ui-qa-checklist.md |
| UI | §14 supplier contacts + WhatsApp link | NOT TESTED | browser step — see qa/ui-qa-checklist.md |
| UI | §15 Dispensed-This-Week panel | NOT TESTED | browser step — see qa/ui-qa-checklist.md |
| §2 | Execute-as / access / version settings | NOT TESTED | read from Apps Script console — see runbook §2 |
