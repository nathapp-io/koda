import { TicketMentionResolver } from './ticket-mention.resolver';

const id = (n: number): string => `c${String(n).padStart(24, '0')}`;
const token = (userId: string): string => `@[x](user:${userId})`;

function resolver(users: readonly string[] = [id(1), id(2)]) {
  const user = { findMany: vi.fn(async () => users.map((userId) => ({ id: userId }))) };
  const db = { user };
  const permissions = { effectiveKeys: vi.fn(async () => new Set(['project.read'])) };
  return { db, permissions, r: new TicketMentionResolver({ client: db } as never, permissions as never) };
}

describe('TicketMentionResolver', () => {
  it('returns authorized ids in text order', async () => {
    const { r } = resolver([id(1), id(2)]);
    expect(await r.mentionedUserIds('p1', `${token(id(2))} ${token(id(1))}`)).toEqual([id(2), id(1)]);
  });

  it('does not check or return users absent from the enabled-user read', async () => {
    const { r, permissions } = resolver([id(1)]);
    expect(await r.mentionedUserIds('p1', `${token(id(1))} ${token(id(2))}`)).toEqual([id(1)]);
    expect(permissions.effectiveKeys).toHaveBeenCalledTimes(1);
  });

  it('propagates effectiveKeys errors unchanged for a mentioned enabled user', async () => {
    const { r, permissions } = resolver([id(1)]);
    const error = new Error('permission read failed');
    permissions.effectiveKeys.mockRejectedValue(error);
    await expect(r.mentionedUserIds('p1', token(id(1)))).rejects.toBe(error);
  });

  it.each([null, '', 'plain @alice text', '@[x](user:)'])('no tokens (%p) return without database or key reads', async (text) => {
    const { r, db, permissions } = resolver();
    expect(await r.mentionedUserIds('p1', text)).toEqual([]);
    expect(db.user.findMany).not.toHaveBeenCalled();
    expect(permissions.effectiveKeys).not.toHaveBeenCalled();
  });
});
