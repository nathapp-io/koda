/**
 * Permissions P1a US-002 — the Role and RoleBinding tables, their constraints, and the system-role
 * seeder against real Postgres.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/permissions/system-roles.integration.spec.ts
 */
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { ITransactionManager } from '@nathapp/nestjs-data';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { AppModule } from '../../../src/app.module';
import { UnknownPermissionEntryError } from '../../../src/permissions/entry-matcher';
import { PrismaRoleBindingRepository } from '../../../src/permissions/prisma-role-binding.repository';
import { PrismaRoleRepository } from '../../../src/permissions/prisma-role.repository';
import { SYSTEM_ROLES_SEED } from '../../../src/permissions/permissions.tokens';
import type { RoleSeed } from '../../../src/permissions/permissions.types';
import { SystemRoleSeeder } from '../../../src/permissions/system-role.seeder';
import { SYSTEM_ROLES } from '../../../src/permissions/system-roles';
import { isUniqueViolation } from '../../../src/common/utils/prisma-errors';
import { createTestPrismaClient } from '../../helpers/test-prisma';
import { resetDb } from '../../helpers/reset-db';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

/** The eleven system roles of the design: key, display name and scope, in Postgres key order. */
const EXPECTED_ROLES: ReadonlyArray<{ key: string; name: string; scope: string }> = [
  { key: 'admin', name: 'Admin', scope: 'GLOBAL' },
  { key: 'agent', name: 'Agent', scope: 'GLOBAL' },
  { key: 'approver', name: 'Approver', scope: 'PROJECT' },
  { key: 'developer', name: 'Developer', scope: 'PROJECT' },
  { key: 'member', name: 'Member', scope: 'GLOBAL' },
  { key: 'owner', name: 'Owner', scope: 'GLOBAL' },
  { key: 'project-admin', name: 'Project Admin', scope: 'PROJECT' },
  { key: 'reviewer', name: 'Reviewer', scope: 'PROJECT' },
  { key: 'triager', name: 'Triager', scope: 'PROJECT' },
  { key: 'verifier', name: 'Verifier', scope: 'PROJECT' },
  { key: 'viewer', name: 'Viewer', scope: 'PROJECT' },
];

describeIntegration('permissions roles and bindings (PG)', () => {
  const prisma = createTestPrismaClient();
  const developerSeed = (() => {
    const entry = SYSTEM_ROLES.find((role) => role.key === 'developer');
    if (entry === undefined) throw new Error('the developer system role is missing from SYSTEM_ROLES');
    return entry;
  })();
  const txManager: ITransactionManager = {
    run: <T>(fn: () => Promise<T>): Promise<T> => fn(),
    getClient: () => prisma as never,
    isInTransaction: () => false,
  };
  const prismaService = { client: prisma } as unknown as PrismaService<PrismaClient>;

  let seeder: SystemRoleSeeder;
  let roles: PrismaRoleRepository;
  let bindings: PrismaRoleBindingRepository;

  const storedRole = (key: string) => prisma.role.findUniqueOrThrow({ where: { key } });
  const setPermissions = (key: string, permissions: string[]) =>
    prisma.role.update({ where: { key }, data: { permissions } });
  const newProject = () => prisma.project.create({ data: { name: 'P', slug: 'p', key: 'P' } });

  beforeAll(() => {
    roles = new PrismaRoleRepository(txManager, prismaService);
    bindings = new PrismaRoleBindingRepository(txManager, prismaService);
    seeder = new SystemRoleSeeder(SYSTEM_ROLES, roles);
  });

  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('AC-1: bootstrap seeds exactly the eleven system roles with the designed names and scopes', async () => {
    await seeder.onApplicationBootstrap();

    const rows = await prisma.role.findMany({ orderBy: { key: 'asc' } });
    expect(rows.map((row) => ({ key: row.key, name: row.name, scope: row.scope }))).toEqual(EXPECTED_ROLES);
    expect(rows.every((row) => row.system)).toBe(true);
    // The stored column is the entry list as written, not an expanded key set.
    expect((await storedRole('developer')).permissions).toEqual([...developerSeed.permissions]);
    expect((await storedRole('agent')).permissions).toEqual(['agent.read']);
  });

  it('AC-2: owner is the only locked role', async () => {
    await seeder.onApplicationBootstrap();

    const locked = await prisma.role.findMany({ where: { locked: true } });
    expect(locked.map((row) => row.key)).toEqual(['owner']);
  });

  it('AC-3: a second bootstrap creates no new Role rows', async () => {
    await seeder.onApplicationBootstrap();
    const before = await prisma.role.findMany({ orderBy: { key: 'asc' } });

    await seeder.onApplicationBootstrap();

    const after = await prisma.role.findMany({ orderBy: { key: 'asc' } });
    expect(after.map((row) => row.id)).toEqual(before.map((row) => row.id));
    expect(after.map((row) => row.createdAt.toISOString())).toEqual(before.map((row) => row.createdAt.toISOString()));
  });

  it('AC-4: keeps an edited permission list on an unlocked system role', async () => {
    await seeder.onApplicationBootstrap();
    await setPermissions('developer', ['ticket.read']);

    await seeder.onApplicationBootstrap();

    expect((await storedRole('developer')).permissions).toEqual(['ticket.read']);
  });

  it('AC-5: restores the locked owner role permissions from the seed', async () => {
    await seeder.onApplicationBootstrap();
    await setPermissions('owner', ['ticket.read']);

    await seeder.onApplicationBootstrap();

    expect((await storedRole('owner')).permissions).toEqual(['*']);
  });

  it('AC-8: rejects a second global binding for the same principal and role', async () => {
    await seeder.onApplicationBootstrap();
    const owner = await storedRole('owner');
    const binding = {
      principalType: 'USER' as const,
      principalId: 'user-1',
      roleId: owner.id,
      projectId: null,
      grantedByType: 'SYSTEM' as const,
      grantedById: 'seed',
    };

    await bindings.createBinding(binding);

    // US-003 recognises this case with isUniqueViolation(error, 'principalId'); the exact same check.
    const duplicate = await bindings.createBinding(binding).then(
      () => null,
      (error: unknown) => error,
    );
    expect(duplicate).toMatchObject({ code: 'P2002' });
    expect(isUniqueViolation(duplicate, 'principalId')).toBe(true);
    expect(await prisma.roleBinding.count({ where: { principalId: 'user-1' } })).toBe(1);
  });

  it('AC-9: rejects a second project binding for the same principal, role and project', async () => {
    await seeder.onApplicationBootstrap();
    const developer = await storedRole('developer');
    const project = await newProject();
    const binding = {
      principalType: 'USER' as const,
      principalId: 'user-1',
      roleId: developer.id,
      projectId: project.id,
      grantedByType: 'SYSTEM' as const,
      grantedById: 'seed',
    };

    await bindings.createBinding(binding);

    const duplicate = await bindings.createBinding(binding).then(
      () => null,
      (error: unknown) => error,
    );
    expect(duplicate).toMatchObject({ code: 'P2002' });
    expect(isUniqueViolation(duplicate, 'principalId')).toBe(true);
    expect(await prisma.roleBinding.count({ where: { principalId: 'user-1' } })).toBe(1);
  });

  it('AC-10: a hard-deleted project takes its bindings with it', async () => {
    await seeder.onApplicationBootstrap();
    const developer = await storedRole('developer');
    const project = await newProject();
    await bindings.createBinding({
      principalType: 'USER',
      principalId: 'user-1',
      roleId: developer.id,
      projectId: project.id,
      grantedByType: 'SYSTEM',
      grantedById: 'seed',
    });

    await prisma.project.delete({ where: { id: project.id } });

    expect(await prisma.roleBinding.count({ where: { projectId: project.id } })).toBe(0);
  });

  it('AC-11: a role a binding references cannot be deleted', async () => {
    await seeder.onApplicationBootstrap();
    const developer = await storedRole('developer');
    await bindings.createBinding({
      principalType: 'USER',
      principalId: 'user-1',
      roleId: developer.id,
      projectId: null,
      grantedByType: 'SYSTEM',
      grantedById: 'seed',
    });

    // The relation is ON DELETE RESTRICT, so the database refuses: P2003 foreign key violation.
    await expect(prisma.role.delete({ where: { id: developer.id } })).rejects.toMatchObject({ code: 'P2003' });
    await expect(storedRole('developer')).resolves.toBeDefined();
  });

  it('AC-12: an application bootstrap with an invalid entry rejects instead of starting the API', async () => {
    let moduleRef: TestingModule | undefined;
    const invalidSeeds: readonly RoleSeed[] = [
      // A valid role first: a seeder that wrote as it validated would already have created it.
      { key: 'developer', name: 'Developer', scope: 'PROJECT', permissions: ['ticket.read'] },
      { key: 'broken', name: 'Broken', scope: 'PROJECT', permissions: ['no.such.key'] },
    ];

    try {
      moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(SYSTEM_ROLES_SEED)
        .useValue(invalidSeeds)
        .compile();

      await expect(moduleRef.init()).rejects.toBeInstanceOf(UnknownPermissionEntryError);
      expect(await prisma.role.count()).toBe(0);
    } finally {
      // Nest's shutdown awaits the failed initialization promise, so closing a module whose bootstrap
      // threw rejects with that same error and disposes nothing. Close the Prisma client the test
      // module opened, then let close() settle: a leaked connection pool would keep vitest alive.
      await moduleRef?.get(PrismaService, { strict: false }).onModuleDestroy().catch(() => undefined);
      await moduleRef?.close().catch(() => undefined);
    }
  });

  it('reads a role back through the repository as a domain object, never as Prisma JSON', async () => {
    await seeder.onApplicationBootstrap();

    const owner = await roles.findOne({ key: 'owner' });

    expect(owner).toMatchObject({ key: 'owner', name: 'Owner', scope: 'GLOBAL', locked: true, system: true });
    expect(owner?.permissions).toEqual(['*']);
    expect(typeof owner?.id).toBe('string');
  });
});
