/*
 * WHIMS v4.5 — integration smoke test (optional, needs jsdom)
 * ------------------------------------------------------------------
 * Loads index.html and every app script in order into a jsdom window,
 * seeds inventory/transactions, and asserts that the additive v4.5
 * wrappers light up each feature on top of the existing app.
 *
 * Run:  npm i jsdom   (once, anywhere)   then   node whims-v45.integration.test.js
 * Skips gracefully (exit 0) if jsdom is not installed.
 */
'use strict';
const fs = require('fs');
const path = require('path');

let JSDOM;
try { ({ JSDOM } = require('jsdom')); }
catch (e) { console.log('jsdom not installed — skipping integration test (run `npm i jsdom` to enable).'); process.exit(0); }

const DIR = __dirname + path.sep;
const dom = new JSDOM(fs.readFileSync(DIR + 'index.html', 'utf8'),
  { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://example.com/' });
const { window } = dom;
window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
window.scrollTo = () => {};
window.AudioContext = function () { return { createOscillator: () => ({ connect() {}, start() {}, stop() {}, frequency: { setValueAtTime() {} } }), createGain: () => ({ connect() {}, gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} } }), currentTime: 0, destination: {} }; };
const storage = {};
Object.defineProperty(window, 'localStorage', { value: { getItem: k => (k in storage ? storage[k] : null), setItem: (k, v) => { storage[k] = String(v); }, removeItem: k => { delete storage[k]; } }, configurable: true });
window.fetch = () => Promise.reject(new Error('no network'));
window.confirm = () => true;
window.requestAnimationFrame = cb => setTimeout(cb, 0);

const SCRIPTS = ['whims-v45.js', 'app.js', 'whims-core.js', 'whims-v41.js', 'whims-source.js',
  'whims-dashboard.js', 'source-analytics-fix.js', 'whims-workflow.js', 'whims-orders.js',
  'whims-intake.js', 'whims-ai.js', 'whims-v45-ui.js'];
const vm = require('vm');
const ctx = dom.getInternalVMContext();
SCRIPTS.forEach(f => {
  try { vm.runInContext(fs.readFileSync(DIR + f, 'utf8'), ctx, { filename: f }); }
  catch (e) { console.error('LOAD ERROR in ' + f + ': ' + e.message); process.exitCode = 1; }
});

const INV = [
  { id: 'HOM003', name: 'BELLADONNA', potency: '30', pack: '15 ML', bottles: 2, cost1: 55, supplier1: 'SBL', active: 'YES' },
  { id: 'HOM004', name: 'BELLADONNA', potency: '30', pack: '30 ML', bottles: 5, cost1: 90, supplier1: 'SBL', active: 'YES' },
  { id: 'HOM005', name: 'BELLADONNA', potency: '200', pack: '30 ML', bottles: 1, cost1: 95, supplier1: 'SBL', active: 'YES' },
  { id: 'GEN010', name: 'SUNNY HAIR COLOR BLACK', potency: '', pack: '1 PACKET', bottles: 4, cost1: 40, supplier1: 'SUNNY', active: 'YES' }
];
window.INV = INV;
window.TX = [{ action: 'DISPENSE', medicineId: 'HOM003', medicineName: 'BELLADONNA', quantity: 8, dateTime: new Date().toISOString().slice(0, 10) + ' 09:00:00' }];

let pass = 0, fail = 0;
function check(name, cond) { if (cond) pass++; else { fail++; console.error('  FAIL ' + name); } }

try { window.document.dispatchEvent(new window.Event('DOMContentLoaded')); } catch (e) {}
setTimeout(() => {
  const d = window.document;
  check('WHIMS45 lib present', !!window.WHIMS45);
  check('WHIMSv45UI present', !!window.WHIMSv45UI);
  check('A fuzzy suggest', window.WHIMS45.suggestMedicines('belad', INV)[0].record.name === 'BELLADONNA');
  window.renderDash();
  check('E weekly panel', /Dispensed This Week/.test((d.getElementById('v45Weekly') || {}).textContent || ''));
  window.openDetail(INV[0]);
  const ex = d.getElementById('v45DetailExtra');
  check('B variants block', ex && /Other pack sizes/.test(ex.textContent) && /Other potencies/.test(ex.textContent));
  check('G suppliers block', ex && /Suppliers/.test(ex.textContent));
  const q = d.getElementById('q'); q.value = 'belladona'; window.renderResults();
  check('A fuzzy fallback on typo', /BELLADONNA/.test(d.getElementById('results').textContent));
  const b = d.getElementById('rBottles'), u = d.getElementById('rUnitCost'), t = d.getElementById('rTotalCalc');
  b.value = '3'; u.value = '150'; u.dispatchEvent(new window.Event('input'));
  check('F receive total ₹450.00', t.textContent === '₹450.00');
  const p = window.WHIMSv45UI.parseDelimited('Medicine,Potency,Pack,Qty\nARNICA,30,15 ML,4\n"BIG, NAME",200,30 ML,2');
  check('C CSV quoted comma', p.rows[1].Medicine === 'BIG, NAME');

  console.log('\nWHIMS v4.5 integration: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}, 60);
