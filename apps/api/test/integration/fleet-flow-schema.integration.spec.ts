import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { canRunDbTests } from '../helpers/test-environment';
import { resetDb } from '../helpers/reset-db';
import { createTestPrismaClient } from '../helpers/test-prisma';
import type { PrismaClient } from '../../src/generated/prisma/client';
import { insertRunner, seedFleetBase } from '../helpers/fleet-fixtures';

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
        branch: 'main', specSha: 'sha', setSha: 'sha', reviewerRole: 'reviewer', supervisorRole: 'supervisor', costCapUsd: '4.25',
      },
    });
    expect(flow.state).toBe('PENDING');
    expect(flow.spentUsd.toString()).toBe('0');
  });

  it('AC-8: rejects duplicate feature within a flow with P2002', async () => {
    const flow = await prisma.fleetFlow.create({
      data: {
        projectId, repoId, entry: 'NAX', createdByType: 'USER', createdById: 'creator',
        branch: 'main', specSha: 'sha', setSha: 'sha', reviewerRole: 'reviewer', supervisorRole: 'supervisor', costCapUsd: '4.25',
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

  it('AC-10: migration preserves an existing published thread', async () => {
    const runner = await insertRunner(prisma);
    const original = await prisma.chatThread.create({
      data: {
        projectId, repoId, runnerId: runner.id, title: 'Published', createdById: 'creator',
        backend: {}, skills: [], publishedSha: 'published-sha', specPublished: true, maxCostUsd: '12.3456',
      },
    });

    // Recreate the pre-US-002 database shape around the published row, then apply the actual additive migration.
    await prisma.$executeRawUnsafe('DROP TABLE "FleetFlowFeature" CASCADE');
    await prisma.$executeRawUnsafe('DROP TABLE "FleetFlow" CASCADE');
    await prisma.$executeRawUnsafe('ALTER TABLE "ChatThread" DROP COLUMN "preApproval"');
    const migrationPath = resolve(__dirname, '../../../../apps/api/prisma/migrations/20261125090000_fleet_flows/migration.sql');
    const statements = readFileSync(migrationPath, 'utf8').split(';').map((statement) => statement.trim()).filter(Boolean);
    for (const statement of statements) await prisma.$executeRawUnsafe(statement);

    const migrated = await prisma.chatThread.findUniqueOrThrow({ where: { id: original.id } });
    expect(migrated).toMatchObject({
      publishedSha: 'published-sha', specPublished: true, runnerId: runner.id, preApproval: null,
    });
    expect(migrated.maxCostUsd.toString()).toBe('12.3456');
  });
});
