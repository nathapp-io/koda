import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { LiveFleetJobEvent } from '../../live/live-event';
import { ProjectEventBus } from '../../live/project-event-bus';
import type { FleetJobRecord } from './domain/fleet-job.domain';

/** Builds fleet_job live events inside a transaction; publishes them only after it commits. */
@Injectable()
export class FleetJobLivePublisher {
  constructor(private readonly bus: ProjectEventBus) {}

  event(job: Pick<FleetJobRecord, 'id' | 'projectId' | 'state'>): LiveFleetJobEvent {
    return { id: randomUUID(), type: 'fleet_job', projectId: job.projectId, jobId: job.id, state: job.state, at: new Date().toISOString() };
  }

  publish(events: readonly LiveFleetJobEvent[]): void {
    for (const event of events) this.bus.publish(event);
  }
}
