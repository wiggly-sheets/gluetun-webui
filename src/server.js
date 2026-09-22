const express = require('express');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const { providerIntegrations } = require('./provider-integrations');

const app = express();
app.set('trust proxy', process.env.TRUST_PROXY === 'true');
app.disable('x-powered-by');
const PORT = process.env.PORT || 3000;

// --- Docker Secrets Support ---
// Try to read from /run/secrets/ (Docker Swarm/Compose secrets), fall back to env vars
function getConfigValue(envVar, secretName = null) {
  const secretPath = `/run/secrets/${secretName || envVar.toLowerCase()}`;
  try {
    if (fs.existsSync(secretPath)) {
      return fs.readFileSync(secretPath, 'utf8').trim();
    }
  } catch (_) {}
  return process.env[envVar] || '';
}

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
      secondaryPublicIp: getConfigValue(`GLUETUN_${i}_SECONDARY_PUBLIC_IP`, `gluetun_${i}_secondary_public_ip`) || '',
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
      secondaryPublicIp: getConfigValue('GLUETUN_SECONDARY_PUBLIC_IP', 'gluetun_secondary_public_ip') || '',
      airVpnApiKey: sharedAirVpnApiKey,
      forwardedPort: getConfigValue('FORWARDED_PORT', 'forwarded_port'),
    });
  }
  return list;
}

const instances = parseInstances();
const instanceMap = new Map(instances.map(inst => [inst.id, inst]));

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
const readLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
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

app.use('/api/', (req, res, next) => req.method === 'GET' ? readLimiter(req, res, next) : next());

// Security headers
app.use((req, res, next) => {
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

app.use(express.json({ limit: '2kb' }));
app.use(uiLimiter, express.static(path.join(__dirname, 'public')));

async function gluetunFetch(instance, endpoint, method = 'GET', body = null) {
  const url = `${instance.url}${endpoint}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);
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
    return res.json();
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

// --- Helper: aggregate health for one instance ---
// Returns { timestamp, vpnStatus, publicIp, portForwarded, dnsStatus, vpnSettings, allFailed }
// allFailed = true if ALL 5 checks failed (service is completely unreachable)

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
    vpnStatus, publicIp, portForwarded, dnsStatus, vpnSettings,
    airVpnServer: airVpnServer ? { ok: true, data: airVpnServer } : { ok: false },
    airVpnUserInfo: airVpnUserInfo ? { ok: true, data: airVpnUserInfo } : { ok: false },
    providerData,
    allFailed,
  };
}

// --- Instance list endpoint ---
app.get('/api/instances', (req, res) => {
  res.json(instances.map(({ id, name }) => ({ id, name })));
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

app.get('/api/settings', async (req, res) => {
  try {
    const data = await gluetunFetch(instances[0], '/v1/vpn/settings');
    res.json({ ok: true, data });
  } catch (err) {
    console.error('[upstream]', err.message);
    res.status(502).json({ ok: false, error: 'Upstream error' });
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

// VPN control actions
const vpnActionLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many requests, please try again later.' },
});

// Rate limiting for SPA/static index route
const staticLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
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

// 404 for undefined /api/* routes – must come before SPA catch-all
app.use('/api/', (req, res) => res.status(404).json({ ok: false, error: 'Not found' }));

app.get('*', staticLimiter, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Global error handler – catches synchronous throws and next(err) calls
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[error]', err.message);
  res.status(500).json({ ok: false, error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Gluetun Web UI running on port ${PORT}`);
  instances.forEach(inst => console.log(`  [${inst.id}] ${inst.name} → ${inst.url}`));
});
