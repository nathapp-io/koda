import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { LiveFleetApprovalEvent } from '../../live/live-event';
import { ProjectEventBus } from '../../live/project-event-bus';
import type { FleetApprovalRecord } from './domain/approval.domain';

/** How a batch reaches the bus. */
export interface LivePublishOptions {
  /**
   * Publication of a durable, outbox-backed producer (US-009): a listener that throws makes this call throw, so the
   * caller's relay retries the event, and a frame a listener already received (same id) is skipped on that retry. The
   * caller must `acknowledge` the batch once its own publication marker has committed, so the bus can release the ids.
   *
   * Without it the batch is published the plain way: subscribers are told, and a failing listener is logged and
   * skipped, because callers outside a relay have already committed and must not fail on a client's socket.
   */
  retryable?: boolean;
}

/** Builds fleet_approval live events inside a transaction; publishes them only after it commits. */
@Injectable()
export class ApprovalLivePublisher {
  constructor(private readonly bus: ProjectEventBus) {}

  /** [] for an approval with no project: there is no admin live channel (spec §2.5). */
  event(a: Pick<FleetApprovalRecord, 'id' | 'projectId' | 'status'>): LiveFleetApprovalEvent[] {
    if (!a.projectId) return [];
    return [{ id: randomUUID(), type: 'fleet_approval', projectId: a.projectId, approvalId: a.id, status: a.status, at: new Date().toISOString() }];
  }

  publish(events: readonly LiveFleetApprovalEvent[], options: LivePublishOptions = {}): void {
    for (const event of events) {
      if (options.retryable === true) this.bus.publishRetryable(event);
      else this.bus.publish(event);
    }
  }

  /** Releases the delivered ids of a `retryable` publication; call it only after the caller's marker committed. */
  acknowledge(events: readonly LiveFleetApprovalEvent[]): void {
    for (const event of events) this.bus.acknowledgeRetryable(event);
  }
}
