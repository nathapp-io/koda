import { NotificationEligibility } from './notification-eligibility';
import type { NotificationDraft } from './notification.types';

const draft = (userId: string, over: Partial<NotificationDraft> = {}): NotificationDraft => ({
  userId, projectId: 'p1', category: 'WATCHED_ACTIVITY', kind: 'ticket_commented', title: 't', body: null, link: '/l',
  params: {}, sourceType: 'ticket_event', sourceId: 'e1', actorId: 'actor', ...over,
});

/** The key of the `projectId`-null bindings in the fake below (`null` is not a usable object key). */
const GLOBAL_BINDINGS = 'projectId-null';

/**
 * The fake Prisma client the binding-only queries read:
 * `bindings` — the PROJECT-scope bindings per project id, plus `GLOBAL_BINDINGS` for the ones with no
 * project, which apply in every project.
 */
interface Sources {
  bindings?: Readonly<Record<string, readonly string[]>>;
}

function setup(sources: Sources = {}) {
  const user = {
    findMany: vi.fn().mockImplementation(async ({ where }: { where: { id?: { in: string[] }; role?: string } }) => {
      if (where.role === 'ADMIN') return [{ id: 'admin' }];
      return [
        { id: 'member', role: 'MEMBER' },
        { id: 'admin', role: 'ADMIN' },
        { id: 'outsider', role: 'MEMBER' },
        { id: 'actor', role: 'MEMBER' },
      ].filter((u) => where.id?.in.includes(u.id));
    }),
  };
  const roleBinding = {
    findMany: vi.fn(async ({ where }: { where: { projectId: string | null } }) =>
      (sources.bindings?.[where.projectId ?? GLOBAL_BINDINGS] ?? []).map((principalId) => ({ principalId }))),
  };
  const project = { count: vi.fn(async () => 1) };
  const eligibility = new NotificationEligibility({ client: { user, roleBinding, project } } as never);
  return { eligibility, user, roleBinding, project };
}

describe('NotificationEligibility (S4a §2.1 step 1)', () => {
  it('drops the actor, disabled or unknown users, and non-member non-admins of the project', async () => {
    const { eligibility, user } = setup({ bindings: { p1: ['member'] } });
    const kept = await eligibility.filter([draft('member'), draft('admin'), draft('outsider'), draft('actor'), draft('disabled-or-gone')]);
    expect(kept.map((d) => d.userId)).toEqual(['member', 'admin']);
    expect(user.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['member', 'admin', 'outsider', 'disabled-or-gone'] }, disabled: false },
      select: { id: true, role: true },
    });
  });

  it('keeps a user whose only source in the project is a project binding', async () => {
    const { eligibility, roleBinding } = setup({ bindings: { p1: ['member'] } });
    await expect(eligibility.filter([draft('member')])).resolves.toEqual([draft('member')]);
    expect(roleBinding.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { principalType: 'USER', projectId: 'p1', role: { scope: 'PROJECT' } },
    }));
  });

  it('keeps a user whose only source is a projectId-null binding', async () => {
    const { eligibility, roleBinding, project } = setup({ bindings: { [GLOBAL_BINDINGS]: ['member'] } });
    await expect(eligibility.filter([draft('member')])).resolves.toEqual([draft('member')]);
    expect(roleBinding.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { principalType: 'USER', projectId: null, role: { scope: 'PROJECT' } },
    }));
    // The global binding only counts in a project that exists and is not soft-deleted.
    expect(project.count).toHaveBeenCalledWith({ where: { id: 'p1', deletedAt: null } });
  });

  it('reads the binding sources once per distinct draft project', async () => {
    const { eligibility, roleBinding } = setup({ bindings: { p1: ['member'], p2: ['member'] } });
    const kept = await eligibility.filter([draft('member'), draft('member', { projectId: 'p2' })]);
    expect(kept.map((d) => d.userId)).toEqual(['member', 'member']);
    // Two queries per project: the local bindings and the projectId-null ones.
    expect(roleBinding.findMany.mock.calls.map(([args]) => args.where.projectId)).toEqual(['p1', null, 'p2', null]);
  });

  it('keeps global drafts (projectId null) for any active user without a membership query', async () => {
    const { eligibility, roleBinding } = setup();
    const kept = await eligibility.filter([draft('outsider', { projectId: null, actorId: null })]);
    expect(kept.map((d) => d.userId)).toEqual(['outsider']);
    expect(roleBinding.findMany).not.toHaveBeenCalled();
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
