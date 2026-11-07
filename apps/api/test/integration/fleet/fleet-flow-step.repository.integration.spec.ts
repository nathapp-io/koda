import { canRunDbTests } from '../../helpers/test-environment';
import { resetDb } from '../../helpers/reset-db';
import { Test, type TestingModule } from '@nestjs/testing';
import { PrismaModule, PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { createPgAdapter } from '../../../src/prisma/pg-adapter';
import { seedFleetBase } from '../../helpers/fleet-fixtures';
import { PrismaFleetFlowStepRepository } from '../../../src/fleet/flows/prisma-fleet-flow-step.repository';

const describeDb = canRunDbTests() ? describe : describe.skip;

describeDb('PrismaFleetFlowStepRepository (PG)', () => {
  let module: TestingModule;
  let prisma: PrismaClient;
  let repo: PrismaFleetFlowStepRepository;
  let projectId: string;
  let repoId: string;
  let creatorId: string;

  beforeAll(async () => {
    await resetDb();
    module = await Test.createTestingModule({
      imports: [PrismaModule.forRoot({ client: PrismaClient, transaction: true, clientOptions: { adapter: createPgAdapter(process.env.DATABASE_URL) } })],
      providers: [PrismaFleetFlowStepRepository],
    }).compile();
    await module.init();
    prisma = module.get<PrismaService<PrismaClient>>(PrismaService).client;
    repo = module.get(PrismaFleetFlowStepRepository);
    const base = await seedFleetBase(prisma);
    ({ projectId, repoId } = base);
    creatorId = base.adminId;
  }, 60_000);
  afterEach(async () => {
    const flows = await prisma.fleetFlow.findMany({ where: { projectId }, select: { id: true } });
    const flowIds = flows.map(({ id }) => id);
    await prisma.fleetJob.deleteMany({ where: { flowId: { in: flowIds } } });
    await prisma.fleetFlow.deleteMany({ where: { id: { in: flowIds } } });
  });
  afterAll(async () => { await module?.close(); });

  async function createFlow(state: string, featureCount = 1) {
    return prisma.fleetFlow.create({ data: {
      projectId, repoId, entry: 'NAX', createdByType: 'USER', createdById: creatorId, branch: `branch-${crypto.randomUUID()}`,
      specSha: 'sha', reviewerRole: 'reviewer', supervisorRole: 'supervisor', costCapUsd: 10, state,
      features: { create: Array.from({ length: featureCount }, (_, position) => ({ position, feature: `feature-${crypto.randomUUID()}-${position}`, specPath: 'spec.md', dependsOn: [] })) },
    } });
  }

  async function createJob(flowId: string, values: { flowStep?: string; queuedAt?: Date; costSpentUsd?: string; costCarriedUsd?: string } = {}) {
    return prisma.fleetJob.create({ data: {
      projectId, repoId, ref: 'main', command: 'PLAN', feature: `job-${crypto.randomUUID()}`, profiles: [], maxCostUsd: 5,
      selectorLabels: [], requestedById: creatorId, flowId, flowStep: values.flowStep ?? null,
      queuedAt: values.queuedAt ?? new Date(), costSpentUsd: values.costSpentUsd ?? '0', costCarriedUsd: values.costCarriedUsd ?? '0',
    } });
  }

  it('AC-1/2/3 returns only APPROVED/RUNNING flows with exactly one feature, ordered by id', async () => {
    const approved = await createFlow('APPROVED');
    const running = await createFlow('RUNNING');
    await createFlow('APPROVED', 2);
    for (const state of ['PENDING', 'WAITING_MERGE', 'WAITING_ANSWER', 'COMPLETED', 'STOPPED']) await createFlow(state);
    const rows = await repo.listAdvanceable(50, null);
    expect(rows).toEqual([{ id: approved.id, createdByType: 'USER', createdById: creatorId }, { id: running.id, createdByType: 'USER', createdById: creatorId }].sort((a, b) => a.id.localeCompare(b.id)));
  });

  it('AC-4 pages eligible flows by id after the cursor', async () => {
    const flows = await Promise.all([createFlow('APPROVED'), createFlow('RUNNING'), createFlow('APPROVED')]);
    const ids = flows.map(({ id }) => id).sort();
    expect(await repo.listAdvanceable(1, ids[0] ?? null)).toEqual([{ id: ids[1], createdByType: 'USER', createdById: creatorId }]);
  });

  it('AC-5/6 returns the newest queued job, or null when there are none', async () => {
    const flow = await createFlow('APPROVED');
    const early = await createJob(flow.id, { queuedAt: new Date('2026-01-01T00:00:00Z') });
    const late = await createJob(flow.id, { queuedAt: new Date('2026-01-02T00:00:00Z') });
    expect(await repo.latestJob(flow.id)).toMatchObject({ id: late.id });
    expect(await repo.latestJob((await createFlow('APPROVED')).id)).toBeNull();
    expect(early.id).not.toBe(late.id);
  });

  it('AC-7 latestJobForStep filters by step before selecting newest', async () => {
    const flow = await createFlow('RUNNING');
    const plan = await createJob(flow.id, { flowStep: 'PLAN', queuedAt: new Date('2026-01-01T00:00:00Z') });
    await createJob(flow.id, { flowStep: 'RUN', queuedAt: new Date('2026-01-03T00:00:00Z') });
    const newestPlan = await createJob(flow.id, { flowStep: 'PLAN', queuedAt: new Date('2026-01-02T00:00:00Z') });
    expect(await repo.latestJobForStep(flow.id, 'PLAN')).toMatchObject({ id: newestPlan.id });
    expect(plan.id).not.toBe(newestPlan.id);
  });

  it('AC-8/9/10 sums spent and carried cost only for this flow, formatting four places', async () => {
    const flow = await createFlow('APPROVED');
    await createJob(flow.id, { costSpentUsd: '1.2500', costCarriedUsd: '0.5000' });
    await createJob(flow.id, { costSpentUsd: '2.0000', costCarriedUsd: '0' });
    await createJob((await createFlow('APPROVED')).id, { costSpentUsd: '99', costCarriedUsd: '1' });
    expect(await repo.sumCost(flow.id)).toBe('3.7500');
    expect(await repo.sumCost((await createFlow('APPROVED')).id)).toBe('0.0000');
  });

  it.each(['done', 'failed', 'running'] as const)('AC-11/12/13 recognizes ingest settlement status %s', async (status) => {
    const job = await createJob((await createFlow('RUNNING')).id);
    const artifact = await prisma.fleetJobArtifact.create({ data: { jobId: job.id, leaseEpoch: 3, kind: 'bundle', storageKey: `key-${job.id}`, sizeBytes: 0n, sha256: 'sha' } });
    await prisma.fleetBundleIngest.create({ data: { artifactId: artifact.id, jobId: job.id, leaseEpoch: 3, status, parserVersion: 1 } });
    expect(await repo.ingestSettled(job.id, 3)).toBe(status === 'done' || status === 'failed');
  });

  it('AC-15 stores the flow spend total', async () => {
    const flow = await createFlow('RUNNING');
    await repo.setSpent(flow.id, '3.7500');
    expect((await prisma.fleetFlow.findUniqueOrThrow({ where: { id: flow.id } })).spentUsd.toFixed(4)).toBe('3.7500');
  });

  it('AC-16/17 resolves user creator existence and disabled status', async () => {
    const disabled = await prisma.user.create({ data: { email: `disabled-${crypto.randomUUID()}@example.com`, passwordHash: 'hash', disabled: true } });
    expect(await repo.creatorAccess({ type: 'USER', id: disabled.id })).toEqual({ exists: true, disabled: true });
    expect(await repo.creatorAccess({ type: 'USER', id: crypto.randomUUID() })).toEqual({ exists: false, disabled: false });
  });

  it('AC-18/19 resolves agent creator existence without treating liveness as disabled', async () => {
    const slug = `agent-${crypto.randomUUID()}`;
    const agent = await prisma.agent.create({ data: { name: slug, slug, apiKeyHash: crypto.randomUUID() } });
    expect(await repo.creatorAccess({ type: 'AGENT', id: agent.id })).toEqual({ exists: true, disabled: false });
    expect(await repo.creatorAccess({ type: 'AGENT', id: crypto.randomUUID() })).toEqual({ exists: false, disabled: false });
  });

  it('AC-20 verifies markStep transitions an APPROVED flow to RUNNING', async () => {
    const flow = await createFlow('APPROVED');
    const feature = await prisma.fleetFlowFeature.findFirstOrThrow({ where: { flowId: flow.id } });
    await repo.markStep(flow.id, feature.id, 'REVIEW', { flowState: 'RUNNING', prNumber: 7 });
    expect((await prisma.fleetFlow.findUniqueOrThrow({ where: { id: flow.id } })).state).toBe('RUNNING');
  });

  it('AC-20/21 marks flow and feature progress and preserves an omitted PR number', async () => {
    const flow = await createFlow('RUNNING');
    const feature = await prisma.fleetFlowFeature.findFirstOrThrow({ where: { flowId: flow.id } });
    await repo.markStep(flow.id, feature.id, 'REVIEW', { flowState: 'RUNNING', prNumber: 7 });
    expect((await prisma.fleetFlow.findUniqueOrThrow({ where: { id: flow.id } })).state).toBe('RUNNING');
    expect(await prisma.fleetFlowFeature.findUniqueOrThrow({ where: { id: feature.id } })).toMatchObject({ state: 'RUNNING', currentStep: 'REVIEW', prNumber: 7 });
    await repo.markStep(flow.id, feature.id, 'PLAN', { flowState: 'RUNNING' });
    expect((await prisma.fleetFlowFeature.findUniqueOrThrow({ where: { id: feature.id } })).prNumber).toBe(7);
  });

  it('AC-22/23 completes flow and feature with the supplied time', async () => {
    const flow = await createFlow('RUNNING');
    const feature = await prisma.fleetFlowFeature.findFirstOrThrow({ where: { flowId: flow.id } });
    const now = new Date('2026-11-04T12:34:56.000Z');
    await repo.complete(flow.id, now);
    expect(await prisma.fleetFlow.findUniqueOrThrow({ where: { id: flow.id } })).toMatchObject({ state: 'COMPLETED', endedAt: now });
    expect((await prisma.fleetFlowFeature.findUniqueOrThrow({ where: { id: feature.id } })).state).toBe('COMPLETED');
  });

  it('AC-14 does not settle an ingest from a different lease', async () => {
    const job = await createJob((await createFlow('RUNNING')).id);
    const artifact = await prisma.fleetJobArtifact.create({ data: { jobId: job.id, leaseEpoch: 4, kind: 'bundle', storageKey: `key-${job.id}`, sizeBytes: 0n, sha256: 'sha' } });
    await prisma.fleetBundleIngest.create({ data: { artifactId: artifact.id, jobId: job.id, leaseEpoch: 4, status: 'done', parserVersion: 1 } });
    expect(await repo.ingestSettled(job.id, 3)).toBe(false);
  });
});
