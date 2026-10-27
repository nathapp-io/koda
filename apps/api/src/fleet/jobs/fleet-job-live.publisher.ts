import { Injectable } from '@nestjs/common';
import { committedEffect } from '../../common/committed-effects';
import { randomUUID } from 'crypto';
import type { LiveFleetJobEvent } from '../../live/live-event';
import { ProjectEventBus } from '../../live/project-event-bus';
import { ThreadEventBus, type ThreadLiveEvent } from '../../live/thread-event-bus';
import type { FleetJobRecord } from './domain/fleet-job.domain';

/**
 * A fleet_job event that may carry the THREAD live events of the same transition (fleet S5a #264). The carried
 * events are server-side only: `publish` routes them to the thread bus and never puts them on the project bus.
 */
export type FleetJobLiveEvent = LiveFleetJobEvent & { readonly threadEvents?: readonly ThreadLiveEvent[] };

/** Builds fleet_job live events inside a transaction; publishes them only after it commits. */
@Injectable()
export class FleetJobLivePublisher {
  constructor(private readonly bus: ProjectEventBus, private readonly threads: ThreadEventBus) {}

  event(job: Pick<FleetJobRecord, 'id' | 'projectId' | 'state'>): LiveFleetJobEvent {
    return { id: randomUUID(), type: 'fleet_job', projectId: job.projectId, jobId: job.id, state: job.state, at: new Date().toISOString() };
  }

  publish(events: readonly FleetJobLiveEvent[]): void {
    committedEffect(() => {
      for (const event of events) {
        const { threadEvents, ...fleetEvent } = event;
        this.bus.publish(fleetEvent);
        for (const threadEvent of threadEvents ?? []) this.threads.publish(threadEvent);
      }
    });
  }
}
