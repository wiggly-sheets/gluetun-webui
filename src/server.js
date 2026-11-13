const express = require('express');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { providerIntegrations } = require('./provider-integrations');
const { getConfigValue } = require('./config');

const SPEEDTEST_ENABLED = process.env.SPEEDTEST_ENABLED === 'true';

const app = express();
app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : false);
app.disable('x-powered-by');
const PORT = process.env.PORT || 3000;
const LATENCY_CHART = process.env.LATENCY_CHART !== 'false';
const LATENCY_CHART_RENDERER = process.env.LATENCY_CHART_RENDERER === 'plotly' ? 'plotly' : 'svg';

// --- Multi-instance configuration ---
// Define multiple gluetun instances via numbered env vars:
//   GLUETUN_1_URL, GLUETUN_1_NAME, GLUETUN_1_API_KEY, GLUETUN_1_USER, GLUETUN_1_PASSWORD
//   GLUETUN_2_URL, GLUETUN_2_NAME, ...
// Or via Docker secrets: gluetun_1_url, gluetun_1_api_key, etc.
// Falls back to legacy single-instance vars (GLUETUN_CONTROL_URL, GLUETUN_API_KEY, etc.)

function parseInstances() {
  const sharedAirVpnApiKey = getConfigValue('AIRVPN_API_KEY', 'airvpn_api_key');
  const list = [];
  for (let i = 1; i <= 20; i++) {
    const url = getConfigValue(`GLUETUN_${i}_URL`, `gluetun_${i}_url`);
    if (!url) continue;
    try {
      new URL(url);
    } catch (err) {
      console.error(`[startup] Invalid GLUETUN_${i}_URL: ${url}`);
      process.exit(1);
    }
    list.push({
      id: String(i),
      name: getConfigValue(`GLUETUN_${i}_NAME`, `gluetun_${i}_name`) || `Instance ${i}`,
      url: url.replace(/\/$/, ''),
      apiKey:   getConfigValue(`GLUETUN_${i}_API_KEY`, `gluetun_${i}_api_key`),
      user:     getConfigValue(`GLUETUN_${i}_USER`, `gluetun_${i}_user`),
      password: getConfigValue(`GLUETUN_${i}_PASSWORD`, `gluetun_${i}_password`),
      ipDisplayMode:    getConfigValue(`GLUETUN_${i}_IP_DISPLAY_MODE`,    `gluetun_${i}_ip_display_mode`)    || 'auto',
      airVpnApiKey: getConfigValue(`GLUETUN_${i}_AIRVPN_API_KEY`, `gluetun_${i}_airvpn_api_key`) || sharedAirVpnApiKey,
      forwardedPort: getConfigValue(`GLUETUN_${i}_FORWARDED_PORT`, `gluetun_${i}_forwarded_port`) || getConfigValue('FORWARDED_PORT', 'forwarded_port'),
    });
  }
  if (list.length === 0) {
    // Legacy single-instance fallback
    const legacyUrl = getConfigValue('GLUETUN_CONTROL_URL', 'gluetun_control_url') || 'http://gluetun:8000';
    // Validate URL at startup (fail-fast)
    try {
      new URL(legacyUrl);
    } catch (err) {
      console.error(`[startup] Invalid GLUETUN_CONTROL_URL: ${legacyUrl}`);
      process.exit(1);
    }
    list.push({
      id: '1',
      name: getConfigValue('GLUETUN_NAME', 'gluetun_name') || 'Gluetun',
      url: legacyUrl.replace(/\/$/, ''),
      apiKey:   getConfigValue('GLUETUN_API_KEY', 'gluetun_api_key'),
      user:     getConfigValue('GLUETUN_USER', 'gluetun_user'),
      password: getConfigValue('GLUETUN_PASSWORD', 'gluetun_password'),
      ipDisplayMode:    getConfigValue('GLUETUN_IP_DISPLAY_MODE',    'gluetun_ip_display_mode')    || 'auto',
      airVpnApiKey: sharedAirVpnApiKey,
      forwardedPort: getConfigValue('FORWARDED_PORT', 'forwarded_port'),
    });
  }
  return list;
}

const instances = parseInstances();
const instanceMap = new Map(instances.map(inst => [inst.id, inst]));

// Server list cache: provider -> { fetchedAt, servers } (TTL 1h)
const serversCache = new Map();
const SERVERS_TTL = 60 * 60 * 1000;

// --- Optional Web UI authentication ---
// Opt-in: enabled only when BOTH WEBUI_USER and WEBUI_PASSWORD are set (env var or Docker secret webui_user/webui_password).
// Sessions are an HMAC-signed cookie derived from the password with scrypt (no extra config;
// a password change invalidates all sessions, and a stolen cookie cannot cheaply guess the password).
const webuiUser     = getConfigValue('WEBUI_USER', 'webui_user');
const webuiPassword = getConfigValue('WEBUI_PASSWORD', 'webui_password');
if (Boolean(webuiUser) !== Boolean(webuiPassword)) {
  console.error('[startup] Misconfiguration: WEBUI_USER and WEBUI_PASSWORD must be set together to enable authentication');
  process.exit(1);
}
const authEnabled = Boolean(webuiUser && webuiPassword);
const SESSION_COOKIE = 'webui_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const sessionSigningKey = crypto.scryptSync(String(webuiPassword ?? ''), 'gluetun-webui-session-v1', 32);
// In-memory version, bumped on logout so already-issued cookies are rejected
// (stateless HMAC cookies would otherwise stay valid until expiry).
let sessionVersion = 0;

function signSessionPayload(payloadB64) {
  return crypto.createHmac('sha256', sessionSigningKey).update(payloadB64).digest('base64url');
}

function createSessionCookie(username) {
  const payloadB64 = Buffer.from(JSON.stringify({ u: username, e: Date.now() + SESSION_TTL_MS, v: sessionVersion })).toString('base64url');
  return `${payloadB64}.${signSessionPayload(payloadB64)}`;
}

function verifySessionCookie(value) {
  if (typeof value !== 'string') return false;
  const dot = value.indexOf('.');
  if (dot <= 0) return false;
  const payloadB64 = value.slice(0, dot);
  const signature = value.slice(dot + 1);
  const sigBuf = Buffer.from(signature, 'base64url');
  const expBuf = Buffer.from(signSessionPayload(payloadB64), 'base64url');
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return false;
  try {
    const { u, e, v } = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
    return u === webuiUser && typeof e === 'number' && e > Date.now() && v === sessionVersion;
  } catch (_) { return false; }
}

function getSessionCookie(req) {
  const header = req.headers.cookie;
  if (!header) return null;
  const match = header.split(';').map(s => s.trim()).find(s => s.startsWith(`${SESSION_COOKIE}=`));
  return match ? match.slice(SESSION_COOKIE.length + 1) : null;
}

function sessionCookieOptions(req) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure || req.headers['x-forwarded-proto'] === 'https',
    maxAge: SESSION_TTL_MS,
    path: '/',
  };
}

// Protects /api/* except login (public), auth (how the SPA learns whether to show
// the login view) and healthz (Docker HEALTHCHECK).
// When auth is disabled this is a no-op pass-through.
function requireAuth(req, res, next) {
  if (!authEnabled) return next();
  if (['/login', '/auth', '/healthz'].includes(req.path)) return next();
  if (verifySessionCookie(getSessionCookie(req))) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

function buildAuthHeadersFor(instance) {
  if (instance.apiKey) {
    return { 'X-API-Key': instance.apiKey };
  }
  if (instance.user && instance.password) {
    const encoded = Buffer.from(`${instance.user}:${instance.password}`).toString('base64');
    return { Authorization: `Basic ${encoded}` };
  }
  return {};
}

function resolveInstance(id) {
  return instanceMap.get(id) || null;
}

// General read rate limiter (covers all /api/* GET routes)
// Max assumes worst case: 20 instances polled every 5s (240/min) plus UI calls.
const readLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many requests, please try again later.' },
});

// Mutating settings writes (server switch / VPN start-stop are separate)
const settingsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many requests, please try again later.' },
});

// UI/static route rate limiter – protects filesystem access for SPA index.html
const uiLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 1000, // limit each IP to 1000 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many requests for the web UI, please try again later.',
});

// Auth must run before the /api/ rate limiters and routes
app.use('/api/', requireAuth);

app.use('/api/', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (req.method === 'GET') return readLimiter(req, res, next);
  next();
});

// Security headers
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

// --- Host header allowlist (DNS rebinding protection) ---
// No-auth local UI: a malicious site could DNS-rebind to 127.0.0.1 and drive
// the VPN controls. Allow only known hosts. Extend via ALLOWED_HOSTS env
// (comma-separated) when accessing via LAN IP or a reverse-proxy domain.
const allowedHosts = new Set(
  ['localhost', '127.0.0.1', '[::1]']
    .concat((process.env.ALLOWED_HOSTS || '').split(','))
    .map(h => h.trim().toLowerCase()).filter(Boolean)
);
app.use((req, res, next) => {
  let host;
  try { host = new URL(`http://${req.headers.host}`).hostname.toLowerCase(); }
  catch (_) { return res.status(400).json({ ok: false, error: 'Bad request' }); }
  if (!allowedHosts.has(host)) return res.status(403).json({ ok: false, error: 'Forbidden' });
  next();
});

app.use(express.json({ limit: '2kb' }));
app.use(uiLimiter, express.static(path.join(__dirname, 'public'), {
  index: false,
}));

async function gluetunFetch(instance, endpoint, method = 'GET', body = null) {
  const url = `${instance.url}${endpoint}`;
  const controller = new AbortController();
  const ms = method === 'PUT' ? 60000 : 5000;
  const timeoutId = setTimeout(() => controller.abort(), ms);
  const opts = {
    method,
    signal: controller.signal,
    redirect: 'error',
    headers: {
      ...(body !== null ? { 'Content-Type': 'application/json' } : {}),
      ...buildAuthHeadersFor(instance),
    },
  };
  if (body !== null) opts.body = JSON.stringify(body);
  try {
    const res = await fetch(url, opts);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Gluetun returned ${res.status}${text ? ': ' + text.slice(0, 200).trim() : ''}`);
    }
    const text = await res.text();
    try { return JSON.parse(text); } catch { return text; }
  } finally {
    clearTimeout(timeoutId);
  }
}

// --- AirVPN API helpers ---

// ponytail: global cache, keyed by service (status is public data shared by all instances). TTL 2min.
const airVpnCache = new Map();

async function airVpnFetch(apiKey, service, ttlMs = 120000) {
  // status needs no API key — cache once for all instances instead of once per apiKey
  const cacheKey = service === 'status' ? `public:${service}` : `${apiKey || 'public'}:${service}`;
  const cached = airVpnCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.data;

  const params = new URLSearchParams({ service, format: 'json' });
  if (apiKey) params.set('key', apiKey);
  const url = `https://airvpn.org/api/?${params}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 4000);

  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'error' });
    if (!res.ok) throw new Error(`AirVPN returned ${res.status}`);
    const data = await res.json();
    // Only overwrite this key — a sweep would evict sibling stale entries that stale-while-revalidate depends on
    airVpnCache.set(cacheKey, { data, expires: Date.now() + ttlMs });
    return data;
  } catch (err) {
    // stale-while-revalidate: serve the stale entry on upstream failure
    if (cached) return cached.data;
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

// --- Helper: strip VPN credentials from settings before sending to the browser ---
// Gluetun's /v1/vpn/settings includes private keys, pre-shared keys and OpenVPN
// credentials. The UI only needs protocol, provider name and server selection.
function sanitizeVpnSettings(data) {
  if (!data || typeof data !== 'object') return data;
  const ss = data.provider?.server_selection || {};
  return {
    type: data.type,
    provider: {
      name: data.provider?.name,
      server_selection: { names: ss.names, hostnames: ss.hostnames, vpn: ss.vpn },
    },
  };
}

// --- Helper: aggregate health for one instance ---
// Returns { timestamp, vpnStatus, publicIp, publicIpv6, portForwarded, dnsStatus, vpnSettings, allFailed }
// allFailed = true if ALL checks failed (service is completely unreachable)

// instanceId -> lowercased gluetun provider name, learned from vpnSettings each successful poll.
// The provider adapter fetch for a poll is gated on the *previous* poll's provider, so the
// first poll of each instance has no provider fetch (card appears from the second poll).
// ponytail: never evicts — max 20 instances, one string each; a stale entry only matters if
// an instance ID is removed and later reused by a different provider. Delete on removal if that ever happens.
const instanceProviderCache = new Map();
async function fetchInstanceHealth(instance) {
  const hasAirVpn = Boolean(instance.airVpnApiKey);
  const adapter = providerIntegrations[instanceProviderCache.get(instance.id)] || null;
  // All upstream fetches in one parallel batch: gluetun (5s timeout) + AirVPN status/userinfo (4s timeout) + provider list (4s/15s timeout)
  const results = await Promise.allSettled([
    gluetunFetch(instance, '/v1/vpn/status'),
    gluetunFetch(instance, '/v1/publicip/ip'),
    gluetunFetch(instance, '/v1/portforward'),
    gluetunFetch(instance, '/v1/dns/status'),
    gluetunFetch(instance, '/v1/vpn/settings'),
    hasAirVpn ? airVpnFetch(instance.airVpnApiKey, 'status') : Promise.resolve(null),
    hasAirVpn ? airVpnFetch(instance.airVpnApiKey, 'userinfo') : Promise.resolve(null),
    adapter ? adapter.fetchServerList() : Promise.resolve(null),
  ]);
  results.forEach((r, i) => {
    if (r.status === 'rejected') console.error(`[${i < 5 ? 'upstream' : i < 7 ? 'airvpn' : 'provider'}][${instance.id}]`, r.reason?.message);
  });
  const [vpnStatus, publicIp, portForwarded, dnsStatus, vpnSettings, airVpnStatus, airVpnUserinfo, providerList] = results.map(r =>
    r.status === 'fulfilled' ? { ok: true, data: r.value } : { ok: false, error: 'Upstream error' }
  );
  const allFailed = [vpnStatus, publicIp, portForwarded, dnsStatus, vpnSettings].every(r => !r.ok);

  // Learn the provider for the next poll
  if (vpnSettings.ok && vpnSettings.data?.provider?.name) {
    instanceProviderCache.set(instance.id, String(vpnSettings.data.provider.name).toLowerCase());
  }

  // Merge env var forwarded port when Gluetun returns 0 (AirVPN doesn't write to status file)
  const envPort = Number(instance.forwardedPort);
  if (portForwarded.ok && portForwarded.data && portForwarded.data.port === 0 && envPort > 0) {
    portForwarded.data.port = envPort;
    if (!portForwarded.data.ports || portForwarded.data.ports.length === 0) {
      portForwarded.data.ports = [envPort];
    }
  }

  // IPv6 is refreshed in the background and cached (5 min TTL) — never blocks the health poll
  const cachedIpv6 = ipv6Cache.value;
  fetchPublicIpv6(); // fire-and-forget; result lands in the cache for the next poll
  const publicIpv6 = cachedIpv6 ? { ok: true, data: cachedIpv6 } : { ok: false, error: 'Not available' };

  let airVpnServer = null;
  let airVpnUserInfo = null;

  // Match current server by userinfo session server_name; if that fails (renamed/stale server),
  // fall back to the vpnSettings server name instead of hiding the card
  if (airVpnStatus.ok && airVpnStatus.data?.servers) {
    const servers = airVpnStatus.data.servers;
    const candidates = [
      airVpnUserinfo.ok ? airVpnUserinfo.data?.connection?.server_name : null,
      vpnSettings?.ok ? vpnSettings.data?.provider?.server_selection?.names?.[0] : null,
    ];
    for (const name of candidates) {
      if (!name) continue;
      const found = servers.find(s => s.public_name === name);
      if (found) { airVpnServer = found; break; }
    }
  }

  // Privacy: only expose the userinfo connection field to the browser (no login/credits/sessions)
  if (airVpnUserinfo.ok) {
    airVpnUserInfo = { connection: airVpnUserinfo.data?.connection ?? null };
  }

  // Generic provider card: match the connected server against the provider's live list
  let providerData = null;
  if (adapter) {
    if (!providerList.ok) {
      providerData = { ok: false };
    } else {
      try {
        // gluetun may store the display name or hostname in server_selection; the publicIp
        // hostname (already fetched in the batch) is the actual connected server as a fallback.
        // Hostnames are stable identifiers — try them first, since a display name can be
        // reassigned to a different server by the provider.
        const ss = vpnSettings.ok ? vpnSettings.data?.provider?.server_selection : null;
        const candidates = [
          ss?.hostnames?.[0],
          ss?.names?.[0],
          publicIp.ok ? publicIp.data?.hostname : null,
        ].filter(Boolean);
        const matched = candidates.length ? adapter.matchServer(providerList.data, candidates) : null;
        const card = await adapter.buildCard(providerList.data, matched);
        providerData = { ok: true, data: card || null };
      } catch (err) {
        console.error(`[provider][${instance.id}]`, err.message);
        providerData = { ok: false };
      }
    }
  }

  return {
    timestamp: new Date().toISOString(),
    vpnStatus, publicIp, publicIpv6, portForwarded, dnsStatus,
    vpnSettings: vpnSettings.ok
      ? { ok: true, data: sanitizeVpnSettings(vpnSettings.data) }
      : vpnSettings,
    airVpnServer: airVpnServer ? { ok: true, data: airVpnServer } : { ok: false },
    airVpnUserInfo: airVpnUserInfo ? { ok: true, data: airVpnUserInfo } : { ok: false },
    providerData,
    allFailed,
  };
}

// --- Public IPv6 (best-effort, cached, background refresh) ---
// NOTE: detected from the webui container's egress, not Gluetun's tunnel.
// Route the webui through Gluetun (network_mode: service:gluetun) for the
// VPN exit IPv6; otherwise this is the host's own IPv6 (or none).
const IPV6_CACHE_TTL_MS = 5 * 60 * 1000;
let ipv6Cache = { value: null, fetchedAt: 0 };
let ipv6InFlight = null;

async function fetchPublicIpv6() {
  if (Date.now() - ipv6Cache.fetchedAt < IPV6_CACHE_TTL_MS) return ipv6Cache.value;
  if (ipv6InFlight) return ipv6InFlight;
  ipv6InFlight = (async () => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch('https://api6.ipify.org?format=json', {
        signal: controller.signal,
        redirect: 'error',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const value = data.ip && data.ip.includes(':') ? { ipv6: data.ip } : null;
      ipv6Cache = { value, fetchedAt: Date.now() };
      return value;
    } catch (_) {
      // Stamp failures too, so an unavailable IPv6 endpoint is retried on the
      // cache TTL instead of on every poll.
      ipv6Cache = { value: ipv6Cache.value, fetchedAt: Date.now() };
      return null;
    } finally {
      clearTimeout(timeoutId);
      ipv6InFlight = null;
    }
  })();
  return ipv6InFlight;
}

// --- Feature config endpoint ---
app.get('/api/config', (req, res) => {
  res.json({ latencyChart: LATENCY_CHART, latencyChartRenderer: LATENCY_CHART_RENDERER });
});

// --- Instance list endpoint ---
app.get('/api/instances', (req, res) => {
  res.json(instances.map(({ id, name, ipDisplayMode }) =>
    ({ id, name, ipDisplayMode })
  ));
});

// --- Per-instance health endpoint ---
app.get('/api/:instanceId/health', async (req, res) => {
  const instance = resolveInstance(req.params.instanceId);
  if (!instance) return res.status(400).json({ ok: false, error: 'Unknown instance ID' });
  const health = await fetchInstanceHealth(instance);
  // Return 503 if all upstream checks failed (service completely unreachable)
  if (health.allFailed) {
    return res.status(503).json({ ok: false, error: 'Service unavailable', ...health });
  }
  res.json({ ok: true, ...health });
});

// --- Legacy aggregate health (instance 1) ---
app.get('/api/health', async (req, res) => {
  const health = await fetchInstanceHealth(instances[0]);
  // Return 503 if all upstream checks failed (service completely unreachable)
  if (health.allFailed) {
    return res.status(503).json({ ok: false, error: 'Service unavailable', ...health });
  }
  res.json({ ok: true, ...health });
});

// --- Legacy individual proxy endpoints (instance 1) ---
app.get('/api/status', async (req, res) => {
  try {
    const data = await gluetunFetch(instances[0], '/v1/vpn/status');
    res.json({ ok: true, data });
  } catch (err) {
    console.error('[upstream]', err.message);
    res.status(502).json({ ok: false, error: 'Upstream error' });
  }
});

app.get('/api/publicip', async (req, res) => {
  try {
    const data = await gluetunFetch(instances[0], '/v1/publicip/ip');
    res.json({ ok: true, data });
  } catch (err) {
    console.error('[upstream]', err.message);
    res.status(502).json({ ok: false, error: 'Upstream error' });
  }
});

app.get('/api/portforwarded', async (req, res) => {
  try {
    const data = await gluetunFetch(instances[0], '/v1/portforward');
    res.json({ ok: true, data });
  } catch (err) {
    console.error('[upstream]', err.message);
    res.status(502).json({ ok: false, error: 'Upstream error' });
  }
});

app.put('/api/:instanceId/settings', settingsLimiter, async (req, res) => {
  const instance = resolveInstance(req.params.instanceId);
  if (!instance) return res.status(400).json({ ok: false, error: 'Unknown instance ID' });
  try {
    const data = await gluetunFetch(
      instance,
      '/v1/vpn/settings',
      'PUT',
      req.body
    );
    res.json({ ok: true, data });
  } catch (err) {
    console.error('[upstream]', err.message);
    res.status(502).json({ ok: false, error: 'Upstream error' });
  }
});

// --- Per-instance server list (from gluetun-servers repo, cached 1h) ---
app.get('/api/:instanceId/servers', async (req, res) => {
  const instance = resolveInstance(req.params.instanceId);
  if (!instance) return res.status(400).json({ ok: false, error: 'Unknown instance ID' });
  if (req.query.provider === undefined) {
    return res.status(400).json({ ok: false, error: 'Missing provider query param' });
  }
  if (typeof req.query.provider !== 'string') {
    return res.status(400).json({ ok: false, error: 'Invalid provider query param' });
  }
  const provider = req.query.provider.trim().toLowerCase();
  if (!provider) return res.status(400).json({ ok: false, error: 'Missing provider query param' });
  if (!/^[a-z0-9 _-]+$/.test(provider)) return res.status(400).json({ ok: false, error: 'Invalid provider' });
  const cached = serversCache.get(provider);
  if (cached && Date.now() - cached.fetchedAt < SERVERS_TTL) {
    return res.json({ ok: true, data: cached.servers });
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);
  try {
    const upstream = await fetch(
      `https://raw.githubusercontent.com/qdm12/gluetun-servers/main/pkg/servers/${encodeURIComponent(provider)}.json`,
      { signal: controller.signal, redirect: 'error' }
    );
    if (!upstream.ok) throw new Error(`HTTP ${upstream.status}`);
    const data = await upstream.json();
    if (!Array.isArray(data.servers)) throw new Error('Malformed server list');
    // Gluetun server lists use `hostname`; the UI expects `server_name`.
    const servers = data.servers.map(s => ({
      server_name: s.server_name ?? s.hostname ?? s.name,
      country: s.country,
      vpn: s.vpn,
    })).filter(s => s.server_name);
    serversCache.set(provider, { fetchedAt: Date.now(), servers });
    res.json({ ok: true, data: servers });
  } catch (err) {
    console.error('[servers]', err.message);
    res.status(502).json({ ok: false, error: 'Could not fetch server list' });
  } finally {
    clearTimeout(timeoutId);
  }
});
app.get('/api/dns', async (req, res) => {
  try {
    const data = await gluetunFetch(instances[0], '/v1/dns/status');
    res.json({ ok: true, data });
  } catch (err) {
    console.error('[upstream]', err.message);
    res.status(502).json({ ok: false, error: 'Upstream error' });
  }
});

const vpnActionLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many requests, please try again later.' },
});

// --- Per-instance VPN control ---
app.put('/api/:instanceId/vpn/:action', vpnActionLimiter, async (req, res) => {
  const instance = resolveInstance(req.params.instanceId);
  if (!instance) return res.status(400).json({ ok: false, error: 'Unknown instance ID' });
  const { action } = req.params;
  const allowed = ['start', 'stop'];
  if (!allowed.includes(action)) {
    return res.status(400).json({ ok: false, error: 'Invalid action. Use start or stop.' });
  }
  try {
    const data = await gluetunFetch(
      instance,
      '/v1/vpn/status',
      'PUT',
      { status: action === 'start' ? 'running' : 'stopped' }
    );
    res.json({ ok: true, data });
  } catch (err) {
    console.error(`[upstream][${instance.id}]`, err.message);
    res.status(502).json({ ok: false, error: 'Upstream error' });
  }
});

// --- Legacy VPN control (instance 1) ---
app.put('/api/vpn/:action', vpnActionLimiter, async (req, res) => {
  const { action } = req.params;
  const allowed = ['start', 'stop'];
  if (!allowed.includes(action)) {
    return res.status(400).json({ ok: false, error: 'Invalid action. Use start or stop.' });
  }
  try {
    const data = await gluetunFetch(
      instances[0],
      '/v1/vpn/status',
      'PUT',
      { status: action === 'start' ? 'running' : 'stopped' }
    );
    res.json({ ok: true, data });
  } catch (err) {
    console.error('[upstream]', err.message);
    res.status(502).json({ ok: false, error: 'Upstream error' });
  }
});

// Serve Plotly bundle
app.use('/vendor/plotly', uiLimiter, express.static(path.join(__dirname, '..', 'node_modules', 'plotly.js-basic-dist-min')));

// --- Web UI authentication routes ---

const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many requests, please try again later.' },
});

app.post('/api/login', loginLimiter, async (req, res) => {
  if (!authEnabled) return res.status(404).json({ ok: false, error: 'Not found' });
  const { username, password } = req.body || {};
  // Compare sha256 digests so timingSafeEqual sees equal-length buffers
  const digest = (s) => crypto.createHash('sha256').update(String(s ?? '')).digest();
  const userMatch = crypto.timingSafeEqual(digest(username), digest(webuiUser));
  const passMatch = crypto.timingSafeEqual(digest(password), digest(webuiPassword));
  if (userMatch && passMatch) {
    res.cookie(SESSION_COOKIE, createSessionCookie(webuiUser), sessionCookieOptions(req));
    return res.json({ ok: true });
  }
  res.status(401).json({ ok: false, error: 'Invalid username or password' });
});

app.post('/api/logout', (req, res) => {
  sessionVersion++; // invalidate all previously issued cookies
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ ok: true });
});

app.get('/api/auth', (req, res) => {
  const authenticated = !authEnabled || verifySessionCookie(getSessionCookie(req));
  res.json({ authenticated, authEnabled });
});

// Public health endpoint for Docker HEALTHCHECK – always reachable, no sensitive data
app.get('/api/healthz', (req, res) => {
  res.json({ ok: true });
});

// --- Speed test (optional, gated by SPEEDTEST_ENABLED) ---
const SPEEDTEST_HISTORY_FILE = process.env.SPEEDTEST_HISTORY_FILE
  || path.join(fs.existsSync('/data') ? '/data' : path.join(__dirname, '..'), 'speedtest-history.json');

function parseSpeedtestOutput(stdout) {
  let result;
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'result') result = obj;
    } catch (_) {}
  }
  if (!result) throw new Error('No result received from speedtest');
  return result;
}

app.get('/api/speedtest/status', (req, res) => {
  res.json({ enabled: SPEEDTEST_ENABLED });
});

if (SPEEDTEST_ENABLED) {
  const { execFile } = require('child_process');
  const { promisify } = require('util');
  const execFileAsync = promisify(execFile);

  const speedtestHistory = [];
  const SPEEDTEST_MAX_HISTORY = 20;
  const SPEEDTEST_BIN = process.env.SPEEDTEST_BIN || '/usr/local/bin/speedtest';

  let running = false;

  // Load persisted history (best-effort; fall back to empty on any error)
  try {
    const parsed = JSON.parse(fs.readFileSync(SPEEDTEST_HISTORY_FILE, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error('history file is not an array');
    const valid = parsed.filter(e =>
      e && typeof e.timestamp === 'string' && typeof e.download === 'number' && typeof e.upload === 'number' && typeof e.ping === 'number'
    );
    speedtestHistory.push(...valid.slice(-SPEEDTEST_MAX_HISTORY));
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`[speedtest] failed to load history: ${err.message}`);
  }

  app.post('/api/speedtest', vpnActionLimiter, async (req, res) => {
    if (running) return res.status(409).json({ ok: false, error: 'Speed test already in progress' });
    running = true;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const { stdout } = await execFileAsync(SPEEDTEST_BIN, ['--accept-license', '--accept-gdpr', '-f', 'json', '-P', '8'], {
            timeout: 60000,
            maxBuffer: 1024 * 1024,
          });
          const result = parseSpeedtestOutput(stdout);
          const entry = {
            timestamp: new Date().toISOString(),
            download: result.download.bandwidth,
            upload: result.upload.bandwidth,
            ping: result.ping.latency,
            server: result.server.name,
            isp: result.isp,
          };
          speedtestHistory.push(entry);
          if (speedtestHistory.length > SPEEDTEST_MAX_HISTORY) speedtestHistory.shift();
          try {
            fs.writeFileSync(`${SPEEDTEST_HISTORY_FILE}.tmp`, JSON.stringify(speedtestHistory));
            fs.renameSync(`${SPEEDTEST_HISTORY_FILE}.tmp`, SPEEDTEST_HISTORY_FILE);
          } catch (err) {
            console.error('[speedtest] failed to save history:', err.message);
          }
          return res.json({ ok: true, ...entry });
        } catch (err) {
          console.error(`[speedtest] attempt ${attempt + 1}:`, err.message);
          if (err.killed || res.destroyed) break;          if (attempt === 0) await new Promise(r => setTimeout(r, 2000));
        }
      }
      if (!res.destroyed && !res.headersSent) {
        res.status(500).json({ ok: false, error: 'Speed test failed' });
      }
    } finally {
      running = false;
    }
  });

  app.get('/api/speedtest/history', (req, res) => {
    res.json({ ok: true, results: speedtestHistory });
  });
}

// 404 for undefined /api/* routes – must come before SPA catch-all
app.use('/api/', (req, res) => res.status(404).json({ ok: false, error: 'Not found' }));

app.get('/{*splat}', uiLimiter, (req, res) => {
  const filePath = path.join(__dirname, 'public', 'index.html');
  let html = fs.readFileSync(filePath, 'utf8');
  const defaultInterval = process.env.DEFAULT_POLL_INTERVAL || '';
  html = html.replace('{{DEFAULT_POLL_INTERVAL}}', defaultInterval);
  res.send(html);
});

// Global error handler – catches synchronous throws and next(err) calls
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ ok: false, error: 'Invalid JSON body' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ ok: false, error: 'Request body too large' });
  }
  console.error('[error]', err.message);
  const status = err.status || err.statusCode || 500;
  res.status(status).json({ ok: false, error: status >= 500 ? 'Internal server error' : err.message });
});

// Only listen when run directly (not when imported for testing)
if (require.main === module) {
  const server = app.listen(PORT, () => {
    console.log(`Gluetun Web UI running on port ${PORT}`);
    const redactUrl = (u) => { try { const x = new URL(u); return `${x.protocol}//${x.host}`; } catch (_) { return '[invalid url]'; } };
    instances.forEach(inst => console.log(`  [${inst.id}] ${inst.name} → ${redactUrl(inst.url)}`));
  });

  function gracefulShutdown(signal) {
    console.log(`\n[${signal}] Shutting down gracefully…`);
    server.close(() => { console.log('Server closed.'); process.exit(0); });
    setTimeout(() => process.exit(1), 5000);
  }
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}

module.exports = { app, parseInstances, gluetunFetch, parseSpeedtestOutput, sanitizeVpnSettings };
