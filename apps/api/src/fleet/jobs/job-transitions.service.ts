import { Inject, Injectable } from '@nestjs/common';
import { FleetCommandType, FleetJobState } from '../../common/enums';
import type { LiveFleetApprovalEvent, LiveFleetJobEvent } from '../../live/live-event';
import { FleetActivityService } from '../activity/fleet-activity.service';
import { ApprovalCloser } from '../approvals/approval-closer';
import { canTransition, isTerminal, TransitionActor } from './job-state';
import { isConfigKind } from '../common/config-jobs';
import { FleetJobLivePublisher } from './fleet-job-live.publisher';
import { FLEET_JOB_REPOSITORY, FleetJobPatch, FleetJobRecord, IFleetJobRepository } from './domain/fleet-job.domain';
import { ScheduleProgressService } from '../schedules/schedule-progress.service';
import { SYSTEM_ACTOR, type TransitionActorRef } from '../common/system-actor';

// The actor of an automatic action lives in a leaf module so budgets, jobs and approvals can all name it
// without importing each other's services (§2.4 closes an approval from the jobs side — now via
// ApprovalStoreModule). Re-exported here because this module is where every importer found it first.
export { SYSTEM_ACTOR };
export type { TransitionActorRef };

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
    @Inject(FLEET_JOB_REPOSITORY) private readonly repo: Pick<IFleetJobRepository, 'update' | 'appendEvent' | 'withdrawPendingCommands' | 'copyConfigResult'>,
    private readonly activity: FleetActivityService,
    private readonly live: FleetJobLivePublisher,
    private readonly schedules: ScheduleProgressService,
    private readonly approvals: ApprovalCloser,
  ) {}

  async apply(input: {
    job: FleetJobRecord; to: FleetJobState; by: TransitionActor; now: Date; actor: TransitionActorRef;
    reason?: string | null; extra?: FleetJobPatch;
  }): Promise<{ job: FleetJobRecord; live: LiveFleetJobEvent; approvalLive: LiveFleetApprovalEvent[] }> {
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
    // Fleet S3 D475: the config job's last reported result becomes its edit row's record, in this transaction.
    if (terminal && isConfigKind(after.command)) await this.repo.copyConfigResult(after.id);
    const live = await this.record({ before: job, after, by, now, actor: input.actor, reason: input.reason });
    // Spec §1.4 / plan D263: nax has exited or is exiting, so its asks are moot and an unsent answer must not go out.
    const approvalLive = job.state === FleetJobState.RUNNING && to !== FleetJobState.RUNNING ? await this.leaveRunning(after, now) : [];
    // S1b §3.3: a scheduled job's end moves its schedule's counters in this same transaction.
    if (terminal && after.scheduleId) await this.schedules.onJobEnded(after, now);
    return { job: after, live, approvalLive };
  }

  private async leaveRunning(job: FleetJobRecord, now: Date): Promise<LiveFleetApprovalEvent[]> {
    await this.repo.withdrawPendingCommands(job.id, now, { types: [FleetCommandType.APPROVAL_ANSWER] });
    return this.approvals.closeForJob(job, now);
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
