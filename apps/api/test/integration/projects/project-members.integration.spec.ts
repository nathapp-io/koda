/**
 * Slice 4 — /projects/:slug/members on real Postgres over HTTP.
 * Run: cd apps/api && bun run test:db:up && bun run test:integration -- test/integration/projects/project-members
 */
import request from 'supertest';
import * as bcrypt from 'bcrypt';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

interface Member { userId: string; email: string; bindings: { id: string; roleKey: string }[] }
interface Page<T> { total: number; records: T[] }

describeIntegration('/projects/:slug/members (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let db: PrismaClient;
  let passwordHash: string;
  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const base = '/api/projects/team/members';
  const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    db = app.get<PrismaService<PrismaClient>>(PrismaService).client as PrismaClient;
    passwordHash = await bcrypt.hash(TEST_PASSWORD, 4);

    const root = await request(server).post('/api/auth/register')
      .send({ email: 'root@koda.test', name: 'Root', password: TEST_PASSWORD }).expect(201);
    tokens.root = data<{ accessToken: string }>(root).accessToken;

    await request(server).post('/api/projects').set(auth('root'))
      .send({ name: 'Team', slug: 'team', key: 'TEAM' }).expect(201);

    for (const who of ['pa', 'dev', 'viewer', 'outsider']) {
      const res = await request(server).post('/api/admin/users').set(auth('root'))
        .send({ email: `${who}@koda.test`, name: who, password: TEST_PASSWORD, role: 'MEMBER' }).expect(201);
      ids[who] = data<{ id: string }>(res).id;
      tokens[who] = await loginToken(server, `${who}@koda.test`);
    }
  });

  afterAll(async () => {
    await app.close();
  });

  it('a global admin adds a project admin and a developer', async () => {
    const pa = data<Member>(await request(server).post(base).set(auth('root')).send({ email: 'pa@koda.test', roleKey: 'project-admin' }).expect(201));
    // Permissions P1l US-006: a member row names its bindings instead of a display role.
    expect(pa).toEqual(expect.objectContaining({ userId: ids.pa }));
    expect(pa).not.toHaveProperty('role');
    expect(pa.bindings).toEqual([expect.objectContaining({ roleKey: 'project-admin', id: expect.any(String) })]);
    await request(server).post(base).set(auth('root')).send({ email: 'dev@koda.test', roleKey: 'developer' }).expect(201);
  });

  it('unknown email is 404; an existing member is 409 (lookup is case-insensitive)', async () => {
    await request(server).post(base).set(auth('root')).send({ email: 'ghost@koda.test', roleKey: 'viewer' }).expect(404);
    await request(server).post(base).set(auth('root')).send({ email: 'DEV@KODA.TEST', roleKey: 'viewer' }).expect(409);
  });

  it('a DEVELOPER can list but cannot add members', async () => {
    const page = data<Page<Member>>(await request(server).get(base).set(auth('dev')).expect(200));
    expect(page.total).toBe(2);
    await request(server).post(base).set(auth('dev')).send({ email: 'viewer@koda.test', roleKey: 'viewer' }).expect(403);
  });

  it('a non-member cannot list members', async () => {
    await request(server).get(base).set(auth('outsider')).expect(403);
  });

  it('a project admin adds a viewer and changes their role', async () => {
    await request(server).post(base).set(auth('pa')).send({ email: 'viewer@koda.test', roleKey: 'viewer' }).expect(201);
    // Permissions P1 US-003: a role change is a grant of the new binding plus a delete of the old one
    // on the role-bindings route; the members list is where the outcome is read.
    const project = await db.project.findUniqueOrThrow({ where: { slug: 'team' } });
    const viewer = await db.roleBinding.findFirstOrThrow({
      where: { principalType: 'USER', principalId: ids.viewer, projectId: project.id, role: { key: 'viewer' } },
    });
    await request(server).post('/api/role-bindings').set(auth('pa'))
      .send({ principalType: 'USER', principalId: ids.viewer, roleKey: 'developer', projectId: project.id })
      .expect(201);
    await request(server).delete(`/api/role-bindings/${viewer.id}`).set(auth('pa')).expect(204);

    const page = data<Page<Member>>(await request(server).get(base).set(auth('pa')).expect(200));
    // Permissions P1l US-006: the row's bindings are what says which role it holds.
    const row = page.records.find((member) => member.userId === ids.viewer);
    expect(row?.bindings.map((binding) => binding.roleKey)).toEqual(['developer']);
    expect(row).not.toHaveProperty('role');
  });

  it('the last project ADMIN cannot have its binding revoked; a global admin can', async () => {
    const project = await db.project.findUniqueOrThrow({ where: { slug: 'team' } });
    const paAdmin = await db.roleBinding.findFirstOrThrow({
      where: { principalType: 'USER', principalId: ids.pa, projectId: project.id, role: { key: 'project-admin' } },
    });
    // A co-admin holds every project key but not `role.binding.global`, so only the last-admin count
    // can refuse it; the count says pa is the project's only active admin.
    const coAdminId = (await db.user.create({ data: { email: 'co-admin@koda.test', passwordHash, role: 'MEMBER' } })).id;
    const coAdminRole = await db.role.create({
      data: {
        key: 'team-co-admin', name: 'Team Co Admin', description: '', scope: 'PROJECT',
        system: false, locked: false, permissions: ['*'],
      },
    });
    await db.roleBinding.create({
      data: {
        principalType: 'USER', principalId: coAdminId, projectId: project.id,
        roleId: coAdminRole.id, grantedByType: 'SYSTEM', grantedById: 'test',
      },
    });
    resetThrottle(app);
    const coAdminToken = await loginToken(server, 'co-admin@koda.test');

    const refused = await request(server).delete(`/api/role-bindings/${paAdmin.id}`).set({ Authorization: `Bearer ${coAdminToken}` }).expect(409);
    expect(refused.body).toMatchObject({ ret: 409, message: 'A project must keep at least one admin' });

    // A self-removal is the self-binding refusal, before any last-admin question is asked.
    await request(server).delete(`/api/role-bindings/${paAdmin.id}`).set(auth('pa')).expect(403);

    // root holds `role.binding.global`, the override the last-admin rule answers to.
    await request(server).delete(`/api/role-bindings/${paAdmin.id}`).set(auth('root')).expect(204);
    expect(await db.roleBinding.findMany({ where: { principalType: 'USER', principalId: ids.pa, projectId: project.id } }))
      .toEqual([]);
  });

  it('removal takes effect on the next request (membership is not cached)', async () => {
    const project = await db.project.findUniqueOrThrow({ where: { slug: 'team' } });
    await request(server).get(base).set(auth('viewer')).expect(200);
    const viewerBindings = await db.roleBinding.findMany({
      where: { principalType: 'USER', principalId: ids.viewer, projectId: project.id },
    });
    expect(viewerBindings.length).toBeGreaterThan(0);
    for (const binding of viewerBindings) {
      await request(server).delete(`/api/role-bindings/${binding.id}`).set(auth('root')).expect(204);
    }
    await request(server).get(base).set(auth('viewer')).expect(403);
    // A second delete of the same binding is the binding route's 404.
    const first = viewerBindings[0] as { id: string };
    await request(server).delete(`/api/role-bindings/${first.id}`).set(auth('root')).expect(404);
  });

  it('a disabled project ADMIN does not count as an active admin', async () => {
    // pa lost its project-admin binding above; restore it and add a second admin.
    await request(server).post('/api/role-bindings').set(auth('root'))
      .send({ principalType: 'USER', principalId: ids.pa, roleKey: 'project-admin', projectId: (await db.project.findUniqueOrThrow({ where: { slug: 'team' } })).id })
      .expect(201);
    await request(server).post(base).set(auth('root')).send({ email: 'viewer@koda.test', roleKey: 'project-admin' }).expect(201);
    await request(server).patch(`/api/admin/users/${ids.viewer}`).set(auth('root')).send({ disabled: true }).expect(200);

    // viewer is disabled, so pa is the only active project ADMIN: the co-admin's delete is refused.
    // Before the active-only count this returned 204 and the project lost its last active admin.
    const project = await db.project.findUniqueOrThrow({ where: { slug: 'team' } });
    const paAdmin = await db.roleBinding.findFirstOrThrow({
      where: { principalType: 'USER', principalId: ids.pa, projectId: project.id, role: { key: 'project-admin' } },
    });
    const coAdmin = await db.user.findUniqueOrThrow({ where: { email: 'co-admin@koda.test' } });
    expect(coAdmin.id).toBeTruthy();
    resetThrottle(app);
    const coAdminToken = await loginToken(server, 'co-admin@koda.test');
    await request(server).delete(`/api/role-bindings/${paAdmin.id}`).set({ Authorization: `Bearer ${coAdminToken}` }).expect(409);
  });

  it('rejects an unassignable role key with 400 permissions.scopeMismatch', async () => {
    // `agent` is a GLOBAL role: naming it for a project member is a scope mismatch, not a legacy enum
    // error — the `role` field that used to carry `AGENT` is gone.
    const res = await request(server).post(base).set(auth('root')).send({ email: 'outsider@koda.test', roleKey: 'agent' });

    expect(res.status).toBe(400);
    expect(res.body.ret).toBe(-2);
    expect(res.body.message).toContain('agent');
  });
});
