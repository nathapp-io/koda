import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaThreadIngestRepository } from './prisma-thread-ingest.repository';
import type { ThreadIngestBatch } from './domain/thread-ingest.domain';

function makeRepository(options: { hasMessage: boolean }) {
  const message = { id: 'M', usage: null };
  let committed = false;
  const client = {
    $queryRaw: vi.fn(async () => []),
    fleetJob: { findUnique: vi.fn(async () => ({
      id: 'J', command: 'THREAD', threadId: 'T', leaseEpoch: 1, projectId: 'P', repoId: 'R', runnerId: 'runner',
    })), update: vi.fn(async () => ({})) },
    chatMessage: {
      findFirst: vi.fn(async () => options.hasMessage ? message : null),
      findMany: vi.fn(async () => []),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => Object.assign(message, data)),
    },
    chatThread: {
      findUniqueOrThrow: vi.fn(async () => ({ backend: { kind: 'native', model: 'm1' }, feature: 'feature', tokens: null })),
      update: vi.fn(async () => ({})),
    },
    fleetCostEvent: { createMany: vi.fn(async () => ({ count: 1 })), aggregate: vi.fn(async () => ({ _sum: { costUsd: 0.25 } })) },
    threadIngestCursor: { upsert: vi.fn(async () => ({})) },
    $executeRaw: vi.fn(async () => 0),
  };
  const budgets = { signal: vi.fn(() => { expect(committed).toBe(true); }) };
  const repository = new PrismaThreadIngestRepository(
    { client } as never,
    { run: async (fn: () => Promise<unknown>) => { const result = await fn(); committed = true; return result; } } as never,
    budgets as never,
    { record: vi.fn().mockResolvedValue(undefined) } as never,
    new EventEmitter2(),
  );
  return { repository, client, budgets };
}

const costBatch = (turnId: string): ThreadIngestBatch => ({
  jobId: 'J', leaseEpoch: 1, badLines: 0, endOffset: 12,
  lines: [
    { line: { type: 'usage', turnId, round: 1, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 }, endOffset: 12 },
  ],
});

describe('thread cost fold review cases (US-005)', () => {
  it('US-012 AC-15: priced usage still advances cursor, derives cost and signals spend scopes after commit', async () => {
    const { repository, client, budgets } = makeRepository({ hasMessage: true });
    const batch = costBatch('t1');
    batch.lines[0].line = { type: 'usage', turnId: 't1', round: 1, inputTokens: 1, outputTokens: 1, cacheRead: 0, cacheWrite: 0, costUsd: 0.25 };
    const result = await repository.fold(batch);
    expect(result.costChanged).toBe(true);
    expect(client.threadIngestCursor.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: expect.objectContaining({ offset: 12n }) }));
    expect(client.fleetCostEvent.aggregate).toHaveBeenCalledTimes(2);
    expect(budgets.signal).toHaveBeenCalledWith(['global', 'project:P', 'repo:R', 'runner:runner']);
  });
  it('records priced zero-cost usage without rederiving spend or signaling budgets', async () => {
    const { repository, client, budgets } = makeRepository({ hasMessage: true });
    await repository.fold(costBatch('t1'));
    expect(client.fleetCostEvent.createMany).toHaveBeenCalledOnce();
    expect(client.fleetJob.findUnique).toHaveBeenCalledOnce();
    expect(budgets.signal).not.toHaveBeenCalled();
  });

  it('counts usage for an unknown turn as skipped and does not reread the job after commit', async () => {
    const { repository, client, budgets } = makeRepository({ hasMessage: false });
    await repository.fold(costBatch('missing'));
    expect(client.threadIngestCursor.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ skippedLines: 1 }),
    }));
    expect(client.fleetJob.findUnique).toHaveBeenCalledOnce();
    expect(budgets.signal).not.toHaveBeenCalled();
  });
});
