# Example: MCP server with arken-core

A Streamable HTTP MCP server built with the official
[TypeScript MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk).
Its existing auth (two demo API keys) decides who gets in. arken-core reads the
identity that auth already set and gives each agent its own rate limit and kill switch.

Needs Node 22.6 or later, which runs the `.ts` files directly.

## Run it

From the repo root:

```bash
npm install
ARKEN_ENFORCE=agent-beta npm run example        # server on :3000, decision log on stderr
```

In a second terminal, call it as each agent (7 calls, limit is 5 per minute):

```bash
npm run example:client -- demo-key-alpha 7      # observe-only: all 7 succeed, calls 6-7 logged would_block
npm run example:client -- demo-key-beta 7       # enforced: calls 6-7 return BLOCKED
```

## Revoke an agent

Add its ID to [`revoked.txt`](./revoked.txt) (or paste the `agent` hash from a log line).
It takes effect within 60 seconds, without a restart:

```bash
echo agent-beta >> examples/mcp-server/revoked.txt
```

`agent-beta` is enforced, so its calls are now blocked. Revoke `agent-alpha` instead and
its calls keep working but are logged with `"revoked": true, "would_block": true`. That's
observe-only: you see what enforcement would do before you switch it on.

## What to copy

- [`server.ts`](./server.ts): `createArken({...})` once per process, `arken.wrap(name, handler)` per tool.
- Your auth only has to put a stable agent ID on `AuthInfo.clientId` (or a claim; see `fromClaim`).
- Set `ARKEN_SECRET` so agent hashes in your logs are keyed to your server.
