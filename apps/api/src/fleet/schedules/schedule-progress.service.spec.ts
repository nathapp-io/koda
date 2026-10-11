import type { FleetJobRecord } from '../jobs/domain/fleet-job.domain';
import type { ScheduleRecord } from './domain/schedule.domain';
import { ScheduleProgressService } from './schedule-progress.service';

const NOW = new Date('2026-10-02T03:00:30.000Z');
const schedule = (over: Partial<ScheduleRecord> = {}): ScheduleRecord => ({
  id: 's1', projectId: 'p1', repoId: 'r1', name: 'nightly', cron: '0 * * * *', timezone: 'UTC', feature: 'f', ref: 'main', profiles: [],
  maxCostUsd: '5', selectorLabels: [], pinnedRunnerId: null, bashMode: 'raw', approvalTimeoutSec: 600, enabled: true, nextFireAt: NOW, lastFiredAt: null, lastJobId: 'j1',
  lastPassedCount: 0, noProgressTicks: 0, noProgressLimit: 3, disabledReason: null, createdById: 'u1', updatedById: 'u1',
  createdAt: NOW, updatedAt: NOW, ...over,
});
const job = (over: Partial<FleetJobRecord> = {}): FleetJobRecord =>
  ({ id: 'j1', projectId: 'p1', state: 'FAILED', scheduleId: 's1', scheduleCountedAt: null, progress: null, ...over }) as FleetJobRecord;

function harness(current: ScheduleRecord | null = schedule(), claimed = true) {
  const repo = {
    claimCounted: vi.fn(async () => claimed),
    lockById: vi.fn(async () => current),
    update: vi.fn(async (_id: string, patch: Partial<ScheduleRecord>) => ({ ...(current as ScheduleRecord), ...patch })),
  };
  const activity = { record: vi.fn(async () => undefined) };
  const webhooks = { dispatch: vi.fn(async () => undefined) };
  return { repo, activity, webhooks, svc: new ScheduleProgressService(repo as never, activity as never, webhooks as never) };
}

describe('ScheduleProgressService.onJobEnded', () => {
  it.each([
    ['a job with no schedule', job({ scheduleId: null })],
    ['a job already counted', job({ scheduleCountedAt: NOW })],
    ['a CANCELLED job (plan D195: not marked counted either)', job({ state: 'CANCELLED' })],
  ])('does nothing for %s', async (_name, ended) => {
    const h = harness();
    await h.svc.onJobEnded(ended, NOW);
    expect(h.repo.claimCounted).not.toHaveBeenCalled();
    expect(h.repo.update).not.toHaveBeenCalled();
  });

  it('does nothing when another path already claimed the count (plan D196)', async () => {
    const h = harness(schedule(), false);
    await h.svc.onJobEnded(job(), NOW);
    expect(h.repo.lockById).not.toHaveBeenCalled();
    expect(h.repo.update).not.toHaveBeenCalled();
  });

  it('COMPLETED disables with completed: activity row and webhook in the same call', async () => {
    const h = harness();
    await h.svc.onJobEnded(job({ state: 'COMPLETED', progress: { passed: 3, total: 3 } }), NOW);
    expect(h.repo.update).toHaveBeenCalledWith('s1', { enabled: false, disabledReason: 'completed' });
    expect(h.activity.record).toHaveBeenCalledWith(expect.objectContaining({
      actorType: 'SYSTEM', actorId: 'system', action: 'schedule.auto_disabled', entityType: 'schedule', entityId: 's1',
      jobId: 'j1', projectId: 'p1', responsibleUserId: 'u1', payload: expect.objectContaining({ reason: 'completed', feature: 'f' }),
    }));
    expect(h.webhooks.dispatch).toHaveBeenCalledWith('p1', 'fleet.schedule.disabled', expect.objectContaining({ scheduleId: 's1', reason: 'completed' }));
  });

  it('FAILED with every story passed disables with finish_failed', async () => {
    const h = harness();
    await h.svc.onJobEnded(job({ progress: { passed: 4, total: 4 } }), NOW);
    expect(h.repo.update).toHaveBeenCalledWith('s1', { enabled: false, disabledReason: 'finish_failed' });
  });

  it('progress resets the counter and raises lastPassedCount; nothing is disabled', async () => {
    const h = harness(schedule({ noProgressTicks: 2, lastPassedCount: 1 }));
    await h.svc.onJobEnded(job({ progress: { passed: 2, total: 5 } }), NOW);
    expect(h.repo.update).toHaveBeenCalledWith('s1', { noProgressTicks: 0, lastPassedCount: 2 });
    expect(h.webhooks.dispatch).not.toHaveBeenCalled();
  });

  it('no progress below the limit only counts', async () => {
    const h = harness(schedule({ noProgressTicks: 1 }));
    await h.svc.onJobEnded(job({ progress: null }), NOW);
    expect(h.repo.update).toHaveBeenCalledWith('s1', { noProgressTicks: 2 });
    expect(h.activity.record).not.toHaveBeenCalled();
  });

  it('the no-progress tick that reaches the limit disables with no_progress in one update', async () => {
    const h = harness(schedule({ noProgressTicks: 2, noProgressLimit: 3 }));
    await h.svc.onJobEnded(job({ progress: 'garbage' }), NOW);
    expect(h.repo.update).toHaveBeenCalledTimes(1);
    expect(h.repo.update).toHaveBeenCalledWith('s1', { noProgressTicks: 3, enabled: false, disabledReason: 'no_progress' });
    expect(h.webhooks.dispatch).toHaveBeenCalledWith('p1', 'fleet.schedule.disabled', expect.objectContaining({ reason: 'no_progress' }));
  });

  it('a disabled schedule keeps its reason: only progress is applied (plan D197)', async () => {
    const off = schedule({ enabled: false, disabledReason: 'manual', noProgressTicks: 1 });
    const completed = harness(off);
    await completed.svc.onJobEnded(job({ state: 'COMPLETED' }), NOW);
    expect(completed.repo.update).not.toHaveBeenCalled();
    expect(completed.webhooks.dispatch).not.toHaveBeenCalled();
    const stalled = harness(off);
    await stalled.svc.onJobEnded(job({ progress: null }), NOW);
    expect(stalled.repo.update).not.toHaveBeenCalled();
    const moved = harness(off);
    await moved.svc.onJobEnded(job({ progress: { passed: 2, total: 5 } }), NOW);
    expect(moved.repo.update).toHaveBeenCalledWith('s1', { noProgressTicks: 0, lastPassedCount: 2 });
  });

  it('a schedule that no longer exists is not an error', async () => {
    const h = harness(null);
    await expect(h.svc.onJobEnded(job(), NOW)).resolves.toBeUndefined();
  });
});

describe('ScheduleProgressService.disable', () => {
  it('disables an enabled schedule once and reports true', async () => {
    const h = harness();
    expect(await h.svc.disable('s1', 'owner_lost_access')).toBe(true);
    expect(h.repo.update).toHaveBeenCalledWith('s1', { enabled: false, disabledReason: 'owner_lost_access' });
    expect(h.webhooks.dispatch).toHaveBeenCalledTimes(1);
  });

  it('reports false and writes nothing for a schedule that is gone or already disabled', async () => {
    const gone = harness(null);
    expect(await gone.svc.disable('s1', 'template_invalid')).toBe(false);
    const off = harness(schedule({ enabled: false, disabledReason: 'manual' }));
    expect(await off.svc.disable('s1', 'template_invalid')).toBe(false);
    expect(off.repo.update).not.toHaveBeenCalled();
    expect(off.webhooks.dispatch).not.toHaveBeenCalled();
  });
});
