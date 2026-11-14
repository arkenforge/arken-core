// Calls the example server as one agent, several times, using the official SDK client.
//
//   npm run example:client -- demo-key-alpha 7
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const [apiKey = 'demo-key-alpha', times = '1'] = process.argv.slice(2);
const url = new URL(process.env.MCP_URL ?? 'http://localhost:3000/mcp');

const client = new Client({ name: 'arken-example-client', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(url, {
  requestInit: { headers: { Authorization: `Bearer ${apiKey}` } },
}));

for (let i = 1; i <= Number(times); i++) {
  const result = await client.callTool({ name: 'search_docs', arguments: { query: 'rate limits' } });
  const text = (result.content as { type: string; text?: string }[])[0]?.text;
  console.log(`call ${i}: ${result.isError ? 'BLOCKED' : 'ok'} - ${text}`);
}
await client.close();
