import { createHash, createHmac } from 'node:crypto';

/** The subset of the MCP SDK's `AuthInfo` that arken-core reads. */
export interface AuthInfoLike {
  clientId?: string;
  extra?: Record<string, unknown>;
}

/** The subset of the MCP SDK's `RequestHandlerExtra` that arken-core reads. */
export interface ExtraLike {
  authInfo?: AuthInfoLike;
}

/**
 * Returns the stable, raw agent ID for a call, or `undefined` if the call has none.
 * Must never return the bearer token itself: tokens rotate, so the ID would not be stable.
 */
export type Identify = (extra: ExtraLike) => string | undefined;

function nonEmpty(value: unknown): string | undefined {
  if (typeof value === 'number') value = String(value);
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Agent = the OAuth client ID your auth layer put on `authInfo.clientId`. */
export function fromClientId(): Identify {
  return (extra) => nonEmpty(extra.authInfo?.clientId);
}

/** Agent = a claim your auth layer copied onto `authInfo.extra` (e.g. `sub`, `azp`). */
export function fromClaim(name: string): Identify {
  return (extra) => nonEmpty(extra.authInfo?.extra?.[name]);
}

/** Agent = the API key's ID (not the key) stored on `authInfo.extra[field]`. */
export function fromApiKeyId(field = 'apiKeyId'): Identify {
  return fromClaim(field);
}

const HASH_PREFIX = 'arken-core:v1:';

/**
 * Hash a raw agent ID into the value that appears in logs and lists.
 * With a secret this is an HMAC, so low-entropy IDs can't be brute-forced from logs.
 */
export function hashAgent(id: string, secret?: string | Buffer): string {
  const digest = secret === undefined
    ? createHash('sha256').update(HASH_PREFIX + id)
    : createHmac('sha256', secret).update(id);
  return digest.digest('hex').slice(0, 32);
}
