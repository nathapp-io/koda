/**
 * Permissions P1 US-001 — the seeded project roles keep the project's secret and invitation reads
 * admin-only, against real Postgres (AC-15 .. AC-21).
 *
 * The seed is observed through the real bootstrap: `resetDb()` empties every table, then
 * `moduleRef.init()` runs `SystemRoleSeeder.onApplicationBootstrap`, so `PermissionService.can`
 * answers from the entries a fresh database actually holds.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/permissions/core-seeded-roles.integration.spec.ts
 */
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { AppModule } from '../../../src/app.module';
import type { KodaPrincipal } from '../../../src/auth/principal/koda-principal.types';
import { MembershipService } from '../../../src/permissions/membership.service';
import { PermissionService } from '../../../src/permissions/permission.service';
import { expectBindingOnlyFixtures, grantBaseline } from '../../../src/permissions/test-helpers/permission-fixtures';
import { resetDb } from '../../helpers/reset-db';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('seeded project roles and the secret and invitation reads (PG)', () => {
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

  /** A user whose only source in a fresh project is one binding of `roleKey`. */
  const memberWithRole = async (
    roleKey: string,
  ): Promise<{ principal: KodaPrincipal; projectId: string }> => {
    const [user, project] = [await newUser(), await newProject()];
    await membership.createBinding({ principal: { type: 'USER', id: user.id }, roleKey, projectId: project.id }, SYSTEM);
    return { principal: userPrincipal(user.id), projectId: project.id };
  };

  const allowedIn = async (principal: KodaPrincipal, key: string, projectId: string): Promise<boolean> =>
    (await permissions.can(principal, key, { projectId })).allowed;

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
    await prisma.agent.deleteMany({});
    await prisma.user.deleteMany({});
    await prisma.project.deleteMany({});
  });

  it('fixtures grant through bindings only', async () => {
    const user = await newUser();

    await expectBindingOnlyFixtures(prisma, [{ type: 'USER', id: user.id }]);
  });

  it('AC-15: a developer cannot read the project CI token', async () => {
    const { principal, projectId } = await memberWithRole('developer');

    expect(await permissions.can(principal, 'project.ci-token.read', { projectId })).toEqual({
      allowed: false,
      reason: 'not-granted',
    });
  });

  it('AC-16: a developer cannot read the project invitations', async () => {
    const { principal, projectId } = await memberWithRole('developer');

    expect(await permissions.can(principal, 'invite.read', { projectId })).toEqual({
      allowed: false,
      reason: 'not-granted',
    });
  });

  it('AC-17: a developer still reads tickets in the project', async () => {
    const { principal, projectId } = await memberWithRole('developer');

    await expect(allowedIn(principal, 'ticket.read', projectId)).resolves.toBe(true);
  });

  it('AC-18: a viewer cannot read the project CI token', async () => {
    const { principal, projectId } = await memberWithRole('viewer');

    await expect(allowedIn(principal, 'project.ci-token.read', projectId)).resolves.toBe(false);
  });

  it('AC-19: a viewer cannot read the project invitations', async () => {
    const { principal, projectId } = await memberWithRole('viewer');

    await expect(allowedIn(principal, 'invite.read', projectId)).resolves.toBe(false);
  });

  it('AC-20: a project-admin reads the project CI token', async () => {
    const { principal, projectId } = await memberWithRole('project-admin');

    await expect(allowedIn(principal, 'project.ci-token.read', projectId)).resolves.toBe(true);
  });

  it('AC-21: a project-admin reads the project invitations', async () => {
    const { principal, projectId } = await memberWithRole('project-admin');

    await expect(allowedIn(principal, 'invite.read', projectId)).resolves.toBe(true);
  });
});
