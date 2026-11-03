import { SystemWriter } from '../../permissions/system-writer.decorator';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { IRagConfig, RAG_CFG } from '../../config/rag.config';
import type { FtsOptimizeStrategy, OptimizeTask } from './fts-optimize-strategy.interface';
import { optimizeInBackground } from './optimize-in-background';

/** Minimal interface for SchedulerRegistry — full type added when @nestjs/schedule is installed (US-002) */
interface SchedulerRegistryLike {
  addInterval(name: string, interval: ReturnType<typeof setInterval>): void;
  deleteInterval(name: string): void;
}

@Injectable()
@SystemWriter('system.rag.optimize')
export class CronOptimizeStrategy implements FtsOptimizeStrategy {
  private readonly logger = new Logger(CronOptimizeStrategy.name);
  private readonly dirtyTables = new Map<string, OptimizeTask>();
  private readonly intervalMs: number;
  private intervalId: ReturnType<typeof setInterval> | null = null;

  constructor(
    @Inject(RAG_CFG) ragConfig: IRagConfig,
    // @Inject(SchedulerRegistry) injected via NestJS DI in real usage
    private readonly schedulerRegistry: SchedulerRegistryLike,
  ) {
    this.intervalMs = ragConfig.ftsOptimizeIntervalMs;
    this.intervalId = setInterval(() => {
      void this.optimizeDirtyTables();
    }, this.intervalMs);
    this.schedulerRegistry.addInterval('fts-optimize', this.intervalId);
  }

  onInsert(projectId: string, optimize: OptimizeTask): Promise<void> {
    this.dirtyTables.set(projectId, optimize);
    return Promise.resolve();
  }

  /** The tick: runs each dirty project's task, which takes the table's write mutex itself. Never inside a session. */
  async optimizeDirtyTables(): Promise<void> {
    const entries = Array.from(this.dirtyTables.entries());
    this.dirtyTables.clear();
    await Promise.all(
      entries.map(async ([projectId, optimize]) => {
        try {
          await optimize();
        } catch (err) {
          this.logger.warn(`FTS optimize failed for project ${projectId}: ${(err as Error).message}`);
        }
      }),
    );
  }

  onFirstAccess(projectId: string, optimize: OptimizeTask): void {
    this.logger.debug(`onFirstAccess fire-and-forget for project ${projectId}`);
    optimizeInBackground(optimize, projectId, this.logger);
  }

  async onDestroy(): Promise<void> {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    try {
      this.schedulerRegistry.deleteInterval('fts-optimize');
    } catch {
      // Interval may already be gone; ignore.
    }
    await this.optimizeDirtyTables();
  }
}
