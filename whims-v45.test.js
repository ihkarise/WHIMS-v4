/*
 * WHIMS v4.5 — regression test suite (pure logic)
 * Run:  node whims-v45.test.js
 * Zero dependencies. Exits non-zero on any failure.
 *
 * Covers the §36 acceptance matrix for all seven feature groups plus the
 * §37 quantity-validation checks that live in pure logic.
 */
'use strict';
const W = require('./whims-v45.js');

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond) {
  if (cond) { pass++; }
  else { fail++; fails.push(name); console.error('  ✗ ' + name); }
}
function eq(name, a, b) { ok(name + ' (got ' + JSON.stringify(a) + ')', JSON.stringify(a) === JSON.stringify(b)); }
function group(title) { console.log('\n• ' + title); }

/* ---------- fixtures ---------- */
const INV = [
  { id: 'HOM001', name: 'ARSENICUM ALBUM', potency: '30', pack: '15 ML', category: 'Homeo', bottles: 4, cost1: 60, supplier1: 'BAKSON', active: 'YES' },
  { id: 'HOM002', name: 'ARSENICUM IODATUM', potency: '30', pack: '15 ML', category: 'Homeo', bottles: 2, cost1: 65, supplier1: 'SBL', active: 'YES' },
  { id: 'HOM003', name: 'BELLADONNA', potency: '30', pack: '15 ML', category: 'Homeo', bottles: 2, cost1: 55, supplier1: 'SBL', active: 'YES' },
  { id: 'HOM004', name: 'BELLADONNA', potency: '30', pack: '30 ML', category: 'Homeo', bottles: 5, cost1: 90, supplier1: 'SBL', active: 'YES' },
  { id: 'HOM005', name: 'BELLADONNA', potency: '200', pack: '30 ML', category: 'Homeo', bottles: 1, cost1: 95, supplier1: 'SBL', active: 'YES' },
  { id: 'HOM006', name: 'BELLADONNA', potency: '1M', pack: '100 ML', category: 'Homeo', bottles: 0, cost1: 120, supplier1: 'SBL', active: 'YES' },
  { id: 'HOM007', name: 'NUX VOMICA', potency: '30', pack: '15 ML', category: 'Homeo', bottles: 3, cost1: 55, supplier1: 'BAKSON', active: 'YES' },
  { id: 'GEN010', name: 'SUNNY HAIR COLOR BLACK', potency: '', pack: '1 PACKET', category: 'General', bottles: 4, cost1: 40, supplier1: 'SUNNY', active: 'YES' },
  { id: 'HOM099', name: 'OLD ARCHIVED REMEDY', potency: '30', pack: '15 ML', category: 'Homeo', bottles: 0, cost1: 0, supplier1: '', active: 'NO' }
];

/* ==================================================================
 * FEATURE A — Smart search
 * ================================================================== */
group('Feature A — smart search');
function names(hits) { return hits.map(h => h.record.name); }

// exact
eq('exact match ranks its item first', names(W.searchMedicines('nux vomica', INV))[0], 'NUX VOMICA');
// lowercase / uppercase
eq('lowercase query works', names(W.searchMedicines('belladonna', INV)).includes('BELLADONNA'), true);
eq('UPPERCASE query works', names(W.searchMedicines('BELLADONNA', INV)).includes('BELLADONNA'), true);
// partial / prefix
ok('prefix "arsen" finds both arsenicums', (() => {
  const n = names(W.searchMedicines('arsen', INV));
  return n.includes('ARSENICUM ALBUM') && n.includes('ARSENICUM IODATUM');
})());
// prefix ranks first
eq('exact ranks above prefix', W.searchMedicines('belladonna', INV)[0].matchType, 'exact');
// typo (single substitution)
eq('typo "belladona" still finds Belladonna', names(W.searchMedicines('belladona', INV)).includes('BELLADONNA'), true);
// missing character
eq('missing char "beladonna" finds Belladonna', names(W.searchMedicines('beladonna', INV)).includes('BELLADONNA'), true);
// extra character
eq('extra char "belladonnna" finds Belladonna', names(W.searchMedicines('belladonnna', INV)).includes('BELLADONNA'), true);
// transposed characters
eq('transposed "belladnona" finds Belladonna', names(W.searchMedicines('belladnona', INV)).includes('BELLADONNA'), true);
// multi-word / token
eq('multi-word "hair black" finds Sunny Hair Color Black', names(W.searchMedicines('hair black', INV)).includes('SUNNY HAIR COLOR BLACK'), true);
// no result
eq('gibberish returns nothing', W.searchMedicines('zzzxqqvv', INV).length, 0);
// empty query
eq('empty query returns nothing', W.searchMedicines('', INV).length, 0);
// id search
eq('id search finds by code', names(W.searchMedicines('HOM007', INV))[0], 'NUX VOMICA');
// activeOnly excludes archived
eq('activeOnly hides archived', names(W.searchMedicines('remedy', INV, { activeOnly: true })).length, 0);
eq('without activeOnly archived is searchable', names(W.searchMedicines('remedy', INV)).includes('OLD ARCHIVED REMEDY'), true);
// ranking: exact score > prefix score
ok('exact scores higher than prefix', (() => {
  const exact = W.searchMedicines('nux vomica', INV)[0].score;
  const pre = W.searchMedicines('nux', INV)[0].score;
  return exact > pre;
})());
// autosuggest dedupes and limits
ok('suggest "bel" returns Belladonna suggestions', W.suggestMedicines('bel', INV).length > 0);
ok('suggest respects limit', W.suggestMedicines('a', INV, { limit: 3 }).length <= 3);

// editDistance sanity
eq('editDistance identical', W.editDistance('abc', 'abc'), 0);
eq('editDistance one sub', W.editDistance('abc', 'abd'), 1);
eq('editDistance transposition costs 2', W.editDistance('ab', 'ba'), 2);

/* ==================================================================
 * FEATURE B — Related variants
 * ================================================================== */
group('Feature B — related variants');
const bella30_15 = INV.find(m => m.id === 'HOM003');
const rv = W.relatedVariants(bella30_15, INV);
// same medicine + same potency + different pack
eq('same potency, other packs = 30 ML variant', rv.samePotencyOtherPacks.map(m => m.pack), ['30 ML']);
// same medicine + different potency
eq('other potencies listed', rv.otherPotencies.map(m => m.potency).sort(), ['1M', '200']);
// stock is NOT merged — each row keeps its own stock
eq('pack variant keeps its own stock', rv.samePotencyOtherPacks[0]._stock, 5);
eq('zero-stock variant present with 0', rv.otherPotencies.find(m => m.potency === '1M')._stock, 0);
// no related variant
const solo = W.relatedVariants(INV.find(m => m.id === 'GEN010'), INV);
eq('no variants for a unique product', solo.samePotencyOtherPacks.length + solo.otherPotencies.length, 0);
// item never lists itself
ok('target not included in its own variants', rv.samePotencyOtherPacks.concat(rv.otherPotencies).every(m => m.id !== 'HOM003'));
// multiple pack variants
const bella30_30 = INV.find(m => m.id === 'HOM004');
eq('belladonna 30/30ML sees the 15ML pack sibling', W.relatedVariants(bella30_30, INV).samePotencyOtherPacks.map(m => m.pack), ['15 ML']);

/* ==================================================================
 * FEATURE C — Import preview
 * ================================================================== */
group('Feature C — import preview');
const importRows = [
  { Medicine: 'ARSENICUM ALBUM', Potency: '30', Pack: '15 ML', Qty: '4', Cost: '60' },   // existing
  { Medicine: 'NEW REMEDY X', Potency: '200', Pack: '10 ML', Qty: '3', Cost: '70' },      // new
  { Medicine: 'NEW REMEDY X', Potency: '200', Pack: '10 ML', Qty: '9', Cost: '70' },      // duplicate of prev in-file
  { Medicine: '', Potency: '30', Pack: '15 ML', Qty: '2', Cost: '30' },                   // invalid (no name)
  { Medicine: 'BAD NUMBERS', Potency: '30', Pack: '15 ML', Qty: 'abc', Cost: '40' }       // invalid (non-numeric qty)
];
const mapping = W.autoMap(Object.keys(importRows[0]));
eq('autoMap detects Medicine→name', mapping.name, 'Medicine');
eq('autoMap detects Qty→bottles', mapping.bottles, 'Qty');
const prev = W.importPreview(importRows, INV, { mapping });
eq('import summary total', prev.summary.total, 5);
eq('import summary new', prev.summary.new, 1);
eq('import summary existing', prev.summary.existing, 1);
eq('import summary duplicates', prev.summary.duplicates, 1);
eq('import summary invalid', prev.summary.invalid, 2);
// preview never mutates inventory
eq('inventory length unchanged after preview', INV.length, 9);
// row classification
eq('row 0 = existing', prev.rows[0].status, 'existing');
eq('existing row carries matchId', prev.rows[0].matchId, 'HOM001');
eq('row 1 = new', prev.rows[1].status, 'new');
eq('row 2 = duplicate', prev.rows[2].status, 'duplicate');
eq('row 3 = invalid (missing name)', prev.rows[3].status, 'invalid');
eq('row 4 = invalid (bad number)', prev.rows[4].status, 'invalid');
// importable rows = only new by default
eq('importableRows default = new only', W.importableRows(prev).length, 1);
eq('importableRows incl. existing', W.importableRows(prev, { includeExisting: true }).length, 2);
// large import performance / correctness
const big = [];
for (let i = 0; i < 1000; i++) big.push({ Medicine: 'BULK MED ' + i, Potency: '30', Pack: '15 ML', Qty: '1', Cost: '10' });
const bigPrev = W.importPreview(big, INV, { mapping });
eq('large import counts 1000 new', bigPrev.summary.new, 1000);
// priority out of range flagged
const pr2 = W.importPreview([{ Medicine: 'X', priority: 9 }], INV, { mapping: { name: 'Medicine', priority: 'priority' } });
eq('priority > 5 is invalid', pr2.rows[0].status, 'invalid');

/* ==================================================================
 * FEATURE D — Order quantity + message
 * ================================================================== */
group('Feature D — order quantity & message');
const hair = INV.find(m => m.id === 'GEN010');
const bottle = INV.find(m => m.id === 'HOM003');
// unit derivation
eq('packet unit from "1 PACKET" pack', W.unitFor(hair), 'packet');
eq('bottle unit from "15 ML" pack', W.unitFor(bottle), 'bottle');
eq('fallback unit is "unit"', W.unitFor({ name: 'MYSTERY', pack: 'XYZ' }), 'unit');
// pluralization respects quantity
eq('qty 1 → singular', W.orderLine(bottle, 1, { hidePack: true }), 'BELLADONNA — 1 bottle');
eq('qty 4 → plural', W.orderLine(bottle, 4, { hidePack: true }), 'BELLADONNA — 4 bottles');
eq('packets plural', W.orderLine(hair, 5, { hidePack: true }), 'SUNNY HAIR COLOR BLACK — 5 packets');
eq('qty 10 line', W.orderLine(hair, 10, { hidePack: true }), 'SUNNY HAIR COLOR BLACK — 10 packets');
// pack shown by default
eq('order line includes pack by default', W.orderLine(bottle, 2), 'BELLADONNA (15 ML) — 2 bottles');
// message assembles quantities
const msg = W.buildOrderMessage([{ med: hair, qty: 5 }, { med: bottle, qty: 2 }]);
ok('message contains hair qty', msg.indexOf('5 packets') >= 0);
ok('message contains bottle qty', msg.indexOf('2 bottles') >= 0);
// received qty independent from ordered qty (concept: orderLine only uses ordered qty)
eq('order message ignores stock/received, uses ordered qty', W.orderLine(bottle, 7, { hidePack: true }), 'BELLADONNA — 7 bottles');

/* ==================================================================
 * FEATURE E — Weekly dispensing
 * ================================================================== */
group('Feature E — weekly dispensing');
// Reference "now": Wednesday 2026-01-14 10:00 local. Week starts Monday 2026-01-12.
const NOW = new Date(2026, 0, 14, 10, 0, 0);
const TX = [
  { action: 'DISPENSE', medicineId: 'HOM003', medicineName: 'BELLADONNA', quantity: 3, dateTime: '2026-01-12 09:00:00' }, // Mon (this week)
  { action: 'DISPENSE', medicineId: 'HOM003', medicineName: 'BELLADONNA', quantity: 5, dateTime: '2026-01-13 09:00:00' }, // Tue (this week)
  { action: 'DISPENSE', medicineId: 'HOM007', medicineName: 'NUX VOMICA', quantity: 6, dateTime: '2026-01-14 08:00:00' }, // Wed (this week)
  { action: 'DISPENSE', medicineId: 'HOM007', medicineName: 'NUX VOMICA', quantity: 4, dateTime: '2026-01-11 08:00:00' }, // Sun (last week)
  { action: 'RECEIVE',  medicineId: 'HOM003', medicineName: 'BELLADONNA', quantity: 10, dateTime: '2026-01-13 07:00:00' }, // not dispense
  { action: 'ADJUSTMENT', medicineId: 'HOM003', medicineName: 'BELLADONNA', quantity: 2, dateTime: '2026-01-13 07:30:00' }, // not dispense
  { action: 'ARCHIVE', medicineId: 'HOM099', medicineName: 'OLD', quantity: 0, dateTime: '2026-01-13 07:30:00' }
];
const wk = W.weeklyDispensed(TX, { now: NOW });
eq('week starts Monday', W.weekStart(NOW).getDate(), 12);
eq('week total counts only this-week dispenses', wk.totalQty, 14);   // 3+5+6
eq('two medicines dispensed this week', wk.items.length, 2);
eq('belladonna weekly qty aggregated', wk.items.find(i => i.id === 'HOM003').qty, 8);
eq('nux weekly qty', wk.items.find(i => i.id === 'HOM007').qty, 6);
eq('top item is belladonna (highest qty)', wk.items[0].id, 'HOM003');
eq('receive/adjustment/archive excluded from events', wk.events, 3);
// last-week dispense excluded
ok('previous-week dispense not counted', wk.items.find(i => i.id === 'HOM007').qty === 6);
// no dispensing
eq('empty tx → zero total', W.weeklyDispensed([], { now: NOW }).totalQty, 0);
eq('empty tx → no items', W.weeklyDispensed([], { now: NOW }).items.length, 0);
// single dispensing
eq('single dispense counted', W.weeklyDispensed([TX[0]], { now: NOW }).totalQty, 3);
// limit
eq('limit trims item list', W.weeklyDispensed(TX, { now: NOW, limit: 1 }).items.length, 1);
// week boundary inclusive at Monday 00:00
const mondayMidnight = { action: 'DISPENSE', medicineId: 'HOM003', medicineName: 'B', quantity: 2, dateTime: '2026-01-12 00:00:00' };
eq('Monday 00:00 is inside the week', W.weeklyDispensed([mondayMidnight], { now: NOW }).totalQty, 2);
// Sunday-start option
eq('Sunday-start week begins 2026-01-11', W.weekStart(NOW, 0).getDate(), 11);

/* ==================================================================
 * FEATURE F — Unit-cost receiving math
 * ================================================================== */
group('Feature F — receiving cost');
eq('1 × ₹100 = ₹100', W.receivingTotal(1, 100).total, 100);
eq('2 × ₹100 = ₹200', W.receivingTotal(2, 100).total, 200);
eq('3 × ₹150 = ₹450', W.receivingTotal(3, 150).total, 450);
eq('5 × ₹125 = ₹625', W.receivingTotal(5, 125).total, 625);
// unit cost preserved exactly (no drift) in the 3rd example
eq('unit cost stays ₹125', W.receivingTotal(5, 125).unitCost, 125);
// decimal safety: 3 × 0.1 must be 0.3, not 0.30000000000000004
eq('float-safe 3 × ₹0.10 = ₹0.30', W.receivingTotal(3, 0.10).total, 0.3);
eq('float-safe 7 × ₹1.15 = ₹8.05', W.receivingTotal(7, 1.15).total, 8.05);
// reverse (legacy) derivation
eq('legacy total→unit: ₹450/3 = ₹150', W.unitCostFromTotal(450, 3), 150);
eq('legacy total→unit divide-by-zero safe', W.unitCostFromTotal(450, 0), 0);
// formatting
eq('formatINR 450 → ₹450.00', W.formatINR(450), '₹450.00');
eq('formatINR indian grouping 125000 → ₹1,25,000.00', W.formatINR(125000), '₹1,25,000.00');
eq('formatINR handles strings', W.formatINR('90'), '₹90.00');

/* ==================================================================
 * FEATURE G — Suppliers & WhatsApp
 * ================================================================== */
group('Feature G — suppliers & WhatsApp');
// phone normalization
eq('bare 10-digit gets +91', W.normalizePhone('9876543210').e164, '+919876543210');
eq('leading 0 stripped then +91', W.normalizePhone('09876543210').e164, '+919876543210');
eq('+91 preserved', W.normalizePhone('+919876543210').e164, '+919876543210');
eq('spaces/dashes ignored', W.normalizePhone('+91 98765-43210').e164, '+919876543210');
eq('empty is invalid', W.normalizePhone('').ok, false);
eq('too short invalid', W.normalizePhone('123').ok, false);
// whatsapp link
ok('whatsapp link built', W.whatsappLink('9876543210', 'hello').indexOf('https://wa.me/919876543210?text=') === 0);
eq('invalid number → null link', W.whatsappLink('12', 'x'), null);
ok('message url-encoded', W.whatsappLink('9876543210', 'a b').indexOf('a%20b') >= 0);
// supplier model
eq('valid supplier accepted', W.isValidSupplier({ name: 'BAKSON', phone: '9876543210' }), true);
eq('nameless supplier rejected', W.isValidSupplier({ phone: '9876543210' }), false);
eq('phoneless supplier rejected', W.isValidSupplier({ name: 'BAKSON' }), false);
// multiple numbers
const sup = W.normalizeSupplier({ name: 'BAKSON', phones: ['9876543210', '08012345678', 'junk'] });
eq('two valid numbers kept, junk dropped', sup.phones.length, 2);
eq('whatsapp defaults to first phone', sup.whatsapp, '+919876543210');
// add/remove immutably, never overwrite
let list = [];
list = W.addSupplier(list, { name: 'BAKSON', phone: '9876543210' });
list = W.addSupplier(list, { name: 'SCHWABE', phone: '9811111111' });
list = W.addSupplier(list, { name: 'NOPE' });        // invalid → ignored
eq('two suppliers added, invalid ignored', list.length, 2);
eq('adding does not overwrite existing', list[0].name, 'BAKSON');
list = W.removeSupplier(list, 0);
eq('remove drops one', list.length, 1);
eq('remaining is SCHWABE', list[0].name, 'SCHWABE');

/* ==================================================================
 * §37 — quantity validation (pure-logic portion)
 * ================================================================== */
group('§37 — quantity validation');
eq('negative order qty coerced to number', typeof W.receivingTotal(-3, 100).total, 'number');
ok('non-numeric qty → 0 total', W.receivingTotal('abc', 100).total === 0);
ok('orderLine with 0 qty is well-formed', W.orderLine(bottle, 0, { hidePack: true }) === 'BELLADONNA — 0 bottles');

/* ---------- summary ---------- */
console.log('\n' + '='.repeat(48));
console.log('WHIMS v4.5 tests:  ' + pass + ' passed, ' + fail + ' failed');
if (fail) { console.log('FAILED: ' + fails.length + ' assertion(s)'); process.exit(1); }
else { console.log('ALL GREEN ✓'); process.exit(0); }
