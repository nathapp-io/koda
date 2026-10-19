import { TicketMentionResolver } from './ticket-mention.resolver';

const id = (n: number): string => `c${String(n).padStart(24, '0')}`;
const token = (userId: string): string => `@[x](user:${userId})`;

/** One fake user row: `DISABLED` is what the id lookup's `disabled: false` filter drops. */
type FakeUser = 'ADMIN' | 'MEMBER' | 'DISABLED';

/**
 * The fake Prisma client the compatibility queries read: `legacy` are the project's `ProjectMember`
 * rows, `bindings` its PROJECT-scope bindings and `globalBindings` the PROJECT-scope bindings with no
 * project, which apply in every project.
 */
interface Sources {
  legacy?: readonly string[];
  bindings?: readonly string[];
  globalBindings?: readonly string[];
}

function resolver(users: Readonly<Record<string, FakeUser>>, sources: Sources = {}) {
  const db = {
    user: {
      findMany: vi.fn(async (args: { where: { id: { in: string[] }; disabled?: boolean } }) =>
        args.where.id.in
          .filter((userId) => users[userId] !== undefined && users[userId] !== 'DISABLED')
          .map((userId) => ({ id: userId, role: users[userId] as 'ADMIN' | 'MEMBER' }))),
    },
    projectMember: {
      findMany: vi.fn(async () => (sources.legacy ?? []).map((userId) => ({ userId }))),
    },
    roleBinding: {
      findMany: vi.fn(async (args: { where: { projectId: string | null } }) =>
        (args.where.projectId === null ? sources.globalBindings ?? [] : sources.bindings ?? [])
          .map((principalId) => ({ principalId }))),
    },
    project: { count: vi.fn(async () => 1) },
  };
  return { db, r: new TicketMentionResolver({ client: db } as never) };
}

describe('TicketMentionResolver (S4a §2.3)', () => {
  it('keeps visible ids in token order', async () => {
    const { r } = resolver({ [id(1)]: 'MEMBER', [id(2)]: 'MEMBER' }, { legacy: [id(1), id(2)] });
    expect(await r.mentionedUserIds('p1', `${token(id(2))} then ${token(id(1))}`)).toEqual([id(2), id(1)]);
  });

  it('keeps a global ADMIN who is in no project, in token order', async () => {
    const { r } = resolver({ [id(1)]: 'ADMIN', [id(2)]: 'MEMBER' }, { legacy: [id(2)] });
    expect(await r.mentionedUserIds('p1', `${token(id(1))} then ${token(id(2))}`)).toEqual([id(1), id(2)]);
  });

  it('keeps a user whose only source in the project is a project binding', async () => {
    const { r, db } = resolver({ [id(2)]: 'MEMBER' }, { bindings: [id(2)] });
    expect(await r.mentionedUserIds('p1', token(id(2)))).toEqual([id(2)]);
    // The role is read from the compatibility union, not from `ProjectMember` alone.
    expect(db.projectMember.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { projectId: 'p1' } }));
    expect(db.roleBinding.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { principalType: 'USER', projectId: 'p1', role: { scope: 'PROJECT' } },
    }));
  });

  it('keeps a user whose only source is a projectId-null binding', async () => {
    const { r, db } = resolver({ [id(2)]: 'MEMBER' }, { globalBindings: [id(2)] });
    expect(await r.mentionedUserIds('p1', token(id(2)))).toEqual([id(2)]);
    expect(db.roleBinding.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { principalType: 'USER', projectId: null, role: { scope: 'PROJECT' } },
    }));
  });

  it('drops a token for a user who is neither a project member nor a global admin', async () => {
    const { r } = resolver({ [id(1)]: 'MEMBER', [id(3)]: 'MEMBER' }, { legacy: [id(1)] });
    expect(await r.mentionedUserIds('p1', `${token(id(1))} ${token(id(3))}`)).toEqual([id(1)]);
  });

  it('drops a disabled user even when the project names them', async () => {
    const { r, db } = resolver({ [id(1)]: 'DISABLED', [id(2)]: 'MEMBER' }, { legacy: [id(1), id(2)] });
    expect(await r.mentionedUserIds('p1', `${token(id(1))} ${token(id(2))}`)).toEqual([id(2)]);
    expect(db.user.findMany).toHaveBeenCalledWith({
      where: { id: { in: [id(1), id(2)] }, disabled: false },
      select: { id: true, role: true },
    });
  });

  it.each([null, '', 'plain @alice text', '@[x](user:)'])('no tokens (%p) → [] without a query', async (text) => {
    const { r, db } = resolver({ [id(1)]: 'MEMBER' });
    expect(await r.mentionedUserIds('p1', text)).toEqual([]);
    expect(db.user.findMany).not.toHaveBeenCalled();
    expect(db.projectMember.findMany).not.toHaveBeenCalled();
    expect(db.roleBinding.findMany).not.toHaveBeenCalled();
  });
});
