import { Global, Module } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { CacheManager } from '@nathapp/nestjs-cache';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { FleetModule } from './fleet.module';
import { FleetActivityService } from './activity/fleet-activity.service';

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

describe('FleetModule', () => {
  let module: TestingModule;

  beforeEach(async () => {
    module = await Test.createTestingModule({
      imports: [FakeGlobalsModule, FleetModule],
    }).compile();
  });

  afterEach(async () => {
    await module.close();
  });

  it('compiles with its providers resolvable', async () => {
    expect(module.get(FleetActivityService)).toBeDefined();
  });
});
