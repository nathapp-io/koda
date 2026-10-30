import { PrismaService } from '@nathapp/nestjs-prisma';
import type { PrismaClient } from '../generated/prisma/client';
import { visibleRequestWhere } from '../approvals/approval-visibility';
import { PrismaHomeRepository } from './prisma-home.repository';

const visibility = { principal: { type: 'USER' as const, id: 'u1' }, scopes: { everywhere: true, global: 'all' as const, projects: [] } };
const scope = { visibility };
const expectedWhere = visibleRequestWhere(visibility, { status: 'pending' });
const T0 = new Date('2026-10-04T10:00:00.000Z');
interface RequestRow { id: string; permissionKey: string; projectId: string | null; createdAt: Date; expiresAt: Date | null; fleetAsk: { jobId: string | null } | null }
function repositoryFor(rows: RequestRow[]) {
  const findMany = vi.fn(async (_args: Record<string, unknown>) => rows);
  const count = vi.fn(async (_args: Record<string, unknown>) => rows.length);
  const prisma = { client: { approvalRequest: { findMany, count } } } as unknown as PrismaService<PrismaClient>;
  return { repository: new PrismaHomeRepository(prisma), findMany, count };
}
function firstArgs(mock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const call = mock.mock.calls[0] as [Record<string, unknown>] | undefined;
  if (!call) throw new Error('stub was not called');
  return call[0];
}
describe('PrismaHomeRepository pending approvals', () => {
  it('maps each key, nullable fleet type and job link while using engine visibility', async () => {
    const { repository, findMany } = repositoryFor([
      { id: 'bash', permissionKey: 'fleet.job.shell.escalate', projectId: 'p1', createdAt: T0, expiresAt: null, fleetAsk: { jobId: 'j1' } },
      { id: 'agent', permissionKey: 'agent.create', projectId: null, createdAt: T0, expiresAt: null, fleetAsk: null },
    ]);
    const rows = await repository.findPendingApprovals(scope, 8);
    expect(rows).toEqual([
      { id: 'bash', permissionKey: 'fleet.job.shell.escalate', type: 'nax_bash_escalate', projectId: 'p1', jobId: 'j1', requestedAt: T0, expiresAt: null },
      { id: 'agent', permissionKey: 'agent.create', type: null, projectId: null, jobId: null, requestedAt: T0, expiresAt: null },
    ]);
    expect(firstArgs(findMany).where).toEqual(expectedWhere);
    expect(firstArgs(findMany).orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
    expect(firstArgs(findMany).take).toBe(8);
  });
  it('counts the same visibility rows it lists', async () => {
    const { repository, count } = repositoryFor([]);
    await repository.countPendingApprovals(scope);
    expect(firstArgs(count).where).toEqual(expectedWhere);
  });
});
