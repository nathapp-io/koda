import { laterOf, nextLinkUrl, nextPageNumber, sameOrigin } from './pagination';

describe('pagination helpers (M10)', () => {
  it('reads rel="next" from a Link header', () => {
    const header = '<https://api.github.com/repos/o/r/issues?page=2>; rel="next", <https://api.github.com/repos/o/r/issues?page=9>; rel="last"';
    expect(nextLinkUrl(header)).toBe('https://api.github.com/repos/o/r/issues?page=2');
  });

  it('returns null without a next link', () => {
    expect(nextLinkUrl('<https://api.github.com/x?page=1>; rel="prev"')).toBeNull();
    expect(nextLinkUrl(undefined)).toBeNull();
  });

  it.each([['3', 3], ['', null], [undefined, null], ['0', null], ['abc', null]])('X-Next-Page %j → %j', (header, expected) => {
    expect(nextPageNumber(header)).toBe(expected);
  });

  it('keeps the later of two timestamps and ignores bad input', () => {
    const a = new Date('2026-09-01T00:00:00Z');
    expect(laterOf(null, '2026-09-01T00:00:00Z')).toEqual(a);
    expect(laterOf(a, '2026-08-01T00:00:00Z')).toBe(a);
    expect(laterOf(a, '2026-10-01T00:00:00Z')).toEqual(new Date('2026-10-01T00:00:00Z'));
    expect(laterOf(a, 'garbage')).toBe(a);
    expect(laterOf(a, undefined)).toBe(a);
  });

  it('compares origins', () => {
    expect(sameOrigin('https://api.github.com/x?page=2', 'https://api.github.com')).toBe(true);
    expect(sameOrigin('https://evil.example/x', 'https://api.github.com')).toBe(false);
    expect(sameOrigin('not a url', 'https://api.github.com')).toBe(false);
  });
});
