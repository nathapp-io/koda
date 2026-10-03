import { NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import { BudgetPausedException } from '../budgets/budget.exceptions';
import { FleetDispatchException } from '../jobs/fleet-dispatch.exception';
import type { OwnerAccess, ScheduleActiveJob, ScheduleRecord } from './domain/schedule.domain';
import { mayDispatch } from './schedule-access';
import { ScheduleTicker } from './schedule-ticker';

const NOW = new Date('2026-10-02T03:00:30.000Z');
const DUE = new Date('2026-10-02T03:00:00.000Z');
const NEXT = new Date('2026-10-02T04:00:00.000Z');
const OWNER_OK: OwnerAccess = { exists: true, disabled: false, globalRole: 'MEMBER', projectRole: 'DEVELOPER' };

const schedule = (over: Partial<ScheduleRecord> = {}): ScheduleRecord => ({
  id: 's1', projectId: 'p1', repoId: 'r1', name: 'nightly', cron: '0 * * * *', timezone: 'UTC', feature: 'login', ref: 'main', profiles: ['fast'],
  maxCostUsd: '5', selectorLabels: [], pinnedRunnerId: null, bashMode: 'raw', approvalTimeoutSec: 600, enabled: true, nextFireAt: DUE, lastFiredAt: null, lastJobId: null,
  lastPassedCount: 0, noProgressTicks: 0, noProgressLimit: 3, disabledReason: null, createdById: 'u1', updatedById: 'u1',
  createdAt: NOW, updatedAt: NOW, ...over,
});

function build(due: ScheduleRecord[] = [schedule()]) {
  const repo = {
    findDue: jest.fn(async () => due),
    claimFire: jest.fn(async () => true),
    findActiveJob: jest.fn(async (): Promise<ScheduleActiveJob | null> => null),
    coalesceIntoQueued: jest.fn(async (): Promise<string | null> => null),
    findOwnerAccess: jest.fn(async () => OWNER_OK),
    update: jest.fn(async () => schedule()),
  };
  const jobs = { dispatch: jest.fn(async () => ({ job: { id: 'job-1' } })) };
  const progress = { disable: jest.fn(async () => true) };
  const activity = { record: jest.fn(async () => undefined) };
  const txManager = { run: jest.fn(async <T>(fn: () => Promise<T>) => fn()) };
  const ticker = new ScheduleTicker(repo as never, jobs as never, progress as never, activity as never, txManager as never, { sweepEnabled: false });
  const actions = () => activity.record.mock.calls.map((c) => (c as unknown as [{ action: string; payload: Record<string, unknown> }])[0]);
  return { repo, jobs, progress, activity, ticker, actions };
}

describe('ScheduleTicker.tick', () => {
  it('dispatches a due schedule as its owner with the schedule id, then records lastJobId and an activity row', async () => {
    const h = build();
    expect(await h.ticker.tick(NOW)).toEqual({ claimed: 1, dispatched: 1, coalesced: 0, skipped: 0, disabled: 0, failed: 0 });
    expect(h.repo.claimFire).toHaveBeenCalledWith('s1', DUE, NEXT, NOW);
    expect(h.jobs.dispatch).toHaveBeenCalledWith(
      'u1', 'p1', { repoId: 'r1', command: 'RUN', feature: 'login', ref: 'main', profiles: ['fast'], maxCostUsd: 5, selectorLabels: [], bashMode: 'raw', approvalTimeoutSec: 600 }, { scheduleId: 's1' },
    );
    expect(h.repo.update).toHaveBeenCalledWith('s1', { lastJobId: 'job-1' });
    expect(h.actions().map((a) => a.action)).toEqual(['schedule.tick_dispatched']);
  });

  it('collapses missed fires: one claim straight to the next fire after now, one dispatch', async () => {
    const h = build([schedule({ nextFireAt: new Date('2026-09-29T03:00:00.000Z') })]);
    await h.ticker.tick(NOW);
    expect(h.repo.claimFire).toHaveBeenCalledTimes(1);
    expect(h.repo.claimFire).toHaveBeenCalledWith('s1', new Date('2026-09-29T03:00:00.000Z'), NEXT, NOW);
    expect(h.jobs.dispatch).toHaveBeenCalledTimes(1);
  });

  it('does nothing when another tick won the claim', async () => {
    const h = build();
    h.repo.claimFire.mockResolvedValue(false);
    expect(await h.ticker.tick(NOW)).toEqual({ claimed: 0, dispatched: 0, coalesced: 0, skipped: 0, disabled: 0, failed: 0 });
    expect(h.jobs.dispatch).not.toHaveBeenCalled();
    expect(h.activity.record).not.toHaveBeenCalled();
  });

  it('coalesces into the schedule\'s QUEUED job and creates no job', async () => {
    const h = build();
    h.repo.findActiveJob.mockResolvedValue({ id: 'j9', state: 'QUEUED' });
    h.repo.coalesceIntoQueued.mockResolvedValue('j9');
    expect((await h.ticker.tick(NOW)).coalesced).toBe(1);
    expect(h.jobs.dispatch).not.toHaveBeenCalled();
    expect(h.actions()).toEqual([expect.objectContaining({ action: 'schedule.tick_coalesced' })]);
  });

  it('decides again when the QUEUED job left QUEUED between the read and the increment (plan D200)', async () => {
    const h = build();
    h.repo.findActiveJob.mockResolvedValueOnce({ id: 'j9', state: 'QUEUED' }).mockResolvedValueOnce(null);
    h.repo.coalesceIntoQueued.mockResolvedValueOnce(null);
    expect((await h.ticker.tick(NOW)).dispatched).toBe(1);
  });

  it('gives up after three rounds of that and records a skip', async () => {
    const h = build();
    h.repo.findActiveJob.mockResolvedValue({ id: 'j9', state: 'QUEUED' });
    expect((await h.ticker.tick(NOW)).skipped).toBe(1);
    expect(h.repo.coalesceIntoQueued).toHaveBeenCalledTimes(3);
    expect(h.actions()[0].payload).toEqual(expect.objectContaining({ reason: 'busy' }));
  });

  it.each(['ASSIGNED', 'RUNNING', 'UPLOADING'] as const)('skips while the schedule has a %s job', async (state) => {
    const h = build();
    h.repo.findActiveJob.mockResolvedValue({ id: 'j7', state });
    expect((await h.ticker.tick(NOW)).skipped).toBe(1);
    expect(h.jobs.dispatch).not.toHaveBeenCalled();
    expect(h.actions()).toEqual([expect.objectContaining({ action: 'schedule.tick_skipped', payload: expect.objectContaining({ reason: 'job_active', state }) })]);
  });

  it.each<[string, OwnerAccess]>([
    ['a user that no longer exists', { exists: false, disabled: false, globalRole: '', projectRole: null }],
    ['a disabled user', { ...OWNER_OK, disabled: true }],
    ['a user removed from the project', { ...OWNER_OK, projectRole: null }],
    ['a user demoted to VIEWER', { ...OWNER_OK, projectRole: 'VIEWER' }],
    ['a legacy AGENT member', { ...OWNER_OK, projectRole: 'AGENT' }],
  ])('disables with owner_lost_access for %s', async (_name, access) => {
    const h = build();
    h.repo.findOwnerAccess.mockResolvedValue(access);
    expect((await h.ticker.tick(NOW)).disabled).toBe(1);
    expect(h.progress.disable).toHaveBeenCalledWith('s1', 'owner_lost_access');
    expect(h.jobs.dispatch).not.toHaveBeenCalled();
  });

  it.each<[string, OwnerAccess]>([
    ['a project DEVELOPER', OWNER_OK],
    ['a project ADMIN', { ...OWNER_OK, projectRole: 'ADMIN' }],
    ['a global ADMIN with no project role', { ...OWNER_OK, globalRole: 'ADMIN', projectRole: null }],
  ])('dispatches for %s', async (_name, access) => {
    expect(mayDispatch(access)).toBe(true);
  });

  const budgetPolicy = { id: 'b1', scopeType: 'global' as const, scopeId: null, scopeKey: 'global' };
  it.each<[string, () => Error, 'skipped' | 'disabled']>([
    ['409 budget paused', () => new BudgetPausedException(budgetPolicy), 'skipped'],
    ['409 active job of the feature (a manual job)', () => new ConflictAppException({ activeJobId: 'm1' }, 'fleet.jobs'), 'skipped'],
    ['404 repo', () => new NotFoundAppException({}, 'fleet.repos'), 'disabled'],
    ['404 pinned runner', () => new NotFoundAppException({}, 'fleet.runners'), 'disabled'],
    ['422 pinned runner can never run it', () => new FleetDispatchException('labels'), 'disabled'],
    ['400 validation', () => new ValidationAppException({ reason: 'ref' }, 'fleet.dispatchInput'), 'disabled'],
    ['any other error', () => new Error('db down'), 'skipped'],
  ])('dispatch outcome: %s', async (_name, error, outcome) => {
    const h = build();
    h.jobs.dispatch.mockRejectedValue(error());
    const result = await h.ticker.tick(NOW);
    expect(result[outcome]).toBe(1);
    if (outcome === 'disabled') expect(h.progress.disable).toHaveBeenCalledWith('s1', 'template_invalid');
    else expect(h.progress.disable).not.toHaveBeenCalled();
    expect(h.repo.update).not.toHaveBeenCalled();
  });

  it('a failure after the job was created (placement, live publish) still links the job and counts as dispatched (plan D199)', async () => {
    const h = build();
    h.repo.findActiveJob.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'job-2', state: 'QUEUED' });
    h.jobs.dispatch.mockRejectedValue(new Error('placement boom'));
    expect(await h.ticker.tick(NOW)).toEqual(expect.objectContaining({ dispatched: 1, skipped: 0 }));
    expect(h.repo.update).toHaveBeenCalledWith('s1', { lastJobId: 'job-2' });
    expect(h.actions()[0]).toEqual(expect.objectContaining({ action: 'schedule.tick_dispatched', payload: expect.objectContaining({ sideEffectFailed: true }) }));
  });

  it('records why a budget skip and a manual-job skip happened', async () => {
    const budget = build();
    budget.jobs.dispatch.mockRejectedValue(new BudgetPausedException(budgetPolicy));
    await budget.ticker.tick(NOW);
    expect(budget.actions()[0].payload).toEqual(expect.objectContaining({ reason: 'budget_paused' }));
    const manual = build();
    manual.jobs.dispatch.mockRejectedValue(new ConflictAppException({ activeJobId: 'm1' }, 'fleet.jobs'));
    await manual.ticker.tick(NOW);
    expect(manual.actions()[0].payload).toEqual(expect.objectContaining({ reason: 'active_job_elsewhere' }));
  });

  it('disables a schedule whose stored cron no longer parses instead of failing every minute (plan D208)', async () => {
    const h = build([schedule({ cron: 'not a cron' })]);
    expect((await h.ticker.tick(NOW)).disabled).toBe(1);
    expect(h.repo.claimFire).not.toHaveBeenCalled();
    expect(h.progress.disable).toHaveBeenCalledWith('s1', 'template_invalid');
  });

  it('keeps going after one schedule fails', async () => {
    const h = build([schedule({ id: 'a' }), schedule({ id: 'b' })]);
    h.repo.claimFire.mockRejectedValueOnce(new Error('boom'));
    expect(await h.ticker.tick(NOW)).toEqual(expect.objectContaining({ failed: 1, dispatched: 1 }));
    expect(h.jobs.dispatch).toHaveBeenCalledTimes(1);
  });
});

describe('ScheduleTicker timer', () => {
  it('does not re-enter: a tick still running makes the next round a no-op', async () => {
    const h = build();
    let finish: (rows: ScheduleRecord[]) => void = () => undefined;
    h.repo.findDue.mockImplementationOnce(() => new Promise<ScheduleRecord[]>((resolve) => { finish = resolve; }));
    const first = h.ticker.runOnce(NOW);
    expect(await h.ticker.runOnce(NOW)).toBeNull();
    finish([]);
    expect(await first).toEqual({ claimed: 0, dispatched: 0, coalesced: 0, skipped: 0, disabled: 0, failed: 0 });
    expect(await h.ticker.runOnce(NOW)).not.toBeNull();
  });

  it('starts no timer when the sweep is disabled', () => {
    const spy = jest.spyOn(global, 'setInterval');
    build().ticker.onModuleInit();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
