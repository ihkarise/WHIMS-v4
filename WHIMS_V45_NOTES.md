# WHIMS v4.5 — Smart Inventory upgrade notes

This phase improves the existing WHIMS app **without rebuilding it**. Everything
is additive and follows the repo's established pattern: pure logic lives in a
tested library, and the UI is wired by *wrapping* the existing `render*`
functions — no existing function, field, ID, API name, or medicine record was
renamed, removed, or overwritten.

> Scope guardrails honoured: **no GitLab migration, no custom domain, no DNS, no
> production deployment, no destructive data migration.** Those remain future
> work (see §H).

---

## A. Files changed

| File | Change |
|------|--------|
| `whims-v45.js` | **New.** Pure, dependency-free logic library (`window.WHIMS45`) for all 7 features. UMD — also runs under Node. |
| `whims-v45.test.js` | **New.** 104-assertion Node regression suite (no dependencies). |
| `whims-v45.integration.test.js` | **New.** Optional jsdom smoke test that loads the whole app; skips cleanly if jsdom is absent. |
| `whims-v45-ui.js` | **New.** Additive UI module; loads last and wraps `renderResults`/`openDetail`/`renderDash`/`renderOrders`. |
| `whims-v45.css` | **New.** Styles for the new UI, using the existing design tokens (incl. dark-theme parity). |
| `index.html` | Added the CSS link + two `<script>` tags; changed the Receive sheet's cost field to *cost per bottle* with a live total. |
| `app.js` | Receive handler now sends per-bottle `unitCost` and a derived total; added live-total calculation. No other behaviour changed. |
| `Code.gs` | `receiveStock` accepts per-bottle `unitCost` (backward compatible with legacy total `amount`); added append-only `importmedicines` action. |

## B. Features implemented

| Module | Feature | Status |
|--------|---------|--------|
| A | Smart medicine search (exact→prefix→token→substring→subsequence→fuzzy), ranked, with clickable **autosuggest** and a **closest-match fallback** on typos | ✅ Implemented & tested |
| B | Related **pack-size** and **potency** variants shown in the detail sheet; **stock is never merged** — each item stays independent | ✅ Implemented & tested |
| C | Database **import** with column auto-mapping, validation, and a *new / existing / duplicate / invalid* preview; only confirmed **new** rows are written (append-only) | ✅ Implemented & tested |
| D | **Order quantity** per item, persisted; unit-aware Copy/WhatsApp messages ("5 packets", "2 bottles") | ✅ Implemented & tested |
| E | **Dispensed This Week** dashboard panel from real DISPENSE transactions (Monday-start week) | ✅ Implemented & tested |
| F | Receiving = **quantity × cost per bottle**, total auto-calculated (money-safe integer-paise math) | ✅ Implemented & tested |
| G | Multiple **supplier contacts** per medicine + **WhatsApp** click-to-chat with a prefilled order message | ✅ Implemented & tested |

## C. Tests

Run: `node whims-v45.test.js`  (and optionally `npm i jsdom && node whims-v45.integration.test.js`)

```
WHIMS v4.5 unit tests:         104 passed, 0 failed   (PASSED)
WHIMS v4.5 integration (jsdom):  9 passed, 0 failed   (PASSED — loads all 12 scripts in a real DOM)
```

Coverage maps to the acceptance matrix (§36–37 of the brief):

- **Search:** exact, lower/UPPER case, partial/prefix, single-typo, missing char,
  extra char, transposed chars, multi-word, no-result, empty, id, active-only, ranking.
- **Variants:** same-name/same-potency/other-pack, other-potency, none, zero-stock, multiple; item never lists itself.
- **Import:** valid, existing, in-file duplicate, missing-name, non-numeric, priority-range, preview-doesn't-mutate, importable-rows, 1000-row bulk.
- **Orders:** qty 1/4/10, singular/plural units, packet vs bottle derivation, message contains quantities, ordered-qty independent of stock/received.
- **Weekly:** none, single, multiple, current vs previous week, totals, Monday-00:00 boundary, receive/adjust/archive excluded, Sunday-start option.
- **Receiving cost:** 1×100, 2×100, 3×150=450, 5×125=625 with unit cost preserved, float-safety (3×0.10=0.30), legacy reverse derivation, INR formatting.
- **Suppliers/WhatsApp:** bare 10-digit, leading-0, +91, spaces/dashes, invalid, link build & url-encoding, add/remove immutability (never overwrites), multiple numbers.

> Not runnable in this environment (no live backend/browser): end-to-end Apps
> Script writes and on-device mobile QA. The backend edits are backward
> compatible and syntax-checked; they need a quick live smoke test on your Apps
> Script deployment before production (see §H).

## D. Database / schema changes

- **No columns renamed, reordered, or removed.** The Inventory/Transactions
  schema in `Code.gs` is unchanged.
- Receiving now stores the **per-bottle cost** in the existing `Primary Cost`
  column (previously derived by dividing a total). The value stored is the same
  kind of number as before — only the input direction changed.
- New Transactions rows may carry the action label `IMPORT` (from bulk import),
  alongside the existing RECEIVE/DISPENSE/ADJUSTMENT/etc.
- `importmedicines` is **append-only**: it never edits or overwrites an existing
  row (skips on matching ID or Name+Potency+Pack). No migration required.
- Client-only storage added (per device, never leaves the browser):
  `whims_med_contacts` (per-medicine supplier contacts) and `whims_order_qty`
  (order quantities). Reuses the existing `whims_supplier_wa` book from the
  orders module.

## E. RBAC

- **RBAC is now implemented** (added after this notes file's original feature
  phase). Full server-side roles MASTER_ADMIN / ADMIN / OPERATOR / VIEWER, a
  two-tier admin model, a frontend User Management panel, strict numeric
  validation, and ADMIN-only append-only import.
- See **`WHIMS_V45_ARCHITECTURE.md`** for the complete role hierarchy,
  permission matrix, master-admin protection, migration and password-security
  mechanisms, and the backend/authorization test coverage (76 direct-API
  assertions in `whims-rbac.test.js`).
- Legacy accounts default to OPERATOR without being invalidated (`MIGRATE_ROLES`).

## F. Performance checklist (which items apply to this static + Apps Script app)

Addressed:
- **Debounced input** — autosuggest debounces (170 ms); no request per keystroke (search is fully client-side over cached inventory).
- **Client-side search index / no N+1** — search/variants/weekly all run over already-loaded arrays; zero extra backend calls.
- **Result limits / pagination** — suggest caps at 8, fuzzy fallback at 40, weekly panel at 8 with "+N more".
- **Cache reuse** — features read the app's existing localStorage-cached `INV`/`TX`.
- **Minimal re-render** — additive wrappers update only their own injected nodes.
- **Money precision** — integer-paise arithmetic avoids float drift.

Not applicable to this architecture (static files + Google Apps Script + Sheets):
CDN config, JS/CSS minify/bundling step, server-side caching, DB connection
pooling, image compression pipeline, code-splitting. These belong to the later
hosting phase. A Lighthouse audit is worth running once hosting is chosen.

## G. Git commits (branch `claude/cool-bell-1xitau`)

```
feat(core): add tested WHIMS v4.5 logic library
feat(receiving): calculate total from quantity x unit cost
feat(ui): wire v4.5 smart-inventory features into the app
feat(import): add append-only bulk import backend action
docs: add v4.5 implementation notes
```

## H. Remaining / future work (explicitly out of scope this phase)

1. **Live backend QA** of the two `Code.gs` edits (per-bottle receive; `importmedicines`) on your Apps Script deployment.
2. **RBAC** — ADMIN/OPERATOR/VIEWER roles (backend role storage + frontend gating), then re-run the §37 security checks against it.
3. **On-device mobile QA** (desktop + phone widths) of the new panels and sheets.
4. **GitLab migration** — repository, CI/build, environment variables.
5. **GitLab Pages** deploy.
6. **Custom domain** `whims.wisehomeopathy.com` + DNS + HTTPS.
7. **Production data safety review** and CORS/Apps Script endpoint review.
8. **Lighthouse audit** once hosting is chosen.

Do **not** proceed to items 4–6 until the functionality above is reviewed and signed off.
