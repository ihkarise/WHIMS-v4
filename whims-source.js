/* WHIMS v4.3 — Entry-source / audit UI.
   Load AFTER app.js (and after whims-orders.js). This module is purely additive:
   it wraps the app's render functions and decorates the DOM. It does NOT modify
   app.js, the backend, or any contract. Uses app globals: INV, apiGet, esc,
   toast, renderResults, openDetail, renderDash.

   Surfaces:
     • a source badge on each inventory row (📷 Lens · Camera / 🔍 HoloScan / 📝 WHIMS)
     • a source filter on the search view
     • provenance rows on the detail sheet (entered via, capture, created/edited by)
     • a "sourcestats" analytics panel on the dashboard (Today / Week / Month)

   Requires backend getInventory to expose entrySource / captureMode / created+updated
   audit fields (added v4.3). On older payloads those fields are blank and the UI degrades quietly. */
(function(){
  if (window.WHIMSSource) return;
  const D = document;
  const G = n => window[n];
  const esc = s => G('esc') ? G('esc')(s) : String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const inv = () => Array.isArray(G('INV')) ? G('INV') : [];
  const up = s => String(s==null?'':s).trim().toUpperCase();
  const titleCase = s => String(s||'').toLowerCase().replace(/\b\w/g,c=>c.toUpperCase()).replace(/_/g,' ');

  /* ---- backend detection (app.js keeps API/TOKEN as const — NOT on window —
         so the old `window.API` guard was always false. Read the cache app.js
         writes instead: whims_api / whims_token. apiGet/apiPost ARE on window. */
  function lsRaw(k){ try{ return localStorage.getItem('whims_'+k); }catch(e){ return null; } }
  function hasApiFn(){ return typeof G('apiGet')==='function'; }
  function hasToken(){ const r=lsRaw('token'); if(!r) return false; try{ return !!JSON.parse(r); }catch(e){ return !!r; } }
  function ready(){ return hasApiFn() && hasToken(); }

  /* ---------------- pure helpers (unit-tested) ---------------- */
  /** Coarse source bucket from an EntrySource enum value. */
  function srcKey(entry){ const e=up(entry);
    if (e==='WISE_LENS' || e==='VOICE_LENS') return 'lens';
    if (e==='HOLOSCAN') return 'holoscan';
    if (e==='WHIMS' || e==='WEB_PORTAL' || e==='MOBILE_APP' || e==='') return 'whims';
    return 'other'; }
  /** Friendly capture-mode label. */
  function capLabel(cap){ const c=up(cap);
    return c==='CAMERA'?'Camera':c==='GALLERY'?'Gallery':c==='VOICE'?'Voice':c?titleCase(c):''; }
  /** Display metadata for a badge: {key,emoji,label,sub,text}. */
  function srcMeta(entry, cap){
    const k=srcKey(entry);
    const base={ lens:{emoji:'📷',label:'Lens'}, holoscan:{emoji:'🔍',label:'HoloScan'},
                 whims:{emoji:'📝',label:'WHIMS'}, other:{emoji:'•',label:titleCase(entry)||'Other'} }[k];
    const sub = (k==='lens') ? capLabel(cap) : '';
    return { key:k, emoji:base.emoji, label:base.label, sub, text: base.emoji+' '+base.label+(sub?' · '+sub:'') }; }
  /** Does an item pass the active source + capture filter? */
  function matchFilter(entry, cap, srcFilter, capFilter){
    if (srcFilter && srcFilter!=='all' && srcKey(entry)!==srcFilter) return false;
    if (capFilter && capFilter!=='all' && up(cap)!==up(capFilter)) return false;
    return true; }
  /** Sort a {key:count} map into ranked rows with percentages. */
  function statRows(obj, total){ obj=obj||{};
    return Object.keys(obj).sort((a,b)=>obj[b]-obj[a])
      .map(k=>({ key:k, count:obj[k], pct: total?Math.round(obj[k]/total*100):0 })); }

  const STATE = { src:'all', cap:'all', range:'today', loadedRange:null };
  let _statSeq = 0;

  window.WHIMSSource = { srcKey, srcMeta, capLabel, matchFilter, statRows,
    setFilter, decorate, reloadStats, _state:STATE };

  /* ---------------- inventory-row badges + filtering ---------------- */
  function decorate(){
    const map={}; inv().forEach(m=>{ map[up(m.id)]=m; });
    D.querySelectorAll('#results .med').forEach(row=>{
      const meta=row.querySelector('.meta'); if(!meta) return;
      const old=meta.querySelector('.src-badge'); if(old) old.remove();
      const id = (meta.textContent.split('·')[0]||'').trim().toUpperCase();
      const m = map[id]; if(!m){ row.style.display=''; return; }
      if (m.entrySource){
        const span=D.createElement('span');
        const sm=srcMeta(m.entrySource, m.captureMode);
        span.className='badge src-badge src-'+sm.key; span.textContent='· '+sm.text;
        meta.appendChild(span);
      }
      row.style.display = matchFilter(m.entrySource, m.captureMode, STATE.src, STATE.cap) ? '' : 'none';
    });
  }

  function setFilter(src, cap){
    if (src!=null) STATE.src=src; if (cap!=null) STATE.cap=cap;
    const f=D.getElementById('src-filter');
    if (f) f.querySelectorAll('[data-src]').forEach(b=>b.classList.toggle('on', b.dataset.src===STATE.src));
    const rr=G('renderResults'); if (typeof rr==='function') rr(); else decorate();
  }

  function mountFilter(){
    if (D.getElementById('src-filter')) return;
    const chips=D.getElementById('chips'); if(!chips) return;
    const bar=D.createElement('div'); bar.className='src-filter'; bar.id='src-filter';
    bar.innerHTML =
      '<span class="src-flabel">Source</span>'+
      '<button class="src-chip on" data-src="all">All</button>'+
      '<button class="src-chip" data-src="lens">📷 Lens</button>'+
      '<button class="src-chip" data-src="holoscan">🔍 HoloScan</button>'+
      '<button class="src-chip" data-src="whims">📝 WHIMS</button>';
    chips.parentNode.insertBefore(bar, chips.nextSibling);
    bar.addEventListener('click', e=>{ const b=e.target.closest('[data-src]'); if(!b) return; setFilter(b.dataset.src); });
  }

  /* ---------------- detail-sheet provenance ---------------- */
  function decorateDetail(m){
    if(!m) return;
    const badges=D.getElementById('dBadges');
    if (badges && m.entrySource){
      badges.querySelectorAll('.src-badge').forEach(n=>n.remove());
      const sm=srcMeta(m.entrySource, m.captureMode);
      const span=D.createElement('span'); span.className='badge src-badge src-'+sm.key; span.textContent=sm.text;
      badges.appendChild(span);
    }
    const kv=D.getElementById('dKv');
    if (kv){
      kv.querySelectorAll('.src-kv').forEach(n=>n.remove());
      const sm=srcMeta(m.entrySource, m.captureMode);
      const add=(val,label)=>{ if(val==null||val==='') return;
        const d=D.createElement('div'); d.className='src-kv'; d.innerHTML='<b>'+esc(val)+'</b><span>'+esc(label)+'</span>'; kv.appendChild(d); };
      if (m.entrySource) add(sm.text,'Entered via');
      if (m.captureMode) add(capLabel(m.captureMode),'Capture mode');
      add(m.createdBy,'Created by'); add(m.createdAt,'Created at');
      add(m.updatedBy,'Last edited by'); add(m.updatedAt,'Last edited');
      if (m.originalSource && up(m.originalSource)!==up(m.entrySource)) add(titleCase(m.originalSource),'Original source');
    }
  }

  /* ---------------- sourcestats analytics panel ---------------- */
  function mountStats(){
    if (D.getElementById('src-stats')) return true;
    const dash=D.getElementById('view-dash'); if(!dash) return false;
    const grid=D.getElementById('statGrid');
    const panel=D.createElement('div'); panel.className='src-stats card glass'; panel.id='src-stats';
    panel.innerHTML =
      '<div class="src-stats-head"><span class="t">Entry sources</span>'+
        '<span class="src-range" id="src-range">'+
          '<button data-range="today" class="on">Today</button>'+
          '<button data-range="week">Week</button>'+
          '<button data-range="month">Month</button></span></div>'+
      '<div class="src-total" id="src-total"></div>'+
      '<div id="src-stats-body"><div class="src-empty">Loading…</div></div>';
    if (grid && grid.parentNode) grid.parentNode.insertBefore(panel, grid.nextSibling);
    else dash.insertBefore(panel, dash.firstChild);
    panel.querySelector('#src-range').addEventListener('click', e=>{
      const b=e.target.closest('[data-range]'); if(!b) return;
      panel.querySelectorAll('#src-range button').forEach(x=>x.classList.toggle('on', x===b));
      reloadStats(b.dataset.range);
    });
    return true;
  }

  async function reloadStats(range){
    if (range) STATE.range=range;
    if (!mountStats()) return;
    const body=D.getElementById('src-stats-body');
    const ag=G('apiGet');
    if (!hasApiFn() || !hasToken()){
      if (body) body.innerHTML='<div class="src-empty">Connect the backend to see source analytics.</div>';
      return;
    }
    const myseq=++_statSeq;                       // only the latest request paints
    if (body) body.innerHTML='<div class="src-empty">Loading…</div>';
    try{
      const data=await ag('sourceanalytics', { range: STATE.range }); // v4.3-a range-aware action
      if (myseq!==_statSeq) return;
      paintStats(data); STATE.loadedRange=STATE.range;
    }catch(e){
      if (myseq!==_statSeq) return;
      // Older backend without 'sourceanalytics' → fall back to the legacy flat
      // inventory-composition counts so the panel still shows something useful.
      if (/unknown action/i.test(e.message||'')){
        try{
          const flat=await ag('sourcestats');
          if (myseq!==_statSeq) return;
          paintLegacy(flat); STATE.loadedRange=STATE.range; return;
        }catch(e2){}
      }
      if (body) body.innerHTML='<div class="src-empty">Could not load analytics — '+esc(e.message||'try again')+'</div>';
    }
  }

  function paintStats(data){
    data=data||{}; const total=data.total||0;
    const totalEl=D.getElementById('src-total'); const body=D.getElementById('src-stats-body');
    if (totalEl) totalEl.textContent = total+' transaction'+(total===1?'':'s')+' · '+esc(data.from||'')+' → '+esc(data.to||'');
    if (!body) return;
    if (!total){ body.innerHTML='<div class="src-empty">No activity in this range yet.</div>'; return; }
    const bar=(label,count,pct,cls)=>'<div class="src-bar"><div class="src-bar-top"><span>'+esc(label)+'</span><b>'+count+'</b></div>'+
      '<div class="src-track '+(cls||'')+'"><i style="width:'+pct+'%"></i></div></div>';
    let h='';
    const src=statRows(data.bySource,total);
    if (src.length){ h+='<div class="src-group"><div class="g-cap">By source</div>'+
      src.map(r=>bar(srcMeta(r.key,'').text, r.count, r.pct, '')).join('')+'</div>'; }
    const cap=statRows(data.byCapture,total);
    if (cap.length){ h+='<div class="src-group"><div class="g-cap">By capture</div>'+
      cap.map(r=>bar(capLabel(r.key)||titleCase(r.key), r.count, r.pct, 'cap')).join('')+'</div>'; }
    const act=statRows(data.byAction,total);
    if (act.length){ h+='<div class="src-group"><div class="g-cap">By action</div>'+
      act.map(r=>bar(titleCase(r.key), r.count, r.pct, 'act')).join('')+'</div>'; }
    body.innerHTML=h;
  }

  /* Fallback renderer for the legacy flat shape { WHIMS, WISE_LENS, HOLOSCAN }
     (current inventory composition) when the range-aware action is unavailable. */
  function paintLegacy(flat){
    flat=flat||{}; const body=D.getElementById('src-stats-body'); const totalEl=D.getElementById('src-total');
    const rows=[['WHIMS',flat.WHIMS||0],['WISE_LENS',flat.WISE_LENS||0],['HOLOSCAN',flat.HOLOSCAN||0]]
      .map(r=>({key:r[0],count:r[1]})).sort((a,b)=>b.count-a.count);
    const total=rows.reduce((s,r)=>s+r.count,0);
    if (totalEl) totalEl.textContent=total+' medicine'+(total===1?'':'s')+' · by entry source (current inventory)';
    if (!body) return;
    if (!total){ body.innerHTML='<div class="src-empty">No source data on the inventory yet.</div>'; return; }
    const bar=(label,count,pct)=>'<div class="src-bar"><div class="src-bar-top"><span>'+esc(label)+'</span><b>'+count+'</b></div>'+
      '<div class="src-track"><i style="width:'+pct+'%"></i></div></div>';
    body.innerHTML='<div class="src-group"><div class="g-cap">By source</div>'+
      rows.map(r=>bar(srcMeta(r.key,'').text, r.count, total?Math.round(r.count/total*100):0)).join('')+'</div>';
  }

  /* ---------------- install (wrap app render fns) ---------------- */
  let wrappedResults=null, wrappedDetail=null, wrappedDash=null;
  function install(){
    if (!wrappedResults && typeof G('renderResults')==='function'){
      wrappedResults=G('renderResults');
      window.renderResults=function(){ try{ wrappedResults.apply(this,arguments); }catch(e){} try{ decorate(); }catch(e){} };
    }
    if (!wrappedDetail && typeof G('openDetail')==='function'){
      wrappedDetail=G('openDetail');
      window.openDetail=function(m){ try{ wrappedDetail.apply(this,arguments); }catch(e){} try{ decorateDetail(m); }catch(e){} };
    }
    if (!wrappedDash && typeof G('renderDash')==='function'){
      wrappedDash=G('renderDash');
      window.renderDash=function(){ try{ wrappedDash.apply(this,arguments); }catch(e){} try{ afterDash(); }catch(e){} };
    }
  }
  function afterDash(){ if (mountStats() && STATE.loadedRange!==STATE.range) reloadStats(); }

  function boot(){ install(); mountFilter(); mountStats(); decorate();
    // first analytics load happens lazily when the dashboard renders / when ready
    if (ready()) reloadStats();
  }
  if (D.readyState==='loading') D.addEventListener('DOMContentLoaded', boot); else boot();
})();
