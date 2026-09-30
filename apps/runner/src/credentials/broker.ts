// apps/runner/src/credentials/broker.ts
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { JobRow } from '../journal/types';
import type { Sleep } from '../time';
import { CredentialServer, type CredentialReply } from './cred-server';
import { helperValue, writeShims } from './job-files';
import { socketPathFor } from './socket-dir';
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
}

export interface BrokerTiming {
  readonly waitMs: number;
  readonly serveWaitMs: number;
  readonly pollMs: number;
}

export interface BrokerDeps {
  readonly tokens: TokenCache;
  readonly socketDir: string;
  readonly runnerId: string;
  readonly selfCommand: readonly string[];
  /** Wall-clock milliseconds: a token's expiry is the server's wall clock. */
  readonly nowMs: () => number;
  readonly sleep: Sleep;
  readonly timing: BrokerTiming;
}

const NONE: JobCredentials = { helper: null, binDir: null };
const keyOf = (job: JobRow): string => `${job.jobId}:${job.leaseEpoch}`;

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
export class CredentialBroker implements CredentialProvider {
  private servers: ReadonlyMap<string, Promise<CredentialServer>> = new Map();
  private closing = false;

  constructor(private readonly deps: BrokerDeps) {}

  async acquire(job: JobRow, options: AcquireOptions): Promise<AcquireResult> {
    const target = credentialTarget(job.assign.repo.cloneUrl);
    if (!target) return { ok: true, credentials: NONE };
    const { tokens, socketDir, runnerId, selfCommand } = this.deps;
    tokens.want(job.jobId, job.leaseEpoch);
    const sock = socketPathFor(socketDir, runnerId, job.jobId, job.leaseEpoch);
    await this.serve(job, sock, target);
    const binDir = join(job.jobDir, 'bin');
    await writeShims(binDir, selfCommand, sock);
    const credentials: JobCredentials = { helper: helperValue(selfCommand, sock), binDir };
    if (!options.wait) return { ok: true, credentials };
    const refused = await this.firstToken(job, options.isCancelled);
    return refused ?? { ok: true, credentials };
  }

  /** D90: this epoch's socket closes, its token is forgotten, its shims go. Other epochs are untouched. */
  async release(job: JobRow): Promise<void> {
    const key = keyOf(job);
    this.deps.tokens.drop(job.jobId, job.leaseEpoch);
    const pending = this.servers.get(key);
    this.servers = new Map([...this.servers].filter(([other]) => other !== key));
    if (pending) await closeQuietly(pending);
    // `<jobDir>/bin` is shared by every epoch of the job (one job dir): keep it while another epoch is served.
    const sibling = [...this.servers.keys()].some((other) => other.startsWith(`${job.jobId}:`));
    if (!sibling) await rm(join(job.jobDir, 'bin'), { recursive: true, force: true });
  }

  /** D90: daemon stop or crash. The sockets go; the tokens stay wanted and the shims stay, for a readopt. */
  async closeAll(): Promise<void> {
    this.closing = true;   // a prepare still waiting for its first token stops at once (daemon stop must not wait 120 s)
    const pending = [...this.servers.values()];
    this.servers = new Map();
    await Promise.all(pending.map(closeQuietly));
  }

  private async serve(job: JobRow, sock: string, target: URL): Promise<void> {
    const key = keyOf(job);
    const existing = this.servers.get(key);
    if (existing) {
      await existing;
      return;
    }
    const pending = CredentialServer.listen(sock, () => this.reply(job, target));
    this.servers = new Map([...this.servers, [key, pending]]);
    try {
      await pending;
    } catch (error) {
      this.servers = new Map([...this.servers].filter(([other]) => other !== key));
      throw error;
    }
  }

  /** D79: the socket's answer; waits up to serveWaitMs for a token that has not arrived yet. */
  private async reply(job: JobRow, target: URL): Promise<CredentialReply> {
    const { tokens, nowMs, sleep, timing } = this.deps;
    const deadline = nowMs() + timing.serveWaitMs;
    for (;;) {
      if (!tokens.wanted(job.jobId, job.leaseEpoch)) return { ok: false, reason: 'job ended' };
      const state = tokens.state(job.jobId, job.leaseEpoch, nowMs());
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
  private async firstToken(job: JobRow, isCancelled?: () => boolean): Promise<Extract<AcquireResult, { ok: false }> | null> {
    const { tokens, nowMs, sleep, timing } = this.deps;
    const deadline = nowMs() + timing.waitMs;
    for (;;) {
      const state = tokens.state(job.jobId, job.leaseEpoch, nowMs());
      if (state.kind === 'token') return null;
      if (state.kind === 'error') return { ok: false, reason: `git token: ${state.reason}` };
      if (this.closing || isCancelled?.()) return { ok: false, reason: 'cancelled', cancelled: true };
      if (nowMs() >= deadline) return { ok: false, reason: 'git token: timeout' };
      await sleep(timing.pollMs);
    }
  }
}
