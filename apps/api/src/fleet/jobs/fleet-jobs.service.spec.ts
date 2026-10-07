import { FleetJobsService } from './fleet-jobs.service';
import type { FleetJobRecord } from './domain/fleet-job.domain';

describe('fleet jobs service approvals count (S1.5 2a D272)', () => {
  const now = new Date('2026-10-01T00:00:00.000Z');
  const record = (id: string): FleetJobRecord =>
    ({
      id, projectId: 'p', repoId: 'r', ref: 'main', command: 'RUN', feature: 'f', planFrom: null, profiles: [],
      maxCostUsd: '5', bashMode: 'escalate', approvalTimeoutSec: 600, selectorLabels: [], pinnedRunnerId: null,
      runnerId: null, runnerBootId: null, leaseEpoch: 1, state: 'RUNNING', stateReason: null, requestedById: 'u',
      queuedAt: now, assignedAt: null, startedAt: null, finishedAt: null, cancelRequestedAt: null,
      naxRunId: null, naxLogRunId: null, naxCostRunId: null, progress: null, currentStoryId: null, currentPhase: null,
      costSpentUsd: '0', costCarriedUsd: '0', firstStartedAt: null, cancelReason: null, scheduleId: null,
      coalescedCount: 0, scheduleCountedAt: null, lastHeartbeatAt: null, finishResult: null, escalationReason: null,
      exitCode: null, resultBranch: null, resultSha: null, resultPrUrl: null, wipPush: null,
      stories: null, storiesTruncated: false, postRun: null, eventSeq: 0, ackedRunnerSeq: 0, attributedAt: null, updatedAt: now,
    }) as never;
  const projectId = 'p';
  const jobA = record('ja');
  const jobB = record('jb');
  let repo: { findPage: jest.Mock; findById: jest.Mock };
  let approvals: { countPendingByJob: jest.Mock };
  let fleetTickets: { forJob: jest.Mock };
  let service: FleetJobsService;

  beforeEach(() => {
    repo = { findPage: jest.fn(), findById: jest.fn() };
    approvals = { countPendingByJob: jest.fn() };
    approvals.countPendingByJob.mockResolvedValue(new Map());
    fleetTickets = { forJob: jest.fn().mockResolvedValue([]) };
    service = new FleetJobsService(
      repo as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      approvals as never,
      fleetTickets as never,
      {} as never,
    );
  });

  it('list counts pending approvals for the whole page in one query (D272)', async () => {
    repo.findPage.mockResolvedValue({ total: 2, current: 1, size: 20, hasNext: false, hasPrev: false, records: [jobA, jobB] });
    approvals.countPendingByJob.mockResolvedValue(new Map([[jobB.id, 3]]));
    const page = await service.list({ projectId }, { current: 1, size: 20 });
    expect(approvals.countPendingByJob).toHaveBeenCalledTimes(1);
    expect(approvals.countPendingByJob).toHaveBeenCalledWith([jobA.id, jobB.id]);
    expect(page.records.map((r) => r.pendingApprovals)).toEqual([0, 3]);
  });

  it('get counts the job pending approvals', async () => {
    repo.findById.mockResolvedValue(jobA);
    approvals.countPendingByJob.mockResolvedValue(new Map([[jobA.id, 1]]));
    expect((await service.get(projectId, jobA.id)).pendingApprovals).toBe(1);
  });
});

describe('fleet jobs service dispatch open-PR guard (#231)', () => {
  const repoRecord = { id: 'r', projectId: 'p', defaultBranch: 'main' };
  const tickets = [{ id: 't1', ref: 'KODA-1', title: 'x', status: 'CREATED' }];
  let repo: { findRepo: jest.Mock };
  let fleetTickets: { resolveForDispatch: jest.Mock; findOpenVcsPrLinks: jest.Mock };
  let budgets: { assertNotPaused: jest.Mock };
  let service: FleetJobsService;

  const build = (): void => {
    repo = { findRepo: jest.fn().mockResolvedValue(repoRecord) };
    fleetTickets = {
      resolveForDispatch: jest.fn((_projectId: string, refs?: readonly string[]) => Promise.resolve(refs && refs.length > 0 ? tickets : [])),
      findOpenVcsPrLinks: jest.fn().mockResolvedValue([{ ticketId: 't1', url: 'https://github.com/acme/widgets/pull/1' }]),
    };
    budgets = { assertNotPaused: jest.fn().mockRejectedValue(new Error('budget-stop-sentinel')) };
    service = new FleetJobsService(
      repo as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      budgets as never,
      {} as never,
      {} as never,
      fleetTickets as never,
      {} as never,
    );
  };

  const runDto = (over: Record<string, unknown> = {}) => ({
    repoId: 'r', command: 'RUN' as const, feature: 'f', maxCostUsd: 5, ticketRefs: ['KODA-1'], ...over,
  });

  it('refuses a RUN when a target ticket already has an open VCS PR', async () => {
    build();
    await expect(service.dispatch('u', 'p', runDto() as never)).rejects.toMatchObject({ code: 409 });
    expect(fleetTickets.findOpenVcsPrLinks).toHaveBeenCalledWith(['t1']);
  });

  it('skips the guard when acknowledgeOpenPr is set, and lets the dispatch continue', async () => {
    build();
    await expect(service.dispatch('u', 'p', runDto({ acknowledgeOpenPr: true }) as never)).rejects.toThrow('budget-stop-sentinel');
    expect(fleetTickets.findOpenVcsPrLinks).not.toHaveBeenCalled();
  });

  it('does not look up PRs when no tickets are targeted', async () => {
    build();
    await expect(service.dispatch('u', 'p', runDto({ ticketRefs: undefined }) as never)).rejects.toThrow('budget-stop-sentinel');
    expect(fleetTickets.findOpenVcsPrLinks).not.toHaveBeenCalled();
  });

  it('does not look up PRs for a PLAN dispatch', async () => {
    build();
    await expect(service.dispatch('u', 'p', runDto({ command: 'PLAN', planFrom: 'spec.md' }) as never)).rejects.toThrow('budget-stop-sentinel');
    expect(fleetTickets.findOpenVcsPrLinks).not.toHaveBeenCalled();
  });
});
