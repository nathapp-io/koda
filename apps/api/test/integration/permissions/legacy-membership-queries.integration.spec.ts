/**
 * Permissions P1b US-001 — the compatibility queries and the scoped binding removal against real
 * Postgres (AC-3 .. AC-14).
 *
 * Every source is a real row, created through the app's own `MembershipService.createBinding` where it
 * is a binding; booting `AppModule` runs `SystemRoleSeeder`, so a seeded role key can be named. The
 * legacy rows are inserted directly, which is what a pre-bindings installation looks like.
 *
 * Run: cd apps/api && bun run test:db:up &&
 *      bun run test:scoped test/integration/permissions/legacy-membership-queries.integration.spec.ts
 */
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { AppModule } from '../../../src/app.module';
import type { KodaPrincipal } from '../../../src/auth/principal/koda-principal.types';
import {
  accessibleProjectIds,
  agentHasProjectAccess,
  countActiveProjectAdmins,
  listProjectMemberships,
  localProjectRole,
  principalIdsWithAccess,
  userProjectRole,
} from '../../../src/permissions/legacy-membership.queries';
import { MembershipService } from '../../../src/permissions/membership.service';
import { PermissionService } from '../../../src/permissions/permission.service';
import type { Granter, PrincipalRef } from '../../../src/permissions/permissions.types';
import { resetDb } from '../../helpers/reset-db';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('legacy membership queries (US-001, PG)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService<PrismaClient>;
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
    role: string;
    email: string;
  }): KodaPrincipal => ({
    actorType: 'user',
    id: user.id,
    name: user.name,
    role: user.role as 'MEMBER' | 'ADMIN',
    email: user.email,
    authorities: [],
    blacklisted: false,
    revoked: false,
  });

  const newUser = (options: { disabled?: boolean } = {}) => {
    counter += 1;
    return db.user.create({
      data: {
        email: `u${counter}@koda.test`,
        name: `U${counter}`,
        passwordHash: 'not-a-real-hash',
        disabled: options.disabled ?? false,
      },
    });
  };

  const newAgent = () => {
    counter += 1;
    return db.agent.create({
      data: { name: `agent-${counter}`, slug: `agent-${counter}`, apiKeyHash: `hash-${counter}` },
    });
  };

  const newProject = (label: string) => {
    counter += 1;
    return db.project.create({ data: { name: label, slug: `${label}-${counter}`, key: `K${counter}` } });
  };

  const bind = (principal: PrincipalRef, roleKey: string, projectId: string | null, by: Granter = SYSTEM) =>
    membership.createBinding({ principal, roleKey, projectId }, by);

  const addLegacyMember = (projectId: string, userId: string, role: string, joinedAt?: Date) =>
    db.projectMember.create({ data: { projectId, userId, role, ...(joinedAt === undefined ? {} : { joinedAt }) } });

  const addRosterRow = (
    projectId: string,
    agentId: string,
    options: { addedById?: string | null; createdAt?: Date } = {},
  ) =>
    db.agentProject.create({
      data: {
        projectId,
        agentId,
        addedById: options.addedById ?? null,
        ...(options.createdAt === undefined ? {} : { createdAt: options.createdAt }),
      },
    });

  const bindingsOf = (principal: PrincipalRef) =>
    db.roleBinding.findMany({
      where: { principalType: principal.type, principalId: principal.id },
      include: { role: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });

  beforeAll(async () => {
    await resetDb();
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService<PrismaClient>, { strict: false });
    db = prisma.client as PrismaClient;
    membership = moduleRef.get(MembershipService);
    permissions = moduleRef.get(PermissionService);
  }, 30_000);

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(async () => {
    await db.roleBinding.deleteMany({});
    await db.projectMember.deleteMany({});
    await db.agentProject.deleteMany({});
    await db.project.deleteMany({});
    await db.agent.deleteMany({});
    await db.user.deleteMany({});
  });

  it('AC-3: a user whose only source in p1 is a developer binding answers DEVELOPER', async () => {
    const user = await newUser();
    const p1 = await newProject('p1');
    await bind(USER(user.id), 'developer', p1.id);

    expect(await db.projectMember.count({ where: { projectId: p1.id, userId: user.id } })).toBe(0);
    expect(await userProjectRole(prisma.client, user.id, p1.id)).toBe('DEVELOPER');
  });

  it('AC-4: the strongest of a legacy VIEWER row and a project-admin binding is ADMIN', async () => {
    const user = await newUser();
    const p1 = await newProject('p1');
    await addLegacyMember(p1.id, user.id, 'VIEWER');
    await bind(USER(user.id), 'project-admin', p1.id);

    expect(await userProjectRole(prisma.client, user.id, p1.id)).toBe('ADMIN');
  });

  it('AC-5: a projectId-null binding is an access source but never a local one', async () => {
    const user = await newUser();
    const p2 = await newProject('p2');
    await bind(USER(user.id), 'reviewer', null);

    expect(await userProjectRole(prisma.client, user.id, p2.id)).toBe('VIEWER');
    expect(await localProjectRole(prisma.client, USER(user.id), p2.id)).toBeNull();
  });

  it('AC-6: a GLOBAL-scope binding is no source at all', async () => {
    const user = await newUser();
    const p1 = await newProject('p1');
    await bind(USER(user.id), 'admin', null);

    expect(await userProjectRole(prisma.client, user.id, p1.id)).toBeNull();
  });

  it('AC-7: an agent with a viewer binding has project access, an unknown project does not', async () => {
    const agent = await newAgent();
    const p1 = await newProject('p1');
    await bind(AGENT(agent.id), 'viewer', p1.id);

    expect(await agentHasProjectAccess(prisma.client, agent.id, p1.id)).toBe(true);
    expect(await agentHasProjectAccess(prisma.client, agent.id, 'no-such-project')).toBe(false);
  });

  it('AC-8: accessible project ids union the roster row and the bindings, minus soft-deleted projects', async () => {
    const agent = await newAgent();
    const p1 = await newProject('p1');
    const p2 = await newProject('p2');
    const p3 = await newProject('p3');
    await addRosterRow(p1.id, agent.id);
    await bind(AGENT(agent.id), 'viewer', p2.id);
    await bind(AGENT(agent.id), 'viewer', p3.id);
    await db.project.update({ where: { id: p3.id }, data: { deletedAt: new Date() } });

    const ids = await accessibleProjectIds(prisma.client, AGENT(agent.id));

    expect(ids).toEqual([p1.id, p2.id].sort());
    expect(ids).toEqual([...ids].sort());
  });

  it('AC-9: a global project binding reaches every non-deleted project', async () => {
    const user = await newUser();
    const p1 = await newProject('p1');
    const p2 = await newProject('p2');
    const p3 = await newProject('p3');
    await bind(USER(user.id), 'developer', null);
    await db.project.update({ where: { id: p3.id }, data: { deletedAt: new Date() } });

    expect(await accessibleProjectIds(prisma.client, USER(user.id))).toEqual([p1.id, p2.id].sort());
  });

  it('AC-10: principal ids with access are the local sources plus the global project bindings', async () => {
    const p1 = await newProject('p1');
    const p2 = await newProject('p2');
    const legacy = await newUser();
    const bound = await newUser();
    const globally = await newUser();
    const globalAdmin = await newUser();
    const elsewhere = await newUser();
    await addLegacyMember(p1.id, legacy.id, 'VIEWER');
    await bind(USER(bound.id), 'viewer', p1.id);
    await bind(USER(globally.id), 'viewer', null);
    await bind(USER(globalAdmin.id), 'admin', null);
    await bind(USER(elsewhere.id), 'developer', p2.id);

    expect(await principalIdsWithAccess(prisma.client, p1.id, 'USER')).toEqual(
      [bound.id, globally.id, legacy.id].sort(),
    );
  });

  it('AC-11: a membership entry carries the earliest source date and its granter', async () => {
    const granter = await newUser();
    const otherGranter = await newUser();
    const p1 = await newProject('p1');
    const rosterOnlyGlobal = await newAgent();
    const agent = await newAgent();
    const joinedAt = new Date('2026-01-01T00:00:00.000Z');
    await addRosterRow(p1.id, agent.id, { addedById: granter.id, createdAt: joinedAt });
    // Granted by a different user, later: a membership read from the newest source would answer this
    // granter and this date instead of the roster row's.
    await bind(AGENT(agent.id), 'viewer', p1.id, { type: 'USER', id: otherGranter.id });
    await bind(AGENT(rosterOnlyGlobal.id), 'developer', null);

    const memberships = await listProjectMemberships(prisma.client, p1.id, 'AGENT');

    expect(memberships).toEqual([
      { principalId: agent.id, role: 'VIEWER', since: joinedAt, addedByUserId: granter.id },
    ]);
  });

  it('AC-12: the active project admins are the distinct non-disabled users holding ADMIN locally', async () => {
    const p1 = await newProject('p1');
    const a = await newUser();
    const b = await newUser();
    const c = await newUser();
    const d = await newUser({ disabled: true });
    await addLegacyMember(p1.id, a.id, 'ADMIN');
    await bind(USER(b.id), 'project-admin', p1.id);
    await addLegacyMember(p1.id, c.id, 'ADMIN');
    await bind(USER(c.id), 'project-admin', p1.id);
    await bind(USER(d.id), 'project-admin', p1.id);

    expect(await countActiveProjectAdmins(prisma.client, p1.id)).toBe(3);
  });

  it('AC-13: removeProjectBindings deletes the named role keys in one project and nothing else', async () => {
    const user = await newUser();
    const p1 = await newProject('p1');
    const p2 = await newProject('p2');
    await addLegacyMember(p1.id, user.id, 'DEVELOPER');
    await bind(USER(user.id), 'developer', p1.id);
    await bind(USER(user.id), 'reviewer', p1.id);
    await bind(USER(user.id), 'developer', p2.id);

    expect(await membership.removeProjectBindings(USER(user.id), p1.id, ['developer'])).toBe(1);

    const remaining = await bindingsOf(USER(user.id));
    expect(remaining.map((row) => [row.role.key, row.projectId])).toEqual([
      ['reviewer', p1.id],
      ['developer', p2.id],
    ]);
    expect(await db.projectMember.count({ where: { projectId: p1.id, userId: user.id } })).toBe(1);
  });

  it('AC-14: removing the only binding in p1 takes the project key away from the next check', async () => {
    const user = await newUser();
    const p1 = await newProject('p1');
    await bind(USER(user.id), 'developer', p1.id);
    const principal = userPrincipal(user);

    expect((await permissions.can(principal, 'ticket.create', { projectId: p1.id })).allowed).toBe(true);

    expect(await membership.removeProjectBindings(USER(user.id), p1.id)).toBe(1);

    expect((await permissions.can(principal, 'ticket.create', { projectId: p1.id })).allowed).toBe(false);
  });

  it('reads the sources from the database on every call, never from a cache', async () => {
    const user = await newUser();
    const p1 = await newProject('p1');
    await bind(USER(user.id), 'viewer', p1.id);
    expect(await userProjectRole(prisma.client, user.id, p1.id)).toBe('VIEWER');

    await bind(USER(user.id), 'project-admin', p1.id);

    expect(await userProjectRole(prisma.client, user.id, p1.id)).toBe('ADMIN');
  });

  it('keeps the two principal types apart for the same project', async () => {
    const user = await newUser();
    const agent = await newAgent();
    const p1 = await newProject('p1');
    await bind(USER(user.id), 'developer', p1.id);
    await bind(AGENT(agent.id), 'viewer', p1.id);

    expect(await principalIdsWithAccess(prisma.client, p1.id, 'USER')).toEqual([user.id]);
    expect(await principalIdsWithAccess(prisma.client, p1.id, 'AGENT')).toEqual([agent.id]);
    expect(await listProjectMemberships(prisma.client, p1.id, 'USER')).toEqual([
      { principalId: user.id, role: 'DEVELOPER', since: expect.any(Date), addedByUserId: null },
    ]);
    expect(await listProjectMemberships(prisma.client, p1.id, 'AGENT')).toEqual([
      { principalId: agent.id, role: 'VIEWER', since: expect.any(Date), addedByUserId: null },
    ]);
  });
});
