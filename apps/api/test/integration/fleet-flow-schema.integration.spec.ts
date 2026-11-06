import { canRunDbTests } from '../helpers/test-environment';
import { resetDb } from '../helpers/reset-db';
import { createTestPrismaClient } from '../helpers/test-prisma';
import type { PrismaClient } from '../../src/generated/prisma/client';
import { seedFleetBase } from '../helpers/fleet-fixtures';

const describeDb = canRunDbTests() ? describe : describe.skip;

describeDb('FleetFlow schema defaults and constraints', () => {
  let prisma: PrismaClient;
  let projectId: string;
  let repoId: string;

  beforeAll(async () => {
    await resetDb();
    prisma = createTestPrismaClient();
    ({ projectId, repoId } = await seedFleetBase(prisma));
  }, 60_000);

  afterAll(async () => { await prisma?.$disconnect(); });

  it('AC-7: defaults flow state and spent amount', async () => {
    const flow = await prisma.fleetFlow.create({
      data: {
        projectId, repoId, entry: 'NAX', createdByType: 'USER', createdById: 'creator',
        branch: 'main', specSha: 'sha', reviewerRole: 'reviewer', supervisorRole: 'supervisor', costCapUsd: '4.25',
      },
    });
    expect(flow.state).toBe('PENDING');
    expect(flow.spentUsd.toString()).toBe('0');
  });

  it('AC-8: rejects duplicate feature within a flow with P2002', async () => {
    const flow = await prisma.fleetFlow.create({
      data: {
        projectId, repoId, entry: 'NAX', createdByType: 'USER', createdById: 'creator',
        branch: 'main', specSha: 'sha', reviewerRole: 'reviewer', supervisorRole: 'supervisor', costCapUsd: '4.25',
      },
    });
    const feature = { flowId: flow.id, position: 1, feature: 'alpha', specPath: '.nax/features/alpha/spec.md', dependsOn: [] };
    await prisma.fleetFlowFeature.create({ data: feature });
    await expect(prisma.fleetFlowFeature.create({ data: { ...feature, position: 2 } }))
      .rejects.toMatchObject({ code: 'P2002' });
  });

  it('AC-9: ChatThread preApproval defaults to null', async () => {
    const thread = await prisma.chatThread.create({
      data: {
        projectId, title: 'Thread', createdById: 'creator', backend: {}, skills: [],
      },
    });
    expect(thread.preApproval).toBeNull();
  });
});
