import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { FLEET_CFG, type IFleetConfig } from '../../../src/config/fleet.config';

const describeDb = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
describeDb('workspace create HTTP', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let config: IFleetConfig;
  const post = (body = {}, token = world.tokens.dev) => request(app.getHttpServer()).post('/api/threads').set('Authorization', `Bearer ${token}`).send({ title: 't', backend: { kind: 'native' }, ...body });
  const message = (res: request.Response, expected: string) => { expect(res.body.ret).not.toBe(0); expect(res.body.message).toBe(expected); };
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
    await prisma.projectMember.upsert({ where: { projectId_userId: { projectId: world.opsProjectId, userId: world.ids.dev } }, create: { projectId: world.opsProjectId, userId: world.ids.dev, role: 'DEVELOPER' }, update: { role: 'DEVELOPER' } });
    await prisma.projectMember.update({ where: { projectId_userId: { projectId: world.projectId, userId: world.ids.dev } }, data: { role: 'DEVELOPER' } });
  });
  afterAll(async () => { await app?.close(); });
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
  it('AC-9: skips VIEWER home', async () => {
    await prisma.projectMember.update({ where: { projectId_userId: { projectId: world.projectId, userId: world.ids.dev } }, data: { role: 'VIEWER' } });
    expect(data<{ homeProject: { slug: string } }>(await post().expect(201)).homeProject.slug).toBe('ops');
  });
  it('AC-10: admin default requires membership', async () => {
    const members = await prisma.projectMember.findMany({ where: { userId: world.ids.root } });
    await prisma.projectMember.deleteMany({ where: { userId: world.ids.root } });
    try { message(await post({}, world.tokens.root).expect(409), 'This project has no repository, so a project thread cannot run'); }
    finally { await prisma.projectMember.createMany({ data: members }); }
  });
  it('AC-11: explicit VIEWER home', async () => { message(await post({ homeProject: 'web' }, world.tokens.viewer).expect(403), 'You cannot create jobs in this home project'); });
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
