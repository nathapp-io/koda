import { NotificationEligibility } from './notification-eligibility';
import type { NotificationDraft } from './notification.types';

const draft = (userId: string, over: Partial<NotificationDraft> = {}): NotificationDraft => ({
  userId, projectId: 'p1', category: 'WATCHED_ACTIVITY', kind: 'ticket_commented', title: 't', body: null, link: '/l',
  params: {}, sourceType: 'ticket_event', sourceId: 'e1', actorId: 'actor', ...over,
});

function setup(users: readonly string[] = ['u1', 'u2']) {
  const user = { findMany: vi.fn(async () => users.map((id) => ({ id, role: 'MEMBER' }))) };
  const prisma = { client: { user } };
  const permissions = { effectiveKeys: vi.fn(async (_ref: unknown, _scope: unknown) => new Set(['project.read'])) };
  const eligibility = new NotificationEligibility(prisma as never, permissions as never);
  return { eligibility, user, permissions };
}

describe('NotificationEligibility', () => {
  it('filters project drafts by project.read while retaining no-project drafts', async () => {
    const { eligibility, permissions } = setup();
    permissions.effectiveKeys.mockResolvedValue(new Set());
    const noProject = draft('u1', { projectId: null });
    await expect(eligibility.filter([draft('u1'), noProject])).resolves.toEqual([noProject]);
  });

  it('asks once per distinct user and project', async () => {
    const { eligibility, permissions } = setup();
    await eligibility.filter([draft('u1'), draft('u1'), draft('u2')]);
    expect(permissions.effectiveKeys).toHaveBeenCalledTimes(2);
    expect(permissions.effectiveKeys).toHaveBeenCalledWith({ type: 'USER', id: 'u1' }, { projectId: 'p1' });
    expect(permissions.effectiveKeys).toHaveBeenCalledWith({ type: 'USER', id: 'u2' }, { projectId: 'p1' });
  });

  it('bounds concurrent permission reads to 10 for a large batch without losing order or deduplication', async () => {
    const ids = Array.from({ length: 500 }, (_, index) => `u${index}`);
    const { eligibility, permissions } = setup(ids);
    let active = 0;
    let peak = 0;
    permissions.effectiveKeys.mockImplementation(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
      return new Set(['project.read']);
    });
    const drafts = ids.flatMap((id) => [draft(id), draft(id, { projectId: 'p2' })]);
    const input = [...drafts, draft('u0')];

    await expect(eligibility.filter(input)).resolves.toEqual(input);
    expect(permissions.effectiveKeys).toHaveBeenCalledTimes(1000);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(10);
    expect(active).toBe(0);
  });

  it('propagates effectiveKeys errors unchanged', async () => {
    const { eligibility, permissions } = setup();
    const error = new Error('permission read failed');
    permissions.effectiveKeys.mockRejectedValue(error);
    await expect(eligibility.filter([draft('u1')])).rejects.toBe(error);
  });

  it('rejects a later chunk unchanged without returning partial drafts or starting remaining chunks', async () => {
    const ids = Array.from({ length: 30 }, (_, index) => `u${index}`);
    const { eligibility, permissions } = setup(ids);
    const error = new Error('later permission read failed');
    permissions.effectiveKeys.mockImplementation(async (ref) => {
      if ((ref as { id: string }).id === 'u10') throw error;
      return new Set(['project.read']);
    });

    await expect(eligibility.filter(ids.map((id) => draft(id)))).rejects.toBe(error);
    expect(permissions.effectiveKeys).toHaveBeenCalledTimes(20);
  });

  it('excludes actors before querying users and does not read keys for empty input', async () => {
    const { eligibility, user, permissions } = setup();
    await expect(eligibility.filter([draft('actor')])).resolves.toEqual([]);
    expect(user.findMany).not.toHaveBeenCalled();
    expect(permissions.effectiveKeys).not.toHaveBeenCalled();
  });
});
