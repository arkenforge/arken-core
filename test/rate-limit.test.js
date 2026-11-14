// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter } from '../dist/ratelimit.js';
import { extraFor, harness, spyHandler } from './helpers.js';

test('the limit trips on call limit+1 and resets after the window', async () => {
  const { arken, clock, records } = harness({ rateLimit: { limit: 3, windowS: 10 } });
  const { handler, calls } = spyHandler();
  const tool = arken.wrap('t', handler);

  for (let i = 0; i < 4; i++) await tool({}, extraFor('agent-a'));
  clock.t += 9_999;
  await tool({}, extraFor('agent-a'));
  clock.t += 1;
  await tool({}, extraFor('agent-a'));

  assert.deepEqual(records().map((r) => [r.decision_inputs.count, r.would_block]), [
    [1, false], [2, false], [3, false], [4, true], [5, true], [1, false],
  ]);
  assert.equal(calls.length, 6, 'observe-only: every call ran');
  for (const r of records()) {
    assert.equal(r.decision_inputs.limit, 3);
    assert.equal(r.decision_inputs.window_s, 10);
  }
});

test('agents are counted separately', async () => {
  const { arken, records } = harness({ rateLimit: { limit: 1, windowS: 60 } });
  const tool = arken.wrap('t', spyHandler().handler);
  await tool({}, extraFor('agent-a'));
  await tool({}, extraFor('agent-a'));
  await tool({}, extraFor('agent-b'));
  assert.deepEqual(records().map((r) => r.would_block), [false, true, false]);
});

test('counts are shared across tools for the same agent', async () => {
  const { arken, records } = harness({ rateLimit: { limit: 1, windowS: 60 } });
  await arken.wrap('one', spyHandler().handler)({}, extraFor('agent-a'));
  await arken.wrap('two', spyHandler().handler)({}, extraFor('agent-a'));
  assert.deepEqual(records().map((r) => [r.tool, r.would_block]), [['one', false], ['two', true]]);
});

test('enforcement applies only to the agents it is switched on for', async () => {
  const { arken } = harness({ rateLimit: { limit: 1, windowS: 60 }, enforce: ['agent-enforced'] });
  const { handler, calls } = spyHandler();
  const tool = arken.wrap('t', handler);

  await tool({}, extraFor('agent-enforced'));
  const blocked = await tool({}, extraFor('agent-enforced'));
  await tool({}, extraFor('agent-observed'));
  await tool({}, extraFor('agent-observed'));

  assert.equal(blocked.isError, true);
  assert.match(blocked.content[0]?.text ?? '', /Rate limit exceeded: 1 calls per 60 s/);
  assert.equal(calls.length, 3, 'only the enforced over-limit call was blocked');
});

test('enforce accepts hashes and predicates', async () => {
  const { arken: byPredicate } = harness({ rateLimit: { limit: 0, windowS: 60 }, enforce: () => true });
  assert.equal((await byPredicate.wrap('t', spyHandler().handler)({}, extraFor('a'))).isError, true);

  const probe = harness();
  await probe.arken.wrap('t', spyHandler().handler)({}, extraFor('agent-h'));
  const hash = probe.records()[0].agent;

  const { arken: byHash } = harness({ rateLimit: { limit: 0, windowS: 60 }, enforce: [hash] });
  assert.equal((await byHash.wrap('t', spyHandler().handler)({}, extraFor('agent-h'))).isError, true);
});

test('calls with no identity are logged with agent null and never limited', async () => {
  const { arken, records } = harness({ rateLimit: { limit: 0, windowS: 60 }, enforce: () => true });
  const { handler, calls } = spyHandler();
  await arken.wrap('t', handler)({}, {});
  await arken.wrap('t', handler)({}, { authInfo: { token: 'only-a-token' } });
  assert.equal(calls.length, 2);
  assert.deepEqual(records().map((r) => [r.agent, r.would_block]), [[null, false], [null, false]]);
});

test('the limiter stays bounded', () => {
  const limiter = new RateLimiter({ limit: 1, windowS: 60 }, 100);
  for (let i = 0; i < 1_000; i++) limiter.hit(`agent-${i}`, 0);
  assert.equal(limiter.hit('agent-999', 0), 2, 'recent agents are kept');
  assert.equal(limiter.hit('agent-0', 0), 1, 'the oldest were dropped');
});
