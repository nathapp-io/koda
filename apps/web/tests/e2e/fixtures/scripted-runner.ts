/**
 * Fleet S1 slice 4c (D128): a runner that speaks the sync protocol from the test.
 * It stands in for apps/runner + fake nax: the job pages only ever see state that
 * runner syncs produce, so scripted syncs exercise them exactly.
 * Shapes: packages/fleet-protocol (SyncRequest/SyncResponse), payload rules:
 * apps/api/src/fleet/sync/event-payloads.ts.
 */
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { pack } from 'tar-stream';

const API_URL = process.env['E2E_API_URL'] ?? 'http://localhost:3102';
const BOOT_ID = 'e2e-boot-1';
const DAEMON_VERSION = '0.1.0-e2e';

/** A machine profile `fast` and every tool, so placement accepts the runner for a GitHub repo. */
export const E2E_RUNNER_CAPABILITIES = {
  nax: { version: '0.83.1', protocols: ['native'] },
  sandbox: { available: true, probedAt: '2026-10-01T00:00:00.000Z' },
  profiles: { fast: { protocol: 'native', providers: ['deepseek'], sandbox: false } },
  credentials: [{ providerId: 'deepseek', available: true, stored: { kind: 'api-key', expired: false }, ambient: false }],
  tools: { git: true, gh: true, glab: true },
  executors: ['host'],
};

export interface Lease {
  jobId: string;
  leaseEpoch: number;
}

interface SyncCommand {
  commandId: string;
  type: 'ASSIGN' | 'CANCEL' | 'READOPT' | 'ABANDON' | 'APPROVAL_ANSWER';
  jobId: string;
  leaseEpoch: number;
  payload: Record<string, unknown>;
}

interface SyncReply {
  jobAcks: Array<{ jobId: string; ackedSeq: number }>;
  commands: SyncCommand[];
}

type EventType = 'state' | 'snapshot' | 'lifecycle' | 'log' | 'approval_request';

/** S2a §2.2 (D307): the 200 body of a log upload. */
export interface LogUploadAnswer {
  outcome: 'appended' | 'duplicate' | 'offset' | 'complete' | 'stream_cap' | 'rate_limited';
  size: number;
  retryAfterMs?: number;
}

const sha256Hex = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** A tar.gz with one regular file per entry, laid out like the runner's bundle (S2a §2.5 member names). */
async function tarGz(members: Readonly<Record<string, string>>): Promise<Buffer> {
  const archive = pack();
  const chunks: Buffer[] = [];
  archive.on('data', (chunk: unknown) => { chunks.push(Buffer.from(chunk as Uint8Array)); });
  const done = new Promise<void>((resolve, reject) => {
    archive.on('end', () => resolve());
    archive.on('error', reject);
  });
  for (const [name, text] of Object.entries(members)) archive.entry({ name, mtime: new Date() }, text);
  archive.finalize();
  await done;
  return gzipSync(Buffer.concat(chunks));
}

async function call<T>(path: string, init: { method: string; token?: string; body?: unknown }): Promise<T> {
  const res = await fetch(`${API_URL}/api${path}`, {
    method: init.method,
    headers: {
      'Content-Type': 'application/json',
      ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method} ${path} failed: ${res.status} ${text}`);
  const body = JSON.parse(text) as { ret?: number; data?: T };
  if (body.ret !== 0) throw new Error(`${init.method} ${path} answered ret ${String(body.ret)}: ${text}`);
  return body.data as T;
}

export class ScriptedRunner {
  private seqByJob: ReadonlyMap<string, number> = new Map();

  private constructor(
    readonly id: string,
    readonly name: string,
    private readonly apiKey: string,
    private readonly protocolVersion: number,
  ) {}

  /**
   * Issues a single-use enrollment token as the admin and enrolls over HTTP, like `koda-runner enroll`. With `relay`
   * the runner speaks protocol v2 and reports the approval relay (S1.5 2a D271), so gated/escalate jobs place on it.
   * With `logs` it speaks protocol v3 (S2a R1): it streams logs over `putLog` and sends no `log` sync events.
   * With `capabilities` the runner reports that blob instead of the default.
   * S3 §3: with `configJobs` the runner reports the config-jobs capability, so placement offers it
   * CONFIG_EDIT / CONFIG_DRIFT jobs (runners without it get the permanent misfit `config_jobs`).
   */
  static async enroll(
    adminToken: string, name: string,
    opts: { relay?: boolean; logs?: boolean; configJobs?: boolean; capabilities?: Record<string, unknown> } = {},
  ): Promise<ScriptedRunner> {
    const protocolVersion = opts.logs ? 3 : opts.relay ? 2 : 1;
    const base = opts.relay ? { ...(opts.capabilities ?? E2E_RUNNER_CAPABILITIES), approvals: { relay: true } } : opts.capabilities ?? E2E_RUNNER_CAPABILITIES;
    // S3 §3: only a runner reporting configJobs is offered CONFIG_EDIT / CONFIG_DRIFT jobs.
    const capabilities = opts.configJobs ? { ...base, configJobs: true } : base;
    const { token } = await call<{ token: string }>('/fleet/enrollments', { method: 'POST', token: adminToken, body: { labels: ['e2e'] } });
    const { runnerId, apiKey } = await call<{ runnerId: string; apiKey: string }>('/fleet/runner/enroll', {
      method: 'POST',
      body: {
        enrollmentToken: token, name, os: 'linux', arch: 'x64', daemonVersion: DAEMON_VERSION,
        protocolVersion, bootId: BOOT_ID, labels: [], capabilities,
      },
    });
    return new ScriptedRunner(runnerId, name, apiKey, protocolVersion);
  }

  /** One idle sync: refreshes lastSeenAt so placement sees the runner online (FLEET_RUNNER_OFFLINE_SEC). */
  async heartbeat(): Promise<void> {
    await this.sync({});
  }

  private sync(over: Record<string, unknown>): Promise<SyncReply> {
    return call<SyncReply>('/fleet/runner/sync', {
      method: 'POST',
      token: this.apiKey,
      body: {
        protocolVersion: this.protocolVersion, bootId: BOOT_ID, daemonVersion: DAEMON_VERSION, freeSlots: 0,
        jobs: [], commandAcks: [], tokenRequests: [], ...over,
      },
    });
  }

  /** Polls (an idle sync long-polls FLEET_SYNC_WAIT_MS) until the ASSIGN for `jobId` arrives, then acks it. */
  async acceptAssign(jobId: string, timeoutMs = 15_000): Promise<Lease> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const reply = await this.sync({ freeSlots: 1 });
      const assign = reply.commands.find((c) => c.type === 'ASSIGN' && c.jobId === jobId);
      if (assign) {
        await this.sync({ commandAcks: [{ commandId: assign.commandId, leaseEpoch: assign.leaseEpoch, result: 'ok' }] });
        return { jobId, leaseEpoch: assign.leaseEpoch };
      }
    }
    throw new Error(`No ASSIGN for job ${jobId} within ${timeoutMs} ms`);
  }

  /** Idle syncs until a command of `type` for `jobId` arrives; acks it with `ack` and returns it (S1.5 APPROVAL_ANSWER). */
  async takeCommand(
    type: SyncCommand['type'],
    jobId: string,
    ack: { result: 'ok' | 'rejected'; detail?: string },
    timeoutMs = 15_000,
  ): Promise<SyncCommand> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const reply = await this.sync({});
      const found = reply.commands.find((c) => c.type === type && c.jobId === jobId);
      if (found) {
        await this.sync({ commandAcks: [{ commandId: found.commandId, leaseEpoch: found.leaseEpoch, result: ack.result, ...(ack.detail ? { detail: ack.detail } : {}) }] });
        return found;
      }
    }
    throw new Error(`No ${type} for job ${jobId} within ${timeoutMs} ms`);
  }

  /** One idle sync: the commands the server has for `jobId` right now (none are acked). */
  async commandsFor(jobId: string): Promise<SyncCommand[]> {
    return (await this.sync({})).commands.filter((c) => c.jobId === jobId);
  }

  /** Sends events with the next runner seqs and checks the server stored all of them (cumulative ack). */
  async report(lease: Lease, events: ReadonlyArray<{ type: EventType; payload: Record<string, unknown> }>): Promise<void> {
    const first = (this.seqByJob.get(lease.jobId) ?? 0) + 1;
    const numbered = events.map((e, i) => ({ seq: first + i, type: e.type, payload: e.payload }));
    const last = first + events.length - 1;
    const reply = await this.sync({ jobs: [{ jobId: lease.jobId, leaseEpoch: lease.leaseEpoch, events: numbered }] });
    const ack = reply.jobAcks.find((a) => a.jobId === lease.jobId);
    if (ack?.ackedSeq !== last) throw new Error(`Job ${lease.jobId}: expected ack ${last}, got ${JSON.stringify(reply.jobAcks)}`);
    this.seqByJob = new Map([...this.seqByJob, [lease.jobId, last]]);
  }

  /** PUT the run bundle (accepted while RUNNING or UPLOADING, spec §3.3). */
  async uploadBundle(lease: Lease, content: string): Promise<void> {
    await this.putBundle(lease, gzipSync(Buffer.from(content, 'utf8')));
  }

  /** S3 §3: the lease-fenced edit set a config job applies (`GET /fleet/runner/jobs/:id/config-edit?leaseEpoch=`). */
  async getConfigEdit(lease: Lease): Promise<{ mode: string; edits: Array<{ path: string; op: string; content?: string; baseSha: string | null }>; prTitle: string | null; baseSha: string }> {
    const res = await fetch(`${API_URL}/api/fleet/runner/jobs/${lease.jobId}/config-edit?leaseEpoch=${lease.leaseEpoch}`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    const raw = await res.text();
    if (res.status !== 200) throw new Error(`config-edit fetch failed: ${res.status} ${raw}`);
    return (JSON.parse(raw) as { data: Awaited<ReturnType<ScriptedRunner['getConfigEdit']>> }).data;
  }

  /** PUT a real tar.gz bundle whose members the API's log fallback reads (S2a §2.5), e.g. `nax.stdout`. */
  async uploadTarBundle(lease: Lease, members: Readonly<Record<string, string>>): Promise<void> {
    await this.putBundle(lease, await tarGz(members));
  }

  private async putBundle(lease: Lease, body: Buffer): Promise<void> {
    const res = await fetch(`${API_URL}/api/fleet/runner/jobs/${lease.jobId}/bundle?leaseEpoch=${lease.leaseEpoch}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/gzip', 'X-Content-SHA256': sha256Hex(body) },
      body: new Uint8Array(body),
    });
    if (res.status !== 201) throw new Error(`Bundle upload failed: ${res.status} ${await res.text()}`);
  }

  /**
   * S2a §2.2: append `text` to one log stream at `offset` (the bytes the server holds), like the runner's LogShipper.
   * `final` marks the stream complete. Throws unless the server answers HTTP 200.
   */
  async putLog(lease: Lease, stream: 'run' | 'stdout' | 'stderr', offset: number, text: string, final = false): Promise<LogUploadAnswer> {
    const body = Buffer.from(text, 'utf8');
    const query = `leaseEpoch=${lease.leaseEpoch}&offset=${offset}${final ? '&final=1' : ''}`;
    const res = await fetch(`${API_URL}/api/fleet/runner/jobs/${lease.jobId}/logs/${stream}?${query}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/octet-stream', 'X-Content-SHA256': sha256Hex(body) },
      body,
    });
    const raw = await res.text();
    if (res.status !== 200) throw new Error(`Log upload failed: ${res.status} ${raw}`);
    return (JSON.parse(raw) as { data: LogUploadAnswer }).data;
  }
}
