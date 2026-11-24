import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';

// Keep tests independent of the developer's shell environment.
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
process.env.GLUETUN_1_URL = 'http://127.0.0.1:1';
process.env.GLUETUN_1_NAME = 'Test Instance';

let app;
let sanitizeVpnSettings;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  const mod = await import('../src/server.js');
  app = mod.app;
  sanitizeVpnSettings = mod.sanitizeVpnSettings;
  // Health polls refresh the public IPv6 address in the background. Keep the suite offline
  // by answering only that request; all other fetches stay real.
  globalThis.fetch = (url, opts) => String(url).startsWith('https://api6.ipify.org')
    ? Promise.resolve({ ok: true, json: async () => ({ ip: '203.0.113.1' }) })
    : realFetch(url, opts);
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

describe('GET /api/health', () => {
  it('returns 503 when all upstream checks fail', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
    expect(res.body.allFailed).toBe(true);
  });
});

describe('legacy instance-1 endpoints', () => {
  for (const path of ['/api/status', '/api/publicip', '/api/portforwarded', '/api/settings', '/api/dns']) {
    it(`still proxies ${path}`, async () => {
      const res = await request(app).get(path);
      expect(res.status).toBe(502);
      expect(res.body).toEqual({ ok: false, error: 'Upstream error' });
    });
  }

  it('still validates legacy VPN actions', async () => {
    const res = await request(app).put('/api/vpn/restart');
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it('still proxies legacy VPN actions', async () => {
    const res = await request(app).put('/api/vpn/start');
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ ok: false, error: 'Upstream error' });
  });
});

describe('GET /api/instances', () => {
  it('returns only the configured public fields', async () => {
    const res = await request(app).get('/api/instances');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { id: '1', name: 'Test Instance', ipDisplayMode: 'auto' },
    ]);
  });
});

describe('GET /api/:instanceId/health', () => {
  it('returns 400 for unknown instance', async () => {
    const res = await request(app).get('/api/99/health');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ ok: false, error: 'Unknown instance ID' });
  });

  it('returns 503 when all upstream checks fail', async () => {
    const res = await request(app).get('/api/1/health');
    expect(res.status).toBe(503);
    expect(res.body.allFailed).toBe(true);
  });
});

describe('mutating API requests', () => {
  it('rejects a cross-origin request', async () => {
    const res = await request(app)
      .post('/api/login')
      .set('Origin', 'https://evil.example')
      .send({ username: 'a', password: 'b' });
    expect(res.status).toBe(403);
    expect(res.body.ok).toBe(false);
  });
});

describe('GET /api/:instanceId/servers', () => {
  it('rejects missing, malformed, and repeated provider params', async () => {
    const cases = [
      ['/api/1/servers', 'Missing provider query param'],
      ['/api/1/servers?provider=', 'Missing provider query param'],
      ['/api/1/servers?provider=bad%2Fname', 'Invalid provider'],
      ['/api/1/servers?provider=nordvpn&provider=mullvad', 'Invalid provider query param'],
    ];
    for (const [url, error] of cases) {
      const res = await request(app).get(url);
      expect(res.status, url).toBe(400);
      expect(res.body, url).toEqual({ ok: false, error });
    }
  });
});

describe('PUT /api/:instanceId/vpn/:action', () => {
  it('returns 400 for unknown instance', async () => {
    const res = await request(app).put('/api/99/vpn/start');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Unknown instance ID');
  });

  it('rejects unsupported actions on the per-instance route', async () => {
    const res = await request(app).put('/api/1/vpn/restart');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid action/);
  });
});

describe('PUT /api/:instanceId/settings', () => {
  it('returns 400 for malformed JSON', async () => {
    const res = await request(app)
      .put('/api/1/settings')
      .set('Content-Type', 'application/json')
      .send('{"broken":');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ ok: false, error: 'Invalid JSON body' });
  });
});

describe('Unknown /api/* routes', () => {
  it('returns 404 JSON', async () => {
    const res = await request(app).get('/api/nonexistent');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ ok: false, error: 'Not found' });
  });
});

describe('SPA catch-all', () => {
  it('serves index.html with template placeholders replaced', async () => {
    const res = await request(app).get('/some/path');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
    expect(res.text).toContain('<title>Gluetun-WebUI</title>');
    expect(res.text).not.toContain('{{DEFAULT_POLL_INTERVAL}}');
  });
});

describe('Host header validation (DNS rebinding)', () => {
  it('rejects unknown Host', async () => {
    const res = await request(app).get('/api/instances').set('Host', 'evil.example.com');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Forbidden');
  });

  it('allows localhost Host', async () => {
    const res = await request(app).get('/api/instances').set('Host', 'localhost:3000');
    expect(res.status).toBe(200);
  });
});

describe('sanitizeVpnSettings', () => {
  it('keeps UI fields and drops VPN credentials', () => {
    const clean = sanitizeVpnSettings({
      type: 'wireguard',
      openvpn: { password: 'secret', key: 'key' },
      wireguard: { private_key: 'priv', pre_shared_key: 'psk' },
      provider: {
        name: 'protonvpn',
        server_selection: { names: ['nl-1'], hostnames: ['nl-1.example'], vpn: 'wireguard' },
      },
    });
    expect(clean).toEqual({
      type: 'wireguard',
      provider: {
        name: 'protonvpn',
        server_selection: { names: ['nl-1'], hostnames: ['nl-1.example'], vpn: 'wireguard' },
      },
    });
    expect(JSON.stringify(clean)).not.toMatch(/secret|priv|psk|"key"/);
  });
});
