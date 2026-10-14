import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { FLEET_CFG, fleetConfig } from '../../../config/fleet.config';
import { LOG_STORE } from '../../logs/log-store';
import type { LogStore } from '../../logs/log-store';
import { logKey } from '../../logs/log-store';
import { isIgnoredLine, parseThreadLine } from './thread-line';
import { ThreadEventBus } from '../../../live/thread-event-bus';
import { THREAD_INGEST_REPOSITORY, type ThreadIngestBatch, type ThreadIngestRepository } from './domain/thread-ingest.domain';

@Injectable()
export class ThreadIngestor {
  private readonly logger = new Logger(ThreadIngestor.name);

  constructor(
    @Inject(LOG_STORE) private readonly store: LogStore,
    @Inject(THREAD_INGEST_REPOSITORY) private readonly repository: ThreadIngestRepository,
    @Inject(FLEET_CFG) private readonly config: ConfigType<typeof fleetConfig> | number,
    private readonly events: ThreadEventBus = new ThreadEventBus(),
  ) {}

  private get logScanBytes(): number {
    return typeof this.config === 'number' ? this.config : this.config.logScanBytes;
  }

  private async foldAndPublish(batch: ThreadIngestBatch): Promise<void> {
    const result = await this.repository.fold(batch);
    for (const event of result.events) this.events.publish(event);
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
        if (lastNewline < 0) {
          // A line longer than the protocol limit can span multiple scan windows. Consume it
          // through its newline as one bad line so the cursor can continue to later records.
          if (size - cursor.offset <= this.logScanBytes || bytes.length < this.logScanBytes) return;
          let lineEnd = -1;
          let scanOffset = cursor.offset + bytes.length;
          while (scanOffset < size && lineEnd < 0) {
            const next = await this.store.read(key, scanOffset, Math.min(size, scanOffset + this.logScanBytes));
            const newline = next.indexOf(0x0a);
            if (newline >= 0) lineEnd = scanOffset + newline + 1;
            else scanOffset += next.length;
          }
          if (lineEnd < 0) return;
          await this.foldAndPublish({ jobId, leaseEpoch, lines: [], endOffset: lineEnd, badLines: 1 });
          continue;
        }
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
          'bad' in parsed || isIgnoredLine(parsed) ? [] : [{ line: parsed, endOffset }],
        );
        const badLines = entries.filter(({ parsed }) => 'bad' in parsed).length;
        const endOffset = cursor.offset + complete.length;
        try {
          await this.foldAndPublish({ jobId, leaseEpoch, lines, endOffset, badLines });
        } catch (error) {
          this.logger.warn(`Thread fold batch failed for job ${jobId} at offset ${endOffset}, retrying line by line`, error);
          let pendingBadLines = 0;
          for (const entry of entries) {
            const { parsed } = entry;
            if ('bad' in parsed) {
              pendingBadLines += 1;
            } else if (isIgnoredLine(parsed)) {
              await this.foldAndPublish({ jobId, leaseEpoch, lines: [], endOffset: entry.endOffset, badLines: pendingBadLines });
              pendingBadLines = 0;
            } else {
              try {
                await this.foldAndPublish({
                  jobId, leaseEpoch, lines: [{ line: parsed, endOffset: entry.endOffset }],
                  endOffset: entry.endOffset, badLines: pendingBadLines,
                });
                pendingBadLines = 0;
              } catch (error) {
                this.logger.error(`Failed to fold thread line for job ${jobId} at ${entry.endOffset}`, error);
                await this.foldAndPublish({
                  jobId, leaseEpoch, lines: [{ line: { bad: true }, endOffset: entry.endOffset }],
                  endOffset: entry.endOffset, badLines: pendingBadLines,
                });
                pendingBadLines = 0;
              }
            }
          }
          if (pendingBadLines > 0) {
            await this.foldAndPublish({ jobId, leaseEpoch, lines: [], endOffset, badLines: pendingBadLines });
          }
        }
      }
    });
  }
}
