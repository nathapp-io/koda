import { decodeTimelineCursor, encodeTimelineCursor, keysetWhere } from './timeline-cursor';

describe('timeline cursor', () => {
  const key = { createdAt: new Date('2026-03-04T05:06:07.089Z'), id: 'ckabc123' };

  it('round-trips', () => {
    expect(decodeTimelineCursor(encodeTimelineCursor(key))).toEqual(key);
  });

  it.each([
    ['', 'empty'],
    ['ckabc123', 'an old-style bare event id'],
    ['not base64 !!', 'garbage'],
    [Buffer.from('2026-99-99T00:00:00Z|x').toString('base64url'), 'an invalid date'],
    [Buffer.from('2026-01-01T00:00:00.000Z|').toString('base64url'), 'an empty id'],
  ])('rejects %s (%s)', (cursor) => {
    expect(decodeTimelineCursor(cursor)).toBeNull();
  });

  it('ANDs the keyset condition with the existing where, keeping a createdAt range', () => {
    const where = { projectId: 'p1', createdAt: { gte: new Date('2026-01-01T00:00:00Z') } };
    expect(keysetWhere(where, key)).toEqual({
      AND: [
        where,
        { OR: [{ createdAt: { lt: key.createdAt } }, { createdAt: key.createdAt, id: { lt: key.id } }] },
      ],
    });
  });

  it('returns the where unchanged without a cursor', () => {
    const where = { projectId: 'p1' };
    expect(keysetWhere(where, undefined)).toBe(where);
  });
});
