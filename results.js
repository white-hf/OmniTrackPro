/**
 * Purolator Batch Tracker — Results Page Controller
 * Full-width table with search, filter, sort, CSV export.
 * Receives real-time updates from background service worker.
 */

let allItems = [];       // Complete tracking list from storage
let taskState = null;
let currentFilter = 'all';
let currentSort = 'input_order';
let searchQuery = '';
let sortDir = {};        // { colName: 'asc'|'desc' }
let toastTimer = null;

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await loadData();
  setupControls();
  render();

  // Real-time updates from background
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.event === 'STATE_UPDATED') {
      loadData().then(render);
    }
  });
});

// ─── Data Loading ─────────────────────────────────────────────────────────────
async function loadData() {
  try {
    const data = await chrome.storage.local.get(['trackingList', 'taskState']);
    allItems = data.trackingList || [];
    taskState = data.taskState || null;
  } catch (e) {
    allItems = [];
    taskState = null;
  }
}

// ─── Controls Setup ───────────────────────────────────────────────────────────
function setupControls() {
  // Search
  document.getElementById('search-input').addEventListener('input', (e) => {
    searchQuery = e.target.value.toLowerCase().trim();
    renderTable();
  });

  // Filter buttons
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentFilter = btn.dataset.filter;
      renderTable();
    });
  });

  // Sort select
  document.getElementById('sort-select').addEventListener('change', (e) => {
    currentSort = e.target.value;
    renderTable();
  });

  // Sortable columns
  document.querySelectorAll('.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      const prev = sortDir[col] || 'asc';
      sortDir[col] = prev === 'asc' ? 'desc' : 'asc';
      document.getElementById('sort-select').value = col;
      currentSort = col;
      document.querySelectorAll('.sortable').forEach(h => h.classList.remove('sorted'));
      th.classList.add('sorted');
      th.querySelector('.sort-arrow').textContent = sortDir[col] === 'asc' ? '↑' : '↓';
      renderTable();
    });
  });

  // Refresh
  document.getElementById('btn-refresh').addEventListener('click', async () => {
    await loadData();
    render();
    showToast('✅ 已刷新');
  });

  // Copy all CSV
  document.getElementById('btn-copy-all').addEventListener('click', () => {
    const csv = buildCsv(getFilteredItems());
    navigator.clipboard.writeText(csv).then(() => showToast('✅ CSV已复制到剪贴板'));
  });

  // Export CSV
  document.getElementById('btn-export').addEventListener('click', () => {
    const csv = buildCsv(getFilteredItems());
    downloadCsv(csv, `purolator_tracking_${formatDateFile(new Date())}.csv`);
    showToast('✅ CSV文件已下载');
  });
}

// ─── Render ───────────────────────────────────────────────────────────────────
function render() {
  renderStats();
  renderTable();
}

function renderStats() {
  const total = taskState?.totalCount || allItems.length;
  const done = allItems.filter(i => i.status === 'completed').length;
  const pending = allItems.filter(i => i.status === 'pending').length;
  const fail = allItems.filter(i => i.status === 'error').length;
  const pct = total > 0 ? Math.round(done / total * 100) : 0;

  document.getElementById('sp-total').textContent = total || '—';
  document.getElementById('sp-done').textContent = done;
  document.getElementById('sp-pending').textContent = pending;
  document.getElementById('sp-fail').textContent = fail;
  document.getElementById('progress-fill').style.width = `${pct}%`;
  document.getElementById('progress-pct').textContent = `${pct}%`;

  // Status dot + text
  const dot = document.getElementById('sp-dot');
  const txt = document.getElementById('sp-status-text');
  dot.className = 'status-dot';

  if (!taskState) {
    txt.textContent = '未开始';
  } else {
    switch (taskState.status) {
      case 'running':
        dot.classList.add('running');
        txt.textContent = taskState.statusDetail 
          ? taskState.statusDetail
          : `查询中... (${done}/${total})`;
        break;
      case 'paused':
        dot.classList.add('paused');
        txt.textContent = '已暂停';
        break;
      case 'error':
        dot.classList.add('error');
        const errCode = taskState.errorInfo?.code;
        const codeLabel = errCode && errCode !== 'TIMEOUT' ? `HTTP ${errCode}: ` : '';
        txt.textContent = `已停止: ${codeLabel}${taskState.errorInfo?.message || ''}`;
        break;
      case 'completed':
        dot.classList.add('done');
        txt.textContent = '全部完成 ✓';
        break;
    }
  }
}

function renderTable() {
  const items = getFilteredItems();
  const tbody = document.getElementById('results-tbody');
  const emptyEl = document.getElementById('empty-state');
  const tableEl = document.getElementById('results-table');
  const countEl = document.getElementById('showing-count');

  countEl.textContent = `显示 ${items.length} / ${allItems.length} 条`;

  if (items.length === 0) {
    tableEl.style.display = 'none';
    emptyEl.style.display = 'flex';
    return;
  }

  tableEl.style.display = 'table';
  emptyEl.style.display = 'none';

  tbody.innerHTML = items.map((item, idx) => buildRow(item, idx + 1)).join('');
}

function getFilteredItems() {
  let items = [...allItems];

  // Filter by status
  if (currentFilter !== 'all') {
    items = items.filter(i => i.status === currentFilter);
  }

  // Filter by search
  if (searchQuery) {
    items = items.filter(i => {
      const r = i.result;
      return (
        i.id.toLowerCase().includes(searchQuery) ||
        (r?.statusDescription || '').toLowerCase().includes(searchQuery) ||
        (r?.statusCode || '').toLowerCase().includes(searchQuery) ||
        (r?.lastEvent?.description || '').toLowerCase().includes(searchQuery) ||
        (r?.lastEvent?.location || '').toLowerCase().includes(searchQuery)
      );
    });
  }

  // Sort
  items = sortItems(items, currentSort);

  return items;
}

function sortItems(items, sortBy) {
  const dir = sortDir[sortBy] === 'desc' ? -1 : 1;

  switch (sortBy) {
    case 'tracking_id':
      return items.sort((a, b) => a.id.localeCompare(b.id) * dir);
    case 'status':
      const order = { completed: 0, error: 1, pending: 2 };
      return items.sort((a, b) => ((order[a.status] ?? 3) - (order[b.status] ?? 3)) * dir);
    case 'last_event_time':
      return items.sort((a, b) => {
        const ta = a.result?.lastEvent?.dateTime || '';
        const tb = b.result?.lastEvent?.dateTime || '';
        return ta.localeCompare(tb) * dir;
      });
    case 'input_order':
    default:
      return items; // Already in original order
  }
}

// ─── Row Builder ──────────────────────────────────────────────────────────────
function buildRow(item, idx) {
  const r = item.result;
  let rowClass = '';
  if (item.status === 'error') rowClass = 'row-error';
  else if (item.status === 'pending') rowClass = 'row-pending';

  // Status badge
  let statusHtml;
  if (item.status === 'completed' && r) {
    statusHtml = `<span class="status-badge ${getStatusBadgeClass(r.statusCode, r.statusDescription)}">${esc(r.statusDescription || r.statusCode)}</span>`;
  } else if (item.status === 'error') {
    statusHtml = `<span class="status-badge badge-error">FAILED</span>`;
  } else {
    statusHtml = `<span class="status-badge badge-pending">PENDING</span>`;
  }

  // Carrier badge
  const carrierName = r?.carrierId || item.carrierId || taskState?.carrierId || '';
  const carrierHtml = carrierName
    ? `<span style="font-size:11px;color:var(--text-3)">${esc(carrierName.toUpperCase())}</span>`
    : '—';

  // ETA Column (Consistent with official website: show Not Available if empty on non-delivered items)
  let etaHtml = '<span class="event-empty">—</span>';
  if (r) {
    const isDelivered = (r.statusDescription || '').toLowerCase().includes('delivered') || 
                        (r.statusCode || '').toLowerCase() === 'del';
    if (isDelivered) {
      etaHtml = '<span class="event-empty">—</span>';
    } else {
      const etaText = r.eta ? r.eta : 'Not Available';
      const isTransit = (r.statusDescription || '').toLowerCase().includes('transit') || 
                        (r.statusCode || '').toLowerCase().includes('int');
      etaHtml = `<div class="eta-cell ${isTransit ? 'eta-highlight' : ''}">${esc(etaText)}</div>`;
    }
  }

  // Pickup Address Column
  let pickupHtml = '<span class="event-empty">—</span>';
  if (r && r.pickupAddress) {
    pickupHtml = `<div class="pickup-cell" title="${esc(r.pickupAddress)}">${esc(truncate(r.pickupAddress, 40))}</div>`;
  }

  // Last 3 events (newest first)
  let lastThreeHtml = '';
  if (item.status === 'error' && item.error) {
    lastThreeHtml = `<div class="error-cell" title="${esc(item.error)}">${esc(truncate(item.error, 60))}</div>`;
  } else if (r?.lastThreeEvents && r.lastThreeEvents.length > 0) {
    lastThreeHtml = `<div class="event-history-container">` + 
      r.lastThreeEvents.map((evt, eIdx) => {
        return `
          <div class="event-history-item ${eIdx === 0 ? 'event-history-latest' : ''}">
            <span class="event-time">${esc(evt.dateTime)}</span>
            <span class="event-desc">${esc(evt.description)}</span>
            ${evt.location ? `<span class="event-loc">📍 ${esc(evt.location)}</span>` : ''}
          </div>
        `;
      }).join('') + `</div>`;
  } else {
    lastThreeHtml = `<div class="event-empty">—</div>`;
  }

  // First event (oldest)
  const firstHtml = buildEventCell(r?.firstEvent, null);

  // Route
  let routeHtml = '<span class="event-empty">—</span>';
  if (r?.shipper || r?.receiver) {
    routeHtml = `
      <div class="route-cell">
        <span>${esc(r.shipper || '?')}</span>
        <span class="route-arrow">→</span>
        <span>${esc(r.receiver || '?')}</span>
      </div>`;
  }

  return `
    <tr class="${rowClass}">
      <td class="td-idx">${idx}</td>
      <td class="td-id" title="${esc(item.id)}">${esc(item.id)}</td>
      <td>${carrierHtml}</td>
      <td>${statusHtml}</td>
      <td>${etaHtml}</td>
      <td>${pickupHtml}</td>
      <td>${lastThreeHtml}</td>
      <td>${firstHtml}</td>
      <td>${routeHtml}</td>
    </tr>
  `;
}

function buildEventCell(event, errorMsg) {
  if (!event && errorMsg) {
    return `<div class="error-cell" title="${esc(errorMsg)}">${esc(truncate(errorMsg, 60))}</div>`;
  }
  if (!event) {
    return `<div class="event-empty">—</div>`;
  }
  return `
    <div class="event-cell">
      <span class="event-time">${esc(event.dateTime)}</span>
      <span class="event-desc">${esc(event.description)}</span>
      ${event.location ? `<span class="event-loc">📍 ${esc(event.location)}</span>` : ''}
    </div>
  `;
}

function getStatusBadgeClass(code, desc) {
  const c = (code || '').toLowerCase();
  const d = (desc || '').toLowerCase();
  if (c === 'del' || d.includes('delivered')) return 'badge-del';
  if (d.includes('transit') || d.includes('on vehicle') || c === 'int') return 'badge-transit';
  if (c === 'not_found') return 'badge-error';
  return 'badge-default';
}

// ─── CSV ──────────────────────────────────────────────────────────────────────
function buildCsv(items) {
  const headers = [
    '运单号', '状态码', '状态描述',
    '预计送达(ETA)', '自提地址',
    '最新记录1-时间', '最新记录1-内容', '最新记录1-地点',
    '最新记录2-时间', '最新记录2-内容', '最新记录2-地点',
    '最新记录3-时间', '最新记录3-内容', '最新记录3-地点',
    '首次记录-时间', '首次记录-内容', '首次记录-地点',
    '发件地', '收件地',
    '运单状态', '错误信息'
  ];

  const rows = items.map(item => {
    const r = item.result;
    if (item.status === 'completed' && r) {
      const e1 = r.lastThreeEvents?.[0] || null;
      const e2 = r.lastThreeEvents?.[1] || null;
      const e3 = r.lastThreeEvents?.[2] || null;
      const isDelivered = (r.statusDescription || '').toLowerCase().includes('delivered') || 
                          (r.statusCode || '').toLowerCase() === 'del';
      const csvEta = r.eta ? r.eta : (isDelivered ? '' : 'Not Available');
      return [
        item.id,
        r.statusCode || '',
        r.statusDescription || '',
        csvEta,
        r.pickupAddress || '',
        e1?.dateTime || '',
        e1?.description || '',
        e1?.location || '',
        e2?.dateTime || '',
        e2?.description || '',
        e2?.location || '',
        e3?.dateTime || '',
        e3?.description || '',
        e3?.location || '',
        r.firstEvent?.dateTime || '',
        r.firstEvent?.description || '',
        r.firstEvent?.location || '',
        r.shipper || '',
        r.receiver || '',
        'completed',
        ''
      ];
    } else {
      return [
        item.id,
        '',
        '',
        '',
        '',
        '', '', '',
        '', '', '',
        '', '', '',
        '', '', '',
        '', '',
        item.status || 'unknown',
        item.error || ''
      ];
    }
  });

  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  return [headers, ...rows].map(row => row.map(q).join(',')).join('\r\n');
}

function downloadCsv(content, filename) {
  const blob = new Blob(['\uFEFF' + content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ─── Utils ────────────────────────────────────────────────────────────────────
function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function truncate(str, len) {
  if (!str) return '';
  return str.length > len ? str.slice(0, len) + '...' : str;
}

function formatDateFile(d) {
  return d.toISOString().slice(0, 16).replace(/[T:]/g, '-');
}

function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('visible'), 2500);
}
