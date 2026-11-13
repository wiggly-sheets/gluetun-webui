const { test } = require('node:test');
const assert = require('node:assert');
const { parseSpeedtestOutput } = require('../src/server.js');

test('parseSpeedtestOutput extracts the result object from JSONL output', () => {
  const stdout = [
    '{"type":"start","timestamp":"2026-01-01T00:00:00Z"}',
    '{"type":"ping","timestamp":"2026-01-01T00:00:01Z","ping":{"latency":12.3}}',
    '{"type":"result","download":{"bandwidth":12345678},"upload":{"bandwidth":3456789},"ping":{"latency":12.3},"server":{"name":"Foo"},"isp":"Bar"}',
  ].join('\n');
  const r = parseSpeedtestOutput(stdout);
  assert.strictEqual(r.type, 'result');
  assert.strictEqual(r.download.bandwidth, 12345678);
});

test('parseSpeedtestOutput skips corrupt lines', () => {
  const stdout = 'not json\n{"type":"result","download":{"bandwidth":1}}\n';
  const r = parseSpeedtestOutput(stdout);
  assert.strictEqual(r.download.bandwidth, 1);
});

test('parseSpeedtestOutput keeps the last result line when multiple exist', () => {
  const stdout = [
    '{"type":"result","download":{"bandwidth":1}}',
    '{"type":"result","download":{"bandwidth":2}}',
  ].join('\n');
  const r = parseSpeedtestOutput(stdout);
  assert.strictEqual(r.download.bandwidth, 2);
});

test('parseSpeedtestOutput throws when no result line', () => {
  assert.throws(() => parseSpeedtestOutput('{"type":"start"}\n'), /No result received/);
});