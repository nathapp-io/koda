import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { parseApprovalRequestChangedPayload, APPROVAL_REQUEST_CHANGED } from '../../approvals/approval-request-events';
import { ProjectEventBus } from '../../live/project-event-bus';
import type { LiveEvent } from '../../live/live-event';
import { FanOutPublisher } from '../../outbox/fan-out-publisher';
import { FLEET_ASK_KEYS, type ApprovalStatus } from './domain/approval.domain';

/**
 * The four engine statuses whose `fleet_approval` frame the fleet does not write itself. `pending` and `cancelled` are
 * published by `ApprovalCloser` inside the producer's transaction, and `approved` is followed by `executed`/`failed`.
 */
const LIVE_STATUS: Readonly<Record<string, ApprovalStatus>> = {
  rejected: 'rejected', executed: 'approved', failed: 'cancelled', expired: 'expired',
};

/**
 * Permissions P3 US-007 (fix round 3): the `fleet_approval` live frame of a settled ask is derived from the durable
 * `approval_request_changed` event, in its own consumer, instead of being published by the recorder after its
 * transaction committed. A crash between the recorder's commit and any publication therefore loses no frame: the relay
 * delivers the event again and this handler publishes it.
 *
 * Best-effort by design (the live buses are in-process), and idempotent by construction: the frame's id is the event's
 * request and status, so a redelivery repeats the same frame rather than inventing a new one.
 */
@Injectable()
export class FleetApprovalLiveSubscriber implements OnModuleInit {
  private readonly logger = new Logger(FleetApprovalLiveSubscriber.name);

  constructor(private readonly registry: FanOutPublisher, private readonly bus: ProjectEventBus) {}

  onModuleInit(): void {
    this.registry.register(APPROVAL_REQUEST_CHANGED, this.handle);
  }

  private readonly handle = (payload: unknown): void => {
    try {
      const p = parseApprovalRequestChangedPayload(payload);
      if (!p || p.projectId === null || !FLEET_ASK_KEYS.includes(p.permissionKey)) return;
      const status = LIVE_STATUS[p.status];
      if (status === undefined) return;
      const event: LiveEvent = {
        id: `${p.requestId}:${p.status}:fleet`,
        type: 'fleet_approval',
        projectId: p.projectId,
        approvalId: p.requestId,
        status,
        at: new Date().toISOString(),
      };
      this.bus.publish(event);
    } catch (error) {
      // Never a reason to retry the outbox: a dropped frame is a best-effort miss, not a lost write.
      this.logger.warn(`fleet approval live event dropped: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
}
