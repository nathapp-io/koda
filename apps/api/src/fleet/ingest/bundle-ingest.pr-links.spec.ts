import { Readable } from 'stream';
import { BundleIngestService } from './bundle-ingest.service';
import { computeCorrection } from './ingest-corrections';

jest.mock('./bundle-reader', () => ({ readBundleFiles: jest.fn(async () => ({})) }));
jest.mock('./parse-bundle', () => ({
  parseBundle: jest.fn(() => ({ naxRunId: null, rows: [], ledgerCostUsd: '0', runStatus: 'completed', finish: null, partial: false, files: [] })),
}));
jest.mock('./ingest-corrections', () => ({ computeCorrection: jest.fn() }));

const now = new Date('2026-10-06T10:00:00Z');

function make() {
  const job = { id: 'j1', leaseEpoch: 1, naxRunId: null, projectId: 'p', repoId: 'r', runnerId: 'rn', state: 'COMPLETED', requestedById: 'u' };
  const repo = {
    claimNext: jest.fn().mockResolvedValueOnce({ id: 'i1', artifactId: 'a1', jobId: 'j1', leaseEpoch: 1, attempts: 0 }).mockResolvedValue(null),
    findArtifact: jest.fn(async () => ({ storageKey: 'k', expiredAt: null })),
    replaceRows: jest.fn(), markOutcome: jest.fn(), markRetry: jest.fn(), markFailed: jest.fn(),
  };
  const store = { get: jest.fn(async () => Readable.from([])) };
  const jobs = { lockById: jest.fn(async () => job), update: jest.fn(async () => job), appendEvent: jest.fn() };
  const live = { event: jest.fn(() => ({})), publish: jest.fn() };
  const ticketEffects = { upsertPrLinks: jest.fn().mockResolvedValue(undefined) };
  const svc = new BundleIngestService(
    repo as never, store as never, jobs as never, live as never, { record: jest.fn() } as never, { signal: jest.fn() } as never,
    { run: (fn: () => unknown) => fn() } as never, ticketEffects as never, { onIngestCorrection: jest.fn() } as never,
  );
  return { svc, ticketEffects, repo };
}

describe('BundleIngestService PR links after corrections (C9 §3.3)', () => {
  it('links the PR on the tickets when the correction filled resultPrUrl', async () => {
    (computeCorrection as jest.Mock).mockReturnValue({ patch: { resultPrUrl: 'https://github.com/acme/app/pull/9' }, costRaised: false, escalated: false, liveCostUsd: null });
    const { svc, ticketEffects, repo } = make();
    await svc.ingestOne(now);
    expect(repo.markRetry).not.toHaveBeenCalled();
    expect(ticketEffects.upsertPrLinks).toHaveBeenCalledWith('j1');
  });

  it('does not link when the correction left resultPrUrl alone', async () => {
    (computeCorrection as jest.Mock).mockReturnValue({ patch: {}, costRaised: false, escalated: false, liveCostUsd: null });
    const { svc, ticketEffects } = make();
    await svc.ingestOne(now);
    expect(ticketEffects.upsertPrLinks).not.toHaveBeenCalled();
  });
});
