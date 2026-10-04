import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { LogStreamName } from './domain/fleet-job-log.domain';
import { LocalDiskLogStore } from './local-disk-log.store';
import { logKey } from './log-store';
import { EntriesPage, LogReadService } from './log-read.service';
import { MemoryLogRepo } from './test-helpers/memory-log-repo';

/** HTTP status of a rejected call (AppException extends HttpException). */
const statusOf = (p: Promise<unknown>) => p.then(() => 0, (e: { getStatus(): number }) => e.getStatus());
const line = (level: string, message: string, extra: object = {}) => `${JSON.stringify({ timestamp: '2026-10-04T08:00:00.000Z', level, stage: 'run', message, ...extra })}\n`;

describe('LogReadService', () => {
  const root = mkdtempSync(join(tmpdir(), 'koda-log-read-'));
  const store = new LocalDiskLogStore({ artifactDir: root });
  let job: { id: string; projectId: string; leaseEpoch: number };
  let logs: MemoryLogRepo;
  let n = 0;
  const jobs = { findById: jest.fn(async (id: string) => (id === job.id ? job : null)) };
  const svc = (scanBytes = 1024) => new LogReadService(jobs as never, logs as never, store, { logScanBytes: scanBytes });
  const write = (stream: LogStreamName, text: string, epoch = 1) => {
    const path = join(root, logKey(job.id, epoch, stream));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  };
  const forward = (s: LogReadService, over: Partial<Parameters<LogReadService['entries']>[3]> = {}, stream = 'run') =>
    s.entries('p1', job.id, stream, { direction: 'forward', limit: 200, ...over });
  const backward = (s: LogReadService, over: Partial<Parameters<LogReadService['entries']>[3]> = {}, stream = 'run') =>
    s.entries('p1', job.id, stream, { direction: 'backward', limit: 200, ...over });

  beforeEach(() => {
    n += 1;
    job = { id: `job${n}`, projectId: 'p1', leaseEpoch: 2 };
    logs = new MemoryLogRepo();
  });

  it('lists attempts latest first with streams in run/stdout/stderr order and legacySampled (spec §3.1)', async () => {
    logs.set({ jobId: job.id, leaseEpoch: 2, stream: 'stdout', sizeBytes: 5, complete: true });
    logs.set({ jobId: job.id, leaseEpoch: 2, stream: 'run', sizeBytes: 9, source: 'bundle', expiredAt: new Date(1) });
    logs.setEventEpochs(job.id, [1]);
    const out = await svc().list('p1', job.id);
    expect(out.attempts.map((a) => [a.leaseEpoch, a.legacySampled, a.streams.map((s) => s.stream)])).toEqual([[2, false, ['run', 'stdout']], [1, true, []]]);
    expect(out.attempts[0].streams[0]).toEqual({ stream: 'run', sizeBytes: 9, complete: false, truncated: false, source: 'bundle', expired: true, updatedAt: new Date(0).toISOString() });
    await expect(statusOf(svc().list('other-project', job.id))).resolves.toBe(404);
  });

  it('reads forward from 0 by default at the job epoch and parses run lines', async () => {
    write('run', line('info', 'a') + line('warn', 'b') + 'partial', 2);
    logs.set({ jobId: job.id, leaseEpoch: 2, stream: 'run', sizeBytes: 999 });
    const page = await forward(svc());
    expect(page.entries.map((e) => e.message)).toEqual(['a', 'b']);
    const end = page.entries[1].offset + page.entries[1].length;
    expect(page).toMatchObject({ nextCursor: end, scannedFrom: 0, scannedTo: end, atEnd: true, complete: false, truncated: false });
    expect(page.size).toBe(end + 'partial'.length);
    expect((await forward(svc(), { level: 'warn' })).entries.map((e) => e.message)).toEqual(['b']);
  });

  it('keeps a growing stream consistent: partial line hidden until complete, atEnd at the last complete line (Review Focus 2)', async () => {
    write('run', 'l1\nl2\npar', 2);
    const back = await backward(svc(), {}, 'stdout');
    expect(back.entries).toEqual([]); // stdout has no file: an empty page (D332)
    const b = await backward(svc());
    expect(b.entries.map((e) => e.text)).toEqual(['l1', 'l2']);
    expect(b).toMatchObject({ nextCursor: 0, atEnd: true, scannedTo: 6 });
    const f1 = await forward(svc());
    expect(f1).toMatchObject({ nextCursor: 6, atEnd: true });
    appendFileSync(join(root, logKey(job.id, 2, 'run')), 'tial\nl4');
    const f2 = await forward(svc(), { cursor: 6 });
    expect(f2.entries.map((e) => e.text)).toEqual(['partial']);
    expect(f2).toMatchObject({ nextCursor: 14, atEnd: true, complete: false });
    logs.set({ jobId: job.id, leaseEpoch: 2, stream: 'run', sizeBytes: 16, complete: true });
    const f3 = await forward(svc(), { cursor: 14 });
    expect(f3.entries.map((e) => e.text)).toEqual(['l4']);
    expect(f3).toMatchObject({ nextCursor: 16, atEnd: true, complete: true });
    expect((await backward(svc())).entries.map((e) => e.text)).toEqual(['l1', 'l2', 'partial', 'l4']);
  });

  it('pages forward through an overlong line without losing or repeating a byte (Review Focus 1)', async () => {
    const text = `${line('info', 'before')}${'x'.repeat(40)}\n${line('info', 'after')}`;
    write('run', text, 2);
    logs.set({ jobId: job.id, leaseEpoch: 2, stream: 'run', sizeBytes: text.length, complete: true });
    const pieces: string[] = [];
    let cursor = 0;
    for (let i = 0; i < 50; i += 1) {
      const page: EntriesPage = await forward(svc(16), { cursor });
      pieces.push(...page.entries.map((e) => text.slice(e.offset, e.offset + e.length)));
      if (page.atEnd) break;
      expect(page.nextCursor).toBeGreaterThan(cursor);
      cursor = page.nextCursor;
    }
    expect(pieces.join('')).toBe(text);
  });

  it('scans at most logScanBytes per filtered request and always moves the cursor (Review Focus 3)', async () => {
    const text = Array.from({ length: 20 }, (_, i) => line('info', `m${i}`)).join('');
    write('run', text, 2);
    let cursor = 0;
    let requests = 0;
    for (;;) {
      const page = await forward(svc(128), { cursor, q: 'never-there' });
      requests += 1;
      expect(page.entries).toEqual([]);
      expect(page.scannedTo - page.scannedFrom).toBeLessThanOrEqual(128);
      if (page.atEnd) break;
      expect(page.nextCursor).toBeGreaterThan(cursor);
      cursor = page.nextCursor;
    }
    expect(requests).toBeGreaterThan(text.length / 128);
    expect(requests).toBeLessThan(text.length / 20);
  });

  it('stops at the limit: forward resumes after the last entry, backward keeps the newest lines', async () => {
    write('stdout', 'a\nb\nc\nd\n', 2);
    const f = await forward(svc(), { limit: 2 }, 'stdout');
    expect(f.entries.map((e) => e.text)).toEqual(['a', 'b']);
    expect(f).toMatchObject({ nextCursor: 4, scannedTo: 4, atEnd: false });
    const b = await backward(svc(), { limit: 2 }, 'stdout');
    expect(b.entries.map((e) => e.text)).toEqual(['c', 'd']);
    expect(b).toMatchObject({ nextCursor: 4, scannedFrom: 4, atEnd: false });
    expect((await backward(svc(), { cursor: 4 }, 'stdout')).entries.map((e) => e.text)).toEqual(['a', 'b']);
  });

  it('answers an empty page for a stream not uploaded yet, 404 past the job epoch, 410 when expired, 400 for a bad stream', async () => {
    expect(await forward(svc(), {}, 'stderr')).toEqual({ entries: [], nextCursor: 0, scannedFrom: 0, scannedTo: 0, atEnd: true, size: 0, complete: false, truncated: false });
    await expect(statusOf(forward(svc(), { leaseEpoch: 3 }))).resolves.toBe(404);
    logs.set({ jobId: job.id, leaseEpoch: 1, stream: 'run', expiredAt: new Date() });
    await expect(statusOf(forward(svc(), { leaseEpoch: 1 }))).resolves.toBe(410);
    await expect(statusOf(forward(svc(), {}, 'prompt'))).resolves.toBe(400);
    await expect(statusOf(svc().entries('p1', 'nope', 'run', { direction: 'forward', limit: 1 }))).resolves.toBe(404);
  });

  it('serves raw ranges clamped to the size and refuses more than 1 MiB', async () => {
    write('stderr', 'hello world', 2);
    expect((await svc().raw('p1', job.id, 'stderr', { from: 6 })).toString()).toBe('world');
    expect((await svc().raw('p1', job.id, 'stderr', { from: 0, to: 5 })).toString()).toBe('hello');
    await expect(statusOf(svc().raw('p1', job.id, 'stderr', { from: 0, to: 1024 * 1024 + 1 }))).resolves.toBe(400);
    await expect(statusOf(svc().raw('p1', job.id, 'stderr', { from: 9, to: 3 }))).resolves.toBe(400);
  });

  it('downloads the whole stream; empty when a row exists without bytes; 404 when neither exists', async () => {
    write('stdout', 'abc\n', 2);
    const d = await svc().download('p1', job.id, 'stdout');
    const chunks: Buffer[] = [];
    for await (const c of d.body) chunks.push(Buffer.from(c));
    expect({ ...d, body: Buffer.concat(chunks).toString() }).toEqual({ jobId: job.id, leaseEpoch: 2, stream: 'stdout', sizeBytes: 4, body: 'abc\n' });
    logs.set({ jobId: job.id, leaseEpoch: 2, stream: 'stderr', complete: true });
    expect((await svc().download('p1', job.id, 'stderr')).sizeBytes).toBe(0);
    await expect(statusOf(svc().download('p1', job.id, 'run'))).resolves.toBe(404);
  });
});
