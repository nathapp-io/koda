import { AuditRecorder } from '../audit/audit-recorder.service';
import { mockAuditRecorder } from '../common/test-helpers/global-stubs.module';
import { Global, Module } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { CacheManager } from '@nathapp/nestjs-cache';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { MembershipService } from '../permissions/membership.service';
import { PermissionService } from '../permissions/permission.service';
import { AdminUsersController } from './admin-users.controller';
import { PrismaUsersRepository } from './prisma-users.repository';
import { UsersAdminService } from './users-admin.service';
import { UsersModule } from './users.module';

// Stand-ins for the global PrismaModule/CacheModule/PermissionsModule so the REAL module under
// test compiles without a database. Mirrors src/outbox/outbox.module.spec.ts.
@Global()
@Module({
  providers: [
    { provide: AuditRecorder, useValue: mockAuditRecorder },
    { provide: PrismaService, useValue: { client: {} } },
    {
      provide: TRANSACTION_MANAGER,
      useValue: { run: <T>(fn: () => Promise<T>) => fn(), getClient: () => ({}), isInTransaction: () => false },
    },
    { provide: CacheManager, useValue: { get: vi.fn(), invalidate: vi.fn() } },
    // Permissions P1 (US-010): the admin user routes run `RequiresGuard`, whose one dependency is
    // the decision point the global PermissionsModule exports.
    {
      provide: PermissionService,
      useValue: { can: vi.fn(async () => ({ allowed: true, reason: 'granted' })) },
    },
    // Permissions P1a (US-004): UsersAdminService injects the permissions module's MembershipService.
    {
      provide: MembershipService,
      useValue: {
        bindBaseline: vi.fn(),
        setGlobalAdmin: vi.fn(),
        // B3: the user writes run inside their own transaction; the stub runs the callback as-is.
        afterCommit: vi.fn((fn: () => Promise<unknown>) => fn()),
      },
    },
  ],
  exports: [AuditRecorder, PrismaService, TRANSACTION_MANAGER, CacheManager, PermissionService, MembershipService],
})
class FakeGlobalsModule {}

describe('UsersModule — DI wiring (no database)', () => {
  let module: TestingModule;

  beforeEach(async () => {
    module = await Test.createTestingModule({
      imports: [FakeGlobalsModule, UsersModule],
    }).compile();
  });

  afterEach(async () => {
    await module.close();
  });

  it('resolves the controller, service and repository from the real module', () => {
    expect(module.get(AdminUsersController)).toBeInstanceOf(AdminUsersController);
    expect(module.get(UsersAdminService)).toBeInstanceOf(UsersAdminService);
    expect(module.get(PrismaUsersRepository)).toBeInstanceOf(PrismaUsersRepository);
  });
});
