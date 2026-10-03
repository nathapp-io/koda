import { describe, expect, mock, test } from 'bun:test';
import type { FleetCommandOut } from '@nathapp/fleet-protocol';
import { Journal } from '../journal/journal';
import { createMemoryLogger } from '../logger';
import { assignFor } from '../../test/helpers/assign';
import { FakeExecutor } from '../../test/helpers/fake-executor';
import { fakeTime } from '../../test/helpers/fake-time';
import { waitFor } from '../../test/helpers/wait';
import { CommandHandler } from './command-handler';
import { RepoMutex } from './repo-mutex';
import { Supervisor } from './supervisor';

function build() {
  const time = fakeTime();
  const journal = Journal.open(':memory:', time.now);
  const ex = new FakeExecutor();
  const log = createMemoryLogger();
  const supervisor = new Supervisor({
    journal, executor: ex, mutex: new RepoMutex(), log, now: time.now, sleep: time.sleep,
    uploader: { upload: async () => ({ kind: 'ok' }) }, tuning: { statusPollMs: 2_000, killGraceMs: 30_000, ackPollMs: 250, uploadAckWaitMs: 0 }, readoptHeartbeatMs: 120_000,
  });
  const approvals = { answer: mock(async (): Promise<{ result: 'ok' | 'rejected'; detail?: string }> => ({ result: 'ok' })) };
  const handler = new CommandHandler({ journal, supervisor, workspaceRoot: '/work/space', log, now: time.now, approvals });
  return { time, journal, ex, supervisor, handler, approvals };
}
const assignCmd = (id = 'c1', jobId = 'j1', epoch = 1): FleetCommandOut => ({ commandId: id, type: 'ASSIGN', jobId, leaseEpoch: epoch, payload: assignFor('RUN', { jobId }) });
const other = (type: FleetCommandOut['type'], id: string, epoch = 1): FleetCommandOut => ({ commandId: id, type, jobId: 'j1', leaseEpoch: epoch, payload: {} });

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
    await b.handler.handle([assignCmd('c1', 'j1', 1)]);
    await waitFor(() => b.ex.ticks >= 1);                        // epoch 1 is running, pid 4242
    b.ex.dieAfterTicks(b.ex.ticks + 2);                          // epoch 2 will finish quickly once it runs
    expect((await b.handler.handle([assignCmd('c2', 'j1', 2)]))[0].result).toBe('ok');
    expect(b.journal.getJob('j1', 1)).toBeNull();
    expect(b.ex.killed).toEqual([{ pgid: 4242, signal: 'SIGKILL' }]);
    await b.supervisor.idle();
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
    const acks = await b.handler.handle([other('ABANDON', 'a1', 1), { ...other('ABANDON', 'a2', 7), jobId: 'ghost' }]);
    expect(acks.map((a) => a.result)).toEqual(['ok', 'ok']);
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
