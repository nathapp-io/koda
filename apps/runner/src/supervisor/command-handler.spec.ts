import { describe, expect, mock, test } from 'bun:test';
import type { CommandAck, FleetCommandOut } from '@nathapp/fleet-protocol';
import { Journal } from '../journal/journal';
import type { JobRow } from '../journal/types';
import { createMemoryLogger } from '../logger';
import { assignFor } from '../../test/helpers/assign';
import { FakeExecutor } from '../../test/helpers/fake-executor';
import { fakeTime } from '../../test/helpers/fake-time';
import { waitFor } from '../../test/helpers/wait';
import { NO_LOG_SHIPPING } from '../../test/helpers/fake-log-shipping';
import { CommandHandler } from './command-handler';
import { RepoMutex } from './repo-mutex';
import { Supervisor } from './supervisor';

/**
 * US-001: `over.journal` reuses an existing journal, so a test can build a second handler and supervisor over the
 * same rows — the runner's restart. `acks` collects the acks whose command retired after its sync.
 */
function build(over: { journal?: Journal } = {}) {
  const time = fakeTime();
  const journal = over.journal ?? Journal.open(':memory:', time.now);
  const ex = new FakeExecutor();
  const log = createMemoryLogger();
  // K11: exposed so a test can hold a repo lock (another job's long RUN) and read the warnings.
  const mutex = new RepoMutex();
  const supervisor = new Supervisor({
    journal, executor: ex, mutex, log, now: time.now, sleep: time.sleep,
    uploader: { upload: async () => ({ kind: 'ok' }) }, tuning: { statusPollMs: 2_000, killGraceMs: 30_000, ackPollMs: 250, uploadAckWaitMs: 0, logDrainTimeoutMs: 120_000 }, readoptHeartbeatMs: 120_000,
    logs: NO_LOG_SHIPPING,
  });
  const approvals = { answer: mock(async (): Promise<{ result: 'ok' | 'rejected'; detail?: string }> => ({ result: 'ok' })) };
  const acks: CommandAck[] = [];
  const handler = new CommandHandler({ journal, supervisor, workspaceRoot: '/work/space', log, now: time.now, approvals, onDeferredAck: (ack) => { acks.push(ack); } });
  return { time, journal, ex, supervisor, handler, approvals, mutex, log, acks };
}
const assignCmd = (id = 'c1', jobId = 'j1', epoch = 1): FleetCommandOut => ({ commandId: id, type: 'ASSIGN', jobId, leaseEpoch: epoch, payload: assignFor('RUN', { jobId }) });
const other = (type: FleetCommandOut['type'], id: string, epoch = 1): FleetCommandOut => ({ commandId: id, type, jobId: 'j1', leaseEpoch: epoch, payload: {} });

/**
 * K11: a command that must not wait for the repo lock the test holds. A regression that does wait fails on the race
 * instead of hanging the suite, and the caller still releases the lock in `finally`.
 */
async function settlesWithin<T>(work: Promise<T>, ms = 500): Promise<{ done: true; value: T } | { done: false }> {
  const timeout = new Promise<{ done: false }>((resolve) => { setTimeout(() => resolve({ done: false }), ms); });
  return Promise.race([work.then((value) => ({ done: true as const, value })), timeout]);
}

describe('ASSIGN', () => {
  test('inserts the job and the applied-command row, acks ok, and starts preparing', async () => {
    const b = build();
    b.ex.dieAfterTicks(1);
    expect(await b.handler.handle([assignCmd()])).toEqual([{ commandId: 'c1', leaseEpoch: 1, result: 'ok' }]);
    expect(b.journal.getJob('j1', 1)).toMatchObject({ command: 'RUN', repoKey: 'acme/app', jobDir: '/work/space/.jobs/j1', state: expect.any(String) });
    expect(b.journal.getCommand('c1')).toMatchObject({ result: 'ok', type: 'ASSIGN', jobId: 'j1', leaseEpoch: 1 });
    await b.supervisor.idle();
    expect(b.ex.calls).toContain('prepare:j1');
  });
  test('a repeated command is acked from the journal and never re-run (Review focus 1)', async () => {
    const b = build();
    b.ex.dieAfterTicks(1);
    await b.handler.handle([assignCmd()]);
    await b.supervisor.idle();
    const before = b.ex.calls.length;
    expect(await b.handler.handle([assignCmd()])).toEqual([{ commandId: 'c1', leaseEpoch: 1, result: 'ok' }]);
    expect(b.ex.calls).toHaveLength(before);
  });
  test('the same (job, epoch) under a new command id is acked ok without a second run', async () => {
    const b = build();
    b.ex.dieAfterTicks(1);
    await b.handler.handle([assignCmd('c1')]);
    await b.supervisor.idle();
    const before = b.ex.calls.length;
    expect((await b.handler.handle([assignCmd('c2')]))[0].result).toBe('ok');
    expect(b.ex.calls).toHaveLength(before);
    expect(b.journal.getCommand('c2')).not.toBeNull();
  });
  test('a replayed ASSIGN whose run was lost in a restart starts it again; a job that has moved on is left alone (D63)', async () => {
    const b = build();
    // What the journal looks like after a crash between "row + applied command committed" and "run started".
    b.journal.insertJob({ assign: assignFor('RUN', { jobId: 'j1' }), leaseEpoch: 1, repoKey: 'acme/app', jobDir: '/work/space/.jobs/j1' });
    b.journal.recordCommand({ commandId: 'c1', jobId: 'j1', leaseEpoch: 1, type: 'ASSIGN', result: 'ok', detail: null, appliedAt: b.time.now().toISOString() });
    b.ex.dieAfterTicks(1);
    expect(await b.handler.handle([assignCmd('c1')])).toEqual([{ commandId: 'c1', leaseEpoch: 1, result: 'ok' }]);
    await b.supervisor.idle();
    expect(b.ex.calls.slice(0, 2)).toEqual(['reap:j1', 'prepare:j1']);
    expect(b.journal.getJob('j1', 1)?.state).toBe('COMPLETED');

    const moved = build();                                       // RUNNING with a pid: not stranded
    moved.journal.insertJob({ assign: assignFor('RUN', { jobId: 'j1' }), leaseEpoch: 1, repoKey: 'acme/app', jobDir: '/work/space/.jobs/j1' });
    moved.journal.updateJob('j1', 1, { state: 'RUNNING', pid: 4242, pgid: 4242 });
    moved.journal.recordCommand({ commandId: 'c1', jobId: 'j1', leaseEpoch: 1, type: 'ASSIGN', result: 'ok', detail: null, appliedAt: moved.time.now().toISOString() });
    await moved.handler.handle([assignCmd('c1')]);
    await moved.supervisor.idle();
    expect(moved.ex.calls).toEqual([]);

    const again = build();                                       // the same (job, epoch) under a new command id resumes as well
    again.journal.insertJob({ assign: assignFor('RUN', { jobId: 'j1' }), leaseEpoch: 1, repoKey: 'acme/app', jobDir: '/work/space/.jobs/j1' });
    again.ex.dieAfterTicks(1);
    expect((await again.handler.handle([assignCmd('c7')]))[0].result).toBe('ok');
    await again.supervisor.idle();
    expect(again.ex.calls).toContain('prepare:j1');
  });
  test('a higher epoch of the same job abandons the lower one first: it is killed and dropped, and its cleanup is left to the new epoch (D64)', async () => {
    const b = build();
    // K11: epoch 1's abandon completes in the background, so its kill and its drop are observed in the order of a
    // sequence the harness records, not by the time `handle` returns.
    const order: string[] = [];
    const kill = b.ex.kill.bind(b.ex);
    b.ex.kill = (pgid, signal) => { order.push(`kill:${signal}`); return kill(pgid, signal); };
    const prepare = b.ex.prepare.bind(b.ex);
    b.ex.prepare = async (job) => { order.push(b.journal.getJob('j1', 1) === null ? 'prepare:dropped' : 'prepare:present'); return prepare(job); };
    await b.handler.handle([assignCmd('c1', 'j1', 1)]);
    await waitFor(() => b.ex.ticks >= 1);                        // epoch 1 is running, pid 4242
    b.ex.dieAfterTicks(b.ex.ticks + 2);                          // epoch 2 will finish quickly once it runs
    expect((await b.handler.handle([assignCmd('c2', 'j1', 2)]))[0].result).toBe('ok');
    await b.supervisor.idle();
    expect(b.journal.getJob('j1', 1)).toBeNull();
    expect(b.ex.killed).toEqual([{ pgid: 4242, signal: 'SIGKILL' }]);
    // The invariant K11 keeps: epoch 1 is killed and dropped before epoch 2's prepare.
    expect(order).toEqual(['prepare:present', 'kill:SIGKILL', 'prepare:dropped']);
    expect(b.journal.getJob('j1', 2)?.state).toBe('COMPLETED');
    const secondPrepare = b.ex.calls.lastIndexOf('prepare:j1');
    expect(b.ex.calls.filter((c) => c === 'prepare:j1')).toHaveLength(2);
    expect(b.ex.calls.slice(0, secondPrepare)).not.toContain('cleanup:j1');   // the abandon of epoch 1 did not clean epoch 2's profile
  });
  test('a hostile payload is acked rejected with a fixed detail, creates no job, and the rejection is replayed', async () => {
    const b = build();
    const bad: FleetCommandOut = { ...assignCmd('c9'), payload: { ...assignFor(), feature: '../../etc' } as never };
    const [ack] = await b.handler.handle([bad]);
    expect(ack).toEqual({ commandId: 'c9', leaseEpoch: 1, result: 'rejected', detail: 'invalid feature' });
    expect(b.journal.getJob('j1', 1)).toBeNull();
    expect(b.ex.calls).toEqual([]);
    expect((await b.handler.handle([bad]))[0]).toEqual(ack);
  });
  test('flow-handoff US-007: a malformed handoff is rejected before the supervisor begins the job', async () => {
    const b = build();
    const record = [{ runId: '..', file: 'result.json', mtimeMs: 1, content: '{}' }];
    const bad: FleetCommandOut = { ...assignCmd('c11'), payload: { ...assignFor(), handoff: { record } } as never };
    const [ack] = await b.handler.handle([bad]);
    expect(ack).toEqual({ commandId: 'c11', leaseEpoch: 1, result: 'rejected', detail: 'invalid handoff' });
    expect(b.journal.getJob('j1', 1)).toBeNull();
    expect(b.ex.calls).toEqual([]);
    expect(b.journal.getCommand('c11')).toMatchObject({ result: 'rejected', detail: 'invalid handoff' });
  });
});

describe('requeue ASSIGN retires older epochs without blocking (K11)', () => {
  /** The older row as a requeue finds it: a finished attempt whose run already ran `executor.cleanup`. */
  const seedFinished = (b: ReturnType<typeof build>, epoch: number): void => {
    b.journal.insertJob({ assign: assignFor('RUN', { jobId: 'j1' }), leaseEpoch: epoch, repoKey: 'acme/app', jobDir: '/work/space/.jobs/j1' });
    b.journal.updateJob('j1', epoch, { state: 'COMPLETED' });
    b.journal.markDone('j1', epoch);
  };
  /** The older row as a requeue finds it after a restart: RUNNING on the journal, no run in memory. */
  const seedUnfinished = (b: ReturnType<typeof build>, epoch: number): void => {
    b.journal.insertJob({ assign: assignFor('RUN', { jobId: 'j1' }), leaseEpoch: epoch, repoKey: 'acme/app', jobDir: '/work/space/.jobs/j1' });
    b.journal.updateJob('j1', epoch, { state: 'RUNNING', pid: 4242, pgid: 4242 });
  };

  test('AC-1/2: a finished older row is dropped at once, so the requeue acks while the test still holds the repo lock', async () => {
    const b = build();
    seedFinished(b, 1);
    b.ex.dieAfterTicks(b.ex.ticks + 2);
    const release = await b.mutex.acquire('acme/app');                    // another job's long RUN
    try {
      expect(await settlesWithin(b.handler.handle([assignCmd('c2', 'j1', 2)])))
        .toEqual({ done: true, value: [{ commandId: 'c2', leaseEpoch: 2, result: 'ok' }] });
      expect(b.journal.getJob('j1', 1)).toBeNull();
    } finally {
      release();
    }
    await b.supervisor.idle();
    expect(b.journal.getJob('j1', 2)?.state).toBe('COMPLETED');
  });

  test('AC-3/4/5/6/7: an unfinished older row is retired behind the repo lock, before the new epoch prepares', async () => {
    const b = build();
    seedUnfinished(b, 1);
    b.ex.alive = true;                                                    // AC-7: a live process of ours
    b.ex.dieAfterTicks(b.ex.ticks + 2);
    let olderAtPrepare: JobRow | null | undefined;
    const prepare = b.ex.prepare.bind(b.ex);
    b.ex.prepare = async (job) => { olderAtPrepare = b.journal.getJob('j1', 1); return prepare(job); };
    const release = await b.mutex.acquire('acme/app');
    try {
      expect(await settlesWithin(b.handler.handle([assignCmd('c2', 'j1', 2)])))
        .toEqual({ done: true, value: [{ commandId: 'c2', leaseEpoch: 2, result: 'ok' }] });
      expect(b.ex.calls).not.toContain('prepare:j1');
    } finally {
      release();
    }
    await b.supervisor.idle();
    expect(olderAtPrepare).toBeNull();                                    // the older row was gone when prepare ran
    expect(b.journal.getJob('j1', 2)?.state).toBe('COMPLETED');
    expect(b.ex.killed).toContainEqual({ pgid: 4242, signal: 'SIGKILL' });
  });

  test('AC-8/9/10: a CANCEL for the new epoch while it waits ends it at once, and nothing is ever prepared', async () => {
    const b = build();
    seedUnfinished(b, 1);
    b.ex.dieAfterTicks(b.ex.ticks + 2);
    const cancel: FleetCommandOut = { commandId: 'c3', type: 'CANCEL', jobId: 'j1', leaseEpoch: 2, payload: {} };
    const release = await b.mutex.acquire('acme/app');
    try {
      expect(await settlesWithin(b.handler.handle([assignCmd('c2', 'j1', 2)])))
        .toEqual({ done: true, value: [{ commandId: 'c2', leaseEpoch: 2, result: 'ok' }] });
      expect(await b.handler.handle([cancel])).toEqual([{ commandId: 'c3', leaseEpoch: 2, result: 'ok' }]);
      expect(b.journal.getJob('j1', 2)).toMatchObject({ state: 'CANCELLED', doneAt: expect.any(String) });
    } finally {
      release();
    }
    await b.supervisor.idle();
    expect(b.ex.calls).not.toContain('prepare:j1');
  });

  test('AC-11: an older epoch that is running is killed and dropped, and its own requeue still completes', async () => {
    const b = build();
    await b.handler.handle([assignCmd('c1', 'j1', 1)]);
    await waitFor(() => b.ex.ticks >= 1);                                 // epoch 1 is running, pid 4242
    b.ex.dieAfterTicks(b.ex.ticks + 2);
    expect((await b.handler.handle([assignCmd('c2', 'j1', 2)]))[0].result).toBe('ok');
    // The ack did not wait for the abandon: epoch 1 still holds the repo mutex, so its retirement is in flight.
    expect(b.journal.getJob('j1', 1)).not.toBeNull();
    await b.supervisor.idle();
    expect(b.journal.getJob('j1', 1)).toBeNull();
    expect(b.ex.killed).toEqual([{ pgid: 4242, signal: 'SIGKILL' }]);
  });

  test('AC-12/13: a failing older-epoch abandon is warned about and the new epoch still prepares', async () => {
    const b = build();
    seedUnfinished(b, 1);
    b.supervisor.abandon = async () => { throw new Error('boom'); };
    b.ex.dieAfterTicks(b.ex.ticks + 2);
    expect((await b.handler.handle([assignCmd('c2', 'j1', 2)]))[0].result).toBe('ok');
    await b.supervisor.idle();
    expect(b.ex.calls).toContain('prepare:j1');
    expect(b.log.lines.some((line) => line.level === 'warn' && line.message === 'older epoch abandon failed')).toBe(true);
  });

  test('AC-14/15: a finished row is dropped at once while a second older row is retired in the background', async () => {
    const b = build();
    seedFinished(b, 1);
    seedUnfinished(b, 2);
    b.ex.dieAfterTicks(b.ex.ticks + 2);
    const release = await b.mutex.acquire('acme/app');
    try {
      expect(await settlesWithin(b.handler.handle([assignCmd('c3', 'j1', 3)])))
        .toEqual({ done: true, value: [{ commandId: 'c3', leaseEpoch: 3, result: 'ok' }] });
      expect(b.journal.getJob('j1', 1)).toBeNull();
    } finally {
      release();
    }
    await b.supervisor.idle();
    expect(b.journal.getJob('j1', 2)).toBeNull();
    expect(b.ex.calls.filter((call) => call === 'prepare:j1')).toHaveLength(1);
  });
});

describe('READOPT replay after restart (K10)', () => {
  const seedReadopt = (kind: 'REVIEW' | 'RUN' | 'THREAD' = 'RUN') => {
    const b = build();
    b.journal.insertJob({ assign: assignFor(kind, { jobId: 'j1' }), leaseEpoch: 1, repoKey: 'acme/app', jobDir: '/work/space/.jobs/j1' });
    b.journal.updateJob('j1', 1, { state: 'RUNNING', pid: 4242, pgid: 4242, ...(kind === 'RUN' ? { naxRunId: 'run-1' } : {}) });
    b.journal.recordCommand({ commandId: 'r1', jobId: 'j1', leaseEpoch: 1, type: 'READOPT', result: 'ok', detail: null, appliedAt: b.time.now().toISOString() });
    return b;
  };
  const readopt = (): FleetCommandOut => other('READOPT', 'r1');

  test('AC-1/2: resumes a live REVIEW watcher and acks ok', async () => {
    const b = seedReadopt('REVIEW');
    b.ex.alive = true;
    expect(await b.handler.handle([readopt()])).toEqual([{ commandId: 'r1', leaseEpoch: 1, result: 'ok' }]);
    await waitFor(() => b.ex.calls.includes('resumeCredentials:j1'));
    expect(b.ex.calls).toContain('resumeCredentials:j1');
    b.ex.dieAfterTicks(b.ex.ticks + 1);
    await b.supervisor.idle();
  });
  test('AC-3/4/5: persists a rejection and replays the updated rejection', async () => {
    const b = seedReadopt();
    b.journal.updateJob('j1', 1, { naxRunId: null });
    const expected: CommandAck[] = [{ commandId: 'r1', leaseEpoch: 1, result: 'rejected', detail: 'run id mismatch' }];
    expect(await b.handler.handle([readopt()])).toEqual(expected);
    expect(b.journal.getCommand('r1')).toMatchObject({ result: 'rejected', detail: 'run id mismatch' });
    expect(await b.handler.handle([readopt()])).toEqual(expected);
  });
  test('AC-6: rejects THREAD replay as an ended session', async () => {
    const b = seedReadopt('THREAD');
    expect(await b.handler.handle([readopt()])).toEqual([{ commandId: 'r1', leaseEpoch: 1, result: 'rejected', detail: 'thread session ended by a runner restart' }]);
  });
  test('AC-7/8: keeps stored ack for done or missing rows without readoption', async () => {
    for (const action of ['done', 'gone'] as const) {
      const b = seedReadopt('REVIEW');
      if (action === 'done') b.journal.markDone('j1', 1);
      else b.journal.abandon('j1', 1);
      const spy = mock(b.supervisor.readopt.bind(b.supervisor));
      b.supervisor.readopt = spy;
      expect(await b.handler.handle([readopt()])).toEqual([{ commandId: 'r1', leaseEpoch: 1, result: 'ok' }]);
      expect(spy).not.toHaveBeenCalled();
      expect(b.ex.calls).not.toContain('readStatus:j1');
    }
  });
  test('AC-9: rejected record replays without readoption', async () => {
    const b = seedReadopt();
    b.journal.updateCommandOutcome('r1', { result: 'rejected', detail: 'process gone', appliedAt: b.time.now().toISOString() });
    const spy = mock(b.supervisor.readopt.bind(b.supervisor));
    b.supervisor.readopt = spy;
    expect(await b.handler.handle([readopt()])).toEqual([{ commandId: 'r1', leaseEpoch: 1, result: 'rejected', detail: 'process gone' }]);
    expect(spy).not.toHaveBeenCalled();
    expect(b.ex.calls).not.toContain('readStatus:j1');
  });
  test('AC-10: second replay finds the in-memory run and does not start another watcher', async () => {
    const b = seedReadopt('REVIEW');
    b.ex.alive = true;
    await b.handler.handle([readopt()]);
    await waitFor(() => b.ex.calls.includes('resumeCredentials:j1'));
    expect(await b.handler.handle([readopt()])).toEqual([{ commandId: 'r1', leaseEpoch: 1, result: 'ok' }]);
    expect(b.ex.calls.filter((call) => call === 'resumeCredentials:j1')).toHaveLength(1);
    b.ex.dieAfterTicks(b.ex.ticks + 1);
    await b.supervisor.idle();
  });
  test('AC-11/12: readopt throw acks runner error and leaves journal unchanged', async () => {
    const b = seedReadopt();
    b.ex.statusError = new Error('failure');
    expect(await b.handler.handle([readopt()])).toEqual([{ commandId: 'r1', leaseEpoch: 1, result: 'rejected', detail: 'runner error' }]);
    expect(b.journal.getCommand('r1')).toMatchObject({ result: 'ok', detail: null });
  });
});

describe('a restart reconstructs the older-epoch retirement (B1)', () => {
  /**
   * The two rows a daemon crash between "ASSIGN acked" and "older epochs retired" leaves behind: epoch 1 RUNNING with
   * the detached process it spawned, epoch 2 ASSIGNED with no pid. The retirement promise lasted only in the process
   * that died with it.
   */
  const seedCrashedRequeue = (b: ReturnType<typeof build>): void => {
    b.journal.insertJob({ assign: assignFor('RUN', { jobId: 'j1' }), leaseEpoch: 1, repoKey: 'acme/app', jobDir: '/work/space/.jobs/j1' });
    b.journal.updateJob('j1', 1, { state: 'RUNNING', pid: 4242, pgid: 4242 });
    b.journal.insertJob({ assign: assignFor('RUN', { jobId: 'j1' }), leaseEpoch: 2, repoKey: 'acme/app', jobDir: '/work/space/.jobs/j1' });
  };
  /** D64 kept across the restart: epoch 1 is killed and gone before epoch 2 prepares, and epoch 2 finishes normally. */
  const expectRetiredBeforePrepare = (b: ReturnType<typeof build>, atPrepare: () => JobRow | null | undefined): void => {
    expect(atPrepare()).toBeNull();
    expect(b.journal.getJob('j1', 1)).toBeNull();
    expect(b.ex.killed).toContainEqual({ pgid: 4242, signal: 'SIGKILL' });
    expect(b.journal.getJob('j1', 2)?.state).toBe('COMPLETED');
  };
  const watchPrepare = (b: ReturnType<typeof build>): (() => JobRow | null | undefined) => {
    let olderAtPrepare: JobRow | null | undefined;
    const prepare = b.ex.prepare.bind(b.ex);
    b.ex.prepare = async (job) => { olderAtPrepare = b.journal.getJob('j1', 1); return prepare(job); };
    return () => olderAtPrepare;
  };

  test('B1: a READOPT replay of the new ASSIGNED epoch retires the older row before it prepares', async () => {
    const b = build();
    seedCrashedRequeue(b);
    b.journal.recordCommand({ commandId: 'r1', jobId: 'j1', leaseEpoch: 2, type: 'READOPT', result: 'ok', detail: null, appliedAt: b.time.now().toISOString() });
    b.ex.alive = true;                                             // epoch 1's detached nax is still ours and running
    b.ex.dieAfterTicks(b.ex.ticks + 2);
    const atPrepare = watchPrepare(b);
    expect(await b.handler.handle([other('READOPT', 'r1', 2)])).toEqual([{ commandId: 'r1', leaseEpoch: 2, result: 'ok' }]);
    await b.supervisor.idle();
    expectRetiredBeforePrepare(b, atPrepare);
  });

  test('B1: an ASSIGN replay (resumeStranded) retires the older row before it prepares', async () => {
    const b = build();
    seedCrashedRequeue(b);
    b.journal.recordCommand({ commandId: 'c2', jobId: 'j1', leaseEpoch: 2, type: 'ASSIGN', result: 'ok', detail: null, appliedAt: b.time.now().toISOString() });
    b.ex.alive = true;
    b.ex.dieAfterTicks(b.ex.ticks + 2);
    const atPrepare = watchPrepare(b);
    expect(await b.handler.handle([assignCmd('c2', 'j1', 2)])).toEqual([{ commandId: 'c2', leaseEpoch: 2, result: 'ok' }]);
    await b.supervisor.idle();
    expectRetiredBeforePrepare(b, atPrepare);
  });
});

describe('a READOPT rejection is durable with its finalization (B2)', () => {
  /** The r1 record acked `ok` before the restart, over a RUN row whose journaled run id is gone: readopt rejects. */
  const seed = () => {
    const b = build();
    b.journal.insertJob({ assign: assignFor('RUN', { jobId: 'j1' }), leaseEpoch: 1, repoKey: 'acme/app', jobDir: '/work/space/.jobs/j1' });
    b.journal.updateJob('j1', 1, { state: 'RUNNING', pid: 4242, pgid: 4242, naxRunId: null });
    b.journal.recordCommand({ commandId: 'r1', jobId: 'j1', leaseEpoch: 1, type: 'READOPT', result: 'ok', detail: null, appliedAt: b.time.now().toISOString() });
    return b;
  };
  const replay = [other('READOPT', 'r1')];

  test('B2: a crash right after readopt returns leaves the rejection journaled, never a stale ok', async () => {
    const b = seed();
    const real = b.supervisor.readopt.bind(b.supervisor);
    // The daemon dies between readopt's answer and the handler's own write: nothing after the call runs.
    b.supervisor.readopt = async (jobId, leaseEpoch, finalize) => {
      await real(jobId, leaseEpoch, finalize);
      throw new Error('daemon died here');
    };
    expect(await b.handler.handle(replay)).toEqual([{ commandId: 'r1', leaseEpoch: 1, result: 'rejected', detail: 'runner error' }]);
    expect(b.journal.getCommand('r1')).toMatchObject({ result: 'rejected', detail: 'run id mismatch' });
    // The next boot replays the rejection, so the API marks the job CRASHED instead of recording it as adopted.
    b.supervisor.readopt = real;
    expect(await b.handler.handle(replay)).toEqual([{ commandId: 'r1', leaseEpoch: 1, result: 'rejected', detail: 'run id mismatch' }]);
  });

  test('B2: a crash inside the finalization rolls back doneAt and the outcome together, so the next boot re-applies', async () => {
    const b = seed();
    const markDone = b.journal.markDone.bind(b.journal);
    b.journal.markDone = (jobId, leaseEpoch) => {
      markDone(jobId, leaseEpoch);
      throw new Error('daemon died here');
    };
    expect(await b.handler.handle(replay)).toEqual([{ commandId: 'r1', leaseEpoch: 1, result: 'rejected', detail: 'runner error' }]);
    // One durable step: the row is not done either, so no boot can see a done row beside the stale ok.
    expect(b.journal.getJob('j1', 1)?.doneAt).toBeNull();
    expect(b.journal.getCommand('r1')).toMatchObject({ result: 'ok' });
    b.journal.markDone = markDone;
    expect(await b.handler.handle(replay)).toEqual([{ commandId: 'r1', leaseEpoch: 1, result: 'rejected', detail: 'run id mismatch' }]);
    expect(b.journal.getCommand('r1')).toMatchObject({ result: 'rejected', detail: 'run id mismatch' });
  });
});

describe('CANCEL, ABANDON, READOPT and unknown types', () => {
  test('CANCEL of a held job is ok; of an unknown job is rejected with does not hold job', async () => {
    const b = build();
    await b.handler.handle([assignCmd()]);
    await waitFor(() => b.ex.ticks >= 1);
    const acks = await b.handler.handle([other('CANCEL', 'k1'), { ...other('CANCEL', 'k2'), jobId: 'ghost' }]);
    expect(acks).toEqual([
      { commandId: 'k1', leaseEpoch: 1, result: 'ok' },
      { commandId: 'k2', leaseEpoch: 1, result: 'rejected', detail: 'does not hold job' },
    ]);
    expect(b.ex.killed[0].signal).toBe('SIGTERM');
    await b.supervisor.idle();
  });
  test('ABANDON drops that epoch and acks ok even when nothing is held', async () => {
    const b = build();
    b.ex.dieAfterTicks(1);
    await b.handler.handle([assignCmd('c1', 'j1', 1)]);
    await b.supervisor.idle();
    // US-001: the ABANDON's ack is deferred until its retirement is durable, so the poll is not held by the cleanup.
    expect(await b.handler.handle([other('ABANDON', 'a1', 1), { ...other('ABANDON', 'a2', 7), jobId: 'ghost' }])).toEqual([]);
    await b.supervisor.idle();
    await b.handler.idle();
    expect(b.acks.map((a) => a.result)).toEqual(['ok', 'ok']);
    expect(b.journal.getJob('j1', 1)).toBeNull();
  });
  test('READOPT is delegated and its ack replays', async () => {
    const b = build();
    b.journal.insertJob({ assign: assignFor(), leaseEpoch: 1, repoKey: 'acme/app', jobDir: '/work/space/.jobs/j1' });
    b.journal.updateJob('j1', 1, { state: 'COMPLETED' });
    const first = await b.handler.handle([other('READOPT', 'r1')]);
    expect(first).toEqual([{ commandId: 'r1', leaseEpoch: 1, result: 'ok' }]);
    expect(await b.handler.handle([other('READOPT', 'r1')])).toEqual(first);
    const rejected = await b.handler.handle([{ ...other('READOPT', 'r2'), jobId: 'ghost' }]);
    expect(rejected).toEqual([{ commandId: 'r2', leaseEpoch: 1, result: 'rejected', detail: 'unknown job' }]);
  });
  test('an unknown command type is rejected, and a throwing supervisor never escapes the handler', async () => {
    const b = build();
    const acks = await b.handler.handle([{ ...other('CANCEL', 'x1'), type: 'REBOOT' as never }]);
    expect(acks[0]).toMatchObject({ result: 'rejected', detail: 'unknown command type' });
    b.supervisor.cancel = () => { throw new Error('boom'); };
    const [ack] = await b.handler.handle([other('CANCEL', 'x2')]);
    expect(ack).toMatchObject({ commandId: 'x2', result: 'rejected', detail: 'runner error' });
  });
  test('a non-string command type is journaled as the literal "unknown" (TYPE-2)', async () => {
    const b = build();
    const acks = await b.handler.handle([{ ...other('CANCEL', 'u1'), type: 1 as never }]);
    expect(acks[0]).toMatchObject({ result: 'rejected', detail: 'unknown command type' });
    expect(b.journal.getCommand('u1')).toMatchObject({ type: 'unknown', result: 'rejected', detail: 'unknown command type' });
  });
});

describe('APPROVAL_ANSWER (spec §4.4)', () => {
  const answer = { commandId: 'c9', type: 'APPROVAL_ANSWER', jobId: 'j1', leaseEpoch: 1, payload: { approvalId: 'a1', naxAskId: 'ask-1', choice: 'allow' } } as const;

  test('delegates to the relay and acks its outcome', async () => {
    const { handler, approvals } = build();
    expect(await handler.handle([answer])).toEqual([{ commandId: 'c9', leaseEpoch: 1, result: 'ok' }]);
    approvals.answer.mockResolvedValueOnce({ result: 'rejected', detail: 'callback_failed:429' });
    expect(await handler.handle([{ ...answer, commandId: 'c10' }])).toEqual([{ commandId: 'c10', leaseEpoch: 1, result: 'rejected', detail: 'callback_failed:429' }]);
  });

  test('a re-sent answer is acked from the applied-command record; nax is not POSTed twice (Review Focus 4)', async () => {
    const { handler, approvals } = build();
    await handler.handle([answer]);
    expect(await handler.handle([answer])).toEqual([{ commandId: 'c9', leaseEpoch: 1, result: 'ok' }]);
    expect(approvals.answer).toHaveBeenCalledTimes(1);
  });
});

/**
 * US-001: an ABANDON retires its epoch outside the poll. The poll must stay free (a job waiting for a token is
 * served while the retirement waits), the cleanup runs once, and the ack is offered only once the outcome is durable.
 */
describe('an ABANDON retires outside the poll (US-001)', () => {
  const abandonCmd = (id = 'a1', jobId = 'j1', epoch = 1): FleetCommandOut => ({ commandId: id, type: 'ABANDON', jobId, leaseEpoch: epoch, payload: { reason: 'stale_lease' } });
  /** The epoch as a stale lease: a run this runner held and the server has fenced. */
  const seedStale = (b: ReturnType<typeof build>, epoch = 1): void => {
    b.journal.insertJob({ assign: assignFor('RUN', { jobId: 'j1' }), leaseEpoch: epoch, repoKey: 'acme/app', jobDir: '/work/space/.jobs/j1' });
    b.journal.updateJob('j1', epoch, { state: 'RUNNING', pid: 4242, pgid: 4242 });
  };

  test('AC-3: a repeated ABANDON joins the first retirement and the completed delivery replays the stored outcome', async () => {
    const b = build();
    seedStale(b);
    const release = await b.mutex.acquire('acme/app');        // another job's long RUN holds the repo lock
    try {
      expect(await settlesWithin(b.handler.handle([abandonCmd()]))).toEqual({ done: true, value: [] });   // no ack while the cleanup waits
      expect(await settlesWithin(b.handler.handle([abandonCmd()]))).toEqual({ done: true, value: [] });   // a repeated command joins it
      expect(b.ex.calls.filter((c) => c === 'cleanup:j1')).toEqual([]);                                   // and no second cleanup started
    } finally {
      release();
    }
    await b.supervisor.idle();
    await b.handler.idle();
    expect(b.ex.calls.filter((c) => c === 'cleanup:j1')).toHaveLength(1);                                  // one cleanup
    expect(b.acks).toEqual([{ commandId: 'a1', leaseEpoch: 1, result: 'ok' }]);
    expect(await b.handler.handle([abandonCmd()])).toEqual([{ commandId: 'a1', leaseEpoch: 1, result: 'ok' }]);   // the stored outcome
    expect(b.ex.calls.filter((c) => c === 'cleanup:j1')).toHaveLength(1);                                  // and never again
  });

  test('AC-5: a restart before the outcome is recorded finishes the outstanding cleanup on the redelivery', async () => {
    const b = build();
    seedStale(b);
    b.supervisor.abandon = async () => { await new Promise<void>(() => undefined); };   // the daemon dies inside the retirement
    expect(await settlesWithin(b.handler.handle([abandonCmd()]))).toEqual({ done: true, value: [] });
    expect(b.journal.getCommand('a1')).toBeNull();                                    // no outcome was recorded

    const restarted = build({ journal: b.journal });                                  // the restart: a new handler over the same rows
    expect(await settlesWithin(restarted.handler.handle([abandonCmd()]))).toEqual({ done: true, value: [] });
    await restarted.supervisor.idle();
    await restarted.handler.idle();
    expect(restarted.ex.calls).toContain('cleanup:j1');                               // the outstanding cleanup finished
    expect(restarted.journal.getCommand('a1')).toMatchObject({ result: 'ok', type: 'ABANDON' });
    expect(restarted.acks).toEqual([{ commandId: 'a1', leaseEpoch: 1, result: 'ok' }]);
  });

  test('AC-5: after the outcome is recorded a restart replays it and never repeats the execution', async () => {
    const b = build();
    seedStale(b);
    expect(await settlesWithin(b.handler.handle([abandonCmd()]))).toEqual({ done: true, value: [] });
    await b.supervisor.idle();
    await b.handler.idle();
    expect(b.journal.getCommand('a1')).toMatchObject({ result: 'ok' });

    const restarted = build({ journal: b.journal });                                  // the ack was lost; the server redelivers
    expect(await restarted.handler.handle([abandonCmd()])).toEqual([{ commandId: 'a1', leaseEpoch: 1, result: 'ok' }]);
    expect(restarted.ex.calls).toEqual([]);                                            // no repeated execution
  });

  test('AC-5: an error escaping supervisor.abandon is a recorded rejection, and a deleted epoch never turns it into a success', async () => {
    const b = build();
    seedStale(b);
    b.supervisor.abandon = async () => { throw new Error('boom'); };
    expect(await settlesWithin(b.handler.handle([abandonCmd()]))).toEqual({ done: true, value: [] });
    await b.handler.idle();
    expect(b.journal.getCommand('a1')).toMatchObject({ result: 'rejected', detail: 'runner error' });
    expect(b.acks).toEqual([{ commandId: 'a1', leaseEpoch: 1, result: 'rejected', detail: 'runner error' }]);

    b.journal.abandon('j1', 1);                                                       // the epoch is gone
    const restarted = build({ journal: b.journal });
    expect(await restarted.handler.handle([abandonCmd()])).toEqual([{ commandId: 'a1', leaseEpoch: 1, result: 'rejected', detail: 'runner error' }]);
  });

  test('AC-7: a failed outcome write queues no ack, and the redelivery records the outcome once the storage recovers', async () => {
    const b = build();
    seedStale(b);
    const record = b.journal.recordCommand.bind(b.journal);
    let broken = true;
    b.journal.recordCommand = (row) => { if (broken) throw new Error('disk full'); return record(row); };
    expect(await settlesWithin(b.handler.handle([abandonCmd()]))).toEqual({ done: true, value: [] });
    await b.supervisor.idle();
    await b.handler.idle();
    expect(b.acks).toEqual([]);                                                       // no ack without a durable outcome
    expect(b.journal.getCommand('a1')).toBeNull();
    expect(b.log.lines.some((line) => line.level === 'error' && line.message === 'abandon outcome could not be persisted')).toBe(true);

    broken = false;
    expect(await settlesWithin(b.handler.handle([abandonCmd()]))).toEqual({ done: true, value: [] });
    await b.handler.idle();
    expect(b.acks).toEqual([{ commandId: 'a1', leaseEpoch: 1, result: 'ok' }]);        // the epoch is gone: an idempotent success
    expect(b.journal.getCommand('a1')).toMatchObject({ result: 'ok' });
  });

  test('AC-8: an explicit ABANDON and an unknown-job cleanup share one retirement', async () => {
    const b = build();
    seedStale(b);
    b.ex.alive = true;
    b.ex.procMatches = false;                                                         // the journaled process is not ours any more
    const release = await b.mutex.acquire('acme/app');
    try {
      expect(await settlesWithin(b.handler.handle([abandonCmd()]))).toEqual({ done: true, value: [] });
      b.supervisor.retireUnknown('j1');                                               // the server reports the job as unknown
      b.journal.insertJob({ assign: assignFor('RUN', { jobId: 'j1' }), leaseEpoch: 2, repoKey: 'acme/app', jobDir: '/work/space/.jobs/j1' });
    } finally {
      release();
    }
    await b.supervisor.idle();
    await b.handler.idle();
    expect(b.ex.calls.filter((c) => c === 'releaseCredentials:j1')).toHaveLength(1);   // one shared retirement
    expect(b.ex.killed).toEqual([]);                                                  // a mismatching identity is never killed
    expect(b.ex.calls).not.toContain('cleanup:j1');                                   // the owned higher epoch keeps its checkout
    expect(b.journal.getJob('j1', 1)).toBeNull();
    expect(b.journal.getJob('j1', 2)).not.toBeNull();                                  // the higher epoch survives
  });
});
