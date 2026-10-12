import type { LogStore } from '../../logs/log-store';
import type { ThreadLine } from './thread-line';

export const THREAD_INGEST_REPOSITORY: unique symbol = Symbol('THREAD_INGEST_REPOSITORY');

export interface ThreadIngestBatch {
  jobId: string;
  leaseEpoch: number;
  lines: Array<{ line: ThreadLine; endOffset: number }>;
  endOffset: number;
  badLines: number;
}

export interface FoldResult {
  costChanged: boolean;
  events: readonly unknown[];
}

export interface ThreadIngestRepository {
  readCursor(jobId: string, leaseEpoch: number): Promise<{ offset: number; skippedLines: number }>;
  fold(batch: ThreadIngestBatch): Promise<FoldResult>;
}

export class ThreadIngestor {
  constructor(
    private readonly store: LogStore,
    private readonly repository: ThreadIngestRepository,
    private readonly logScanBytes: number,
  ) {}

  async catchUp(_jobId: string, _leaseEpoch: number): Promise<void> {}
}
