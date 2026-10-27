import { PrismaService } from '@nathapp/nestjs-prisma';
import type { PrismaClient } from '../generated/prisma/client';
import { FLEET_ASK_KEY, FLEET_ASK_KEYS } from '../fleet/approvals/domain/approval.domain';
import { PrismaHomeRepository } from './prisma-home.repository';

/**
 * Permissions P3 (US-011) — `/home`'s "needs you" approvals read the approval engine
 * (`ApprovalRequest` + its `FleetApprovalAsk` link) instead of the legacy `FleetApproval` row.
 *
 * The DB-backed acceptance criteria (US-011 AC-9 and AC-10) are in
 * `test/integration/home/home-api.integration.spec.ts`. This spec pins the repository read without a
 * database: the stub answers `approvalRequest` and has no `fleetApproval` delegate at all, so a read of
 * the legacy row cannot pass.
 */

interface RequestRow {
  id: string;
  permissionKey: string;
  projectId: string | null;
  createdAt: Date;
  expiresAt: Date | null;
  fleetAsk: { jobId: string | null } | null;
}

const T0 = new Date('2026-10-04T10:00:00.000Z');
const minutesBefore = (minutes: number): Date => new Date(T0.getTime() - minutes * 60_000);

function repositoryFor(rows: RequestRow[]) {
  const findMany = vi.fn(async (_args: Record<string, unknown>) => rows);
  const count = vi.fn(async (_args: Record<string, unknown>) => rows.length);
  const client = { approvalRequest: { findMany, count } };
  const prisma = { client } as unknown as PrismaService<PrismaClient>;
  return { repository: new PrismaHomeRepository(prisma), findMany, count };
}

/** The single call's argument object the stub recorded, read without a non-null assertion. */
function firstArgs(mock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const call = mock.mock.calls[0] as [Record<string, unknown>] | undefined;
  if (call === undefined) throw new Error('the stub was not called');
  return call[0];
}

describe('PrismaHomeRepository pending approvals — engine reads (US-011)', () => {
  it('AC-9: labels each pending request by its fleet key and takes the job from the link', async () => {
    const { repository, findMany } = repositoryFor([
      {
        id: 'req-bash', permissionKey: FLEET_ASK_KEY.nax_bash_escalate, projectId: 'p1',
        createdAt: minutesBefore(3), expiresAt: minutesBefore(-7), fleetAsk: { jobId: 'job-1' },
      },
    ]);

    const rows = await repository.findPendingApprovals({ projectIds: ['p1'], includeUnscoped: false }, 8);

    expect(rows).toEqual([{
      id: 'req-bash', type: 'nax_bash_escalate', projectId: 'p1', jobId: 'job-1',
      requestedAt: minutesBefore(3), expiresAt: minutesBefore(-7),
    }]);
    const where = firstArgs(findMany)['where'] as Record<string, unknown>;
    expect(where['status']).toBe('pending');
    expect(where['permissionKey']).toEqual({ in: [...FLEET_ASK_KEYS] });
    // A fleet-key request without a link is not a fleet row.
    expect(where['fleetAsk']).toEqual({ isNot: null });
    expect(where['OR']).toEqual([{ projectId: { in: ['p1'] } }]);
  });

  it('AC-10: a global admin scope also reads the asks no project owns', async () => {
    const { repository, findMany } = repositoryFor([
      {
        id: 'req-budget', permissionKey: FLEET_ASK_KEY.budget_override_required, projectId: null,
        createdAt: minutesBefore(5), expiresAt: null, fleetAsk: { jobId: null },
      },
    ]);

    const rows = await repository.findPendingApprovals({ projectIds: ['p1'], includeUnscoped: true }, 8);

    expect(rows).toEqual([{
      id: 'req-budget', type: 'budget_override_required', projectId: null, jobId: null,
      requestedAt: minutesBefore(5), expiresAt: null,
    }]);
    const where = firstArgs(findMany)['where'] as Record<string, unknown>;
    expect(where['OR']).toEqual([{ projectId: { in: ['p1'] } }, { projectId: null }]);
  });

  it('counts the same rows it would list, and never matches anything on an empty scope', async () => {
    const { repository, count } = repositoryFor([]);

    await expect(repository.countPendingApprovals({ projectIds: [], includeUnscoped: false })).resolves.toBe(0);

    const where = firstArgs(count)['where'] as Record<string, unknown>;
    expect(where).toMatchObject({ status: 'pending', permissionKey: { in: [...FLEET_ASK_KEYS] }, fleetAsk: { isNot: null }, id: { in: [] } });
    // Prisma ignores an empty `OR`, so the empty scope is a never-match instead.
    expect(where['OR']).toBeUndefined();
  });

  it('leaves out a row whose key is not a fleet key, and reads the page newest first with its bound', async () => {
    const { repository, findMany } = repositoryFor([
      {
        id: 'req-delete', permissionKey: 'ticket.delete', projectId: 'p1',
        createdAt: minutesBefore(1), expiresAt: null, fleetAsk: null,
      },
      {
        id: 'req-bash', permissionKey: FLEET_ASK_KEY.nax_bash_escalate, projectId: 'p1',
        createdAt: minutesBefore(2), expiresAt: null, fleetAsk: { jobId: 'job-1' },
      },
    ]);

    const rows = await repository.findPendingApprovals({ projectIds: ['p1'], includeUnscoped: false }, 3);

    expect(rows.map((row) => row.id)).toEqual(['req-bash']);
    const args = firstArgs(findMany) as { orderBy: unknown; take: number };
    expect(args.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
    expect(args.take).toBe(3);
  });
});
