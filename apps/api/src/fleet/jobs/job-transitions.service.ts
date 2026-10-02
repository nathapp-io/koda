import { Inject, Injectable } from '@nestjs/common';
import type { FleetActorType, FleetJobState } from '../../common/enums';
import type { LiveFleetJobEvent } from '../../live/live-event';
import { FleetActivityService } from '../activity/fleet-activity.service';
import { canTransition, isTerminal, TransitionActor } from './job-state';
import { FleetJobLivePublisher } from './fleet-job-live.publisher';
import { FLEET_JOB_REPOSITORY, FleetJobPatch, FleetJobRecord, IFleetJobRepository } from './domain/fleet-job.domain';

export interface TransitionActorRef {
  type: FleetActorType;
  id: string;
}

export const SYSTEM_ACTOR: TransitionActorRef = Object.freeze({ type: 'SYSTEM', id: 'system' });

export class InvalidTransitionError extends Error {
  constructor(readonly from: string, readonly to: string, readonly by: TransitionActor) {
    super(`transition ${from} -> ${to} by ${by} is not allowed`);
  }
}

/**
 * Every job state change goes through here (spec §5.4): table check, timestamps, the
 * plan D4 epoch bump, a server `state` event, FleetActivity. Call inside txManager.run;
 * publish the returned live event after commit.
 */
@Injectable()
export class JobTransitionsService {
  constructor(
    @Inject(FLEET_JOB_REPOSITORY) private readonly repo: Pick<IFleetJobRepository, 'update' | 'appendEvent' | 'withdrawPendingCommands'>,
    private readonly activity: FleetActivityService,
    private readonly live: FleetJobLivePublisher,
  ) {}

  async apply(input: {
    job: FleetJobRecord; to: FleetJobState; by: TransitionActor; now: Date; actor: TransitionActorRef;
    reason?: string | null; extra?: FleetJobPatch;
  }): Promise<{ job: FleetJobRecord; live: LiveFleetJobEvent }> {
    const { job, to, by, now } = input;
    if (!canTransition(job.state, to, by)) throw new InvalidTransitionError(job.state, to, by);
    const terminal = isTerminal(to);
    const bump = by === 'server' && terminal && job.runnerId !== null;
    const patch: FleetJobPatch = {
      ...(input.extra ?? {}),
      state: to,
      stateReason: input.reason ?? null,
      // S1b §2.1: firstStartedAt is the job's budget window; set once, never cleared (not even by requeue).
      ...(to === 'RUNNING' ? { startedAt: now, ...(job.firstStartedAt ? {} : { firstStartedAt: now }) } : {}),
      ...(terminal ? { finishedAt: now } : {}),
      ...(bump ? { bumpEpoch: true } : {}),
    };
    const after = await this.repo.update(job.id, patch);
    const live = await this.record({ before: job, after, by, now, actor: input.actor, reason: input.reason });
    return { job: after, live };
  }

  async record(input: {
    before: FleetJobRecord; after: FleetJobRecord; by: TransitionActor; now: Date; actor: TransitionActorRef; reason?: string | null;
  }): Promise<LiveFleetJobEvent> {
    const { before, after, by, now } = input;
    const reason = input.reason ?? null;
    if (isTerminal(after.state)) await this.repo.withdrawPendingCommands(after.id, now);
    await this.repo.appendEvent(after.id, {
      leaseEpoch: after.leaseEpoch, runnerSeq: null, type: 'state', payload: { from: before.state, to: after.state, by, reason },
    });
    await this.activity.record({
      actorType: input.actor.type, actorId: input.actor.id, action: `job.${after.state.toLowerCase()}`,
      entityType: 'job', entityId: after.id, jobId: after.id, projectId: after.projectId,
      responsibleUserId: after.requestedById, payload: { from: before.state, to: after.state, reason },
    });
    return this.live.event(after);
  }
}
