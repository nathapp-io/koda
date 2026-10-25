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
        const firstLine = batch.lines[0]?.line;
        if (firstLine && !('bad' in firstLine) && firstLine.messageId !== 'm2') folded.push(firstLine.messageId);
        // Domain-invalid lines are reported as skipped, not storage exceptions.
        const skipped = batch.lines.filter(({ line }) => 'bad' in line || line.messageId === 'm2').length;
        cursor = { offset: batch.endOffset, skippedLines: cursor.skippedLines + batch.badLines + skipped };
        return { costChanged: false, events: [] };
      }),
    };

    await new ThreadIngestor(store, repository, 65_536).catchUp('job-1', 1);

    expect(folded).toEqual(['m1', 'm3']);
    expect(cursor).toEqual({ offset: source.length, skippedLines: 1 });
  });

  it('preserves a failed turn_end cursor and replays completion exactly once after recovery', async () => {
    const prefix = JSON.stringify({ type: 'turn_start', turnId: 't1' }) + '\n';
    const source = Buffer.from(prefix + JSON.stringify({ type: 'turn_end', turnId: 't1', status: 'completed', output: 'Done', costUsd: 2, usage: { inputTokens: 1, outputTokens: 1 } }) + '\n');
    const store = {
      size: vi.fn().mockResolvedValue(source.length),
      read: vi.fn(async (_key: string, from: number, to: number) => source.subarray(from, to)),
      withLock: vi.fn(async (_key: string, fn: () => Promise<unknown>) => fn()),
    } as unknown as LogStore;
    let offset = 0;
    let unavailable = true;
    const completions: object[] = [];
    const audits: string[] = [];
    const repository: ThreadIngestRepository = {
      readCursor: vi.fn(async () => ({ offset, skippedLines: 0 })),
      fold: vi.fn(async batch => {
        const end = batch.lines.find(({ line }) => line.type === 'turn_end');
        if (end && unavailable) throw new Error('audit down');
        if (end) {
          completions.push(end.line);
          audits.push('turn ended completed');
        }
        offset = batch.endOffset;
        return { costChanged: !!end, events: [] };
      }),
    };
    const ingestor = new ThreadIngestor(store, repository, 65_536);
    await expect(ingestor.catchUp('job-1', 1)).rejects.toThrow('audit down');
    expect(offset).toBe(Buffer.byteLength(prefix));
    expect(completions).toEqual([]);
    expect(audits).toEqual([]);
    unavailable = false;
    await ingestor.catchUp('job-1', 1);
    await ingestor.catchUp('job-1', 1);
    expect(offset).toBe(source.length);
    expect(completions).toEqual([expect.objectContaining({ status: 'completed', output: 'Done', costUsd: 2 })]);
    expect(audits).toEqual(['turn ended completed']);
  });

  it('#271: folds a published line, whose own ignored field is not the ignored-type sentinel', async () => {
    const sha = 'c'.repeat(40);
    const source = Buffer.from([
      '{"type":"thinking_delta","turnId":"t1","text":"x"}\n',
      `{"type":"published","sha":"${sha}","paths":["docs/a.md"],"ignored":[],"specPresent":true}\n`,
    ].join(''));
    const store = {
      size: vi.fn().mockResolvedValue(source.length),
      read: vi.fn(async (_key: string, from: number, to: number) => source.subarray(from, to)),
      withLock: vi.fn(async (_key: string, fn: () => Promise<unknown>) => fn()),
    } as unknown as LogStore;
    let cursor = { offset: 0, skippedLines: 0 };
    const types: string[] = [];
    const repository: ThreadIngestRepository = {
      readCursor: vi.fn(async () => cursor),
      fold: vi.fn(async (batch) => {
        for (const { line } of batch.lines) types.push(line.type);
        cursor = { offset: batch.endOffset, skippedLines: cursor.skippedLines + batch.badLines };
        return { costChanged: false, events: [] };
      }),
    };

    await new ThreadIngestor(store, repository, 65_536).catchUp('job-1', 1);

    expect(types).toEqual(['published']);
    expect(cursor).toEqual({ offset: source.length, skippedLines: 0 });
  });

  it('#271: the line-by-line retry folds a published line too', async () => {
    const sha = 'd'.repeat(40);
    const source = Buffer.from([
      '{"type":"input_consumed","messageId":"m1"}\n',
      `{"type":"published","sha":"${sha}","paths":[],"ignored":["x.ts"],"specPresent":false}\n`,
    ].join(''));
    const store = {
      size: vi.fn().mockResolvedValue(source.length),
      read: vi.fn(async (_key: string, from: number, to: number) => source.subarray(from, to)),
      withLock: vi.fn(async (_key: string, fn: () => Promise<unknown>) => fn()),
    } as unknown as LogStore;
    let cursor = { offset: 0, skippedLines: 0 };
    const types: string[] = [];
    const repository: ThreadIngestRepository = {
      readCursor: vi.fn(async () => cursor),
      fold: vi.fn(async (batch) => {
        if (batch.lines.length > 1) throw new Error('force the line-by-line retry');
        for (const { line } of batch.lines) types.push(line.type);
        cursor = { offset: batch.endOffset, skippedLines: cursor.skippedLines + batch.badLines };
        return { costChanged: false, events: [] };
      }),
    };

    await new ThreadIngestor(store, repository, 65_536).catchUp('job-1', 1);

    expect(types).toEqual(['input_consumed', 'published']);
    expect(cursor).toEqual({ offset: source.length, skippedLines: 0 });
  });
});
