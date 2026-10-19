/**
 * Permissions P1 US-002 — the legacy rows and the baseline fallback count in `PermissionService.can`
 * (AC-1 .. AC-22), against real Postgres.
 *
 * Every fixture writes the legacy row (`ProjectMember`, `AgentProject`, `AgentRoleEntry`) directly, as
 * the compatibility surface does, and no `RoleBinding` unless the AC names one: the union is observed
 * through the same `can` call a route makes.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/permissions/core-legacy-union.integration.spec.ts
 */
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { AppModule } from '../../../src/app.module';
import type { KodaPrincipal } from '../../../src/auth/principal/koda-principal.types';
import { AUTH_CFG, IAuthConfig } from '../../../src/config/auth.config';
import { MembershipService } from '../../../src/permissions/membership.service';
import { PermissionCache } from '../../../src/permissions/permission-cache';
import { PermissionService } from '../../../src/permissions/permission.service';
import { PrismaRoleBindingRepository } from '../../../src/permissions/prisma-role-binding.repository';
import { PrismaRoleRepository } from '../../../src/permissions/prisma-role.repository';
import { resetDb } from '../../helpers/reset-db';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('PermissionService legacy union and baseline (PG)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaClient;
  let permissions: PermissionService;
  let membership: MembershipService;
  let counter = 0;

  const SYSTEM = { type: 'SYSTEM' as const, id: 'test' };
  const userPrincipal = (id: string): KodaPrincipal =>
    ({ actorType: 'user', id, role: 'MEMBER', email: `${id}@koda.test` }) as KodaPrincipal;
  const agentPrincipal = (id: string): KodaPrincipal => ({ actorType: 'agent', id }) as unknown as KodaPrincipal;

  const newUser = async (role: 'MEMBER' | 'ADMIN' = 'MEMBER') => {
    counter += 1;
    return prisma.user.create({
      data: { email: `lu${counter}@koda.test`, name: `LU${counter}`, passwordHash: 'x', role },
    });
  };
  const newAgent = async () => {
    counter += 1;
    return prisma.agent.create({ data: { name: `LA${counter}`, slug: `la${counter}`, apiKeyHash: `hash-${counter}` } });
  };
  const newProject = async () => {
    counter += 1;
    return prisma.project.create({ data: { name: `LP${counter}`, slug: `lp${counter}`, key: `LP${counter}` } });
  };

  /** The legacy membership row a project member has today. */
  const legacyMember = (projectId: string, userId: string, role: string) =>
    prisma.projectMember.create({ data: { projectId, userId, role } });
  /** The legacy roster row that puts an agent on a project. */
  const roster = (agentId: string, projectId: string) => prisma.agentProject.create({ data: { agentId, projectId } });
  /** The legacy role an agent holds globally (DEVELOPER | REVIEWER | VERIFIER | TRIAGER). */
  const agentRole = (agentId: string, role: string) => prisma.agentRoleEntry.create({ data: { agentId, role } });
  const bind = (
    principalType: 'USER' | 'AGENT',
    principalId: string,
    roleKey: string,
    projectId: string | null = null,
  ) => membership.createBinding({ principal: { type: principalType, id: principalId }, roleKey, projectId }, SYSTEM);

  const allowedIn = async (principal: KodaPrincipal, key: string, projectId: string): Promise<boolean> =>
    (await permissions.can(principal, key, { projectId })).allowed;

  /**
   * A second `PermissionService` over the module's repositories and cache, with agent project scoping
   * turned off — the `AGENT_PROJECT_SCOPING=off` installation AC-14 describes.
   */
  const unscopedPermissions = (): PermissionService =>
    new PermissionService(
      moduleRef.get(PrismaRoleRepository, { strict: false }),
      moduleRef.get(PrismaRoleBindingRepository, { strict: false }),
      moduleRef.get(PermissionCache, { strict: false }),
      { ...moduleRef.get<IAuthConfig>(AUTH_CFG, { strict: false }), agentProjectScoping: false },
    );

  beforeAll(async () => {
    await resetDb();
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    // Runs SystemRoleSeeder.onApplicationBootstrap on the reset database.
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService<PrismaClient>, { strict: false }).client as PrismaClient;
    permissions = moduleRef.get(PermissionService);
    membership = moduleRef.get(MembershipService);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(async () => {
    await prisma.roleBinding.deleteMany({});
    await prisma.agentRoleEntry.deleteMany({});
    await prisma.agentProject.deleteMany({});
    await prisma.agent.deleteMany({});
    await prisma.projectMember.deleteMany({});
    await prisma.user.deleteMany({});
    await prisma.project.deleteMany({});
  });

  it('AC-1: a legacy DEVELOPER row grants ticket.create in the project', async () => {
    const [user, p1] = [await newUser(), await newProject()];
    await legacyMember(p1.id, user.id, 'DEVELOPER');

    expect(await permissions.can(userPrincipal(user.id), 'ticket.create', { projectId: p1.id })).toEqual({
      allowed: true,
      reason: 'granted',
    });
  });

  it('AC-2: a legacy VIEWER row refuses ticket.create', async () => {
    const [user, p1] = [await newUser(), await newProject()];
    await legacyMember(p1.id, user.id, 'VIEWER');

    expect(await permissions.can(userPrincipal(user.id), 'ticket.create', { projectId: p1.id })).toEqual({
      allowed: false,
      reason: 'not-granted',
    });
  });

  it('AC-3: a legacy VIEWER row grants comment.create', async () => {
    const [user, p1] = [await newUser(), await newProject()];
    await legacyMember(p1.id, user.id, 'VIEWER');

    await expect(allowedIn(userPrincipal(user.id), 'comment.create', p1.id)).resolves.toBe(true);
  });

  it('AC-4: a legacy ADMIN row grants ticket.delete', async () => {
    const [user, p1] = [await newUser(), await newProject()];
    await legacyMember(p1.id, user.id, 'ADMIN');

    await expect(allowedIn(userPrincipal(user.id), 'ticket.delete', p1.id)).resolves.toBe(true);
  });

  it('AC-5: a legacy stored role AGENT grants comment.create', async () => {
    const [user, p1] = [await newUser(), await newProject()];
    await legacyMember(p1.id, user.id, 'AGENT');

    await expect(allowedIn(userPrincipal(user.id), 'comment.create', p1.id)).resolves.toBe(true);
  });

  it('AC-6: a legacy stored role AGENT refuses ticket.create', async () => {
    const [user, p1] = [await newUser(), await newProject()];
    await legacyMember(p1.id, user.id, 'AGENT');

    await expect(allowedIn(userPrincipal(user.id), 'ticket.create', p1.id)).resolves.toBe(false);
  });

  it('AC-7: a legacy DEVELOPER row in p1 grants nothing in p2', async () => {
    const [user, p1, p2] = [await newUser(), await newProject(), await newProject()];
    await legacyMember(p1.id, user.id, 'DEVELOPER');

    expect(await permissions.can(userPrincipal(user.id), 'ticket.create', { projectId: p2.id })).toEqual({
      allowed: false,
      reason: 'not-granted',
    });
  });

  it('AC-8: a legacy roster row without an AgentRoleEntry grants comment.create', async () => {
    const [agent, p1] = [await newAgent(), await newProject()];
    await roster(agent.id, p1.id);

    await expect(allowedIn(agentPrincipal(agent.id), 'comment.create', p1.id)).resolves.toBe(true);
  });

  it('AC-9: a legacy roster row without an AgentRoleEntry refuses ticket.create', async () => {
    const [agent, p1] = [await newAgent(), await newProject()];
    await roster(agent.id, p1.id);

    expect(await permissions.can(agentPrincipal(agent.id), 'ticket.create', { projectId: p1.id })).toEqual({
      allowed: false,
      reason: 'not-granted',
    });
  });

  it('AC-10: a roster row and an AgentRoleEntry DEVELOPER grant ticket.create', async () => {
    const [agent, p1] = [await newAgent(), await newProject()];
    await roster(agent.id, p1.id);
    await agentRole(agent.id, 'DEVELOPER');

    await expect(allowedIn(agentPrincipal(agent.id), 'ticket.create', p1.id)).resolves.toBe(true);
  });

  it('AC-11: a roster row and an AgentRoleEntry DEVELOPER refuse ticket.delete', async () => {
    const [agent, p1] = [await newAgent(), await newProject()];
    await roster(agent.id, p1.id);
    await agentRole(agent.id, 'DEVELOPER');

    await expect(allowedIn(agentPrincipal(agent.id), 'ticket.delete', p1.id)).resolves.toBe(false);
  });

  it('AC-12: a viewer binding plus an AgentRoleEntry DEVELOPER grants ticket.create', async () => {
    const [agent, p1] = [await newAgent(), await newProject()];
    await bind('AGENT', agent.id, 'viewer', p1.id);
    await agentRole(agent.id, 'DEVELOPER');

    await expect(allowedIn(agentPrincipal(agent.id), 'ticket.create', p1.id)).resolves.toBe(true);
  });

  it('AC-13: an AgentRoleEntry REVIEWER with no source in p2 refuses ticket.transition.close there', async () => {
    const [agent, p2] = [await newAgent(), await newProject()];
    await agentRole(agent.id, 'REVIEWER');

    expect(await permissions.can(agentPrincipal(agent.id), 'ticket.transition.close', { projectId: p2.id })).toEqual({
      allowed: false,
      reason: 'not-granted',
    });
  });

  it('AC-14: with agent project scoping off, an AgentRoleEntry DEVELOPER grants ticket.create in p2', async () => {
    const [agent, p2] = [await newAgent(), await newProject()];
    await agentRole(agent.id, 'DEVELOPER');

    // Scoping on (the module's own service): the agent has no source in p2, so the role grants nothing.
    await expect(allowedIn(agentPrincipal(agent.id), 'ticket.create', p2.id)).resolves.toBe(false);
    // The two services share the module's cache: drop the denied entry so the unscoped one recomputes.
    await membership.invalidatePermissions();
    await expect(
      unscopedPermissions().can(agentPrincipal(agent.id), 'ticket.create', { projectId: p2.id }),
    ).resolves.toEqual({ allowed: true, reason: 'granted' });
  });

  it('AC-15: a user with no binding and no legacy row holds agent.read from the baseline', async () => {
    const user = await newUser();

    expect(await permissions.can(userPrincipal(user.id), 'agent.read')).toEqual({ allowed: true, reason: 'granted' });
  });

  it('AC-16: a user with no binding and no legacy row is refused project.create', async () => {
    const user = await newUser();

    expect(await permissions.can(userPrincipal(user.id), 'project.create')).toEqual({
      allowed: false,
      reason: 'not-granted',
    });
  });

  it('AC-17: an agent with no binding and no legacy row holds agent.read from the baseline', async () => {
    const agent = await newAgent();

    expect(await permissions.can(agentPrincipal(agent.id), 'agent.read')).toEqual({ allowed: true, reason: 'granted' });
  });

  it('AC-18: a roster row and an AgentRoleEntry TRIAGER grant ticket.label.assign', async () => {
    const [agent, p1] = [await newAgent(), await newProject()];
    await roster(agent.id, p1.id);
    await agentRole(agent.id, 'TRIAGER');

    await expect(allowedIn(agentPrincipal(agent.id), 'ticket.label.assign', p1.id)).resolves.toBe(true);
  });

  it('AC-19: a roster row and an AgentRoleEntry TRIAGER refuse ticket.create', async () => {
    const [agent, p1] = [await newAgent(), await newProject()];
    await roster(agent.id, p1.id);
    await agentRole(agent.id, 'TRIAGER');

    await expect(allowedIn(agentPrincipal(agent.id), 'ticket.create', p1.id)).resolves.toBe(false);
  });

  it('AC-20: a roster row and an AgentRoleEntry VERIFIER grant ticket.transition.verify', async () => {
    const [agent, p1] = [await newAgent(), await newProject()];
    await roster(agent.id, p1.id);
    await agentRole(agent.id, 'VERIFIER');

    await expect(allowedIn(agentPrincipal(agent.id), 'ticket.transition.verify', p1.id)).resolves.toBe(true);
  });

  it('AC-21: a roster row and an AgentRoleEntry VERIFIER refuse ticket.transition.start', async () => {
    const [agent, p1] = [await newAgent(), await newProject()];
    await roster(agent.id, p1.id);
    await agentRole(agent.id, 'VERIFIER');

    await expect(allowedIn(agentPrincipal(agent.id), 'ticket.transition.start', p1.id)).resolves.toBe(false);
  });

  it('AC-22: invalidating after an AgentRoleEntry write makes the next can call see the new role', async () => {
    const [agent, p1] = [await newAgent(), await newProject()];
    await roster(agent.id, p1.id);
    const principal = agentPrincipal(agent.id);

    expect(await permissions.can(principal, 'ticket.create', { projectId: p1.id })).toEqual({
      allowed: false,
      reason: 'not-granted',
    });

    await agentRole(agent.id, 'DEVELOPER');
    // The decision is cached under the `permissions` tag, so the new row is invisible until the cache
    // is dropped: that is the behaviour `invalidatePermissions` exists to break.
    await expect(allowedIn(principal, 'ticket.create', p1.id)).resolves.toBe(false);
    await membership.invalidatePermissions();

    expect(await permissions.can(principal, 'ticket.create', { projectId: p1.id })).toEqual({
      allowed: true,
      reason: 'granted',
    });
  });
});
