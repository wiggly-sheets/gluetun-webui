const { getConfigValue } = require('./config');

const MAX_INSTANCES = 20;

function buildInstance({ id, name, url, apiKey, user, password, ipDisplayMode, airVpnApiKey, forwardedPort }) {
  return {
    id,
    name,
    url: url.replace(/\/$/, ''),
    apiKey,
    user,
    password,
    ipDisplayMode: ipDisplayMode || 'auto',
    airVpnApiKey,
    forwardedPort,
  };
}

function parseInstances() {
  const sharedAirVpnApiKey = getConfigValue('AIRVPN_API_KEY', 'airvpn_api_key');
  const sharedForwardedPort = getConfigValue('FORWARDED_PORT', 'forwarded_port');
  const list = [];

  for (let i = 1; i <= MAX_INSTANCES; i++) {
    const url = getConfigValue(`GLUETUN_${i}_URL`, `gluetun_${i}_url`);
    if (!url) continue;
    try {
      new URL(url);
    } catch (_) {
      console.error(`[startup] Invalid GLUETUN_${i}_URL: ${url}`);
      process.exit(1);
    }
    list.push(buildInstance({
      id: String(i),
      name: getConfigValue(`GLUETUN_${i}_NAME`, `gluetun_${i}_name`) || `Instance ${i}`,
      url,
      apiKey: getConfigValue(`GLUETUN_${i}_API_KEY`, `gluetun_${i}_api_key`),
      user: getConfigValue(`GLUETUN_${i}_USER`, `gluetun_${i}_user`),
      password: getConfigValue(`GLUETUN_${i}_PASSWORD`, `gluetun_${i}_password`),
      ipDisplayMode: getConfigValue(`GLUETUN_${i}_IP_DISPLAY_MODE`, `gluetun_${i}_ip_display_mode`),
      airVpnApiKey: getConfigValue(`GLUETUN_${i}_AIRVPN_API_KEY`, `gluetun_${i}_airvpn_api_key`) || sharedAirVpnApiKey,
      forwardedPort: getConfigValue(`GLUETUN_${i}_FORWARDED_PORT`, `gluetun_${i}_forwarded_port`) || sharedForwardedPort,
    }));
  }

  if (list.length === 0) {
    // Legacy single-instance fallback
    const legacyUrl = getConfigValue('GLUETUN_CONTROL_URL', 'gluetun_control_url') || 'http://gluetun:8000';
    try {
      new URL(legacyUrl);
    } catch (_) {
      console.error(`[startup] Invalid GLUETUN_CONTROL_URL: ${legacyUrl}`);
      process.exit(1);
    }
    list.push(buildInstance({
      id: '1',
      name: getConfigValue('GLUETUN_NAME', 'gluetun_name') || 'Gluetun',
      url: legacyUrl,
      apiKey: getConfigValue('GLUETUN_API_KEY', 'gluetun_api_key'),
      user: getConfigValue('GLUETUN_USER', 'gluetun_user'),
      password: getConfigValue('GLUETUN_PASSWORD', 'gluetun_password'),
      ipDisplayMode: getConfigValue('GLUETUN_IP_DISPLAY_MODE', 'gluetun_ip_display_mode'),
      airVpnApiKey: sharedAirVpnApiKey,
      forwardedPort: sharedForwardedPort,
    }));
  }
  return list;
}

function loadAuth() {
  const user = getConfigValue('WEBUI_USER', 'webui_user');
  const password = getConfigValue('WEBUI_PASSWORD', 'webui_password');
  if (Boolean(user) !== Boolean(password)) {
    console.error('[startup] Misconfiguration: WEBUI_USER and WEBUI_PASSWORD must be set together to enable authentication');
    process.exit(1);
  }
  return { user, password, enabled: Boolean(user && password) };
}

function loadSettings() {
  return { instances: parseInstances(), auth: loadAuth() };
}

module.exports = { loadSettings, parseInstances };
