import { describe, expect, test } from 'bun:test';
import type { FleetJobKindName, SnapshotEventPayload, StateEventPayload } from '@nathapp/fleet-protocol';
import type { UploadOutcome } from '../bundle/upload-bundle';
import { Journal } from '../journal/journal';
import { createMemoryLogger } from '../logger';
import { assignFor } from '../../test/helpers/assign';
import { FakeExecutor } from '../../test/helpers/fake-executor';
import { fakeTime } from '../../test/helpers/fake-time';
import { waitFor } from '../../test/helpers/wait';
import type { EventRow } from '../journal/types';
import { JobRun, type BundleUploader, type JobRunDeps, type JobRunTuning } from './job-run';
import { RepoMutex } from './repo-mutex';

function build(command: FleetJobKindName = 'RUN', jobId = 'j1', tuning: Partial<JobRunTuning> = {}) {
  const time = fakeTime();
  const journal = Journal.open(':memory:', time.now);
  const ex = new FakeExecutor();
  const uploads: string[] = [];
  const outcomes: UploadOutcome[] = [];
  const uploader: BundleUploader = {
    upload: async (job, file) => {
      uploads.push(`${job.jobId}:${file.sha256.slice(0, 4)}`);
      return outcomes.shift() ?? { kind: 'ok' };
    },
  };
  const mutex = new RepoMutex();
  const log = createMemoryLogger();
  const deps: JobRunDeps = {
    journal, executor: ex, mutex, uploader, log, now: time.now, sleep: time.sleep,
    tuning: { statusPollMs: 2_000, killGraceMs: 30_000, ackPollMs: 250, uploadAckWaitMs: 0, ...tuning },   // 0: unit tests do not wait for acks unless they say so
  };
  journal.insertJob({ assign: assignFor(command, { jobId }), leaseEpoch: 1, repoKey: 'acme/app', jobDir: `/w/.jobs/${jobId}` });
  return { time, journal, ex, outcomes, uploads, mutex, deps, log, acked: [] as EventRow[], run: new JobRun(deps, jobId, 1) };
}
type Built = ReturnType<typeof build>;
const events = (b: Built, jobId = 'j1') => b.journal.pendingEvents(jobId, 1, 1_000);
const states = (b: Built, jobId = 'j1') => events(b, jobId).filter((e) => e.type === 'state').map((e) => e.payload as StateEventPayload);
const stateNames = (b: Built) => states(b).map((s) => s.to);
/** What the server's ack does: the events leave `pendingEvents`, so they are kept in `b.acked` for the assertions. */
const ackAll = (b: Built) => {
  const pending = events(b);
  if (pending.length === 0) return;
  b.acked.push(...pending);
  b.journal.ackThrough('j1', 1, Math.max(...pending.map((e) => e.seq)));
};
const everything = (b: Built) => [...b.acked, ...events(b)];
const everyStateName = (b: Built) => everything(b).filter((e) => e.type === 'state').map((e) => (e.payload as StateEventPayload).to);
const pendingStates = (b: Built) => events(b).filter((e) => e.type === 'state').map((e) => (e.payload as StateEventPayload).to);
const settle = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0));
const lastSnapshot = (b: Built) => events(b).filter((e) => e.type === 'snapshot').at(-1)?.payload as SnapshotEventPayload | undefined;

describe('RUN happy path (D35)', () => {
  test('RUNNING -> UPLOADING -> COMPLETED, pid recorded with RUNNING, final snapshot with the ledger result, cleanup and done', async () => {
    const b = build();
    b.ex.dieAfterTicks(2);
    await b.run.start('prepare');
    expect(stateNames(b)).toEqual(['RUNNING', 'UPLOADING', 'COMPLETED']);
    expect(b.journal.getJob('j1', 1)).toMatchObject({ state: 'COMPLETED', pid: 4242, pgid: 4242, branch: 'feat/x' });
    expect(b.journal.getJob('j1', 1)?.doneAt).not.toBeNull();
    expect(lastSnapshot(b)).toMatchObject({ naxRunId: 'run-1', finishResult: 'opened', resultPrUrl: 'https://example.test/pr/1', resultBranch: 'feat/x', resultSha: 'b'.repeat(40) });
    expect(b.uploads).toEqual(['j1:cccc']);
    expect(b.ex.calls).toEqual(expect.arrayContaining(['prepare:j1', 'spawn:j1', 'reap:j1', 'collectBundle:j1', 'cleanup:j1']));
    expect(b.mutex.isLocked('acme/app')).toBe(false);
  });
  test('the watcher runs on every poll and once more after the process is gone', async () => {
    const b = build();
    b.ex.dieAfterTicks(3);
    await b.run.start('prepare');
    expect(b.ex.ticks).toBe(4);
    expect(b.time.nowMs() - Date.parse('2026-10-01T00:00:00.000Z')).toBe(2 * 2_000);
  });
  test('run ids the watcher reports are persisted for readopt', async () => {
    const b = build();
    b.ex.onTick = (n) => {
      if (n === 1) b.ex.watchOptions[0].onRunIds?.({ naxRunId: 'run-9', logPath: '/l.jsonl' });
      if (n >= 2) b.ex.alive = false;
    };
    await b.run.start('prepare');
    expect(b.journal.getJob('j1', 1)).toMatchObject({ naxRunId: 'run-9', logPath: '/l.jsonl' });
  });
});

describe('verdicts', () => {
  test('escalated keeps nax reason', async () => {
    const b = build();
    b.ex.status = { run: { id: 'r', status: 'completed' }, postRun: { finish: { result: 'escalated', escalationReason: 'blocked by review' } } };
    b.ex.dieAfterTicks(1);
    await b.run.start('prepare');
    expect(states(b).at(-1)).toEqual({ to: 'ESCALATED', reason: 'blocked by review' });
  });
  test.each([
    ['failed', { run: { id: 'r', status: 'failed' } }, 'run status: failed'],
    ['crashed (status still running)', { run: { id: 'r', status: 'running' } }, 'run status: running'],
    ['no status.json', null, 'no status.json'],
  ])('%s is FAILED with the reason', async (_label, status, reason) => {
    const b = build();
    b.ex.status = status as never;
    b.ex.dieAfterTicks(1);
    await b.run.start('prepare');
    expect(states(b).at(-1)).toEqual({ to: 'FAILED', reason });
    expect(stateNames(b)).toEqual(['RUNNING', 'UPLOADING', 'FAILED']);
  });
});

describe('failures before the process runs', () => {
  test('a failed prepare is ASSIGNED -> FAILED with the reason, no spawn, no bundle, cleanup, done', async () => {
    const b = build();
    b.ex.prepareResult = { ok: false, reason: 'checkout: ref not found' };
    await b.run.start('prepare');
    expect(states(b)).toEqual([{ to: 'FAILED', reason: 'checkout: ref not found' }]);
    expect(b.ex.calls).toEqual(['prepare:j1', 'cleanup:j1']);
    expect(b.journal.getJob('j1', 1)?.doneAt).not.toBeNull();
    expect(b.uploads).toEqual([]);
  });
  test('a spawn that throws is FAILED with spawn failed', async () => {
    const b = build();
    b.ex.spawnError = new Error('ENOENT nax');
    await b.run.start('prepare');
    expect(states(b)).toEqual([{ to: 'FAILED', reason: 'spawn failed: ENOENT nax' }]);
  });
  test('a cancel while the job waits for the repo mutex ends ASSIGNED -> CANCELLED at once, holding nothing (D66)', async () => {
    const b = build();
    const release = await b.mutex.acquire('acme/app');            // another job holds the repo
    const started = b.run.start('prepare');
    expect(b.run.requestCancel()).toBe(true);
    // Still queued: the state event and the freed slot must already be there.
    expect(states(b)).toEqual([{ to: 'CANCELLED', reason: 'cancelled before start' }]);
    expect(b.journal.getJob('j1', 1)?.doneAt).not.toBeNull();
    expect(b.run.requestCancel()).toBe(false);
    release();
    await started;
    expect(b.ex.calls).toEqual([]);                                // never prepared, spawned or cleaned
    expect(stateNames(b)).toEqual(['CANCELLED']);
    expect(b.mutex.isLocked('acme/app')).toBe(false);
  });
  test('a cancel that lands during prepare stops before the spawn', async () => {
    const b = build();
    const originalPrepare = b.ex.prepare.bind(b.ex);
    b.ex.prepare = async (job, options) => { b.run.requestCancel(); return originalPrepare(job, options); };
    await b.run.start('prepare');
    expect(stateNames(b)).toEqual(['CANCELLED']);
    expect(b.ex.calls).not.toContain('spawn:j1');
  });
  test('prepare is given an isCancelled probe, and a prepare that reports cancelled is CANCELLED, not FAILED (D66)', async () => {
    const b = build();
    const originalPrepare = b.ex.prepare.bind(b.ex);
    let probeAfterCancel: boolean | undefined;
    b.ex.prepare = async (job, options) => {
      expect(options?.isCancelled?.()).toBe(false);
      b.run.requestCancel();
      probeAfterCancel = options?.isCancelled?.();
      await originalPrepare(job, options);
      return { ok: false, reason: 'cancelled', cancelled: true };
    };
    await b.run.start('prepare');
    expect(probeAfterCancel).toBe(true);
    expect(states(b)).toEqual([{ to: 'CANCELLED', reason: 'cancelled before start' }]);
    expect(b.ex.calls).not.toContain('spawn:j1');
  });
  test('reprepare reaps the registry before preparing again (a crash between spawn and RUNNING, D65)', async () => {
    const b = build();
    b.ex.dieAfterTicks(1);
    await b.run.start('reprepare');
    expect(b.ex.calls.slice(0, 2)).toEqual(['reap:j1', 'prepare:j1']);
    expect(stateNames(b)).toEqual(['RUNNING', 'UPLOADING', 'COMPLETED']);
  });
});

describe('cancel while running', () => {
  test('SIGTERM to the group, then the normal flow ends CANCELLED through UPLOADING with the partial bundle', async () => {
    const b = build();
    b.ex.status = { run: { id: 'r', status: 'crashed' } };       // nax writes crashed on SIGTERM
    let accepted = null as boolean | null;   // `as`: the callback below assigns it, but TS cannot see that from here
    b.ex.onTick = (n) => { if (n === 2) accepted = b.run.requestCancel(); };   // no expect here: JobRun.tick swallows a throw
    await b.run.start('prepare');
    expect(accepted).toBe(true);
    expect(b.ex.killed).toEqual([{ pgid: 4242, signal: 'SIGTERM' }]);
    expect(stateNames(b)).toEqual(['RUNNING', 'UPLOADING', 'CANCELLED']);
    expect(b.uploads).toHaveLength(1);
    expect(b.ex.calls).toContain('reap:j1');
    expect(b.journal.getJob('j1', 1)?.cancelRequestedAt).not.toBeNull();
  });
  test('a process that ignores SIGTERM is killed after the grace period', async () => {
    const b = build();
    b.ex.onKill = (signal) => { if (signal === 'SIGKILL') b.ex.alive = false; };
    b.ex.onTick = (n) => { if (n === 1) b.run.requestCancel(); };
    await b.run.start('prepare');
    expect(b.ex.killed.map((k) => k.signal)).toEqual(['SIGTERM', 'SIGKILL']);
    expect(b.time.nowMs() - Date.parse('2026-10-01T00:00:00.000Z')).toBeGreaterThanOrEqual(30_000);
    expect(states(b).at(-1)?.to).toBe('CANCELLED');
  });
  test('cancelling twice sends one SIGTERM; cancelling a finished job is refused', async () => {
    const b = build();
    b.ex.onTick = (n) => { if (n === 1) { b.run.requestCancel(); b.run.requestCancel(); } if (n >= 3) b.ex.alive = false; };
    await b.run.start('prepare');
    expect(b.ex.killed.filter((k) => k.signal === 'SIGTERM')).toHaveLength(1);
    expect(b.run.requestCancel()).toBe(false);
  });
});

describe('PLAN', () => {
  test('a valid plan is pushed while RUNNING, then bundled; the push result rides the final snapshot', async () => {
    const b = build('PLAN');
    b.ex.dieAfterTicks(1);
    await b.run.start('prepare');
    expect(stateNames(b)).toEqual(['RUNNING', 'UPLOADING', 'COMPLETED']);
    expect(b.ex.calls.indexOf('finishPlan:j1')).toBeLessThan(b.ex.calls.indexOf('collectBundle:j1'));
    expect(lastSnapshot(b)).toMatchObject({ resultBranch: 'feat/x', resultSha: 'a'.repeat(40) });
    expect(b.journal.getJob('j1', 1)).toMatchObject({ resultBranch: 'feat/x', resultSha: 'a'.repeat(40) });
  });
  test('a failed push is FAILED with its reason and the bundle is still uploaded', async () => {
    const b = build('PLAN');
    b.ex.planPush = { ok: false, reason: 'plan push failed' };
    b.ex.dieAfterTicks(1);
    await b.run.start('prepare');
    expect(states(b).at(-1)).toEqual({ to: 'FAILED', reason: 'plan push failed' });
    expect(b.uploads).toHaveLength(1);
    expect(b.journal.getJob('j1', 1)).toMatchObject({ resultBranch: null, resultSha: null });   // D77: nothing kept for a resume; a requeue re-plans
  });
  test('an invalid plan is FAILED and nothing is pushed', async () => {
    const b = build('PLAN');
    b.ex.plan = { ok: false, reason: 'prd.json has no userStories', branchName: null };
    b.ex.dieAfterTicks(1);
    await b.run.start('prepare');
    expect(states(b).at(-1)).toEqual({ to: 'FAILED', reason: 'prd.json has no userStories' });
    expect(b.ex.calls).not.toContain('finishPlan:j1');
  });
  test('a resume after the push was recorded does not push again (Review focus 5)', async () => {
    const b = build('PLAN');
    b.journal.updateJob('j1', 1, { state: 'UPLOADING', resultBranch: 'feat/x', resultSha: 'd'.repeat(40), pid: 1, pgid: 1 });
    await b.run.start('finish');
    expect(b.ex.calls).not.toContain('finishPlan:j1');
    expect(stateNames(b)).toEqual(['COMPLETED']);
    expect(lastSnapshot(b)).toMatchObject({ resultSha: 'd'.repeat(40) });
  });
  test('a cancel that lands during the PLAN push ends CANCELLED, not FAILED (review minor 2)', async () => {
    const b = build('PLAN');
    b.ex.dieAfterTicks(1);
    let sawOptions: readonly unknown[] = [];
    b.ex.finishPlan = async (job, options) => {
      sawOptions = [...b.ex.finishPlanOptions, options];
      b.run.requestCancel();
      return options?.isCancelled?.() === true ? { ok: false, reason: 'cancelled', cancelled: true } : b.ex.planPush;
    };
    await b.run.start('prepare');
    expect(sawOptions).toHaveLength(1);
    expect(states(b).at(-1)).toEqual({ to: 'CANCELLED' });   // reason null, as planVerdict words a cancel
    expect(stateNames(b)).toEqual(['RUNNING', 'UPLOADING', 'CANCELLED']);
  });
  test('a halt during the PLAN push records nothing: the probe reflects halt and the run lets go (review minor 2)', async () => {
    const b = build('PLAN');
    b.ex.dieAfterTicks(1);
    const seen: { probe: (() => boolean) | null } = { probe: null };
    b.ex.finishPlan = async (_job, options) => {
      seen.probe = options?.isCancelled ?? null;
      b.run.halt();
      return { ok: false, reason: 'cancelled', cancelled: true };
    };
    await b.run.start('prepare');
    expect(seen.probe?.()).toBe(true);
    expect(everyStateName(b)).toEqual(['RUNNING']);   // no UPLOADING, no verdict: abandon owns the job now
    expect(b.uploads).toEqual([]);
  });
});

describe('bundle outcomes (D36, D49)', () => {
  test('a failed upload ends in the verdict state with a reason; a FAILED verdict keeps its reason first', async () => {
    const ok = build();
    ok.outcomes.push({ kind: 'failed', detail: 'HTTP 500' });
    ok.ex.dieAfterTicks(1);
    await ok.run.start('prepare');
    expect(states(ok).at(-1)).toEqual({ to: 'COMPLETED', reason: 'bundle upload failed' });
    const bad = build();
    bad.outcomes.push({ kind: 'failed', detail: 'HTTP 500' });
    bad.ex.status = { run: { id: 'r', status: 'failed' } };
    bad.ex.dieAfterTicks(1);
    await bad.run.start('prepare');
    expect(states(bad).at(-1)).toEqual({ to: 'FAILED', reason: 'run status: failed; bundle upload failed' });
  });
  test('413 ends with bundle too large', async () => {
    const b = build();
    b.outcomes.push({ kind: 'too-large' });
    b.ex.dieAfterTicks(1);
    await b.run.start('prepare');
    expect(states(b).at(-1)).toEqual({ to: 'COMPLETED', reason: 'bundle too large' });
  });
  test('a stale lease parks the job: no terminal event, not done, the mutex is released', async () => {
    const b = build();
    b.outcomes.push({ kind: 'stale' });
    b.ex.dieAfterTicks(1);
    await b.run.start('prepare');
    expect(stateNames(b)).toEqual(['RUNNING', 'UPLOADING']);
    expect(b.journal.getJob('j1', 1)?.doneAt).toBeNull();
    expect(b.mutex.isLocked('acme/app')).toBe(false);
  });
  test('a bundle that cannot be built fails the upload step, not the runner', async () => {
    const b = build();
    b.ex.bundleError = new Error('tar failed');
    b.ex.dieAfterTicks(1);
    await b.run.start('prepare');
    expect(states(b).at(-1)).toEqual({ to: 'COMPLETED', reason: 'bundle upload failed' });
  });
  test('files left out of the bundle for an unsafe name are a lifecycle warning (D68)', async () => {
    const b = build();
    b.ex.bundle = { ...b.ex.bundle, skipped: ['nax-out/two\nlines.txt'] };
    b.ex.dieAfterTicks(1);
    await b.run.start('prepare');
    expect(events(b).some((e) => e.type === 'lifecycle' && JSON.stringify(e.payload).includes('left out 1 file'))).toBe(true);
    expect(states(b).at(-1)?.to).toBe('COMPLETED');
  });
  test('STYLE-3: the lifecycle warning for skipped bundle files carries the names as a structured `details` array, not a JSON-encoded string', async () => {
    const b = build();
    b.ex.bundle = { ...b.ex.bundle, skipped: ['a\nb', 'c\\d'] };
    b.ex.dieAfterTicks(1);
    await b.run.start('prepare');
    const warn = events(b).find((e) => e.type === 'lifecycle' && (e.payload as { message: string }).message.includes('left out'));
    expect(warn).toBeDefined();
    const payload = warn?.payload as { message: string; details?: unknown[] };
    expect(payload.details).toEqual(['a\nb', 'c\\d']);
    expect(payload.message).not.toContain('["a\\nb"');
  });
});

describe('the upload waits for the server to have applied UPLOADING (D60)', () => {
  /** A sleep that acks the journal on every ack-poll from the `n`-th on, like the sync loop would. */
  function withAckOnPoll(b: Built, n: number, seen: { polls: number }): JobRun {
    const sleep = async (ms: number) => {
      await b.time.sleep(ms);
      if (ms === 250) {
        seen.polls += 1;
        if (seen.polls >= n) ackAll(b);
      }
    };
    return new JobRun({ ...b.deps, sleep }, 'j1', 1);
  }
  test('polls until the UPLOADING event is acked, then uploads exactly once', async () => {
    const b = build('RUN', 'j1', { uploadAckWaitMs: 60_000 });
    let pendingAtUpload: string[] = [];
    const uploader: BundleUploader = { upload: async () => { pendingAtUpload = pendingStates(b); b.uploads.push('j1'); return { kind: 'ok' }; } };
    const seen = { polls: 0 };
    b.ex.dieAfterTicks(1);
    const run = withAckOnPoll({ ...b, deps: { ...b.deps, uploader } } as Built, 3, seen);
    await run.start('prepare');
    expect(seen.polls).toBe(3);
    expect(pendingAtUpload).not.toContain('UPLOADING');           // the ack had covered it
    expect(b.uploads).toEqual(['j1']);
    expect(everyStateName(b)).toEqual(['RUNNING', 'UPLOADING', 'COMPLETED']);
  });
  test('gives up waiting after the bound, warns, and uploads anyway', async () => {
    const b = build('RUN', 'j1', { uploadAckWaitMs: 1_000 });
    b.ex.dieAfterTicks(1);
    await b.run.start('prepare');                                  // nobody acks
    expect(b.uploads).toHaveLength(1);
    expect(events(b).some((e) => e.type === 'lifecycle' && JSON.stringify(e.payload).includes('not acked in time'))).toBe(true);
    expect(states(b).at(-1)?.to).toBe('COMPLETED');
  });
  test('a state-conflict is retried once after the pending events are acked, and then the verdict stands', async () => {
    const b = build('RUN', 'j1', { uploadAckWaitMs: 60_000 });
    b.outcomes.push({ kind: 'state-conflict', detail: 'The job is ASSIGNED; this action is not allowed' }, { kind: 'ok' });
    b.ex.dieAfterTicks(1);
    const seen = { polls: 0 };
    await withAckOnPoll(b, 1, seen).start('prepare');
    expect(b.uploads).toHaveLength(2);
    expect(everything(b).some((e) => e.type === 'lifecycle' && JSON.stringify(e.payload).includes('retrying after the next ack'))).toBe(true);
    expect(everyStateName(b).at(-1)).toBe('COMPLETED');
  });
  test('a second state-conflict ends the job locally: lifecycle error, no terminal event, done, slot released', async () => {
    const b = build('RUN', 'j1', { uploadAckWaitMs: 60_000 });
    const conflict: UploadOutcome = { kind: 'state-conflict', detail: 'The job is COMPLETED; this action is not allowed' };
    b.outcomes.push(conflict, conflict);
    b.ex.dieAfterTicks(1);
    await withAckOnPoll(b, 1, { polls: 0 }).start('prepare');
    expect(b.uploads).toHaveLength(2);
    expect(everyStateName(b)).toEqual(['RUNNING', 'UPLOADING']);   // no COMPLETED, no FAILED
    expect(everything(b).filter((e) => e.type === 'lifecycle' && (e.payload as { level: string }).level === 'error')).toHaveLength(1);
    expect(b.journal.getJob('j1', 1)?.doneAt).not.toBeNull();
    expect(b.journal.activeCount()).toBe(0);
    expect(b.ex.calls).toContain('cleanup:j1');
    expect(b.mutex.isLocked('acme/app')).toBe(false);
  });
});

describe('runner errors', () => {
  test('an exception while RUNNING goes through UPLOADING to FAILED with a reason', async () => {
    const b = build();
    b.ex.statusError = new Error('disk vanished');
    b.ex.dieAfterTicks(1);
    await b.run.start('prepare');
    expect(stateNames(b)).toEqual(['RUNNING', 'UPLOADING', 'FAILED']);
    expect(states(b).at(-1)?.reason).toBe('runner error: disk vanished');
    expect(b.journal.getJob('j1', 1)?.doneAt).not.toBeNull();
  });
  test('a runner error with the nax still alive kills its group before reaping and failing the job (D65)', async () => {
    const b = build();
    const run = new JobRun({ ...b.deps, sleep: async () => { throw new Error('clock exploded'); } }, 'j1', 1);
    b.ex.onTick = () => undefined;                                  // nax never exits on its own
    await run.start('prepare');
    expect(b.ex.killed).toEqual([{ pgid: 4242, signal: 'SIGKILL' }]);
    expect(b.ex.calls.indexOf('reap:j1')).toBeGreaterThan(-1);
    expect(stateNames(b)).toEqual(['RUNNING', 'UPLOADING', 'FAILED']);
    expect(states(b).at(-1)?.reason).toBe('runner error: clock exploded');
  });
  test('a runner error whose pid is not this job\'s nax (recycled) signals nothing', async () => {
    const b = build();
    b.ex.procMatches = false;
    const run = new JobRun({ ...b.deps, sleep: async () => { throw new Error('clock exploded'); } }, 'j1', 1);
    b.ex.onTick = () => undefined;
    await run.start('prepare');
    expect(b.ex.killed).toEqual([]);
    expect(states(b).at(-1)?.to).toBe('FAILED');
  });
  test('a watcher that throws is logged as a lifecycle warning and the job continues', async () => {
    const b = build();
    b.ex.onTick = (n) => { if (n === 1) throw new Error('bad tick'); if (n >= 3) b.ex.alive = false; };
    await b.run.start('prepare');
    expect(events(b).some((e) => e.type === 'lifecycle' && JSON.stringify(e.payload).includes('watcher error: bad tick'))).toBe(true);
    expect(states(b).at(-1)?.to).toBe('COMPLETED');
  });
});

describe('resume (readopt)', () => {
  test('watch attaches with startAtEnd and never re-runs prepare or spawn; a cancel recorded while down is re-sent', async () => {
    const b = build();
    b.journal.updateJob('j1', 1, { state: 'RUNNING', pid: 4242, pgid: 4242, naxRunId: 'run-1', cancelRequestedAt: '2026-10-01T00:00:00.000Z' });
    b.ex.alive = true;
    b.ex.status = { run: { id: 'run-1', status: 'crashed' } };
    b.ex.dieAfterTicks(2);
    await b.run.start('watch');
    expect(b.ex.watchOptions[0].startAtEnd).toBe(true);
    expect(b.ex.calls).not.toContain('prepare:j1');
    expect(b.ex.calls).not.toContain('spawn:j1');
    expect(b.ex.killed[0]).toEqual({ pgid: 4242, signal: 'SIGTERM' });
    expect(stateNames(b)).toEqual(['UPLOADING', 'CANCELLED']);
  });
  test('BUG-2: a RUNNING row with pid=null fails safely instead of uploading a partial bundle', async () => {
    const b = build();
    b.journal.updateJob('j1', 1, { state: 'RUNNING' });   // pid stays null: journal corruption / missed patch
    await b.run.start('watch');
    expect(stateNames(b)).toEqual(['UPLOADING', 'FAILED']);
    expect(states(b).at(-1)?.reason).toBe('runner error: pid missing on RUNNING row');
    expect(b.uploads).toEqual([]);
    expect(b.ex.calls).toContain('cleanup:j1');
    expect(b.journal.getJob('j1', 1)?.doneAt).not.toBeNull();
  });
  test('BUG-4: failSafe with pid=null skips reap (no stale .nax-pids SIGKILL)', async () => {
    const b = build();
    // trigger failSafe via the same RUNNING-no-pid path; b.ex.calls records reap vs cleanup
    b.journal.updateJob('j1', 1, { state: 'RUNNING' });
    await b.run.start('watch');
    expect(b.ex.calls).not.toContain('reap:j1');
    expect(b.ex.calls).toContain('cleanup:j1');
  });
  test('finish from UPLOADING does not emit UPLOADING again', async () => {
    const b = build();
    b.journal.updateJob('j1', 1, { state: 'UPLOADING', pid: 4242, pgid: 4242 });
    await b.run.start('finish');
    expect(stateNames(b)).toEqual(['COMPLETED']);
    expect(events(b).some((e) => e.type === 'lifecycle')).toBe(false);
  });
  test('a job whose terminal event was journaled before the crash is only cleaned up', async () => {
    const b = build();
    b.journal.updateJob('j1', 1, { state: 'COMPLETED' });
    await b.run.start('finish');
    expect(b.uploads).toEqual([]);
    expect(b.ex.calls).toEqual(['cleanup:j1']);
    expect(b.journal.getJob('j1', 1)?.doneAt).not.toBeNull();
  });
});

describe('abandon and halt', () => {
  test('abandon kills a group that is still this job, drops the epoch and stops the run quietly', async () => {
    const b = build();
    b.ex.onTick = () => undefined;
    const running = b.run.start('prepare');
    await waitFor(() => b.ex.calls.includes('spawn:j1') && b.ex.ticks >= 1);
    await b.run.abandon();
    await running;
    expect(b.ex.killed).toEqual([{ pgid: 4242, signal: 'SIGKILL' }]);
    expect(b.journal.getJob('j1', 1)).toBeNull();
    expect(b.journal.pendingEvents('j1', 1, 100)).toEqual([]);
    expect(b.uploads).toEqual([]);
    expect(b.ex.calls).toContain('cleanup:j1');
  });
  test('abandon of a lower epoch kills its group but leaves the reap and the profile to the live higher epoch (D64)', async () => {
    const b = build();
    b.ex.onTick = () => undefined;
    const running = b.run.start('prepare');
    await waitFor(() => b.ex.calls.includes('spawn:j1') && b.ex.ticks >= 1);
    b.journal.insertJob({ assign: assignFor('RUN'), leaseEpoch: 2, repoKey: 'acme/app', jobDir: '/w/.jobs/j1' });   // the requeued attempt
    const callsBefore = b.ex.calls.length;
    await b.run.abandon();
    await running;
    expect(b.ex.killed).toEqual([{ pgid: 4242, signal: 'SIGKILL' }]);       // that pid is epoch 1's
    expect(b.ex.calls.slice(callsBefore)).toEqual(['releaseCredentials:j1']);   // D90: epoch 1's socket closes; no reap, no cleanup
    expect(b.journal.getJob('j1', 1)).toBeNull();
    expect(b.journal.getJob('j1', 2)).not.toBeNull();
  });
  test('abandon waits for the repo mutex (D64): cleanup never overlaps another job\'s prepare', async () => {
    const b = build();
    b.ex.onTick = () => undefined;
    const running = b.run.start('prepare');
    await waitFor(() => b.ex.ticks >= 1);
    const outsider = b.mutex.acquire('acme/app');                              // another job queued behind the running one
    let abandoned = false;
    const done = b.run.abandon().then(() => { abandoned = true; });           // halts the run; its cleanup queues after the outsider
    await running;                                                             // the halted run lets go of the repo ...
    const release = await outsider;                                            // ... and the other job now holds it
    await settle();
    expect(abandoned).toBe(false);
    expect(b.ex.calls).not.toContain('cleanup:j1');
    release();
    await done;
    expect(abandoned).toBe(true);
    expect(b.ex.calls).toContain('cleanup:j1');
  });
  test('an abandon during a prepare that is waiting for its first token ends the wait at once (the halt isCancelled fires), with no transition', async () => {
    const b = build();
    const waitStartMs = b.time.nowMs();
    const deadline = waitStartMs + 120_000;                        // the real tokenWaitMs: the fenced server never mints
    let polls = 0;
    const originalPrepare = b.ex.prepare.bind(b.ex);
    b.ex.prepare = async (job, options) => {                       // mimics the broker's firstToken poll loop
      await originalPrepare(job, options);
      for (;;) {
        if (options?.isCancelled?.()) return { ok: false, reason: 'cancelled', cancelled: true };
        if (b.time.nowMs() >= deadline) return { ok: false, reason: 'git token: timeout' };
        polls += 1;
        await b.time.sleep(250);
      }
    };
    const started = b.run.start('prepare');
    await waitFor(() => polls >= 1);                               // the prepare is inside its token wait, holding the repo mutex
    await b.run.abandon();                                         // sets halted, then waits on the mutex the prepare holds
    await started;
    expect(b.time.nowMs()).toBeLessThan(deadline);                 // the wait ended at the next poll, not at tokenWaitMs
    expect(states(b)).toEqual([]);                                 // a halted prepare's outcome is discarded without a transition
    expect(b.ex.calls).toContain('prepare:j1');
    expect(b.ex.calls).not.toContain('spawn:j1');
    expect(b.journal.getJob('j1', 1)).toBeNull();                  // the abandon still completed its cleanup
    expect(b.mutex.isLocked('acme/app')).toBe(false);
  });
  test('a recycled pid (not this job) is not signalled on abandon', async () => {
    const b = build();
    const running = b.run.start('prepare');
    await waitFor(() => b.ex.ticks >= 1);
    b.ex.procMatches = false;
    await b.run.abandon();
    await running;
    expect(b.ex.killed).toEqual([]);
  });
  test('halt stops emitting and leaves the child alone', async () => {
    const b = build();
    const running = b.run.start('prepare');
    await waitFor(() => b.ex.ticks >= 1);
    b.run.halt();
    await running;
    expect(b.ex.killed).toEqual([]);
    expect(stateNames(b)).toEqual(['RUNNING']);
    expect(b.journal.getJob('j1', 1)?.doneAt).toBeNull();
  });
});

describe('git credentials across a restart (D90)', () => {
  test('a watch start restores the job\'s credentials before the first watcher tick', async () => {
    const b = build();
    b.journal.updateJob('j1', 1, { state: 'RUNNING', pid: 4242, pgid: 4242 });
    b.ex.alive = true;
    let restoredFirst = false;
    b.ex.onTick = (n) => {
      if (n === 1) restoredFirst = b.ex.calls.includes('resumeCredentials:j1');
      if (n >= 1) b.ex.alive = false;
    };
    await b.run.start('watch');
    expect(restoredFirst).toBe(true);
  });
  test('a prepare start does not resume (prepare acquires them itself)', async () => {
    const b = build();
    b.ex.dieAfterTicks(1);
    await b.run.start('prepare');
    expect(b.ex.calls).not.toContain('resumeCredentials:j1');
  });
  test('a failing resume is a warning and the run is still watched to its end', async () => {
    const b = build();
    b.journal.updateJob('j1', 1, { state: 'RUNNING', pid: 4242, pgid: 4242 });
    b.ex.alive = true;
    b.ex.resumeError = new Error('socket dir gone');
    b.ex.dieAfterTicks(1);
    await b.run.start('watch');
    expect(events(b).some((e) => e.type === 'lifecycle' && JSON.stringify(e.payload).includes('git credentials could not be restored'))).toBe(true);
    expect(stateNames(b)).toEqual(['UPLOADING', 'COMPLETED']);
  });
  test('abandon releases this epoch\'s credentials', async () => {
    const b = build();
    b.ex.onTick = () => undefined;
    const running = b.run.start('prepare');
    await waitFor(() => b.ex.calls.includes('spawn:j1') && b.ex.ticks >= 1);
    await b.run.abandon();
    await running;
    expect(b.ex.calls).toContain('releaseCredentials:j1');
  });
});

describe('two jobs on one repo', () => {
  test('the second job does not prepare until the first has cleaned up', async () => {
    const first = build('RUN', 'j1');
    first.ex.dieAfterTicks(1);
    const journal = first.journal;
    journal.insertJob({ assign: assignFor('RUN', { jobId: 'j2', feature: 'other' }), leaseEpoch: 1, repoKey: 'acme/app', jobDir: '/w/.jobs/j2' });
    const second = new JobRun({ ...first.deps }, 'j2', 1);
    const a = first.run.start('prepare');
    const b = second.start('prepare');
    await Promise.all([a, b]);
    const order = first.ex.calls.filter((c) => /^(prepare|cleanup):/.test(c));
    expect(order).toEqual(['prepare:j1', 'cleanup:j1', 'prepare:j2', 'cleanup:j2']);
  });
});
