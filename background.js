import { getCarrier, DEFAULT_CARRIER_ID, httpErrorMessage, findPickupAddressInJson } from './carriers.js';

console.log('[Tracker Background v1.4.9] Service Worker initialized successfully.');

const ALARM_NAME = 'purolator_next_query';
// WAF tokens are valid ~5 minutes; warn after 4 min
const WAF_TOKEN_WARN_MS  = 4 * 60 * 1000;
const WAF_TOKEN_EXPIRY_MS = 5 * 60 * 1000;

// ─── WAF Token Auto-Capture ───────────────────────────────────────────────────
// Passively listens to ALL requests going to track.purolator.com from any tab.
// When a request contains x-aws-waf-token, it is automatically saved.
// The user only needs to open purolator.com once; no manual copy-paste needed.
chrome.webRequest.onSendHeaders.addListener(
  async (details) => {
    console.log('[Tracker Background] Request intercepted to URL:', details.url);
    const headers = details.requestHeaders || [];
    console.log('[Tracker Background] Found headers keys:', headers.map(h => h.name));

    const wafHeader = headers.find(
      h => h.name.toLowerCase() === 'x-aws-waf-token'
    );
    if (!wafHeader?.value) {
      console.log('[Tracker Background] No x-aws-waf-token found in this request.');
      return;
    }

    console.log('[Tracker Background] x-aws-waf-token detected! Value length:', wafHeader.value.length);
    const { carrierSettings = {} } = await chrome.storage.local.get(['carrierSettings']);
    const current = carrierSettings.purolator?.wafToken;
    const lastCaptured = carrierSettings.purolator?.wafTokenCapturedAt || 0;

    // Save token if value changed, OR if it is identical but we haven't refreshed its capture time in 30 seconds
    if (current !== wafHeader.value || (Date.now() - lastCaptured > 30000)) {
      console.log('[Tracker Background] Saving/refreshing WAF Token in storage...');
      await chrome.storage.local.set({
        carrierSettings: {
          ...carrierSettings,
          purolator: {
            ...(carrierSettings.purolator || {}),
            wafToken: wafHeader.value,
            wafTokenCapturedAt: Date.now()
          }
        }
      });
      broadcastUpdate();
      console.log('[Tracker Background] WAF Token saved and broadcasted.');
    } else {
      console.log('[Tracker Background] Token value is identical and recently updated. Skipping storage write.');
    }
  },
  { urls: ['https://track.purolator.com/*'] },
  ['requestHeaders', 'extraHeaders']
);

// ─── Declarative Net Request Setup (Anti-Bot Headers) ──────────────────────────
// Manifest V3 standard way to spoof request headers asynchronously.
// Registers rules to rewrite Origin, Referer, and Sec-Fetch-Site on track.purolator.com.
async function setupDeclarativeRules() {
  const rules = [
    {
      id: 1,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'origin', operation: 'set', value: 'https://www.purolator.com' },
          { header: 'referer', operation: 'set', value: 'https://www.purolator.com/' },
          { header: 'sec-fetch-site', operation: 'set', value: 'same-site' }
        ]
      },
      condition: {
        urlFilter: 'https://track.purolator.com/*',
        resourceTypes: ['xmlhttprequest', 'main_frame', 'sub_frame']
      }
    },
    {
      id: 2,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'origin', operation: 'set', value: 'https://www.purolator.com' },
          { header: 'referer', operation: 'set', value: 'https://www.purolator.com/en/shipping/tracker' },
          { header: 'sec-fetch-site', operation: 'set', value: 'same-origin' }
        ]
      },
      condition: {
        urlFilter: 'https://www.purolator.com/en/api/locations/byID/*',
        resourceTypes: ['xmlhttprequest']
      }
    }
  ];

  try {
    // Session rules are dynamic and clean up automatically on browser restart
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [1, 2],
      addRules: rules
    });
  } catch (e) {
    console.error('Failed to update declarativeNetRequest rules:', e);
  }
}

// Initial rule registration on worker execution
setupDeclarativeRules();






const DEFAULT_SETTINGS = {
  language:           'en',
  minDelaySeconds:    12, // Minimum time for human copying + pasting (12 seconds)
  maxDelaySeconds:    35, // Maximum time including reading and processing (35 seconds)
  totalHours:         0,
  maxRetries:         2,
  retryDelaySeconds:  60
};

// Resolver triggers for capturing page-level API interceptions
let currentQueryResolver = null;
let currentQueryRejecter = null;
let trackerTabReloadedThisSession = false;
let activeRpaTabId = null;

// ─── RPA DOM Automation Tab Manager ───────────────────────────────────────────
// Generates a dedicated WAF-compliant window for the active query session.
async function getOrCreateTrackerTab() {
  // If we already have a bound tab, check if it is still open
  if (activeRpaTabId !== null) {
    try {
      const tab = await chrome.tabs.get(activeRpaTabId);
      return tab;
    } catch (_) {
      // Tab was closed by user, reset and create a new one
      activeRpaTabId = null;
    }
  }

  const carrier = getCarrier('purolator');
  const url = (carrier?.website || 'https://www.purolator.com') + '/en/shipping/tracker';

  console.log('[Tracker Background] Creating dedicated RPA window...');
  const win = await chrome.windows.create({
    url,
    type: 'normal',
    width: 960,
    height: 720,
    focused: true // Opens in foreground to guarantee immediate page rendering & script execution
  });

  trackerTabReloadedThisSession = true;
  activeRpaTabId = win.tabs[0].id;

  // Wait 4.5 seconds for complete initialization
  await new Promise(r => setTimeout(r, 4500));
  return win.tabs[0];
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async () => {
  const { settings } = await chrome.storage.local.get(['settings']);
  if (!settings) {
    await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
  }
  await setupDeclarativeRules();
});

chrome.runtime.onStartup.addListener(async () => {
  const { taskState } = await chrome.storage.local.get(['taskState']);
  if (taskState?.status === 'running') {
    await chrome.storage.local.set({
      taskState: { ...taskState, status: 'paused', stoppedAt: Date.now(), pauseReason: 'browser_restart' }
    });
  }
  await setupDeclarativeRules();
});


// ─── Alarm ───────────────────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) processNextItem();
});

// ─── Message Router & Interceptor ──────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // Capture the intercepted API response from content.js monkey-patch
  if (message.action === 'API_RESPONSE_CAPTURED') {
    const isSearch = !message.url || message.url.includes('/search');
    if (isSearch) {
      console.log('[Tracker Background] Captured tracking search API response!');
      if (currentQueryResolver) {
        currentQueryResolver(message.data);
        currentQueryResolver = null;
        currentQueryRejecter = null;
      }
    } else {
      console.log('[Tracker Background] Captured other API response (locations/etc):', message.url);
      handleCapturedLocation(message.url, message.data);
    }
    sendResponse({ success: true });
    return false;
  }

  // Capture API errors/WAF blocks instantly from content.js monkey-patch
  if (message.action === 'API_RESPONSE_ERROR') {
    console.warn('[Tracker Background] Intercepted API error code:', message.status, message.message);
    if (currentQueryRejecter) {
      const err = new Error(message.message || '官方页面查询请求失败');
      err.statusCode = message.status || 405;
      currentQueryRejecter(err);
      currentQueryResolver = null;
      currentQueryRejecter = null;
    }
    sendResponse({ success: true });
    return false;
  }

  handleMessage(message)
    .then(sendResponse)
    .catch(err => sendResponse({ error: err.message }));
  return true;
});


async function handleMessage(msg) {
  switch (msg.action) {
    case 'START_QUEUE':    return await startQueue(msg.trackingNumbers, msg.carrierId);
    case 'CONTINUE_QUEUE': return await continueQueue();
    case 'PAUSE_QUEUE':    return await pauseQueue();
    case 'RESET_QUEUE':    return await resetQueue();
    case 'GET_STATE':      return await chrome.storage.local.get(['trackingList', 'taskState', 'settings', 'carrierSettings']);
    case 'SAVE_SETTINGS':  return await saveSettings(msg.settings);
    case 'SAVE_CARRIER_SETTINGS': return await saveCarrierSettings(msg.carrierId, msg.carrierSettings);
    case 'GET_TOKEN_STATUS': return await getTokenStatus(msg.carrierId || 'purolator');
    case 'OPEN_CARRIER_SITE': return await openCarrierSite(msg.carrierId || 'purolator');
    default:               return { error: 'Unknown action: ' + msg.action };
  }
}

async function getTokenStatus(carrierId) {
  const { carrierSettings = {} } = await chrome.storage.local.get(['carrierSettings']);
  const cfg = carrierSettings[carrierId] || {};
  const capturedAt = cfg.wafTokenCapturedAt || null;
  const hasToken   = !!cfg.wafToken;
  const age        = capturedAt ? Date.now() - capturedAt : null;

  let status = 'missing';
  if (hasToken && age !== null) {
    if (age < WAF_TOKEN_WARN_MS)   status = 'fresh';
    else if (age < WAF_TOKEN_EXPIRY_MS) status = 'expiring';
    else                                status = 'expired';
  }

  return { status, hasToken, capturedAt, age };
}

async function openCarrierSite(carrierId) {
  const carrier = getCarrier(carrierId);
  if (!carrier?.website) return { error: 'No website for this carrier' };
  await chrome.tabs.create({ url: carrier.website, active: true });
  return { success: true };
}


// ─── Queue Operations ─────────────────────────────────────────────────────────

async function startQueue(rawInput, carrierId = DEFAULT_CARRIER_ID) {
  const carrier = getCarrier(carrierId);
  if (!carrier) return { error: `Unknown carrier: ${carrierId}` };

  // Reset reload flag for the new query session
  trackerTabReloadedThisSession = false;
  activeRpaTabId = null;

  const ids = [...new Set(
    rawInput.split(/[\n,;\t\r ]+/).map(s => s.trim()).filter(s => s.length > 3)
  )];
  if (ids.length === 0) return { error: 'No valid tracking numbers found' };

  const items = ids.map(id => ({
    id, status: 'pending', result: null, error: null, retries: 0, queryTime: null
  }));

  const taskState = {
    status:       'running',
    carrierId,
    carrierName:  carrier.name,
    startedAt:    Date.now(),
    stoppedAt:    null,
    errorInfo:    null,
    totalCount:   items.length,
    pauseReason:  null
  };

  await chrome.storage.local.set({ trackingList: items, taskState });
  setTimeout(processNextItem, 150);
  return { success: true, count: ids.length };
}

async function continueQueue() {
  const { taskState } = await chrome.storage.local.get(['taskState']);
  if (!taskState)                    return { error: 'No active session found' };
  if (taskState.status === 'completed') return { error: 'Session already completed' };

  // Reset reload flag for continuation
  trackerTabReloadedThisSession = false;

  await chrome.storage.local.set({
    taskState: { ...taskState, status: 'running', errorInfo: null, stoppedAt: null, pauseReason: null }
  });
  setTimeout(processNextItem, 150);
  return { success: true };
}

async function pauseQueue() {
  await chrome.alarms.clear(ALARM_NAME);
  const { taskState } = await chrome.storage.local.get(['taskState']);
  if (taskState) {
    await chrome.storage.local.set({
      taskState: { ...taskState, status: 'paused', stoppedAt: Date.now(), pauseReason: 'user' }
    });
  }
  broadcastUpdate();
  return { success: true };
}

async function resetQueue() {
  await chrome.alarms.clear(ALARM_NAME);
  await chrome.storage.local.remove(['trackingList', 'taskState']);
  broadcastUpdate();
  return { success: true };
}

async function saveSettings(newSettings) {
  const { settings } = await chrome.storage.local.get(['settings']);
  await chrome.storage.local.set({ settings: { ...DEFAULT_SETTINGS, ...settings, ...newSettings } });
  return { success: true };
}

async function saveCarrierSettings(carrierId, newCarrierSettings) {
  const { carrierSettings = {} } = await chrome.storage.local.get(['carrierSettings']);
  carrierSettings[carrierId] = { ...(carrierSettings[carrierId] || {}), ...newCarrierSettings };
  await chrome.storage.local.set({ carrierSettings });
  return { success: true };
}

// ─── Core Processing ──────────────────────────────────────────────────────────

async function sendMessageToTabWithRetry(tabId, message) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await chrome.tabs.sendMessage(tabId, message);
      return res;
    } catch (err) {
      console.warn(`[Tracker Background] Send message failed (attempt ${attempt + 1}):`, err.message);
      if (err.message.includes('Receiving end does not exist')) {
        // If content script is missing or page was lazy loaded, force inject them
        try {
          console.log('[Tracker Background] Dynamically injecting interceptor.js (MAIN) and content.js (ISOLATED)...');
          // 1. Inject WAF interceptor in webpage MAIN world (bypassing CSP)
          try {
            await chrome.scripting.executeScript({
              target: { tabId },
              world: 'MAIN',
              files: ['interceptor.js']
            });
          } catch (mainErr) {
            console.warn('[Tracker Background] MAIN world injection warning (expected on non-auth tabs):', mainErr.message);
          }
          // 2. Inject DOM automation controller in ISOLATED world
          await chrome.scripting.executeScript({
            target: { tabId },
            files: ['content.js']
          });
        } catch (injectErr) {
          console.error('[Tracker Background] Failed to force-inject scripts:', injectErr);
        }
      }
      // Wait 1 second before retrying
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  throw new Error('与官方查询页面连接失败，请在浏览器中刷新该官方网页后重新点击“继续查询”');
}

async function processNextItem() {
  const { trackingList, taskState, settings, carrierSettings = {} } =
    await chrome.storage.local.get(['trackingList', 'taskState', 'settings', 'carrierSettings']);

  if (!trackingList || !taskState || taskState.status !== 'running') return;

  const cfg        = { ...DEFAULT_SETTINGS, ...settings };
  const carrierId  = taskState.carrierId || DEFAULT_CARRIER_ID;
  const carrier    = getCarrier(carrierId);

  if (!carrier) {
    await stopWithError({ message: `物流商 "${carrierId}" 未找到`, statusCode: null, isFatal: true },
      null, trackingList, taskState);
    return;
  }

  // Build carrier-specific settings (merge defaults from schema + stored values)
  const storedCarrierCfg = carrierSettings[carrierId] || {};
  const carrierDefaults  = Object.fromEntries(
    carrier.settingsSchema.map(f => [f.key, f.default ?? ''])
  );
  const carrierCfg = { ...carrierDefaults, ...storedCarrierCfg, language: cfg.language || 'en' };

  const nextIndex = trackingList.findIndex(i => i.status === 'pending');

  // All done?
  if (nextIndex === -1) {
    const done  = trackingList.filter(i => i.status === 'completed').length;
    const fails = trackingList.filter(i => i.status === 'error').length;
    await chrome.storage.local.set({
      taskState: { ...taskState, status: 'completed', stoppedAt: Date.now() }
    });
    chrome.notifications.create('done_' + Date.now(), {
      type: 'basic', iconUrl: 'icons/icon48.png',
      title: `${carrier.emoji} ${carrier.name} Tracker ✓ 全部完成`,
      message: `成功: ${done}  失败: ${fails}  共: ${taskState.totalCount} 个运单`,
      priority: 2
    });
    broadcastUpdate();
    return;
  }

  const item = trackingList[nextIndex];

  let rawData;
  try {
    const tab = await getOrCreateTrackerTab();
    if (!tab) {
      throw new Error('无法连接官方查询页面，请确保浏览器已加载该页面。');
    }

    // Trigger content.js to input and click search on the page DOM (with auto-inject recovery)
    const res = await sendMessageToTabWithRetry(tab.id, {
      action: 'AUTOMATE_SEARCH',
      trackingId: item.id
    });
    if (res && res.error) {
      throw new Error(res.error);
    }

    // Wait for the monkey-patch to capture the clean JSON response from the page
    rawData = await new Promise((resolve, reject) => {
      currentQueryResolver = resolve;
      currentQueryRejecter = reject;

      // 45 second timeout to allow users to manually solve captchas / picture verifications on screen
      setTimeout(() => {
        if (currentQueryRejecter) {
          currentQueryRejecter(new Error('页面查询响应超时。若窗口中弹出了人机验证码，请尽快在网页中手动完成点选验证以自动恢复。'));
          currentQueryResolver = null;
          currentQueryRejecter = null;
        }
      }, 45000);
    });

    // Parse the captured JSON using the carrier parser
    const result = carrier.parseResponse(rawData, item.id);

    // If self-pickup hold ID is present, wait for the page's own JS to execute locations/byID fetch and intercept it naturally
    if (result.holdForPickupLocationId) {
      const key = String(result.holdForPickupLocationId).toUpperCase();
      const storageRes = await chrome.storage.local.get(['locationAddressMap']);
      const map = storageRes.locationAddressMap || {};
      const holdPrefix = `[ID: ${result.holdForPickupLocationId}] `;

      const entry = map[key];
      let isExpired = true;
      let cachedAddress = '';

      if (entry) {
        if (typeof entry === 'object' && entry.address && entry.updatedAt) {
          const ageMs = Date.now() - entry.updatedAt;
          const twoWeeksMs = 14 * 24 * 3600 * 1000;
          if (ageMs < twoWeeksMs) {
            isExpired = false;
            cachedAddress = entry.address;
          }
        }
      }

      if (!isExpired && cachedAddress) {
        // Instant hit in persistent cache and not expired (less than 2 weeks old)
        console.log('[Tracker Background] Location address cache hit instantly:', key, '->', cachedAddress);
        result.pickupAddress = cachedAddress.startsWith('[ID:') ? cachedAddress : `${holdPrefix}${cachedAddress}`;
      } else {
        // Cache miss or expired: Wait up to 2.5 seconds (25 attempts * 100ms) for page JS to request it
        console.log('[Tracker Background] Location cache miss or expired (2 weeks). Waiting for page JS to fetch details for:', key);
        for (let i = 0; i < 25; i++) {
          await new Promise(r => setTimeout(r, 100));
          const storageResCheck = await chrome.storage.local.get(['locationAddressMap']);
          const mapCheck = storageResCheck.locationAddressMap || {};
          const checkEntry = mapCheck[key];
          if (checkEntry) {
            const checkAddr = typeof checkEntry === 'object' ? checkEntry.address : checkEntry;
            console.log('[Tracker Background] Intercepted page locations query:', key, '->', checkAddr);
            result.pickupAddress = checkAddr.startsWith('[ID:') ? checkAddr : `${holdPrefix}${checkAddr}`;
            break;
          }
        }
      }
    }

    trackingList[nextIndex] = { ...item, status: 'completed', result, error: null, queryTime: Date.now() };
    await chrome.storage.local.set({ trackingList });
    broadcastUpdate();

    const remaining = trackingList.filter(i => i.status === 'pending').length;
    if (remaining === 0) {
      // Transition to completed immediately in the same cycle
      const done  = trackingList.filter(i => i.status === 'completed').length;
      const fails = trackingList.filter(i => i.status === 'error').length;
      await chrome.storage.local.set({
        taskState: { ...taskState, status: 'completed', stoppedAt: Date.now() }
      });
      // Voice Alert (Text-to-Speech) on Completion
      try {
        chrome.tts.speak('全部物流运单已查询完毕。', { lang: 'zh-CN', rate: 1.1, volume: 1.0 });
      } catch (e) {
        console.warn('[Tracker Background] TTS completion speak failed:', e);
      }

      chrome.notifications.create('done_' + Date.now(), {
        type: 'basic', iconUrl: 'icons/icon48.png',
        title: `${carrier.emoji} ${carrier.name} Tracker ✓ 全部完成`,
        message: `成功: ${done}  失败: ${fails}  共: ${taskState.totalCount} 个运单`,
        priority: 2
      });
      broadcastUpdate();
    } else {
      await scheduleAlarm(calculateDelay(cfg, remaining, taskState.startedAt));
    }

  } catch (err) {
    const code = err.statusCode || 'TIMEOUT';
    console.error(`[Tracker Background] Query failed for ID: ${item.id} | Code: ${code} | Error: ${err.message}`);
    // RPA automation errors or timeouts are treated as fatal (stops queue for user visual recovery)
    const errObj = {
      statusCode: code,
      message: err.message
    };
    await stopWithError(errObj, item.id, trackingList, taskState, carrier);
  }
}

async function stopWithError(err, trackingId, trackingList, taskState, carrier) {
  const errorInfo = {
    code:       err.statusCode,
    message:    err.message,
    trackingId: trackingId || null,
    timestamp:  Date.now()
  };
  const done = (trackingList || []).filter(i => i.status === 'completed').length;
  await chrome.storage.local.set({
    taskState: { ...taskState, status: 'error', stoppedAt: Date.now(), errorInfo }
  });

  // Auto-focus the RPA window and bounce/flash in OS taskbar to grab operator's attention immediately
  if (activeRpaTabId !== null) {
    try {
      const tab = await chrome.tabs.get(activeRpaTabId);
      await chrome.windows.update(tab.windowId, { focused: true, drawAttention: true });
    } catch (_) {}
  }

  const carrierLabel = carrier ? `${carrier.emoji} ${carrier.name}` : '物流商';
  
  // Voice Alert (Text-to-Speech)
  try {
    const errorMsg = String(err.message || '');
    if (err.statusCode === 405 || errorMsg.includes('验证码') || errorMsg.includes('验证') || errorMsg.includes('人机')) {
      chrome.tts.speak('注意！检测到人机验证码，请尽快处理。', { lang: 'zh-CN', rate: 1.1, volume: 1.0 });
    } else {
      chrome.tts.speak('注意！物流查询中断，请检查网页。', { lang: 'zh-CN', rate: 1.1, volume: 1.0 });
    }
  } catch (e) {
    console.warn('[Tracker Background] TTS speak failed:', e);
  }

  chrome.notifications.create('err_' + Date.now(), {
    type: 'basic', iconUrl: 'icons/icon48.png',
    title: `⚠️ ${carrierLabel} Tracker — 查询已停止`,
    message: `错误 ${err.statusCode || ''}: ${err.message}\n已完成 ${done}/${taskState.totalCount} 个运单`,
    priority: 2
  });
  broadcastUpdate();
}

// ─── Scheduling ───────────────────────────────────────────────────────────────

function calculateDelay(cfg, remaining, startedAt) {
  const minMs = (cfg.minDelaySeconds || 8) * 1000;
  const maxMs = (cfg.maxDelaySeconds || 30) * 1000;

  if (cfg.totalHours > 0 && remaining > 0 && startedAt) {
    const totalMs   = cfg.totalHours * 3600 * 1000;
    const timeLeft  = Math.max(0, totalMs - (Date.now() - startedAt));
    if (timeLeft > 0) {
      const target = timeLeft / remaining;
      const jitter = target * 0.3;
      return Math.max(minMs, target + (Math.random() * jitter * 2 - jitter));
    }
  }
  return minMs + Math.random() * (maxMs - minMs);
}

async function scheduleAlarm(delayMs) {
  await chrome.alarms.clear(ALARM_NAME);
  chrome.alarms.create(ALARM_NAME, { delayInMinutes: Math.max(delayMs / 60000, 1 / 600) });
}

function broadcastUpdate() {
  chrome.runtime.sendMessage({ event: 'STATE_UPDATED' }).catch(() => {});
}

async function handleCapturedLocation(url, data) {
  try {
    // 1. Explicitly check for /api/locations/byID/ response structure
    if (url.includes('/api/locations/byID/') && data.locations && data.locations.length > 0) {
      const loc = data.locations[0];
      if (loc && loc.address) {
        const addr = loc.address;
        const street = [addr.streetNumber, addr.streetName, addr.streetType].filter(Boolean).join(' ');
        const zip = addr.postalCode ? String(addr.postalCode).replace(/\s+/g, '') : '';
        const formattedZip = zip.length === 6 ? `${zip.slice(0, 3)} ${zip.slice(3)}` : zip;
        const fullAddress = `${street}, ${addr.city}, ${addr.provinceCode || addr.province} ${formattedZip}`.trim().replace(/,\s*$/, '');
        
        if (loc.locationId) {
          const key = String(loc.locationId).toUpperCase().trim();
          console.log('[Tracker Background] Parsing and saving exact location byID map:', key, '->', fullAddress);
          const storageRes = await chrome.storage.local.get(['locationAddressMap']);
          const map = storageRes.locationAddressMap || {};
          map[key] = {
            address: fullAddress,
            updatedAt: Date.now()
          };
          await chrome.storage.local.set({ locationAddressMap: map });
          broadcastUpdate();
          return;
        }
      }
    }

    // 2. Generic fallback for other locations endpoints
    let address = findPickupAddressInJson(data);
    if (!address && data && typeof data === 'object') {
      const street = data.addressLine1 || data.street || data.address || '';
      const city = data.city || '';
      const prov = data.provinceState || data.province || '';
      const zip = data.postalCode || data.zipCode || '';
      const lines = [street, city, prov, zip].filter(Boolean);
      if (lines.length > 0) {
        address = lines.join(', ');
      }
    }

    if (address) {
      const urlPart = String(url).split('?')[0];
      const parts = urlPart.split('/');
      let locationId = '';
      
      const locIdx = parts.findIndex(p => p.toLowerCase() === 'locations' || p.toLowerCase() === 'location');
      if (locIdx !== -1 && parts[locIdx + 1]) {
        locationId = parts[locIdx + 1];
      } else {
        locationId = data.locationId || data.id || '';
      }

      if (locationId) {
        const key = String(locationId).toUpperCase().trim();
        console.log('[Tracker Background] Saving location details map:', key, '->', address);
        
        const storageRes = await chrome.storage.local.get(['locationAddressMap']);
        const map = storageRes.locationAddressMap || {};
        map[key] = {
          address: address,
          updatedAt: Date.now()
        };
        await chrome.storage.local.set({ locationAddressMap: map });
        broadcastUpdate();
      }
    }
  } catch (e) {
    console.error('[Tracker Background] Failed parsing location details:', e);
  }
}


