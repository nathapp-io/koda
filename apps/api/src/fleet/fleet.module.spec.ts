import { Test, TestingModule } from '@nestjs/testing';
import { FleetModule } from './fleet.module';
import { EnrollmentService } from './runners/enrollment.service';
import { RunnersService } from './runners/runners.service';
import { FleetActivityService } from './activity/fleet-activity.service';
import { FleetReposService } from './repos/fleet-repos.service';
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
  });
});
