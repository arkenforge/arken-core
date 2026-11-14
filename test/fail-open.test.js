// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extraFor, harness, spyHandler } from './helpers.js';

/**
 * The handler ran exactly once, with the original argument objects, and its result came back as-is.
 * @param {import('@arkenforge/core').Arken} arken
 */
async function assertPassedThrough(arken) {
  const { handler, calls, result } = spyHandler();
  const args = { q: 1 };
  const extra = extraFor('agent-a');
  const out = await arken.wrap('t', handler)(args, extra);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.[0], args);
  assert.equal(calls[0]?.[1], extra);
  assert.equal(out, result);
}

test('identify throws: call passes through and the error is reported', async () => {
  const { arken, errors } = harness({ identify: () => { throw new Error('boom'); } });
  await assertPassedThrough(arken);
  assert.equal(errors.length, 1);
});

test('clock throws: call passes through', async () => {
  const { arken, errors } = harness({ now: () => { throw new Error('boom'); } });
  await assertPassedThrough(arken);
  assert.ok(errors.length >= 1);
});

test('deny list unreadable (a directory): call passes through', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'arken-core-test-'));
  const { arken, errors } = harness({ denyList: dir });
  await assertPassedThrough(arken);
  assert.equal(errors.length, 1);
});

test('deny list missing: call passes through', async () => {
  const { arken } = harness({ denyList: join(tmpdir(), 'arken-core-does-not-exist', 'revoked.txt') });
  await assertPassedThrough(arken);
});

test('log sink throws: call passes through', async () => {
  const { arken, errors } = harness({ log: () => { throw new Error('disk full'); } });
  await assertPassedThrough(arken);
  assert.equal(errors.length, 1);
});

test('log sink and error reporter both throw: call still passes through', async () => {
  const { arken } = harness({
    log: () => { throw new Error('disk full'); },
    onError: () => { throw new Error('reporter broken'); },
  });
  await assertPassedThrough(arken);
});

test('custom enforce predicate throws: call passes through', async () => {
  const { arken } = harness({
    rateLimit: { limit: 0, windowS: 60 },
    enforce: () => { throw new Error('boom'); },
  });
  await assertPassedThrough(arken);
});

test('handler errors propagate unchanged and the handler runs once', async () => {
  const { arken, lines } = harness();
  const failure = new Error('tool failed');
  let calls = 0;
  const tool = arken.wrap('t', async (/** @type {unknown[]} */ ..._args) => { calls += 1; throw failure; });
  await assert.rejects(tool({}, extraFor('a')), (err) => err === failure);
  assert.equal(calls, 1);
  assert.equal(lines.length, 1, 'a failed call is still logged');
});

test('synchronous handler throws propagate unchanged', async () => {
  const { arken } = harness();
  const failure = new TypeError('sync failure');
  const tool = arken.wrap('t', (/** @type {unknown[]} */ ..._args) => { throw failure; });
  await assert.rejects(tool({}, extraFor('a')), (err) => err === failure);
});

test('`this` is preserved for handlers that use it', async () => {
  const { arken } = harness();
  const owner = {
    name: 'owner',
    tool: arken.wrap('t', async function (/** @type {unknown} */ _args, /** @type {unknown} */ _extra) {
      // @ts-ignore: `this` is the owner object
      return this.name;
    }),
  };
  assert.equal(await owner.tool({}, extraFor('a')), 'owner');
});
