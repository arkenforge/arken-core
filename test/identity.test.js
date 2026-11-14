// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromApiKeyId, fromClaim, hashAgent } from '@arkenforge/core';
import { extraFor, harness, spyHandler } from './helpers.js';

test('the same client ID with different tokens hashes to the same agent', async () => {
  const { arken, records } = harness({ secret: 's' });
  const tool = arken.wrap('t', spyHandler().handler);
  await tool({}, extraFor('agent-a', 'token-1'));
  await tool({}, extraFor('agent-a', 'token-2-reissued'));
  await tool({}, extraFor('agent-b', 'token-1'));
  const [a1, a2, b] = records().map((r) => r.agent);
  assert.equal(a1, a2);
  assert.notEqual(a1, b);
  assert.match(a1, /^[0-9a-f]{32}$/);
});

test('the hash depends on the secret', () => {
  assert.notEqual(hashAgent('agent-a'), hashAgent('agent-a', 's1'));
  assert.notEqual(hashAgent('agent-a', 's1'), hashAgent('agent-a', 's2'));
  assert.equal(hashAgent('agent-a', 's1'), hashAgent('agent-a', 's1'));
});

test('fromClaim and fromApiKeyId read authInfo.extra', async () => {
  const { arken, records } = harness({ identify: fromClaim('sub') });
  await arken.wrap('t', spyHandler().handler)({}, extraFor('agent-a'));
  assert.equal(records()[0].agent, hashAgent('sub-agent-a'));

  const keyed = harness({ identify: fromApiKeyId() });
  await keyed.arken.wrap('t', spyHandler().handler)({}, { authInfo: { extra: { apiKeyId: 'key_123' } } });
  assert.equal(keyed.records()[0].agent, hashAgent('key_123'));
});

test('a custom identify function is supported', async () => {
  const { arken, records } = harness({ identify: (/** @type {import('@arkenforge/core').ExtraLike} */ extra) => extra.authInfo?.clientId?.toUpperCase() });
  await arken.wrap('t', spyHandler().handler)({}, extraFor('agent-a'));
  assert.equal(records()[0].agent, hashAgent('AGENT-A'));
});

test('handlers without an input schema (extra only) are identified too', async () => {
  const { arken, records } = harness();
  await arken.wrap('t', spyHandler().handler)(extraFor('agent-a'));
  assert.equal(records()[0].agent, hashAgent('agent-a'));
});
