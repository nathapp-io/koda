import { safeHref, isSafeUrl, SAFE_URL_REPLACEMENT } from '~/lib/safe-url'

describe('safeHref', () => {
  it.each([
    'https://github.com/owner/repo/pull/1',
    'http://gitlab.com/owner/repo/-/merge_requests/1',
    'mailto:hello@example.com',
    'tel:+1-555-0100',
  ])('passes through safe URL %s unchanged', (url) => {
    expect(safeHref(url)).toBe(url)
  })

  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'data:application/octet-stream;base64,AAAA',
    'javASCRIP\t:alert(1)',
  ])('replaces dangerous scheme in %s with the safe placeholder', (url) => {
    expect(safeHref(url)).toBe(SAFE_URL_REPLACEMENT)
  })

  it.each([
    undefined,
    null,
    '',
    123,
    {},
    [],
  ])('replaces non-string input %p with the safe placeholder', (input) => {
    expect(safeHref(input)).toBe(SAFE_URL_REPLACEMENT)
  })

  it('treats bare tokens without a scheme as safe (still passes through)', () => {
    expect(safeHref('github.com/owner/repo')).toBe('github.com/owner/repo')
  })

  it('isSafeUrl reflects the same allowlist as safeHref', () => {
    expect(isSafeUrl('https://example.com')).toBe(true)
    expect(isSafeUrl('javascript:alert(1)')).toBe(false)
    expect(isSafeUrl(null)).toBe(false)
  })
})
