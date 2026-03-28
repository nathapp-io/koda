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
  private readonly dirtyTables = new Map<string, LanceTable>();
  private readonly intervalMs: number;

  constructor(
    private readonly configService: ConfigService,
    // @Inject(SchedulerRegistry) injected via NestJS DI in real usage
    private readonly schedulerRegistry: SchedulerRegistryLike,
  ) {
    this.intervalMs = this.configService.get<number>('rag.ftsOptimizeIntervalMs') ?? 300_000;
    const interval = setInterval(() => {
      void this.optimizeDirtyTables();
    }, this.intervalMs);
    this.schedulerRegistry.addInterval('fts-optimize', interval);
  }

  onInsert(projectId: string, table: LanceTable): Promise<void> {
    this.dirtyTables.set(projectId, table);
    return Promise.resolve();
  }

  async optimizeDirtyTables(): Promise<void> {
    const entries = Array.from(this.dirtyTables.entries());
    this.dirtyTables.clear();
    await Promise.all(
      entries.map(async ([projectId, table]) => {
        try {
          await table.optimize();
        } catch (err) {
          this.logger.warn(`FTS optimize failed for project ${projectId}: ${(err as Error).message}`);
        }
      }),
    );
  }

  onFirstAccess(projectId: string, table: LanceTable): void {
    this.logger.debug(`onFirstAccess fire-and-forget for project ${projectId}`);
    void table.optimize();
  }

  async onDestroy(): Promise<void> {
    await this.optimizeDirtyTables();
  }
}
