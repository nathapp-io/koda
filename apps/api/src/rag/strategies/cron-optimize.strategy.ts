import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FtsOptimizeStrategy } from './fts-optimize-strategy.interface';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LanceTable = any;

/** Minimal interface for SchedulerRegistry — full type added when @nestjs/schedule is installed (US-002) */
interface SchedulerRegistryLike {
  addInterval(name: string, interval: ReturnType<typeof setInterval>): void;
}

@Injectable()
export class CronOptimizeStrategy implements FtsOptimizeStrategy {
  private readonly logger = new Logger(CronOptimizeStrategy.name);
  // TODO: use in implementation
  private readonly _dirtyTables = new Map<string, LanceTable>();
  private readonly _intervalMs: number;

  constructor(
    private readonly configService: ConfigService,
    // @Inject(SchedulerRegistry) injected via NestJS DI in real usage
    private readonly schedulerRegistry: SchedulerRegistryLike,
  ) {
    this._intervalMs = this.configService.get<number>('rag.ftsOptimizeIntervalMs') ?? 300_000;
    // TODO: implement — register interval via schedulerRegistry.addInterval('fts-optimize', ...)
    this.logger.debug('CronOptimizeStrategy stub — interval not registered');
  }

  onInsert(_projectId: string, _table: LanceTable): Promise<void> {
    // TODO: implement — add table to _dirtyTables map
    this.logger.debug('onInsert stub — not implemented');
    return Promise.resolve();
  }

  async optimizeDirtyTables(): Promise<void> {
    // TODO: implement — call optimize() for each dirty table and clear map
    this.logger.debug('optimizeDirtyTables stub — not implemented');
  }

  onFirstAccess(_projectId: string, _table: LanceTable): void {
    // TODO: implement — fire-and-forget table.optimize()
    this.logger.debug('onFirstAccess stub — not implemented');
  }

  async onDestroy(): Promise<void> {
    // TODO: implement — flush dirty tables
    this.logger.debug('onDestroy stub — not implemented');
  }
}
