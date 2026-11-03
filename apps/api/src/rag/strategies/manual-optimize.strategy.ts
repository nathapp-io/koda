import { SystemWriter } from '../../permissions/system-writer.decorator';
import { Injectable, Logger } from '@nestjs/common';
import type { FtsOptimizeStrategy, OptimizeTask } from './fts-optimize-strategy.interface';
import { optimizeInBackground } from './optimize-in-background';

@Injectable()
@SystemWriter('system.rag.optimize')
export class ManualOptimizeStrategy implements FtsOptimizeStrategy {
  private readonly logger = new Logger(ManualOptimizeStrategy.name);

  onInsert(_projectId: string, _optimize: OptimizeTask): Promise<void> {
    // No-op on insert — optimize is triggered manually via API endpoint
    return Promise.resolve();
  }

  onFirstAccess(projectId: string, optimize: OptimizeTask): void {
    this.logger.debug(`onFirstAccess fire-and-forget for project ${projectId}`);
    optimizeInBackground(optimize, projectId, this.logger);
  }

  async onDestroy(): Promise<void> {
    // No-op
  }
}
