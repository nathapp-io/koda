import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { APPROVAL_REQUEST_CHANGED, parseApprovalRequestChangedPayload } from '../approvals/approval-request-events';
import { FanOutPublisher } from '../outbox/fan-out-publisher';
import { ProjectEventBus } from './project-event-bus';

/** Best-effort, content-free project invalidation; never causes an outbox retry. */
@Injectable()
export class ApprovalRequestLiveSubscriber implements OnModuleInit {
  private readonly logger = new Logger(ApprovalRequestLiveSubscriber.name);

  constructor(private readonly registry: FanOutPublisher, private readonly bus: ProjectEventBus) {}

  onModuleInit(): void {
    this.registry.register(APPROVAL_REQUEST_CHANGED, this.handle);
  }

  private readonly handle = (payload: unknown): void => {
    try {
      const p = parseApprovalRequestChangedPayload(payload);
      if (!p) {
        this.logger.warn(`${APPROVAL_REQUEST_CHANGED}: malformed payload skipped`);
        return;
      }
      if (p.projectId === null) return;
      this.bus.publish({
        id: `${p.requestId}:${p.status}`, type: 'approval_request', projectId: p.projectId,
        requestId: p.requestId, status: p.status, at: new Date().toISOString(),
      });
    } catch (err) {
      this.logger.warn(`Live approval request event dropped: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}
