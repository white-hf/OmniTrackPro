/**
 * Purolator Batch Tracker — Popup Controller (ES Module)
 */

import { listCarriers, DEFAULT_CARRIER_ID } from './carriers.js';

// ─── State ────────────────────────────────────────────────────────────────────
let state = { trackingList: [], taskState: null, settings: null, carrierSettings: {} };
let activeTab = 'input';
let resultFilter = 'all';
let selectedCarrierId = DEFAULT_CARRIER_ID;
let timerInterval = null;
let tokenStatusInterval = null;
let toastTimer = null;

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await loadState();

  // Restore selected carrier from last session if available
  if (state.taskState?.carrierId) selectedCarrierId = state.taskState.carrierId;

  setupTabs();
  setupCarrierSelector();
  setupInputTab();
  setupProgressTab();
  setupResultsTab();
  render();

  // Poll token status every 30s so freshness display stays current
  await renderTokenStatus();
  tokenStatusInterval = setInterval(renderTokenStatus, 30_000);

  // Listen for background updates (real-time) — also refreshes token status
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.event === 'STATE_UPDATED') {
      loadState().then(() => { render(); renderTokenStatus(); });
    }
  });
});


// ─── State Loading ────────────────────────────────────────────────────────────
async function loadState() {
  try {
    state = await chrome.runtime.sendMessage({ action: 'GET_STATE' });
    if (!state) state = { trackingList: [], taskState: null, settings: null, carrierSettings: {} };
  } catch (e) {
    state = { trackingList: [], taskState: null, settings: null, carrierSettings: {} };
  }
}

// ─── Tab Management ───────────────────────────────────────────────────────────
function setupTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
}

function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
  document.getElementById(`tab-btn-${tab}`).classList.add('active');
  document.getElementById(`tab-${tab}`).classList.add('active');
}

// ─── CARRIER SELECTOR ────────────────────────────────────────────────────────
function setupCarrierSelector() {
  const carriers = listCarriers();
  const container = document.getElementById('carrier-chips');

  container.dataset.single = carriers.length === 1 ? 'true' : 'false';

  container.innerHTML = carriers.map(c => `
    <div class="carrier-chip${c.id === selectedCarrierId ? ' active' : ''}"
         data-carrier="${c.id}"
         id="chip-${c.id}"
         title="${c.name} — ${c.description}"
         style="${c.id === selectedCarrierId ? `border-color:${c.color};color:${c.color};background:${c.bgColor}` : ''}">
      <span class="chip-emoji">${c.emoji}</span>
      <span class="chip-name" style="${c.id === selectedCarrierId ? `color:${c.color}` : ''}">${c.name}</span>
      <span class="chip-flag">${c.flag}</span>
    </div>
  `).join('');

  // Click to select (only when multiple carriers exist)
  if (carriers.length > 1) {
    container.querySelectorAll('.carrier-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const id = chip.dataset.carrier;
        if (id === selectedCarrierId) return;
        if (state.taskState && !['completed', null].includes(state.taskState?.status)) {
          showToast('⚠️ 请先暂停或重置当前查询任务');
          return;
        }
        selectedCarrierId = id;
        refreshCarrierChips();
        updateEstimate();
        renderTokenStatus();  // Show token status for newly selected carrier
      });
    });
  }
}

// ─── TOKEN STATUS ─────────────────────────────────────────────────────────────
async function renderTokenStatus() {
  const carrier = listCarriers().find(c => c.id === selectedCarrierId);
  // Only Purolator (and future carriers with WAF tokens) needs this
  // Check if carrier has a wafToken field in its schema
  const needsWafToken = carrier?.settingsSchema?.some(f => f.key === 'wafToken');
  const bar     = document.getElementById('token-status-bar');
  const dotEl   = document.getElementById('ts-dot');
  const textEl  = document.getElementById('ts-text');
  const btnEl   = document.getElementById('ts-open-site');
  const ageEl   = document.getElementById('ts-age');

  if (!needsWafToken) {
    bar.style.display = 'none';
    return;
  }
  bar.style.display = 'flex';

  let tokenInfo;
  try {
    tokenInfo = await chrome.runtime.sendMessage({
      action: 'GET_TOKEN_STATUS',
      carrierId: selectedCarrierId
    });
  } catch (_) {
    tokenInfo = { status: 'missing' };
  }

  const { status, age } = tokenInfo || { status: 'missing' };

  // Remove all state classes
  bar.classList.remove('ts-fresh', 'ts-expiring', 'ts-missing', 'ts-expired');
  bar.classList.add(`ts-${status}`);

  switch (status) {
    case 'fresh':
      textEl.textContent     = 'WAF Token 已就绪';
      btnEl.style.display    = 'none';
      ageEl.style.display    = 'inline';
      ageEl.textContent      = `${Math.round(age / 1000)} 秒前获取`;
      break;

    case 'expiring':
      textEl.textContent     = 'WAF Token 即将过期';
      btnEl.style.display    = 'inline-block';
      btnEl.textContent      = '刷新 →';
      ageEl.style.display    = 'inline';
      ageEl.textContent      = `(${Math.round(age / 1000)}s 前)`;
      break;

    case 'expired':
      textEl.textContent     = 'WAF Token 已过期';
      btnEl.style.display    = 'inline-block';
      btnEl.textContent      = '点击刷新 →';
      ageEl.style.display    = 'none';
      break;

    case 'missing':
    default:
      textEl.textContent     = '未获取 Token — 点击右侧按钮，插件将自动捕获';
      btnEl.style.display    = 'inline-block';
      btnEl.textContent      = '打开官网 →';
      ageEl.style.display    = 'none';
      break;
  }
}



function refreshCarrierChips() {
  const carriers = listCarriers();
  carriers.forEach(c => {
    const chip = document.getElementById(`chip-${c.id}`);
    if (!chip) return;
    const isActive = c.id === selectedCarrierId;
    chip.classList.toggle('active', isActive);
    chip.style.borderColor = isActive ? c.color : '';
    chip.style.color       = isActive ? c.color : '';
    chip.style.background  = isActive ? c.bgColor : '';
    chip.querySelector('.chip-name').style.color = isActive ? c.color : '';
  });
}

// ─── INPUT TAB ────────────────────────────────────────────────────────────────
function setupInputTab() {
  // "Open Carrier Site" button — triggers WAF token auto-capture
  document.getElementById('ts-open-site').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ action: 'OPEN_CARRIER_SITE', carrierId: selectedCarrierId });
    showToast('🌐 已打开官网，操作完成后 Token 将自动获取');
    // Re-check status after a short delay to give the page time to load
    setTimeout(renderTokenStatus, 4000);
    setTimeout(renderTokenStatus, 8000);
  });


  const textarea = document.getElementById('tracking-input');

  textarea.addEventListener('input', () => {
    const count = parseTrackingNumbers(textarea.value).length;
    const pill = document.getElementById('count-pill');
    pill.textContent = `${count} 个`;
    pill.classList.toggle('has-count', count > 0);
    document.getElementById('btn-start').disabled = count === 0;
    updateEstimate(count);
  });

  document.getElementById('btn-start').addEventListener('click', async () => {
    const raw = document.getElementById('tracking-input').value;
    const ids = parseTrackingNumbers(raw);
    if (ids.length === 0) return;

    const btn = document.getElementById('btn-start');
    btn.disabled = true;
    btn.textContent = '启动中...';

    const result = await chrome.runtime.sendMessage({
      action: 'START_QUEUE',
      trackingNumbers: raw,
      carrierId: selectedCarrierId
    });

    if (result?.error) {
      showToast('❌ ' + result.error);
      btn.disabled = false;
      btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg> 开始查询';
    } else {
      await loadState();
      render();
      switchTab('progress');
    }
  });

  document.getElementById('btn-continue-from-input').addEventListener('click', async () => {
    const res = await chrome.runtime.sendMessage({ action: 'CONTINUE_QUEUE' });
    if (res?.error) showToast('❌ ' + res.error);
    else { await loadState(); render(); switchTab('progress'); }
  });

  document.getElementById('btn-clear-input').addEventListener('click', () => {
    document.getElementById('tracking-input').value = '';
    document.getElementById('count-pill').textContent = '0 个';
    document.getElementById('count-pill').classList.remove('has-count');
    document.getElementById('btn-start').disabled = true;
    document.getElementById('estimate-row').style.display = 'none';
  });

  document.getElementById('btn-settings').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });
}

function updateEstimate(count) {
  if (count === undefined) {
    count = parseTrackingNumbers(document.getElementById('tracking-input')?.value || '').length;
  }
  const estimateRow  = document.getElementById('estimate-row');
  const estimateText = document.getElementById('estimate-text');
  if (count <= 0) { estimateRow.style.display = 'none'; return; }
  estimateRow.style.display = 'flex';
  estimateText.textContent   = buildEstimateText(count, state.settings);
}

// ─── PROGRESS TAB ─────────────────────────────────────────────────────────────
function setupProgressTab() {
  document.getElementById('btn-resume').addEventListener('click', async () => {
    const res = await chrome.runtime.sendMessage({ action: 'CONTINUE_QUEUE' });
    if (res?.error) showToast('❌ ' + res.error);
    else { await loadState(); render(); }
  });

  document.getElementById('btn-pause').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ action: 'PAUSE_QUEUE' });
    clearInterval(timerInterval);
    await loadState();
    render();
  });

  document.getElementById('btn-open-results').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('results.html') });
  });

  document.getElementById('btn-reset').addEventListener('click', async () => {
    if (!confirm('确定要重置并清空所有数据吗？')) return;
    await chrome.runtime.sendMessage({ action: 'RESET_QUEUE' });
    clearInterval(timerInterval);
    state = { trackingList: [], taskState: null, settings: state.settings, carrierSettings: state.carrierSettings };
    render();
    switchTab('input');
    refreshCarrierChips(); // Re-enable carrier selection
  });
}

// ─── RESULTS TAB ──────────────────────────────────────────────────────────────
function setupResultsTab() {
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      resultFilter = btn.dataset.filter;
      renderResultsTab();
    });
  });

  document.getElementById('btn-copy-csv').addEventListener('click', () => {
    const csv = buildCsv(state.trackingList || []);
    navigator.clipboard.writeText(csv).then(() => showToast('✅ CSV已复制到剪贴板'));
  });

  document.getElementById('btn-export-csv').addEventListener('click', () => {
    const csv = buildCsv(state.trackingList || []);
    downloadCsv(csv, `tracking_${formatDateFile(new Date())}.csv`);
    showToast('✅ CSV文件已下载');
  });

  document.getElementById('btn-open-full').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('results.html') });
  });
}

// ─── Render ───────────────────────────────────────────────────────────────────
function render() {
  renderAlertBanner();
  renderInputTabBtns();
  renderProgressTab();
  renderResultsTab();
  updateTabBadges();
}

function renderAlertBanner() {
  const banner = document.getElementById('alert-banner');
  const text   = document.getElementById('alert-text');
  const ts     = state.taskState;

  if (ts?.status === 'error' && ts.errorInfo) {
    banner.style.display = 'flex';
    banner.className     = 'alert-banner type-error';
    const errCode        = ts.errorInfo.code;
    const codeLabel      = errCode && errCode !== 'TIMEOUT' ? `[HTTP ${errCode}] ` : '';
    text.textContent     = `查询中断: ${codeLabel}${ts.errorInfo.message}`;
    document.getElementById('alert-dismiss').onclick = () => { banner.style.display = 'none'; };
  } else if (ts?.status === 'completed') {
    const done = (state.trackingList || []).filter(i => i.status === 'completed').length;
    banner.style.display = 'flex';
    banner.className     = 'alert-banner type-success';
    text.textContent     = `✅ 全部完成！已查询 ${done}/${ts.totalCount} 个运单`;
    document.getElementById('alert-dismiss').onclick = () => { banner.style.display = 'none'; };
  } else {
    banner.style.display = 'none';
  }
}

function renderInputTabBtns() {
  const ts        = state.taskState;
  const canContinue = ts && ['paused', 'error'].includes(ts.status);
  document.getElementById('btn-continue-from-input').style.display = canContinue ? 'flex' : 'none';

  // Show which carrier the active session is using
  if (ts && ts.carrierId) selectedCarrierId = ts.carrierId;
  refreshCarrierChips();
}

function renderProgressTab() {
  const ts   = state.taskState;
  const list = state.trackingList || [];
  const total   = ts?.totalCount || list.length;
  const done    = list.filter(i => i.status === 'completed').length;
  const pending = list.filter(i => i.status === 'pending').length;
  const fail    = list.filter(i => i.status === 'error').length;
  const pct     = total > 0 ? Math.round(done / total * 100) : 0;

  // Progress ring (circumference = 2π×46 ≈ 289.03)
  const offset = 289.03 * (1 - pct / 100);
  document.getElementById('ring-progress').style.strokeDashoffset = offset;
  document.getElementById('ring-pct').textContent = `${pct}%`;

  document.getElementById('stat-total').textContent   = total || '—';
  document.getElementById('stat-done').textContent    = done;
  document.getElementById('stat-pending').textContent = pending;
  document.getElementById('stat-fail').textContent    = fail;

  // Status dot + text
  const dot = document.getElementById('status-dot');
  const txt = document.getElementById('status-text');
  dot.className = 'status-dot';

  if (!ts) {
    txt.textContent = '未开始';
  } else {
    // Show carrier name in status
    const carrierLabel = ts.carrierName ? `[${ts.carrierName}] ` : '';
    switch (ts.status) {
      case 'running':
        dot.classList.add('dot-running');
        txt.textContent = ts.statusDetail 
          ? `${carrierLabel}${ts.statusDetail}`
          : `${carrierLabel}查询中... (${done}/${total})`;
        startCountdownTimer();
        break;
      case 'paused':
        dot.classList.add('dot-paused');
        txt.textContent = `${carrierLabel}已暂停`;
        stopCountdownTimer();
        break;
      case 'error':
        dot.classList.add('dot-error');
        txt.textContent = `${carrierLabel}查询已停止`;
        stopCountdownTimer();
        break;
      case 'completed':
        dot.classList.add('dot-done');
        txt.textContent = `${carrierLabel}全部完成 ✓`;
        stopCountdownTimer();
        break;
    }
  }

  // Error card
  const errorCard = document.getElementById('error-card');
  if (ts?.status === 'error' && ts.errorInfo) {
    errorCard.style.display = 'block';
    document.getElementById('ec-code').textContent   = ts.errorInfo.code ? `HTTP ${ts.errorInfo.code}` : 'ERROR';
    document.getElementById('ec-msg').textContent    = ts.errorInfo.message || '未知错误';
    document.getElementById('ec-detail').textContent = ts.errorInfo.trackingId ? `运单: ${ts.errorInfo.trackingId}` : '';
    document.getElementById('ec-time').textContent   = ts.errorInfo.timestamp ? `时间: ${formatDate(new Date(ts.errorInfo.timestamp))}` : '';
  } else {
    errorCard.style.display = 'none';
  }

  const isRunning  = ts?.status === 'running';
  const canResume  = ts && ['paused', 'error'].includes(ts.status);
  document.getElementById('btn-resume').style.display = canResume  ? 'inline-flex' : 'none';
  document.getElementById('btn-pause').style.display  = isRunning  ? 'inline-flex' : 'none';
}

function renderResultsTab() {
  const list      = state.trackingList || [];
  const completed = list.filter(i => i.status === 'completed').length;
  document.getElementById('res-count').textContent = `${completed} 条已完成`;

  const displayList = list.filter(item => {
    if (resultFilter === 'all')       return item.status === 'completed' || item.status === 'error';
    if (resultFilter === 'completed') return item.status === 'completed';
    if (resultFilter === 'error')     return item.status === 'error';
    if (resultFilter === 'pending')   return item.status === 'pending';
    return true;
  });

  const tbody  = document.getElementById('mini-tbody');
  const emptyEl = document.getElementById('empty-results');

  if (displayList.length === 0) {
    tbody.innerHTML = '';
    document.getElementById('mini-table').style.display = 'none';
    emptyEl.style.display = 'flex';
    return;
  }

  document.getElementById('mini-table').style.display = 'table';
  emptyEl.style.display = 'none';

  tbody.innerHTML = displayList.map(item => {
    const r = item.result;
    const statusBadge = r
      ? getStatusBadge(r.statusCode, r.statusDescription)
      : item.status === 'error'
        ? `<span class="status-badge badge-error">ERROR</span>`
        : `<span class="status-badge badge-pending">PENDING</span>`;

    const lastEvent = r?.lastEvent?.description
      ? `<span title="${r.lastEvent.formatted}">${r.lastEvent.description}</span>`
      : item.error
        ? `<span style="color:var(--red);font-size:10.5px">${item.error}</span>`
        : '—';

    return `
      <tr>
        <td title="${item.id}" style="font-family:monospace;font-size:11px">${item.id}</td>
        <td>${statusBadge}</td>
        <td style="max-width:140px">${lastEvent}</td>
      </tr>
    `;
  }).join('');

  const badgeResults = document.getElementById('badge-results');
  if (completed > 0) {
    badgeResults.textContent = completed;
    badgeResults.style.display = 'inline-flex';
  } else {
    badgeResults.style.display = 'none';
  }
}

function updateTabBadges() {
  const list = state.trackingList || [];
  const ts   = state.taskState;
  const badgeProgress = document.getElementById('badge-progress');
  const pending = list.filter(i => i.status === 'pending').length;
  if (ts?.status === 'running' && pending > 0) {
    badgeProgress.textContent    = pending;
    badgeProgress.style.display  = 'inline-flex';
  } else {
    badgeProgress.style.display  = 'none';
  }
}

// ─── Countdown Timer ──────────────────────────────────────────────────────────
function startCountdownTimer() {
  stopCountdownTimer();
  updateNextTimer();
  timerInterval = setInterval(updateNextTimer, 1000);
}

function stopCountdownTimer() {
  clearInterval(timerInterval);
  timerInterval = null;
  document.getElementById('next-timer').style.display = 'none';
}

async function updateNextTimer() {
  try {
    const alarm  = await chrome.alarms.get('purolator_next_query');
    const timerEl = document.getElementById('next-timer');
    if (alarm?.scheduledTime) {
      const secs = Math.max(0, Math.round((alarm.scheduledTime - Date.now()) / 1000));
      timerEl.style.display = 'inline';
      timerEl.textContent   = `下次: ${secs}s`;
    } else {
      timerEl.style.display = 'none';
    }
  } catch (_) {}
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function parseTrackingNumbers(text) {
  return [...new Set(text.split(/[\n,;\t\r ]+/).map(s => s.trim()).filter(s => s.length > 3))];
}

function buildEstimateText(count, settings) {
  const cfg    = settings || {};
  const avg    = ((cfg.minDelaySeconds || 8) + (cfg.maxDelaySeconds || 30)) / 2;
  if (cfg.totalHours > 0) return `将在 ${cfg.totalHours} 小时内完成 ${count} 个运单的查询`;
  const secs   = count * avg;
  const fmtTime = s => s < 60 ? `${Math.round(s)} 秒` : s < 3600 ? `约 ${Math.round(s/60)} 分钟` : `约 ${(s/3600).toFixed(1)} 小时`;
  return `预计 ${fmtTime(secs)}（平均间隔 ${avg.toFixed(0)}s）完成 ${count} 个运单`;
}

function getStatusBadge(code, desc) {
  const d   = (desc || '').toLowerCase();
  let cls   = 'badge-default';
  if (['del'].includes((code || '').toLowerCase()) || d.includes('delivered')) cls = 'badge-delivered';
  else if (d.includes('transit') || d.includes('on vehicle')) cls = 'badge-transit';
  else if (code === 'NOT_FOUND') cls = 'badge-error';
  return `<span class="status-badge ${cls}" title="${code}">${desc || code || '—'}</span>`;
}

function buildCsv(list) {
  const headers = [
    '运单号','物流商','状态码','状态描述',
    '最后记录-时间','最后记录-描述','最后记录-地点',
    '首次记录-时间','首次记录-描述','首次记录-地点',
    '发件地','收件地','备注/错误'
  ];
  const rows = list.map(item => {
    const r = item.result;
    if (item.status === 'completed' && r) {
      return [item.id, r.carrierId || '', r.statusCode, r.statusDescription,
        r.lastEvent?.dateTime || '', r.lastEvent?.description || '', r.lastEvent?.location || '',
        r.firstEvent?.dateTime || '', r.firstEvent?.description || '', r.firstEvent?.location || '',
        r.shipper || '', r.receiver || '', ''];
    }
    return [item.id, state.taskState?.carrierId || '', item.status.toUpperCase(), '',
      '', '', '', '', '', '', '', '', item.error || ''];
  });
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  return [headers, ...rows].map(r => r.map(q).join(',')).join('\r\n');
}

function downloadCsv(content, filename) {
  const blob = new Blob(['\uFEFF' + content], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function formatDate(d)     { return d.toLocaleString('zh-CN', { hour12: false }); }
function formatDateFile(d) { return d.toISOString().slice(0, 16).replace(/[T:]/g, '-'); }

function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('visible'), 2500);
}
