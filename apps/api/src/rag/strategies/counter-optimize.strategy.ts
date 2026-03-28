import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FtsOptimizeStrategy } from './fts-optimize-strategy.interface';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LanceTable = any;

@Injectable()
export class CounterOptimizeStrategy implements FtsOptimizeStrategy {
  private readonly logger = new Logger(CounterOptimizeStrategy.name);
  // TODO: use in implementation
  private readonly _threshold: number;
  private readonly _counters = new Map<string, number>();

  constructor(private readonly configService: ConfigService) {
    this._threshold = this.configService.get<number>('rag.ftsOptimizeThreshold') ?? 10;
  }

  async onInsert(_projectId: string, _table: LanceTable): Promise<void> {
    // TODO: implement — increment counter, call table.optimize() at threshold
    this.logger.debug('onInsert stub — not implemented');
  }

  onFirstAccess(_projectId: string, _table: LanceTable): void {
    // TODO: implement — fire-and-forget table.optimize()
    this.logger.debug('onFirstAccess stub — not implemented');
  }

  async onDestroy(): Promise<void> {
    // no-op
  }
}
