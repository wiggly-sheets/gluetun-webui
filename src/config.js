const fs = require('fs');

// Docker Secrets Support: read from /run/secrets/<name> (Docker Swarm/Compose secrets),
// fall back to env vars. Shared by server.js and provider-integrations.js.
// Values are read once per process: rotating a secret requires a restart.
const configCache = new Map();

function getConfigValue(envVar, secretName = null) {
  const cacheKey = `${envVar}:${secretName || ''}`;
  if (configCache.has(cacheKey)) return configCache.get(cacheKey);
  const secretPath = `/run/secrets/${secretName || envVar.toLowerCase()}`;
  let value = '';
  try {
    if (fs.existsSync(secretPath)) value = fs.readFileSync(secretPath, 'utf8').trim();
  } catch (_) {}
  if (!value) value = process.env[envVar] || '';
  configCache.set(cacheKey, value);
  return value;
}

module.exports = { getConfigValue };