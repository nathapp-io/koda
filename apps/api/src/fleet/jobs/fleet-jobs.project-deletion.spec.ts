import type { Mock } from 'vitest';
import { Logger } from '@nestjs/common';
import { FleetJobsService, PROJECT_DELETED_REASON, PROJECT_QUIESCE_LIMIT } from './fleet-jobs.service';
import { SYSTEM_ACTOR } from './job-transitions.service';
import type { FleetJobRecord } from './domain/fleet-job.domain';
import type { LiveFleetJobEvent } from '../../live/live-event';

/**
 * Review P2 remainder (US-001): `cancelForProjectDelete` ends only the project's **unstarted** jobs.
 *
 * A soft-deleted project's QUEUED jobs would otherwise still be placed on the next runner sync and spend
 * real budget for a project nobody can reach (every route 404s). QUEUED, and ASSIGNED whose ASSIGN the
 * runner has not acked, end on the server through `JobTransitionsService`; RUNNING, UPLOADING and an
 * acked ASSIGNED job are left to finish and report (spec ruling 15).
 */
describe('FleetJobsService.cancelForProjectDelete (US-001)', () => {
  const now = new Date('2026-11-01T00:00:00.000Z');
  const projectId = 'p1';

  const jobRecord = (id: string, state: FleetJobRecord['state'], over: Partial<FleetJobRecord> = {}): FleetJobRecord => ({
    id, projectId, repoId: 'r1', ref: 'main', command: 'RUN', feature: id, planFrom: null, profiles: [],
    maxCostUsd: '5', bashMode: 'raw', approvalTimeoutSec: 600, selectorLabels: [], pinnedRunnerId: null,
    runnerId: state === 'QUEUED' ? null : 'runner-1', runnerBootId: null, leaseEpoch: 1, state, stateReason: null,
    requestedById: 'u1', queuedAt: now, assignedAt: null, startedAt: null, finishedAt: null, cancelRequestedAt: null,
    naxRunId: null, naxLogRunId: null, naxCostRunId: null, progress: null, currentStoryId: null, currentPhase: null,
    costSpentUsd: '0', costCarriedUsd: '0', firstStartedAt: null, cancelReason: null, scheduleId: null,
    coalescedCount: 0, scheduleCountedAt: null, lastHeartbeatAt: null, finishResult: null, escalationReason: null,
    exitCode: null, resultBranch: null, resultSha: null, resultPrUrl: null, wipPush: null,
    stories: null, storiesTruncated: false, postRun: null, configResult: null, eventSeq: 0, ackedRunnerSeq: 0,
    attributedAt: null, updatedAt: now, ...over,
  }) as FleetJobRecord;

  let repo: { findProjectUnstartedIds: Mock; lockById: Mock; findPendingCommand: Mock };
  let transitions: { apply: Mock };
  let service: FleetJobsService;
  let warn: Mock;

  /** The live event a transition answers, so the result can be checked against the transition's own. */
  const liveFor = (job: FleetJobRecord): LiveFleetJobEvent =>
    ({ id: `live-${job.id}`, type: 'fleet_job', projectId: job.projectId, jobId: job.id, state: 'CANCELLED', at: now.toISOString() }) as LiveFleetJobEvent;

  beforeEach(() => {
    repo = { findProjectUnstartedIds: vi.fn().mockResolvedValue([]), lockById: vi.fn(), findPendingCommand: vi.fn().mockResolvedValue(null) };
    transitions = {
      apply: vi.fn(async ({ job }: { job: FleetJobRecord }) => ({ job: { ...job, state: 'CANCELLED' as const }, live: liveFor(job) })),
    };
    service = new FleetJobsService(
      repo as never, {} as never, {} as never, {} as never, transitions as never, {} as never, {} as never,
      {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never,
    );
    warn = vi.fn();
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(warn);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('AC-7: cancels a QUEUED job with the project_deleted reason recorded on the transition', async () => {
    const queued = jobRecord('j1', 'QUEUED');
    repo.findProjectUnstartedIds.mockResolvedValue([queued.id]);
    repo.lockById.mockResolvedValue(queued);

    const result = await service.cancelForProjectDelete(projectId, now);

    expect(repo.findProjectUnstartedIds).toHaveBeenCalledWith(projectId, PROJECT_QUIESCE_LIMIT);
    expect(transitions.apply).toHaveBeenCalledTimes(1);
    expect(transitions.apply).toHaveBeenCalledWith(expect.objectContaining({
      job: queued,
      to: 'CANCELLED',
      by: 'server',
      now,
      actor: SYSTEM_ACTOR,
      reason: PROJECT_DELETED_REASON,
      extra: { cancelReason: PROJECT_DELETED_REASON },
    }));
    expect(PROJECT_DELETED_REASON).toBe('project_deleted');
    expect(result.cancelled).toEqual([queued.id]);
    expect(result.live).toEqual([liveFor(queued)]);
  });

  it('AC-8: cancels an ASSIGNED job whose ASSIGN command is still pending', async () => {
    const assigned = jobRecord('j2', 'ASSIGNED');
    repo.findProjectUnstartedIds.mockResolvedValue([assigned.id]);
    repo.lockById.mockResolvedValue(assigned);
    repo.findPendingCommand.mockResolvedValue({ id: 'cmd-1', jobId: assigned.id, type: 'ASSIGN', leaseEpoch: 1 });

    const result = await service.cancelForProjectDelete(projectId, now);

    expect(repo.findPendingCommand).toHaveBeenCalledWith({ jobId: assigned.id, type: 'ASSIGN', leaseEpoch: assigned.leaseEpoch });
    expect(transitions.apply).toHaveBeenCalledWith(expect.objectContaining({
      job: assigned, to: 'CANCELLED', actor: SYSTEM_ACTOR, extra: { cancelReason: PROJECT_DELETED_REASON },
    }));
    expect(result.cancelled).toEqual([assigned.id]);
  });

  it('AC-9: leaves RUNNING, UPLOADING and an acked ASSIGNED job to finish', async () => {
    const running = jobRecord('j3', 'RUNNING');
    const uploading = jobRecord('j4', 'UPLOADING');
    const acked = jobRecord('j5', 'ASSIGNED');
    repo.findProjectUnstartedIds.mockResolvedValue([running.id, uploading.id, acked.id]);
    repo.lockById.mockImplementation(async (id: string) => [running, uploading, acked].find((job) => job.id === id));
    // The only ASSIGNED row whose ASSIGN the runner already acked: nothing pending to withdraw.
    repo.findPendingCommand.mockResolvedValue(null);

    const result = await service.cancelForProjectDelete(projectId, now);

    expect(transitions.apply).not.toHaveBeenCalled();
    expect(result).toEqual({ cancelled: [], live: [] });
  });

  it('AC-10: skips a job whose row is no longer QUEUED or ASSIGNED once locked', async () => {
    // The query saw it QUEUED; by the time the row lock was granted it had started.
    repo.findProjectUnstartedIds.mockResolvedValue(['j6']);
    repo.lockById.mockResolvedValue(jobRecord('j6', 'RUNNING'));

    const result = await service.cancelForProjectDelete(projectId, now);

    expect(transitions.apply).not.toHaveBeenCalled();
    expect(result).toEqual({ cancelled: [], live: [] });
  });

  it('AC-11: logs one warn naming the project when the scan reaches the limit', async () => {
    const ids = Array.from({ length: PROJECT_QUIESCE_LIMIT }, (_, index) => `job-${index}`);
    repo.findProjectUnstartedIds.mockResolvedValue(ids);
    repo.lockById.mockResolvedValue(null);

    await service.cancelForProjectDelete(projectId, now);

    expect(PROJECT_QUIESCE_LIMIT).toBe(500);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(projectId);
  });

  it('AC-21: skips an ASSIGNED job whose ASSIGN was acked while the row lock was awaited', async () => {
    const assigned = jobRecord('j7', 'ASSIGNED');
    repo.findProjectUnstartedIds.mockResolvedValue([assigned.id]);
    // The re-read row is still ASSIGNED, but the runner acked the ASSIGN in the window: nothing to withdraw.
    repo.lockById.mockResolvedValue(assigned);
    repo.findPendingCommand.mockResolvedValue(null);

    const result = await service.cancelForProjectDelete(projectId, now);

    expect(repo.lockById).toHaveBeenCalledWith(assigned.id);
    // The pending-command check belongs after the lock, never before it.
    expect(repo.findPendingCommand.mock.invocationCallOrder[0]).toBeGreaterThan(repo.lockById.mock.invocationCallOrder[0]);
    expect(transitions.apply).not.toHaveBeenCalled();
    expect(result.cancelled).toEqual([]);
  });
});
