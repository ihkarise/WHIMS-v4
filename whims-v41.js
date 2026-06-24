/* ============================================================================
   WHIMS v4.1-a — Feature Extension Module  (Wise Homeopathy Inventory)
   ----------------------------------------------------------------------------
   ADDITIVE ONLY. This file is loaded AFTER app.js. It does NOT modify, rename,
   or replace any existing function — it only WRAPS a few render functions
   (saving the original and calling it first) and ADDS new UI + handlers.

   app.js and Code.gs are untouched. No backend API was added or changed:
     • "Add New Medicine"  reuses the existing  additem  action.
     • "Stock Correction"  reuses the existing  adjust   action.

   Ships: P1 (auto-suggest+autofill, add-new-master+codegen, close buttons,
   sound), P3 (stock correction + history), P4 (fast select/clear/order render),
   and small enhancements (copy code, recent searches, highlight, daily stats,
   auto/light/dark, automatic local backup).
   ========================================================================== */
(function () {
  'use strict';

  // Bail out gracefully if loaded on a page without the base app.
  if (typeof $ !== 'function' || typeof store === 'undefined') {
    console.warn('[WHIMS v4.1] base app not detected — module idle');
    return;
  }

  /* small private helpers (do not collide with app.js globals) */
  const v$ = s => document.querySelector(s);
  const v$$ = s => [...document.querySelectorAll(s)];
  const vEsc = s => String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const todayStr = () => {
    const d = new Date(), p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  };

  /* ===========================================================================
     0 · SOUND FEEDBACK  (optional — wraps the existing toast())
     ------------------------------------------------------------------------
     Every success/error in the app already ends in a toast() call, so wrapping
     toast() gives us add/remove/update/error feedback with zero invasive edits.
     =========================================================================== */
  const Sound = {
    on() { return store.get('sound', false) === true; },
    setOn(v) { store.set('sound', !!v); },
    _ctx: null,
    _ac() {
      if (!this._ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) this._ctx = new AC();
      }
      return this._ctx;
    },
    play(kind) {
      if (!this.on()) return;
      const ctx = this._ac(); if (!ctx) return;
      try { if (ctx.state === 'suspended') ctx.resume(); } catch (e) {}
      // kind → [freq, duration]
      const map = { success: [660, 0.12], error: [180, 0.22], tap: [520, 0.05] };
      const [f, dur] = map[kind] || map.success;
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
      o.connect(g).connect(ctx.destination);
      o.start(); o.stop(ctx.currentTime + dur + 0.02);
      if (kind === 'success') { // pleasant two-note for success
        const o2 = ctx.createOscillator(), g2 = ctx.createGain();
        o2.type = 'sine'; o2.frequency.value = 880;
        g2.gain.setValueAtTime(0.0001, ctx.currentTime + 0.10);
        g2.gain.exponentialRampToValueAtTime(0.14, ctx.currentTime + 0.12);
        g2.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.24);
        o2.connect(g2).connect(ctx.destination);
        o2.start(ctx.currentTime + 0.10); o2.stop(ctx.currentTime + 0.26);
      }
    }
  };
  // Wrap toast (function declaration → reassignable from here).
  if (typeof toast === 'function') {
    const _toast = toast;
    // eslint-disable-next-line no-global-assign
    toast = function (msg, err) {
      _toast(msg, err);
      Sound.play(err ? 'error' : 'success');
    };
  }

  /* ===========================================================================
     1 · CLOSE (✕) BUTTON IN EVERY POPUP
     =========================================================================== */
  function injectCloseButtons() {
    v$$('.sheet').forEach(sh => {
      if (sh.querySelector('.v41-x')) return;
      const x = document.createElement('button');
      x.className = 'v41-x';
      x.type = 'button';
      x.setAttribute('aria-label', 'Close');
      x.innerHTML = '&times;';
      x.onclick = () => { if (typeof closeSheets === 'function') closeSheets(); Sound.play('tap'); };
      sh.appendChild(x);
    });
  }

  /* ===========================================================================
     2 · THEME  (Auto / Light / Dark)
     =========================================================================== */
  const Theme = {
    get() { return store.get('theme', 'auto'); },
    set(mode) { store.set('theme', mode); this.apply(); },
    _mq: window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null,
    apply() {
      const mode = this.get();
      const dark = mode === 'dark' || (mode === 'auto' && this._mq && this._mq.matches);
      document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
      const tm = v$('meta[name="theme-color"]');
      if (tm) tm.setAttribute('content', dark ? '#0E1530' : '#1E2D5E');
      const sel = v$('#v41Theme'); if (sel) sel.value = mode;
    },
    init() {
      this.apply();
      if (this._mq && this._mq.addEventListener)
        this._mq.addEventListener('change', () => { if (this.get() === 'auto') this.apply(); });
    }
  };

  /* ===========================================================================
     3 · AUTOMATIC LOCAL BACKUP
     ------------------------------------------------------------------------
     Snapshots INV + TX to localStorage after every successful sync (keeps the
     last few), and offers a manual JSON download. Wraps loadAll().
     =========================================================================== */
  const Backup = {
    KEY: 'backups',
    MAX: 5,
    snapshot() {
      try {
        if (!Array.isArray(INV) || !INV.length) return;
        const list = store.get(this.KEY, []);
        list.unshift({ at: new Date().toISOString(), inv: INV.length, tx: (TX || []).length });
        store.set(this.KEY, list.slice(0, this.MAX));
        // full payload (separate key, overwritten each time to save space)
        store.set('backup_latest', { at: new Date().toISOString(), inv: INV, tx: TX || [] });
        const el = v$('#v41BackupInfo');
        if (el) el.textContent = 'Last auto-backup: ' + new Date().toLocaleString('en-IN') +
          ' · ' + INV.length + ' medicines';
      } catch (e) { /* localStorage full / disabled — non-fatal */ }
    },
    download() {
      const payload = store.get('backup_latest', { at: new Date().toISOString(), inv: INV, tx: TX || [] });
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'whims-backup-' + todayStr() + '.json';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      toast('Backup downloaded ✓');
    }
  };
  if (typeof loadAll === 'function') {
    const _loadAll = loadAll;
    // eslint-disable-next-line no-global-assign
    loadAll = async function (showToast) {
      const r = await _loadAll(showToast);
      Backup.snapshot();
      return r;
    };
  }

  /* ===========================================================================
     4 · UNIQUE CODE GENERATION  (exposed + unit-testable)
     ------------------------------------------------------------------------
     ID format: <PREFIX><NNN>, e.g. MT003. Next free number per prefix.
     =========================================================================== */
  function nextCode(prefix, inventory) {
    const p = String(prefix || '').trim().toUpperCase().replace(/[^A-Z]/g, '');
    if (!p) return '';
    let max = 0;
    (inventory || []).forEach(m => {
      const id = String(m.id || '').trim().toUpperCase();
      const mm = id.match(/^([A-Z]+)(\d+)$/);
      if (mm && mm[1] === p) { const n = parseInt(mm[2], 10); if (n > max) max = n; }
    });
    const width = Math.max(3, String(max + 1).length);
    return p + String(max + 1).padStart(width, '0');
  }

  /* category prefixes seen in current inventory (for the picker) */
  function knownPrefixes() {
    const set = new Set();
    (INV || []).forEach(m => {
      const mm = String(m.id || '').toUpperCase().match(/^([A-Z]+)\d+$/);
      if (mm) set.add(mm[1]);
    });
    return [...set].sort();
  }

  /* ===========================================================================
     5 · LIGHTWEIGHT AUTOCOMPLETE  (reusable)
     ------------------------------------------------------------------------
     Suggests from the in-memory inventory. Used for auto-fill on the
     Add-New-Medicine form.
     =========================================================================== */
  function attachAutocomplete(input, getItems, onPick) {
    let box = null, items = [], active = -1;
    const close = () => { if (box) { box.remove(); box = null; } active = -1; };
    const open = (list) => {
      close();
      if (!list.length) return;
      box = document.createElement('div');
      box.className = 'v41-ac';
      list.forEach((it, i) => {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'v41-ac-row';
        row.innerHTML = '<b>' + vEsc(it.label) + '</b>' + (it.sub ? '<span>' + vEsc(it.sub) + '</span>' : '');
        row.onmousedown = (e) => { e.preventDefault(); onPick(it.value); close(); };
        box.appendChild(row);
      });
      const wrap = input.closest('.v41-field') || input.parentElement;
      wrap.style.position = 'relative';
      wrap.appendChild(box);
    };
    input.addEventListener('input', () => {
      const q = input.value.trim().toLowerCase();
      if (q.length < 2) return close();
      items = getItems(q).slice(0, 8);
      open(items);
    });
    input.addEventListener('blur', () => setTimeout(close, 120));
  }

  /* ===========================================================================
     6 · ADD NEW MEDICINE MASTER  (reuses existing  additem  backend action)
     =========================================================================== */
  function buildNewMedSheet() {
    if (v$('#sheetNewMed')) return;
    const html = `
      <div class="grab"></div>
      <h2>Add New Medicine</h2>
      <div class="idline">Creates a master entry with an auto-generated code.</div>
      <div class="v41-field"><label for="nmName">Medicine name *</label>
        <input id="nmName" type="text" placeholder="e.g. ARNICA MONTANA" autocomplete="off"></div>
      <div class="btnrow">
        <div class="v41-field" style="flex:1"><label for="nmPrefix">Category code *</label>
          <input id="nmPrefix" list="nmPrefixList" type="text" placeholder="e.g. MT" autocomplete="off">
          <datalist id="nmPrefixList"></datalist></div>
        <div class="v41-field" style="flex:1"><label for="nmCode">Generated code</label>
          <input id="nmCode" type="text" placeholder="—"></div>
      </div>
      <div class="btnrow">
        <div class="v41-field" style="flex:1"><label for="nmPack">Pack size</label>
          <input id="nmPack" type="text" placeholder="e.g. 100 ML"></div>
        <div class="v41-field" style="flex:1"><label for="nmPotency">Potency</label>
          <input id="nmPotency" type="text" placeholder="e.g. MT, 30, 200"></div>
      </div>
      <div class="btnrow">
        <div class="v41-field" style="flex:1"><label for="nmBottles">Opening bottles *</label>
          <input id="nmBottles" type="number" min="0" inputmode="numeric" value="0"></div>
        <div class="v41-field" style="flex:1"><label for="nmMl">Opening ML</label>
          <input id="nmMl" type="number" min="0" inputmode="numeric" placeholder="optional"></div>
      </div>
      <div class="v41-field"><label for="nmSupplier">Primary supplier</label>
        <input id="nmSupplier" type="text" placeholder="e.g. BAKSON" autocomplete="off"></div>
      <div class="btnrow">
        <div class="v41-field" style="flex:1"><label for="nmCost">Primary cost (₹)</label>
          <input id="nmCost" type="number" min="0" step="0.01" inputmode="decimal" placeholder="optional"></div>
        <div class="v41-field" style="flex:1"><label for="nmExpiry">Expiry (YYYY-MM)</label>
          <input id="nmExpiry" type="month"></div>
      </div>
      <div class="v41-field"><label for="nmRemarks">Remarks</label>
        <input id="nmRemarks" type="text" placeholder="optional"></div>
      <div class="btnrow" style="margin-top:18px">
        <button class="btn btn-ghost" data-close>Cancel</button>
        <button class="btn btn-green" id="nmSave">Create medicine</button>
      </div>`;
    const sheet = document.createElement('div');
    sheet.className = 'sheet';
    sheet.id = 'sheetNewMed';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.innerHTML = html;
    document.body.appendChild(sheet);

    // close handler (data-close in app.js is wired at load; wire ours too)
    sheet.querySelector('[data-close]').onclick = () => closeSheets();

    const name = sheet.querySelector('#nmName');
    const prefix = sheet.querySelector('#nmPrefix');
    const code = sheet.querySelector('#nmCode');
    const regen = () => { code.value = nextCode(prefix.value, INV); };
    prefix.addEventListener('input', regen);

    // auto-fill: pick an existing medicine to copy its category/pack/potency/supplier
    attachAutocomplete(name,
      (q) => {
        const seen = new Set(), out = [];
        (INV || []).forEach(m => {
          const nm = String(m.name || '');
          if (nm.toLowerCase().includes(q) && !seen.has(nm.toLowerCase())) {
            seen.add(nm.toLowerCase());
            out.push({ label: nm, sub: m.id + ' · ' + (m.pack || ''), value: m });
          }
        });
        return out;
      },
      (m) => {
        // copy attributes (NOT the code — a new code is generated) for fast entry
        const mm = String(m.id || '').toUpperCase().match(/^([A-Z]+)\d+$/);
        if (mm && !prefix.value) prefix.value = mm[1];
        if (!sheet.querySelector('#nmPack').value) sheet.querySelector('#nmPack').value = m.pack || '';
        if (!sheet.querySelector('#nmPotency').value) sheet.querySelector('#nmPotency').value = m.potency || '';
        if (!sheet.querySelector('#nmSupplier').value) sheet.querySelector('#nmSupplier').value = m.supplier1 || '';
        regen();
        toast('Copied details from "' + (m.name || '') + '" — new code generated');
      });

    // supplier autocomplete from known suppliers
    attachAutocomplete(sheet.querySelector('#nmSupplier'),
      (q) => {
        const seen = new Set(), out = [];
        (INV || []).forEach(m => {
          [m.supplier1, m.supplier2].forEach(s => {
            const ss = String(s || '').trim();
            if (ss && ss.toLowerCase().includes(q) && !seen.has(ss.toLowerCase())) {
              seen.add(ss.toLowerCase()); out.push({ label: ss, value: ss });
            }
          });
        });
        return out;
      },
      (s) => { sheet.querySelector('#nmSupplier').value = s; });

    sheet.querySelector('#nmSave').onclick = async () => {
      const btn = sheet.querySelector('#nmSave');
      const nm = name.value.trim();
      if (!nm) return toast('Enter the medicine name', true);
      if (!code.value) return toast('Enter a category code to generate the ID', true);
      if (typeof API === 'function' && !API()) return toast('Connect the backend first (Settings)', true);
      btn.disabled = true;
      try {
        const res = await apiPost({
          action: 'additem',
          id: code.value,
          name: nm,
          pack: sheet.querySelector('#nmPack').value.trim(),
          potency: sheet.querySelector('#nmPotency').value.trim(),
          category: prefix.value.trim().toUpperCase(),
          bottles: Number(sheet.querySelector('#nmBottles').value) || 0,
          ml: sheet.querySelector('#nmMl').value === '' ? '' : Number(sheet.querySelector('#nmMl').value),
          supplier1: sheet.querySelector('#nmSupplier').value.trim(),
          cost1: sheet.querySelector('#nmCost').value === '' ? '' : Number(sheet.querySelector('#nmCost').value),
          expiry: sheet.querySelector('#nmExpiry').value,
          remarks: sheet.querySelector('#nmRemarks').value.trim()
        });
        closeSheets();
        toast('Created ' + (res.id || code.value) + ' ✓');
        await loadAll(false);
      } catch (e) {
        toast(e.message, true);
      }
      btn.disabled = false;
    };

    injectCloseButtons(); // give the new sheet its ✕ too
  }

  function openNewMed(prefill) {
    buildNewMedSheet();
    const sheet = v$('#sheetNewMed');
    // reset
    ['#nmName', '#nmPrefix', '#nmCode', '#nmPack', '#nmPotency', '#nmMl',
      '#nmSupplier', '#nmCost', '#nmExpiry', '#nmRemarks'].forEach(s => { const el = sheet.querySelector(s); if (el) el.value = ''; });
    sheet.querySelector('#nmBottles').value = '0';
    // populate prefix datalist
    const dl = sheet.querySelector('#nmPrefixList');
    dl.innerHTML = knownPrefixes().map(p => '<option value="' + vEsc(p) + '">').join('');
    if (prefill && prefill.name) sheet.querySelector('#nmName').value = prefill.name;
    openSheet('#sheetNewMed');
    setTimeout(() => sheet.querySelector('#nmName').focus(), 60);
  }

  function injectNewMedButton() {
    const search = v$('#view-search .searchwrap');
    if (!search || v$('#v41NewMed')) return;
    const b = document.createElement('button');
    b.id = 'v41NewMed';
    b.className = 'btn btn-navy';
    b.style.marginTop = '8px';
    b.textContent = '＋ New medicine';
    b.onclick = () => openNewMed();
    search.appendChild(b);
  }

  /* ===========================================================================
     7 · STOCK CORRECTION MODULE  (P3 — reuses existing  adjust  action)
     =========================================================================== */
  function buildCorrectSheet() {
    if (v$('#sheetCorrect')) return;
    const html = `
      <div class="grab"></div>
      <h2>Stock Correction</h2>
      <div class="idline" id="ccName"></div>
      <div class="banner" style="background:rgba(199,119,0,.12);color:var(--amber-deep);border-color:rgba(199,119,0,.25)">
        Use this only to fix a wrong stock figure (e.g. miscount, breakage, expiry write-off). A reason is required and is logged.</div>
      <div class="v41-field"><label for="ccBottles">Correct bottle count *</label>
        <input id="ccBottles" type="number" min="0" inputmode="numeric"></div>
      <div class="v41-field"><label for="ccMl">Correct ML (optional)</label>
        <input id="ccMl" type="number" min="0" inputmode="numeric"></div>
      <div class="v41-field"><label for="ccReason">Reason *</label>
        <select id="ccReason">
          <option value="">— choose —</option>
          <option>Physical recount</option>
          <option>Breakage / spillage</option>
          <option>Expiry write-off</option>
          <option>Data entry error</option>
          <option>Found unrecorded stock</option>
          <option>Other (see note)</option>
        </select></div>
      <div class="v41-field"><label for="ccNote">Note</label>
        <input id="ccNote" type="text" placeholder="Optional detail"></div>
      <div class="btnrow" style="margin-top:18px">
        <button class="btn btn-ghost" data-close>Cancel</button>
        <button class="btn btn-navy" id="ccSave">Save correction</button>
      </div>`;
    const sheet = document.createElement('div');
    sheet.className = 'sheet';
    sheet.id = 'sheetCorrect';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.innerHTML = html;
    document.body.appendChild(sheet);
    sheet.querySelector('[data-close]').onclick = () => closeSheets();

    sheet.querySelector('#ccSave').onclick = async () => {
      const btn = sheet.querySelector('#ccSave');
      if (!current) return;
      const reason = sheet.querySelector('#ccReason').value;
      if (!reason) return toast('Choose a reason for the correction', true);
      const bottles = Number(sheet.querySelector('#ccBottles').value);
      if (!(bottles >= 0)) return toast('Enter the correct bottle count', true);
      if (typeof API === 'function' && !API()) return toast('Connect the backend first (Settings)', true);
      const note = sheet.querySelector('#ccNote').value.trim();
      btn.disabled = true;
      try {
        const res = await apiPost({
          action: 'adjust',
          id: current.id,
          bottles: bottles,
          ml: sheet.querySelector('#ccMl').value === '' ? '' : Number(sheet.querySelector('#ccMl').value),
          priority: '',
          remarks: 'STOCK CORRECTION: ' + reason + (note ? ' — ' + note : '')
        });
        closeSheets();
        toast('Correction saved ✓ · stock: ' + (res.newStock !== undefined ? res.newStock : bottles));
        await loadAll(false);
      } catch (e) {
        toast(e.message, true);
      }
      btn.disabled = false;
    };
    injectCloseButtons();
  }

  function openCorrect() {
    if (!current) return;
    buildCorrectSheet();
    const sheet = v$('#sheetCorrect');
    sheet.querySelector('#ccName').textContent = current.name + ' · current: ' + (current.bottles ?? '?') + ' btl';
    sheet.querySelector('#ccBottles').value = current.bottles ?? '';
    sheet.querySelector('#ccMl').value = current.ml ?? '';
    sheet.querySelector('#ccReason').value = '';
    sheet.querySelector('#ccNote').value = '';
    openSheet('#sheetCorrect');
  }

  /* add "Stock Correction" + "Copy code" buttons into the detail sheet */
  function injectDetailButtons() {
    const detail = v$('#sheetDetail');
    if (!detail || v$('#v41Correct')) return;
    const row = document.createElement('div');
    row.className = 'btnrow';
    row.style.marginTop = '9px';
    row.innerHTML =
      '<button class="btn btn-ghost" id="v41Correct">Stock Correction</button>' +
      '<button class="btn btn-ghost" id="v41CopyCode">Copy code</button>';
    detail.appendChild(row);
    row.querySelector('#v41Correct').onclick = openCorrect;
    row.querySelector('#v41CopyCode').onclick = async () => {
      if (!current) return;
      try { await navigator.clipboard.writeText(current.id); toast('Code ' + current.id + ' copied'); }
      catch (e) { toast('Copy failed', true); }
    };
  }

  /* ===========================================================================
     8 · HISTORY FILTER + CORRECTION HISTORY  (wraps renderTx)
     =========================================================================== */
  let txFilter = 'all';
  function injectHistoryFilter() {
    const view = v$('#view-history');
    if (!view || v$('#v41TxFilter')) return;
    const bar = document.createElement('div');
    bar.id = 'v41TxFilter';
    bar.className = 'chips';
    bar.style.margin = '0 0 12px';
    bar.innerHTML = [
      ['all', 'All'], ['correction', 'Corrections'], ['RECEIVE', 'Received'],
      ['DISPENSE', 'Dispensed'], ['ADJUSTMENT', 'Adjustments']
    ].map(([f, l]) => '<button class="chip ' + (f === 'all' ? 'on' : '') + '" data-tf="' + f + '">' + l + '</button>').join('');
    const title = view.querySelector('.view-title');
    title.insertAdjacentElement('afterend', bar);
    bar.querySelectorAll('[data-tf]').forEach(b => b.onclick = () => {
      txFilter = b.dataset.tf;
      bar.querySelectorAll('.chip').forEach(c => c.classList.toggle('on', c === b));
      if (typeof renderTx === 'function') renderTx();
    });
  }
  if (typeof renderTx === 'function') {
    const _renderTx = renderTx;
    // eslint-disable-next-line no-global-assign
    renderTx = function () {
      if (txFilter === 'all') return _renderTx();
      const all = Array.isArray(TX) ? TX : [];
      const isCorr = t => /^STOCK CORRECTION/i.test(String(t.remarks || ''));
      const filtered = all.filter(t =>
        txFilter === 'correction' ? isCorr(t) : String(t.action) === txFilter);
      const list = v$('#txList');
      if (!list) return;
      if (!filtered.length) {
        list.innerHTML = '<div class="empty"><b>Nothing here</b>No matching transactions.</div>';
        return;
      }
      // reuse the app's txRow renderer for visual consistency
      list.innerHTML = filtered.map(txRow).join('');
    };
  }

  /* ===========================================================================
     9 · DASHBOARD DAILY STATISTICS  (wraps renderDash)
     =========================================================================== */
  function renderDailyStats() {
    const host = v$('#view-dash');
    if (!host) return;
    let card = v$('#v41Today');
    const all = Array.isArray(TX) ? TX : [];
    const today = todayStr();
    const isToday = t => String(t.dateTime || '').slice(0, 10) === today;
    const td = all.filter(isToday);
    const sum = (arr, f) => arr.reduce((a, t) => a + (Number(t[f]) || 0), 0);
    const recv = td.filter(t => t.action === 'RECEIVE');
    const disp = td.filter(t => t.action === 'DISPENSE');
    const inB = sum(recv, 'quantity'), outB = sum(disp, 'quantity');
    const spend = sum(recv, 'amount'), revenue = sum(disp, 'amount');
    const tilesHtml =
      tile(td.length, "Today's entries", '') +
      tile('+' + inB, 'Bottles in', 'green') +
      tile('−' + outB, 'Bottles out', 'red') +
      tile('₹' + revenue.toLocaleString('en-IN'), 'Dispensed value', 'blue');
    function tile(n, label, cls) {
      return '<div class="stat glass ' + cls + '"><div class="capstrip"></div><b>' + vEsc(n) + '</b><span>' + vEsc(label) + '</span></div>';
    }
    const block = '<div class="view-title" style="margin-top:22px">Today (' + today + ')</div>' +
      '<div class="stats" id="v41TodayGrid">' + tilesHtml + '</div>';
    if (!card) {
      card = document.createElement('div');
      card.id = 'v41Today';
      // place right after the existing Stock Overview stat grid
      const grid = v$('#statGrid');
      if (grid && grid.parentElement) grid.insertAdjacentElement('afterend', card);
      else host.appendChild(card);
    }
    card.innerHTML = block;
  }
  if (typeof renderDash === 'function') {
    const _renderDash = renderDash;
    // eslint-disable-next-line no-global-assign
    renderDash = function () { _renderDash(); renderDailyStats(); };
  }

  /* ===========================================================================
     10 · RECENT SEARCHES + HIGHLIGHT MATCHES  (wraps renderResults)
     =========================================================================== */
  const Recent = {
    KEY: 'recent_searches', MAX: 6,
    list() { return store.get(this.KEY, []); },
    add(q) {
      q = String(q || '').trim();
      if (q.length < 2) return;
      let l = this.list().filter(x => x.toLowerCase() !== q.toLowerCase());
      l.unshift(q);
      store.set(this.KEY, l.slice(0, this.MAX));
      this.render();
    },
    render() {
      let host = v$('#v41Recent');
      if (!host) {
        const wrap = v$('#view-search .searchwrap');
        if (!wrap) return;
        host = document.createElement('div');
        host.id = 'v41Recent';
        host.className = 'chips';
        host.style.marginTop = '6px';
        wrap.appendChild(host);
      }
      const l = this.list();
      host.style.display = l.length ? 'flex' : 'none';
      host.innerHTML = l.map(q =>
        '<button class="chip" data-rq="' + vEsc(q) + '">🕘 ' + vEsc(q) + '</button>').join('') +
        (l.length ? '<button class="chip" data-rq-clear="1">Clear</button>' : '');
      host.querySelectorAll('[data-rq]').forEach(b => b.onclick = () => {
        const q = v$('#q'); q.value = b.dataset.rq; q.dispatchEvent(new Event('input'));
      });
      const clr = host.querySelector('[data-rq-clear]');
      if (clr) clr.onclick = () => { store.set(this.KEY, []); this.render(); };
    }
  };
  // commit a recent search when the user pauses typing
  (function wireRecent() {
    const q = v$('#q'); if (!q) return;
    let t;
    q.addEventListener('input', () => {
      clearTimeout(t);
      const val = q.value;
      t = setTimeout(() => Recent.add(val), 1100);
    });
  })();

  // safe text-node highlighter (no innerHTML injection)
  function highlightMatches(query) {
    const root = v$('#results'); if (!root) return;
    const q = String(query || '').trim();
    if (q.length < 2) return;
    const needle = q.toLowerCase();
    const targets = root.querySelectorAll('.med .name, .med .meta');
    targets.forEach(node => {
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, null);
      const texts = [];
      let n; while ((n = walker.nextNode())) texts.push(n);
      texts.forEach(textNode => {
        const txt = textNode.nodeValue;
        const idx = txt.toLowerCase().indexOf(needle);
        if (idx === -1) return;
        const frag = document.createDocumentFragment();
        frag.appendChild(document.createTextNode(txt.slice(0, idx)));
        const mark = document.createElement('mark');
        mark.className = 'v41-mark';
        mark.textContent = txt.slice(idx, idx + needle.length);
        frag.appendChild(mark);
        frag.appendChild(document.createTextNode(txt.slice(idx + needle.length)));
        textNode.parentNode.replaceChild(frag, textNode);
      });
    });
  }
  if (typeof renderResults === 'function') {
    const _renderResults = renderResults;
    // eslint-disable-next-line no-global-assign
    renderResults = function () {
      _renderResults();
      const q = v$('#q') ? v$('#q').value : '';
      highlightMatches(q);
    };
  }

  /* ===========================================================================
     11 · FASTER SELECT ALL / CLEAR ALL / ORDER RENDER  (P4 — wraps renderOrders)
     ------------------------------------------------------------------------
     The original re-renders the entire orders DOM on every Select-all/Clear.
     We re-bind those buttons to toggle classes in place (no rebuild), and add
     a fast click-delegation path. Original render still runs first.
     =========================================================================== */
  if (typeof renderOrders === 'function') {
    const _renderOrders = renderOrders;
    // eslint-disable-next-line no-global-assign
    renderOrders = function () {
      _renderOrders();
      const selAllBtn = v$('#selAll');
      const list = v$('#orderList');
      if (!selAllBtn || !list) return;
      const checks = () => [...list.querySelectorAll('.ocheck')];
      const total = checks().length;
      const refreshCount = () => {
        const sel = (typeof orderSel !== 'undefined') ? orderSel.size : checks().filter(c => c.classList.contains('on')).length;
        const c = v$('#selCount'); if (c) c.textContent = sel + ' of ' + total + ' selected';
        selAllBtn.textContent = (sel === total && total > 0) ? 'Clear all' : 'Select all';
      };
      // in-place Select all / Clear all — no full re-render
      selAllBtn.onclick = () => {
        const allOn = (typeof orderSel !== 'undefined') ? orderSel.size === total : checks().every(c => c.classList.contains('on'));
        checks().forEach(cb => {
          const id = cb.dataset.chk;
          if (allOn) { cb.classList.remove('on'); cb.textContent = ''; cb.setAttribute('aria-checked', 'false'); if (typeof orderSel !== 'undefined') orderSel.delete(id); }
          else { cb.classList.add('on'); cb.textContent = '✓'; cb.setAttribute('aria-checked', 'true'); if (typeof orderSel !== 'undefined') orderSel.add(id); }
        });
        refreshCount();
        Sound.play('tap');
      };
      refreshCount();
    };
  }

  /* ===========================================================================
     12 · SETTINGS PANEL ADDITIONS  (theme / sound / backup)
     =========================================================================== */
  function injectSettings() {
    const view = v$('#view-settings');
    if (!view || v$('#v41Settings')) return;
    const card = document.createElement('div');
    card.className = 'card glass';
    card.id = 'v41Settings';
    card.innerHTML = `
      <div class="view-title" style="margin:0 0 10px">Appearance & extras (v4.1)</div>
      <label for="v41Theme">Theme</label>
      <select id="v41Theme">
        <option value="auto">Auto (match device)</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
      <label style="display:flex;align-items:center;gap:10px;margin-top:14px;text-transform:none;letter-spacing:0;font-size:14px;color:var(--ink)">
        <input id="v41Sound" type="checkbox" style="width:auto;margin:0">
        Sound feedback on actions</label>
      <div class="btnrow" style="margin-top:16px">
        <button class="btn btn-ghost" id="v41Download">Download backup</button>
        <button class="btn btn-navy" id="v41AddMed">＋ New medicine</button>
      </div>
      <p class="note" id="v41BackupInfo">Automatic local backup runs after every sync.</p>`;
    view.appendChild(card);

    const sel = card.querySelector('#v41Theme');
    sel.value = Theme.get();
    sel.onchange = () => Theme.set(sel.value);

    const snd = card.querySelector('#v41Sound');
    snd.checked = Sound.on();
    snd.onchange = () => { Sound.setOn(snd.checked); if (snd.checked) Sound.play('success'); };

    card.querySelector('#v41Download').onclick = () => Backup.download();
    card.querySelector('#v41AddMed').onclick = () => openNewMed();

    const list = store.get(Backup.KEY, []);
    if (list[0]) card.querySelector('#v41BackupInfo').textContent =
      'Last auto-backup: ' + new Date(list[0].at).toLocaleString('en-IN') + ' · ' + list[0].inv + ' medicines';
  }

  /* ===========================================================================
     BOOT
     =========================================================================== */
  function boot() {
    Theme.init();
    injectCloseButtons();
    injectDetailButtons();
    injectNewMedButton();
    injectSettings();
    injectHistoryFilter();
    Recent.render();
    // refresh the wrapped renders once now that wrappers are installed
    try { if (typeof renderDash === 'function') renderDash(); } catch (e) {}
    try { if (typeof renderResults === 'function') renderResults(); } catch (e) {}
    Backup.snapshot();
    console.log('[WHIMS v4.1-a] feature module loaded');
  }

  // expose a tiny namespace for QA / debugging (does not touch app.js globals)
  window.WHIMS41 = { nextCode, knownPrefixes, Theme, Sound, Backup, Recent, openNewMed, openCorrect, version: '4.1-a' };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
