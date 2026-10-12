import { Prisma } from '../../generated/prisma/client';
import { FleetCommandType } from '../../common/enums';
import type { FleetCommandRecord } from '../jobs/domain/fleet-job.domain';
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
