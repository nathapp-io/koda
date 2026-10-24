import { canRunDbTests } from '../../helpers/test-environment';
/**
 * Permissions P1d US-001 — the catalog and seed changes and `projectIdsWithKey`, against real
 * Postgres (AC-15 .. AC-22).
 *
 * The seed is observed through the real bootstrap: `resetDb()` empties every table, then
 * `moduleRef.init()` runs `SystemRoleSeeder.onApplicationBootstrap`, so `PermissionService.can` and
 * `projectIdsWithKey` answer from the entries a fresh database actually holds.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/permissions/enforce-fleet-foundations.integration.spec.ts
 */
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { AppModule } from '../../../src/app.module';
import type { KodaPrincipal } from '../../../src/auth/principal/koda-principal.types';
import { MembershipService } from '../../../src/permissions/membership.service';
import { PermissionService } from '../../../src/permissions/permission.service';
import { expectBindingOnlyFixtures, grantBaseline } from '../../../src/permissions/test-helpers/permission-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { expectGuardActive, fixtureDb, withTestActor } from '../../helpers/action-context';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;

describeIntegration('enforce-fleet foundations (PG)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaClient;
  let permissions: PermissionService;
  let membership: MembershipService;
  let counter = 0;

  const SYSTEM = { type: 'SYSTEM' as const, id: 'test' };
  const userPrincipal = (id: string): KodaPrincipal =>
    ({ actorType: 'user', id, role: 'MEMBER', email: `${id}@koda.test` }) as KodaPrincipal;

  const newUser = async () => {
    counter += 1;
    const user = await prisma.user.create({
      data: { email: `u${counter}@koda.test`, name: `U${counter}`, passwordHash: 'x' },
    });
    // The baseline binding production writes on a user create, so the fixture holds no legacy grant.
    await grantBaseline(prisma, { type: 'USER', id: user.id });
    return user;
  };
  const newProject = async () => {
    counter += 1;
    return prisma.project.create({ data: { name: `P${counter}`, slug: `p${counter}`, key: `P${counter}` } });
  };
  const bind = (principal: { id: string }, roleKey: string, projectId: string | null) =>
    withTestActor({ type: 'SYSTEM', id: 'seed' }, () =>
      membership.createBinding({ principal: { type: 'USER', id: principal.id }, roleKey, projectId }, SYSTEM));

  /** A user with one binding in a fresh project: the only source of the principal's keys there. */
  const userBoundIn = async (
    roleKey: string,
  ): Promise<{ user: { id: string }; principal: KodaPrincipal; projectId: string }> => {
    const [user, project] = [await newUser(), await newProject()];
    await bind(user, roleKey, project.id);
    return { user, principal: userPrincipal(user.id), projectId: project.id };
  };

  beforeAll(async () => {
    await resetDb();
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    // Runs SystemRoleSeeder.onApplicationBootstrap on the reset database.
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

  it('fixtures grant through bindings only', async () => {
    const user = await newUser();

    await expectBindingOnlyFixtures(prisma, [{ type: 'USER', id: user.id }]);
  });

  it('AC-15: a binding-only developer is not-owner of fleet.schedule.update without a resource', async () => {
    const { principal, projectId } = await userBoundIn('developer');

    expect(await permissions.can(principal, 'fleet.schedule.update', { projectId })).toEqual({
      allowed: false,
      reason: 'not-owner',
    });
  });

  it('AC-16: the same developer owns the schedule it created', async () => {
    const { user, principal, projectId } = await userBoundIn('developer');

    expect(
      await permissions.can(principal, 'fleet.schedule.update', {
        projectId,
        resource: { createdBy: { type: 'USER', id: user.id } },
      }),
    ).toEqual({ allowed: true, reason: 'granted' });
  });

  it('AC-17: a binding-only developer holds fleet.repo.drift.check', async () => {
    const { principal, projectId } = await userBoundIn('developer');

    expect(await permissions.can(principal, 'fleet.repo.drift.check', { projectId })).toEqual({
      allowed: true,
      reason: 'granted',
    });
  });

  it('AC-18: a binding-only developer holds fleet.activity.read in the project', async () => {
    const { principal, projectId } = await userBoundIn('developer');

    expect(await permissions.can(principal, 'fleet.activity.read', { projectId })).toEqual({
      allowed: true,
      reason: 'granted',
    });
  });

  it('AC-19: a binding-only project admin deletes any schedule of the project', async () => {
    const { principal, projectId } = await userBoundIn('project-admin');

    expect(await permissions.can(principal, 'fleet.schedule.delete', { projectId })).toEqual({
      allowed: true,
      reason: 'granted',
    });
  });

  it('AC-20: projectIdsWithKey lists only the project where the developer holds fleet.activity.read', async () => {
    const [user, p1] = [await newUser(), await newProject()];
    await newProject();
    await bind(user, 'developer', p1.id);

    expect(await permissions.projectIdsWithKey(userPrincipal(user.id), 'fleet.activity.read')).toEqual({
      all: false,
      projectIds: [p1.id],
    });
  });

  it('AC-21: projectIdsWithKey keeps only the project where the key is held', async () => {
    const [user, p1, p2] = [await newUser(), await newProject(), await newProject()];
    await bind(user, 'viewer', p1.id);
    await bind(user, 'developer', p2.id);

    expect(await permissions.projectIdsWithKey(userPrincipal(user.id), 'fleet.job.dispatch')).toEqual({
      all: false,
      projectIds: [p2.id],
    });
  });

  it('AC-22: a global admin holds the key everywhere', async () => {
    const user = await newUser();
    await newProject();
    await bind(user, 'admin', null);

    expect(await permissions.projectIdsWithKey(userPrincipal(user.id), 'fleet.activity.read')).toEqual({
      all: true,
    });
  });

  it('projectIdsWithKey answers a runner no project', async () => {
    const runner = { actorType: 'runner', id: 'r1' } as unknown as KodaPrincipal;

    expect(await permissions.projectIdsWithKey(runner, 'fleet.activity.read')).toEqual({
      all: false,
      projectIds: [],
    });
  });

  it('a caller in no project gets no project', async () => {
    const user = await newUser();
    await newProject();

    expect(await permissions.projectIdsWithKey(userPrincipal(user.id), 'fleet.activity.read')).toEqual({
      all: false,
      projectIds: [],
    });
  });
});
