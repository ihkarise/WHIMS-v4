/* WHIMS v4.1 — Orders lifecycle, integrated into the existing "Orders" tab.
   Load AFTER app.js (and after whims-v41.js). Mounts a shared-order board at the
   top of #view-orders and tags the legacy reorder rows with an "on order" pill,
   so orders set in WHIMS *or* HoloScan are visible and nothing is ordered twice.
   Uses app globals: apiPost, toast, esc, INV, renderOrders, loadAll. */
(function(){
  if (window.WHIMSOrders) return;
  const LS_WA='whims_supplier_wa';
  let CACHE=[], legacyRender=null;
  const D=document;

  const G=n=>window[n];
  const Core=()=>(window.WHIMS&&window.WHIMS.Core)||null;
  const WF=()=>(window.WHIMS&&window.WHIMS.Workflow)||null;
  const emitOrderEvent=(ev,payload)=>{ const w=WF(); if(w){ try{ w.dispatch(ev,payload); }catch(e){} } };
  const esc=s=>G('esc')?G('esc')(s):String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const toast=(m,e)=>{ const t=G('toast'); if(t)t(m,e); else console.log(m); };
  async function call(body){ const ap=G('apiPost'); if(!ap)throw new Error('WHIMS API not ready');
    const r=await ap(body); return (r&&typeof r==='object'&&'ok'in r&&'data'in r)?r.data:r; }
  /** Inventory accessor for this module's own use (the add-to-cart search).
   *  `let INV` in app.js is a top-level lexical binding, not a `window`
   *  property — so the old `G('INV')` check was always [] in production,
   *  silently breaking renderSearch() while everything else (forecastMap,
   *  which calls Core.Intelligence directly) kept working, because Core's
   *  own data.inventory() already does the correct window→localStorage
   *  fallback. Delegate to that same accessor instead of duplicating it. */
  const inv=()=>{ const c=Core(); if(c) return c.data.inventory();
    return Array.isArray(G('INV'))?G('INV'):[]; };  // graceful fallback only if Core failed to load
  function timeAgo(s){ const t=Date.parse((s||'').replace(' ','T')); if(isNaN(t))return''; const d=Math.floor((Date.now()-t)/1000);
    if(d<60)return'just now'; if(d<3600)return Math.floor(d/60)+'m ago'; if(d<86400)return Math.floor(d/3600)+'h ago'; return Math.floor(d/86400)+'d ago'; }
  function waMap(){ try{return JSON.parse(localStorage.getItem(LS_WA)||'{}');}catch(e){return{};} }
  function waSet(m){ try{localStorage.setItem(LS_WA,JSON.stringify(m));}catch(e){} }

  function activeFor(medId){ const id=String(medId).toUpperCase();
    return CACHE.find(l=>String(l.medId).toUpperCase()===id&&l.status!=='VOID'&&l.status!=='RECEIVED')||null; }
  window.WHIMSOrders={ activeFor, reload:()=>load().then(paint), board:()=>D.getElementById('wo-board') };

  /* ---- mount the board inside the existing Orders tab (once) ---- */
  function mount(){
    if (D.getElementById('wo-board')) return true;
    const view=D.getElementById('view-orders'); if(!view) return false;
    const board=D.createElement('div'); board.id='wo-board';
    board.innerHTML=
      '<div class="wo-head">Live orders <span class="wo-sub">— shared with HoloScan, so nothing is ordered twice</span></div>'+
      '<input class="wo-search" id="wo-search" placeholder="add to cart — name or id (e.g. ABROMA / MT003)" autocapitalize="characters">'+
      '<div class="wo-res" id="wo-res"></div>'+
      '<div id="wo-body"></div>'+
      '<div class="wo-btns"><button class="wo-btn wo-ghost" id="wo-refresh">↻ Refresh</button>'+
        '<button class="wo-btn wo-ghost" id="wo-watoggle">📱 Supplier numbers</button></div>'+
      '<div id="wo-waform" style="display:none">'+
        '<input class="wo-search" id="wo-wasup" placeholder="SUPPLIER e.g. BAKSON" autocapitalize="characters" style="margin:6px 0">'+
        '<input class="wo-search" id="wo-wanum" placeholder="number with country code e.g. 919876543210">'+
        '<div class="wo-btns"><button class="wo-btn wo-primary" id="wo-wasave">Save number</button></div>'+
        '<div id="wo-walist"></div></div>'+
      '<div class="wo-legacy-cap">Reorder suggestions (by priority)</div>';
    const title=view.querySelector('.view-title');
    if(title&&title.nextSibling) view.insertBefore(board,title.nextSibling);
    else view.insertBefore(board, view.firstChild);

    D.getElementById('wo-refresh').onclick=()=>load().then(paint);
    D.getElementById('wo-search').oninput=e=>renderSearch(e.target.value);
    D.getElementById('wo-watoggle').onclick=()=>{ const f=D.getElementById('wo-waform');
      f.style.display=f.style.display==='none'?'':'none'; if(f.style.display==='')renderWa(); };
    D.getElementById('wo-wasave').onclick=saveWa;
    D.getElementById('wo-body').addEventListener('click',onBody);
    return true;
  }

  /* ---- wrap the app's renderOrders: legacy list + our board + row tags ---- */
  function install(){
    if (legacyRender) return;
    legacyRender = (typeof window.renderOrders==='function') ? window.renderOrders : function(){};
    window.renderOrders = function(){ try{legacyRender.apply(this,arguments);}catch(e){} afterOrders(); };
  }
  function afterOrders(){ if(!mount())return; render(); decorate(); load().then(paint); }
  function paint(){ render(); decorate(); }

  function cart(){ return CACHE.filter(l=>l.status==='CART'); }
  /** Single Core.Intelligence call per render, reused by every cart row — the
   *  Order Engine never calculates Current Stock / Usage / Suggested Qty itself. */
  function forecastMap(){
    const c=Core(); if(!c) return {};
    try{
      const rows=c.Intelligence.calculateForecastInputs();
      const map={}; rows.forEach(r=>map[String(r.id).toUpperCase()]=r);
      return map;
    }catch(e){ return {}; }
  }
  function groups(){ const map={},ord=[]; CACHE.forEach(l=>{ if(l.status!=='ORDERED'&&l.status!=='PURCHASED')return;
    if(!map[l.orderId]){map[l.orderId]={id:l.orderId,status:l.status,supplier:l.supplier,by:l.updatedBy,updated:l.updated,lines:[]};ord.push(l.orderId);}
    map[l.orderId].lines.push(l); if(l.status==='ORDERED')map[l.orderId].status='ORDERED'; }); return ord.map(i=>map[i]); }

  const PRI_LABEL=['None','Low','Medium','High','Urgent','Critical'];
  function priOptions(sel){ return [0,1,2,3,4,5].map(p=>'<option value="'+p+'"'+(p===sel?' selected':'')+'>'+PRI_LABEL[p]+'</option>').join(''); }

  function render(){
    const body=D.getElementById('wo-body'); if(!body)return;
    const c=cart(), gs=groups(), fc=forecastMap();
    let h='<div class="wo-cap">Cart ('+c.length+')</div>';
    if(!c.length) h+='<div class="wo-note">Cart is empty. Search above to add a medicine to reorder.</div>';
    else{
      h+='<div class="wo-bulkbar" id="wo-bulkbar" style="display:none">'+
        '<span id="wo-bulkcount">0 selected</span>'+
        '<div class="wo-bulkbtns">'+
          '<button class="wo-bx" data-bulk="qty">Qty</button>'+
          '<button class="wo-bx" data-bulk="supplier">Supplier</button>'+
          '<button class="wo-bx" data-bulk="priority">Priority</button>'+
          '<button class="wo-bx" data-bulk="delete">Delete</button>'+
          '<button class="wo-bx" data-bulk="export">Export ▾</button>'+
          '<button class="wo-bx" data-bulk="print">Print</button>'+
        '</div></div>';
      c.forEach(l=>{
        const f=fc[String(l.medId).toUpperCase()];
        h+='<div class="wo-card" data-line="'+esc(l.lineId)+'" data-med="'+esc(l.medId)+'">'+
          '<div class="wo-cardhead">'+
            '<label class="wo-chk"><input type="checkbox" class="wo-sel" data-line="'+esc(l.lineId)+'"></label>'+
            '<div class="wo-cardtitle"><b>'+esc(l.medId)+'</b> '+esc(l.medName)+(l.pack?' <span class="wo-meta">'+esc(l.pack)+'</span>':'')+'</div>'+
            '<button class="wo-x2" data-a="rm" data-l="'+esc(l.lineId)+'" title="Remove">✕</button>'+
          '</div>'+
          '<div class="wo-cardgrid">'+
            '<div class="wo-fld"><label>Supplier</label><input class="wo-finput" data-f="supplier" data-line="'+esc(l.lineId)+'" value="'+esc(l.supplier||'')+'"></div>'+
            '<div class="wo-fld"><label>Priority</label><select class="wo-finput" data-f="priority" data-line="'+esc(l.lineId)+'">'+priOptions(l.priority||0)+'</select></div>'+
            '<div class="wo-fld"><label>Quantity</label><div class="wo-qtywrap">'+
              '<button class="wo-step" data-a="q" data-l="'+esc(l.lineId)+'" data-d="-1">−</button>'+
              '<input class="wo-finput wo-qtyinput" data-f="qty" data-line="'+esc(l.lineId)+'" type="number" min="1" value="'+l.qtyOrdered+'">'+
              '<button class="wo-step" data-a="q" data-l="'+esc(l.lineId)+'" data-d="1">+</button></div></div>'+
            '<div class="wo-fld"><label>Est. Cost</label><input class="wo-finput" data-f="unitCost" data-line="'+esc(l.lineId)+'" type="number" min="0" step="0.01" value="'+(l.unitCost||'')+'" placeholder="₹/unit"></div>'+
            '<div class="wo-fld wo-fld-wide"><label>Notes</label><input class="wo-finput" data-f="remarks" data-line="'+esc(l.lineId)+'" value="'+esc(l.remarks||'')+'" placeholder="optional note"></div>'+
          '</div>'+
          (f?'<div class="wo-suggest"><span>Current stock <b>'+f.currentStock+'</b></span>'+
            '<span>Avg weekly use <b>'+f.avgWeeklyUsage+'</b></span>'+
            (f.daysRemaining!=null?'<span>Days left <b>'+f.daysRemaining+'</b></span>':'')+
            '<span>Suggested <b>'+f.recommendedQty+'</b></span>'+
            (f.recommendedQty>0?'<button class="wo-usesuggest" data-line="'+esc(l.lineId)+'" data-qty="'+f.recommendedQty+'">Use '+f.recommendedQty+'</button>':'')+
            '</div>':'')+
        '</div>';
      });
      h+='<div class="wo-btns"><button class="wo-btn wo-primary" data-a="place">🧾 Place order</button></div>'; }
    gs.forEach(grp=>{ h+='<div class="wo-pog"><div class="wo-pohead"><span class="wo-tag">'+esc(grp.id)+(grp.supplier?' · '+esc(grp.supplier):'')+
        '</span><span class="wo-status wo-s-'+grp.status+'">'+grp.status+'</span></div>'+
        '<div class="wo-meta">set by '+esc(grp.by||'staff')+(grp.updated?' · '+timeAgo(grp.updated):'')+'</div>';
      grp.lines.forEach(l=>{ h+='<div class="wo-row"><div class="wo-top"><b>'+esc(l.medId)+'</b> '+esc(l.medName)+' <span class="wo-meta">× '+l.qtyOrdered+(l.supplier?' · '+esc(l.supplier):'')+'</span></div></div>'; });
      h+='<div class="wo-btns"><button class="wo-btn wo-ghost" data-a="wa" data-o="'+grp.id+'">📱 WhatsApp</button>'+
        (grp.status==='ORDERED'?'<button class="wo-btn wo-ghost" data-a="pur" data-o="'+grp.id+'">✓ Purchased</button>':'')+
        '<button class="wo-btn wo-primary" data-a="rcv" data-o="'+grp.id+'">📦 Received</button>'+
        '<button class="wo-btn wo-danger" data-a="void" data-o="'+grp.id+'">Void</button></div></div>'; });
    if(!c.length&&!gs.length) h+='<div class="wo-note" style="margin-top:6px">No open orders right now.</div>';
    body.innerHTML=h;
    wireCartFields();
    wireBulk();
  }

  /* tag legacy reorder rows already on an active order (from either app) */
  function decorate(){
    [...D.querySelectorAll('#orderList .orow')].forEach(row=>{
      const id=row.getAttribute('data-id'); const old=row.querySelector('.wo-onorder'); if(old)old.remove();
      const a=activeFor(id); if(!a)return;
      const pill=D.createElement('span'); pill.className='wo-onorder';
      pill.textContent='on order · '+a.orderId+' · '+a.status;
      const nm=row.querySelector('.nm'); (nm||row).appendChild(pill);
    });
  }

  function arm(btn,onConfirm){ if(btn.dataset.armed==='1'){btn.dataset.armed='0';btn.classList.remove('wo-armed');clearTimeout(btn._t);onConfirm();return;}
    btn.dataset.armed='1';btn.classList.add('wo-armed');const txt=btn.textContent;btn.textContent='Tap again to confirm';
    clearTimeout(btn._t);btn._t=setTimeout(()=>{btn.dataset.armed='0';btn.classList.remove('wo-armed');btn.textContent=txt;},4000); }

  function onBody(e){ const b=e.target.closest('button'); if(!b||!b.dataset.a)return; const a=b.dataset.a;
    if(a==='q')qty(b.dataset.l,parseInt(b.dataset.d,10));
    else if(a==='rm')remove(b.dataset.l);
    else if(a==='place')arm(b,place);
    else if(a==='wa')whatsapp(b.dataset.o);
    else if(a==='pur')arm(b,()=>advance(b.dataset.o,'PURCHASED'));
    else if(a==='rcv')arm(b,()=>advance(b.dataset.o,'RECEIVED'));
    else if(a==='void')arm(b,()=>advance(b.dataset.o,'VOID')); }

  /** Phase A — Smart Order Engine: field edits (Quantity/Supplier/Priority/Notes/Est.
   *  Cost) on an existing cart line go through orderupdate, which never touches
   *  Inventory (unlike orderAdd's bridgeSetPriority side effect on a brand-new add). */
  async function updateLine(lineId, fields){
    try{ await call(Object.assign({action:'orderupdate',lineId}, fields));
      await load(); render(); emitOrderEvent('ORDER_UPDATED',{lineId,fields});
    }catch(err){ toast('Failed: '+err.message,1); render(); }
  }
  function wireCartFields(){
    D.querySelectorAll('.wo-finput[data-f]:not(.wo-qtyinput)').forEach(el=>{
      el.onblur=()=>{
        const lineId=el.dataset.line, f=el.dataset.f;
        const cur=CACHE.find(l=>l.lineId===lineId); if(!cur) return;
        let val=el.value;
        if(f==='priority') val=parseInt(val,10)||0;
        if(f==='unitCost') val=(val===''?'':parseFloat(val));
        const curVal = f==='priority'?(cur.priority||0):(cur[f]==null?'':cur[f]);
        if(String(val)===String(curVal)) return;
        updateLine(lineId,{[f]:val});
      };
    });
    D.querySelectorAll('.wo-qtyinput').forEach(el=>{
      el.onblur=()=>{
        const lineId=el.dataset.line; const cur=CACHE.find(l=>l.lineId===lineId); if(!cur) return;
        const n=parseInt(el.value,10);
        if(!n||n<=0){ toast('Quantity must be greater than 0',1); el.value=cur.qtyOrdered; return; }
        if(n===cur.qtyOrdered) return;
        updateLine(lineId,{qty:n});
      };
    });
    D.querySelectorAll('.wo-usesuggest').forEach(b=>{
      b.onclick=()=>updateLine(b.dataset.line,{qty:parseInt(b.dataset.qty,10)}); // suggestion is a click-to-fill, never automatic
    });
  }

  /* ---- Phase A — Bulk Order Operations: reuses Core.Bulk (Layer 3) for execution;
     this module only supplies the per-item action, never its own loop/retry logic. */
  function bulkSelected(){ return Array.from(D.querySelectorAll('.wo-sel:checked')).map(cb=>cb.dataset.line); }
  function updateBulkBar(){
    const sel=bulkSelected(); const bar=D.getElementById('wo-bulkbar'); if(!bar) return;
    bar.style.display = sel.length ? '' : 'none';
    const cnt=D.getElementById('wo-bulkcount'); if(cnt) cnt.textContent=sel.length+' selected';
  }
  function wireBulk(){
    D.querySelectorAll('.wo-sel').forEach(cb=>cb.onchange=updateBulkBar);
    const bar=D.getElementById('wo-bulkbar'); if(!bar) return;
    bar.querySelectorAll('[data-bulk]').forEach(b=>b.onclick=()=>runBulk(b.dataset.bulk));
    updateBulkBar();
  }
  async function bulkRun(ids, handler){
    const c=Core();
    if(c) return c.Bulk.run(ids, handler, { concurrency:1 });        // reuse the engine
    const results=[]; for(const id of ids){ try{ results.push(await handler(id)); }catch(e){} } return { results }; // graceful fallback only if Core failed to load
  }
  async function runBulk(kind){
    const ids=bulkSelected();
    if(!ids.length){ toast('Select at least one item first',1); return; }
    if(kind==='delete'){
      if(!confirm('Remove '+ids.length+' item(s) from the cart?'))return;
      await bulkRun(ids, lineId=>call({action:'orderremove',lineId}));
      await load(); render(); refreshLegacy(); emitOrderEvent('ORDER_DELETED',{lineIds:ids});
      toast('✓ Removed '+ids.length+' item(s)'); return;
    }
    if(kind==='export'){ exportMenu(ids); return; }
    if(kind==='print'){ printPO(ids); return; }
    if(kind==='qty'){
      const v=prompt('Set quantity for '+ids.length+' item(s):'); if(v==null) return;
      const n=parseInt(v,10); if(!n||n<=0){ toast('Enter a valid quantity',1); return; }
      await bulkRun(ids, lineId=>call({action:'orderupdate',lineId,qty:n}));
    } else if(kind==='supplier'){
      const v=prompt('Set supplier for '+ids.length+' item(s):'); if(v==null||!v.trim()) return;
      await bulkRun(ids, lineId=>call({action:'orderupdate',lineId,supplier:v.trim()}));
    } else if(kind==='priority'){
      const v=prompt('Set priority 0-5 for '+ids.length+' item(s):','3'); if(v==null) return;
      const p=parseInt(v,10); if(isNaN(p)||p<0||p>5){ toast('Priority must be 0-5',1); return; }
      await bulkRun(ids, lineId=>call({action:'orderupdate',lineId,priority:p}));
    } else return;
    await load(); render(); emitOrderEvent('ORDER_UPDATED',{lineIds:ids,kind}); toast('✓ Updated '+ids.length+' item(s)');
  }
  async function load(){ try{ CACHE=await call({action:'orders'})||[]; }catch(err){ toast('Orders: '+err.message,1); CACHE=[]; } }
  function refreshLegacy(){ try{ legacyRender&&legacyRender(); }catch(e){} decorate(); }

  async function addToCart(id){
    const dup=activeFor(id);
    if(dup&&dup.status!=='CART'&&!confirm(id+' is already on order ('+dup.orderId+' · '+dup.status+'). Add again anyway?'))return;
    const cur=CACHE.find(l=>l.status==='CART'&&l.medId===id); const qn=(cur?cur.qtyOrdered:0)+1;
    try{ await call({action:'orderadd',id,qty:qn}); D.getElementById('wo-search').value=''; D.getElementById('wo-res').innerHTML='';
      await load(); render(); refreshLegacy(); toast('✓ '+id+' in cart × '+qn); }catch(err){ toast('Failed: '+err.message,1); } }
  async function qty(lineId,d){ const cur=CACHE.find(l=>l.lineId===lineId); if(!cur)return;
    const qn=Math.max(1,cur.qtyOrdered+d); if(qn===cur.qtyOrdered&&d<0)return;
    await updateLine(lineId,{qty:qn}); }
  async function remove(lineId){ try{ await call({action:'orderremove',lineId}); await load(); render(); refreshLegacy();
      emitOrderEvent('ORDER_DELETED',{lineId}); toast('✓ Removed'); }catch(err){ toast('Failed: '+err.message,1); } }
  async function place(){ try{ const r=await call({action:'orderplace'}); await load(); render(); refreshLegacy();
      emitOrderEvent('ORDER_CREATED',{orderId:r.orderId,count:r.count});
      toast('✓ Placed '+r.orderId+' ('+r.count+' item'+(r.count>1?'s':'')+')'); }catch(err){ toast('Failed: '+err.message,1); } }
  async function advance(orderId,status){ try{ const r=await call({action:'orderstatus',orderId,status});
      if(status==='RECEIVED'){ if(G('loadAll'))try{await G('loadAll')();}catch(e){} toast('✓ Received — stock updated ('+r.updated+')'); }
      else if(status==='VOID')toast('✓ Voided'); else toast('✓ Marked '+status.toLowerCase());
      await load(); render(); refreshLegacy(); emitOrderEvent('ORDER_UPDATED',{orderId,status}); }catch(err){ toast('Failed: '+err.message,1); } }
  /* ---- Phase A — Export: CSV/Excel use a Blob download (no library needed — Excel
     opens CSV natively); PDF/Print use the browser's own print dialog (print-to-PDF
     is a standard OS/browser capability, so no PDF library is bundled either). */
  function linesFor(ids){ const set=new Set(ids); return CACHE.filter(l=>set.has(l.lineId)); }
  function csvEscape(v){ v=String(v==null?'':v); return /[",\n]/.test(v) ? '"'+v.replace(/"/g,'""')+'"' : v; }
  function toCsv(lines){
    const head=['Code','Name','Supplier','Qty','Unit','Priority','Est. Cost','Notes','Status'];
    const rows=lines.map(l=>[l.medId,l.medName,l.supplier,l.qtyOrdered,l.pack,PRI_LABEL[l.priority||0],l.unitCost||'',l.remarks||'',l.status]);
    return [head,...rows].map(r=>r.map(csvEscape).join(',')).join('\r\n');
  }
  function downloadBlob(text,filename,mime){
    const blob=new Blob([text],{type:mime}); const url=URL.createObjectURL(blob);
    const a=D.createElement('a'); a.href=url; a.download=filename; a.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  function exportMenu(ids){
    const choice=prompt('Export '+ids.length+' item(s) as:\n1 = CSV\n2 = Excel\n3 = Printable PO\n4 = Supplier-wise PO','1');
    if(choice==null) return;
    const lines=linesFor(ids);
    if(choice==='1') downloadBlob(toCsv(lines),'wise-order-'+Date.now()+'.csv','text/csv');
    else if(choice==='2') downloadBlob(toCsv(lines),'wise-order-'+Date.now()+'.xls','application/vnd.ms-excel');
    else if(choice==='3') printPO(ids,false);
    else if(choice==='4') printPO(ids,true);
  }
  function poHtml(lines,bySupplier){
    const groupRows = bySupplier
      ? Object.entries(lines.reduce((m,l)=>{ const k=l.supplier||'Unassigned'; (m[k]=m[k]||[]).push(l); return m; },{}))
      : [['Purchase Order', lines]];
    let h='<h1>Wise Homeopathy — Purchase Order'+(bySupplier?'s (by supplier)':'')+'</h1>'+
      '<div class="po-meta">'+new Date().toLocaleString()+'</div>';
    groupRows.forEach(([supplier,rows])=>{
      h+='<h2>'+esc(supplier)+'</h2><table><thead><tr><th>Code</th><th>Name</th><th>Unit</th><th>Qty</th><th>Priority</th><th>Est. Cost</th><th>Notes</th></tr></thead><tbody>'+
        rows.map(l=>'<tr><td>'+esc(l.medId)+'</td><td>'+esc(l.medName)+'</td><td>'+esc(l.pack||'')+'</td><td>'+l.qtyOrdered+
          '</td><td>'+PRI_LABEL[l.priority||0]+'</td><td>'+(l.unitCost?'₹'+l.unitCost:'')+'</td><td>'+esc(l.remarks||'')+'</td></tr>').join('')+
        '</tbody></table>';
    });
    return h;
  }
  function printPO(ids,bySupplier){
    const lines=linesFor(ids); if(!lines.length){ toast('Nothing to print',1); return; }
    const w=window.open('','_blank'); if(!w){ toast('Pop-up blocked — allow pop-ups to print',1); return; }
    w.document.write('<html><head><title>Wise Purchase Order</title><style>'+
      'body{font-family:Inter,system-ui,sans-serif;padding:24px;color:#1E293B}'+
      'h1{font-size:18px;color:#2A3C78}h2{font-size:14px;color:#2A3C78;margin-top:18px}'+
      '.po-meta{font-size:11px;color:#64748B;margin-bottom:10px}'+
      'table{width:100%;border-collapse:collapse;font-size:12px;margin-top:6px}'+
      'th,td{border:1px solid #E2E8F0;padding:6px 8px;text-align:left}th{background:#F8FAFC}'+
      '</style></head><body>'+poHtml(lines,bySupplier)+'</body></html>');
    w.document.close(); w.focus(); setTimeout(()=>w.print(),300);
  }

  function whatsapp(orderId){ const lines=CACHE.filter(l=>l.orderId===orderId); if(!lines.length){toast('Nothing to send.');return;}
    const sup=lines[0].supplier||''; const num=waMap()[String(sup).toUpperCase()]||'';
    const txt='Order '+orderId+(sup?' — '+sup:'')+'\n'+lines.map(l=>'• '+l.medName+' ('+l.medId+') × '+l.qtyOrdered).join('\n');
    window.open('https://wa.me/'+(num?num.replace(/[^\d]/g,''):'')+'?text='+encodeURIComponent(txt),'_blank');
    if(!num)toast('Tip: save '+(sup||'this supplier')+'’s number below.'); }

  const ORDER_SEARCH_FIELDS=['id','name','supplier1','supplier2','category','potency','barcode'];
  function renderSearch(q){ const box=D.getElementById('wo-res'); q=(q||'').trim();
    if(!q){box.innerHTML='';return;}
    const c=Core();
    let hits;
    if(c){ hits=c.Search.search(q, inv(), { fields:ORDER_SEARCH_FIELDS, limit:12 }); }   // reuse the Global Search Engine
    else{ // graceful fallback only if Core failed to load
      const Q=q.toUpperCase(); hits=[]; const seen=new Set();
      for(const it of inv()){ if(!it||!it.id||seen.has(it.id))continue;
        if(String(it.id).toUpperCase().includes(Q)||String(it.name||'').toUpperCase().includes(Q)){seen.add(it.id);hits.push(it);if(hits.length>=12)break;} }
    }
    if(!hits.length){box.innerHTML='<div class="wo-note">No match.</div>';return;}
    box.innerHTML=hits.map(it=>{ const on=activeFor(it.id);
      return '<button data-id="'+esc(it.id)+'"><b>'+esc(it.id)+'</b> '+esc(it.name)+
        '<span>'+(it.bottles!=null?it.bottles+' btl':'')+(it.supplier1?' · '+esc(it.supplier1):'')+'</span>'+
        (on?'<em class="wo-warn">already on order · '+esc(on.orderId)+' · '+on.status+'</em>':'')+'</button>'; }).join('');
    box.querySelectorAll('button[data-id]').forEach(b=>b.onclick=()=>addToCart(b.dataset.id)); }

  function renderWa(){ const m=waMap(),keys=Object.keys(m),box=D.getElementById('wo-walist');
    box.innerHTML=keys.length?keys.map(k=>'<div class="wo-row"><div class="wo-top"><b>'+esc(k)+'</b> '+esc(m[k])+'</div><button class="wo-x2" data-wa="'+esc(k)+'">✕</button></div>').join(''):'<div class="wo-note">No numbers saved.</div>';
    box.querySelectorAll('[data-wa]').forEach(b=>b.onclick=()=>{const m2=waMap();delete m2[b.dataset.wa];waSet(m2);renderWa();}); }
  function saveWa(){ const s=D.getElementById('wo-wasup').value.trim().toUpperCase(), n=D.getElementById('wo-wanum').value.trim();
    if(!s||!n){toast('Enter a supplier and number.',1);return;}
    const m=waMap();m[s]=n;waSet(m);D.getElementById('wo-wasup').value='';D.getElementById('wo-wanum').value='';renderWa();toast('✓ Saved '+s); }

  function boot(){ install();
    const v=D.getElementById('view-orders'); if(v&&v.classList.contains('active')) afterOrders(); }
  if (D.readyState==='loading') D.addEventListener('DOMContentLoaded',boot); else boot();
})();
