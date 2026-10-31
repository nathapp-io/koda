import { Inject, Injectable } from '@nestjs/common';
import { bookkeeping } from '../../action-context/audit-coverage';
import type { OpenPullRequest } from '../git-broker/github-app-client';
import { FleetJobsService } from '../jobs/fleet-jobs.service';
import type { FleetRepoRecord } from '../repos/domain/fleet-repo.domain';
import {
  FLEET_PR_REVIEW_REPOSITORY,
  type FleetPrReviewRecord,
  type IFleetPrReviewRepository,
} from './domain/fleet-pr-review.domain';

/** What one repo's pass needs: the pass time, one poll interval, and the calls it may still make (spec call 9). */
export interface DispatchRepoOptions {
  now: Date;
  /** `prReviewPollMs`: a `pending` row older than this is a claim a dead pass left behind (spec call 8). */
  pollMs: number;
  /** Dispatch calls this repo may still make, the pass's `prReviewMaxDispatch` accounting for earlier repos. */
  remaining: number;
}

const PENDING = 'pending';

/**
 * Fleet auto-review (spec §"The dispatcher"): claims eligible PR heads of one repo and dispatches a bounded
 * number of `REVIEW` jobs. Failure outcomes are US-007; repo orchestration and the pass-wide cap are US-009.
 */
@Injectable()
export class ReviewHeadDispatcher {
  constructor(
    @Inject(FLEET_PR_REVIEW_REPOSITORY) private readonly reviews: IFleetPrReviewRepository,
    private readonly jobs: FleetJobsService,
  ) {}

  /**
   * Walks `prs` in ascending `number`, skipping the heads the spec's call 5 excludes, and returns how many
   * `dispatch` calls it made. No transaction is open around `dispatch`: a 409 from the active-job index must
   * not poison one (the `ScheduleTicker` rule).
   */
  async dispatchRepo(repo: FleetRepoRecord, prs: readonly OpenPullRequest[], opts: DispatchRepoOptions): Promise<number> {
    const actorId = repo.autoReviewEnabledById;
    // `autoReview` is only true while an enabler is stored (US-002 writes the flag and the enabler together),
    // so a repo without one cannot be dispatched on anyone's behalf.
    if (actorId === null) return 0;

    const staleBefore = opts.now.getTime() - opts.pollMs;
    const ordered = [...prs].sort((left, right) => left.number - right.number);
    let calls = 0;

    for (const pr of ordered) {
      if (skips(repo, pr)) continue;
      if (!(await this.headIsOpen(repo, pr, staleBefore))) continue;
      if (calls >= opts.remaining) break;
      const pending = await bookkeeping('fleet.pr-review-bookkeeping', () => this.reviews.insertPending(repo.id, pr.number, pr.headSha));
      if (pending === null) continue;
      calls += 1;
      await this.dispatch(actorId, repo, pr, pending);
    }

    return calls;
  }

  /**
   * Call 6: a `dispatched` or `failed:` row settles the head for good; a `pending` row still inside one poll
   * interval belongs to a running pass. An older one is a claim whose pass died between insert and dispatch
   * (call 8), so it is removed and the head is handled as new.
   */
  private async headIsOpen(repo: FleetRepoRecord, pr: OpenPullRequest, staleBefore: number): Promise<boolean> {
    const row = await this.reviews.findHead(repo.id, pr.number, pr.headSha);
    return row === null || (await this.reopenStaleClaim(row, staleBefore));
  }

  private async reopenStaleClaim(row: FleetPrReviewRecord, staleBefore: number): Promise<boolean> {
    if (row.outcome !== PENDING) return false;
    if (row.createdAt.getTime() >= staleBefore) return false;
    await bookkeeping('fleet.pr-review-bookkeeping', () => this.reviews.remove(row.id));
    return true;
  }

  /**
   * Call 5 and, on success, the job link: the review is dispatched on the enabler's behalf, then the claim
   * records its job. A throw is left to propagate for now — US-007 adds the outcome mapping (`remove` for a
   * retryable failure, `failed:<reason>` for a permanent one) that turns it into a settled row.
   */
  private async dispatch(actorId: string, repo: FleetRepoRecord, pr: OpenPullRequest, pending: FleetPrReviewRecord): Promise<void> {
    const result = await this.jobs.dispatch(
      actorId,
      repo.projectId,
      {
        command: 'REVIEW',
        repoId: repo.id,
        prNumber: pr.number,
        profiles: repo.autoReviewProfiles,
        maxCostUsd: Number(repo.autoReviewMaxCostUsd),
      },
      { auditKey: 'system.pr-review.dispatch' },
    );
    await bookkeeping('fleet.pr-review-bookkeeping', () => this.reviews.markDispatched(pending.id, result.job.id));
  }
}

/**
 * Call 5: a draft, a head from a fork or a deleted repository, or a PR last updated before auto-review was
 * turned on is not reviewed. Without an enable time the last rule skips nothing.
 */
function skips(repo: FleetRepoRecord, pr: OpenPullRequest): boolean {
  if (pr.draft) return true;
  if (pr.headRepoFullName === null) return true;
  if (pr.headRepoFullName.toLowerCase() !== `${repo.owner}/${repo.name}`.toLowerCase()) return true;
  return repo.autoReviewEnabledAt !== null && pr.updatedAt.getTime() < repo.autoReviewEnabledAt.getTime();
}
