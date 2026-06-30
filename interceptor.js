/**
 * Purolator Batch Tracker — Interceptor Script (MAIN World)
 * Overrides window.fetch and window.XMLHttpRequest to capture success and error responses.
 * Runs directly in the webpage main context, bypassing Content Security Policy (CSP).
 */
(function() {
  console.log('[Tracker Inject v1.4.9] Initializing API Interceptors in MAIN world...');

  // Helper to determine if a URL is one of our target APIs
  function isTargetApi(url) {
    if (typeof url !== 'string') return false;
    return url.includes('/tracking-ext/v1/') || url.includes('/api/locations/byID/');
  }

  // ─── 1. Hook window.fetch ───────────────────────────────────────────────────
  const originalFetch = window.fetch;
  window.fetch = async function(...args) {
    const response = await originalFetch(...args);
    const url = args[0];
    if (isTargetApi(url)) {
      try {
        if (!response.ok) {
          console.warn('[Tracker Inject v1.4.9] Fetch API error status:', response.status, 'URL:', url);
          window.postMessage({ type: 'PUROLATOR_API_ERROR', url, status: response.status }, '*');
        } else {
          const clone = response.clone();
          clone.json().then(data => {
            console.log('[Tracker Inject v1.4.9] Fetch captured JSON response from:', url, data);
            window.postMessage({ type: 'PUROLATOR_API_RESPONSE', url, data }, '*');
          }).catch(err => {
            console.error('[Tracker Inject v1.4.9] Fetch JSON parse err:', err, 'URL:', url);
            window.postMessage({ type: 'PUROLATOR_API_ERROR', url, status: 405, message: '数据解析失败' }, '*');
          });
        }
      } catch (e) {
        console.error('[Tracker Inject v1.4.9] Fetch intercept err:', e, 'URL:', url);
      }
    }
    return response;
  };

  // ─── 2. Hook window.XMLHttpRequest (Crucial for jQuery/$.ajax calls) ─────────
  const originalOpen = window.XMLHttpRequest.prototype.open;
  const originalSend = window.XMLHttpRequest.prototype.send;

  window.XMLHttpRequest.prototype.open = function(method, url, ...args) {
    this._url = url;
    return originalOpen.apply(this, [method, url, ...args]);
  };

  window.XMLHttpRequest.prototype.send = function(...args) {
    if (isTargetApi(this._url)) {
      const url = this._url;
      this.addEventListener('load', () => {
        try {
          if (this.status >= 200 && this.status < 300) {
            const data = JSON.parse(this.responseText);
            console.log('[Tracker Inject v1.4.9] XHR captured JSON response from:', url, data);
            window.postMessage({ type: 'PUROLATOR_API_RESPONSE', url, data }, '*');
          } else {
            console.warn('[Tracker Inject v1.4.9] XHR API error status:', this.status, 'URL:', url);
            window.postMessage({ type: 'PUROLATOR_API_ERROR', url, status: this.status }, '*');
          }
        } catch (err) {
          console.error('[Tracker Inject v1.4.9] XHR response JSON parse err:', err, 'URL:', url);
          window.postMessage({ type: 'PUROLATOR_API_ERROR', url, status: this.status || 405, message: 'XHR数据解析失败' }, '*');
        }
      });

      this.addEventListener('error', () => {
        console.error('[Tracker Inject v1.4.9] XHR request network error. URL:', url);
        window.postMessage({ type: 'PUROLATOR_API_ERROR', url, status: this.status || 0 }, '*');
      });
    }
    return originalSend.apply(this, args);
  };

  console.log('[Tracker Inject v1.4.9] Fetch and XHR Interceptors successfully initialized.');
})();
