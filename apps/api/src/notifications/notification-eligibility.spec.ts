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

  it('propagates effectiveKeys errors unchanged', async () => {
    const { eligibility, permissions } = setup();
    const error = new Error('permission read failed');
    permissions.effectiveKeys.mockRejectedValue(error);
    await expect(eligibility.filter([draft('u1')])).rejects.toBe(error);
  });

  it('excludes actors before querying users and does not read keys for empty input', async () => {
    const { eligibility, user, permissions } = setup();
    await expect(eligibility.filter([draft('actor')])).resolves.toEqual([]);
    expect(user.findMany).not.toHaveBeenCalled();
    expect(permissions.effectiveKeys).not.toHaveBeenCalled();
  });
});
