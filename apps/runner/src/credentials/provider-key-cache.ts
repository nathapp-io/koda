// apps/runner/src/credentials/provider-key-cache.ts
import type { ProviderKeyError, ProviderKeyGrant, ProviderKeyRequest } from '@nathapp/fleet-protocol';

/** One handed-out provider key. `expiresAtMs` is epoch milliseconds: the wire carries ISO, the socket answers this. */
export interface CachedProviderKey {
  readonly key: string;
  readonly expiresAtMs: number;
  /** nax's account label for the key (`koda:<scope>:<name>`), so a rotation reads as a new key, not an overwrite. */
  readonly account: string;
}

export type ProviderKeyState =
  | { readonly kind: 'grant'; readonly grant: CachedProviderKey }
  /** `revoked` when this (job, epoch, provider) was served before: the job must not switch identity now. */
  | { readonly kind: 'denied'; readonly reason: 'none' | 'revoked' }
  | { readonly kind: 'pending' };

export interface ProviderKeyCacheTiming {
  /** US-008: a cached grant is served only while more than this is left before `expiresAt` (60 s). */
  readonly refreshMarginMs: number;
}

/** The server accepts at most 64 provider key requests per sync (apps/api/src/fleet/sync/sync-request.parser.ts). */
export const MAX_PROVIDER_KEY_REQUESTS = 64;

interface Entry {
  readonly jobId: string;
  readonly leaseEpoch: number;
  readonly providerId: string;
  readonly grant: CachedProviderKey | null;
  readonly denial: 'none' | 'revoked' | null;
  /** A grant was served for this (job, epoch, provider): a later denial is a revocation, never a decline. */
  readonly served: boolean;
  /** A request for this entry is queued and not yet answered. */
  readonly wanted: boolean;
}

const keyOf = (jobId: string, leaseEpoch: number, providerId: string): string => JSON.stringify([jobId, leaseEpoch, providerId]);
/** A grant names only its job and provider (responses carry no lease epoch): the request binds it to one. */
const scopeOf = (jobId: string, providerId: string): string => JSON.stringify([jobId, providerId]);

/**
 * Per (jobId, leaseEpoch, providerId) provider keys, in memory only (US-008): never journaled, logged or written to
 * disk. A restarted daemon starts empty and asks again for whatever a job's next model call needs.
 */
export class ProviderKeyCache {
  private entries: ReadonlyMap<string, Entry> = new Map();
  private listeners: ReadonlyArray<() => void> = [];

  constructor(private readonly timing: ProviderKeyCacheTiming) {}

  /** Called when a request is queued, so the sync loop can end an idle poll and ask at once. */
  onNeed(listener: () => void): () => void {
    this.listeners = [...this.listeners, listener];
    return () => { this.listeners = this.listeners.filter((other) => other !== listener); };
  }

  /** Queue a request for one provider; a no-op while one is already queued. Clears an earlier denial. */
  want(jobId: string, leaseEpoch: number, providerId: string): void {
    const key = keyOf(jobId, leaseEpoch, providerId);
    const current = this.entries.get(key);
    if (current?.wanted) return;
    const entry: Entry = current
      ? { ...current, denial: null, wanted: true }
      : { jobId, leaseEpoch, providerId, grant: null, denial: null, served: false, wanted: true };
    this.entries = new Map([...this.entries, [key, entry]]);
    for (const listener of this.listeners) listener();
  }

  /** A grant is served for the whole lease; inside the refresh margin the socket asks for a new key instead. */
  state(jobId: string, leaseEpoch: number, providerId: string, nowMs: number): ProviderKeyState {
    const entry = this.entries.get(keyOf(jobId, leaseEpoch, providerId));
    if (entry?.grant && entry.grant.expiresAtMs - nowMs > this.timing.refreshMarginMs) {
      return { kind: 'grant', grant: entry.grant };
    }
    if (entry?.denial) return { kind: 'denied', reason: entry.denial };
    return { kind: 'pending' };
  }

  /** Drop everything this job epoch holds: its grants, its served set and any queued request (releaseProviderKeys). */
  drop(jobId: string, leaseEpoch: number): void {
    this.entries = new Map([...this.entries].filter(([, entry]) => entry.jobId !== jobId || entry.leaseEpoch !== leaseEpoch));
  }

  /** The queued requests, one per (job, provider) — the highest epoch asking — capped at the server's limit. */
  requests(): ProviderKeyRequest[] {
    const highest = new Map<string, Entry>();
    for (const entry of this.entries.values()) {
      if (!entry.wanted) continue;
      const seen = highest.get(scopeOf(entry.jobId, entry.providerId));
      if (!seen || entry.leaseEpoch > seen.leaseEpoch) highest.set(scopeOf(entry.jobId, entry.providerId), entry);
    }
    return [...highest.values()]
      .slice(0, MAX_PROVIDER_KEY_REQUESTS)
      .map((entry) => ({ jobId: entry.jobId, leaseEpoch: entry.leaseEpoch, providerId: entry.providerId }));
  }

  /**
   * The server's answer to this request's provider requests. A grant belongs to the epoch whose request carried it
   * (responses do not say); one for something we did not ask, or dropped meanwhile, is ignored.
   */
  apply(requested: readonly ProviderKeyRequest[], grants: readonly ProviderKeyGrant[], errors: readonly ProviderKeyError[]): void {
    const epochOf = new Map<string, number>();
    for (const request of requested) {
      if (!epochOf.has(scopeOf(request.jobId, request.providerId))) epochOf.set(scopeOf(request.jobId, request.providerId), request.leaseEpoch);
    }
    const next = new Map(this.entries);
    for (const grant of grants) {
      const entry = this.entryFor(next, epochOf, grant.jobId, grant.providerId);
      if (!entry) continue;
      const expiresAtMs = Date.parse(grant.expiresAt);
      if (Number.isNaN(expiresAtMs)) continue;   // pending expiry is an error, never an invented grant
      next.set(keyOf(entry.jobId, entry.leaseEpoch, entry.providerId), {
        ...entry, grant: { key: grant.key, expiresAtMs, account: grant.account }, denial: null, served: true, wanted: false,
      });
    }
    for (const error of errors) {
      const entry = this.entryFor(next, epochOf, error.jobId, error.providerId);
      if (!entry) continue;
      next.set(keyOf(entry.jobId, entry.leaseEpoch, entry.providerId), {
        ...entry, denial: entry.served ? 'revoked' : 'none', wanted: false,
      });
    }
    this.entries = next;
  }

  private entryFor(entries: ReadonlyMap<string, Entry>, epochOf: ReadonlyMap<string, number>, jobId: string, providerId: string): Entry | null {
    const epoch = epochOf.get(scopeOf(jobId, providerId));
    return epoch === undefined ? null : entries.get(keyOf(jobId, epoch, providerId)) ?? null;
  }
}
