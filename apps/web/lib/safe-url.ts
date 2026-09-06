/**
 * URL safety helpers — anything user- or third-party-controlled that gets
 * rendered as a clickable link must round-trip through these to avoid binding
 * a `javascript:` (or `data:`, `vbscript:`…) URL into the page. The fix for
 * WEB-03: validate URL scheme on entry AND when binding to `:href`.
 */

const SAFE_URL_SCHEMES = ['http:', 'https:', 'mailto:', 'tel:'] as const
type SafeUrlScheme = (typeof SAFE_URL_SCHEMES)[number]

export const SAFE_URL_REPLACEMENT = '#'

/**
 * Returns `true` when `url` parses to a URL whose protocol is one of the
 * safe schemes we allow in the app.
 *
 * Note: this is purely client-side defense-in-depth. Production inputs
 * (webhook payloads, etc.) should also be validated server-side; treating
 * this helper as the only line of defense would let any caller bypass it
 * by writing the raw HTML binding elsewhere.
 */
export function isSafeUrl(url: unknown): url is string {
  if (typeof url !== 'string' || url.length === 0) return false
  try {
    // Bare tokens like "github.com/foo" become a relative URL with no
    // detectable scheme, which we still consider safe (browser will
    // resolve them relative to the current page, not run them as JS).
    const parsed = new URL(url, 'http://placeholder.invalid')
    return SAFE_URL_SCHEMES.includes(parsed.protocol as SafeUrlScheme)
  } catch {
    return false
  }
}

/**
 * Returns the original URL when it has a safe scheme, otherwise
 * `SAFE_URL_REPLACEMENT` so the link still renders but does not navigate
 * to a potentially malicious target. Use as the value of `:href` on
 * `<a>` elements that take user-supplied URLs.
 */
export function safeHref(url: unknown): string {
  if (typeof url !== 'string') return SAFE_URL_REPLACEMENT
  if (url.length === 0) return SAFE_URL_REPLACEMENT
  if (isSafeUrl(url)) return url
  return SAFE_URL_REPLACEMENT
}
