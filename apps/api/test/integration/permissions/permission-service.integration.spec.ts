/**
 * Permissions P1a US-003 — PermissionService against real Postgres (AC-1 .. AC-15).
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/permissions/permission-service.integration.spec.ts
 */
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { AppModule } from '../../../src/app.module';
import type { KodaPrincipal } from '../../../src/auth/principal/koda-principal.types';
import { MembershipService } from '../../../src/permissions/membership.service';
import { PermissionService } from '../../../src/permissions/permission.service';
import { resetDb } from '../../helpers/reset-db';
import { expectGuardActive, fixtureDb, withTestActor } from '../../helpers/action-context';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('PermissionService (PG)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaClient;
  let permissions: PermissionService;
  let membership: MembershipService;
  let counter = 0;

  const SYSTEM = { type: 'SYSTEM' as const, id: 'test' };
  const userPrincipal = (id: string): KodaPrincipal =>
    ({ actorType: 'user', id, role: 'MEMBER', email: `${id}@koda.test` }) as KodaPrincipal;
  const agentPrincipal = (id: string): KodaPrincipal => ({ actorType: 'agent', id }) as unknown as KodaPrincipal;

  const newUser = async () => {
    counter += 1;
    return prisma.user.create({
      data: { email: `u${counter}@koda.test`, name: `U${counter}`, passwordHash: 'x' },
    });
  };
  const newAgent = async () => {
    counter += 1;
    return prisma.agent.create({ data: { name: `A${counter}`, slug: `a${counter}`, apiKeyHash: `hash-${counter}` } });
  };
  const newProject = async () => {
    counter += 1;
    return prisma.project.create({ data: { name: `P${counter}`, slug: `p${counter}`, key: `P${counter}` } });
  };
  const bind = (principalType: 'USER' | 'AGENT', principalId: string, roleKey: string, projectId: string | null) =>
    // Fixture grants run as `SYSTEM/seed`, the context the fixture client writes under.
    withTestActor({ type: 'SYSTEM', id: 'seed' }, () =>
      membership.createBinding({ principal: { type: principalType, id: principalId }, roleKey, projectId }, SYSTEM));

  beforeAll(async () => {
    await resetDb();
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await moduleRef.init();
    prisma = fixtureDb(moduleRef);
    permissions = moduleRef.get(PermissionService);
    membership = moduleRef.get(MembershipService);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(async () => {
    await prisma.roleBinding.deleteMany({});
    await prisma.agent.deleteMany({});
    await prisma.user.deleteMany({});
    await prisma.project.deleteMany({});
  });

  it('writes need an action context', async () => {
    await expect(expectGuardActive(moduleRef)).resolves.toBeUndefined();
  });

  it('AC-1: a developer binding in p1 grants ticket.create', async () => {
    const [user, p1] = [await newUser(), await newProject()];
    await bind('USER', user.id, 'developer', p1.id);
    expect(await permissions.can(userPrincipal(user.id), 'ticket.create', { projectId: p1.id })).toEqual({
      allowed: true,
      reason: 'granted',
    });
  });

  it('AC-2: a developer cannot ticket.delete', async () => {
    const [user, p1] = [await newUser(), await newProject()];
    await bind('USER', user.id, 'developer', p1.id);
    expect(await permissions.can(userPrincipal(user.id), 'ticket.delete', { projectId: p1.id })).toEqual({
      allowed: false,
      reason: 'not-granted',
    });
  });

  it('AC-3: the p1 binding grants nothing in p2', async () => {
    const [user, p1, p2] = [await newUser(), await newProject(), await newProject()];
    await bind('USER', user.id, 'developer', p1.id);
    expect((await permissions.can(userPrincipal(user.id), 'ticket.create', { projectId: p2.id })).allowed).toBe(false);
  });

  it('AC-4: a projectId-null reviewer binding applies in a project the agent has no binding in', async () => {
    const [agent, p2] = [await newAgent(), await newProject()];
    await bind('AGENT', agent.id, 'reviewer', null);
    expect(
      (await permissions.can(agentPrincipal(agent.id), 'ticket.transition.close', { projectId: p2.id })).allowed,
    ).toBe(true);
  });

  it('AC-5: a projectId-null admin binding grants user.create', async () => {
    const user = await newUser();
    await bind('USER', user.id, 'admin', null);
    expect((await permissions.can(userPrincipal(user.id), 'user.create')).allowed).toBe(true);
  });

  it('AC-6: an admin without an owner binding is denied role.binding.owner', async () => {
    const user = await newUser();
    await bind('USER', user.id, 'admin', null);
    expect((await permissions.can(userPrincipal(user.id), 'role.binding.owner')).allowed).toBe(false);
  });

  it('AC-7: user with no bindings grants nothing', async () => {
    const user = await newUser();
    expect(await permissions.can(userPrincipal(user.id), 'user.create')).toEqual({ allowed: false, reason: 'not-granted' });
  });

  it('AC-8: notification.read is implicit', async () => {
    const user = await newUser();
    expect(await permissions.can(userPrincipal(user.id), 'notification.read')).toEqual({
      allowed: true,
      reason: 'implicit',
    });
  });

  it('AC-9: a project key with an empty context is no-project', async () => {
    const user = await newUser();
    expect(await permissions.can(userPrincipal(user.id), 'ticket.create', {})).toEqual({
      allowed: false,
      reason: 'no-project',
    });
  });

  it('AC-10: an agent owner binding inserted directly is still principal-type for role.binding.owner', async () => {
    const agent = await newAgent();
    const owner = await prisma.role.findUniqueOrThrow({ where: { key: 'owner' } });
    await prisma.roleBinding.create({
      data: { principalType: 'AGENT', principalId: agent.id, roleId: owner.id, projectId: null, grantedByType: 'SYSTEM', grantedById: 'test' },
    });
    expect(await permissions.can(agentPrincipal(agent.id), 'role.binding.owner')).toEqual({
      allowed: false,
      reason: 'principal-type',
    });
  });

  it('AC-11: a runner principal is denied', async () => {
    const p1 = await newProject();
    const runner = { actorType: 'runner', id: 'r1' } as unknown as KodaPrincipal;
    expect((await permissions.can(runner, 'ticket.read', { projectId: p1.id })).allowed).toBe(false);
  });

  describe('own keys', () => {
    it('AC-12/13/14: comment.update.own depends on the resource creator', async () => {
      const [user, other, p1] = [await newUser(), await newUser(), await newProject()];
      await bind('USER', user.id, 'viewer', p1.id);
      const principal = userPrincipal(user.id);

      expect(
        (await permissions.can(principal, 'comment.update', { projectId: p1.id, resource: { createdBy: { type: 'USER', id: user.id } } })).allowed,
      ).toBe(true);
      expect(
        await permissions.can(principal, 'comment.update', { projectId: p1.id, resource: { createdBy: { type: 'USER', id: other.id } } }),
      ).toEqual({ allowed: false, reason: 'not-owner' });
      expect((await permissions.can(principal, 'comment.update', { projectId: p1.id })).reason).toBe('not-owner');
    });
  });

  it('AC-15: after removeBinding the next identical can call is denied', async () => {
    const [user, p1] = [await newUser(), await newProject()];
    const binding = await bind('USER', user.id, 'developer', p1.id);
    const principal = userPrincipal(user.id);

    expect((await permissions.can(principal, 'ticket.create', { projectId: p1.id })).allowed).toBe(true);
    // A route-reached write, called here as the fixture setup step it is: `SYSTEM/seed`.
    await withTestActor({ type: 'SYSTEM', id: 'seed' }, () => membership.removeBinding(binding.id));
    expect((await permissions.can(principal, 'ticket.create', { projectId: p1.id })).allowed).toBe(false);
  });
});
