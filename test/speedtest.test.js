const { test } = require('node:test');
const assert = require('node:assert');

// Scrub config env before importing the server: its import-time validation can process.exit.
for (const key of [
  'WEBUI_USER', 'WEBUI_PASSWORD', 'TRUST_PROXY', 'SPEEDTEST_ENABLED', 'ALLOWED_HOSTS',
  'GLUETUN_CONTROL_URL', 'GLUETUN_NAME', 'GLUETUN_API_KEY', 'GLUETUN_USER', 'GLUETUN_PASSWORD',
  'GLUETUN_IP_DISPLAY_MODE', 'AIRVPN_API_KEY', 'FORWARDED_PORT', 'DEFAULT_POLL_INTERVAL',
]) delete process.env[key];
for (let i = 1; i <= 20; i++) {
  for (const field of ['URL', 'NAME', 'API_KEY', 'USER', 'PASSWORD', 'IP_DISPLAY_MODE', 'AIRVPN_API_KEY', 'FORWARDED_PORT']) {
    delete process.env[`GLUETUN_${i}_${field}`];
  }
}

const { parseSpeedtestOutput } = require('../src/server.js');

test('parseSpeedtestOutput returns the last result line and ignores non-JSON lines', () => {
  const stdout = [
    '{"type":"start","timestamp":"2026-01-01T00:00:00Z"}',
    'speedtest warning: not json',
    '{"type":"result","download":{"bandwidth":1}}',
    '{"type":"result","download":{"bandwidth":12345678},"upload":{"bandwidth":3456789},"ping":{"latency":12.3},"server":{"name":"Foo"},"isp":"Bar"}',
  ].join('\n');
  const r = parseSpeedtestOutput(stdout);
  assert.deepStrictEqual(
    { download: r.download.bandwidth, upload: r.upload.bandwidth, ping: r.ping.latency, server: r.server.name, isp: r.isp },
    { download: 12345678, upload: 3456789, ping: 12.3, server: 'Foo', isp: 'Bar' },
  );
});

test('parseSpeedtestOutput throws when no result line exists', () => {
  assert.throws(() => parseSpeedtestOutput('not json\n{"type":"start"}\n'), /No result received/);
});
