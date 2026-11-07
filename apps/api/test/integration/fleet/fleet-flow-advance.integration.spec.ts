import { Logger } from '@nestjs/common';
import { canRunDbTests } from '../../helpers/test-environment';
import { NathApplication } from '@nathapp/nestjs-app';
import type { PrismaClient } from '../../../src/generated/prisma/client';
import { FleetFlowTicker } from '../../../src/fleet/flows/fleet-flow.ticker';
import { FLEET_FLOW_STEP_REPOSITORY, type IFleetFlowStepRepository } from '../../../src/fleet/flows/domain/fleet-flow-step.domain';
import { FleetFlowsService } from '../../../src/fleet/flows/fleet-flows.service';
import { fixtureDb, withTestActor } from '../../helpers/action-context';
import { insertRunner, seedFleetBase } from '../../helpers/fleet-fixtures';
import { bootHttpApp } from '../../helpers/http-app';
import { resetDb } from '../../helpers/reset-db';

const integration = canRunDbTests() ? describe : describe.skip;
const SHA = 'a'.repeat(40);
const SPEC = '.nax/features/flow/spec.md';

integration('fleet flow advancement through the database', () => {
  let app: NathApplication;
  let db: PrismaClient;
  let ticker: FleetFlowTicker;
  let flows: FleetFlowsService;
  let projectId: string;
  let repoId: string;
  let creatorId: string;
  let runnerId: string;
  let threadId: string;
  const now = new Date('2026-11-07T12:00:00.000Z');

  beforeAll(async () => {
    vi.stubEnv('FLEET_THREADS_ENABLED', 'true');
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    db = fixtureDb(app);
    ({ projectId, repoId, adminId: creatorId } = await seedFleetBase(db));
    ticker = app.get(FleetFlowTicker);
    flows = app.get(FleetFlowsService);
  }, 60_000);

  afterAll(async () => { try { await app?.close(); } finally { vi.unstubAllEnvs(); } });

  beforeEach(async () => {
    await db.fleetPrReview.deleteMany();
    await db.fleetFlowFeature.deleteMany();
    await db.fleetFlow.deleteMany();
    await db.fleetJob.deleteMany({ where: { projectId } });
    await db.chatThread.deleteMany({ where: { projectId } });
    const runner = await insertRunner(db, { name: `flow-runner-${Date.now()}`, createdById: creatorId });
    runnerId = runner.id;
    const thread = await db.chatThread.create({ data: {
      projectId, repoId, title: 'flow integration', createdById: creatorId,
      backend: { kind: 'native', model: 'm1' }, skills: [], feature: 'flow', specPath: SPEC,
      baseRef: 'main', runnerId, publishedSha: SHA, specPublished: true, writtenPaths: [SPEC],
    } });
    threadId = thread.id;
    await db.chatThread.update({ where: { id: threadId }, data: {
      preApproval: { userId: creatorId, at: now.toISOString(), costCapUsd: '30' },
    } });
  });

  async function createFlow(features = ['flow']) {
    return withTestActor({ type: 'USER', id: creatorId }, async () => (await flows.create({
      entry: 'THREAD', threadId,
      features: features.map((feature) => ({ feature, specPath: SPEC, dependsOn: [] })),
      roles: { reviewer: 'acp:claude', supervisor: 'native:fast' }, costCapUsd: '25',
    }, { type: 'USER', id: creatorId }, { projectId, now })).flow).then(async (flow) => {
      return db.fleetFlow.update({ where: { id: flow.id }, data: {
        state: 'APPROVED', approvalMode: 'human', approverId: creatorId, approvedAt: now,
      } }).then(() => flow);
    });
  }

  it('AC-1–AC-4: tick dispatches and persists a linked SPEC_REVIEW job, step and audit', async () => {
    const flow = await createFlow();
    expect(await db.fleetFlow.findUniqueOrThrow({ where: { id: flow.id } })).toMatchObject({ state: 'APPROVED', specSha: SHA });
    const advanceable = await app.get<IFleetFlowStepRepository>(FLEET_FLOW_STEP_REPOSITORY).listAdvanceable(50, null);
    expect(advanceable.map(({ id }) => id)).toContain(flow.id);
    const loggerError = vi.mocked(Logger.prototype.error);
    loggerError.mockClear();
    await ticker.tick(now);
    expect(loggerError.mock.calls).toEqual([]);
    const afterTick = await db.fleetFlow.findUniqueOrThrow({ where: { id: flow.id } });
    expect(afterTick).toMatchObject({ state: 'RUNNING', stopReason: null, stopDetail: null });
    const jobs = await db.fleetJob.findMany({ where: { flowId: flow.id } });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ flowId: flow.id, flowStep: 'SPEC_REVIEW', command: 'AGENT', ref: SHA });
    expect(await db.fleetFlow.findUniqueOrThrow({ where: { id: flow.id } })).toMatchObject({ state: 'RUNNING' });
    expect(await db.fleetFlowFeature.findMany({ where: { flowId: flow.id } })).toMatchObject([{ currentStep: 'SPEC_REVIEW' }]);
    expect(await db.auditEntry.count({ where: { key: 'system.flow.advance', resourceType: 'flow', resourceId: flow.id } })).toBeGreaterThan(0);
  });

  it('AC-5: another tick does not duplicate a queued flow job', async () => {
    const flow = await createFlow();
    await ticker.tick(now);
    await ticker.tick(new Date(now.getTime() + 1_000));
    expect(await db.fleetJob.count({ where: { flowId: flow.id } })).toBe(1);
  });

  async function seedTerminalStep(flowId: string, step: string, command: string, data: Record<string, unknown> = {}) {
    const flow = await db.fleetFlow.findUniqueOrThrow({ where: { id: flowId }, include: { features: true } });
    await db.fleetFlow.update({ where: { id: flowId }, data: { state: 'RUNNING' } });
    await db.fleetFlowFeature.updateMany({ where: { flowId }, data: { state: 'RUNNING', currentStep: step } });
    return db.fleetJob.create({ data: {
      projectId, repoId, ref: step === 'SPEC_REVIEW' ? SHA : 'main', command, feature: flow.features[0].feature,
      profiles: [], maxCostUsd: '10', selectorLabels: [], pinnedRunnerId: runnerId, requestedById: creatorId,
      state: 'COMPLETED', queuedAt: new Date(now.getTime() - 60_000), finishedAt: new Date(now.getTime() - 30_000),
      flowId, flowStep: step, ...data,
    } });
  }

  it('AC-8: a failed SPEC_REVIEW stops with exact detail and audit through tick', async () => {
    const flow = await createFlow();
    const job = await seedTerminalStep(flow.id, 'SPEC_REVIEW', 'AGENT', { state: 'FAILED', stateReason: 'checkout: ref not found' });
    const loggerError = vi.mocked(Logger.prototype.error);
    loggerError.mockClear();
    await ticker.tick(now);
    expect(await db.fleetFlow.findUniqueOrThrow({ where: { id: flow.id } })).toMatchObject({
      state: 'STOPPED', stopReason: 'step_failed', stopDetail: `SPEC_REVIEW job ${job.id} FAILED: checkout: ref not found`,
    });
    expect(await db.auditEntry.count({ where: { key: 'system.flow.advance', resourceType: 'flow', resourceId: flow.id } })).toBeGreaterThan(0);
    expect(loggerError.mock.calls).toEqual([]);
  });

  it('AC-9: an empty SPEC_REVIEW verdict dispatches a linked PLAN job', async () => {
    const flow = await createFlow();
    await seedTerminalStep(flow.id, 'SPEC_REVIEW', 'AGENT', {
      agentResult: { status: 'completed', output: 'Looks good. {"findings":[]}', truncated: false, deniedAsks: [], deniedAsksTruncated: false },
    });
    await ticker.tick(now);
    expect(await db.fleetJob.findMany({ where: { flowId: flow.id, flowStep: 'PLAN' } })).toHaveLength(1);
  });

  it('AC-10: a SPEC_REVIEW finding stops the flow', async () => {
    const flow = await createFlow();
    await seedTerminalStep(flow.id, 'SPEC_REVIEW', 'AGENT', {
      agentResult: { status: 'completed', output: '{"findings":[{"id":"F1","summary":"A finding"}]}', truncated: false, deniedAsks: [], deniedAsksTruncated: false },
    });
    await ticker.tick(now);
    expect(await db.fleetFlow.findUniqueOrThrow({ where: { id: flow.id } })).toMatchObject({ state: 'STOPPED', stopReason: 'review_findings' });
  });

  it('AC-11: RUN creates a review claim linked to its new REVIEW job', async () => {
    const flow = await createFlow();
    const repo = await db.fleetRepo.findUniqueOrThrow({ where: { id: repoId } });
    await seedTerminalStep(flow.id, 'RUN', 'RUN', { resultPrUrl: `https://github.com/acme/${repo.name}/pull/12`, resultSha: 'h1' });
    await ticker.tick(now);
    const claim = await db.fleetPrReview.findUniqueOrThrow({ where: { repoId_prNumber_headSha: { repoId, prNumber: 12, headSha: 'h1' } } });
    const review = await db.fleetJob.findUniqueOrThrow({ where: { id: claim.jobId! } });
    expect(claim).toMatchObject({ outcome: 'dispatched', prNumber: 12, headSha: 'h1' });
    expect(review).toMatchObject({ command: 'REVIEW', flowId: flow.id, flowStep: 'REVIEW' });
  });

  it('AC-12–AC-14: an existing auto-review job is adopted and the PR recorded without dispatching another job', async () => {
    const flow = await createFlow();
    const repo = await db.fleetRepo.findUniqueOrThrow({ where: { id: repoId } });
    await seedTerminalStep(flow.id, 'RUN', 'RUN', { resultPrUrl: `https://github.com/acme/${repo.name}/pull/12`, resultSha: 'h1' });
    const autoReview = await db.fleetJob.create({ data: {
      projectId, repoId, ref: 'h1', command: 'REVIEW', feature: 'review-pr-12', profiles: [], maxCostUsd: '10',
      selectorLabels: [], pinnedRunnerId: runnerId, requestedById: creatorId, state: 'QUEUED',
    } });
    await db.fleetPrReview.create({ data: { repoId, prNumber: 12, headSha: 'h1', jobId: autoReview.id, outcome: 'dispatched' } });
    await ticker.tick(now);
    expect(await db.fleetJob.count({ where: { repoId, command: 'REVIEW' } })).toBe(1);
    expect(await db.fleetJob.findUniqueOrThrow({ where: { id: autoReview.id } })).toMatchObject({ flowId: flow.id, flowStep: 'REVIEW' });
    expect(await db.fleetFlowFeature.findMany({ where: { flowId: flow.id } })).toMatchObject([{ prNumber: 12, currentStep: 'REVIEW' }]);
  });

  it('AC-6/7: multiple features remain approved and do not dispatch', async () => {
    const flow = await createFlow(['flow', 'other']);
    await ticker.tick(now);
    expect(await db.fleetJob.count({ where: { flowId: flow.id } })).toBe(0);
    expect(await db.fleetFlow.findUniqueOrThrow({ where: { id: flow.id } })).toMatchObject({ state: 'APPROVED' });
  });
});
