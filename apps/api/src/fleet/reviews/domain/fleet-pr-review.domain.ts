import type { PrincipalRef } from '../../../permissions/permissions.types';

export const FLEET_PR_REVIEW_REPOSITORY = Symbol('FLEET_PR_REVIEW_REPOSITORY');

/**
 * Fleet auto-review (spec §`FleetPrReview`): one row per `(repoId, prNumber, headSha)`.
 *
 * `outcome` is `pending` (claimed, the dispatch has not finished), `dispatched` (with `jobId`) or
 * `failed:<reason>`. A head with a `dispatched` or `failed:` row is never dispatched again.
 */
export interface FleetPrReviewRecord {
  id: string;
  repoId: string;
  prNumber: number;
  headSha: string;
  jobId: string | null;
  outcome: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Whether the principal that enabler names still exists, and whether it is disabled. */
export interface PrincipalAccess {
  exists: boolean;
  disabled: boolean;
}

export interface IFleetPrReviewRepository {
  findHead(repoId: string, prNumber: number, headSha: string): Promise<FleetPrReviewRecord | null>;
  /** Claims the head as `pending`; null when another pass holds it (a P2002 on the unique index). */
  insertPending(repoId: string, prNumber: number, headSha: string): Promise<FleetPrReviewRecord | null>;
  markDispatched(id: string, jobId: string): Promise<void>;
  markFailed(id: string, outcome: string): Promise<void>;
  remove(id: string): Promise<void>;
  /**
   * The rules `PrismaScheduleRepository.findOwnerAccess` applies: a USER exists when its `User` row does
   * and is disabled when `User.disabled`; an AGENT exists when its `Agent` row does and is never disabled.
   */
  findPrincipalAccess(ref: PrincipalRef): Promise<PrincipalAccess>;
}
