/**
 * Entry Sources Dashboard Fix
 * Fetches source stats and replaces the hardcoded fallback text.
 */
(function() {
  'use strict';

  async function fetchAndRenderSources() {
    const apiUrl = localStorage.getItem('whims_api_url') || window.API_URL;
    if (!apiUrl) return;

    try {
      const res = await fetch(apiUrl + '?action=sourcestats&token=' + (localStorage.getItem('whims_token') || ''));
      if (!res.ok) throw new Error('Network response was not ok');
      const json = await res.json();

      // The backend wraps in { ok: true, data: {...} }
      const data = json.ok ? json.data : json;

      if (data.error || data.WHIMS === -1) return; // Columns not added yet

      // Find the widget containing the fallback text
      const allElements = document.querySelectorAll('.stat, .card, [class*="source"], [class*="analytics"], div, section');
      
      for (let i = 0; i < allElements.length; i++) {
        const el = allElements[i];
        if (el.textContent.includes('Connect the backend to see source analytics')) {
          
          let htmlContent = '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;padding:4px 0;">';
          
          const sources = [
            { key: 'WHIMS', label: 'WHIMS', bg: 'var(--green-soft)', color: 'var(--green)' },
            { key: 'WISE_LENS', label: 'Wise Lens', bg: 'var(--navy-soft)', color: 'var(--navy)' },
            { key: 'HOLOSCAN', label: 'HoloScan', bg: 'var(--amber-soft)', color: 'var(--amber)' }
          ];

          sources.forEach(src => {
            const val = data[src.key] || data[src.key.toLowerCase()] || 0;
            htmlContent += `
              <div style="background:${src.bg};border-radius:12px;padding:10px 8px;text-align:center;">
                <div style="font-family:Poppins;font-weight:800;font-size:20px;color:${src.color};line-height:1.1;">${val}</div>
                <div style="font-size:10px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-top:4px;">${src.label}</div>
              </div>`;
          });
          htmlContent += '</div>';
          
          el.innerHTML = htmlContent;
        }
      }
    } catch (err) {
      console.warn('Source analytics fetch failed:', err);
    }
  }

  function init() {
    // Attempt to run immediately if DOM is ready
    fetchAndRenderSources();

    // Use MutationObserver to catch late-rendering by the main app framework
    const observer = new MutationObserver((mutations) => {
      let shouldRun = false;
      for (let i = 0; i < mutations.length; i++) {
        if (mutations[i].addedNodes.length > 0) {
          shouldRun = true;
          break;
        }
      }
      if (shouldRun) fetchAndRenderSources();
    });

    observer.observe(document.body, { childList: true, subtree: true });

    // Clean up observer after 15 seconds to prevent memory leaks
    setTimeout(() => observer.disconnect(), 15000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();