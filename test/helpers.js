// @ts-check
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createArken } from '@arkenforge/core';

/**
 * The `extra` an MCP SDK handler receives, with auth from the server's own layer.
 * @param {string} clientId
 * @param {string} [token]
 */
export function extraFor(clientId, token = `token-for-${clientId}`) {
  return { authInfo: { clientId, token, scopes: [], extra: { sub: `sub-${clientId}` } } };
}

/** createArken with a fake clock and captured log lines. */
export function harness(options = {}) {
  const clock = { t: Date.UTC(2026, 10, 14) };
  /** @type {string[]} */
  const lines = [];
  /** @type {unknown[]} */
  const errors = [];
  const arken = createArken({
    now: () => clock.t,
    log: (line) => lines.push(line),
    onError: (err) => errors.push(err),
    ...options,
  });
  return { arken, clock, lines, errors, records: () => lines.map((l) => JSON.parse(l)) };
}

/**
 * A handler that records every call.
 * @param {{ content: { type: 'text', text: string }[], isError?: boolean }} [result]
 */
export function spyHandler(result = { content: [{ type: 'text', text: 'ok' }] }) {
  /** @type {unknown[][]} */
  const calls = [];
  const handler = async (/** @type {unknown[]} */ ...args) => {
    calls.push(args);
    return result;
  };
  return { handler, calls, result };
}

export function tempFile(contents = '') {
  const dir = mkdtempSync(join(tmpdir(), 'arken-core-test-'));
  const path = join(dir, 'revoked.txt');
  writeFileSync(path, contents);
  return { dir, path };
}
