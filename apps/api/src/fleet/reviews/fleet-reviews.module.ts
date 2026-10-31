import { Module } from '@nestjs/common';
import { FleetJobsModule } from '../jobs/fleet-jobs.module';
import { GitBrokerModule } from '../git-broker/git-broker.module';
import { FleetReposModule } from '../repos/fleet-repos.module';
import { EnablerGate } from './enabler-gate';
import { FLEET_PR_REVIEW_REPOSITORY } from './domain/fleet-pr-review.domain';
import { FleetPrReviewPass } from './fleet-pr-review.pass';
import { FleetPrReviewPoller } from './fleet-pr-review.poller';
import { PrismaFleetPrReviewRepository } from './prisma-fleet-pr-review.repository';
import { ReviewHeadDispatcher } from './review-head-dispatcher';

/**
 * Fleet auto-review (spec §"The pass and the poller"): the polling pass, the enabler gate, the
 * per-head dispatcher and the claim repository, behind the enabler gate the settings route writes.
 *
 * The poller that owns the timer joins in US-010. Exports nothing: the feature has no route or
 * consumer outside this module, and the claim repository stays module-private.
 */
@Module({
  imports: [FleetReposModule, FleetJobsModule, GitBrokerModule],
  providers: [
    PrismaFleetPrReviewRepository,
    { provide: FLEET_PR_REVIEW_REPOSITORY, useExisting: PrismaFleetPrReviewRepository },
    EnablerGate,
    ReviewHeadDispatcher,
    FleetPrReviewPass,
    FleetPrReviewPoller,
  ],
})
export class FleetReviewsModule {}
