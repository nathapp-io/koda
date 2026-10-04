import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { FLEET_CFG, IFleetConfig } from '../../config/fleet.config';
import { BundleIngestService } from './bundle-ingest.service';

export const INGEST_SWEEP_MS = 30_000;

/** Spec §2.1, D368: catches rows the in-process kick missed (restart, retry due, stale claim). */
@Injectable()
export class BundleIngestSweeper implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly ingest: BundleIngestService,
    @Inject(FLEET_CFG) private readonly cfg: Pick<IFleetConfig, 'sweepEnabled'>,
  ) {}

  onModuleInit(): void {
    if (!this.cfg.sweepEnabled) return;
    this.timer = setInterval(() => this.ingest.kick(), INGEST_SWEEP_MS);
    this.timer.unref();
    this.ingest.kick();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
