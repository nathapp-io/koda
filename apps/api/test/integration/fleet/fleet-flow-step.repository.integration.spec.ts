import { canRunDbTests } from '../../helpers/test-environment';
import { resetDb } from '../../helpers/reset-db';
import { Test, type TestingModule } from '@nestjs/testing';
import { PrismaModule, PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { createPgAdapter } from '../../../src/prisma/pg-adapter';
import { seedFleetBase } from '../../helpers/fleet-fixtures';
import { PrismaFleetFlowStepRepository } from '../../../src/fleet/flows/prisma-fleet-flow-step.repository';
import { PrismaFleetFlowRepository } from '../../../src/fleet/flows/prisma-fleet-flow.repository';

const describeDb = canRunDbTests() ? describe : describe.skip;

describeDb('PrismaFleetFlowStepRepository (PG)', () => {
  let module: TestingModule;
  let prisma: PrismaClient;
  let repo: PrismaFleetFlowStepRepository;
  let flowRepo: PrismaFleetFlowRepository;
  let projectId: string;
  let repoId: string;
  let creatorId: string;

  beforeAll(async () => {
    await resetDb();
    module = await Test.createTestingModule({
      imports: [PrismaModule.forRoot({ client: PrismaClient, transaction: true, clientOptions: { adapter: createPgAdapter(process.env.DATABASE_URL) } })],
      providers: [PrismaFleetFlowStepRepository, PrismaFleetFlowRepository],
    }).compile();
    await module.init();
    prisma = module.get<PrismaService<PrismaClient>>(PrismaService).client;
    repo = module.get(PrismaFleetFlowStepRepository);
    flowRepo = module.get(PrismaFleetFlowRepository);
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
      specSha: 'sha', setSha: 'sha', reviewerRole: 'reviewer', supervisorRole: 'supervisor', costCapUsd: 10, state,
      features: { create: Array.from({ length: featureCount }, (_, position) => ({ position, feature: `feature-${crypto.randomUUID()}-${position}`, specPath: 'spec.md', dependsOn: [] })) },
    }, include: { features: { orderBy: { position: 'asc' } } } });
  }

  /** A job of the flow's first feature, unless the test names the feature it belongs to. */
  async function createJob(flowId: string, values: { flowStep?: string; queuedAt?: Date; costSpentUsd?: string; costCarriedUsd?: string; flowFeatureId?: string } = {}) {
    const flowFeatureId = values.flowFeatureId
      ?? (await prisma.fleetFlowFeature.findFirstOrThrow({ where: { flowId }, orderBy: { position: 'asc' } })).id;
    return prisma.fleetJob.create({ data: {
      projectId, repoId, ref: 'main', command: 'PLAN', feature: `job-${crypto.randomUUID()}`, profiles: [], maxCostUsd: 5,
      selectorLabels: [], requestedById: creatorId, flowId, flowStep: values.flowStep ?? null, flowFeatureId,
      queuedAt: values.queuedAt ?? new Date(), costSpentUsd: values.costSpentUsd ?? '0', costCarriedUsd: values.costCarriedUsd ?? '0',
    } });
  }

  it('AC-1/2/3 returns only APPROVED/RUNNING flows, whatever their feature count, ordered by id', async () => {
    const approved = await createFlow('APPROVED');
    const running = await createFlow('RUNNING');
    // US-008: a flow of a set is advanced too, one feature at a time.
    const approvedSet = await createFlow('APPROVED', 2);
    for (const state of ['PENDING', 'WAITING_MERGE', 'WAITING_ANSWER', 'COMPLETED', 'STOPPED']) await createFlow(state);
    const rows = await repo.listAdvanceable(50, null);
    expect(rows).toEqual([
      { id: approved.id, createdByType: 'USER', createdById: creatorId },
      { id: approvedSet.id, createdByType: 'USER', createdById: creatorId },
      { id: running.id, createdByType: 'USER', createdById: creatorId },
    ].sort((a, b) => a.id.localeCompare(b.id)));
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
    expect(await repo.latestJobForStep(flow.id, flow.features[0].id, 'PLAN')).toMatchObject({ id: newestPlan.id });
    expect(plan.id).not.toBe(newestPlan.id);
  });

  it('US-001 AC-8: latestJobWithIngest answers for the feature, not for the flow', async () => {
    const flow = await createFlow('RUNNING', 2);
    const [first, second] = flow.features;
    const mine = await createJob(flow.id, { flowFeatureId: first.id, queuedAt: new Date('2026-01-01T00:00:00Z') });
    const newer = await createJob(flow.id, { flowFeatureId: second.id, queuedAt: new Date('2026-01-02T00:00:00Z') });

    const latest = await repo.latestJobWithIngest(flow.id, first.id);

    expect(latest?.job.id).toBe(mine.id);
    expect(latest?.job.flowFeatureId).toBe(first.id);
    expect(newer.id).not.toBe(mine.id);
  });

  it('US-001 AC-9: latestJobForStep answers for the feature, not for the flow', async () => {
    const flow = await createFlow('RUNNING', 2);
    const [first, second] = flow.features;
    const plan = await createJob(flow.id, { flowStep: 'PLAN', flowFeatureId: second.id, queuedAt: new Date('2026-01-02T00:00:00Z') });
    const otherPlan = await createJob(flow.id, { flowStep: 'PLAN', flowFeatureId: first.id, queuedAt: new Date('2026-01-03T00:00:00Z') });

    expect(await repo.latestJobForStep(flow.id, second.id, 'PLAN')).toMatchObject({ id: plan.id });
    expect(otherPlan.id).not.toBe(plan.id);
  });

  it('US-001 AC-10: countJobsForStepSince counts the jobs of the feature only', async () => {
    const flow = await createFlow('RUNNING', 2);
    const [first, second] = flow.features;
    const since = new Date('2026-01-01T00:00:00Z');
    await createJob(flow.id, { flowStep: 'PLAN', flowFeatureId: second.id, queuedAt: new Date('2026-01-02T00:00:00Z') });
    await createJob(flow.id, { flowStep: 'PLAN', flowFeatureId: second.id, queuedAt: new Date('2026-01-03T00:00:00Z') });
    await createJob(flow.id, { flowStep: 'PLAN', flowFeatureId: first.id, queuedAt: new Date('2026-01-04T00:00:00Z') });
    await createJob(flow.id, { flowStep: 'PLAN', flowFeatureId: second.id, queuedAt: new Date('2025-12-31T00:00:00Z') });

    expect(await repo.countJobsForStepSince(flow.id, second.id, 'PLAN', since)).toBe(2);
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

  it('US-002 persists feature branches and isolated feature and flow states', async () => {
    const flow = await createFlow('RUNNING', 2);
    const [first, second] = flow.features;
    expect((await flowRepo.findById(flow.id))?.features.map(({ branch }) => branch)).toEqual([null, null]);

    await repo.setFeatureBranch(first.id, 'feat/b');
    await repo.markFeatureState(first.id, 'READY');
    await repo.setFlowState(flow.id, 'WAITING_MERGE');
    const updated = await flowRepo.findById(flow.id);
    expect(updated?.features.map(({ branch, state }) => ({ branch, state }))).toEqual([
      { branch: 'feat/b', state: 'READY' }, { branch: null, state: 'PENDING' },
    ]);
    expect(updated?.state).toBe('WAITING_MERGE');
    expect(second.state).toBe('PENDING');
  });

  it('US-002 completion preserves merged features and records calls sha promotion semantics', async () => {
    const flow = await createFlow('RUNNING', 2);
    const [merged, ready] = flow.features;
    await prisma.fleetFlowFeature.update({ where: { id: merged.id }, data: { state: 'MERGED' } });
    await prisma.fleetFlowFeature.update({ where: { id: ready.id }, data: { state: 'READY' } });
    const now = new Date('2026-11-04T12:34:56.000Z');
    await repo.complete(flow.id, now);
    expect((await flowRepo.findById(flow.id))?.features.map(({ state }) => state)).toEqual(['MERGED', 'COMPLETED']);
    expect(await prisma.fleetFlow.findUniqueOrThrow({ where: { id: flow.id } })).toMatchObject({ state: 'COMPLETED', endedAt: now });

    const callsFlow = await createFlow('RUNNING');
    const feature = callsFlow.features[0];
    await repo.recordCalls(callsFlow.id, feature.id, 'job-null', null);
    expect(await prisma.fleetFlow.findUniqueOrThrow({ where: { id: callsFlow.id } })).toMatchObject({ specSha: 'sha', setSha: 'sha' });
    await repo.recordCalls(callsFlow.id, feature.id, 'job-two', 'sha2');
    expect(await prisma.fleetFlow.findUniqueOrThrow({ where: { id: callsFlow.id } })).toMatchObject({ specSha: 'sha2', setSha: 'sha' });
    await repo.recordCalls(callsFlow.id, feature.id, 'job-three', 'sha3', { setSha: true });
    expect(await prisma.fleetFlow.findUniqueOrThrow({ where: { id: callsFlow.id } })).toMatchObject({ specSha: 'sha3', setSha: 'sha3' });
    expect((await flowRepo.findById(callsFlow.id))?.features[0]?.callsJobId).toBe('job-three');
  });

  it('US-002 keeps created, re-asked and updated spec sha aligned with set sha', async () => {
    const created = await flowRepo.create({
      projectId, repoId, entry: 'NAX', createdByType: 'USER', createdById: creatorId,
      branch: `branch-${crypto.randomUUID()}`, specSha: 'sha-create', reviewerRole: 'reviewer',
      supervisorRole: 'supervisor', costCapUsd: '10', features: [{ feature: 'f', specPath: 'spec.md', dependsOn: [] }],
    });
    expect(created.setSha).toBe(created.specSha);
    await flowRepo.updateSha(created.id, 'sha4');
    expect(await prisma.fleetFlow.findUniqueOrThrow({ where: { id: created.id } })).toMatchObject({ specSha: 'sha4', setSha: 'sha4' });
    await flowRepo.reask(created.id, { specSha: 'sha4', approvalRequestId: 'request' });
    expect(await prisma.fleetFlow.findUniqueOrThrow({ where: { id: created.id } })).toMatchObject({ specSha: 'sha4', setSha: 'sha4' });
  });

  it('US-002 recordCalls rolls back the feature marker when the flow SHA write fails', async () => {
    const flow = await createFlow('RUNNING');
    const feature = flow.features[0];
    await expect(repo.recordCalls('missing-flow', feature.id, 'job-rollback', 'sha-failure')).rejects.toThrow();
    expect(await prisma.fleetFlowFeature.findUniqueOrThrow({ where: { id: feature.id } })).toMatchObject({ callsJobId: null });
  });

  it('US-002 missing-flow completion rejects before changing unrelated rows', async () => {
    const flow = await createFlow('RUNNING');
    const before = await prisma.fleetFlowFeature.findMany({ where: { flowId: flow.id } });
    await expect(repo.complete('missing-flow', new Date())).rejects.toThrow();
    expect(await prisma.fleetFlow.findUniqueOrThrow({ where: { id: flow.id } })).toMatchObject({ state: 'RUNNING' });
    expect(await prisma.fleetFlowFeature.findMany({ where: { flowId: flow.id } })).toEqual(before);
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

  it('US-006 AC-1..4 stores rulings job ids scoped to the feature and maps them through findById', async () => {
    const firstFlow = await createFlow('RUNNING');
    const otherFlow = await createFlow('RUNNING');
    const feature = await prisma.fleetFlowFeature.findFirstOrThrow({ where: { flowId: firstFlow.id } });
    const otherFeature = await prisma.fleetFlowFeature.findFirstOrThrow({ where: { flowId: otherFlow.id } });

    expect(feature.rulingsJobId).toBeNull();
    await prisma.fleetFlowFeature.update({ where: { id: feature.id }, data: { rulingsJobId: null } });
    expect((await prisma.fleetFlowFeature.findUniqueOrThrow({ where: { id: feature.id } })).rulingsJobId).toBeNull();

    await prisma.fleetFlowFeature.update({ where: { id: feature.id }, data: {
      callsJobId: 'calls', questionsJobId: 'questions', questions: [{ id: '1', question: 'q' }], answers: [{ id: '1', answer: 'a' }],
    } });
    await repo.recordRulings(firstFlow.id, feature.id, 'j1');
    expect(await prisma.fleetFlowFeature.findUniqueOrThrow({ where: { id: feature.id } })).toMatchObject({
      rulingsJobId: 'j1', callsJobId: 'calls', questionsJobId: 'questions',
      questions: [{ id: '1', question: 'q' }], answers: [{ id: '1', answer: 'a' }],
    });
    expect((await flowRepo.findById(firstFlow.id))?.features[0]).toMatchObject({ rulingsJobId: 'j1' });

    await repo.recordRulings(firstFlow.id, otherFeature.id, 'wrong-flow');
    expect((await prisma.fleetFlowFeature.findUniqueOrThrow({ where: { id: otherFeature.id } })).rulingsJobId).toBeNull();
  });

  it('US-005 AC-1..6 records PRD edits only for the matching flow feature and maps the marker', async () => {
    const flow = await createFlow('RUNNING');
    const otherFlow = await createFlow('RUNNING');
    const feature = await prisma.fleetFlowFeature.findFirstOrThrow({ where: { flowId: flow.id } });
    const otherFeature = await prisma.fleetFlowFeature.findFirstOrThrow({ where: { flowId: otherFlow.id } });

    expect(feature.prdEditsJobId).toBeNull();
    await prisma.fleetFlowFeature.update({ where: { id: feature.id }, data: { callsJobId: 'calls', rulingsJobId: 'rulings' } });
    await repo.recordPrdEdits(flow.id, feature.id, 'job-1');
    expect(await prisma.fleetFlowFeature.findUniqueOrThrow({ where: { id: feature.id } })).toMatchObject({
      prdEditsJobId: 'job-1', callsJobId: 'calls', rulingsJobId: 'rulings',
    });
    expect((await flowRepo.findById(flow.id))?.features[0]).toMatchObject({ prdEditsJobId: 'job-1' });

    await repo.recordPrdEdits(flow.id, otherFeature.id, 'wrong-flow');
    expect((await prisma.fleetFlowFeature.findUniqueOrThrow({ where: { id: otherFeature.id } })).prdEditsJobId).toBeNull();
  });

  it('AC-14 does not settle an ingest from a different lease', async () => {
    const job = await createJob((await createFlow('RUNNING')).id);
    const artifact = await prisma.fleetJobArtifact.create({ data: { jobId: job.id, leaseEpoch: 4, kind: 'bundle', storageKey: `key-${job.id}`, sizeBytes: 0n, sha256: 'sha' } });
    await prisma.fleetBundleIngest.create({ data: { artifactId: artifact.id, jobId: job.id, leaseEpoch: 4, status: 'done', parserVersion: 1 } });
    expect(await repo.ingestSettled(job.id, 3)).toBe(false);
  });
});
