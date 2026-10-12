import type { LogStore } from '../../logs/log-store';
import { ThreadIngestor } from './thread-ingestor';
import type { ThreadIngestRepository } from './domain/thread-ingest.domain';

describe('ThreadIngestor (US-002)', () => {
  it('US-002 AC10: isolates a rejected batch to its individual lines and advances past the bad line', async () => {
    const source = Buffer.from([
      '{"type":"input_consumed","messageId":"m1"}\n',
      '{"type":"input_consumed","messageId":"m2"}\n',
      '{"type":"input_consumed","messageId":"m3"}\n',
    ].join(''));
    const store = {
      size: vi.fn().mockResolvedValue(source.length),
      read: vi.fn(async (_key: string, from: number, to: number) => source.subarray(from, to)),
      withLock: vi.fn(async (_key: string, fn: () => Promise<unknown>) => fn()),
    } as unknown as LogStore;
    let cursor = { offset: 0, skippedLines: 0 };
    const folded: string[] = [];
    const repository: ThreadIngestRepository = {
      readCursor: vi.fn(async () => cursor),
      fold: vi.fn(async (batch) => {
        if (batch.lines.some(({ line }) => line.messageId === 'm2') && batch.lines.length > 1) {
          throw new Error('batch contains m2');
        }
        if (batch.lines[0]?.line.messageId === 'm2' && batch.badLines === 0) {
          throw new Error('m2 rejected');
        }
        if (batch.lines.length > 0 && batch.lines[0]?.line.messageId !== 'm2') folded.push(batch.lines[0].line.messageId);
        cursor = { offset: batch.endOffset, skippedLines: cursor.skippedLines + batch.badLines };
        return { costChanged: false, events: [] };
      }),
    };

    await new ThreadIngestor(store, repository, 65_536).catchUp('job-1', 1);

    expect(folded).toEqual(['m1', 'm3']);
    expect(cursor).toEqual({ offset: source.length, skippedLines: 1 });
  });
});
