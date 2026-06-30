/**
 * ═══════════════════════════════════════════════════════════════
 *  Purolator Batch Tracker — Carrier Registry (Plugin System)
 * ═══════════════════════════════════════════════════════════════
 *
 * How to add a new carrier:
 *  1. Add an entry to CARRIERS following the structure below.
 *  2. Add its hostPermission URL to manifest.json → host_permissions.
 *  3. Implement makeApiCall(trackingId, carrierSettings) → raw API response.
 *  4. Implement parseResponse(rawData, trackingId) → NormalizedResult.
 *
 * NormalizedResult shape (all carriers must return this):
 * {
 *   trackingId:        string,
 *   carrierId:         string,
 *   found:             boolean,
 *   statusCode:        string,   e.g. "DEL"
 *   statusDescription: string,   e.g. "Delivered"
 *   shipmentPin:       string,
 *   product:           string,
 *   shipper:           string,   e.g. "MISSISSAUGA, ON, CA"
 *   receiver:          string,
 *   lastEvent:         EventRecord | null,   // most recent
 *   firstEvent:        EventRecord | null,   // earliest
 *   totalEvents:       number
 * }
 *
 * EventRecord shape:
 * { dateTime, description, reasonCode, location, formatted }
 */

// ─── Shared Utilities ────────────────────────────────────────────────────────

export function formatEvent(event) {
  if (!event) return null;
  const parts = [];
  if (event.location?.city)          parts.push(event.location.city.trim());
  if (event.location?.provinceState) parts.push(event.location.provinceState);
  if (event.location?.countryCode)   parts.push(event.location.countryCode);
  const location = parts.join(', ');
  return {
    dateTime:   event.dateTime    || '',
    description: event.description || '',
    reasonCode: event.reasonCode  || '',
    location,
    formatted: [event.dateTime, event.description, location].filter(Boolean).join(' | ')
  };
}

export function formatAddress(addr) {
  if (!addr) return '';
  return [addr.city?.trim(), addr.provinceState, addr.countryCode].filter(Boolean).join(', ');
}

// Recursively scans the API JSON tree for keys matching ETA patterns (Estimated Delivery Date)
export function findEtaInJson(obj) {
  if (!obj || typeof obj !== 'object') return null;

  const keys = Object.keys(obj);
  for (const k of keys) {
    const kl = k.toLowerCase();
    if (kl.includes('deliverydate') || kl.includes('estimateddelivery') || kl.includes('expecteddelivery') || kl.includes('estdeliverydate')) {
      if (typeof obj[k] === 'string' && obj[k].trim().length > 0) {
        return obj[k].trim();
      }
    }
  }

  for (const k of keys) {
    if (typeof obj[k] === 'object' && obj[k] !== null) {
      const found = findEtaInJson(obj[k]);
      if (found) return found;
    }
  }
  return null;
}

// Recursively scans the API JSON tree for keys matching retail store or pickup address structures
export function findPickupAddressInJson(obj) {
  if (!obj || typeof obj !== 'object') return null;

  const keys = Object.keys(obj);
  for (const k of keys) {
    const kl = k.toLowerCase();
    if (kl === 'retailstore' || kl === 'pickuplocation' || kl === 'holdinglocation' || kl === 'retailoutlet' || kl === 'storeaddress') {
      const store = obj[k];
      if (store && typeof store === 'object') {
        const lines = [
          store.name,
          store.addressLine1 || store.address1 || store.streetAddress,
          store.addressLine2 || store.address2,
          store.city,
          store.provinceState || store.province || store.state,
          store.postalCode || store.zipCode || store.zip
        ].filter(Boolean);
        if (lines.length > 0) {
          return lines.join(', ');
        }
      }
    }
  }

  for (const k of keys) {
    if (typeof obj[k] === 'object' && obj[k] !== null) {
      const found = findPickupAddressInJson(obj[k]);
      if (found) return found;
    }
  }
  return null;
}

export function httpErrorMessage(code) {
  const map = {
    400: '请求格式错误 (400 Bad Request)',
    401: '认证失败，Token已过期，请更新凭证 (401 Unauthorized)',
    403: '访问被拒绝，IP可能已被封禁 (403 Forbidden)',
    404: '接口不存在 (404 Not Found)',
    405: 'Token已过期或触发人机验证 (405 Method Not Allowed)',
    429: '请求过于频繁，已被限流 (429 Too Many Requests)',
    500: '服务器内部错误 (500)',
    502: '网关错误 (502 Bad Gateway)',
    503: '服务暂时不可用 (503 Service Unavailable)'
  };
  return map[code] || `HTTP 错误 ${code}`;
}

// ─── Carrier Registry ─────────────────────────────────────────────────────────

export const CARRIERS = {

  // ══════════════════════════════════════════════════════════════
  //  PUROLATOR
  // ══════════════════════════════════════════════════════════════
  purolator: {
    id:          'purolator',
    name:        'Purolator',
    shortName:   'PRL',
    country:     'CA',
    flag:        '🇨🇦',
    emoji:       '📦',
    color:       '#7C5CBF',          // accent color for UI
    bgColor:     'rgba(124,92,191,0.15)',
    borderColor: 'rgba(124,92,191,0.35)',
    description: '加拿大包裹配送',
    website:     'https://www.purolator.com',
    hostPermission: 'https://track.purolator.com/*',

    // Fields shown in the Options → Credentials panel for this carrier
    settingsSchema: [
      {
        key:         'apiKey',
        label:       'API Key',
        type:        'password',
        required:    true,
        default:     'TdIVdHURM65yalzbkDenz5jMWlovpP7L2VrK9QMu',
        placeholder: 'TdIVdHURM65y...'
      },
      {
        key:         'wafToken',
        label:       'WAF Token',
        type:        'textarea',
        required:    false,
        default:     '',
        placeholder: 'a879ef80-bfb5-429f-...',
        helpTitle:   '如何获取 WAF Token？',
        helpSteps: [
          '打开 <a href="https://www.purolator.com" target="_blank">purolator.com</a> 并加载页面',
          '按 <kbd>F12</kbd> → Network 标签',
          '在页面上触发一次查询，筛选 <code>search</code> 请求',
          '找到发往 <code>track.purolator.com</code> 的请求',
          '复制请求头中 <code>x-aws-waf-token</code> 的值',
          '粘贴到此处并保存（约 5 分钟有效期）'
        ]
      }
    ],

    async makeApiCall(trackingId, carrierSettings) {
      const API_URL = 'https://track.purolator.com/tracking-ext/v1/search';
      const headers = {
        'accept':            'application/json, text/javascript, */*; q=0.01',
        'accept-language':   'en-US,en;q=0.9',
        'content-type':      'application/json',
        'sec-fetch-dest':    'empty',
        'sec-fetch-mode':    'cors',
        'sec-fetch-site':    'same-site',
        'x-api-key':         carrierSettings.apiKey || 'TdIVdHURM65yalzbkDenz5jMWlovpP7L2VrK9QMu'
      };
      if (carrierSettings.wafToken?.trim()) {
        headers['x-aws-waf-token'] = carrierSettings.wafToken.trim();
      }
      const response = await fetch(API_URL, {
        method:      'POST',
        headers,
        body:        JSON.stringify({
          search:   [{ trackingId, pod: true, sequenceId: 1, eventSortOrder: 'd' }],
          language: carrierSettings.language || 'en'
        }),
        referrer:    'https://www.purolator.com/',
        mode:        'cors',
        credentials: 'include'
      });
      if (!response.ok) {
        const err = new Error(httpErrorMessage(response.status));
        err.statusCode = response.status;
        err.isFatal    = [401, 403, 405, 429].includes(response.status);
        throw err;
      }
      return await response.json();
    },

    parseResponse(data, trackingId) {
      const searchResult = data.searchResult?.[0];
      const shipment     = data.shipment?.[0];
      const pkg          = shipment?.package?.[0];
      // eventSortOrder:"d" → newest first → events[0] = latest, events[last] = first
      const events       = pkg?.events || [];
      const lastEvent    = events.length > 0 ? formatEvent(events[0])                  : null;
      const firstEvent   = events.length > 0 ? formatEvent(events[events.length - 1]) : null;
      const notFound     = !searchResult || searchResult.status !== 'FOUND' || !shipment;

      // Extract last 3 events
      const lastThreeEvents = events.slice(0, 3).map(e => formatEvent(e));

      // Extract ETA (Estimated Time of Arrival)
      let eta = pkg?.details?.deliveryDetails?.deliveryDateTime || '';
      if (!eta) {
        eta = findEtaInJson(data) || '';
      }
      if (eta && eta.includes('T')) {
        eta = eta.split('T')[0];
      }

      // Extract Self-Pickup Address (if status indicates pickup)
      let pickupAddress = findPickupAddressInJson(data) || '';
      const holdId = pkg?.details?.holdForPickupLocationId;
      const isPickupStatus = ['pup', 'hap', 'hold', 'held', 'pickup', '自提', 'retail'].some(word => 
        (shipment?.status?.code || '').toLowerCase().includes(word) || 
        (shipment?.status?.description || '').toLowerCase().includes(word) ||
        (lastEvent?.description || '').toLowerCase().includes(word)
      ) || !!holdId;

      if (isPickupStatus && !pickupAddress) {
        // Fallback: extract from the latest event location & description
        const event = events[0];
        if (event) {
          const locStr = [event.location?.city, event.location?.provinceState].filter(Boolean).join(', ');
          const desc = event.description || '';
          const prefix = holdId ? `[ID: ${holdId}] ` : '';
          if (desc.includes('Depot') || desc.includes('Store') || desc.includes('Location') || /\d+/.test(desc)) {
            pickupAddress = `${prefix}${desc} (${locStr})`;
          } else {
            pickupAddress = `${prefix}${desc || '自提点'} (${locStr})`;
          }
        } else if (holdId) {
          pickupAddress = `自提网点 ID: ${holdId}`;
        }
      }

      return {
        trackingId,
        carrierId:          'purolator',
        found:              !notFound,
        statusCode:         shipment?.status?.code        || (notFound ? 'NOT_FOUND' : 'UNKNOWN'),
        statusDescription:  shipment?.status?.description || (notFound ? 'Not Found' : 'Unknown'),
        shipmentPin:        shipment?.shipmentPin || '',
        product:            shipment?.details?.product?.description || '',
        shipper:            formatAddress(shipment?.details?.shipper),
        receiver:           formatAddress(shipment?.details?.receiver),
        lastEvent,
        firstEvent,
        lastThreeEvents,
        pickupAddress,
        eta,
        holdForPickupLocationId: holdId || '',
        totalEvents:        events.length
      };
    }
  },

  // ══════════════════════════════════════════════════════════════
  //  TEMPLATE — Copy this block and fill in to add a new carrier
  // ══════════════════════════════════════════════════════════════
  //
  // example_carrier: {
  //   id:          'example_carrier',
  //   name:        'Example Carrier',
  //   shortName:   'EXM',
  //   country:     'US',
  //   flag:        '🇺🇸',
  //   emoji:       '🚚',
  //   color:       '#e05a00',
  //   bgColor:     'rgba(224,90,0,0.12)',
  //   borderColor: 'rgba(224,90,0,0.3)',
  //   description: '描述',
  //   website:     'https://example.com',
  //   hostPermission: 'https://api.example.com/*',   // also add to manifest.json
  //
  //   settingsSchema: [
  //     { key: 'apiKey', label: 'API Key', type: 'password', required: true, default: '', placeholder: '' }
  //   ],
  //
  //   async makeApiCall(trackingId, carrierSettings) {
  //     // Call the carrier API, throw error with .isFatal = true for 401/403/429
  //     // Return the raw response data object
  //   },
  //
  //   parseResponse(data, trackingId) {
  //     // Transform raw response → NormalizedResult shape (see top of file)
  //     return { trackingId, carrierId: 'example_carrier', found: true, ... };
  //   }
  // }

};

// ─── Registry Helpers ─────────────────────────────────────────────────────────

export function getCarrier(carrierId) {
  return CARRIERS[carrierId] || null;
}

export function listCarriers() {
  return Object.values(CARRIERS);
}

export const DEFAULT_CARRIER_ID = 'purolator';
