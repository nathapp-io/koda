import { Readable } from 'stream';
import { Logger } from '@nestjs/common';
import type { TransactionRunOptions } from '@nathapp/nestjs-data';
import type { ArtifactStore } from './artifact-store';
import { BundleService } from './bundle.service';
import { mockAuditRecorder } from '../../common/test-helpers/global-stubs.module';

describe('BundleService.upload metadata reconciliation', () => {
  afterEach(() => vi.restoreAllMocks());

  const setup = (verificationFails: boolean) => {
    const original = new Error('metadata acknowledgement lost');
    const secondary = new Error('verification unavailable');
    const bytes = new Map<string, Buffer>();
    let attemptKey = '';
    const store = {
      put: vi.fn<ArtifactStore['put']>(async (key, source) => {
        attemptKey = key;
        const chunks: Buffer[] = [];
        for await (const chunk of source) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks);
        bytes.set(key, body);
        return { sizeBytes: body.length, sha256: 'a'.repeat(64) };
      }),
      delete: vi.fn<ArtifactStore['delete']>(async (key) => { bytes.delete(key); }),
    };
    const repo = {
      lockById: vi.fn(async () => ({ id: 'j1', runnerId: 'r1', leaseEpoch: 3, state: 'UPLOADING' })),
      findArtifact: vi.fn().mockResolvedValueOnce(null),
      upsertArtifact: vi.fn(async () => ({ id: 'a1' })),
    };
    if (verificationFails) repo.findArtifact.mockRejectedValue(secondary);
    else repo.findArtifact.mockResolvedValue(null);
    let calls = 0;
    const tx = {
      run: vi.fn(async (fn: () => Promise<unknown>, _options?: TransactionRunOptions) => {
        const call = ++calls;
        const result = await fn();
        // The metadata callback succeeded, but its transaction's outcome is unknown to the caller.
        if (call === 2) throw original;
        return result;
      }),
      getClient: vi.fn(), isInTransaction: vi.fn(() => false),
    };
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    warn.mockClear();
    const service = new BundleService(repo as never, store as never, { holds: () => true } as never,
      { record: vi.fn() } as never, tx as never, { bundleMaxBytes: 100 }, {} as never,
      { enqueue: vi.fn() } as never, {} as never, mockAuditRecorder);
    const upload = () => service.upload({ jobId: 'j1', runnerId: 'r1', leaseEpochRaw: '3',
      sha256Header: 'a'.repeat(64), contentType: 'application/gzip', contentLength: '7', body: Readable.from(['attempt']) });
    return { original, secondary, bytes, store, repo, tx, warn, upload, key: () => attemptKey };
  };

  it('AC-7: retains attempt bytes when the fresh verification read fails', async () => {
    const h = setup(true);
    await expect(h.upload()).rejects.toBe(h.original);
    expect(h.repo.findArtifact).toHaveBeenCalledTimes(2);
    expect(h.tx.run).toHaveBeenLastCalledWith(expect.any(Function), expect.objectContaining({ propagation: 'requiresNew', isolationLevel: 'ReadCommitted' }));
    expect(h.bytes.get(h.key())).toEqual(Buffer.from('attempt'));
    expect(h.store.delete).not.toHaveBeenCalled();
  });

  it('AC-8: identifies the retained attempt in a recoverable verification diagnostic', async () => {
    const h = setup(true);
    await expect(h.upload()).rejects.toBe(h.original);
    expect(h.warn).toHaveBeenCalledWith(expect.stringContaining(h.key()));
    expect(h.warn).toHaveBeenCalledWith(expect.stringContaining(h.secondary.message));
  });

  it('AC-9: preserves the original error after a failed verification read', async () => {
    const h = setup(true);
    const error = await h.upload().catch((error: unknown) => error);
    expect(h.repo.findArtifact).toHaveBeenCalledTimes(2);
    expect(error).toBe(h.original);
    expect(error).not.toBe(h.secondary);
  });

  it('AC-10: diagnoses orphan deletion failure without masking the metadata failure', async () => {
    const h = setup(false);
    h.store.delete.mockRejectedValueOnce(new Error('disk unavailable'));
    await expect(h.upload()).rejects.toBe(h.original);
    expect(h.store.delete).toHaveBeenCalledExactlyOnceWith(h.key());
    expect(h.warn).toHaveBeenCalledWith(expect.stringContaining(h.key()));
    expect(h.warn).toHaveBeenCalledWith(expect.stringContaining('disk unavailable'));
    expect(h.bytes.has(h.key())).toBe(true);
  });
});

/** HTTP status of a rejected call (AppException extends HttpException). */
const statusOf = (p: Promise<unknown>) => p.then(() => 0, (e: { getStatus(): number }) => e.getStatus());

describe('BundleService.download (S2a D341)', () => {
  const job = { id: 'j1', projectId: 'p1' };
  const artifact = (leaseEpoch: number, expiredAt: Date | null) => ({ id: `a${leaseEpoch}`, jobId: 'j1', leaseEpoch, kind: 'bundle', storageKey: `jobs/j1/${leaseEpoch}/x.tar.gz`, sizeBytes: 3n, sha256: 'x', createdAt: new Date(0), expiredAt });
  const repo = { findById: vi.fn(async () => job), findLatestArtifact: vi.fn() };
  const store = { get: vi.fn(async () => Readable.from([Buffer.from('tgz')])) };
  const svc = new BundleService(repo as never, store as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, mockAuditRecorder);
  afterEach(() => vi.clearAllMocks());

  it('streams the newest unexpired bundle', async () => {
    repo.findLatestArtifact.mockResolvedValueOnce(artifact(2, null));
    await expect(svc.download('p1', 'j1')).resolves.toMatchObject({ leaseEpoch: 2, sizeBytes: 3n });
    expect(repo.findLatestArtifact).toHaveBeenCalledWith('j1', 'bundle');
    expect(store.get).toHaveBeenCalledWith('jobs/j1/2/x.tar.gz');
  });

  it('answers 410 when only an expired bundle exists', async () => {
    repo.findLatestArtifact.mockResolvedValueOnce(null).mockResolvedValueOnce(artifact(1, new Date()));
    await expect(statusOf(svc.download('p1', 'j1'))).resolves.toBe(410);
    expect(repo.findLatestArtifact).toHaveBeenLastCalledWith('j1', 'bundle', { includeExpired: true });
    expect(store.get).not.toHaveBeenCalled();
  });

  it('answers 404 when no bundle was ever uploaded, and for another project', async () => {
    repo.findLatestArtifact.mockResolvedValue(null);
    await expect(statusOf(svc.download('p1', 'j1'))).resolves.toBe(404);
    await expect(statusOf(svc.download('p2', 'j1'))).resolves.toBe(404);
  });
});
