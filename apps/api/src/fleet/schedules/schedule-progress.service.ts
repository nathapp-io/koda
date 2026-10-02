import { Inject, Injectable } from '@nestjs/common';
import { WebhookDispatcherService } from '../../webhook/webhook-dispatcher.service';
import { FleetActivityService } from '../activity/fleet-activity.service';
import type { FleetJobRecord } from '../jobs/domain/fleet-job.domain';
import { AutoDisableReason, IScheduleRepository, SCHEDULE_REPOSITORY, SchedulePatch, ScheduleRecord } from './domain/schedule.domain';
import { judgeEndedJob } from './schedule-progress-rules';
import { SYSTEM_ACTOR_ID, schedulePayload, scheduleWebhookPayload } from './schedule-payloads';

/**
 * S1b §3.3. Counts the end of a scheduled job against its schedule and auto-disables it. It depends only on
 * repositories, the activity log and the webhook dispatcher, never on FleetJobsService (plan D192: no DI cycle).
 * Call inside the transaction that ended the job: the activity row and the webhook outbox row commit with it.
 */
@Injectable()
export class ScheduleProgressService {
  constructor(
    @Inject(SCHEDULE_REPOSITORY) private readonly repo: IScheduleRepository,
    private readonly activity: FleetActivityService,
    private readonly webhooks: WebhookDispatcherService,
  ) {}

  /** `job` is the record after the terminal transition. */
  async onJobEnded(job: FleetJobRecord, now: Date): Promise<void> {
    if (!job.scheduleId || job.scheduleCountedAt || job.state === 'CANCELLED') return;
    if (!(await this.repo.claimCounted(job.id, now))) return;
    const schedule = await this.repo.lockById(job.scheduleId);
    if (!schedule) return;
    const verdict = judgeEndedJob(job, schedule.lastPassedCount);
    if (verdict.kind === 'progress') {
      await this.repo.update(schedule.id, { noProgressTicks: 0, lastPassedCount: verdict.passed });
      return;
    }
    // Plan D197: a schedule that is already off keeps its reason; only progress is recorded.
    if (!schedule.enabled || verdict.kind === 'ignore') return;
    if (verdict.kind === 'disable') {
      await this.disableLocked(schedule, verdict.reason, { jobId: job.id });
      return;
    }
    const ticks = schedule.noProgressTicks + 1;
    if (ticks >= schedule.noProgressLimit) await this.disableLocked(schedule, 'no_progress', { jobId: job.id }, { noProgressTicks: ticks });
    else await this.repo.update(schedule.id, { noProgressTicks: ticks });
  }

  /** Auto-disable outside a job end (the ticker: owner lost access, template invalid). False when nothing changed. */
  async disable(scheduleId: string, reason: AutoDisableReason, detail: { jobId?: string } = {}): Promise<boolean> {
    const schedule = await this.repo.lockById(scheduleId);
    if (!schedule || !schedule.enabled) return false;
    await this.disableLocked(schedule, reason, detail);
    return true;
  }

  private async disableLocked(schedule: ScheduleRecord, reason: AutoDisableReason, detail: { jobId?: string }, counters: SchedulePatch = {}): Promise<void> {
    const after = await this.repo.update(schedule.id, { ...counters, enabled: false, disabledReason: reason });
    await this.activity.record({
      actorType: 'SYSTEM', actorId: SYSTEM_ACTOR_ID, action: 'schedule.auto_disabled', entityType: 'schedule', entityId: schedule.id,
      jobId: detail.jobId ?? null, projectId: schedule.projectId, responsibleUserId: schedule.createdById,
      payload: schedulePayload(after, { reason }),
    });
    await this.webhooks.dispatch(schedule.projectId, 'fleet.schedule.disabled', scheduleWebhookPayload(after, reason));
  }
}
