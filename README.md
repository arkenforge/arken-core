<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/arken-stone-dark.svg">
    <img src=".github/assets/arken-stone-light.svg" alt="The Arken stone" width="120">
  </picture>
</p>

<h1 align="center">arken-core</h1>

<p align="center">
  Per-agent limits and a kill switch for MCP servers, using the auth you already have.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@arkenforge/core"><img src="https://img.shields.io/npm/v/@arkenforge/core.svg" alt="npm"></a>
  <a href="https://github.com/arkenforge/arken-core/actions/workflows/ci.yml"><img src="https://github.com/arkenforge/arken-core/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg" alt="License: Apache 2.0"></a>
</p>

---

When several agents call your MCP server under one account or one API key, per-user and
per-IP controls can't tell them apart. arken-core wraps your tool handlers and gives
**each agent** its own:

- **Log line**: one JSON line per call, naming the agent (hashed), the tool and the decision inputs.
- **Rate limit**: per agent, not per user or IP, so one loop can't drain everyone's quota.
- **Kill switch**: put one agent on a deny list and it's cut off within 60 seconds. Nobody else is signed out.

It is **observe-only by default**: it logs what it *would* block and blocks nothing until you
switch enforcement on for a specific agent. If arken-core itself fails, the call goes through untouched.

It runs in your process, on your auth. It adds no runtime dependencies, sends nothing anywhere
and holds no credentials.

## Install

```bash
npm install @arkenforge/core
```

Node 20.19 or later. TypeScript types included. Works with the
[official TypeScript MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk) and
anything else that calls tool handlers as `(args, extra)` or `(extra)`.

## Quick start

```ts
import { createArken, fromClientId } from '@arkenforge/core';

const arken = createArken({
  identify: fromClientId(),             // who the agent is, from your existing auth
  secret: process.env.ARKEN_SECRET,     // keys the agent hashes in your logs
  denyList: './revoked.txt',            // your kill switch
  rateLimit: { limit: 60, windowS: 60 },
});

server.registerTool(
  'search_docs',
  { description: 'Search the docs', inputSchema: { query: z.string() } },
  arken.wrap('search_docs', async ({ query }) => {
    // your handler, unchanged
  }),
);
```

Create one `arken` per process and wrap each tool. A runnable server and client are in
[`examples/mcp-server`](examples/mcp-server).

## How it identifies agents

arken-core never authenticates anyone. Your auth already did that and put the result on
`extra.authInfo`. arken-core reads a **stable** ID from it:

| Helper | Reads | Use when |
|---|---|---|
| `fromClientId()` *(default)* | `authInfo.clientId` | OAuth client IDs, or your verifier sets the API key's ID here |
| `fromClaim('sub')` | `authInfo.extra.sub` | your verifier copies token claims onto `authInfo.extra` |
| `fromApiKeyId('keyId')` | `authInfo.extra.keyId` | API keys with a separate key ID |
| `(extra) => string \| undefined` | anything | none of the above |

The ID is hashed (HMAC-SHA256 when `secret` is set) and the hash is what you see in logs. Because
it comes from the client or key ID and not the token, it stays the same when tokens are reissued,
so a revoked agent can't come back as a stranger with a fresh token.

Calls with no identity are logged with `"agent": null` and are never limited or blocked.

## The decision log

One line per call, on **stderr** by default (stdout is the protocol channel on stdio servers):

```json
{"ts":"2026-11-14T21:14:34.895Z","agent":"66bca028f6bdeb663cfca3c84c97ad6a","tool":"search_docs","decision_inputs":{"revoked":false,"count":6,"limit":5,"window_s":60},"would_block":true,"duration_ms":0.41}
```

| Field | Meaning |
|---|---|
| `ts` | ISO 8601 time of the call |
| `agent` | Hashed agent ID, or `null` if the call had none |
| `tool` | The name you passed to `wrap` |
| `decision_inputs.revoked` | The agent is on the deny list |
| `decision_inputs.count` | This agent's calls in the current window, including this one |
| `decision_inputs.limit`, `window_s` | The limit in force |
| `would_block` | `revoked`, or `count > limit` |
| `duration_ms` | Time spent in your handler |

**Never logged:** tool arguments, results, tokens, scopes, claims, raw agent IDs, the secret.
The line is built field by field, so nothing else can reach it. Send it elsewhere with
`log: (line) => myLogger.info(line)`.

## Observe, then enforce

1. **Wrap your handlers.** Everything is logged, nothing is blocked.
2. **Watch for a week.** Filter for `"would_block":true` to see who your limits would have hit.
3. **Enforce on one agent** when the data says you're ready:

```ts
createArken({ /* ... */ enforce: ['agent-7f3a'] });   // raw IDs or hashes from the log
createArken({ /* ... */ enforce: (agent) => true });  // or everyone
```

An enforced call that would block doesn't reach your handler. The client gets an MCP error result
(`isError: true`) saying it was revoked or rate limited. **Revocation follows the same rule**:
a revoked agent in observe-only mode is logged with `"would_block": true` and still runs.

## The kill switch

`denyList` is a plain text file, one agent per line, `#` for comments. An entry can be the raw ID
your auth uses or the `agent` hash copied from a log line:

```text
# revoked 2026-11-14: runaway loop, ticket #412
agent-7f3a
66bca028f6bdeb663cfca3c84c97ad6a
```

It is checked at most once a minute, during a call, so changes apply within 60 seconds with no
restart. If the file goes missing or can't be read, the last good list stays in force.

## Options

| Option | Default | |
|---|---|---|
| `identify` | `fromClientId()` | How to find the agent on a call |
| `secret` | none | HMAC key for agent hashes. Set it: without one, low-entropy IDs could be guessed from their hashes |
| `denyList` | none | Path to the revocation file |
| `rateLimit` | `{ limit: 60, windowS: 60 }` | Fixed window, per agent, shared across tools |
| `enforce` | none (observe-only) | Agents to enforce on: IDs, hashes, or a predicate on the hash |
| `log` | stderr | Receives each JSON line |
| `onError` | short note on stderr | Receives arken-core's own errors (the call goes through regardless) |

## Fails open

Everything arken-core does runs inside `try/catch`. If identifying the agent, reading the deny
list, counting or logging throws, your handler runs exactly once with its original arguments
and its result is returned as-is. Errors from your own handler propagate unchanged.
Removing arken-core means unwrapping your handlers.

## Limits of 1.0

- Counts are **in memory, per process**. Behind a load balancer each replica counts on its own.
- TypeScript / Node only.
- No write or payment rules, no per-agent spend caps yet.

## What changed and why

Until November 2026 this repository was a different project: a Rust library that verified
requests signed with self-issued `did:key` (secp256k1) identities, loaded into Node and Python
through native bindings.

We stopped because market research changed the brief. Operators only trust identities they
issue or choose themselves, so an agent-held key that no one vouches for doesn't help them. And
where agents do sign requests, the industry has settled on
[RFC 9421 HTTP Message Signatures](https://www.rfc-editor.org/rfc/rfc9421) with Ed25519, not a
bespoke scheme. What operators were missing wasn't a new identity. It was a way to tell apart and
control the agents behind the identities they already have. (For context on how public MCP
servers authenticate today, see our
[survey of 34K endpoints](https://github.com/arkenforge/mcp-auth-survey).)

So 1.0 drops its own crypto, its Rust core and its native binaries, and works on top of your auth.
The old packages (`@arkenforge/arken-auth`, `arken-auth`, `arken-client` and the PyPI packages)
are retired. Their code is preserved:

- [`legacy`](https://github.com/arkenforge/arken-core/tree/legacy) branch and
  [`v0-did-key`](https://github.com/arkenforge/arken-core/tree/v0-did-key) tag: the Rust core.
- [`v0-arken-auth`](https://github.com/arkenforge/arken-core/tree/v0-arken-auth) tag: the
  Express and FastAPI middleware and the JS and Python clients.

They are unmaintained and have known security issues. Don't deploy them.

## Security

See [SECURITY.md](SECURITY.md).

## License

[Apache 2.0](LICENSE) © ArkenForge
