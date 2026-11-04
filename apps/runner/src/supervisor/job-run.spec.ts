import { afterAll, describe, expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AssignPayload, FleetJobKindName, SnapshotEventPayload, StateEventPayload } from '@nathapp/fleet-protocol';
import type { UploadOutcome } from '../bundle/upload-bundle';
import { LogShipper } from '../logs/log-shipper';
import { Journal } from '../journal/journal';
import { createMemoryLogger } from '../logger';
import { systemSleep } from '../time';
import { assignFor } from '../../test/helpers/assign';
import { FakeExecutor } from '../../test/helpers/fake-executor';
import { fakeLogServer } from '../../test/helpers/fake-log-server';
import { FakeLogShipping } from '../../test/helpers/fake-log-shipping';
import { fakeTime } from '../../test/helpers/fake-time';
import { makeTempDirs } from '../../test/helpers/tmp';
import { waitFor } from '../../test/helpers/wait';
import type { EventRow } from '../journal/types';
import { JobRun, type BundleUploader, type JobRunDeps, type JobRunTuning } from './job-run';
import { RepoMutex } from './repo-mutex';

function build(command: FleetJobKindName = 'RUN', jobId = 'j1', tuning: Partial<JobRunTuning> = {}, assign: Partial<AssignPayload> = {}) {
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
  const logs = new FakeLogShipping();
  const deps: JobRunDeps = {
    journal, executor: ex, mutex, uploader, log, now: time.now, sleep: time.sleep,
    tuning: { statusPollMs: 2_000, killGraceMs: 30_000, ackPollMs: 250, uploadAckWaitMs: 0, logDrainTimeoutMs: 120_000, ...tuning },   // 0: unit tests do not wait for acks unless they say so
    logs,
  };
  journal.insertJob({ assign: assignFor(command, { ...assign, jobId }), leaseEpoch: 1, repoKey: 'acme/app', jobDir: `/w/.jobs/${jobId}` });
  return { time, journal, ex, outcomes, uploads, mutex, deps, log, logs, acked: [] as EventRow[], run: new JobRun(deps, jobId, 1) };
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
const inOrder = (all: string[], wanted: string[]) => wanted.every((s, i) => all.indexOf(s) >= 0 && (i === 0 || all.indexOf(s) > all.indexOf(wanted[i - 1])));
const lifecycles = (b: Built) => everything(b).filter((e) => e.type === 'lifecycle').map((e) => e.payload as { level: string; message: string });
const tmpLogs = makeTempDirs();
afterAll(() => tmpLogs.cleanup());

describe('readopted process identity (US-003)', () => {
  test('AC-5: stops a readopted watch when the pid belongs to another process', async () => {
    const b = build();
    b.ex.alive = true;
    b.journal.updateJob('j1', 1, { state: 'RUNNING', pid: 4242, pgid: 4242 });
    b.ex.procMatches = false;
    await b.run.start('watch');
    expect(b.ex.alive).toBe(true);
    expect(b.ex.ticks).toBe(2);
  });

  test('AC-6: checks identity after each live watch tick', async () => {
    const b = build();
    b.ex.alive = true;
    b.journal.updateJob('j1', 1, { state: 'RUNNING', pid: 4242, pgid: 4242 });
    let identityChecks = 0;
    const processIdentity = b.ex.processIdentity.bind(b.ex);
    b.ex.processIdentity = async (job) => { identityChecks += 1; return processIdentity(job); };
    b.ex.dieAfterTicks(4);
    await b.run.start('watch');
    expect(identityChecks).toBe(3);
  });

  test('AC-7: unknown identity fails closed and continues until liveness ends', async () => {
    const b = build();
    b.ex.alive = true;
    b.journal.updateJob('j1', 1, { state: 'RUNNING', pid: 4242, pgid: 4242 });
    b.ex.identityUnknown = true;
    let identityChecks = 0;
    const processIdentity = b.ex.processIdentity.bind(b.ex);
    b.ex.processIdentity = async (job) => { identityChecks += 1; return processIdentity(job); };
    const started = b.run.start('watch');
    await waitFor(() => b.ex.ticks >= 5);
    expect(b.journal.getJob('j1', 1)?.doneAt).toBeNull();
    expect(identityChecks).toBeGreaterThanOrEqual(5);
    b.ex.alive = false;
    await started;
    expect(b.journal.getJob('j1', 1)?.doneAt).not.toBeNull();
  });

  test('AC-8: does not check identity for a process spawned here', async () => {
    const b = build();
    b.ex.aliveAfterSpawn = true;
    let checks = 0;
    b.ex.processIdentity = async () => { checks += 1; return 'ours'; };
    b.ex.dieAfterTicks(4);
    await b.run.start('prepare');
    expect(checks).toBe(0);
  });

  test('AC-9: does not chain a FIX step after a readopted pid is identified as other', async () => {
    const b = build('FIX');
    b.ex.alive = true;
    b.journal.updateJob('j1', 1, { state: 'RUNNING', pid: 4242, pgid: 4242 });
    b.ex.procMatches = false;
    await b.run.start('watch');
    expect(b.ex.calls).not.toContain('spawnFixStep:j1');
  });
});

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

describe('REVIEW verdicts (US-007)', () => {
  test('posted review completes without reading status and reports ledger cost', async () => {
    const b = build('REVIEW');
    b.ex.reviewPosted = true;
    b.ex.planCost = '0.0421';
    b.ex.dieAfterTicks(1);
    await b.run.start('prepare');
    expect(states(b).at(-1)?.to).toBe('COMPLETED');
    expect(lastSnapshot(b)?.costSpentUsd).toBe('0.0421');
    expect(b.ex.calls).not.toContain('readStatus:j1');
  });

  test('unposted review fails with review not posted', async () => {
    const b = build('REVIEW');
    b.ex.reviewPosted = false;
    b.ex.dieAfterTicks(1);
    await b.run.start('prepare');
    expect(states(b).at(-1)).toEqual({ to: 'FAILED', reason: 'review not posted' });
  });

  test('cancel takes precedence over a posted review', async () => {
    const b = build('REVIEW');
    b.ex.reviewPosted = true;
    b.ex.onTick = () => { b.run.requestCancel(); b.ex.alive = false; };
    await b.run.start('prepare');
    expect(states(b).at(-1)?.to).toBe('CANCELLED');
  });

  test('cancel remains CANCELLED if reading the posted marker would throw', async () => {
    const b = build('REVIEW');
    b.ex.reviewPostedError = new Error('stdout unreadable');
    b.ex.onTick = () => { b.run.requestCancel(); b.ex.alive = false; };
    await b.run.start('prepare');
    expect(states(b).at(-1)?.to).toBe('CANCELLED');
    expect(b.ex.calls).not.toContain('readReviewPosted:j1');
  });
});

describe('FIX step chaining (US-010)', () => {
  function fix(maxCostUsd = '5') {
    const b = build('FIX', 'j1', {}, { maxCostUsd });
    b.ex.reviewPosted = true;
    b.ex.planCost = '0.0100';
    b.ex.fixOutcome = { kind: 'pushed', logPath: null, pushedSha: null, stderrLine: null };
    b.ex.dieAfterTicks(1);
    return b;
  }

  function pendingFix(b: Built) {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const spawn = b.ex.spawnFixStep.bind(b.ex);
    b.ex.spawnFixStep = async (row) => {
      b.ex.calls.push('fix-pending');
      await pending;
      return spawn(row);
    };
    return release;
  }

  async function reachedHandoff(b: Built): Promise<void> {
    await waitFor(() => b.ex.calls.includes('fix-pending') || b.journal.getJob('j1', 1)?.doneAt !== null);
    expect(b.ex.calls).toContain('fix-pending');
  }

  test.each(['prepare', 'reprepare'] as const)('AC-1: %s chains exactly once and journals the new process', async (from) => {
    const b = fix();
    await b.run.start(from);
    expect(b.ex.calls.filter((call) => call === 'spawnFixStep:j1')).toHaveLength(1);
    expect(b.journal.getJob('j1', 1)).toMatchObject({ pid: 4343, pgid: 4343 });
    expect(b.ex.calls.filter((call) => call === 'spawn:j1')).toHaveLength(1);
  });

  test('AC-2: the fix stays RUNNING until its own process exits', async () => {
    const b = fix();
    const release = pendingFix(b);
    let fixTickState: string | undefined;
    b.ex.onTick = () => {
      if (!b.ex.calls.includes('spawnFixStep:j1')) b.ex.alive = false;
      else fixTickState = b.journal.getJob('j1', 1)?.state;
    };
    const started = b.run.start('prepare');
    await reachedHandoff(b);
    release();
    await waitFor(() => b.ex.ticks >= 2);
    expect(fixTickState).toBe('RUNNING');
    expect(stateNames(b)).toEqual(['RUNNING']);
    expect(b.uploads).toEqual([]);
    b.ex.alive = false;
    await started;
    expect(stateNames(b)).toEqual(['RUNNING', 'UPLOADING', 'COMPLETED']);
    expect(b.uploads).toHaveLength(1);
  });

  test('AC-3: an unposted review never chains', async () => {
    const b = fix();
    b.ex.reviewPosted = false;
    await b.run.start('prepare');
    expect(b.ex.calls).not.toContain('spawnFixStep:j1');
    expect(states(b).at(-1)).toEqual({ to: 'FAILED', reason: 'review not posted' });
  });

  test('AC-4: exact exhausted review budget never chains', async () => {
    const b = fix('0.05');
    b.ex.planCost = '0.0500';
    await b.run.start('prepare');
    expect(b.ex.calls).not.toContain('spawnFixStep:j1');
    expect(stateNames(b)).toContain('UPLOADING');
  });

  test('AC-5: unreadable review marker never chains and means review not posted', async () => {
    const b = fix();
    b.ex.reviewPostedError = new Error('stdout unreadable');
    await b.run.start('prepare');
    expect(b.ex.calls).not.toContain('spawnFixStep:j1');
    expect(states(b).at(-1)).toEqual({ to: 'FAILED', reason: 'review not posted' });
    expect(b.uploads).toHaveLength(1);
  });

  test('AC-6: cancel observed during review prevents chaining', async () => {
    const b = fix();
    b.ex.onTick = () => { b.run.requestCancel(); b.ex.alive = false; };
    await b.run.start('prepare');
    expect(b.ex.calls).not.toContain('spawnFixStep:j1');
    expect(states(b).at(-1)?.to).toBe('CANCELLED');
  });

  test.each(['watch', 'finish'] as const)('AC-7: readopt %s never starts a fix', async (from) => {
    const b = fix();
    b.ex.alive = true;
    b.journal.updateJob('j1', 1, { state: 'RUNNING', pid: 4242, pgid: 4242 });
    await b.run.start(from);
    expect(b.ex.calls).not.toContain('spawnFixStep:j1');
    expect(b.ex.calls).not.toContain('spawn:j1');
    expect(states(b).at(-1)).toEqual({ to: 'FAILED', reason: 'interrupted before fix' });
  });

  test('AC-8: a cancel during pending spawn signals the old and the newly journaled groups', async () => {
    const b = fix();
    const release = pendingFix(b);
    const started = b.run.start('prepare');
    await reachedHandoff(b);
    b.run.requestCancel();
    expect(b.ex.killed).toEqual([{ pgid: 4242, signal: 'SIGTERM' }]);
    let rowAtFixSignal: { pid: number | null; pgid: number | null } | undefined;
    b.ex.onKill = () => {
      rowAtFixSignal = b.journal.getJob('j1', 1) ?? undefined;
      b.ex.alive = false;
    };
    release();
    await started;
    expect(b.ex.killed).toEqual([{ pgid: 4242, signal: 'SIGTERM' }, { pgid: 4343, signal: 'SIGTERM' }]);
    expect(rowAtFixSignal).toMatchObject({ pid: 4343, pgid: 4343 });
    expect(states(b).at(-1)?.to).toBe('CANCELLED');
  });

  test('AC-9: prior SIGKILL history is reset so the new group gets its own kill grace', async () => {
    const b = fix();
    const release = pendingFix(b);
    const signals: Array<{ signal: string; at: number }> = [];
    b.ex.onKill = (signal) => {
      signals.push({ signal, at: b.time.nowMs() });
      if (signal === 'SIGKILL') b.ex.alive = false;
    };
    b.ex.onTick = () => {
      if (b.ex.killed.some((kill) => kill.pgid === 4242 && kill.signal === 'SIGKILL')) {
        // Simulate prior signal history at a process handoff, NOT permission to chain a cancelled job.
        // AC-6 separately enforces that a still-observed cancel must suppress the spawn.
        b.journal.updateJob('j1', 1, { cancelRequestedAt: null });
      } else b.run.requestCancel();
    };
    const started = b.run.start('prepare');
    await reachedHandoff(b);
    expect(b.ex.killed).toEqual([{ pgid: 4242, signal: 'SIGTERM' }, { pgid: 4242, signal: 'SIGKILL' }]);
    b.ex.onTick = () => {
      // Bound a regression's watch loop without making the missing signal pass.
      if (b.time.nowMs() - signals[1].at > 90_000) b.ex.alive = false;
    };
    b.run.requestCancel();
    release();
    await started;
    expect(b.ex.killed.slice(2)).toEqual([{ pgid: 4343, signal: 'SIGTERM' }, { pgid: 4343, signal: 'SIGKILL' }]);
    expect(signals[3].at - signals[2].at).toBeGreaterThanOrEqual(30_000);
    expect(states(b).at(-1)?.to).toBe('CANCELLED');
  });

  test.each(['stop', 'abandon'] as const)('AC-10: %s during pending spawn records the new handle before returning', async (halt) => {
    const b = fix();
    const release = pendingFix(b);
    const started = b.run.start('prepare');
    await reachedHandoff(b);
    const killedRows: Array<number | null> = [];
    b.ex.matchesProcess = async (row) => { killedRows.push(row.pid); return b.ex.alive; };
    expect(stateNames(b)).toEqual(['RUNNING']);
    const abandoned = halt === 'abandon' ? b.run.abandon() : undefined;
    if (halt === 'stop') b.run.halt();
    release();
    await started;
    if (abandoned) {
      await abandoned;
      expect(killedRows).toEqual([4343]);
      expect(b.ex.killed).toEqual([{ pgid: 4343, signal: 'SIGKILL' }]);
    } else {
      expect(b.journal.getJob('j1', 1)).toMatchObject({ pid: 4343, pgid: 4343, state: 'RUNNING', doneAt: null });
      expect(b.ex.killed).toEqual([]);
    }
    // Journal.abandon removes the row and its events after cleanup.
    expect(stateNames(b)).toEqual(halt === 'abandon' ? [] : ['RUNNING']);
    expect(b.uploads).toEqual([]);
    expect(b.mutex.isLocked('acme/app')).toBe(false);
  });

  test('AC-11: a failed fix spawn is held for judging, never retried or sent to failSafe', async () => {
    const b = fix();
    b.ex.spawnFixStepError = new Error('git token: none');
    await b.run.start('prepare');
    expect(b.ex.calls.filter((call) => call === 'spawnFixStep:j1')).toHaveLength(1);
    expect(stateNames(b)).toEqual(['RUNNING', 'UPLOADING', 'FAILED']);
    expect(states(b).at(-1)).toEqual({ to: 'FAILED', reason: 'fix spawn failed: git token: none' });
    expect(b.uploads).toHaveLength(1);
    expect(b.log.lines.some((entry) => entry.message === 'job run failed')).toBe(false);
  });

  test('AC-12: an undefined cost ledger suppresses chaining', async () => {
    const b = fix();
    b.ex.planCost = undefined;
    await b.run.start('prepare');
    expect(b.ex.calls).not.toContain('spawnFixStep:j1');
    expect(stateNames(b)).toContain('UPLOADING');
  });

  test('AC-13: REVIEW remains a single-process lifecycle', async () => {
    const b = build('REVIEW');
    b.ex.reviewPosted = true;
    b.ex.dieAfterTicks(1);
    await b.run.start('prepare');
    expect(stateNames(b)).toEqual(['RUNNING', 'UPLOADING', 'COMPLETED']);
    expect(b.ex.calls).not.toContain('spawnFixStep:j1');
    expect(b.ex.calls).not.toContain('hasFixStep:j1');
    expect(b.ex.calls.filter((call) => call === 'spawn:j1')).toHaveLength(1);
  });

  test('an existing fix marker suppresses another fix, even in a fresh lifecycle', async () => {
    const b = fix();
    b.ex.fixStepStarted = true;
    await b.run.start('prepare');
    expect(b.ex.calls).not.toContain('spawnFixStep:j1');
    expect(stateNames(b)).toEqual(['RUNNING', 'UPLOADING', 'COMPLETED']);
  });

  test('a cancel landing during the chaining file reads still suppresses spawn', async () => {
    const b = fix();
    b.ex.readPlanCost = async () => { b.run.requestCancel(); return '0.0100'; };
    await b.run.start('prepare');
    expect(b.ex.calls).not.toContain('spawnFixStep:j1');
    expect(states(b).at(-1)?.to).toBe('CANCELLED');
  });

  test('REVIEW marker read errors retain the failSafe behavior', async () => {
    const b = build('REVIEW');
    b.ex.reviewPostedError = new Error('stdout unreadable');
    b.ex.dieAfterTicks(1);
    await b.run.start('prepare');
    expect(states(b).at(-1)).toEqual({ to: 'FAILED', reason: 'runner error: stdout unreadable' });
    expect(b.uploads).toEqual([]);
  });
});

describe('FIX verdict (US-012)', () => {
  async function judged(config: { outcome?: import('../verdict/fix-result').FixOutcome; cost?: string | undefined; maxCostUsd?: string; posted?: boolean; postedError?: Error; fixStep?: boolean; spawnFailure?: Error; cancel?: boolean } = {}) {
    const b = build('FIX', 'j1', {}, { maxCostUsd: config.maxCostUsd ?? '1' });
    b.ex.reviewPosted = config.posted ?? true;
    b.ex.reviewPostedError = config.postedError ?? null;
    b.ex.fixStepStarted = config.fixStep ?? !config.spawnFailure;
    b.ex.fixOutcome = config.outcome ?? ((config.fixStep === false || config.spawnFailure)
      ? { kind: 'none', logPath: null, pushedSha: null, stderrLine: null }
      : { kind: 'pushed', logPath: null, pushedSha: 'a'.repeat(40), stderrLine: null });
    b.ex.planCost = Object.hasOwn(config, 'cost') ? config.cost : '0.2500';
    if (config.spawnFailure) b.ex.spawnFixStepError = config.spawnFailure;
    b.ex.dieAfterTicks(1);
    if (config.fixStep === false && !config.spawnFailure) b.journal.updateJob('j1', 1, { state: 'RUNNING', pid: 4242, pgid: 4242 });
    if (config.cancel) b.ex.onTick = () => { b.run.requestCancel(); b.ex.alive = false; };
    await b.run.start(config.fixStep === false && !config.spawnFailure ? 'watch' : 'prepare');
    return b;
  }

  test('AC-1/2: pushed result carries full sha and final cumulative cost', async () => {
    const b = await judged();
    expect(states(b).at(-1)?.to).toBe('COMPLETED');
    expect(lastSnapshot(b)).toMatchObject({ fixOutcome: 'pushed', resultSha: 'a'.repeat(40), costSpentUsd: '0.2500' });
  });
  test('AC-3: pushed without sha omits resultSha', async () => {
    const b = await judged({ outcome: { kind: 'pushed', logPath: null, pushedSha: null, stderrLine: null } });
    expect(states(b).at(-1)?.to).toBe('COMPLETED');
    expect(lastSnapshot(b)).toMatchObject({ fixOutcome: 'pushed' });
    expect(lastSnapshot(b)).not.toHaveProperty('resultSha');
  });
  test('AC-4: nothing completes without sha', async () => {
    const b = await judged({ outcome: { kind: 'nothing', logPath: null, pushedSha: null, stderrLine: null } });
    expect(states(b).at(-1)?.to).toBe('COMPLETED');
    expect(lastSnapshot(b)).toMatchObject({ fixOutcome: 'nothing' });
    expect(lastSnapshot(b)).not.toHaveProperty('resultSha');
  });
  test('AC-9: ready FIX result is included beside the unchanged nothing outcome', async () => {
    const fixReady = { markedReady: true };
    const b = await judged({ outcome: { kind: 'nothing', logPath: null, pushedSha: null, stderrLine: null, fixReady } });
    expect(lastSnapshot(b)).toMatchObject({ fixOutcome: 'nothing', fixReady });
  });
  test('AC-10/12: null or unavailable ready result does not change outcome or add snapshot key', async () => {
    for (const fixReady of [null, undefined]) {
      const b = await judged({ outcome: { kind: 'nothing', logPath: null, pushedSha: null, stderrLine: null, fixReady } });
      expect(states(b).at(-1)?.to).toBe('COMPLETED');
      expect(lastSnapshot(b)).toMatchObject({ fixOutcome: 'nothing' });
      expect(lastSnapshot(b)).not.toHaveProperty('fixReady');
    }
  });
  test.each([
    ['AC-5', false, '0.2500', '0.25', 'budget spent by review'],
    ['AC-6', false, undefined, '1', 'cost ledger unreadable'],
    ['AC-7', false, '0.5000', '1', 'interrupted before fix'],
  ])('%s: no fix step reports reason', async (_ac, fixStep, cost, maxCostUsd, reason) => {
    const b = await judged({ fixStep, cost, maxCostUsd });
    expect(states(b).at(-1)).toEqual({ to: 'FAILED', reason });
  });
  test('AC-8: held fix spawn failure takes precedence', async () => {
    const b = await judged({ spawnFailure: new Error('git token: none') });
    expect(states(b).at(-1)).toEqual({ to: 'FAILED', reason: 'fix spawn failed: git token: none' });
  });
  test('AC-9: missing review marker means review not posted', async () => {
    const b = await judged({ posted: false });
    expect(states(b).at(-1)).toEqual({ to: 'FAILED', reason: 'review not posted' });
  });
  test('AC-10: unreadable review marker means review not posted', async () => {
    const b = await judged({ postedError: new Error('stdout') });
    expect(states(b).at(-1)).toEqual({ to: 'FAILED', reason: 'review not posted' });
  });
  test('AC-11/12: unsuccessful fix reports stderr first line or fallback', async () => {
    const bad = await judged({ outcome: { kind: 'none', logPath: null, pushedSha: null, stderrLine: 'untrusted PR: author is not a writer' } });
    expect(states(bad).at(-1)).toEqual({ to: 'FAILED', reason: 'untrusted PR: author is not a writer' });
    const empty = await judged({ outcome: { kind: 'none', logPath: null, pushedSha: null, stderrLine: null } });
    expect(states(empty).at(-1)).toEqual({ to: 'FAILED', reason: 'fix not pushed' });
  });
  test('a failed fix-step existence read preserves the runner error', async () => {
    const b = build('FIX');
    b.ex.reviewPosted = true;
    b.ex.planCost = '0.5000';
    b.journal.updateJob('j1', 1, { state: 'RUNNING', pid: 4242, pgid: 4242 });
    b.ex.hasFixStep = async () => { throw new Error('fix marker unreadable'); };
    b.ex.dieAfterTicks(1);
    await b.run.start('watch');
    expect(states(b).at(-1)).toEqual({ to: 'FAILED', reason: 'runner error: fix marker unreadable' });
  });

  test('AC-13: unreadable fix outcome falls back to fix not pushed', async () => {
    const b = build('FIX'); b.ex.reviewPosted = true; b.ex.fixStepStarted = true; b.ex.dieAfterTicks(1);
    b.ex.readFixOutcome = async () => { throw new Error('fix unreadable'); };
    await b.run.start('prepare');
    expect(states(b).at(-1)).toEqual({ to: 'FAILED', reason: 'fix not pushed' });
  });
  test('AC-14: cancellation precedes readers', async () => {
    const b = await judged({ cancel: true });
    expect(states(b).at(-1)?.to).toBe('CANCELLED');
    expect(b.ex.calls).not.toContain('readReviewPosted:j1');
    expect(b.ex.calls).not.toContain('readFixOutcome:j1');
  });
});

describe('FIX readopt finish (US-006)', () => {
  test('a posted review without a started fix fails as interrupted before fix', async () => {
    const b = build('FIX');
    b.ex.reviewPosted = true;
    b.journal.updateJob('j1', 1, { state: 'RUNNING', pid: 4242, pgid: 4242 });
    await b.run.start('finish');
    expect(states(b).at(-1)).toEqual({ to: 'FAILED', reason: 'interrupted before fix' });
    expect(b.ex.calls).toContain('readReviewPosted:j1');
  });
});

describe('verdicts', () => {
  test.each(['PLAN', 'RUN'] as const)('%s missing output reports nax stderr through a lifecycle event (#207)', async (command) => {
    const b = build(command);
    const dir = await tmpLogs.make('stderr');
    const stderrPath = join(dir, 'nax.stderr');
    await writeFile(stderrPath, '\n[interaction] Failed to initialize interaction plugin: Telegram plugin requires botToken and chatId\n');
    b.ex.logFiles = { ...b.ex.logFiles, stderrPath };
    b.ex.plan = { ok: false, reason: 'no prd.json produced', branchName: null };
    b.ex.status = null;
    b.ex.dieAfterTicks(1);
    await b.run.start('prepare');
    expect(lifecycles(b)).toContainEqual({ level: 'error', message: 'nax stderr: [interaction] Failed to initialize interaction plugin: Telegram plugin requires botToken and chatId' });
    expect(states(b).at(-1)).toEqual({ to: 'FAILED', reason: command === 'PLAN' ? 'no prd.json produced' : 'no status.json' });
  });

  test('a cancelled job never promotes stderr into a failure diagnostic', async () => {
    const b = build('PLAN');
    const dir = await tmpLogs.make('stderr-cancel');
    const stderrPath = join(dir, 'nax.stderr');
    await writeFile(stderrPath, 'plugin init failed');
    b.ex.logFiles = { ...b.ex.logFiles, stderrPath };
    b.ex.plan = { ok: false, reason: 'no prd.json produced', branchName: null };
    b.ex.onTick = () => { b.run.requestCancel(); b.ex.alive = false; };
    await b.run.start('prepare');
    expect(states(b).at(-1)?.to).toBe('CANCELLED');
    expect(lifecycles(b).some((event) => event.message.startsWith('nax stderr:'))).toBe(false);
  });
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
  test('AC-13 (US-006): a REVIEW decisions write error is FAILED with the spawn-failed reason', async () => {
    const b = build('REVIEW');
    b.ex.spawnError = new Error('EACCES decisions file');
    await b.run.start('prepare');
    expect(states(b)).toEqual([{ to: 'FAILED', reason: 'spawn failed: EACCES decisions file' }]);
  });
  test('AC-14 (US-006): a REVIEW job with no git token at spawn is FAILED with the mapped reason', async () => {
    const b = build('REVIEW');
    b.ex.spawnError = new Error('git token: none');
    await b.run.start('prepare');
    expect(states(b)).toEqual([{ to: 'FAILED', reason: 'spawn failed: git token: none' }]);
    expect(b.ex.calls).toEqual(['prepare:j1', 'spawn:j1', 'cleanup:j1']);   // no bundle, no upload
    expect(b.uploads).toEqual([]);
  });
  test('US-008 AC-10: a FIX with no git token is FAILED with the spawn-failed reason', async () => {
    const b = build('FIX');
    b.ex.spawnError = new Error('git token: none');
    await b.run.start('prepare');
    expect(states(b)).toEqual([{ to: 'FAILED', reason: 'spawn failed: git token: none' }]);
    expect(b.ex.calls).toEqual(['prepare:j1', 'spawn:j1', 'cleanup:j1']);
    expect(b.uploads).toEqual([]);
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
  test.each(['COMPLETED', 'FAILED', 'CANCELLED'] as const)('%s PLAN reports ledger spend before its terminal state without status.json (#203)', async (terminal) => {
    const b = build('PLAN');
    b.ex.status = null;
    b.ex.planCost = '0.0044';
    if (terminal === 'FAILED') b.ex.plan = { ok: false, reason: 'no prd.json produced', branchName: null };
    b.ex.onTick = () => {
      if (terminal === 'CANCELLED') b.run.requestCancel();
      b.ex.alive = false;
    };
    await b.run.start('prepare');
    expect(states(b).at(-1)?.to).toBe(terminal);
    expect(lastSnapshot(b)?.costSpentUsd).toBe('0.0044');
    const all = events(b);
    const cost = all.find((e) => e.type === 'snapshot' && (e.payload as SnapshotEventPayload).costSpentUsd === '0.0044');
    const terminalEvent = all.find((e) => e.type === 'state' && (e.payload as StateEventPayload).to === terminal);
    expect(cost?.seq).toBeLessThan(terminalEvent?.seq ?? 0);
  });

  test('resumed PLAN finish reports the same absolute spend without charging it twice (#203)', async () => {
    const b = build('PLAN');
    b.ex.status = null;
    b.ex.planCost = '0.0044';
    b.journal.updateJob('j1', 1, { state: 'UPLOADING', resultBranch: 'feat/x', resultSha: 'd'.repeat(40), pid: 1, pgid: 1 });
    await b.run.start('finish');
    expect(lastSnapshot(b)).toMatchObject({ costSpentUsd: '0.0044', resultSha: 'd'.repeat(40) });
    expect(states(b).at(-1)?.to).toBe('COMPLETED');
  });

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
  test('watch attaches a watcher and never re-runs prepare or spawn; a cancel recorded while down is re-sent', async () => {
    const b = build();
    b.journal.updateJob('j1', 1, { state: 'RUNNING', pid: 4242, pgid: 4242, naxRunId: 'run-1', cancelRequestedAt: '2026-10-01T00:00:00.000Z' });
    b.ex.alive = true;
    b.ex.status = { run: { id: 'run-1', status: 'crashed' } };
    b.ex.dieAfterTicks(2);
    await b.run.start('watch');
    expect(b.ex.watchOptions).toHaveLength(1);
    expect(b.logs.calls).toContain('logs.register:j1');
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
    expect(b.ex.calls.slice(callsBefore)).toEqual(['releaseCredentials:j1', 'releaseApprovals:j1']);   // D90: epoch 1's socket closes; no reap, no cleanup
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

describe('approval relay across the run lifecycle (plan D273, D285)', () => {
  test('a watch start resumes approvals before the first tick', async () => {
    const b = build();
    b.journal.updateJob('j1', 1, { state: 'RUNNING', pid: 4242, pgid: 4242 });
    b.ex.alive = true;
    let resumedFirst = false;
    b.ex.onTick = (n) => { if (n === 1) resumedFirst = b.ex.calls.includes('resumeApprovals:j1'); if (n >= 1) b.ex.alive = false; };
    await b.run.start('watch');
    expect(resumedFirst).toBe(true);
  });
  test('abandon of a lower epoch releases its relay even when a higher epoch is live (plan D285)', async () => {
    const b = build();
    b.ex.onTick = () => undefined;
    const running = b.run.start('prepare');
    await waitFor(() => b.ex.calls.includes('spawn:j1') && b.ex.ticks >= 1);
    b.journal.insertJob({ assign: assignFor('RUN'), leaseEpoch: 2, repoKey: 'acme/app', jobDir: '/w/.jobs/j1' });   // the requeued attempt
    const callsBefore = b.ex.calls.length;
    await b.run.abandon();
    await running;
    expect(b.ex.calls.slice(callsBefore)).toEqual(['releaseCredentials:j1', 'releaseApprovals:j1']);   // no reap, no cleanup
  });
  test('a failing approvals resume is a lifecycle error and the run is still watched (plan D273)', async () => {
    const b = build();
    b.journal.updateJob('j1', 1, { state: 'RUNNING', pid: 4242, pgid: 4242 });
    b.ex.alive = true;
    b.ex.resumeApprovalsError = new Error('EADDRINUSE');
    b.ex.dieAfterTicks(1);
    await b.run.start('watch');
    expect(events(b).some((e) => e.type === 'lifecycle' && JSON.stringify(e.payload).includes('approval relay could not be restored'))).toBe(true);
    expect(b.ex.ticks).toBeGreaterThanOrEqual(1);   // the run is still watched (FakeExecutor counts ticks, not 'tick' calls)
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

describe('RUN progress push (S1b 1a)', () => {
  const failedStatus = { run: { id: 'r', status: 'failed' } };
  test('a FAILED run pushes before UPLOADING; the pushed branch and sha override the ledger', async () => {
    const b = build();
    b.ex.status = failedStatus;
    b.ex.dieAfterTicks(1);
    await b.run.start('prepare');
    expect(b.ex.calls.indexOf('pushProgress:j1')).toBeGreaterThan(-1);
    expect(b.ex.calls.indexOf('pushProgress:j1')).toBeLessThan(b.ex.calls.indexOf('collectBundle:j1'));
    expect(states(b).at(-1)).toEqual({ to: 'FAILED', reason: 'run status: failed' });
    expect(lastSnapshot(b)).toMatchObject({ wipPush: 'pushed', resultBranch: 'feat/x', resultSha: 'e'.repeat(40) });
    expect(b.journal.getJob('j1', 1)).toMatchObject({ resultBranch: 'feat/x', resultSha: 'e'.repeat(40) });
  });
  test('a COMPLETED run with a finish ledger does not push and reports no wipPush', async () => {
    const b = build();
    b.ex.dieAfterTicks(1);
    await b.run.start('prepare');
    expect(b.ex.calls).not.toContain('pushProgress:j1');
    expect(lastSnapshot(b)?.wipPush).toBeUndefined();
  });
  test.each([undefined, { finish: { status: 'skipped' } }])('a COMPLETED run without a finish ledger pushes and records its output (postRun=%j)', async (postRun) => {
    const b = build();
    b.ex.status = { run: { id: 'r', status: 'completed' }, ...(postRun ? { postRun } : {}) };
    b.ex.ledger = null;
    b.ex.dieAfterTicks(1);
    await b.run.start('prepare');
    expect(states(b).at(-1)).toEqual({ to: 'COMPLETED' });
    expect(lastSnapshot(b)).toMatchObject({ wipPush: 'pushed', resultBranch: 'feat/x', resultSha: 'e'.repeat(40) });
    expect(b.journal.getJob('j1', 1)).toMatchObject({ resultBranch: 'feat/x', resultSha: 'e'.repeat(40) });
  });
  test('a failed fallback push is visible without changing the COMPLETED verdict', async () => {
    const b = build();
    b.ex.status = { run: { id: 'r', status: 'completed' } };
    b.ex.ledger = null;
    b.ex.progressPush = { kind: 'failed', reason: 'diverged' };
    b.ex.dieAfterTicks(1);
    await b.run.start('prepare');
    expect(states(b).at(-1)).toEqual({ to: 'COMPLETED' });
    expect(lastSnapshot(b)).toMatchObject({ wipPush: 'failed:diverged' });
    expect(b.journal.getJob('j1', 1)).toMatchObject({ resultBranch: null, resultSha: null });
  });
  test('a COMPLETED run resumed after its fallback push reuses the persisted output', async () => {
    const b = build();
    b.ex.status = { run: { id: 'r', status: 'completed' } };
    b.ex.ledger = null;
    b.journal.updateJob('j1', 1, { state: 'UPLOADING', branch: 'feat/x', resultBranch: 'feat/x', resultSha: 'd'.repeat(40), pid: 1, pgid: 1 });
    await b.run.start('finish');
    expect(b.ex.calls).not.toContain('pushProgress:j1');
    expect(stateNames(b)).toEqual(['COMPLETED']);
    expect(lastSnapshot(b)).toMatchObject({ wipPush: 'pushed', resultBranch: 'feat/x', resultSha: 'd'.repeat(40) });
  });
  test('a COMPLETED run resumed after publication but before recording the SHA recovers its output', async () => {
    const b = build();
    b.ex.status = { run: { id: 'r', status: 'completed' } };
    b.ex.ledger = null;
    b.ex.progressPush = { kind: 'none', branch: 'feat/x', sha: 'd'.repeat(40) };
    b.journal.updateJob('j1', 1, { state: 'RUNNING', branch: 'feat/x', pid: 1, pgid: 1 });
    await b.run.start('finish');
    expect(stateNames(b)).toEqual(['UPLOADING', 'COMPLETED']);
    expect(lastSnapshot(b)).toMatchObject({ wipPush: 'none', resultBranch: 'feat/x', resultSha: 'd'.repeat(40) });
    expect(b.journal.getJob('j1', 1)).toMatchObject({ resultBranch: 'feat/x', resultSha: 'd'.repeat(40) });
  });
  test('ESCALATED with nothing new reports none and the published result (D145)', async () => {
    const b = build();
    b.ex.status = { run: { id: 'r', status: 'completed' }, postRun: { finish: { result: 'escalated', escalationReason: 'review' } } };
    b.ex.progressPush = { kind: 'none', branch: 'feat/x', sha: 'b'.repeat(40) };
    b.ex.dieAfterTicks(1);
    await b.run.start('prepare');
    expect(lastSnapshot(b)).toMatchObject({ wipPush: 'none', resultBranch: 'feat/x', resultSha: 'b'.repeat(40) });
    expect(states(b).at(-1)).toEqual({ to: 'ESCALATED', reason: 'review' });
  });
  test('a failed push keeps the nax verdict and reason', async () => {
    const b = build();
    b.ex.status = failedStatus;
    b.ex.progressPush = { kind: 'failed', reason: 'diverged' };
    b.ex.dieAfterTicks(1);
    await b.run.start('prepare');
    expect(states(b).at(-1)).toEqual({ to: 'FAILED', reason: 'run status: failed' });
    expect(lastSnapshot(b)).toMatchObject({ wipPush: 'failed:diverged', resultSha: 'b'.repeat(40) });
  });
  test('a CANCELLED run still pushes, and the probe is halt-only', async () => {
    const b = build();
    b.ex.status = { run: { id: 'r', status: 'crashed' } };
    b.ex.onTick = (n) => { if (n === 2) b.run.requestCancel(); };
    await b.run.start('prepare');
    expect(stateNames(b)).toEqual(['RUNNING', 'UPLOADING', 'CANCELLED']);
    expect(b.ex.calls).toContain('pushProgress:j1');
    expect(b.ex.pushProgressOptions[0].isHalted?.()).toBe(false);
    expect(lastSnapshot(b)).toMatchObject({ wipPush: 'pushed' });
  });
  test('a halt during the push records nothing (D144)', async () => {
    const b = build();
    b.ex.status = failedStatus;
    b.ex.dieAfterTicks(1);
    const seen: { probe: (() => boolean) | null } = { probe: null };
    b.ex.pushProgress = async (_job, options) => {
      seen.probe = options?.isHalted ?? null;
      b.run.halt();
      return { kind: 'halted' };
    };
    await b.run.start('prepare');
    expect(seen.probe?.()).toBe(true);
    expect(everyStateName(b)).toEqual(['RUNNING']);
    expect(b.uploads).toEqual([]);
  });
  test('resume after the push was recorded does not push again and reports pushed (D141)', async () => {
    const b = build();
    b.ex.status = failedStatus;
    b.journal.updateJob('j1', 1, { state: 'UPLOADING', branch: 'feat/x', resultBranch: 'feat/x', resultSha: 'd'.repeat(40), pid: 1, pgid: 1 });
    await b.run.start('finish');
    expect(b.ex.calls).not.toContain('pushProgress:j1');
    expect(stateNames(b)).toEqual(['FAILED']);
    expect(lastSnapshot(b)).toMatchObject({ wipPush: 'pushed', resultSha: 'd'.repeat(40) });
  });
  test('a push that throws keeps the nax verdict and reports failed:push error', async () => {
    const b = build();
    b.ex.status = failedStatus;
    b.ex.pushProgress = async () => { throw new Error('boom'); };
    b.ex.dieAfterTicks(1);
    await b.run.start('prepare');
    expect(states(b).at(-1)).toEqual({ to: 'FAILED', reason: 'run status: failed' });
    expect(lastSnapshot(b)).toMatchObject({ wipPush: 'failed:push error', resultSha: 'b'.repeat(40) });
  });
  test('PLAN never calls pushProgress', async () => {
    const b = build('PLAN');
    b.ex.dieAfterTicks(1);
    await b.run.start('prepare');
    expect(b.ex.calls).not.toContain('pushProgress:j1');
  });
});

describe('log shipping (S2a §2.4, plan D327)', () => {
  test('registers after spawn with the executor\'s log sources; its lifecycle callback writes journal lifecycle events', async () => {
    const b = build();
    const logs = new FakeLogShipping(b.ex.calls);
    b.ex.dieAfterTicks(1);
    await new JobRun({ ...b.deps, logs }, 'j1', 1).start('prepare');
    expect(inOrder(b.ex.calls, ['spawn:j1', 'logs.register:j1'])).toBe(true);
    expect(logs.jobs[0]).toMatchObject({ jobId: 'j1', leaseEpoch: 1, sources: b.ex.logFiles });
    expect(logs.calls.filter((c) => c === 'logs.register:j1')).toHaveLength(1);
  });
  test('a lifecycle message from the shipper lands on the job\'s timeline', async () => {
    const b = build();
    b.ex.dieAfterTicks(1);
    b.ex.onTick = (n) => {
      if (n === 1) b.logs.jobs[0].lifecycle('warn', 'the stdout log shrank');
      b.ex.alive = false;
    };
    await b.run.start('prepare');
    expect(lifecycles(b)).toContainEqual({ level: 'warn', message: 'the stdout log shrank' });
  });
  test('wakes the shipper after every tick, the final one included', async () => {
    const b = build();
    b.ex.dieAfterTicks(2);
    await b.run.start('prepare');
    expect(b.ex.ticks).toBe(3);
    expect(b.logs.wakes).toBe(3);
  });
  test('drains after the final tick and reap, concurrently with the progress push, and awaits it before UPLOADING (R5)', async () => {
    const b = build();
    const logs = new FakeLogShipping(b.ex.calls);
    logs.holdDrain();
    b.ex.status = { run: { id: 'run-1', status: 'failed' } };
    b.ex.dieAfterTicks(1);
    const done = new JobRun({ ...b.deps, logs }, 'j1', 1).start('prepare');
    await waitFor(() => b.ex.calls.includes('pushProgress:j1'));
    expect(inOrder(b.ex.calls, ['reap:j1', 'logs.drain:j1', 'pushProgress:j1'])).toBe(true);
    await settle();
    expect(stateNames(b)).toEqual(['RUNNING']);
    logs.releaseDrain();
    await done;
    expect(stateNames(b)).toEqual(['RUNNING', 'UPLOADING', 'FAILED']);
    expect(inOrder(b.ex.calls, ['logs.drain:j1', 'collectBundle:j1', 'logs.stop:j1', 'cleanup:j1'])).toBe(true);
  });
  test('a drain timeout is a lifecycle warning and the run goes on to its verdict and bundle', async () => {
    const b = build();
    b.logs.drainResult = 'timeout';
    b.ex.dieAfterTicks(1);
    await b.run.start('prepare');
    expect(lifecycles(b)).toContainEqual({ level: 'warn', message: 'log upload did not finish within 120 s; the bundle fills the rest' });
    expect(stateNames(b)).toEqual(['RUNNING', 'UPLOADING', 'COMPLETED']);
  });
  test('a halt during the drain stops the job\'s logs and reports nothing more (Review focus 4)', async () => {
    const b = build();
    const logs = new FakeLogShipping(b.ex.calls);
    logs.holdDrain();
    b.ex.dieAfterTicks(1);
    const run = new JobRun({ ...b.deps, logs }, 'j1', 1);
    const done = run.start('prepare');
    await waitFor(() => logs.calls.includes('logs.drain:j1'));
    run.halt();
    await done;
    expect(logs.calls).toContain('logs.stop:j1');
    expect(stateNames(b)).toEqual(['RUNNING']);
    expect(b.uploads).toEqual([]);
  });
  test('the finish path (nax exited while the daemon was down) registers and drains before UPLOADING (R5)', async () => {
    const b = build();
    const logs = new FakeLogShipping(b.ex.calls);
    b.journal.updateJob('j1', 1, { state: 'RUNNING', pid: 4242, pgid: 4242, naxRunId: 'run-1' });
    await new JobRun({ ...b.deps, logs }, 'j1', 1).start('finish');
    expect(inOrder(b.ex.calls, ['logs.register:j1', 'logs.drain:j1', 'collectBundle:j1'])).toBe(true);
    expect(stateNames(b)).toEqual(['UPLOADING', 'COMPLETED']);
  });
  test('the watch path registers the job\'s logs too', async () => {
    const b = build();
    b.journal.updateJob('j1', 1, { state: 'RUNNING', pid: 4242, pgid: 4242, naxRunId: 'run-1' });
    b.ex.alive = true;
    b.ex.dieAfterTicks(1);
    await b.run.start('watch');
    expect(b.logs.calls).toEqual(expect.arrayContaining(['logs.register:j1', 'logs.drain:j1', 'logs.stop:j1']));
  });
  test('a job that never spawns never registers, and its cleanup still releases the key', async () => {
    const b = build();
    b.ex.prepareResult = { ok: false, reason: 'checkout failed' };
    await b.run.start('prepare');
    expect(b.logs.calls).toEqual(['logs.stop:j1', 'logs.stop:j1']);   // cleanup(), then start()'s finally (idempotent)
  });
  test('PLAN: the drain overlaps finishPlan and completes before UPLOADING', async () => {
    const b = build('PLAN');
    const logs = new FakeLogShipping(b.ex.calls);
    logs.holdDrain();
    b.ex.dieAfterTicks(1);
    const done = new JobRun({ ...b.deps, logs }, 'j1', 1).start('prepare');
    await waitFor(() => b.ex.calls.includes('finishPlan:j1'));
    expect(inOrder(b.ex.calls, ['logs.drain:j1', 'finishPlan:j1'])).toBe(true);
    await settle();
    expect(stateNames(b)).toEqual(['RUNNING']);
    logs.releaseDrain();
    await done;
    expect(stateNames(b)).toEqual(['RUNNING', 'UPLOADING', 'COMPLETED']);
  });
  test('a runner error drains the logs before its UPLOADING -> FAILED report (no bundle follows)', async () => {
    const b = build();
    const logs = new FakeLogShipping(b.ex.calls);
    b.ex.statusError = new Error('disk gone');
    b.ex.dieAfterTicks(1);
    await new JobRun({ ...b.deps, logs }, 'j1', 1).start('prepare');
    expect(stateNames(b)).toEqual(['RUNNING', 'UPLOADING', 'FAILED']);
    expect(inOrder(b.ex.calls, ['logs.register:j1', 'logs.drain:j1', 'logs.stop:j1', 'cleanup:j1'])).toBe(true);
    expect(b.uploads).toEqual([]);
  });
  test('a re-adopted row that is already terminal never registers its logs', async () => {
    const b = build();
    b.journal.updateJob('j1', 1, { state: 'COMPLETED', pid: 4242, pgid: 4242 });
    await b.run.start('finish');
    expect(b.logs.calls).toEqual(['logs.stop:j1', 'logs.stop:j1']);
  });
  test('abandon of a run that never started (after a restart) stops the key and registers nothing', async () => {
    const b = build();
    b.journal.updateJob('j1', 1, { state: 'RUNNING', pid: 4242, pgid: 4242 });
    await new JobRun(b.deps, 'j1', 1).abandon();
    expect(b.logs.calls).toEqual(['logs.stop:j1']);
  });
  test('with the real shipper, a PUT that never answers does not slow the watch loop; the drain times out (R4, R5)', async () => {
    const dir = await tmpLogs.make('jr');
    await writeFile(join(dir, 'nax.stdout'), 'line\n');
    const server = fakeLogServer();
    for (let i = 0; i < 10; i += 1) server.overrides.push('hold');
    const shipper = new LogShipper({
      transport: server.transport, log: createMemoryLogger(), nowMs: () => Date.now(), sleep: systemSleep, random: () => 0,
      tuning: { chunkBytes: 1_024, maxInFlight: 2, putTimeoutMs: 60_000, backoffMaxMs: 1_000 },
    });
    try {
      const b = build('RUN', 'j1', { logDrainTimeoutMs: 1_000 });
      b.ex.logFiles = { outDir: join(dir, 'nax-out'), feature: 'f', stdoutPath: join(dir, 'nax.stdout'), stderrPath: join(dir, 'nax.stderr'), runLog: false };
      b.ex.dieAfterTicks(5);
      await new JobRun({ ...b.deps, logs: shipper }, 'j1', 1).start('prepare');
      expect(b.ex.ticks).toBe(6);
      await waitFor(() => server.inFlight === 0);
      expect(lifecycles(b)).toContainEqual({ level: 'warn', message: 'log upload did not finish within 1 s; the bundle fills the rest' });
      expect(stateNames(b)).toEqual(['RUNNING', 'UPLOADING', 'COMPLETED']);
    } finally {
      await shipper.close();
    }
  });
});

describe('RUN workflow finish (US-002)', () => {
  test('AC-3: workflow draft with reasons reports ESCALATED with the joined reason', async () => {
    const b = build();
    b.journal.updateJob('j1', 1, { state: 'RUNNING', branch: 'feat/x', pid: 1, pgid: 1 });
    b.ex.status = { run: { id: 'r', status: 'completed' }, workflow: { step: 'done', outcome: 'draft' } };
    (b.ex as unknown as Record<string, unknown>)['workflowResult'] = { runId: 'w1', outcome: 'draft', reasons: ['CI failed: test'] };
    (b.ex as unknown as Record<string, unknown>)['head'] = null;
    await b.run.start('finish');
    expect(states(b).at(-1)).toEqual({ to: 'ESCALATED', reason: 'workflow draft: CI failed: test' });
  });
  test('AC-4: workflow ready with no ledger never pushes and carries no wipPush', async () => {
    const b = build();
    b.journal.updateJob('j1', 1, { state: 'RUNNING', branch: 'feat/x', pid: 1, pgid: 1 });
    b.ex.status = { run: { id: 'r', status: 'completed' }, workflow: { step: 'done', outcome: 'ready' } };
    (b.ex as unknown as Record<string, unknown>)['workflowResult'] = null;
    (b.ex as unknown as Record<string, unknown>)['head'] = 'abc123';
    b.ex.ledger = null;
    await b.run.start('finish');
    expect(b.ex.calls).not.toContain('pushProgress:j1');
    expect(lastSnapshot(b)?.wipPush).toBeUndefined();
  });
  test('AC-5: workflow draft never pushes', async () => {
    const b = build();
    b.journal.updateJob('j1', 1, { state: 'RUNNING', branch: 'feat/x', pid: 1, pgid: 1 });
    b.ex.status = { run: { id: 'r', status: 'completed' }, workflow: { step: 'done', outcome: 'draft' } };
    (b.ex as unknown as Record<string, unknown>)['workflowResult'] = { runId: 'w1', outcome: 'draft', reasons: ['CI failed: test'] };
    (b.ex as unknown as Record<string, unknown>)['head'] = 'abc123';
    await b.run.start('finish');
    expect(b.ex.calls).not.toContain('pushProgress:j1');
  });
  test('AC-6: workflow local-only pushes once and never reads the ledger', async () => {
    const b = build();
    b.journal.updateJob('j1', 1, { state: 'RUNNING', branch: 'feat/x', pid: 1, pgid: 1 });
    b.ex.status = { run: { id: 'r', status: 'completed' }, workflow: { step: 'done', outcome: 'local-only' } };
    (b.ex as unknown as Record<string, unknown>)['workflowResult'] = { runId: 'w1', outcome: 'local-only', reasons: ['push failed'] };
    b.ex.ledger = null;
    await b.run.start('finish');
    expect(b.ex.calls.filter((c) => c === 'pushProgress:j1')).toHaveLength(1);
    expect((b.ex as unknown as Record<string, unknown>)['readFinishLedgerCalls'] ?? b.ex.calls.filter((c) => c === 'readFinishLedger:j1').length).toBe(0);
  });
  test('AC-7: workflow ready reports the branch and head sha without reading the ledger', async () => {
    const b = build();
    b.journal.updateJob('j1', 1, { state: 'RUNNING', branch: 'feat/x', pid: 1, pgid: 1 });
    b.ex.status = { run: { id: 'r', status: 'completed' }, workflow: { step: 'done', outcome: 'ready' } };
    (b.ex as unknown as Record<string, unknown>)['workflowResult'] = null;
    (b.ex as unknown as Record<string, unknown>)['head'] = 'abc123';
    await b.run.start('finish');
    expect(lastSnapshot(b)).toMatchObject({ resultBranch: 'feat/x', resultSha: 'abc123' });
    expect((b.ex as unknown as Record<string, unknown>)['readFinishLedgerCalls'] ?? b.ex.calls.filter((c) => c === 'readFinishLedger:j1').length).toBe(0);
  });
  test('AC-8: workflow ready journals the head sha', async () => {
    const b = build();
    b.journal.updateJob('j1', 1, { state: 'RUNNING', branch: 'feat/x', pid: 1, pgid: 1 });
    b.ex.status = { run: { id: 'r', status: 'completed' }, workflow: { step: 'done', outcome: 'ready' } };
    (b.ex as unknown as Record<string, unknown>)['workflowResult'] = null;
    (b.ex as unknown as Record<string, unknown>)['head'] = 'abc123';
    await b.run.start('finish');
    expect(b.journal.getJob('j1', 1)).toMatchObject({ resultBranch: 'feat/x', resultSha: 'abc123' });
  });
  test('AC-9: no workflow block keeps the ledger path', async () => {
    const b = build();
    b.journal.updateJob('j1', 1, { state: 'RUNNING', branch: 'feat/x', pid: 1, pgid: 1 });
    b.ex.status = { run: { id: 'r', status: 'completed' } };
    b.ex.ledger = { branch: 'feat/y', headSha: 'def456' };
    await b.run.start('finish');
    expect(lastSnapshot(b)).toMatchObject({ resultBranch: 'feat/y', resultSha: 'def456' });
  });
  test('AC-10: workflow ready with no head reports COMPLETED with the branch and no sha', async () => {
    const b = build();
    b.journal.updateJob('j1', 1, { state: 'RUNNING', branch: 'feat/x', pid: 1, pgid: 1 });
    b.ex.status = { run: { id: 'r', status: 'completed' }, workflow: { step: 'done', outcome: 'ready' } };
    (b.ex as unknown as Record<string, unknown>)['workflowResult'] = null;
    (b.ex as unknown as Record<string, unknown>)['head'] = null;
    b.ex.ledger = null;
    await b.run.start('finish');
    expect(states(b).at(-1)?.to).toBe('COMPLETED');
    expect(lastSnapshot(b)).toMatchObject({ resultBranch: 'feat/x' });
    expect(lastSnapshot(b)).not.toHaveProperty('resultSha');
  });
  test('AC-11: resumed workflow ready reuses the journalled sha without reading the head', async () => {
    const b = build();
    b.journal.updateJob('j1', 1, { state: 'UPLOADING', branch: 'feat/x', resultBranch: 'feat/x', resultSha: 'aaa111', pid: 1, pgid: 1 });
    b.ex.status = { run: { id: 'r', status: 'completed' }, workflow: { step: 'done', outcome: 'ready' } };
    (b.ex as unknown as Record<string, unknown>)['workflowResult'] = null;
    (b.ex as unknown as Record<string, unknown>)['head'] = 'bbb222';
    await b.run.start('finish');
    expect(lastSnapshot(b)).toMatchObject({ resultSha: 'aaa111' });
    expect(b.journal.getJob('j1', 1)?.resultSha).toBe('aaa111');
  });
  test('AC-12: cancelled workflow ready keeps the cancelled path with one push', async () => {
    const b = build();
    b.journal.updateJob('j1', 1, { state: 'RUNNING', branch: 'feat/x', pid: 1, pgid: 1, cancelRequestedAt: '2026-10-01T00:00:00.000Z' });
    b.ex.status = { run: { id: 'r', status: 'completed' }, workflow: { step: 'done', outcome: 'ready' } };
    (b.ex as unknown as Record<string, unknown>)['workflowResult'] = null;
    (b.ex as unknown as Record<string, unknown>)['head'] = 'abc123';
    await b.run.start('finish');
    expect(states(b).at(-1)?.to).toBe('CANCELLED');
    expect(b.ex.calls.filter((c) => c === 'pushProgress:j1')).toHaveLength(1);
  });
});
