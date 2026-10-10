import type { Mock } from 'vitest';
import { Readable } from 'stream';
import { BundleIngestService } from './bundle-ingest.service';
import { computeCorrection } from './ingest-corrections';

vi.mock('./bundle-reader', () => ({ readBundleFiles: vi.fn(async () => ({})) }));
vi.mock('./parse-bundle', () => ({
  parseBundle: vi.fn(() => ({ naxRunId: null, rows: [], ledgerCostUsd: '0', runStatus: 'completed', finish: null, partial: false, files: [] })),
}));
vi.mock('./ingest-corrections', () => ({ computeCorrection: vi.fn() }));

const now = new Date('2026-10-06T10:00:00Z');

function make() {
  const job = { id: 'j1', leaseEpoch: 1, naxRunId: null, projectId: 'p', repoId: 'r', runnerId: 'rn', state: 'COMPLETED', requestedById: 'u' };
  const repo = {
    claimNext: vi.fn().mockResolvedValueOnce({ id: 'i1', artifactId: 'a1', jobId: 'j1', leaseEpoch: 1, attempts: 0 }).mockResolvedValue(null),
    findArtifact: vi.fn(async () => ({ storageKey: 'k', expiredAt: null })),
    replaceRows: vi.fn(), markOutcome: vi.fn(), markRetry: vi.fn(), markFailed: vi.fn(),
  };
  const store = { get: vi.fn(async () => Readable.from([])) };
  const jobs = { lockById: vi.fn(async () => job), update: vi.fn(async () => job), appendEvent: vi.fn() };
  const live = { event: vi.fn(() => ({})), publish: vi.fn() };
  const ticketEffects = { upsertPrLinks: vi.fn().mockResolvedValue(undefined) };
  const svc = new BundleIngestService(
    repo as never, store as never, jobs as never, live as never, { record: vi.fn() } as never, { signal: vi.fn() } as never,
    { run: (fn: () => unknown) => fn() } as never, ticketEffects as never, { onIngestCorrection: vi.fn() } as never,
  );
  return { svc, ticketEffects, repo };
}

describe('BundleIngestService PR links after corrections (C9 §3.3)', () => {
  it('links the PR on the tickets when the correction filled resultPrUrl', async () => {
    (computeCorrection as Mock).mockReturnValue({ patch: { resultPrUrl: 'https://github.com/acme/app/pull/9' }, costRaised: false, escalated: false, liveCostUsd: null });
    const { svc, ticketEffects, repo } = make();
    await svc.ingestOne(now);
    expect(repo.markRetry).not.toHaveBeenCalled();
    expect(ticketEffects.upsertPrLinks).toHaveBeenCalledWith('j1');
  });

  it('does not link when the correction left resultPrUrl alone', async () => {
    (computeCorrection as Mock).mockReturnValue({ patch: {}, costRaised: false, escalated: false, liveCostUsd: null });
    const { svc, ticketEffects } = make();
    await svc.ingestOne(now);
    expect(ticketEffects.upsertPrLinks).not.toHaveBeenCalled();
  });
});
