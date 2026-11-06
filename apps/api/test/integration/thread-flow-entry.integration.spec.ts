import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import type { PrismaClient } from '../../src/generated/prisma/client';
import { grantKeys } from '../../src/approvals/test-helpers/approval-fixtures';
import { PermissionCache } from '../../src/permissions/permission-cache';
import { fixtureDb } from '../helpers/action-context';
import { insertRunner, rosterFleetAgent, seedFleetHttpAgent, seedFleetHttpWorld, type FleetHttpWorld } from '../helpers/fleet-fixtures';
import { bootHttpApp, data } from '../helpers/http-app';
import { resetDb } from '../helpers/reset-db';
import { canRunDbTests } from '../helpers/test-environment';

const describeDb = canRunDbTests() ? describe : describe.skip;
const input = { features: [{ feature: 'flow-x', specPath: '.nax/features/flow-x/spec.md' }], roles: { reviewer: 'acp:claude', supervisor: 'native:fast' }, costCapUsd: 25 };

describeDb('thread fleet flow entry endpoint', () => {
  let app: NathApplication;
  let db: PrismaClient;
  let world: FleetHttpWorld;
  let threadId: string;
  let runnerId: string;
  let agent: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  let slug = 'web';
  let previousThreadsEnabled: string | undefined;

  beforeAll(async () => {
    previousThreadsEnabled = process.env.FLEET_THREADS_ENABLED;
    process.env.FLEET_THREADS_ENABLED = 'true';
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(app.getHttpServer(), db);
    await grantKeys(db, { type: 'USER', id: world.ids.dev }, ['fleet.flow.create'], world.projectId);
    agent = await seedFleetHttpAgent(app.getHttpServer(), world.tokens.root);
    await rosterFleetAgent(db, agent.id, world.projectId);
    await grantKeys(db, { type: 'AGENT', id: agent.id }, ['fleet.flow.create'], world.projectId);
    await app.get(PermissionCache).invalidate();
    const runner = await insertRunner(db);
    runnerId = runner.id;
    const thread = await db.chatThread.create({ data: {
      projectId: world.projectId, repoId: world.repoId, title: 'published flow thread',
      createdById: world.ids.dev, createdByType: 'USER', backend: {}, skills: [], baseRef: 'trunk',
      feature: 'flow-x', specPath: '.nax/features/flow-x/spec.md', runnerId: runner.id,
      specPublished: true, publishedSha: 'a'.repeat(40),
    } });
    threadId = thread.id;
  }, 60_000);

  afterAll(async () => {
    try { await app?.close(); }
    finally {
      if (previousThreadsEnabled === undefined) delete process.env.FLEET_THREADS_ENABLED;
      else process.env.FLEET_THREADS_ENABLED = previousThreadsEnabled;
    }
  });

  const post = (id = threadId, token = world.tokens.dev, slugValue = slug, body = input) =>
    request(app.getHttpServer()).post(`/api/projects/${slugValue}/threads/${id}/flows`).set({ Authorization: `Bearer ${token}` }).send(body);

  beforeEach(async () => {
    await db.chatThread.update({ where: { id: threadId }, data: { kind: 'REPO', status: 'ACTIVE', repoId: world.repoId, feature: 'flow-x', specPath: '.nax/features/flow-x/spec.md', runnerId, specPublished: true, publishedSha: 'a'.repeat(40), preApproval: null } });
    await db.approvalDecision.deleteMany();
    await db.approvalRequest.deleteMany();
    await db.fleetFlowFeature.deleteMany();
    await db.fleetFlow.deleteMany();
  });

  it('AC-1/13: creates a thread-entry flow from the locked publish record and returns its URL', async () => {
    const response = await request(app.getHttpServer()).post(`/api/projects/${slug}/threads/${threadId}/flows`)
      .set({ Authorization: `Bearer ${world.tokens.dev}` }).send(input).expect(201);
    const flow = data<{ id: string; entry: string; branch: string; specSha: string; pinnedRunnerId: string; threadId: string; state: string; url: string }>(response);
    expect(flow).toMatchObject({ entry: 'THREAD', branch: 'feat/flow-x', specSha: 'a'.repeat(40), threadId, state: 'PENDING', url: `/web/flows/${flow.id}` });
    expect(flow.pinnedRunnerId).toBeTruthy();
  });

  it('AC-3/4/5/15: maps unpublished, non-repository, archived and runnerless threads to conflicts', async () => {
    await db.chatThread.update({ where: { id: threadId }, data: { specPublished: false } });
    await post().expect(409);
    await db.chatThread.update({ where: { id: threadId }, data: { specPublished: true, kind: 'PROJECT', repoId: null, feature: null } });
    await post().expect(409);
    await db.chatThread.update({ where: { id: threadId }, data: { kind: 'REPO', repoId: world.repoId, feature: 'flow-x', status: 'ARCHIVED' } });
    await post().expect(409);
    await db.chatThread.update({ where: { id: threadId }, data: { status: 'ACTIVE', runnerId: null } });
    await post().expect(409);
  });

  it('AC-8/9/14: rejects a live duplicate, missing permission and missing thread', async () => {
    await post().expect(201);
    await post().expect(409);
    await post(threadId, world.tokens.viewer).expect(403);
    await post('missing-thread-id').expect(404);
  });

  it('AC-11: consumes a covering thread tick and creates an approved flow', async () => {
    await db.chatThread.update({ where: { id: threadId }, data: { preApproval: { userId: world.ids.dev, at: new Date().toISOString(), costCapUsd: '40' } } });
    const response = await post().expect(201);
    const flow = data<{ id: string; state: string; approval: { mode: string } }>(response);
    expect(flow).toMatchObject({ state: 'APPROVED', approval: { mode: 'PRE_APPROVED' } });
    expect((await db.chatThread.findUniqueOrThrow({ where: { id: threadId } })).preApproval).toBeNull();
  });

  it('F2: rejects an invalid agent request before the approval gate stores it', async () => {
    const before = await db.approvalRequest.count();
    await post(threadId, agent.apiKey, slug, { ...input, features: [] }).expect(400);
    expect(await db.approvalRequest.count()).toBe(before);
  });

  it('AC-10: rejects zero features before opening a request or writing a flow', async () => {
    const before = await db.approvalRequest.count();
    await request(app.getHttpServer()).post(`/api/projects/${slug}/threads/${threadId}/flows`)
      .set({ Authorization: `Bearer ${world.tokens.dev}` }).send({ ...input, features: [] }).expect(400);
    expect(await db.approvalRequest.count()).toBe(before);
    expect(await db.fleetFlow.count()).toBe(0);
  });
});
