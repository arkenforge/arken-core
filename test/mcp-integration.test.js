// @ts-check
// End to end through the official MCP SDK: a real McpServer and Client over the
// in-memory transport, with authInfo attached the way the HTTP auth middleware does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createArken } from '@arkenforge/core';
import { tempFile } from './helpers.js';

/**
 * @param {import('@arkenforge/core').Arken} arken
 * @param {string} clientId
 */
async function connect(arken, clientId) {
  const server = new McpServer({ name: 'test-server', version: '1.0.0' });
  let ran = 0;
  server.registerTool('ping', { description: 'Replies pong' }, arken.wrap('ping', async () => {
    ran += 1;
    return { content: [{ type: 'text', text: 'pong' }] };
  }));

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const send = clientTransport.send.bind(clientTransport);
  const authInfo = { clientId, token: `secret-token-${clientId}`, scopes: [] };
  clientTransport.send = (message, options) => send(message, { ...options, authInfo });

  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, ran: () => ran, close: () => Promise.all([client.close(), server.close()]) };
}

test('observe-only through the SDK: revoked agent is logged, both agents get answers', async () => {
  const { path } = tempFile('agent-revoked\n');
  /** @type {string[]} */
  const lines = [];
  const arken = createArken({ denyList: path, log: (l) => lines.push(l) });

  for (const id of ['agent-revoked', 'agent-sibling']) {
    const c = await connect(arken, id);
    const res = await c.client.callTool({ name: 'ping', arguments: {} });
    assert.deepEqual(res.content, [{ type: 'text', text: 'pong' }]);
    assert.equal(c.ran(), 1);
    await c.close();
  }

  const [revoked, sibling] = lines.map((l) => JSON.parse(l));
  assert.equal(revoked.would_block, true);
  assert.equal(sibling.would_block, false);
  assert.doesNotMatch(lines.join('\n'), /secret-token|agent-revoked|agent-sibling/);
});

test('enforced through the SDK: the client receives an isError result', async () => {
  const { path } = tempFile('agent-revoked\n');
  const arken = createArken({ denyList: path, enforce: ['agent-revoked'], log: () => {} });
  const c = await connect(arken, 'agent-revoked');
  const res = await c.client.callTool({ name: 'ping', arguments: {} });
  assert.equal(res.isError, true);
  assert.equal(c.ran(), 0);
  await c.close();
});
