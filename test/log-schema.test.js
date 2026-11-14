// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extraFor, harness, spyHandler } from './helpers.js';

test('one JSON line per call with exactly the documented fields', async () => {
  const { arken, lines } = harness({ rateLimit: { limit: 5, windowS: 30 } });
  const tool = arken.wrap('search', spyHandler().handler);
  await tool({}, extraFor('agent-a'));
  await tool({}, extraFor('agent-a'));

  assert.equal(lines.length, 2);
  for (const line of lines) {
    assert.doesNotMatch(line, /\n/);
    const r = JSON.parse(line);
    assert.deepEqual(Object.keys(r), ['ts', 'agent', 'tool', 'decision_inputs', 'would_block', 'duration_ms']);
    assert.deepEqual(Object.keys(r.decision_inputs), ['revoked', 'count', 'limit', 'window_s']);
    assert.equal(new Date(r.ts).toISOString(), r.ts);
    assert.equal(typeof r.agent, 'string');
    assert.equal(r.tool, 'search');
    assert.equal(typeof r.decision_inputs.revoked, 'boolean');
    assert.equal(typeof r.decision_inputs.count, 'number');
    assert.equal(r.decision_inputs.limit, 5);
    assert.equal(r.decision_inputs.window_s, 30);
    assert.equal(typeof r.would_block, 'boolean');
    assert.ok(r.duration_ms >= 0);
  }
});

test('duration_ms measures the handler', async () => {
  const { arken, records } = harness();
  await arken.wrap('slow', async (/** @type {unknown[]} */ ..._args) => new Promise((r) => setTimeout(r, 25)))({}, extraFor('a'));
  assert.ok(records()[0].duration_ms >= 20, `got ${records()[0].duration_ms}`);
});

test('the default sink writes to stderr, never stdout', async () => {
  const { createArken } = await import('@arkenforge/core');
  /** @type {string[]} */
  const out = [];
  /** @type {string[]} */
  const err = [];
  const [o, e] = [process.stdout.write, process.stderr.write];
  // @ts-ignore: capture both streams for this test only
  process.stdout.write = (c) => (out.push(String(c)), true);
  // @ts-ignore
  process.stderr.write = (c) => (err.push(String(c)), true);
  try {
    await createArken().wrap('t', spyHandler().handler)({}, extraFor('a'));
  } finally {
    process.stdout.write = o;
    process.stderr.write = e;
  }
  assert.equal(out.length, 0);
  assert.equal(err.length, 1);
  assert.equal(JSON.parse(err[0] ?? '').tool, 't');
});
