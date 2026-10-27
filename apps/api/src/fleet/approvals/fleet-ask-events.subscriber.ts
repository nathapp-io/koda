import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import type { ApprovalRequestRecord } from '../../approvals/domain/approval.domain';
import { ApprovalRequestQueries } from '../../approvals/approval-request.queries';
import { APPROVAL_REQUEST_CHANGED, parseApprovalRequestChangedPayload } from '../../approvals/approval-request-events';
import { FanOutPublisher } from '../../outbox/fan-out-publisher';
import { BUDGET_REPOSITORY, type IBudgetRepository } from '../budgets/domain/budget.domain';
import { SYSTEM_ACTOR } from '../jobs/job-transitions.service';
import { ApprovalCloser, type ApprovalActor } from './approval-closer';
import { FLEET_ASK_KEYS, type FleetApprovalRecord } from './domain/approval.domain';
import { FleetApprovalAskStore } from './fleet-approval-ask.store';

/**
 * The four engine statuses the fleet must record for itself. The other three are the fleet's own:
 * `pending` at open and `cancelled` at close are written by `ApprovalCloser` in the producer's transaction, and
 * `approved` is skipped because `executed` or `failed` always follows it.
 */
const RECORDED_STATUSES: ReadonlySet<string> = new Set(['rejected', 'executed', 'failed', 'expired']);

/**
 * Permissions P3 US-009, delivered early for US-007 fix round 2: the fleet's resolution outputs for the statuses the
 * *engine* sets (activity row, `fleet.approval.resolved` webhook, `fleet_approval` live event) are recorded from the
 * durable outbox event `ApprovalRequestEvents` writes in the deciding transaction, instead of after the decision
 * committed. A crash between the decision and the outputs therefore loses nothing: the relay redelivers the event, and
 * `FleetApprovalAsk.recordedStatus` makes the redelivery a no-op.
 *
 * The relay runs this handler inside `runAsSystem('outbox')`, so the writes are delivery bookkeeping of the change the
 * engine already audited: no `@SystemWriter`, no audit rows of its own.
 */
@Injectable()
export class FleetAskEventsSubscriber implements OnModuleInit {
  private readonly logger = new Logger(FleetAskEventsSubscriber.name);

  constructor(
    private readonly registry: FanOutPublisher,
    private readonly store: FleetApprovalAskStore,
    private readonly queries: ApprovalRequestQueries,
    private readonly closer: ApprovalCloser,
    @Inject(BUDGET_REPOSITORY) private readonly budgets: Pick<IBudgetRepository, 'findById'>,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
  ) {}

  onModuleInit(): void {
    this.registry.register(APPROVAL_REQUEST_CHANGED, this.handle);
  }

  /** Keep the relay's context and let database failures trigger its retry. */
  private readonly handle = async (payload: unknown): Promise<void> => {
    const p = parseApprovalRequestChangedPayload(payload);
    if (!p) {
      this.logger.warn(`${APPROVAL_REQUEST_CHANGED}: malformed payload skipped`);
      return;
    }
    if (!RECORDED_STATUSES.has(p.status) || !FLEET_ASK_KEYS.includes(p.permissionKey)) return;

    await this.record(p.requestId, p.status);
  };

  /**
   * One settle's outputs, in one transaction with its `recordedStatus`, under a `FOR UPDATE` lock on the link. The lock
   * is what makes the marker a claim: two concurrent deliveries of the same event serialise here, and the loser sees the
   * recorded status and writes nothing. The live frame is not published here — `FleetApprovalLiveSubscriber` derives it
   * from the same durable event, so a crash between this commit and any publication loses no live event.
   */
  private record(requestId: string, status: string): Promise<boolean> {
    return this.txManager.run(async () => {
      const link = await this.store.lockByRequest(requestId);
      // A non-fleet request, a request with no link, or this status already recorded: nothing to write.
      if (link === null || link.recordedStatus === status) return false;
      const request = await this.queries.findById(requestId);
      const view = await this.store.findApproval(requestId);
      if (request === null || view === null) return false;
      // Legacy repair can restore a wrongly expired ask while its old outbox event is still awaiting delivery.
      if (status === 'expired' && request.status !== 'expired') return false;

      // The fleet fills the resolution while the column is still null, exactly as the view derives it.
      if (link.resolvedBy === null) await this.store.setResolvedBy(requestId, status === 'expired' ? 'timeout' : 'user');
      await this.closer.recordResolved(view, await this.actorFor(request, view));
      await this.store.setRecordedStatus(requestId, status);
      return true;
    });
  }

  /**
   * Who the fleet attributes the resolution to: the decider for a decided ask, and for an expiry the ask's
   * on-behalf-of user, else the policy's last editor (the budget half has no single requester).
   */
  private async actorFor(request: ApprovalRequestRecord, view: FleetApprovalRecord): Promise<ApprovalActor> {
    if (request.status === 'expired') {
      const onBehalfOf = request.onBehalfOf;
      const responsibleUserId = onBehalfOf?.type === 'USER'
        ? onBehalfOf.id
        : view.policyId === null ? null : (await this.budgets.findById(view.policyId))?.updatedById ?? null;
      return { type: 'SYSTEM', id: SYSTEM_ACTOR.id, responsibleUserId };
    }
    const decider = request.approverId;
    // The fleet activity vocabulary has no agent actor: a decision is attributed to the decider as a user, which is what
    // the adapter wrote before the recorder moved into the outbox (P3 keeps that attribution).
    if (decider === null) return { type: 'SYSTEM', id: SYSTEM_ACTOR.id, responsibleUserId: null };
    return { type: 'USER', id: decider, responsibleUserId: decider };
  }
}
