import { bookkeeping } from '../../action-context/audit-coverage';
import type { IFleetPrReviewRepository } from './domain/fleet-pr-review.domain';
import { ReviewClaimFenceError, ReviewClaimLostError } from './review-claim-errors';

/**
 * Review B4 — the one review-claim fence, shared by every path that dispatches a `REVIEW` job for a claim.
 *
 * The link between the claim and its job is written by the job insert's own transaction (`FleetJobsService.dispatch`
 * calls this fence inside it), never after the commit. A stale-claim sweep reads its job lookup and then deletes the
 * claim conditionally, so it can interleave with the insert: whichever write touches the claim row first settles it.
 * When the sweep wins, this fence loses — the insert rolls back, so no job exists for a claim that is no longer its
 * owner's. When this fence wins, the claim is `dispatched` with this job id in the same commit, and the sweep's
 * delete matches no row.
 *
 * Both auto-review paths (the head dispatcher and the flow's claim) and the FIX follow-up use it, so a fix round
 * cannot leave one of them linking its job after the commit.
 */
export function reviewClaimFence(
  reviews: Pick<IFleetPrReviewRepository, 'markDispatchedIfPending'>,
  claimId: string,
): (jobId: string) => Promise<void> {
  return async (jobId: string): Promise<void> => {
    let linked: boolean;
    try {
      linked = await bookkeeping('fleet.pr-review-bookkeeping', () => reviews.markDispatchedIfPending(claimId, jobId));
    } catch (error) {
      throw new ReviewClaimFenceError(error);
    }
    if (!linked) throw new ReviewClaimLostError();
  };
}
