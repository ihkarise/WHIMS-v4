/*
 * WHIMS v4.5 — UI wiring (additive, non-destructive)
 * ------------------------------------------------------------------
 * Loads LAST. Follows the established wrap-composition pattern: it only
 * WRAPS window.render* functions and augments existing DOM — it never
 * replaces app.js logic, renames fields, or touches IDs/backend schema.
 * All feature maths come from the tested WHIMS45 library.
 *
 *   A  Smart search        → autosuggest dropdown + fuzzy no-result fallback
 *   B  Related variants    → pack/potency section inside the detail sheet
 *   D  Order quantity       → per-item qty on legacy order rows + rich message
 *   E  Weekly dispensing    → "Dispensed This Week" dashboard panel
 *   G  Suppliers / WhatsApp → per-medicine contacts + click-to-chat
 *   C  Database import       → preview/validate/confirm card in Settings
 */
(function () {
  'use strict';
  if (window.WHIMSv45UI) return;
  var W = window.WHIMS45;
  if (!W) { console.warn('[WHIMS v4.5] logic library not found — UI disabled'); return; }

  var D = document;
  function $(s, r) { return (r || D).querySelector(s); }
  function G(n) { try { return window[n]; } catch (e) { return undefined; } }
  function inv() { return Array.isArray(G('INV')) ? G('INV') : []; }
  function tx() { return Array.isArray(G('TX')) ? G('TX') : []; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]); }); }
  function toast(m, e) { if (typeof G('toast') === 'function') G('toast')(m, e); }
  function lsGet(k, d) { try { var v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

  /* ================================================================
   * A — Smart search: autosuggest + fuzzy fallback
   * ================================================================ */
  var sugTimer;
  function mountAutosuggest() {
    var wrap = $('#view-search .searchwrap');
    var q = $('#q');
    if (!wrap || !q || $('#v45Suggest')) return;
    var box = D.createElement('div');
    box.id = 'v45Suggest';
    box.className = 'v45-suggest';
    box.setAttribute('role', 'listbox');
    // place directly under the search bar
    var bar = wrap.querySelector('.searchbar');
    (bar || wrap).insertAdjacentElement('afterend', box);

    q.addEventListener('input', function () {
      clearTimeout(sugTimer);
      var val = q.value;
      sugTimer = setTimeout(function () { renderSuggest(val); }, 170); // debounce — no request per keystroke
    });
    q.addEventListener('focus', function () { if (q.value.trim().length >= 2) renderSuggest(q.value); });
    D.addEventListener('click', function (e) {
      if (!box.contains(e.target) && e.target !== q) box.classList.remove('open');
    });
  }

  function renderSuggest(val) {
    var box = $('#v45Suggest'); if (!box) return;
    var query = String(val || '').trim();
    if (query.length < 2) { box.classList.remove('open'); box.innerHTML = ''; return; }
    var hits = W.suggestMedicines(query, inv(), { limit: 8, activeOnly: false });
    if (!hits.length) { box.classList.remove('open'); box.innerHTML = ''; return; }
    box.innerHTML = hits.map(function (h, i) {
      var m = h.record;
      var stock = (m.bottles === '' || m.bottles == null) ? '?' : m.bottles;
      var sub = [m.id, m.potency, m.pack].filter(Boolean).join(' · ');
      var tag = h.matchType === 'fuzzy' ? '<span class="v45-sug-tag">did you mean</span>' : '';
      return '<button class="v45-sug-item" data-i="' + i + '" role="option">' +
        '<span class="v45-sug-name">' + esc(m.name) + tag + '</span>' +
        '<span class="v45-sug-sub">' + esc(sub) + '</span>' +
        '<span class="v45-sug-stock">' + esc(stock) + ' btl</span></button>';
    }).join('');
    box.classList.add('open');
    box.querySelectorAll('.v45-sug-item').forEach(function (b) {
      b.onclick = function () {
        var m = hits[Number(b.dataset.i)].record;
        box.classList.remove('open');
        if (typeof G('openDetail') === 'function') G('openDetail')(m);
      };
    });
  }

  // Fuzzy fallback: after the base search renders, if it found nothing but the
  // query has fuzzy matches, show those ranked instead of "Nothing found".
  function fuzzyFallback() {
    var q = $('#q'); var results = $('#results');
    if (!q || !results) return;
    var query = q.value.trim();
    if (!query) return;
    var empty = results.querySelector('.empty');
    if (!empty) return;                       // base search already found matches
    var hits = W.searchMedicines(query, inv(), { limit: 40, activeOnly: false });
    if (!hits.length) return;
    var medRow = G('medRow'); var openDetail = G('openDetail');
    if (typeof medRow !== 'function') return;
    var rows = hits.map(function (h) { return h.record; });
    results.innerHTML = '<div class="v45-fuzzy-note">No exact match — closest medicines:</div>' +
      '<div class="card glass" style="padding:6px 8px">' + rows.map(medRow).join('') + '</div>';
    rows.forEach(function (m, i) {
      var main = results.querySelector('.medmain[data-i="' + i + '"]');
      if (main && typeof openDetail === 'function') main.onclick = function () { openDetail(m); };
      var ob = results.querySelector('.ordbtn[data-ord="' + i + '"]');
      if (ob && typeof G('toggleOrder') === 'function') ob.onclick = function (ev) { ev.stopPropagation(); G('toggleOrder')(m, ob); };
    });
  }

  /* ================================================================
   * B — Related variants + G — suppliers, inside the detail sheet
   * ================================================================ */
  var MED_CONTACTS = 'whims_med_contacts';   // { medId: [ {name, phones[], whatsapp, notes} ] }
  var SUP_WA = 'whims_supplier_wa';          // shared with whims-orders.js: { SUPPLIERNAME: number }

  function decorateDetail(m) {
    var sheet = $('#sheetDetail'); if (!sheet || !m) return;
    // remove any prior injected block (detail sheet is reused)
    var old = $('#v45DetailExtra'); if (old) old.remove();
    var host = D.createElement('div');
    host.id = 'v45DetailExtra';
    host.innerHTML = variantsHtml(m) + suppliersHtml(m);
    // insert before the first button row in the detail sheet
    var firstBtnRow = sheet.querySelector('.btnrow');
    if (firstBtnRow) firstBtnRow.insertAdjacentElement('beforebegin', host);
    else sheet.appendChild(host);
    wireVariants(host);
    wireSuppliers(host, m);
  }

  function variantsHtml(m) {
    var rv = W.relatedVariants(m, inv());
    if (!rv.samePotencyOtherPacks.length && !rv.otherPotencies.length) return '';
    function chip(v, kind) {
      var label = kind === 'pack' ? (v.pack || '—') : ((v.potency || '—') + ' · ' + (v.pack || ''));
      var s = v._stock;
      var cls = s === 0 ? 'v45-var-out' : '';
      return '<button class="v45-var ' + cls + '" data-vid="' + esc(v.id) + '">' +
        esc(label) + '<em>' + s + ' btl</em></button>';
    }
    var h = '<div class="v45-section"><div class="v45-sec-title">Related in stock</div>';
    if (rv.samePotencyOtherPacks.length) {
      h += '<div class="v45-var-label">Other pack sizes (potency ' + esc(m.potency || '—') + ')</div>' +
        '<div class="v45-var-row">' + rv.samePotencyOtherPacks.map(function (v) { return chip(v, 'pack'); }).join('') + '</div>';
    }
    if (rv.otherPotencies.length) {
      h += '<div class="v45-var-label">Other potencies</div>' +
        '<div class="v45-var-row">' + rv.otherPotencies.map(function (v) { return chip(v, 'pot'); }).join('') + '</div>';
    }
    h += '<div class="v45-var-note">Each is a separate item — stock is never combined.</div></div>';
    return h;
  }
  function wireVariants(host) {
    host.querySelectorAll('.v45-var').forEach(function (b) {
      b.onclick = function () {
        var m = inv().find(function (x) { return String(x.id) === b.dataset.vid; });
        if (m && typeof G('openDetail') === 'function') G('openDetail')(m);
      };
    });
  }

  function contactsFor(medId) {
    var all = lsGet(MED_CONTACTS, {});
    return Array.isArray(all[medId]) ? all[medId] : [];
  }
  function saveContacts(medId, list) {
    var all = lsGet(MED_CONTACTS, {}); all[medId] = list; lsSet(MED_CONTACTS, all);
  }
  // Suppliers already on the medicine record + the shared supplier→number book.
  function recordSuppliers(m) {
    var waBook = lsGet(SUP_WA, {});
    var out = [];
    [m.supplier1, m.supplier2].forEach(function (s) {
      if (!s) return;
      var num = waBook[String(s).toUpperCase()] || '';
      out.push({ name: s, phones: num ? [num] : [], whatsapp: num, notes: '', _fromRecord: true });
    });
    return out;
  }

  function suppliersHtml(m) {
    var all = recordSuppliers(m).concat(contactsFor(m.id));
    var msg = W.buildOrderMessage([{ med: m, qty: 1 }]);
    var rows = all.map(function (s, i) {
      var phones = (s.phones && s.phones.length) ? s.phones : (s.whatsapp ? [s.whatsapp] : []);
      var numBtns = phones.map(function (p) {
        var link = W.whatsappLink(p, msg);
        return link
          ? '<a class="v45-wa" href="' + esc(link) + '" target="_blank" rel="noopener">WhatsApp ' + esc(p) + '</a>'
          : '<span class="v45-wa v45-wa-bad">' + esc(p) + '</span>';
      }).join('');
      if (!numBtns) numBtns = '<span class="v45-nomum">no number saved</span>';
      var del = s._fromRecord ? '' : '<button class="v45-sup-del" data-del="' + i + '" title="Remove contact">×</button>';
      return '<div class="v45-sup-row"><div class="v45-sup-nm">' + esc(s.name) + '</div>' +
        '<div class="v45-sup-nums">' + numBtns + '</div>' + del + '</div>';
    }).join('');
    return '<div class="v45-section"><div class="v45-sec-title">Suppliers &amp; WhatsApp ordering</div>' +
      (rows || '<div class="v45-var-note">No suppliers on file for this medicine.</div>') +
      '<div class="v45-sup-add">' +
      '<input class="v45-in" id="v45SupName" placeholder="Supplier name">' +
      '<input class="v45-in" id="v45SupPhone" placeholder="Phone / WhatsApp e.g. 98765 43210">' +
      '<button class="v45-btn" id="v45SupAdd">Add</button></div>' +
      '<div class="v45-var-note">Contacts are saved on this device only.</div></div>';
  }
  function wireSuppliers(host, m) {
    var addBtn = host.querySelector('#v45SupAdd');
    if (addBtn) addBtn.onclick = function () {
      var name = (host.querySelector('#v45SupName').value || '').trim();
      var phone = (host.querySelector('#v45SupPhone').value || '').trim();
      if (!W.isValidSupplier({ name: name, phone: phone })) { toast('Enter a supplier name and a valid number', true); return; }
      var list = W.addSupplier(contactsFor(m.id), { name: name, phone: phone });
      saveContacts(m.id, list);
      G('openDetail')(m);           // re-render sheet with the new contact
    };
    host.querySelectorAll('.v45-sup-del').forEach(function (b) {
      b.onclick = function () {
        var list = W.removeSupplier(contactsFor(m.id), Number(b.dataset.del) - recordSuppliers(m).length);
        saveContacts(m.id, list);
        G('openDetail')(m);
      };
    });
  }

  /* ================================================================
   * E — Weekly dispensing panel on the dashboard
   * ================================================================ */
  function renderWeekly() {
    var host = $('#view-dash'); if (!host) return;
    var wk = W.weeklyDispensed(tx(), { weekStartsOn: 1 });
    var card = $('#v45Weekly');
    var top = wk.items.slice(0, 8);
    var rows = top.length
      ? top.map(function (it) {
          return '<div class="v45-wk-row"><span class="v45-wk-nm">' + esc(it.name || it.id) + '</span>' +
            '<span class="v45-wk-q">' + it.qty + '<em> dispensed</em></span></div>';
        }).join('') + (wk.items.length > top.length ? '<div class="v45-wk-more">+' + (wk.items.length - top.length) + ' more medicines this week</div>' : '')
      : '<div class="v45-var-note">No medicines dispensed yet this week.</div>';
    var start = wk.weekStart;
    var startLabel = start.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
    var block = '<div class="view-title" style="margin-top:22px">Dispensed This Week</div>' +
      '<div class="card glass v45-wk-card">' +
      '<div class="v45-wk-head"><span>Since Mon ' + esc(startLabel) + '</span><b>' + wk.totalQty + ' total</b></div>' +
      rows + '</div>';
    if (!card) {
      card = D.createElement('div'); card.id = 'v45Weekly';
      var recent = host.querySelector('#dashTx');
      if (recent && recent.parentElement) recent.insertAdjacentElement('beforebegin', card);
      else host.appendChild(card);
    }
    card.innerHTML = block;
  }

  /* ================================================================
   * D — Order quantity on legacy order rows + rich order message
   * ================================================================ */
  var ORDER_QTY = 'whims_order_qty';   // { medId: qty }
  function qtyMap() { return lsGet(ORDER_QTY, {}); }
  function qtyFor(id) { var q = qtyMap()[id]; return q == null ? 1 : q; }
  function setQty(id, q) { var m = qtyMap(); m[id] = Math.max(1, Number(q) || 1); lsSet(ORDER_QTY, m); }

  function decorateOrders() {
    var list = $('#orderList'); if (!list) return;
    list.querySelectorAll('.orow').forEach(function (row) {
      if (row.querySelector('.v45-qty')) return;
      var id = row.dataset.id; if (!id) return;
      var stepper = D.createElement('div');
      stepper.className = 'v45-qty';
      stepper.innerHTML = '<button class="v45-qbtn" data-d="-1">−</button>' +
        '<input class="v45-qin" type="number" min="1" inputmode="numeric" value="' + qtyFor(id) + '" aria-label="Order quantity">' +
        '<button class="v45-qbtn" data-d="1">+</button>';
      // insert before the remove (×) button
      var rm = row.querySelector('.orm');
      if (rm) rm.insertAdjacentElement('beforebegin', stepper);
      else row.appendChild(stepper);
      var input = stepper.querySelector('.v45-qin');
      input.onchange = function () { setQty(id, input.value); input.value = qtyFor(id); };
      stepper.querySelectorAll('.v45-qbtn').forEach(function (b) {
        b.onclick = function () { setQty(id, qtyFor(id) + Number(b.dataset.d)); input.value = qtyFor(id); };
      });
    });
  }

  // Build a quantity + unit aware order message from the current legacy selection.
  function richOrderMessage() {
    var orderData = G('orderData'); var orderSel = G('orderSel');
    if (typeof orderData !== 'function') return '';
    var groups = orderData();
    var names = Object.keys(groups).sort();
    var items = [];
    names.forEach(function (s) {
      groups[s].forEach(function (m) {
        if (orderSel && orderSel.size && !orderSel.has(m.id)) return;
        items.push({ med: m, qty: qtyFor(m.id) });
      });
    });
    if (!items.length) return '';
    return W.buildOrderMessage(items, {
      header: 'Hello,\n\nPlease supply the following:',
      footer: 'Thank you.\n— Wise Homeopathy'
    });
  }

  function wireOrderButtons() {
    var copy = $('#copyOrder'); var wa = $('#waOrder');
    if (copy && !copy.dataset.v45) {
      copy.dataset.v45 = '1';
      copy.addEventListener('click', function (e) {
        var t = richOrderMessage(); if (!t) return;              // fall through to legacy toast if empty
        e.stopImmediatePropagation();                            // supersede legacy handler
        navigator.clipboard.writeText(t).then(function () { toast('Order copied (with quantities)'); },
          function () { toast('Copy failed — long-press to select', true); });
      }, true);
    }
    if (wa && !wa.dataset.v45) {
      wa.dataset.v45 = '1';
      wa.addEventListener('click', function (e) {
        var t = richOrderMessage(); if (!t) return;
        e.stopImmediatePropagation();
        window.open('https://wa.me/?text=' + encodeURIComponent(t), '_blank');
      }, true);
    }
  }

  /* ================================================================
   * C — Database import (preview / validate / confirm) in Settings
   * ================================================================ */
  function mountImport() {
    var view = $('#view-settings'); if (!view || $('#v45Import')) return;
    var card = D.createElement('div');
    card.className = 'card glass';
    card.id = 'v45Import';
    card.innerHTML =
      '<div class="view-title" style="margin:0 0 10px">Database import (v4.5)</div>' +
      '<p class="note" style="margin-top:0">Import a CSV file or paste rows. Nothing is written until you review the preview and confirm — existing medicines are never overwritten.</p>' +
      '<input id="v45File" type="file" accept=".csv,text/csv,text/plain" style="margin-bottom:10px">' +
      '<textarea id="v45Paste" rows="4" placeholder="…or paste CSV / tab-separated rows here (first row = column headers)"></textarea>' +
      '<div class="btnrow" style="margin-top:12px">' +
      '<button class="btn btn-navy" id="v45Preview">Preview import</button>' +
      '<button class="btn btn-green" id="v45Confirm" disabled>Import new rows</button></div>' +
      '<div id="v45ImportOut"></div>';
    view.appendChild(card);

    var lastPreview = null;
    $('#v45File', card).addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0]; if (!f) return;
      var reader = new FileReader();
      reader.onload = function () { $('#v45Paste', card).value = String(reader.result || ''); };
      reader.readAsText(f);
    });
    $('#v45Preview', card).onclick = function () {
      var text = $('#v45Paste', card).value.trim();
      if (!text) { toast('Choose a file or paste rows first', true); return; }
      var parsed = parseDelimited(text);
      if (!parsed.rows.length) { toast('No data rows found', true); return; }
      var mapping = W.autoMap(parsed.headers);
      lastPreview = W.importPreview(parsed.rows, inv(), { mapping: mapping });
      renderImportPreview(card, parsed, mapping, lastPreview);
      $('#v45Confirm', card).disabled = lastPreview.summary.new === 0;
    };
    $('#v45Confirm', card).onclick = function () {
      if (!lastPreview) return;
      var rows = W.importableRows(lastPreview);  // new rows only
      if (!rows.length) { toast('Nothing new to import', true); return; }
      if (!confirm('Import ' + rows.length + ' NEW medicine(s)? Existing rows are left untouched.')) return;
      commitImport(rows, card);
    };
  }

  function renderImportPreview(card, parsed, mapping, prev) {
    var s = prev.summary;
    var mapLine = W.IMPORT_KNOWN_FIELDS.filter(function (f) { return mapping[f]; })
      .map(function (f) { return '<b>' + f + '</b>←' + esc(mapping[f]); }).join(' · ');
    var badge = function (n, label, cls) { return '<span class="v45-imp-b ' + cls + '"><b>' + n + '</b>' + label + '</span>'; };
    var sample = prev.rows.slice(0, 12).map(function (r) {
      return '<tr class="v45-imp-' + r.status + '"><td>' + (r.index + 1) + '</td>' +
        '<td>' + esc(r.record.name || '—') + '</td>' +
        '<td>' + esc(r.record.potency || '') + '</td>' +
        '<td>' + esc(r.record.pack || '') + '</td>' +
        '<td>' + r.status + (r.issues.length ? ' <em>(' + esc(r.issues.join('; ')) + ')</em>' : '') + '</td></tr>';
    }).join('');
    $('#v45ImportOut', card).innerHTML =
      '<div class="v45-map">Detected columns: ' + (mapLine || '<em>none recognised</em>') + '</div>' +
      '<div class="v45-imp-badges">' +
      badge(s.total, 'Total rows', '') + badge(s.new, 'New', 'v45-imp-new') +
      badge(s.existing, 'Existing', 'v45-imp-existing') + badge(s.duplicates, 'Duplicates', 'v45-imp-duplicate') +
      badge(s.invalid, 'Invalid', 'v45-imp-invalid') + '</div>' +
      '<table class="v45-imp-table"><thead><tr><th>#</th><th>Name</th><th>Pot.</th><th>Pack</th><th>Status</th></tr></thead>' +
      '<tbody>' + sample + '</tbody></table>' +
      (prev.rows.length > 12 ? '<div class="v45-var-note">Showing 12 of ' + prev.rows.length + ' rows.</div>' : '') +
      (s.new ? '' : '<div class="v45-var-note">No new rows to import — nothing will be written.</div>');
  }

  async function commitImport(rows, card) {
    var ap = G('apiPost');
    if (typeof ap !== 'function') { toast('Backend not connected', true); return; }
    $('#v45Confirm', card).disabled = true;
    try {
      var res = await ap({ action: 'importmedicines', rows: rows });
      toast('Imported ' + (res && res.added != null ? res.added : rows.length) + ' medicine(s) ✓');
      if (typeof G('loadAll') === 'function') await G('loadAll')(false);
      $('#v45ImportOut', card).innerHTML = '<div class="v45-map">Import complete — added ' +
        (res && res.added != null ? res.added : rows.length) + ', skipped ' + (res && res.skipped != null ? res.skipped : 0) + '.</div>';
    } catch (e) {
      // Backend action may not exist yet on older deployments — say so plainly.
      toast('Import failed: ' + e.message + (/unknown action/i.test(e.message) ? ' (update Code.gs to v4.5)' : ''), true);
      $('#v45Confirm', card).disabled = false;
    }
  }

  // Minimal, dependency-free CSV / TSV parser (handles quoted fields & commas).
  function parseDelimited(text) {
    var lines = String(text).replace(/\r\n?/g, '\n').split('\n').filter(function (l) { return l.trim() !== ''; });
    if (!lines.length) return { headers: [], rows: [] };
    var delim = (lines[0].indexOf('\t') >= 0 && lines[0].indexOf(',') < 0) ? '\t' : ',';
    function splitRow(line) {
      if (delim === '\t') return line.split('\t').map(function (c) { return c.trim(); });
      var out = [], cur = '', inQ = false;
      for (var i = 0; i < line.length; i++) {
        var ch = line[i];
        if (inQ) {
          if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
          else if (ch === '"') inQ = false;
          else cur += ch;
        } else {
          if (ch === '"') inQ = true;
          else if (ch === ',') { out.push(cur.trim()); cur = ''; }
          else cur += ch;
        }
      }
      out.push(cur.trim());
      return out;
    }
    var headers = splitRow(lines[0]);
    var rows = lines.slice(1).map(function (l) {
      var cells = splitRow(l), obj = {};
      headers.forEach(function (h, i) { obj[h] = cells[i] == null ? '' : cells[i]; });
      return obj;
    });
    return { headers: headers, rows: rows };
  }

  /* ================================================================
   * Install — wrap the existing render functions (compose, never replace)
   * ================================================================ */
  function wrap(name, after) {
    var prev = (typeof window[name] === 'function') ? window[name] : function () {};
    window[name] = function () {
      var r; try { r = prev.apply(this, arguments); } catch (e) {}
      try { after.apply(this, arguments); } catch (e) {}
      return r;
    };
  }

  function install() {
    wrap('renderResults', fuzzyFallback);
    wrap('openDetail', function (m) { decorateDetail(m); });
    wrap('renderDash', renderWeekly);
    wrap('renderOrders', function () { decorateOrders(); wireOrderButtons(); });
  }

  function boot() {
    install();
    mountAutosuggest();
    mountImport();
    // refresh anything already on screen now that wrappers are installed
    try { if (typeof window.renderDash === 'function') window.renderDash(); } catch (e) {}
    try { if (typeof window.renderResults === 'function') window.renderResults(); } catch (e) {}
    try { if (typeof window.renderOrders === 'function') window.renderOrders(); } catch (e) {}
    console.log('[WHIMS v4.5] UI module loaded');
  }

  window.WHIMSv45UI = {
    version: '4.5.0',
    renderSuggest: renderSuggest, renderWeekly: renderWeekly,
    richOrderMessage: richOrderMessage, parseDelimited: parseDelimited,
    _test: { qtyFor: qtyFor, setQty: setQty }
  };

  if (D.readyState === 'loading') D.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
