import { Inject, Injectable, Logger } from '@nestjs/common';
import { bookkeeping } from '../../action-context/audit-coverage';
import { FLEET_CFG, type IFleetConfig } from '../../config/fleet.config';
import { FleetJobsService } from '../jobs/fleet-jobs.service';
import { FLEET_PR_REVIEW_REPOSITORY, type IFleetPrReviewRepository } from './domain/fleet-pr-review.domain';
import { ReviewClaimFenceError, ReviewClaimLostError } from './review-claim-errors';

export type HeadClaim =
  | { kind: 'claimed'; claimId: string }
  | { kind: 'owned'; jobId: string }
  | { kind: 'busy' }
  | { kind: 'failed'; outcome: string };

@Injectable()
export class FleetReviewClaimService {
  private readonly logger = new Logger(FleetReviewClaimService.name);

  constructor(
    @Inject(FLEET_PR_REVIEW_REPOSITORY) private readonly reviews: IFleetPrReviewRepository,
    @Inject(FLEET_CFG) private readonly config: Pick<IFleetConfig, 'prReviewPollMs'>,
    private readonly jobs: FleetJobsService,
  ) {}

  async claimHead(repoId: string, prNumber: number, headSha: string, now: Date): Promise<HeadClaim> {
    const inserted = await bookkeeping('fleet.pr-review-bookkeeping', () => this.reviews.insertPending(repoId, prNumber, headSha));
    if (inserted !== null) return { kind: 'claimed', claimId: inserted.id };
    const existing = await this.reviews.findHead(repoId, prNumber, headSha);
    if (existing === null) return { kind: 'busy' };
    if (existing.jobId !== null) return { kind: 'owned', jobId: existing.jobId };
    if (existing.outcome.startsWith('failed:')) return { kind: 'failed', outcome: existing.outcome };
    if (existing.outcome !== 'pending') return { kind: 'busy' };
    if (existing.createdAt.getTime() >= now.getTime() - this.config.prReviewPollMs) return { kind: 'busy' };
    const staleBefore = new Date(now.getTime() - this.config.prReviewPollMs);
    // US-006: the stale claim's pass may have created the head's job before it died. A job created inside the
    // claim's dispatch window is this head's job, so the claim is linked to it instead of being dropped and the
    // head dispatched a second time. A failed lookup leaves the claim as it is for this pass.
    let jobId: string | null;
    try {
      jobId = await this.jobs.findReviewJobIdBetween(
        repoId, prNumber, existing.createdAt, new Date(existing.createdAt.getTime() + this.config.prReviewPollMs),
      );
    } catch (error) {
      this.logger.warn(`Review job lookup failed for repo ${repoId} PR ${prNumber}: ${error instanceof Error ? error.constructor.name : 'UnknownError'}`);
      return { kind: 'busy' };
    }
    if (jobId !== null) {
      const linked = await bookkeeping('fleet.pr-review-bookkeeping', () => this.reviews.markDispatchedIfPending(existing.id, jobId));
      if (linked) return { kind: 'owned', jobId };
      // Another pass settled or removed the claim between the lookup and the link: its answer is the claim's.
      return this.settledAnswer(repoId, prNumber, headSha);
    }
    const removed = await bookkeeping('fleet.pr-review-bookkeeping', () => this.reviews.removeStalePending(existing.id, staleBefore));
    if (!removed) return this.settledAnswer(repoId, prNumber, headSha);
    const retried = await bookkeeping('fleet.pr-review-bookkeeping', () => this.reviews.insertPending(repoId, prNumber, headSha));
    return retried === null ? { kind: 'busy' } : { kind: 'claimed', claimId: retried.id };
  }

  /** A claim another pass changed under this one: its job is owned, its failure is reported, anything else is busy. */
  private async settledAnswer(repoId: string, prNumber: number, headSha: string): Promise<HeadClaim> {
    const settled = await this.reviews.findHead(repoId, prNumber, headSha);
    if (settled?.jobId !== null && settled?.jobId !== undefined) return { kind: 'owned', jobId: settled.jobId };
    if (settled?.outcome.startsWith('failed:')) return { kind: 'failed', outcome: settled.outcome };
    return { kind: 'busy' };
  }

  markDispatched(claimId: string, jobId: string): Promise<void> {
    return bookkeeping('fleet.pr-review-bookkeeping', () => this.reviews.markDispatched(claimId, jobId));
  }

  /**
   * Review B4: the fence to pass into the dispatch that creates this claim's REVIEW job. The link is written inside
   * that insert's transaction, so a stale-claim sweep either removes the claim first — this fence then loses and the
   * insert rolls back — or finds the claim already dispatched and cannot drop it.
   */
  fence(claimId: string): (jobId: string) => Promise<void> {
    return async (jobId: string) => {
      let linked: boolean;
      try {
        linked = await bookkeeping('fleet.pr-review-bookkeeping', () => this.reviews.markDispatchedIfPending(claimId, jobId));
      } catch (error) {
        throw new ReviewClaimFenceError(error);
      }
      if (!linked) throw new ReviewClaimLostError();
    };
  }

  release(claimId: string): Promise<void> {
    return bookkeeping('fleet.pr-review-bookkeeping', () => this.reviews.remove(claimId));
  }
}
