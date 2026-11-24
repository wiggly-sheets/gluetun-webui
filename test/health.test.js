const test = require('node:test');
const assert = require('node:assert');
const { createHealthService } = require('../src/health');

const instance = {
  id: '1',
  url: 'http://gluetun:8000',
  forwardedPort: '51820',
};

function fakeGluetun() {
  const calls = [];
  const fetchGluetun = async (_instance, endpoint) => {
    calls.push(endpoint);
    if (endpoint === '/v1/vpn/status') return { status: 'running' };
    if (endpoint === '/v1/publicip/ip') return { public_ip: '203.0.113.5', hostname: 'server.example' };
    if (endpoint === '/v1/portforward') return { port: 0 };
    if (endpoint === '/v1/dns/status') return { status: 'running' };
    if (endpoint === '/v1/vpn/settings') {
      return {
        type: 'wireguard',
        provider: { name: 'unknown-provider', server_selection: { names: ['s1'], hostnames: ['h1'], vpn: 'wireguard' } },
      };
    }
    throw new Error(`unexpected ${endpoint}`);
  };
  return { fetchGluetun, calls };
}

test('getHealth coalesces concurrent polls and merges the forwarded port', async () => {
  let clock = 1000;
  const { fetchGluetun, calls } = fakeGluetun();
  const fetchImpl = async () => ({ ok: true, json: async () => ({ ip: '2001:db8::1' }) });
  const service = createHealthService({ fetchGluetun, fetchImpl, now: () => clock });

  const [first, second] = await Promise.all([
    service.getHealth(instance),
    service.getHealth(instance),
  ]);

  assert.equal(calls.length, 5);
  assert.equal(first.allFailed, false);
  assert.equal(second.portForwarded.data.port, 51820);
  assert.deepEqual(first.portForwarded.data.ports, [51820]);
  assert.equal(first.vpnSettings.data.provider.name, 'unknown-provider');

  // Inside the coalescing window the cached entry is reused.
  await service.getHealth(instance);
  assert.equal(calls.length, 5);

  // After the window a fresh batch runs.
  clock += 2000;
  await service.getHealth(instance);
  assert.equal(calls.length, 10);
});

test('invalidate discards an in-flight batch instead of caching it', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let blockFirstStatus = true;
  const calls = [];
  const fetchGluetun = async (_instance, endpoint) => {
    calls.push(endpoint);
    if (endpoint === '/v1/vpn/status') {
      if (blockFirstStatus) { blockFirstStatus = false; await gate; }
      return { status: 'running' };
    }
    if (endpoint === '/v1/publicip/ip') return { public_ip: '203.0.113.5' };
    if (endpoint === '/v1/portforward') return { port: 0 };
    if (endpoint === '/v1/dns/status') return { status: 'running' };
    if (endpoint === '/v1/vpn/settings') return { type: 'wireguard', provider: { name: 'unknown-provider' } };
    throw new Error(`unexpected ${endpoint}`);
  };
  const fetchImpl = async () => ({ ok: true, json: async () => ({ ip: '2001:db8::1' }) });
  const service = createHealthService({ fetchGluetun, fetchImpl, now: () => 1000 });

  const first = service.getHealth(instance);
  await new Promise(resolve => setImmediate(resolve));
  service.invalidate(instance.id);
  release();
  await first;

  // The invalidated batch must not have cached its result: this call starts a new batch.
  await service.getHealth(instance);
  assert.equal(calls.filter(c => c === '/v1/vpn/status').length, 2);
});
