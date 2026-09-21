# WHIMS v4.5 — LIVE Apps Script QA results

> Fill this in after actually running against a TEST deployment. Do not mark any
> row PASS unless it was exercised against the live Apps Script `/exec` URL.
> Copy this file to `qa/RESULTS-live.md` and complete it.

## Deployment under test (§2)

| Field | Value |
|-------|-------|
| Apps Script project | _(fill)_ |
| Deployed web-app `/exec` URL (TEST) | _(fill)_ |
| Deployment version | _(fill)_ |
| Execute as | _(expect: Me)_ |
| Who has access | _(expect: Anyone)_ |
| Code.gs version | v4.5 consolidated |
| Bound Spreadsheet ID (TEST) | _(fill)_ |
| Frontend URL tested (TEST) | _(fill)_ |
| Run date / tester | _(fill)_ |

## Automated API QA (paste `qa/RESULTS.md` table here)

_Run `node qa/live-api-qa.mjs` against the TEST `/exec` URL and paste its
generated table below. Expected shape: §2 reachability, §3 auth, §4 user-mgmt,
§5 security matrix, §7 receiving, §8 dispense, §9 orders, §10 intake, §11
packaging, §12 WQE, §13 import._

| Section | Test | Result | Detail |
|---|---|---|---|
| … | _(paste)_ | | |

## Manual UI QA (from `qa/ui-qa-checklist.md`)

| Section | Item | Result | Notes |
|---|---|---|---|
| §4 | User Management panel (4.1–4.9) | NOT TESTED | |
| §6 | Search fuzzy/exact/typo/variants (6.1–6.7) | NOT TESTED | |
| §14 | Suppliers + WhatsApp (14.1–14.4) | NOT TESTED | |
| §15 | Dispensed This Week (15.1–15.2) | NOT TESTED | |

## Overall

| Metric | Count |
|--------|-------|
| PASS | _(fill)_ |
| FAIL | _(fill)_ |
| NOT TESTED | _(fill)_ |

**Sign-off:** live QA was / was not performed against Apps Script (circle one).
Do not report live QA as passed unless it was actually performed.
