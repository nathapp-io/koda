import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NathApplication } from '@nathapp/nestjs-app';
import type { PrismaClient } from '../../src/generated/prisma/client';
import { ConflictAppException } from '../../src/common/exceptions/conflict-app.exception';
import { ApprovalAskService } from '../../src/approvals/approval-ask.service';
import { FleetFlowsService, type CreateFlowInput, type FlowCreator } from '../../src/fleet/flows/fleet-flows.service';
import { FleetReposService } from '../../src/fleet/repos/fleet-repos.service';
import { ThreadsService } from '../../src/fleet/threads/threads.service';
import type { ChatThreadRecord } from '../../src/fleet/threads/domain/chat-thread.domain';
import { fixtureDb, withTestActor } from '../helpers/action-context';
import { insertRunner, seedFleetBase } from '../helpers/fleet-fixtures';
import { bootHttpApp } from '../helpers/http-app';
import { resetDb } from '../helpers/reset-db';
import { canRunDbTests } from '../helpers/test-environment';

const describeDb = canRunDbTests() ? describe : describe.skip;
const SHA = 'c'.repeat(40);
const OTHER_SHA = 'd'.repeat(40);
const FEATURES = [
  { feature: 'flow-a', specPath: '.nax/features/flow-a/spec.md', dependsOn: [] },
  { feature: 'flow-b', specPath: '.nax/features/flow-b/spec.md', dependsOn: ['flow-a'] },
];
const ROLES = { reviewer: 'acp:claude', supervisor: 'native:fast' };

describeDb('FleetFlowsService.create', () => {
  let app: NathApplication;
  let db: PrismaClient;
  let service: FleetFlowsService;
  let repos: FleetReposService;
  let projectId: string;
  let repoId: string;
  let runnerId: string;
  let previousThreadsEnabled: string | undefined;
  let sequence = 0;

  const thread = async (overrides: Record<string, unknown> = {}) => db.chatThread.create({
    data: {
      projectId, repoId, title: 'flow thread', createdById: 'thread-owner', createdByType: 'USER',
      backend: {}, skills: [], baseRef: 'main', feature: `flow-feature-${++sequence}`,
      specPath: `.nax/features/flow-feature-${sequence}/spec.md`, runnerId,
      specPublished: true, publishedSha: SHA, preApproval: undefined, ...overrides,
    },
  });

  const threadInput = (threadId: string, overrides: Partial<CreateFlowInput> = {}): CreateFlowInput => ({
    entry: 'THREAD', threadId, features: FEATURES, roles: ROLES, costCapUsd: '25', ...overrides,
  });
  const naxInput = (overrides: Partial<CreateFlowInput> = {}): CreateFlowInput => ({
    entry: 'NAX', repoId, branch: 'feat/flow', specSha: SHA, features: FEATURES, roles: ROLES, costCapUsd: '25', ...overrides,
  });
  const create = (creator: FlowCreator, input: CreateFlowInput) =>
    withTestActor(creator, () => service.create(input, creator, { projectId }));

  const user = (id: string): FlowCreator => ({ type: 'USER', id });
  const startedRequests = () => db.approvalRequest.findMany({ where: { permissionKey: 'fleet.flow.start' } });

  beforeAll(async () => {
    previousThreadsEnabled = process.env.FLEET_THREADS_ENABLED;
    process.env.FLEET_THREADS_ENABLED = 'true';
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    db = fixtureDb(app);
    ({ projectId, repoId } = await seedFleetBase(db));
    runnerId = (await insertRunner(db)).id;
    service = app.get(FleetFlowsService, { strict: false });
    repos = app.get(FleetReposService, { strict: false });
  }, 60_000);

  afterAll(async () => {
    try { await app?.close(); }
    finally {
      if (previousThreadsEnabled === undefined) delete process.env.FLEET_THREADS_ENABLED;
      else process.env.FLEET_THREADS_ENABLED = previousThreadsEnabled;
    }
  });

  beforeEach(async () => {
    await db.approvalDecision.deleteMany();
    await db.approvalRequest.deleteMany();
    await db.fleetFlowFeature.deleteMany();
    await db.fleetFlow.deleteMany();
    await db.auditEntry.deleteMany({ where: { key: 'fleet.flow.create' } });
    await db.fleetActivity.deleteMany({ where: { entityType: 'flow' } });
  });
  /**
   * Spies are restored one by one: `vi.restoreAllMocks()` would also undo `test-setup.ts`'s no-op
   * `Logger.prototype` spies, which the next file in this shared (isolate: false) DB worker relies on.
   */
  const spies: Array<{ mockRestore: () => void }> = [];
  const spyOn = <T extends { mockRestore: () => void }>(spy: T): T => { spies.push(spy); return spy; };
  afterEach(() => { for (const spy of spies.splice(0)) spy.mockRestore(); });

  it('AC-1: a USER creator with no tick writes a PENDING flow and opens the start ask', async () => {
    const row = await thread();
    const { flow } = await create(user('flow-author'), threadInput(row.id));

    expect(flow.state).toBe('PENDING');
    expect(flow.approvalMode).toBeNull();
    const requests = await startedRequests();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      permissionKey: 'fleet.flow.start', projectId, actorType: 'SYSTEM', actorId: 'flow', origin: 'system',
      onBehalfOfType: 'USER', onBehalfOfId: 'flow-author', requiredMode: 'human', status: 'pending',
      input: { flowId: flow.id, specSha: SHA },
    });
  });

  it('AC-2: the request id create opened is stored as the flow approvalRequestId', async () => {
    const row = await thread();
    const { flow, approvalRequestId } = await create(user('flow-author'), threadInput(row.id));

    const [request] = await startedRequests();
    expect(approvalRequestId).toBe(request.id);
    expect(flow.approvalRequestId).toBe(request.id);
    expect((await db.fleetFlow.findUniqueOrThrow({ where: { id: flow.id } })).approvalRequestId).toBe(request.id);
  });

  it('AC-3: an AGENT creator opens the request on behalf of the agent', async () => {
    const row = await thread();
    const creator: FlowCreator = { type: 'AGENT', id: 'flow-agent' };
    const { flow } = await create(creator, threadInput(row.id));

    expect(flow.createdByType).toBe('AGENT');
    expect(await startedRequests()).toMatchObject([{ onBehalfOfType: 'AGENT', onBehalfOfId: 'flow-agent' }]);
  });

  it('AC-4: a thread entry takes branch, sha and runner from the record lockForFlow returned', async () => {
    const row = await thread({ feature: 'thread-entry', publishedSha: OTHER_SHA });
    const lock = spyOn(vi.spyOn(ThreadsService.prototype, 'lockForFlow'));
    const { flow } = await create(user('flow-author'), threadInput(row.id));

    expect(lock).toHaveBeenCalledTimes(1);
    expect(lock).toHaveBeenCalledWith(projectId, row.id);
    const locked = await (lock.mock.results[0]?.value as Promise<ChatThreadRecord>);
    // AC-11 contract: `publishedSha` is the thread's publish record, `runnerId` the pinned runner.
    expect(flow).toMatchObject({
      entry: 'THREAD', threadId: row.id, repoId,
      branch: `feat/${locked.feature}`, specSha: locked.publishedSha, pinnedRunnerId: locked.runnerId,
    });
    expect(flow).toMatchObject({ branch: 'feat/thread-entry', specSha: OTHER_SHA, pinnedRunnerId: runnerId });
  });

  it("AC-5: a covering tick is consumed for the tick's own user and starts the flow APPROVED", async () => {
    const row = await thread({ preApproval: { userId: 'flow-author', at: '2026-11-01T00:00:00.000Z', costCapUsd: '40' } });
    const { flow } = await create(user('flow-author'), threadInput(row.id, { costCapUsd: '25' }));

    expect(flow).toMatchObject({ state: 'APPROVED', approvalMode: 'PRE_APPROVED', approverId: 'flow-author', approvalRequestId: null });
    expect(flow.approvedAt).toBeInstanceOf(Date);
    expect(await startedRequests()).toHaveLength(0);
    expect((await db.chatThread.findUniqueOrThrow({ where: { id: row.id } })).preApproval).toBeNull();
    expect(flow.spentUsd).toBe('0.0000');
    expect((await db.fleetFlow.findUniqueOrThrow({ where: { id: flow.id } })).state).toBe('APPROVED');
  });

  it("AC-6: a tick covers the thread's creator too", async () => {
    const row = await thread({
      createdById: 'flow-author', createdByType: 'USER',
      preApproval: { userId: 'someone-else', at: '2026-11-01T00:00:00.000Z', costCapUsd: '40' },
    });
    const { flow } = await create(user('flow-author'), threadInput(row.id));

    expect(flow).toMatchObject({ state: 'APPROVED', approvalMode: 'PRE_APPROVED', approverId: 'someone-else' });
  });

  it('AC-7: a creator the tick does not cover is PENDING and leaves the tick in place', async () => {
    const tick = { userId: 'someone-else', at: '2026-11-01T00:00:00.000Z', costCapUsd: '40' };
    const row = await thread({ createdById: 'thread-owner', preApproval: tick });
    const { flow } = await create(user('flow-author'), threadInput(row.id));

    expect(flow.state).toBe('PENDING');
    expect(await startedRequests()).toHaveLength(1);
    expect((await db.chatThread.findUniqueOrThrow({ where: { id: row.id } })).preApproval).toEqual(tick);
  });

  it('AC-8: a tick below the flow cap does not cover it', async () => {
    const tick = { userId: 'flow-author', at: '2026-11-01T00:00:00.000Z', costCapUsd: '9.5' };
    const row = await thread({ preApproval: tick });
    const { flow } = await create(user('flow-author'), threadInput(row.id, { costCapUsd: '10' }));

    expect(flow.state).toBe('PENDING');
    expect(await startedRequests()).toHaveLength(1);
    expect((await db.chatThread.findUniqueOrThrow({ where: { id: row.id } })).preApproval).toEqual(tick);
  });

  it('AC-9: concurrent creates for one thread produce one flow and one threadBusy conflict', async () => {
    const row = await thread();
    const results = await Promise.allSettled([
      create(user('flow-author'), threadInput(row.id)),
      create(user('flow-author'), threadInput(row.id)),
    ]);

    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(ConflictAppException);
    expect((rejected[0].reason as ConflictAppException).prefix).toBe('fleet.flows.threadBusy');
    expect(await db.fleetFlow.count({ where: { threadId: row.id } })).toBe(1);
  });

  it('AC-10: a thread whose earlier flow is STOPPED takes a new flow', async () => {
    const row = await thread();
    const first = await create(user('flow-author'), threadInput(row.id));
    await db.fleetFlow.update({ where: { id: first.flow.id }, data: { state: 'STOPPED', stopReason: 'manual', endedAt: new Date() } });

    const second = await create(user('flow-author'), threadInput(row.id));

    expect(second.flow.id).not.toBe(first.flow.id);
    expect((await db.fleetFlow.findUniqueOrThrow({ where: { id: first.flow.id } })).state).toBe('STOPPED');
    expect(await db.fleetFlow.count({ where: { threadId: row.id } })).toBe(2);
  });

  it('AC-11: a nax entry with a live duplicate conflicts and names the existing flow', async () => {
    const first = await create(user('flow-author'), naxInput());

    const error = await create(user('flow-author'), naxInput()).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ConflictAppException);
    expect((error as ConflictAppException).prefix).toBe('fleet.flows.duplicate');
    expect((error as ConflictAppException).args).toMatchObject({ flowId: first.flow.id });
    expect(await db.fleetFlow.count({ where: { repoId, branch: 'feat/flow', specSha: SHA } })).toBe(1);
  });

  it('AC-12: concurrent nax creates produce one flow and one duplicate conflict', async () => {
    const results = await Promise.allSettled([
      create(user('flow-author'), naxInput()),
      create(user('flow-author'), naxInput()),
    ]);

    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect((rejected[0].reason as ConflictAppException).prefix).toBe('fleet.flows.duplicate');
    expect(await db.fleetFlow.count({ where: { repoId, branch: 'feat/flow', specSha: SHA } })).toBe(1);
  });

  it('AC-13: create audits fleet.flow.create against the flow', async () => {
    const row = await thread();
    const { flow } = await create(user('flow-author'), threadInput(row.id));

    expect(await db.auditEntry.findMany({ where: { key: 'fleet.flow.create', resourceId: flow.id } }))
      .toMatchObject([{ key: 'fleet.flow.create', resourceType: 'flow', resourceId: flow.id, projectId }]);
  });

  it('AC-14: create records flow.created activity with the flow payload', async () => {
    const row = await thread();
    const { flow } = await create(user('flow-author'), threadInput(row.id));

    expect(await db.fleetActivity.findMany({ where: { action: 'flow.created', entityId: flow.id } })).toMatchObject([{
      actorType: 'USER', actorId: 'flow-author', action: 'flow.created', entityType: 'flow', entityId: flow.id,
      projectId, payload: { flowId: flow.id, entry: 'THREAD', featureCount: FEATURES.length, state: 'PENDING' },
    }]);
  });

  it('AC-15: a failing ask leaves no flow or feature row behind', async () => {
    const row = await thread();
    const ask = spyOn(vi.spyOn(ApprovalAskService.prototype, 'open')).mockRejectedValue(new Error('ask exploded'));

    await expect(create(user('flow-author'), threadInput(row.id))).rejects.toThrow('ask exploded');

    expect(ask).toHaveBeenCalledTimes(1);
    expect(await db.fleetFlow.count()).toBe(0);
    expect(await db.fleetFlowFeature.count()).toBe(0);
  });

  it('stores the features in position order, PENDING, with their dependencies', async () => {
    const row = await thread();
    const { flow } = await create(user('flow-author'), threadInput(row.id));

    expect(flow.features).toMatchObject([
      { feature: 'flow-a', specPath: '.nax/features/flow-a/spec.md', dependsOn: [], state: 'PENDING', currentStep: null, prNumber: null },
      { feature: 'flow-b', specPath: '.nax/features/flow-b/spec.md', dependsOn: ['flow-a'], state: 'PENDING', currentStep: null, prNumber: null },
    ]);
  });

  it('findByIdentity matches the repo owner and name case-insensitively, and lockById locks it', async () => {
    const repo = await db.fleetRepo.findUniqueOrThrow({ where: { id: repoId } });

    const found = await repos.findByIdentity('github', repo.owner.toUpperCase(), repo.name.toUpperCase());
    expect(found).toMatchObject({ id: repoId, projectId });
    expect(await repos.findByIdentity('gitlab', repo.owner, repo.name)).toBeNull();

    expect(await repos.lockById(repoId)).toMatchObject({ id: repoId, projectId });
    expect(await repos.lockById('missing-repo')).toBeNull();
  });
});
