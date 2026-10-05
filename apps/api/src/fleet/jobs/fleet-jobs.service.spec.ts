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
  let service: FleetJobsService;

  beforeEach(() => {
    repo = { findPage: jest.fn(), findById: jest.fn() };
    approvals = { countPendingByJob: jest.fn() };
    approvals.countPendingByJob.mockResolvedValue(new Map());
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
