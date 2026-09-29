import { Inject, Injectable, Logger } from '@nestjs/common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import type { LiveFleetJobEvent } from '../../live/live-event';
import { FleetActivityService } from '../activity/fleet-activity.service';
import type { JobAck, JobReport } from '../common/protocol';
import { FleetJobLivePublisher } from '../jobs/fleet-job-live.publisher';
import { canTransition, isTerminal } from '../jobs/job-state';
import { JobTransitionsService } from '../jobs/job-transitions.service';
import { FLEET_JOB_REPOSITORY, FleetJobEventRecord, FleetJobRecord, IFleetJobRepository } from '../jobs/domain/fleet-job.domain';
import { interpretEvent } from './event-payloads';
import { FenceService } from './fence.service';
import { stableStringify } from './stable-json';

export interface ReportOutcome {
  ack: JobAck | null;
  unknown: boolean;
  live: LiveFleetJobEvent[];
}

const NONE: ReportOutcome = Object.freeze({ ack: null, unknown: false, live: [] });

/**
 * One job's events from one sync, in one transaction (spec §3.2, plan D2/D5/D6): fence,
 * dedup on (epoch, runnerSeq), store, then apply only the contiguous prefix above the
 * cumulative ack. A resent seq with a different payload rejects the whole report.
 */
@Injectable()
export class JobReportProcessor {
  private readonly logger = new Logger(JobReportProcessor.name);

  constructor(
    @Inject(FLEET_JOB_REPOSITORY) private readonly repo: IFleetJobRepository,
    private readonly transitions: JobTransitionsService,
    private readonly live: FleetJobLivePublisher,
    private readonly fence: FenceService,
    private readonly activity: FleetActivityService,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
  ) {}

  process(runnerId: string, report: JobReport, now: Date): Promise<ReportOutcome> {
    return this.txManager.run(async () => {
      const job = await this.repo.lockById(report.jobId);
      if (!job) return { ...NONE, unknown: true };
      if (!this.fence.holds(job, runnerId, report.leaseEpoch)) {
        await this.fence.abandon(runnerId, job, report.leaseEpoch);
        return NONE;
      }
      const events = [...report.events].sort((a, b) => a.seq - b.seq);
      const stored = new Map((await this.repo.findRunnerEvents(job.id, job.leaseEpoch, events.map((e) => e.seq))).map((e) => [e.runnerSeq, e]));
      const conflict = events.find((e) => {
        const prior = stored.get(e.seq);
        return prior !== undefined && (prior.type !== e.type || stableStringify(prior.payload) !== stableStringify(e.payload));
      });
      if (conflict) {
        this.logger.warn(`Protocol error: job ${job.id} epoch ${job.leaseEpoch} seq ${conflict.seq} resent with a different payload`);
        return { ...NONE, ack: { jobId: job.id, ackedSeq: job.ackedRunnerSeq } };
      }
      for (const e of events) {
        if (!stored.has(e.seq)) await this.repo.appendEvent(job.id, { leaseEpoch: job.leaseEpoch, runnerSeq: e.seq, type: e.type, payload: e.payload });
      }
      return this.applyContiguous(job, runnerId, now);
    });
  }

  private async applyContiguous(job: FleetJobRecord, runnerId: string, now: Date): Promise<ReportOutcome> {
    let current = job;
    let next = job.ackedRunnerSeq + 1;
    let mirrored = false;
    const live: LiveFleetJobEvent[] = [];
    for (const event of await this.repo.findRunnerEventsAfter(job.id, job.leaseEpoch, job.ackedRunnerSeq)) {
      if (event.runnerSeq !== next) break;
      const applied = await this.applyOne(current, event, runnerId, now);
      current = applied.job;
      if (applied.live) live.push(applied.live);
      mirrored = mirrored || applied.mirrored;
      next += 1;
    }
    const ackedSeq = next - 1;
    if (ackedSeq !== job.ackedRunnerSeq) current = await this.repo.update(job.id, { ackedRunnerSeq: ackedSeq });
    if (mirrored && live.length === 0) live.push(this.live.event(current));
    return { ack: { jobId: job.id, ackedSeq }, unknown: false, live };
  }

  private async applyOne(job: FleetJobRecord, event: FleetJobEventRecord, runnerId: string, now: Date): Promise<{ job: FleetJobRecord; live?: LiveFleetJobEvent; mirrored: boolean }> {
    const effect = interpretEvent(event.type, event.payload);
    if (effect.kind === 'none') return { job, mirrored: false };
    if (effect.kind === 'mirror') return { job: await this.repo.update(job.id, effect.patch), mirrored: true };
    if (effect.kind === 'transition' && canTransition(job.state, effect.to, 'runner')) {
      const r = await this.transitions.apply({
        job, to: effect.to, by: 'runner', now, actor: { type: 'RUNNER', id: runnerId }, reason: effect.reason,
        extra: effect.exitCode === null ? {} : { exitCode: effect.exitCode },
      });
      return { job: r.job, live: r.live, mirrored: false };
    }
    const reason = effect.kind === 'invalid' ? effect.reason : `transition ${job.state} -> ${effect.to}`;
    this.logger.warn(`Rejected runner event on job ${job.id} (runnerSeq ${event.runnerSeq}): ${reason}`);
    await this.activity.record({
      actorType: 'RUNNER', actorId: runnerId, action: 'job.event_rejected', entityType: 'job', entityId: job.id, jobId: job.id,
      projectId: job.projectId, responsibleUserId: job.requestedById, payload: { runnerSeq: event.runnerSeq, type: event.type, reason },
    });
    return { job, mirrored: false };
  }
}
