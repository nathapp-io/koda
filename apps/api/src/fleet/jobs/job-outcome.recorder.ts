import { Inject, Injectable } from '@nestjs/common';
import { OutboxService } from '@nathapp/nestjs-outbox';
import { FleetJobState } from '../../common/enums';
import {
  buildJobOutcomePayload, FLEET_JOB_OUTCOME, JobOutcome, jobOutcomeOf,
} from '../../notifications/fleet/fleet-notification-events';
import { FLEET_JOB_REPOSITORY, FleetJobRecord, IFleetJobRepository } from './domain/fleet-job.domain';
import { isThreadKind } from '../common/thread-jobs';

/** US-002: an agent requested the job, so nothing that reads a user is meaningful for its requester. */
const isAgentRequested = (job: Pick<FleetJobRecord, 'requestedByType'>): boolean => job.requestedByType === 'AGENT';

/**
 * Fleet S4a §2.4 (D513): the enqueue side of `fleet_job_outcome`. Always called inside the caller's transaction,
 * so the outbox row commits or rolls back with the state change. The source id is `<jobId>:<leaseEpoch>` read
 * after the update: a requeued attempt that ends the same way notifies again; a retry of the same attempt does not.
 *
 * US-002: a job an agent requested enqueues nothing — a job-outcome notification is addressed to the requester's
 * user rows (in-app notification, watchers), and agents have none.
 */
@Injectable()
export class FleetJobOutcomeRecorder {
  constructor(
    @Inject(FLEET_JOB_REPOSITORY) private readonly repo: Pick<IFleetJobRepository, 'findRepo'>,
    private readonly outbox: OutboxService,
  ) {}

  async onTerminal(job: FleetJobRecord): Promise<void> {
    if (isAgentRequested(job) || isThreadKind(job.command)) return;
    const outcome = jobOutcomeOf(job.state, job.resultPrUrl);
    if (outcome) await this.enqueue(job, outcome);
  }

  async onIngestCorrection(job: FleetJobRecord, change: { escalated: boolean; prFilled: boolean }): Promise<void> {
    if (isAgentRequested(job)) return;
    if (change.escalated) {
      await this.enqueue(job, 'escalated');
      return;
    }
    if (change.prFilled && job.state === FleetJobState.COMPLETED && job.resultPrUrl) await this.enqueue(job, 'pr_opened');
  }

  private async enqueue(job: FleetJobRecord, outcome: JobOutcome): Promise<void> {
    const repo = await this.repo.findRepo(job.repoId);
    await this.outbox.record({
      type: FLEET_JOB_OUTCOME,
      payload: buildJobOutcomePayload(job, repo ? `${repo.owner}/${repo.name}` : job.repoId, outcome),
      metadata: { projectId: job.projectId, eventId: `${job.id}:${job.leaseEpoch}` },
    });
  }
}
