import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import type { AssignPayload } from '@nathapp/fleet-protocol';
import { makeTempDirs } from '../../test/helpers/tmp';
import { Journal } from './journal';

const SKIP_FILEMODE = process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0);

const assign = (jobId = 'j1'): AssignPayload => ({
  jobId, command: 'RUN', repo: { provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'main', cloneUrl: 'https://github.com/acme/app.git' },
  ref: 'main', feature: 'feat', planFrom: null, profiles: [], maxCostUsd: '5', bashMode: 'raw', gitIdentity: { name: 'bot', email: 'bot@x' },
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
  test('prune uses done_at (journal state), not file times, and returns the job dirs to delete', () => {
    j.insertJob(job('old', 1));
    j.insertJob(job('fresh', 1));
    j.insertJob(job('running', 1));
    j.appendEvent('old', 1, 'log', { stream: 'run', text: 'x' });
    j.markDone('old', 1);
    clock = new Date('2026-10-05T00:00:00.000Z');
    j.markDone('fresh', 1);
    clock = new Date('2026-10-09T00:00:00.000Z'); // old is 8 days done, fresh 4
    expect(j.prune(7)).toEqual([{ jobId: 'old', leaseEpoch: 1, jobDir: '/w/.jobs/old' }]);
    expect(j.getJob('old', 1)).toBeNull();
    expect(j.pendingEvents('old', 1, 5)).toEqual([]);
    expect(j.getJob('fresh', 1)).not.toBeNull();
    expect(j.getJob('running', 1)).not.toBeNull();
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

describe('schema migration (MIG-1)', () => {
  test('an old journal without last_push_attempt_at is upgraded in place', async () => {
    const path = join(await tmp.make('migrate'), 'journal.db');
    const old = new Database(path, { create: true });
    old.exec(`CREATE TABLE jobs (
      job_id TEXT NOT NULL, lease_epoch INTEGER NOT NULL, command TEXT NOT NULL, state TEXT NOT NULL,
      repo_key TEXT NOT NULL, branch TEXT, pid INTEGER, pgid INTEGER, nax_run_id TEXT, log_path TEXT,
      job_dir TEXT NOT NULL, assign_json TEXT NOT NULL, cancel_requested_at TEXT, result_branch TEXT,
      result_sha TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, done_at TEXT,
      PRIMARY KEY (job_id, lease_epoch));`);
    old.query('INSERT INTO jobs (job_id, lease_epoch, command, state, repo_key, job_dir, assign_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run('j1', 1, 'PLAN', 'FAILED', 'acme/app', '/w/.jobs/j1', JSON.stringify(assign()), 't', 't');
    old.close();

    const upgraded = Journal.open(path, now);
    expect(upgraded.getJob('j1', 1)?.lastPushAttemptAt).toBeNull();
    const patched = upgraded.updateJob('j1', 1, { lastPushAttemptAt: '2026-10-01T00:00:01.000Z' });
    expect(patched?.lastPushAttemptAt).toBe('2026-10-01T00:00:01.000Z');
    upgraded.close();
  });
});
