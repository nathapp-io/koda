import { PrismaChatThreadRepository } from './prisma-chat-thread.repository';

/** A ChatMessage row as Prisma returns it, including the fold-internal round columns. */
const row = {
  id: 'm2', threadId: 'T', seq: 2, jobId: 'J', turnId: 't1', role: 'assistant', authorUserId: null,
  clientMessageId: null, content: 'Hello', toolSummary: null, status: 'streaming', errorReason: null,
  usage: null, costUsd: null, costSource: null, streamRound: 1, streamRoundStart: 0,
  createdAt: new Date('2026-10-14T00:00:00.000Z'),
};

describe('PrismaChatThreadRepository message mapping (US-003)', () => {
  function repoWith(findMany: (args: unknown) => Promise<unknown[]>): PrismaChatThreadRepository {
    const prisma = { client: { chatMessage: { findMany: vi.fn(findMany) } } } as never;
    return new PrismaChatThreadRepository(
      prisma, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never,
    );
  }

  it('US-003 AC13: messages() returns rows without threadId, streamRound or streamRoundStart', async () => {
    const repo = repoWith(async () => [row]);
    const [message] = await repo.messages('T', 0, 100);
    expect(message).toMatchObject({ id: 'm2', seq: 2, content: 'Hello', status: 'streaming', turnId: 't1' });
    expect(Object.hasOwn(message as object, 'threadId')).toBe(false);
    expect(Object.hasOwn(message as object, 'streamRound')).toBe(false);
    expect(Object.hasOwn(message as object, 'streamRoundStart')).toBe(false);
  });

  it('US-003 AC13: messages() keeps costUsd as a string and null when unpriced', async () => {
    const repo = repoWith(async () => [{ ...row, costUsd: { toString: () => '0.0123' } }, row]);
    const [priced, unpriced] = await repo.messages('T', 0, 100);
    expect(priced?.costUsd).toBe('0.0123');
    expect(unpriced?.costUsd).toBeNull();
  });

  it('US-003 AC13: messages() passes the after-seq filter and limit to the query', async () => {
    const findMany = vi.fn(async () => []);
    const prisma = { client: { chatMessage: { findMany } } } as never;
    const repo = new PrismaChatThreadRepository(prisma, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
    await repo.messages('T', 4, 25);
    expect(findMany).toHaveBeenCalledWith({ where: { threadId: 'T', seq: { gt: 4 } }, orderBy: { seq: 'asc' }, take: 25 });
  });
});
