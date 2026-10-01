/**
 * Fleet S1 slice 4c (D128): a runner that speaks the sync protocol from the test.
 * It stands in for apps/runner + fake nax: the job pages only ever see state that
 * runner syncs produce, so scripted syncs exercise them exactly.
 * Shapes: packages/fleet-protocol (SyncRequest/SyncResponse), payload rules:
 * apps/api/src/fleet/sync/event-payloads.ts.
 */
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

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
  type: 'ASSIGN' | 'CANCEL' | 'READOPT' | 'ABANDON';
  jobId: string;
  leaseEpoch: number;
}

interface SyncReply {
  jobAcks: Array<{ jobId: string; ackedSeq: number }>;
  commands: SyncCommand[];
}

type EventType = 'state' | 'snapshot' | 'lifecycle' | 'log';

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
  ) {}

  /** Issues a single-use enrollment token as the admin and enrolls over HTTP, like `koda-runner enroll`. */
  static async enroll(adminToken: string, name: string): Promise<ScriptedRunner> {
    const { token } = await call<{ token: string }>('/fleet/enrollments', { method: 'POST', token: adminToken, body: { labels: ['e2e'] } });
    const { runnerId, apiKey } = await call<{ runnerId: string; apiKey: string }>('/fleet/runner/enroll', {
      method: 'POST',
      body: {
        enrollmentToken: token, name, os: 'linux', arch: 'x64', daemonVersion: DAEMON_VERSION,
        protocolVersion: 1, bootId: BOOT_ID, labels: [], capabilities: E2E_RUNNER_CAPABILITIES,
      },
    });
    return new ScriptedRunner(runnerId, name, apiKey);
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
        protocolVersion: 1, bootId: BOOT_ID, daemonVersion: DAEMON_VERSION, freeSlots: 0,
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
    const body = gzipSync(Buffer.from(content, 'utf8'));
    const sha256 = createHash('sha256').update(body).digest('hex');
    const res = await fetch(`${API_URL}/api/fleet/runner/jobs/${lease.jobId}/bundle?leaseEpoch=${lease.leaseEpoch}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/gzip', 'X-Content-SHA256': sha256 },
      body,
    });
    if (res.status !== 201) throw new Error(`Bundle upload failed: ${res.status} ${await res.text()}`);
  }
}
