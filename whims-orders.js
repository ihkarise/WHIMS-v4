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
  const esc=s=>G('esc')?G('esc')(s):String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const toast=(m,e)=>{ const t=G('toast'); if(t)t(m,e); else console.log(m); };
  async function call(body){ const ap=G('apiPost'); if(!ap)throw new Error('WHIMS API not ready');
    const r=await ap(body); return (r&&typeof r==='object'&&'ok'in r&&'data'in r)?r.data:r; }
  const inv=()=>Array.isArray(G('INV'))?G('INV'):[];
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
  function groups(){ const map={},ord=[]; CACHE.forEach(l=>{ if(l.status!=='ORDERED'&&l.status!=='PURCHASED')return;
    if(!map[l.orderId]){map[l.orderId]={id:l.orderId,status:l.status,supplier:l.supplier,by:l.updatedBy,updated:l.updated,lines:[]};ord.push(l.orderId);}
    map[l.orderId].lines.push(l); if(l.status==='ORDERED')map[l.orderId].status='ORDERED'; }); return ord.map(i=>map[i]); }

  function render(){
    const body=D.getElementById('wo-body'); if(!body)return;
    const c=cart(), gs=groups();
    let h='<div class="wo-cap">Cart ('+c.length+')</div>';
    if(!c.length) h+='<div class="wo-note">Cart is empty. Search above to add a medicine to reorder.</div>';
    else{ c.forEach(l=>{ h+='<div class="wo-row"><div class="wo-top"><b>'+esc(l.medId)+'</b> '+esc(l.medName)+
        (l.supplier?'<div class="wo-meta">'+esc(l.supplier)+'</div>':'')+'</div>'+
        '<div class="wo-ctl"><button class="wo-step" data-a="q" data-m="'+esc(l.medId)+'" data-d="-1">−</button>'+
        '<span class="wo-qty">'+l.qtyOrdered+'</span>'+
        '<button class="wo-step" data-a="q" data-m="'+esc(l.medId)+'" data-d="1">+</button>'+
        '<button class="wo-x2" data-a="rm" data-l="'+esc(l.lineId)+'">✕</button></div></div>'; });
      h+='<div class="wo-btns"><button class="wo-btn wo-primary" data-a="place">🧾 Place order</button></div>'; }
    gs.forEach(grp=>{ h+='<div class="wo-pog"><div class="wo-pohead"><span class="wo-tag">'+esc(grp.id)+(grp.supplier?' · '+esc(grp.supplier):'')+
        '</span><span class="wo-status wo-s-'+grp.status+'">'+grp.status+'</span></div>'+
        '<div class="wo-meta">set by '+esc(grp.by||'staff')+(grp.updated?' · '+timeAgo(grp.updated):'')+'</div>';
      grp.lines.forEach(l=>{ h+='<div class="wo-row"><div class="wo-top"><b>'+esc(l.medId)+'</b> '+esc(l.medName)+' <span class="wo-meta">× '+l.qtyOrdered+'</span></div></div>'; });
      h+='<div class="wo-btns"><button class="wo-btn wo-ghost" data-a="wa" data-o="'+grp.id+'">📱 WhatsApp</button>'+
        (grp.status==='ORDERED'?'<button class="wo-btn wo-ghost" data-a="pur" data-o="'+grp.id+'">✓ Purchased</button>':'')+
        '<button class="wo-btn wo-primary" data-a="rcv" data-o="'+grp.id+'">📦 Received</button>'+
        '<button class="wo-btn wo-danger" data-a="void" data-o="'+grp.id+'">Void</button></div></div>'; });
    if(!c.length&&!gs.length) h+='<div class="wo-note" style="margin-top:6px">No open orders right now.</div>';
    body.innerHTML=h;
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
    if(a==='q')qty(b.dataset.m,parseInt(b.dataset.d,10));
    else if(a==='rm')remove(b.dataset.l);
    else if(a==='place')arm(b,place);
    else if(a==='wa')whatsapp(b.dataset.o);
    else if(a==='pur')arm(b,()=>advance(b.dataset.o,'PURCHASED'));
    else if(a==='rcv')arm(b,()=>advance(b.dataset.o,'RECEIVED'));
    else if(a==='void')arm(b,()=>advance(b.dataset.o,'VOID')); }

  async function load(){ try{ CACHE=await call({action:'orders'})||[]; }catch(err){ toast('Orders: '+err.message,1); CACHE=[]; } }
  function refreshLegacy(){ try{ legacyRender&&legacyRender(); }catch(e){} decorate(); }

  async function addToCart(id){
    const dup=activeFor(id);
    if(dup&&dup.status!=='CART'&&!confirm(id+' is already on order ('+dup.orderId+' · '+dup.status+'). Add again anyway?'))return;
    const cur=CACHE.find(l=>l.status==='CART'&&l.medId===id); const qn=(cur?cur.qtyOrdered:0)+1;
    try{ await call({action:'orderadd',id,qty:qn}); D.getElementById('wo-search').value=''; D.getElementById('wo-res').innerHTML='';
      await load(); render(); refreshLegacy(); toast('✓ '+id+' in cart × '+qn); }catch(err){ toast('Failed: '+err.message,1); } }
  async function qty(medId,d){ const cur=CACHE.find(l=>l.status==='CART'&&l.medId===medId); if(!cur)return;
    const qn=Math.max(1,cur.qtyOrdered+d); if(qn===cur.qtyOrdered&&d<0)return;
    try{ await call({action:'orderadd',id:medId,qty:qn}); await load(); render(); }catch(err){ toast('Failed: '+err.message,1); } }
  async function remove(lineId){ try{ await call({action:'orderremove',lineId}); await load(); render(); refreshLegacy(); toast('✓ Removed'); }catch(err){ toast('Failed: '+err.message,1); } }
  async function place(){ try{ const r=await call({action:'orderplace'}); await load(); render(); refreshLegacy(); toast('✓ Placed '+r.orderId+' ('+r.count+' item'+(r.count>1?'s':'')+')'); }catch(err){ toast('Failed: '+err.message,1); } }
  async function advance(orderId,status){ try{ const r=await call({action:'orderstatus',orderId,status});
      if(status==='RECEIVED'){ if(G('loadAll'))try{await G('loadAll')();}catch(e){} toast('✓ Received — stock updated ('+r.updated+')'); }
      else if(status==='VOID')toast('✓ Voided'); else toast('✓ Marked '+status.toLowerCase());
      await load(); render(); refreshLegacy(); }catch(err){ toast('Failed: '+err.message,1); } }
  function whatsapp(orderId){ const lines=CACHE.filter(l=>l.orderId===orderId); if(!lines.length){toast('Nothing to send.');return;}
    const sup=lines[0].supplier||''; const num=waMap()[String(sup).toUpperCase()]||'';
    const txt='Order '+orderId+(sup?' — '+sup:'')+'\n'+lines.map(l=>'• '+l.medName+' ('+l.medId+') × '+l.qtyOrdered).join('\n');
    window.open('https://wa.me/'+(num?num.replace(/[^\d]/g,''):'')+'?text='+encodeURIComponent(txt),'_blank');
    if(!num)toast('Tip: save '+(sup||'this supplier')+'’s number below.'); }

  function renderSearch(q){ const box=D.getElementById('wo-res'); q=(q||'').trim().toUpperCase();
    if(!q){box.innerHTML='';return;}
    const hits=[],seen=new Set();
    for(const it of inv()){ if(!it||!it.id||seen.has(it.id))continue;
      if(String(it.id).toUpperCase().includes(q)||String(it.name||'').toUpperCase().includes(q)){seen.add(it.id);hits.push(it);if(hits.length>=12)break;} }
    if(!hits.length){box.innerHTML='<div class="wo-note">No match.</div>';return;}
    box.innerHTML=hits.map(it=>{ const on=activeFor(it.id);
      return '<button data-id="'+esc(it.id)+'"><b>'+esc(it.id)+'</b> '+esc(it.name)+
        '<span>'+(it.bottles!=null?it.bottles+' btl':'')+'</span>'+
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
