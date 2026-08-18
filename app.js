/*
 * WHIMS — Wise Homeopathy Inventory Management System
   Frontend logic v1.0 · Backend: Google Apps Script (Code.gs) */
'use strict';

/* ---------- tiny helpers ---------- */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const store = {
  get(k, d){ try { const v = localStorage.getItem('whims_' + k); return v === null ? d : JSON.parse(v); } catch(e){ return d; } },
  set(k, v){ try { localStorage.setItem('whims_' + k, JSON.stringify(v)); } catch(e){} }
};

/* ---------- state ---------- */
let INV = store.get('inv', []);
let TX = store.get('tx', []);
let INTAKE = store.get('intake', []);   // pending intake records awaiting approval
let current = null;          // medicine open in detail sheet
let dispenseQty = 1;
let filter = 'all';
const API = () => (store.get('api', '') || 'https://script.google.com/macros/s/AKfycbwMfmOuKh8TWISu-69uw06aAZn0_knAZmwKUUGcBg_HWvGFNR9PHBSxwqFfEz84kvCnaA/exec').trim();
const USER = () => store.get('user', 'Staff');

/* ---------- session (token comes from backend login — no secrets live in this file) ---------- */
const TOKEN = () => store.get('token', '');
function setSession(token, user){
  store.set('token', token || '');
  if (user) store.set('user', user);
}
function showLogin(msg){
  $('#loginScreen').classList.add('open');
  $('#loginErr').textContent = msg || '';
  $('#loginApiWrap').style.display = API() ? 'none' : 'block';
  setTimeout(() => $(API() ? '#loginUser' : '#loginApi').focus(), 50);
}
function hideLogin(){ $('#loginScreen').classList.remove('open'); }
function authFailed(message){
  // any expired/invalid session lands here → back to the login screen
  setSession('', null);
  showLogin(message || 'Session expired — please log in again');
}

/* ---------- status logic (mirrors sheet formula) ---------- */
function statusOf(m){
  if (m.active === 'NO') return 'ARCHIVED';
  if (m.bottles === '' || m.bottles === null || m.bottles === undefined) return '';
  const b = Number(m.bottles);
  if (b === 0) return 'OUT OF STOCK';
  if (b === 1) return 'LOW STOCK';
  if (b <= 5) return 'GOOD';
  return 'OVERSTOCK';
}
const badgeCls = s => ({'OUT OF STOCK':'out','LOW STOCK':'low','GOOD':'good','OVERSTOCK':'over','ARCHIVED':'arch'}[s] || 'arch');

/* ---------- API ---------- */
function isAuthError(msg){ return /unauthorized|session expired|log in/i.test(String(msg)); }

async function apiGet(action, params = {}){
  const u = new URL(API());
  u.searchParams.set('action', action);
  u.searchParams.set('token', TOKEN());
  Object.entries(params).forEach(([k,v]) => u.searchParams.set(k, v));
  const r = await fetch(u, { method:'GET' });
  const j = await r.json();
  if (!j.ok){
    if (isAuthError(j.error)) { authFailed(j.error); }
    throw new Error(j.error || 'Backend error');
  }
  return j.data;
}
async function apiPost(body){
  // text/plain avoids the CORS preflight that Apps Script cannot answer
  const r = await fetch(API(), { method:'POST', headers:{'Content-Type':'text/plain;charset=utf-8'}, body: JSON.stringify({ ...body, token: TOKEN() }) });
  const j = await r.json();
  if (!j.ok){
    if (isAuthError(j.error)) { authFailed(j.error); }
    throw new Error(j.error || 'Backend error');
  }
  return j.data;
}

async function loadAll(showToast){
  if (!API()){ setSync(false); renderAll(); return; }
  try {
    setSyncing();
    const [inv, tx, intake] = await Promise.all([
      apiGet('inventory'),
      apiGet('transactions', {limit:120}),
      apiGet('readintake')
    ]);
    INV = inv; TX = tx; INTAKE = Array.isArray(intake) ? intake : [];
    store.set('inv', INV); store.set('tx', TX); store.set('intake', INTAKE);
    setSync(true);
    $('#dataInfo').textContent = INV.length + ' medicines loaded · last sync ' + new Date().toLocaleTimeString();
    if (showToast) toast('Synced — ' + INV.length + ' medicines');
  } catch(e){
    setSync(false);
    toast('Sync failed: ' + e.message, true);
  }
  renderAll();
}

function setSync(on){
  const d = $('#syncDot');
  d.className = on ? 'on' : 'off';
  $('#syncLabel').textContent = on ? 'Synced' : 'Offline';
  $('#setupBanner').style.display = API() ? 'none' : 'block';
}
function setSyncing(){ $('#syncLabel').textContent = 'Syncing…'; }

/* ---------- toast ---------- */
let toastTimer;
function toast(msg, err){
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'show' + (err ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.className = '', 2600);
}

/* ---------- navigation ---------- */
 $$('nav button').forEach(b => b.onclick = () => switchView(b.dataset.v));
function switchView(v){
  $$('nav button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
  $$('.view').forEach(x => x.classList.remove('active'));
  const view = $('#view-' + v);
  if (view) view.classList.add('active');
  if (v === 'history') renderTx();
  if (v === 'orders') renderOrders();
  if (v === 'intake') renderIntake();
  window.scrollTo({top:0});
}

/* ---------- dashboard ---------- */
function renderDash(){
  const act = INV.filter(m => m.active !== 'NO');
  const c = {
    total: act.length,
    out: act.filter(m => statusOf(m) === 'OUT OF STOCK').length,
    low: act.filter(m => statusOf(m) === 'LOW STOCK').length,
    good: act.filter(m => ['GOOD','OVERSTOCK'].includes(statusOf(m))).length,
    over: act.filter(m => statusOf(m) === 'OVERSTOCK').length,
    need: act.filter(m => Number(m.priority) > 0).length,
    arch: INV.filter(m => m.active === 'NO').length
  };

  /* notification bar: red if anything is out, amber if only low, green if all healthy */
  const ab = $('#alertBar');
  if (c.out > 0){
    ab.className = 'alertbar show crit pulse';
    ab.innerHTML = '<div class="ic">!</div><div class="tx"><b>' + c.out + ' medicine' + (c.out > 1 ? 's' : '') + ' out of stock</b>'
      + '<span>' + (c.low ? c.low + ' more running low · ' : '') + 'Tap to see the list</span></div><div class="go">›</div>';
    ab.onclick = () => { setChip('out'); switchView('search'); };
  } else if (c.low > 0){
    ab.className = 'alertbar show warn pulse';
    ab.innerHTML = '<div class="ic">▲</div><div class="tx"><b>' + c.low + ' medicine' + (c.low > 1 ? 's' : '') + ' running low</b>'
      + '<span>1 bottle left each · Tap to review</span></div><div class="go">›</div>';
    ab.onclick = () => { setChip('low'); switchView('search'); };
  } else if (INV.length){
    ab.className = 'alertbar show healthy';
    ab.innerHTML = '<div class="ic">✓</div><div class="tx"><b>All stock healthy</b>'
      + '<span>No medicine is out of stock or running low</span></div><div class="go">›</div>';
    ab.onclick = () => { setChip('good'); switchView('search'); };
  } else {
    ab.className = 'alertbar';
    ab.onclick = null;
  }

  const tile = (n, label, cls, f) =>
    `<button class="stat glass ${cls}" data-jump="${f}"><div class="capstrip"></div><b>${n}</b><span>${label}</span></button>`;
  $('#statGrid').innerHTML =
    tile(c.total, 'Total medicines', '', 'all') +
    tile(c.out, 'Out of stock', 'red', 'out') +
    tile(c.low, 'Low stock', 'amber', 'low') +
    tile(c.good, 'In stock', 'green', 'good') +
    tile(c.over, 'Overstock', 'blue', 'over') +
    tile(c.need, 'Need purchase', 'blue', 'need') +
    tile(c.arch, 'Archived', 'grey', 'arch');
  $$('#statGrid .stat').forEach(s => s.onclick = () => { setChip(s.dataset.jump); switchView('search'); });

  const recent = TX.slice(0, 6);
  $('#dashTx').innerHTML = recent.length ? recent.map(txRow).join('') : '<div class="empty">No transactions yet</div>';
}

/* ---------- search ---------- */
 $('#q').addEventListener('input', renderResults);
 $$('#chips .chip').forEach(c => c.onclick = () => setChip(c.dataset.f));
function setChip(f){
  filter = f;
  $$('#chips .chip').forEach(c => c.classList.toggle('on', c.dataset.f === f));
  renderResults();
}

function renderResults(){
  const q = $('#q').value.trim().toLowerCase();
  let list = INV;
  if (filter === 'arch') list = list.filter(m => m.active === 'NO');
  else {
    list = list.filter(m => m.active !== 'NO');
    if (filter === 'out') list = list.filter(m => statusOf(m) === 'OUT OF STOCK');
    if (filter === 'low') list = list.filter(m => statusOf(m) === 'LOW STOCK');
    if (filter === 'good') list = list.filter(m => ['GOOD','OVERSTOCK'].includes(statusOf(m)));
    if (filter === 'over') list = list.filter(m => statusOf(m) === 'OVERSTOCK');
    if (filter === 'need') list = list.filter(m => Number(m.priority) > 0);
  }
  if (q){
    list = list.filter(m =>
      m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q) ||
      String(m.potency).toLowerCase().includes(q) || String(m.category).toLowerCase().includes(q) ||
      String(m.supplier1).toLowerCase().includes(q) || String(m.supplier2).toLowerCase().includes(q));
  }
  const out = list.slice(0, 80);
  $('#results').innerHTML = out.length
    ? '<div class="card glass" style="padding:6px 8px">' + out.map(medRow).join('') + '</div>' +
      (list.length > 80 ? `<div class="empty">Showing 80 of ${list.length} — type to narrow down</div>` : '')
    : `<div class="empty"><b>Nothing found</b>Try a shorter search or another filter.</div>`;
  out.forEach((m, i) => {
    const main = $('#results .medmain[data-i="' + i + '"]');
    if (main) main.onclick = () => openDetail(m);
    const ob = $('#results .ordbtn[data-ord="' + i + '"]');
    if (ob) ob.onclick = (ev) => { ev.stopPropagation(); toggleOrder(m, ob); };
  });
}

function medRow(m, i){
  const s = statusOf(m);
  const sCls = {'OUT OF STOCK':'s-out','LOW STOCK':'s-low','OVERSTOCK':'s-over','ARCHIVED':'s-arch'}[s] || '';
  const onOrder = Number(m.priority) > 0;
  const ordBtn = m.active === 'NO' ? '' :
    `<button class="ordbtn ${onOrder ? 'rm' : 'add'}" data-ord="${i}"
       aria-label="${onOrder ? 'Remove from order' : 'Add to order'}"
       title="${onOrder ? 'Remove from purchase order' : 'Add to purchase order'}">${onOrder ? '−' : '＋'}</button>`;
  return `<div class="med ${sCls}">
    <button class="medmain" data-i="${i}">
      <div class="pot">${esc(m.potency || '—')}</div>
      <div class="info">
        <div class="name">${esc(m.name)}</div>
        <div class="meta">${esc(m.id)} · ${esc(m.pack || '')} ${s ? '· <span class="badge ' + badgeCls(s) + '">' + s + '</span>' : ''}${onOrder ? ' · <span class="badge p' + m.priority + '">On order · P' + m.priority + '</span>' : ''}</div>
      </div>
      <div class="right"><div class="stockN">${m.bottles === '' || m.bottles === null ? '?' : m.bottles}</div><div class="stockL">btl</div></div>
    </button>
    ${ordBtn}
  </div>`;
}

/* ---------- detail sheet ---------- */
function openDetail(m){
  current = m;
  $('#dName').textContent = m.name;
  $('#dMeta').textContent = m.id + ' · ' + (m.pack || '') + ' · ' + (m.category || '');
  const s = statusOf(m);
  const pr = Number(m.priority) > 0 ? `<span class="badge p${m.priority}">Priority ${m.priority}</span> ` : '';
  $('#dBadges').innerHTML = pr + (s ? `<span class="badge ${badgeCls(s)}">${s}</span>` : '');
  $('#dKv').innerHTML =
    kv(m.bottles ?? '—', 'Bottles') + kv(m.ml ?? '—', 'Stock ML') +
    kv(esc(m.supplier1 || '—'), 'Primary supplier') + kv(m.cost1 ? '₹' + m.cost1 : '—', 'Primary cost') +
    kv(esc(m.supplier2 || '—'), 'Secondary supplier') + kv(m.cost2 ? '₹' + m.cost2 : '—', 'Secondary cost') +
    kv(esc(m.mfd || '—'), 'MFD') + kv(esc(m.expiry || '—'), 'Expiry') +
    kv(esc(m.updated || '—'), 'Last updated') + kv(esc(m.remarks || '—'), 'Remarks');
  $('#goArchive').textContent = m.active === 'NO' ? 'Restore' : 'Archive';
  openSheet('#sheetDetail');
}
const kv = (b, l) => `<div><b>${b}</b><span>${l}</span></div>`;

/* ---------- sheets open/close ---------- */
function openSheet(id){
  $('#backdrop').classList.add('open');
  $$('.sheet').forEach(s => s.classList.remove('open'));
  $(id).classList.add('open');
  document.body.style.overflow = 'hidden';
}
function closeSheets(){
  $('#backdrop').classList.remove('open');
  $$('.sheet').forEach(s => s.classList.remove('open'));
  document.body.style.overflow = '';
}
 $('#backdrop').onclick = closeSheets;
 $$('[data-close]').forEach(b => b.onclick = closeSheets);

/* ---------- receive ---------- */
 $('#goReceive').onclick = () => {
  $('#rName').textContent = current.name + ' · current: ' + (current.bottles ?? '?') + ' btl';
  $('#rBottles').value = ''; $('#rMl').value = ''; $('#rRemarks').value = ''; $('#rAmount').value = '';
  $('#rSupplier').value = current.supplier1 || '';
  $('#rMfd').value = ''; $('#rExpiry').value = '';
  openSheet('#sheetReceive');
};
 $('#doReceive').onclick = () => act('receive', $('#doReceive'), {
  id: current.id,
  bottles: Number($('#rBottles').value),
  ml: $('#rMl').value === '' ? '' : Number($('#rMl').value),
  supplier: $('#rSupplier').value.trim(),
  amount: $('#rAmount').value === '' ? 0 : Number($('#rAmount').value),
  mfd: $('#rMfd').value, expiry: $('#rExpiry').value,
  remarks: $('#rRemarks').value.trim()
}, b => b.bottles >= 1 || 'Enter how many bottles were received');

/* ---------- dispense ---------- */
 $('#goDispense').onclick = () => {
  dispenseQty = 1;
  $('#xName').textContent = current.name + ' · current: ' + (current.bottles ?? '?') + ' btl';
  $('#xMl').value = ''; $('#xRemarks').value = ''; $('#xQty').value = ''; $('#xAmount').value = '';
  $('#customQtyWrap').style.display = 'none';
  $$('.quick button').forEach(b => b.classList.toggle('on', b.dataset.q === '1'));
  openSheet('#sheetDispense');
};
 $$('.quick button').forEach(b => b.onclick = () => {
  $$('.quick button').forEach(x => x.classList.remove('on'));
  b.classList.add('on');
  if (b.dataset.q === 'c'){ $('#customQtyWrap').style.display = 'block'; $('#xQty').focus(); dispenseQty = 0; }
  else { $('#customQtyWrap').style.display = 'none'; dispenseQty = Number(b.dataset.q); }
});
 $('#doDispense').onclick = () => {
  const qty = dispenseQty || Number($('#xQty').value);
  act('dispense', $('#doDispense'), {
    id: current.id, bottles: qty,
    ml: $('#xMl').value === '' ? '' : Number($('#xMl').value),
    amount: $('#xAmount').value === '' ? 0 : Number($('#xAmount').value),
    remarks: $('#xRemarks').value.trim()
  }, b => b.bottles >= 1 || 'Choose a quantity to dispense');
};

/* ---------- adjust ---------- */
 $('#goAdjust').onclick = () => {
  $('#aName').textContent = current.name;
  $('#aBottles').value = current.bottles ?? '';
  $('#aMl').value = current.ml ?? '';
  $('#aPriority').value = ''; $('#aRemarks').value = '';
  openSheet('#sheetAdjust');
};
 $('#doAdjust').onclick = () => act('adjust', $('#doAdjust'), {
  id: current.id,
  bottles: Number($('#aBottles').value),
  ml: $('#aMl').value === '' ? '' : Number($('#aMl').value),
  priority: $('#aPriority').value,
  remarks: $('#aRemarks').value.trim() || 'Manual adjustment'
}, b => b.bottles >= 0 || 'Enter the correct bottle count');

/* ---------- archive / restore ---------- */
 $('#goArchive').onclick = () => {
  const restoring = current.active === 'NO';
  if (!confirm((restoring ? 'Restore' : 'Archive') + ' "' + current.name + '"?')) return;
  act(restoring ? 'restore' : 'archive', $('#goArchive'), { id: current.id, remarks: '' }, () => true);
};

/* ---------- shared action runner ---------- */
async function act(action, btn, body, validate){
  const v = validate(body);
  if (v !== true){ toast(v, true); return; }
  if (!API()){ toast('Connect the backend first (Settings)', true); return; }
  btn.disabled = true;
  try {
    const res = await apiPost({ action, ...body });
    closeSheets();
    const verb = {receive:'Received', dispense:'Dispensed', adjust:'Adjusted', archive:'Archived', restore:'Restored'}[action];
    toast(verb + ' ✓ ' + (res.newStock !== undefined ? '· stock: ' + res.newStock : ''));
    await loadAll(false);
  } catch(e){
    toast(e.message, true);
  }
  btn.disabled = false;
}

/* ---------- order add / remove (priority only — stock untouched) ---------- */
async function toggleOrder(m, btn, removeOnly){
  if (!API()){ toast('Connect the backend first (Settings)', true); return; }
  const adding = removeOnly ? false : !(Number(m.priority) > 0);
  if (btn) btn.disabled = true;
  try {
    await apiPost({
      action: 'priority',
      id: m.id,
      priority: adding ? 3 : 0,
      remarks: adding ? 'Added to purchase order' : 'Removed from purchase order'
    });
    toast(adding ? 'Added to order list ✓ (priority 3 — change it in Adjust)' : 'Removed from order list ✓');
    await loadAll(false);
  } catch(e){
    toast(e.message, true);
  }
  if (btn) btn.disabled = false;
}

/* ---------- orders ---------- */
function orderData(){
  const need = INV.filter(m => m.active !== 'NO' && Number(m.priority) > 0)
    .sort((a,b) => Number(b.priority) - Number(a.priority));
  const groups = {};
  need.forEach(m => {
    const s = m.supplier1 || 'Unassigned supplier';
    (groups[s] = groups[s] || []).push(m);
  });
  return groups;
}
let orderSel = new Set();   // ids ticked for copy/whatsapp; refilled on each render

function renderOrders(){
  const groups = orderData();
  const names = Object.keys(groups).sort();
  const allIds = names.flatMap(s => groups[s].map(m => m.id));

  // keep previous ticks where possible; newly appeared items start ticked
  const prev = orderSel;
  orderSel = new Set(allIds.filter(id => prev.size === 0 || prev.has(id)));

  if (!names.length){
    $('#orderTools').style.display = 'none';
    $('#orderList').innerHTML = '<div class="empty"><b>Nothing to order</b>Add medicines from Search with the ＋ button, or set a reorder priority in Adjust.</div>';
    return;
  }
  $('#orderTools').style.display = 'flex';

  $('#orderList').innerHTML = names.map(s => `
    <div class="card glass supgroup">
      <div class="suphead">${esc(s)} · ${groups[s].length}</div>
      ${groups[s].map(m => `
        <div class="orow" data-id="${esc(m.id)}">
          <button class="ocheck ${orderSel.has(m.id) ? 'on' : ''}" data-chk="${esc(m.id)}" role="checkbox"
            aria-checked="${orderSel.has(m.id)}" aria-label="Include ${esc(m.name)} in order">${orderSel.has(m.id) ? '✓' : ''}</button>
          <span class="badge p${m.priority}">${m.priority}</span>
          <div style="flex:1;min-width:0">
            <div class="nm">${esc(m.name)}</div>
            <div class="pk">${esc(m.id)} · ${esc(m.pack || '')} · stock ${m.bottles ?? '?'} btl ${m.cost1 ? '· ₹' + m.cost1 : ''}</div>
          </div>
          <button class="orm" data-rm="${esc(m.id)}" aria-label="Remove ${esc(m.name)} from order" title="Remove from order">×</button>
        </div>`).join('')}
    </div>`).join('');

  // wire checkboxes
  $$('#orderList .ocheck').forEach(cb => cb.onclick = () => {
    const id = cb.dataset.chk;
    if (orderSel.has(id)) orderSel.delete(id); else orderSel.add(id);
    cb.classList.toggle('on', orderSel.has(id));
    cb.setAttribute('aria-checked', orderSel.has(id));
    cb.textContent = orderSel.has(id) ? '✓' : '';
    updateSelCount(allIds.length);
  });
  // wire per-item remove (×)
  $$('#orderList .orm').forEach(b => b.onclick = () => {
    const m = INV.find(x => x.id === b.dataset.rm);
    if (!m) return;
    if (!confirm('Remove "' + m.name + '" from the purchase order?')) return;
    toggleOrder(m, b, true);
  });

  updateSelCount(allIds.length);

  $('#selAll').onclick = () => {
    const all = orderSel.size === allIds.length;
    orderSel = all ? new Set() : new Set(allIds);
    renderOrders();
  };
  $('#rmSel').onclick = async () => {
    if (!orderSel.size) return toast('Nothing selected', true);
    if (!confirm('Remove ' + orderSel.size + ' item(s) from the purchase order?')) return;
    if (!API()){ toast('Connect the backend first (Settings)', true); return; }
    $('#rmSel').disabled = true;
    let done = 0, fail = 0;
    for (const id of orderSel){
      const m = INV.find(x => x.id === id);
      if (!m) continue;
      try {
        await apiPost({ action:'priority', id: m.id, priority: 0, remarks:'Removed from purchase order (bulk)' });
        done++;
      } catch(e){ fail++; }
    }
    $('#rmSel').disabled = false;
    toast('Removed ' + done + ' item(s)' + (fail ? ' · ' + fail + ' failed' : ''), fail > 0);
    orderSel = new Set();
    await loadAll(false);
  };
}

function updateSelCount(total){
  $('#selAll').textContent = (orderSel.size === total ? 'Clear all' : 'Select all');
  $('#selCount').textContent = orderSel.size + ' of ' + total + ' selected';
}
function orderText(){
  const groups = orderData();
  const names = Object.keys(groups).sort();
  if (!names.length) return '';
  let out = '*WISE HOMEOPATHY — PURCHASE ORDER*\n' + new Date().toLocaleDateString('en-IN') + '\n';
  let count = 0;
  names.forEach(s => {
    const items = groups[s].filter(m => orderSel.has(m.id));
    if (!items.length) return;
    out += '\n*' + s + '*\n';
    items.forEach(m => { out += '• ' + m.name + ' (' + (m.pack || '') + ') — P' + m.priority + '\n'; count++; });
  });
  return count ? out : '';
}
 $('#copyOrder').onclick = async () => {
  const t = orderText();
  if (!t) return toast('No items selected — tick the boxes first', true);
  try { await navigator.clipboard.writeText(t); toast('Selected items copied'); }
  catch(e){ toast('Copy failed — long-press to select manually', true); }
};
 $('#waOrder').onclick = () => {
  const t = orderText();
  if (!t) return toast('No items selected — tick the boxes first', true);
  window.open('https://wa.me/?text=' + encodeURIComponent(t), '_blank');
};

/* ---------- intake (pending stock approvals) ---------- */
function intakeField(item, key){
  // tolerate a few alternate field names from the backend
  return item[key] ?? item[key.replace(/Time$/,'')] ?? item[key.replace(/([A-Z])/g, '_$1').toLowerCase()] ?? '—';
}

function renderIntake(){
  const wrap = $('#intakeList');
  if (!wrap) return;
  const pending = INTAKE.filter(r => {
    const st = String(r.status || r.state || '').toUpperCase();
    return st === '' || st === 'PENDING' || st === 'NEW' || st === 'WAITING';
  });

  if (!pending.length){
    wrap.innerHTML = '<div class="empty"><b>No pending stock</b>Stock captured via the intake form will appear here for approval.</div>';
    return;
  }

  wrap.innerHTML = pending.map((item, i) => `
    <div class="card glass intakeItem">
      <div class="dKv">
        ${kv(esc(intakeField(item,'medicine')), 'Medicine')}
        ${kv(esc(intakeField(item,'pack')), 'Pack')}
        ${kv(esc(intakeField(item,'potency')), 'Potency')}
        ${kv(esc(intakeField(item,'supplier')), 'Supplier')}
        ${kv(esc(intakeField(item,'qty')), 'Qty')}
        ${kv(esc(intakeField(item,'action')), 'Action')}
        ${kv(esc(intakeField(item,'source')), 'Source')}
        ${kv(esc(intakeField(item,'capturedTime') || intakeField(item,'captured')), 'Captured time')}
      </div>
      <div class="intakeActions" style="display:flex;gap:8px;margin-top:10px">
        <button class="ordbtn add" data-accept="${i}" style="flex:1;padding:10px">Accept</button>
        <button class="ordbtn rm" data-reject="${i}" style="flex:1;padding:10px">Reject</button>
      </div>
    </div>
  `).join('');

  wrap.querySelectorAll('[data-accept]').forEach(b => b.onclick = () => approveIntake(pending[Number(b.dataset.accept)]));
  wrap.querySelectorAll('[data-reject]').forEach(b => b.onclick = () => rejectIntake(pending[Number(b.dataset.reject)]));
}

async function approveIntake(item){
  if (!API()){ toast('Connect the backend first (Settings)', true); return; }
  if (!confirm('Accept intake for "' + (item.medicine || item.name || 'this medicine') + '"?')) return;
  try {
    await apiPost({ action:'approveintake', intakeId: item.intakeId });
    toast('Intake accepted ✓');
    await loadAll(false);
  } catch(e){
    toast(e.message, true);
  }
}

async function rejectIntake(item){
  if (!API()){ toast('Connect the backend first (Settings)', true); return; }
  if (!confirm('Reject intake for "' + (item.medicine || item.name || 'this medicine') + '"?')) return;
  try {
    await apiPost({ action:'rejectintake', intakeId: item.intakeId });
    toast('Intake rejected');
    await loadAll(false);
  } catch(e){
    toast(e.message, true);
  }
}

/* ---------- history ---------- */
function txRow(t){
  const sign = t.action === 'RECEIVE' ? '+' : t.action === 'DISPENSE' ? '−' : '';
  const icon = {RECEIVE:'+', DISPENSE:'−', ADJUSTMENT:'±', ARCHIVE:'⌫', RESTORE:'↺', 'ORDER-ADD':'🛒', 'ORDER-REMOVE':'⊘'}[t.action] || '•';
  return `<div class="tx ${esc(t.action)}">
    <div class="ic">${icon}</div>
    <div class="body">
      <div class="t1">${esc(t.medicineName)}</div>
      <div class="t2">${esc(t.action)} · ${esc(t.dateTime)} · ${esc(t.user)}${t.amount ? ' · ₹' + Number(t.amount).toLocaleString('en-IN') : ''}${t.remarks ? ' · ' + esc(t.remarks) : ''}</div>
    </div>
    ${sign ? `<div class="qty">${sign}${t.quantity}</div>` : ''}
  </div>`;
}
function renderTx(){
  $('#txList').innerHTML = TX.length ? TX.map(txRow).join('') : '<div class="empty"><b>No history yet</b>Receive or dispense stock to start the audit trail.</div>';
}

/* ---------- settings ---------- */
 $('#apiUrl').value = store.get('api', '');
 $('#userName').value = store.get('user', '');
 $('#saveSettings').onclick = () => {
  store.set('api', $('#apiUrl').value.trim());
  store.set('user', $('#userName').value.trim() || 'Staff');
  toast('Settings saved');
  loadAll(true);
};
 $('#testApi').onclick = async () => {
  const url = $('#apiUrl').value.trim();
  if (!url) return toast('Paste your Apps Script URL first', true);
  store.set('api', url);
  try {
    const r = await fetch(url + (url.includes('?') ? '&' : '?') + 'action=ping');
    const j = await r.json();
    toast(j.ok ? '✓ Backend is live' : 'Backend error: ' + j.error, !j.ok);
  } catch(e){
    toast('Cannot reach backend — check the URL and deployment access (“Anyone”)', true);
  }
};
 $('#refreshData').onclick = () => loadAll(true);

/* ---------- login / logout ---------- */
async function doLogin(){
  const apiField = $('#loginApi').value.trim();
  if (apiField) store.set('api', apiField);
  if (!API()){ $('#loginErr').textContent = 'Paste your Apps Script URL first'; return; }
  const u = $('#loginUser').value.trim();
  const p = $('#loginPass').value;
  if (!u || !p){ $('#loginErr').textContent = 'Enter username and password'; return; }
  $('#loginBtn').disabled = true;
  $('#loginErr').textContent = '';
  try {
    const r = await fetch(API(), { method:'POST', headers:{'Content-Type':'text/plain;charset=utf-8'},
      body: JSON.stringify({ action:'login', username:u, password:p }) });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || 'Login failed');
    setSession(j.data.token, j.data.user);
    $('#loginPass').value = '';
    hideLogin();
    toast('Welcome, ' + j.data.user + ' ✓ (session ' + j.data.hours + 'h)');
    $('#whoAmI').textContent = 'Logged in as: ' + j.data.user;
    loadAll(true);
  } catch(e){
    $('#loginErr').textContent = e.message;
  }
  $('#loginBtn').disabled = false;
}
 $('#loginBtn').onclick = doLogin;
 $('#loginPass').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });

 $('#logoutBtn').onclick = async () => {
  if (!confirm('Log out of WHIMS?')) return;
  try { if (API() && TOKEN()) await fetch(API(), { method:'POST', headers:{'Content-Type':'text/plain;charset=utf-8'}, body: JSON.stringify({ action:'logout', token: TOKEN() }) }); } catch(e){}
  setSession('', null);
  showLogin('Logged out');
};

/* ---------- render all + boot ---------- */
function renderAll(){ renderDash(); renderResults(); renderOrders(); renderTx(); renderIntake(); }
setSync(false);
renderAll();
if (TOKEN()){
  $('#whoAmI').textContent = 'Logged in as: ' + USER();
  loadAll(false);          // if the session died, authFailed() pops the login screen
} else {
  showLogin();
}