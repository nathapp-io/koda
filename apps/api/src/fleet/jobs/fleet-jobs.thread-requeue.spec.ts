import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import { FleetJobsService } from './fleet-jobs.service';
import type { FleetJobRecord } from './domain/fleet-job.domain';

/** S5a: a THREAD job is never requeued; a new session goes through the send route. */
describe('fleet jobs service requeue refuses a THREAD job (S5a)', () => {
  const now = new Date('2026-10-01T00:00:00.000Z');
  const job = (over: Partial<FleetJobRecord>): FleetJobRecord => ({
    id: 'jt', projectId: 'p', repoId: 'r', ref: 'main', command: 'THREAD', feature: 'thread-1', planFrom: null, profiles: [],
    maxCostUsd: '5', bashMode: 'raw', approvalTimeoutSec: 600, selectorLabels: [], pinnedRunnerId: null,
    runnerId: null, runnerBootId: null, leaseEpoch: 1, state: 'CRASHED', stateReason: null, requestedById: 'u',
    queuedAt: now, assignedAt: null, startedAt: null, finishedAt: null, cancelRequestedAt: null,
    naxRunId: null, naxLogRunId: null, naxCostRunId: null, progress: null, currentStoryId: null, currentPhase: null,
    costSpentUsd: '0', costCarriedUsd: '0', firstStartedAt: null, cancelReason: null, scheduleId: null,
    coalescedCount: 0, scheduleCountedAt: null, lastHeartbeatAt: null, finishResult: null, escalationReason: null,
    exitCode: null, resultBranch: null, resultSha: null, resultPrUrl: null, wipPush: null,
    stories: null, storiesTruncated: false, postRun: null, configResult: null, eventSeq: 0, ackedRunnerSeq: 0, attributedAt: null, updatedAt: now,
    ...over,
  }) as FleetJobRecord;

  const build = (current: FleetJobRecord) => {
    const repo = { lockById: vi.fn().mockResolvedValue(current), withdrawPendingCommands: vi.fn() };
    const transitions = { apply: vi.fn() };
    const budgets = { assertNotPaused: vi.fn() };
    const placement = { placeJob: vi.fn() };
    const txManager = { run: vi.fn((fn: () => Promise<unknown>) => fn()) };
    const service = new FleetJobsService(
      repo as never, placement as never, {} as never, {} as never, transitions as never, {} as never,
      budgets as never, txManager as never, { countPendingByJob: vi.fn() } as never, {} as never, {} as never, { findByJobId: vi.fn() } as never,
    );
    return { service, repo, transitions, budgets, placement };
  };

  it('answers 409 fleet.jobState for a CRASHED THREAD job and changes nothing', async () => {
    const { service, repo, transitions, budgets, placement } = build(job({ state: 'CRASHED' }));
    const error = await service.requeue('u', 'p', 'jt').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictAppException);
    expect((error as ConflictAppException).prefix).toBe('fleet.jobState');
    expect((error as ConflictAppException).args).toEqual({ state: 'CRASHED' });
    expect(repo.withdrawPendingCommands).not.toHaveBeenCalled();
    expect(transitions.apply).not.toHaveBeenCalled();
    expect(budgets.assertNotPaused).not.toHaveBeenCalled();
    expect(placement.placeJob).not.toHaveBeenCalled();
  });
});
