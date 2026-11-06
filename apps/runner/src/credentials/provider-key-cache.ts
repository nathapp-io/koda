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

/** What one request is answered with: its own grant, or the reason koda has none for it. */
export type ProviderKeyAnswer =
  | { readonly kind: 'grant'; readonly grant: CachedProviderKey }
  | { readonly kind: 'denied'; readonly reason: 'none' | 'revoked' };

/**
 * US-008 D-1: one request's answer, shared by every lookup waiting on it. The value lives in the promise the waiter
 * holds, so no later request (however many follow) can replace it and the cache keeps nothing once it is answered.
 */
export interface ProviderKeyWait {
  /** The request generation this wait is answered by. */
  readonly generation: number;
  readonly answered: Promise<ProviderKeyAnswer>;
}

interface Waiter extends ProviderKeyWait {
  readonly settle: (answer: ProviderKeyAnswer) => void;
}

interface Entry {
  readonly jobId: string;
  readonly leaseEpoch: number;
  readonly providerId: string;
  /** The last granted key of this scope: what a lookup that asks now is served while its lease has margin left. */
  readonly grant: CachedProviderKey | null;
  /** The last denial, for a plain reader deciding whether to revalidate. */
  readonly denial: 'none' | 'revoked' | null;
  /** A grant was served for this (job, epoch, provider): a later denial is a revocation, never a decline. */
  readonly served: boolean;
  /** A request for this entry is queued and not yet answered. */
  readonly wanted: boolean;
  /** The request generation this entry is waiting for (or last waited for): each `want` that queues asks afresh. */
  readonly generation: number;
  /** The generation the last sync carried, so its answer binds to that request and never to a newer want. */
  readonly inflight: number;
  /** The queued request's waiters: at most one generation is ever queued, so they share one promise. */
  readonly waiter: Waiter | null;
}

const keyOf = (jobId: string, leaseEpoch: number, providerId: string): string => JSON.stringify([jobId, leaseEpoch, providerId]);
/** A grant names only its job and provider (responses carry no lease epoch): the request binds it to one. */
const scopeOf = (jobId: string, providerId: string): string => JSON.stringify([jobId, providerId]);

function newWaiter(generation: number): Waiter {
  let settle: (answer: ProviderKeyAnswer) => void = () => undefined;
  const answered = new Promise<ProviderKeyAnswer>((resolve) => { settle = resolve; });
  return { generation, answered, settle };
}

/** Answer the waiters of `generation` (and only them): a later request's answer never reaches an earlier waiter. */
function settleWaiter(entry: Entry, generation: number, answer: ProviderKeyAnswer): Waiter | null {
  if (entry.waiter?.generation !== generation) return entry.waiter;
  entry.waiter.settle(answer);
  return null;
}

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
   * Queue a request for one provider and return the wait for its answer. A no-op while one is already queued (every
   * lookup waiting on it shares that one promise). A waiter that asks again later gets a new generation, and the
   * earlier wait keeps the answer to the earlier request — later revalidation cannot erase it.
   */
  want(jobId: string, leaseEpoch: number, providerId: string): ProviderKeyWait {
    const key = keyOf(jobId, leaseEpoch, providerId);
    const current = this.entries.get(key);
    if (current?.wanted) {
      const waiter = current.waiter ?? newWaiter(current.generation);
      if (waiter !== current.waiter) this.entries = new Map([...this.entries, [key, { ...current, waiter }]]);
      return waiter;
    }
    const generation = (current?.generation ?? 0) + 1;
    const waiter = newWaiter(generation);
    const entry: Entry = current
      ? { ...current, wanted: true, generation, waiter }
      : { jobId, leaseEpoch, providerId, grant: null, denial: null, served: false, wanted: true, generation, inflight: 0, waiter };
    this.entries = new Map([...this.entries, [key, entry]]);
    for (const listener of this.listeners) listener();
    return waiter;
  }

  /**
   * A plain read, for a lookup deciding whether it has to ask at all: the latest live grant, else the last denial of a
   * request that is not queued any more, else pending. A queued lookup reads its own answer from its wait instead.
   */
  state(jobId: string, leaseEpoch: number, providerId: string, nowMs: number): ProviderKeyState {
    const entry = this.entries.get(keyOf(jobId, leaseEpoch, providerId));
    if (!entry) return { kind: 'pending' };
    if (entry.grant && entry.grant.expiresAtMs - nowMs > this.timing.refreshMarginMs) {
      return { kind: 'grant', grant: entry.grant };
    }
    if (entry.denial && !entry.wanted) return { kind: 'denied', reason: entry.denial };
    return { kind: 'pending' };
  }

  /** A grant must have more than this left before a lookup hands it out (inside it the key is renewed). */
  get refreshMarginMs(): number {
    return this.timing.refreshMarginMs;
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
   * (responses do not say); one for something we did not ask, or dropped meanwhile, is ignored. The answer settles the
   * wait of the generation that carried it — and only that one: a later request's answer never becomes an earlier
   * lookup's result (US-008 D-1). The newest grant and denial are also kept for a plain read.
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
      const granted = { key: grant.key, expiresAtMs, account: grant.account };
      const waiter = settleWaiter(entry, this.answeredGeneration(entry), { kind: 'grant', grant: granted });
      next.set(keyOf(entry.jobId, entry.leaseEpoch, entry.providerId), {
        ...entry, grant: granted, denial: null, wanted: waiter !== null, inflight: 0, waiter,
      });
    }
    for (const error of errors) {
      const entry = this.entryFor(next, epochOf, error.jobId, error.providerId);
      if (!entry) continue;
      const reason = entry.served ? 'revoked' : 'none';
      const waiter = settleWaiter(entry, this.answeredGeneration(entry), { kind: 'denied', reason });
      next.set(keyOf(entry.jobId, entry.leaseEpoch, entry.providerId), {
        ...entry, denial: reason, wanted: waiter !== null, inflight: 0, waiter,
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
