import { Global, Module } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { CacheManager } from '@nathapp/nestjs-cache';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { AdminUsersController } from './admin-users.controller';
import { PrismaUsersRepository } from './prisma-users.repository';
import { UsersAdminService } from './users-admin.service';
import { UsersModule } from './users.module';

// Stand-ins for the global PrismaModule/CacheModule so the REAL module under
// test compiles without a database. Mirrors src/outbox/outbox.module.spec.ts.
@Global()
@Module({
  providers: [
    { provide: PrismaService, useValue: { client: {} } },
    {
      provide: TRANSACTION_MANAGER,
      useValue: { run: <T>(fn: () => Promise<T>) => fn(), getClient: () => ({}), isInTransaction: () => false },
    },
    { provide: CacheManager, useValue: { get: jest.fn(), invalidate: jest.fn() } },
  ],
  exports: [PrismaService, TRANSACTION_MANAGER, CacheManager],
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
