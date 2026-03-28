import { Injectable, Logger } from '@nestjs/common';
import type { FtsOptimizeStrategy } from './fts-optimize-strategy.interface';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LanceTable = any;

@Injectable()
export class ManualOptimizeStrategy implements FtsOptimizeStrategy {
  private readonly logger = new Logger(ManualOptimizeStrategy.name);

  onInsert(_projectId: string, _table: LanceTable): Promise<void> {
    // No-op on insert — optimize is triggered manually via API endpoint
    this.logger.debug('ManualOptimizeStrategy.onInsert — no-op');
    return Promise.resolve();
  }

  onFirstAccess(_projectId: string, _table: LanceTable): void {
    // TODO: implement — fire-and-forget table.optimize()
    this.logger.debug('onFirstAccess stub — not implemented');
  }

  async onDestroy(): Promise<void> {
    // No-op
  }
}
