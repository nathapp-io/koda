import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { FLEET_CFG, type IFleetConfig } from '../../config/fleet.config';
import { ReviewEventMinter } from './review-event.minter';

/** Periodic recovery for review-event mint wake-ups missed while the process is unavailable. */
@Injectable()
export class ReviewEventMintPoller implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly minter: ReviewEventMinter,
    @Inject(FLEET_CFG) private readonly config: Pick<IFleetConfig, 'sweepEnabled' | 'reviewMintPollMs'>,
  ) {}

  onModuleInit(): void {
    if (!this.config.sweepEnabled) return;
    this.timer = setInterval(() => void this.minter.run(), this.config.reviewMintPollMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
}
