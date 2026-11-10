import { Logger } from '@nestjs/common';
import { FleetJobState } from '../../common/enums';
import type { PlacementRunnerRow, QueuedCursor, QueuedScanFilter } from './domain/fleet-job.domain';
import { MAX_QUEUED_SCAN_PAGES, QUEUED_SCAN_LIMIT } from './placement-rules';
import { PlacementService } from './placement.service';

/**
 * US-004: a fill reads QUEUED candidates in bounded keyset pages of rows the runner can actually take, so a page of
 * jobs it can never hold (pinned elsewhere, the other kind, a deleted project — excluded in SQL) or that misfit for a
 * per-job reason cannot hide every newer one. Drives the real service with fake collaborators, no database.
 */
const NOW = new Date('2026-11-21T12:00:00.000Z');

const runnerRow = (over: Partial<PlacementRunnerRow> = {}): PlacementRunnerRow => ({
  id: 'r1', name: 'box-1', enabled: true, lastSeenAt: new Date(NOW.getTime() - 1_000), bootedAt: NOW, labels: [],
  capacity: 2, bootId: 'boot-1', protocolVersion: 4, threadCapacity: 2,
  capabilities: {
    nax: { version: '0.83.0', protocols: ['native'] },
    sandbox: { available: true, probedAt: NOW.toISOString() },
    profiles: {}, credentials: [], tools: { git: true, gh: true, glab: true }, executors: ['host'],
    threadBackends: { native: ['m1'], acp: [] },
  },
  ...over,
} as PlacementRunnerRow);

interface JobSpec {
  id: string;
  command?: 'RUN' | 'THREAD';
  /** A selector label the fixture runner does not carry: the job reaches the per-job misfit check and fails it. */
  misfit?: boolean;
}

const jobRecord = (job: JobSpec) => ({
  id: job.id, projectId: 'p1', repoId: `repo-${job.id}`, command: job.command ?? 'RUN', state: FleetJobState.QUEUED,
  pinnedRunnerId: null, selectorLabels: job.misfit ? ['gpu'] : [], profiles: [], bashMode: 'raw',
  threadId: (job.command ?? 'RUN') === 'THREAD' ? `t-${job.id}` : null, feature: `f-${job.id}`, ref: 'trunk',
  maxCostUsd: '5', planFrom: null, approvalTimeoutSec: 600, leaseEpoch: 0, runnerId: null,
});

const threadAssignOf = (job: JobSpec) => ({
  threadId: `t-${job.id}`, action: 'SESSION', kind: 'REPO', feature: `f-${job.id}`, resume: false, instructions: 'go',
  backend: { kind: 'native', model: 'm1' }, skills: [], initialMessage: null,
});

/**
 * The candidates a runner can take, oldest first, answered the way the keyset query does: `limit` rows after the
 * cursor (`after` is a row the previous page returned), so paging is driven by real page boundaries.
 */
function keysetPages(jobs: JobSpec[]) {
  const rows: QueuedCursor[] = jobs.map((job, i) => ({ id: job.id, queuedAt: new Date(NOW.getTime() + i * 1_000) }));
  return (after: QueuedCursor | null): QueuedCursor[] => {
    const start = after ? rows.findIndex((row) => row.id === after.id) + 1 : 0;
    return rows.slice(start);
  };
}

/** Fake collaborators for one enabled runner and the given takeable QUEUED candidates. */
function fixture(jobs: JobSpec[], over: { pausedScope?: string } = {}) {
  const byId = new Map(jobs.map((job) => [job.id, jobRecord(job)]));
  const after = keysetPages(jobs);
  const assigned: string[] = [];
  const repo = {
    findRepo: vi.fn(async (repoId: string) => ({
      id: repoId, projectId: 'p1', provider: 'github' as const, owner: 'acme', name: 'app', defaultBranch: 'trunk', githubInstallationId: null,
    })),
    lockById: vi.fn(async (id: string) => byId.get(id) ?? null),
    findPlacementRunners: vi.fn(async () => [runnerRow()]),
    lockRunners: vi.fn(async () => ['r1']),
    findActiveLoads: vi.fn(async () => []),
    findQueuedPage: vi.fn(async (_filter: QueuedScanFilter, limit: number, cursor: QueuedCursor | null) => after(cursor).slice(0, limit)),
    findThreadAssign: vi.fn(async (id: string) => (byId.get(id)?.command === 'THREAD' ? threadAssignOf(byId.get(id) as JobSpec) : null)),
    // US-008: a RUN job is a nax command, so placement reads the repo's rule override for it.
    findRuleOverride: vi.fn(async () => null),
    setRuleOverrideSummary: vi.fn(async () => undefined),
    findById: vi.fn(async (id: string) => byId.get(id) ?? null),
    createCommand: vi.fn(async (c: { type: string; payload: unknown }) => c),
    pinThreadRunner: vi.fn(async () => undefined),
    casAssign: vi.fn(async (jobId: string) => { assigned.push(jobId); return 1; }),
  };
  const transitions = { record: vi.fn(async () => ({ live: {} })), apply: vi.fn(async () => ({ live: {} })) };
  const pausedScope = over.pausedScope;
  const budgets = {
    snapshot: vi.fn(async () => ({ runnerPaused: () => false, match: () => (pausedScope ? { id: pausedScope } : null) })),
  };
  const service = new PlacementService(
    repo as never,
    transitions as never,
    { publish: vi.fn() } as never,
    { notify: vi.fn() } as never,
    budgets as never,
    { run: vi.fn(async (fn: () => Promise<unknown>) => fn()) } as never,
    { threadsEnabled: true, runnerOfflineSec: 90 } as never,
    { githubApiUrl: 'https://api.github.com', gitlabApiUrl: 'https://gitlab.com/api/v4' } as never,
    { record: vi.fn(async () => undefined) } as never,
  );
  return { service, repo, transitions, assigned };
}

/** The `after` argument of each findQueuedPage call, in order. */
const cursors = (repo: { findQueuedPage: ReturnType<typeof vi.fn> }) =>
  repo.findQueuedPage.mock.calls.map((call) => (call as unknown as [QueuedScanFilter, number, QueuedCursor | null])[2]);

/** 50 misfitting jobs — one full page of candidates this runner always fails the per-job checks on. */
const misfitPage = (page: number): JobSpec[] =>
  Array.from({ length: QUEUED_SCAN_LIMIT }, (_, i) => ({ id: `m${page}-${i}`, misfit: true }));

describe('US-004: the fill scan reads bounded keyset pages of takeable candidates', () => {
  it('AC-8: assigns a fitting job found on the second page, continuing from the first page\'s last row', async () => {
    const first = misfitPage(0);
    const { service, repo, assigned } = fixture([...first, { id: 'fit' }]);

    expect(await service.fillRunner('r1', 1, NOW)).toBe(1);

    expect(assigned).toEqual(['fit']);
    expect(repo.findQueuedPage).toHaveBeenCalledTimes(2);
    expect(cursors(repo)[0]).toBeNull();
    expect(cursors(repo)[1]).toEqual(expect.objectContaining({ id: first[first.length - 1].id }));
    expect(cursors(repo)[1]?.queuedAt).toBeInstanceOf(Date);
  });

  it('AC-9: stops reading pages once the free slot is filled', async () => {
    const { service, repo, assigned } = fixture([{ id: 'fit' }, ...misfitPage(0)]);

    expect(await service.fillRunner('r1', 1, NOW)).toBe(1);

    expect(assigned).toEqual(['fit']);
    expect(repo.findQueuedPage).toHaveBeenCalledTimes(1);
  });

  it('AC-10: stops after a page shorter than QUEUED_SCAN_LIMIT', async () => {
    const { service, repo, assigned } = fixture([{ id: 'm-lone', misfit: true }]);

    expect(await service.fillRunner('r1', 1, NOW)).toBe(0);

    expect(assigned).toEqual([]);
    expect(repo.findQueuedPage).toHaveBeenCalledTimes(1);
  });

  it(`AC-11, AC-12: reads exactly ${MAX_QUEUED_SCAN_PAGES} full pages and assigns nothing when every candidate misfits`, async () => {
    const pages = Array.from({ length: MAX_QUEUED_SCAN_PAGES + 1 }, (_, page) => misfitPage(page));
    const { service, repo, assigned } = fixture(pages.flat());

    expect(await service.fillRunner('r1', 1, NOW)).toBe(0);

    expect(assigned).toEqual([]);
    expect(repo.findQueuedPage).toHaveBeenCalledTimes(MAX_QUEUED_SCAN_PAGES);
  });

  it('AC-13: logs one warn naming the runner when the page cap ends the scan with slots still free', async () => {
    const pages = Array.from({ length: MAX_QUEUED_SCAN_PAGES + 1 }, (_, page) => misfitPage(page));
    const { service } = fixture(pages.flat());
    const warn = vi.mocked(Logger.prototype.warn);
    warn.mockClear();

    await service.fillRunner('r1', 1, NOW);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('r1');
  });

  it('AC-14: scans with the runner\'s own filter and the non-thread kind', async () => {
    const { service, repo } = fixture([{ id: 'j1' }]);

    await service.fillRunner('r1', 1, NOW);

    expect(repo.findQueuedPage).toHaveBeenCalledWith({ runnerId: 'r1', threads: false }, QUEUED_SCAN_LIMIT, null);
  });

  it('AC-15: fillRunnerThreads scans with the thread kind', async () => {
    const { service, repo, assigned } = fixture([{ id: 't1', command: 'THREAD' }]);

    await service.fillRunnerThreads('r1', NOW);

    expect(repo.findQueuedPage).toHaveBeenCalledWith({ runnerId: 'r1', threads: true }, QUEUED_SCAN_LIMIT, null);
    expect(assigned).toEqual(['t1']);
  });

  it('AC-16: still cancels a paged QUEUED job whose scope paused, with the budget reason', async () => {
    const { service, repo, transitions } = fixture([{ id: 'j1' }], { pausedScope: 'pol-1' });

    expect(await service.fillRunner('r1', 1, NOW)).toBe(0);

    expect(transitions.apply).toHaveBeenCalledWith(expect.objectContaining({
      job: expect.objectContaining({ id: 'j1' }), to: FleetJobState.CANCELLED, reason: 'budget:pol-1',
      extra: { cancelReason: 'budget:pol-1' },
    }));
    expect(repo.casAssign).not.toHaveBeenCalled();
  });
});
