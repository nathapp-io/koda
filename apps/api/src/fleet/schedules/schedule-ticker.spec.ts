import { NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { currentActor, currentContext, type ActionContext } from '../../action-context/action-context';
import { currentBookkeepingReason } from '../../action-context/audit-coverage';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import { BudgetPausedException } from '../budgets/budget.exceptions';
import { FleetDispatchException } from '../jobs/fleet-dispatch.exception';
import type { OwnerAccess, ScheduleActiveJob, ScheduleRecord } from './domain/schedule.domain';
import { mayDispatch } from './schedule-access';
import { ScheduleTicker } from './schedule-ticker';

const NOW = new Date('2026-10-02T03:00:30.000Z');
const DUE = new Date('2026-10-02T03:00:00.000Z');
const NEXT = new Date('2026-10-02T04:00:00.000Z');
/** US-005: the owner exists and is not disabled; the permission itself is its key set. */
const OWNER_OK: OwnerAccess = { exists: true, disabled: false };
const DISPATCH_KEYS: ReadonlySet<string> = new Set(['fleet.job.dispatch', 'fleet.job.read']);
/** A viewer binding: reads, no dispatch. */
const VIEWER_KEYS: ReadonlySet<string> = new Set(['fleet.schedule.read', 'fleet.job.read']);

const schedule = (over: Partial<ScheduleRecord> = {}): ScheduleRecord => ({
  id: 's1', projectId: 'p1', repoId: 'r1', name: 'nightly', cron: '0 * * * *', timezone: 'UTC', feature: 'login', ref: 'main', profiles: ['fast'],
  maxCostUsd: '5', selectorLabels: [], pinnedRunnerId: null, bashMode: 'raw', approvalTimeoutSec: 600, enabled: true, nextFireAt: DUE, lastFiredAt: null, lastJobId: null,
  lastPassedCount: 0, noProgressTicks: 0, noProgressLimit: 3, disabledReason: null, createdById: 'u1', updatedById: 'u1',
  createdAt: NOW, updatedAt: NOW, ...over,
});

function build(due: ScheduleRecord[] = [schedule()], opts: { sweepEnabled?: boolean } = {}) {
  /** US-004: the context each background entry point ran in, recorded where it was observed. */
  let findDueContext: ActionContext | undefined;
  let dispatchContext: ActionContext | undefined;
  const repo = {
    findDue: vi.fn(async () => {
      findDueContext = currentContext();
      return due;
    }),
    claimFire: vi.fn(async () => true),
    findActiveJob: vi.fn(async (): Promise<ScheduleActiveJob | null> => null),
    coalesceIntoQueued: vi.fn(async (): Promise<string | null> => null),
    findOwnerAccess: vi.fn(async (): Promise<OwnerAccess> => OWNER_OK),
    update: vi.fn(async () => schedule()),
  };
  /** Records the action context `dispatch` was called in: US-004 fires as the schedule's component, on the owner's behalf. */
  const jobs = {
    dispatch: vi.fn(async () => {
      dispatchContext = currentContext();
      return { job: { id: 'job-1' } };
    }),
  };
  const progress = { disable: vi.fn(async () => true) };
  const activity = { record: vi.fn(async () => undefined) };
  const audit = { record: vi.fn(async () => undefined) };
  const txManager = { run: vi.fn(async <T>(fn: () => Promise<T>) => fn()) };
  // US-005: the owner's dispatch permission is its effective keys, read through the real service.
  const permissions = { effectiveKeys: vi.fn(async () => DISPATCH_KEYS) };
  const ticker = new ScheduleTicker(
    repo as never, jobs as never, progress as never, activity as never, txManager as never,
    { sweepEnabled: opts.sweepEnabled ?? false }, permissions as never, audit as never,
  );
  const actions = () => activity.record.mock.calls.map((c) => (c as unknown as [{ action: string; payload: Record<string, unknown>; actorType: string }])[0]);
  return {
    repo, jobs, progress, activity, audit, permissions, ticker, actions,
    contextSeenByDispatch: () => dispatchContext,
    contextSeenByFindDue: () => findDueContext,
  };
}

describe('ScheduleTicker.tick', () => {
  it('dispatches a due schedule as its owner with the schedule id, then records lastJobId and an activity row', async () => {
    const h = build();
    expect(await h.ticker.tick(NOW)).toEqual({ claimed: 1, dispatched: 1, coalesced: 0, skipped: 0, disabled: 0, failed: 0 });
    expect(h.repo.claimFire).toHaveBeenCalledWith('s1', DUE, NEXT, NOW);
    expect(h.jobs.dispatch).toHaveBeenCalledWith(
      'u1', 'p1', { repoId: 'r1', command: 'RUN', feature: 'login', ref: 'main', profiles: ['fast'], maxCostUsd: 5, selectorLabels: [], bashMode: 'raw', approvalTimeoutSec: 600 }, { scheduleId: 's1', auditKey: 'system.schedule.dispatch' },
    );
    expect(h.repo.update).toHaveBeenCalledWith('s1', { lastJobId: 'job-1' });
    expect(h.actions().map((a) => a.action)).toEqual(['schedule.tick_dispatched']);
    expect(h.audit.record).not.toHaveBeenCalled(); // FleetJobsService owns the dispatch entry.
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

  it('reads the owner ref off the record, defaulting an untagged creator to a user (US-005)', async () => {
    const tagged = build([schedule({ createdById: 'a1', createdByType: 'AGENT' })]);
    await tagged.ticker.tick(NOW);
    expect(tagged.repo.findOwnerAccess).toHaveBeenCalledWith('p1', { type: 'AGENT', id: 'a1' });
    expect(tagged.permissions.effectiveKeys).toHaveBeenCalledWith({ type: 'AGENT', id: 'a1' }, { projectId: 'p1' });

    const untagged = build([schedule({ createdById: 'u1', createdByType: undefined })]);
    await untagged.ticker.tick(NOW);
    expect(untagged.repo.findOwnerAccess).toHaveBeenCalledWith('p1', { type: 'USER', id: 'u1' });
    expect(untagged.permissions.effectiveKeys).toHaveBeenCalledWith({ type: 'USER', id: 'u1' }, { projectId: 'p1' });
  });

  it('dispatches inside the schedule component\'s action context, on the owner\'s behalf, and keeps its own rows a system actor (US-004)', async () => {
    const h = build([schedule({ createdById: 'a1', createdByType: 'AGENT' })]);

    expect((await h.ticker.tick(NOW)).dispatched).toBe(1);

    // The fire runs as the scheduler, so `actorTypeFor` inside dispatch still names the agent's type.
    expect(h.contextSeenByDispatch()?.actor).toEqual({ type: 'SYSTEM', id: 'schedule' });
    expect(h.contextSeenByDispatch()?.onBehalfOf).toEqual({ type: 'AGENT', id: 'a1' });
    expect(h.jobs.dispatch).toHaveBeenCalledWith('a1', 'p1', expect.objectContaining({ feature: 'login' }), { scheduleId: 's1', auditKey: 'system.schedule.dispatch' });
    // The ticker's own row is never relabelled: it is a SYSTEM entry, not the current actor's.
    expect(h.actions()).toEqual([expect.objectContaining({ action: 'schedule.tick_dispatched', actorType: 'SYSTEM' })]);
  });

  it('leaves no actor in context after the tick (tick is not the wrapped entry; the fire is the only extent)', async () => {
    const h = build();
    await h.ticker.tick(NOW);
    expect(currentActor()).toBeUndefined();
  });

  it('AC-14: does not dispatch when the owner lost dispatch access, even though the fire was claimed', async () => {
    const h = build();
    h.permissions.effectiveKeys.mockResolvedValue(VIEWER_KEYS);

    expect((await h.ticker.tick(NOW)).disabled).toBe(1);

    expect(h.repo.claimFire).toHaveBeenCalledTimes(1);
    expect(h.jobs.dispatch).not.toHaveBeenCalled();
    expect(h.progress.disable).toHaveBeenCalledWith('s1', 'owner_lost_access');
  });

  it.each<[string, OwnerAccess, ReadonlySet<string>]>([
    ['a user that no longer exists', { exists: false, disabled: false }, DISPATCH_KEYS],
    ['a disabled user', { exists: true, disabled: true }, DISPATCH_KEYS],
    ['an owner that lost fleet.job.dispatch (a viewer binding)', OWNER_OK, VIEWER_KEYS],
    ['an owner with no keys at all', OWNER_OK, new Set()],
  ])('disables with owner_lost_access for %s', async (_name, access, keys) => {
    const h = build();
    h.repo.findOwnerAccess.mockResolvedValue(access);
    h.permissions.effectiveKeys.mockResolvedValue(keys);
    expect((await h.ticker.tick(NOW)).disabled).toBe(1);
    expect(h.progress.disable).toHaveBeenCalledWith('s1', 'owner_lost_access');
    expect(h.jobs.dispatch).not.toHaveBeenCalled();
  });

  it('keeps an agent owner\'s schedule alive: an agent owner is never disabled by its status (US-005 AC-10)', async () => {
    const h = build([schedule({ createdById: 'a1', createdByType: 'AGENT' })]);
    h.repo.findOwnerAccess.mockResolvedValue({ exists: true, disabled: false });

    expect((await h.ticker.tick(NOW)).dispatched).toBe(1);
    expect(h.progress.disable).not.toHaveBeenCalled();
  });

  it.each<[string, OwnerAccess, ReadonlySet<string>]>([
    ['a project developer', OWNER_OK, DISPATCH_KEYS],
    ['an agent owner with the dispatch key', OWNER_OK, new Set(['fleet.job.dispatch'])],
  ])('dispatches for %s', async (_name, access, keys) => {
    expect(mayDispatch(access, keys)).toBe(true);
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
    const spy = vi.spyOn(global, 'setInterval');
    build().ticker.onModuleInit();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

/**
 * Permissions P2 US-004: the interval callback — the background entry — opens the `schedule` component's
 * context, while `tick` itself stays request-reachable and unwrapped.
 */
describe('ScheduleTicker background context (US-004)', () => {
  afterEach(() => vi.useRealTimers());

  it('AC-1: the interval callback scans the due schedules as SYSTEM/schedule', async () => {
    vi.useFakeTimers();
    const h = build([schedule()], { sweepEnabled: true });
    h.ticker.onModuleInit();

    await vi.advanceTimersByTimeAsync(60_000);
    h.ticker.onModuleDestroy();

    expect(h.repo.findDue).toHaveBeenCalledTimes(1);
    expect(h.contextSeenByFindDue()?.actor).toEqual({ type: 'SYSTEM', id: 'schedule' });
  });

  it('AC-2: tick dispatches a due schedule whose fire it claimed as SYSTEM/schedule', async () => {
    const h = build([schedule({ createdById: 'a1', createdByType: 'AGENT' })]);

    expect((await h.ticker.tick(NOW)).dispatched).toBe(1);

    expect(h.repo.claimFire).toHaveBeenCalledTimes(1);
    expect(h.repo.findActiveJob).toHaveBeenCalledTimes(1);
    expect(h.contextSeenByDispatch()?.actor).toEqual({ type: 'SYSTEM', id: 'schedule' });
  });

  it('AC-3: that dispatch runs on behalf of the agent owner a1', async () => {
    const h = build([schedule({ createdById: 'a1', createdByType: 'AGENT' })]);

    await h.ticker.tick(NOW);

    expect(h.contextSeenByDispatch()?.onBehalfOf).toEqual({ type: 'AGENT', id: 'a1' });
  });

  it('AC-15: no context survives the tick, so a caller inside no context sees no actor', async () => {
    const h = build([schedule()], { sweepEnabled: true });
    h.ticker.onModuleInit();
    await h.ticker.runOnce(NOW);
    h.ticker.onModuleDestroy();

    expect(currentActor()).toBeUndefined();
    expect(currentContext()).toBeUndefined();
  });
});

/**
 * Permissions P2 US-007: a schedule's fire claim, its skip and coalesce activity rows and the last-job link are the
 * scheduler's own bookkeeping. The dispatch they lead to is a job creation, so it stays counted.
 */
describe('ScheduleTicker audit coverage (permissions P2 US-007)', () => {
  type Reason = ReturnType<typeof currentBookkeepingReason>;

  /** Records the bookkeeping reason current at each call of a stub, then answers exactly as the stub did. */
  function watching<T>(fn: T, seen: Reason[]): T {
    const mock = fn as unknown as {
      getMockImplementation(): ((...args: never[]) => unknown) | undefined;
      mockImplementation(impl: (...args: never[]) => unknown): void;
    };
    const impl = mock.getMockImplementation();
    mock.mockImplementation((...args: never[]) => {
      seen.push(currentBookkeepingReason());
      return impl?.(...args);
    });
    return fn;
  }

  it('AC-7: tick claims the fire of a due schedule while currentBookkeepingReason() answers fleet.schedule-bookkeeping', async () => {
    const h = build();
    const seen: Reason[] = [];
    watching(h.repo.claimFire, seen);

    await h.ticker.tick(NOW);

    expect(h.repo.claimFire).toHaveBeenCalledWith('s1', DUE, NEXT, NOW);
    expect(seen).toEqual(['fleet.schedule-bookkeeping']);
  });

  it('AC-8: the skip of a schedule whose job still runs records its activity row under fleet.schedule-bookkeeping', async () => {
    const h = build();
    h.repo.findActiveJob.mockResolvedValue({ id: 'j7', state: 'RUNNING' });
    const seen: Reason[] = [];
    watching(h.activity.record, seen);

    expect((await h.ticker.tick(NOW)).skipped).toBe(1);

    expect(h.activity.record).toHaveBeenCalledTimes(1);
    expect(h.actions()).toEqual([expect.objectContaining({ action: 'schedule.tick_skipped', payload: expect.objectContaining({ reason: 'job_active' }) })]);
    expect(seen).toEqual(['fleet.schedule-bookkeeping']);
  });

  it('AC-8: the coalesce activity row is bookkeeping too, and the coalesce of the queued job stays inside it', async () => {
    const h = build();
    h.repo.findActiveJob.mockResolvedValue({ id: 'j9', state: 'QUEUED' });
    h.repo.coalesceIntoQueued.mockResolvedValue('j9');
    const seen: Reason[] = [];
    watching(h.activity.record, seen);

    expect((await h.ticker.tick(NOW)).coalesced).toBe(1);

    expect(h.actions()).toEqual([expect.objectContaining({ action: 'schedule.tick_coalesced' })]);
    expect(seen).toEqual(['fleet.schedule-bookkeeping']);
  });

  it.each<[string, () => Error, string]>([
    ['a budget pause', () => new BudgetPausedException({ id: 'b1', scopeType: 'global', scopeId: null, scopeKey: 'global' }), 'budget_paused'],
    ['a manual job of the feature', () => new ConflictAppException({ activeJobId: 'm1' }, 'fleet.jobs'), 'active_job_elsewhere'],
    ['any other error', () => new Error('db down'), 'error'],
  ])('AC-8: the skip row of %s is recorded under fleet.schedule-bookkeeping', async (_name, error, reason) => {
    const h = build();
    h.jobs.dispatch.mockRejectedValue(error());
    const seen: Reason[] = [];
    watching(h.activity.record, seen);

    await h.ticker.tick(NOW);

    expect(h.actions()).toEqual([
      expect.objectContaining({ action: 'schedule.tick_skipped', payload: expect.objectContaining({ reason }) }),
    ]);
    expect(seen).toEqual(['fleet.schedule-bookkeeping']);
  });

  it('AC-9: the dispatch of a due schedule runs while currentBookkeepingReason() answers undefined', async () => {
    const h = build();
    const seen: Reason[] = [];
    watching(h.jobs.dispatch, seen);

    expect((await h.ticker.tick(NOW)).dispatched).toBe(1);

    expect(h.jobs.dispatch).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([undefined]);
  });

  it('AC-10: that dispatching tick then links the last job id under fleet.schedule-bookkeeping', async () => {
    const h = build();
    const seen: Reason[] = [];
    watching(h.repo.update, seen);

    expect((await h.ticker.tick(NOW)).dispatched).toBe(1);

    expect(h.repo.update).toHaveBeenCalledWith('s1', { lastJobId: 'job-1' });
    expect(seen).toEqual(['fleet.schedule-bookkeeping']);
  });

  it('leaves no reason current once the tick has resolved', async () => {
    const h = build();

    await h.ticker.tick(NOW);

    expect(currentBookkeepingReason()).toBeUndefined();
  });
});
