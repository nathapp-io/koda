import { Readable } from 'stream';
import { BundleIngestService } from './bundle-ingest.service';

const now = new Date('2026-10-05T10:00:00Z');
const claim = (attempts: number) => ({ id: 'i1', artifactId: 'a1', jobId: 'j1', leaseEpoch: 1, attempts });

function make(attempts: number, opts: { expired?: boolean; storeFails?: boolean } = {}) {
  const repo = {
    claimNext: jest.fn().mockResolvedValueOnce(claim(attempts)).mockResolvedValue(null),
    findArtifact: jest.fn(async () => ({ storageKey: 'k', expiredAt: opts.expired ? now : null })),
    markRetry: jest.fn(), markFailed: jest.fn(), markOutcome: jest.fn(), replaceRows: jest.fn(),
  };
  const store = { get: jest.fn(async () => (opts.storeFails ? Promise.reject(new Error('EIO disk')) : Readable.from([Buffer.from('not gzip')]))) };
  const svc = new BundleIngestService(repo as never, store as never, {} as never, {} as never, {} as never, {} as never, { run: (fn: () => unknown) => fn() } as never, { upsertPrLinks: jest.fn() } as never);
  return { svc, repo };
}

describe('BundleIngestService failure handling (spec §2.5)', () => {
  it('backs off 1 minute after the first failure', async () => {
    const { svc, repo } = make(0);
    await svc.ingestOne(now);
    expect(repo.markRetry).toHaveBeenCalledWith('i1', 1, new Date(now.getTime() + 60_000), expect.stringContaining(''));
  });

  it('uses the 4th backoff (2 h) after the 4th failure and fails on the 5th', async () => {
    const fourth = make(3);
    await fourth.svc.ingestOne(now);
    expect(fourth.repo.markRetry).toHaveBeenCalledWith('i1', 4, new Date(now.getTime() + 7_200_000), expect.any(String));
    const fifth = make(4);
    await fifth.svc.ingestOne(now);
    expect(fifth.repo.markFailed).toHaveBeenCalledWith('i1', 5, expect.any(String));
  });

  it('fails an expired bundle at once without retry', async () => {
    const { svc, repo } = make(0, { expired: true });
    await svc.ingestOne(now);
    expect(repo.markFailed).toHaveBeenCalledWith('i1', 1, 'bundle expired');
    expect(repo.markRetry).not.toHaveBeenCalled();
  });

  it('trims the stored error to 500 chars', async () => {
    const { svc, repo } = make(0, { storeFails: true });
    await svc.ingestOne(now);
    const error = repo.markRetry.mock.calls[0][3] as string;
    expect(error.length).toBeLessThanOrEqual(500);
    expect(error).toContain('EIO disk');
  });

  it('returns false when nothing is claimable', async () => {
    const { svc, repo } = make(0);
    repo.claimNext.mockReset().mockResolvedValue(null);
    await expect(svc.ingestOne(now)).resolves.toBe(false);
  });
});
