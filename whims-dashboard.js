/* WHIMS v4.2 — Phase 7: Dashboard Integration.
   Load AFTER app.js, whims-core.js, and whims-source.js.

   Purely additive: wraps window.renderDash (composing with whims-source.js's
   own wrap, the same idiom Code.gs uses for approveOne) and mounts a card
   grid right after the Entry Sources panel (or after #statGrid if that panel
   isn't present). This module computes NOTHING itself — every number comes
   from WHIMS.Core.Intelligence, called exactly once per Core function per
   render ("Never duplicate calculations"): one classifyMovement() call feeds
   both the Fast Moving and Slow Moving cards; one calculateStockHealth() call
   feeds both Inventory Health and Stock Alerts.

   Cards: Inventory Health, Stock Alerts, Fast Moving, Slow Moving, Dead Stock,
   Supplier Summary, Purchase Summary, Upcoming Expiry, Turnover.

   App globals used: esc, openDetail (both top-level `function` decls in
   app.js, so they're on window even under 'use strict' — same assumption
   whims-orders.js / whims-source.js already rely on). */
(function(){
  if (window.WHIMSDash) return;
  const D = document;
  const G = n => window[n];
  const Core = () => (window.WHIMS && window.WHIMS.Core) || null;
  const esc = s => G('esc') ? G('esc')(s) : String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const inr = n => '₹' + Number(n||0).toLocaleString('en-IN');

  /* ---------------- pure card-template helpers (unit-tested) ---------------- */
  function cardWrap(title, inner){
    return '<div class="card glass di-card"><div class="di-title">'+esc(title)+'</div>'+inner+'</div>';
  }
  function legendItem(label, n, cls){ return '<span class="di-leg di-leg-'+cls+'"><b>'+n+'</b>'+esc(label)+'</span>'; }
  function pill(label, n, cls){ return '<span class="di-pill'+(cls?' di-pill-'+cls:'')+'"><b>'+n+'</b>'+esc(label)+'</span>'; }
  function row(id, name, sub, dotCls){
    return '<div class="di-row" data-jump-id="'+esc(id)+'">'+
      (dotCls?'<span class="di-dot '+dotCls+'"></span>':'')+
      '<span class="di-name">'+esc(name)+'</span><span class="di-sub">'+esc(sub)+'</span></div>';
  }

  function healthCardHtml(health){
    const total = health.active || 0;
    const pct = n => total ? Math.round(n/total*100) : 0;
    return cardWrap('Inventory Health',
      '<div class="di-stack">'+
        '<i style="width:'+pct(health.outOfStock)+'%;background:var(--red)"></i>'+
        '<i style="width:'+pct(health.lowStock)+'%;background:var(--amber)"></i>'+
        '<i style="width:'+pct(health.good)+'%;background:var(--green)"></i>'+
        '<i style="width:'+pct(health.overstock)+'%;background:var(--blue)"></i>'+
      '</div><div>'+
        legendItem('Out', health.outOfStock, 'red')+
        legendItem('Low', health.lowStock, 'amber')+
        legendItem('Good', health.good, 'green')+
        legendItem('Over', health.overstock, 'blue')+
      '</div>');
  }

  function alertsCardHtml(health, urgentRows){
    const body = urgentRows.length
      ? '<div class="di-list">'+urgentRows.map(x=>
          row(x.id, x.name, x.status==='OUT OF STOCK'?'Out of stock':'1 left', x.status==='OUT OF STOCK'?'red':'amber')
        ).join('')+'</div>'
      : '<div class="di-empty">All stock healthy</div>';
    return cardWrap('Stock Alerts', body + (health.needPurchase ? '<div class="di-foot">'+health.needPurchase+' flagged for purchase</div>' : ''));
  }

  function movementCardHtml(title, items, emptyMsg){
    if (!items.length) return cardWrap(title, '<div class="di-empty">'+emptyMsg+'</div>');
    return cardWrap(title, '<div class="di-list">'+items.slice(0,5).map(r=>
      row(r.id, r.name, r.qty ? r.qty+' dispensed' : '—')
    ).join('')+'</div>');
  }

  function deadStockCardHtml(dead){
    if (!dead.length) return cardWrap('Dead Stock', '<div class="di-empty">No dead stock detected</div>');
    return cardWrap('Dead Stock', '<div class="di-list">'+dead.slice(0,5).map(r=>
      row(r.id, r.name, inr(r.value))
    ).join('')+'</div><div class="di-foot">'+dead.length+' item'+(dead.length>1?'s':'')+' tied up</div>');
  }

  function supplierCardHtml(sup){
    if (!sup.length) return cardWrap('Supplier Summary', '<div class="di-empty">No suppliers on file</div>');
    return cardWrap('Supplier Summary', '<div class="di-list">'+sup.slice(0,4).map(s=>
      '<div class="di-row"><span class="di-name">'+esc(s.supplier)+'</span><span class="di-sub">'+s.medicines+' meds · '+inr(s.value)+'</span></div>'
    ).join('')+'</div>');
  }

  function purchaseCardHtml(pur, windowDays){
    return cardWrap('Purchase Summary',
      '<div class="di-big">'+inr(pur.totalSpend)+'</div>'+
      '<div class="di-foot">'+pur.receipts+' receipt'+(pur.receipts!==1?'s':'')+' · avg '+inr(pur.avgPerReceipt)+' · last '+windowDays+' days</div>');
  }

  function expiryCardHtml(exp){
    const c = exp.counts;
    const urgent = exp.buckets.expired.concat(exp.buckets.d30).sort((a,b)=>(a.daysLeft||0)-(b.daysLeft||0)).slice(0,4);
    const body = urgent.length
      ? '<div class="di-list">'+urgent.map(r=> row(r.id, r.name, r.daysLeft<0?'expired':r.daysLeft+'d left', r.daysLeft<0?'red':'amber')).join('')+'</div>'
      : '<div class="di-empty">Nothing expiring soon</div>';
    return cardWrap('Upcoming Expiry',
      '<div class="di-pills">'+pill('Expired',c.expired,'red')+pill('30d',c.d30,'amber')+pill('90d',c.d90,'blue')+pill('180d',c.d180,'')+'</div>'+body);
  }

  function turnoverCardHtml(turn){
    return cardWrap('Turnover',
      '<div class="di-big">'+turn.turnover+'×</div>'+
      '<div class="di-foot">'+turn.dispensedUnits+' dispensed of '+turn.inventoryUnits+' in stock · annualised</div>');
  }

  /** Picks the active, out/low-stock items for the Alerts card without a new
   *  Core call — just classifies the already-loaded inventory using the exact
   *  same statusOf() Core itself uses internally (single source of truth for
   *  the rule; this is row selection, not a duplicated aggregate calculation). */
  function urgentItems(invAll, statusOf){
    return invAll.filter(m => String(m.active).toUpperCase()!=='NO')
      .map(m => ({ id:m.id, name:m.name, status:statusOf(m) }))
      .filter(x => x.status==='OUT OF STOCK' || x.status==='LOW STOCK')
      .sort((a,b) => (a.status==='OUT OF STOCK'?0:1) - (b.status==='OUT OF STOCK'?0:1))
      .slice(0,6);
  }

  window.WHIMSDash = { cardWrap, legendItem, pill, row, urgentItems,
    healthCardHtml, alertsCardHtml, movementCardHtml, deadStockCardHtml,
    supplierCardHtml, purchaseCardHtml, expiryCardHtml, turnoverCardHtml };

  /* ---------------- mount + render ---------------- */
  function mount(){
    if (D.getElementById('di-cards')) return true;
    const dash = D.getElementById('view-dash'); if (!dash) return false;
    const anchor = D.getElementById('src-stats') || D.getElementById('statGrid');
    if (!anchor) return false;
    const wrap = D.createElement('div'); wrap.id = 'di-cards';
    wrap.innerHTML = '<div class="view-title" style="margin-top:22px">Intelligence</div><div class="di-grid" id="di-grid"></div>';
    anchor.parentNode.insertBefore(wrap, anchor.nextSibling);
    return true;
  }

  function renderCards(){
    const c = Core(); const grid = D.getElementById('di-grid');
    if (!c || !grid) return;
    const invAll = c.data.inventory();
    const txAll = c.data.transactions();
    const opts = { windowDays: 90 };
    const IL = c.Intelligence;

    // each Core function called exactly once — shared results feed related cards
    const health = IL.calculateStockHealth(invAll);
    const mv = IL.classifyMovement(invAll, txAll, opts);
    const dead = IL.calculateDeadStock(invAll, txAll, opts);
    const sup = IL.calculateSupplierAnalytics(invAll);
    const pur = IL.calculatePurchaseAnalytics(txAll, opts);
    const exp = IL.calculateExpiryAnalytics(invAll, opts);
    const turn = IL.calculateInventoryTurnover(invAll, txAll, opts);
    const urgent = urgentItems(invAll, IL.statusOf);

    grid.innerHTML =
      healthCardHtml(health) +
      alertsCardHtml(health, urgent) +
      movementCardHtml('Fast Moving', mv.fast, 'No dispensing activity yet') +
      movementCardHtml('Slow Moving', mv.slow, 'Nothing slow-moving right now') +
      deadStockCardHtml(dead) +
      supplierCardHtml(sup) +
      purchaseCardHtml(pur, opts.windowDays) +
      expiryCardHtml(exp) +
      turnoverCardHtml(turn);

    grid.querySelectorAll('[data-jump-id]').forEach(el => {
      el.onclick = () => {
        const m = invAll.find(x => String(x.id)===el.dataset.jumpId);
        if (m && typeof G('openDetail')==='function') G('openDetail')(m);
      };
    });
  }

  /* ---------------- install (wrap renderDash — composes with whims-source.js) ---------------- */
  let wrapped = null;
  function install(){
    if (wrapped) return;
    wrapped = (typeof window.renderDash==='function') ? window.renderDash : function(){};
    window.renderDash = function(){ try{ wrapped.apply(this,arguments); }catch(e){} try{ afterDash(); }catch(e){} };
  }
  function afterDash(){ if (mount()) renderCards(); }

  function boot(){ install();
    const v = D.getElementById('view-dash');
    if (v && v.classList.contains('active') && mount()) renderCards();
  }
  if (D.readyState==='loading') D.addEventListener('DOMContentLoaded', boot); else boot();
})();
