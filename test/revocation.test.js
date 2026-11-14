// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { hashAgent } from '@arkenforge/core';
import { extraFor, harness, spyHandler, tempFile } from './helpers.js';

test('a revoked agent shows would_block while its sibling does not; observe-only runs both', async () => {
  const { path } = tempFile('# revoked agents\nagent-revoked\n');
  const { arken, records } = harness({ denyList: path });
  const { handler, calls } = spyHandler();
  const tool = arken.wrap('search', handler);

  await tool({}, extraFor('agent-revoked'));
  await tool({}, extraFor('agent-sibling'));

  const [revoked, sibling] = records();
  assert.equal(revoked.decision_inputs.revoked, true);
  assert.equal(revoked.would_block, true);
  assert.equal(sibling.decision_inputs.revoked, false);
  assert.equal(sibling.would_block, false);
  assert.equal(calls.length, 2, 'observe-only: revocation is logged, not enforced');
});

test('a revoked agent with enforcement on is blocked; the handler does not run', async () => {
  const { path } = tempFile('agent-revoked\n');
  const { arken, records } = harness({ denyList: path, enforce: ['agent-revoked'] });
  const { handler, calls } = spyHandler();
  const out = await arken.wrap('search', handler)({}, extraFor('agent-revoked'));
  assert.equal(calls.length, 0);
  assert.equal(out.isError, true);
  assert.match(out.content[0]?.text ?? '', /revoked/);
  assert.equal(records()[0].would_block, true);
});

test('deny list entries may be hashes copied from the logs', async () => {
  const { path } = tempFile(`${hashAgent('agent-x', 's')}\n`);
  const { arken, records } = harness({ denyList: path, secret: 's' });
  await arken.wrap('t', spyHandler().handler)({}, extraFor('agent-x'));
  assert.equal(records()[0].decision_inputs.revoked, true);
});

test('deny list is re-read at most once per 60 s', async () => {
  const { path } = tempFile('');
  const { arken, clock, records } = harness({ denyList: path });
  const tool = arken.wrap('t', spyHandler().handler);

  await tool({}, extraFor('agent-late'));
  appendFileSync(path, 'agent-late\n');
  utimesSync(path, new Date(), new Date(Date.now() + 5_000));

  clock.t += 59_999;
  await tool({}, extraFor('agent-late'));
  clock.t += 1;
  await tool({}, extraFor('agent-late'));

  assert.deepEqual(records().map((r) => r.decision_inputs.revoked), [false, false, true]);
});

test('a deny list that disappears keeps the last good list', async () => {
  const { path } = tempFile('agent-r\n');
  const { arken, clock, records, errors } = harness({ denyList: path });
  const tool = arken.wrap('t', spyHandler().handler);

  await tool({}, extraFor('agent-r'));
  rmSync(path);
  clock.t += 60_000;
  await tool({}, extraFor('agent-r'));

  assert.deepEqual(records().map((r) => r.decision_inputs.revoked), [true, true]);
  assert.equal(errors.length, 1);
});

test('un-revoking takes effect on the next refresh', async () => {
  const { path } = tempFile('agent-r\n');
  const { arken, clock, records } = harness({ denyList: path });
  const tool = arken.wrap('t', spyHandler().handler);

  await tool({}, extraFor('agent-r'));
  writeFileSync(path, '');
  clock.t += 60_000;
  await tool({}, extraFor('agent-r'));

  assert.deepEqual(records().map((r) => r.decision_inputs.revoked), [true, false]);
});
