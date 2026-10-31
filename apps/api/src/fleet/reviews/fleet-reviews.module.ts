import { Module } from '@nestjs/common';
import { MemoryModule } from '../../memory/memory.module';
import { ReviewEventMinter } from './review-event.minter';
import { ReviewEventMintPoller } from './review-event-mint.poller';
import { FleetJobsModule } from '../jobs/fleet-jobs.module';
import { GitBrokerModule } from '../git-broker/git-broker.module';
import { FleetReposModule } from '../repos/fleet-repos.module';
import { EnablerGate } from './enabler-gate';
import { FLEET_PR_REVIEW_REPOSITORY } from './domain/fleet-pr-review.domain';
import { FleetPrReviewPass } from './fleet-pr-review.pass';
import { FleetPrReviewPoller } from './fleet-pr-review.poller';
import { PrismaFleetPrReviewRepository } from './prisma-fleet-pr-review.repository';
import { ReviewHeadDispatcher } from './review-head-dispatcher';
import { FleetReviewEventsService } from './fleet-review-events.service';
import { FleetReviewEventRepository } from './fleet-review-event.repository';
import { FLEET_REVIEW_EVENT_REPOSITORY } from './domain/fleet-review-event.domain';

/**
 * Fleet auto-review (spec §"The pass and the poller"): the polling pass, the enabler gate, the
 * per-head dispatcher and the claim repository, behind the enabler gate the settings route writes.
 *
 * Exports the review-event service for bundle ingestion; repositories stay module-private.
 */
@Module({
  imports: [MemoryModule, FleetReposModule, FleetJobsModule, GitBrokerModule],
  providers: [
    PrismaFleetPrReviewRepository,
    { provide: FLEET_PR_REVIEW_REPOSITORY, useExisting: PrismaFleetPrReviewRepository },
    EnablerGate,
    ReviewHeadDispatcher,
    FleetPrReviewPass,
    FleetPrReviewPoller,
    FleetReviewEventRepository,
    { provide: FLEET_REVIEW_EVENT_REPOSITORY, useExisting: FleetReviewEventRepository },
    FleetReviewEventsService,
    ReviewEventMinter,
    ReviewEventMintPoller,
  ],
  exports: [FleetReviewEventsService],
})
export class FleetReviewsModule {}
