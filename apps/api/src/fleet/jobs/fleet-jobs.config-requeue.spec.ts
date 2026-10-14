import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import { FleetJobsService } from './fleet-jobs.service';
import type { FleetJobRecord } from './domain/fleet-job.domain';
import type { ConfigEditRecord } from '../repo-config/domain/config-edit.domain';
import type { ConfigJobOutcome, ConfigJobResult } from '../common/config-jobs';

/** US-003 R1: a config edit whose result is conflict or invalid cannot be requeued; it repeats the same failure. */
describe('fleet jobs service requeue of a config job (US-003)', () => {
  const now = new Date('2026-10-01T00:00:00.000Z');
  const job = (over: Partial<FleetJobRecord>): FleetJobRecord => ({
    id: 'jc', projectId: 'p', repoId: 'r', ref: 'main', command: 'CONFIG_EDIT', feature: 'config-edit-1', planFrom: null, profiles: [],
    maxCostUsd: '5', bashMode: 'raw', approvalTimeoutSec: 600, selectorLabels: [], pinnedRunnerId: null,
    runnerId: null, runnerBootId: null, leaseEpoch: 1, state: 'FAILED', stateReason: 'conflict', requestedById: 'u',
    queuedAt: now, assignedAt: null, startedAt: null, finishedAt: now, cancelRequestedAt: null,
    naxRunId: null, naxLogRunId: null, naxCostRunId: null, progress: null, currentStoryId: null, currentPhase: null,
    costSpentUsd: '0', costCarriedUsd: '0', firstStartedAt: null, cancelReason: null, scheduleId: null,
    coalescedCount: 0, scheduleCountedAt: null, lastHeartbeatAt: null, finishResult: null, escalationReason: null,
    exitCode: null, resultBranch: null, resultSha: null, resultPrUrl: null, wipPush: null,
    stories: null, storiesTruncated: false, postRun: null, workflow: null, configResult: null, eventSeq: 0, ackedRunnerSeq: 0, attributedAt: null, updatedAt: now,
    ...over,
  }) as FleetJobRecord;

  const edit = (over: Partial<ConfigEditRecord>): ConfigEditRecord => ({
    id: 'e1', jobId: 'jc', mode: 'edit', prTitle: 'Update config', prBody: null, baseSha: 'base',
    edits: [{ path: 'nax/config.json', op: 'put', content: '{}', baseSha: 'b1' }], result: null, createdAt: now,
    ...over,
  });

  const result = (outcome: ConfigJobOutcome): ConfigJobResult => ({ outcome });

  const build = (current: FleetJobRecord, found: ConfigEditRecord | null) => {
    const repo = { lockById: vi.fn().mockResolvedValue(current), withdrawPendingCommands: vi.fn(), findById: vi.fn().mockResolvedValue(current) };
    const transitions = { apply: vi.fn() };
    const budgets = { assertNotPaused: vi.fn() };
    const placement = { placeJob: vi.fn() };
    const configEdits = { findByJobId: vi.fn().mockResolvedValue(found) };
    const txManager = { run: vi.fn((fn: () => Promise<unknown>) => fn()) };
    const service = new FleetJobsService(
      repo as never, placement as never, {} as never, { publish: vi.fn() } as never, transitions as never, {} as never,
      budgets as never, txManager as never, { countPendingByJob: vi.fn().mockResolvedValue(new Map()) } as never, { forJob: vi.fn().mockResolvedValue([]) } as never, {} as never, configEdits as never,
    );
    return { service, repo, transitions, budgets, placement, configEdits };
  };

  /** Requeue succeeds: transition returns the job as QUEUED and placement is a no-op. */
  const allowQueued = (repo: ReturnType<typeof build>['repo'], transitions: ReturnType<typeof build>['transitions'], placement: ReturnType<typeof build>['placement'], current: FleetJobRecord) => {
    vi.mocked(repo.findById).mockResolvedValue({ ...current, state: 'QUEUED' });
    vi.mocked(transitions.apply).mockImplementation(async (input: never) => {
      const args = input as unknown as { job: FleetJobRecord; extra: Partial<FleetJobRecord> };
      return { job: { ...args.job, ...args.extra, state: 'QUEUED' } as FleetJobRecord, live: {} as never };
    });
    vi.mocked(placement.placeJob).mockResolvedValue({ assigned: false, runnerId: null, misfits: [] } as never);
  };

  const refusal = async (service: FleetJobsService) => {
    const error = await service.requeue('u', 'p', 'jc').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictAppException);
    return error as ConflictAppException;
  };

  it('AC-4: refuses a failed edit whose result is conflict with fleet.configRequeue { outcome: conflict }', async () => {
    const current = job({ state: 'FAILED' });
    const { service } = build(current, edit({ result: result('conflict') }));
    const error = await refusal(service);
    expect(error.prefix).toBe('fleet.configRequeue');
    expect(error.args).toEqual({ outcome: 'conflict' });
  });

  it('AC-5: refuses a failed edit whose result is invalid with fleet.configRequeue { outcome: invalid }', async () => {
    const current = job({ state: 'FAILED' });
    const { service } = build(current, edit({ result: result('invalid') }));
    const error = await refusal(service);
    expect(error.prefix).toBe('fleet.configRequeue');
    expect(error.args).toEqual({ outcome: 'invalid' });
  });

  it('AC-6: a refused requeue performs no job state transition and withdraws no commands', async () => {
    const current = job({ state: 'FAILED' });
    const { service, repo, transitions } = build(current, edit({ result: result('conflict') }));
    await refusal(service);
    expect(transitions.apply).not.toHaveBeenCalled();
    expect(repo.withdrawPendingCommands).not.toHaveBeenCalled();
  });

  it('AC-7: a refused requeue performs no placement and no budget check', async () => {
    const current = job({ state: 'FAILED' });
    const { service, placement, budgets } = build(current, edit({ result: result('invalid') }));
    await refusal(service);
    expect(placement.placeJob).not.toHaveBeenCalled();
    expect(budgets.assertNotPaused).not.toHaveBeenCalled();
  });

  it('AC-8: a failed edit whose result is push_failed still requeues to QUEUED', async () => {
    const current = job({ state: 'FAILED' });
    const { service, repo, transitions, placement } = build(current, edit({ result: result('push_failed') }));
    allowQueued(repo, transitions, placement, current);
    const response = await service.requeue('u', 'p', 'jc');
    expect(transitions.apply).toHaveBeenCalledWith(expect.objectContaining({ to: 'QUEUED' }));
    expect(response.job.state).toBe('QUEUED');
  });

  it('AC-9: a failed drift job whose result is invalid still requeues to QUEUED (only mode edit is guarded)', async () => {
    const current = job({ state: 'FAILED', command: 'CONFIG_DRIFT' });
    const { service, repo, transitions, placement } = build(current, edit({ mode: 'drift', result: result('invalid') }));
    allowQueued(repo, transitions, placement, current);
    const response = await service.requeue('u', 'p', 'jc');
    expect(transitions.apply).toHaveBeenCalledWith(expect.objectContaining({ to: 'QUEUED' }));
    expect(response.job.state).toBe('QUEUED');
  });

  it('AC-10: a failed config job with no edit row still requeues to QUEUED', async () => {
    const current = job({ state: 'FAILED' });
    const { service, repo, transitions, placement } = build(current, null);
    allowQueued(repo, transitions, placement, current);
    const response = await service.requeue('u', 'p', 'jc');
    expect(transitions.apply).toHaveBeenCalledWith(expect.objectContaining({ to: 'QUEUED' }));
    expect(response.job.state).toBe('QUEUED');
  });

  it('AC-11: a failed config job whose edit has no result and no job configResult still requeues to QUEUED', async () => {
    const current = job({ state: 'FAILED', configResult: null });
    const { service, repo, transitions, placement } = build(current, edit({ result: null }));
    allowQueued(repo, transitions, placement, current);
    const response = await service.requeue('u', 'p', 'jc');
    expect(transitions.apply).toHaveBeenCalledWith(expect.objectContaining({ to: 'QUEUED' }));
    expect(response.job.state).toBe('QUEUED');
  });

  it('AC-12: with edit.result null, the outcome is read from the job configResult and refused when it is conflict', async () => {
    const current = job({ state: 'FAILED', configResult: result('conflict') });
    const { service, transitions } = build(current, edit({ result: null }));
    const error = await refusal(service);
    expect(error.prefix).toBe('fleet.configRequeue');
    expect(error.args).toEqual({ outcome: 'conflict' });
    expect(transitions.apply).not.toHaveBeenCalled();
  });
});
