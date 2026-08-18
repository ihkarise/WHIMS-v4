/* WHIMS v4.2 — Phase 9: Manual AI Assistant.
   Load AFTER app.js, whims-v41.js, whims-core.js, and whims-dashboard.js.

   "AI runs only when requested. Never automatic. Never scheduled." — the
   ONLY function in this file that calls the backend (ask()) is wired
   exclusively to two button clicks (a preset, or the custom-question Send
   button). It is never called from boot(), mountTrigger(), install(), a
   timer, or any other lifecycle hook.

   "AI never modifies inventory. Recommendations only." — this is true at
   the architecture level: ask() only ever POSTs { action:'aiask', ... } and
   renders the returned text. There is no code path anywhere in this file
   to apiPost({action:'receive'|'dispense'|'adjust'|'priority'|...}) or any
   other write action.

   Reuses existing infrastructure rather than building new UI plumbing:
     • the app's own #backdrop/.sheet system via openSheet()/closeSheets()
       (top-level function decls in app.js — on window even under 'use strict')
     • the same .v41-x close-button idiom whims-v41.js already established
     • WHIMS.Core.Intelligence.exportAnalyticsSnapshot() (Phase 8) as the
       single source of truth for every number the assistant can see —
       this file computes nothing itself, it only slices that snapshot. */
(function(){
  if (window.WHIMSAI) return;
  const D = document;
  const G = n => window[n];
  const Core = () => (window.WHIMS && window.WHIMS.Core) || null;
  const esc = s => G('esc') ? G('esc')(s) : String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const toast = (m,e)=>{ const t=G('toast'); if(t)t(m,e); else console.log(m); };
  async function apiPost(body){ const ap=G('apiPost'); if(!ap) throw new Error('WHIMS API not ready');
    const r=await ap(body); return (r&&typeof r==='object'&&'ok'in r&&'data'in r)?r.data:r; }

  /* ---------------- the 10 spec-required questions ---------------- */
  const PRESETS = [
    { key:'purchase_today', label:'What should I purchase today?', context:['forecast','stockHealth','dashboard'] },
    { key:'shortages', label:'Predict shortages', context:['forecast','stockHealth'] },
    { key:'reorder_qty', label:'Suggest reorder quantities', context:['forecast'] },
    { key:'supplier_pricing', label:'Compare supplier pricing', context:['supplierCostComparison','suppliers'] },
    { key:'reduce_cost', label:'Reduce inventory cost', context:['investment','deadStock','supplierCostComparison'] },
    { key:'dead_stock', label:'Find dead stock', context:['deadStock','investment'] },
    { key:'slow_moving', label:'Find slow-moving medicines', context:['movement'] },
    { key:'optimise', label:'Suggest inventory optimisation', context:['stockHealth','movement','deadStock','investment','turnover'] },
    { key:'exec_summary', label:'Generate executive summary', context:['dashboard','stockHealth','value','turnover','purchases','expiry'] },
    { key:'purchase_recs', label:'Generate purchase recommendations', context:['forecast','suppliers','supplierCostComparison','purchases'] }
  ];
  const DEFAULT_CONTEXT_KEYS = ['dashboard','stockHealth'];   // used for freeform questions

  /** Slices only the requested keys out of the full Phase 8 snapshot — keeps
   *  the AI request small and on-topic instead of shipping the whole catalog
   *  for every question (pure, unit-tested). */
  function buildContext(keys, snapshot){
    const ctx = { generatedAt: snapshot.generatedAt, windowDays: snapshot.windowDays };
    (keys||[]).forEach(k => { if (snapshot && snapshot[k] !== undefined) ctx[k] = snapshot[k]; });
    return ctx;
  }

  window.WHIMSAI = { PRESETS, buildContext, _test:{ buildContext, PRESETS, DEFAULT_CONTEXT_KEYS } };

  /* ---------------- sheet injection (reuses the existing .sheet/.backdrop system) ---------------- */
  function ensureSheet(){
    if (D.getElementById('sheetAI')) return;
    const el = D.createElement('div');
    el.className = 'sheet'; el.id = 'sheetAI';
    el.setAttribute('role','dialog'); el.setAttribute('aria-modal','true');
    el.innerHTML =
      '<div class="grab"></div>'+
      '<h2>✨ Wise AI Assistant</h2>'+
      '<div class="ai-sub">Ask about your inventory — answers only, nothing is changed.</div>'+
      '<div class="ai-presets" id="ai-presets">'+
        PRESETS.map(p=>'<button class="ai-preset-btn" data-key="'+esc(p.key)+'">'+esc(p.label)+'</button>').join('')+
      '</div>'+
      '<div class="ai-custom"><input id="ai-q" placeholder="Or ask your own question…"><button id="ai-send">Ask</button></div>'+
      '<div class="ai-result" id="ai-result"></div>'+
      '<div class="ai-disclaimer">Recommendations only — Wise AI never changes your inventory, places orders, or takes any action.</div>';
    D.body.appendChild(el);

    // close button — same idiom whims-v41.js already uses for every other sheet
    const x = D.createElement('button');
    x.className = 'v41-x'; x.type = 'button'; x.setAttribute('aria-label','Close'); x.innerHTML = '&times;';
    x.onclick = () => { const cs = G('closeSheets'); if (cs) cs(); };
    el.appendChild(x);

    el.querySelectorAll('.ai-preset-btn').forEach(b => b.onclick = () => ask(PRESETS.find(p=>p.key===b.dataset.key)));
    el.querySelector('#ai-send').onclick = () => {
      const q = el.querySelector('#ai-q').value.trim();
      if (!q){ toast('Type a question first', true); return; }
      ask({ key:'custom', label:q, context: DEFAULT_CONTEXT_KEYS });
    };
  }

  /** User-initiated open only — wired to the trigger button's onclick, nothing else. */
  function openAI(){
    ensureSheet();
    const os = G('openSheet'); if (os) os('#sheetAI');
    const r = D.getElementById('ai-result'); if (r) r.innerHTML = '';
  }

  /** THE single function that ever talks to the AI backend. Called exclusively
   *  from a preset button's onclick or the Send button's onclick (wired above) —
   *  never from boot/mount/install/afterDash/a timer. "Never automatic." */
  async function ask(preset){
    const c = Core(); if (!c){ toast('Needs whims-core.js', true); return; }
    if (!G('apiPost')){ toast('Connect the backend first (Settings)', true); return; }
    const snapshot = c.Intelligence.exportAnalyticsSnapshot();   // Phase 8 export — single source of truth
    const ctx = buildContext(preset.context, snapshot);
    const result = D.getElementById('ai-result');
    if (result) result.innerHTML = '<div class="ai-loading">Thinking…</div>';
    try{
      const r = await apiPost({ action:'aiask', question: preset.label, context: ctx });
      if (result) result.innerHTML = '<div class="ai-answer">'+esc(r.answer||'').replace(/\n/g,'<br>')+'</div>'+
        (r.model ? '<div class="ai-meta">'+esc(r.model)+'</div>' : '');
    }catch(e){
      if (result) result.innerHTML = '<div class="ai-error">'+esc(e.message)+'</div>';
    }
  }

  /* ---------------- trigger button mount (resilient to load order) ---------------- */
  function mountTrigger(){
    if (D.getElementById('ai-trigger')) return true;
    const dash = D.getElementById('view-dash'); if (!dash) return false;
    const anchor = D.getElementById('di-cards') || D.getElementById('src-stats') || D.getElementById('statGrid');
    if (!anchor) return false;
    const btn = D.createElement('button');
    btn.id = 'ai-trigger'; btn.className = 'ai-fab'; btn.type = 'button';
    btn.textContent = '✨ Ask AI Assistant';
    btn.onclick = openAI;                 // the ONLY caller of openAI — a real click
    anchor.parentNode.insertBefore(btn, anchor.nextSibling);
    return true;
  }

  let wrapped = null;
  function install(){
    if (wrapped) return;
    wrapped = (typeof window.renderDash==='function') ? window.renderDash : function(){};
    window.renderDash = function(){ try{ wrapped.apply(this,arguments); }catch(e){} try{ mountTrigger(); }catch(e){} };
  }
  function boot(){ install();
    const v = D.getElementById('view-dash');
    if (v && v.classList.contains('active')) mountTrigger();
  }
  if (D.readyState==='loading') D.addEventListener('DOMContentLoaded', boot); else boot();
})();
