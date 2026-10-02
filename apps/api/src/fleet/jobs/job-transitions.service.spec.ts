import { InvalidTransitionError, JobTransitionsService, SYSTEM_ACTOR } from './job-transitions.service';
import type { FleetJobRecord } from './domain/fleet-job.domain';

const NOW = new Date('2026-10-01T00:00:00.000Z');
const job = (over: Partial<FleetJobRecord> = {}): FleetJobRecord => ({
  id: 'j1', projectId: 'p1', repoId: 'r1', ref: 'main', command: 'RUN', feature: 'f', planFrom: null, profiles: [],
  maxCostUsd: '5', bashMode: 'raw', selectorLabels: [], pinnedRunnerId: null, runnerId: 'run-1', runnerBootId: 'b1',
  leaseEpoch: 2, state: 'ASSIGNED', stateReason: null, requestedById: 'u1', queuedAt: NOW, assignedAt: NOW,
  startedAt: null, finishedAt: null, cancelRequestedAt: null, naxRunId: null, naxLogRunId: null, naxCostRunId: null,
  progress: null, currentStoryId: null, currentPhase: null, costSpentUsd: '0', costCarriedUsd: '0', firstStartedAt: null, cancelReason: null, scheduleId: null, coalescedCount: 0, scheduleCountedAt: null, lastHeartbeatAt: null, finishResult: null,
  escalationReason: null, exitCode: null, resultBranch: null, resultSha: null, resultPrUrl: null, wipPush: null, stories: null, storiesTruncated: false, eventSeq: 0,
  ackedRunnerSeq: 0, attributedAt: null, updatedAt: NOW, ...over,
});

describe('JobTransitionsService', () => {
  const repo = {
    update: jest.fn(async (_id: string, patch: Record<string, unknown>) => job({ ...(patch as Partial<FleetJobRecord>), leaseEpoch: patch.bumpEpoch ? 3 : 2 })),
    appendEvent: jest.fn(),
    withdrawPendingCommands: jest.fn(),
  };
  const activity = { record: jest.fn() };
  const live = { event: jest.fn((j: FleetJobRecord) => ({ id: 'e', type: 'fleet_job', projectId: j.projectId, jobId: j.id, state: j.state, at: NOW.toISOString() })), publish: jest.fn() };
  const svc = new JobTransitionsService(repo as never, activity as never, live as never);
  afterEach(() => jest.clearAllMocks());

  it('refuses a transition outside the table', async () => {
    await expect(svc.apply({ job: job({ state: 'RUNNING' }), to: 'COMPLETED', by: 'runner', now: NOW, actor: SYSTEM_ACTOR }))
      .rejects.toBeInstanceOf(InvalidTransitionError);
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('stamps startedAt on RUNNING and writes the server event and activity', async () => {
    const { job: after, live: ev } = await svc.apply({ job: job(), to: 'RUNNING', by: 'runner', now: NOW, actor: { type: 'RUNNER', id: 'run-1' } });
    expect(repo.update).toHaveBeenCalledWith('j1', expect.objectContaining({ state: 'RUNNING', startedAt: NOW, stateReason: null }));
    expect(repo.appendEvent).toHaveBeenCalledWith('j1', { leaseEpoch: 2, runnerSeq: null, type: 'state', payload: { from: 'ASSIGNED', to: 'RUNNING', by: 'runner', reason: null } });
    expect(activity.record).toHaveBeenCalledWith(expect.objectContaining({
      actorType: 'RUNNER', action: 'job.running', entityType: 'job', entityId: 'j1', jobId: 'j1', projectId: 'p1', responsibleUserId: 'u1',
    }));
    expect(repo.withdrawPendingCommands).not.toHaveBeenCalled();
    expect(ev).toEqual(expect.objectContaining({ type: 'fleet_job', jobId: after.id, state: 'RUNNING' }));
  });

  it('sets firstStartedAt on the first RUNNING only (S1b §2.1)', async () => {
    await svc.apply({ job: job(), to: 'RUNNING', by: 'runner', now: NOW, actor: { type: 'RUNNER', id: 'run-1' } });
    expect(repo.update).toHaveBeenLastCalledWith('j1', expect.objectContaining({ startedAt: NOW, firstStartedAt: NOW }));
    const earlier = new Date('2026-09-01T00:00:00.000Z');
    await svc.apply({ job: job({ firstStartedAt: earlier }), to: 'RUNNING', by: 'runner', now: NOW, actor: { type: 'RUNNER', id: 'run-1' } });
    expect(repo.update.mock.calls[1][1]).not.toHaveProperty('firstStartedAt');
  });

  it('bumps the epoch and withdraws commands on a server-owned terminal transition of a held job (plan D4)', async () => {
    await svc.apply({ job: job(), to: 'CANCELLED', by: 'server', now: NOW, actor: SYSTEM_ACTOR, reason: 'cancelled before start' });
    expect(repo.update).toHaveBeenCalledWith('j1', expect.objectContaining({ state: 'CANCELLED', finishedAt: NOW, bumpEpoch: true, stateReason: 'cancelled before start' }));
    expect(repo.withdrawPendingCommands).toHaveBeenCalledWith('j1', NOW);
  });

  it('does not bump for a runner-reported terminal state or a never-assigned job', async () => {
    await svc.apply({ job: job({ state: 'UPLOADING' }), to: 'COMPLETED', by: 'runner', now: NOW, actor: SYSTEM_ACTOR });
    await svc.apply({ job: job({ state: 'QUEUED', runnerId: null }), to: 'CANCELLED', by: 'server', now: NOW, actor: SYSTEM_ACTOR });
    for (const [, patch] of repo.update.mock.calls) expect(patch).not.toHaveProperty('bumpEpoch');
  });
});
