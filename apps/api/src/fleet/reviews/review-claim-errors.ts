/**
 * Review B4 — the two failures a review claim's dispatch fence can report.
 *
 * A review claim is a `pending` row that a pass dispatches a `REVIEW` job for. The job insert carries the claim link
 * in its own transaction (`FleetJobsService.dispatch`'s `fence`), so a stale-claim sweep — which reads its job lookup
 * and then conditionally deletes the claim — cannot interleave: whichever write touches the claim row first settles
 * it, and the other either finds the claim gone (no job is created) or the claim already dispatched (no delete
 * matches).
 */

/**
 * The claim this pass holds is gone or already settled, so its job insert must not commit. Thrown from the fence,
 * inside the insert transaction, so the insert rolls back.
 */
export class ReviewClaimLostError extends Error {
  readonly name = 'ReviewClaimLostError';

  constructor() {
    super('the review claim was removed or settled before the job insert committed');
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * The fence's own write to the claim failed. The insert rolled back with it, and the failure belongs to the caller (a
 * database problem, not a lost claim), so the caller rethrows the original error.
 */
export class ReviewClaimFenceError extends Error {
  readonly name = 'ReviewClaimFenceError';

  constructor(readonly cause: unknown) {
    super(`review claim fence failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
