import { AuditRecorder } from '../audit/audit-recorder.service';
import { mockAuditRecorder } from '../common/test-helpers/global-stubs.module';
import { Test, TestingModule } from '@nestjs/testing';
import { Global, Module } from '@nestjs/common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { CacheManager } from '@nathapp/nestjs-cache';
import { AUTH_CFG, IAuthConfig } from '../config/auth.config';
import { MembershipService } from './membership.service';
import { PermissionService } from './permission.service';
import { PrismaRoleRepository } from './prisma-role.repository';
import { PrismaRoleBindingRepository } from './prisma-role-binding.repository';
import {
  ROLE_BINDING_REPOSITORY,
  ROLE_REPOSITORY,
  SYSTEM_ROLES_SEED,
} from './permissions.tokens';
import { PermissionsModule } from './permissions.module';
import { SYSTEM_ROLES } from './system-roles';
import { SystemRoleSeeder } from './system-role.seeder';
import type { PrismaClient } from '../generated/prisma/client';

/**
 * US-002 — DI guard for the permissions module shell.
 *
 * `bun run test` runs without a database, so a missing provider, an exported repository token or a
 * seeder that never gets bootstrapped must surface here rather than in the DB-backed suites.
 */

/** No role rows: the seeder creates all eleven, which the delegates below accept. */
const mockPrismaClient = {
  role: {
    findFirst: vi.fn(async () => null),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: `id-${String(data['key'])}`, ...data })),
    update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'id', ...data })),
  },
};

/** `AbstractPrismaRepository` reads the active client from the transaction manager. */
const mockTransactionManager: ITransactionManager = {
  run: <T>(fn: () => Promise<T>): Promise<T> => fn(),
  getClient: () => mockPrismaClient as never,
  isInTransaction: () => false,
};

const mockPrismaService = { client: mockPrismaClient } as unknown as PrismaService<PrismaClient>;

/** US-004: the module reads `ownerEmail` in `onModuleInit`; outside production it only needs to resolve. */
const mockAuthConfig: IAuthConfig = {
  jwtSecret: 'test-secret',
  jwtExpiresIn: '15m',
  jwtRefreshSecret: 'test-refresh-secret',
  jwtRefreshExpiresIn: '7d',
  apiKeySecret: 'test-api-key-secret',
  registrationEnabled: false,
};

/**
 * What `PrismaModule.forRoot({ isGlobal: true })` provides in the application: the repositories below
 * inject both, and a module-scoped provider cannot see the testing module's root providers.
 */
@Global()
@Module({
  providers: [
    { provide: AuditRecorder, useValue: mockAuditRecorder },
    { provide: PrismaService, useValue: mockPrismaService },
    { provide: TRANSACTION_MANAGER, useValue: mockTransactionManager },
    // The application registers the cache globally (`CacheModule.register({ isGlobal: true })`).
    { provide: CacheManager, useValue: {} },
    // The application registers it globally (`ConfigBridgeModule` over `ConfigModule.forRoot`).
    { provide: AUTH_CFG, useValue: mockAuthConfig },
  ],
  exports: [AuditRecorder, PrismaService, TRANSACTION_MANAGER, CacheManager, AUTH_CFG],
})
class PermissionStubsModule {}

describe('US-002 PermissionsModule', () => {
  let moduleRef: TestingModule;

  const build = (): Promise<TestingModule> =>
    Test.createTestingModule({ imports: [PermissionStubsModule, PermissionsModule] }).compile();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await moduleRef?.close();
  });

  it('compiles without a database', async () => {
    moduleRef = await build();

    expect(moduleRef).toBeDefined();
  });

  it('registers the repositories behind their symbol tokens', async () => {
    moduleRef = await build();

    expect(moduleRef.get(ROLE_REPOSITORY)).toBeInstanceOf(PrismaRoleRepository);
    expect(moduleRef.get(ROLE_BINDING_REPOSITORY)).toBeInstanceOf(PrismaRoleBindingRepository);
  });

  it('does not export the module-private repositories', () => {
    const exported: unknown[] = Reflect.getMetadata('exports', PermissionsModule) ?? [];

    expect(exported).not.toContain(ROLE_REPOSITORY);
    expect(exported).not.toContain(ROLE_BINDING_REPOSITORY);
    expect(exported).not.toContain(PrismaRoleRepository);
    expect(exported).not.toContain(PrismaRoleBindingRepository);
  });

  it('exports PermissionService and MembershipService, and provides them', async () => {
    const exported: unknown[] = Reflect.getMetadata('exports', PermissionsModule) ?? [];
    moduleRef = await build();

    expect(exported).toEqual(expect.arrayContaining([PermissionService, MembershipService]));
    expect(moduleRef.get(PermissionService)).toBeInstanceOf(PermissionService);
    expect(moduleRef.get(MembershipService)).toBeInstanceOf(MembershipService);
  });

  it('provides SYSTEM_ROLES_SEED as the system role table', async () => {
    moduleRef = await build();

    expect(moduleRef.get(SYSTEM_ROLES_SEED)).toBe(SYSTEM_ROLES);
  });

  it('seeds the system roles when the application bootstraps', async () => {
    moduleRef = await build();

    await moduleRef.init();

    // The seeder ran as a lifecycle hook on an empty table, and wrote through the repository.
    expect(mockPrismaService.client.role.create).toHaveBeenCalledTimes(SYSTEM_ROLES.length);
    expect(moduleRef.get(SystemRoleSeeder)).toBeInstanceOf(SystemRoleSeeder);
  });
});
