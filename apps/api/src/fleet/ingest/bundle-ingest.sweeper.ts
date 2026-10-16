import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { EventEmitterReadinessWatcher } from '@nestjs/event-emitter';
import { FLEET_CFG, IFleetConfig } from '../../config/fleet.config';
import { BundleIngestService } from './bundle-ingest.service';

export const INGEST_SWEEP_MS = 30_000;

/**
 * Spec §2.1, D368: catches rows the in-process kick missed (restart, retry due, stale claim).
 *
 * The first kick waits for the event emitter's readiness: a RUN ingest emits `KNOWLEDGE_RUN_INGESTED`, and Nest
 * attaches `@OnEvent` listeners only at application bootstrap, after every `onModuleInit`. Draining the restart
 * backlog any earlier would emit to no listener and lose those outcome passes.
 */
@Injectable()
export class BundleIngestSweeper implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  private destroyed = false;

  constructor(
    private readonly ingest: BundleIngestService,
    @Inject(FLEET_CFG) private readonly cfg: Pick<IFleetConfig, 'sweepEnabled'>,
    private readonly eventsReady: EventEmitterReadinessWatcher,
  ) {}

  onModuleInit(): void {
    if (!this.cfg.sweepEnabled) return;
    void this.eventsReady.waitUntilReady().then(() => this.start());
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private start(): void {
    if (this.destroyed) return;
    this.timer = setInterval(() => this.ingest.kick(), INGEST_SWEEP_MS);
    this.timer.unref();
    this.ingest.kick();
  }
}
