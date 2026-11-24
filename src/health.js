const { providerIntegrations } = require('./provider-integrations');
const { createCache } = require('./cache');

const HEALTH_COALESCE_MS = 2000;
const IPV6_CACHE_TTL_MS = 5 * 60 * 1000;
const IPV6_STALE_MS = 15 * 60 * 1000;

// --- Helper: strip VPN credentials from settings before sending to the browser ---
// Gluetun's /v1/vpn/settings includes private keys, pre-shared keys and OpenVPN
// credentials. The UI only needs protocol, provider name and server selection.
function sanitizeAirVpnSession(session, server = null) {
  return {
    device_name: session.device_name,
    vpn_ip: session.vpn_ip,
    exit_ip: session.exit_ip,
    server_name: session.server_name,
    server_country: session.server_country,
    server_location: session.server_location,
    connected_since_date: session.connected_since_date,
    bytes_read: session.bytes_read,
    bytes_write: session.bytes_write,
    speed_read: session.speed_read,
    speed_write: session.speed_write,
    server_health: server?.health,
    server_warning: server?.warning,
    server_load: server?.currentload,
    server_bw: server?.bw,
    server_bw_max: server?.bw_max,
    server_users: server?.users,
  };
}

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

// Deep module for one instance's health: batches Gluetun, AirVPN, IPv6 and provider
// lookups, hides credentials, merges the forwarded port, and coalesces concurrent callers.
// Dependencies are injected so tests can run the whole batch without a network.
function createHealthService({ fetchGluetun, fetchImpl = (...args) => fetch(...args), now = Date.now }) {
  // status is public data shared by all instances; stale entries are served while a refresh runs.
  const airVpnCache = createCache({ ttlMs: 120000, staleWhileRevalidate: true, now });
  // instanceId -> lowercased gluetun provider name, learned from vpnSettings each successful poll.
  const instanceProviderCache = new Map();
  const healthCache = new Map();
  const healthGeneration = new Map();
  let ipv6Cache = { value: null, fetchedAt: 0, retryAt: 0 };
  let ipv6InFlight = null;

  async function airVpnFetch(apiKey, service) {
    // status needs no API key — cache once for all instances instead of once per apiKey
    const cacheKey = service === 'status' ? `public:${service}` : `${apiKey || 'public'}:${service}`;
    return airVpnCache.get(cacheKey, async () => {
      const params = new URLSearchParams({ service, format: 'json' });
      if (apiKey) params.set('key', apiKey);
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 4000);
      try {
        const res = await fetchImpl(`https://airvpn.org/api/?${params}`, {
          signal: controller.signal,
          redirect: 'error',
        });
        if (!res.ok) throw new Error(`AirVPN returned ${res.status}`);
        return res.json();
      } finally {
        clearTimeout(timeoutId);
      }
    });
  }

  // --- Public IPv6 (best-effort, cached, background refresh) ---
  // NOTE: detected from the webui container's egress, not Gluetun's tunnel.
  // Route the webui through Gluetun (network_mode: service:gluetun) for the
  // VPN exit IPv6; otherwise this is the host's own IPv6 (or none).
  async function fetchPublicIpv6() {
    if (now() < ipv6Cache.retryAt) return ipv6Cache.value;
    if (ipv6InFlight) return ipv6InFlight;
    ipv6InFlight = (async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      try {
        const res = await fetchImpl('https://api6.ipify.org?format=json', {
          signal: controller.signal,
          redirect: 'error',
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const value = data.ip && data.ip.includes(':') ? { ipv6: data.ip } : null;
        ipv6Cache = { value, fetchedAt: now(), retryAt: now() + IPV6_CACHE_TTL_MS };
        return value;
      } catch (_) {
        // Keep the last value but stop refreshing its timestamp: after IPV6_STALE_MS
        // the health poll hides it. Retry on the cache TTL, not on every poll.
        ipv6Cache = { value: ipv6Cache.value, fetchedAt: ipv6Cache.fetchedAt, retryAt: now() + IPV6_CACHE_TTL_MS };
        return null;
      } finally {
        clearTimeout(timeoutId);
        ipv6InFlight = null;
      }
    })();
    return ipv6InFlight;
  }

  // --- Aggregate health for one instance ---
  async function fetchInstanceHealth(instance) {
    const hasAirVpn = Boolean(instance.airVpnApiKey);
    // Start IPv6 in the background immediately; the cached value is read after the batch.
    fetchPublicIpv6();
    // Gluetun checks and AirVPN run in parallel; the provider list waits for vpnSettings
    // so the learned provider can be used on the same poll.
    const checks = [
      ['upstream', fetchGluetun(instance, '/v1/vpn/status')],
      ['upstream', fetchGluetun(instance, '/v1/publicip/ip')],
      ['upstream', fetchGluetun(instance, '/v1/portforward')],
      ['upstream', fetchGluetun(instance, '/v1/dns/status')],
      ['upstream', fetchGluetun(instance, '/v1/vpn/settings')],
      ['airvpn', hasAirVpn ? airVpnFetch(instance.airVpnApiKey, 'status') : Promise.resolve(null)],
      ['airvpn', hasAirVpn ? airVpnFetch(instance.airVpnApiKey, 'userinfo') : Promise.resolve(null)],
    ];
    const connectedPromise = Promise.allSettled(checks.map(([, promise]) => promise));

    // Learn the provider as soon as vpnSettings settles, then start the provider list
    // fetch while the remaining Gluetun checks finish instead of waiting for the whole batch.
    const vpnSettingsEarly = await checks[4][1].then(
      data => ({ ok: true, data }),
      () => ({ ok: false, error: 'Upstream error' })
    );
    if (vpnSettingsEarly.ok && vpnSettingsEarly.data?.provider?.name) {
      instanceProviderCache.set(instance.id, String(vpnSettingsEarly.data.provider.name).toLowerCase());
    }
    const earlyAdapter = providerIntegrations[instanceProviderCache.get(instance.id)] || null;
    const earlyProviderList = earlyAdapter
      ? earlyAdapter.fetchServerList().then(
          data => ({ ok: true, data }),
          () => ({ ok: false, error: 'Upstream error' })
        )
      : null;

    const connected = await connectedPromise;
    connected.forEach((r, i) => {
      if (r.status === 'rejected') console.error(`[${checks[i][0]}][${instance.id}]`, r.reason?.message);
    });
    const [vpnStatus, publicIp, portForwarded, dnsStatus, vpnSettings, airVpnStatus, airVpnUserinfo] = connected.map(r =>
      r.status === 'fulfilled' ? { ok: true, data: r.value } : { ok: false, error: 'Upstream error' }
    );
    const allFailed = [vpnStatus, publicIp, portForwarded, dnsStatus, vpnSettings].every(r => !r.ok);

    const adapter = providerIntegrations[instanceProviderCache.get(instance.id)] || null;
    const providerList = adapter
      ? await (adapter === earlyAdapter && earlyProviderList
          ? earlyProviderList
          : adapter.fetchServerList().then(
              data => ({ ok: true, data }),
              () => ({ ok: false, error: 'Upstream error' })
            ))
      : { ok: false, error: 'No provider' };
    if (adapter && !providerList.ok) console.error(`[provider][${instance.id}] upstream fetch failed`);

    // Merge env var forwarded port when Gluetun returns 0 (AirVPN doesn't write to status file)
    const envPort = Number(instance.forwardedPort);
    if (portForwarded.ok && portForwarded.data && portForwarded.data.port === 0 && envPort > 0) {
      portForwarded.data.port = envPort;
      portForwarded.data.source = 'env';
      if (!portForwarded.data.ports || portForwarded.data.ports.length === 0) {
        portForwarded.data.ports = [envPort];
      }
    }

    // IPv6 is refreshed in the background and cached (5 min TTL) — never blocks the health poll.
    // A value older than the stale window is hidden so a broken lookup cannot show an address forever.
    const cachedIpv6 = ipv6Cache.value && now() - ipv6Cache.fetchedAt <= IPV6_STALE_MS
      ? ipv6Cache.value
      : null;
    const publicIpv6 = cachedIpv6 ? { ok: true, data: cachedIpv6 } : { ok: false, error: 'Not available' };

    // The API reports every AirVPN session on the account. Match this instance's tunnel by
    // exit IP; a session from another device stays in airVpnSessions and never claims to be local.
    const localExitIp = publicIp.ok ? publicIp.data?.public_ip : null;
    const rawSessions = airVpnUserinfo.ok
      ? (Array.isArray(airVpnUserinfo.data?.sessions)
          ? airVpnUserinfo.data.sessions
          : airVpnUserinfo.data?.connection ? [airVpnUserinfo.data.connection] : [])
      : [];
    const airVpnServers = new Map(
      (airVpnStatus.ok ? airVpnStatus.data?.servers || [] : []).map(server => [server.public_name, server])
    );
    const sessions = rawSessions
      .filter(Boolean)
      .map(session => sanitizeAirVpnSession(session, airVpnServers.get(session.server_name)))
      .filter(session => session.exit_ip || session.server_name);
    const localSession = localExitIp ? sessions.find(session => session.exit_ip === localExitIp) || null : null;

    let airVpnServer = null;
    // Match the local session's server; fall back to the vpnSettings name when AirVPN does not
    // report this instance as connected yet.
    if (airVpnStatus.ok && airVpnStatus.data?.servers) {
      const servers = airVpnStatus.data.servers;
      const candidates = [
        localSession?.server_name,
        vpnSettings?.ok ? vpnSettings.data?.provider?.server_selection?.names?.[0] : null,
      ];
      for (const name of candidates) {
        if (!name) continue;
        const found = servers.find(s => s.public_name === name);
        if (found) { airVpnServer = found; break; }
      }
    }

    const airVpnUserInfo = localSession
      ? { ok: true, data: { connection: localSession } }
      : { ok: false, error: 'No session for this instance' };
    const airVpnSessions = sessions.filter(session => session !== localSession);

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
      timestamp: new Date(now()).toISOString(),
      vpnStatus, publicIp, publicIpv6, portForwarded, dnsStatus,
      vpnSettings: vpnSettings.ok
        ? { ok: true, data: sanitizeVpnSettings(vpnSettings.data) }
        : vpnSettings,
      airVpnServer: airVpnServer ? { ok: true, data: airVpnServer } : { ok: false },
      airVpnUserInfo,
      airVpnSessions,
      providerData,
      allFailed,
    };
  }

  // Short coalescing window: concurrent clients share one upstream batch.
  function getHealth(instance) {
    const generation = healthGeneration.get(instance.id) || 0;
    const cached = healthCache.get(instance.id);
    if (cached) {
      if (cached.pending) return cached.pending;
      if (now() - cached.at < HEALTH_COALESCE_MS) return Promise.resolve(cached.data);
    }
    const pending = fetchInstanceHealth(instance)
      .then(data => {
        // Do not repopulate the cache from a batch that started before a mutation.
        if ((healthGeneration.get(instance.id) || 0) === generation) {
          healthCache.set(instance.id, { at: now(), data });
        }
        return data;
      })
      .catch(err => {
        healthCache.delete(instance.id);
        throw err;
      });
    healthCache.set(instance.id, { at: now(), pending });
    return pending;
  }

  function invalidate(instanceId) {
    healthCache.delete(instanceId);
    healthGeneration.set(instanceId, (healthGeneration.get(instanceId) || 0) + 1);
  }

  return { getHealth, fetchInstanceHealth, fetchPublicIpv6, airVpnFetch, invalidate };
}

module.exports = { createHealthService, sanitizeVpnSettings };
