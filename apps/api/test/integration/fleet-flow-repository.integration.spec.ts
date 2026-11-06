import { canRunDbTests } from '../helpers/test-environment';
import { resetDb } from '../helpers/reset-db';
import { createTestPrismaClient } from '../helpers/test-prisma';
import type { PrismaClient } from '../../src/generated/prisma/client';
import { seedFleetBase } from '../helpers/fleet-fixtures';
import { PrismaFleetFlowRepository } from '../../src/fleet/flows/prisma-fleet-flow.repository';
import { FlowTransitionError } from '../../src/fleet/flows/domain/fleet-flow.domain';

const describeDb = canRunDbTests() ? describe : describe.skip;
const tx = { run: (fn: () => Promise<unknown>) => fn() };

describeDb('PrismaFleetFlowRepository', () => {
  let prisma: PrismaClient;
  let repo: PrismaFleetFlowRepository;
  let projectId: string;
  let repoId: string;

  beforeAll(async () => {
    await resetDb();
    prisma = createTestPrismaClient();
    ({ projectId, repoId } = await seedFleetBase(prisma));
    repo = new PrismaFleetFlowRepository(tx as never, { client: prisma } as never);
  }, 60_000);
  afterAll(async () => { await prisma?.$disconnect(); });

  async function createFlow(overrides: Partial<Parameters<PrismaFleetFlowRepository['create']>[0]> = {}) {
    return repo.create({
      projectId, repoId, entry: 'NAX', createdByType: 'USER', createdById: 'creator',
      branch: 'main', specSha: 'sha-1', reviewerRole: 'reviewer', supervisorRole: 'supervisor', costCapUsd: '4.25',
      features: [], ...overrides,
    });
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
  it('AC-10 stops a flow with reason and end time', async () => {
    const flow = await createFlow(); const now = new Date();
    expect(await repo.stop(flow.id, 'human_stop', now)).toMatchObject({ state: 'STOPPED', stopReason: 'human_stop', endedAt: now });
  });
  it('AC-11 rejects stopping a terminal flow without mutation', async () => {
    const flow = await createFlow(); const stopped = await repo.stop(flow.id, 'human_stop', new Date());
    await expect(repo.stop(flow.id, 'human_stop', new Date())).rejects.toBeInstanceOf(FlowTransitionError);
    expect(await repo.findById(flow.id)).toEqual(stopped);
  });
  it('AC-12 pages project flows newest first and filters other projects', async () => {
    const older = await createFlow(); await new Promise((resolve) => setTimeout(resolve, 5)); const newer = await createFlow();
    const page = await repo.findPage({ projectId }, { current: 1, size: 20 } as never);
    expect(page.records.map(({ id }) => id)).toEqual(expect.arrayContaining([older.id, newer.id]));
    expect(page.records.findIndex(({ id }) => id === newer.id)).toBeLessThan(page.records.findIndex(({ id }) => id === older.id));
    expect(page.records.every(({ projectId: id }) => id === projectId)).toBe(true);
  });
  it('AC-13 cascades repo deletion to flows and features', async () => {
    const flow = await createFlow({ features: [{ feature: 'a', specPath: 'a/spec.md', dependsOn: [] }] });
    await prisma.fleetRepo.delete({ where: { id: repoId } });
    expect(await prisma.fleetFlow.findUnique({ where: { id: flow.id } })).toBeNull();
    expect(await prisma.fleetFlowFeature.count({ where: { flowId: flow.id } })).toBe(0);
  });
});
