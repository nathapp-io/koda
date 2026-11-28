import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { AssignPayload } from '@nathapp/fleet-protocol';
import { makeTempDirs } from '../../test/helpers/tmp';
import { Journal, JobDirCleanupPendingError } from './journal';

const SKIP_FILEMODE = process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0);

const assign = (jobId = 'j1'): AssignPayload => ({
  jobId, command: 'RUN', repo: { provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'main', cloneUrl: 'https://github.com/acme/app.git' },
  ref: 'main', feature: 'feat', planFrom: null, profiles: [], maxCostUsd: '5', bashMode: 'raw', approvalTimeoutSec: 600, gitIdentity: { name: 'bot', email: 'bot@x' },
});
const job = (jobId = 'j1', leaseEpoch = 1) => ({ assign: assign(jobId), leaseEpoch, repoKey: 'acme/app', jobDir: `/w/.jobs/${jobId}` });

let clock = new Date('2026-10-01T00:00:00.000Z');
const now = () => clock;
let j: Journal;
beforeEach(() => {
  clock = new Date('2026-10-01T00:00:00.000Z');
  j = Journal.open(':memory:', now);
});
const tmp = makeTempDirs();
afterAll(() => tmp.cleanup());

describe('jobs', () => {
  test('insertJob is idempotent and starts ASSIGNED and active', () => {
    const first = j.insertJob(job());
    expect(first.created).toBe(true);
    expect(first.row).toMatchObject({ jobId: 'j1', leaseEpoch: 1, state: 'ASSIGNED', pid: null, doneAt: null, assign: assign() });
    const again = j.insertJob(job());
    expect(again.created).toBe(false);
    expect(j.activeCount()).toBe(1);
  });
  test('epochs of one job are separate rows', () => {
    j.insertJob(job('j1', 1));
    j.insertJob(job('j1', 2));
    expect(j.jobsById('j1').map((r) => r.leaseEpoch)).toEqual([1, 2]);
  });
  test('updateJob patches only the named columns and stamps updatedAt', () => {
    j.insertJob(job());
    clock = new Date('2026-10-01T00:05:00.000Z');
    const row = j.updateJob('j1', 1, { state: 'RUNNING', pid: 42, pgid: 42, naxRunId: 'run-1', cancelRequestedAt: '2026-10-01T00:04:00.000Z' });
    expect(row).toMatchObject({ state: 'RUNNING', pid: 42, pgid: 42, naxRunId: 'run-1', branch: null, updatedAt: '2026-10-01T00:05:00.000Z' });
    expect(j.updateJob('nope', 1, { pid: 1 })).toBeNull();
  });
  test('markDone removes the job from the active set', () => {
    j.insertJob(job());
    j.markDone('j1', 1);
    expect(j.activeCount()).toBe(0);
    expect(j.getJob('j1', 1)?.doneAt).toBe('2026-10-01T00:00:00.000Z');
  });
});

describe('events', () => {
  test('seq is per (job, epoch), contiguous from 1', () => {
    j.insertJob(job('a', 1));
    j.insertJob(job('b', 1));
    expect([1, 2, 3].map(() => j.appendEvent('a', 1, 'log', { stream: 'run', text: 'x' }))).toEqual([1, 2, 3]);
    expect(j.appendEvent('b', 1, 'lifecycle', { level: 'info', message: 'm' })).toBe(1);
  });
  test('an event for a job that is gone is refused, not orphaned', () => {
    expect(j.appendEvent('ghost', 1, 'log', { stream: 'run', text: 'x' })).toBeNull();
    expect(j.stats().pendingEvents).toBe(0);
  });
  test('a patch lands in the same transaction as the event', () => {
    j.insertJob(job());
    j.appendEvent('j1', 1, 'state', { to: 'RUNNING' }, { state: 'RUNNING', pid: 7, pgid: 7 });
    expect(j.getJob('j1', 1)).toMatchObject({ state: 'RUNNING', pid: 7 });
  });
  test('pending events come back in order and ackThrough marks a prefix only', () => {
    j.insertJob(job());
    for (let i = 0; i < 5; i += 1) j.appendEvent('j1', 1, 'log', { stream: 'run', text: `l${i}` });
    expect(j.pendingEvents('j1', 1, 3).map((e) => e.seq)).toEqual([1, 2, 3]);
    j.ackThrough('j1', 1, 2);
    expect(j.pendingEvents('j1', 1, 10).map((e) => e.seq)).toEqual([3, 4, 5]);
    j.ackThrough('j1', 1, 1); // the cursor never moves back
    expect(j.pendingEvents('j1', 1, 10).map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(j.jobsWithPending()).toEqual([{ jobId: 'j1', leaseEpoch: 1 }]);
    j.ackThrough('j1', 1, 5);
    expect(j.jobsWithPending()).toEqual([]);
  });
  test('the next seq continues after acked rows', () => {
    j.insertJob(job());
    j.appendEvent('j1', 1, 'log', { stream: 'run', text: 'a' });
    j.ackThrough('j1', 1, 1);
    expect(j.appendEvent('j1', 1, 'log', { stream: 'run', text: 'b' })).toBe(2);
  });
  test('replaceEvent keeps the seq and swaps type and payload (D24)', () => {
    j.insertJob(job());
    j.appendEvent('j1', 1, 'snapshot', { costSpentUsd: '1.0000' });
    j.replaceEvent('j1', 1, 1, 'lifecycle', { level: 'error', message: 'dropped' });
    expect(j.pendingEvents('j1', 1, 5)).toMatchObject([{ seq: 1, type: 'lifecycle', payload: { level: 'error', message: 'dropped' } }]);
  });
  test('onWrite fires only after the outermost transaction commits, once, and never for a rollback (D55)', () => {
    j.insertJob(job());
    const seen: number[] = [];
    j.onWrite(() => { seen.push(j.pendingEvents('j1', 1, 10).length); });
    j.tx(() => {
      j.appendEvent('j1', 1, 'log', { stream: 'run', text: 'a' });
      j.appendEvent('j1', 1, 'log', { stream: 'run', text: 'b' });
      expect(seen).toEqual([]); // nothing announced while the transaction is open
    });
    expect(seen).toEqual([2]); // one wake-up, and the listener already sees both committed rows
    expect(() => j.tx(() => {
      j.appendEvent('j1', 1, 'log', { stream: 'run', text: 'c' });
      throw new Error('boom');
    })).toThrow('boom');
    expect(seen).toEqual([2]);
    expect(j.pendingEvents('j1', 1, 10)).toHaveLength(2);
  });
  test('onWrite fires for append and replace, and stops after unsubscribe', () => {
    j.insertJob(job());
    let n = 0;
    const off = j.onWrite(() => { n += 1; });
    j.appendEvent('j1', 1, 'log', { stream: 'run', text: 'x' });
    j.replaceEvent('j1', 1, 1, 'lifecycle', { level: 'info', message: 'y' });
    expect(n).toBe(2);
    off();
    j.appendEvent('j1', 1, 'log', { stream: 'run', text: 'z' });
    expect(n).toBe(2);
  });
});

describe('commands and abandon', () => {
  const rec = (commandId: string, result: 'ok' | 'rejected' = 'ok') => ({ commandId, jobId: 'j1', leaseEpoch: 1, type: 'ASSIGN', result, detail: result === 'ok' ? null : 'why', appliedAt: clock.toISOString() });
  test('recordCommand is first-write-wins and replays the stored result', () => {
    expect(j.recordCommand(rec('c1'))).toBe(true);
    expect(j.recordCommand(rec('c1', 'rejected'))).toBe(false);
    expect(j.getCommand('c1')).toMatchObject({ result: 'ok', detail: null });
    expect(j.getCommand('nope')).toBeNull();
  });
  test('AC-13: updateCommandOutcome changes outcome and timestamp but preserves command identity', () => {
    const appliedAt = '2026-11-20T00:00:00.000Z';
    j.recordCommand(rec('update-me'));
    j.updateCommandOutcome('update-me', { result: 'rejected', detail: 'x', appliedAt });
    expect(j.getCommand('update-me')).toMatchObject({ commandId: 'update-me', type: 'ASSIGN', jobId: 'j1', leaseEpoch: 1, result: 'rejected', detail: 'x', appliedAt });
  });
  test('AC-14: updateCommandOutcome does not insert unknown ids', () => {
    j.updateCommandOutcome('nope', { result: 'ok', detail: null, appliedAt: '2026-11-20T00:00:00.000Z' });
    expect(j.getCommand('nope')).toBeNull();
  });
  test('abandon drops that epoch only and keeps the applied-command row', () => {
    j.insertJob(job('j1', 1));
    j.insertJob(job('j1', 2));
    j.appendEvent('j1', 1, 'log', { stream: 'run', text: 'x' });
    j.appendEvent('j1', 2, 'log', { stream: 'run', text: 'y' });
    j.recordCommand(rec('c1'));
    j.abandon('j1', 1);
    expect(j.getJob('j1', 1)).toBeNull();
    expect(j.getJob('j1', 2)).not.toBeNull();
    expect(j.pendingEvents('j1', 1, 5)).toEqual([]);
    expect(j.pendingEvents('j1', 2, 5)).toHaveLength(1);
    expect(j.getCommand('c1')).not.toBeNull();
  });
});

describe('persistence and retention', () => {
  test('rows survive a reopen of the file (persist before send)', async () => {
    const path = join(await tmp.make('journal'), 'journal.db');
    const a = Journal.open(path, now);
    a.insertJob(job());
    a.appendEvent('j1', 1, 'log', { stream: 'run', text: 'kept' });
    a.setMeta('boot_id', 'b1');
    a.close();
    const b = Journal.open(path, now);
    expect(b.pendingEvents('j1', 1, 5)).toMatchObject([{ seq: 1, payload: { text: 'kept' } }]);
    expect(b.getMeta('boot_id')).toBe('b1');
    expect(b.getMeta('missing')).toBeNull();
    b.close();
  });
  test('AC-1/2/3: unacknowledged expired event is retained and replayable after reopening SQLite', async () => {
    const path = join(await tmp.make('prune-undelivered'), 'journal.db');
    const writer = Journal.open(path, now);
    writer.insertJob(job('undelivered', 1));
    writer.appendEvent('undelivered', 1, 'lifecycle', { level: 'info', message: 'terminal' });
    writer.markDone('undelivered', 1);
    clock = new Date('2026-10-09T00:00:00.000Z');

    expect(writer.prune(7)).toEqual([]);
    expect(writer.getJob('undelivered', 1)).not.toBeNull();
    writer.close();

    const reopened = Journal.open(path, now);
    expect(reopened.pendingEvents('undelivered', 1, 5)).toMatchObject([{ seq: 1, type: 'lifecycle', payload: { message: 'terminal' } }]);
    reopened.close();
  });

  test('AC-4/5/6/7: partial acknowledgements protect a job and cleanup happens once after final ack', () => {
    j.insertJob(job('partial', 1));
    j.appendEvent('partial', 1, 'log', { stream: 'run', text: 'first' });
    j.appendEvent('partial', 1, 'lifecycle', { level: 'info', message: 'terminal' });
    j.markDone('partial', 1);
    clock = new Date('2026-10-09T00:00:00.000Z');
    j.ackThrough('partial', 1, 1);

    expect(j.prune(7)).toEqual([]);
    expect(j.getJob('partial', 1)).not.toBeNull();
    expect(j.pendingEvents('partial', 1, 5).map((event) => event.seq)).toEqual([2]);

    j.ackThrough('partial', 1, 2);
    expect(j.prune(7)).toEqual([{ jobId: 'partial', leaseEpoch: 1, jobDir: '/w/.jobs/partial' }]);
    expect(j.getJob('partial', 1)).toBeNull();
    expect(j.prune(7)).toEqual([]); // reporting is once-only even before filesystem cleanup finishes
    j.completePrune('/w/.jobs/partial');
    expect(j.prune(7)).toEqual([]);
  });

  test('AC-8/9/10: younger and active jobs survive while an eligible lease is removed independently', () => {
    j.insertJob(job('young', 1));
    j.insertJob(job('active', 1));
    j.insertJob(job('eligible', 1));
    j.appendEvent('eligible', 1, 'lifecycle', { level: 'info', message: 'terminal' });
    j.markDone('eligible', 1);
    clock = new Date('2026-10-05T00:00:00.000Z');
    j.markDone('young', 1);
    clock = new Date('2026-10-09T00:00:00.000Z');
    j.ackThrough('eligible', 1, 1);

    expect(j.prune(7)).toEqual([{ jobId: 'eligible', leaseEpoch: 1, jobDir: '/w/.jobs/eligible' }]);
    expect(j.getJob('young', 1)).not.toBeNull();
    expect(j.getJob('active', 1)).not.toBeNull();
    expect(j.getJob('eligible', 1)).toBeNull();
  });

  test('AC-11 regression: an authorized cleanup blocks a new lease from claiming its directory until cleanup completes', async () => {
    const path = join(await tmp.make('prune-claim'), 'journal.db');
    const writer = Journal.open(path, now);
    writer.insertJob(job('reused', 1));
    writer.markDone('reused', 1);
    clock = new Date('2026-10-09T00:00:00.000Z');
    const cleanup = writer.prune(7);
    expect(cleanup).toEqual([{ jobId: 'reused', leaseEpoch: 1, jobDir: '/w/.jobs/reused' }]);
    writer.close();

    const reopened = Journal.open(path, now);
    // The refusal is a structured, retryable contention — never a bare failure a caller could turn into a job FAILED.
    expect(() => reopened.insertJob(job('reused', 2))).toThrow(JobDirCleanupPendingError);
    expect(reopened.prune(7)).toEqual([]); // opening another connection must not re-report an in-flight cleanup
    reopened.rearmPruneCleanup(); // only daemon startup, under home ownership, retries unfinished cleanup
    expect(() => reopened.insertJob(job('reused', 2))).toThrow(JobDirCleanupPendingError);
    expect(reopened.prune(7)).toEqual(cleanup);
    expect(reopened.prune(7)).toEqual([]);

    reopened.completePrune('/w/.jobs/reused');
    reopened.rearmPruneCleanup();
    expect(reopened.prune(7)).toEqual([]); // completed claims never return on restart
    expect(reopened.insertJob(job('reused', 2)).created).toBe(true);
    reopened.close();
  });

  test('legacy cleanup reservations migrate without releasing their directories and report only once', async () => {
    const path = join(await tmp.make('prune-legacy'), 'journal.db');
    const legacy = new Database(path, { create: true });
    legacy.exec(`CREATE TABLE prune_cleanup_claims (job_dir TEXT PRIMARY KEY, job_id TEXT NOT NULL, lease_epoch INTEGER NOT NULL);
      INSERT INTO prune_cleanup_claims VALUES ('/w/.jobs/legacy', 'legacy', 1);`);
    legacy.close();

    const migrated = Journal.open(path, now);
    const other = Journal.open(path, now);
    try {
      expect(() => migrated.insertJob(job('legacy', 2))).toThrow(JobDirCleanupPendingError);
      expect(migrated.prune(7)).toEqual([{ jobId: 'legacy', leaseEpoch: 1, jobDir: '/w/.jobs/legacy' }]);
      expect(other.prune(7)).toEqual([]);
      expect(() => other.insertJob(job('legacy', 2))).toThrow(JobDirCleanupPendingError);
      migrated.completePrune('/w/.jobs/legacy');
      expect(other.insertJob(job('legacy', 2)).created).toBe(true);
    } finally {
      other.close();
      migrated.close();
    }
  });

  test('AC-11/12: shared job directory is protected by retained epochs and returned once when both expire', () => {
    j.insertJob(job('shared', 1));
    j.insertJob({ ...job('shared', 2), jobDir: '/w/.jobs/shared' });
    j.appendEvent('shared', 1, 'lifecycle', { level: 'info', message: 'one' });
    j.appendEvent('shared', 2, 'lifecycle', { level: 'info', message: 'two' });
    j.markDone('shared', 1);
    j.markDone('shared', 2);
    clock = new Date('2026-10-09T00:00:00.000Z');
    j.ackThrough('shared', 1, 1);

    expect(j.prune(7)).toEqual([]);
    expect(j.getJob('shared', 1)).toBeNull();
    expect(j.getJob('shared', 2)).not.toBeNull();
    j.ackThrough('shared', 2, 1);
    expect(j.prune(7)).toEqual([{ jobId: 'shared', leaseEpoch: 2, jobDir: '/w/.jobs/shared' }]);
    expect(j.prune(7)).toEqual([]);
    expect(() => j.insertJob(job('shared', 3))).toThrow(JobDirCleanupPendingError);
    j.completePrune('/w/.jobs/shared');
    expect(j.prune(7)).toEqual([]);
  });
});

describe('openReadOnly (D72)', () => {
  test('reads what a writer committed, refuses every write, and creates nothing', async () => {
    const path = join(await tmp.make('ro'), 'journal.db');
    const writer = Journal.open(path, now);
    writer.insertJob(job());
    const reader = Journal.openReadOnly(path, now);
    expect(reader.getJob('j1', 1)?.state).toBe('ASSIGNED');
    expect(reader.stats().activeJobs).toBe(1);
    expect(() => reader.insertJob(job('j2'))).toThrow();
    expect(() => reader.setMeta('k', 'v')).toThrow();
    reader.close();
    writer.insertJob(job('j3'));                                          // the writer is unaffected
    writer.close();
    expect(() => Journal.openReadOnly(join(path, '..', 'missing.db'), now)).toThrow();
  });
});

describe('file permissions (SEC-1)', () => {
  test('the journal file and its WAL siblings are created 0o600, not the process umask', async () => {
    if (SKIP_FILEMODE) return;
    const path = join(await tmp.make('mode'), 'journal.db');
    const j = Journal.open(path, now);
    j.insertJob(job());
    // The -wal/-shm siblings exist only while a connection holds the WAL open; SQLite removes them on
    // the last clean close (Linux) but leaves them (macOS), so assert the mode while still open.
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(`${path}-wal`)).mode & 0o777).toBe(0o600);
    expect((await stat(`${path}-shm`)).mode & 0o777).toBe(0o600);
    j.close();
  });
});

describe('approval relay state (S1.5 §4.1, plan D278, D285)', () => {
  test('stores a receiver per (job, epoch) and pending asks per ask id', () => {
    j.putApprovalReceiver({ jobId: 'j1', leaseEpoch: 1, port: 43_210, secret: 'a'.repeat(64) });
    expect(j.getApprovalReceiver('j1', 1)).toEqual({ jobId: 'j1', leaseEpoch: 1, port: 43_210, secret: 'a'.repeat(64) });
    expect(j.getApprovalReceiver('j1', 2)).toBeNull();

    const ask = { jobId: 'j1', leaseEpoch: 1, naxAskId: 'ask-1', callbackUrl: 'http://127.0.0.1:5/nax/interact/ask-1', deadlineAt: '2026-10-04T10:10:00.000Z' };
    expect(j.insertPendingAsk(ask)).toBe(true);
    expect(j.insertPendingAsk(ask)).toBe(false);   // a re-sent nax POST is idempotent (D286)
    expect(j.getPendingAsk('j1', 1, 'ask-1')).toEqual(ask);
    j.deletePendingAsk('j1', 1, 'ask-1');
    expect(j.getPendingAsk('j1', 1, 'ask-1')).toBeNull();
  });
  test('deleteApprovalState removes one epoch only (D285)', () => {
    j.putApprovalReceiver({ jobId: 'j1', leaseEpoch: 1, port: 1, secret: 's' });
    j.putApprovalReceiver({ jobId: 'j1', leaseEpoch: 2, port: 2, secret: 's' });
    j.insertPendingAsk({ jobId: 'j1', leaseEpoch: 1, naxAskId: 'ask-1', callbackUrl: 'u', deadlineAt: 'd' });
    j.deleteApprovalState('j1', 1);
    expect(j.approvalStateKeys()).toEqual([{ jobId: 'j1', leaseEpoch: 2 }]);
    expect(j.getPendingAsk('j1', 1, 'ask-1')).toBeNull();
  });
});
