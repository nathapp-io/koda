import { randomUUID } from 'node:crypto';
import { canRunDbTests } from '../helpers/test-environment';
import { resetDb } from '../helpers/reset-db';
import { applyMigration, scratchSchemaBefore } from '../helpers/migration-schema';
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
    const migration = '20261125090000_fleet_flows';
    const scratch = await scratchSchemaBefore(
      process.env.DATABASE_URL as string, `flow_schema_${randomUUID().replaceAll('-', '')}`, migration,
    );
    try {
      // Use the actual pre-migration schema; current Prisma reads would select columns
      // that did not exist yet. Keep all migration DDL away from the shared test schema.
      await scratch.db.$executeRaw`
        INSERT INTO "Project" ("id", "name", "slug", "key", "updatedAt")
        VALUES ('project', 'Project', 'project', 'PROJ', now())`;
      await scratch.db.$executeRaw`
        INSERT INTO "FleetRepo" ("id", "projectId", "provider", "owner", "name", "defaultBranch", "createdById")
        VALUES ('repo', 'project', 'github', 'acme', 'app', 'main', 'creator')`;
      const runner = await insertRunner(scratch.db);
      await scratch.db.$executeRaw`
        INSERT INTO "ChatThread" (
          "id", "projectId", "repoId", "runnerId", "title", "createdById", "backend", "skills",
          "publishedSha", "specPublished", "maxCostUsd"
        ) VALUES ('thread', 'project', 'repo', ${runner.id}, 'Published', 'creator', '{}', '[]',
                  'published-sha', true, 12.3456)`;

      await applyMigration(scratch.db, migration);
      const [migrated] = await scratch.db.$queryRaw<Array<{
        publishedSha: string; specPublished: boolean; runnerId: string; preApproval: unknown; maxCostUsd: string;
      }>>`SELECT "publishedSha", "specPublished", "runnerId", "preApproval", "maxCostUsd"::text AS "maxCostUsd"
          FROM "ChatThread" WHERE "id" = 'thread'`;
      expect(migrated).toMatchObject({
        publishedSha: 'published-sha', specPublished: true, runnerId: runner.id, preApproval: null,
      });
      expect(migrated.maxCostUsd).toBe('12.3456');
      const columns = await prisma.$queryRaw<Array<{ column_name: string }>>`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'FleetFlow' AND column_name = 'setSha'`;
      expect(columns).toEqual([{ column_name: 'setSha' }]);
    } finally {
      await scratch.drop();
    }
  }, 120_000);
});
