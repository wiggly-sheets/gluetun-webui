// --- Provider integrations ---
// Generic per-provider server cards. Adapters are additive: register one here and
// the health batch calls it for any instance whose gluetun provider matches.
// Each adapter: { fetchServerList, matchServer, buildCard }
//   fetchServerList(): Promise<Array> — fetch + cache the provider's server list
//   matchServer(list, candidates): Object|null — find the entry for the connected server
//   buildCard(list, matched): Object|null — normalized card data
// Card shape: { provider, serverName, location?, load?, extra?: [{label, value}] }

const PROVIDER_TTL_MS = {
  nordvpn: 5 * 60 * 1000,    // load changes often
  mullvad: 60 * 60 * 1000,   // relays are static
  privado: 60 * 60 * 1000,   // hourly export
};

const DEFAULT_TIMEOUT_MS = 4000;

// ponytail: global cache keyed by URL — server lists are public data shared by all instances
const fetchJsonCache = new Map();

async function doFetch(url, ttlMs, timeoutMs, transform) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'error' });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const data = await res.json();
    return transform ? transform(data) : data;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchJson(url, { ttlMs, timeoutMs = DEFAULT_TIMEOUT_MS, transform = null }) {
  const cached = fetchJsonCache.get(url);
  if (cached && cached.expires > Date.now()) return cached.data;      // fresh
  if (cached && cached.data) {                                        // stale: serve now, refresh in background
    if (!cached.refreshing) {
      cached.refreshing = true;
      // Fire-and-forget: never block callers on a refresh. On failure the stale
      // entry stays, so the next call retries. Only overwrite this key — a sweep
      // would evict sibling stale entries that stale-while-revalidate depends on.
      doFetch(url, ttlMs, timeoutMs, transform)
        .then(data => fetchJsonCache.set(url, { data, expires: Date.now() + ttlMs }))
        .catch(() => {})
        .finally(() => { cached.refreshing = false; });
    }
    return cached.data;
  }
  if (cached && cached.promise) return cached.promise;                // in-flight: single-flight dedup

  const promise = doFetch(url, ttlMs, timeoutMs, transform);
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
};

module.exports = { providerIntegrations };