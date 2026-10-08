import { NotificationEligibility } from './notification-eligibility';
import type { NotificationDraft } from './notification.types';

const draft = (userId: string, over: Partial<NotificationDraft> = {}): NotificationDraft => ({
  userId, projectId: 'p1', category: 'WATCHED_ACTIVITY', kind: 'ticket_commented', title: 't', body: null, link: '/l',
  params: {}, sourceType: 'ticket_event', sourceId: 'e1', actorId: 'actor', ...over,
});

function setup() {
  const user = {
    findMany: jest.fn().mockImplementation(async ({ where }: { where: { id?: { in: string[] }; role?: string } }) => {
      if (where.role === 'ADMIN') return [{ id: 'admin' }];
      return [
        { id: 'member', role: 'MEMBER' },
        { id: 'admin', role: 'ADMIN' },
        { id: 'outsider', role: 'MEMBER' },
        { id: 'actor', role: 'MEMBER' },
      ].filter((u) => where.id?.in.includes(u.id));
    }),
  };
  const projectMember = { findMany: jest.fn().mockResolvedValue([{ projectId: 'p1', userId: 'member' }, { projectId: 'p1', userId: 'actor' }]) };
  const eligibility = new NotificationEligibility({ client: { user, projectMember } } as never);
  return { eligibility, user, projectMember };
}

describe('NotificationEligibility (S4a §2.1 step 1)', () => {
  it('drops the actor, disabled or unknown users, and non-member non-admins of the project', async () => {
    const { eligibility, user } = setup();
    const kept = await eligibility.filter([draft('member'), draft('admin'), draft('outsider'), draft('actor'), draft('disabled-or-gone')]);
    expect(kept.map((d) => d.userId)).toEqual(['member', 'admin']);
    expect(user.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['member', 'admin', 'outsider', 'disabled-or-gone'] }, disabled: false },
      select: { id: true, role: true },
    });
  });

  it('keeps global drafts (projectId null) for any active user without a membership query', async () => {
    const { eligibility, projectMember } = setup();
    const kept = await eligibility.filter([draft('outsider', { projectId: null, actorId: null })]);
    expect(kept.map((d) => d.userId)).toEqual(['outsider']);
    expect(projectMember.findMany).not.toHaveBeenCalled();
  });

  it('returns nothing for nothing', async () => {
    const { eligibility, user } = setup();
    await expect(eligibility.filter([])).resolves.toEqual([]);
    expect(user.findMany).not.toHaveBeenCalled();
  });

  it('finds active global admins', async () => {
    const { eligibility, user } = setup();
    await expect(eligibility.findGlobalAdminIds()).resolves.toEqual(['admin']);
    expect(user.findMany).toHaveBeenCalledWith({ where: { role: 'ADMIN', disabled: false }, select: { id: true }, orderBy: { createdAt: 'asc' } });
  });
});
