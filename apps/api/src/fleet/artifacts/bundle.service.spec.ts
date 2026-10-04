import { Readable } from 'stream';
import { BundleService } from './bundle.service';

/** HTTP status of a rejected call (AppException extends HttpException). */
const statusOf = (p: Promise<unknown>) => p.then(() => 0, (e: { getStatus(): number }) => e.getStatus());

describe('BundleService.download (S2a D341)', () => {
  const job = { id: 'j1', projectId: 'p1' };
  const artifact = (leaseEpoch: number, expiredAt: Date | null) => ({ id: `a${leaseEpoch}`, jobId: 'j1', leaseEpoch, kind: 'bundle', storageKey: `jobs/j1/${leaseEpoch}/x.tar.gz`, sizeBytes: 3n, sha256: 'x', createdAt: new Date(0), expiredAt });
  const repo = { findById: jest.fn(async () => job), findLatestArtifact: jest.fn() };
  const store = { get: jest.fn(async () => Readable.from([Buffer.from('tgz')])) };
  const svc = new BundleService(repo as never, store as never, {} as never, {} as never, {} as never, {} as never, {} as never);
  afterEach(() => jest.clearAllMocks());

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
