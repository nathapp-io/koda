import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import type { PrismaClient } from '../../src/generated/prisma/client';
import { grantKeys, seedWaitPolicy } from '../../src/approvals/test-helpers/approval-fixtures';
import { FLEET_CFG, type IFleetConfig } from '../../src/config/fleet.config';
import type { FleetFlowDto } from '../../src/fleet/flows/dto/fleet-flow.dto';
import { FleetFlowsService, type CreatedFlow } from '../../src/fleet/flows/fleet-flows.service';
import { PermissionCache } from '../../src/permissions/permission-cache';
import { fixtureDb } from '../helpers/action-context';
import { insertRunner, rosterFleetAgent, seedFleetHttpAgent, seedFleetHttpWorld, type FleetHttpWorld } from '../helpers/fleet-fixtures';
import { bootHttpApp, data, resetThrottle } from '../helpers/http-app';
import { resetDb } from '../helpers/reset-db';
import { canRunDbTests } from '../helpers/test-environment';

const describeDb = canRunDbTests() ? describe : describe.skip;
const sha = 'a'.repeat(40);
const slug = 'web';
const input = { features: [{ feature: 'flow-x', specPath: '.nax/features/flow-x/spec.md' }], roles: { reviewer: 'acp:claude', supervisor: 'native:fast' }, costCapUsd: 25 };
const parsedFeatures = [{ ...input.features[0], dependsOn: [] }];

// The HTTP envelope exposes the translated message, not the key. Resolve the exact key (including
// exception code) rather than accepting a substring or any response with the same status.
function refusal(response: request.Response, key: string, args: Record<string, string> = {}): void {
  const [namespace, ...segments] = key.split('.');
  const catalog: unknown = JSON.parse(readFileSync(join(__dirname, '../../src/i18n/en', `${namespace}.json`), 'utf8'));
  const sentence = segments.reduce<unknown>((node, segment) =>
    typeof node === 'object' && node !== null ? (node as Record<string, unknown>)[segment] : undefined, catalog);
  expect(typeof sentence).toBe('string');
  expect(response.body).toEqual({
    ret: Number(segments.at(-1)),
    message: String(sentence).replace(/\{(\w+)\}/g, (placeholder, name: string) => args[name] ?? placeholder),
  });
}

describeDb('thread fleet flow entry endpoint', () => {
  let app: NathApplication;
  let db: PrismaClient;
  let world: FleetHttpWorld;
  let threadId: string;
  let runnerId: string;
  let foreignThreadId: string;
  let agent: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  const config = () => app.get<IFleetConfig>(FLEET_CFG);

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null });
    config().threadsEnabled = true;
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(app.getHttpServer(), db);
    await grantKeys(db, { type: 'USER', id: world.ids.dev }, ['fleet.flow.create'], world.projectId);
    agent = await seedFleetHttpAgent(app.getHttpServer(), world.tokens.root);
    await rosterFleetAgent(db, agent.id, world.projectId);
    await grantKeys(db, { type: 'AGENT', id: agent.id }, ['fleet.flow.create'], world.projectId);
    await app.get(PermissionCache).invalidate();
    runnerId = (await insertRunner(db)).id;
    threadId = (await db.chatThread.create({ data: {
      projectId: world.projectId, repoId: world.repoId, title: 'published flow thread',
      createdById: world.ids.dev, createdByType: 'USER', backend: {}, skills: [], baseRef: 'trunk',
      feature: 'flow-x', specPath: input.features[0].specPath, runnerId,
      specPublished: true, publishedSha: sha,
    } })).id;
    foreignThreadId = (await db.chatThread.create({ data: {
      projectId: world.opsProjectId, repoId: world.foreignRepoId, title: 'foreign thread',
      createdById: world.ids.dev, createdByType: 'USER', backend: {}, skills: [], baseRef: 'main',
      feature: 'foreign-flow', specPath: 'docs/spec.md', runnerId, specPublished: true, publishedSha: sha,
    } })).id;
  }, 60_000);

  afterAll(async () => { await app?.close(); });

  const post = (id = threadId, token = world.tokens.dev, body = input) =>
    request(app.getHttpServer()).post(`/api/projects/${slug}/threads/${id}/flows`).set({ Authorization: `Bearer ${token}` }).send(body);

  beforeEach(async () => {
    resetThrottle(app);
    await db.chatThread.update({ where: { id: threadId }, data: { kind: 'REPO', status: 'ACTIVE', repoId: world.repoId, feature: 'flow-x', specPath: input.features[0].specPath, runnerId, specPublished: true, publishedSha: sha, preApproval: null } });
    await db.approvalDecision.deleteMany();
    await db.approvalRequest.deleteMany();
    await db.fleetFlowFeature.deleteMany();
    await db.fleetFlow.deleteMany();
    await db.fleetActivity.deleteMany({ where: { entityType: 'flow' } });
    await db.auditEntry.deleteMany({ where: { key: { in: ['fleet.flow.create', 'fleet.flow.start'] } } });
  });

  async function expectNoFlowWrites() {
    expect(await db.fleetFlow.count()).toBe(0);
    expect(await db.fleetFlowFeature.count()).toBe(0);
    expect(await db.approvalRequest.count()).toBe(0);
    expect(await db.fleetActivity.count({ where: { entityType: 'flow' } })).toBe(0);
    expect(await db.auditEntry.count({ where: { key: 'fleet.flow.create' } })).toBe(0);
  }

  async function expectPendingFlow(id: string, creator: { type: 'USER' | 'AGENT'; id: string }, target = { branch: 'feat/flow-x', specSha: sha, pinnedRunnerId: runnerId }) {
    const row = await db.fleetFlow.findUniqueOrThrow({ where: { id }, include: { features: { orderBy: { position: 'asc' } } } });
    expect(row).toMatchObject({ projectId: world.projectId, repoId: world.repoId, threadId, entry: 'THREAD',
      ...target, createdByType: creator.type, createdById: creator.id, state: 'PENDING', approvalMode: null,
      approverId: null, approvedAt: null, endedAt: null, reviewerRole: input.roles.reviewer, supervisorRole: input.roles.supervisor });
    expect(row.costCapUsd.toString()).toBe('25');
    expect(row.features).toMatchObject([{ ...parsedFeatures[0], position: 0, state: 'PENDING' }]);
    expect(row.features).toHaveLength(1);
    if (row.approvalRequestId === null) throw new Error('PENDING flow must persist its start approval request id');
    const ask = await db.approvalRequest.findUniqueOrThrow({ where: { id: row.approvalRequestId } });
    expect(ask).toMatchObject({ permissionKey: 'fleet.flow.start', projectId: world.projectId, status: 'pending', requiredMode: 'human',
      onBehalfOfType: creator.type, onBehalfOfId: creator.id, input: { flowId: id, specSha: target.specSha } });
    expect(await db.fleetActivity.findMany({ where: { action: 'flow.created', entityId: id } }))
      .toMatchObject([{ actorType: creator.type, actorId: creator.id, entityType: 'flow', projectId: world.projectId }]);
    expect(await db.auditEntry.findMany({ where: { key: 'fleet.flow.create', resourceId: id } }))
      .toMatchObject([{ resourceType: 'flow', projectId: world.projectId }]);
    return row;
  }

  it('AC-1/13: returns and persists the exact locked publish record, creator, features and start request', async () => {
    const flow = data<FleetFlowDto>(await post().expect(201));
    const row = await expectPendingFlow(flow.id, { type: 'USER', id: world.ids.dev });
    expect(flow).toMatchObject({ entry: 'THREAD', projectId: world.projectId, repoId: world.repoId,
      branch: 'feat/flow-x', specSha: sha, pinnedRunnerId: runnerId, threadId, state: 'PENDING',
      createdBy: { type: 'USER', id: world.ids.dev }, roles: input.roles, costCapUsd: '25.0000',
      features: parsedFeatures, url: `/${slug}/flows/${flow.id}`,
      approval: { mode: 'REQUEST', approvalRequestId: row.approvalRequestId, approverId: null, approvedAt: null } });
    expect(await db.fleetFlow.count()).toBe(1);
    expect(await db.approvalRequest.count()).toBe(1);
  });

  it('AC-2: the HTTP route calls the stubbed create once with pinned ids and parsed features, roles, cap and caller', async () => {
    const now = new Date();
    const result: CreatedFlow = { approvalRequestId: null, flow: {
      id: 'stub-flow', projectId: world.projectId, repoId: world.repoId, threadId, entry: 'THREAD',
      createdByType: 'USER', createdById: world.ids.dev, branch: 'feat/flow-x', specSha: sha, pinnedRunnerId: runnerId,
      reviewerRole: input.roles.reviewer, supervisorRole: input.roles.supervisor, costCapUsd: '25', spentUsd: '0',
      state: 'PENDING', approvalMode: null, approverId: null, approvedAt: null, approvalRequestId: null,
      stopReason: null, endedAt: null, createdAt: now, updatedAt: now, features: [],
    } };
    const create = vi.spyOn(app.get(FleetFlowsService), 'create').mockResolvedValue(result);
    try {
      // Caller-supplied route/identity fields must not override the route's project or principal.
      const body = { ...input, projectId: world.opsProjectId, threadId: foreignThreadId, createdBy: { type: 'USER', id: world.ids.root } };
      const response = await post(threadId, world.tokens.dev, body).expect(201);
      expect(data<FleetFlowDto>(response).id).toBe('stub-flow');
      expect(create).toHaveBeenCalledOnce();
      expect(create).toHaveBeenCalledWith({ entry: 'THREAD', threadId, features: parsedFeatures, roles: input.roles, costCapUsd: '25' },
        { type: 'USER', id: world.ids.dev }, { projectId: world.projectId });
      await expectNoFlowWrites();
    } finally { create.mockRestore(); }
  });

  it.each([
    ['AC-3', { specPublished: false }, 'threads.notPublished.409'],
    ['AC-4', { kind: 'PROJECT', repoId: null, feature: null }, 'threads.notRepoThread.409'],
    ['AC-5', { status: 'ARCHIVED' }, 'threads.archived.409'],
    ['AC-15', { runnerId: null }, 'threads.runnerMissing.409'],
  ])('%s: refuses an ineligible thread with the exact key and no writes', async (_ac, update, key) => {
    await db.chatThread.update({ where: { id: threadId }, data: update });
    refusal(await post().expect(409), key);
    await expectNoFlowWrites();
  });

  it('AC-6: disabled config refuses with threads.disabled and writes nothing', async () => {
    const previous = config().threadsEnabled;
    config().threadsEnabled = false;
    try {
      refusal(await post().expect(409), 'threads.disabled.409');
      await expectNoFlowWrites();
    } finally { config().threadsEnabled = previous; }
  });

  it.each(['foreign', 'nonexistent'])('AC-7/14: hides a %s thread as threads.notFound and writes nothing', async (which) => {
    refusal(await post(which === 'foreign' ? foreignThreadId : 'missing-thread-id').expect(404), 'threads.notFound.404');
    await expectNoFlowWrites();
  });

  it('AC-8: a PENDING flow conflicts with fleet.flows.threadBusy without a second flow or request', async () => {
    const first = data<FleetFlowDto>(await post().expect(201));
    refusal(await post().expect(409), 'fleet.flows.threadBusy.409');
    expect(await db.fleetFlow.findMany()).toMatchObject([{ id: first.id, state: 'PENDING' }]);
    expect(await db.fleetFlow.count()).toBe(1);
    expect(await db.fleetFlowFeature.count()).toBe(1);
    expect(await db.approvalRequest.count()).toBe(1);
    expect(await db.fleetActivity.count({ where: { action: 'flow.created' } })).toBe(1);
  });

  it('AC-9: a project viewer without fleet.flow.create is refused before any writes', async () => {
    refusal(await post(threadId, world.tokens.viewer).expect(403), 'permissions.40003');
    await expectNoFlowWrites();
  });

  it('AC-11: consumes a covering tick and persists PRE_APPROVED without a start request', async () => {
    await db.chatThread.update({ where: { id: threadId }, data: { preApproval: { userId: world.ids.dev, at: new Date().toISOString(), costCapUsd: '40' } } });
    const flow = data<FleetFlowDto>(await post().expect(201));
    expect(flow).toMatchObject({ state: 'APPROVED', approval: { mode: 'PRE_APPROVED', approverId: world.ids.dev, approvedAt: expect.any(String), approvalRequestId: null } });
    expect(await db.fleetFlow.findUniqueOrThrow({ where: { id: flow.id } })).toMatchObject({
      state: 'APPROVED', approvalMode: 'PRE_APPROVED', approverId: world.ids.dev, approvedAt: expect.any(Date), approvalRequestId: null,
      pinnedRunnerId: runnerId, specSha: sha, threadId,
    });
    expect((await db.chatThread.findUniqueOrThrow({ where: { id: threadId } })).preApproval).toBeNull();
    expect(await db.approvalRequest.count()).toBe(0);
  });

  it('AC-12: agent create approval executes against the latest thread record as the requester, then opens a separate start request', async () => {
    const policy = await seedWaitPolicy(db, 'fleet.flow.create', world.projectId);
    const create = vi.spyOn(app.get(FleetFlowsService), 'create');
    try {
      const pending = data<{ id: string; status: string; permissionKey: string }>(await post(threadId, agent.apiKey).expect(202));
      expect(pending).toMatchObject({ status: 'pending', permissionKey: 'fleet.flow.create' });
      expect(create).not.toHaveBeenCalled();
      expect(await db.fleetFlow.count()).toBe(0);
      expect(await db.fleetFlowFeature.count()).toBe(0);
      expect(await db.approvalRequest.findUniqueOrThrow({ where: { id: pending.id } })).toMatchObject({
        actorType: 'AGENT', actorId: agent.id, projectId: world.projectId, requiredMode: 'agent',
        input: { projectId: world.projectId, threadId, body: { features: parsedFeatures, roles: input.roles, costCapUsd: '25' } },
      });
      const latest = { branch: 'feat/latest-flow', specSha: 'b'.repeat(40), pinnedRunnerId: (await insertRunner(db)).id };
      await db.chatThread.update({ where: { id: threadId }, data: { feature: 'latest-flow', publishedSha: latest.specSha, runnerId: latest.pinnedRunnerId } });
      const decision = await request(app.getHttpServer()).post(`/api/approvals/${pending.id}/decisions`)
        .set({ Authorization: `Bearer ${world.tokens.root}` }).send({ decision: 'approve' }).expect(200);
      expect(data<{ status: string }>(decision).status).toBe('executed');
      expect(create).toHaveBeenCalledOnce();
      expect(create).toHaveBeenCalledWith({ entry: 'THREAD', threadId, features: parsedFeatures, roles: input.roles, costCapUsd: '25' },
        { type: 'AGENT', id: agent.id }, { projectId: world.projectId });
      const flows = await db.fleetFlow.findMany();
      expect(flows).toHaveLength(1);
      const flow = await expectPendingFlow(flows[0].id, { type: 'AGENT', id: agent.id }, latest);
      expect(flow.approvalRequestId).not.toBe(pending.id);
      expect(await db.approvalRequest.count()).toBe(2);
      expect(await db.approvalRequest.findUniqueOrThrow({ where: { id: pending.id } })).toMatchObject({ status: 'executed' });
      expect(await db.approvalDecision.findMany({ where: { requestId: pending.id } })).toMatchObject([
        { decision: 'approve', deciderType: 'USER', deciderId: world.ids.root },
      ]);
    } finally {
      create.mockRestore();
      await db.approvalPolicy.delete({ where: { id: policy.id } });
    }
  });

  it.each(['USER', 'AGENT'])('AC-10/F2: invalid %s features are named and rejected before any flow or approval is stored', async (type) => {
    const response = await post(threadId, type === 'USER' ? world.tokens.dev : agent.apiKey, { ...input, features: [] }).expect(400);
    refusal(response, 'fleet.flowInput.-2', { reason: 'features' });
    await expectNoFlowWrites();
  });
});
