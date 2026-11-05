// apps/runner/src/credentials/broker.ts
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { JobRow } from '../journal/types';
import type { Sleep } from '../time';
import { CredentialServer, type CredentialReply, type ProviderReply } from './cred-server';
import { helperValue, writeShims } from './job-files';
import type { CachedProviderKey, ProviderKeyCache } from './provider-key-cache';
import { SocketDirError, ensureSocketDir, socketPathFor } from './socket-dir';
import type { TokenCache } from './token-cache';

export interface JobCredentials {
  /** The `credential.helper` value, or null when the clone URL needs no credentials (D83). */
  readonly helper: string | null;
  /** `<jobDir>/bin` with the gh and glab shims, or null (D83). */
  readonly binDir: string | null;
}

export type AcquireResult = { ok: true; credentials: JobCredentials } | { ok: false; reason: string; cancelled?: true };

export interface AcquireOptions {
  /** Wait for the job's first token (prepare, the PLAN push), or not (a readopted run, D90). */
  readonly wait: boolean;
  readonly isCancelled?: () => boolean;
}

/** What `HostExecutor` needs from the broker. */
export interface CredentialProvider {
  acquire(job: JobRow, options: AcquireOptions): Promise<AcquireResult>;
  release(job: JobRow): Promise<void>;
  /**
   * US-006: the live token the cache holds for this exact (jobId, leaseEpoch), or null for any other state (none yet,
   * expired, a token error). A REVIEW job needs it to write nax's forge token file.
   */
  currentToken?(job: JobRow): string | null;
  freshToken?(job: JobRow, minRemainingMs: number, isCancelled?: () => boolean): Promise<{ ok: true; token: string } | { ok: false; reason: string }>;
  /**
   * US-008: the path of this job epoch's provider-key socket, opened on the first call. Provider keys are needed for
   * every model call, so the socket outlives the git credential socket (released after checkout).
   */
  serveProviderKeys?(job: JobRow): Promise<string>;
  /** US-008: true when the job holds a provider key for `providerId` (the same lookup the socket answers with). */
  providerKeyGranted?(job: JobRow, providerId: string): Promise<boolean>;
  releaseProviderKeys?(job: JobRow): Promise<void>;
}

/** Read-only project repository credentials; no job-local command shims. */
export interface RepoCredentialProvider {
  acquireRepo(job: JobRow, repo: { repoId: string; cloneUrl: string }, options: AcquireOptions): Promise<AcquireResult>;
  releaseRepo(job: JobRow, repoId: string): Promise<void>;
}

export interface BrokerTiming {
  readonly waitMs: number;
  readonly serveWaitMs: number;
  readonly pollMs: number;
  /** US-008: how long a provider-key request waits for its grant; defaults to `PROVIDER_KEY_WAIT_MS` (55 s). */
  readonly providerKeyWaitMs?: number;
}

/** US-008: the spec's 55 s — a model call waits this long for a key before it hears `error`. */
export const PROVIDER_KEY_WAIT_MS = 55_000;

/** The socket-name segment that keeps the provider-key socket apart from the git and repository ones (D78). */
export const PROVIDER_KEY_SOCKET_SCOPE = 'provider-keys';

export interface BrokerDeps {
  readonly tokens: TokenCache;
  readonly socketDir: string;
  readonly runnerId: string;
  readonly selfCommand: readonly string[];
  /** Wall-clock milliseconds: a token's expiry is the server's wall clock. */
  readonly nowMs: () => number;
  readonly sleep: Sleep;
  readonly timing: BrokerTiming;
  /** D109: the owner the socket directory must have; defaults to this process's uid. */
  readonly uid?: number;
  /** US-008: the provider keys handed out over sync; absent in a broker that serves only git credentials. */
  readonly providerKeys?: ProviderKeyCache;
}

const NONE: JobCredentials = { helper: null, binDir: null };
const keyOf = (job: JobRow, repoId?: string): string => `${job.jobId}:${job.leaseEpoch}${repoId === undefined ? '' : `:${repoId}`}`;

function credentialTarget(cloneUrl: string): URL | null {
  const url = new URL(cloneUrl);
  return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
}

async function closeQuietly(pending: Promise<CredentialServer>): Promise<void> {
  try {
    await (await pending).close();
  } catch {
    // never listened, or already gone
  }
}

/** Design §3.1: one socket per (job, epoch), answered from the TokenCache, and the job's shims. */
export class CredentialBroker implements CredentialProvider, RepoCredentialProvider {
  private servers: ReadonlyMap<string, Promise<CredentialServer>> = new Map();
  /** US-008: provider-key sockets live apart from `servers`, so `release`'s shims check never sees them. */
  private providerServers: ReadonlyMap<string, Promise<CredentialServer>> = new Map();
  /** Identity tokens invalidate sleeping provider replies when their job epoch is released. */
  private readonly providerEpochs = new Map<string, object>();
  private closing = false;
  private readonly repositories = new Map<string, Set<string>>();

  constructor(private readonly deps: BrokerDeps) {}

  async acquire(job: JobRow, options: AcquireOptions): Promise<AcquireResult> {
    const target = credentialTarget(job.assign.repo.cloneUrl);
    if (!target) return { ok: true, credentials: NONE };
    const { tokens, socketDir, runnerId, selfCommand } = this.deps;
    tokens.want(job.jobId, job.leaseEpoch);
    const sock = socketPathFor(socketDir, runnerId, job.jobId, job.leaseEpoch);
    try {
      await this.serve(job, sock, target);
    } catch (error) {
      if (error instanceof SocketDirError) return { ok: false, reason: 'git credentials: socket dir unsafe' };   // D109
      throw error;
    }
    const binDir = join(job.jobDir, 'bin');
    await writeShims(binDir, selfCommand, sock);
    const credentials: JobCredentials = { helper: helperValue(selfCommand, sock), binDir };
    if (!options.wait) return { ok: true, credentials };
    const refused = await this.firstToken(job, options.isCancelled);
    return refused ?? { ok: true, credentials };
  }

  async acquireRepo(job: JobRow, repo: { repoId: string; cloneUrl: string }, options: AcquireOptions): Promise<AcquireResult> {
    const target = credentialTarget(repo.cloneUrl);
    if (!target) return { ok: true, credentials: NONE };
    const { tokens, socketDir, runnerId, selfCommand } = this.deps;
    const { repoId } = repo;
    tokens.want(job.jobId, job.leaseEpoch, repoId);
    const key = keyOf(job);
    const repos = this.repositories.get(key) ?? new Set<string>();
    repos.add(repoId);
    this.repositories.set(key, repos);
    const sock = socketPathFor(socketDir, runnerId, job.jobId, job.leaseEpoch, repoId);
    try {
      await this.serve(job, sock, target, repoId);
    } catch (error) {
      if (error instanceof SocketDirError) return { ok: false, reason: 'git credentials: socket dir unsafe' };
      throw error;
    }
    const credentials: JobCredentials = { helper: helperValue(selfCommand, sock), binDir: null };
    if (!options.wait) return { ok: true, credentials };
    const refused = await this.firstToken(job, options.isCancelled, repoId);
    return refused ?? { ok: true, credentials };
  }

  /**
   * US-006: the same `TokenCache.state` the socket answers from, for this exact job and epoch on the broker's clock
   * (`HostExecutor.spawn` writes it to nax's forge token file). Anything but a live token is null.
   */
  currentToken(job: JobRow): string | null {
    const state = this.deps.tokens.state(job.jobId, job.leaseEpoch, this.deps.nowMs());
    return state.kind === 'token' ? state.token.token : null;
  }

  /** Await a token with the requested remaining lifetime; always remove the minimum when the wait ends. */
  async freshToken(job: JobRow, minRemainingMs: number, isCancelled?: () => boolean): Promise<{ ok: true; token: string } | { ok: false; reason: string }> {
    const { tokens, nowMs, sleep, timing } = this.deps;
    tokens.requireFresh(job.jobId, job.leaseEpoch, minRemainingMs);
    const deadline = nowMs() + timing.waitMs;
    try {
      for (;;) {
        const error = tokens.error(job.jobId, job.leaseEpoch);
        if (error !== null) return { ok: false, reason: `git token: ${error}` };
        const state = tokens.state(job.jobId, job.leaseEpoch, nowMs());
        if (state.kind === 'token' && Date.parse(state.token.expiresAt) - nowMs() >= minRemainingMs) {
          return { ok: true, token: state.token.token };
        }
        if (this.closing || isCancelled?.()) return { ok: false, reason: 'cancelled' };
        if (nowMs() >= deadline) return { ok: false, reason: 'git token: timeout' };
        await sleep(timing.pollMs);
      }
    } finally {
      tokens.requireFresh(job.jobId, job.leaseEpoch, 0);
    }
  }

  async releaseRepo(job: JobRow, repoId: string): Promise<void> {
    this.deps.tokens.drop(job.jobId, job.leaseEpoch, repoId);
    const key = keyOf(job, repoId);
    const pending = this.servers.get(key);
    this.servers = new Map([...this.servers].filter(([other]) => other !== key));
    const repos = this.repositories.get(keyOf(job));
    repos?.delete(repoId);
    if (repos?.size === 0) this.repositories.delete(keyOf(job));
    if (pending) await closeQuietly(pending);
  }

  /** D90: this epoch's socket closes, its token is forgotten, its shims go. Other epochs are untouched. */
  async release(job: JobRow): Promise<void> {
    for (const repoId of [...(this.repositories.get(keyOf(job)) ?? [])]) await this.releaseRepo(job, repoId);
    const key = keyOf(job);
    this.deps.tokens.drop(job.jobId, job.leaseEpoch);
    const pending = this.servers.get(key);
    this.servers = new Map([...this.servers].filter(([other]) => other !== key));
    if (pending) await closeQuietly(pending);
    // `<jobDir>/bin` is shared by every epoch of the job (one job dir): keep it while another epoch is served.
    const sibling = [...this.servers.keys()].some((other) => other.startsWith(`${job.jobId}:`));
    if (!sibling) await rm(join(job.jobDir, 'bin'), { recursive: true, force: true });
  }

  /**
   * US-008: the job epoch's provider-key socket, opened once per (job, epoch) whatever the clone URL — an ssh
   * `git@…` job needs no git token but still needs its model keys. Returns the path; the map holds the pending
   * listen so two concurrent calls share one socket.
   */
  async serveProviderKeys(job: JobRow): Promise<string> {
    const { socketDir, runnerId } = this.deps;
    const sock = socketPathFor(socketDir, runnerId, job.jobId, job.leaseEpoch, PROVIDER_KEY_SOCKET_SCOPE);
    const key = keyOf(job);
    const existing = this.providerServers.get(key);
    if (existing) {
      await existing;
      return sock;
    }
    const pending = this.listenProviderKeys(job, sock);
    this.providerServers = new Map([...this.providerServers, [key, pending]]);
    try {
      await pending;
    } catch (error) {
      this.providerServers = new Map([...this.providerServers].filter(([other]) => other !== key));
      throw error;
    }
    return sock;
  }

  /** US-008: the same lookup the socket answers with, as a yes/no (`true` only on a grant). */
  async providerKeyGranted(job: JobRow, providerId: string): Promise<boolean> {
    return (await this.providerKeyReply(job, providerId)).ok;
  }

  /**
   * US-008: what the job's provider-key socket answers for one provider. A cached grant is served while more than the
   * refresh margin is left; otherwise the request is queued for the sync loop and this waits up to 55 s. A denial is
   * `none` for a provider the job never had and `revoked` for one it did, so nax never switches identity mid-job.
   *
   * US-009 (US-008 D-1): this lookup waits on the answer to its own request and nothing else — no later request of the
   * same job can replace it, however many follow.
   */
  async providerKeyReply(job: JobRow, providerId: string): Promise<ProviderReply> {
    const cache = this.deps.providerKeys;
    if (!cache) return { ok: false, reason: 'error' };   // no vault wired: nothing can be granted, so invent nothing
    const { nowMs, sleep, timing } = this.deps;
    if (this.closing) return { ok: false, reason: 'error' };
    const key = keyOf(job);
    const epoch = this.providerEpochs.get(key) ?? {};
    this.providerEpochs.set(key, epoch);
    const deadline = nowMs() + (timing.providerKeyWaitMs ?? PROVIDER_KEY_WAIT_MS);
    const serve = (grant: CachedProviderKey): ProviderReply => {
      cache.markServed(job.jobId, job.leaseEpoch, providerId);
      return { ok: true, key: grant.key, expiresAt: grant.expiresAtMs, account: grant.account };
    };
    const cached = cache.state(job.jobId, job.leaseEpoch, providerId, nowMs());
    if (cached.kind === 'grant') return serve(cached.grant);   // no request needed: the lease still has margin
    // A new lookup revalidates an earlier denial; from here it reads only the answer its own request settles with.
    const cancelled = (): boolean => this.closing || this.providerEpochs.get(key) !== epoch || nowMs() >= deadline;
    let wait = cache.want(job.jobId, job.leaseEpoch, providerId);
    for (;;) {
      // Check before waiting: a released waiter must never read a dropped epoch's answer as its own.
      if (cancelled()) return { ok: false, reason: 'error' };
      // The poll tick only re-checks those guards; the answer itself arrives as soon as the sync delivers it.
      const answer = await Promise.race([wait.answered, sleep(timing.pollMs).then((): null => null)]);
      // … and again after it: an answer that lands while the epoch is being released, the broker is closing or the wait
      // runs out must neither be served nor re-queued, so the check has to sit between the await and any use of it.
      if (cancelled()) return { ok: false, reason: 'error' };
      if (answer === null) continue;
      if (answer.kind === 'denied') return { ok: false, reason: answer.reason };
      if (answer.grant.expiresAtMs - nowMs() > cache.refreshMarginMs) return serve(answer.grant);
      wait = cache.want(job.jobId, job.leaseEpoch, providerId);   // too short a lease to hand out: ask for a new key
    }
  }

  /** US-008: this epoch's provider-key socket closes and its grants and served set go. Other epochs are untouched. */
  async releaseProviderKeys(job: JobRow): Promise<void> {
    const key = keyOf(job);
    const pending = this.providerServers.get(key);
    this.providerEpochs.delete(key);   // invalidate every provider waiter before dropping this epoch's cache
    this.providerServers = new Map([...this.providerServers].filter(([other]) => other !== key));
    this.deps.providerKeys?.drop(job.jobId, job.leaseEpoch);
    if (pending) await closeQuietly(pending);
  }

  /** D90: daemon stop or crash. The sockets go; the tokens stay wanted and the shims stay, for a readopt. */
  async closeAll(): Promise<void> {
    this.closing = true;   // a prepare still waiting for its first token stops at once (daemon stop must not wait 120 s)
    this.providerEpochs.clear();
    const pending = [...this.servers.values(), ...this.providerServers.values()];
    this.servers = new Map();
    this.providerServers = new Map();
    await Promise.all(pending.map(closeQuietly));
  }

  /** US-008: the socket directory is checked again here, as the git sockets do (D109); a provider request waits inside. */
  private async listenProviderKeys(job: JobRow, sock: string): Promise<CredentialServer> {
    await ensureSocketDir(this.deps.socketDir, this.deps.uid ?? process.getuid?.() ?? 0);
    return CredentialServer.listenProviderKeys(sock, (providerId) => this.providerKeyReply(job, providerId));
  }

  private async serve(job: JobRow, sock: string, target: URL, repoId?: string): Promise<void> {
    const key = keyOf(job, repoId);
    const existing = this.servers.get(key);
    if (existing) {
      await existing;
      return;
    }
    await ensureSocketDir(this.deps.socketDir, this.deps.uid ?? process.getuid?.() ?? 0);   // D109: not only at daemon start
    const pending = CredentialServer.listen(sock, () => this.reply(job, target, repoId));
    this.servers = new Map([...this.servers, [key, pending]]);
    try {
      await pending;
    } catch (error) {
      this.servers = new Map([...this.servers].filter(([other]) => other !== key));
      throw error;
    }
  }

  /** D79: the socket's answer; waits up to serveWaitMs for a token that has not arrived yet. */
  private async reply(job: JobRow, target: URL, repoId?: string): Promise<CredentialReply> {
    const { tokens, nowMs, sleep, timing } = this.deps;
    const deadline = nowMs() + timing.serveWaitMs;
    for (;;) {
      if (!tokens.wanted(job.jobId, job.leaseEpoch, repoId)) return { ok: false, reason: 'job ended' };
      const state = tokens.state(job.jobId, job.leaseEpoch, nowMs(), repoId);
      if (state.kind === 'token') {
        const { username, token, expiresAt } = state.token;
        return { ok: true, username, token, expiresAt, protocol: target.protocol.slice(0, -1), host: target.host };
      }
      if (state.kind === 'error') return { ok: false, reason: state.reason };
      if (nowMs() >= deadline) return { ok: false, reason: 'no token' };
      await sleep(timing.pollMs);
    }
  }

  /** D82: null once the first token is there; otherwise why prepare must stop. */
  private async firstToken(job: JobRow, isCancelled?: () => boolean, repoId?: string): Promise<Extract<AcquireResult, { ok: false }> | null> {
    const { tokens, nowMs, sleep, timing } = this.deps;
    const deadline = nowMs() + timing.waitMs;
    for (;;) {
      const state = tokens.state(job.jobId, job.leaseEpoch, nowMs(), repoId);
      if (state.kind === 'token') return null;
      if (state.kind === 'error') return { ok: false, reason: `git token: ${state.reason}` };
      if (this.closing || isCancelled?.()) return { ok: false, reason: 'cancelled', cancelled: true };
      if (nowMs() >= deadline) return { ok: false, reason: 'git token: timeout' };
      await sleep(timing.pollMs);
    }
  }
}
