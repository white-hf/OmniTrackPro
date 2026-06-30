/**
 * Purolator Batch Tracker — Content Script (Isolated World)
 * Receives message from interceptor.js (MAIN world) and forwards to background.js.
 * Automates DOM interaction (typing, clicking search button).
 */

console.log('[Tracker Content v1.4.9] Content Script initialized in ISOLATED world.');

// ─── 1. Handle API Intercept Messages ──────────────────────────────────────────
// Listen for postMessage from the main world interceptor (interceptor.js) and forward to background.js
window.addEventListener('message', (event) => {
  if (event.data?.type === 'PUROLATOR_API_RESPONSE') {
    console.log('[Tracker Content v1.4.9] Intercepted API success response, URL:', event.data.url);
    chrome.runtime.sendMessage({
      action: 'API_RESPONSE_CAPTURED',
      url: event.data.url,
      data: event.data.data
    }).catch(err => console.warn('[Tracker Content v1.4.9] Success message forward failed:', err));
  } else if (event.data?.type === 'PUROLATOR_API_ERROR') {
    console.log('[Tracker Content v1.4.9] Intercepted API error response, URL:', event.data.url);
    chrome.runtime.sendMessage({
      action: 'API_RESPONSE_ERROR',
      url: event.data.url,
      status: event.data.status,
      message: event.data.message || '官方接口请求失败'
    }).catch(err => console.warn('[Tracker Content v1.4.9] Error message forward failed:', err));
  }
});

// Helper: Checks if an element is inside the global site header or top navigation.
// This prevents the extension from filling global header search boxes instead of the main tracking widgets.
// We keep this filter extremely conservative (only matching actual header tags or navbar classes)
// to prevent false positives (like matching .search-container or .menu-content in the page body).
// No dynamic classes are checked to prevent false positives.
function isHeaderOrGlobalSearch(el) {
  let parent = el;
  while (parent) {
    if (parent.tagName === 'HEADER' || parent.tagName === 'NAV') {
      return true;
    }
    const cls = parent.className ? String(parent.className).toLowerCase() : '';
    const id = parent.id ? String(parent.id).toLowerCase() : '';
    if (cls.includes('navbar') || cls.includes('header-menu') || cls.includes('nav-menu')) {
      return true;
    }
    if (id.includes('navbar') || id.includes('header-menu') || id.includes('nav-menu')) {
      return true;
    }
    parent = parent.parentElement;
  }
  return false;
}

// Deep Selector: Recursively traverses light DOM and open Shadow DOMs to find matching elements
function querySelectorAllDeep(selector, root = document) {
  let elements = Array.from(root.querySelectorAll(selector));
  const allChildren = root.querySelectorAll('*');
  for (const child of allChildren) {
    if (child.shadowRoot) {
      elements = elements.concat(querySelectorAllDeep(selector, child.shadowRoot));
    }
  }
  return elements;
}

// ─── 2. DOM Automation Helpers ────────────────────────────────────────────────
function findInputBox() {
  const selectors = [
    'textarea#track-input',
    'input#track-input',
    'textarea[placeholder*="tracking" i]',
    'textarea[placeholder*="PIN" i]',
    'input[placeholder*="tracking" i]',
    'input[placeholder*="PIN" i]',
    'textarea',
    'input[type="text"]'
  ];
  for (const s of selectors) {
    const elements = querySelectorAllDeep(s);
    for (const el of elements) {
      // Must be visible AND NOT inside a global header/navigation
      if (el && el.offsetWidth > 0 && el.offsetHeight > 0 && !isHeaderOrGlobalSearch(el)) {
        console.log('[Tracker Content v1.4.9] Matched input element selector:', s);
        return el;
      }
    }
  }
  return null;
}

// Scans for the tracking execution button
function findTrackButton() {
  // 1. Direct standard selectors outside header
  const direct = querySelectorAllDeep('#track-button, .btn-track, .track-btn, button[type="submit"], input[type="submit"]');
  for (const d of direct) {
    if (d && d.offsetWidth > 0 && d.offsetHeight > 0 && !isHeaderOrGlobalSearch(d)) {
      console.log('[Tracker Content v1.4.9] Matched direct button selector.');
      return d;
    }
  }

  // 2. Scan all possible elements by text content (highly resilient to div/a/span buttons)
  const candidates = querySelectorAllDeep('button, input[type="submit"], input[type="button"], a, div, span');
  
  // Try exact matches first
  for (const el of candidates) {
    if (isHeaderOrGlobalSearch(el)) continue;
    const txt = (el.textContent || el.value || '').trim().toLowerCase();
    if (txt === 'track' || txt === 'track now' || txt === 'track package' || txt === 'search' || txt === '查询') {
      if (el.offsetWidth > 0 && el.offsetHeight > 0) {
        console.log('[Tracker Content v1.4.9] Matched button text exact:', txt);
        return el;
      }
    }
  }

  // Try partial semantic matches
  for (const el of candidates) {
    if (isHeaderOrGlobalSearch(el)) continue;
    const txt = (el.textContent || el.value || '').toLowerCase();
    if (txt.includes('track') || txt.includes('search') || txt.includes('查询')) {
      if (el.offsetWidth > 0 && el.offsetHeight > 0) {
        console.log('[Tracker Content v1.4.9] Matched button text partial:', txt);
        return el;
      }
    }
  }

  return null;
}

// Promotes target button to nearest clickable parent wrapper (e.g. wrapper DIV with button classes or BUTTON tag)
function promoteToClickableParent(el) {
  let parent = el;
  // Traverse up to 4 levels
  for (let i = 0; i < 4; i++) {
    if (!parent || parent.tagName === 'BODY') break;
    if (parent.tagName === 'BUTTON' || parent.tagName === 'A') {
      return parent;
    }
    if (parent.getAttribute && parent.getAttribute('role') === 'button') {
      return parent;
    }
    const cls = parent.className ? String(parent.className).toLowerCase() : '';
    const id = parent.id ? String(parent.id).toLowerCase() : '';
    if (cls.includes('btn') || cls.includes('button') || id.includes('btn') || id.includes('button')) {
      return parent;
    }
    parent = parent.parentElement;
  }
  return el;
}

// Emulates a highly-trusted physical mouse click sequence (mousedown -> mouseup -> click)
function simulateMouseClick(el) {
  const rect = el.getBoundingClientRect();
  const clientX = rect.left + rect.width / 2;
  const clientY = rect.top + rect.height / 2;

  el.dispatchEvent(new MouseEvent('mousedown', {
    bubbles: true, cancelable: true, view: window, clientX, clientY
  }));
  el.dispatchEvent(new MouseEvent('mouseup', {
    bubbles: true, cancelable: true, view: window, clientX, clientY
  }));
  el.click();
}

// ─── 3. Message Listener from background.js ────────────────────────────────────
// Listen for messages from background script
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === 'AUTOMATE_SEARCH') {
    executeSearchFlow(message.trackingId)
      .then(res => sendResponse(res))
      .catch(err => sendResponse({ error: err.message }));
    return true; // async response
  }
});

async function executeSearchFlow(trackingId) {
  console.log('[Tracker Content v1.4.9] Starting DOM automation for ID:', trackingId);

  // Diagnostic: Print a complete map of all inputs/textareas in the DOM (including Shadow DOM)
  try {
    const allInputs = querySelectorAllDeep('input, textarea');
    console.log(`[Tracker Content v1.4.9] DOM Scan: Found ${allInputs.length} total input/textarea tags.`);
    allInputs.forEach((el, idx) => {
      const path = [];
      let p = el;
      while (p) {
        const classStr = p.className ? `.${String(p.className).trim().split(/\s+/).join('.')}` : '';
        path.push(`${p.tagName}${p.id ? '#' + p.id : ''}${classStr}`);
        p = p.parentElement;
      }
      console.log(`  [Input #${idx}] tag=${el.tagName} | id=${el.id || 'none'} | placeholder="${el.placeholder || ''}" | visible=${el.offsetWidth > 0 && el.offsetHeight > 0} | skipped_by_header_check=${isHeaderOrGlobalSearch(el)} | path=${path.reverse().join(' > ')}`);
    });
  } catch (e) {
    console.warn('[Tracker Content v1.4.9] DOM diagnostic scan failed:', e.message);
  }

  // Poll for tracking input box (up to 10 seconds) to wait for React/dynamic framework rendering
  let input = null;
  const inputStart = Date.now();
  console.log('[Tracker Content v1.4.9] Polling for tracking input box in body...');
  while (Date.now() - inputStart < 10000) {
    input = findInputBox();
    if (input) break;
    await new Promise(r => setTimeout(r, 300));
  }

  if (!input) {
    console.error('[Tracker Content v1.4.9] Failed to find main tracking input box in body (Timeout 10s)!');
    throw new Error('未找到单号输入框，请确保页面已完全加载完毕。');
  }
  console.log('[Tracker Content v1.4.9] Target Input Box Found:', input.tagName, 'ID:', input.id, 'Placeholder:', input.placeholder);

  // Poll for track button (up to 4 seconds)
  let btn = null;
  const btnStart = Date.now();
  while (Date.now() - btnStart < 4000) {
    btn = findTrackButton();
    if (btn) break;
    await new Promise(r => setTimeout(r, 300));
  }

  if (btn) {
    console.log('[Tracker Content v1.4.9] Target Button Found:', btn.tagName, 'ID:', btn.id, 'Text:', (btn.textContent || btn.value || '').trim());
  } else {
    console.warn('[Tracker Content v1.4.9] No specific search button found outside header. Will attempt form submit or Enter keypress fallbacks.');
  }

  // Focus and clear input
  input.focus();
  input.value = '';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));

  await new Promise(r => setTimeout(r, 200));

  // Simulate human typing with complete keyboard lifecycle events (keydown -> update -> input -> keyup)
  // This satisfies React change handlers and enables search buttons
  for (let i = 0; i < trackingId.length; i++) {
    const char = trackingId[i];
    const keyCode = char.charCodeAt(0);

    input.dispatchEvent(new KeyboardEvent('keydown', { key: char, code: `Key${char.toUpperCase()}`, keyCode, bubbles: true }));
    input.value += char;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { key: char, code: `Key${char.toUpperCase()}`, keyCode, bubbles: true }));

    await new Promise(r => setTimeout(r, 20 + Math.random() * 30));
  }
  input.dispatchEvent(new Event('change', { bubbles: true }));

  // Scroll to input smoothly
  input.scrollIntoView({ behavior: 'smooth', block: 'center' });
  await new Promise(r => setTimeout(r, 500));

  // Try to click button or trigger form submit
  if (btn) {
    const clickTarget = promoteToClickableParent(btn);
    console.log('[Tracker Content v1.4.9] Triggering click on Search target:', clickTarget.tagName, 'Class:', clickTarget.className);
    simulateMouseClick(clickTarget);
  }

  // Double Insurance: Dispatch Enter keypress on input to force form submission
  await new Promise(r => setTimeout(r, 200));
  console.log('[Tracker Content v1.4.9] Dispatching Enter keypress on input to ensure form submission...');
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));

  return { success: true };
}
