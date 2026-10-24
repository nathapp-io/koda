import { canRunDbTests } from '../../helpers/test-environment';
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { FleetHttpWorld, seedFleetHttpWorld, enrollRunner } from '../../helpers/fleet-fixtures';
import { seedThreadJobFor } from '../../helpers/thread-fixtures';
import { PrismaChatThreadRepository } from '../../../src/fleet/threads/prisma-chat-thread.repository';
import { PrismaFleetJobRepository } from '../../../src/fleet/jobs/prisma-fleet-job.repository';
import { LiveStreamRegistry } from '../../../src/live/live-stream-registry';
import { FLEET_CFG, IFleetConfig } from '../../../src/config/fleet.config';
import { MembershipService } from '../../../src/permissions/membership.service';
import { expectBindingOnlyFixtures, grantRole, revokeProjectRoles } from '../../../src/permissions/test-helpers/permission-fixtures';

// The nax sandbox withholds host Postgres/Docker.
const describeDb = canRunDbTests() ? describe : describe.skip;
describeDb('thread scope isolation', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let repo: PrismaChatThreadRepository;
  let workspace: string;
  let projectThread: string;
  const projectScope = () => ({ kind: 'project', projectId: world.projectId } as const);
  const userScope = (userId = world.ids.dev) => ({ kind: 'workspace', userId } as const);
  const server = () => app.getHttpServer();
  const auth = (token = world.tokens.dev) => ({ Authorization: `Bearer ${token}` });
  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(server(), prisma);
    app.get<IFleetConfig>(FLEET_CFG, { strict: false }).threadsEnabled = true;
    repo = app.get(PrismaChatThreadRepository, { strict: false });
    // Both principals are project admins in web: the setup replaces their world grants with the
    // project-admin binding.
    for (const userId of [world.ids.dev, world.ids.viewer]) {
      const principal = { type: 'USER' as const, id: userId };
      await revokeProjectRoles(prisma, principal, world.projectId);
      await grantRole(prisma, principal, 'project-admin', world.projectId);
    }
    await app.get(MembershipService).invalidatePermissions();
    const seed = async (kind: string, createdById: string, at: number) => prisma.chatThread.create({ data: {
      projectId: world.projectId, kind, createdById, title: 'Scope fixture', backend: { kind: 'native', model: 'm1' }, skills: [], lastActivityAt: new Date(at),
    } });
    workspace = (await seed('WORKSPACE', world.ids.dev, 2000)).id;
    projectThread = (await seed('PROJECT', world.ids.dev, 3000)).id;
    await seed('WORKSPACE', world.ids.root, 4000);
  }, 60_000);
  afterAll(async () => { await app?.close(); });

  it('fixtures grant through bindings only', async () => {
    await expectBindingOnlyFixtures(prisma, [
      { type: 'USER', id: world.ids.root },
      { type: 'USER', id: world.ids.dev },
      { type: 'USER', id: world.ids.viewer },
      { type: 'USER', id: world.ids.outsider },
    ]);
    // AC-8: the setup promoted dev and viewer to the project admin, one binding each.
    const roleOf = async (userId: string) => (await prisma.roleBinding.findMany({
      where: { principalType: 'USER', principalId: userId, projectId: world.projectId },
      include: { role: { select: { key: true } } },
    })).map((binding) => binding.role.key);
    expect(await roleOf(world.ids.dev)).toEqual(['project-admin']);
    expect(await roleOf(world.ids.viewer)).toEqual(['project-admin']);
  });

  it('AC-1: project list excludes workspace rows', async () => {
    const ids = (await repo.list(projectScope(), undefined, 0, 20)).map(t => t.id);
    expect(ids).toContain(projectThread); expect(ids).not.toContain(workspace);
  });
  it('AC-2: project get cannot read workspace', async () => {
    expect(await repo.get(projectScope(), workspace)).toBeNull();
  });
  it('AC-3: creator reads workspace with home project, even when soft deleted', async () => {
    const project = await prisma.project.findUniqueOrThrow({ where: { id: world.projectId } });
    await prisma.project.update({ where: { id: project.id }, data: { deletedAt: new Date() } });
    try {
      expect(await repo.get(userScope(), workspace)).toMatchObject({ id: workspace, homeProject: { slug: project.slug, name: project.name } });
    } finally { await prisma.project.update({ where: { id: project.id }, data: { deletedAt: null } }); }
  });
  it('AC-4: another user cannot read workspace', async () => {
    expect(await repo.get(userScope(world.ids.root), workspace)).toBeNull();
  });
  it('AC-5: workspace scope excludes project threads', async () => {
    expect(await repo.get(userScope(), projectThread)).toBeNull();
  });
  it('AC-6: workspace list is creator-only, workspace-only and newest first', async () => {
    const newer = await prisma.chatThread.create({ data: { projectId: world.projectId, kind: 'WORKSPACE', createdById: world.ids.dev, title: 'Newer', backend: {}, skills: [], lastActivityAt: new Date(5000) } });
    try {
      const rows = await repo.list(userScope(), undefined, 0, 20);
      expect(rows.map(t => t.id)).toEqual([newer.id, workspace]);
      expect(rows.every(t => t.homeProject?.slug === 'web')).toBe(true);
    } finally { await prisma.chatThread.delete({ where: { id: newer.id } }); }
  });
  it('AC-7: project HTTP list hides creator workspace', async () => {
    const res = await request(server()).get('/api/projects/web/threads').set(auth()).expect(200);
    expect(data<{ items: { id: string }[] }>(res).items.map(t => t.id)).not.toContain(workspace);
  });
  it('AC-8: project detail hides workspace from its ADMIN creator', async () => {
    const res = await request(server()).get(`/api/projects/web/threads/${workspace}`).set(auth()).expect(404);
    expect(res.body.message).toBe('Thread not found');
  });
  it('AC-9: project send creates no workspace message', async () => {
    await request(server()).post(`/api/projects/web/threads/${workspace}/messages`).set(auth()).send({ text: 'secret', clientMessageId: 'scope-test' }).expect(404);
    expect(await prisma.chatMessage.count({ where: { threadId: workspace } })).toBe(0);
  });
  it('AC-10: project publish hides workspace', async () => {
    const res = await request(server()).post(`/api/projects/web/threads/${workspace}/publish`).set(auth()).send({}).expect(404);
    expect(res.body.message).toBe('Thread not found');
  });
  it('AC-11: project events refuses workspace before opening stream', async () => {
    const acquire = vi.spyOn(app.get(LiveStreamRegistry, { strict: false }), 'tryAcquire');
    try {
      await request(server()).get(`/api/projects/web/threads/${workspace}/events`).set(auth()).timeout(1000).expect(404);
      expect(acquire).not.toHaveBeenCalled();
    } finally { acquire.mockRestore(); }
  });
  it('AC-12: another ADMIN cannot archive workspace through project', async () => {
    await request(server()).post(`/api/projects/web/threads/${workspace}/archive`).set(auth(world.tokens.viewer)).send({}).expect(404);
    expect(await prisma.chatThread.findUniqueOrThrow({ where: { id: workspace } })).toMatchObject({ status: 'ACTIVE' });
  });
  it('AC-13: project cap update hides workspace', async () => {
    const res = await request(server()).patch(`/api/projects/web/threads/${workspace}`).set(auth()).send({ maxCostUsd: 9 }).expect(404);
    expect(res.body.message).toBe('Thread not found');
  });
  it('AC-14: project end-session hides workspace', async () => {
    const res = await request(server()).post(`/api/projects/web/threads/${workspace}/end-session`).set(auth()).send({}).expect(404);
    expect(res.body.message).toBe('Thread not found');
  });
  it('AC-15: token scope preserves WORKSPACE SESSION', async () => {
    const runner = await enrollRunner(server(), world.tokens.root, 'scope-runner');
    const seeded = await seedThreadJobFor(prisma, world, runner, { kind: 'WORKSPACE', createdById: world.ids.root, projectId: world.projectId });
    try {
      expect(await prisma.chatThread.findUniqueOrThrow({ where: { id: seeded.threadId } })).toMatchObject({ kind: 'WORKSPACE', createdById: world.ids.root, projectId: world.projectId, repoId: null, baseRef: null, feature: null, specPath: null });
      expect(await prisma.fleetJob.findUniqueOrThrow({ where: { id: seeded.jobId } })).toMatchObject({ repoId: world.repoId });
      expect(await app.get(PrismaFleetJobRepository, { strict: false }).findThreadTokenScope(seeded.jobId)).toEqual({ kind: 'WORKSPACE', action: 'SESSION' });
    } finally {
      await prisma.fleetJob.delete({ where: { id: seeded.jobId } });
      await prisma.chatThread.delete({ where: { id: seeded.threadId } });
    }
  });
});
