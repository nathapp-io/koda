import { createHash } from 'crypto';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable } from 'stream';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import { FleetFenceException } from '../artifacts/bundle.exceptions';
import { LocalDiskLogStore } from './local-disk-log.store';
import { logKey } from './log-store';
import { MemoryLogRepo } from './test-helpers/memory-log-repo';
import { FleetLogException } from './log-upload.exceptions';
import { LogUpload, LogUploadService } from './log-upload.service';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
/** HTTP status of a rejected call (AppException extends HttpException). */
const statusOf = (p: Promise<unknown>) => p.then(() => 0, (e: { getStatus(): number }) => e.getStatus());

describe('LogUploadService', () => {
  const root = mkdtempSync(join(tmpdir(), 'koda-log-upload-'));
  const store = new LocalDiskLogStore({ artifactDir: root });
  const cfg = { logMaxBytes: 32, logChunkMaxBytes: 16, logRunnerBytesPerSec: 1_000_000 };
  let job: { id: string; projectId: string; runnerId: string | null; leaseEpoch: number; state: string };
  const jobs = { findById: jest.fn(async () => job), lockById: jest.fn(async () => job) };
  const fence = { holds: jest.fn((j: typeof job, r: string, e: number) => j.runnerId === r && j.leaseEpoch === e), abandon: jest.fn() };
  const tx = { run: jest.fn((fn: () => unknown) => fn()) };
  const live = { touch: jest.fn() };
  let logs: MemoryLogRepo;
  let svc: LogUploadService;
  let n = 0;

  beforeEach(() => {
    n += 1;
    job = { id: `job${n}`, projectId: 'p1', runnerId: 'r1', leaseEpoch: 1, state: 'RUNNING' };
    logs = new MemoryLogRepo();
    svc = new LogUploadService(jobs as never, fence as never, tx as never, store, logs as never, live as never, cfg as never);
  });
  afterEach(() => jest.clearAllMocks());

  const up = (body: string, over: Partial<LogUpload> = {}) => {
    const bytes = Buffer.from(body);
    return svc.upload({
      runnerId: 'r1', jobId: job.id, streamRaw: 'run', leaseEpochRaw: '1', offsetRaw: '0', finalRaw: undefined,
      // Declared length 0 or 1 keeps the rate bucket out of the way: Date.now() has 1 ms granularity (rate test overrides it).
      sha256Header: sha(bytes), contentLength: String(Math.min(bytes.length, 1)), body: Readable.from([bytes]), ...over,
    });
  };
  const file = () => readFileSync(join(root, logKey(job.id, 1, 'run')), 'utf8');

  it('appends at the current size, then answers duplicate and offset with the server size', async () => {
    await expect(up('abc\n')).resolves.toEqual({ outcome: 'appended', size: 4 });
    await expect(up('abc\n')).resolves.toEqual({ outcome: 'duplicate', size: 4 }); // Review Focus 1
    await expect(up('x', { offsetRaw: '9' })).resolves.toEqual({ outcome: 'offset', size: 4 });
    await expect(up('de\n', { offsetRaw: '4' })).resolves.toEqual({ outcome: 'appended', size: 7 });
    expect(file()).toBe('abc\nde\n');
    expect(await logs.findStream(job.id, 1, 'run')).toMatchObject({ sizeBytes: 7, complete: false });
    expect(live.touch).toHaveBeenLastCalledWith({ projectId: 'p1', jobId: job.id, leaseEpoch: 1, stream: 'run', size: 7, complete: false }, false);
  });

  it('accepts ASSIGNED and UPLOADING; refuses a terminal job with 409 jobState (R2)', async () => {
    job = { ...job, state: 'ASSIGNED' };
    await expect(up('a')).resolves.toMatchObject({ outcome: 'appended' });
    job = { ...job, state: 'UPLOADING' };
    await expect(up('b', { offsetRaw: '1' })).resolves.toMatchObject({ outcome: 'appended' });
    job = { ...job, state: 'COMPLETED' };
    await expect(up('c', { offsetRaw: '2' })).rejects.toBeInstanceOf(ConflictAppException);
  });

  it('a stale lease queues ABANDON under the row lock and throws the fence 409 (D310)', async () => {
    await expect(up('a', { leaseEpochRaw: '0' })).rejects.toBeInstanceOf(FleetFenceException);
    expect(jobs.lockById).toHaveBeenCalledWith(job.id);
    expect(fence.abandon).toHaveBeenCalledWith('r1', job, 0);
  });

  it('final=1 at the end marks the stream complete; later uploads answer complete (D314)', async () => {
    await up('abc\n');
    await expect(up('', { offsetRaw: '4', finalRaw: '1' })).resolves.toEqual({ outcome: 'complete', size: 4 });
    expect(await logs.findStream(job.id, 1, 'run')).toMatchObject({ complete: true });
    expect(live.touch).toHaveBeenLastCalledWith(expect.objectContaining({ complete: true }), true);
    await expect(up('', { offsetRaw: '4', finalRaw: '1' })).resolves.toEqual({ outcome: 'complete', size: 4 });
    await expect(up('z', { offsetRaw: '4' })).resolves.toEqual({ outcome: 'complete', size: 4 });
    expect(file()).toBe('abc\n');
  });

  it('final=1 at the wrong offset answers offset and does not complete', async () => {
    await up('abc\n');
    await expect(up('', { offsetRaw: '2', finalRaw: '1' })).resolves.toEqual({ outcome: 'offset', size: 4 });
    expect(await logs.findStream(job.id, 1, 'run')).toMatchObject({ complete: false });
  });

  it('cuts a chunk at the cap, marks truncated, and answers stream_cap again on retry (D315, Review Focus 2)', async () => {
    await up('0123456789abcdef'); // 16
    const tail = '0123456789ABCDEFGHIJ'.slice(0, 16);
    await expect(up(tail, { offsetRaw: '16' })).resolves.toEqual({ outcome: 'appended', size: 32 });
    await expect(up('more', { offsetRaw: '32' })).resolves.toEqual({ outcome: 'stream_cap', size: 32 });
    const before = file();
    await expect(up('more', { offsetRaw: '32' })).resolves.toEqual({ outcome: 'stream_cap', size: 32 });
    expect(file()).toBe(before);
    expect(await logs.findStream(job.id, 1, 'run')).toMatchObject({ truncated: true, complete: false, sizeBytes: 32 });
  });

  it('a chunk straddling the cap keeps only the bytes that fit', async () => {
    await up('0123456789abcdef');
    await up('0123456789', { offsetRaw: '16' }); // 26
    await expect(up('ABCDEFGHIJ', { offsetRaw: '26' })).resolves.toEqual({ outcome: 'stream_cap', size: 32 });
    expect(file().slice(26)).toBe('ABCDEF');
  });

  it('refuses a body past the chunk max by counting, not by Content-Length (413)', async () => {
    const big = 'x'.repeat(17);
    expect(await statusOf(up(big, { contentLength: '3' }))).toBe(413);
  });

  it('refuses a SHA mismatch (422) and bad input (400) before touching the store', async () => {
    await expect(up('abc', { sha256Header: sha(Buffer.from('zzz')) })).rejects.toBeInstanceOf(FleetLogException);
    expect(await statusOf(up('abc', { streamRaw: 'prompt' }))).toBe(400);
    expect(await statusOf(up('abc', { offsetRaw: '-1' }))).toBe(400);
    expect(await statusOf(up('abc', { finalRaw: 'yes' }))).toBe(400);
    expect(await statusOf(up('', {}))).toBe(400); // empty and not final
    expect(await statusOf(up('abc', { sha256Header: 'nope' }))).toBe(400);
    expect(await logs.findStream(job.id, 1, 'run')).toBeNull();
  });

  it('answers rate_limited with a wait before reading the body (D312)', async () => {
    svc = new LogUploadService(jobs as never, fence as never, tx as never, store, logs as never, live as never, { ...cfg, logRunnerBytesPerSec: 1 } as never);
    await expect(up('0123456789abcdef', { contentLength: '16' })).resolves.toMatchObject({ outcome: 'appended' });
    const res = await up('a', { offsetRaw: '16', contentLength: '1' });
    expect(res.outcome).toBe('rate_limited');
    expect(res.retryAfterMs).toBeGreaterThan(0);
  });
});
