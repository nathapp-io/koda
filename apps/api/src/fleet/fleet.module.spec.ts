import { Test, TestingModule } from '@nestjs/testing';
import { FleetModule } from './fleet.module';
import { EnrollmentService } from './runners/enrollment.service';
import { RunnersService } from './runners/runners.service';
import { FleetActivityService } from './activity/fleet-activity.service';
import { FleetReposService } from './repos/fleet-repos.service';
import { ConfigJobsService } from './repo-config/config-jobs.service';
import { FakeFleetRepoFilesReader } from './repo-config/fake-fleet-repo-files.reader';
import { FleetRepoFilesRouter } from './repo-config/fleet-repo-files.router';
import { selectRepoFilesReader } from './repo-config/repo-config.module';
import { LogReadService } from './logs/log-read.service';
import { FleetLogRetentionProcessor } from './logs/fleet-log-retention.processor';
import { AnalyticsService } from './analytics/analytics.service';
import { FleetDashboardService } from './dashboard/dashboard.service';
import { GlobalStubsModule } from '../common/test-helpers/global-stubs.module';

// GlobalStubsModule stands in for the global PrismaModule/CacheModule plus the
// config namespaces so the REAL module under test compiles without a database.
// FleetReposModule pulls in VcsModule (→ ProjectsModule → NathappAuthModule,
// OutboxModule, RagModule), which needs the real ConfigService loaders for
// auth/vcs/outbox — the same wiring src/vcs/vcs.module.spec.ts uses.
describe('FleetModule', () => {
  let module: TestingModule;

  beforeEach(async () => {
    module = await Test.createTestingModule({
      imports: [GlobalStubsModule, FleetModule],
    }).compile();
  });

  afterEach(async () => {
    await module.close();
  });

  it('compiles with its providers resolvable', async () => {
    expect(module.get(FleetActivityService)).toBeDefined();
    expect(module.get(EnrollmentService)).toBeDefined();
    expect(module.get(RunnersService)).toBeDefined();
    expect(module.get(FleetReposService)).toBeDefined();
    expect(module.get(LogReadService)).toBeDefined();
    expect(module.get(FleetLogRetentionProcessor)).toBeDefined();
    expect(module.get(AnalyticsService)).toBeDefined();
    expect(module.get(FleetDashboardService)).toBeDefined();
    expect(module.get(ConfigJobsService)).toBeDefined();
  });

  it('binds the fake reader only when both test flags are on (S3 plan C11)', () => {
    const build = (flags: { testHooksEnabled: boolean; testFakeNaxFiles: boolean }) => {
      const router = { list: vi.fn(), read: vi.fn() } as unknown as FleetRepoFilesRouter;
      const fake = new FakeFleetRepoFilesReader();
      return selectRepoFilesReader(flags, router, fake);
    };
    expect(build({ testHooksEnabled: true, testFakeNaxFiles: true })).toBeInstanceOf(FakeFleetRepoFilesReader);
    expect(build({ testHooksEnabled: true, testFakeNaxFiles: false })).not.toBeInstanceOf(FakeFleetRepoFilesReader);
    expect(build({ testHooksEnabled: false, testFakeNaxFiles: true })).not.toBeInstanceOf(FakeFleetRepoFilesReader);
  });
});
