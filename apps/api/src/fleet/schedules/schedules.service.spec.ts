import { ForbiddenAppException, NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import { FleetDispatchException } from '../jobs/fleet-dispatch.exception';
import type { ScheduleRecord } from './domain/schedule.domain';
import { SchedulesService } from './schedules.service';

const NOW = new Date('2026-10-02T03:00:30.000Z');
const schedule = (over: Partial<ScheduleRecord> = {}): ScheduleRecord => ({
  id: 's1', projectId: 'p1', repoId: 'r1', name: 'nightly', cron: '0 9 * * *', timezone: 'UTC', feature: 'login', ref: 'main', profiles: [],
  maxCostUsd: '5', selectorLabels: [], pinnedRunnerId: null, bashMode: 'raw', approvalTimeoutSec: 600, enabled: true,
  nextFireAt: new Date('2026-10-02T09:00:00.000Z'), lastFiredAt: null,
  lastJobId: null, lastPassedCount: 4, noProgressTicks: 2, noProgressLimit: 3, disabledReason: null, createdById: 'owner', updatedById: 'owner',
  createdAt: NOW, updatedAt: NOW, ...over,
});
const REPO = { id: 'r1', projectId: 'p1', provider: 'github' as const, owner: 'acme', name: 'app', defaultBranch: 'trunk', githubInstallationId: null };

function build(current: ScheduleRecord | null = schedule()) {
  const repo = {
    findByProject: jest.fn(async () => (current ? [current] : [])),
    findById: jest.fn(async () => current),
    lockById: jest.fn(async () => current),
    create: jest.fn(async (data: Record<string, unknown>) => ({ ...schedule(), ...data, id: 'new' }) as ScheduleRecord),
    update: jest.fn(async (_id: string, patch: Partial<ScheduleRecord>) => ({ ...(current as ScheduleRecord), ...patch })),
    delete: jest.fn(async () => undefined),
    sumCostBySchedule: jest.fn(async () => new Map<string, string>()),
    findOwnerAccess: jest.fn(async () => ({ exists: true, disabled: false, globalRole: 'MEMBER', projectRole: 'DEVELOPER' })),
  };
  const jobsRepo = { findRepo: jest.fn(async () => REPO as typeof REPO | null) };
  const placement = { evaluatePinned: jest.fn(async (): Promise<string | null> => null) };
  const activity = { record: jest.fn(async () => undefined) };
  const txManager = { run: jest.fn(async <T>(fn: () => Promise<T>) => fn()) };
  const svc = new SchedulesService(repo as never, jobsRepo as never, placement as never, activity as never, txManager as never);
  return { repo, jobsRepo, placement, activity, svc };
}
const input = (over: Record<string, unknown> = {}) => ({
  name: ' nightly ', repoId: 'r1', feature: 'login', cron: ' 0  9 * * * ', timezone: 'asia/singapore', maxCostUsd: 5, ...over,
}) as never;

describe('SchedulesService.create', () => {
  it('stores the normalised template: trimmed name, canonical zone, repo default branch as ref, next fire from now', async () => {
    const h = build();
    await h.svc.create('u9', 'p1', input(), NOW);
    expect(h.repo.create).toHaveBeenCalledWith({
      projectId: 'p1', repoId: 'r1', name: 'nightly', cron: '0 9 * * *', timezone: 'Asia/Singapore', feature: 'login', ref: 'trunk', profiles: [],
      maxCostUsd: '5', selectorLabels: [], pinnedRunnerId: null, bashMode: 'raw', approvalTimeoutSec: 600, noProgressLimit: 3,
      nextFireAt: new Date('2026-10-03T01:00:00.000Z'), createdById: 'u9',
    });
    expect(h.activity.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'schedule.created', entityType: 'schedule', actorType: 'USER', actorId: 'u9', projectId: 'p1' }));
  });

  it.each([
    ['a cron with four fields', { cron: '* * * *' }],
    ['a cron firing every ten minutes', { cron: '*/10 * * * *' }],
    ['an unknown timezone', { timezone: 'Mars/Base' }],
    ['a feature that is not a single path segment', { feature: '../etc' }],
    ['a reserved profile', { profiles: ['koda-job-x'] }],
  ])('refuses %s with a validation error and stores nothing', async (_name, over) => {
    const h = build();
    await expect(h.svc.create('u9', 'p1', input(over), NOW)).rejects.toBeInstanceOf(ValidationAppException);
    expect(h.repo.create).not.toHaveBeenCalled();
  });

  it('refuses a repo that is not in this project (404)', async () => {
    const h = build();
    h.jobsRepo.findRepo.mockResolvedValue({ ...REPO, projectId: 'other' });
    await expect(h.svc.create('u9', 'p1', input(), NOW)).rejects.toBeInstanceOf(NotFoundAppException);
    h.jobsRepo.findRepo.mockResolvedValue(null);
    await expect(h.svc.create('u9', 'p1', input(), NOW)).rejects.toBeInstanceOf(NotFoundAppException);
  });

  it('refuses an unknown pinned runner (404) and one that can never run the job (422)', async () => {
    const h = build();
    h.placement.evaluatePinned.mockResolvedValue('not_found');
    await expect(h.svc.create('u9', 'p1', input({ pinnedRunnerId: 'ghost' }), NOW)).rejects.toBeInstanceOf(NotFoundAppException);
    h.placement.evaluatePinned.mockResolvedValue('tools');
    await expect(h.svc.create('u9', 'p1', input({ pinnedRunnerId: 'run-1' }), NOW)).rejects.toBeInstanceOf(FleetDispatchException);
    h.placement.evaluatePinned.mockResolvedValue('capacity');
    await expect(h.svc.create('u9', 'p1', input({ pinnedRunnerId: 'run-1' }), NOW)).resolves.toBeDefined();
  });

  it('stores bashMode and approvalTimeoutSec, defaulting to raw and 600', async () => {
    const h = build();
    await h.svc.create('u9', 'p1', input(), NOW);
    expect(h.repo.create).toHaveBeenCalledWith(expect.objectContaining({ bashMode: 'raw', approvalTimeoutSec: 600 }));
    await h.svc.create('u9', 'p1', input({ name: 'b', bashMode: 'gated', approvalTimeoutSec: 120 }), NOW);
    expect(h.repo.create).toHaveBeenLastCalledWith(expect.objectContaining({ bashMode: 'gated', approvalTimeoutSec: 120 }));
  });
});

describe('SchedulesService.update', () => {
  it('lets the owner change the template; a cron change recomputes nextFireAt from now on an enabled schedule', async () => {
    const h = build();
    await h.svc.update('owner', 'p1', 's1', { cron: '0 6 * * *' } as never, false, NOW);
    expect(h.repo.update).toHaveBeenCalledWith('s1', expect.objectContaining({ cron: '0 6 * * *', nextFireAt: new Date('2026-10-02T06:00:00.000Z'), updatedById: 'owner' }));
  });

  it('does not move nextFireAt of a disabled schedule, or when only the name changes, and never enables it', async () => {
    const off = build(schedule({ enabled: false, disabledReason: 'manual' }));
    await off.svc.update('owner', 'p1', 's1', { cron: '0 6 * * *' } as never, false, NOW);
    expect(off.repo.update.mock.calls[0][1]).not.toHaveProperty('nextFireAt');
    expect(off.repo.update.mock.calls[0][1]).not.toHaveProperty('enabled');
    const renamed = build();
    await renamed.svc.update('owner', 'p1', 's1', { name: ' new ' } as never, false, NOW);
    expect(renamed.repo.update.mock.calls[0][1]).toEqual(expect.objectContaining({ name: 'new' }));
    expect(renamed.repo.update.mock.calls[0][1]).not.toHaveProperty('nextFireAt');
  });

  it('pinnedRunnerId null unpins; omitted keeps the pin', async () => {
    const pinned = build(schedule({ pinnedRunnerId: 'run-1' }));
    await pinned.svc.update('owner', 'p1', 's1', { pinnedRunnerId: null } as never, false, NOW);
    expect(pinned.repo.update.mock.calls[0][1]).toEqual(expect.objectContaining({ pinnedRunnerId: null }));
    const kept = build(schedule({ pinnedRunnerId: 'run-1' }));
    await kept.svc.update('owner', 'p1', 's1', { name: 'x' } as never, false, NOW);
    expect(kept.repo.update.mock.calls[0][1]).toEqual(expect.objectContaining({ pinnedRunnerId: 'run-1' }));
  });

  it('keeps the stored mode on an update that omits it', async () => {
    const stored = schedule({ bashMode: 'escalate', approvalTimeoutSec: 90 });
    const h = build(stored);
    await h.svc.update('owner', 'p1', 's1', { name: 'renamed' } as never, false, NOW);
    expect(h.repo.update).toHaveBeenCalledWith('s1', expect.objectContaining({ bashMode: 'escalate', approvalTimeoutSec: 90 }));
  });

  it('refuses another developer, allows a project admin, and 404s another project\'s schedule', async () => {
    const h = build();
    await expect(h.svc.update('someone-else', 'p1', 's1', { name: 'x' } as never, false, NOW)).rejects.toBeInstanceOf(ForbiddenAppException);
    await expect(h.svc.update('someone-else', 'p1', 's1', { name: 'x' } as never, true, NOW)).resolves.toBeDefined();
    await expect(h.svc.update('owner', 'other-project', 's1', { name: 'x' } as never, true, NOW)).rejects.toBeInstanceOf(NotFoundAppException);
    const gone = build(null);
    await expect(gone.svc.update('owner', 'p1', 's1', { name: 'x' } as never, true, NOW)).rejects.toBeInstanceOf(NotFoundAppException);
  });
});

describe('SchedulesService.enable and disable', () => {
  it('enable resets the stall counter and the reason, recomputes nextFireAt from now, and keeps lastPassedCount', async () => {
    const h = build(schedule({ enabled: false, disabledReason: 'no_progress', noProgressTicks: 3 }));
    const dto = await h.svc.enable('owner', 'p1', 's1', false, NOW);
    expect(h.repo.update).toHaveBeenCalledWith('s1', { enabled: true, disabledReason: null, noProgressTicks: 0, nextFireAt: new Date('2026-10-02T09:00:00.000Z'), updatedById: 'owner' });
    expect(dto.lastPassedCount).toBe(4);
    expect(h.activity.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'schedule.enabled' }));
  });

  it.each([
    ['a disabled owner', { exists: true, disabled: true, globalRole: 'MEMBER', projectRole: 'DEVELOPER' }],
    ['an owner removed from the project', { exists: true, disabled: false, globalRole: 'MEMBER', projectRole: null }],
    ['an owner demoted to VIEWER', { exists: true, disabled: false, globalRole: 'MEMBER', projectRole: 'VIEWER' }],
    ['an owner that no longer exists', { exists: false, disabled: false, globalRole: '', projectRole: null }],
  ])('enable is refused with a 409 conflict for %s, even when a project admin asks (plan D211)', async (_name, access) => {
    const h = build(schedule({ enabled: false, disabledReason: 'manual' }));
    h.repo.findOwnerAccess.mockResolvedValue(access);
    await expect(h.svc.enable('admin', 'p1', 's1', true, NOW)).rejects.toBeInstanceOf(ConflictAppException);
    expect(h.repo.update).not.toHaveBeenCalled();
    expect(h.activity.record).not.toHaveBeenCalled();
  });

  it('enable on an enabled schedule changes nothing', async () => {
    const h = build();
    h.repo.findOwnerAccess.mockResolvedValue({ exists: false, disabled: false, globalRole: '', projectRole: null });
    await h.svc.enable('owner', 'p1', 's1', false, NOW);
    expect(h.repo.findOwnerAccess).not.toHaveBeenCalled();
    expect(h.repo.update).not.toHaveBeenCalled();
    expect(h.activity.record).not.toHaveBeenCalled();
  });

  it('disable records a manual reason and a user activity row, and is idempotent', async () => {
    const h = build();
    const dto = await h.svc.disable('owner', 'p1', 's1', false);
    expect(h.repo.update).toHaveBeenCalledWith('s1', { enabled: false, disabledReason: 'manual', updatedById: 'owner' });
    expect(dto).toEqual(expect.objectContaining({ enabled: false, disabledReason: 'manual', nextFireAt: null }));
    expect(h.activity.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'schedule.disabled', actorType: 'USER' }));
    const off = build(schedule({ enabled: false, disabledReason: 'completed' }));
    await off.svc.disable('owner', 'p1', 's1', false);
    expect(off.repo.update).not.toHaveBeenCalled();
  });

  it('refuses a developer who is not the owner', async () => {
    const h = build();
    await expect(h.svc.disable('other', 'p1', 's1', false)).rejects.toBeInstanceOf(ForbiddenAppException);
    await expect(h.svc.enable('other', 'p1', 's1', false, NOW)).rejects.toBeInstanceOf(ForbiddenAppException);
  });
});

describe('SchedulesService.remove, list and get', () => {
  it('remove checks access without the schedule lock (plan D194), deletes, and records a row; a stranger is refused', async () => {
    const h = build();
    await h.svc.remove('owner', 'p1', 's1', false);
    expect(h.repo.lockById).not.toHaveBeenCalled();
    expect(h.repo.delete).toHaveBeenCalledWith('s1');
    expect(h.activity.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'schedule.deleted' }));
    await expect(h.svc.remove('other', 'p1', 's1', false)).rejects.toBeInstanceOf(ForbiddenAppException);
  });

  it('list and get carry the schedule\'s total cost; nextFireAt is null while disabled', async () => {
    const h = build(schedule({ enabled: false, disabledReason: 'manual' }));
    h.repo.sumCostBySchedule.mockResolvedValue(new Map([['s1', '3.7500']]));
    expect(await h.svc.list('p1')).toEqual([expect.objectContaining({ id: 's1', totalCostUsd: '3.7500', nextFireAt: null })]);
    expect(await h.svc.get('p1', 's1')).toEqual(expect.objectContaining({ totalCostUsd: '3.7500' }));
    await expect(h.svc.get('other-project', 's1')).rejects.toBeInstanceOf(NotFoundAppException);
  });

  it('a schedule with no jobs reports 0.0000', async () => {
    expect((await build().svc.get('p1', 's1')).totalCostUsd).toBe('0.0000');
  });
});
