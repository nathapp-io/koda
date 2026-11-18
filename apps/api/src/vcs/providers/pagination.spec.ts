import { inclusiveSince, laterOf, nextLinkUrl, nextPageFromLink, nextPageNumber, sameOrigin } from './pagination';

describe('pagination helpers (M10)', () => {
  it('reads rel="next" from a Link header', () => {
    const header = '<https://api.github.com/repos/o/r/issues?page=2>; rel="next", <https://api.github.com/repos/o/r/issues?page=9>; rel="last"';
    expect(nextLinkUrl(header)).toBe('https://api.github.com/repos/o/r/issues?page=2');
  });

  it('returns null without a next link', () => {
    expect(nextLinkUrl('<https://api.github.com/x?page=1>; rel="prev"')).toBeNull();
    expect(nextLinkUrl(undefined)).toBeNull();
  });

  it('does not treat rel="next-page" as a next link', () => {
    expect(nextLinkUrl('<https://api.github.com/x?page=2>; rel="next-page"')).toBeNull();
  });

  it.each([['3', 3], ['', null], [undefined, null], ['0', null], ['abc', null]])('X-Next-Page %j → %j', (header, expected) => {
    expect(nextPageNumber(header)).toBe(expected);
  });

  // A proxy can drop X-Next-Page, leaving only the standard Link header.
  const endpoint = 'https://gitlab.example/api/v4/projects/1/merge_requests';
  it.each([
    [`<${endpoint}?page=2>; rel="next"`, 2],
    [`<${endpoint}?page=2>; rel="prev", <${endpoint}?page=3>; rel="next"`, 3],
    ['<?page=2>; rel="next"', 2],
    ['<?page=2&tags=a,b>; title="page, two"; rel="alternate next"', 2],
    [`<${endpoint}?page=2>; rel="prev"`, null],
    ['<?page=2>; rel=next-page', null],
    ['not a link', null],
    [undefined, null],
  ])('Link %j → next page %j', (header, expected) => {
    expect(nextPageFromLink(header, endpoint)).toBe(expected);
  });

  it.each([
    `<${endpoint}?after=cursor>; rel="next"`,
    '<http://[broken?page=2>; rel="next"',
    '<>; rel="next"',
    '<?page=2junk>; rel="next"',
    '<?page=9007199254740992>; rel="next"',
    '<?page=2&page=3>; rel="next"',
    '<?page=2>; rel="next", <?page=3>; rel="next"',
  ])('rejects an unusable next link: %s', (header) => {
    expect(() => nextPageFromLink(header, endpoint)).toThrow('Invalid next page');
  });

  it('keeps the later of two timestamps and ignores bad input', () => {
    const a = new Date('2026-09-01T00:00:00Z');
    expect(laterOf(null, '2026-09-01T00:00:00Z')).toEqual(a);
    expect(laterOf(a, '2026-08-01T00:00:00Z')).toBe(a);
    expect(laterOf(a, '2026-10-01T00:00:00Z')).toEqual(new Date('2026-10-01T00:00:00Z'));
    expect(laterOf(a, 'garbage')).toBe(a);
    expect(laterOf(a, undefined)).toBe(a);
  });

  it('backs the resume bound off one second so a boundary item is not skipped', () => {
    expect(inclusiveSince(new Date('2026-09-01T00:00:00.000Z'))).toBe('2026-08-31T23:59:59.000Z');
  });

  it('compares origins', () => {
    expect(sameOrigin('https://api.github.com/x?page=2', 'https://api.github.com')).toBe(true);
    expect(sameOrigin('https://evil.example/x', 'https://api.github.com')).toBe(false);
    expect(sameOrigin('not a url', 'https://api.github.com')).toBe(false);
  });
});
