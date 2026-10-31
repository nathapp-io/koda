import { Test, type TestingModule } from '@nestjs/testing';
import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import { REVIEW_EVENTS_INGESTED } from '../common/review-events';
import { GlobalStubsModule } from '../../common/test-helpers/global-stubs.module';
import { FleetModule } from '../fleet.module';
import { FleetReposModule } from '../repos/fleet-repos.module';
import { FleetReposService } from '../repos/fleet-repos.service';
import { FLEET_REPO_REPOSITORY } from '../repos/domain/fleet-repo.domain';
import { EnablerGate } from './enabler-gate';
import { FLEET_PR_REVIEW_REPOSITORY, type IFleetPrReviewRepository } from './domain/fleet-pr-review.domain';
import { FleetPrReviewPass } from './fleet-pr-review.pass';
import { FleetPrReviewPoller } from './fleet-pr-review.poller';
import { FleetReviewsModule } from './fleet-reviews.module';
import { ReviewHeadDispatcher } from './review-head-dispatcher';
import { ReviewEventMinter } from './review-event.minter';
import { FLEET_REVIEW_EVENT_REPOSITORY } from './domain/fleet-review-event.domain';
import { ReviewDecisionWriter } from '../../memory/review-decision.writer';

/**
 * US-009 — the wiring of the auto-review module, without a database.
 *
 * The pass, the gate and the dispatcher have no route that would fail loudly if they were left out of
 * the application: an unregistered pass simply never polls. So this spec pins the registration, and
 * that the two modules the feature joins (`FleetModule`, `FleetReposModule`) name what it needs.
 *
 * `GlobalStubsModule` stands in for the global Prisma/Cache/permission/config providers, the same
 * harness `fleet.module.spec.ts` uses, so the real module compiles with no Postgres.
 */
describe('FleetReviewsModule', () => {
  let module: TestingModule | undefined;

  afterEach(async () => {
    await module?.close();
    module = undefined;
  });

  it('AC-3: event emitter discovery invokes the registered minter', async () => {
    module = await Test.createTestingModule({ imports: [GlobalStubsModule, EventEmitterModule.forRoot(), FleetReviewsModule] })
      .overrideProvider(FLEET_REVIEW_EVENT_REPOSITORY).useValue({ claimPending: vi.fn().mockResolvedValue([]) })
      .compile();
    await module.init();
    const minter = module.get(ReviewEventMinter);
    const run = vi.spyOn(minter, 'run').mockResolvedValue(undefined);
    module.get(EventEmitter2).emit(REVIEW_EVENTS_INGESTED, { jobId: 'job-1' });
    expect(run).toHaveBeenCalledExactlyOnceWith();
  });

  it('US-005 AC-13: resolves the minter and the exported memory writer', async () => {
    module = await Test.createTestingModule({ imports: [GlobalStubsModule, FleetReviewsModule] })
      .overrideProvider(FLEET_REVIEW_EVENT_REPOSITORY).useValue({ claimPending: vi.fn().mockResolvedValue([]) })
      .compile();
    expect(module.get(ReviewEventMinter)).toBeInstanceOf(ReviewEventMinter);
    expect(module.get(ReviewDecisionWriter)).toBeInstanceOf(ReviewDecisionWriter);
    await expect(module.get(ReviewEventMinter).run()).resolves.toBeUndefined();
  });

  it('AC-8: compiles with FleetPrReviewPoller resolvable', async () => {
    module = await Test.createTestingModule({ imports: [GlobalStubsModule, FleetReviewsModule] }).compile();

    expect(module.get(FleetPrReviewPoller)).toBeInstanceOf(FleetPrReviewPoller);
  });

  it('AC-13: compiles with the pass, the gate, the dispatcher and the review repository resolvable', async () => {
    module = await Test.createTestingModule({ imports: [GlobalStubsModule, FleetReviewsModule] }).compile();

    expect(module.get(FleetPrReviewPass)).toBeInstanceOf(FleetPrReviewPass);
    expect(module.get(EnablerGate)).toBeInstanceOf(EnablerGate);
    expect(module.get(ReviewHeadDispatcher)).toBeInstanceOf(ReviewHeadDispatcher);
    expect(module.get<IFleetPrReviewRepository>(FLEET_PR_REVIEW_REPOSITORY)).toBeDefined();
  });

  it('AC-14: FleetModule imports FleetReviewsModule', () => {
    const imports = Reflect.getMetadata('imports', FleetModule) as unknown[];

    expect(imports).toContain(FleetReviewsModule);
  });

  it('AC-15: FleetReposModule still exports its repository token and now exports FleetReposService', () => {
    const exports = Reflect.getMetadata('exports', FleetReposModule) as unknown[];

    expect(exports).toContain(FLEET_REPO_REPOSITORY);
    expect(exports).toContain(FleetReposService);
  });
});
