import { PrismaThreadIngestRepository } from './prisma-thread-ingest.repository';
import type { ThreadIngestBatch } from './thread-ingestor';

function makeRepository(options: { hasMessage: boolean }) {
  const message = { id: 'M', usage: null };
  const client = {
    $queryRaw: vi.fn(async () => []),
    fleetJob: { findUnique: vi.fn(async () => ({
      id: 'J', command: 'THREAD', threadId: 'T', leaseEpoch: 1, projectId: 'P', repoId: 'R', runnerId: 'runner',
    })) },
    chatMessage: {
      findFirst: vi.fn(async () => options.hasMessage ? message : null),
      findMany: vi.fn(async () => []),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => Object.assign(message, data)),
    },
    chatThread: {
      findUniqueOrThrow: vi.fn(async () => ({ backend: { kind: 'native', model: 'm1' }, feature: 'feature', tokens: null })),
      update: vi.fn(async () => ({})),
    },
    fleetCostEvent: { createMany: vi.fn(async () => ({ count: 1 })) },
    threadIngestCursor: { upsert: vi.fn(async () => ({})) },
  };
  const budgets = { signal: vi.fn() };
  const repository = new PrismaThreadIngestRepository(
    { client } as never,
    { run: (fn: () => Promise<unknown>) => fn() } as never,
    budgets as never,
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
