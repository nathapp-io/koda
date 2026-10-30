import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import type { ApprovalRequestRecord } from '../../approvals/domain/approval.domain';
import { ApprovalRequestQueries } from '../../approvals/approval-request.queries';
import { APPROVAL_REQUEST_CHANGED, parseApprovalRequestChangedPayload } from '../../approvals/approval-request-events';
import type { LiveFleetApprovalEvent } from '../../live/live-event';
import { FanOutPublisher } from '../../outbox/fan-out-publisher';
import { BUDGET_REPOSITORY, type IBudgetRepository } from '../budgets/domain/budget.domain';
import { SYSTEM_ACTOR } from '../common/system-actor';
import { ApprovalCloser, deciderActor, type ApprovalActor } from './approval-closer';
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
 * The live frame's durable identity. A retry of a publication that was never acknowledged republishes this same id,
 * so a consumer can recognise the frame it already has instead of reporting the settlement twice.
 */
const liveFrameId = (requestId: string, status: string): string => `${requestId}:${status}:fleet`;

/**
 * Permissions P3 US-009: the fleet's activity row and `fleet_approval` live event for statuses the *engine* sets
 * are recorded from the durable outbox event `ApprovalRequestEvents` writes in the deciding (or expiring) transaction,
 * instead of after it committed. Engine webhook delivery is handled separately by `ApprovalRequestEvents`. A crash
 * between that commit and the fleet outputs therefore loses nothing: the relay redelivers the event, and
 * `FleetApprovalAsk.recordedStatus` makes the redelivery a no-op.
 *
 * Recording and live delivery carry independent acknowledgements (`recordedStatus`, `publishedStatus`): an undelivered
 * frame is republished by the next delivery even though its activity row is already written, and a
 * delivered frame is not published twice. The frame leaves only after the transaction that recorded it returned, so a
 * reader never sees a frame for a rollback, and it is published *retryably*: a listener that failed keeps the
 * publication unacknowledged, so the relay's retry reaches it — the listeners that already had the frame (same id) are
 * skipped.
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
    if (live.length === 0) return;
    // Retryable publication: a listener that fails makes this throw, the relay retries the event, and the listeners
    // that already had the frame skip it. The marker is written only once every listener succeeded, and the delivered
    // ids are released only once that marker committed — so a crash at either point leaves the frame retryable.
    this.live.publish(live, { retryable: true });
    await this.txManager.run(async () => {
      await this.store.setPublishedStatus(p.requestId, p.status);
    });
    this.live.acknowledge(live);
  };

  /**
   * One settle's outputs, in one transaction with its `recordedStatus`, under a `FOR UPDATE` lock on the link. The lock
   * is what makes each marker a claim: two concurrent deliveries of the same event serialise here, and the loser sees the
   * recorded status and writes nothing. Answers the frames still to publish — the fresh ones, or the ones an earlier
   * delivery recorded but never acknowledged — and the caller publishes them once this transaction returned.
   */
  private record(requestId: string, status: string): Promise<LiveFleetApprovalEvent[]> {
    return this.txManager.run(async () => {
      const link = await this.store.lockByRequest(requestId);
      // A non-fleet request, a request with no link, or an event whose outputs and frame are both already settled.
      if (link === null) return [];
      const record = link.recordedStatus !== status;
      const publish = link.publishedStatus !== status;
      if (!record && !publish) return [];
      const request = await this.queries.findById(requestId);
      if (request === null) return [];
      // Legacy repair can restore a wrongly expired ask while its old outbox event is still awaiting delivery.
      if (status === 'expired' && request.status !== 'expired') return [];

      // The fleet fills the resolution while the column is still null, exactly as the view derives it.
      if (record && link.resolvedBy === null) await this.store.setResolvedBy(requestId, status === 'expired' ? 'timeout' : 'user');
      if (record) await this.store.setRecordedStatus(requestId, status);
      if (!publish) return [];
      const view = await this.store.findApproval(requestId);
      if (view === null) return [];
      // `recordResolved` writes the activity row and answers the live frame of the fleet status. Engine webhook
      // delivery is independent; a redelivery that only owes the frame builds it from the view instead.
      const frames = record
        ? await this.closer.recordResolved(view, await this.actorFor(link, request, status))
        : this.live.event(view);
      return frames.map((frame) => ({ ...frame, id: liveFrameId(requestId, status) }));
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
