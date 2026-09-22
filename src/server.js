const express = require('express');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

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
  const list = [];
  for (let i = 1; i <= 20; i++) {
    const url = getConfigValue(`GLUETUN_${i}_URL`, `gluetun_${i}_url`);
    if (!url) continue;
    // Validate URL at startup (fail-fast)
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
    });
  }
  return list;
}

const instances = parseInstances();
const instanceMap = new Map(instances.map(inst => [inst.id, inst]));

// --- Optional Web UI authentication ---
// Opt-in: enabled only when BOTH WEBUI_USER and WEBUI_PASSWORD are set (env var or Docker secret webui_user/webui_password).
// Sessions are an HMAC-signed cookie derived from the password (no extra config; a password change invalidates all sessions).
const webuiUser     = getConfigValue('WEBUI_USER', 'webui_user');
const webuiPassword = getConfigValue('WEBUI_PASSWORD', 'webui_password');
if (Boolean(webuiUser) !== Boolean(webuiPassword)) {
  console.error('[startup] Misconfiguration: WEBUI_USER and WEBUI_PASSWORD must be set together to enable authentication');
  process.exit(1);
}
const authEnabled = Boolean(webuiUser && webuiPassword);
const SESSION_COOKIE = 'webui_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const sessionSigningKey = crypto.createHash('sha256').update(webuiPassword).digest();
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

// Auth must run before the /api/ rate limiters and routes
app.use('/api/', requireAuth);

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

// --- Helper: aggregate health for one instance ---
// Returns { timestamp, vpnStatus, publicIp, portForwarded, dnsStatus, vpnSettings, allFailed }
// allFailed = true if ALL 5 checks failed (service is completely unreachable)
async function fetchInstanceHealth(instance) {
  const results = await Promise.allSettled([
    gluetunFetch(instance, '/v1/vpn/status'),
    gluetunFetch(instance, '/v1/publicip/ip'),
    gluetunFetch(instance, '/v1/portforward'),
    gluetunFetch(instance, '/v1/dns/status'),
    gluetunFetch(instance, '/v1/vpn/settings'),
  ]);
  results.forEach(r => { if (r.status === 'rejected') console.error(`[upstream][${instance.id}]`, r.reason?.message); });
  const [vpnStatus, publicIp, portForwarded, dnsStatus, vpnSettings] = results.map(r =>
    r.status === 'fulfilled' ? { ok: true, data: r.value } : { ok: false, error: 'Upstream error' }
  );
  const allFailed = results.every(r => r.status === 'rejected');
  return { timestamp: new Date().toISOString(), vpnStatus, publicIp, portForwarded, dnsStatus, vpnSettings, allFailed };
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
  res.json({ authenticated });
});

// Public health endpoint for Docker HEALTHCHECK – always reachable, no sensitive data
app.get('/api/healthz', (req, res) => {
  res.json({ ok: true });
});

// 404 for undefined /api/* routes – must come before SPA catch-all
app.use('/api/', (req, res) => res.status(404).json({ ok: false, error: 'Not found' }));

app.get('*', staticLimiter, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
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
  res.status(500).json({ ok: false, error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Gluetun Web UI running on port ${PORT}`);
  instances.forEach(inst => console.log(`  [${inst.id}] ${inst.name} → ${inst.url}`));
});
