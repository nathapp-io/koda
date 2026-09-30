import { describe, expect, test } from 'bun:test';
import type { AssignPayload } from '@nathapp/fleet-protocol';
import type { UploadOutcome } from '../bundle/upload-bundle';
import { Journal } from '../journal/journal';
import { createMemoryLogger } from '../logger';
import { assignFor } from '../../test/helpers/assign';
import { FakeExecutor } from '../../test/helpers/fake-executor';
import { fakeTime } from '../../test/helpers/fake-time';
import { waitFor } from '../../test/helpers/wait';
import { RepoMutex } from './repo-mutex';
import { Supervisor } from './supervisor';

function build() {
  const time = fakeTime();
  const journal = Journal.open(':memory:', time.now);
  const ex = new FakeExecutor();
  const outcomes: UploadOutcome[] = [];
  const supervisor = new Supervisor({
    journal, executor: ex, mutex: new RepoMutex(), log: createMemoryLogger(), now: time.now, sleep: time.sleep,
    uploader: { upload: async () => outcomes.shift() ?? { kind: 'ok' } },
    tuning: { statusPollMs: 2_000, killGraceMs: 30_000, ackPollMs: 250, uploadAckWaitMs: 0 }, readoptHeartbeatMs: 120_000,
  });
  const add = (over: Partial<AssignPayload> = {}, epoch = 1, command: 'RUN' | 'PLAN' = 'RUN') =>
    journal.insertJob({ assign: assignFor(command, over), leaseEpoch: epoch, repoKey: 'acme/app', jobDir: `/w/.jobs/${over.jobId ?? 'j1'}` }).row;
  return { time, journal, ex, outcomes, supervisor, add };
}
const stateNames = (b: ReturnType<typeof build>, id = 'j1', epoch = 1) =>
  b.journal.pendingEvents(id, epoch, 1_000).filter((e) => e.type === 'state').map((e) => (e.payload as { to: string }).to);

describe('begin and idle', () => {
  test('starts a run, ignores a second begin for the same (job, epoch), and idle waits for the end', async () => {
    const b = build();
    b.ex.dieAfterTicks(1);
    const row = b.add();
    b.supervisor.begin(row, 'prepare');
    b.supervisor.begin(row, 'prepare');
    await b.supervisor.idle();
    expect(b.ex.calls.filter((c) => c === 'prepare:j1')).toHaveLength(1);
    expect(stateNames(b).at(-1)).toBe('COMPLETED');
  });
});

describe('cancel', () => {
  test('signals a live run; unknown jobs are unknown; a job with no run only records the cancel (it is validated at readopt)', async () => {
    const b = build();
    const row = b.add();
    b.supervisor.begin(row, 'prepare');
    await waitFor(() => b.ex.ticks >= 1);
    expect(b.supervisor.cancel('j1', 1)).toBe('ok');
    await b.supervisor.idle();
    expect(b.ex.killed[0].signal).toBe('SIGTERM');
    expect(b.supervisor.cancel('ghost', 1)).toBe('unknown');
    const other = build();
    other.add({ jobId: 'idle' });
    expect(other.supervisor.cancel('idle', 1)).toBe('ok');
    expect(other.journal.getJob('idle', 1)?.cancelRequestedAt).not.toBeNull();
    expect(other.ex.killed).toEqual([]);
  });
  test('cancelling a finished job is ok and changes nothing', async () => {
    const b = build();
    b.add();
    b.journal.updateJob('j1', 1, { state: 'COMPLETED' });
    b.journal.markDone('j1', 1);
    expect(b.supervisor.cancel('j1', 1)).toBe('ok');
    expect(b.journal.getJob('j1', 1)?.cancelRequestedAt).toBeNull();
  });
});

describe('abandon (D49, Review focus 4)', () => {
  test('is keyed by epoch: the stale epoch is dropped and killed, the newer epoch is untouched', async () => {
    const b = build();
    b.add({}, 1);
    b.add({}, 2);
    b.journal.updateJob('j1', 1, { state: 'RUNNING', pid: 4242, pgid: 4242 });
    b.journal.appendEvent('j1', 1, 'log', { stream: 'run', text: 'old' });
    b.journal.appendEvent('j1', 2, 'log', { stream: 'run', text: 'new' });
    b.ex.alive = true;
    await b.supervisor.abandon('j1', 1);
    expect(b.journal.getJob('j1', 1)).toBeNull();
    expect(b.journal.getJob('j1', 2)).not.toBeNull();
    expect(b.journal.pendingEvents('j1', 2, 10)).toHaveLength(1);
    expect(b.ex.killed).toEqual([{ pgid: 4242, signal: 'SIGKILL' }]);
  });
  test('does not signal a pid that is no longer this job (recycled), and tolerates an unknown job', async () => {
    const b = build();
    b.add();
    b.journal.updateJob('j1', 1, { state: 'RUNNING', pid: 4242, pgid: 4242 });
    b.ex.alive = true;
    b.ex.procMatches = false;
    await b.supervisor.abandon('j1', 1);
    expect(b.ex.killed).toEqual([]);
    await b.supervisor.abandon('ghost', 9);
  });
  test('abandonAll drops every epoch of a job the server does not know', async () => {
    const b = build();
    b.add({}, 1);
    b.add({}, 2);
    await b.supervisor.abandonAll('j1');
    expect(b.journal.jobsById('j1')).toEqual([]);
  });
  test('abandoning a live run stops it without further events', async () => {
    const b = build();
    const row = b.add();
    b.supervisor.begin(row, 'prepare');
    await waitFor(() => b.ex.ticks >= 1);
    await b.supervisor.abandon('j1', 1);
    await b.supervisor.idle();
    expect(b.journal.getJob('j1', 1)).toBeNull();
  });
});

describe('readopt (design §2 control paths, D33, D54)', () => {
  const running = (b: ReturnType<typeof build>, over: Record<string, unknown> = {}, command: 'RUN' | 'PLAN' = 'RUN') => {
    b.add({}, 1, command);
    b.journal.updateJob('j1', 1, { state: 'RUNNING', pid: 4242, pgid: 4242, naxRunId: 'run-1', ...over });
    return b.journal.getJob('j1', 1);
  };
  const freshStatus = (b: ReturnType<typeof build>, over: Record<string, unknown> = {}) => ({
    run: { id: 'run-1', status: 'running' }, lastHeartbeat: b.time.now().toISOString(), ...over,
  });

  test('pid alive, run id matches, heartbeat fresh: ok, and the watcher attaches at end of file', async () => {
    const b = build();
    running(b);
    b.ex.alive = true;
    b.ex.status = freshStatus(b) as never;
    b.ex.dieAfterTicks(2);
    b.ex.status = { run: { id: 'run-1', status: 'running' }, lastHeartbeat: b.time.now().toISOString() };
    expect(await b.supervisor.readopt('j1', 1)).toEqual({ result: 'ok' });
    await b.supervisor.idle();
    expect(b.ex.watchOptions[0].startAtEnd).toBe(true);
    expect(b.ex.calls).not.toContain('prepare:j1');
  });
  test('a second READOPT while attached is ok and starts nothing new', async () => {
    const b = build();
    running(b);
    b.ex.alive = true;
    b.ex.status = freshStatus(b) as never;
    await b.supervisor.readopt('j1', 1);
    await waitFor(() => b.ex.ticks >= 1);
    expect(await b.supervisor.readopt('j1', 1)).toEqual({ result: 'ok' });
    expect(b.ex.watchOptions).toHaveLength(1);
    b.ex.alive = false;
    await b.supervisor.idle();
  });
  test('pid alive but the run id differs and the pid is not this job (a recycled pid): rejected, reaped, cleaned, done, nothing signalled', async () => {
    const b = build();
    running(b);
    b.ex.alive = true;
    b.ex.procMatches = false;
    b.ex.status = freshStatus(b, { run: { id: 'someone-else', status: 'running' } }) as never;
    expect(await b.supervisor.readopt('j1', 1)).toEqual({ result: 'rejected', detail: 'run id mismatch' });
    expect(b.ex.calls).toEqual(expect.arrayContaining(['reap:j1', 'cleanup:j1']));
    expect(b.journal.getJob('j1', 1)?.doneAt).not.toBeNull();
    expect(b.ex.killed).toEqual([]);
  });
  test('pid alive, run id matches, heartbeat older than 2 minutes: rejected, and the stale nax is SIGKILLed before the reap (D65)', async () => {
    const b = build();
    running(b);
    b.ex.alive = true;
    b.ex.onKill = (signal) => { b.ex.calls.push(`kill:${signal}`); b.ex.alive = false; };
    b.ex.status = freshStatus(b, { lastHeartbeat: new Date(b.time.nowMs() - 121_000).toISOString() }) as never;
    expect(await b.supervisor.readopt('j1', 1)).toEqual({ result: 'rejected', detail: 'stale heartbeat' });
    expect(b.ex.killed).toEqual([{ pgid: 4242, signal: 'SIGKILL' }]);
    expect(b.ex.calls.indexOf('kill:SIGKILL')).toBeGreaterThan(-1);
    expect(b.ex.calls.indexOf('kill:SIGKILL')).toBeLessThan(b.ex.calls.indexOf('reap:j1'));
    expect(b.ex.calls.indexOf('reap:j1')).toBeLessThan(b.ex.calls.indexOf('cleanup:j1'));
    expect(b.journal.getJob('j1', 1)?.doneAt).not.toBeNull();
  });
  test('pid alive, it is this job\'s nax, but its run id is not the journaled one: rejected and killed', async () => {
    const b = build();
    running(b);
    b.ex.alive = true;
    b.ex.status = freshStatus(b, { run: { id: 'a-newer-run', status: 'running' } }) as never;
    expect(await b.supervisor.readopt('j1', 1)).toEqual({ result: 'rejected', detail: 'run id mismatch' });
    expect(b.ex.killed).toEqual([{ pgid: 4242, signal: 'SIGKILL' }]);
  });
  test('pid gone, status final and matching: ok, the run finishes and reports normally (finished while the daemon was down)', async () => {
    const b = build();
    running(b);
    b.ex.alive = false;
    b.ex.status = { run: { id: 'run-1', status: 'completed' }, postRun: { finish: { status: 'passed', result: 'opened', url: 'https://example.test/pr/1' } } };
    expect(await b.supervisor.readopt('j1', 1)).toEqual({ result: 'ok' });
    await b.supervisor.idle();
    expect(stateNames(b)).toEqual(['UPLOADING', 'COMPLETED']);       // RUNNING was reported before the daemon went down
  });
  test('pid gone and status still running (nax died without a final write): rejected', async () => {
    const b = build();
    running(b);
    b.ex.alive = false;
    b.ex.status = freshStatus(b) as never;
    expect(await b.supervisor.readopt('j1', 1)).toEqual({ result: 'rejected', detail: 'process gone' });
  });
  test('no status.json or no journaled run id: rejected', async () => {
    const a = build();
    running(a);
    a.ex.alive = true;
    a.ex.status = null;
    expect((await a.supervisor.readopt('j1', 1)).result).toBe('rejected');
    const c = build();
    running(c, { naxRunId: null });
    c.ex.alive = true;
    c.ex.status = freshStatus(c) as never;
    expect((await c.supervisor.readopt('j1', 1)).result).toBe('rejected');
  });
  test('a job still ASSIGNED with no pid reaps, re-runs prepare and is acked ok (D33, D65)', async () => {
    const b = build();
    b.add();
    b.ex.dieAfterTicks(1);
    expect(await b.supervisor.readopt('j1', 1)).toEqual({ result: 'ok' });
    await b.supervisor.idle();
    expect(b.ex.calls.slice(0, 2)).toEqual(['reap:j1', 'prepare:j1']);
    expect(stateNames(b).at(-1)).toBe('COMPLETED');
  });
  test('a RUNNING job with no recorded pid is rejected', async () => {
    const b = build();
    b.add();
    b.journal.updateJob('j1', 1, { state: 'RUNNING' });
    expect((await b.supervisor.readopt('j1', 1)).result).toBe('rejected');
  });
  test('a terminal journal state is only cleaned up, ok', async () => {
    const b = build();
    b.add();
    b.journal.updateJob('j1', 1, { state: 'COMPLETED' });
    expect(await b.supervisor.readopt('j1', 1)).toEqual({ result: 'ok' });
    expect(b.ex.calls).toEqual(['cleanup:j1']);
    expect(b.journal.getJob('j1', 1)?.doneAt).not.toBeNull();
  });
  test('an unknown job is rejected', async () => {
    expect(await build().supervisor.readopt('ghost', 1)).toEqual({ result: 'rejected', detail: 'unknown job' });
  });
  test('PLAN: a live process that is this job is watched; a dead or foreign one goes to the finish path (no status.json to judge by)', async () => {
    const live = build();
    running(live, { naxRunId: null }, 'PLAN');
    live.ex.alive = true;
    live.ex.dieAfterTicks(2);
    expect(await live.supervisor.readopt('j1', 1)).toEqual({ result: 'ok' });
    await live.supervisor.idle();
    expect(live.ex.watchOptions).toHaveLength(1);
    expect(stateNames(live).at(-1)).toBe('COMPLETED');

    const dead = build();
    running(dead, { naxRunId: null }, 'PLAN');
    dead.ex.alive = false;
    expect(await dead.supervisor.readopt('j1', 1)).toEqual({ result: 'ok' });
    await dead.supervisor.idle();
    expect(dead.ex.watchOptions).toHaveLength(0);
    expect(dead.ex.calls).toContain('readPlan:j1');

    const foreign = build();
    running(foreign, { naxRunId: null }, 'PLAN');
    foreign.ex.alive = true;
    foreign.ex.procMatches = false;
    expect(await foreign.supervisor.readopt('j1', 1)).toEqual({ result: 'ok' });
    expect(foreign.ex.watchOptions).toHaveLength(0);
    foreign.ex.alive = false;
    await foreign.supervisor.idle();
  });
});

describe('shutdown', () => {
  test('halts every run without touching a child', async () => {
    const b = build();
    const row = b.add();
    b.supervisor.begin(row, 'prepare');
    await waitFor(() => b.ex.ticks >= 1);
    b.supervisor.shutdown();
    await b.supervisor.idle();
    expect(b.ex.killed).toEqual([]);
    expect(stateNames(b)).toEqual(['RUNNING']);
  });
});
