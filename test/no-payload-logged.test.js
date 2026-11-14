// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness, spyHandler } from './helpers.js';

test('log lines never contain arguments, tokens, scopes, claims or the raw agent ID', async () => {
  const { arken, lines } = harness({ secret: 'server-secret' });
  const { handler } = spyHandler({ content: [{ type: 'text', text: 'RESULT-SECRET' }] });
  const tool = arken.wrap('search', handler);

  const extra = {
    authInfo: {
      clientId: 'CLIENT-ID-SECRET',
      token: 'BEARER-TOKEN-SECRET',
      scopes: ['SCOPE-SECRET'],
      extra: { email: 'EMAIL-SECRET@example.com', sub: 'SUB-SECRET' },
    },
    requestInfo: { headers: { authorization: 'Bearer HEADER-SECRET' } },
  };
  await tool({ query: 'ARG-SECRET', apiKey: 'sk-ARGKEY-SECRET' }, extra);

  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0] ?? '', /SECRET/);
});

test('the server secret itself never appears in logs', async () => {
  const { arken, lines } = harness({ secret: 'HMAC-KEY-SECRET' });
  const { handler } = spyHandler();
  await arken.wrap('t', handler)({}, { authInfo: { clientId: 'a' } });
  assert.doesNotMatch(lines.join('\n'), /SECRET/);
});

test('the default error reporter does not print error messages (they may carry secrets)', async () => {
  /** @type {string[]} */
  const writes = [];
  const original = process.stderr.write;
  // @ts-ignore: capture stderr for this test only
  process.stderr.write = (chunk) => (writes.push(String(chunk)), true);
  try {
    const { createArken } = await import('@arkenforge/core');
    const arken = createArken({
      log: () => {},
      identify: () => { throw new Error('token BEARER-SECRET was malformed'); },
    });
    const { handler } = spyHandler();
    await arken.wrap('t', handler)({}, {});
  } finally {
    process.stderr.write = original;
  }
  assert.ok(writes.length > 0, 'an internal error should be reported');
  assert.doesNotMatch(writes.join(''), /SECRET/);
});
