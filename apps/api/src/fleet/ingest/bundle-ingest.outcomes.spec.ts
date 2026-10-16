import type { Mock } from 'vitest';
import { Readable } from 'stream';
import { BundleIngestService } from './bundle-ingest.service';
import { computeCorrection } from './ingest-corrections';
import { parseBundle } from './parse-bundle';

vi.mock('./bundle-reader', () => ({ readBundleFiles: vi.fn(async () => ({})) }));
vi.mock('./parse-bundle', () => ({
  parseBundle: vi.fn(() => ({ naxRunId: null, rows: [], ledgerCostUsd: '0', runStatus: 'completed', finish: null, partial: false, files: [] })),
}));
vi.mock('./ingest-corrections', () => ({ computeCorrection: vi.fn() }));

const now = new Date('2026-10-09T10:00:00Z');

function make(updated: Record<string, unknown>) {
  const job = { id: 'j1', leaseEpoch: 1, naxRunId: null, projectId: 'p', repoId: 'r', runnerId: 'rn', state: 'COMPLETED', requestedById: 'u', resultPrUrl: null };
  const repo = {
    claimNext: vi.fn().mockResolvedValueOnce({ id: 'i1', artifactId: 'a1', jobId: 'j1', leaseEpoch: 1, attempts: 0 }).mockResolvedValue(null),
    findArtifact: vi.fn(async () => ({ storageKey: 'k', expiredAt: null })),
    replaceRows: vi.fn(), markOutcome: vi.fn(), markRetry: vi.fn(), markFailed: vi.fn(),
  };
  const store = { get: vi.fn(async () => Readable.from([])) };
  const jobs = { lockById: vi.fn(async () => job), update: vi.fn(async () => ({ ...job, ...updated })), appendEvent: vi.fn() };
  const live = { event: vi.fn(() => ({})), publish: vi.fn() };
  const order: string[] = [];
  const outcomes = { onIngestCorrection: vi.fn(async () => { order.push('outcome'); }) };
  const svc = new BundleIngestService(
    repo as never, store as never, jobs as never, live as never, { record: vi.fn() } as never, { signal: vi.fn() } as never,
    { run: async (fn: () => unknown) => { order.push('tx:start'); const r = await fn(); order.push('tx:end'); return r; } } as never,
    { upsertPrLinks: vi.fn().mockResolvedValue(undefined) } as never, outcomes as never,
  );
  return { svc, outcomes, repo, order };
}

describe('BundleIngestService notification outcomes (S4a §2.4, D513)', () => {
  it('reports a verdict correction to the recorder inside the ingest transaction', async () => {
    (computeCorrection as Mock).mockReturnValue({ patch: { state: 'ESCALATED' }, costRaised: false, escalated: true, liveCostUsd: null });
    const { svc, outcomes, order, repo } = make({ state: 'ESCALATED' });
    await svc.ingestOne(now);
    expect(repo.markRetry).not.toHaveBeenCalled();
    expect(outcomes.onIngestCorrection).toHaveBeenCalledWith(expect.objectContaining({ state: 'ESCALATED' }), { escalated: true, prFilled: false });
    expect(order).toEqual(['tx:start', 'outcome', 'tx:end']);
  });

  it('reports a late PR url', async () => {
    (computeCorrection as Mock).mockReturnValue({ patch: { resultPrUrl: 'https://x/pull/2' }, costRaised: false, escalated: false, liveCostUsd: null });
    const { svc, outcomes } = make({ resultPrUrl: 'https://x/pull/2' });
    await svc.ingestOne(now);
    expect(outcomes.onIngestCorrection).toHaveBeenCalledWith(expect.objectContaining({ resultPrUrl: 'https://x/pull/2' }), { escalated: false, prFilled: true });
  });

  it('does not call the recorder when the correction changed neither', async () => {
    (computeCorrection as Mock).mockReturnValue({ patch: {}, costRaised: false, escalated: false, liveCostUsd: null });
    const { svc, outcomes } = make({});
    await svc.ingestOne(now);
    expect(outcomes.onIngestCorrection).not.toHaveBeenCalled();
  });
});

/** S5b US-001: what the parser produced for a RUN bundle that carries workflow/feature-report.md. */
const reportRow = { kind: 'report', content: '# R' } as const;
const parsedWithReport = {
  naxRunId: 'run-1', runStatus: 'completed', workflow: null, workflowOutcome: null, workflowUrl: null,
  rows: { costEvents: [], stories: [], reviews: [], outcomes: [reportRow] },
  finish: null, files: {}, partial: false, ledgerCostUsd: '0',
};
const noCorrection = { patch: {}, costRaised: false, escalated: false, escalatedFrom: null, liveCostUsd: null };

function makeForCommand(command: string) {
  const job = {
    id: 'j1', leaseEpoch: 1, naxRunId: 'run-1', projectId: 'p', repoId: 'r', runnerId: 'rn', state: 'COMPLETED',
    command, requestedById: 'u', resultPrUrl: null, costSpentUsd: '0', stateReason: 'done', finishResult: null,
    escalationReason: null, resultBranch: null, resultSha: null, workflow: null,
  };
  const repo = {
    claimNext: vi.fn().mockResolvedValueOnce({ id: 'i1', artifactId: 'a1', jobId: 'j1', leaseEpoch: 1, attempts: 0 }).mockResolvedValue(null),
    findArtifact: vi.fn(async () => ({ storageKey: 'k', expiredAt: null })),
    replaceRows: vi.fn(), markOutcome: vi.fn(), markRetry: vi.fn(), markFailed: vi.fn(),
  };
  const store = { get: vi.fn(async () => Readable.from([])) };
  const jobs = { lockById: vi.fn(async () => job), update: vi.fn(async () => job), appendEvent: vi.fn() };
  const svc = new BundleIngestService(
    repo as never, store as never, jobs as never, { event: vi.fn(() => ({})), publish: vi.fn() } as never,
    { record: vi.fn() } as never, { signal: vi.fn() } as never, { run: (fn: () => unknown) => fn() } as never,
    { upsertPrLinks: vi.fn() } as never, { onIngestCorrection: vi.fn() } as never,
  );
  return { svc, repo };
}

describe('BundleIngestService run outcomes (S5b US-001 AC-10/AC-11)', () => {
  it('AC-10 writes the parsed outcome rows for a RUN job', async () => {
    (parseBundle as Mock).mockReturnValueOnce(parsedWithReport);
    (computeCorrection as Mock).mockReturnValueOnce(noCorrection);
    const { svc, repo } = makeForCommand('RUN');
    await svc.ingestOne(now);
    expect(repo.markRetry).not.toHaveBeenCalled();
    expect(repo.replaceRows).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'j1', leaseEpoch: 1, projectId: 'p', repoId: 'r' }),
      expect.objectContaining({ costEvents: [], stories: [], reviews: [], outcomes: [reportRow] }),
    );
  });

  it('AC-11 writes no outcome rows for a PLAN job', async () => {
    (parseBundle as Mock).mockReturnValueOnce(parsedWithReport);
    (computeCorrection as Mock).mockReturnValueOnce(noCorrection);
    const { svc, repo } = makeForCommand('PLAN');
    await svc.ingestOne(now);
    expect(repo.replaceRows).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ outcomes: [] }));
  });
});
