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
  readonly repoId?: string;
  readonly jobId: string;
  readonly leaseEpoch: number;
  readonly token: CachedToken | null;
  readonly error: string | null;
  readonly coolUntilMs: number;
  readonly minRemainingMs: number;
}

/** The server accepts at most 64 token requests per sync (apps/api/src/fleet/sync/sync-request.parser.ts). */
export const MAX_TOKEN_REQUESTS = 64;

const scopeOf = (jobId: string, repoId?: string): string => JSON.stringify([jobId, repoId]);
const keyOf = (jobId: string, leaseEpoch: number, repoId?: string): string =>
  `${jobId}:${leaseEpoch}${repoId === undefined ? '' : `:${repoId}`}`;

/**
 * Per (jobId, leaseEpoch, repoId?) git tokens, in memory only (design §3.1, D81): never journaled, logged or written to disk.
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

  want(jobId: string, leaseEpoch: number, repoId?: string): void {
    const key = keyOf(jobId, leaseEpoch, repoId);
    if (this.entries.has(key)) return;
    this.entries = new Map([...this.entries, [key, { jobId, leaseEpoch, ...(repoId === undefined ? {} : { repoId }), token: null, error: null, coolUntilMs: 0, minRemainingMs: 0 }]]);
    for (const listener of this.listeners) listener();
  }

  wanted(jobId: string, leaseEpoch: number, repoId?: string): boolean {
    return this.entries.has(keyOf(jobId, leaseEpoch, repoId));
  }

  /** Request a job-scoped token with at least the given remaining lifetime. */
  requireFresh(jobId: string, leaseEpoch: number, minRemainingMs: number): void {
    const key = keyOf(jobId, leaseEpoch);
    const current = this.entries.get(key) ?? {
      jobId, leaseEpoch, token: null, error: null, coolUntilMs: 0, minRemainingMs: 0,
    };
    this.entries = new Map([...this.entries, [key, { ...current, error: null, minRemainingMs }]]);
    for (const listener of this.listeners) listener();
  }

  /** Return the stored server error even if a live token still takes precedence in state(). */
  error(jobId: string, leaseEpoch: number, repoId?: string): string | null {
    return this.entries.get(keyOf(jobId, leaseEpoch, repoId))?.error ?? null;
  }

  drop(jobId: string, leaseEpoch: number, repoId?: string): void {
    const key = keyOf(jobId, leaseEpoch, repoId);
    if (this.entries.has(key)) this.entries = new Map([...this.entries].filter(([other]) => other !== key));
  }

  /** An expired token is never served; an error only shows when there is no live token (D82). */
  state(jobId: string, leaseEpoch: number, nowMs: number, repoId?: string): TokenState {
    const entry = this.entries.get(keyOf(jobId, leaseEpoch, repoId));
    if (entry?.token && Date.parse(entry.token.expiresAt) > nowMs) return { kind: 'token', token: entry.token };
    if (entry?.error) return { kind: 'error', reason: entry.error };
    return { kind: 'pending' };
  }

  /** D81: one request per (job, repoId), using its highest wanted epoch for a missing or nearly expired token, outside any cool-down. */
  requests(nowMs: number): TokenRequest[] {
    const highest = new Map<string, Entry>();
    for (const entry of this.entries.values()) {
      const seen = highest.get(scopeOf(entry.jobId, entry.repoId));
      if (!seen || entry.leaseEpoch > seen.leaseEpoch) highest.set(scopeOf(entry.jobId, entry.repoId), entry);
    }
    return [...highest.values()]
      .filter((entry) => entry.coolUntilMs <= nowMs && (this.remaining(entry.token?.expiresAt, nowMs) <= this.timing.refreshMarginMs || this.remaining(entry.token?.expiresAt, nowMs) < entry.minRemainingMs))
      .sort((a, b) => Number(a.repoId !== undefined) - Number(b.repoId !== undefined))
      .slice(0, MAX_TOKEN_REQUESTS)
      .map((entry) => ({
        jobId: entry.jobId,
        leaseEpoch: entry.leaseEpoch,
        ...(entry.repoId === undefined ? {} : { repoId: entry.repoId }),
        ...(entry.repoId === undefined && entry.minRemainingMs > 0 && this.remaining(entry.token?.expiresAt, nowMs) < entry.minRemainingMs ? { fresh: true as const } : {}),
      }));
  }

  /** A GitToken names its job and optional repository: it belongs to the epoch this sync asked for (D81). */
  apply(requested: readonly TokenRequest[], tokens: readonly GitToken[], errors: readonly GitTokenError[], nowMs: number): void {
    const epochOf = new Map(requested.map((r) => [scopeOf(r.jobId, r.repoId), r.leaseEpoch] as const));
    const next = new Map(this.entries);
    const cool = nowMs + this.timing.cooldownMs;
    for (const token of tokens) {
      const epoch = epochOf.get(scopeOf(token.jobId, token.repoId));
      const entry = epoch === undefined ? undefined : next.get(keyOf(token.jobId, epoch, token.repoId));
      if (!entry) continue;
      const cached: CachedToken = { token: token.token, username: token.username, expiresAt: token.expiresAt };
      const remaining = this.remaining(token.expiresAt, nowMs);
      const minimumMet = remaining >= entry.minRemainingMs;
      // A token still below the requested minimum, or already inside the normal refresh margin,
      // would otherwise be requested again at once: cool down instead (D81).
      next.set(keyOf(entry.jobId, entry.leaseEpoch, entry.repoId), {
        ...entry,
        token: cached,
        error: null,
        minRemainingMs: minimumMet ? 0 : entry.minRemainingMs,
        coolUntilMs: minimumMet && this.fresh(token.expiresAt, nowMs) ? 0 : cool,
      });
    }
    for (const error of errors) {
      const epoch = epochOf.get(scopeOf(error.jobId, error.repoId));
      const entry = epoch === undefined ? undefined : next.get(keyOf(error.jobId, epoch, error.repoId));
      if (entry) next.set(keyOf(entry.jobId, entry.leaseEpoch, entry.repoId), { ...entry, error: error.reason, coolUntilMs: cool });
    }
    this.entries = next;
  }

  private remaining(expiresAt: string | undefined, nowMs: number): number {
    if (expiresAt === undefined) return Number.NEGATIVE_INFINITY;
    const at = Date.parse(expiresAt);
    return Number.isNaN(at) ? Number.NEGATIVE_INFINITY : at - nowMs;
  }

  private fresh(expiresAt: string, nowMs: number): boolean {
    return this.remaining(expiresAt, nowMs) > this.timing.refreshMarginMs;
  }
}
