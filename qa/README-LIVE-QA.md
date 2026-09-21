# WHIMS v4.5 — Live Apps Script QA runbook

Runs the consolidated `Code.gs` against a **TEST** Google Spreadsheet and a
**TEST** Apps Script deployment. **Never point any of this at production.**

> **What I (the assistant) can and cannot do:** I cannot create the Apps Script
> project, deploy the web app, or create the Google Sheet — that needs your
> Google account's Apps Script editor. I *can* run the automated API QA
> (`live-api-qa.mjs`) against a TEST `/exec` URL over HTTPS. Deploy the test
> backend, paste me the URL + the test passwords you set, and I'll run it and
> report real PASS/FAIL. The runner is already validated end-to-end against a
> local harness that executes the real `Code.gs` (see `RESULTS-local-harness.md`:
> 76 PASS / 0 FAIL / 6 browser-only NOT TESTED).

---

## Step 0 — Make the TEST spreadsheet (≈3 min)

1. Create a **new** Google Sheet named e.g. `WHIMS TEST — QA` (not a copy of production).
2. Make two tabs named exactly **`Inventory`** and **`Transactions`**.
3. Import the seed data (File → Import → Upload → *Replace current sheet* per tab):
   - `qa/seed/Inventory.csv` → `Inventory` tab
   - `qa/seed/Transactions.csv` → `Transactions` tab
   (Or paste the CSV contents; keep row 1 as headers, and do **not** reorder columns.)
4. Leave column **S (Status)** blank — the app never writes it.
   The `Orders`, `Intake`, and `ApprovalUndo` tabs are created automatically on first use.

## Step 1 — Deploy the TEST backend (≈5 min)

1. In the TEST sheet: **Extensions → Apps Script**.
2. Delete the default `Code.gs` contents and paste **this repo's `Code.gs`** in full. Save.
3. Bootstrap accounts from the editor (Run ▶ each, then blank any password line):
   - `SET_MASTER_ADMIN` — edit `MASTER_USERNAME='qa_master'`, `MASTER_PASSWORD='QAmaster123'`, run, then blank the password.
   - In the console (or by editing + running `ADD_USER`): create
     `ADD_USER('qa_admin','QAadmin123','ADMIN')`, `ADD_USER('qa_oper','QAoper123','OPERATOR')`,
     `ADD_USER('qa_view','QAview123','VIEWER')`.
   - Run `MIGRATE_ROLES()` once (harmless; backfills any legacy record).
   - (Optional, for §12 AI answers) set Script Property `OPENROUTER_API_KEY`.
4. **Deploy → New deployment → Web app**: *Execute as* **Me**, *Who has access* **Anyone**. Copy the `/exec` URL.

## Step 2 — Verify deployment (record these — checklist §2)

From the Apps Script console, record and paste into the results file:

| Field | Where to read it | Value |
|-------|------------------|-------|
| Apps Script project name/id | Project Settings | |
| Deployed web-app `/exec` URL | Deploy → Manage deployments | |
| Deployment version | Manage deployments | |
| Execute as | Deployment config | should be **Me** |
| Who has access | Deployment config | should be **Anyone** |
| Code.gs version | top-of-file header / your paste | v4.5 consolidated |
| Bound Spreadsheet ID | Sheet URL `/d/<ID>/` | |

Quick reachability check: open `<EXEC_URL>?action=ping` → expect `{"ok":true,"message":"WHIMS backend is live",...}`.

## Step 3 — Run the automated API QA (§2 reachability, §3, §4, §5, §7–§13)

```
WHIMS_EXEC_URL="<your TEST /exec URL>" \
WHIMS_MASTER_USER=qa_master WHIMS_MASTER_PASS='QAmaster123' \
WHIMS_ADMIN_USER=qa_admin   WHIMS_ADMIN_PASS='QAadmin123' \
WHIMS_OPER_USER=qa_oper     WHIMS_OPER_PASS='QAoper123' \
WHIMS_VIEW_USER=qa_view     WHIMS_VIEW_PASS='QAview123' \
node qa/live-api-qa.mjs
```

It prints PASS/FAIL/NOT-TESTED per item and writes `qa/RESULTS.md`. It performs
real writes on the **test** sheet only. (If you use different passwords, pass
them via the env vars above.)

> Or send me the `/exec` URL + the passwords you set and I'll run it for you.

## Step 4 — Manual UI QA (§4 visual, §6, §14, §15)

Deploy the frontend for the TEST run (either open `index.html` locally and point
Settings → API URL at the TEST `/exec`, or publish a **separate test** GitHub
Pages — never the production site). Then follow `qa/ui-qa-checklist.md` and fill
its PASS/FAIL table.

## Step 5 — Fill the report

Copy `qa/RESULTS-TEMPLATE.md` → `qa/RESULTS-live.md`, paste the §2 deployment
facts, the automated `RESULTS.md` table, and the UI checklist outcomes. Mark
each item PASS / FAIL / NOT TESTED. Do not mark anything PASS that wasn't
actually exercised against the live deployment.

---

## Production safety (enforced by this runbook)

- A brand-new TEST sheet + TEST Apps Script deployment; production is never
  opened, deployed to, or written.
- Test accounts are `qa_*`; no production user is touched.
- No DNS, no GitLab, no `whims.wisehomeopathy.com`, no production deployment.

## Local pre-flight (optional, no Google account needed)

Validate the runner against the real `Code.gs` locally first:
```
node qa/local-mock-server.mjs 8787
# in another shell:
WHIMS_EXEC_URL=http://127.0.0.1:8787 node qa/live-api-qa.mjs
```
This uses an in-memory Sheets model — it proves the runner works but is **not**
Apps Script and **not** a live result.
