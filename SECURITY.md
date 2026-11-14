# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| 1.x (`@arkenforge/core`) | Yes |
| 0.x and everything on the [`legacy`](https://github.com/arkenforge/arken-core/tree/legacy) branch or the `v0-*` tags, including the retired `@arkenforge/arken-auth`, `arken-auth` and `arken-client` packages | No. Known issues will not be fixed. Don't deploy them. |

## Scope

In scope:

- An enforced agent getting past its limit or revocation
- One agent's calls counted or revoked as another's, or an agent escaping revocation (for example by rotating tokens)
- Tool arguments, results, tokens, claims, raw agent IDs or the `secret` reaching a log line or error output
- arken-core changing, failing or repeating a call it should have passed through (the fail-open guarantee)
- A deny-list file being read in a way that silently drops revoked entries

Out of scope:

- Weaknesses in the auth layer you put in front of arken-core. It trusts the identity it's given.
- Per-process counting behind a load balancer (a documented limitation)
- Issues requiring access to the server's filesystem or process
- Vulnerabilities in dependencies not introduced by this project

## Reporting a vulnerability

Report privately through GitHub's advisory system:

**[Open a private security advisory](https://github.com/arkenforge/arken-core/security/advisories/new)**

Do not open a public issue for security vulnerabilities.

Include the affected version, steps to reproduce and the potential impact. You will receive a response within 72 hours.

## Hall of Finders

*Everyone who finds and responsibly discloses a verified security flaw is credited here.*

| Researcher | Finding | Date |
|---|---|---|
| — | — | — |
