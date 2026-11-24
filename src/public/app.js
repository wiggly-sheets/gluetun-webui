/* Gluetun Web UI - app.js */

const MAX_HISTORY = 30;
const VALID_STATES = new Set(['connected', 'paused', 'disconnected', 'unknown']);
const LATENCY_GOOD_MS = 150;
const LATENCY_WARN_MS = 400;
const MAX_LATENCY_DISPLAY_MS = 800;
const STORAGE_INTERVAL_KEY = 'gluetun-poll-interval';

let instances    = [];   // [{ id, name }] from /api/instances
let isPolling    = false;
let refreshTimer = null;
let latencyChartEnabled = false;
let latencyChartRenderer = 'svg';
const latencyHistory   = new Map(); // id -> number[] (ms, newest last)

// Plotly color vars – resolved at render time so a theme switch picks up the new palette.
const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
function plotlyColorMap() {
  return {
    'var(--green)': cssVar('--green'),
    'var(--yellow)': cssVar('--yellow'),
    'var(--red)': cssVar('--red'),
    'var(--muted)': cssVar('--muted')
  };
}
let authorized   = true; // false once the session expires / user logs out
let authEnabled  = false; // server tells us whether login is configured

// ---- Utility ----

function $(id) { return document.getElementById(id); }
function setEl(id, val) { const el = $(id); if (el) el.textContent = val ?? '–'; }
function setText(id, val) { setEl(id, val); }

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function showToast(msg, type = 'info', duration = 3500) {
  const t = $('toast');
  t.textContent = msg;
  t.className = `toast ${type}`;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.className = 'toast hidden'; }, duration);
}

function isIPv6(ip) {
  return ip && ip.includes(':');
}

function ipTypeLabel(ip) {
  return isIPv6(ip) ? 'IPv6' : 'IPv4';
}

// ---- Authentication UI ----

function stopPolling() {
  authorized = false;
  clearTimeout(refreshTimer);
  isPolling = false;
}

function showLogin() {
  stopPolling();
  $('login-view').classList.remove('hidden');
  $('logout-btn').classList.add('hidden');
  $('app-main').classList.add('hidden');
}

function showDashboard() {
  authorized = true;
  $('login-view').classList.add('hidden');
  $('logout-btn').classList.toggle('hidden', !authEnabled);
  $('app-main').classList.remove('hidden');
}

function showLoginError(message) {
  const errEl = $('login-error');
  errEl.textContent = message;
  errEl.classList.remove('hidden');
}

// ---- Per-instance session history ----

function sessionKey(id) { return `gluetun_history_${id}`; }

function loadHistoryFor(id) {
  try {
    const raw = JSON.parse(sessionStorage.getItem(sessionKey(id)));
    return Array.isArray(raw) ? raw.filter(s => VALID_STATES.has(s)) : [];
  } catch (_) { return []; }
}

function pushHistoryFor(id, state) {
  const hist = loadHistoryFor(id);
  hist.push(state);
  if (hist.length > MAX_HISTORY) hist.shift();
  try { sessionStorage.setItem(sessionKey(id), JSON.stringify(hist)); } catch (_) {}
}

function renderHistoryFor(id) {
  const track = document.getElementById(`i${id}-history-track`);
  if (!track) return;
  const hist = loadHistoryFor(id);
  track.innerHTML = '';
  hist.forEach((s, i) => {
    const tick = document.createElement('div');
    tick.className = `history-tick ${s}`;
    tick.title = `Poll #${i + 1}: ${s}`;
    track.appendChild(tick);
  });
}

// ---- Per-instance latency history ----

function pushLatencyFor(id, ms) {
  const hist = latencyHistory.get(id) || [];
  hist.push(ms);
  if (hist.length > MAX_HISTORY) hist.shift();
  latencyHistory.set(id, hist);
  try { localStorage.setItem(`gluetun_latency_${id}`, JSON.stringify(hist)); } catch (_) {}
}

function loadLatencyFor(id) {
  try {
    const raw = JSON.parse(localStorage.getItem(`gluetun_latency_${id}`));
    return Array.isArray(raw) ? raw.slice(0, MAX_HISTORY) : [];
  } catch (_) { return []; }
}

function latencyColor(ms) {
  if (ms === null || ms === undefined) return 'var(--muted)';
  if (ms < LATENCY_GOOD_MS)  return 'var(--green)';
  if (ms < LATENCY_WARN_MS)  return 'var(--yellow)';
  return 'var(--red)';
}

function renderSvgChartFor(container, hist) {
  const W = container.clientWidth || 600;
  const H = 64;
  const BAR_GAP = 2;
  const barW = Math.max(2, Math.floor((W - BAR_GAP) / MAX_HISTORY) - BAR_GAP);
  const cols = Math.floor((W + BAR_GAP) / (barW + BAR_GAP));
  const slice = hist.slice(-cols);
  const svgW = slice.length * (barW + BAR_GAP);

  const bars = slice.map((ms, i) => {
    const height = ms === null
      ? 4
      : Math.max(4, Math.round((ms / MAX_LATENCY_DISPLAY_MS) * H));
    const y = H - height;
    const color = latencyColor(ms);
    return `<rect x="${i * (barW + BAR_GAP)}" y="${y}" width="${barW}" height="${height}" rx="2" fill="${color}" opacity="0.85" />`;
  }).join('');

  container.innerHTML = `<svg width="${svgW}" height="${H}" style="display:block">${bars}</svg>`;
}

function loadPlotly(onLoad) {
  const s = document.createElement('script');
  s.src = '/vendor/plotly/plotly-basic.min.js';
  s.onload = onLoad;
  document.head.appendChild(s);
}

// Containers already handed to Plotly. The lazy-load transition may leave the SVG chart
// in the container; Plotly inserts (not replaces) its plot div, so the first render must clear.
const plotlyRendered = new WeakSet();

function renderPlotlyChartFor(container, hist) {
  if (!plotlyRendered.has(container)) {
    container.innerHTML = '';
    plotlyRendered.add(container);
  }
  const x = hist.map((_, i) => i);
  // 50 = the SVG renderer's minimum bar (4px on a 64px chart, scaled to the [0,800] axis); every bar gets at least this
  const y = hist.map(ms => ms === null ? 50 : Math.max(50, ms));
  const customdata = hist.map(ms => ms === null ? '–' : ms + 'ms');
  const colors = plotlyColorMap();
  const markerColor = hist.map(ms => {
    const c = latencyColor(ms);
    return colors[c] || '#64748b';
  });
  const data = [{
    x: x,
    y: y,
    customdata: customdata,
    marker: { color: markerColor },
    hovertemplate: '%{customdata}<extra></extra>',
    type: 'bar'
  }];
  const layout = {
    height: 64,
    margin: { t: 4, r: 4, b: 4, l: 30 },
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor: 'rgba(0,0,0,0)',
    font: { color: cssVar('--muted') || '#64748b', size: 10 },
    xaxis: { showgrid: false, zeroline: false, showticklabels: false },
    yaxis: { range: [0, MAX_LATENCY_DISPLAY_MS], showgrid: true, gridcolor: 'rgba(100,116,139,0.15)', zeroline: false },
    bargap: 0.25
  };
  const config = { displayModeBar: false, responsive: true };
  Plotly.react(container, data, layout, config);
}

function renderLatencyChartFor(id) {
  const container = document.getElementById(`i${id}-latency-chart`);
  if (!container) return;
  const hist = latencyHistory.get(id) || [];
  if (hist.length === 0) {
    container.innerHTML = '';
    return;
  }

  if (latencyChartRenderer === 'plotly' && window.Plotly && window.Plotly.react) {
    renderPlotlyChartFor(container, hist);
  } else {
    renderSvgChartFor(container, hist);
  }

  const latest = hist[hist.length - 1];
  const statEl = document.getElementById(`i${id}-latency-stat`);
  if (statEl) {
    statEl.textContent = latest === null ? '–' : `${latest}ms`;
    statEl.style.color = latencyColor(latest);
  }
}

// ---- Dashboard cards ----
// Markup and updates for each card live together, so an element ID cannot drift
// between the template and the code that writes it.
const CARD_MODULES = {
  ip: {
    mount: (id, inst) => `
      <div class="card" data-card-id="ip" draggable="false">
        <div class="card-header">
          <span class="card-icon">&#127760;</span>
          <h3>${escHtml(inst.name)}</h3>
        </div>
        <div class="card-body">
          <div class="stat-row">
            <span class="stat-label" id="i${id}-ip-primary-label">Public IP</span>
            <span class="stat-value mono" id="i${id}-ip-address">–</span>
          </div>
          <div class="stat-row secondary-ip-row">
            <span class="stat-label" id="i${id}-ip-secondary-label">Secondary IP</span>
            <span class="stat-value mono" id="i${id}-ip-secondary">–</span>
          </div>
          <div class="stat-row"><span class="stat-label">Country</span><span class="stat-value" id="i${id}-ip-country">–</span></div>
          <div class="stat-row"><span class="stat-label">City</span><span class="stat-value" id="i${id}-ip-city">–</span></div>
          <div class="stat-row"><span class="stat-label">Organisation</span><span class="stat-value" id="i${id}-ip-org">–</span></div>
        </div>
      </div>`,
    update: (id, ctx) => {
      const { ip, primaryIp, primaryDisplay, secondaryIp, showSecondary } = ctx;
      const secondaryEl = document.getElementById(`i${id}-ip-secondary`);
      const secondaryRow = secondaryEl ? secondaryEl.closest('.stat-row') : null;
      setEl(`i${id}-ip-primary-label`, showSecondary ? ipTypeLabel(primaryIp) : 'Public IP');
      setEl(`i${id}-ip-address`, primaryDisplay || '–');
      if (secondaryRow) secondaryRow.style.display = showSecondary ? 'flex' : 'none';
      if (showSecondary) {
        setEl(`i${id}-ip-secondary-label`, secondaryIp ? ipTypeLabel(secondaryIp) : 'Secondary IP');
        setEl(`i${id}-ip-secondary`, secondaryIp || '–');
      }
      setEl(`i${id}-ip-country`, ip?.country ?? '–');
      setEl(`i${id}-ip-city`, ip?.city ?? '–');
      setEl(`i${id}-ip-org`, ip?.org ?? ip?.organization ?? '–');
    },
    clear: id => {
      setEl(`i${id}-ip-primary-label`, 'Public IP');
      setEl(`i${id}-ip-address`, '–');
      setEl(`i${id}-ip-country`, '–');
      setEl(`i${id}-ip-city`, '–');
      setEl(`i${id}-ip-org`, '–');
      setEl(`i${id}-ip-secondary-label`, 'Secondary IP');
      const secondaryEl = document.getElementById(`i${id}-ip-secondary`);
      const secondaryRow = secondaryEl ? secondaryEl.closest('.stat-row') : null;
      if (secondaryRow) secondaryRow.style.display = 'none';
    },
  },

  vpn: {
    mount: id => `
      <div class="card" data-card-id="vpn" draggable="false">
        <div class="card-header">
          <span class="card-icon">&#128274;</span>
          <h3>VPN Connection</h3>
        </div>
        <div class="card-body">
          <div class="stat-row"><span class="stat-label">Status</span><span class="stat-value" id="i${id}-vpn-status">–</span></div>
          <div class="stat-row"><span class="stat-label">Provider</span><span class="stat-value" id="i${id}-vpn-provider">–</span></div>
          <div class="stat-row"><span class="stat-label">Server</span><div id="i${id}-server-container" class="server-input-container"><select id="i${id}-server-select" class="server-select" aria-label="VPN server"><option value="">Auto (best)</option></select></div></div>
          <div class="stat-row"><span class="stat-label">Protocol</span><span class="stat-value" id="i${id}-vpn-protocol">–</span></div>
          <div class="stat-row"><span class="stat-label">Country</span><span class="stat-value" id="i${id}-vpn-country">–</span></div>
          <div class="stat-row"><span class="stat-label">City</span><span class="stat-value" id="i${id}-vpn-city">–</span></div>
        </div>
      </div>`,
    update: (id, ctx) => {
      const { s, d, ip } = ctx;
      setEl(`i${id}-vpn-status`, d?.status ?? '–');
      setEl(`i${id}-vpn-provider`, s?.provider?.name ?? '–');
      setEl(`i${id}-vpn-protocol`, s?.type ?? '–');
      setEl(`i${id}-vpn-country`, ip?.country ?? '–');
      setEl(`i${id}-vpn-city`, ip?.city ?? '–');
      updateServerSelect(id, s);
    },
    clear: id => {
      setEl(`i${id}-vpn-status`, '–');
      setEl(`i${id}-vpn-provider`, '–');
      setEl(`i${id}-vpn-protocol`, '–');
      setEl(`i${id}-vpn-country`, '–');
      setEl(`i${id}-vpn-city`, '–');
      updateServerSelect(id, null);
    },
  },

  port: {
    mount: id => `
      <div class="card" data-card-id="port" draggable="false">
        <div class="card-header">
          <span class="card-icon">&#128268;</span>
          <h3>Port Forwarding</h3>
        </div>
        <div class="card-body">
          <div class="stat-row"><span class="stat-label">Forwarded Port</span><span class="stat-value mono" id="i${id}-port-number">–</span></div>
        </div>
      </div>`,
    update: (id, ctx) => {
      const data = ctx.health.portForwarded?.ok ? ctx.health.portForwarded.data : null;
      const port = data?.port ?? 0;
      const configured = data?.source === 'env';
      setEl(`i${id}-port-number`, port > 0
        ? `${port}${configured ? ' (configured)' : ''}`
        : ctx.health.portForwarded?.ok ? 'Not forwarded' : 'N/A');
    },
    clear: id => setEl(`i${id}-port-number`, 'N/A'),
  },

  dns: {
    mount: id => `
      <div class="card" data-card-id="dns" draggable="false">
        <div class="card-header">
          <span class="card-icon">&#128225;</span>
          <h3>DNS</h3>
        </div>
        <div class="card-body">
          <div class="stat-row"><span class="stat-label">Status</span><span class="stat-value" id="i${id}-dns-status">–</span></div>
        </div>
      </div>`,
    update: (id, ctx) => {
      const dns = ctx.health.dnsStatus;
      setEl(`i${id}-dns-status`, dns?.ok ? (dns.data?.status ?? 'OK') : 'Unavailable');
    },
    clear: id => setEl(`i${id}-dns-status`, 'Unavailable'),
  },

  history: {
    mount: id => `
      <div class="card card-wide" data-card-id="history" draggable="false">
        <div class="card-header">
          <span class="card-icon">&#128200;</span>
          <h3>Status History (last 30 polls)</h3>
        </div>
        <div class="card-body">
          <div class="history-track" id="i${id}-history-track"></div>
          <div class="history-legend">
            <span class="dot connected"></span> Connected &nbsp;
            <span class="dot paused"></span> Paused &nbsp;
            <span class="dot disconnected"></span> Disconnected &nbsp;
            <span class="dot unknown"></span> Unknown
          </div>
        </div>
      </div>`,
    update: (id, ctx) => {
      pushHistoryFor(id, ctx.state);
      renderHistoryFor(id);
    },
    clear: id => {
      pushHistoryFor(id, 'unknown');
      renderHistoryFor(id);
    },
  },

  latency: {
    mount: id => latencyChartEnabled ? `
      <div class="card card-wide">
        <div class="card-header">
          <span class="card-icon">&#9889;</span>
          <h3>Latency (last 30 polls)</h3>
          <span id="i${id}-latency-stat" class="stat-value" style="margin-left:auto;font-size:0.9rem">–</span>
        </div>
        <div class="card-body">
          <div class="latency-chart-wrapper">
            <div class="latency-chart" id="i${id}-latency-chart"></div>
          </div>
          <div class="history-legend">
            <span class="dot latency-good"></span> <150ms &nbsp;
            <span class="dot latency-warn"></span> 150–400ms &nbsp;
            <span class="dot latency-bad"></span> >400ms &nbsp;
            <span class="dot unknown"></span> Failed
          </div>
        </div>
      </div>` : '',
  },

  airvpn: {
    mount: id => `
      <div class="card card-wide airvpn-card" id="i${id}-airvpn-card">
        <div class="card-header">
          <span class="card-icon">&#127758;</span>
          <h3>AirVPN Server</h3>
          <span id="i${id}-airvpn-server-name" class="badge ok"></span>
        </div>
        <div class="card-body">
          <div class="stat-row"><span class="stat-label">Health</span><span class="stat-value" id="i${id}-airvpn-health">–</span></div>
          <div class="stat-row"><span class="stat-label">Load</span><span class="stat-value" id="i${id}-airvpn-load">–</span></div>
          <div class="stat-row"><span class="stat-label">Bandwidth</span><span class="stat-value mono" id="i${id}-airvpn-bw">–</span></div>
          <div class="stat-row"><span class="stat-label">Users</span><span class="stat-value" id="i${id}-airvpn-users">–</span></div>
          <div class="stat-row"><span class="stat-label">Location</span><span class="stat-value" id="i${id}-airvpn-location">–</span></div>
          <div class="stat-row"><span class="stat-label">Transferred</span><span class="stat-value mono" id="i${id}-airvpn-transfer">–</span></div>
          <div class="stat-row"><span class="stat-label">Speed</span><span class="stat-value mono" id="i${id}-airvpn-speed">–</span></div>
          <div class="stat-row"><span class="stat-label">Connected</span><span class="stat-value" id="i${id}-airvpn-connected">–</span></div>
        </div>
      </div>`,
    update: (id, ctx) => {
      const { airVpnServer, airVpnUserInfo } = ctx.health;
      const card = document.getElementById(`i${id}-airvpn-card`);
      if (!card) return;
      if (!airVpnServer?.ok || airVpnServer?.data == null) {
        card.classList.remove('visible');
        return;
      }
      card.classList.add('visible');
      const s = airVpnServer.data;
      setEl(`i${id}-airvpn-server-name`, s.public_name || '–');
      setEl(`i${id}-airvpn-health`, s.health === 'ok' ? 'OK' : (s.warning || s.health || '–'));
      setEl(`i${id}-airvpn-load`, s.currentload !== undefined ? `${s.currentload}%` : '–');
      setEl(`i${id}-airvpn-bw`, s.bw !== undefined && s.bw_max !== undefined ? `${s.bw}/${s.bw_max} Mbps` : '–');
      setEl(`i${id}-airvpn-users`, s.users !== undefined ? String(s.users) : '–');
      const loc = [s.location, s.country_name].filter(Boolean).join(', ');
      setEl(`i${id}-airvpn-location`, loc || '–');
      const nameBadge = document.getElementById(`i${id}-airvpn-server-name`);
      if (nameBadge) nameBadge.className = s.health === 'ok' ? 'badge ok' : 'badge warn';

      const conn = airVpnUserInfo?.ok ? airVpnUserInfo.data?.connection : null;
      if (conn) {
        const read = conn.bytes_read || 0;
        const write = conn.bytes_write || 0;
        setEl(`i${id}-airvpn-transfer`, `${formatBytes(read)} ↑ / ${formatBytes(write)} ↓`);
        const spdR = conn.speed_read || 0;
        const spdW = conn.speed_write || 0;
        setEl(`i${id}-airvpn-speed`, `${formatBytes(spdR)}/s ↑ / ${formatBytes(spdW)}/s ↓`);
        setEl(`i${id}-airvpn-connected`, conn.connected_since_date || '–');
      } else {
        setEl(`i${id}-airvpn-transfer`, '–');
        setEl(`i${id}-airvpn-speed`, '–');
        setEl(`i${id}-airvpn-connected`, '–');
      }
    },
    clear: id => document.getElementById(`i${id}-airvpn-card`)?.classList.remove('visible'),
  },

  provider: {
    mount: id => `
      <div class="card card-wide provider-card" id="i${id}-provider-card">
        <div class="card-header">
          <span class="card-icon">&#127760;</span>
          <h3>Provider Server</h3>
          <span id="i${id}-provider-server-name" class="badge ok"></span>
        </div>
        <div class="card-body" id="i${id}-provider-body">
          <div class="stat-row"><span class="stat-label">Location</span><span class="stat-value" id="i${id}-provider-location">–</span></div>
          <div class="stat-row"><span class="stat-label">Load</span><span class="stat-value" id="i${id}-provider-load">–</span></div>
        </div>
      </div>`,
    update: (id, ctx) => {
      const providerData = ctx.health.providerData;
      const card = document.getElementById(`i${id}-provider-card`);
      if (!card) return;
      if (!providerData?.ok || providerData.data == null) {
        card.classList.remove('visible');
        return;
      }
      card.classList.add('visible');
      const d = providerData.data;
      setEl(`i${id}-provider-server-name`, d.serverName || '–');
      setEl(`i${id}-provider-location`, d.location || '–');
      setEl(`i${id}-provider-load`, typeof d.load === 'number' ? `${d.load}%` : '–');
      const body = document.getElementById(`i${id}-provider-body`);
      body?.querySelectorAll('.provider-extra').forEach(el => el.remove());
      (d.extra || []).forEach(row => {
        const div = document.createElement('div');
        div.className = 'stat-row provider-extra';
        const label = document.createElement('span');
        label.className = 'stat-label';
        label.textContent = row.label;
        const value = document.createElement('span');
        value.className = 'stat-value';
        value.textContent = row.value ?? '–';
        div.append(label, value);
        body.appendChild(div);
      });
    },
    clear: id => document.getElementById(`i${id}-provider-card`)?.classList.remove('visible'),
  },
};

function cardMarkup(id, inst) {
  return Object.values(CARD_MODULES).map(m => m.mount ? m.mount(id, inst) : '').join('');
}

function buildDashboardGroup(inst) {
  const id = String(inst.id);
  if (!/^\d+$/.test(id)) return document.createDocumentFragment();
  const group = document.createElement('div');
  group.className = 'dashboard-group';
  group.id = `dashboard-${id}`;
  group.innerHTML = `
    <div class="status-banner unknown" id="i${id}-banner">
      <div class="banner-icon">&#9679;</div>
      <div class="banner-text">
        <span id="i${id}-banner-title">Checking VPN status…</span>
        <span id="i${id}-banner-sub" class="muted"></span>
      </div>
      <div class="banner-actions">
        <button id="i${id}-btn-start" type="button" class="btn-success">&#9654; Start</button>
        <button id="i${id}-btn-stop" type="button" class="btn-danger">&#9209; Stop</button>
      </div>
    </div>
    <div class="dashboard-grid" id="i${id}-grid">${cardMarkup(id, inst)}</div>
  `;
  group.querySelector(`#i${id}-btn-start`).addEventListener('click', () => vpnAction(id, 'start'));
  group.querySelector(`#i${id}-btn-stop`).addEventListener('click', () => vpnAction(id, 'stop'));
  const serverSelect = group.querySelector(`#i${id}-server-select`);
  serverSelect.addEventListener('change', () => {
    updateServerForInstance(id, serverSelect.value);
  });
  return group;
}

function renderAllDashboards() {
  const container = $('dashboards-container');
  container.innerHTML = '';
  // CSS keeps this at one column on narrow screens; the inline value only sets the desktop count.
  container.style.setProperty('--dash-cols', Math.min(instances.length, 4) || 1);
  instances.forEach(inst => {
    container.appendChild(buildDashboardGroup(inst));
    applyLayout(inst.id);
    renderHistoryFor(inst.id);
    if (latencyChartEnabled) renderLatencyChartFor(inst.id);
  });
}

// ---- Server dropdown population ----

function populateServerSelect(select, servers, vpnType) {
  select.innerHTML = '<option value="">Auto (best)</option>';
  const seen = new Set();
  const byCountry = new Map();
  for (const entry of servers) {
    if (!entry?.server_name) continue;
    if (vpnType && entry.vpn !== vpnType) continue;
    if (seen.has(entry.server_name)) continue;
    seen.add(entry.server_name);
    if (!byCountry.has(entry.country)) byCountry.set(entry.country, []);
    byCountry.get(entry.country).push(entry.server_name);
  }
  for (const [country, names] of byCountry) {
    const group = document.createElement('optgroup');
    group.label = country || 'Other';
    names.forEach(name => {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      group.appendChild(opt);
    });
    select.appendChild(group);
  }
}

// --- Update the server dropdown for an instance's provider (fetched once per provider) ---
function applyServerValue(select, name) {
  if (document.activeElement === select) return;
  if (name && !Array.from(select.options).some(o => o.value === name)) {
    select.add(new Option(name, name));
  }
  select.value = name;
}

function updateServerSelect(id, s) {
  const select = document.getElementById(`i${id}-server-select`);
  if (!select) return;
  const provider = s?.provider?.name ?? '';
  const vpnType = s?.provider?.server_selection?.vpn ?? '';
  const currentName = s?.provider?.server_selection?.names?.[0] ?? '';
  if (!provider) {
    delete select.dataset.provider;
    delete select.dataset.vpn;
    select.innerHTML = '<option value="">Auto (best)</option>';
    select.disabled = true;
    return;
  }
  if (select.dataset.provider !== provider || select.dataset.vpn !== vpnType) {
    const retryKey = `${id}:${provider}:${vpnType}`;
    if ((serversRetryAt.get(retryKey) || 0) > Date.now()) return;
    select.disabled = true;
    select.dataset.provider = provider;
    select.dataset.vpn = vpnType;
    fetch(`/api/${id}/servers?provider=${encodeURIComponent(provider)}`)
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then(data => {
        if (!data.ok) throw new Error(data.error ?? 'Unknown error');
        serversRetryAt.delete(retryKey);
        populateServerSelect(select, data.data, vpnType);
        select.disabled = false;
        applyServerValue(select, currentName);
      })
      .catch(err => {
        console.error(`[servers][${id}]`, err.message);
        serversRetryAt.set(retryKey, Date.now() + 60000);
        delete select.dataset.provider;
        delete select.dataset.vpn;
        select.innerHTML = '<option value="">Auto (best)</option>';
        select.disabled = true;
      });
  } else {
    applyServerValue(select, currentName);
  }
}

// ---- Update a panel with health data ----

function updatePanel(inst, health) {
  const id = inst.id;
  const d  = health.vpnStatus?.ok ? health.vpnStatus.data : null;
  const s  = health.vpnSettings?.ok ? health.vpnSettings.data : null;
  const ip = health.publicIp?.ok ? health.publicIp.data : null;

  const state = !health.vpnStatus?.ok ? 'unknown'
    : d?.status === 'running' ? 'connected'
    : d?.status === 'stopped' ? 'paused'
    : 'disconnected';

  const banner = document.getElementById(`i${id}-banner`);
  if (banner) banner.className = `status-banner ${state}`;

  const primaryIp   = ip?.public_ip ?? ip?.ip ?? '';
  const secondaryIp = health.publicIpv6?.ok ? (health.publicIpv6.data?.ipv6 || '') : '';
  const displayMode = inst.ipDisplayMode || 'auto';
  const showSecondary = displayMode === 'dual' || (displayMode === 'auto' && !!secondaryIp);
  const primaryDisplay = showSecondary ? primaryIp : (primaryIp || secondaryIp);

  const pubIpStr = primaryIp || '';
  let sub = '';
  if      (state === 'connected')    sub = pubIpStr ? `Public IP: ${pubIpStr}` : 'Tunnel is up';
  else if (state === 'paused')       sub = pubIpStr ? `Gluetun active – exit IP: ${pubIpStr}` : 'Gluetun active – VPN process stopped';
  else if (state === 'disconnected') sub = 'Tunnel is down – traffic may be unprotected';
  else                               sub = 'Could not reach Gluetun control API';
  if (secondaryIp) sub += ` · ${secondaryIp}`;

  const title = state === 'connected' ? 'VPN Connected'
    : state === 'paused' ? 'VPN Paused'
    : state === 'disconnected' ? 'VPN Disconnected'
    : 'Status Unknown';
  setEl(`i${id}-banner-title`, title);
  setEl(`i${id}-banner-sub`, sub);

  const ctx = { state, d, s, ip, health, primaryIp, primaryDisplay, secondaryIp, showSecondary };
  CARD_MODULES.ip.update(id, ctx);
  CARD_MODULES.vpn.update(id, ctx);
  CARD_MODULES.port.update(id, ctx);
  CARD_MODULES.dns.update(id, ctx);
  CARD_MODULES.history.update(id, ctx);
  CARD_MODULES.airvpn.update(id, ctx);
  CARD_MODULES.provider.update(id, ctx);
}

function formatBytes(b) {
  if (b < 1) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(b) / Math.log(1024));
  return `${(b / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

function updatePanelError(inst) {
  const id = inst.id;
  const banner = document.getElementById(`i${id}-banner`);
  if (banner) banner.className = 'status-banner unknown';
  setEl(`i${id}-banner-title`, 'Status Unknown');
  setEl(`i${id}-banner-sub`, 'Could not reach Gluetun control API');
  ['ip', 'vpn', 'port', 'dns', 'history', 'airvpn', 'provider'].forEach(name => {
    CARD_MODULES[name].clear(id);
  });
}

// ---- API ----

async function fetchHealth(instanceId) {
  const res = await fetch(`/api/${instanceId}/health`);
  if (res.status === 401) { showLogin(); showLoginError('Session expired, please sign in again.'); throw new Error('Unauthorized'); }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ---- Poll all instances in parallel ----

async function pollAll() {
  if (isPolling || !authorized) return;
  isPolling = true;
  const refreshBtn = $('refresh-btn');
  refreshBtn.textContent = '';
  const spin = document.createElement('span');
  spin.className = 'spin';
  spin.textContent = '\u21bb';
  refreshBtn.appendChild(spin);
  refreshBtn.appendChild(document.createTextNode(' Refresh'));
  refreshBtn.disabled = true;

  await Promise.allSettled(instances.map(async inst => {
    try {
      const t0 = performance.now();
      const health = await fetchHealth(inst.id);
      const latencyMs = Math.round(performance.now() - t0);
      if (latencyChartEnabled) pushLatencyFor(inst.id, latencyMs);
      updatePanel(inst, health);
      if (latencyChartEnabled) renderLatencyChartFor(inst.id);
    } catch (err) {
      console.error(`[poll][${inst.id}]`, err);
      if (latencyChartEnabled) pushLatencyFor(inst.id, null);
      updatePanelError(inst);
      if (latencyChartEnabled) renderLatencyChartFor(inst.id);
    }
  }));

  setEl('last-updated', `Updated ${new Date().toLocaleTimeString()}`);
  refreshBtn.textContent = '\u21bb Refresh';
  refreshBtn.disabled = false;
  isPolling = false;
}

// ---- VPN actions ----

async function vpnAction(instanceId, action) {
  const inst  = instances.find(i => i.id === instanceId);
  const name  = inst?.name ?? instanceId;
  const label = action === 'start' ? 'Starting' : 'Stopping';
  showToast(`${label} ${name}…`, 'info', 5000);
  try {
    const res  = await fetch(`/api/${instanceId}/vpn/${action}`, { method: 'PUT' });
    if (res.status === 401) { showLogin(); showLoginError('Session expired, please sign in again.'); return; }
    const data = await res.json();
    if (data.ok) {
      showToast(`${name}: VPN ${action} command sent`, 'success');
      clearTimeout(refreshTimer);
      setTimeout(async () => { await pollAll(); scheduleNextPoll(); }, 2000);
    } else {
      showToast(`${name}: ${data.error ?? 'Unknown error'}`, 'error', 5000);
    }
  } catch (err) {
    showToast(`${name}: Request failed: ${err.message}`, 'error', 5000);
  }
}

// ---- Auto refresh ----

function scheduleNextPoll() {
  clearTimeout(refreshTimer);
  if (!authorized) return;
  const interval = parseInt($('refresh-interval').value, 10);
  if (interval > 0) {
    refreshTimer = setTimeout(async () => {
      await pollAll();
      scheduleNextPoll();
    }, interval);
  }
}

function applyAutoRefresh() {
  clearTimeout(refreshTimer);
  scheduleNextPoll();
}

// ---- Speed Test ----

let speedtestRunning = false;
let speedtestResults = [];
let speedtestResizeBound = false;

function buildSpeedtestCard() {
  const card = document.createElement('div');
  card.className = 'card card-wide';
  card.id = 'speedtest-card';
  card.innerHTML = `
    <div class="card-header">
      <span class="card-icon">&#9889;</span>
      <h3>Speed Test</h3>
    </div>
    <div class="card-body">
      <div class="speedtest-controls">
        <button id="speedtest-run" class="btn-success">&#9654; Run Test</button>
        <span id="speedtest-status" class="muted"></span>
        <select id="speedtest-range" class="muted" aria-label="Speed test history range">
          <option value="5">Last 5</option>
          <option value="10">Last 10</option>
          <option value="20">Last 20</option>
          <option value="0" selected>All</option>
        </select>
      </div>
      <div id="speedtest-result" class="speedtest-result hidden">
        <div class="speedtest-stats">
          <div class="speedtest-stat">
            <span class="speedtest-stat-label">Download</span>
            <span class="speedtest-stat-value mono" id="speedtest-dl">–</span>
          </div>
          <div class="speedtest-stat">
            <span class="speedtest-stat-label">Upload</span>
            <span class="speedtest-stat-value mono" id="speedtest-ul">–</span>
          </div>
          <div class="speedtest-stat">
            <span class="speedtest-stat-label">Ping</span>
            <span class="speedtest-stat-value mono" id="speedtest-ping">–</span>
          </div>
          <div class="speedtest-stat">
            <span class="speedtest-stat-label">Server</span>
            <span class="speedtest-stat-value mono" id="speedtest-server">–</span>
          </div>
        </div>
        <div class="speedtest-chart-wrap hidden">
          <canvas id="speedtest-chart" width="400" height="120"></canvas>
        </div>
      </div>
    </div>
  `;
  card.querySelector('#speedtest-run').addEventListener('click', runSpeedtest);
  card.querySelector('#speedtest-range').addEventListener('change', e => {
    if (!speedtestResults.length) return;
    const n = parseInt(e.target.value, 10);
    renderSpeedtestChart(n > 0 ? speedtestResults.slice(-n) : speedtestResults);
  });
  return card;
}

function formatMbps(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec === 0) return '–';
  return ((bytesPerSec * 8) / 1000000).toFixed(1) + ' Mbps';
}

function renderSpeedtestResult(data) {
  setText('speedtest-dl', formatMbps(data.download));
  setText('speedtest-ul', formatMbps(data.upload));
  setText('speedtest-ping', data.ping ? data.ping.toFixed(0) + ' ms' : '–');
  setText('speedtest-server', data.server || '–');
  $('speedtest-result').classList.remove('hidden');
}

async function runSpeedtest() {
  if (speedtestRunning) return;
  speedtestRunning = true;
  const btn = document.getElementById('speedtest-run');
  const status = document.getElementById('speedtest-status');
  btn.disabled = true;
  btn.innerHTML = '<span class="spin">&#x21bb;</span> Testing…';
  status.textContent = 'Running speed test (may take 15–30 seconds)…';
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);
    const res = await fetch('/api/speedtest', { method: 'POST', signal: controller.signal });
    clearTimeout(timeoutId);
    const data = await res.json();
    if (data.ok) {
      renderSpeedtestResult(data);
      status.textContent = 'Completed';
      loadAndRenderSpeedtestChart();
    } else {
      status.textContent = data.error || 'Test failed';
    }
  } catch (err) {
    status.textContent = 'Error: ' + err.message;
  }
  btn.disabled = false;
  btn.innerHTML = '&#9654; Run Test';
  speedtestRunning = false;
}

async function loadAndRenderSpeedtestChart() {
  try {
    const res = await fetch('/api/speedtest/history');
    const data = await res.json();
    if (!data.ok || !data.results.length) return;
    speedtestResults = data.results;
    const n = parseInt($('speedtest-range').value, 10);
    renderSpeedtestChart(n > 0 ? speedtestResults.slice(-n) : speedtestResults);
  } catch (_) {}
}

function renderSpeedtestChart(results) {
  const canvas = document.getElementById('speedtest-chart');
  if (!canvas) return;
  const wrap = canvas.closest('.speedtest-chart-wrap');
  if (results.length < 2) { wrap.classList.add('hidden'); return; }
  wrap.classList.remove('hidden');
  const ctx = canvas.getContext('2d');
  const W = canvas.width = canvas.parentElement.clientWidth;
  const H = canvas.height = 120;
  ctx.clearRect(0, 0, W, H);

  const GUTTER = 60;
  const plotW = W - GUTTER;
  const dl = results.map(r => r.download * 8 / 1000000);
  const ul = results.map(r => r.upload * 8 / 1000000);
  const maxVal = Math.max(...dl, ...ul, 1) * 1.15;
  const step = plotW / (results.length - 1);

  // Gridlines and Y-axis labels
  ctx.font = '11px system-ui';
  ctx.strokeStyle = 'rgba(100,116,139,0.25)';
  ctx.lineWidth = 1;
  ctx.fillStyle = '#64748b';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  const targetTicks = 5;
  const rawStep = maxVal / targetTicks;
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / mag;
  const tickStep = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const ticks = [];
  for (let v = 0; v <= maxVal; v += tickStep) ticks.push(v);
  ticks.forEach((v, i) => {
    const y = H - (v / maxVal) * (H - 10) - 5;
    ctx.beginPath();
    ctx.moveTo(GUTTER, y);
    ctx.lineTo(W, y);
    ctx.stroke();
    const labelV = Math.round(v * 100) / 100;
    const num = labelV === 0 ? '0' : (labelV >= 10 ? Math.round(labelV) : labelV.toFixed(1));
    const label = i === ticks.length - 1 ? num + ' Mbps' : num;
    ctx.fillText(label, GUTTER - 4, y);
  });
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  function drawLine(values, color) {
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    values.forEach((v, i) => {
      const x = GUTTER + i * step;
      const y = H - (v / maxVal) * (H - 10) - 5;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
    values.forEach((v, i) => {
      const x = GUTTER + i * step;
      const y = H - (v / maxVal) * (H - 10) - 5;
      ctx.beginPath();
      ctx.arc(x, y, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    });
  }

  drawLine(dl, '#4ade80');
  drawLine(ul, '#60a5fa');

  // Legend
  ctx.font = '11px system-ui';
  ctx.fillStyle = '#4ade80';
  ctx.fillText('↓ DL', GUTTER + 4, 12);
  ctx.fillStyle = '#60a5fa';
  ctx.fillText('↑ UL', GUTTER + 40, 12);
  ctx.fillStyle = '#64748b';
  ctx.textAlign = 'right';
  ctx.fillText(results.length + ' tests', W - 4, 12);
  ctx.textAlign = 'left';
}

async function initSpeedtest() {
  try {
    const res = await fetch('/api/speedtest/status');
    const data = await res.json();
    const enabled = data.enabled;
    if (!enabled) return;
  } catch (_) { return; }

  const card = buildSpeedtestCard();
  const container = $('dashboards-container');
  container.appendChild(card);

  if (!speedtestResizeBound) {
    speedtestResizeBound = true;
    window.addEventListener('resize', () => {
      if (!speedtestResults.length) return;
      const n = parseInt($('speedtest-range').value, 10);
      renderSpeedtestChart(n > 0 ? speedtestResults.slice(-n) : speedtestResults);
    });
  }

  // Load existing history
  try {
    const res = await fetch('/api/speedtest/history');
    const data = await res.json();
    if (data.ok && data.results.length) {
      speedtestResults = data.results;
      renderSpeedtestResult(data.results[data.results.length - 1]);
      const n = parseInt($('speedtest-range').value, 10);
      renderSpeedtestChart(n > 0 ? speedtestResults.slice(-n) : speedtestResults);
    }
  } catch (_) {}
}

// ---- Event listeners ----

function saveInterval() {
    const select = $('refresh-interval');
    const value = parseInt(select.value, 10);
    if (!isNaN(value)) {
        try { localStorage.setItem(STORAGE_INTERVAL_KEY, value); } catch (_) {}
    }
}

// Restore saved polling interval
let savedInterval = null;
try { savedInterval = localStorage.getItem(STORAGE_INTERVAL_KEY); } catch (_) {}
let intervalValue = null;
if (savedInterval !== null) {
    const parsed = parseInt(savedInterval, 10);
    if (!isNaN(parsed) && [0, 5000, 10000, 30000, 60000].includes(parsed)) {
        intervalValue = parsed;
    }
}
// If no valid saved value, try the meta tag for default from environment
if (intervalValue === null) {
    const meta = document.getElementById('default-poll-interval');
    if (meta && meta.content) {
        const metaValue = parseInt(meta.content, 10);
        if (!isNaN(metaValue) && [0, 5000, 10000, 30000, 60000].includes(metaValue)) {
            intervalValue = metaValue;
        }
    }
}
// Apply the value if found
if (intervalValue !== null) {
    $('refresh-interval').value = intervalValue;
}
// ---- Edit Mode ----

const CARD_IDS = ['ip', 'vpn', 'port', 'dns', 'history'];
let editMode = false;
let dragSrcCard = null;
const dragBoundGrids = new WeakSet();
// Backoff after a failed provider server-list fetch, keyed by instance+provider+vpn.
const serversRetryAt = new Map();

function layoutKey(instId) { return `gluetun_layout_${instId}`; }

function defaultLayout() {
  return { order: [...CARD_IDS], sizes: { history: 4 }, hidden: [] };
}

function sanitizeLayout(raw) {
  const valid = new Set(CARD_IDS);
  const order = [...new Set((Array.isArray(raw.order) ? raw.order : []).filter(cid => valid.has(cid)))];
  const hidden = [...new Set((Array.isArray(raw.hidden) ? raw.hidden : []).filter(cid => valid.has(cid)))];
  const sizes = {};
  const rawSizes = raw.sizes && typeof raw.sizes === 'object' && !Array.isArray(raw.sizes) ? raw.sizes : {};
  CARD_IDS.forEach(cid => {
    const n = Number(rawSizes[cid]);
    sizes[cid] = Number.isFinite(n) && n > 0 ? Math.min(4, Math.max(1, Math.floor(n))) : 1;
  });
  return { order, hidden, sizes };
}

function loadLayout(instId) {
  try {
    const raw = JSON.parse(localStorage.getItem(layoutKey(instId)));
    if (raw && Array.isArray(raw.order)) return sanitizeLayout(raw);
  } catch (_) {}
  return defaultLayout();
}

function saveLayout(instId, layout) {
  try { localStorage.setItem(layoutKey(instId), JSON.stringify(layout)); } catch (_) {}
}

function applyLayout(instId) {
  const grid = document.getElementById(`i${instId}-grid`);
  if (!grid) return;
  const layout = loadLayout(instId);
  const cards = {};

  grid.querySelectorAll('.card[data-card-id]').forEach(c => {
    cards[c.dataset.cardId] = c;
  });

  // Reorder tracked cards, then pin cards outside the editable layout to the end
  layout.order.forEach(cid => {
    if (cards[cid]) grid.appendChild(cards[cid]);
  });
  grid.querySelectorAll('.card:not([data-card-id])').forEach(c => grid.appendChild(c));

  // Sizes
  CARD_IDS.forEach(cid => {
    const card = cards[cid];
    if (!card) return;
    const span = layout.sizes[cid] || 1;
    const numCols = getComputedStyle(grid).gridTemplateColumns.split(' ').length;
    card.style.gridColumn = span >= numCols ? '1 / -1' : `span ${span}`;
    // card-wide class is just for initial default, override with explicit span
    card.classList.toggle('card-wide', false);
  });

  // Hidden
  CARD_IDS.forEach(cid => {
    const card = cards[cid];
    if (!card) return;
    card.style.display = layout.hidden.includes(cid) ? 'none' : '';
  });

  applyLayoutUI(instId);
}

function applyLayoutUI(instId) {
  const layout = loadLayout(instId);
  document.querySelectorAll(`#i${instId}-grid .card[data-card-id]`).forEach(card => {
    const cid = card.dataset.cardId;
    // Drag
    card.draggable = editMode;
    // Resize handle (right edge)
    let rh = card.querySelector('.resize-handle');
    if (editMode) {
      if (!rh) {
        rh = document.createElement('div');
        rh.className = 'resize-handle';
        rh.title = 'Drag to resize';
        rh.addEventListener('mousedown', (e) => startResize(e, instId, cid));
        card.appendChild(rh);
      }
      rh.style.display = '';
    } else if (rh) {
      rh.style.display = 'none';
    }
  });

  // Drag events for reorder (delegated, attached once per grid)
  if (editMode) {
    const gridEl = document.getElementById(`i${instId}-grid`);
    if (gridEl && !dragBoundGrids.has(gridEl)) {
      dragBoundGrids.add(gridEl);
      gridEl.addEventListener('dragstart', onDragStart);
      gridEl.addEventListener('dragover', onDragOver);
      gridEl.addEventListener('drop', onDrop);
      gridEl.addEventListener('dragend', onDragEnd);
    }
  }

  // Update show/hide panel
  renderVisibilityPanel(instId);
}

// ---- Edge-drag resize ----

function startResize(e, instId, cid) {
  e.preventDefault();
  e.stopPropagation();
  const grid = document.getElementById(`i${instId}-grid`);
  if (!grid) return;
  const card = grid.querySelector(`[data-card-id="${cid}"]`);
  if (!card) return;

  const startX = e.clientX;
  const gridRect = grid.getBoundingClientRect();
  const parentRect = grid.parentElement.getBoundingClientRect();
  const numCols = getComputedStyle(grid).gridTemplateColumns.split(' ').length;
  const gap = parseFloat(getComputedStyle(grid).columnGap) || 0;
  const colWidth = (gridRect.width - gap * (numCols - 1)) / numCols;
  const startSpan = loadLayout(instId).sizes[cid] || 1;

  card.classList.add('resizing');
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';

  // Create grid overlay
  const overlay = document.createElement('div');
  overlay.className = 'grid-overlay';
  overlay.style.cssText = `
    position:absolute; top:${gridRect.top - parentRect.top}px; left:${gridRect.left - parentRect.left}px;
    width:${gridRect.width}px; height:${gridRect.height}px;
    display:flex; pointer-events:none; z-index:10;
  `;
  for (let i = 0; i < numCols; i++) {
    const col = document.createElement('div');
    col.className = 'grid-col-guide';
    col.style.cssText = `flex:1; border-right:1px dashed rgba(74,222,128,0.3); transition: background 0.1s;`;
    overlay.appendChild(col);
  }
  grid.parentElement.style.position = 'relative';
  grid.parentElement.appendChild(overlay);

  let activeSpan = startSpan;

  function onMove(ev) {
    const delta = ev.clientX - startX;
    const spanDelta = Math.round(delta / colWidth);
    activeSpan = Math.max(1, Math.min(numCols, startSpan + spanDelta));
    card.style.gridColumn = activeSpan >= numCols ? '1 / -1' : `span ${activeSpan}`;
    // Highlight active columns in overlay
    overlay.querySelectorAll('.grid-col-guide').forEach((col, i) => {
      col.style.background = i < activeSpan ? 'rgba(74,222,128,0.08)' : '';
    });
  }

  function onUp() {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    window.removeEventListener('blur', onUp);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    card.classList.remove('resizing');
    overlay.remove();

    const layout = loadLayout(instId);
    layout.sizes[cid] = activeSpan;
    saveLayout(instId, layout);
    applyLayout(instId);
  }

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
  window.addEventListener('blur', onUp);
}

function onDragStart(e) {
  if (e.target.closest('.resize-handle')) return;
  const card = e.target.closest('.card[data-card-id]');
  if (!card) return;
  dragSrcCard = card;
  card.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', card.dataset.cardId);
}

function onDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const card = e.target.closest('.card[data-card-id]');
  if (card) card.classList.add('drag-over');
}

function onDrop(e) {
  e.preventDefault();
  const card = e.target.closest('.card[data-card-id]');
  if (!card) return;
  card.classList.remove('drag-over');
  const instId = card.closest('.dashboard-group')?.id?.replace('dashboard-', '');
  if (!instId || !dragSrcCard || dragSrcCard === card) return;
  if (dragSrcCard.closest('.dashboard-group') !== card.closest('.dashboard-group')) return;
  const layout = loadLayout(instId);
  const fromId = dragSrcCard.dataset.cardId;
  const toId = card.dataset.cardId;
  const fromIdx = layout.order.indexOf(fromId);
  const toIdx = layout.order.indexOf(toId);
  if (fromIdx === -1 || toIdx === -1) return;
  layout.order.splice(fromIdx, 1);
  layout.order.splice(toIdx, 0, fromId);
  saveLayout(instId, layout);
  applyLayout(instId);
}

function onDragEnd(e) {
  const card = e.target.closest('.card[data-card-id]');
  if (card) card.classList.remove('dragging');
  document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
  dragSrcCard = null;
}

function renderVisibilityPanel(instId) {
  let panel = document.getElementById(`i${instId}-visibility-panel`);
  if (!panel) {
    panel = document.createElement('div');
    panel.id = `i${instId}-visibility-panel`;
    panel.className = 'visibility-panel';
    const group = document.getElementById(`dashboard-${instId}`);
    if (group) group.insertBefore(panel, group.querySelector('.dashboard-grid'));
  }
  if (!editMode) { panel.style.display = 'none'; return; }
  panel.style.display = '';
  const layout = loadLayout(instId);
  const labels = { ip: 'Public IP', vpn: 'VPN Connection', port: 'Port Forwarding', dns: 'DNS', history: 'History' };
  panel.innerHTML = CARD_IDS.map(cid => {
    const vis = !layout.hidden.includes(cid);
    return `<label class="vis-toggle"><input type="checkbox" data-vis-cid="${cid}" ${vis ? 'checked' : ''}> ${labels[cid]}</label>`;
  }).join('') + `<button class="reset-layout-btn" title="Reset to default layout">↺ Reset</button>`;
  panel.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', () => {
      const layout = loadLayout(instId);
      const cid = cb.dataset.visCid;
      if (cb.checked) {
        layout.hidden = layout.hidden.filter(h => h !== cid);
      } else {
        if (!layout.hidden.includes(cid)) layout.hidden.push(cid);
      }
      saveLayout(instId, layout);
      applyLayout(instId);
    });
  });
  panel.querySelector('.reset-layout-btn')?.addEventListener('click', () => {
    saveLayout(instId, defaultLayout());
    applyLayout(instId);
    showToast('Layout reset to defaults', 'success');
  });
}

function toggleEditMode() {
  editMode = !editMode;
  const btn = $('edit-toggle');
  btn.classList.toggle('active', editMode);
  btn.setAttribute('aria-pressed', String(editMode));
  btn.innerHTML = editMode ? '&#10003; Done' : '&#9998; Edit';
  document.querySelectorAll('.dashboard-group').forEach(group => {
    const instId = group.id.replace('dashboard-', '');
    applyLayout(instId);
    const panel = document.getElementById(`i${instId}-visibility-panel`);
    if (panel) panel.style.display = editMode ? '' : 'none';
  });
}
// ---- Theme ----

const THEMES = ['dark', 'light', 'auto'];
const THEME_ICONS = { dark: '☾', light: '☀', auto: '◉' };
let currentTheme = 'dark';

function applyTheme(theme) {
  currentTheme = theme;
  if (theme === 'auto') {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
  } else {
    document.documentElement.setAttribute('data-theme', theme);
  }
  const btn = $('theme-toggle');
  if (btn) {
    btn.textContent = THEME_ICONS[theme];
    const next = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
    btn.title = `Switch to ${next} theme`;
    btn.setAttribute('aria-label', `Theme: ${theme}. Click to cycle.`);
  }
  // Plotly colors are resolved at render time, so redraw existing bars for the new palette.
  if (latencyChartEnabled && latencyChartRenderer === 'plotly') {
    instances.forEach(inst => renderLatencyChartFor(inst.id));
  }
}

function cycleTheme() {
  const idx = THEMES.indexOf(currentTheme);
  const next = THEMES[(idx + 1) % THEMES.length];
  try { localStorage.setItem('gluetun_theme', next); } catch (_) {}
  applyTheme(next);
}

const mq = window.matchMedia('(prefers-color-scheme: dark)');
const onSchemeChange = () => { if (currentTheme === 'auto') applyTheme('auto'); };
if (mq.addEventListener) mq.addEventListener('change', onSchemeChange);
else mq.addListener(onSchemeChange);

// ---- Init ----

$('refresh-btn').addEventListener('click', () => {
    clearTimeout(refreshTimer);
    pollAll().then(() => scheduleNextPoll());
});
$('refresh-interval').addEventListener('change', () => {
    saveInterval();
    applyAutoRefresh();
});
$('edit-toggle').addEventListener('click', toggleEditMode);
$('theme-toggle').addEventListener('click', cycleTheme);

// Load saved theme
let savedTheme = 'dark';
try { savedTheme = localStorage.getItem('gluetun_theme') || 'dark'; } catch (_) {}
applyTheme(THEMES.includes(savedTheme) ? savedTheme : 'dark');

async function updateServerForInstance(instanceId, newServer) {
  const body = { provider: { server_selection: { names: newServer ? [newServer] : [] } } };
  try {
    const res = await fetch(`/api/${instanceId}/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const msg = await res.json().catch(() => null);
      throw new Error(msg?.error ?? `HTTP ${res.status}`);
    }
    showToast(newServer ? `Switching to ${newServer}…` : 'Auto-selecting best server…', 'success');
  } catch (err) {
    console.error('[updateServer]', err.message);
    showToast(`Failed: ${err.message}`, 'error');
  }
}

// ---- Auth actions ----

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-error').classList.add('hidden');
  const username = $('login-username').value;
  const password = $('login-password').value;
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.ok) {
      $('login-username').value = '';
      $('login-password').value = '';
      await initDashboard();
    } else {
      showLoginError(data.error ?? 'Invalid username or password');
      $('login-password').value = '';
    }
  } catch (err) {
    showLoginError(`Login failed: ${err.message}`);
  }
});

$('logout-btn').addEventListener('click', async () => {
  try { await fetch('/api/logout', { method: 'POST' }); } catch (_) {}
  // Auth may be disabled server-side – in that case /api/auth still reports authenticated,
  // so return to the dashboard instead of stranding the user at a login screen.
  try {
    const res = await fetch('/api/auth');
    if (res.ok) {
      const data = await res.json();
      authEnabled = data.authEnabled === true;
      if (data.authenticated) { await initDashboard(); return; }
    }
  } catch (_) {}
  showLogin();
});

// ---- Init ----

async function initDashboard() {
  showDashboard();
  try {
    const cfgRes = await fetch('/api/config');
    if (cfgRes.ok) {
      const cfg = await cfgRes.json();
      latencyChartEnabled = cfg.latencyChart === true;
      latencyChartRenderer = cfg.latencyChartRenderer === 'plotly' ? 'plotly' : 'svg';
    }
  } catch (_) {}
  try {
    const res = await fetch('/api/instances');
    if (res.status === 401) { showLogin(); showLoginError('Session expired, please sign in again.'); return; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    instances = Array.isArray(data) ? data : [{ id: '1', name: 'Gluetun' }];
  } catch (_) {
    instances = [{ id: '1', name: 'Gluetun' }];
  }
  if (latencyChartEnabled) {
    instances.forEach(inst => {
      const hist = loadLatencyFor(inst.id);
      if (hist.length > 0) latencyHistory.set(inst.id, hist);
    });
  }
  if (latencyChartEnabled && latencyChartRenderer === 'plotly') {
    loadPlotly(() => {
      instances.forEach(inst => renderLatencyChartFor(inst.id));
    });
  }
  renderAllDashboards();
  await pollAll();
  initSpeedtest();
  scheduleNextPoll();
}

(async () => {
  try {
    const res = await fetch('/api/auth');
    if (res.ok) {
      const data = await res.json();
      authEnabled = data.authEnabled === true;
      if (data.authenticated) {
        await initDashboard();
        return;
      }
    }
  } catch (_) {}
  showLogin();
})();
