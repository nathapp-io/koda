import { PrismaService } from '@nathapp/nestjs-prisma';
import { TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { PrismaMemoryItemRepository } from './prisma-memory-item.repository';

/** One stored row, as Prisma hands it to `toDomain`. */
const row = (over: Record<string, unknown> = {}) => ({
  id: 'mem-1',
  projectId: 'project-1',
  kind: 'NOTE',
  subject: 'replay-budget',
  predicate: 'project',
  object: 'Budget stays 2,048 MiB.',
  description: 'replay budget',
  activeKey: 'NOTE:replay-budget',
  ownerId: 'agent-a',
  ownerType: 'AGENT',
  scope: 'project',
  ownerKey: null,
  sourceType: null,
  sourceId: null,
  status: 'active',
  confidence: 0.8,
  ttlAt: null,
  supersededBy: null,
  deletedAt: null,
  createdAt: new Date('2026-11-21T09:00:00.000Z'),
  updatedAt: new Date('2026-11-21T09:01:00.000Z'),
  ...over,
});

describe('PrismaMemoryItemRepository.findChangedAfter (memory-notes US-006)', () => {
  let repository: PrismaMemoryItemRepository;
  const findMany = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    findMany.mockResolvedValue([]);
    const prisma = { client: { memoryItem: { findMany } }, withTransaction: vi.fn() };
    repository = new PrismaMemoryItemRepository(
      { run: vi.fn((fn: () => Promise<unknown>) => fn()), getClient: vi.fn(), isInTransaction: vi.fn(() => false) } as never,
      prisma as unknown as PrismaService<never>,
    );
  });

  it('AC-4/AC-5: reads the project rows plus the caller\'s user rows, every status and soft-deleted row included', async () => {
    const until = new Date('2026-11-21T09:03:00.000Z');

    await repository.findChangedAfter({ projectId: 'project-1', ownerKey: 'AGENT:agent-a' }, null, until, 25);

    const query = findMany.mock.calls[0][0] as Record<string, unknown>;
    expect(query.where).toEqual({
      OR: [{ projectId: 'project-1' }, { ownerKey: 'AGENT:agent-a' }],
      // Settle window: the read never passes a timestamp a late commit may still be writing at.
      updatedAt: { lt: until },
    });
    // No eligibility filter: no deletedAt, status, kind or TTL term narrows the feed.
    expect(query.where).not.toHaveProperty('deletedAt');
    expect(query.where).not.toHaveProperty('status');
    expect(query.where).not.toHaveProperty('kind');
    expect(query.orderBy).toEqual([{ updatedAt: 'asc' }, { id: 'asc' }]);
    expect(query.take).toBe(25);
  });

  it('AC-8: a cursor is the (updatedAt, id) pair — strictly after it, id breaking a shared timestamp', async () => {
    const after = { updatedAt: new Date('2026-11-21T08:00:00.000Z'), id: 'mem-5' };

    await repository.findChangedAfter(
      { projectId: 'project-1', ownerKey: 'AGENT:agent-a' },
      after,
      new Date('2026-11-21T09:03:00.000Z'),
      100,
    );

    const query = findMany.mock.calls[0][0] as Record<string, unknown>;
    expect(query.where).toMatchObject({
      AND: [
        {
          OR: [
            { updatedAt: { gt: after.updatedAt } },
            { updatedAt: after.updatedAt, id: { gt: after.id } },
          ],
        },
      ],
    });
  });

  it('AC-5: a superseded, a rejected and a soft-deleted row are mapped as stored', async () => {
    const deletedAt = new Date('2026-11-21T09:02:00.000Z');
    findMany.mockResolvedValue([
      row({ id: 'mem-1', status: 'superseded', activeKey: null }),
      row({ id: 'mem-2', status: 'rejected', activeKey: null }),
      row({ id: 'mem-3', deletedAt }),
    ]);

    const items = await repository.findChangedAfter(
      { projectId: 'project-1', ownerKey: 'AGENT:agent-a' },
      null,
      new Date('2026-11-21T09:03:00.000Z'),
      10,
    );

    expect(items.map((item) => [item.id, item.status, item.deletedAt])).toEqual([
      ['mem-1', 'superseded', undefined],
      ['mem-2', 'rejected', undefined],
      ['mem-3', 'active', deletedAt],
    ]);
  });
});
