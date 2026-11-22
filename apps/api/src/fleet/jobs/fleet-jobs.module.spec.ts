import { Test } from '@nestjs/testing';
import { GlobalStubsModule } from '../../common/test-helpers/global-stubs.module';
import { FLEET_JOB_REPOSITORY } from './domain/fleet-job.domain';
import { FleetJobsModule } from './fleet-jobs.module';
import { FleetJobsService } from './fleet-jobs.service';
import { PrismaFleetJobLabelsRepository } from './prisma-fleet-job-labels.repository';

/**
 * 2a ENH-1: module-registration / DI compilation guard. Lives here so any future
 * missing provider or circular import breaks `bun run test` (no DB), not just the
 * DB-mode `bun run test:scoped test/integration/fleet` runs.
 *
 * `GlobalStubsModule` supplies the global providers the production `app.module.ts`
 * wires through `PrismaModule.forRoot({ transaction: true })`, `ConfigModule.forRoot`
 * and `CacheModule.register`. `FleetJobsModule` itself only imports `PrismaModule`
 * (without `.forRoot`), so without the stubs the OutboxCoreModule reached via
 * `LiveModule → OutboxModule` cannot resolve `TRANSACTION_MANAGER`.
 */
describe('FleetJobsModule', () => {
  it('AC-10: injects the registered labels repository into the service', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [GlobalStubsModule, FleetJobsModule] }).compile();
    try {
      const labels = moduleRef.get(PrismaFleetJobLabelsRepository);
      expect(labels).toBeDefined();
      expect(moduleRef.get(FleetJobsService).labels).toBe(labels);
    } finally {
      await moduleRef.close();
    }
  });

  it('compiles and resolves the job repository token', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [GlobalStubsModule, FleetJobsModule] }).compile();
    try {
      const repo = moduleRef.get(FLEET_JOB_REPOSITORY);
      expect(repo).toBeDefined();
    } finally {
      await moduleRef.close();
    }
  });
});
