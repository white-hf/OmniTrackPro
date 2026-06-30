/**
 * Purolator Batch Tracker — Options Page Controller (ES Module)
 * Dynamically renders per-carrier credential sections from the carrier registry.
 */

import { listCarriers, DEFAULT_CARRIER_ID } from './carriers.js';

const DEFAULT_SETTINGS = {
  language:          'en',
  minDelaySeconds:   12,
  maxDelaySeconds:   35,
  totalHours:        0,
  maxRetries:        2,
  retryDelaySeconds: 60
};

let globalSettings  = { ...DEFAULT_SETTINGS };
let carrierSettings = {};   // { [carrierId]: { [fieldKey]: value } }
let saveTimer       = null;

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await loadAllSettings();
  renderCarrierSections();
  populateGlobalForm();
  setupListeners();
  updatePreview();
});

// ─── Load / Save ──────────────────────────────────────────────────────────────
async function loadAllSettings() {
  try {
    const stored = await chrome.storage.local.get(['settings', 'carrierSettings']);
    globalSettings  = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
    carrierSettings = stored.carrierSettings || {};
  } catch (_) {
    globalSettings  = { ...DEFAULT_SETTINGS };
    carrierSettings = {};
  }
}

async function saveAll() {
  // Collect global settings from form
  const newGlobal = {
    language:          document.getElementById('language').value,
    minDelaySeconds:   parseFloat(document.getElementById('min-delay').value)  || DEFAULT_SETTINGS.minDelaySeconds,
    maxDelaySeconds:   parseFloat(document.getElementById('max-delay').value)  || DEFAULT_SETTINGS.maxDelaySeconds,
    totalHours:        parseFloat(document.getElementById('total-hours').value) || 0,
    maxRetries:        parseInt(document.getElementById('max-retries').value)   || DEFAULT_SETTINGS.maxRetries,
    retryDelaySeconds: parseInt(document.getElementById('retry-delay').value)   || DEFAULT_SETTINGS.retryDelaySeconds
  };

  if (newGlobal.minDelaySeconds >= newGlobal.maxDelaySeconds) {
    showStatus('❌ 最小间隔必须小于最大间隔', 'error'); return;
  }
  if (newGlobal.minDelaySeconds < 8) {
    showStatus('❌ 最小间隔建议不低于 8 秒，以确保人机行为安全性', 'error'); return;
  }

  // Collect per-carrier settings from form
  const carriers = listCarriers();
  const newCarrierSettings = {};
  carriers.forEach(carrier => {
    const carrierData = {};
    carrier.settingsSchema.forEach(field => {
      const el = document.getElementById(`cs-${carrier.id}-${field.key}`);
      if (el) carrierData[field.key] = el.value.trim();
    });
    newCarrierSettings[carrier.id] = carrierData;
  });

  globalSettings  = newGlobal;
  carrierSettings = newCarrierSettings;

  try {
    await chrome.storage.local.set({ settings: globalSettings, carrierSettings });
    showStatus('✅ 所有设置已保存', 'success');
    updatePreview();
  } catch (e) {
    showStatus('❌ 保存失败: ' + e.message, 'error');
  }
}

// ─── Carrier Sections (Dynamic) ───────────────────────────────────────────────
function renderCarrierSections() {
  const carriers  = listCarriers();
  const container = document.getElementById('carrier-sections-container');

  const html = `
    <div class="carrier-sections-wrap">
      <div class="section-title-standalone">
        <span class="section-icon">🔐</span>
        物流商 API 凭证配置
        <span class="section-note-standalone">共 ${carriers.length} 个物流商</span>
      </div>
      ${carriers.map(carrier => renderCarrierSection(carrier)).join('')}
    </div>
  `;
  container.innerHTML = html;

  // Wire up toggle behavior
  carriers.forEach(carrier => {
    const header = document.getElementById(`cs-header-${carrier.id}`);
    const body   = document.getElementById(`cs-body-${carrier.id}`);
    const toggle = document.getElementById(`cs-toggle-${carrier.id}`);

    header.addEventListener('click', () => {
      const isOpen = !body.classList.contains('collapsed');
      body.classList.toggle('collapsed', isOpen);
      toggle.classList.toggle('open', !isOpen);
    });

    // Wire toggle-visibility buttons
    carrier.settingsSchema.forEach(field => {
      if (field.type === 'password') {
        const btn = document.getElementById(`vis-${carrier.id}-${field.key}`);
        if (btn) {
          btn.addEventListener('click', () => {
            const input = document.getElementById(`cs-${carrier.id}-${field.key}`);
            input.type  = input.type === 'password' ? 'text' : 'password';
            btn.textContent = input.type === 'password' ? '👁' : '🙈';
          });
        }
      }
    });

    // Populate stored values
    const stored = carrierSettings[carrier.id] || {};
    carrier.settingsSchema.forEach(field => {
      const el = document.getElementById(`cs-${carrier.id}-${field.key}`);
      if (el) el.value = stored[field.key] ?? field.default ?? '';
    });
  });
}

function renderCarrierSection(carrier) {
  // First carrier starts expanded, others collapsed
  const isFirst     = listCarriers()[0].id === carrier.id;
  const bodyClass   = isFirst ? 'cs-body' : 'cs-body collapsed';
  const toggleClass = isFirst ? 'cs-toggle open' : 'cs-toggle';

  return `
    <div class="carrier-section" id="carrier-section-${carrier.id}">
      <div class="cs-header"
           id="cs-header-${carrier.id}"
           style="background:${carrier.bgColor};border-bottom:1px solid ${carrier.borderColor}">
        <div class="cs-badge">
          <span class="cs-emoji">${carrier.emoji}</span>
          <span class="cs-carrier-name" style="color:${carrier.color}">${carrier.name}</span>
          <span class="cs-country">${carrier.description}</span>
          <span class="cs-flag">${carrier.flag}</span>
        </div>
        <a href="${carrier.website}" target="_blank" class="cs-website-link"
           onclick="event.stopPropagation()" style="color:${carrier.color}">官网 ↗</a>
        <span class="${toggleClass}" id="cs-toggle-${carrier.id}">▼</span>
      </div>

      <div class="${bodyClass}" id="cs-body-${carrier.id}">
        ${carrier.settingsSchema.map(field => renderCarrierField(carrier, field)).join('')}
      </div>
    </div>
  `;
}

function renderCarrierField(carrier, field) {
  const inputId   = `cs-${carrier.id}-${field.key}`;
  const visId     = `vis-${carrier.id}-${field.key}`;
  const required  = field.required ? `<span class="required-badge">必填</span>` : '';

  let inputHtml;
  if (field.type === 'password') {
    inputHtml = `
      <div class="input-row">
        <input type="password" id="${inputId}" placeholder="${field.placeholder || ''}"
               class="field-input" autocomplete="off"/>
        <button class="btn-toggle-vis" id="${visId}">👁</button>
      </div>
    `;
  } else if (field.type === 'textarea') {
    inputHtml = `<textarea id="${inputId}" rows="3" placeholder="${field.placeholder || ''}"
                  class="field-input field-textarea" autocomplete="off"></textarea>`;
  } else {
    inputHtml = `<input type="${field.type || 'text'}" id="${inputId}"
                  placeholder="${field.placeholder || ''}" class="field-input"/>`;
  }

  const helpHtml = field.helpSteps ? `
    <details class="how-to">
      <summary>📖 ${field.helpTitle || '如何获取？'}</summary>
      <ol class="how-to-steps">
        ${field.helpSteps.map(step => `<li>${step}</li>`).join('')}
      </ol>
    </details>
  ` : '';

  return `
    <div class="field">
      <label for="${inputId}">${field.label} ${required}</label>
      ${inputHtml}
      ${helpHtml}
    </div>
  `;
}

// ─── Global Form ──────────────────────────────────────────────────────────────
function populateGlobalForm() {
  document.getElementById('language').value    = globalSettings.language    || 'en';
  document.getElementById('min-delay').value   = globalSettings.minDelaySeconds;
  document.getElementById('max-delay').value   = globalSettings.maxDelaySeconds;
  document.getElementById('total-hours').value = globalSettings.totalHours  || 0;
  document.getElementById('max-retries').value = globalSettings.maxRetries;
  document.getElementById('retry-delay').value = globalSettings.retryDelaySeconds;
}

// ─── Event Listeners ──────────────────────────────────────────────────────────
function setupListeners() {
  document.getElementById('btn-save').addEventListener('click', saveAll);

  document.getElementById('btn-reset-defaults').addEventListener('click', () => {
    if (confirm('确定恢复全局调度设置为默认值吗？（物流商凭证不受影响）')) {
      globalSettings = { ...DEFAULT_SETTINGS };
      populateGlobalForm();
      updatePreview();
      showStatus('已恢复默认调度设置（未保存）', 'info');
    }
  });

  ['min-delay', 'max-delay', 'total-hours'].forEach(id => {
    document.getElementById(id).addEventListener('input', updatePreview);
  });

  document.getElementById('link-results').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: chrome.runtime.getURL('results.html') });
  });
}

// ─── Preview ──────────────────────────────────────────────────────────────────
function updatePreview() {
  const minDelay  = parseFloat(document.getElementById('min-delay').value)   || DEFAULT_SETTINGS.minDelaySeconds;
  const maxDelay  = parseFloat(document.getElementById('max-delay').value)   || DEFAULT_SETTINGS.maxDelaySeconds;
  const totalHours = parseFloat(document.getElementById('total-hours').value) || 0;
  const avgDelay  = (minDelay + maxDelay) / 2;

  const rows = [50, 100, 500].map(n => {
    const time = totalHours > 0
      ? `${totalHours} 小时（自适应间隔）`
      : formatDuration(n * avgDelay);
    return `<div class="preview-row"><strong>${n} 个运单</strong>  →  预计 ${time}</div>`;
  }).join('');

  const note = totalHours > 0
    ? `<div class="preview-note">时间窗口模式：在 ${totalHours}h 内自动分配，最小间隔不低于 ${minDelay}s</div>`
    : `<div class="preview-note">随机间隔模式：每次查询随机等待 ${minDelay}s ~ ${maxDelay}s</div>`;

  document.getElementById('preview-content').innerHTML = rows + note;
}

function formatDuration(secs) {
  if (secs < 60)   return `${Math.round(secs)} 秒`;
  if (secs < 3600) return `约 ${Math.round(secs / 60)} 分钟`;
  const h = Math.floor(secs / 3600);
  const m = Math.round((secs % 3600) / 60);
  return `约 ${h} 小时${m > 0 ? ' ' + m + ' 分钟' : ''}`;
}

// ─── Status ───────────────────────────────────────────────────────────────────
function showStatus(msg, type = 'success') {
  const el   = document.getElementById('save-status');
  el.textContent = msg;
  el.style.color = type === 'error' ? '#ff5a6e' : type === 'info' ? '#8890b0' : '#22d3a1';
  clearTimeout(saveTimer);
  if (type === 'success') saveTimer = setTimeout(() => { el.textContent = ''; }, 4000);
}

// ─── Inject extra styles not in options.css ──────────────────────────────────
const style = document.createElement('style');
style.textContent = `
  .section-title-standalone {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 14px;
    font-weight: 600;
    color: var(--text);
    padding: 0 2px 12px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 0;
  }
  .section-note-standalone {
    margin-left: auto;
    font-size: 11px;
    color: var(--text-3);
  }
  .cs-website-link {
    font-size: 11.5px;
    text-decoration: none;
    padding: 3px 8px;
    border-radius: 4px;
    border: 1px solid currentColor;
    opacity: 0.7;
    transition: opacity 0.15s;
  }
  .cs-website-link:hover { opacity: 1; }
  .preview-row { font-size: 12.5px; color: var(--text); padding: 2px 0; }
  .preview-row strong { color: var(--blue); min-width: 90px; display: inline-block; }
  .preview-note {
    margin-top: 8px;
    font-size: 11.5px;
    color: var(--text-3);
    border-top: 1px solid rgba(255,255,255,0.05);
    padding-top: 8px;
  }
`;
document.head.appendChild(style);
