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
  /**
   * The server's answer to one request. `generation` is the request it answered, so a lookup waiting at an older
   * generation still reads its own answer after a later lookup has asked again (US-008 D-1).
   */
  readonly answer: { readonly reason: 'none' | 'revoked'; readonly generation: number } | null;
  /** A grant was served for this (job, epoch, provider): a later denial is a revocation, never a decline. */
  readonly served: boolean;
  /** A request for this entry is queued and not yet answered. */
  readonly wanted: boolean;
  /** The request generation this entry is waiting for (or last waited for): each `want` that queues asks afresh. */
  readonly generation: number;
  /** The generation the last sync carried, so its answer binds to that request and never to a newer want. */
  readonly inflight: number;
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

  /**
   * Queue a request for one provider and return the generation to wait at. A no-op while one is already queued (the
   * same generation comes back). The earlier answer is kept, not erased: a lookup waiting at that generation still
   * reads it, while a newer one waits for its own.
   */
  want(jobId: string, leaseEpoch: number, providerId: string): number {
    const key = keyOf(jobId, leaseEpoch, providerId);
    const current = this.entries.get(key);
    if (current?.wanted) return current.generation;
    const generation = (current?.generation ?? 0) + 1;
    const entry: Entry = current
      ? { ...current, wanted: true, generation }
      : { jobId, leaseEpoch, providerId, grant: null, answer: null, served: false, wanted: true, generation, inflight: 0 };
    this.entries = new Map([...this.entries, [key, entry]]);
    for (const listener of this.listeners) listener();
    return generation;
  }

  /**
   * A grant is served for the whole lease; inside the refresh margin the socket asks for a new key instead. A denial
   * is only visible to a waiter at or below the generation its request answered (`generation` omitted: to any reader
   * that is not waiting, which is what a plain lookup asks); a newer waiter waits for its own answer.
   */
  state(jobId: string, leaseEpoch: number, providerId: string, nowMs: number, generation?: number): ProviderKeyState {
    const entry = this.entries.get(keyOf(jobId, leaseEpoch, providerId));
    if (entry?.grant && entry.grant.expiresAtMs - nowMs > this.timing.refreshMarginMs) {
      return { kind: 'grant', grant: entry.grant };
    }
    const answer = entry?.answer ?? null;
    if (entry && answer && (generation === undefined ? !entry.wanted : answer.generation >= generation)) {
      return { kind: 'denied', reason: answer.reason };
    }
    return { kind: 'pending' };
  }

  /** Record a successful broker reply, not sync receipt or a read-only cache lookup. */
  markServed(jobId: string, leaseEpoch: number, providerId: string): void {
    const key = keyOf(jobId, leaseEpoch, providerId);
    const entry = this.entries.get(key);
    if (entry?.grant && !entry.served) this.entries = new Map([...this.entries, [key, { ...entry, served: true }]]);
  }

  /** Drop everything this job epoch holds: its grants, its served set and any queued request (releaseProviderKeys). */
  drop(jobId: string, leaseEpoch: number): void {
    this.entries = new Map([...this.entries].filter(([, entry]) => entry.jobId !== jobId || entry.leaseEpoch !== leaseEpoch));
  }

  /**
   * The queued requests, one per (job, provider) — the highest epoch asking — capped at the server's limit. Each one is
   * marked in flight at its generation, so the answer the server sends back is tagged with the request that carried it
   * and never with a later one.
   */
  requests(): ProviderKeyRequest[] {
    const highest = new Map<string, Entry>();
    for (const entry of this.entries.values()) {
      if (!entry.wanted) continue;
      const seen = highest.get(scopeOf(entry.jobId, entry.providerId));
      if (!seen || entry.leaseEpoch > seen.leaseEpoch) highest.set(scopeOf(entry.jobId, entry.providerId), entry);
    }
    const chosen = [...highest.values()].slice(0, MAX_PROVIDER_KEY_REQUESTS);
    if (chosen.length === 0) return [];
    const next = new Map(this.entries);
    for (const entry of chosen) next.set(keyOf(entry.jobId, entry.leaseEpoch, entry.providerId), { ...entry, inflight: entry.generation });
    this.entries = next;
    return chosen.map((entry) => ({ jobId: entry.jobId, leaseEpoch: entry.leaseEpoch, providerId: entry.providerId }));
  }

  /**
   * The server's answer to this request's provider requests. A grant belongs to the epoch whose request carried it
   * (responses do not say); one for something we did not ask, or dropped meanwhile, is ignored. The answer is tagged
   * with the generation of the request that carried it, so a lookup that asked again after this answer was applied
   * waits for its own and never reads this one (a lookup that asked while this request was still out joined it).
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
      // A grant serves every waiter of this scope, whatever request carried it: only a denial has to stay bound
      // to the request it answered.
      next.set(keyOf(entry.jobId, entry.leaseEpoch, entry.providerId), {
        ...entry, grant: { key: grant.key, expiresAtMs, account: grant.account }, answer: null, wanted: false, inflight: 0,
      });
    }
    for (const error of errors) {
      const entry = this.entryFor(next, epochOf, error.jobId, error.providerId);
      if (!entry) continue;
      const answered = this.answeredGeneration(entry);
      next.set(keyOf(entry.jobId, entry.leaseEpoch, entry.providerId), {
        ...entry, answer: { reason: entry.served ? 'revoked' : 'none', generation: answered }, wanted: false, inflight: 0,
      });
    }
    this.entries = next;
  }

  /** The request an answer belongs to: the one this sync carried, else the entry's own (a request object a spec built). */
  private answeredGeneration(entry: Entry): number {
    return entry.inflight > 0 ? entry.inflight : entry.generation;
  }

  private entryFor(entries: ReadonlyMap<string, Entry>, epochOf: ReadonlyMap<string, number>, jobId: string, providerId: string): Entry | null {
    const epoch = epochOf.get(scopeOf(jobId, providerId));
    return epoch === undefined ? null : entries.get(keyOf(jobId, epoch, providerId)) ?? null;
  }
}
