import { TicketMentionResolver } from './ticket-mention.resolver';

const id = (n: number): string => `c${String(n).padStart(24, '0')}`;
const token = (userId: string): string => `@[x](user:${userId})`;

function resolver(visible: readonly string[]) {
  const db = {
    user: { findMany: vi.fn(async (args: { where: { id: { in: string[] } } }) =>
      args.where.id.in.filter((u) => visible.includes(u)).map((u) => ({ id: u }))) },
  };
  return { db, r: new TicketMentionResolver({ client: db } as never) };
}

describe('TicketMentionResolver (S4a §2.3)', () => {
  it('keeps visible ids in token order', async () => {
    const { r } = resolver([id(1), id(2)]);
    expect(await r.mentionedUserIds('p1', `${token(id(2))} then ${token(id(1))}`)).toEqual([id(2), id(1)]);
  });

  it('drops a token for a user who is neither a project member nor a global admin', async () => {
    const { r, db } = resolver([id(1)]);
    expect(await r.mentionedUserIds('p1', `${token(id(1))} ${token(id(3))}`)).toEqual([id(1)]);
    expect(db.user.findMany).toHaveBeenCalledWith({
      where: {
        id: { in: [id(1), id(3)] },
        disabled: false,
        OR: [{ role: 'ADMIN' }, { projectMemberships: { some: { projectId: 'p1' } } }],
      },
      select: { id: true },
    });
  });

  it.each([null, '', 'plain @alice text', '@[x](user:)'])('no tokens (%p) → [] without a query', async (text) => {
    const { r, db } = resolver([id(1)]);
    expect(await r.mentionedUserIds('p1', text)).toEqual([]);
    expect(db.user.findMany).not.toHaveBeenCalled();
  });
});
