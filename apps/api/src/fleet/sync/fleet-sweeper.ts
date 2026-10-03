import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { FleetJobState } from '../../common/enums';
import { FLEET_CFG, IFleetConfig } from '../../config/fleet.config';
import { ApprovalLivePublisher } from '../approvals/approval-live.publisher';
import { FleetJobLivePublisher } from '../jobs/fleet-job-live.publisher';
import { RUNNER_HELD_STATES } from '../jobs/job-state';
import { JobTransitionsService, SYSTEM_ACTOR } from '../jobs/job-transitions.service';
import { FLEET_JOB_REPOSITORY, IFleetJobRepository } from '../jobs/domain/fleet-job.domain';
import { PrAttributionService } from './pr-attribution.service';

const SWEEP_INTERVAL_MS = 30_000;

/**
 * Spec §5.3 "machine silent" (plus UPLOADING, plan D11). In process (single API instance).
 * Each job is re-checked under its row lock, so a runner that synced after the scan is spared.
 */
@Injectable()
export class FleetSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FleetSweeper.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(FLEET_JOB_REPOSITORY) private readonly repo: IFleetJobRepository,
    private readonly transitions: JobTransitionsService,
    private readonly live: FleetJobLivePublisher,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
    @Inject(FLEET_CFG) private readonly fleetConfig: Pick<IFleetConfig, 'sweepEnabled' | 'jobCrashSec'>,
    private readonly attribution: PrAttributionService,
    private readonly approvalLive: ApprovalLivePublisher,
  ) {}

  onModuleInit(): void {
    if (!this.fleetConfig.sweepEnabled) return;
    this.timer = setInterval(() => {
      this.sweep().catch((error: unknown) => this.logger.error(`Fleet sweep failed: ${error instanceof Error ? error.message : String(error)}`));
    }, SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async sweep(now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - this.fleetConfig.jobCrashSec * 1000);
    let crashed = 0;
    for (const id of await this.repo.findSilentHeldIds(cutoff)) {
      const result = await this.txManager.run(async () => {
        const job = await this.repo.lockById(id, { skipLocked: true });
        if (!job || !(RUNNER_HELD_STATES as readonly string[]).includes(job.state) || !job.runnerId) return null;
        const [runner] = await this.repo.findPlacementRunners([job.runnerId]);
        if (runner && runner.lastSeenAt.getTime() >= cutoff.getTime()) return null;
        return this.transitions.apply({ job, to: FleetJobState.CRASHED, by: 'server', now, actor: SYSTEM_ACTOR, reason: 'runner silent' });
      });
      if (result) {
        this.live.publish([result.live]);
        this.approvalLive.publish(result.approvalLive);
        void this.attribution.attribute(id); // fire-and-forget; never throws
        crashed += 1;
      }
    }
    if (crashed > 0) this.logger.warn(`Crashed ${crashed} job(s) of silent runners`);
    return crashed;
  }
}
