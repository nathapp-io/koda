import { canRunDbTests } from '../helpers/test-environment';
import { resetDb } from '../helpers/reset-db';
import { Test, type TestingModule } from '@nestjs/testing';
import { PrismaModule, PrismaService } from '@nathapp/nestjs-prisma';
import { TRANSACTION_MANAGER, type ITransactionManager } from '@nathapp/nestjs-data';
import { PrismaClient } from '../../src/generated/prisma/client';
import { createPgAdapter } from '../../src/prisma/pg-adapter';
import { seedFleetBase } from '../helpers/fleet-fixtures';
import { PrismaFleetFlowRepository } from '../../src/fleet/flows/prisma-fleet-flow.repository';
import { PrismaFleetFlowStepRepository } from '../../src/fleet/flows/prisma-fleet-flow-step.repository';
import { FlowTransitionError } from '../../src/fleet/flows/domain/fleet-flow.domain';
import { FLOW_CALL_TEXT_MAX, flowQuestions } from '../../src/fleet/flows/flow-calls';

const describeDb = canRunDbTests() ? describe : describe.skip;

describeDb('PrismaFleetFlowRepository', () => {
  let module: TestingModule;
  let tx: ITransactionManager;
  let prisma: PrismaClient;
  let repo: PrismaFleetFlowRepository;
  let steps: PrismaFleetFlowStepRepository;
  let projectId: string;
  let repoId: string;

  beforeAll(async () => {
    await resetDb();
    module = await Test.createTestingModule({
      imports: [PrismaModule.forRoot({
        client: PrismaClient,
        transaction: true,
        clientOptions: { adapter: createPgAdapter(process.env.DATABASE_URL) },
      })],
      providers: [PrismaFleetFlowRepository, PrismaFleetFlowStepRepository],
    }).compile();
    await module.init();
    prisma = module.get<PrismaService<PrismaClient>>(PrismaService).client;
    tx = module.get(TRANSACTION_MANAGER);
    repo = module.get(PrismaFleetFlowRepository);
    steps = module.get(PrismaFleetFlowStepRepository);
    ({ projectId, repoId } = await seedFleetBase(prisma));
  }, 60_000);
  afterAll(async () => { await module?.close(); });

  async function createFlow(overrides: Partial<Parameters<PrismaFleetFlowRepository['create']>[0]> = {}) {
    return repo.create({
      projectId, repoId, entry: 'NAX', createdByType: 'USER', createdById: 'creator',
      branch: 'main', specSha: 'sha-1', reviewerRole: 'reviewer', supervisorRole: 'supervisor', costCapUsd: '4.25',
      features: [], ...overrides,
    });
  }

  /** A flow with its single feature, in the state a review leaves it in. */
  async function createRunningFlow() {
    const flow = await createFlow({ features: [{ feature: 'a', specPath: 'a/spec.md', dependsOn: [] }] });
    await prisma.fleetFlow.update({ where: { id: flow.id }, data: { state: 'RUNNING' } });
    await prisma.fleetFlowFeature.update({ where: { id: flow.features[0].id }, data: { state: 'RUNNING' } });
    return flow;
  }

  it('AC-1 persists ordered features with pending state', async () => {
    const flow = await createFlow({ features: ['a', 'b', 'c'].map((feature) => ({ feature, specPath: `${feature}/spec.md`, dependsOn: [] })) });
    expect(flow.features.map(({ position, state }) => [position, state])).toEqual([[0, 'PENDING'], [1, 'PENDING'], [2, 'PENDING']]);
  });
  it('AC-2 finds features ordered with dependencies', async () => {
    const flow = await createFlow({ features: [
      { feature: 'b', specPath: 'b/spec.md', dependsOn: ['a'] },
      { feature: 'a', specPath: 'a/spec.md', dependsOn: [] },
    ] });
    expect((await repo.findById(flow.id))?.features.map(({ feature, dependsOn }) => [feature, dependsOn])).toEqual([['b', ['a']], ['a', []]]);
  });
  it('AC-3 rolls back a flow when feature uniqueness fails', async () => {
    const before = await prisma.fleetFlow.count();
    await expect(createFlow({ features: [1, 2].map(() => ({ feature: 'same', specPath: 'spec.md', dependsOn: [] })) })).rejects.toBeDefined();
    expect(await prisma.fleetFlow.count()).toBe(before);
  });
  it.each(['./docs/spec.md', 'docs//spec.md', 'docs/./spec.md'])('B1 persists canonical specPath for %s', async (specPath) => {
    const flow = await createFlow({ features: [{ feature: 'flow', specPath, dependsOn: [] }] });
    expect(flow.features[0].specPath).toBe('docs/spec.md');
    expect((await prisma.fleetFlowFeature.findFirstOrThrow({ where: { flowId: flow.id } })).specPath).toBe('docs/spec.md');
  });
  it('M1 rolls back nested repository transitions with the caller transaction', async () => {
    const flow = await createFlow();
    const failure = new Error('abort caller transaction');
    await expect(tx.run(async () => {
      await repo.approve(flow.id, { mode: 'REQUEST', approverId: 'approver', approvedAt: new Date(), approvalRequestId: 'request' });
      await repo.updateSha(flow.id, 'rolled-back-sha');
      throw failure;
    })).rejects.toBe(failure);
    expect(await repo.findById(flow.id)).toEqual(flow);
  });
  it('M1 holds the flow lock until commit and rejects approval racing a stop', async () => {
    const flow = await createFlow();
    let releaseLock!: () => void;
    let locked!: (pid: number) => void;
    const held = new Promise<number>((resolve) => { locked = resolve; });
    const release = new Promise<void>((resolve) => { releaseLock = resolve; });
    const holder = tx.run(async () => {
      const [{ pid }] = await prisma.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      const stopped = await repo.stop(flow.id, 'human_stop', new Date());
      locked(pid);
      await release;
      return stopped;
    });
    let contender: Promise<unknown> | undefined;
    try {
      const pid = await Promise.race([held, holder.then(() => { throw new Error('holder ended before signalling'); })]);
      // Independent reads must still see the committed PENDING snapshot, not the nested stop.
      expect((await repo.findById(flow.id))?.state).toBe('PENDING');
      contender = repo.approve(flow.id, { mode: 'REQUEST', approverId: 'racer', approvedAt: new Date(), approvalRequestId: 'request' })
        .then((value) => value, (error: unknown) => error);
      // Observe a real Postgres lock wait rather than relying on a scheduling delay.
      await vi.waitFor(async () => {
        const [row] = await prisma.$queryRaw<Array<{ blocked: boolean }>>`
          SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))
          ) AS blocked`;
        expect(row.blocked).toBe(true);
      }, { timeout: 2_000, interval: 20 });
    } finally {
      releaseLock();
      await Promise.allSettled([holder, contender]);
    }
    const stopped = await holder;
    expect(await contender).toBeInstanceOf(FlowTransitionError);
    expect(await repo.findById(flow.id)).toEqual(stopped);
  });
  it('AC-4 and AC-5 query live flow state for a thread', async () => {
    const thread = await prisma.chatThread.create({ data: { projectId, title: 'flow thread', createdById: 'creator', backend: {}, skills: [] } });
    const flow = await createFlow({ threadId: thread.id });
    const approved = await repo.approve(flow.id, { mode: 'REQUEST', approverId: 'approver', approvedAt: new Date(), approvalRequestId: 'request' });
    expect((await repo.findLiveForThread(thread.id))?.state).toBe('APPROVED');
    await repo.stop(approved.id, 'human_stop', new Date());
    expect(await repo.findLiveForThread(thread.id)).toBeNull();
  });
  it('AC-6 finds live flows by repo, branch and sha', async () => {
    await createFlow({ branch: 'feature', specSha: 'sha-target' });
    expect(await repo.findLiveForSpec(repoId, 'feature', 'sha-target')).toMatchObject({ state: 'PENDING', repoId, branch: 'feature', specSha: 'sha-target' });
  });
  it('AC-7 records approval attribution', async () => {
    const flow = await createFlow(); const approvedAt = new Date();
    expect(await repo.approve(flow.id, { mode: 'REQUEST', approverId: 'approver', approvedAt, approvalRequestId: 'request' })).toMatchObject({ state: 'APPROVED', approvalMode: 'REQUEST', approverId: 'approver', approvedAt, approvalRequestId: 'request' });
  });
  it('AC-8 reasks an approved flow and clears approval', async () => {
    const flow = await createFlow(); await repo.approve(flow.id, { mode: 'REQUEST', approverId: 'approver', approvedAt: new Date(), approvalRequestId: 'old' });
    expect(await repo.reask(flow.id, { specSha: 'sha-2', approvalRequestId: 'new' })).toMatchObject({ state: 'PENDING', specSha: 'sha-2', approvalRequestId: 'new', approvalMode: null, approverId: null, approvedAt: null });
  });
  it('AC-9 updates only sha on an approved flow', async () => {
    const flow = await createFlow(); const approved = await repo.approve(flow.id, { mode: 'REQUEST', approverId: 'approver', approvedAt: new Date(), approvalRequestId: 'request' });
    const updated = await repo.updateSha(flow.id, 'sha-2');
    expect(updated).toMatchObject({ specSha: 'sha-2', state: approved.state, approvalMode: approved.approvalMode, approverId: approved.approverId, approvedAt: approved.approvedAt, approvalRequestId: approved.approvalRequestId });
  });
  it('AC-10 stops a flow with reason, detail and end time, and stops every feature', async () => {
    const flow = await createFlow({ features: ['a', 'b'].map((feature) => ({ feature, specPath: `${feature}/spec.md`, dependsOn: [] })) }); const now = new Date();
    expect(await repo.stop(flow.id, 'cost_cap', now, 'spent 5 of cap 5')).toMatchObject({ state: 'STOPPED', stopReason: 'cost_cap', stopDetail: 'spent 5 of cap 5', endedAt: now });
    const features = await prisma.fleetFlowFeature.findMany({ where: { flowId: flow.id }, orderBy: { position: 'asc' } });
    expect(features).toHaveLength(2);
    expect(features.map(({ state }) => state)).toEqual(['STOPPED', 'STOPPED']);
  });
  it('stores job flow linkage and preserves jobs when a flow is deleted', async () => {
    const flow = await createFlow();
    const job = await prisma.fleetJob.create({ data: { projectId, repoId, ref: 'main', command: 'PLAN', feature: 'flow', profiles: [], maxCostUsd: 5, selectorLabels: [], requestedById: 'creator', flowId: flow.id, flowStep: 'PLAN' } });
    expect(await prisma.fleetJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ flowId: flow.id, flowStep: 'PLAN' });
    await prisma.fleetFlow.delete({ where: { id: flow.id } });
    expect(await prisma.fleetJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ flowId: null, flowStep: 'PLAN' });
  });
  it('clears stopDetail when omitted and returns persisted detail from findById', async () => {
    const flow = await createFlow();
    await prisma.fleetFlow.update({ where: { id: flow.id }, data: { stopDetail: 'stored detail' } });
    expect(await repo.findById(flow.id)).toMatchObject({ stopDetail: 'stored detail' });
    expect(await repo.stop(flow.id, 'human_stop', new Date())).toMatchObject({ stopDetail: null });
  });
  it('resets every feature to pending with no current step on reask', async () => {
    const flow = await createFlow({ features: [{ feature: 'a', specPath: 'a/spec.md', dependsOn: [] }] });
    await repo.approve(flow.id, { mode: 'REQUEST', approverId: 'approver', approvedAt: new Date(), approvalRequestId: 'request' });
    await prisma.fleetFlow.update({ where: { id: flow.id }, data: { state: 'RUNNING' } });
    await prisma.fleetFlowFeature.updateMany({ where: { flowId: flow.id }, data: { state: 'RUNNING', currentStep: 'SPEC_REVIEW' } });
    await repo.reask(flow.id, { specSha: 'sha-new', approvalRequestId: 'new-request' });
    expect(await prisma.fleetFlowFeature.findMany({ where: { flowId: flow.id } })).toMatchObject([{ state: 'PENDING', currentStep: null }]);
  });
  it.each(['STOPPED', 'COMPLETED'] as const)('AC-10 rejects stopping terminal %s without mutation', async (state) => {
    const flow = await createFlow();
    await prisma.fleetFlow.update({ where: { id: flow.id }, data: { state } });
    const terminal = await repo.findById(flow.id);
    await expect(repo.stop(flow.id, 'human_stop', new Date())).rejects.toBeInstanceOf(FlowTransitionError);
    expect(await repo.findById(flow.id)).toEqual(terminal);
  });
  it('AC-8 filters project flows to the requested thread', async () => {
    const thread1 = await prisma.chatThread.create({ data: { projectId, title: 'thread one', createdById: 'creator', backend: {}, skills: [] } });
    const thread2 = await prisma.chatThread.create({ data: { projectId, title: 'thread two', createdById: 'creator', backend: {}, skills: [] } });
    const flow1 = await createFlow({ threadId: thread1.id });
    await createFlow({ threadId: thread2.id });
    const page = await repo.findPage({ projectId, threadId: thread1.id }, { current: 1, size: 20 });
    expect(page.records.map(({ id }) => id)).toEqual([flow1.id]);
  });

  it('AC-12 pages project flows newest first and filters other projects', async () => {
    const older = await createFlow(); await new Promise((resolve) => setTimeout(resolve, 5)); const newer = await createFlow();
    const otherProject = await seedFleetBase(prisma);
    await createFlow({ projectId: otherProject.projectId, repoId: otherProject.repoId });
    const page = await repo.findPage({ projectId }, { current: 1, size: 20 } as never);
    expect(page.records.map(({ id }) => id)).toEqual(expect.arrayContaining([older.id, newer.id]));
    expect(page.records.findIndex(({ id }) => id === newer.id)).toBeLessThan(page.records.findIndex(({ id }) => id === older.id));
    expect(page.records.every(({ projectId: id }) => id === projectId)).toBe(true);
  });
  it('AC-13 cascades repo deletion to flows and features without breaking shared fixtures', async () => {
    const ownRepo = await seedFleetBase(prisma);
    const flow = await createFlow({ repoId: ownRepo.repoId, projectId: ownRepo.projectId, features: [{ feature: 'a', specPath: 'a/spec.md', dependsOn: [] }] });
    await prisma.fleetRepo.delete({ where: { id: ownRepo.repoId } });
    expect(await prisma.fleetFlow.findUnique({ where: { id: flow.id } })).toBeNull();
    expect(await prisma.fleetFlowFeature.count({ where: { flowId: flow.id } })).toBe(0);
    expect(await prisma.fleetRepo.findUnique({ where: { id: repoId } })).not.toBeNull();
    expect((await createFlow()).repoId).toBe(repoId);
  });

  it('AC-1 reads a feature created without the answer columns as empty', async () => {
    const flow = await createFlow({ features: [{ feature: 'a', specPath: 'a/spec.md', dependsOn: [] }] });
    const feature = (await repo.findById(flow.id))?.features[0];
    expect(feature).toMatchObject({ questionsJobId: null, questions: null, answers: null, answeredById: null, answeredAt: null });
  });

  it('AC-2 waits for an answer and stores the questions of the review', async () => {
    const flow = await createRunningFlow();
    await steps.setWaiting(flow.id, flow.features[0].id, { jobId: 'j1', questions: [{ id: '2', question: 'Q1' }] });
    const stored = await repo.findById(flow.id);
    expect(stored?.state).toBe('WAITING_ANSWER');
    expect(stored?.features[0]).toMatchObject({
      state: 'WAITING_ANSWER', questionsJobId: 'j1', questions: [{ id: '2', question: 'Q1' }],
    });
  });

  it('AC-3 clears the answers of an earlier review when a new wait starts', async () => {
    const flow = await createRunningFlow();
    await prisma.fleetFlowFeature.update({
      where: { id: flow.features[0].id },
      data: {
        answers: [{ id: '2', answer: 'A1' }], answeredById: 'u1', answeredAt: new Date('2026-11-05T12:00:00.000Z'),
      },
    });
    await steps.setWaiting(flow.id, flow.features[0].id, { jobId: 'j2', questions: [{ id: '4', question: 'Q2' }] });
    const feature = (await repo.findById(flow.id))?.features[0];
    expect(feature).toMatchObject({ questionsJobId: 'j2', questions: [{ id: '4', question: 'Q2' }], answers: null, answeredById: null, answeredAt: null });
    // The column is SQL NULL: a plain `null` would write the JSON null instead of clearing it.
    const [row] = await prisma.$queryRaw<Array<{ cleared: boolean }>>`SELECT "answers" IS NULL AS cleared FROM "FleetFlowFeature" WHERE "id" = ${flow.features[0].id}`;
    expect(row?.cleared).toBe(true);
  });

  it('AC-4 records the answers and resumes the flow', async () => {
    const flow = await createRunningFlow();
    await steps.setWaiting(flow.id, flow.features[0].id, { jobId: 'j1', questions: [{ id: '2', question: 'Q1' }] });
    const at = new Date('2026-11-05T12:00:00.000Z');
    const recorded = await repo.recordAnswers(flow.id, flow.features[0].id, { answers: [{ id: '2', answer: 'A1' }], userId: 'u1', at });
    expect(recorded.state).toBe('RUNNING');
    expect(recorded.features[0]).toMatchObject({
      state: 'RUNNING', answers: [{ id: '2', answer: 'A1' }], answeredById: 'u1', answeredAt: at,
    });
  });

  it('AC-5 reads the questions of a waiting flow as an array of question objects', async () => {
    const flow = await createRunningFlow();
    await steps.setWaiting(flow.id, flow.features[0].id, { jobId: 'j1', questions: [{ id: '2', question: 'Q1' }] });
    const feature = (await repo.findById(flow.id))?.features[0];
    expect(Array.isArray(feature?.questions)).toBe(true);
    expect(feature?.questions).toEqual([{ id: '2', question: 'Q1' }]);
  });

  it('AC-8 keeps the flow running when the feature of a wait does not exist', async () => {
    const flow = await createRunningFlow();
    await expect(tx.run(async () => {
      await steps.setWaiting(flow.id, 'missing-feature', { jobId: 'j1', questions: [{ id: '2', question: 'Q1' }] });
    })).rejects.toThrow(/not found/i);
    expect((await repo.findById(flow.id))?.state).toBe('RUNNING');
  });

  it('AC-2 stores a question whose text is cut inside a surrogate pair', async () => {
    const flow = await createRunningFlow();
    // The cut lands between the halves of the emoji, so the stored question keeps only whole
    // characters: PostgreSQL JSONB rejects a lone surrogate.
    const [question] = flowQuestions([{
      class: 'ambiguous', summary: 's', question: 'a'.repeat(FLOW_CALL_TEXT_MAX - 1) + '😀',
    }]);
    await steps.setWaiting(flow.id, flow.features[0].id, { jobId: 'j1', questions: [question] });
    const stored = await repo.findById(flow.id);
    expect(stored?.state).toBe('WAITING_ANSWER');
    expect(stored?.features[0]).toMatchObject({
      state: 'WAITING_ANSWER', questionsJobId: 'j1', questions: [question],
    });
    const [row] = await prisma.$queryRaw<Array<{ questions: string }>>`
      SELECT "questions"::text AS questions FROM "FleetFlowFeature" WHERE "id" = ${flow.features[0].id}`;
    expect(row?.questions).not.toContain('\\ud83d');
  });
});
