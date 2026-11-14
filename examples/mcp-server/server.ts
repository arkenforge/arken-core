// An MCP server (official TypeScript SDK, Streamable HTTP) protected by arken-core.
//
// Your existing auth stays in charge of who gets in. arken-core only reads the identity
// that auth already established, and gives each agent its own limit and kill switch.
//
// Run from the repo root:  npm run example
import { createServer, type IncomingMessage } from 'node:http';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { z } from 'zod';
import { createArken, fromClientId } from '@arkenforge/core';

const PORT = Number(process.env.PORT ?? 3000);

// ── Your existing auth ───────────────────────────────────────────────────────
// Stand-in for whatever you already use (API keys, OAuth, a gateway). The only
// requirement is that it puts a stable agent ID on AuthInfo.clientId.
const API_KEYS = new Map([
  ['demo-key-alpha', 'agent-alpha'],
  ['demo-key-beta', 'agent-beta'],
]);

function authenticate(req: IncomingMessage): AuthInfo | undefined {
  const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  const clientId = token === undefined ? undefined : API_KEYS.get(token);
  return clientId === undefined ? undefined : { token: token!, clientId, scopes: [] };
}

// ── arken-core ───────────────────────────────────────────────────────────────
// One instance for the whole process, so counts and the deny list are shared.
const arken = createArken({
  identify: fromClientId(),
  secret: process.env.ARKEN_SECRET,
  denyList: fileURLToPath(new URL('./revoked.txt', import.meta.url)),
  rateLimit: { limit: 5, windowS: 60 },
  // Observe-only unless you list agents here, e.g. ARKEN_ENFORCE=agent-beta
  enforce: process.env.ARKEN_ENFORCE?.split(',').filter(Boolean),
});

function buildServer(): McpServer {
  const server = new McpServer({ name: 'arken-example', version: '1.0.0' });
  server.registerTool(
    'search_docs',
    { description: 'Search the docs', inputSchema: { query: z.string() } },
    arken.wrap('search_docs', async ({ query }) => ({
      content: [{ type: 'text', text: `3 results for "${query}"` }],
    })),
  );
  return server;
}

// ── HTTP ─────────────────────────────────────────────────────────────────────
async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

createServer(async (req, res) => {
  try {
    if (new URL(req.url ?? '/', 'http://localhost').pathname !== '/mcp') {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' }).end(); // stateless server: no GET/DELETE sessions
      return;
    }
    const auth = authenticate(req);
    if (auth === undefined) {
      res.writeHead(401, { 'WWW-Authenticate': 'Bearer' }).end();
      return;
    }

    // Stateless mode (no sessionIdGenerator): a fresh MCP server and transport per request.
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport();
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(Object.assign(req, { auth }), res, await readJson(req));
  } catch {
    if (!res.headersSent) res.writeHead(400).end();
  }
}).listen(PORT, () => {
  process.stderr.write(`MCP server on http://localhost:${PORT}/mcp (decision log on stderr)\n`);
});
