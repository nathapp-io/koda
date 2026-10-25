import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import type { PrismaClient } from '../../../src/generated/prisma/client';
import { FLEET_CFG, type IFleetConfig } from '../../../src/config/fleet.config';
import { canRunDbTests } from '../../helpers/test-environment';
import { bootHttpApp, data, resetThrottle } from '../../helpers/http-app';
import { fixtureDb } from '../../helpers/action-context';
import { FLEET_CAPS, seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { MembershipService } from '../../../src/permissions/membership.service';
import { PrismaChatThreadRepository } from '../../../src/fleet/threads/prisma-chat-thread.repository';
import { grantBaseline, grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';
import { resetDb } from '../../helpers/reset-db';

const describeDb = canRunDbTests() ? describe : describe.skip;
describeDb('fleet thread lifecycle audit HTTP', () => {
  let app: NathApplication;
  let db: PrismaClient;
  let world: FleetHttpWorld;
  let config: IFleetConfig;
  let seq = 0;
  const auth = () => ({ Authorization: `Bearer ${world.tokens.dev}` });
  const projectCreate = (title: string, feature: string) => request(app.getHttpServer())
    .post('/api/projects/web/threads').set(auth()).send({ repoId: world.repoId, feature, title, backend: { kind: 'native', model: 'm1' } });
  const entries = (key: string, resourceId: string) => db.auditEntry.findMany({ where: { key, resourceId }, take: 10 });
  const createWorkspace = () => request(app.getHttpServer()).post('/api/threads').set(auth()).send({ title: `workspace-${++seq}`, backend: { kind: 'native', model: 'm1' } });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false, ownerEmail: null });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(app.getHttpServer(), db);
    config = app.get<IFleetConfig>(FLEET_CFG, { strict: false });
    config.threadsEnabled = true;
  }, 60_000);
  beforeEach(() => resetThrottle(app));
  afterAll(async () => {
    if (config) config.threadsEnabled = false;
    await app?.close();
  });

  it('AC-2/3: audits project REPO creation without recording the title', async () => {
    const title = `secret-title-${++seq}`;
    const thread = data<{ id: string }>(await projectCreate(title, `audit-create-${seq}`).expect(201));
    const rows = await entries('thread.create', thread.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: 'thread.create', resourceType: 'thread', resourceId: thread.id, projectId: world.projectId, actorType: 'USER', actorId: world.ids.dev, summary: 'created REPO' });
    expect(rows[0]?.summary).not.toContain(title);
  });

  it('AC-4: the unique repo-feature loser returns 409 and creates no extra entry', async () => {
    const feature = `audit-duplicate-${++seq}`;
    const before = await db.auditEntry.count({ where: { key: 'thread.create', projectId: world.projectId } });
    const first = data<{ id: string }>(await projectCreate('first', feature).expect(201));
    await projectCreate('second-secret', feature).expect(409);
    expect(await entries('thread.create', first.id)).toHaveLength(1);
    expect(await db.auditEntry.count({ where: { key: 'thread.create', projectId: world.projectId } })).toBe(before + 1);
  });

  it('AC-14: concurrent repo-feature creates leave only the winner audited and translate the loser conflict', async () => {
    const feature = `audit-race-${++seq}`;
    const before = await db.auditEntry.count({ where: { key: 'thread.create', projectId: world.projectId } });
    const repository = app.get(PrismaChatThreadRepository, { strict: false });
    const create = repository.create.bind(repository);
    let release: (() => void) | undefined;
    const bothCreatesReachedRepository = new Promise<void>((resolve) => { release = resolve; });
    let arrivals = 0;
    const createSpy = vi.spyOn(repository, 'create').mockImplementation(async (input) => {
      arrivals += 1;
      if (arrivals === 2) release?.();
      await bothCreatesReachedRepository;
      return create(input);
    });
    let responses: request.Response[];
    try {
      responses = await Promise.all([
        projectCreate('race-first', feature),
        projectCreate('race-second', feature),
      ]);
    } finally {
      createSpy.mockRestore();
    }
    expect(arrivals).toBe(2);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    const winnerResponse = responses.find((response) => response.status === 201);
    const loserResponse = responses.find((response) => response.status === 409);
    expect(winnerResponse).toBeDefined();
    expect(loserResponse).toBeDefined();
    if (!winnerResponse || !loserResponse) throw new Error('Expected one winner and one repo-feature conflict');
    const winner = data<{ id: string }>(winnerResponse);
    expect(loserResponse.body.message).toBe(`An active thread already uses feature ${feature}`);
    expect(await entries('thread.create', winner.id)).toEqual([expect.objectContaining({ key: 'thread.create', resourceType: 'thread', projectId: world.projectId, summary: 'created REPO' })]);
    expect(await db.auditEntry.count({ where: { key: 'thread.create', projectId: world.projectId } })).toBe(before + 1);
  });

  it('AC-5: audits workspace creation against its home project', async () => {
    const thread = data<{ id: string; homeProject: { slug: string } }>(await createWorkspace().expect(201));
    const row = await entries('thread.workspace.create', thread.id);
    expect(row).toHaveLength(1);
    expect(row[0]).toMatchObject({ resourceType: 'thread', projectId: world.projectId, summary: 'created WORKSPACE' });
  });

  it('AC-6: attributes workspace creation to an agent with the required global role binding', async () => {
    const roleKey = `workspace-audit-${++seq}`;
    await db.role.create({ data: { key: roleKey, name: roleKey, description: '', scope: 'GLOBAL', system: false, locked: false, permissions: ['thread.workspace.create', 'thread.workspace.read.own', 'thread.workspace.message.send.own'] } });
    const createdAgent = data<{ apiKey: string; agent: { id: string } }>(await request(app.getHttpServer()).post('/api/agents').set({ Authorization: `Bearer ${world.tokens.root}` }).send({ name: roleKey, slug: roleKey }).expect(201));
    await grantBaseline(db, { type: 'AGENT', id: createdAgent.agent.id });
    await grantRole(db, { type: 'AGENT', id: createdAgent.agent.id }, 'developer', world.projectId);
    await grantRole(db, { type: 'AGENT', id: createdAgent.agent.id }, roleKey, null);
    await app.get(MembershipService).invalidatePermissions();
    const result = data<{ id: string }>(await request(app.getHttpServer()).post('/api/threads').set({ Authorization: `Bearer ${createdAgent.apiKey}` }).send({ title: 'agent-workspace', backend: { kind: 'native', model: 'm1' } }).expect(201));
    expect(await entries('thread.workspace.create', result.id)).toEqual([expect.objectContaining({ actorType: 'AGENT', actorId: createdAgent.agent.id, projectId: world.projectId, summary: 'created WORKSPACE' })]);
  });

  it('AC-7/8/9: audits project cap and one archive, but not repeated archive', async () => {
    const thread = data<{ id: string }>(await projectCreate(`lifecycle-${++seq}`, `audit-lifecycle-${seq}`).expect(201));
    await request(app.getHttpServer()).patch(`/api/projects/web/threads/${thread.id}`).set(auth()).send({ maxCostUsd: 5 }).expect(200);
    expect(await entries('thread.cap.update', thread.id)).toEqual([expect.objectContaining({ resourceType: 'thread', projectId: world.projectId, summary: 'fields: maxCostUsd' })]);
    await request(app.getHttpServer()).post(`/api/projects/web/threads/${thread.id}/archive`).set(auth()).expect(200);
    await request(app.getHttpServer()).post(`/api/projects/web/threads/${thread.id}/archive`).set(auth()).expect(200);
    expect(await entries('thread.archive', thread.id)).toEqual([expect.objectContaining({ summary: 'archived' })]);
  });

  it('AC-10: records the archive and its committed queued-job cancellation', async () => {
    const thread = data<{ id: string }>(await projectCreate(`cancel-thread-${++seq}`, `audit-cancel-${seq}`).expect(201));
    const job = await db.fleetJob.create({ data: {
      projectId: world.projectId, repoId: world.repoId, ref: 'trunk', command: 'THREAD', feature: `thread-${thread.id}`, profiles: [],
      maxCostUsd: 5, selectorLabels: [], requestedById: world.ids.dev, requestedByType: 'USER', threadId: thread.id, state: 'QUEUED',
    } });
    await request(app.getHttpServer()).post(`/api/projects/web/threads/${thread.id}/archive`).set(auth()).expect(200);
    expect(await entries('thread.archive', thread.id)).toEqual([expect.objectContaining({ summary: 'archived' })]);
    expect(await entries('fleet.job.cancel', job.id)).toEqual([expect.objectContaining({ summary: 'cancelled from QUEUED' })]);
  });

  it('AC-11/12/13: audits workspace cap/archive and rejects another owner without an entry', async () => {
    const thread = data<{ id: string }>(await createWorkspace().expect(201));
    const outsiderAuth = { Authorization: `Bearer ${world.tokens.outsider}` };
    await request(app.getHttpServer()).post(`/api/threads/${thread.id}/archive`).set(outsiderAuth).expect(404);
    expect(await entries('thread.workspace.archive', thread.id)).toEqual([]);
    await request(app.getHttpServer()).patch(`/api/threads/${thread.id}`).set(auth()).send({ maxCostUsd: 5 }).expect(200);
    expect(await entries('thread.cap.update', thread.id)).toEqual([expect.objectContaining({ projectId: world.projectId, summary: 'fields: maxCostUsd' })]);
    await request(app.getHttpServer()).post(`/api/threads/${thread.id}/archive`).set(auth()).expect(200);
    expect(await entries('thread.workspace.archive', thread.id)).toEqual([expect.objectContaining({ summary: 'archived' })]);
    const outsiderCreate = await request(app.getHttpServer()).post('/api/threads').set({ Authorization: `Bearer ${world.tokens.outsider}` }).send({ title: 'other', backend: { kind: 'native' } });
    if (outsiderCreate.status === 201) {
      const otherThread = data<{ id: string }>(outsiderCreate);
      await request(app.getHttpServer()).post(`/api/threads/${otherThread.id}/archive`).set(auth()).expect(404);
      expect(await entries('thread.workspace.archive', otherThread.id)).toEqual([]);
    }
  });
});
