const test = require('node:test');
const assert = require('node:assert');
const { createCache } = require('../src/cache');

test('cache returns fresh data and coalesces concurrent misses', async () => {
  let clock = 0;
  let calls = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const cache = createCache({ ttlMs: 10, now: () => clock });
  const fetchFn = async () => { calls++; await gate; return calls; };

  const first = cache.get('key', fetchFn);
  const second = cache.get('key', fetchFn);
  release();

  assert.equal(await first, 1);
  assert.equal(await second, 1);
  assert.equal(calls, 1);

  assert.equal(await cache.get('key', fetchFn), 1);
  assert.equal(calls, 1);

  clock = 11;
  assert.equal(await cache.get('key', fetchFn), 2);
  assert.equal(calls, 2);
});

test('stale-while-revalidate serves the old value while one refresh runs', async () => {
  let clock = 0;
  let calls = 0;
  let release;
  let gate = Promise.resolve();
  const cache = createCache({ ttlMs: 10, staleWhileRevalidate: true, now: () => clock });
  const fetchFn = async () => {
    calls++;
    if (calls > 1) await gate;
    return `v${calls}`;
  };

  assert.equal(await cache.get('key', fetchFn), 'v1');
  clock = 11;
  gate = new Promise(resolve => { release = resolve; });

  assert.equal(await cache.get('key', fetchFn), 'v1');
  assert.equal(calls, 2);
  release();
  await gate;
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(await cache.get('key', fetchFn), 'v2');
  assert.equal(calls, 2);
});

test('evicts the oldest entry when maxEntries is reached', async () => {
  let clock = 0;
  const cache = createCache({ ttlMs: 10, maxEntries: 1, now: () => clock });
  assert.equal(await cache.get('a', async () => 1), 1);
  assert.equal(await cache.get('b', async () => 2), 2);

  let calls = 0;
  assert.equal(await cache.get('a', async () => { calls++; return 3; }), 3);
  assert.equal(calls, 1);
});

test('negative cache returns null until the failure window expires', async () => {
  let clock = 0;
  let calls = 0;
  const cache = createCache({ ttlMs: 10, negativeTtlMs: 5, now: () => clock });
  const fail = async () => { calls++; throw new Error('upstream down'); };

  await assert.rejects(cache.get('key', fail), /upstream down/);
  assert.equal(await cache.get('key', fail), null);
  assert.equal(calls, 1);

  clock = 5;
  assert.equal(await cache.get('key', async () => { calls++; return 'ok'; }), 'ok');
  assert.equal(calls, 2);
});
