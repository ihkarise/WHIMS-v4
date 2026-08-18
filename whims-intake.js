/* WHIMS v4.2 — Phase 2: Editable Intake Review.
   Load AFTER app.js, whims-core.js, and whims-source.js.

   Purely additive: wraps window.renderIntake and rebuilds the cards inside
   #intakeList as fully editable forms. Selecting an inventory match uses the
   Global Search Engine (WHIMS.Core.Search, Layer 2). Accept sends the edited
   values through the existing 'approveintake' items[] payload (already supported
   by the v4.0 backend); Reject is unchanged ('rejectintake').

   App globals used: apiPost, toast, loadAll, esc, INTAKE/INV (via Core.data).
   Backend contract (unchanged):
     approveintake { items:[{ intakeId, action, matchedId?, name?, category?,
        potency?, pack?, qty, unitCost?, supplier?, mfd?, expiry?, barcode? }] }
     rejectintake  { intakeId }
*/
(function(){
  if (window.WHIMSIntake) return;
  const D = document;
  const G = n => window[n];
  const Core = () => (window.WHIMS && window.WHIMS.Core) || null;
  const WF = () => (window.WHIMS && window.WHIMS.Workflow) || null;
  const esc = s => G('esc') ? G('esc')(s) : String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const toast = (m,e)=>{ const t=G('toast'); if(t)t(m,e); else console.log(m); };
  async function apiPost(body){ const ap=G('apiPost'); if(!ap) throw new Error('WHIMS API not ready');
    const r=await ap(body); return (r&&typeof r==='object'&&'ok'in r&&'data'in r)?r.data:r; }
  const up = s => String(s==null?'':s).trim().toUpperCase();

  /* ---------------- pure helpers (unit-tested) ---------------- */
  function isPending(status){ const s=up(status); return s===''||s==='PENDING'||s==='NEW'||s==='WAITING'; }
  function numOrEmpty(v){ if(v==null||v==='') return ''; const n=parseFloat(String(v).replace(/[^0-9.\-]/g,'')); return isNaN(n)?'':n; }

  /** The single source of truth for a card's initial field values — used both
   *  to render the form and as the "Original OCR" baseline for diffing.
   *  The Intake sheet never overwrites these columns until approval, so this
   *  IS the original OCR snapshot with zero backend change (Phase 3). */
  function deriveFields(r){
    const action = up(r.action)==='ADD_NEW' || (!r.matchedId && !up(r.action)) ? 'ADD_NEW' : (up(r.action)||'RECEIVE');
    const code = action==='RECEIVE' ? (r.matchedId||'') : (r.proposedId||'');
    return { action, code,
      name: r.name||'', category: r.category||'', potency: r.potency||'', pack: r.pack||'',
      qty: (r.qty===0||r.qty==null||r.qty==='')?'':String(r.qty),
      unitCost: (r.unitCost===0||r.unitCost==null||r.unitCost==='')?'':String(r.unitCost),
      supplier: r.supplier||'', mfd: r.mfd||'', expiry: r.expiry||'', barcode: r.barcode||'' };
  }
  const DIFF_FIELDS = ['code','name','category','potency','pack','qty','unitCost','supplier','mfd','expiry','barcode'];
  const DIFF_LABELS = { code:'Code', name:'Medicine', category:'Category', potency:'Potency', pack:'Pack',
    qty:'Qty', unitCost:'Cost', supplier:'Supplier', mfd:'MFD', expiry:'Expiry', barcode:'Barcode' };

  /** Compares Original OCR vs the live Reviewer Version → list of {f,before,after}. */
  function diffFields(orig, cur){
    const norm = (f,v) => (f==='qty'||f==='unitCost') ? String(numOrEmpty(v)) : String(v==null?'':v).trim();
    const out = [];
    DIFF_FIELDS.forEach(f=>{
      const b = norm(f, orig[f]), a = norm(f, cur[f]);
      if (b !== a) out.push({ f, before: orig[f]||'—', after: cur[f]||'—' });
    });
    return out;
  }
  /** Compact human-readable audit note, capped so it never bloats the Transactions sheet. */
  function summarizeDiff(diffs){
    if (!diffs.length) return '';
    const parts = diffs.slice(0,6).map(d => DIFF_LABELS[d.f]+' '+d.before+'→'+d.after);
    let s = parts.join(', ');
    if (diffs.length > 6) s += ' (+' + (diffs.length-6) + ' more)';
    return s.length > 300 ? s.slice(0,297)+'…' : s;
  }

  /* ---------------- Phase 5: Undo Approval — pure helpers ---------------- */
  let _undoList = [];     // {undoId,intakeId,resultId,action,createdAt,expiresAt,approvedBy}
  let _undoTimer = null;

  /** De-dupe by intakeId (newest wins) and drop anything already expired. */
  function filterActiveUndos(list, nowMs){
    nowMs = nowMs != null ? nowMs : Date.now();
    const seen = new Set(); const out = [];
    list.slice().sort((a,b)=> Date.parse(b.createdAt||0)-Date.parse(a.createdAt||0)).forEach(e=>{
      if (!e || !e.intakeId || seen.has(e.intakeId)) return;
      const exp = Date.parse(String(e.expiresAt||'').replace(' ','T'));
      if (isNaN(exp) || exp <= nowMs) return;
      seen.add(e.intakeId); out.push(e);
    });
    return out;
  }
  function secondsRemaining(expiresAt, nowMs){
    nowMs = nowMs != null ? nowMs : Date.now();
    const exp = Date.parse(String(expiresAt||'').replace(' ','T'));
    if (isNaN(exp)) return 0;
    return Math.max(0, Math.round((exp-nowMs)/1000));
  }
  /** undoId is the precise key when we have it; intakeId is the fallback (e.g. after a reload-seeded entry). */
  function undoTarget(entry){ return entry.undoId ? {undoId:entry.undoId} : {intakeId:entry.intakeId}; }

  /** Build the approveintake item payload from a card's action + matched id + fields. */
  function buildItem(o){
    const f = o.fields || {};
    const item = { intakeId:o.intakeId, action:up(o.action)==='ADD_NEW'?'ADD_NEW':'RECEIVE' };
    const q = numOrEmpty(f.qty); item.qty = q===''?0:q;
    const c = numOrEmpty(f.unitCost); if (c!=='') item.unitCost = c;
    if (f.supplier) item.supplier = f.supplier;
    if (f.mfd) item.mfd = f.mfd;
    if (f.expiry) item.expiry = f.expiry;
    if (f.barcode) item.barcode = f.barcode;
    if (item.action==='RECEIVE'){
      item.matchedId = (o.matchedId || f.code || '').trim();
    } else {
      if (f.name) item.name = f.name;
      if (f.category) item.category = f.category;
      if (f.potency) item.potency = f.potency;
      if (f.pack) item.pack = f.pack;
    }
    return item;
  }
  /** Validate a built item; returns true or an error string. */
  function validateItem(it){
    if (it.action==='RECEIVE'){
      if (!it.matchedId) return 'Pick the existing medicine to receive into';
      if (!(it.qty>0)) return 'Enter a quantity greater than 0';
    } else {
      if (!it.name) return 'Enter the medicine name';
    }
    return true;
  }

  window.WHIMSIntake = { isPending, buildItem, validateItem, refresh:()=>enhance(),
    deriveFields, diffFields, summarizeDiff, filterActiveUndos, secondsRemaining, undoTarget,
    _test:{ isPending, buildItem, validateItem, numOrEmpty, deriveFields, diffFields, summarizeDiff,
      filterActiveUndos, secondsRemaining, undoTarget } };

  /* ---------------- data access (via Core, with fallbacks) ---------------- */
  function intakeRows(){ const c=Core(); const arr = c?c.data.intake():(Array.isArray(G('INTAKE'))?G('INTAKE'):[]);
    return (arr||[]).filter(r=>isPending(r.status||r.state)); }
  function inventoryActive(){ const c=Core(); const inv = c?c.data.inventory():(Array.isArray(G('INV'))?G('INV'):[]);
    return (inv||[]).filter(m=>up(m.active)!=='NO'); }
  let _idx = null;
  function index(){ const c=Core(); if(!c) return null; if(!_idx) _idx=c.Search.createIndex(inventoryActive()); return _idx; }
  const _origByCard = new Map();   // intakeId -> Original OCR fields (Phase 3)

  /* ---------------- render ---------------- */
  const field = (f,label,val,opts)=>{ opts=opts||{};
    return '<div class="wi-f'+(opts.full?' full':'')+'" data-field="'+f+'">'+
      '<label>'+esc(label)+' <span class="wi-edited">Edited</span></label>'+
      '<input data-f="'+f+'" value="'+esc(val==null?'':val)+'"'+
      (opts.type?' type="'+opts.type+'"':'')+(opts.ro?' readonly':'')+
      (opts.ph?' placeholder="'+esc(opts.ph)+'"':'')+'>'+
    '</div>'; };

  function cardHtml(r){
    const fl = deriveFields(r);
    const action = fl.action, code = fl.code, qty = fl.qty, cost = fl.unitCost;
    return ''+
    '<div class="wi-card" data-id="'+esc(r.intakeId)+'" data-action="'+action+'" data-match="'+esc(r.matchedId||'')+'">'+
      '<div class="wi-head"><span class="wi-src">'+esc(r.source||'INTAKE')+'</span>'+
        (r.confidence?'<span class="wi-conf">conf '+esc(r.confidence)+'</span>':'')+'</div>'+
      '<div class="wi-seg">'+
        '<button data-act="RECEIVE"'+(action==='RECEIVE'?' class="on"':'')+'>Receive into existing</button>'+
        '<button data-act="ADD_NEW"'+(action==='ADD_NEW'?' class="on"':'')+'>Add as new</button></div>'+
      '<div class="wi-pick" data-role="receive"'+(action==='RECEIVE'?'':' style="display:none"')+'>'+
        '<input class="wi-search" placeholder="search inventory — name / code / barcode" autocapitalize="characters">'+
        '<div class="wi-res"></div>'+
        '<div class="wi-matched'+(r.matchedId?' on':'')+'">'+(r.matchedId?'Receiving into <b>'+esc(r.matchedId)+'</b> · '+esc(r.name||''):'')+'</div>'+
      '</div>'+
      '<div class="wi-grid">'+
        field('code','Code', code, { ph: action==='ADD_NEW'?'auto-assigned on accept':'' })+
        field('name','Name', fl.name)+
        field('category','Category', fl.category)+
        field('potency','Potency', fl.potency)+
        field('pack','Pack', fl.pack)+
        field('qty','Qty', qty, { type:'number' })+
        field('unitCost','Unit cost', cost, { type:'number' })+
        field('supplier','Supplier', fl.supplier)+
        field('mfd','MFD', fl.mfd)+
        field('expiry','Expiry', fl.expiry)+
        field('barcode','Barcode', fl.barcode, { full:true })+
      '</div>'+
      (Core()?'':'<div class="wi-note">Search needs whims-core.js — type the code manually for now.</div>')+
      '<div class="wi-diffnote"></div>'+
      '<div class="wi-dupbox"></div>'+
      '<div class="wi-actions">'+
        '<button class="wi-btn wi-accept">Accept</button>'+
        '<button class="wi-btn wi-reject">Reject</button>'+
      '</div>'+
    '</div>';
  }

  function enhance(){
    const wrap = D.getElementById('intakeList'); if(!wrap) return;
    _idx = null;                                   // rebuild the search index from fresh inventory
    const rows = intakeRows();
    const undos = filterActiveUndos(_undoList);
    if (!rows.length && !undos.length) return;     // leave the app's empty-state in place ("remove after approval")
    _origByCard.clear();
    rows.forEach(r => _origByCard.set(String(r.intakeId), deriveFields(r)));
    wrap.innerHTML = undos.map(undoBannerHtml).join('') + rows.map(cardHtml).join('');
    wrap.querySelectorAll('.wi-card').forEach(wireCard);
    wrap.querySelectorAll('.wi-undo').forEach(wireUndoBanner);
    startUndoTicker();
  }

  /* ---------------- Phase 5: Undo banner render/wire/ticker ---------------- */
  function undoBannerHtml(e){
    const secs = secondsRemaining(e.expiresAt);
    return '<div class="wi-undo" data-undo-id="'+esc(e.undoId||'')+'" data-intake-id="'+esc(e.intakeId)+'" data-expires="'+esc(e.expiresAt||'')+'">'+
      '<span>✓ '+(e.action==='ADD_NEW'?'Added':'Received')+' <b>'+esc(e.resultId)+'</b></span>'+
      '<span class="wi-undo-timer">undo available · <b data-undo-secs>'+secs+'</b>s</span>'+
      '<button class="wi-undo-btn">Undo</button></div>';
  }
  function wireUndoBanner(el){
    el.querySelector('.wi-undo-btn').onclick = ()=> doUndo(el.dataset.undoId, el.dataset.intakeId, el);
  }
  function startUndoTicker(){
    clearInterval(_undoTimer);
    _undoTimer = setInterval(()=>{
      let any=false;
      D.querySelectorAll('.wi-undo').forEach(el=>{
        const secs = secondsRemaining(el.dataset.expires);
        const b = el.querySelector('[data-undo-secs]'); if (b) b.textContent = secs;
        if (secs<=0){ el.remove(); } else any=true;
      });
      _undoList = filterActiveUndos(_undoList);
      if (!any) clearInterval(_undoTimer);
    }, 1000);
  }
  async function doUndo(undoId, intakeId, el){
    if (!G('apiPost')){ toast('Connect the backend first (Settings)', true); return; }
    const btn = el && el.querySelector('.wi-undo-btn'); if (btn) btn.disabled = true;
    try{
      const body = Object.assign({ action:'undoapprove' }, undoTarget({undoId,intakeId}));
      await apiPost(body);
      _undoList = _undoList.filter(e => e.undoId !== undoId);
      toast('Undone ✓ — back in the review queue');
      const wf = WF(); if (wf) wf.dispatch('INVENTORY_UPDATED', { intakeId, undone:true });
      if (G('loadAll')) await G('loadAll')(false); else enhance();
    }catch(e){ toast(e.message, true); if (btn) btn.disabled=false; }
  }
  /** Re-seed the undo list from the backend (resilient to a page reload within the window). */
  async function seedUndoList(){
    const ag = G('apiGet'); if (typeof ag !== 'function') return;
    try{
      const list = await ag('recentapprovals');
      if (Array.isArray(list) && list.length){
        _undoList = filterActiveUndos(_undoList.concat(list));
        enhance();
      }
    }catch(e){ /* older backend without Phase 5 — silently degrade, no Undo banners */ }
  }

  function wireCard(card){
    const search = card.querySelector('.wi-search');
    const res = card.querySelector('.wi-res');
    const matched = card.querySelector('.wi-matched');
    const codeInput = card.querySelector('[data-f="code"]');
    const dupBox = card.querySelector('.wi-dupbox');
    card._dupResolved = new Set();   // candidate ids the reviewer has explicitly decided on this session
    card._dupNotes = [];             // audit trail of those decisions (folds into Phase 3's reviewNote)
    card._dupBlocking = false;

    /* ---- Phase 4: duplicate detection against active inventory ---- */
    function currentRecord(){
      const F = {}; card.querySelectorAll('[data-f]').forEach(el=> F[el.dataset.f]=el.value.trim());
      return { id:F.code, name:F.name, category:F.category, potency:F.potency, pack:F.pack,
               supplier:F.supplier, barcode:F.barcode };
    }
    function dupReasonLabel(rs){ return rs.map(r=>({code:'code',barcode:'barcode',name:'name',potency:'potency',pack:'pack',category:'category',supplier:'supplier'}[r]||r)).join('+'); }
    function checkDuplicates(){
      const c = Core(); if (!c){ dupBox.innerHTML=''; card._dupBlocking=false; return; }
      const excludeId = card.dataset.action==='RECEIVE' ? card.dataset.match : '';
      const all = c.Search.findDuplicates(currentRecord(), inventoryActive(), { excludeId });
      const list = all.filter(d => !card._dupResolved.has(d.id));
      card._dupBlocking = list.length > 0;
      if (!list.length){ dupBox.innerHTML=''; return; }
      dupBox.innerHTML = '<div class="wi-dup-head">⚠ Possible duplicate'+(list.length>1?'s':'')+' found</div>'+
        list.map(d => ''+
          '<div class="wi-dup-row" data-dup="'+esc(d.id)+'">'+
            '<div class="wi-dup-info"><b>'+esc(d.id)+'</b> '+esc(d.name)+
              '<span>matched on '+esc(dupReasonLabel(d.reasons))+' · '+d.score+'%</span></div>'+
            '<div class="wi-dup-btns">'+
              '<button data-dup-act="merge">Merge</button>'+
              '<button data-dup-act="keep">Keep separate</button>'+
              '<button data-dup-act="ignore">Ignore</button>'+
            '</div></div>').join('');
      dupBox.querySelectorAll('.wi-dup-row').forEach(row=>{
        const id = row.dataset.dup;
        const cand = list.find(d=>d.id===id);
        row.querySelector('[data-dup-act="merge"]').onclick = ()=> applyMatch(card, cand.candidate, true);
        row.querySelector('[data-dup-act="keep"]').onclick = ()=>{
          card._dupResolved.add(id); card._dupNotes.push('Kept separate from '+id); checkDuplicates();
        };
        row.querySelector('[data-dup-act="ignore"]').onclick = ()=>{
          card._dupResolved.add(id); card._dupNotes.push('Ignored possible duplicate '+id); checkDuplicates();
        };
      });
    }

    /* ---- Phase 3: live diff against the preserved Original OCR ---- */
    function markDiffs(){
      const orig = _origByCard.get(card.dataset.id); if(!orig) return;
      const cur = {}; card.querySelectorAll('[data-f]').forEach(el=> cur[el.dataset.f]=el.value);
      const diffs = diffFields(orig, cur);
      const changed = new Set(diffs.map(d=>d.f));
      card.querySelectorAll('.wi-f[data-field]').forEach(wrap=>
        wrap.classList.toggle('wi-changed', changed.has(wrap.dataset.field)));
      const note = card.querySelector('.wi-diffnote');
      const summary = summarizeDiff(diffs);
      note.textContent = summary ? 'Edited: '+summary : '';
      note.classList.toggle('on', !!summary);
      card._reviewNote = summary;
      checkDuplicates();
    }
    card.querySelectorAll('[data-f]').forEach(el => el.addEventListener('input', markDiffs));
    markDiffs(); // baseline pass — no diffs on first render, but sets up state + initial dup check

    function setAction(act){
      card.dataset.action = act;
      card.querySelectorAll('.wi-seg button').forEach(b=>b.classList.toggle('on', b.dataset.act===act));
      card.querySelector('.wi-pick').style.display = act==='RECEIVE' ? '' : 'none';
      if (act==='ADD_NEW'){ codeInput.setAttribute('placeholder','auto-assigned on accept'); }
      else { codeInput.removeAttribute('placeholder'); }
      markDiffs();
    }
    card.querySelectorAll('.wi-seg button').forEach(b=> b.onclick = ()=> setAction(b.dataset.act));

    /** Shared by the picker (search result click) AND the duplicate banner's Merge button —
     *  one fill routine so both paths stay identical, per "reuse existing functions". */
    function applyMatch(card, m, fromMerge){
      card.dataset.match = m.id;
      codeInput.value = m.id;
      card.querySelector('[data-f="name"]').value = m.name||'';
      card.querySelector('[data-f="category"]').value = m.category||'';
      card.querySelector('[data-f="potency"]').value = m.potency||'';
      card.querySelector('[data-f="pack"]').value = m.pack||'';
      matched.innerHTML = 'Receiving into <b>'+esc(m.id)+'</b> · '+esc(m.name||'');
      matched.classList.add('on');
      res.innerHTML=''; if (search) search.value='';
      if (fromMerge) card._dupNotes.push('Merged into '+m.id);
      setAction('RECEIVE');   // also calls markDiffs() → checkDuplicates(), which now excludes the chosen id
    }

    if (search){
      search.oninput = ()=>{
        const idx = index(); const q = search.value.trim();
        if (!idx || !q){ res.innerHTML=''; return; }
        const hits = idx.search(q, { limit:8 });
        res.innerHTML = hits.map(m =>
          '<button data-id="'+esc(m.id)+'"><b>'+esc(m.id)+'</b> '+esc(m.name)+
          '<span>'+esc(m.potency||'')+(m.pack?' · '+esc(m.pack):'')+(m.bottles!=null?' · '+m.bottles+' btl':'')+'</span></button>').join('');
        res.querySelectorAll('button[data-id]').forEach(btn => btn.onclick = ()=>{
          const m = inventoryActive().find(x=>String(x.id)===btn.dataset.id); if(!m) return;
          applyMatch(card, m, false);   // Selecting a medicine fills Code, Name, Category, Potency, Pack (per spec)
        });
      };
    }

    card.querySelector('.wi-accept').onclick = ()=> accept(card);
    card.querySelector('.wi-reject').onclick = ()=> reject(card);
  }

  function gather(card){
    const F = {}; card.querySelectorAll('[data-f]').forEach(el=> F[el.dataset.f]=el.value.trim());
    const item = buildItem({ intakeId:card.dataset.id, action:card.dataset.action, matchedId:card.dataset.match, fields:F });
    const notes = [card._reviewNote, ...(card._dupNotes||[])].filter(Boolean);
    if (notes.length) item.reviewNote = notes.join('; ').slice(0,300);
    return item;
  }


  async function accept(card){
    if (card._dupBlocking){ toast('Resolve the possible duplicate above first — Merge, Keep separate, or Ignore', true); return; }
    const item = gather(card);
    const v = validateItem(item);
    if (v!==true){ toast(v, true); return; }
    if (!G('apiPost')){ toast('Connect the backend first (Settings)', true); return; }
    const btn = card.querySelector('.wi-accept'); btn.disabled = true;
    try{
      const r = await apiPost({ action:'approveintake', items:[item] });
      const res = (r && r.results && r.results[0]) || {};
      toast('Intake accepted ✓' + (res.resultId?' · '+res.resultId:''));
      const wf = WF(); if (wf) wf.dispatch('INTAKE_APPROVED', { intakeId:card.dataset.id, resultId:res.resultId, action:res.action });
      if (res.undoId && res.undoExpiresAt){          // Phase 5 — older backends simply omit these, no banner shown
        _undoList.push({ undoId:res.undoId, intakeId:card.dataset.id, resultId:res.resultId,
          action:res.action||card.dataset.action, createdAt:new Date().toISOString(), expiresAt:res.undoExpiresAt });
      }
      _origByCard.delete(card.dataset.id);
      if (G('loadAll')) await G('loadAll')(false); else enhance();
    }catch(e){ toast(e.message, true); btn.disabled=false; }
  }

  async function reject(card){
    if (!confirm('Reject this intake?')) return;
    if (!G('apiPost')){ toast('Connect the backend first (Settings)', true); return; }
    const btn = card.querySelector('.wi-reject'); btn.disabled = true;
    try{
      await apiPost({ action:'rejectintake', intakeId:card.dataset.id });
      toast('Intake rejected');
      const wf = WF(); if (wf) wf.emit('INTAKE_REJECTED', { intakeId:card.dataset.id });
      _origByCard.delete(card.dataset.id);
      if (G('loadAll')) await G('loadAll')(false); else enhance();
    }catch(e){ toast(e.message, true); btn.disabled=false; }
  }

  /* ---------------- install (wrap app render fn) ---------------- */
  let wrapped = null;
  function install(){
    if (wrapped) return;
    wrapped = (typeof window.renderIntake==='function') ? window.renderIntake : function(){};
    window.renderIntake = function(){ try{ wrapped.apply(this,arguments); }catch(e){} try{ enhance(); }catch(e){} };
  }
  function boot(){ install();
    const v=D.getElementById('view-intake'); if(v && v.classList.contains('active')) enhance();
    seedUndoList();
  }
  if (D.readyState==='loading') D.addEventListener('DOMContentLoaded', boot); else boot();
})();
