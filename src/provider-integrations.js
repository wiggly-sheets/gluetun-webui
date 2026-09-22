// --- Provider integrations ---
// Generic per-provider server cards. Adapters are additive: register one here and
// the health batch calls it for any instance whose gluetun provider matches.
// Each adapter: { fetchServerList, matchServer, buildCard }
//   fetchServerList(): Promise<Array> — fetch + cache the provider's server list
//   matchServer(list, candidates): Object|null — find the entry for the connected server
//   buildCard(list, matched): Object|null — normalized card data
// Card shape: { provider, serverName, location?, load?, extra?: [{label, value}] }
//
// Auth-based adapters (surfshark, protonvpn): fetchServerList returns null when the
// required credential env vars are unset — no card, no network call, no error spam.

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { getConfigValue } = require('./config');

const PROVIDER_TTL_MS = {
  nordvpn: 5 * 60 * 1000,    // load changes often
  mullvad: 60 * 60 * 1000,   // relays are static
  privado: 60 * 60 * 1000,   // hourly export
  ivpn: 5 * 60 * 1000,       // load changes often
  pia: 60 * 60 * 1000,       // regions are static
  windscribe: 60 * 60 * 1000, // locations are static
  surfshark: 5 * 60 * 1000,  // load changes often
  protonvpn: 10 * 60 * 1000, // load + status change
};

const DEFAULT_TIMEOUT_MS = 4000;

// ponytail: global cache keyed by URL — server lists are public data shared by all instances
const fetchJsonCache = new Map();

async function doFetch(url, ttlMs, timeoutMs, transform, text = false, headers = null) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'error',
      ...(headers ? { headers } : {}),
    });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} for ${url}`);
      err.status = res.status;
      throw err;
    }
    const data = text ? await res.text() : await res.json();
    return transform ? transform(data) : data;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchJson(url, { ttlMs, timeoutMs = DEFAULT_TIMEOUT_MS, transform = null, text = false, headers = null }) {
  const cached = fetchJsonCache.get(url);
  if (cached && cached.expires > Date.now()) return cached.data;      // fresh
  if (cached && cached.data) {                                        // stale: serve now, refresh in background
    if (!cached.refreshing) {
      cached.refreshing = true;
      // Fire-and-forget: never block callers on a refresh. On failure the stale
      // entry stays, so the next call retries. Only overwrite this key — a sweep
      // would evict sibling stale entries that stale-while-revalidate depends on.
      doFetch(url, ttlMs, timeoutMs, transform, text, headers)
        .then(data => fetchJsonCache.set(url, { data, expires: Date.now() + ttlMs }))
        .catch(() => {})
        .finally(() => { cached.refreshing = false; });
    }
    return cached.data;
  }
  if (cached && cached.promise) return cached.promise;                // in-flight: single-flight dedup

  const promise = doFetch(url, ttlMs, timeoutMs, transform, text, headers);
  // Store the in-flight promise: concurrent callers await the same fetch instead of firing their own
  fetchJsonCache.set(url, { promise });
  promise.then(
    data => fetchJsonCache.set(url, { data, expires: Date.now() + ttlMs }),
    () => fetchJsonCache.delete(url)   // failed first fetch: drop the rejected promise so the next call retries
  );
  return promise;
}

// Match the connected server against any of the candidate names across the given fields, case-insensitively
function matchBy(list, candidates, fields) {
  if (!list || !candidates || !candidates.length) return null;
  const needles = new Set(candidates.filter(Boolean).map(c => c.toLowerCase()));
  return list.find(entry => fields.some(f => needles.has(String(entry[f] || '').toLowerCase()))) || null;
}

// --- Mullvad account expiry (optional, requires MULLVAD_ACCOUNT_NUMBER) ---
let mullvadAccountData = null;
let mullvadAccountExpires = 0;
let mullvadAccountRefreshing = false;

const MULLVAD_ACCOUNT_TTL_MS = 60 * 60 * 1000;
// Negative cache: after a failure (e.g. invalid account number) don't retry every poll
const MULLVAD_ACCOUNT_FAIL_TTL_MS = 5 * 60 * 1000;

// One AbortController + timeout per request (token POST and account GET each get their own)
async function mullvadFetch(url, opts = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    return await fetch(url, { redirect: 'error', ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function mullvadFetchAccount(accountNumber) {
  const tokenRes = await mullvadFetch('https://api.mullvad.net/auth/v1/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account_number: accountNumber }),
  });
  if (!tokenRes.ok) throw new Error(`token HTTP ${tokenRes.status}`);
  const tokenData = await tokenRes.json();
  const token = tokenData.access_token || tokenData.token;
  if (!token) throw new Error('no access_token in token response');

  const acctRes = await mullvadFetch('https://api.mullvad.net/accounts/v1/accounts/me', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!acctRes.ok) throw new Error(`account HTTP ${acctRes.status}`);
  const acct = await acctRes.json();
  return { expires: acct.expires || null };
}

// Fire-and-forget: never block the card on the account fetch. Return the cached entry
// immediately (null on first call); the background fetch fills the cache for a later poll.
function fetchMullvadAccount() {
  const accountNumber = process.env.MULLVAD_ACCOUNT_NUMBER;
  if (!accountNumber) return null;
  if (mullvadAccountExpires > Date.now()) return mullvadAccountData;  // fresh, or negative-cached failure
  if (mullvadAccountRefreshing) return mullvadAccountData;            // in flight: return stale (or null)

  mullvadAccountRefreshing = true;
  mullvadFetchAccount(accountNumber)
    .then(data => {
      mullvadAccountData = data;
      mullvadAccountExpires = Date.now() + MULLVAD_ACCOUNT_TTL_MS;
    })
    .catch(err => {
      // The expiry row is optional — omit it rather than failing the card
      console.error('[provider][mullvad] account fetch failed:', err.message);
      mullvadAccountData = null;
      mullvadAccountExpires = Date.now() + MULLVAD_ACCOUNT_FAIL_TTL_MS;
    })
    .finally(() => { mullvadAccountRefreshing = false; });
  return mullvadAccountData;
}

// Authenticated fetch with timeout; follows redirects (auth hosts shuffle between APIs).
// Throws Error with .status on non-2xx so callers can react to 401s (revoked token).
// loginCall tags login-HTTP failures with .fromLogin so the token cache isn't invalidated
// on a bad password — a 401 from the login itself means credentials, not a stale token.
async function authFetch(url, opts = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), opts.timeoutMs || DEFAULT_TIMEOUT_MS);
  try {
    const { timeoutMs, ...fetchOpts } = opts;
    const res = await fetch(url, { redirect: 'follow', ...fetchOpts, signal: controller.signal });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} for ${url}`);
      err.status = res.status;
      throw err;
    }
    return { data: await res.json(), headers: res.headers };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function loginCall(url, opts) {
  try {
    return await authFetch(url, opts);
  } catch (err) {
    err.fromLogin = true; // login failure, not a stale token — keep the negative cache
    throw err;
  }
}

// Auth token cache, one entry per provider. Tokens are credentials: never expose them in
// cards or logs. TTL cache + single-flight (concurrent callers await the same login) +
// negative cache (a failing login is retried after failTtlMs, not every poll).
const tokenCache = new Map();

function cachedToken(key, ttlMs, loginFn, failTtlMs = 5 * 60 * 1000) {
  const cached = tokenCache.get(key);
  if (cached && cached.failUntil > Date.now()) return null;            // recent login failure: don't hammer
  if (cached && cached.expires > Date.now()) return cached.data;       // fresh token
  if (cached && cached.promise) return cached.promise;                 // in-flight: single-flight dedup
  const promise = loginFn()
    .then(token => {
      tokenCache.set(key, { data: token, expires: Date.now() + ttlMs });
      return token;
    })
    .catch(err => {
      tokenCache.set(key, { failUntil: Date.now() + failTtlMs });      // retry later, no error spam
      throw err;
    });
  tokenCache.set(key, { promise });
  return promise;
}

function cleanCard(card) {
  return {
    provider: card.provider,
    serverName: card.serverName,
    location: card.location || undefined,
    load: typeof card.load === 'number' ? card.load : undefined,
    extra: card.extra && card.extra.length ? card.extra : undefined,
  };
}

// ~29MB raw list -> ~2-3MB: cache only the fields the card needs
const slimNordvpnServers = servers => servers.map(s => ({
  name: s.name,
  hostname: s.hostname,
  load: s.load,
  country: s.locations?.[0]?.country?.name,
  city: s.locations?.[0]?.country?.city?.name,
}));

// --- Surfshark (auth-based) ---
// https://github.com/Incognito-Coder/Wiregen (wiregen.py) and gluetun PR #1560
// (qdm12/gluetun internal/provider/surfshark): login POST /v1/auth/login with
// {username, password} returns the field `token`; the generic cluster list is
// GET /v4/server/clusters/generic with fields connectionName, country, location,
// region, load (load confirmed live — the public endpoint returns it unauthenticated);
// account info GET /v1/payment/subscriptions/current returns {name, expiresAt}.
const SURFSHARK_TOKEN_TTL_MS = 30 * 60 * 1000;
const SURFSHARK_SUB_TTL_MS = 12 * 60 * 60 * 1000;
const SURFSHARK_SUB_FAIL_TTL_MS = 5 * 60 * 1000;
let surfsharkSub = { data: null, expires: 0 };

async function surfsharkLogin() {
  const res = await loginCall('https://api.surfshark.com/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json;charset=utf-8', Accept: 'application/json' },
    body: JSON.stringify({
      username: getConfigValue('SURFSHARK_USER'),
      password: getConfigValue('SURFSHARK_PASSWORD'),
    }),
  });
  const token = res.data.token || res.data.accessToken;
  if (!token) throw new Error('no token in login response');
  return token;
}

// Fire-and-forget like mullvad's account fetch: never block the card. The expiry row
// shows up on a later poll; a failure is negative-cached and retried after the fail TTL.
function primeSurfsharkSubscription() {
  if (surfsharkSub.expires > Date.now()) return;
  surfsharkSub.expires = Date.now() + SURFSHARK_SUB_FAIL_TTL_MS; // in-flight guard
  // cachedToken returns a bare token on a warm cache, a promise otherwise — wrap both
  Promise.resolve(cachedToken('surfshark', SURFSHARK_TOKEN_TTL_MS, surfsharkLogin))
    .then(token => {
      if (!token) return null;
      return authFetch('https://api.surfshark.com/v1/payment/subscriptions/current', {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      });
    })
    .then(res => {
      if (res) surfsharkSub = { data: res.data, expires: Date.now() + SURFSHARK_SUB_TTL_MS };
    })
    .catch(err => {
      if (err.status === 401 && !err.fromLogin) tokenCache.delete('surfshark'); // stale token: re-login next poll
      console.error('[provider][surfshark] subscription fetch failed:', err.message);
      surfsharkSub = { data: null, expires: Date.now() + SURFSHARK_SUB_FAIL_TTL_MS };
    });
}

function surfsharkExpiryRow() {
  const expiry = surfsharkSub.data?.expiresAt || surfsharkSub.data?.expires_on;
  if (!expiry) return [];
  let date;
  if (/^\d+$/.test(String(expiry))) {
    const numeric = Number(expiry);
    // Unix seconds (< 1e12) vs epoch milliseconds — normalize before creating the Date
    date = new Date(numeric < 1e12 ? numeric * 1000 : numeric).toISOString();
  } else {
    date = String(expiry); // ISO string
  }
  return [{ label: 'Subscription expires', value: date.slice(0, 10) }];
}

// --- ProtonVPN (auth-based, SRP-6a) ---
// ponytail: SRP handshake built from reverse-engineered docs, unverified against a live account — test with real credentials
//
// Flow (2026, confirmed live against api.protonvpn.ch):
//  1. POST /auth/v4/sessions (empty body, with app headers) -> {AccessToken, UID}. Required:
//     the old two-step flow (info without a session) is dead — it returns 401 "Invalid access token".
//  2. POST /auth/v4/info {Username, Intent: "Proton"} with Bearer + x-pm-uid ->
//     {Code:1000, Modulus (PGP clearsigned), Salt (base64, 10 bytes), ServerEphemeral (base64),
//     SRPSession (hex), Version:4}.
//  3. SRP proofs (math from ProtonMail/go-srp, used by gluetun, and @protontech/crypto — the
//     web client's own implementation; bcryptjs is the exact library @protontech/crypto uses):
//       x = expandHash(bcrypt(password, "$2y$10$" + dotSlashB64(salt || "proton")) || N)
//       A = g^a mod N,  k = expandHash(LE(2) || N) mod N,  u = expandHash(A || B) as LE int
//       S = (B - k*g^x)^(u*x + a) mod N
//       M1 = expandHash(A || B || S),  M2 = expandHash(A || M1 || S)
//     All wire numbers are 256-byte little-endian. expandHash = SHA512(x||0)||SHA512(x||1)||SHA512(x||2)||SHA512(x||3).
//  4. POST /auth/v4 {Username, ClientEphemeral: b64(A), ClientProof: b64(M1), SRPSession} ->
//     {Code:1000, AccessToken, UID, ServerProof}. 2FA accounts set TwoFactor / 2FA.Enabled
//     (or return Code 8003) and are NOT supported — no TOTP.
//  5. GET /vpn/v2/logicals with Authorization: Bearer <AccessToken> + x-pm-uid.
const PROTON_API = 'https://api.protonvpn.ch';
const PROTON_TOKEN_TTL_MS = 60 * 60 * 1000;
const PROTON_HEADERS = {
  'User-Agent': 'ProtonVPN/5.15.95 (Android)',
  'x-pm-appversion': 'android-vpn@5.15.95.5-dev+play',
  'x-pm-apiversion': '4',
  Accept: 'application/vnd.protonmail.v1+json',
};

const SRP_BYTES = 256; // 2048-bit modulus

function bigIntFromLE(bytes) {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]);
  return n;
}

function bigIntToLE(num, byteLength) {
  const out = Buffer.alloc(byteLength);
  for (let i = 0; i < byteLength; i++) { out[i] = Number(num & 0xffn); num >>= 8n; }
  return out;
}

function expandHash(data) {
  const parts = [];
  for (let i = 0; i < 4; i++) {
    parts.push(crypto.createHash('sha512').update(Buffer.concat([data, Buffer.from([i])])).digest());
  }
  return Buffer.concat(parts);
}

function modExp(base, exponent, modulus) {
  let result = 1n;
  base %= modulus;
  while (exponent > 0n) {
    if (exponent & 1n) result = (result * base) % modulus;
    base = (base * base) % modulus;
    exponent >>= 1n;
  }
  return result;
}

function mod(a, m) { const r = a % m; return r < 0n ? r + m : r; }

// Strip PGP clearsign armor + signature. The OpenPGP signature check (done by Proton's own
// clients) is skipped: the modulus arrives over TLS from api.protonvpn.ch — the same trust
// domain that supplies the SRP session. Reimplementing OpenPGP verification would need a
// dependency; TLS already binds the response to the host.
function pgpClearSignedToBytes(signed) {
  const match = String(signed).match(
    /-----BEGIN PGP SIGNED MESSAGE-----\r?\n(?:[^\r\n]*\r?\n)*\r?\n([\s\S]*?)\r?\n-----BEGIN PGP SIGNATURE-----/
  );
  if (!match) throw new Error('malformed PGP clearsigned modulus');
  return Buffer.from(match[1].replace(/\s/g, ''), 'base64');
}

// Proton v3/v4 password digest. The API Salt (10 bytes) + "proton" form the 16-byte bcrypt
// salt, dot-slash encoded (the standard bcrypt base64 alphabet) under a $2y$10$ prefix.
function protonHashPassword(password, version, saltB64, modulus) {
  if (version !== 3 && version !== 4) throw new Error(`unsupported Proton auth version ${version} (expected 3 or 4)`);
  const salt = Buffer.from(saltB64, 'base64');
  const bcryptSalt = bcrypt.encodeBase64(new Uint8Array(Buffer.concat([salt, Buffer.from('proton')])), 16);
  const crypted = bcrypt.hashSync(password, `$2y$10$${bcryptSalt}`);
  return expandHash(Buffer.concat([Buffer.from(crypted, 'latin1'), modulus])); // x
}

// Client-side SRP proofs; returns A (clientEphemeral), M1 (clientProof), M2 (expectedServerProof),
// all 256-byte little-endian.
function protonGenerateProofs(modulus, xBytes, serverEphemeralBytes) {
  if (modulus.length !== SRP_BYTES || serverEphemeralBytes.length !== SRP_BYTES) {
    throw new Error(`unexpected SRP parameter size (modulus ${modulus.length}, ephemeral ${serverEphemeralBytes.length})`);
  }
  const N = bigIntFromLE(modulus);
  const g = 2n;
  const B = bigIntFromLE(serverEphemeralBytes);
  // go-srp checkParams: B = 0 or B = N yields S = 0 — reject both (malicious/glitched server)
  if (B === 0n || B % N === 0n) throw new Error('invalid server ephemeral');

  const k = bigIntFromLE(expandHash(Buffer.concat([bigIntToLE(g, SRP_BYTES), modulus]))) % N;
  const x = bigIntFromLE(xBytes);
  const Nminus1 = N - 1n;

  let a, A, u;
  do {
    a = bigIntFromLE(crypto.randomBytes(SRP_BYTES));
    A = modExp(g, a, N);
    u = bigIntFromLE(expandHash(Buffer.concat([bigIntToLE(A, SRP_BYTES), serverEphemeralBytes])));
  } while (A === 0n || u === 0n);

  const kgx = mod(k * modExp(g, x, N), N);
  const S = modExp(mod(B - kgx, N), mod(u * x + a, Nminus1), N);
  const aBytes = bigIntToLE(A, SRP_BYTES);
  const sBytes = bigIntToLE(S, SRP_BYTES);
  const M1 = expandHash(Buffer.concat([aBytes, serverEphemeralBytes, sBytes]));
  const M2 = expandHash(Buffer.concat([aBytes, M1, sBytes]));
  return { clientEphemeral: aBytes, clientProof: M1, expectedServerProof: M2 };
}

async function protonLogin() {
  const username = getConfigValue('PROTONVPN_USER');
  const password = getConfigValue('PROTONVPN_PASSWORD');

  // Anonymous session bootstrap (see flow comment above)
  const sessionRes = await loginCall(`${PROTON_API}/auth/v4/sessions`, {
    method: 'POST',
    headers: { ...PROTON_HEADERS, 'Content-Type': 'application/json' },
    body: '{}',
  });
  const anonToken = sessionRes.data.AccessToken;
  const anonUid = sessionRes.data.UID || '';
  if (!anonToken) throw new Error('no access token in session response');

  const sessionHeaders = {
    ...PROTON_HEADERS,
    'Content-Type': 'application/json',
    Authorization: `Bearer ${anonToken}`,
    ...(anonUid ? { 'x-pm-uid': anonUid } : {}),
  };

  const infoRes = await loginCall(`${PROTON_API}/auth/v4/info`, {
    method: 'POST',
    headers: sessionHeaders,
    body: JSON.stringify({ Username: username, Intent: 'Proton' }),
  });
  const info = infoRes.data;
  if (info.Code !== undefined && info.Code !== 1000) throw new Error(`auth/info code ${info.Code}: ${info.Error || ''}`);
  const { Modulus, Salt, ServerEphemeral, SRPSession, Version } = info;
  if (!Modulus || !Salt || !ServerEphemeral || !SRPSession) throw new Error('incomplete auth/info response');

  const modulus = pgpClearSignedToBytes(Modulus);
  const serverEphemeral = Buffer.from(ServerEphemeral, 'base64');
  const x = protonHashPassword(password, Number(Version || 4), Salt, modulus);
  const proofs = protonGenerateProofs(modulus, x, serverEphemeral);

  const authRes = await loginCall(`${PROTON_API}/auth/v4`, {
    method: 'POST',
    headers: sessionHeaders,
    body: JSON.stringify({
      Username: username,
      ClientEphemeral: proofs.clientEphemeral.toString('base64'),
      ClientProof: proofs.clientProof.toString('base64'),
      SRPSession,
    }),
  });
  const auth = authRes.data;

  // Accounts with 2FA enabled are not supported (no TOTP implementation)
  if (auth.Code === 8003 || Number(auth.TwoFactor || 0) > 0 || Number(auth['2FA']?.Enabled || 0) > 0) {
    throw new Error('PROTONVPN 2FA not supported');
  }
  if (auth.Code !== undefined && auth.Code !== 1000) throw new Error(`auth code ${auth.Code}: ${auth.Error || ''}`);
  if (auth.ServerProof && auth.ServerProof !== proofs.expectedServerProof.toString('base64')) {
    throw new Error('server proof mismatch (wrong username or password)');
  }
  if (!auth.AccessToken) throw new Error('no access token in auth response');
  return { token: auth.AccessToken, uid: auth.UID || anonUid };
}

const providerIntegrations = {
  nordvpn: {
    async fetchServerList() {
      // Default response is only 100 servers; the full list is required to match an arbitrary connection.
      // 15s timeout: this is the big list (~29MB). The other providers' lists are small and keep the 4s default.
      return fetchJson('https://api.nordvpn.com/v1/servers?limit=9999', {
        ttlMs: PROVIDER_TTL_MS.nordvpn,
        timeoutMs: 15000,
        transform: slimNordvpnServers,
      });
    },
    matchServer(list, candidates) {
      // gluetun may store the display name or the hostname in server_selection — match both
      return matchBy(list, candidates, ['name', 'hostname']);
    },
    buildCard(list, matched) {
      if (!matched) return null;
      return cleanCard({
        provider: 'nordvpn',
        serverName: matched.name,
        location: [matched.country, matched.city].filter(Boolean).join(', '),
        load: matched.load,
      });
    },
  },

  mullvad: {
    async fetchServerList() {
      const data = await fetchJson('https://api.mullvad.net/app/v1/relays', { ttlMs: PROVIDER_TTL_MS.mullvad });
      const locations = data.locations || {};
      const seen = new Set();
      return [data.openvpn, data.wireguard, data.bridge]
        .flatMap(group => (group?.relays || []))
        .filter(r => r.active)
        .map(r => ({
          hostname: r.hostname,
          owned: r.owned,
          location: r.location,
          country_name: locations[r.location]?.country,
          city_name: locations[r.location]?.city,
        }))
        // The same hostname appears in openvpn/wireguard/bridge groups — keep the first
        .filter(r => !seen.has(r.hostname) && seen.add(r.hostname));
    },
    matchServer(list, candidates) {
      return matchBy(list, candidates, ['hostname']);
    },
    buildCard(list, matched) {
      if (!matched) return null;
      const extra = [{ label: 'Owned', value: matched.owned ? 'Yes' : 'No' }];
      // Non-blocking: returns cached account data or null; the expiry row shows up on a later poll
      const account = fetchMullvadAccount();
      if (account?.expires) {
        extra.push({ label: 'Account expires', value: String(account.expires).slice(0, 10) });
      }
      return cleanCard({
        provider: 'mullvad',
        serverName: matched.hostname,
        location: [matched.country_name, matched.city_name].filter(Boolean).join(', '),
        extra,
      });
    },
  },

  privado: {
    async fetchServerList() {
      const data = await fetchJson('https://privadovpn.com/apps/servers_export.json', { ttlMs: PROVIDER_TTL_MS.privado });
      return data.servers || [];
    },
    matchServer(list, candidates) {
      return matchBy(list, candidates, ['hostname']);
    },
    buildCard(list, matched) {
      if (!matched) return null;
      return cleanCard({
        provider: 'privado',
        serverName: matched.hostname,
        location: [matched.country, matched.city].filter(Boolean).join(', '),
        load: matched.load,
      });
    },
  },

  ivpn: {
    async fetchServerList() {
      // Live status (per-server load + country/city). The old /v4/status path 404s;
      // the status page points to /v4/servers/stats which carries the same fields plus load.
      return fetchJson('https://api.ivpn.net/v4/servers/stats', {
        ttlMs: PROVIDER_TTL_MS.ivpn,
        transform: data => (data.servers || [])
          .filter(s => s.is_active && !s.in_maintenance)
          .map(s => ({
            gateway: s.gateway,
            hostname: s.hostnames?.openvpn || s.gateway,
            wgHostname: s.hostnames?.wireguard || s.gateway,
            country: s.country,
            city: s.city,
            load: s.load,
          })),
      });
    },
    matchServer(list, candidates) {
      // gluetun stores either the OpenVPN gateway or the WireGuard hostname in server_selection
      return matchBy(list, candidates, ['gateway', 'hostname', 'wgHostname']);
    },
    buildCard(list, matched) {
      if (!matched) return null;
      return cleanCard({
        provider: 'ivpn',
        serverName: matched.gateway,
        location: [matched.country, matched.city].filter(Boolean).join(', '),
        load: matched.load,
      });
    },
  },

  pia: {
    async fetchServerList() {
      // The response is JSON on the first line followed by a newline + base64 signature;
      // parse the first line instead of the whole body.
      return fetchJson('https://serverlist.piaservers.net/vpninfo/servers/v4', {
        ttlMs: PROVIDER_TTL_MS.pia,
        text: true,
        transform: raw => JSON.parse(raw.split('\n')[0]).regions.map(r => ({
          id: r.id,
          name: r.name,
          country: r.country,
          dns: r.dns,
          portForward: r.port_forward,
        })),
      });
    },
    matchServer(list, candidates) {
      // gluetun may store the region display name, region id, or DNS hostname
      return matchBy(list, candidates, ['name', 'id', 'dns']);
    },
    buildCard(list, matched) {
      if (!matched) return null;
      return cleanCard({
        provider: 'pia',
        serverName: matched.name,
        location: matched.country,
        extra: [{ label: 'Port forwarding', value: matched.portForward ? 'Yes' : 'No' }],
      });
    },
  },

  windscribe: {
    async fetchServerList() {
      return fetchJson('https://assets.windscribe.com/serverlist/mob-v2/0/0', {
        ttlMs: PROVIDER_TTL_MS.windscribe,
        transform: data => (data.data || []).flatMap(loc =>
          (loc.groups || []).map(g => ({
            name: loc.name,
            country: loc.country || loc.country_code, // full name when present, code otherwise
            city: g.city,
            hostname: g.ovpn_x509,
            wgEndpoint: g.wg_endpoint,
            dnsHostname: loc.dns_hostname,
          }))
        ),
      });
    },
    matchServer(list, candidates) {
      // gluetun stores the location name, city, or a per-city hostname in server_selection
      return matchBy(list, candidates, ['name', 'city', 'hostname', 'wgEndpoint', 'dnsHostname']);
    },
    buildCard(list, matched) {
      if (!matched) return null;
      return cleanCard({
        provider: 'windscribe',
        serverName: matched.hostname || matched.city,
        location: [matched.country, matched.city].filter(Boolean).join(', '),
      });
    },
  },

  surfshark: {
    // ponytail: /v4/server/clusters/generic shape (connectionName, country, location, region)
    // reverse-engineered from wiregen.py (Incognito-Coder/Wiregen) — verify the field
    // mapping against a live account with real credentials before trusting card output.
    async fetchServerList() {
      // Opt-in: no credentials -> no card, no network call, no errors
      if (!(getConfigValue('SURFSHARK_USER') && getConfigValue('SURFSHARK_PASSWORD'))) return null;
      try {
        const token = await cachedToken('surfshark', SURFSHARK_TOKEN_TTL_MS, surfsharkLogin);
        if (!token) return null; // negative-cached login failure
        primeSurfsharkSubscription(); // non-blocking: expiry row appears on a later poll
        // return await (not return): a bare `return promise` bypasses this catch on rejection
        return await fetchJson('https://api.surfshark.com/v4/server/clusters/generic', {
          ttlMs: PROVIDER_TTL_MS.surfshark,
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
          transform: data => (Array.isArray(data) ? data : []).map(s => ({
            hostname: s.connectionName,
            country: s.country,
            city: s.location,
            region: s.region,
            load: typeof s.load === 'number' ? s.load : undefined,
          })),
        });
      } catch (err) {
        if (err.status === 401 && !err.fromLogin) tokenCache.delete('surfshark'); // stale token: re-login next poll
        console.error('[provider][surfshark]', err.message);
        return null;
      }
    },
    matchServer(list, candidates) {
      return matchBy(list, candidates, ['hostname', 'city']);
    },
    buildCard(list, matched) {
      if (!matched) return null;
      return cleanCard({
        provider: 'surfshark',
        serverName: matched.hostname,
        location: [matched.country, matched.city].filter(Boolean).join(', '),
        load: matched.load,
        extra: surfsharkExpiryRow(),
      });
    },
  },

  protonvpn: {
    async fetchServerList() {
      if (!(getConfigValue('PROTONVPN_USER') && getConfigValue('PROTONVPN_PASSWORD'))) return null;
      try {
        const auth = await cachedToken('protonvpn', PROTON_TOKEN_TTL_MS, protonLogin);
        if (!auth) return null; // negative-cached login failure
        // return await (not return): a bare `return promise` bypasses this catch on rejection
        return await fetchJson(`${PROTON_API}/vpn/v2/logicals`, {
          ttlMs: PROVIDER_TTL_MS.protonvpn,
          headers: {
            ...PROTON_HEADERS,
            Authorization: `Bearer ${auth.token}`,
            ...(auth.uid ? { 'x-pm-uid': auth.uid } : {}),
          },
          transform: data => (data.LogicalServers || []).map(s => ({
            name: s.Name,
            hostname: s.Domain || s.Servers?.[0]?.Domain || null,
            country: s.ExitCountry,
            city: s.City,
            region: s.Region,
            load: typeof s.Load === 'number' ? s.Load : undefined,
          })),
        });
      } catch (err) {
        if (err.status === 401 && !err.fromLogin) tokenCache.delete('protonvpn'); // revoked/expired token: re-login next poll
        console.error('[provider][protonvpn]', err.message);
        return null;
      }
    },
    matchServer(list, candidates) {
      return matchBy(list, candidates, ['name', 'hostname']);
    },
    buildCard(list, matched) {
      if (!matched) return null;
      return cleanCard({
        provider: 'protonvpn',
        serverName: matched.name || matched.hostname,
        location: [matched.country, matched.city].filter(Boolean).join(', '),
        load: matched.load,
      });
    },
  },
};

module.exports = {
  providerIntegrations,
  // Exposed so the SRP math can be exercised offline (no real Proton credentials to verify
  // against the live server). Not used by the app.
  __test: {
    bigIntFromLE,
    bigIntToLE,
    expandHash,
    modExp,
    pgpClearSignedToBytes,
    protonHashPassword,
    protonGenerateProofs,
  },
};