import { Inject, Injectable } from '@nestjs/common';
import { bookkeeping } from '../../action-context/audit-coverage';
import { FLEET_CFG, type IFleetConfig } from '../../config/fleet.config';
import { FLEET_PR_REVIEW_REPOSITORY, type IFleetPrReviewRepository } from './domain/fleet-pr-review.domain';

export type HeadClaim =
  | { kind: 'claimed'; claimId: string }
  | { kind: 'owned'; jobId: string }
  | { kind: 'busy' }
  | { kind: 'failed'; outcome: string };

@Injectable()
export class FleetReviewClaimService {
  constructor(
    @Inject(FLEET_PR_REVIEW_REPOSITORY) private readonly reviews: IFleetPrReviewRepository,
    @Inject(FLEET_CFG) private readonly config: Pick<IFleetConfig, 'prReviewPollMs'>,
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
    await bookkeeping('fleet.pr-review-bookkeeping', () => this.reviews.remove(existing.id));
    const retried = await bookkeeping('fleet.pr-review-bookkeeping', () => this.reviews.insertPending(repoId, prNumber, headSha));
    return retried === null ? { kind: 'busy' } : { kind: 'claimed', claimId: retried.id };
  }

  markDispatched(claimId: string, jobId: string): Promise<void> {
    return bookkeeping('fleet.pr-review-bookkeeping', () => this.reviews.markDispatched(claimId, jobId));
  }

  release(claimId: string): Promise<void> {
    return bookkeeping('fleet.pr-review-bookkeeping', () => this.reviews.remove(claimId));
  }
}
