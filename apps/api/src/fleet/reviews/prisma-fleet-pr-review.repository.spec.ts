import { createMockPrismaService, type PrismaService } from '@nathapp/nestjs-prisma';
import type { PrismaClient } from '../../generated/prisma/client';
import type { FleetPrReviewRecord } from './domain/fleet-pr-review.domain';
import { PrismaFleetPrReviewRepository } from './prisma-fleet-pr-review.repository';

describe('PrismaFleetPrReviewRepository claim cleanup', () => {
  it.each(['markFailed', 'remove'] as const)('does not let %s change a dispatched claim', async (operation) => {
    const dispatched: FleetPrReviewRecord = {
      id: 'claim-1', repoId: 'repo-1', prNumber: 7, headSha: 'aaa',
      outcome: 'dispatched', jobId: 'review-1', followUpEventId: null,
      createdAt: new Date(0), updatedAt: new Date(0),
    };
    let row: FleetPrReviewRecord | null = { ...dispatched };
    type Filter = Partial<Pick<FleetPrReviewRecord, 'id' | 'outcome' | 'jobId'>>;
    const matches = (where: Filter) => row !== null && Object.entries(where).every(([key, value]) =>
      row?.[key as keyof Filter] === value);
    const updateMany = vi.fn(async ({ where, data }: { where: Filter; data: Pick<FleetPrReviewRecord, 'outcome'> }) => {
      if (!matches(where) || row === null) return { count: 0 };
      row = { ...row, ...data };
      return { count: 1 };
    });
    const deleteMany = vi.fn(async ({ where }: { where: Filter }) => {
      if (!matches(where)) return { count: 0 };
      row = null;
      return { count: 1 };
    });
    const prisma = createMockPrismaService({ fn: vi.fn });
    prisma.client.fleetPrReview = { updateMany, deleteMany, findUnique: vi.fn(async () => row) } as never;
    const repo = new PrismaFleetPrReviewRepository({
      run: (fn) => fn(), getClient: vi.fn(), isInTransaction: () => false,
    }, prisma as unknown as PrismaService<PrismaClient>);

    if (operation === 'markFailed') await repo.markFailed(dispatched.id, 'failed:profiles');
    else await repo.remove(dispatched.id);

    expect(await repo.findHead(dispatched.repoId, dispatched.prNumber, dispatched.headSha)).toEqual(dispatched);
    const cleanup = operation === 'markFailed' ? updateMany : deleteMany;
    expect(cleanup).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      where: { id: dispatched.id, outcome: 'pending', jobId: null },
    }));
  });
});
