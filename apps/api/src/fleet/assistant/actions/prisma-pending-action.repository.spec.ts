import { PrismaPendingActionRepository } from './prisma-pending-action.repository';

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
