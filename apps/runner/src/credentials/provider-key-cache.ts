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

/**
 * How many settled answers one (job, epoch, provider) keeps. A suspended lookup reads the answer of the request it
 * asked at, so the answers have to outlive later ones; keeping the recent window bounds that memory. Evicting one can
 * only make a lookup too old to have waited this long ask again — never hand it a later request's answer.
 */
export const MAX_PROVIDER_KEY_COMPLETIONS = 64;

/** One settled answer, kept per request generation until the window overflows. */
type Completion =
  | { readonly kind: 'grant'; readonly grant: CachedProviderKey }
  | { readonly kind: 'denied'; readonly reason: 'none' | 'revoked' };

interface Entry {
  readonly jobId: string;
  readonly leaseEpoch: number;
  readonly providerId: string;
  /** The last granted key of this scope: what a lookup that asks now is served while its lease has margin left. */
  readonly grant: CachedProviderKey | null;
  /** The last denial, for the readers that ask without a generation (a plain lookup deciding whether to revalidate). */
  readonly answer: { readonly reason: 'none' | 'revoked'; readonly generation: number } | null;
  /** A grant was served for this (job, epoch, provider): a later denial is a revocation, never a decline. */
  readonly served: boolean;
  /** A request for this entry is queued and not yet answered. */
  readonly wanted: boolean;
  /** The request generation this entry is waiting for (or last waited for): each `want` that queues asks afresh. */
  readonly generation: number;
  /** The generation the last sync carried, so its answer binds to that request and never to a newer want. */
  readonly inflight: number;
  /**
   * Every recent request's settled answer, by generation (US-008 D-1): a lookup that asked at generation G reads G's
   * answer even after a later lookup asked again and was answered — a grant for the later one never becomes the
   * earlier one's result.
   */
  readonly completions: ReadonlyMap<number, Completion>;
}

const keyOf = (jobId: string, leaseEpoch: number, providerId: string): string => JSON.stringify([jobId, leaseEpoch, providerId]);
/** A grant names only its job and provider (responses carry no lease epoch): the request binds it to one. */
const scopeOf = (jobId: string, providerId: string): string => JSON.stringify([jobId, providerId]);

/** Record one generation's answer, keeping only the most recent `MAX_PROVIDER_KEY_COMPLETIONS` of them. */
function withCompletion(completions: ReadonlyMap<number, Completion>, generation: number, completion: Completion): ReadonlyMap<number, Completion> {
  const next = new Map(completions);
  next.set(generation, completion);
  if (next.size <= MAX_PROVIDER_KEY_COMPLETIONS) return next;
  return new Map([...next.keys()].sort((a, b) => b - a).slice(0, MAX_PROVIDER_KEY_COMPLETIONS).map((gen) => [gen, next.get(gen) as Completion] as const));
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
   * Queue a request for one provider and return the generation to wait at. A no-op while one is already queued (the
   * same generation comes back). Every earlier answer is kept, not erased: a lookup waiting at its own generation still
   * reads it, while a newer one waits for its own.
   */
  want(jobId: string, leaseEpoch: number, providerId: string): number {
    const key = keyOf(jobId, leaseEpoch, providerId);
    const current = this.entries.get(key);
    if (current?.wanted) return current.generation;
    const generation = (current?.generation ?? 0) + 1;
    const entry: Entry = current
      ? { ...current, wanted: true, generation }
      : { jobId, leaseEpoch, providerId, grant: null, answer: null, served: false, wanted: true, generation, inflight: 0, completions: new Map() };
    this.entries = new Map([...this.entries, [key, entry]]);
    for (const listener of this.listeners) listener();
    return generation;
  }

  /**
   * A grant is served for the whole lease; inside the refresh margin the socket asks for a new key instead. With a
   * `generation` the lookup reads the answer its own request settled with and nothing else — a grant or denial another
   * request got is not its result (US-008 D-1) — so a missing or expired one means it asks again. Without a generation,
   * a plain reader sees the latest live grant, else the last denial of a request that is not queued any more.
   */
  state(jobId: string, leaseEpoch: number, providerId: string, nowMs: number, generation?: number): ProviderKeyState {
    const entry = this.entries.get(keyOf(jobId, leaseEpoch, providerId));
    if (!entry) return { kind: 'pending' };
    if (generation !== undefined) {
      const completion = entry.completions.get(generation);
      if (completion?.kind === 'denied') return { kind: 'denied', reason: completion.reason };
      // An expired grant is not an answer: its lookup has to ask again for a lease it can still use.
      if (completion?.kind === 'grant' && completion.grant.expiresAtMs - nowMs > this.timing.refreshMarginMs) {
        return { kind: 'grant', grant: completion.grant };
      }
      return { kind: 'pending' };
    }
    if (entry.grant && entry.grant.expiresAtMs - nowMs > this.timing.refreshMarginMs) {
      return { kind: 'grant', grant: entry.grant };
    }
    if (entry.answer && !entry.wanted) return { kind: 'denied', reason: entry.answer.reason };
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
   * (responses do not say); one for something we did not ask, or dropped meanwhile, is ignored. Each answer is recorded
   * as the settled completion of the generation that carried it, so the lookup that asked then reads it whatever a
   * later lookup asks afterwards (US-008 D-1); the newest grant and denial are also kept for plain readers.
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
      const settled = this.answeredGeneration(entry);
      const granted = { key: grant.key, expiresAtMs, account: grant.account };
      next.set(keyOf(entry.jobId, entry.leaseEpoch, entry.providerId), {
        ...entry, grant: granted, answer: null, wanted: false, inflight: 0,
        completions: withCompletion(entry.completions, settled, { kind: 'grant', grant: granted }),
      });
    }
    for (const error of errors) {
      const entry = this.entryFor(next, epochOf, error.jobId, error.providerId);
      if (!entry) continue;
      const settled = this.answeredGeneration(entry);
      const reason = entry.served ? 'revoked' : 'none';
      next.set(keyOf(entry.jobId, entry.leaseEpoch, entry.providerId), {
        ...entry, answer: { reason, generation: settled }, wanted: false, inflight: 0,
        completions: withCompletion(entry.completions, settled, { kind: 'denied', reason }),
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
