/* ============================================================================
 * WHIMS Core — v4.2 Foundation (build-before-everything-else)
 * ----------------------------------------------------------------------------
 * Four reusable internal layers, exposed under one namespace:
 *     window.WHIMS.Core = { util, data, Intelligence, Search, Bulk, Plugins }
 *
 *   Layer 1  Intelligence  — business calculations only (no HTML/CSS/UI/AI)
 *   Layer 2  Search        — one reusable search service (instant/partial/fuzzy)
 *   Layer 3  Bulk          — one reusable bulk-operation processor
 *   Layer 4  Plugins       — registration + event bus; modules self-register
 *
 * PURELY ADDITIVE. Loads AFTER app.js. Touches no app file, no backend, no
 * contract. Reads inventory/transactions defensively: window globals first,
 * then the localStorage cache app.js already maintains (whims_inv/tx/intake),
 * so it works whether or not the app exposes its globals on window.
 *
 * Node-safe: never touches document/localStorage at load; exports via
 * module.exports so the QA harness can require() it without a DOM.
 * ========================================================================== */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) {
    root.WHIMS = root.WHIMS || {};
    root.WHIMS.Core = api;
    root.WHIMSCore = api; // short alias
  }
})(typeof window !== 'undefined' ? window
   : (typeof globalThis !== 'undefined' ? globalThis : this),
function () {
  'use strict';

  var DAY = 86400000;
  var WEEK_PER_MONTH = 4.345;

  /* ======================================================================
   * util — small shared helpers (no side effects)
   * ==================================================================== */
  var util = {
    num: function (v) { var n = Number(v); return isNaN(n) ? 0 : n; },
    str: function (v) { return v === null || v === undefined ? '' : String(v); },
    round: function (n, p) { var f = Math.pow(10, p || 0); return Math.round((Number(n) || 0) * f) / f; },
    clamp: function (n, lo, hi) { return Math.max(lo, Math.min(hi, n)); },

    /** Tolerant date parser for the mixed formats found in the sheet.
     *  Handles: ISO (yyyy-MM-dd[ HH:mm:ss]), yyyy/MM, MM/yyyy, dd-MM-yyyy,
     *  dd/MM/yyyy, "MMM yyyy", bare yyyy. Returns a Date or null.
     *  Month-only values resolve to the LAST day of that month (expiry-safe). */
    parseDate: function (v) {
      if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
      var s = util.str(v).trim();
      if (!s) return null;
      var m;
      // ISO datetime / date
      m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
      if (m) return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
      // yyyy-MM or yyyy/MM  (month → end of month)
      m = s.match(/^(\d{4})[\/\-](\d{1,2})$/);
      if (m) return endOfMonth(+m[1], +m[2] - 1);
      // MM/yyyy or MM-yyyy  (month → end of month)
      m = s.match(/^(\d{1,2})[\/\-](\d{4})$/);
      if (m) return endOfMonth(+m[2], +m[1] - 1);
      // dd/MM/yyyy or dd-MM-yyyy
      m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
      if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
      // "MMM yyyy" / "MMMM yyyy"
      m = s.match(/^([A-Za-z]{3,})[ \-](\d{4})$/);
      if (m) {
        var mi = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
        if (mi >= 0) return endOfMonth(+m[2], mi);
      }
      // bare yyyy
      m = s.match(/^(\d{4})$/);
      if (m) return new Date(+m[1], 11, 31);
      var d = new Date(s);
      return isNaN(d.getTime()) ? null : d;
    },

    daysBetween: function (a, b) {
      var da = util.parseDate(a), db = util.parseDate(b);
      if (!da || !db) return null;
      return Math.round((db.getTime() - da.getTime()) / DAY);
    },

    monthKey: function (v) {
      var d = util.parseDate(v); if (!d) return '';
      return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2);
    }
  };

  var MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  function endOfMonth(y, mIdx) { return new Date(y, mIdx + 1, 0, 23, 59, 59); }

  /** Mirrors app.js statusOf() exactly so every layer agrees with the UI. */
  function statusOf(m) {
    if (util.str(m.active).toUpperCase() === 'NO') return 'ARCHIVED';
    var b = m.bottles;
    if (b === '' || b === null || b === undefined) return '';
    b = Number(b);
    if (b === 0) return 'OUT OF STOCK';
    if (b === 1) return 'LOW STOCK';
    if (b <= 5) return 'GOOD';
    return 'OVERSTOCK';
  }
  util.statusOf = statusOf;

  /* ======================================================================
   * data — single shared accessor (window global → localStorage cache)
   * ==================================================================== */
  var data = (function () {
    function lsArray(key) {
      try {
        if (typeof localStorage === 'undefined') return null;
        var raw = localStorage.getItem('whims_' + key);
        if (raw == null) return null;
        var v = JSON.parse(raw);
        return Array.isArray(v) ? v : null;
      } catch (e) { return null; }
    }
    function pick(globalName, lsKey) {
      var g = (typeof window !== 'undefined') ? window[globalName] : undefined;
      if (Array.isArray(g)) return g;
      var c = lsArray(lsKey);
      return c || [];
    }
    return {
      inventory: function () { return pick('INV', 'inv'); },
      transactions: function () { return pick('TX', 'tx'); },
      intake: function () { return pick('INTAKE', 'intake'); }
    };
  })();

  /* ======================================================================
   * Layer 1 — Intelligence (pure calculations; each accepts explicit data,
   *           defaulting to the shared accessor so callers can stay terse)
   * ==================================================================== */
  function activeOnly(inv) { return inv.filter(function (m) { return util.str(m.active).toUpperCase() !== 'NO'; }); }
  function now(opts) { return (opts && opts.now != null) ? +new Date(opts.now) : Date.now(); }
  function windowDays(opts) { return (opts && opts.windowDays) || 90; }

  function calculateStockHealth(inv) {
    inv = inv || data.inventory();
    var act = activeOnly(inv);
    var c = { active: act.length, outOfStock: 0, lowStock: 0, good: 0, overstock: 0, unknown: 0,
              archived: inv.length - act.length, needPurchase: 0 };
    act.forEach(function (m) {
      var s = statusOf(m);
      if (s === 'OUT OF STOCK') c.outOfStock++;
      else if (s === 'LOW STOCK') c.lowStock++;
      else if (s === 'GOOD') c.good++;
      else if (s === 'OVERSTOCK') c.overstock++;
      else c.unknown++;
      if (util.num(m.priority) > 0) c.needPurchase++;
    });
    c.inStock = c.good + c.overstock;
    return c;
  }

  function calculateInventoryValue(inv) {
    inv = inv || data.inventory();
    var total = 0, valued = 0;
    activeOnly(inv).forEach(function (m) {
      var v = util.num(m.bottles) * util.num(m.cost1);
      if (v > 0) { total += v; valued++; }
    });
    return { value: util.round(total, 2), valuedItems: valued };
  }

  /** Per-medicine dispensed quantity within the window (DISPENSE transactions). */
  function calculateConsumptionAnalytics(tx, opts) {
    tx = tx || data.transactions(); opts = opts || {};
    var cutoff = now(opts) - windowDays(opts) * DAY;
    var byMed = {};
    var totalQty = 0, count = 0;
    tx.forEach(function (t) {
      if (util.str(t.action).toUpperCase() !== 'DISPENSE') return;
      var d = util.parseDate(t.dateTime);
      if (d && d.getTime() < cutoff) return;
      var id = util.str(t.medicineId);
      var q = util.num(t.quantity);
      if (!byMed[id]) byMed[id] = { id: id, name: util.str(t.medicineName), qty: 0, events: 0, last: null };
      byMed[id].qty += q; byMed[id].events++;
      if (d && (!byMed[id].last || d > byMed[id].last)) byMed[id].last = d;
      totalQty += q; count++;
    });
    var weeks = windowDays(opts) / 7;
    Object.keys(byMed).forEach(function (id) {
      byMed[id].avgWeekly = util.round(byMed[id].qty / weeks, 2);
      byMed[id].avgMonthly = util.round(byMed[id].avgWeekly * WEEK_PER_MONTH, 2);
    });
    return { windowDays: windowDays(opts), totalQty: totalQty, events: count, byMed: byMed };
  }

  /** Reorder forecast inputs per active medicine. */
  function calculateForecastInputs(inv, tx, opts) {
    inv = inv || data.inventory(); tx = tx || data.transactions(); opts = opts || {};
    var leadDays = opts.leadDays || 7;
    var coverWeeks = opts.coverWeeks || 4;
    var wd = windowDays(opts);
    var cons = calculateConsumptionAnalytics(tx, opts).byMed;
    var nowMs = now(opts);
    return activeOnly(inv).map(function (m) {
      var id = util.str(m.id);
      var used = cons[id] ? cons[id].qty : 0;
      var stock = util.num(m.bottles);
      var dailyUse = used / wd;
      var daysRemaining = dailyUse > 0 ? stock / dailyUse : Infinity;
      var avgWeekly = (used / wd) * 7;
      var stockOut = isFinite(daysRemaining) ? new Date(nowMs + daysRemaining * DAY) : null;
      var reorder = stockOut ? new Date(stockOut.getTime() - leadDays * DAY) : null;
      var recommendedQty = Math.max(0, Math.ceil(avgWeekly * coverWeeks) - stock);
      return {
        id: id, name: util.str(m.name), currentStock: stock,
        avgWeeklyUsage: util.round(avgWeekly, 2),
        avgMonthlyUsage: util.round(avgWeekly * WEEK_PER_MONTH, 2),
        daysRemaining: isFinite(daysRemaining) ? Math.floor(daysRemaining) : null,
        estimatedStockOut: stockOut ? iso(stockOut) : null,
        recommendedReorderDate: reorder ? iso(reorder) : null,
        recommendedQty: recommendedQty,
        priority: util.num(m.priority)
      };
    });
  }
  function iso(d) { return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }

  /** Active meds with stock that have not moved within deadDays (or never). */
  function calculateDeadStock(inv, tx, opts) {
    inv = inv || data.inventory(); tx = tx || data.transactions(); opts = opts || {};
    var deadDays = opts.deadDays || 90;
    var cutoff = now(opts) - deadDays * DAY;
    var lastByMed = {};
    tx.forEach(function (t) {
      if (util.str(t.action).toUpperCase() !== 'DISPENSE') return;
      var d = util.parseDate(t.dateTime); if (!d) return;
      var id = util.str(t.medicineId);
      if (!lastByMed[id] || d > lastByMed[id]) lastByMed[id] = d;
    });
    var out = [];
    activeOnly(inv).forEach(function (m) {
      if (util.num(m.bottles) <= 0) return;
      var last = lastByMed[util.str(m.id)] || null;
      if (!last || last.getTime() < cutoff) {
        out.push({ id: util.str(m.id), name: util.str(m.name), bottles: util.num(m.bottles),
                   value: util.round(util.num(m.bottles) * util.num(m.cost1), 2),
                   lastDispense: last ? iso(last) : null });
      }
    });
    out.sort(function (a, b) { return b.value - a.value; });
    return out;
  }

  /** Fast / slow / dead movement buckets. */
  function classifyMovement(inv, tx, opts) {
    inv = inv || data.inventory(); tx = tx || data.transactions(); opts = opts || {};
    var cons = calculateConsumptionAnalytics(tx, opts).byMed;
    var rows = activeOnly(inv).map(function (m) {
      return { id: util.str(m.id), name: util.str(m.name), bottles: util.num(m.bottles),
               qty: cons[util.str(m.id)] ? cons[util.str(m.id)].qty : 0,
               value: util.round(util.num(m.bottles) * util.num(m.cost1), 2) };
    });
    var moving = rows.filter(function (r) { return r.qty > 0; }).sort(function (a, b) { return b.qty - a.qty; });
    var dead = rows.filter(function (r) { return r.qty === 0 && r.bottles > 0; });
    var cut = Math.ceil(moving.length / 4) || 0;
    return { fast: moving.slice(0, cut), slow: moving.slice(Math.max(cut, moving.length - cut)), dead: dead, moving: moving.length };
  }

  function calculateSupplierAnalytics(inv) {
    inv = inv || data.inventory();
    var by = {};
    activeOnly(inv).forEach(function (m) {
      var s = util.str(m.supplier1).trim() || 'Unassigned';
      if (!by[s]) by[s] = { supplier: s, medicines: 0, bottles: 0, value: 0, costSum: 0, costCount: 0 };
      by[s].medicines++; by[s].bottles += util.num(m.bottles);
      by[s].value += util.num(m.bottles) * util.num(m.cost1);
      if (util.num(m.cost1) > 0) { by[s].costSum += util.num(m.cost1); by[s].costCount++; }
    });
    return Object.keys(by).map(function (k) {
      by[k].value = util.round(by[k].value, 2);
      by[k].avgCost = by[k].costCount ? util.round(by[k].costSum / by[k].costCount, 2) : 0;
      delete by[k].costSum; delete by[k].costCount;
      return by[k];
    }).sort(function (a, b) { return b.value - a.value; });
  }

  /** Same-medicine cost comparison across its two listed suppliers, plus a
   *  cheapest-on-average supplier ranking (reuses calculateSupplierAnalytics —
   *  no duplicated calculation logic). */
  function calculateSupplierCostComparison(inv) {
    inv = inv || data.inventory();
    var dualSourced = [];
    activeOnly(inv).forEach(function (m) {
      var s1 = util.str(m.supplier1).trim(), s2 = util.str(m.supplier2).trim();
      var c1 = util.num(m.cost1), c2 = util.num(m.cost2);
      if (!s1 || !s2 || c1 <= 0 || c2 <= 0) return;
      if (s1.toUpperCase() === s2.toUpperCase()) return;   // same supplier listed twice — not a real comparison
      var cheaper = c1 < c2 ? 'supplier1' : (c2 < c1 ? 'supplier2' : 'tie');
      var savings = util.round(Math.abs(c1 - c2), 2);
      var savingsPct = util.round(savings / Math.max(c1, c2) * 100, 1);
      dualSourced.push({ id: util.str(m.id), name: util.str(m.name),
        supplier1: s1, cost1: c1, supplier2: s2, cost2: c2,
        cheaper: cheaper, savings: savings, savingsPct: savingsPct });
    });
    var bySupplierAvg = calculateSupplierAnalytics(inv)
      .filter(function (s) { return s.avgCost > 0; })
      .map(function (s) { return { supplier: s.supplier, avgCost: s.avgCost, medicines: s.medicines }; })
      .sort(function (a, b) { return a.avgCost - b.avgCost; });
    return { dualSourced: dualSourced, bySupplierAvg: bySupplierAvg };
  }

  /** Capital tied up in stock, stratified by movement risk (reuses classifyMovement
   *  and calculateInventoryValue — no duplicated calculation logic). Distinct from
   *  plain Inventory Value: shows WHERE the money is sitting, not just the total. */
  function calculateInventoryInvestment(inv, tx, opts) {
    inv = inv || data.inventory(); tx = tx || data.transactions(); opts = opts || {};
    var totalValue = calculateInventoryValue(inv).value;
    var mv = classifyMovement(inv, tx, opts);
    var sumVal = function (arr) { return util.round(arr.reduce(function (s, r) { return s + (r.value || 0); }, 0), 2); };
    var fastValue = sumVal(mv.fast), slowValue = sumVal(mv.slow), deadValue = sumVal(mv.dead);
    var otherValue = util.round(totalValue - fastValue - slowValue - deadValue, 2);
    return { totalValue: totalValue, fastMovingValue: fastValue, slowMovingValue: slowValue,
             deadStockValue: deadValue, otherValue: otherValue, windowDays: windowDays(opts) };
  }

  /** Purchase spend from RECEIVE transactions. */
  function calculatePurchaseAnalytics(tx, opts) {
    tx = tx || data.transactions(); opts = opts || {};
    var cutoff = (opts && opts.windowDays) ? now(opts) - windowDays(opts) * DAY : -Infinity;
    var total = 0, count = 0, byMonth = {};
    tx.forEach(function (t) {
      if (util.str(t.action).toUpperCase() !== 'RECEIVE') return;
      var d = util.parseDate(t.dateTime);
      if (d && d.getTime() < cutoff) return;
      var amt = util.num(t.amount);
      total += amt; count++;
      var mk = util.monthKey(t.dateTime);
      if (mk) byMonth[mk] = util.round((byMonth[mk] || 0) + amt, 2);
    });
    return { totalSpend: util.round(total, 2), receipts: count,
             avgPerReceipt: count ? util.round(total / count, 2) : 0, byMonth: byMonth };
  }

  function calculateExpiryAnalytics(inv, opts) {
    inv = inv || data.inventory(); opts = opts || {};
    var nowMs = now(opts);
    var buckets = { expired: [], d30: [], d90: [], d180: [], ok: [], noDate: [] };
    activeOnly(inv).forEach(function (m) {
      var d = util.parseDate(m.expiry);
      var row = { id: util.str(m.id), name: util.str(m.name), expiry: util.str(m.expiry),
                  bottles: util.num(m.bottles), daysLeft: null };
      if (!d) { buckets.noDate.push(row); return; }
      var dl = Math.floor((d.getTime() - nowMs) / DAY);
      row.daysLeft = dl;
      if (dl < 0) buckets.expired.push(row);
      else if (dl <= 30) buckets.d30.push(row);
      else if (dl <= 90) buckets.d90.push(row);
      else if (dl <= 180) buckets.d180.push(row);
      else buckets.ok.push(row);
    });
    return {
      counts: { expired: buckets.expired.length, d30: buckets.d30.length, d90: buckets.d90.length,
                d180: buckets.d180.length, ok: buckets.ok.length, noDate: buckets.noDate.length },
      buckets: buckets
    };
  }

  /** Units-based turnover, annualised from the window. */
  function calculateInventoryTurnover(inv, tx, opts) {
    inv = inv || data.inventory(); tx = tx || data.transactions(); opts = opts || {};
    var dispensed = calculateConsumptionAnalytics(tx, opts).totalQty;
    var units = 0;
    activeOnly(inv).forEach(function (m) { units += util.num(m.bottles); });
    var annual = dispensed * (365 / windowDays(opts));
    return { dispensedUnits: dispensed, inventoryUnits: units,
             turnover: units > 0 ? util.round(annual / units, 2) : 0,
             windowDays: windowDays(opts) };
  }

  function calculateDashboardMetrics(inv, tx, opts) {
    inv = inv || data.inventory(); tx = tx || data.transactions(); opts = opts || {};
    var health = calculateStockHealth(inv);
    var value = calculateInventoryValue(inv);
    var expiry = calculateExpiryAnalytics(inv, opts);
    var dead = calculateDeadStock(inv, tx, opts);
    return {
      generatedAt: new Date(now(opts)).toISOString(),
      total: health.active, statusCounts: health,
      needPurchase: health.needPurchase,
      inventoryValue: value.value,
      expiringSoon: expiry.counts.expired + expiry.counts.d30,
      expired: expiry.counts.expired,
      deadStock: dead.length
    };
  }

  /** One bundle of everything — also the Phase-8 AI export object. */
  function exportAnalyticsSnapshot(inv, tx, opts) {
    inv = inv || data.inventory(); tx = tx || data.transactions(); opts = opts || {};
    return {
      generatedAt: new Date(now(opts)).toISOString(),
      windowDays: windowDays(opts),
      inventory: { count: inv.length, active: activeOnly(inv).length },
      value: calculateInventoryValue(inv),
      stockHealth: calculateStockHealth(inv),
      turnover: calculateInventoryTurnover(inv, tx, opts),
      suppliers: calculateSupplierAnalytics(inv),
      supplierCostComparison: calculateSupplierCostComparison(inv),
      purchases: calculatePurchaseAnalytics(tx, opts),
      consumption: calculateConsumptionAnalytics(tx, opts),
      deadStock: calculateDeadStock(inv, tx, opts),
      movement: classifyMovement(inv, tx, opts),
      investment: calculateInventoryInvestment(inv, tx, opts),
      expiry: calculateExpiryAnalytics(inv, opts),
      forecast: calculateForecastInputs(inv, tx, opts),
      dashboard: calculateDashboardMetrics(inv, tx, opts)
    };
  }

  var Intelligence = {
    statusOf: statusOf,
    calculateStockHealth: calculateStockHealth,
    calculateInventoryValue: calculateInventoryValue,
    calculateInventoryTurnover: calculateInventoryTurnover,
    calculateSupplierAnalytics: calculateSupplierAnalytics,
    calculateSupplierCostComparison: calculateSupplierCostComparison,
    calculatePurchaseAnalytics: calculatePurchaseAnalytics,
    calculateConsumptionAnalytics: calculateConsumptionAnalytics,
    calculateDeadStock: calculateDeadStock,
    classifyMovement: classifyMovement,
    calculateInventoryInvestment: calculateInventoryInvestment,
    calculateExpiryAnalytics: calculateExpiryAnalytics,
    calculateForecastInputs: calculateForecastInputs,
    calculateDashboardMetrics: calculateDashboardMetrics,
    exportAnalyticsSnapshot: exportAnalyticsSnapshot
  };

  /* ======================================================================
   * Layer 2 — Search (one reusable service; instant/partial/fuzzy)
   * ==================================================================== */
  var Search = (function () {
    var DEFAULT_FIELDS = ['id', 'name', 'category', 'potency', 'pack', 'barcode', 'supplier1', 'supplier2'];
    var STRONG = { id: 1.25, name: 1.2, barcode: 1.25 };

    function norm(s) { return util.str(s).toLowerCase().replace(/\s+/g, ' ').trim(); }

    /** subsequence score: are all chars of q present in v, in order? 0..40. */
    function subseq(q, v) {
      if (!q) return 0;
      var i = 0, j = 0, first = -1, last = -1;
      while (i < q.length && j < v.length) {
        if (q[i] === v[j]) { if (first < 0) first = j; last = j; i++; }
        j++;
      }
      if (i < q.length) return 0;                 // not a subsequence
      var span = (last - first + 1) || 1;
      var compact = q.length / span;              // 1 = contiguous
      return Math.round(20 + 20 * compact);       // 20..40
    }

    function fieldScore(q, val) {
      var v = norm(val); if (!v) return 0;
      if (v === q) return 100;
      if (v.indexOf(q) === 0) return 80;
      var idx = v.indexOf(q);
      if (idx > 0) return 60 - Math.min(idx, 20);
      return subseq(q, v);
    }

    function scoreRecord(q, rec, fields) {
      var best = 0;
      for (var i = 0; i < fields.length; i++) {
        var f = fields[i];
        var s = fieldScore(q, rec[f]) * (STRONG[f] || 1);
        if (s > best) best = s;
      }
      return best;
    }

    function search(query, records, opts) {
      opts = opts || {};
      var fields = opts.fields || DEFAULT_FIELDS;
      var limit = opts.limit || 50;
      var threshold = opts.threshold != null ? opts.threshold : 1;
      var q = norm(query);
      if (!q) return [];
      var scored = [];
      for (var i = 0; i < records.length; i++) {
        var sc = scoreRecord(q, records[i], fields);
        if (sc >= threshold) scored.push({ record: records[i], score: sc });
      }
      scored.sort(function (a, b) { return b.score - a.score; });
      var top = scored.slice(0, limit);
      return opts.withScores ? top : top.map(function (x) { return x.record; });
    }

    /** Pre-bound index for a record set; every module can build one. */
    function createIndex(records, fields) {
      var f = fields || DEFAULT_FIELDS;
      return {
        records: records, fields: f,
        search: function (query, opts) {
          opts = opts || {}; if (!opts.fields) opts.fields = f;
          return search(query, records, opts);
        }
      };
    }

    /* ---- Phase 4: duplicate detection — reusable multi-field matching ----
       Domain rule: in this catalog, the SAME medicine at a DIFFERENT potency
       is a legitimate separate item (homeopathy stock is potency-specific),
       so name alone never scores high enough to flag; name+potency must
       agree before a candidate is treated as a likely duplicate. */
    function dupNorm(s){ return String(s==null?'':s).trim().toUpperCase(); }
    function dupNormPack(s){ return dupNorm(s).replace(/\s+/g,''); }
    function dupBarcodes(s){ return dupNorm(s).split(/[,;\s]+/).filter(Boolean); }

    function scoreDuplicate(record, c){
      const rid = dupNorm(record.id || record.code), cid = dupNorm(c.id);
      if (rid && cid && rid === cid) return { score:100, reasons:['code'] };
      const rbc = dupBarcodes(record.barcode), cbc = dupBarcodes(c.barcode);
      if (rbc.length && cbc.some(b => rbc.includes(b))) return { score:100, reasons:['barcode'] };

      const rname = dupNorm(record.name), cname = dupNorm(c.name);
      const nameMatch = !!(rname && cname && rname === cname);
      const rpot = dupNorm(record.potency), cpot = dupNorm(c.potency);
      const potMatch = !!(rpot && cpot && rpot === cpot);
      const potMismatch = !!(rpot && cpot && rpot !== cpot);   // both known and explicitly different
      const rpack = dupNormPack(record.pack), packMatch = !!(rpack && dupNormPack(c.pack) === rpack);

      let score = 0, reasons = [];
      if (nameMatch && potMatch && packMatch){ score = 90; reasons = ['name','potency','pack']; }
      else if (nameMatch && potMatch){ score = 55; reasons = ['name','potency']; }
      else if (nameMatch && packMatch){ score = 35; reasons = ['name','pack']; }   // diff potency → likely NOT a duplicate
      else if (nameMatch){ score = 15; reasons = ['name']; }                       // name alone → not a duplicate signal
      // An explicit potency disagreement caps the score here — it's strong evidence
      // of a genuinely different SKU, so coincidental category/supplier matches
      // must not be allowed to push it back over the threshold.
      if (score > 0 && !potMismatch){
        const rcat = dupNorm(record.category);
        if (rcat && dupNorm(c.category) === rcat){ score += 5; reasons.push('category'); }
        const rsup = dupNorm(record.supplier);
        if (rsup && dupNorm(c.supplier) === rsup){ score += 5; reasons.push('supplier'); }
      }
      return { score, reasons };
    }

    /** Compare a staged/edited record against active inventory; ranked candidates above threshold.
     *  opts.excludeId — skip a specific candidate (e.g. the medicine the reviewer already chose to
     *  receive into — that's an intentional match, not a "duplicate" warning). */
    function findDuplicates(record, candidates, opts){
      opts = opts || {};
      const limit = opts.limit || 5;
      const threshold = opts.threshold != null ? opts.threshold : 45;
      const exclude = opts.excludeId ? dupNorm(opts.excludeId) : '';
      const out = [];
      (candidates||[]).forEach(c => {
        if (exclude && dupNorm(c.id) === exclude) return;
        const { score, reasons } = scoreDuplicate(record, c);
        if (score >= threshold) out.push({ id:c.id, name:c.name, score:Math.min(score,100), reasons, candidate:c });
      });
      out.sort((a,b) => b.score - a.score);
      return out.slice(0, limit);
    }

    return { search: search, createIndex: createIndex, fieldScore: fieldScore, DEFAULT_FIELDS: DEFAULT_FIELDS,
      findDuplicates: findDuplicates };
  })();

  /* ======================================================================
   * Layer 3 — Bulk (one reusable processor; future modules plug handlers in)
   * ==================================================================== */
  var Bulk = (function () {
    var registry = {};

    /** run(items, handler, opts) → {total,done,failed,errors,results}
     *  handler(item, index) may be async. Sequential by default (safe for the
     *  Apps Script lock); set opts.concurrency>1 for parallel batches. */
    function run(items, handler, opts) {
      opts = opts || {};
      items = items || [];
      var concurrency = Math.max(1, opts.concurrency || 1);
      var stopOnError = !!opts.stopOnError;
      var onProgress = opts.onProgress;
      var summary = { total: items.length, done: 0, failed: 0, errors: [], results: [] };
      var idx = 0, stopped = false;

      function step() {
        if (stopped || idx >= items.length) return Promise.resolve();
        var i = idx++;
        return Promise.resolve()
          .then(function () { return handler(items[i], i); })
          .then(function (res) { summary.done++; summary.results[i] = res; })
          .catch(function (err) {
            summary.failed++;
            summary.errors.push({ index: i, item: items[i], error: (err && err.message) || String(err) });
            if (stopOnError) stopped = true;
          })
          .then(function () {
            if (onProgress) { try { onProgress(summary.done + summary.failed, summary.total, summary); } catch (e) {} }
            return step();
          });
      }
      var lanes = [];
      for (var c = 0; c < concurrency; c++) lanes.push(step());
      return Promise.all(lanes).then(function () { return summary; });
    }

    function register(name, handler) { registry[String(name).toLowerCase()] = handler; return Bulk; }
    function get(name) { return registry[String(name).toLowerCase()] || null; }
    function has(name) { return !!registry[String(name).toLowerCase()]; }
    function runNamed(name, items, opts) {
      var h = get(name);
      if (!h) return Promise.reject(new Error('No bulk operation registered: ' + name));
      return run(items, h, opts);
    }
    function list() { return Object.keys(registry); }

    return { run: run, register: register, get: get, has: has, runNamed: runNamed, list: list };
  })();

  /* ======================================================================
   * Layer 4 — Plugins (registration + event bus; no core edits to extend)
   * ==================================================================== */
  var Plugins = (function () {
    var plugins = {};
    var listeners = {};

    function register(plugin) {
      if (!plugin || !plugin.name) throw new Error('Plugin needs a name');
      var key = String(plugin.name).toLowerCase();
      if (plugins[key]) return plugins[key]; // idempotent — never double-register
      plugins[key] = plugin;
      if (typeof plugin.init === 'function') { try { plugin.init(publicApi); } catch (e) {} }
      emit('plugin:registered', plugin);
      return plugin;
    }
    function get(name) { return plugins[String(name).toLowerCase()] || null; }
    function has(name) { return !!plugins[String(name).toLowerCase()]; }
    function all() { return Object.keys(plugins).map(function (k) { return plugins[k]; }); }

    function on(event, fn) { (listeners[event] = listeners[event] || []).push(fn); return function off() { offFn(event, fn); }; }
    function offFn(event, fn) {
      if (!listeners[event]) return;
      listeners[event] = listeners[event].filter(function (f) { return f !== fn; });
    }
    function emit(event, payload) {
      (listeners[event] || []).slice().forEach(function (fn) { try { fn(payload); } catch (e) {} });
      // wildcard hook for plugins implementing onEvent(event,payload)
      all().forEach(function (p) {
        var camel = 'on' + event.replace(/(^|[:_-])(\w)/g, function (_, __, c) { return c.toUpperCase(); });
        if (typeof p[camel] === 'function') { try { p[camel](payload); } catch (e) {} }
      });
    }
    return { register: register, get: get, has: has, all: all, on: on, off: offFn, emit: emit };
  })();

  /* ======================================================================
   * public surface
   * ==================================================================== */
  var publicApi = {
    version: '4.2.0',
    util: util, data: data,
    Intelligence: Intelligence, Search: Search, Bulk: Bulk, Plugins: Plugins
  };
  return publicApi;
});
