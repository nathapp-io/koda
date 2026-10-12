import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { FLEET_CFG, fleetConfig } from '../../../config/fleet.config';
import { LOG_STORE } from '../../logs/log-store';
import type { LogStore } from '../../logs/log-store';
import { logKey } from '../../logs/log-store';
import { parseThreadLine, type ThreadLine } from './thread-line';

export const THREAD_INGEST_REPOSITORY: unique symbol = Symbol('THREAD_INGEST_REPOSITORY');

export interface ThreadIngestBatch {
  jobId: string;
  leaseEpoch: number;
  lines: Array<{ line: ThreadLine; endOffset: number }>;
  endOffset: number;
  badLines: number;
  rejectedLine?: boolean;
}

export interface FoldResult {
  costChanged: boolean;
  events: readonly unknown[];
}

export interface ThreadIngestRepository {
  readCursor(jobId: string, leaseEpoch: number): Promise<{ offset: number; skippedLines: number }>;
  fold(batch: ThreadIngestBatch): Promise<FoldResult>;
}

@Injectable()
export class ThreadIngestor {
  private readonly logger = new Logger(ThreadIngestor.name);

  constructor(
    @Inject(LOG_STORE) private readonly store: LogStore,
    @Inject(THREAD_INGEST_REPOSITORY) private readonly repository: ThreadIngestRepository,
    @Inject(FLEET_CFG) private readonly config: ConfigType<typeof fleetConfig> | number,
  ) {}

  private get logScanBytes(): number {
    return typeof this.config === 'number' ? this.config : this.config.logScanBytes;
  }

  async catchUp(jobId: string, leaseEpoch: number): Promise<void> {
    const key = logKey(jobId, leaseEpoch, 'thread');
    await this.store.withLock(key, async () => {
      while (true) {
        const cursor = await this.repository.readCursor(jobId, leaseEpoch);
        const size = await this.store.size(key);
        if (cursor.offset >= size) return;
        const scanEnd = Math.min(size, cursor.offset + this.logScanBytes);
        const bytes = await this.store.read(key, cursor.offset, scanEnd);
        const lastNewline = bytes.lastIndexOf(0x0a);
        if (lastNewline < 0) return;
        const complete = bytes.subarray(0, lastNewline + 1);
        const entries: Array<{ parsed: ReturnType<typeof parseThreadLine>; endOffset: number }> = [];
        let start = 0;
        for (let index = 0; index <= lastNewline; index += 1) {
          if (complete[index] !== 0x0a) continue;
          entries.push({
            parsed: parseThreadLine(complete.subarray(start, index + 1)),
            endOffset: cursor.offset + index + 1,
          });
          start = index + 1;
        }
        const lines = entries.flatMap(({ parsed, endOffset }) =>
          'bad' in parsed || 'ignored' in parsed ? [] : [{ line: parsed, endOffset }],
        );
        const badLines = entries.filter(({ parsed }) => 'bad' in parsed).length;
        const endOffset = cursor.offset + complete.length;
        try {
          await this.repository.fold({ jobId, leaseEpoch, lines, endOffset, badLines });
        } catch {
          for (const entry of entries) {
            const { parsed } = entry;
            if ('bad' in parsed) {
              await this.repository.fold({ jobId, leaseEpoch, lines: [], endOffset: entry.endOffset, badLines: 1 });
            } else if ('ignored' in parsed) {
              await this.repository.fold({ jobId, leaseEpoch, lines: [], endOffset: entry.endOffset, badLines: 0 });
            } else {
              try {
                await this.repository.fold({
                  jobId, leaseEpoch, lines: [{ line: parsed, endOffset: entry.endOffset }],
                  endOffset: entry.endOffset, badLines: 0,
                });
              } catch (error) {
                this.logger.error(`Failed to fold thread line for job ${jobId} at ${entry.endOffset}`, error);
                await this.repository.fold({
                  jobId, leaseEpoch, lines: [{ line: parsed, endOffset: entry.endOffset }],
                  endOffset: entry.endOffset, badLines: 1, rejectedLine: true,
                });
              }
            }
          }
        }
      }
    });
  }
}
