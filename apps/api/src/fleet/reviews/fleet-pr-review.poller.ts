import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { FLEET_CFG, type IFleetConfig } from '../../config/fleet.config';
import { FleetPrReviewPass } from './fleet-pr-review.pass';

/** Runs the auto-review pass on a single-flight, opt-in-to-sweeping lifecycle. */
@Injectable()
export class FleetPrReviewPoller implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FleetPrReviewPoller.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly pass: FleetPrReviewPass,
    @Inject(FLEET_CFG)
    private readonly config: Pick<IFleetConfig, 'sweepEnabled' | 'prReviewEnabled' | 'prReviewPollMs'>,
  ) {}

  onModuleInit(): void {
    if (!this.config.sweepEnabled || !this.config.prReviewEnabled) return;
    this.timer = setInterval(() => void this.poll(), this.config.prReviewPollMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  async poll(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.pass.run(new Date());
    } catch (error) {
      this.logger.error(`Fleet PR review poll failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.running = false;
    }
  }
}
