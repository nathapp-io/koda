import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import type { ApprovalRequestRecord } from '../../approvals/domain/approval.domain';
import { ApprovalRequestQueries } from '../../approvals/approval-request.queries';
import { APPROVAL_REQUEST_CHANGED, parseApprovalRequestChangedPayload } from '../../approvals/approval-request-events';
import type { LiveFleetApprovalEvent } from '../../live/live-event';
import { FanOutPublisher } from '../../outbox/fan-out-publisher';
import { BUDGET_REPOSITORY, type IBudgetRepository } from '../budgets/domain/budget.domain';
import { SYSTEM_ACTOR } from '../common/system-actor';
import { ApprovalCloser, userActor, type ApprovalActor } from './approval-closer';
import { ApprovalLivePublisher } from './approval-live.publisher';
import { FLEET_ASK_KEYS, type FleetApprovalRecord } from './domain/approval.domain';
import type { FleetApprovalAskRecord } from './domain/fleet-approval-ask.domain';
import { FleetApprovalAskStore } from './fleet-approval-ask.store';

/**
 * The four engine statuses the fleet must record for itself. The other three are the fleet's own:
 * `pending` at open and `cancelled` at close are written by `ApprovalCloser` in the producer's transaction, and
 * `approved` is skipped because `executed` or `failed` always follows it.
 */
const RECORDED_STATUSES: ReadonlySet<string> = new Set(['rejected', 'executed', 'failed', 'expired']);

/**
 * Permissions P3 US-009: the fleet's three outputs for the statuses the *engine* sets — the activity row, the
 * `fleet.approval.resolved` webhook and the `fleet_approval` live event — are recorded from the durable outbox event
 * `ApprovalRequestEvents` writes in the deciding (or expiring) transaction, instead of after it committed. A crash
 * between that commit and the outputs therefore loses nothing: the relay redelivers the event, and
 * `FleetApprovalAsk.recordedStatus` makes the redelivery a no-op.
 *
 * The relay runs this handler inside `runAsSystem('outbox')`, so the writes are delivery bookkeeping of the change the
 * engine already audited: no `@SystemWriter`, no audit rows of its own. The live frame is built inside the transaction
 * from the committed view but published only after it, so a reader never sees a frame for a rollback.
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
    private readonly live: ApprovalLivePublisher,
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

    const live = await this.record(p.requestId, p.status);
    if (live.length > 0) this.live.publish(live);
  };

  /**
   * One settle's outputs, in one transaction with its `recordedStatus`, under a `FOR UPDATE` lock on the link. The lock
   * is what makes the marker a claim: two concurrent deliveries of the same event serialise here, and the loser sees the
   * recorded status and writes nothing. Answers the live frames the caller publishes once this transaction returned.
   */
  private record(requestId: string, status: string): Promise<LiveFleetApprovalEvent[]> {
    return this.txManager.run(async () => {
      const link = await this.store.lockByRequest(requestId);
      // A non-fleet request, a request with no link, or this status already recorded: nothing to write.
      if (link === null || link.recordedStatus === status) return [];
      const request = await this.queries.findById(requestId);
      if (request === null) return [];
      // Legacy repair can restore a wrongly expired ask while its old outbox event is still awaiting delivery.
      if (status === 'expired' && request.status !== 'expired') return [];

      // The fleet fills the resolution while the column is still null, exactly as the view derives it.
      if (link.resolvedBy === null) await this.store.setResolvedBy(requestId, status === 'expired' ? 'timeout' : 'user');
      await this.store.setRecordedStatus(requestId, status);
      const view = await this.store.findApproval(requestId);
      if (view === null) return [];
      // `recordResolved` writes the activity row and the webhook, and answers the live frame of the fleet status.
      return this.closer.recordResolved(view, await this.actorFor(link, request, status));
    });
  }

  /**
   * Who the fleet attributes the resolution to: the last decision's decider for a decided ask, and for an expiry the
   * ask's on-behalf-of user, else the policy's last editor (the budget half has no single requester). The event payload
   * carries neither, so both reads go through the engine's existing queries.
   */
  private async actorFor(link: FleetApprovalAskRecord, request: ApprovalRequestRecord, status: string): Promise<ApprovalActor> {
    if (status !== 'expired') {
      const decision = (await this.queries.decisionsFor(request.id)).at(-1);
      // The fleet activity vocabulary has no agent actor: a decision is attributed to the decider as a user, which is
      // what the adapter wrote before the recorder moved into the outbox (P3 keeps that attribution).
      if (decision === undefined) return { type: 'SYSTEM', id: SYSTEM_ACTOR.id, responsibleUserId: null };
      return userActor(decision.deciderId);
    }
    const onBehalfOf = request.onBehalfOf;
    if (onBehalfOf?.type === 'USER') return { type: 'SYSTEM', id: SYSTEM_ACTOR.id, responsibleUserId: onBehalfOf.id };
    const policy = link.budgetPolicyId === null ? null : await this.budgets.findById(link.budgetPolicyId);
    return { type: 'SYSTEM', id: SYSTEM_ACTOR.id, responsibleUserId: policy?.updatedById ?? null };
  }
}
