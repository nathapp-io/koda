/** Binding-only membership queries and their HTTP consumers against real Postgres. */
import type { NathApplication } from '@nathapp/nestjs-app';
import request from 'supertest';
import { hashSync } from 'bcrypt';
import { bootHttpApp, data, loginToken, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';
import { PrismaClient } from '../../../src/generated/prisma/client';
import type { KodaPrincipal } from '../../../src/auth/principal/koda-principal.types';
import {
  accessibleProjectIds,
  agentHasProjectAccess,
  countActiveProjectAdmins,
  listProjectMemberships,
  localProjectRole,
  principalIdsWithAccess,
  userProjectRole,
} from '../../../src/permissions/membership.queries';
import { MembershipService } from '../../../src/permissions/membership.service';
import { PermissionService } from '../../../src/permissions/permission.service';
import type { Granter, PrincipalRef } from '../../../src/permissions/permissions.types';
import { grantBaseline } from '../../../src/permissions/test-helpers/permission-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { expectGuardActive, fixtureDb, withTestActor } from '../../helpers/action-context';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('binding-only membership queries (PG)', () => {
  let moduleRef: NathApplication;
  let db: PrismaClient;
  let membership: MembershipService;
  let permissions: PermissionService;
  let counter = 0;

  const SYSTEM: Granter = { type: 'SYSTEM', id: 'test' };
  const USER = (id: string): PrincipalRef => ({ type: 'USER', id });
  const AGENT = (id: string): PrincipalRef => ({ type: 'AGENT', id });
  const userPrincipal = (user: {
    id: string;
    name: string;
    email: string;
  }): KodaPrincipal => ({
    actorType: 'user',
    id: user.id,
    name: user.name,
    role: 'MEMBER',
    email: user.email,
    authorities: [],
    blacklisted: false,
    revoked: false,
  });

  const newUser = async (options: { disabled?: boolean } = {}) => {
    counter += 1;
    const user = await db.user.create({
      data: {
        email: `u${counter}@koda.test`,
        name: `U${counter}`,
        passwordHash: hashSync(TEST_PASSWORD, 4),
        disabled: options.disabled ?? false,
      },
    });
    await grantBaseline(db, USER(user.id));
    return user;
  };

  const newAgent = async () => {
    counter += 1;
    const agent = await db.agent.create({
      data: { name: `agent-${counter}`, slug: `agent-${counter}`, apiKeyHash: `hash-${counter}` },
    });
    await grantBaseline(db, AGENT(agent.id));
    return agent;
  };

  const newProject = (label: string) => {
    counter += 1;
    return db.project.create({ data: { name: label, slug: `${label}-${counter}`, key: `K${counter}` } });
  };

  // Fixture grants run as `SYSTEM/seed`, the context the fixture client writes under.
  const bind = (principal: PrincipalRef, roleKey: string, projectId: string | null, by: Granter = SYSTEM) =>
    withTestActor({ type: 'SYSTEM', id: 'seed' }, () => membership.createBinding({ principal, roleKey, projectId }, by));

  beforeAll(async () => {
    await resetDb();
    moduleRef = await bootHttpApp({ registrationEnabled: false, ownerEmail: null });
    db = fixtureDb(moduleRef);
    membership = moduleRef.get(MembershipService);
    permissions = moduleRef.get(PermissionService);
  }, 30_000);

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(async () => {
    resetThrottle(moduleRef);
    await db.roleBinding.deleteMany({});
    await db.project.deleteMany({});
    await db.agent.deleteMany({});
    await db.user.deleteMany({});
  });

  it('writes need an action context', async () => {
    await expect(expectGuardActive(moduleRef)).resolves.toBeUndefined();
  });

  it('AC-3: a user whose only source in p1 is a developer binding answers DEVELOPER', async () => {
    const user = await newUser();
    const p1 = await newProject('p1');
    await bind(USER(user.id), 'developer', p1.id);

    expect(await userProjectRole(db, user.id, p1.id)).toBe('DEVELOPER');
  });

  it('AC-4: a project-admin binding maps to ADMIN from its binding', async () => {
    const user = await newUser();
    const p1 = await newProject('p1');
    await bind(USER(user.id), 'project-admin', p1.id);

    expect(await userProjectRole(db, user.id, p1.id)).toBe('ADMIN');
  });

  it('AC-5: a projectId-null binding is an access source but never a local one', async () => {
    const user = await newUser();
    const p2 = await newProject('p2');
    await bind(USER(user.id), 'reviewer', null);

    expect(await userProjectRole(db, user.id, p2.id)).toBe('VIEWER');
    expect(await localProjectRole(db, USER(user.id), p2.id)).toBeNull();
  });

  it('AC-6: a GLOBAL-scope binding is no source at all', async () => {
    const user = await newUser();
    const p1 = await newProject('p1');
    await bind(USER(user.id), 'admin', null);

    expect(await userProjectRole(db, user.id, p1.id)).toBeNull();
  });

  it('AC-7: an agent with a viewer binding has project access, an unknown project does not', async () => {
    const agent = await newAgent();
    const p1 = await newProject('p1');
    await bind(AGENT(agent.id), 'viewer', p1.id);

    expect(await agentHasProjectAccess(db, agent.id, p1.id)).toBe(true);
    expect(await agentHasProjectAccess(db, agent.id, 'no-such-project')).toBe(false);
  });

  it('AC-8: accessible project ids exclude unbound projects, minus soft-deleted projects', async () => {
    const agent = await newAgent();
    await newProject('p1');
    const p2 = await newProject('p2');
    const p3 = await newProject('p3');
    await bind(AGENT(agent.id), 'viewer', p2.id);
    await bind(AGENT(agent.id), 'viewer', p3.id);
    await db.project.update({ where: { id: p3.id }, data: { deletedAt: new Date() } });

    const ids = await accessibleProjectIds(db, AGENT(agent.id));

    expect(ids).toEqual([p2.id]);
    expect(ids).toEqual([...ids].sort());
  });

  it('AC-9: a global project binding reaches every non-deleted project', async () => {
    const user = await newUser();
    const p1 = await newProject('p1');
    const p2 = await newProject('p2');
    const p3 = await newProject('p3');
    await bind(USER(user.id), 'developer', null);
    await db.project.update({ where: { id: p3.id }, data: { deletedAt: new Date() } });

    expect(await accessibleProjectIds(db, USER(user.id))).toEqual([p1.id, p2.id].sort());
  });

  it('AC-10: principal ids with access are the local sources plus the global project bindings', async () => {
    const p1 = await newProject('p1');
    const p2 = await newProject('p2');
    await newUser();
    const bound = await newUser();
    const globally = await newUser();
    const globalAdmin = await newUser();
    const elsewhere = await newUser();
    await bind(USER(bound.id), 'viewer', p1.id);
    await bind(USER(globally.id), 'viewer', null);
    await bind(USER(globalAdmin.id), 'admin', null);
    await bind(USER(elsewhere.id), 'developer', p2.id);

    expect(await principalIdsWithAccess(db, p1.id, 'USER')).toEqual(
      [bound.id, globally.id].sort(),
    );
  });

  it('AC-11: a membership entry carries the earliest source date and its granter', async () => {
    const otherGranter = await newUser();
    const p1 = await newProject('p1');
    const rosterOnlyGlobal = await newAgent();
    const agent = await newAgent();
    const binding = await bind(AGENT(agent.id), 'viewer', p1.id, { type: 'USER', id: otherGranter.id });
    await bind(AGENT(rosterOnlyGlobal.id), 'developer', null);

    const memberships = await listProjectMemberships(db, p1.id, 'AGENT');

    expect(memberships).toEqual([
      { principalId: agent.id, role: 'VIEWER', since: binding.createdAt, addedByUserId: otherGranter.id },
    ]);
  });

  it('AC-12: the active project admins are the distinct non-disabled users holding ADMIN locally', async () => {
    const p1 = await newProject('p1');
    await newUser();
    const b = await newUser();
    const c = await newUser();
    const d = await newUser({ disabled: true });
    await bind(USER(b.id), 'project-admin', p1.id);
    await bind(USER(c.id), 'project-admin', p1.id);
    await bind(USER(d.id), 'project-admin', p1.id);

    expect(await countActiveProjectAdmins(db, p1.id)).toBe(2);
  });

  it('AC-14: removing the only binding in p1 takes the project key away from the next check', async () => {
    const user = await newUser();
    const p1 = await newProject('p1');
    const binding = await bind(USER(user.id), 'developer', p1.id);
    const principal = userPrincipal(user);

    expect((await permissions.can(principal, 'ticket.create', { projectId: p1.id })).allowed).toBe(true);

    await withTestActor({ type: 'SYSTEM', id: 'seed' }, () => membership.removeBinding(binding.id));

    expect((await permissions.can(principal, 'ticket.create', { projectId: p1.id })).allowed).toBe(false);
  });

  it('reads the sources from the database on every call, never from a cache', async () => {
    const user = await newUser();
    const p1 = await newProject('p1');
    await bind(USER(user.id), 'viewer', p1.id);
    expect(await userProjectRole(db, user.id, p1.id)).toBe('VIEWER');

    await bind(USER(user.id), 'project-admin', p1.id);

    expect(await userProjectRole(db, user.id, p1.id)).toBe('ADMIN');
  });

  it('keeps the two principal types apart for the same project', async () => {
    const user = await newUser();
    const agent = await newAgent();
    const p1 = await newProject('p1');
    await bind(USER(user.id), 'developer', p1.id);
    await bind(AGENT(agent.id), 'viewer', p1.id);

    expect(await principalIdsWithAccess(db, p1.id, 'USER')).toEqual([user.id]);
    expect(await principalIdsWithAccess(db, p1.id, 'AGENT')).toEqual([agent.id]);
    expect(await listProjectMemberships(db, p1.id, 'USER')).toEqual([
      { principalId: user.id, role: 'DEVELOPER', since: expect.any(Date), addedByUserId: null },
    ]);
    expect(await listProjectMemberships(db, p1.id, 'AGENT')).toEqual([
      { principalId: agent.id, role: 'VIEWER', since: expect.any(Date), addedByUserId: null },
    ]);
  });
  it('AC-1 / AC-9: unbound users are neither local members nor access sources', async () => {
    const user = await newUser();
    const p = await newProject('legacy-user');
    expect.soft(await listProjectMemberships(db, p.id, 'USER')).toEqual([]);
    expect(await userProjectRole(db, user.id, p.id)).toBeNull();
  });

  it('AC-2: developer membership provenance comes from its earliest project binding', async () => {
    const user = await newUser();
    const granter = await newUser();
    const p = await newProject('provenance');
    const first = await bind(USER(user.id), 'developer', p.id, { type: 'USER', id: granter.id });
    await bind(USER(user.id), 'viewer', p.id);
    expect(await listProjectMemberships(db, p.id, 'USER')).toEqual([
      { principalId: user.id, role: 'DEVELOPER', since: first.createdAt, addedByUserId: granter.id },
    ]);
  });

  it('AC-3 / AC-4 / AC-5: an unbound agent gains access through a viewer binding', async () => {
    const agent = await newAgent();
    const p = await newProject('legacy-agent');
    expect.soft(await listProjectMemberships(db, p.id, 'AGENT')).toEqual([]);
    expect.soft(await agentHasProjectAccess(db, agent.id, p.id)).toBe(false);
    await bind(AGENT(agent.id), 'viewer', p.id);
    expect(await agentHasProjectAccess(db, agent.id, p.id)).toBe(true);
  });

  it('AC-6: accessible user projects exclude unbound projects', async () => {
    const user = await newUser();
    await newProject('unbound');
    const p2 = await newProject('bound');
    await bind(USER(user.id), 'developer', p2.id);
    expect(await accessibleProjectIds(db, USER(user.id))).toEqual([p2.id]);
  });

  it('AC-7: access ids omit unbound users', async () => {
    await newUser();
    const viewer = await newUser();
    const p = await newProject('access');
    await bind(USER(viewer.id), 'viewer', p.id);
    expect(await principalIdsWithAccess(db, p.id, 'USER')).toEqual([viewer.id]);
  });

  it('AC-8: only enabled binding-backed project admins count', async () => {
    const enabled = await newUser();
    const disabled = await newUser({ disabled: true });
    await newUser();
    const p = await newProject('admins');
    await bind(USER(enabled.id), 'project-admin', p.id);
    await bind(USER(disabled.id), 'project-admin', p.id);
    expect(await countActiveProjectAdmins(db, p.id)).toBe(1);
  });

  it('AC-10 / AC-11: global developer binding applies only in a live project', async () => {
    const user = await newUser();
    const p = await newProject('live');
    await bind(USER(user.id), 'developer', null);
    expect(await userProjectRole(db, user.id, p.id)).toBe('DEVELOPER');
    await db.project.update({ where: { id: p.id }, data: { deletedAt: new Date() } });
    expect(await userProjectRole(db, user.id, p.id)).toBeNull();
  });

  it('AC-12: member HTTP listing contains only locally bound principals', async () => {
    const admin = await newUser();
    await newUser();
    const viewerAgent = await newAgent();
    await newAgent();
    const p = await newProject('members');
    await bind(USER(admin.id), 'project-admin', p.id);
    await bind(AGENT(viewerAgent.id), 'viewer', p.id);
    const token = await loginToken(moduleRef.getHttpServer(), admin.email);
    const response = await request(moduleRef.getHttpServer()).get(`/api/projects/${p.slug}/members?principals=all`)
      .auth(token, { type: 'bearer' }).expect(200);
    expect(data<{ records: { principalId: string }[] }>(response).records.map(row => row.principalId))
      .toEqual([admin.id, viewerAgent.id]);
  });

  it('AC-13: member chips contain only binding ids from local bindings', async () => {
    const admin = await newUser();
    const user = await newUser();
    const p = await newProject('chips');
    await bind(USER(admin.id), 'project-admin', p.id);
    const binding = await bind(USER(user.id), 'viewer', p.id);
    const token = await loginToken(moduleRef.getHttpServer(), admin.email);
    const response = await request(moduleRef.getHttpServer()).get(`/api/projects/${p.slug}/members`)
      .auth(token, { type: 'bearer' }).expect(200);
    const member = data<{ records: { principalId: string; joinedAt: string; bindings: { id: string | null }[] }[] }>(response)
      .records.find(row => row.principalId === user.id);
    expect(member?.bindings.map(chip => chip.id)).toEqual([binding.id]);
    expect(member?.joinedAt).toBe(binding.createdAt.toISOString());
  });

  it('AC-14: project HTTP listing excludes unbound projects', async () => {
    const user = await newUser();
    await newProject('unbound-list');
    const p2 = await newProject('bound-list');
    await bind(USER(user.id), 'viewer', p2.id);
    const token = await loginToken(moduleRef.getHttpServer(), user.email);
    const response = await request(moduleRef.getHttpServer()).get('/api/projects')
      .auth(token, { type: 'bearer' }).expect(200);
    expect(data<{ slug: string }[]>(response).map(row => row.slug)).toEqual([p2.slug]);
  });

  it('an unbound agent joins the project through a viewer binding', async () => {
    // Permissions P1 US-003: the roster POST and the members PATCH are gone. Adding the agent is a
    // viewer binding on `/role-bindings`.
    const admin = await newUser();
    const agent = await newAgent();
    const p = await newProject('legacy-writes');
    await bind(USER(admin.id), 'project-admin', p.id);
    const token = await loginToken(moduleRef.getHttpServer(), admin.email);
    await request(moduleRef.getHttpServer()).post('/api/role-bindings')
      .auth(token, { type: 'bearer' })
      .send({ principalType: 'AGENT', principalId: agent.id, roleKey: 'viewer', projectId: p.id })
      .expect(201);
    expect(await db.roleBinding.count({
      where: { principalType: 'AGENT', principalId: agent.id, projectId: p.id },
    })).toBe(1);
  });

});
