#!/usr/bin/env node
/*
 * LOCAL validation harness (NOT the live backend).
 * Runs the REAL consolidated Code.gs inside a vm with an in-memory Apps Script
 * + Sheets model, exposed over HTTP so qa/live-api-qa.mjs can be validated
 * end-to-end locally before running it against a real TEST /exec URL.
 *
 *   node qa/local-mock-server.mjs 8787   # then, in another shell:
 *   WHIMS_EXEC_URL=http://127.0.0.1:8787 node qa/live-api-qa.mjs
 *
 * This proves the QA runner and the backend agree over real HTTP. It is a
 * developer validation aid — it is NOT Apps Script and NOT a live deployment.
 */
import http from 'node:http';
import vm from 'node:vm';
import fs from 'node:fs';

const PORT = Number(process.argv[2] || process.env.PORT || 8787);
const ROOT = new URL('..', import.meta.url).pathname;

/* ---------- in-memory Sheets model (mirrors whims-backend.test.js) ---------- */
function makeSheet(name, rows) {
  const data = rows ? rows.map(r => r.slice()) : [];
  let maxCols = data.reduce((m, r) => Math.max(m, r.length), 0);
  function ensureCell(r0, c0) { while (data.length <= r0) data.push([]); if (c0 + 1 > maxCols) maxCols = c0 + 1; }
  function get(r0, c0) { const row = data[r0]; return row && row[c0] != null ? row[c0] : ''; }
  function set(r0, c0, v) { ensureCell(r0, c0); const row = data[r0]; while (row.length <= c0) row.push(''); row[c0] = v; }
  function lastRow() { for (let r = data.length - 1; r >= 0; r--) { const row = data[r] || []; for (let c = 0; c < row.length; c++) if (row[c] !== '' && row[c] != null) return r + 1; } return 0; }
  function range(row, col, nR = 1, nC = 1) {
    const r1 = row - 1, c1 = col - 1;
    return {
      getValue() { return get(r1, c1); }, setValue(v) { set(r1, c1, v); return this; },
      getValues() { const o = []; for (let r = 0; r < nR; r++) { const l = []; for (let c = 0; c < nC; c++) l.push(get(r1 + r, c1 + c)); o.push(l); } return o; },
      setValues(m) { for (let r = 0; r < m.length; r++) for (let c = 0; c < m[r].length; c++) set(r1 + r, c1 + c, m[r][c]); return this; },
      getFormula() { return ''; }, copyTo() {}, setFontWeight() { return this; }, setNumberFormat() { return this; }
    };
  }
  return {
    getName: () => name,
    getDataRange() { return range(1, 1, Math.max(lastRow(), 1), Math.max(maxCols, 1)); },
    getLastRow: lastRow, getLastColumn: () => maxCols, getMaxColumns: () => maxCols, getMaxRows: () => 100000,
    getRange: (r, c, nR, nC) => range(r, c, nR, nC),
    appendRow(arr) { const r = lastRow(); for (let c = 0; c < arr.length; c++) set(r, c, arr[c]); if (arr.length > maxCols) maxCols = arr.length; },
    insertColumnsAfter(col, n) { if (col + n > maxCols) maxCols = col + n; }, setFrozenRows() {}
  };
}
function csvRows(path) {
  return fs.readFileSync(path, 'utf8').replace(/\r/g, '').split('\n').filter(l => l.length).map(l => l.split(','));
}

function makeSandbox() {
  const props = {}; const cache = {}; let uuid = 0;
  const sheets = {};
  sheets['Inventory'] = makeSheet('Inventory', csvRows(ROOT + 'qa/seed/Inventory.csv'));
  sheets['Transactions'] = makeSheet('Transactions', csvRows(ROOT + 'qa/seed/Transactions.csv'));
  const Utilities = {
    getUuid: () => 'uuid-' + (++uuid) + '-' + Math.floor(Math.random() * 1e6),
    DigestAlgorithm: { SHA_256: 'S' }, Charset: { UTF_8: 'U' },
    computeDigest: (a, t) => { const o = new Array(32).fill(0); for (let i = 0; i < t.length; i++) o[i % 32] = (o[i % 32] + t.charCodeAt(i) * (i + 7)) & 0xff; return o.map(b => b > 127 ? b - 256 : b); },
    formatDate: (d) => new Date(d).toISOString().slice(0, 19).replace('T', ' ')
  };
  const PropertiesService = { getScriptProperties: () => ({ getProperty: k => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = String(v); }, deleteProperty: k => { delete props[k]; } }) };
  const CacheService = { getScriptCache: () => ({ get: k => (k in cache ? cache[k] : null), put: (k, v) => { cache[k] = String(v); }, remove: k => { delete cache[k]; } }) };
  const LockService = { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) };
  const Session = { getScriptTimeZone: () => 'UTC' };
  const Logger = { log() {} };
  const ContentService = { MimeType: { JSON: 'JSON' }, createTextOutput: s => ({ _s: s, getContent() { return this._s; }, setMimeType() { return this; } }) };
  const SpreadsheetApp = { getActiveSpreadsheet: () => ({ getSheetByName: n => sheets[n] || null, insertSheet: n => (sheets[n] = makeSheet(n, [])) }) };
  const UrlFetchApp = { fetch: () => { throw new Error('UrlFetchApp not available in local harness (OpenRouter calls unsupported)'); } };
  const box = { PropertiesService, CacheService, LockService, Session, Logger, Utilities, ContentService, SpreadsheetApp, UrlFetchApp, console };
  vm.createContext(box);
  vm.runInContext(fs.readFileSync(ROOT + 'Code.gs', 'utf8'), box, { filename: 'Code.gs' });
  // seed accounts to match qa/live-api-qa.mjs defaults
  box.upsertUser('qa_master', 'QAmaster123', 'MASTER_ADMIN');
  box.ADD_USER('qa_admin', 'QAadmin123', 'ADMIN');
  box.ADD_USER('qa_oper', 'QAoper123', 'OPERATOR');
  box.ADD_USER('qa_view', 'QAview123', 'VIEWER');
  return box;
}

const box = makeSandbox();

http.createServer((req, res) => {
  let bodyChunks = [];
  req.on('data', c => bodyChunks.push(c));
  req.on('end', () => {
    let out;
    try {
      if (req.method === 'POST') {
        out = box.doPost({ postData: { contents: Buffer.concat(bodyChunks).toString('utf8') } });
      } else {
        const u = new URL(req.url, 'http://localhost');
        const params = {}; u.searchParams.forEach((v, k) => { params[k] = v; });
        out = box.doGet({ parameter: params });
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(out.getContent());
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
    }
  });
}).listen(PORT, () => console.log('LOCAL WHIMS harness on http://127.0.0.1:' + PORT + '  (runs real Code.gs; NOT Apps Script)'));
