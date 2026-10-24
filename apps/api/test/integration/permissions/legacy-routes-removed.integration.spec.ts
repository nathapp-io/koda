import { canRunDbTests } from '../../helpers/test-environment';
/**
 * Permissions P1 US-003 — the five legacy write routes are gone over real HTTP + Postgres
 * (AC-1 .. AC-7, AC-9).
 *
 * A retired route answers 404 because no handler remains, and the state it used to write is
 * untouched: the user keeps its developer binding (AC-3) and the roster PATCH that stays keeps
 * answering 200 for a bound agent (AC-7). AC-9 pins the replacement write the roster route's callers
 * moved to: `POST /role-bindings` answers an existing binding with 201 and the same binding id, so a
 * duplicate grant is no longer a 409.
 *
 * Every case builds its own project, users and agent, so the file is order-independent and no case
 * reads a row an earlier one wrote.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/permissions/legacy-routes-removed.integration.spec.ts
 */
import request from 'supertest';
import * as bcrypt from 'bcrypt';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { MembershipService } from '../../../src/permissions/membership.service';
import { grantBaseline, grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, loginToken, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';
import { expectGuardActive, fixtureDb } from '../../helpers/action-context';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;

/** Booting `AppModule` runs the system-role seeder, so the first hook needs a generous budget. */
const BOOT_TIMEOUT_MS = 60_000;

describeIntegration('the legacy write routes are removed (US-003)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let db: PrismaClient;
  let membership: MembershipService;
  let passwordHash: string;
  let sequence = 0;
  const tokens = new Map<string, string>();

  const newProject = async (): Promise<{ id: string; slug: string }> => {
    const n = (sequence += 1);
    return db.project.create({ data: { name: `Legacy ${n}`, slug: `legacy-${n}`, key: `LG${n}` } });
  };

  const newUser = async () => {
    const n = (sequence += 1);
    const user = await db.user.create({
      data: { email: `legacy-${n}@koda.test`, name: `Legacy ${n}`, passwordHash },
    });
    await grantBaseline(db, { type: 'USER', id: user.id });
    return user;
  };

  const newAgent = async () => {
    const n = (sequence += 1);
    const agent = await db.agent.create({
      data: { name: `legacy-agent-${n}`, slug: `legacy-agent-${n}`, apiKeyHash: `legacy-hash-${n}` },
    });
    await grantBaseline(db, { type: 'AGENT', id: agent.id });
    return agent;
  };

  /** The user's access token, minted once per user and after every grant it holds. */
  const tokenFor = async (user: { id: string; email: string }): Promise<string> => {
    const cached = tokens.get(user.id);
    if (cached) return cached;
    resetThrottle(app);
    const token = await loginToken(server, user.email);
    tokens.set(user.id, token);
    return token;
  };

  /** Binds a seeded role to a principal; the grant is written under the cache, so the cache is dropped. */
  const grant = async (
    principal: { type: 'USER' | 'AGENT'; id: string },
    roleKey: string,
    projectId: string | null,
  ): Promise<{ id: string }> => {
    const binding = await grantRole(db, principal, roleKey, projectId);
    await membership.invalidatePermissions();
    return binding;
  };

  /** A user holding the global `admin` binding: every project key, plus `role.binding.global`. */
  const globalAdmin = async (): Promise<{ token: string; id: string }> => {
    const user = await newUser();
    await grant({ type: 'USER', id: user.id }, 'admin', null);
    return { token: await tokenFor(user), id: user.id };
  };

  /** The bindings the user holds in the project — what a retired write must not change. */
  const userBindings = (userId: string, projectId: string) => db.roleBinding.findMany({
    where: { principalType: 'USER', principalId: userId, projectId },
    select: { id: true, role: { select: { key: true } } },
  });

  /** The bindings the agent holds in the project. */
  const agentBindings = (agentId: string, projectId: string) => db.roleBinding.findMany({
    where: { principalType: 'AGENT', principalId: agentId, projectId },
    select: { id: true, role: { select: { key: true } } },
  });

  beforeAll(async () => {
    await resetDb();
    passwordHash = await bcrypt.hash(TEST_PASSWORD, 4);
    app = await bootHttpApp({ registrationEnabled: false, ownerEmail: null });
    server = app.getHttpServer();
    db = fixtureDb(app);
    membership = app.get(MembershipService);
  }, BOOT_TIMEOUT_MS);

  beforeEach(() => {
    resetThrottle(app);
  });

  afterAll(async () => {
    await app.close();
  });

  it('writes need an action context', async () => {
    await expect(expectGuardActive(app)).resolves.toBeUndefined();
  });

  it('AC-1: PATCH /projects/:slug/members/:userId answers 404', async () => {
    const project = await newProject();
    const member = await newUser();
    await grant({ type: 'USER', id: member.id }, 'developer', project.id);
    const admin = await globalAdmin();

    const res = await request(server)
      .patch(`/api/projects/${project.slug}/members/${member.id}`)
      .set({ Authorization: `Bearer ${admin.token}` })
      .send({ role: 'VIEWER' });

    expect(res.status).toBe(404);
    expect(res.body).not.toHaveProperty('data');
    // The retired handler wrote a binding; the refusal leaves the developer one in place.
    expect(await userBindings(member.id, project.id)).toEqual([
      expect.objectContaining({ role: { key: 'developer' } }),
    ]);
  });

  it('AC-2: DELETE /projects/:slug/members/:userId answers 404', async () => {
    const project = await newProject();
    const member = await newUser();
    await grant({ type: 'USER', id: member.id }, 'developer', project.id);
    const admin = await globalAdmin();

    const res = await request(server)
      .delete(`/api/projects/${project.slug}/members/${member.id}`)
      .set({ Authorization: `Bearer ${admin.token}` });

    expect(res.status).toBe(404);
    expect(res.body).not.toHaveProperty('data');
  });

  it('AC-3: after that DELETE the user\'s developer binding in P still exists', async () => {
    const project = await newProject();
    const member = await newUser();
    const developer = await grant({ type: 'USER', id: member.id }, 'developer', project.id);
    const admin = await globalAdmin();

    await request(server)
      .delete(`/api/projects/${project.slug}/members/${member.id}`)
      .set({ Authorization: `Bearer ${admin.token}` })
      .expect(404);

    expect(await db.roleBinding.findUnique({ where: { id: developer.id } })).not.toBeNull();
    expect(await userBindings(member.id, project.id)).toEqual([
      expect.objectContaining({ id: developer.id, role: { key: 'developer' } }),
    ]);
  });

  it('AC-4: POST /projects/:slug/agents answers 404', async () => {
    const project = await newProject();
    const agent = await newAgent();
    const admin = await globalAdmin();

    const res = await request(server)
      .post(`/api/projects/${project.slug}/agents`)
      .set({ Authorization: `Bearer ${admin.token}` })
      .send({ agentSlug: agent.slug });

    expect(res.status).toBe(404);
    expect(res.body).not.toHaveProperty('data');
    // The retired handler granted a viewer binding; the refusal writes none.
    expect(await agentBindings(agent.id, project.id)).toEqual([]);
  });

  it('AC-5: DELETE /projects/:slug/agents/:agentSlug answers 404', async () => {
    const project = await newProject();
    const agent = await newAgent();
    const viewer = await grant({ type: 'AGENT', id: agent.id }, 'viewer', project.id);
    const admin = await globalAdmin();

    const res = await request(server)
      .delete(`/api/projects/${project.slug}/agents/${agent.slug}`)
      .set({ Authorization: `Bearer ${admin.token}` });

    expect(res.status).toBe(404);
    expect(res.body).not.toHaveProperty('data');
    expect(await agentBindings(agent.id, project.id)).toEqual([
      expect.objectContaining({ id: viewer.id, role: { key: 'viewer' } }),
    ]);
  });

  it('AC-6: PATCH /agents/:slug/update-roles answers 404', async () => {
    const agent = await newAgent();
    const admin = await globalAdmin();

    const res = await request(server)
      .patch(`/api/agents/${agent.slug}/update-roles`)
      .set({ Authorization: `Bearer ${admin.token}` })
      .send({ roles: ['DEVELOPER'] });

    expect(res.status).toBe(404);
    expect(res.body).not.toHaveProperty('data');
  });

  it('AC-7: PATCH /projects/:slug/agents/:agentSlug still answers 200', async () => {
    const project = await newProject();
    const agent = await newAgent();
    await grant({ type: 'AGENT', id: agent.id }, 'viewer', project.id);
    const admin = await globalAdmin();

    const res = await request(server)
      .patch(`/api/projects/${project.slug}/agents/${agent.slug}`)
      .set({ Authorization: `Bearer ${admin.token}` })
      .send({ status: 'PAUSED' })
      .expect(200);

    expect(res.body).toMatchObject({ ret: 0, data: expect.objectContaining({ slug: agent.slug, status: 'PAUSED' }) });
    expect(await db.agent.findUnique({ where: { id: agent.id }, select: { status: true } }))
      .toEqual({ status: 'PAUSED' });
  });

  it('AC-9: a Project Admin\'s second viewer binding POST answers 201 with the first binding id', async () => {
    const project = await newProject();
    const agent = await newAgent();
    const projectAdminUser = await newUser();
    await grant({ type: 'USER', id: projectAdminUser.id }, 'project-admin', project.id);
    const projectAdminToken = await tokenFor(projectAdminUser);
    const body = {
      principalType: 'AGENT',
      principalId: agent.id,
      roleKey: 'viewer',
      projectId: project.id,
    };

    const first = await request(server)
      .post('/api/role-bindings')
      .set({ Authorization: `Bearer ${projectAdminToken}` })
      .send(body)
      .expect(201);
    const second = await request(server)
      .post('/api/role-bindings')
      .set({ Authorization: `Bearer ${projectAdminToken}` })
      .send(body)
      .expect(201);

    const firstId = (first.body as { data: { id: string } }).data.id;
    expect((second.body as { data: { id: string } }).data.id).toBe(firstId);
    expect(await agentBindings(agent.id, project.id)).toEqual([
      expect.objectContaining({ id: firstId, role: { key: 'viewer' } }),
    ]);
  });
});
