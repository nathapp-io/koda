import type { FleetJobLogRecord, IFleetJobLogRepository, LogStreamName, LogStreamPatch } from '../domain/fleet-job-log.domain';

const keyOf = (jobId: string, leaseEpoch: number, stream: string) => `${jobId}:${leaseEpoch}:${stream}`;

/**
 * A complete in-memory IFleetJobLogRepository for unit specs. Use `upsertStream` to
 * record what the service wrote; `set` to seed a pre-existing row (e.g. simulate a
 * previous upload that the service must not touch); `findStream` / `listForAttempt`
 * to assert; `get` for synchronous reads inside the spec.
 *
 * The CAS in `completeFromBundle` mirrors the Prisma implementation: a write only
 * succeeds when the row is absent or has both `complete = false` and `truncated = false`.
 */
export class MemoryLogRepo
  implements Pick<IFleetJobLogRepository, 'findStream' | 'listForAttempt' | 'upsertStream' | 'completeFromBundle'>
{
  rows: ReadonlyMap<string, FleetJobLogRecord> = new Map();

  async findStream(jobId: string, leaseEpoch: number, stream: LogStreamName): Promise<FleetJobLogRecord | null> {
    return this.rows.get(keyOf(jobId, leaseEpoch, stream)) ?? null;
  }

  async listForAttempt(jobId: string, leaseEpoch: number): Promise<FleetJobLogRecord[]> {
    return [...this.rows.values()].filter((r) => r.jobId === jobId && r.leaseEpoch === leaseEpoch);
  }

  async upsertStream(jobId: string, leaseEpoch: number, stream: LogStreamName, patch: LogStreamPatch): Promise<FleetJobLogRecord> {
    const prev = await this.findStream(jobId, leaseEpoch, stream);
    const row: FleetJobLogRecord = {
      id: prev?.id ?? `${jobId}-${leaseEpoch}-${stream}`,
      jobId, leaseEpoch, stream,
      source: prev?.source ?? 'stream',
      expiredAt: null,
      createdAt: new Date(0), updatedAt: new Date(0),
      complete: patch.complete ?? prev?.complete ?? false,
      truncated: patch.truncated ?? prev?.truncated ?? false,
      sizeBytes: patch.sizeBytes,
    };
    this.rows = new Map([...this.rows, [keyOf(jobId, leaseEpoch, stream), row]]);
    return row;
  }

  async completeFromBundle(
    jobId: string, leaseEpoch: number, stream: LogStreamName, r: { sizeBytes: number; truncated: boolean },
  ): Promise<boolean> {
    const prev = await this.findStream(jobId, leaseEpoch, stream);
    if (prev && (prev.complete || prev.truncated)) return false;
    this.set({ jobId, leaseEpoch, stream, sizeBytes: r.sizeBytes, complete: !r.truncated, truncated: r.truncated, source: 'bundle' });
    return true;
  }

  /** Seed a row directly; bypasses the service's write path. */
  set(r: Partial<FleetJobLogRecord> & { jobId: string; leaseEpoch: number; stream: LogStreamName }): FleetJobLogRecord {
    const row: FleetJobLogRecord = {
      id: 'x', sizeBytes: 0, complete: false, truncated: false, source: 'stream', expiredAt: null,
      createdAt: new Date(0), updatedAt: new Date(0),
      ...r,
    };
    this.rows = new Map([...this.rows, [keyOf(r.jobId, r.leaseEpoch, r.stream), row]]);
    return row;
  }

  /** Synchronous read for assertions inside the spec. */
  get(jobId: string, leaseEpoch: number, stream: string): FleetJobLogRecord | null {
    return this.rows.get(keyOf(jobId, leaseEpoch, stream)) ?? null;
  }
}
