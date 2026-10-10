import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable } from 'stream';
import { tarGz } from '../../../test/helpers/tar-gz';
import type { LogStreamName } from './domain/fleet-job-log.domain';
import { LocalDiskLogStore } from './local-disk-log.store';
import { logKey } from './log-store';
import { LogFallbackService } from './log-fallback.service';
import { MemoryLogRepo } from './test-helpers/memory-log-repo';

describe('LogFallbackService', () => {
  const root = mkdtempSync(join(tmpdir(), 'koda-fallback-'));
  const store = new LocalDiskLogStore({ artifactDir: root });
  const live = { touch: vi.fn() };
  let repo: MemoryLogRepo;
  let bundle: Buffer;
  let job: { id: string; projectId: string; command: string; feature: string; naxLogRunId: string | null; leaseEpoch: number };
  const artifacts = { get: vi.fn(async () => Readable.from([bundle])) };
  const jobs = { findById: vi.fn(async () => job) };
  let n = 0;
  const svc = () => new LogFallbackService(artifacts as never, store, repo as never, jobs as never, live as never, { logMaxBytes: 16 } as never);
  const file = (s: LogStreamName) => readFileSync(join(root, logKey(job.id, 1, s)), 'utf8');
  const runLog = 'nax-out/features/f/runs/r1.jsonl';

  beforeEach(() => {
    n += 1;
    repo = new MemoryLogRepo();
    job = { id: `jf${n}`, projectId: 'p1', command: 'RUN', feature: 'f', naxLogRunId: 'r1', leaseEpoch: 1 };
  });
  afterEach(() => vi.clearAllMocks());

  it('fills missing and incomplete streams; leaves complete and truncated ones alone', async () => {
    bundle = await tarGz([{ name: runLog, body: 'R1\nR2\n' }, { name: 'nax.stdout', body: 'OUT' }, { name: 'nax.stderr', body: 'ERR' }]);
    repo.set({ jobId: job.id, leaseEpoch: 1, stream: 'run', sizeBytes: 3 });
    await store.append(logKey(job.id, 1, 'run'), 0, Buffer.from('R1\n'));
    repo.set({ jobId: job.id, leaseEpoch: 1, stream: 'stdout', sizeBytes: 3, complete: true });
    await store.append(logKey(job.id, 1, 'stdout'), 0, Buffer.from('out'));
    repo.set({ jobId: job.id, leaseEpoch: 1, stream: 'stderr', sizeBytes: 16, truncated: true });
    await svc().fill({ jobId: job.id, leaseEpoch: 1, storageKey: 'k' });
    expect(file('run')).toBe('R1\nR2\n');
    expect(repo.get(job.id, 1, 'run')).toMatchObject({ complete: true, source: 'bundle', sizeBytes: 6 });
    expect(file('stdout')).toBe('out');
    expect(repo.get(job.id, 1, 'stderr')).toMatchObject({ truncated: true, source: 'stream' });
    expect(live.touch).toHaveBeenCalledWith(expect.objectContaining({ stream: 'run', complete: true, size: 6 }), true);
  });

  it('never replaces with a shorter member, and leaves a stream with no member incomplete', async () => {
    bundle = await tarGz([{ name: runLog, body: 'R1\n' }]);
    repo.set({ jobId: job.id, leaseEpoch: 1, stream: 'run', sizeBytes: 5 });
    await store.append(logKey(job.id, 1, 'run'), 0, Buffer.from('R1\nR2'));
    await svc().fill({ jobId: job.id, leaseEpoch: 1, storageKey: 'k' });
    expect(file('run')).toBe('R1\nR2');
    expect(repo.get(job.id, 1, 'run')).toMatchObject({ complete: false });
    expect(repo.get(job.id, 1, 'stdout')).toBeNull();
  });

  it('caps a member larger than FLEET_LOG_MAX_BYTES and marks it truncated (D318)', async () => {
    bundle = await tarGz([{ name: 'nax.stdout', body: 'x'.repeat(40) }]);
    await svc().fill({ jobId: job.id, leaseEpoch: 1, storageKey: 'k' });
    expect(file('stdout')).toBe('x'.repeat(16));
    expect(repo.get(job.id, 1, 'stdout')).toMatchObject({ truncated: true, complete: false, sizeBytes: 16, source: 'bundle' });
  });

  it('ignores naxLogRunId of a newer attempt (Review Focus 5)', async () => {
    job = { ...job, leaseEpoch: 2, naxLogRunId: 'r2' };
    bundle = await tarGz([{ name: runLog, body: 'old\n', mtime: new Date(1000) }, { name: 'nax-out/features/f/runs/r2.jsonl', body: 'new\n', mtime: new Date(500) }]);
    await svc().fill({ jobId: job.id, leaseEpoch: 1, storageKey: 'k' });
    expect(file('run')).toBe('old\n'); // newest by mtime, not the new attempt's id
  });

  it('skips a stream that became complete after the listing (CAS under the lock)', async () => {
    bundle = await tarGz([{ name: runLog, body: 'BUNDLE\n' }]);
    await store.append(logKey(job.id, 1, 'run'), 0, Buffer.from('LIVE\n'));
    artifacts.get.mockImplementationOnce(async () => {
      repo.set({ jobId: job.id, leaseEpoch: 1, stream: 'run', sizeBytes: 5, complete: true });
      return Readable.from([bundle]);
    });
    await svc().fill({ jobId: job.id, leaseEpoch: 1, storageKey: 'k' });
    expect(file('run')).toBe('LIVE\n');
    expect(live.touch).not.toHaveBeenCalled();
  });

  it('schedule() never throws and idle() waits for the queue; a corrupt bundle leaves streams incomplete', async () => {
    bundle = Buffer.from('corrupt');
    const s = svc();
    expect(() => s.schedule({ jobId: job.id, leaseEpoch: 1, storageKey: 'k' })).not.toThrow();
    await s.idle();
    expect(repo.get(job.id, 1, 'run')).toBeNull();
  });
});
