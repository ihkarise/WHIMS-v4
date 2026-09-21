/*
 * WHIMS v4.5 — Smart Inventory logic library
 * ------------------------------------------------------------------
 * Pure, dependency-free, framework-agnostic functions that power the
 * seven v4.5 features. Everything here is deterministic and unit-tested
 * (see whims-v45.test.js) so it can run identically in the browser and
 * under Node. It performs NO DOM work, NO network work and mutates NO
 * global state — the UI layer (whims-v45-ui.js) consumes this.
 *
 * Exposed as:
 *   • window.WHIMS45           (browser)
 *   • module.exports           (Node / tests)
 *
 * Feature map:
 *   A  Smart search          → searchMedicines(), Search internals
 *   B  Related variants      → relatedVariants(), medicineIdentity()
 *   C  Database import        → importPreview()
 *   D  Order quantity         → orderLine(), unitFor(), buildOrderMessage()
 *   E  Weekly dispensing      → weeklyDispensed(), weekStart()
 *   F  Unit-cost receiving    → receivingTotal(), formatINR()
 *   G  Suppliers / WhatsApp   → normalizePhone(), whatsappLink(),
 *                               supplier contact model helpers
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;   // Node / tests
  root.WHIMS45 = api;                                                        // browser
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ==================================================================
   * Shared small utilities
   * ================================================================== */
  function str(v) { return v === null || v === undefined ? '' : String(v); }
  function num(v) {
    if (v === null || v === undefined || v === '') return 0;
    var n = Number(String(v).replace(/[^0-9.\-]/g, ''));
    return isNaN(n) ? 0 : n;
  }
  function isBlank(v) { return v === null || v === undefined || String(v).trim() === ''; }

  /** Normalize a searchable string: lowercase, strip punctuation, collapse
   *  whitespace. Keeps letters, digits and single spaces only. */
  function normalize(s) {
    return str(s).toLowerCase()
      .replace(/[^a-z0-9\s]+/g, ' ')   // punctuation → space
      .replace(/\s+/g, ' ')
      .trim();
  }
  /** Identity normalize: like normalize but keeps the raw token joined for
   *  medicine-name identity (spaces collapsed, punctuation dropped). */
  function normName(s) { return normalize(s); }
  /** Potency normalize — homeopathy potencies are case/space-insensitive
   *  (e.g. "30", "30C", "1m", "1 M"). */
  function normPotency(s) {
    return str(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
  }
  /** Pack normalize — "15 ML" == "15ml". */
  function normPack(s) {
    return str(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
  }
  function tokens(s) { return normalize(s).split(' ').filter(Boolean); }

  /* ==================================================================
   * Feature A — Smart medicine search (layered + fuzzy)
   * ------------------------------------------------------------------
   * Layers, highest wins:
   *   exact(1000) > prefix(850) > word/token(700) > substring(560)
   *   > subsequence(420) > fuzzy edit-distance(<=300)
   * Field weights let name/id/barcode outrank category/supplier.
   * ================================================================== */

  /** Levenshtein edit distance (iterative, O(n*m), early-exit on maxDist). */
  function editDistance(a, b, maxDist) {
    a = str(a); b = str(b);
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    if (Math.abs(a.length - b.length) > (maxDist == null ? Infinity : maxDist)) {
      return (maxDist == null ? Math.abs(a.length - b.length) : maxDist + 1);
    }
    var prev = new Array(b.length + 1);
    var cur = new Array(b.length + 1);
    for (var j = 0; j <= b.length; j++) prev[j] = j;
    for (var i = 1; i <= a.length; i++) {
      cur[0] = i;
      var rowMin = cur[0];
      for (var k = 1; k <= b.length; k++) {
        var cost = a.charCodeAt(i - 1) === b.charCodeAt(k - 1) ? 0 : 1;
        cur[k] = Math.min(prev[k] + 1, cur[k - 1] + 1, prev[k - 1] + cost);
        if (cur[k] < rowMin) rowMin = cur[k];
      }
      if (maxDist != null && rowMin > maxDist) return maxDist + 1;   // can only grow
      var tmp = prev; prev = cur; cur = tmp;
    }
    return prev[b.length];
  }

  /** Allowed typo budget grows with word length. */
  function fuzzyBudget(len) {
    if (len <= 3) return 0;    // too short to fuzz safely
    if (len <= 5) return 1;
    if (len <= 9) return 2;
    return 3;
  }

  /** Is q a subsequence of v (all chars in order)? Returns a compactness score 0..1 or -1. */
  function subsequenceScore(q, v) {
    if (!q) return -1;
    var i = 0, j = 0, first = -1, last = -1;
    while (i < q.length && j < v.length) {
      if (q[i] === v[j]) { if (first < 0) first = j; last = j; i++; }
      j++;
    }
    if (i < q.length) return -1;
    var span = (last - first + 1) || 1;
    return q.length / span;   // 1 = contiguous
  }

  /** Score a single field value against a normalized query. Returns {score,type}. */
  function scoreField(q, rawVal) {
    var v = normalize(rawVal);
    if (!v) return { score: 0, type: null };
    if (v === q) return { score: 1000, type: 'exact' };
    if (v.indexOf(q) === 0) return { score: 850, type: 'prefix' };

    // token/word layer — any word starts with q, or all query-words prefix a value-word
    var vTokens = v.split(' ');
    var qTokens = q.split(' ').filter(Boolean);
    if (qTokens.length > 1) {
      var allMatched = qTokens.every(function (qt) {
        return vTokens.some(function (vt) { return vt.indexOf(qt) === 0; });
      });
      if (allMatched) return { score: 720, type: 'token' };
    }
    if (vTokens.some(function (vt) { return vt.indexOf(q) === 0; })) return { score: 700, type: 'token' };

    var sub = v.indexOf(q);
    if (sub > 0) return { score: 560 - Math.min(sub, 40), type: 'substring' };

    var seq = subsequenceScore(q, v);
    if (seq >= 0) return { score: Math.round(360 + 60 * seq), type: 'subsequence' };

    // fuzzy — compare q against whole value and against each value token
    var budget = fuzzyBudget(q.length);
    if (budget > 0) {
      var best = Infinity;
      var d = editDistance(q, v, budget); if (d < best) best = d;
      for (var t = 0; t < vTokens.length; t++) {
        var dt = editDistance(q, vTokens[t], budget); if (dt < best) best = dt;
        if (best === 0) break;
      }
      if (best <= budget) return { score: 300 - best * 60, type: 'fuzzy' };
    }
    return { score: 0, type: null };
  }

  var DEFAULT_FIELDS = [
    { key: 'name', weight: 1.0 },
    { key: 'id', weight: 1.0 },
    { key: 'barcode', weight: 1.0 },
    { key: 'potency', weight: 0.6 },
    { key: 'pack', weight: 0.55 },
    { key: 'category', weight: 0.5 },
    { key: 'supplier1', weight: 0.5 },
    { key: 'supplier2', weight: 0.5 }
  ];

  /** Rank a record against the query. Returns {score,type,field} or null. */
  function scoreRecord(q, rec, fields) {
    var best = null;
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      var r = scoreField(q, rec[f.key]);
      if (r.score <= 0) continue;
      var weighted = r.score * f.weight;
      if (!best || weighted > best.score) best = { score: weighted, type: r.type, field: f.key };
    }
    return best;
  }

  /**
   * searchMedicines(query, records, opts)
   *   opts.fields     — array of {key,weight}       (default DEFAULT_FIELDS)
   *   opts.limit      — max results                 (default 30)
   *   opts.threshold  — min weighted score          (default 150)
   *   opts.activeOnly — drop m.active === 'NO'       (default false)
   * Returns [{ record, score, matchType, field }] ranked best-first.
   */
  function searchMedicines(query, records, opts) {
    opts = opts || {};
    var fields = opts.fields || DEFAULT_FIELDS;
    var limit = opts.limit || 30;
    var threshold = opts.threshold != null ? opts.threshold : 150;
    var q = normalize(query);
    records = records || [];
    if (!q) return [];
    var out = [];
    for (var i = 0; i < records.length; i++) {
      var rec = records[i];
      if (!rec) continue;
      if (opts.activeOnly && str(rec.active).toUpperCase() === 'NO') continue;
      var r = scoreRecord(q, rec, fields);
      if (r && r.score >= threshold) {
        out.push({ record: rec, score: Math.round(r.score), matchType: r.type, field: r.field });
      }
    }
    out.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      return normalize(a.record.name).localeCompare(normalize(b.record.name));
    });
    return out.slice(0, limit);
  }

  /** Lightweight autosuggest — de-duplicated top suggestions for a typeahead. */
  function suggestMedicines(query, records, opts) {
    opts = opts || {};
    var limit = opts.limit || 8;
    var hits = searchMedicines(query, records, { limit: limit * 2, threshold: opts.threshold != null ? opts.threshold : 200, activeOnly: opts.activeOnly, fields: opts.fields });
    var seen = {}, out = [];
    for (var i = 0; i < hits.length && out.length < limit; i++) {
      var id = str(hits[i].record.id) || normalize(hits[i].record.name);
      if (seen[id]) continue;
      seen[id] = 1;
      out.push(hits[i]);
    }
    return out;
  }

  /* ==================================================================
   * Feature B — Related pack / potency variants
   * ------------------------------------------------------------------
   * Identity = normalized name (+ potency). Stock is NEVER merged — each
   * inventory row stays independent; we only describe relationships.
   * ================================================================== */

  function medicineIdentity(m) {
    return { name: normName(m && m.name), potency: normPotency(m && m.potency) };
  }

  /**
   * relatedVariants(target, inventory, opts)
   * Returns:
   *   { samePotencyOtherPacks: [rows], otherPotencies: [rows] }
   * where each row is the untouched inventory object plus a convenience
   * `_stock` number. Same name + same potency + different pack → pack
   * variant. Same name + different potency → potency variant.
   * opts.includeArchived (default false).
   */
  function relatedVariants(target, inventory, opts) {
    opts = opts || {};
    inventory = inventory || [];
    var tName = normName(target && target.name);
    var tPot = normPotency(target && target.potency);
    var tPack = normPack(target && target.pack);
    var tId = str(target && target.id);
    var samePack = [], otherPot = [];
    for (var i = 0; i < inventory.length; i++) {
      var m = inventory[i];
      if (!m) continue;
      if (!opts.includeArchived && str(m.active).toUpperCase() === 'NO') continue;
      if (str(m.id) === tId && tId !== '') continue;          // never list the item itself
      if (normName(m.name) !== tName || tName === '') continue; // must be the same medicine name
      var row = Object.assign({}, m, { _stock: num(m.bottles) });
      if (normPotency(m.potency) === tPot) {
        if (normPack(m.pack) !== tPack) samePack.push(row);   // same potency, different pack
      } else {
        otherPot.push(row);                                    // different potency
      }
    }
    var byStock = function (a, b) { return b._stock - a._stock; };
    samePack.sort(byStock);
    otherPot.sort(byStock);
    return { samePotencyOtherPacks: samePack, otherPotencies: otherPot };
  }

  /* ==================================================================
   * Feature E — Weekly dispensing intelligence
   * ------------------------------------------------------------------
   * Week boundary: Monday 00:00 (local) → now, inclusive. Only DISPENSE
   * transactions count — receiving/adjustment/archive/restore/order are
   * excluded. Stock is read from transaction quantity, not inventory.
   * ================================================================== */

  /** parse "YYYY-MM-DD HH:mm:ss" (sheet format), ISO, or Date. Local time. */
  function parseDate(v) {
    if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
    var s = str(v).trim();
    if (!s) return null;
    var m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
    if (m) {
      return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
    }
    var d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }

  /** Start of the current week (Monday 00:00 by default). weekStartsOn: 0=Sun..6. */
  function weekStart(now, weekStartsOn) {
    var d = now instanceof Date ? new Date(now.getTime()) : new Date(now == null ? Date.now() : now);
    var startDow = weekStartsOn == null ? 1 : weekStartsOn;   // Monday
    d.setHours(0, 0, 0, 0);
    var diff = (d.getDay() - startDow + 7) % 7;
    d.setDate(d.getDate() - diff);
    return d;
  }

  /**
   * weeklyDispensed(transactions, opts)
   *   opts.now          — reference time (default Date.now())
   *   opts.weekStartsOn — 0..6 (default 1 = Monday)
   *   opts.limit        — top N medicines (default Infinity)
   * Returns { weekStart, totalQty, events, items:[{id,name,qty,events}] }.
   */
  function weeklyDispensed(transactions, opts) {
    opts = opts || {};
    transactions = transactions || [];
    var nowMs = opts.now == null ? Date.now() : +new Date(opts.now);
    var start = weekStart(nowMs, opts.weekStartsOn).getTime();
    var byMed = {}, order = [], totalQty = 0, events = 0;
    for (var i = 0; i < transactions.length; i++) {
      var t = transactions[i];
      if (!t || str(t.action).toUpperCase() !== 'DISPENSE') continue;
      var d = parseDate(t.dateTime);
      if (!d) continue;
      var ms = d.getTime();
      if (ms < start || ms > nowMs) continue;
      var id = str(t.medicineId) || normName(t.medicineName);
      var q = num(t.quantity);
      if (!byMed[id]) { byMed[id] = { id: str(t.medicineId), name: str(t.medicineName), qty: 0, events: 0 }; order.push(id); }
      byMed[id].qty += q; byMed[id].events++;
      totalQty += q; events++;
    }
    var items = order.map(function (id) { return byMed[id]; })
      .sort(function (a, b) { return b.qty - a.qty || a.name.localeCompare(b.name); });
    if (opts.limit != null && isFinite(opts.limit)) items = items.slice(0, opts.limit);
    return { weekStart: new Date(start), totalQty: totalQty, events: events, items: items };
  }

  /* ==================================================================
   * Feature F — Unit-cost receiving math (money-safe)
   * ------------------------------------------------------------------
   * User enters quantity + cost PER bottle; total is derived. Arithmetic
   * is done in integer paise to avoid float drift (e.g. 3 × 150 = 450).
   * ================================================================== */

  function toPaise(rupees) { return Math.round(num(rupees) * 100); }
  function fromPaise(paise) { return Math.round(paise) / 100; }

  /** receivingTotal(quantity, unitCost) → { quantity, unitCost, total } */
  function receivingTotal(quantity, unitCost) {
    var qty = num(quantity);
    var unit = num(unitCost);
    var totalPaise = Math.round(qty * toPaise(unit));
    return { quantity: qty, unitCost: fromPaise(toPaise(unit)), total: fromPaise(totalPaise) };
  }

  /** Derive per-unit cost from a legacy total (backward-compat display only). */
  function unitCostFromTotal(total, quantity) {
    var qty = num(quantity);
    if (qty <= 0) return 0;
    return fromPaise(Math.round(toPaise(total) / qty));
  }

  /** Format a number as clean INR, e.g. 450 → "₹450.00". */
  function formatINR(value, opts) {
    opts = opts || {};
    var n = num(value);
    var s = Math.abs(n).toFixed(opts.decimals == null ? 2 : opts.decimals);
    // Indian grouping (lakh/crore) on the integer part
    var parts = s.split('.');
    var intPart = parts[0];
    var last3 = intPart.slice(-3);
    var rest = intPart.slice(0, -3);
    if (rest) last3 = rest.replace(/\B(?=(\d\d)+(?!\d))/g, ',') + ',' + last3;
    var grouped = last3 + (parts[1] ? '.' + parts[1] : '');
    return (n < 0 ? '-' : '') + '₹' + grouped;
  }

  /* ==================================================================
   * Feature D — Order quantity + unit-aware message
   * ------------------------------------------------------------------
   * Unit is derived from the pack / name text, never hardcoded to
   * "bottle". Falls back to a neutral "unit".
   * ================================================================== */

  var UNIT_RULES = [
    { re: /\b(ml|drop|dilution|bottle|liquid|mother\s*tincture|\bmt\b|globule)\b/i, unit: 'bottle' },
    { re: /\b(tab|tablet|pill|trituration)\b/i, unit: 'tablet' },
    { re: /\b(cap|capsule)\b/i, unit: 'capsule' },
    { re: /\b(sachet)\b/i, unit: 'sachet' },
    { re: /\b(tube|cream|ointment|gel|balm)\b/i, unit: 'tube' },
    { re: /\b(packet|pkt|sachet|strip)\b/i, unit: 'packet' },
    { re: /\b(box|carton)\b/i, unit: 'box' }
  ];

  /** unitFor(med) → singular unit noun derived from pack/name/category. */
  function unitFor(med) {
    med = med || {};
    var hay = [med.pack, med.name, med.category, med.form].map(str).join(' ');
    for (var i = 0; i < UNIT_RULES.length; i++) {
      if (UNIT_RULES[i].re.test(hay)) return UNIT_RULES[i].unit;
    }
    return 'unit';
  }

  function pluralize(word, n) {
    if (Math.abs(num(n)) === 1) return word;
    if (/(s|x|z|ch|sh)$/i.test(word)) return word + 'es';
    if (/[^aeiou]y$/i.test(word)) return word.slice(0, -1) + 'ies';
    return word + 's';
  }

  /**
   * orderLine(med, qty, opts) → "Sunny Hair Color Black — 5 packets"
   * opts.unit overrides the derived unit. opts.bullet prefixes "• ".
   */
  function orderLine(med, qty, opts) {
    opts = opts || {};
    med = med || {};
    var q = num(qty);
    var unit = opts.unit || unitFor(med);
    var packNote = !opts.hidePack && !isBlank(med.pack) ? ' (' + str(med.pack).trim() + ')' : '';
    var line = str(med.name).trim() + packNote + ' — ' + q + ' ' + pluralize(unit, q);
    return (opts.bullet ? '• ' : '') + line;
  }

  /**
   * buildOrderMessage(items, opts)
   *   items: [{ med, qty }] or inventory rows carrying `qty`/`qtyOrdered`
   * Returns a WhatsApp/clipboard-ready message with quantities and units.
   */
  function buildOrderMessage(items, opts) {
    opts = opts || {};
    items = items || [];
    var header = opts.header || 'Hello, please supply:';
    var lines = items.map(function (it) {
      var med = it.med || it;
      var qty = it.qty != null ? it.qty : (it.qtyOrdered != null ? it.qtyOrdered : 1);
      return orderLine(med, qty, { bullet: opts.bullet !== false });
    });
    var body = header + '\n\n' + lines.join('\n');
    if (opts.footer) body += '\n\n' + opts.footer;
    return body;
  }

  /* ==================================================================
   * Feature G — Suppliers & WhatsApp
   * ================================================================== */

  /**
   * normalizePhone(raw, defaultCC) → { ok, e164, digits, display } for wa.me.
   * Handles +91, leading 0, bare 10-digit numbers; defaultCC default "91".
   */
  function normalizePhone(raw, defaultCC) {
    defaultCC = str(defaultCC || '91').replace(/\D/g, '') || '91';
    var s = str(raw).trim();
    var hadPlus = s.charAt(0) === '+';
    var digits = s.replace(/\D/g, '');
    if (!digits) return { ok: false, e164: '', digits: '', display: '' };
    if (!hadPlus) {
      if (digits.length > 2 && digits.charAt(0) === '0') digits = digits.replace(/^0+/, '');
      // bare local number (e.g. 10-digit Indian mobile) → prepend default CC
      if (digits.length <= 10) digits = defaultCC + digits;
    }
    var ok = digits.length >= 10 && digits.length <= 15;
    return { ok: ok, e164: '+' + digits, digits: digits, display: '+' + digits };
  }

  /** whatsappLink(number, message, defaultCC) → https://wa.me/... or null. */
  function whatsappLink(number, message, defaultCC) {
    var p = normalizePhone(number, defaultCC);
    if (!p.ok) return null;
    var base = 'https://wa.me/' + p.digits;
    return message ? base + '?text=' + encodeURIComponent(str(message)) : base;
  }

  /** Validate & normalize one supplier contact. Non-destructive. */
  function normalizeSupplier(s) {
    s = s || {};
    var phones = (Array.isArray(s.phones) ? s.phones : (s.phone ? [s.phone] : []))
      .map(function (p) { return normalizePhone(p); })
      .filter(function (p) { return p.ok; })
      .map(function (p) { return p.display; });
    var wa = s.whatsapp ? normalizePhone(s.whatsapp) : null;
    return {
      name: str(s.name).trim(),
      phones: phones,
      whatsapp: wa && wa.ok ? wa.display : (phones[0] || ''),
      notes: str(s.notes).trim()
    };
  }
  function isValidSupplier(s) {
    var n = normalizeSupplier(s);
    return !!(n.name && (n.phones.length || n.whatsapp));
  }
  /** Add a supplier to a list immutably; returns a new array. Never overwrites. */
  function addSupplier(list, s) {
    var next = (Array.isArray(list) ? list.slice() : []);
    if (isValidSupplier(s)) next.push(normalizeSupplier(s));
    return next;
  }
  function removeSupplier(list, index) {
    var next = (Array.isArray(list) ? list.slice() : []);
    if (index >= 0 && index < next.length) next.splice(index, 1);
    return next;
  }

  /* ==================================================================
   * Feature C — Database import preview / validation
   * ------------------------------------------------------------------
   * Non-destructive: classifies each incoming row without writing.
   *   invalid   — missing required fields (name)
   *   duplicate — collides with another row IN THE IMPORT
   *   existing  — matches a row already in inventory (id, or name+potency)
   *   new       — safe to add
   * ================================================================== */

  var IMPORT_REQUIRED = ['name'];
  var IMPORT_KNOWN_FIELDS = ['id', 'name', 'pack', 'potency', 'category', 'bottles',
    'ml', 'priority', 'supplier1', 'cost1', 'supplier2', 'cost2', 'mfd', 'expiry', 'barcode', 'remarks'];

  /** Guess a target field from a spreadsheet header string. */
  function guessField(header) {
    var h = normalize(header).replace(/\s+/g, '');
    var MAP = {
      id: 'id', code: 'id', sku: 'id', itemid: 'id', medid: 'id',
      name: 'name', medicine: 'name', medicinename: 'name', product: 'name', item: 'name', itemname: 'name',
      pack: 'pack', packsize: 'pack', size: 'pack',
      potency: 'potency', power: 'potency', strength: 'potency',
      category: 'category', type: 'category', group: 'category',
      bottles: 'bottles', qty: 'bottles', quantity: 'bottles', stock: 'bottles', count: 'bottles',
      ml: 'ml', volume: 'ml',
      priority: 'priority', reorder: 'priority',
      supplier: 'supplier1', supplier1: 'supplier1', company: 'supplier1', vendor: 'supplier1', primarysupplier: 'supplier1',
      supplier2: 'supplier2', secondarysupplier: 'supplier2',
      cost: 'cost1', cost1: 'cost1', price: 'cost1', rate: 'cost1', unitcost: 'cost1', primarycost: 'cost1',
      cost2: 'cost2', secondarycost: 'cost2',
      mfd: 'mfd', mfg: 'mfd', manufactured: 'mfd', mfgdate: 'mfd',
      expiry: 'expiry', expiration: 'expiry', exp: 'expiry', expirydate: 'expiry',
      barcode: 'barcode', ean: 'barcode', upc: 'barcode',
      remarks: 'remarks', notes: 'remarks', note: 'remarks'
    };
    return MAP[h] || null;
  }

  /** Build a default mapping {targetField: header} from a list of headers. */
  function autoMap(headers) {
    var map = {};
    (headers || []).forEach(function (h) {
      var f = guessField(h);
      if (f && !map[f]) map[f] = h;
    });
    return map;
  }

  /** Apply a mapping to a raw row object → normalized medicine-shaped record. */
  function applyMapping(rawRow, mapping) {
    var rec = {};
    Object.keys(mapping || {}).forEach(function (field) {
      var header = mapping[field];
      if (header != null && rawRow[header] !== undefined) rec[field] = rawRow[header];
    });
    return rec;
  }

  function existingKey(m) { return normName(m.name) + '|' + normPotency(m.potency) + '|' + normPack(m.pack); }

  /**
   * importPreview(rawRows, inventory, opts)
   *   opts.mapping  — {targetField: header}. If omitted, rows are assumed
   *                   already keyed by target field (or auto-mapped from keys).
   * Returns { summary, rows } where each row is
   *   { index, record, status, issues:[...], matchId? }
   * and summary = { total, new, existing, duplicates, invalid }.
   * Never mutates inventory.
   */
  function importPreview(rawRows, inventory, opts) {
    opts = opts || {};
    rawRows = rawRows || [];
    inventory = inventory || [];
    var mapping = opts.mapping;

    // index existing inventory
    var byId = {}, byKey = {};
    inventory.forEach(function (m) {
      if (!isBlank(m.id)) byId[str(m.id).toUpperCase()] = m;
      byKey[existingKey(m)] = m;
    });

    var seenInImport = {};
    var rows = rawRows.map(function (raw, i) {
      var record = mapping ? applyMapping(raw, mapping) : raw;
      var issues = [];
      // required fields
      IMPORT_REQUIRED.forEach(function (f) { if (isBlank(record[f])) issues.push('missing ' + f); });
      // numeric sanity — a non-blank value that has no usable digits is invalid
      ['bottles', 'ml', 'cost1', 'cost2'].forEach(function (f) {
        if (isBlank(record[f])) return;
        var stripped = String(record[f]).replace(/[^0-9.\-]/g, '');
        if (stripped === '' || isNaN(Number(stripped))) issues.push('non-numeric ' + f);
      });
      if (!isBlank(record.priority)) {
        var p = num(record.priority);
        if (p < 0 || p > 5) issues.push('priority out of range');
      }

      var status;
      if (issues.length) {
        status = 'invalid';
      } else {
        var key = existingKey(record);
        var idKey = isBlank(record.id) ? null : str(record.id).toUpperCase();
        if (seenInImport[key]) {
          status = 'duplicate';
          issues.push('duplicate of row ' + (seenInImport[key] + 1) + ' in this file');
        } else if ((idKey && byId[idKey]) || byKey[key]) {
          status = 'existing';
        } else {
          status = 'new';
        }
        seenInImport[key] = i;
      }
      var match = null;
      if (status === 'existing') {
        var idKey2 = isBlank(record.id) ? null : str(record.id).toUpperCase();
        match = (idKey2 && byId[idKey2]) || byKey[existingKey(record)];
      }
      return { index: i, record: record, status: status, issues: issues, matchId: match ? match.id : null };
    });

    var summary = { total: rows.length, new: 0, existing: 0, duplicates: 0, invalid: 0 };
    rows.forEach(function (r) {
      if (r.status === 'new') summary.new++;
      else if (r.status === 'existing') summary.existing++;
      else if (r.status === 'duplicate') summary.duplicates++;
      else if (r.status === 'invalid') summary.invalid++;
    });
    return { summary: summary, rows: rows };
  }

  /** Rows that are safe to import as-is (new only, by default). */
  function importableRows(preview, opts) {
    opts = opts || {};
    var allow = opts.includeExisting ? ['new', 'existing'] : ['new'];
    return preview.rows.filter(function (r) { return allow.indexOf(r.status) >= 0; }).map(function (r) { return r.record; });
  }

  /* ==================================================================
   * Public surface
   * ================================================================== */
  return {
    version: '4.5.0',
    // utils
    normalize: normalize, normName: normName, normPotency: normPotency, normPack: normPack,
    tokens: tokens, editDistance: editDistance, parseDate: parseDate,
    // A search
    searchMedicines: searchMedicines, suggestMedicines: suggestMedicines,
    scoreField: scoreField, DEFAULT_FIELDS: DEFAULT_FIELDS,
    // B variants
    medicineIdentity: medicineIdentity, relatedVariants: relatedVariants,
    // C import
    importPreview: importPreview, autoMap: autoMap, guessField: guessField,
    applyMapping: applyMapping, importableRows: importableRows,
    IMPORT_KNOWN_FIELDS: IMPORT_KNOWN_FIELDS,
    // D order qty
    unitFor: unitFor, pluralize: pluralize, orderLine: orderLine, buildOrderMessage: buildOrderMessage,
    // E weekly
    weekStart: weekStart, weeklyDispensed: weeklyDispensed,
    // F receiving cost
    receivingTotal: receivingTotal, unitCostFromTotal: unitCostFromTotal, formatINR: formatINR,
    // G suppliers / whatsapp
    normalizePhone: normalizePhone, whatsappLink: whatsappLink,
    normalizeSupplier: normalizeSupplier, isValidSupplier: isValidSupplier,
    addSupplier: addSupplier, removeSupplier: removeSupplier
  };
}));
