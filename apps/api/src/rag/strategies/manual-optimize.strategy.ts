import { Injectable, Logger } from '@nestjs/common';
import type { FtsOptimizeStrategy } from './fts-optimize-strategy.interface';
import { optimizeInBackground } from './optimize-in-background';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LanceTable = any;

@Injectable()
export class ManualOptimizeStrategy implements FtsOptimizeStrategy {
  private readonly logger = new Logger(ManualOptimizeStrategy.name);

  onInsert(_projectId: string, _table: LanceTable): Promise<void> {
    // No-op on insert — optimize is triggered manually via API endpoint
    return Promise.resolve();
  }

  onFirstAccess(projectId: string, table: LanceTable): void {
    this.logger.debug(`onFirstAccess fire-and-forget for project ${projectId}`);
    optimizeInBackground(table, projectId, this.logger);
  }

  async onDestroy(): Promise<void> {
    // No-op
  }
}
