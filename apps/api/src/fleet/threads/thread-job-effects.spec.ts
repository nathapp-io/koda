import { Prisma } from '../../generated/prisma/client';
import { FleetCommandType } from '../../common/enums';
import type { FleetCommandRecord, FleetJobRecord } from '../jobs/domain/fleet-job.domain';
import { ThreadJobEffects } from './thread-job-effects';

function fakePrisma(opts: { threadPendingQuestion?: unknown; threadId?: string } = {}) {
  const thread = { id: opts.threadId ?? 'T', pendingQuestion: (opts.threadPendingQuestion ?? { requestId: 'q1', text: 'Which repo?', expiresAt: 'E' }) as unknown };
  const fleetJob = { findUnique: vi.fn(async () => ({ id: 'J', threadId: thread.id })) };
  const chatThread = {
    findUnique: vi.fn(async () => thread),
    update: vi.fn(async ({ data }: { data: { pendingQuestion: unknown } }) => Object.assign(thread, data)),
  };
  const fleetCommand = { update: vi.fn(async () => ({})) };
  const chatMessage = { updateMany: vi.fn(async () => ({ count: 0 })) };
  const client = { fleetJob, chatThread, fleetCommand, chatMessage };
  return { prisma: { client } as never, thread, client, chatThread, fleetCommand, fleetJob };
}

const answerCommand = (over: Partial<FleetCommandRecord> = {}): FleetCommandRecord => ({
  id: 'cmd1', runnerId: 'R', jobId: 'J', type: FleetCommandType.THREAD_ANSWER, leaseEpoch: 1,
  payload: { requestId: 'q1', text: 'acme/app' }, createdAt: new Date(0), deliveredAt: null, ackedAt: null, ackResult: null,
  ...over,
});

describe('ThreadJobEffects.onInputAck (US-004)', () => {
  it('US-004 AC10: an ok ack for a THREAD_ANSWER clears the thread pendingQuestion when the requestId matches', async () => {
    const { prisma, thread } = fakePrisma();
    await new ThreadJobEffects(prisma).onInputAck(answerCommand(), 'ok', '');
    expect(thread.pendingQuestion).toBe(Prisma.DbNull);
  });

  it('US-004 AC11: a rejected ack for a THREAD_ANSWER keeps the thread pendingQuestion', async () => {
    const { prisma, thread } = fakePrisma();
    await new ThreadJobEffects(prisma).onInputAck(answerCommand(), 'rejected', 'not_pending');
    expect(thread.pendingQuestion).toMatchObject({ requestId: 'q1' });
  });

  it('US-004 AC10: an ok ack for a THREAD_ANSWER keeps a pendingQuestion with a different requestId', async () => {
    const { prisma, thread } = fakePrisma({ threadPendingQuestion: { requestId: 'q2', text: 'Next?', expiresAt: 'E' } });
    await new ThreadJobEffects(prisma).onInputAck(answerCommand(), 'ok', '');
    expect(thread.pendingQuestion).toMatchObject({ requestId: 'q2' });
  });

  it('US-004 AC10: an ok ack for a THREAD_ANSWER reads the command job and clears the pendingQuestion of its thread', async () => {
    const { prisma, chatThread, fleetJob } = fakePrisma({ threadId: 'T9' });
    await new ThreadJobEffects(prisma).onInputAck(answerCommand(), 'ok', '');
    expect(fleetJob.findUnique).toHaveBeenCalledWith({ where: { id: 'J' }, select: { id: true, threadId: true } });
    expect(chatThread.update).toHaveBeenCalledWith({ where: { id: 'T9' }, data: { pendingQuestion: Prisma.DbNull } });
  });

  it('US-004 AC10: the ack still rewrites the command payload to the requestId', async () => {
    const { prisma, fleetCommand } = fakePrisma();
    await new ThreadJobEffects(prisma).onInputAck(answerCommand(), 'ok', '');
    expect(fleetCommand.update).toHaveBeenCalledWith({ where: { id: 'cmd1' }, data: { payload: { requestId: 'q1' } } });
  });
});

/**
 * thread-agents-modes US-008 fix round 1 (F2): a decision shares the `THREAD_ANSWER` type with a text answer but not
 * its pending question. The two pending lists are written by independent ingest paths, so they can hold the same
 * request id; an accepted decision must not delete the unanswered question.
 */
describe('ThreadJobEffects.onInputAck for an approval decision (US-008 F2)', () => {
  const decisionCommand = (over: Partial<FleetCommandRecord> = {}): FleetCommandRecord =>
    answerCommand({ payload: { requestId: 'q1', decision: 'allow' }, ...over });

  it('F2: an ok ack for a decision keeps a pendingQuestion that shares its requestId', async () => {
    const { prisma, thread } = fakePrisma();

    await new ThreadJobEffects(prisma).onInputAck(decisionCommand(), 'ok', '');

    expect(thread.pendingQuestion).toMatchObject({ requestId: 'q1' });
  });

  it('F2: the decision ack still rewrites the command payload to the requestId', async () => {
    const { prisma, fleetCommand } = fakePrisma();

    await new ThreadJobEffects(prisma).onInputAck(decisionCommand(), 'ok', '');

    expect(fleetCommand.update).toHaveBeenCalledWith({ where: { id: 'cmd1' }, data: { payload: { requestId: 'q1' } } });
  });
});

/**
 * B3 (whole-branch review): the decision route answers 200 as soon as the command is queued, so only the runner's ack
 * says whether the session took the decision. The effects record that outcome on the pending request it decided, and
 * answer a thread live event so the open page refetches instead of displaying "queued" forever.
 */
const pendingApproval = { requestId: 'q1', tool: 'bash', summary: 'Run the migration', expiresAt: '2026-11-24T01:00:00.000Z' };

function decisionPrisma(opts: { pendingApprovals?: unknown } = {}) {
  const thread = { id: 'T', pendingApprovals: (opts.pendingApprovals ?? null) as unknown, pendingQuestion: null as unknown };
  const fleetJob = { findUnique: vi.fn(async () => ({ id: 'J', threadId: thread.id })) };
  const chatThread = {
    findUnique: vi.fn(async () => thread),
    update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => Object.assign(thread, data)),
  };
  const client = {
    fleetJob, chatThread,
    fleetCommand: { update: vi.fn(async () => ({})) },
    chatMessage: { updateMany: vi.fn(async () => ({ count: 0 })) },
  };
  return { prisma: { client } as never, thread, chatThread };
}

const decisionCommand = (payload: Record<string, unknown> = { requestId: 'q1', decision: 'allow' }): FleetCommandRecord =>
  answerCommand({ payload });

describe('ThreadJobEffects.onInputAck for a decision delivery (B3)', () => {
  it('B3: a rejected decision ack records the rejection on its pending request and returns a thread event', async () => {
    const { prisma, thread } = decisionPrisma({ pendingApprovals: [pendingApproval] });

    const event = await new ThreadJobEffects(prisma).onInputAck(decisionCommand(), 'rejected', 'expired');

    expect(thread.pendingApprovals).toEqual([
      { ...pendingApproval, delivery: { decision: 'allow', result: 'rejected', detail: 'expired', at: expect.any(String) } },
    ]);
    expect(event).toMatchObject({ type: 'thread', threadId: 'T' });
  });

  it('B3: an ok decision ack records the ok delivery too, so a reopened page shows it was delivered', async () => {
    const { prisma, thread } = decisionPrisma({ pendingApprovals: [pendingApproval] });

    const event = await new ThreadJobEffects(prisma).onInputAck(decisionCommand({ requestId: 'q1', decision: 'deny' }), 'ok', '');

    expect(thread.pendingApprovals).toEqual([
      { ...pendingApproval, delivery: { decision: 'deny', result: 'ok', detail: null, at: expect.any(String) } },
    ]);
    expect(event).toMatchObject({ type: 'thread', threadId: 'T' });
  });

  it('B3: a decision for a request the session already resolved writes nothing and returns no event', async () => {
    const { prisma, chatThread } = decisionPrisma({ pendingApprovals: [{ ...pendingApproval, requestId: 'other' }] });

    await expect(new ThreadJobEffects(prisma).onInputAck(decisionCommand(), 'rejected', 'expired')).resolves.toBeNull();
    expect(chatThread.update).not.toHaveBeenCalled();
  });

  it('B3: a thread with no pending list writes nothing and returns no event', async () => {
    const { prisma, chatThread } = decisionPrisma();

    await expect(new ThreadJobEffects(prisma).onInputAck(decisionCommand(), 'rejected', 'expired')).resolves.toBeNull();
    expect(chatThread.update).not.toHaveBeenCalled();
  });

  it('B3: bounds the stored detail to 200 characters', async () => {
    const { prisma, thread } = decisionPrisma({ pendingApprovals: [pendingApproval] });

    await new ThreadJobEffects(prisma).onInputAck(decisionCommand(), 'rejected', 'x'.repeat(300));

    expect((thread.pendingApprovals as Array<{ delivery: { detail: string } }>)[0]?.delivery.detail).toBe('x'.repeat(200));
  });

  it('B3 (control): a text answer ack records no delivery and returns no thread event', async () => {
    const { prisma, chatThread } = decisionPrisma({ pendingApprovals: [pendingApproval] });

    await expect(new ThreadJobEffects(prisma).onInputAck(answerCommand(), 'ok', '')).resolves.toBeNull();
    expect(chatThread.update).not.toHaveBeenCalled();
  });
});

const publishCommand = (over: Partial<FleetCommandRecord> = {}): FleetCommandRecord => ({
  id: 'cmdP', runnerId: 'R', jobId: 'JP', type: FleetCommandType.THREAD_PUBLISH, leaseEpoch: 1,
  payload: {}, createdAt: new Date(0), deliveredAt: null, ackedAt: null, ackResult: null,
  ...over,
});

/** A fake whose thread row takes `lastWrite` writes; the job row resolves to the command's thread. */
function publishPrisma() {
  const chatThread = { update: vi.fn(async () => ({})), updateMany: vi.fn(async () => ({ count: 1 })) };
  const client = { chatThread, fleetJob: { findUnique: vi.fn(async () => ({ id: 'JP', threadId: 'T' })) }, fleetCommand: { update: vi.fn(async () => ({})) }, chatMessage: {} };
  return { prisma: { client } as never, chatThread };
}

describe('ThreadJobEffects.onInputAck for THREAD_PUBLISH (US-004)', () => {
  it('AC-8: a rejected publish ack writes publish_failed with the ack detail to the thread lastWrite', async () => {
    const { prisma, chatThread } = publishPrisma();
    await new ThreadJobEffects(prisma).onInputAck(publishCommand(), 'rejected', 'turn_running');
    expect(chatThread.update).toHaveBeenCalledWith({
      where: { id: 'T' },
      data: { lastWrite: { kind: 'publish_failed', jobId: 'JP', at: expect.any(String), reason: 'turn_running' } },
    });
  });

  it('AC-8: the publish_failed lastWrite is stamped with the ack time', async () => {
    const { prisma, chatThread } = publishPrisma();
    const before = Date.now();
    await new ThreadJobEffects(prisma).onInputAck(publishCommand(), 'rejected', 'turn_running');
    const data = (chatThread.update.mock.calls[0] as unknown as [{ data: { lastWrite: { at: string } } }])[0].data;
    const at = Date.parse(data.lastWrite.at);
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(Date.now());
  });

  it('AC-8: a rejected publish ack with a detail longer than 64 characters keeps only 64', async () => {
    const { prisma, chatThread } = publishPrisma();
    await new ThreadJobEffects(prisma).onInputAck(publishCommand(), 'rejected', 'x'.repeat(100));
    const data = (chatThread.update.mock.calls[0] as unknown as [{ data: { lastWrite: { reason: string } } }])[0].data;
    expect(data.lastWrite.reason).toBe('x'.repeat(64));
  });

  it('AC-8: a rejected publish ack with the publishing detail leaves lastWrite alone (its own result line follows)', async () => {
    const { prisma, chatThread } = publishPrisma();
    await new ThreadJobEffects(prisma).onInputAck(publishCommand(), 'rejected', 'publishing');
    expect(chatThread.update).not.toHaveBeenCalled();
  });

  it('AC-9: an ok publish ack writes nothing (the published line follows on the stream)', async () => {
    const { prisma, chatThread } = publishPrisma();
    await new ThreadJobEffects(prisma).onInputAck(publishCommand(), 'ok', '');
    expect(chatThread.update).not.toHaveBeenCalled();
  });

  it('AC-9: an ok publish ack does not rewrite the command payload either', async () => {
    const { prisma } = publishPrisma();
    const fleetCommand = (prisma as unknown as { client: { fleetCommand: { update: ReturnType<typeof vi.fn> } } }).client.fleetCommand;
    await new ThreadJobEffects(prisma).onInputAck(publishCommand(), 'ok', '');
    expect(fleetCommand.update).not.toHaveBeenCalled();
  });
});

const endedJob = (over: Partial<FleetJobRecord> = {}): FleetJobRecord => ({
  id: 'J', command: 'THREAD', threadId: 'T', state: 'CRASHED', ...over,
} as FleetJobRecord);

function endedPrisma(opts: { open?: Array<{ id: string }>; session?: unknown } = {}) {
  const thread = { id: 'T', session: opts.session === undefined ? null : opts.session };
  const chatMessage = {
    findMany: vi.fn(async () => opts.open ?? []),
    updateMany: vi.fn(async () => ({ count: (opts.open ?? []).length })),
  };
  const chatThread = {
    findUnique: vi.fn(async () => thread),
    updateMany: vi.fn(async () => ({ count: 1 })),
    update: vi.fn(async () => thread),
  };
  const $queryRaw = vi.fn(async () => []);
  const client = { chatMessage, chatThread, fleetJob: {}, fleetCommand: {}, $queryRaw };
  return { prisma: { client } as never, chatMessage, chatThread, $queryRaw };
}

const liveSession = (over: Record<string, unknown> = {}) => ({
  jobId: 'J', state: 'live', resumed: true, contextReset: false, reason: null, at: '2026-10-13T07:00:00.000Z', ...over,
});

describe('ThreadJobEffects.onJobEnded (#264)', () => {
  it('moves the pending and streaming messages to errored with the job state as the reason', async () => {
    const { prisma, chatMessage } = endedPrisma({ open: [{ id: 'm1' }, { id: 'm2' }] });
    await new ThreadJobEffects(prisma).onJobEnded(endedJob());
    expect(chatMessage.updateMany).toHaveBeenCalledWith({
      where: { threadId: 'T', status: { in: ['pending', 'streaming'] } },
      data: { status: 'errored', errorReason: 'crashed' },
    });
  });

  it('returns a message event per moved message and a thread event, all for the job thread', async () => {
    const { prisma } = endedPrisma({ open: [{ id: 'm1' }, { id: 'm2' }] });
    const events = await new ThreadJobEffects(prisma).onJobEnded(endedJob());
    expect(events.map((e) => e.type)).toEqual(['message', 'message', 'thread']);
    expect(events[0]).toMatchObject({ type: 'message', messageId: 'm1', threadId: 'T' });
    expect(events[1]).toMatchObject({ type: 'message', messageId: 'm2', threadId: 'T' });
    expect(events[2]).toMatchObject({ type: 'thread', threadId: 'T' });
    for (const event of events) {
      expect(typeof event.id).toBe('string');
      expect(Number.isNaN(Date.parse(event.at))).toBe(false);
    }
  });

  it('still returns a thread event when no message was open', async () => {
    const { prisma } = endedPrisma({ open: [] });
    const events = await new ThreadJobEffects(prisma).onJobEnded(endedJob({ state: 'COMPLETED' }));
    expect(events.map((e) => e.type)).toEqual(['thread']);
  });

  it('publishes nothing and writes nothing for a non-THREAD job', async () => {
    const { prisma, chatMessage, chatThread } = endedPrisma({ open: [{ id: 'm1' }] });
    const events = await new ThreadJobEffects(prisma).onJobEnded(endedJob({ command: 'RUN' }));
    expect(events).toEqual([]);
    expect(chatMessage.updateMany).not.toHaveBeenCalled();
    expect(chatThread.update).not.toHaveBeenCalled();
  });

  it('closes a live session snapshot of this job as failed when the job crashed, keeping its resume flags', async () => {
    const { prisma, chatThread } = endedPrisma({ session: liveSession() });
    await new ThreadJobEffects(prisma).onJobEnded(endedJob({ state: 'CRASHED' }));
    expect(chatThread.update).toHaveBeenCalledWith({
      where: { id: 'T' },
      data: { session: expect.objectContaining({ jobId: 'J', state: 'failed', reason: 'crashed', resumed: true, contextReset: false }) },
    });
  });

  it('closes a live session snapshot of this job as closed when the job completed idle', async () => {
    const { prisma, chatThread } = endedPrisma({ session: liveSession() });
    await new ThreadJobEffects(prisma).onJobEnded(endedJob({ state: 'COMPLETED' }));
    expect(chatThread.update).toHaveBeenCalledWith({
      where: { id: 'T' },
      data: { session: expect.objectContaining({ jobId: 'J', state: 'closed', reason: 'completed' }) },
    });
  });

  it('closes the snapshot with the job stateReason and finishedAt when the transition set them', async () => {
    const { prisma, chatThread } = endedPrisma({ session: liveSession() });
    const finishedAt = new Date('2026-10-13T07:16:09.940Z');
    const events = await new ThreadJobEffects(prisma).onJobEnded(endedJob({ state: 'CRASHED', stateReason: 'runner silent', finishedAt }));
    expect(chatThread.update).toHaveBeenCalledWith({
      where: { id: 'T' },
      data: { session: expect.objectContaining({ state: 'failed', reason: 'runner silent', at: finishedAt.toISOString() }) },
    });
    expect(events.every((e) => e.at === finishedAt.toISOString())).toBe(true);
  });

  it('locks the thread row before it reads or writes the messages', async () => {
    const { prisma, chatMessage, $queryRaw } = endedPrisma({ open: [{ id: 'm1' }] });
    await new ThreadJobEffects(prisma).onJobEnded(endedJob());
    expect($queryRaw).toHaveBeenCalledTimes(1);
    expect($queryRaw.mock.invocationCallOrder[0]).toBeLessThan(chatMessage.findMany.mock.invocationCallOrder[0]);
  });

  it('leaves a snapshot the runner already closed untouched', async () => {
    const { prisma, chatThread } = endedPrisma({ session: liveSession({ state: 'closed', reason: 'idle' }) });
    await new ThreadJobEffects(prisma).onJobEnded(endedJob({ state: 'COMPLETED' }));
    expect(chatThread.update).not.toHaveBeenCalled();
  });

  it('leaves a live snapshot of a different job untouched', async () => {
    const { prisma, chatThread } = endedPrisma({ session: liveSession({ jobId: 'OTHER' }) });
    await new ThreadJobEffects(prisma).onJobEnded(endedJob({ state: 'CRASHED' }));
    expect(chatThread.update).not.toHaveBeenCalled();
  });

  it('writes nothing to the session when the thread has none', async () => {
    const { prisma, chatThread } = endedPrisma({ session: null });
    await new ThreadJobEffects(prisma).onJobEnded(endedJob());
    expect(chatThread.update).not.toHaveBeenCalled();
  });

  it('US-007 AC-10: clears the thread pendingApprovals as well as its pendingQuestion', async () => {
    const { prisma, chatThread } = endedPrisma({ open: [] });
    await new ThreadJobEffects(prisma).onJobEnded(endedJob({ state: 'CRASHED' }));
    expect(chatThread.updateMany).toHaveBeenCalledWith({
      where: { id: 'T' }, data: { pendingQuestion: Prisma.DbNull, pendingApprovals: Prisma.DbNull },
    });
  });
});
