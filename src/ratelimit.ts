export interface RateLimit {
  /** Calls allowed per agent per window. */
  limit: number;
  /** Window length in seconds. */
  windowS: number;
}

interface Window {
  start: number;
  count: number;
}

/**
 * Per-agent fixed-window counter, in memory. Bounded: once more than `maxAgents`
 * are tracked, expired windows are dropped, then the oldest.
 */
export class RateLimiter {
  readonly #windowMs: number;
  readonly #maxAgents: number;
  readonly #windows = new Map<string, Window>();

  constructor({ windowS }: RateLimit, maxAgents = 10_000) {
    this.#windowMs = windowS * 1000;
    this.#maxAgents = maxAgents;
  }

  /** Record one call and return the agent's count in the current window, including it. */
  hit(agent: string, nowMs: number): number {
    let window = this.#windows.get(agent);
    if (window === undefined || nowMs - window.start >= this.#windowMs) {
      this.#windows.delete(agent);
      window = { start: nowMs, count: 0 };
      this.#windows.set(agent, window);
      if (this.#windows.size > this.#maxAgents) this.#sweep(nowMs);
    }
    window.count += 1;
    return window.count;
  }

  #sweep(nowMs: number): void {
    for (const [agent, window] of this.#windows) {
      if (nowMs - window.start >= this.#windowMs) this.#windows.delete(agent);
    }
    for (const agent of this.#windows.keys()) {
      if (this.#windows.size <= this.#maxAgents) break;
      this.#windows.delete(agent);
    }
  }
}
