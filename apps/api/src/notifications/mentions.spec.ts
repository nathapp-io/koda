import { MENTION_LIMIT, parseMentions } from './mentions';

const id = (n: number): string => `c${String(n).padStart(24, '0')}`;
const token = (label: string, userId: string): string => `@[${label}](user:${userId})`;

describe('parseMentions (S4a §2.3, D504)', () => {
  it('returns distinct ids in first-seen order', () => {
    const text = `hi ${token('Ann', id(1))} and ${token('Bo', id(2))}, again ${token('Ann L.', id(1))}`;
    expect(parseMentions(text)).toEqual([id(1), id(2)]);
  });

  it('returns [] for empty, null and undefined', () => {
    expect(parseMentions('')).toEqual([]);
    expect(parseMentions(null)).toEqual([]);
    expect(parseMentions(undefined)).toEqual([]);
  });

  it('never parses plain @name text', () => {
    expect(parseMentions('ping @alice and @bob@example.com')).toEqual([]);
  });

  it.each([
    ['an empty id', '@[x](user:)'],
    ['an empty label', `@[](user:${id(1)})`],
    ['a label containing ]', `@[a]b](user:${id(1)})`],
    ['an id that is not a cuid', '@[x](user:not-a-cuid)'],
    ['an uppercase id', `@[x](user:${id(1).toUpperCase()})`],
    ['an id that is too short', '@[x](user:c123)'],
    ['an id that is too long', `@[x](user:c${'a'.repeat(40)})`],
    ['another scheme', `@[x](agent:${id(1)})`],
    ['a missing closing paren', `@[x](user:${id(1)}`],
    ['a space before the paren', `@[x] (user:${id(1)})`],
  ])('ignores %s', (_label, text) => {
    expect(parseMentions(text)).toEqual([]);
  });

  it(`caps at ${MENTION_LIMIT} distinct ids, even for 500 tokens`, () => {
    const text = Array.from({ length: 500 }, (_, i) => token(`u${i}`, id(i))).join(' ');
    const ids = parseMentions(text);
    expect(ids).toHaveLength(MENTION_LIMIT);
    expect(ids[0]).toBe(id(0));
    expect(ids[MENTION_LIMIT - 1]).toBe(id(MENTION_LIMIT - 1));
  });

  it('is linear on a long run of unterminated labels', () => {
    const text = `@[${'['.repeat(50_000)}`;
    const started = Date.now();
    expect(parseMentions(text)).toEqual([]);
    expect(Date.now() - started).toBeLessThan(500);
  });
});
