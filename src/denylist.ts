import { readFileSync, statSync } from 'node:fs';

export const DENY_LIST_REFRESH_MS = 60_000;

/**
 * A revocation list read from a local file: one agent per line, `#` starts a comment.
 * An entry may be a raw agent ID or its hash as printed in the logs.
 *
 * The file is checked lazily, during a call, at most once per minute. If it is missing
 * or unreadable, the last good list is kept.
 */
export class DenyList {
  readonly #path: string;
  readonly #hash: (id: string) => string;
  readonly #onError: (err: unknown) => void;
  #entries = new Set<string>();
  #checkedAt = -Infinity;
  #version = '';

  constructor(path: string, hash: (id: string) => string, onError: (err: unknown) => void) {
    this.#path = path;
    this.#hash = hash;
    this.#onError = onError;
  }

  has(agent: string, nowMs: number): boolean {
    if (nowMs - this.#checkedAt >= DENY_LIST_REFRESH_MS) {
      this.#checkedAt = nowMs;
      this.#reload();
    }
    return this.#entries.has(agent);
  }

  #reload(): void {
    try {
      const stat = statSync(this.#path);
      const version = `${stat.mtimeMs}:${stat.size}`;
      if (version === this.#version) return;
      const entries = new Set<string>();
      for (const raw of readFileSync(this.#path, 'utf8').split('\n')) {
        const entry = raw.replace(/#.*/, '').trim();
        if (entry === '') continue;
        entries.add(entry);
        entries.add(this.#hash(entry));
      }
      this.#entries = entries;
      this.#version = version;
    } catch (err) {
      this.#onError(err);
    }
  }
}
