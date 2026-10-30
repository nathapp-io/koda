import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import type { ApprovalRequestRecord } from '../../approvals/domain/approval.domain';
import { ApprovalRequestQueries } from '../../approvals/approval-request.queries';
import { APPROVAL_REQUEST_CHANGED, parseApprovalRequestChangedPayload } from '../../approvals/approval-request-events';
import { FanOutPublisher } from '../../outbox/fan-out-publisher';
import { BUDGET_REPOSITORY, type IBudgetRepository } from '../budgets/domain/budget.domain';
import { SYSTEM_ACTOR } from '../common/system-actor';
import { ApprovalCloser, deciderActor, type ApprovalActor } from './approval-closer';
import { FLEET_ASK_KEYS } from './domain/approval.domain';
import type { FleetApprovalAskRecord } from './domain/fleet-approval-ask.domain';
import { FleetApprovalAskStore } from './fleet-approval-ask.store';

/**
 * The four engine statuses the fleet must record for itself. The other three are the fleet's own:
 * `pending` at open and `cancelled` at close are written by `ApprovalCloser` in the producer's transaction, and
 * `approved` is skipped because `executed` or `failed` always follows it.
 */
const RECORDED_STATUSES: ReadonlySet<string> = new Set(['rejected', 'executed', 'failed', 'expired']);

/**
 * Records the fleet activity for engine-owned settlements from the durable outbox. The link lock and
 * recordedStatus make activity and its marker atomic and once-only, including concurrent redeliveries.
 * ApprovalRequestLiveSubscriber independently publishes the engine's approval_request event.
 * The relay supplies the system:outbox context; these are delivery bookkeeping, not new audited actions.
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

  /** One activity and its marker in the same transaction, serialised by the link's FOR UPDATE lock. */
  private record(requestId: string, status: string): Promise<void> {
    return this.txManager.run(async () => {
      const link = await this.store.lockByRequest(requestId);
      if (link === null || link.recordedStatus === status) return;
      const request = await this.queries.findById(requestId);
      if (request === null) return;
      // Legacy repair can restore a wrongly expired ask while its old outbox event is still awaiting delivery.
      if (status === 'expired' && request.status !== 'expired') return;

      if (link.resolvedBy === null) await this.store.setResolvedBy(requestId, status === 'expired' ? 'timeout' : 'user');
      await this.store.setRecordedStatus(requestId, status);
      const view = await this.store.findApproval(requestId);
      if (view === null) return;
      await this.closer.recordResolved(view, await this.actorFor(link, request, status));
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
      // The relay runs as `system:outbox`: nothing downstream can infer the decider's type, so the decision carries it.
      if (decision === undefined) return { type: 'SYSTEM', id: SYSTEM_ACTOR.id, responsibleUserId: null };
      return deciderActor(decision);
    }
    const onBehalfOf = request.onBehalfOf;
    if (onBehalfOf?.type === 'USER') return { type: 'SYSTEM', id: SYSTEM_ACTOR.id, responsibleUserId: onBehalfOf.id };
    const policy = link.budgetPolicyId === null ? null : await this.budgets.findById(link.budgetPolicyId);
    return { type: 'SYSTEM', id: SYSTEM_ACTOR.id, responsibleUserId: policy?.updatedById ?? null };
  }
}
