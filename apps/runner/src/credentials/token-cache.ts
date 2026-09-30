// apps/runner/src/credentials/token-cache.ts
import type { GitToken, GitTokenError, TokenRequest } from '@nathapp/fleet-protocol';

export interface CachedToken {
  readonly token: string;
  readonly username: GitToken['username'];
  readonly expiresAt: string;
}

export type TokenState =
  | { readonly kind: 'token'; readonly token: CachedToken }
  | { readonly kind: 'error'; readonly reason: string }
  | { readonly kind: 'pending' };

export interface TokenCacheTiming {
  /** Design §3.1: ask again this long before `expiresAt` (the server reuses its token until 300 s before it). */
  readonly refreshMarginMs: number;
  /** D81: after a token that is already inside the margin, or an error, wait this long before asking for that job again. */
  readonly cooldownMs: number;
}

interface Entry {
  readonly jobId: string;
  readonly leaseEpoch: number;
  readonly token: CachedToken | null;
  readonly error: string | null;
  readonly coolUntilMs: number;
}

/** The server accepts at most 64 token requests per sync (apps/api/src/fleet/sync/sync-request.parser.ts). */
export const MAX_TOKEN_REQUESTS = 64;

const keyOf = (jobId: string, leaseEpoch: number): string => `${jobId}:${leaseEpoch}`;

/**
 * Per (jobId, leaseEpoch) git tokens, in memory only (design §3.1, D81): never journaled, logged or written to disk.
 * A restarted daemon starts empty and asks again for every job that still wants one.
 */
export class TokenCache {
  private entries: ReadonlyMap<string, Entry> = new Map();
  private listeners: ReadonlyArray<() => void> = [];

  constructor(private readonly timing: TokenCacheTiming) {}

  /** Called when a job starts wanting a token, so the sync loop can end an idle poll and ask at once. */
  onNeed(listener: () => void): () => void {
    this.listeners = [...this.listeners, listener];
    return () => { this.listeners = this.listeners.filter((other) => other !== listener); };
  }

  want(jobId: string, leaseEpoch: number): void {
    const key = keyOf(jobId, leaseEpoch);
    if (this.entries.has(key)) return;
    this.entries = new Map([...this.entries, [key, { jobId, leaseEpoch, token: null, error: null, coolUntilMs: 0 }]]);
    for (const listener of this.listeners) listener();
  }

  wanted(jobId: string, leaseEpoch: number): boolean {
    return this.entries.has(keyOf(jobId, leaseEpoch));
  }

  drop(jobId: string, leaseEpoch: number): void {
    const key = keyOf(jobId, leaseEpoch);
    if (this.entries.has(key)) this.entries = new Map([...this.entries].filter(([other]) => other !== key));
  }

  /** An expired token is never served; an error only shows when there is no live token (D82). */
  state(jobId: string, leaseEpoch: number, nowMs: number): TokenState {
    const entry = this.entries.get(keyOf(jobId, leaseEpoch));
    if (entry?.token && Date.parse(entry.token.expiresAt) > nowMs) return { kind: 'token', token: entry.token };
    if (entry?.error) return { kind: 'error', reason: entry.error };
    return { kind: 'pending' };
  }

  /** D81: one request per job (its highest wanted epoch) for a missing or nearly expired token, outside any cool-down. */
  requests(nowMs: number): TokenRequest[] {
    const highest = new Map<string, Entry>();
    for (const entry of this.entries.values()) {
      const seen = highest.get(entry.jobId);
      if (!seen || entry.leaseEpoch > seen.leaseEpoch) highest.set(entry.jobId, entry);
    }
    return [...highest.values()]
      .filter((entry) => entry.coolUntilMs <= nowMs && (entry.token === null || !this.fresh(entry.token.expiresAt, nowMs)))
      .slice(0, MAX_TOKEN_REQUESTS)
      .map((entry) => ({ jobId: entry.jobId, leaseEpoch: entry.leaseEpoch }));
  }

  /** A GitToken names only its job: it belongs to the epoch this sync asked for (D81). */
  apply(requested: readonly TokenRequest[], tokens: readonly GitToken[], errors: readonly GitTokenError[], nowMs: number): void {
    const epochOf = new Map(requested.map((r) => [r.jobId, r.leaseEpoch] as const));
    const next = new Map(this.entries);
    const cool = nowMs + this.timing.cooldownMs;
    for (const token of tokens) {
      const epoch = epochOf.get(token.jobId);
      const entry = epoch === undefined ? undefined : next.get(keyOf(token.jobId, epoch));
      if (!entry) continue;
      const cached: CachedToken = { token: token.token, username: token.username, expiresAt: token.expiresAt };
      // A token already inside the margin (a refresh that returned the same token, or clock skew) would be asked for
      // again at once: cool down instead (D81).
      next.set(keyOf(entry.jobId, entry.leaseEpoch), { ...entry, token: cached, error: null, coolUntilMs: this.fresh(token.expiresAt, nowMs) ? 0 : cool });
    }
    for (const error of errors) {
      const epoch = epochOf.get(error.jobId);
      const entry = epoch === undefined ? undefined : next.get(keyOf(error.jobId, epoch));
      if (entry) next.set(keyOf(entry.jobId, entry.leaseEpoch), { ...entry, error: error.reason, coolUntilMs: cool });
    }
    this.entries = next;
  }

  private fresh(expiresAt: string, nowMs: number): boolean {
    const at = Date.parse(expiresAt);
    return !Number.isNaN(at) && at - nowMs > this.timing.refreshMarginMs;
  }
}
