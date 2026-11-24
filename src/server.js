const express = require('express');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { providerIntegrations } = require('./provider-integrations');
const { createHealthService, sanitizeVpnSettings } = require('./health');
const { createCache } = require('./cache');
const { loadSettings, parseInstances } = require('./settings');

const SPEEDTEST_ENABLED = process.env.SPEEDTEST_ENABLED === 'true';
const INDEX_TEMPLATE = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
const DEFAULT_POLL_INTERVAL = process.env.DEFAULT_POLL_INTERVAL || '';

const app = express();
app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : false);
app.disable('x-powered-by');
const PORT = process.env.PORT || 3000;
const LATENCY_CHART = process.env.LATENCY_CHART !== 'false';
const LATENCY_CHART_RENDERER = process.env.LATENCY_CHART_RENDERER === 'plotly' ? 'plotly' : 'svg';

const settings = loadSettings();
const instances = settings.instances;
const instanceMap = new Map(instances.map(inst => [inst.id, inst]));

// Server list cache: provider -> servers (TTL 1h, one upstream fetch at a time)
const SERVERS_TTL = 60 * 60 * 1000;
const serversCache = createCache({ ttlMs: SERVERS_TTL, maxEntries: 50 });

// --- Optional Web UI authentication ---
// Opt-in: enabled only when BOTH WEBUI_USER and WEBUI_PASSWORD are set (env var or Docker secret webui_user/webui_password).
// Sessions are an HMAC-signed cookie derived from the password with scrypt (no extra config;
// a password change invalidates all sessions, and a stolen cookie cannot cheaply guess the password).
const { enabled: authEnabled, user: webuiUser, password: webuiPassword } = settings.auth;
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
  if (['/login', '/logout', '/auth', '/healthz'].includes(req.path)) return next();
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
const readLimiter = rateLimit({
  windowMs: 60 * 1000,
  // Worst case: 20 instances at 5s from three tabs (720/min) plus UI calls.
  max: 1200,
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

// Reject cross-site mutations. Sec-Fetch-Site is exact (scheme, host, port); Origin is the
// fallback and is checked against the Host allowlist so a proxy may rewrite Host. Requests
// without either header (curl) keep working; SameSite=Lax also covers cookies.
app.use('/api/', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  // Modern browsers send Sec-Fetch-Site: exact same-origin includes scheme and port,
  // and it survives a proxy that rewrites Host (e.g. nginx proxy_pass default).
  const fetchSite = req.headers['sec-fetch-site'];
  if (fetchSite) {
    if (fetchSite === 'same-origin') return next();
    return res.status(403).json({ ok: false, error: 'Cross-origin request blocked' });
  }
  const origin = req.headers.origin;
  if (!origin) return next();
  let originHostname;
  try { originHostname = new URL(origin).hostname.toLowerCase(); }
  catch (_) { return res.status(403).json({ ok: false, error: 'Cross-origin request blocked' }); }
  // Compare against the configured host allowlist rather than Host: a reverse proxy may
  // rewrite Host, while an attacker origin is still not a host this app serves.
  if (!allowedHosts.has(originHostname)) {
    return res.status(403).json({ ok: false, error: 'Cross-origin request blocked' });
  }
  next();
});
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

const healthService = createHealthService({ fetchGluetun: gluetunFetch });

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
  const health = await healthService.getHealth(instance);
  // Return 503 if all upstream checks failed (service completely unreachable)
  if (health.allFailed) {
    return res.status(503).json({ ok: false, error: 'Service unavailable', ...health });
  }
  res.json({ ok: true, ...health });
});

// --- Legacy aggregate health (instance 1) ---
app.get('/api/health', async (req, res) => {
  const health = await healthService.getHealth(instances[0]);
  // Return 503 if all upstream checks failed (service completely unreachable)
  if (health.allFailed) {
    return res.status(503).json({ ok: false, error: 'Service unavailable', ...health });
  }
  res.json({ ok: true, ...health });
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
    healthService.invalidate(instance.id);
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
  try {
    const servers = await serversCache.get(provider, async () => {
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
        return data.servers.map(s => ({
          server_name: s.server_name ?? s.hostname ?? s.name,
          country: s.country,
          vpn: s.vpn,
        })).filter(s => s.server_name);
      } finally {
        clearTimeout(timeoutId);
      }
    });
    res.json({ ok: true, data: servers });
  } catch (err) {
    console.error('[servers]', err.message);
    res.status(502).json({ ok: false, error: 'Could not fetch server list' });
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
    healthService.invalidate(instance.id);
    res.json({ ok: true, data });
  } catch (err) {
    console.error(`[upstream][${instance.id}]`, err.message);
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
  // Only a valid session may invalidate every cookie; an expired one just clears its own.
  if (authEnabled && verifySessionCookie(getSessionCookie(req))) sessionVersion++;
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
  res.send(INDEX_TEMPLATE.replace('{{DEFAULT_POLL_INTERVAL}}', DEFAULT_POLL_INTERVAL));
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
