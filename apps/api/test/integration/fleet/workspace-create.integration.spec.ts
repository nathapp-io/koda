import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { FLEET_CFG, type IFleetConfig } from '../../../src/config/fleet.config';
import { MembershipService } from '../../../src/permissions/membership.service';
import { expectBindingOnlyFixtures, grantRole, revokeProjectRoles } from '../../../src/permissions/test-helpers/permission-fixtures';

const describeDb = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
describeDb('workspace create HTTP', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let config: IFleetConfig;
  const post = (body = {}, token = world.tokens.dev) => request(app.getHttpServer()).post('/api/threads').set('Authorization', `Bearer ${token}`).send({ title: 't', backend: { kind: 'native' }, ...body });
  const message = (res: request.Response, expected: string) => { expect(res.body.ret).not.toBe(0); expect(res.body.message).toBe(expected); };
  const invalidatePermissions = () => app.get(MembershipService).invalidatePermissions();
  const dev = () => ({ type: 'USER' as const, id: world.ids.dev });
  const root = () => ({ type: 'USER' as const, id: world.ids.root });
  beforeAll(async () => {
    await resetDb(); app = await bootHttpApp({ registrationEnabled: false });
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(app.getHttpServer(), prisma);
    config = app.get(FLEET_CFG, { strict: false });
  }, 60_000);
  beforeEach(async () => {
    config.threadsEnabled = true;
    await prisma.project.update({ where: { id: world.projectId }, data: { createdAt: new Date(1000) } });
    await prisma.project.update({ where: { id: world.opsProjectId }, data: { createdAt: new Date(2000) } });
    await grantRole(prisma, dev(), 'developer', world.opsProjectId);
    await revokeProjectRoles(prisma, dev(), world.projectId);
    await grantRole(prisma, dev(), 'developer', world.projectId);
    // Permissions P1 US-003: the home project's `thread.create` key decides occupancy, and the rows above
    // are written straight to the database, so the effective-key cache is dropped as a real write would.
    await invalidatePermissions();
  });
  afterAll(async () => { await app?.close(); });
  it('fixtures grant through bindings only', async () => {
    await expectBindingOnlyFixtures(prisma, [
      { type: 'USER', id: world.ids.root },
      { type: 'USER', id: world.ids.dev },
      { type: 'USER', id: world.ids.viewer },
      { type: 'USER', id: world.ids.outsider },
    ]);
  });
  it('AC-5: whitelist preserves refused fields', async () => { message(await post({ repoId: 'r1' }).expect(400), 'Invalid thread input: workspaceFields'); });
  it('AC-6/7: oldest eligible home and persisted workspace row', async () => {
    const thread = data<{ id: string; homeProject: { slug: string } }>(await post().expect(201));
    expect(thread.homeProject.slug).toBe('web');
    expect(await prisma.chatThread.findUniqueOrThrow({ where: { id: thread.id } })).toMatchObject({ kind: 'WORKSPACE', projectId: world.projectId, repoId: null, feature: null, baseRef: null });
  });
  it('AC-8: skips home without repo', async () => {
    const repo = await prisma.fleetRepo.findUniqueOrThrow({ where: { id: world.repoId } });
    await prisma.fleetRepo.delete({ where: { id: repo.id } });
    try { expect(data<{ homeProject: { slug: string } }>(await post().expect(201)).homeProject.slug).toBe('ops'); }
    finally { await prisma.fleetRepo.create({ data: repo }); }
  });
  it('AC-9: skips a home whose thread.create key a VIEWER lacks', async () => {
    await revokeProjectRoles(prisma, dev(), world.projectId);
    await grantRole(prisma, dev(), 'viewer', world.projectId);
    await invalidatePermissions();
    expect(data<{ homeProject: { slug: string } }>(await post().expect(201)).homeProject.slug).toBe('ops');
  });
  it('AC-10: admin default requires membership', async () => {
    // The admin's reach is not membership: with no project binding of its own, the default home is refused.
    const bindings = await prisma.roleBinding.findMany({
      where: { principalType: 'USER', principalId: root().id, projectId: { in: [world.projectId, world.opsProjectId] } },
      include: { role: { select: { key: true } } },
    });
    await revokeProjectRoles(prisma, root(), world.projectId);
    await revokeProjectRoles(prisma, root(), world.opsProjectId);
    try { message(await post({}, world.tokens.root).expect(409), 'This project has no repository, so a project thread cannot run'); }
    finally {
      for (const binding of bindings) await grantRole(prisma, root(), binding.role.key, binding.projectId);
      await invalidatePermissions();
    }
  });
  it('AC-11: explicit VIEWER home is refused with the permissions code', async () => { message(await post({ homeProject: 'web' }, world.tokens.viewer).expect(403), 'You do not have permissions to perform this action'); });
  it('AC-12: explicit home without repo', async () => {
    const repo = await prisma.fleetRepo.findUniqueOrThrow({ where: { id: world.repoId } }); await prisma.fleetRepo.delete({ where: { id: repo.id } });
    try { message(await post({ homeProject: 'web' }).expect(409), 'This project has no repository, so a project thread cannot run'); }
    finally { await prisma.fleetRepo.create({ data: repo }); }
  });
  it('AC-13/14: unknown and unreachable have identical 404s', async () => {
    const a = await post({ homeProject: 'web' }, world.tokens.outsider).expect(404);
    const b = await post({ homeProject: 'absent' }, world.tokens.outsider).expect(404);
    expect(a.body).toEqual(b.body); expect(a.body.ret).not.toBe(0);
  });
  it('AC-15: disabled', async () => { config.threadsEnabled = false; try { message(await post().expect(409), 'Chat threads are disabled'); } finally { config.threadsEnabled = true; } });
});
