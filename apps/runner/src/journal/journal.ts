import { Database } from 'bun:sqlite';
import type { RunnerEvent, RunnerEventType } from '@nathapp/fleet-protocol';
import { systemNow, type Now } from '../time';
import { SCHEMA_SQL } from './schema';
import type { CommandRecord, EventRow, JobPatch, JobRow, NewJob } from './types';

type Row = Record<string, unknown>;

const PATCH_COLUMNS: Readonly<Record<keyof JobPatch, string>> = {
  state: 'state', branch: 'branch', pid: 'pid', pgid: 'pgid', naxRunId: 'nax_run_id', logPath: 'log_path',
  cancelRequestedAt: 'cancel_requested_at', resultBranch: 'result_branch', resultSha: 'result_sha',
};

const toJob = (r: Row): JobRow => ({
  jobId: r['job_id'] as string, leaseEpoch: r['lease_epoch'] as number, command: r['command'] as JobRow['command'], state: r['state'] as JobRow['state'],
  repoKey: r['repo_key'] as string, branch: r['branch'] as string | null, pid: r['pid'] as number | null, pgid: r['pgid'] as number | null,
  naxRunId: r['nax_run_id'] as string | null, logPath: r['log_path'] as string | null, jobDir: r['job_dir'] as string,
  assign: JSON.parse(r['assign_json'] as string), cancelRequestedAt: r['cancel_requested_at'] as string | null,
  resultBranch: r['result_branch'] as string | null, resultSha: r['result_sha'] as string | null,
  createdAt: r['created_at'] as string, updatedAt: r['updated_at'] as string, doneAt: r['done_at'] as string | null,
});

const toEvent = (r: Row): EventRow => ({
  jobId: r['job_id'] as string, leaseEpoch: r['lease_epoch'] as number, seq: r['seq'] as number, type: r['type'] as RunnerEventType,
  payload: JSON.parse(r['payload_json'] as string), createdAt: r['created_at'] as string, acked: r['acked'] === 1,
});

const toCommand = (r: Row): CommandRecord => ({
  commandId: r['command_id'] as string, jobId: r['job_id'] as string, leaseEpoch: r['lease_epoch'] as number, type: r['type'] as string,
  result: r['result'] as CommandRecord['result'], detail: r['detail'] as string | null, appliedAt: r['applied_at'] as string,
});

/** Persist-before-send store (slice 3 design §1.4). Every write commits before the caller reports it. */
export class Journal {
  private readonly listeners = new Set<() => void>();
  private txDepth = 0;
  private dirty = false;

  private constructor(private readonly db: Database, private readonly now: Now) {}

  static open(path: string, now: Now = systemNow): Journal {
    const db = new Database(path, { create: true });
    // FULL, not NORMAL (D55): under WAL, NORMAL can lose the last committed transactions on power loss. A lost
    // *reported* event would be re-issued after restart under the same seq with different content, and the server
    // would keep the first one (its ack is the highest contiguous stored seq).
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
    db.exec(SCHEMA_SQL);
    return new Journal(db, now);
  }

  close(): void {
    this.db.close();
  }

  onWrite(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }

  /** One sqlite transaction; nested calls join it. Listeners are told once, after the outermost commit (D55). */
  tx<T>(fn: () => T): T {
    this.txDepth += 1;
    let result: T;
    try {
      result = this.db.transaction(fn)();
    } catch (error) {
      if (this.txDepth === 1) this.dirty = false; // the outermost transaction rolled back: nothing was written
      throw error;
    } finally {
      this.txDepth -= 1;
    }
    if (this.txDepth === 0 && this.dirty) {
      this.dirty = false;
      this.notify();
    }
    return result;
  }

  /** Marks an event write; announces it now when no transaction is open, else at the outermost commit. */
  private wrote(): void {
    this.dirty = true;
    if (this.txDepth === 0) {
      this.dirty = false;
      this.notify();
    }
  }

  getMeta(key: string): string | null {
    const row = this.db.query('SELECT value FROM meta WHERE key = ?').get(key) as Row | null;
    return row ? (row['value'] as string) : null;
  }

  setMeta(key: string, value: string): void {
    this.db.query('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  insertJob(job: NewJob): { row: JobRow; created: boolean } {
    const stamp = this.now().toISOString();
    const result = this.db.query(
      `INSERT OR IGNORE INTO jobs (job_id, lease_epoch, command, state, repo_key, job_dir, assign_json, created_at, updated_at)
       VALUES (?, ?, ?, 'ASSIGNED', ?, ?, ?, ?, ?)`,
    ).run(job.assign.jobId, job.leaseEpoch, job.assign.command, job.repoKey, job.jobDir, JSON.stringify(job.assign), stamp, stamp);
    const row = this.getJob(job.assign.jobId, job.leaseEpoch);
    if (!row) throw new Error('journal: inserted job row not found');
    return { row, created: result.changes > 0 };
  }

  getJob(jobId: string, leaseEpoch: number): JobRow | null {
    const row = this.db.query('SELECT * FROM jobs WHERE job_id = ? AND lease_epoch = ?').get(jobId, leaseEpoch) as Row | null;
    return row ? toJob(row) : null;
  }

  jobsById(jobId: string): JobRow[] {
    return (this.db.query('SELECT * FROM jobs WHERE job_id = ? ORDER BY lease_epoch').all(jobId) as Row[]).map(toJob);
  }

  activeJobs(): JobRow[] {
    return (this.db.query('SELECT * FROM jobs WHERE done_at IS NULL ORDER BY created_at, job_id').all() as Row[]).map(toJob);
  }

  activeCount(): number {
    return (this.db.query('SELECT COUNT(*) AS n FROM jobs WHERE done_at IS NULL').get() as Row)['n'] as number;
  }

  updateJob(jobId: string, leaseEpoch: number, patch: JobPatch): JobRow | null {
    const keys = (Object.keys(patch) as Array<keyof JobPatch>).filter((k) => k in PATCH_COLUMNS);
    const sets = [...keys.map((k) => `${PATCH_COLUMNS[k]} = ?`), 'updated_at = ?'];
    const values = [...keys.map((k) => patch[k] ?? null), this.now().toISOString()];
    this.db.query(`UPDATE jobs SET ${sets.join(', ')} WHERE job_id = ? AND lease_epoch = ?`).run(...values, jobId, leaseEpoch);
    return this.getJob(jobId, leaseEpoch);
  }

  markDone(jobId: string, leaseEpoch: number): void {
    const stamp = this.now().toISOString();
    this.db.query('UPDATE jobs SET done_at = COALESCE(done_at, ?), updated_at = ? WHERE job_id = ? AND lease_epoch = ?').run(stamp, stamp, jobId, leaseEpoch);
  }

  appendEvent(jobId: string, leaseEpoch: number, type: RunnerEventType, payload: RunnerEvent['payload'], patch?: JobPatch): number | null {
    return this.tx(() => {
      if (!this.getJob(jobId, leaseEpoch)) return null;
      const next = ((this.db.query('SELECT COALESCE(MAX(seq), 0) AS m FROM events WHERE job_id = ? AND lease_epoch = ?').get(jobId, leaseEpoch) as Row)['m'] as number) + 1;
      this.db.query('INSERT INTO events (job_id, lease_epoch, seq, type, payload_json, created_at, acked) VALUES (?, ?, ?, ?, ?, ?, 0)')
        .run(jobId, leaseEpoch, next, type, JSON.stringify(payload), this.now().toISOString());
      if (patch) this.updateJob(jobId, leaseEpoch, patch);
      this.wrote();
      return next;
    });
  }

  pendingEvents(jobId: string, leaseEpoch: number, limit: number): EventRow[] {
    return (this.db.query('SELECT * FROM events WHERE job_id = ? AND lease_epoch = ? AND acked = 0 ORDER BY seq LIMIT ?').all(jobId, leaseEpoch, limit) as Row[]).map(toEvent);
  }

  jobsWithPending(): Array<{ jobId: string; leaseEpoch: number }> {
    const rows = this.db.query('SELECT job_id, lease_epoch FROM events WHERE acked = 0 GROUP BY job_id, lease_epoch ORDER BY MIN(created_at), job_id').all() as Row[];
    return rows.map((r) => ({ jobId: r['job_id'] as string, leaseEpoch: r['lease_epoch'] as number }));
  }

  ackThrough(jobId: string, leaseEpoch: number, ackedSeq: number): void {
    this.db.query('UPDATE events SET acked = 1 WHERE job_id = ? AND lease_epoch = ? AND seq <= ?').run(jobId, leaseEpoch, ackedSeq);
  }

  replaceEvent(jobId: string, leaseEpoch: number, seq: number, type: RunnerEventType, payload: RunnerEvent['payload']): void {
    this.db.query('UPDATE events SET type = ?, payload_json = ? WHERE job_id = ? AND lease_epoch = ? AND seq = ? AND acked = 0')
      .run(type, JSON.stringify(payload), jobId, leaseEpoch, seq);
    this.wrote();
  }

  recordCommand(record: CommandRecord): boolean {
    const result = this.db.query(
      'INSERT OR IGNORE INTO applied_commands (command_id, job_id, lease_epoch, type, result, detail, applied_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(record.commandId, record.jobId, record.leaseEpoch, record.type, record.result, record.detail, record.appliedAt);
    return result.changes > 0;
  }

  getCommand(commandId: string): CommandRecord | null {
    const row = this.db.query('SELECT * FROM applied_commands WHERE command_id = ?').get(commandId) as Row | null;
    return row ? toCommand(row) : null;
  }

  abandon(jobId: string, leaseEpoch: number): void {
    this.tx(() => {
      this.db.query('DELETE FROM events WHERE job_id = ? AND lease_epoch = ?').run(jobId, leaseEpoch);
      this.db.query('DELETE FROM jobs WHERE job_id = ? AND lease_epoch = ?').run(jobId, leaseEpoch);
    });
  }

  prune(retentionDays: number): Array<{ jobId: string; leaseEpoch: number; jobDir: string }> {
    const cutoff = new Date(this.now().getTime() - retentionDays * 86_400_000).toISOString();
    return this.tx(() => {
      const old = this.db.query('SELECT job_id, lease_epoch, job_dir FROM jobs WHERE done_at IS NOT NULL AND done_at < ?').all(cutoff) as Row[];
      for (const r of old) {
        const key: [string, number] = [r['job_id'] as string, r['lease_epoch'] as number];
        this.db.query('DELETE FROM events WHERE job_id = ? AND lease_epoch = ?').run(...key);
        this.db.query('DELETE FROM jobs WHERE job_id = ? AND lease_epoch = ?').run(...key);
      }
      this.db.query('DELETE FROM applied_commands WHERE applied_at < ?').run(cutoff);
      return old.map((r) => ({ jobId: r['job_id'] as string, leaseEpoch: r['lease_epoch'] as number, jobDir: r['job_dir'] as string }));
    });
  }

  stats(): { activeJobs: number; pendingEvents: number } {
    return {
      activeJobs: this.activeCount(),
      pendingEvents: (this.db.query('SELECT COUNT(*) AS n FROM events WHERE acked = 0').get() as Row)['n'] as number,
    };
  }
}
