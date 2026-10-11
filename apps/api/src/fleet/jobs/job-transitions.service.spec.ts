import { InvalidTransitionError, JobTransitionsService, SYSTEM_ACTOR } from './job-transitions.service';
import type { LiveFleetApprovalEvent } from '../../live/live-event';
import type { FleetJobRecord } from './domain/fleet-job.domain';

const NOW = new Date('2026-10-01T00:00:00.000Z');

const APPROVAL_LIVE: LiveFleetApprovalEvent = { id: 'lv-1', type: 'fleet_approval', projectId: 'p1', approvalId: 'a1', status: 'cancelled', at: NOW.toISOString() };
const job = (over: Partial<FleetJobRecord> = {}): FleetJobRecord => ({
  id: 'j1', projectId: 'p1', repoId: 'r1', ref: 'main', command: 'RUN', feature: 'f', planFrom: null, threadId: null, profiles: [],
  maxCostUsd: '5', bashMode: 'raw', approvalTimeoutSec: 600, selectorLabels: [], pinnedRunnerId: null, runnerId: 'run-1', runnerBootId: 'b1',
  leaseEpoch: 2, state: 'ASSIGNED', stateReason: null, requestedById: 'u1', queuedAt: NOW, assignedAt: NOW,
  startedAt: null, finishedAt: null, cancelRequestedAt: null, naxRunId: null, naxLogRunId: null, naxCostRunId: null,
  progress: null, currentStoryId: null, currentPhase: null, costSpentUsd: '0', costCarriedUsd: '0', firstStartedAt: null, cancelReason: null, scheduleId: null, coalescedCount: 0, scheduleCountedAt: null, lastHeartbeatAt: null, finishResult: null,
  escalationReason: null, exitCode: null, resultBranch: null, resultSha: null, resultPrUrl: null, wipPush: null, stories: null, storiesTruncated: false, postRun: null, configResult: null, eventSeq: 0,
  ackedRunnerSeq: 0, attributedAt: null, updatedAt: NOW, ...over,
});

describe('JobTransitionsService', () => {
  const repo = {
    update: vi.fn(async (_id: string, patch: Record<string, unknown>) => job({ ...(patch as Partial<FleetJobRecord>), leaseEpoch: patch.bumpEpoch ? 3 : 2 })),
    appendEvent: vi.fn(),
    withdrawPendingCommands: vi.fn(),
    copyConfigResult: vi.fn(),
  };
  const activity = { record: vi.fn() };
  const live = { event: vi.fn((j: FleetJobRecord) => ({ id: 'e', type: 'fleet_job', projectId: j.projectId, jobId: j.id, state: j.state, at: NOW.toISOString() })), publish: vi.fn() };
  const schedules = { onJobEnded: vi.fn(async () => undefined) };
  const closer = { closeForJob: vi.fn().mockResolvedValue([APPROVAL_LIVE]) };
  const outcomes = { onTerminal: vi.fn(async () => undefined) };
  const svc = new JobTransitionsService(repo as never, activity as never, live as never, schedules as never, closer as never, outcomes as never);
  afterEach(() => vi.clearAllMocks());

  const ACTOR = { type: 'RUNNER', id: 'run-1' } as const;

  describe('leaving RUNNING (S1.5 §1.4, plan D263)', () => {
    it.each([['UPLOADING', 'runner'], ['CANCELLED', 'runner'], ['CRASHED', 'server']] as const)(
      'RUNNING -> %s closes the asks and withdraws unsent answers', async (to, by) => {
        const r = await svc.apply({ job: { ...job(), state: 'RUNNING' }, to, by, now: NOW, actor: ACTOR });
        expect(repo.withdrawPendingCommands).toHaveBeenCalledWith(job().id, NOW, { types: ['APPROVAL_ANSWER'] });
        expect(closer.closeForJob).toHaveBeenCalledWith(expect.objectContaining({ id: job().id }), NOW);
        expect(r.approvalLive).toEqual([APPROVAL_LIVE]);
      });

    it('a move that does not leave RUNNING touches no approvals', async () => {
      const r = await svc.apply({ job: { ...job(), state: 'ASSIGNED' }, to: 'RUNNING', by: 'runner', now: NOW, actor: ACTOR });
      expect(closer.closeForJob).not.toHaveBeenCalled();
      expect(r.approvalLive).toEqual([]);
    });
  });

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

  it('counts the end of a scheduled job against its schedule, in the same call (S1b §3.3)', async () => {
    const scheduledRepo = { ...repo, update: vi.fn(async () => job({ state: 'FAILED', scheduleId: 's1' })) };
    const scheduledSvc = new JobTransitionsService(scheduledRepo as never, activity as never, live as never, schedules as never, closer as never, { onTerminal: vi.fn() } as never);
    await scheduledSvc.apply({ job: job({ state: 'UPLOADING', scheduleId: 's1' }), to: 'FAILED', by: 'runner', now: NOW, actor: { type: 'RUNNER', id: 'run-1' } });
    expect(schedules.onJobEnded).toHaveBeenCalledWith(expect.objectContaining({ id: 'j1', state: 'FAILED', scheduleId: 's1' }), NOW);
  });

  it('does not touch the schedule for a non-terminal transition or an unscheduled job', async () => {
    const running = { ...repo, update: vi.fn(async () => job({ state: 'RUNNING', scheduleId: 's1' })) };
    await new JobTransitionsService(running as never, activity as never, live as never, schedules as never, closer as never, { onTerminal: vi.fn() } as never)
      .apply({ job: job({ scheduleId: 's1' }), to: 'RUNNING', by: 'runner', now: NOW, actor: { type: 'RUNNER', id: 'run-1' } });
    await svc.apply({ job: job({ state: 'UPLOADING' }), to: 'FAILED', by: 'runner', now: NOW, actor: { type: 'RUNNER', id: 'run-1' } });
    expect(schedules.onJobEnded).not.toHaveBeenCalled();
  });

  describe('config jobs (fleet S3 D475)', () => {
    it.each([['COMPLETED', 'runner'], ['FAILED', 'runner'], ['CRASHED', 'server']] as const)(
      'copies configResult into the edit row on UPLOADING -> %s', async (to, by) => {
        repo.update.mockImplementationOnce(async (_id: string, patch: Record<string, unknown>) => job({ ...(patch as Partial<FleetJobRecord>), command: 'CONFIG_EDIT' }));
        await svc.apply({ job: job({ command: 'CONFIG_EDIT', state: 'UPLOADING' }), to, by, now: NOW, actor: ACTOR });
        expect(repo.copyConfigResult).toHaveBeenCalledWith('j1');
      });

    it('does not copy for a non-terminal step or for a nax job', async () => {
      repo.update.mockImplementationOnce(async (_id: string, patch: Record<string, unknown>) => job({ ...(patch as Partial<FleetJobRecord>), command: 'CONFIG_EDIT' }));
      await svc.apply({ job: job({ command: 'CONFIG_EDIT', state: 'RUNNING' }), to: 'UPLOADING', by: 'runner', now: NOW, actor: ACTOR });
      await svc.apply({ job: job({ state: 'UPLOADING' }), to: 'COMPLETED', by: 'runner', now: NOW, actor: ACTOR });
      expect(repo.copyConfigResult).not.toHaveBeenCalled();
    });
  });

  describe('notification outcome (S4a §2.4, D513)', () => {
    it('hands every terminal job to the outcome recorder, after the update', async () => {
      await svc.apply({ job: job({ state: 'UPLOADING' }), to: 'ESCALATED', by: 'runner', now: NOW, actor: ACTOR });
      expect(outcomes.onTerminal).toHaveBeenCalledWith(expect.objectContaining({ id: 'j1', state: 'ESCALATED' }));
      expect(repo.update.mock.invocationCallOrder[0]).toBeLessThan(outcomes.onTerminal.mock.invocationCallOrder[0]);
    });

    it('passes the bumped epoch of a server terminal transition', async () => {
      await svc.apply({ job: job({ state: 'RUNNING' }), to: 'CRASHED', by: 'server', now: NOW, actor: SYSTEM_ACTOR });
      expect(outcomes.onTerminal).toHaveBeenCalledWith(expect.objectContaining({ state: 'CRASHED', leaseEpoch: 3 }));
    });

    it('does not call the recorder for a non-terminal move', async () => {
      await svc.apply({ job: job({ state: 'ASSIGNED' }), to: 'RUNNING', by: 'runner', now: NOW, actor: ACTOR });
      expect(outcomes.onTerminal).not.toHaveBeenCalled();
    });
  });
});
