import { Global, Module } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { CacheManager } from '@nathapp/nestjs-cache';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { FleetModule } from './fleet.module';
import { EnrollmentService } from './runners/enrollment.service';
import { RunnersService } from './runners/runners.service';
import { FleetActivityService } from './activity/fleet-activity.service';
import { mockAuthConfig, mockFleetConfig } from '../common/test-helpers/global-stubs.module';
import { AUTH_CFG } from '../config/auth.config';
import { FLEET_CFG } from '../config/fleet.config';

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
    { provide: AUTH_CFG, useValue: mockAuthConfig },
    { provide: FLEET_CFG, useValue: mockFleetConfig },
  ],
  exports: [PrismaService, TRANSACTION_MANAGER, CacheManager, AUTH_CFG, FLEET_CFG],
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
    expect(module.get(EnrollmentService)).toBeDefined();
    expect(module.get(RunnersService)).toBeDefined();
  });
});
