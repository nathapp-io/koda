/**
 * Branch review B1 / US-006 AC-8 — the real-stack regression for the koda path linkifier.
 *
 * `tests/lib/thread-markdown.spec.ts` has to double `marked` and `isomorphic-dompurify`: jest's
 * CommonJS runtime cannot load the sanitizer (jsdom → ESM-only `@exodus/bytes`, see
 * `tests/lib/markdown.spec.ts`). Its B1 cases therefore prove the *linkifier's* behaviour over the
 * two byte strings the production sanitizer is believed to return — but the belief itself was only
 * ever checked by hand. This harness closes that: it runs outside jest (bun, the repo runtime),
 * drives the real `renderThreadMarkdown` — real marked, real isomorphic-dompurify — and parses
 * what it returns with jsdom's own HTML parser, the parser the sanitizer uses itself.
 *
 * It is part of the web package's test gate (`bun run test` runs `jest` and then this file, see
 * apps/web/package.json). Every check is independent; the process exits non-zero if one fails.
 */

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

import { sanitizeHtmlFragment } from '../../lib/markdown'
import { renderThreadMarkdown } from '../../lib/thread-markdown'
import {
  B1_QUOTED_ATTRIBUTE_HTML,
  B1_QUOTED_ATTRIBUTE_TEXT_NODE_HTML,
} from '../fixtures/b1-quoted-attribute'

/**
 * jsdom is not a direct dependency of this package — it comes with the production sanitizer, which
 * is exactly what should parse this output — so it is resolved through it.
 */
const requireFromSanitizer = createRequire(createRequire(import.meta.url).resolve('isomorphic-dompurify'))
const { JSDOM } = requireFromSanitizer('jsdom') as {
  JSDOM: new (html: string) => { window: { document: Document } }
}

/** The DOM jsdom builds from one HTML string (the same parser the sanitizer runs on). */
function documentOf(html: string): Document {
  return new JSDOM(`<!doctype html><html><body>${html}</body></html>`).window.document
}

const checks: Array<{ name: string; run: () => void }> = []

function check(name: string, run: () => void): void {
  checks.push({ name, run })
}

// ── the fixture the jest double stands in for ────────────────────────────────────────────────

for (const [label, html] of [
  ['quoted attribute', B1_QUOTED_ATTRIBUTE_HTML],
  ['text node', B1_QUOTED_ATTRIBUTE_TEXT_NODE_HTML],
] as const) {
  check(`the production sanitizer returns the ${label} B1 fixture byte for byte`, () => {
    assert.equal(
      sanitizeHtmlFragment(html),
      html,
      'isomorphic-dompurify changed these bytes — tests/lib/thread-markdown.spec.ts doubles a sanitizer that no longer behaves like the real one',
    )
  })
}

// ── the whole real pipeline, parsed as HTML ──────────────────────────────────────────────────

check('a `>` in a quoted attribute never becomes markup through the real pipeline', () => {
  const html = renderThreadMarkdown(B1_QUOTED_ATTRIBUTE_HTML, 'sandbox')
  const doc = documentOf(html)

  assert.equal(doc.querySelector('svg'), null, `an svg element was created from the attribute text: ${html}`)
  assert.equal(doc.querySelector('[onload], [onerror]'), null, `a handler attribute survived: ${html}`)

  const span = doc.querySelector('span')
  assert.ok(span, `the span itself was lost: ${html}`)
  assert.equal(
    span.getAttribute('title'),
    '> /sandbox/tickets/SB-3 <svg onload=alert(1)>',
    'the attribute value was rewritten instead of being left as data',
  )

  // The path is inside the attribute value, not a text node: it must not become a link.
  assert.equal(doc.querySelector('a'), null, `a link was built from attribute text: ${html}`)
})

check('a real text node beside such an attribute is still linked', () => {
  const html = renderThreadMarkdown(B1_QUOTED_ATTRIBUTE_TEXT_NODE_HTML, 'sandbox')
  const doc = documentOf(html)

  assert.equal(doc.querySelector('svg'), null, `an svg element was created from the attribute text: ${html}`)
  assert.equal(doc.querySelector('[onload], [onerror]'), null, `a handler attribute survived: ${html}`)
  assert.equal(
    doc.querySelector('span')?.getAttribute('title'),
    'a > b <svg onload=alert(1)>',
    'the attribute value was rewritten instead of being left as data',
  )

  const links = doc.querySelectorAll('a')
  assert.equal(links.length, 1, `expected exactly one link: ${html}`)
  assert.equal(links[0].getAttribute('href'), '/sandbox/tickets/SB-3')
  assert.equal(links[0].textContent, '/sandbox/tickets/SB-3')
})

// ── US-006 AC-1 and AC-8 through the real renderer ───────────────────────────────────────────

check('AC-1: a plain ticket path is linked by the real renderer', () => {
  const html = renderThreadMarkdown('see /sandbox/tickets/SB-3 now', 'sandbox')
  const links = documentOf(html).querySelectorAll('a')

  assert.equal(links.length, 1, `expected exactly one link: ${html}`)
  assert.equal(links[0].getAttribute('href'), '/sandbox/tickets/SB-3')
})

check('AC-8: the img is removed, its handler is gone and the path is still linked', () => {
  const html = renderThreadMarkdown('<img src=x onerror=alert(1)> /sandbox/tickets/SB-3', 'sandbox')
  const doc = documentOf(html)

  assert.equal(doc.querySelector('img'), null, `an img element survived: ${html}`)
  assert.equal(doc.querySelector('[onerror], [onload]'), null, `a handler attribute survived: ${html}`)
  assert.equal(html.includes('onerror'), false, `the handler text survived: ${html}`)

  const links = doc.querySelectorAll('a')
  assert.equal(links.length, 1, `expected exactly one link: ${html}`)
  assert.equal(links[0].getAttribute('href'), '/sandbox/tickets/SB-3')
})

// ── B3 (branch review): a long citation-free token renders in bounded time ───────────────────

/**
 * The reported case: the unanchored document-citation regex retried its open-ended `owner` at every
 * character of an ordinary long token, so the real pipeline took 4.1 seconds on 100,000 `a`
 * characters — synchronously, on every SSR render and streaming update. The linkifier now scans each
 * text run once. This runs the whole real stack (marked, the sanitizer, the linkifier), which is
 * where the cost was measured.
 */
check('renderThreadMarkdown is bounded on a 100,000-character citation-free token', () => {
  const text = 'a'.repeat(100_000)
  const started = Date.now()
  const html = renderThreadMarkdown(text, 'sandbox')
  const elapsed = Date.now() - started

  assert.ok(html.includes(text), 'the rendered HTML lost the token')
  assert.equal(documentOf(html).querySelectorAll('a').length, 0, `a link was built from a non-citation: ${html.slice(0, 200)}`)
  assert.ok(elapsed < 1500, `renderThreadMarkdown took ${elapsed}ms on a citation-free token (quadratic scan?)`)
})

// ── runner ───────────────────────────────────────────────────────────────────────────────────

let failed = 0
for (const { name, run } of checks) {
  try {
    run()
    console.log(`ok   ${name}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL ${name}\n     ${error instanceof Error ? error.message : String(error)}`)
  }
}

if (failed > 0) {
  console.error(`\n${failed} of ${checks.length} real-sanitizer check(s) failed`)
  process.exit(1)
}

console.log(`\n${checks.length} checks passed (real marked + isomorphic-dompurify, parsed with jsdom)`)
