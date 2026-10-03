import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { LiveFleetApprovalEvent } from '../../live/live-event';
import { ProjectEventBus } from '../../live/project-event-bus';
import type { FleetApprovalRecord } from './domain/approval.domain';

/** Builds fleet_approval live events inside a transaction; publishes them only after it commits. */
@Injectable()
export class ApprovalLivePublisher {
  constructor(private readonly bus: ProjectEventBus) {}

  /** [] for an approval with no project: there is no admin live channel (spec §2.5). */
  event(a: Pick<FleetApprovalRecord, 'id' | 'projectId' | 'status'>): LiveFleetApprovalEvent[] {
    if (!a.projectId) return [];
    return [{ id: randomUUID(), type: 'fleet_approval', projectId: a.projectId, approvalId: a.id, status: a.status, at: new Date().toISOString() }];
  }

  publish(events: readonly LiveFleetApprovalEvent[]): void {
    for (const event of events) this.bus.publish(event);
  }
}
