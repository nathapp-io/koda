import { Readable } from 'stream';
import { BundleIngestService } from './bundle-ingest.service';
import { FleetJobTicketEffects } from '../tickets/fleet-job-ticket.effects';

vi.mock('./bundle-reader', () => ({ readBundleFiles: vi.fn() }));

const now = new Date('2026-10-06T10:00:00Z');
const workflowResult = JSON.stringify({
  schemaVersion: 1,
  runId: 'fab5b9af-d3a3-41f2-91ed-62372a733c03',
  verdict: { workflowPassed: true, outcome: 'draft', reasons: ['CI failed: test'], openItems: [] },
});
const statusText = JSON.stringify({
  run: { id: 'run-1', status: 'completed' },
  workflow: { step: 'done', outcome: 'draft', url: 'https://github.com/o/r/pull/4' },
});
const files = {
  cost: [], metrics: null, reviews: [], finishResults: [], finishLast: [],
  status: { name: 'nax-out/status.json', text: statusText },
  workflowResult: { name: 'workflow/result.json', text: workflowResult },
  oversized: [],
};

function make() {
  const job = {
    id: 'j1', leaseEpoch: 1, naxRunId: 'run-1', projectId: 'p', repoId: 'r', runnerId: 'rn',
    state: 'COMPLETED', command: 'RUN', requestedById: 'u', costSpentUsd: '0.0745',
    stateReason: null, finishResult: null, escalationReason: null, resultPrUrl: null,
    resultBranch: null, resultSha: null, workflow: null,
  };
  const repo = {
    claimNext: vi.fn().mockResolvedValueOnce({ id: 'i1', artifactId: 'a1', jobId: 'j1', leaseEpoch: 1, attempts: 0 }).mockResolvedValue(null),
    findArtifact: vi.fn(async () => ({ storageKey: 'k', expiredAt: null })),
    replaceRows: vi.fn(), markOutcome: vi.fn(), markRetry: vi.fn(), markFailed: vi.fn(),
  };
  const store = { get: vi.fn(async () => Readable.from([])) };
  const jobs = {
    lockById: vi.fn(async () => job),
    update: vi.fn(async (_id: string, patch: Record<string, unknown>) => ({ ...job, ...patch })),
    appendEvent: vi.fn(),
  };
  const live = { event: vi.fn(() => ({})), publish: vi.fn() };
  const activity = { record: vi.fn() };
  const ticketEffects = { upsertPrLinks: vi.fn().mockResolvedValue(undefined) };
  const outcomes = { onIngestCorrection: vi.fn() };
  const svc = new BundleIngestService(
    repo as never, store as never, jobs as never, live as never, activity as never, { signal: vi.fn() } as never,
    { run: (fn: () => unknown) => fn() } as never, ticketEffects as never, outcomes as never,
    { emit: vi.fn() } as never,
  );
  return { svc, repo, jobs, activity, ticketEffects };
}

describe('BundleIngestService workflow draft correction (US-005 AC-13/AC-14)', () => {
  it('AC-13 leaves the job ESCALATED with workflow and PR url and links the ticket PR', async () => {
    const { readBundleFiles } = await import('./bundle-reader');
    vi.mocked(readBundleFiles).mockResolvedValue(files as never);
    const { svc, jobs, ticketEffects } = make();
    await svc.ingestOne(now);
    expect(jobs.update).toHaveBeenCalledWith('j1', expect.objectContaining({
      state: 'ESCALATED',
      resultPrUrl: 'https://github.com/o/r/pull/4',
    }));
    const patch = jobs.update.mock.calls[0][1] as Record<string, unknown>;
    expect((patch.workflow as { outcome?: unknown })?.outcome).toBe('draft');
    expect(ticketEffects.upsertPrLinks).toHaveBeenCalledWith('j1');
  });

  it('AC-14 records the escalation activity with source workflow', async () => {
    const { readBundleFiles } = await import('./bundle-reader');
    vi.mocked(readBundleFiles).mockResolvedValue(files as never);
    const { svc, activity } = make();
    await svc.ingestOne(now);
    expect(activity.record).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ source: 'workflow' }),
    }));
  });

  it('AC-13b persists the workflow PR URL as a fleet pr link on the linked ticket (F1)', async () => {
    const { readBundleFiles } = await import('./bundle-reader');
    vi.mocked(readBundleFiles).mockResolvedValue(files as never);
    const job = {
      id: 'j1', leaseEpoch: 1, naxRunId: 'run-1', projectId: 'p', repoId: 'r', runnerId: 'rn',
      state: 'COMPLETED', command: 'RUN', requestedById: 'u', costSpentUsd: '0.0745',
      stateReason: null, finishResult: null, escalationReason: null, resultPrUrl: null,
      resultBranch: null, resultSha: null, workflow: null,
    };
    let savedPatch: Record<string, unknown> = {};
    const ingestRepo = {
      claimNext: vi.fn().mockResolvedValueOnce({ id: 'i1', artifactId: 'a1', jobId: 'j1', leaseEpoch: 1, attempts: 0 }).mockResolvedValue(null),
      findArtifact: vi.fn(async () => ({ storageKey: 'k', expiredAt: null })),
      replaceRows: vi.fn(), markOutcome: vi.fn(), markRetry: vi.fn(), markFailed: vi.fn(),
    };
    const store = { get: vi.fn(async () => Readable.from([])) };
    const jobs = {
      lockById: vi.fn(async () => job),
      update: vi.fn(async (_id: string, patch: Record<string, unknown>) => {
        savedPatch = patch;
        return { ...job, ...patch };
      }),
      appendEvent: vi.fn(),
    };
    const live = { event: vi.fn(() => ({})), publish: vi.fn() };
    const activity = { record: vi.fn() };
    const outcomes = { onIngestCorrection: vi.fn() };
    // The effect reads the job row after the correction commit; serve the corrected row.
    const effectRepo = {
      findJobForPrLinks: vi.fn(async () => ({
        id: 'j1', projectId: 'p', requestedById: 'u',
        resultPrUrl: (savedPatch.resultPrUrl as string | undefined) ?? null,
        repo: { provider: 'github' as const, owner: 'o', name: 'r' },
      })),
      findTicketsForJob: vi.fn(async () => [{ ticketId: 't1', ref: 'T-1', title: 'T-1', status: 'IN_PROGRESS', notifiedEpoch: null }]),
      upsertFleetPrLink: vi.fn(async () => true),
    };
    const events = { record: vi.fn() };
    const txManager = { run: (fn: () => unknown) => fn() };
    const realEffects = new FleetJobTicketEffects({} as never, effectRepo as never, events as never, txManager as never);
    const svc = new BundleIngestService(
      ingestRepo as never, store as never, jobs as never, live as never, activity as never, { signal: vi.fn() } as never,
      txManager as never, realEffects as never, outcomes as never, { emit: vi.fn() } as never,
    );
    await svc.ingestOne(now);
    // BundleIngestService fires upsertPrLinks without awaiting it; flush before asserting.
    for (let i = 0; i < 20 && effectRepo.upsertFleetPrLink.mock.calls.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(savedPatch.resultPrUrl).toBe('https://github.com/o/r/pull/4');
    expect(effectRepo.upsertFleetPrLink).toHaveBeenCalledWith(expect.objectContaining({
      ticketId: 't1', jobId: 'j1', url: 'https://github.com/o/r/pull/4', prNumber: 4, externalRef: 'o/r#4',
    }));
  });
});
