import { performance } from 'node:perf_hooks';
import { DenyList } from './denylist.ts';
import { fromClientId, hashAgent, type ExtraLike, type Identify } from './identity.ts';
import { formatLine, stderrSink, type LogSink } from './log.ts';
import { RateLimiter, type RateLimit } from './ratelimit.ts';

export { fromApiKeyId, fromClaim, fromClientId, hashAgent } from './identity.ts';
export type { AuthInfoLike, ExtraLike, Identify } from './identity.ts';
export type { DecisionLine, LogSink } from './log.ts';
export type { RateLimit } from './ratelimit.ts';

export interface ArkenOptions {
  /** How to find the agent on a call. Default: `fromClientId()`. */
  identify?: Identify | undefined;
  /** HMAC key for agent hashes. Strongly recommended; without it IDs are plain SHA-256. */
  secret?: string | Buffer | undefined;
  /** Path to the revocation list. Re-checked at most once a minute. */
  denyList?: string | undefined;
  /** Default: 60 calls per 60 s per agent. */
  rateLimit?: RateLimit | undefined;
  /**
   * Agents whose would-block decisions are enforced, as raw IDs or hashes, or a predicate
   * on the hash. Default: none, so everything is observe-only.
   */
  enforce?: readonly string[] | ((agent: string) => boolean) | undefined;
  /** Receives one JSON line per call. Default: stderr. */
  log?: LogSink | undefined;
  /** Receives arken-core's own errors. The call always goes through regardless. */
  onError?: ((err: unknown) => void) | undefined;
  /** Clock in ms. For tests. */
  now?: (() => number) | undefined;
}

/** What an enforced, would-block call returns instead of running the handler. */
// A type alias, not an interface, so it is assignable to the SDK's CallToolResult.
export type BlockedResult = {
  content: { type: 'text'; text: string }[];
  isError: true;
};

export interface Arken {
  /**
   * Wrap an MCP tool handler. The wrapper takes the same arguments and resolves to the
   * handler's result, or to a `BlockedResult` when enforcement blocks the call.
   */
  wrap<A extends unknown[], R>(
    tool: string,
    handler: (...args: A) => R | Promise<R>,
  ): (...args: A) => Promise<Awaited<R> | BlockedResult>;
}

interface Decision {
  agent: string | null;
  revoked: boolean;
  count: number;
  wouldBlock: boolean;
  enforced: boolean;
}

const DEFAULT_RATE_LIMIT: RateLimit = { limit: 60, windowS: 60 };

// Never includes the error message: a custom `identify` could put a token in it.
function defaultOnError(err: unknown): void {
  const kind = err instanceof Error ? err.name : typeof err;
  process.stderr.write(`[arken-core] internal error (${kind}); call passed through\n`);
}

export function createArken(options: ArkenOptions = {}): Arken {
  const identify = options.identify ?? fromClientId();
  const rateLimit = options.rateLimit ?? DEFAULT_RATE_LIMIT;
  const sink = options.log ?? stderrSink;
  const now = options.now ?? Date.now;
  const userOnError = options.onError ?? defaultOnError;
  const onError = (err: unknown): void => {
    try {
      userOnError(err);
    } catch {
      // An error handler that throws must not break the call either.
    }
  };

  const hash = (id: string): string => hashAgent(id, options.secret);
  const limiter = new RateLimiter(rateLimit);
  const denyList = options.denyList === undefined ? null : new DenyList(options.denyList, hash, onError);

  const enforce = options.enforce;
  let isEnforced: (agent: string) => boolean;
  if (typeof enforce === 'function') {
    isEnforced = enforce;
  } else {
    const enforced = new Set<string>();
    for (const entry of enforce ?? []) enforced.add(entry).add(hash(entry));
    isEnforced = (agent) => enforced.has(agent);
  }

  function decide(extra: unknown): Decision {
    const id = typeof extra === 'object' && extra !== null ? identify(extra as ExtraLike) : undefined;
    if (id === undefined) return { agent: null, revoked: false, count: 0, wouldBlock: false, enforced: false };
    const agent = hash(id);
    const t = now();
    const revoked = denyList !== null && denyList.has(agent, t);
    const count = limiter.hit(agent, t);
    const wouldBlock = revoked || count > rateLimit.limit;
    return { agent, revoked, count, wouldBlock, enforced: wouldBlock && isEnforced(agent) };
  }

  function log(tool: string, d: Decision, durationMs: number): void {
    try {
      sink(formatLine({
        ts: new Date(now()).toISOString(),
        agent: d.agent,
        tool,
        decision_inputs: { revoked: d.revoked, count: d.count, limit: rateLimit.limit, window_s: rateLimit.windowS },
        would_block: d.wouldBlock,
        duration_ms: Math.round(durationMs * 100) / 100,
      }));
    } catch (err) {
      onError(err);
    }
  }

  function blocked(d: Decision): BlockedResult {
    const text = d.revoked
      ? 'This agent has been revoked by the server operator.'
      : `Rate limit exceeded: ${rateLimit.limit} calls per ${rateLimit.windowS} s.`;
    return { content: [{ type: 'text', text }], isError: true };
  }

  return {
    wrap<A extends unknown[], R>(tool: string, handler: (...args: A) => R | Promise<R>) {
      return async function (this: unknown, ...args: A): Promise<Awaited<R> | BlockedResult> {
        // MCP tool callbacks are (args, extra) or (extra): extra is always last.
        let decision: Decision;
        try {
          decision = decide(args[args.length - 1]);
        } catch (err) {
          onError(err);
          return await handler.apply(this, args);
        }

        if (decision.enforced) {
          log(tool, decision, 0);
          return blocked(decision);
        }

        const start = performance.now();
        try {
          return await handler.apply(this, args);
        } finally {
          log(tool, decision, performance.now() - start);
        }
      };
    },
  };
}
