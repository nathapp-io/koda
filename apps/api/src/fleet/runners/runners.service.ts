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

@Injectable()
export class RunnersService {
  constructor(
    @Inject(RUNNER_REPOSITORY) private readonly repo: IRunnerRepository,
    private readonly activity: FleetActivityService,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
    @Inject(FLEET_CFG) private readonly fleetConfig: Pick<IFleetConfig, 'runnerOfflineSec'>,
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
    };
    return this.txManager.run(async () => {
      if (!(await this.repo.findRunnerById(id))) throw new NotFoundAppException({}, 'fleet.runners');
      const updated = await this.repo.updateRunner(id, clean);
      await this.activity.record({ actorType: 'USER', actorId, action: 'runner.updated', entityType: 'runner', entityId: id, payload: { ...clean } });
      return RunnerDto.from(updated, this.view(new Date()));
    });
  }

  /**
   * Deleting revokes the runner's key (plan D5) and is refused while any job is
   * unfinished or pinned to the runner (plan D15). The row is locked FOR UPDATE
   * first so the count sees a stable row (review m6).
   */
  async remove(actorId: string, id: string): Promise<void> {
    await this.txManager.run(async () => {
      await this.repo.lockForDelete(id);
      const runner = await this.repo.findRunnerById(id);
      if (!runner) throw new NotFoundAppException({}, 'fleet.runners');
      if ((await this.repo.countUnfinishedJobs(id)) > 0) throw new ConflictAppException({}, 'fleet.runnerBusy');
      await this.repo.deleteRunner(id);
      await this.activity.record({ actorType: 'USER', actorId, action: 'runner.deleted', entityType: 'runner', entityId: id, payload: { name: runner.name } });
    });
  }
}
