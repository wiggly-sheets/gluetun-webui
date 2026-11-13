const fs = require('fs');

// Docker Secrets Support: read from /run/secrets/<name> (Docker Swarm/Compose secrets),
// fall back to env vars. Shared by server.js and provider-integrations.js.
function getConfigValue(envVar, secretName = null) {
  const secretPath = `/run/secrets/${secretName || envVar.toLowerCase()}`;
  try {
    if (fs.existsSync(secretPath)) return fs.readFileSync(secretPath, 'utf8').trim();
  } catch (_) {}
  return process.env[envVar] || '';
}

module.exports = { getConfigValue };