import { Inject, Injectable } from '@nestjs/common';
import { NotFoundAppException } from '@nathapp/nestjs-common';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import type { IPageOption } from '@nathapp/nestjs-common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import type { IPageResult } from '@nathapp/nestjs-data';
import { remapPage } from '../../common/dto/koda-page.query';
import { FleetActivityService } from '../activity/fleet-activity.service';
import { IRunnerRepository, RUNNER_REPOSITORY, RunnerPatch } from './domain/runner.domain';
import { FLEET_CFG, IFleetConfig } from '../../config/fleet.config';
import { RunnerDto, RunnerView } from './dto/runner.dto';
import { RunnerSummaryDto } from './dto/runner-summary.dto';
import { AuditRecorder } from '../../audit/audit-recorder.service';
import { fieldsSummary } from '../../audit/audit-summary';
import { FleetJobsService } from '../jobs/fleet-jobs.service';
import { FleetJobLivePublisher } from '../jobs/fleet-job-live.publisher';
import { RunnerNotifier } from '../jobs/runner-notifier';

@Injectable()
export class RunnersService {
  constructor(
    @Inject(RUNNER_REPOSITORY) private readonly repo: IRunnerRepository,
    private readonly activity: FleetActivityService,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
    @Inject(FLEET_CFG) private readonly fleetConfig: Pick<IFleetConfig, 'runnerOfflineSec'>,
    private readonly audit: AuditRecorder,
    private readonly jobs: FleetJobsService,
    private readonly live: FleetJobLivePublisher,
    private readonly notifier: RunnerNotifier,
  ) {}

  private view(now: Date): RunnerView {
    return { now, offlineSec: this.fleetConfig.runnerOfflineSec };
  }

  async list(page: IPageOption, now = new Date()): Promise<IPageResult<RunnerDto>> {
    const view = this.view(now);
    return remapPage(await this.repo.findRunnerPage(page), (r) => RunnerDto.from(r, view));
  }

  /** Every runner, as a project member may see it (runners are global, overview D118). */
  async listSummaries(page: IPageOption, now = new Date()): Promise<IPageResult<RunnerSummaryDto>> {
    const view = this.view(now);
    return remapPage(await this.repo.findRunnerPage(page), (r) => RunnerSummaryDto.from(r, view));
  }

  async get(id: string, now = new Date()): Promise<RunnerDto> {
    const runner = await this.repo.findRunnerById(id);
    if (!runner) throw new NotFoundAppException({}, 'fleet.runners');
    return RunnerDto.from(runner, this.view(now));
  }

  async update(actorId: string, id: string, patch: RunnerPatch): Promise<RunnerDto> {
    const clean: RunnerPatch = {
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.labels !== undefined ? { labels: [...new Set(patch.labels)].sort() } : {}),
      ...(patch.capacity !== undefined ? { capacity: patch.capacity } : {}),
      ...(patch.threadCapacity !== undefined ? { threadCapacity: patch.threadCapacity } : {}),
    };
    const { dto, cancellation } = await this.txManager.run(async () => {
      // Review B1: the enabled read must be the state this transaction writes from. Placement takes this same
      // runner-row lock before it re-reads `enabled`, so a job placed concurrently either sees the runner disabled or
      // is already held and is cancelled below; a concurrent enable cannot commit between the read and the write.
      // Review B4: an edit takes FOR NO KEY UPDATE, not FOR UPDATE. It still conflicts with placement's FOR UPDATE,
      // but it does not conflict with the FOR KEY SHARE lock the cancellation below takes when it inserts a CANCEL
      // command for this runner — with FOR UPDATE the two transactions deadlock (this one waits for the job row, the
      // cancellation waits for the runner's key-share lock).
      await this.repo.lockForNoKeyUpdate(id);
      const existing = await this.repo.findRunnerById(id);
      if (!existing) throw new NotFoundAppException({}, 'fleet.runners');
      const updated = await this.repo.updateRunner(id, clean);
      const cancellation = existing.enabled && clean.enabled === false
        ? await this.jobs.cancelForRunnerDisabled(id, actorId, new Date())
        : null;
      await this.activity.record({ actorType: 'USER', actorId, action: 'runner.updated', entityType: 'runner', entityId: id, payload: { ...clean } });
      await this.audit.record({ key: 'fleet.runner.update', resourceType: 'fleet-runner', resourceId: id, projectId: null, summary: fieldsSummary(clean) });
      return { dto: RunnerDto.from(updated, this.view(new Date())), cancellation };
    });
    if (cancellation) {
      this.live.publish(cancellation.live);
      for (const runnerId of new Set(cancellation.wake)) this.notifier.notify(runnerId);
    }
    return dto;
  }

  /**
   * US-005 (ACP probe): ask a runner to re-probe its capabilities now, under the audited
   * `fleet.runner.update` key. The request is only a timestamp on the runner row: the runner's next
   * sync takes it atomically and answers `reprobe: true`. NotFound for an id that no runner has, so a
   * stale admin page learns the runner is gone instead of silently writing nothing.
   */
  async requestReprobe(actorId: string, id: string, now = new Date()): Promise<{ requestedAt: string }> {
    const requestedAt = await this.txManager.run(async () => {
      const requested = await this.repo.requestReprobe(id, now);
      if (!requested) throw new NotFoundAppException({}, 'fleet.runners');
      await this.audit.record({ key: 'fleet.runner.update', resourceType: 'fleet-runner', resourceId: id, projectId: null, summary: 'reprobe requested' });
      return now;
    });
    // Only after the transaction commits: a wake that read the row before the write would wait out the poll.
    this.notifier.notify(id);
    return { requestedAt: requestedAt.toISOString() };
  }

  /**
   * Deleting revokes the runner's key (plan D5) and is refused while any job is
   * unfinished or pinned to the runner (plan D15). The row is locked FOR UPDATE
   * first so the count sees a stable row (review m6).
   */
  async remove(actorId: string, id: string): Promise<void> {
    await this.txManager.run(async () => {
      await this.repo.lockForUpdate(id);
      const runner = await this.repo.findRunnerById(id);
      if (!runner) throw new NotFoundAppException({}, 'fleet.runners');
      if ((await this.repo.countUnfinishedJobs(id)) > 0) throw new ConflictAppException({}, 'fleet.runnerBusy');
      await this.repo.deleteRunner(id);
      await this.activity.record({ actorType: 'USER', actorId, action: 'runner.deleted', entityType: 'runner', entityId: id, payload: { name: runner.name } });
      await this.audit.record({ key: 'fleet.runner.delete', resourceType: 'fleet-runner', resourceId: id, projectId: null, summary: 'deleted' });
    });
  }
}
