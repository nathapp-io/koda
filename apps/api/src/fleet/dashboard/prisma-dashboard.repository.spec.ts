import { PrismaService } from '@nathapp/nestjs-prisma';
import type { PrismaClient } from '../../generated/prisma/client';
import { PrismaDashboardRepository } from './prisma-dashboard.repository';

/**
 * Permissions P3 (US-011) — the dashboard's pending-approval summary reads the approval engine
 * (`FleetApprovalAsk`, whose request status is the ask's) instead of the legacy `FleetApproval` row.
 *
 * The DB-backed acceptance criterion (US-011 AC-8) is in
 * `test/integration/fleet/fleet-dashboard-repository.integration.spec.ts`. This spec pins the same read
 * without a database: the stub answers `fleetApprovalAsk.groupBy` and has no `fleetApproval` delegate at
 * all, so a read of the legacy row cannot pass.
 */

interface Group {
  jobId: string | null;
  _count: { _all: number };
  _min: { createdAt: Date | null };
}

const T0 = new Date('2026-10-04T10:00:00.000Z');
const minutesBefore = (minutes: number): Date => new Date(T0.getTime() - minutes * 60_000);

function repositoryFor(groups: Group[]) {
  const groupBy = vi.fn(async (_args: Record<string, unknown>) => groups);
  const client = { fleetApprovalAsk: { groupBy } };
  const prisma = { client } as unknown as PrismaService<PrismaClient>;
  return { repository: new PrismaDashboardRepository(prisma), groupBy };
}

describe('PrismaDashboardRepository.pendingSummaryByJob — engine reads (US-011)', () => {
  it('AC-8: summarises the pending engine asks of the asked jobs with the oldest link createdAt', async () => {
    const { repository, groupBy } = repositoryFor([
      { jobId: 'job-1', _count: { _all: 2 }, _min: { createdAt: minutesBefore(3) } },
    ]);

    const rows = await repository.pendingSummaryByJob(['job-1', 'job-2']);

    expect(rows).toEqual([{ jobId: 'job-1', count: 2, oldestRequestedAt: minutesBefore(3) }]);
    // The link's own createdAt is the summary's timestamp: it is written in the request's transaction,
    // and only a pending request counts.
    expect(groupBy).toHaveBeenCalledExactlyOnceWith({
      by: ['jobId'],
      where: { jobId: { in: ['job-1', 'job-2'] }, request: { status: 'pending' } },
      _count: { _all: true },
      _min: { createdAt: true },
    });
  });

  it('leaves out a group with no job and one whose links carry no createdAt', async () => {
    const { repository } = repositoryFor([
      { jobId: null, _count: { _all: 1 }, _min: { createdAt: minutesBefore(1) } },
      { jobId: 'job-2', _count: { _all: 1 }, _min: { createdAt: null } },
      { jobId: 'job-3', _count: { _all: 1 }, _min: { createdAt: minutesBefore(5) } },
    ]);

    await expect(repository.pendingSummaryByJob(['job-2', 'job-3'])).resolves.toEqual([
      { jobId: 'job-3', count: 1, oldestRequestedAt: minutesBefore(5) },
    ]);
  });

  it('answers [] for no job ids without reading the table', async () => {
    const { repository, groupBy } = repositoryFor([]);

    await expect(repository.pendingSummaryByJob([])).resolves.toEqual([]);
    expect(groupBy).not.toHaveBeenCalled();
  });
});
