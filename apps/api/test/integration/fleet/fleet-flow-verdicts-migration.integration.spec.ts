import { randomUUID } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import { PrismaModule, PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { createPgAdapter } from '../../../src/prisma/pg-adapter';
import { PrismaFleetFlowRepository } from '../../../src/fleet/flows/prisma-fleet-flow.repository';
import { PrismaFleetFlowStepRepository } from '../../../src/fleet/flows/prisma-fleet-flow-step.repository';
import { canRunDbTests } from '../../helpers/test-environment';
import { resetDb } from '../../helpers/reset-db';
import { seedFleetBase } from '../../helpers/fleet-fixtures';
import { applyMigration, scratchSchemaBefore, type ScratchSchema } from '../../helpers/migration-schema';

const MIGRATION = '20261129090000_fleet_flow_verdicts';
const describeDb = canRunDbTests() ? describe : describe.skip;

describeDb('fleet flow verdicts migration and repositories (PG)', () => {
  let module: TestingModule;
  let prisma: PrismaClient;
  let stepRepository: PrismaFleetFlowStepRepository;
  let flowRepository: PrismaFleetFlowRepository;
  let projectId: string;
  let repoId: string;
  let creatorId: string;
  let scratch: ScratchSchema;

  beforeAll(async () => {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('Test database URL missing');
    scratch = await scratchSchemaBefore(url, `flow_verdicts_${randomUUID().replaceAll('-', '')}`, MIGRATION);
    await applyMigration(scratch.db, MIGRATION);
    await resetDb();
    module = await Test.createTestingModule({
      imports: [PrismaModule.forRoot({ client: PrismaClient, transaction: true, clientOptions: { adapter: createPgAdapter(process.env.DATABASE_URL) } })],
      providers: [PrismaFleetFlowStepRepository, PrismaFleetFlowRepository],
    }).compile();
    await module.init();
    prisma = module.get<PrismaService<PrismaClient>>(PrismaService).client;
    stepRepository = module.get(PrismaFleetFlowStepRepository);
    flowRepository = module.get(PrismaFleetFlowRepository);
    const base = await seedFleetBase(prisma);
    ({ projectId, repoId } = base);
    creatorId = base.adminId;
  }, 60_000);

  afterEach(async () => {
    const flows = await prisma.fleetFlow.findMany({ where: { projectId }, select: { id: true } });
    const flowIds = flows.map(({ id }) => id);
    await prisma.fleetJob.deleteMany({ where: { flowId: { in: flowIds } } });
    await prisma.fleetFlow.deleteMany({ where: { id: { in: flowIds } } });
    await prisma.ticket.deleteMany({ where: { projectId } });
    await prisma.project.update({ where: { id: projectId }, data: { deletedAt: null } });
  });

  afterAll(async () => {
    await module?.close();
    await scratch?.drop();
  });

  it('applies nullable columns and a SET NULL ticket foreign key in the migration', async () => {
    const columns = await scratch.db.$queryRaw<Array<{ table_name: string; column_name: string; is_nullable: string }>>`
      SELECT table_name, column_name, is_nullable FROM information_schema.columns
      WHERE table_schema = current_schema() AND
        ((table_name = 'FleetFlowFeature' AND column_name = 'callsJobId') OR
         (table_name = 'FleetFlow' AND column_name = 'ticketId'))`;
    expect(columns).toEqual(expect.arrayContaining([
      { table_name: 'FleetFlowFeature', column_name: 'callsJobId', is_nullable: 'YES' },
      { table_name: 'FleetFlow', column_name: 'ticketId', is_nullable: 'YES' },
    ]));
    const foreignKey = await scratch.db.$queryRaw<Array<{ delete_action: string }>>`
      SELECT c.confdeltype::text AS delete_action FROM pg_constraint c
      JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE c.conname = 'FleetFlow_ticketId_fkey' AND n.nspname = current_schema()`;
    expect(foreignKey).toEqual([{ delete_action: 'n' }]);

    const id = randomUUID();
    const projectId = `project-${id}`;
    const repoId = `repo-${id}`;
    const flowId = `flow-${id}`;
    const featureId = `feature-${id}`;
    await scratch.db.$executeRaw`INSERT INTO "Project" ("id", "name", "slug", "key", "updatedAt") VALUES (${projectId}, ${projectId}, ${`slug-${id}`}, ${`key-${id}`}, now())`;
    await scratch.db.$executeRaw`INSERT INTO "FleetRepo" ("id", "projectId", "provider", "owner", "name", "defaultBranch", "createdById") VALUES (${repoId}, ${projectId}, 'github', 'owner', ${`repo-${id}`}, 'main', 'creator')`;
    await scratch.db.$executeRaw`INSERT INTO "FleetFlow" ("id", "projectId", "repoId", "entry", "createdByType", "createdById", "branch", "specSha", "reviewerRole", "supervisorRole", "costCapUsd", "updatedAt") VALUES (${flowId}, ${projectId}, ${repoId}, 'NAX', 'USER', 'creator', 'main', 'sha', 'reviewer', 'supervisor', 10, now())`;
    await scratch.db.$executeRaw`INSERT INTO "FleetFlowFeature" ("id", "flowId", "position", "feature", "specPath", "dependsOn") VALUES (${featureId}, ${flowId}, 0, 'feature', 'spec.md', ARRAY[]::text[])`;
    const featureRows = await scratch.db.$queryRaw<Array<{ callsJobId: string | null }>>`SELECT "callsJobId" FROM "FleetFlowFeature" WHERE "id" = ${featureId}`;
    const flowRows = await scratch.db.$queryRaw<Array<{ ticketId: string | null }>>`SELECT "ticketId" FROM "FleetFlow" WHERE "id" = ${flowId}`;
    expect(featureRows).toEqual([{ callsJobId: null }]);
    expect(flowRows).toEqual([{ ticketId: null }]);
  });

  async function createFlow() {
    return prisma.fleetFlow.create({ data: {
      projectId, repoId, entry: 'NAX', createdByType: 'USER', createdById: creatorId,
      branch: `branch-${randomUUID()}`, specSha: 'sha', setSha: 'sha', reviewerRole: 'reviewer', supervisorRole: 'supervisor',
      costCapUsd: 10,
      features: { create: [{ position: 0, feature: `feature-${randomUUID()}`, specPath: 'spec.md', dependsOn: [] }] },
    }, include: { features: true } });
  }

  async function createJob(flowId: string, flowFeatureId: string, flowStep: string, queuedAt: Date) {
    return prisma.fleetJob.create({ data: {
      projectId, repoId, ref: 'main', command: 'PLAN', feature: `job-${randomUUID()}`, profiles: [], maxCostUsd: 5,
      selectorLabels: [], requestedById: creatorId, flowId, flowFeatureId, flowStep, queuedAt,
    } });
  }

  it('AC-1: new flow feature columns default to null', async () => {
    const flow = await createFlow();
    const feature = await prisma.fleetFlowFeature.findFirstOrThrow({ where: { flowId: flow.id } });
    expect(feature.callsJobId).toBeNull();
  });

  it('AC-2: new flow ticket column defaults to null', async () => {
    const flow = await createFlow();
    expect(flow.ticketId).toBeNull();
  });

  it('AC-3: deleting a linked ticket leaves the flow with a null ticketId', async () => {
    const ticket = await prisma.ticket.create({ data: { projectId, number: 1, type: 'TASK', title: 'Flow ticket' } });
    const flow = await prisma.fleetFlow.create({ data: {
      projectId, repoId, ticketId: ticket.id, entry: 'NAX', createdByType: 'USER', createdById: creatorId,
      branch: `branch-${randomUUID()}`, specSha: 'sha', setSha: 'sha', reviewerRole: 'reviewer', supervisorRole: 'supervisor', costCapUsd: 10,
    } });
    await prisma.ticket.delete({ where: { id: ticket.id } });
    expect(await prisma.fleetFlow.findUniqueOrThrow({ where: { id: flow.id } })).toMatchObject({ ticketId: null });
  });

  it('AC-4/5: count matching jobs queued at or after the timestamp', async () => {
    const flow = await createFlow();
    const featureId = flow.features[0].id;
    const since = new Date('2026-11-01T00:00:00Z');
    await createJob(flow.id, featureId, 'PLAN', new Date('2026-11-02T00:00:00Z'));
    await createJob(flow.id, featureId, 'PLAN', new Date('2026-11-03T00:00:00Z'));
    await createJob(flow.id, featureId, 'SPEC_REVIEW', new Date('2026-11-04T00:00:00Z'));
    await createJob(flow.id, featureId, 'PLAN', new Date('2026-10-31T00:00:00Z'));
    expect(await stepRepository.countJobsForStepSince(flow.id, featureId, 'PLAN', since)).toBe(2);
  });

  it('AC-6: count is zero when a flow has no jobs', async () => {
    const flow = await createFlow();
    expect(await stepRepository.countJobsForStepSince(flow.id, flow.features[0].id, 'PLAN', new Date())).toBe(0);
  });

  it('AC-7: projectSlug resolves a live project slug', async () => {
    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    expect(await stepRepository.projectSlug(projectId)).toBe(project.slug);
  });

  it('AC-8: projectSlug hides a soft-deleted project', async () => {
    await prisma.project.update({ where: { id: projectId }, data: { deletedAt: new Date() } });
    expect(await stepRepository.projectSlug(projectId)).toBeNull();
  });

  it('AC-9/10: recordCalls updates the feature and flow together', async () => {
    const flow = await createFlow();
    const feature = await prisma.fleetFlowFeature.findFirstOrThrow({ where: { flowId: flow.id } });
    await stepRepository.recordCalls(flow.id, feature.id, 'j1', 'abc123');
    expect((await prisma.fleetFlowFeature.findUniqueOrThrow({ where: { id: feature.id } })).callsJobId).toBe('j1');
    expect((await prisma.fleetFlow.findUniqueOrThrow({ where: { id: flow.id } })).specSha).toBe('abc123');
  });

  it('AC-11/12: setTicket sets only a previously empty ticketId', async () => {
    const flow = await createFlow();
    const first = await prisma.ticket.create({ data: { projectId, number: 1, type: 'TASK', title: 'First' } });
    const second = await prisma.ticket.create({ data: { projectId, number: 2, type: 'TASK', title: 'Second' } });
    expect(await stepRepository.setTicket(flow.id, first.id)).toBe(true);
    expect(await stepRepository.setTicket(flow.id, second.id)).toBe(false);
    expect((await prisma.fleetFlow.findUniqueOrThrow({ where: { id: flow.id } })).ticketId).toBe(first.id);
  });

  it('AC-13: findById maps ticketId and feature callsJobId', async () => {
    const ticket = await prisma.ticket.create({ data: { projectId, number: 1, type: 'TASK', title: 'Flow ticket' } });
    const flow = await prisma.fleetFlow.create({ data: {
      projectId, repoId, ticketId: ticket.id, entry: 'NAX', createdByType: 'USER', createdById: creatorId,
      branch: `branch-${randomUUID()}`, specSha: 'sha', setSha: 'sha', reviewerRole: 'reviewer', supervisorRole: 'supervisor', costCapUsd: 10,
      features: { create: [{ position: 0, feature: `feature-${randomUUID()}`, specPath: 'spec.md', dependsOn: [], callsJobId: 'j1' }] },
    } });
    expect(await flowRepository.findById(flow.id)).toMatchObject({ ticketId: ticket.id, features: [{ callsJobId: 'j1' }] });
  });
});
