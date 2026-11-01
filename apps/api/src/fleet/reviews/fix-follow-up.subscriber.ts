import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import { BudgetPausedException } from '../budgets/budget.exceptions';
import { FleetDispatchException } from '../jobs/fleet-dispatch.exception';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { runAsSystem } from '../../action-context/action-context';
import { bookkeeping } from '../../action-context/audit-coverage';
import { AuditRecorder } from '../../audit/audit-recorder.service';
import { FanOutPublisher } from '../../outbox/fan-out-publisher';
import { PermissionService } from '../../permissions/permission.service';
import { mayDispatch } from '../schedules/schedule-access';
import { SystemWriter } from '../../permissions/system-writer.decorator';
import {
  FIX_FOLLOW_UP,
  parseFixFollowUpPayload,
  type FixFollowUpPayload,
} from '../common/fix-follow-up-events';
import { FleetJobsService } from '../jobs/fleet-jobs.service';
import { FleetReposService } from '../repos/fleet-repos.service';
import { FLEET_PR_REVIEW_REPOSITORY, type IFleetPrReviewRepository } from './domain/fleet-pr-review.domain';

/** The system component id: the second segment of `system.pr-fix.follow-up` (action-context rule). */
const COMPONENT = 'pr-fix';

/**
 * K3-B1 (spec §"Calls made in this spec" 3, 5, 6, 8, 9): a `FIX` that pushed a commit gets one follow-up
 * `REVIEW` of the same PR, so the head is re-reviewed with koda's review decisions.
 *
 * The whole body runs as the `pr-fix` system component on behalf of the FIX requester, under this class's
 * own key. Before dispatching it claims the pushed head in `FleetPrReview`, the K1-B auto-review table, so
 * the poller does not review that head a second time; a successful dispatch records the review job on the
 * claim and one audit entry on the FIX job, which is the link between the two jobs.
 *
 * Throws only on database failure (the `FleetJobOutcomeSubscriber` rule), so the relay redelivers: a claim
 * that still exists makes the redelivery skip instead of dispatching twice.
 */
@Injectable()
@SystemWriter('system.pr-fix.follow-up')
export class FixFollowUpSubscriber implements OnModuleInit {
  private readonly logger = new Logger(FixFollowUpSubscriber.name);

  /** The constructor is fixed from US-002 on: US-003 and US-004 only extend the handler. */
  constructor(
    private readonly registry: FanOutPublisher,
    @Inject(FLEET_PR_REVIEW_REPOSITORY) private readonly reviews: IFleetPrReviewRepository,
    private readonly jobs: FleetJobsService,
    private readonly repos: FleetReposService,
    private readonly permissions: PermissionService,
    private readonly audit: AuditRecorder,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
  ) {}

  onModuleInit(): void {
    this.registry.register(FIX_FOLLOW_UP, this.handle);
  }

  readonly handle = async (payload: unknown): Promise<void> => {
    const p = parseFixFollowUpPayload(payload);
    if (p === null) {
      this.logger.warn(`${FIX_FOLLOW_UP}: malformed payload skipped`);
      return;
    }

    await runAsSystem(
      COMPONENT,
      () => this.followUp(p),
      { onBehalfOf: { type: p.requestedByType, id: p.requestedById } },
    );
  };

  private async followUp(p: FixFollowUpPayload): Promise<void> {
    const requester = { type: p.requestedByType, id: p.requestedById } as const;
    const [access, keys] = await Promise.all([
      this.reviews.findPrincipalAccess(requester),
      this.permissions.effectiveKeys(requester, { projectId: p.projectId }),
    ]);
    if (!mayDispatch(access, keys)) {
      await this.recordSkip(p, 'requester_lost_access');
      return;
    }

    const repo = await this.repos.findReviewRepo(p.repoId);
    if (repo === null) {
      await this.recordSkip(p, 'repo_gone');
      return;
    }

    const claim = await bookkeeping(
      'fleet.pr-review-bookkeeping',
      () => this.reviews.insertPending(p.repoId, p.prNumber, p.headSha),
    );
    // A null claim means the auto-review poller, or an earlier delivery of this event, already owns the head.
    if (claim === null) {
      await this.recordSkip(p, 'head_already_claimed');
      return;
    }

    let job: { id: string };
    try {
      ({ job } = await this.jobs.dispatch(
        p.requestedById,
        p.projectId,
        {
          command: 'REVIEW',
          repoId: p.repoId,
          prNumber: p.prNumber,
          profiles: p.profiles,
          maxCostUsd: Number(p.maxCostUsd),
        },
        { auditKey: 'system.pr-fix.follow-up' },
      ));
    } catch (error) {
      if (error instanceof BudgetPausedException) {
        await this.removeClaim(claim.id);
        await this.recordSkip(p, 'budget_paused');
        return;
      }
      if (error instanceof ConflictAppException && getExceptionResponse(error).prefix === 'fleet.jobs') {
        await this.removeClaim(claim.id);
        await this.recordSkip(p, 'review_active');
        return;
      }
      if (error instanceof ValidationAppException || error instanceof NotFoundAppException || error instanceof FleetDispatchException) {
        const response = getExceptionResponse(error);
        const reason = error instanceof ValidationAppException && typeof response.args?.reason === 'string'
          ? response.args.reason
          : error.constructor.name;
        await bookkeeping('fleet.pr-review-bookkeeping', () => this.reviews.markFailed(claim.id, `failed:${reason}`.slice(0, 200)));
        await this.recordSkip(p, reason);
        return;
      }
      this.logger.warn(`Follow-up review dispatch failed for FIX job ${p.jobId}: ${error instanceof Error ? error.constructor.name : 'UnknownError'}`);
      await this.removeClaim(claim.id);
      await this.recordSkip(p, 'dispatch_error');
      return;
    }

    await bookkeeping(
      'fleet.pr-review-bookkeeping',
      () => this.reviews.markDispatched(claim.id, job.id),
    );

    // The entry on the FIX job is the link between the two jobs; `record` requires a transaction.
    await this.txManager.run(() => this.audit.record({
      key: 'system.pr-fix.follow-up',
      resourceType: 'fleet-job',
      resourceId: p.jobId,
      projectId: p.projectId,
      summary: `follow-up review dispatched: ${job.id}`,
    }));
  }

  private removeClaim(id: string): Promise<void> {
    return bookkeeping('fleet.pr-review-bookkeeping', () => this.reviews.remove(id));
  }

  private async recordSkip(p: FixFollowUpPayload, reason: string): Promise<void> {
    await this.txManager.run(() => this.audit.record({
      key: 'system.pr-fix.follow-up',
      resourceType: 'fleet-job',
      resourceId: p.jobId,
      projectId: p.projectId,
      summary: `follow-up review skipped: ${reason}`,
    }));
  }
}

function getExceptionResponse(error: Error): { prefix?: string; args?: Record<string, unknown> } {
  const response: unknown = (error as Error & { getResponse: () => unknown }).getResponse();
  if (typeof response !== 'object' || response === null) return {};
  return response as { prefix?: string; args?: Record<string, unknown> };
}
