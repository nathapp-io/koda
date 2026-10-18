import { PrismaPendingActionRepository } from './prisma-pending-action.repository';
import type { DirectActionInput } from './pending-action.domain';

/**
 * Fleet S5b 2aw US-001 (2aw-D1): `deliveredMessageId` is part of the record the repository stores and reads, so the
 * message a note was handed to survives a round trip. The PG side of the same column is covered by
 * test/integration/fleet/assistant-action-delivery.integration.spec.ts; this spec pins the mapping itself, which runs
 * without a database.
 */
describe('PrismaPendingActionRepository deliveredMessageId mapping (2aw US-001 AC-11)', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: 'a1', projectId: 'p1', threadId: 't1', jobId: 'j1', toolCallId: 'tc1', tool: 'koda_add_comment',
    input: { ref: 'KODA-1' }, preview: 'Add a comment', status: 'REJECTED', requestedById: 'u1', approvalId: 'ap1',
    decidedById: 'u1', decidedAt: new Date('2026-01-02T00:00:00.000Z'), result: null,
    deliveredAt: new Date('2026-01-03T00:00:00.000Z'), deliveredMessageId: 'm1',
    expiresAt: new Date('2026-01-04T00:00:00.000Z'), createdAt: new Date('2026-01-01T00:00:00.000Z'), ...over,
  });

  const stub = (over: Record<string, unknown> = {}) => {
    const client = {
      pendingAction: {
        findUnique: vi.fn(async () => row(over)),
        update: vi.fn(async (args: { data: Record<string, unknown> }) => row(args.data)),
      },
      project: { findMany: vi.fn(async () => [{ id: 'p1', slug: 'web' }]) },
    };
    const tx = { getClient: () => client, run: (fn: () => Promise<unknown>) => fn(), isInTransaction: () => false };
    return { repo: new PrismaPendingActionRepository(tx as never, { client } as never), client };
  };

  it('findById answers the deliveredMessageId stored on the row', async () => {
    const { repo } = stub();

    const record = await repo.findById('a1');

    expect(record?.deliveredMessageId).toBe('m1');
    expect(record?.deliveredAt).toEqual(new Date('2026-01-03T00:00:00.000Z'));
    expect(record?.projectSlug).toBe('web');
  });

  it('answers deliveredMessageId null for a row that has not been delivered', async () => {
    const { repo } = stub({ deliveredMessageId: null, deliveredAt: null });

    expect((await repo.findById('a1'))?.deliveredMessageId).toBeNull();
  });

  it('writes deliveredMessageId through the update mapping, and leaves it untouched when the patch omits it', async () => {
    const { repo, client } = stub();

    await repo.update('a1', { deliveredMessageId: 'm2' });
    await repo.update('a1', { status: 'EXECUTED' });

    expect(client.pendingAction.update).toHaveBeenNthCalledWith(1, { where: { id: 'a1' }, data: { deliveredMessageId: 'm2' } });
    expect(client.pendingAction.update).toHaveBeenNthCalledWith(2, { where: { id: 'a1' }, data: { status: 'EXECUTED' } });
  });
});

/**
 * Fleet S5b 3 US-004 (3-D14): `insertDirect` is the only writer of a direct action, and it writes the whole terminal
 * row in one insert. The PG side of the same path is covered by
 * test/integration/fleet/assistant-direct-action-record.integration.spec.ts; this spec pins the row and the query it
 * sends, which runs without a database.
 */
describe('PrismaPendingActionRepository.insertDirect (US-004)', () => {
  const NOW = new Date('2026-10-23T09:00:00.000Z');

  const input = (over: Partial<DirectActionInput> = {}): DirectActionInput => ({
    projectId: 'p1', tool: 'koda_add_comment', input: { ref: 'KODA-1', body: 'hello' },
    preview: 'Add a comment to KODA-1 "Fix login":\n\nhello', actorType: 'agent', actorId: 'ag1', origin: 'mcp',
    status: 'EXECUTED', result: 'done', now: NOW, ...over,
  });

  const stub = () => {
    const client = {
      pendingAction: {
        create: vi.fn(async (_args: { data: Record<string, unknown>; select?: Record<string, unknown> }) => ({ id: 'ad1' })),
        findMany: vi.fn(async (_args: unknown) => []),
      },
      project: { findMany: vi.fn(async () => []) },
    };
    const tx = { getClient: () => client, run: (fn: () => Promise<unknown>) => fn(), isInTransaction: () => false };
    return { repo: new PrismaPendingActionRepository(tx as never, { client } as never), client };
  };

  it('AC-4: answers the id of the single row it inserted', async () => {
    const { repo, client } = stub();

    await expect(repo.insertDirect(input())).resolves.toEqual({ id: 'ad1' });

    expect(client.pendingAction.create).toHaveBeenCalledTimes(1);
  });

  it('AC-5/AC-6/AC-7: the row is direct, terminal, approver-less and already decided', async () => {
    const { repo, client } = stub();

    await repo.insertDirect(input());

    expect(client.pendingAction.create).toHaveBeenCalledWith({
      data: {
        projectId: 'p1', tool: 'koda_add_comment', input: { ref: 'KODA-1', body: 'hello' },
        preview: 'Add a comment to KODA-1 "Fix login":\n\nhello', status: 'EXECUTED', result: 'done',
        actorType: 'agent', actorId: 'ag1', origin: 'mcp', approvalMode: 'none',
        approverType: null, approverId: null, approvalId: null,
        threadId: null, jobId: null, toolCallId: null, requestedById: null, decidedById: null,
        decidedAt: NOW, expiresAt: NOW,
      },
      select: { id: true },
    });
  });

  it('AC-9: a failed call stores its status and its failure text on the same row', async () => {
    const { repo, client } = stub();

    await repo.insertDirect(input({ status: 'FAILED', result: 'not_found' }));

    expect(client.pendingAction.create.mock.calls[0][0].data).toMatchObject({ status: 'FAILED', result: 'not_found' });
  });

  it('AC-10 premise: the row is never PENDING, so the sweeper\'s due scan cannot select it', async () => {
    const { repo, client } = stub();

    await repo.insertDirect(input({ status: 'FAILED', result: 'not_found' }));
    await repo.findDue(NOW, 100);

    expect(client.pendingAction.create.mock.calls[0][0].data['status']).not.toBe('PENDING');
    expect(client.pendingAction.findMany).toHaveBeenCalledWith({
      where: { origin: 'thread', status: 'PENDING', expiresAt: { lte: NOW } },
      orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }], take: 100,
    });
  });
});
