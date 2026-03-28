import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FtsOptimizeStrategy } from './fts-optimize-strategy.interface';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LanceTable = any;

@Injectable()
export class CounterOptimizeStrategy implements FtsOptimizeStrategy {
  private readonly logger = new Logger(CounterOptimizeStrategy.name);
  private readonly threshold: number;
  private readonly counters = new Map<string, number>();

  constructor(private readonly configService: ConfigService) {
    this.threshold = this.configService.get<number>('rag.ftsOptimizeThreshold') ?? 10;
  }

  async onInsert(projectId: string, table: LanceTable): Promise<void> {
    const count = (this.counters.get(projectId) ?? 0) + 1;
    this.counters.set(projectId, count);

    if (count >= this.threshold) {
      this.counters.set(projectId, 0);
      try {
        await table.optimize();
      } catch (err) {
        this.logger.warn(`FTS optimize failed for project ${projectId}: ${(err as Error).message}`);
      }
    }
  }

  onFirstAccess(projectId: string, table: LanceTable): void {
    this.logger.debug(`onFirstAccess fire-and-forget for project ${projectId}`);
    void table.optimize();
  }

  async onDestroy(): Promise<void> {
    // no-op
  }
}
