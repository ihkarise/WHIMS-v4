/* WHIMS v4.2 — Phase B: Workflow Engine.
   Load AFTER whims-core.js. No other load-order dependency — every other
   module is bridged in via its EXISTING globals (window.renderDash,
   window.WHIMSOrders, window.WHIMSIntake), so whims-dashboard.js and
   whims-source.js need ZERO modification for this to refresh them.

   This engine performs NO business calculations and NO UI rendering.
   It only coordinates events — exactly as specified.

   Built on Core.Plugins (Layer 4), not a parallel pub-sub: subscribe/
   unsubscribe/emit delegate straight to Core.Plugins.on/off/emit. The new
   value this engine adds on top is dispatch() (named cascades), and a
   debounced/batched/dedup refresh queue (refreshModule/queueRefresh/
   batchRefresh) — capabilities Plugins doesn't have. */
(function(){
  if (window.WHIMS && window.WHIMS.Workflow) return;
  const Core = () => (window.WHIMS && window.WHIMS.Core) || null;
  const DEBOUNCE_MS = 120;

  /* ---------------- documented event vocabulary (spec) ---------------- */
  const EVENTS = [
    'INTAKE_CREATED','INTAKE_UPDATED','INTAKE_APPROVED','INTAKE_REJECTED',
    'INVENTORY_UPDATED','TRANSACTION_CREATED',
    'ORDER_CREATED','ORDER_UPDATED','ORDER_DELETED',
    'DASHBOARD_REFRESH','ANALYTICS_REFRESH','AI_SNAPSHOT_REFRESH','SEARCH_INDEX_REFRESH',
    'ORDER_SUGGESTIONS_REFRESH'
  ];

  /* ---------------- pure refresh-queue logic (unit-tested) ---------------- */
  const modules = new Map();     // name -> refresh fn
  let pending = new Set();
  let inFlight = new Set();
  let timer = null;

  function refreshModule(name, fn){ modules.set(name, fn); return api; }
  function hasModule(name){ return modules.has(name); }

  function queueRefresh(name){
    if (!modules.has(name)) return;     // unknown name — ignore silently, never throws on a typo
    pending.add(name);
    scheduleBatch();
  }
  function scheduleBatch(){
    if (timer) return;
    timer = setTimeout(() => { timer = null; batchRefresh(); }, DEBOUNCE_MS);
  }
  /** Runs every currently-queued module's refresh handler exactly once, then
   *  clears the queue. A module already mid-refresh in THIS flush is skipped
   *  (no synchronous circular re-entry); if it re-queues itself it simply
   *  runs again on the next flush, never recursively within this one. */
  async function batchRefresh(){
    if (timer){ clearTimeout(timer); timer = null; }
    const names = Array.from(pending); pending.clear();
    for (const name of names){
      if (inFlight.has(name)) continue;
      inFlight.add(name);
      try{
        const fn = modules.get(name);
        if (fn){ const r = fn(); if (r && typeof r.then === 'function') await r; }
      } catch(e){ /* one module's failure must never block the others */ }
      inFlight.delete(name);
    }
    return names;
  }

  /* ---------------- cascade tables — the ONLY "business" knowledge here is
     "which architectural event implies which other events / which modules
     need refreshing" — no calculations, no rendering. ---------------- */
  const CASCADES = {
    INTAKE_APPROVED: ['INVENTORY_UPDATED','TRANSACTION_CREATED','DASHBOARD_REFRESH',
      'ANALYTICS_REFRESH','SEARCH_INDEX_REFRESH','ORDER_SUGGESTIONS_REFRESH','AI_SNAPSHOT_REFRESH']
  };
  const REFRESH_TRIGGERS = {
    DASHBOARD_REFRESH: ['dashboard'],
    INVENTORY_UPDATED: ['dashboard','orders'],
    ORDER_SUGGESTIONS_REFRESH: ['orders'],
    ORDER_CREATED: ['orders'],
    ORDER_UPDATED: ['orders'],
    ORDER_DELETED: ['orders']
  };
  function triggersFor(event){ return REFRESH_TRIGGERS[event] || []; }

  /* ---------------- pub/sub — delegates to Core.Plugins, doesn't reimplement it ---------------- */
  function emit(event, payload){
    const c = Core(); if (c) { try{ c.Plugins.emit(event, payload); }catch(e){} }
  }
  function subscribe(event, fn){
    const c = Core(); if (!c) return function off(){};
    return c.Plugins.on(event, fn);
  }
  function unsubscribe(event, fn){
    const c = Core(); if (c) c.Plugins.off(event, fn);
  }

  /** dispatch = emit + run the named cascade (if any) + queue the refreshes
   *  each step implies. This is what modules call for a "real" business
   *  event (e.g. an Intake approval); emit() alone is for simple one-off
   *  notifications with no further orchestration. */
  function dispatch(event, payload){
    emit(event, payload);
    triggersFor(event).forEach(queueRefresh);
    const chain = CASCADES[event];
    if (chain){
      chain.forEach(step => { emit(step, payload); triggersFor(step).forEach(queueRefresh); });
    }
    return api;
  }

  const api = { EVENTS, emit, subscribe, unsubscribe, dispatch,
    refreshModule, hasModule, queueRefresh, batchRefresh,
    _test: { modules, pending: () => pending, inFlight: () => inFlight, CASCADES, REFRESH_TRIGGERS } };

  window.WHIMS = window.WHIMS || {};
  window.WHIMS.Workflow = api;

  /* ---------------- default bridges to EXISTING modules — zero modification
     to whims-dashboard.js / whims-source.js required. They both already cascade
     off window.renderDash() being called (the established wrap-composition
     pattern), so one bridge here refreshes both. ---------------- */
  function installDefaults(){
    refreshModule('dashboard', () => { if (typeof window.renderDash === 'function') window.renderDash(); });
    refreshModule('orders', () => { if (window.WHIMSOrders && window.WHIMSOrders.reload) return window.WHIMSOrders.reload(); });
    refreshModule('intake', () => { if (window.WHIMSIntake && window.WHIMSIntake.refresh) window.WHIMSIntake.refresh(); });

    const c = Core();
    if (c){
      try{ c.Plugins.register({ name:'Workflow', init(){} }); }catch(e){}   // visible in the existing Plugin Framework
    }
  }
  installDefaults();
})();
