import { SystemWriter } from '../../permissions/system-writer.decorator';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { IRagConfig, RAG_CFG } from '../../config/rag.config';
import type { FtsOptimizeStrategy, OptimizeTask } from './fts-optimize-strategy.interface';
import { optimizeInBackground } from './optimize-in-background';

@Injectable()
@SystemWriter('system.rag.optimize')
export class CounterOptimizeStrategy implements FtsOptimizeStrategy {
  private readonly logger = new Logger(CounterOptimizeStrategy.name);
  private readonly threshold: number;
  private readonly counters = new Map<string, number>();

  constructor(@Inject(RAG_CFG) ragConfig: IRagConfig) {
    this.threshold = ragConfig.ftsOptimizeThreshold;
  }

  async onInsert(projectId: string, optimize: OptimizeTask): Promise<void> {
    const count = (this.counters.get(projectId) ?? 0) + 1;
    this.counters.set(projectId, count);

    if (count >= this.threshold) {
      this.counters.set(projectId, 0);
      // Never awaited: onInsert can run inside a held write session of the same table, and awaiting the task's
      // `exclusive` there deadlocks the non-reentrant mutex. The queued optimize runs when the session releases.
      optimizeInBackground(optimize, projectId, this.logger);
    }
  }

  onFirstAccess(projectId: string, optimize: OptimizeTask): void {
    this.logger.debug(`onFirstAccess fire-and-forget for project ${projectId}`);
    optimizeInBackground(optimize, projectId, this.logger);
  }

  clearProject(projectId: string): void {
    this.counters.delete(projectId);
  }

  async onDestroy(): Promise<void> {
    this.counters.clear();
  }
}
