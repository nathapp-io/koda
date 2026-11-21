/**
 * US-002 AC-1 to AC-6 and AC-12/AC-13 — the real-stack checks for image-free comment markdown.
 *
 * `tests/lib/markdown.spec.ts` and `tests/lib/thread-markdown.spec.ts` have to double `marked` and
 * `isomorphic-dompurify`: jest's CommonJS runtime cannot load the sanitizer (jsdom → ESM-only
 * `@exodus/bytes`). Those specs therefore prove a module's behaviour over byte strings the
 * production stack is *believed* to produce. This harness runs outside jest (bun, the repo
 * runtime), drives the real renderers — real marked, real isomorphic-dompurify — and parses what
 * they return with jsdom's own HTML parser, the parser the sanitizer uses itself.
 *
 * It is part of the web package's test gate (`bun run test` runs `jest` and then this file, see
 * apps/web/package.json). Every check is independent; the process exits non-zero if one fails.
 */

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

import {
  renderMarkdownOrEscape,
  renderMarkdownWithoutImages,
  renderSafeMarkdown,
} from '../../lib/markdown'
import { renderThreadMarkdown } from '../../lib/thread-markdown'

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

// ── the payload that discriminates the strip from the strip + second sanitize ─────────────────

/**
 * A link whose `title` holds `<img b=`: stripping every `<img …>` with a regex over serialized HTML
 * ends that attribute early and eats the anchor's own `>`, so the text after it re-parses as
 * attributes of the `<a>` element — `onmouseover` among them. Only sanitizing *after* the strip
 * removes it again, which is why AC-1 and AC-6 fail on a strip with no second sanitize.
 */
const IMG_IN_ATTRIBUTE_PAYLOAD = '[x](https://e.com "a<img b=")\n\n" onmouseover="alert(1)" x="y"'

// ── AC-1 to AC-5: renderMarkdownWithoutImages on the real stack ──────────────────────────────

check('AC-1: stripping an img that ends an attribute early leaves no live handler attribute', () => {
  const html = renderMarkdownWithoutImages(IMG_IN_ATTRIBUTE_PAYLOAD)
  const doc = documentOf(html)

  assert.equal(doc.querySelector('[onmouseover]'), null, `an element carries onmouseover: ${html}`)

  // Not vacuous: this harness must be able to see the defect the second sanitize fixes. With the
  // strip alone (the pre-US-002 shape of the thread renderer) the same payload really does re-parse
  // with a live handler, because the strip ate the anchor's own `>`.
  const strippedOnly = renderMarkdownOrEscape(IMG_IN_ATTRIBUTE_PAYLOAD).replace(/<img\b[^>]*>/gi, '')
  assert.ok(
    documentOf(strippedOnly).querySelector('[onmouseover]'),
    'the fixture no longer discriminates: the strip alone leaves no handler attribute',
  )
})

check('AC-2: a markdown image is removed and the text around it is kept', () => {
  const html = renderMarkdownWithoutImages('see ![x](https://example.com/a.png) here')
  const doc = documentOf(html)

  assert.equal(doc.querySelector('img'), null, `an img element survived: ${html}`)
  assert.equal(doc.body.textContent?.includes('see'), true, `the text before the image was lost: ${html}`)
  assert.equal(doc.body.textContent?.includes('here'), true, `the text after the image was lost: ${html}`)
})

check('AC-3: a javascript: link keeps no usable href', () => {
  const html = renderMarkdownWithoutImages('[x](javascript:alert(1))')
  const doc = documentOf(html)

  assert.equal(doc.querySelector('a[href^="javascript:"]'), null, `a javascript: href survived: ${html}`)
  for (const link of doc.querySelectorAll('a')) {
    assert.equal((link.getAttribute('href') ?? '').toLowerCase().startsWith('javascript:'), false, `a javascript: href survived: ${html}`)
  }
})

check('AC-4: a script element is removed', () => {
  const html = renderMarkdownWithoutImages('<script>alert(1)</script>ok')
  const doc = documentOf(html)

  assert.equal(doc.querySelector('script'), null, `a script element survived: ${html}`)
  assert.equal(doc.body.textContent?.includes('ok'), true, `the text after the script was lost: ${html}`)
})

check('AC-5: breaks: true keeps a single typed newline as a <br> between the two lines', () => {
  const html = renderMarkdownWithoutImages('line one\nline two', { breaks: true })
  const paragraph = documentOf(html).querySelector('p')

  assert.ok(paragraph, `no paragraph was rendered: ${html}`)
  const br = paragraph.querySelector('br')
  assert.ok(br, `no <br> element: ${html}`)
  assert.equal(br.previousSibling?.textContent, 'line one', `the <br> is not after "line one": ${html}`)
  assert.equal(br.nextSibling?.textContent, 'line two', `the <br> is not before "line two": ${html}`)
})

// ── AC-6: renderThreadMarkdown's no-slug branch is sanitized too ─────────────────────────────

check('AC-6: renderThreadMarkdown without a slug returns sanitized HTML', () => {
  const html = renderThreadMarkdown(IMG_IN_ATTRIBUTE_PAYLOAD)
  const doc = documentOf(html)

  assert.equal(doc.querySelector('[onmouseover]'), null, `an element carries onmouseover: ${html}`)
})

// ── AC-12/AC-13: one-argument callers render exactly as before ───────────────────────────────

check('AC-12: renderMarkdownOrEscape without options argument keeps a newline unbroken', () => {
  const html = renderMarkdownOrEscape('line one\nline two')

  assert.equal(documentOf(html).querySelector('br'), null, `an unexpected <br> was rendered: ${html}`)
})

check('AC-13: renderSafeMarkdown without options argument keeps a newline unbroken', () => {
  const html = renderSafeMarkdown('line one\nline two')

  assert.equal(documentOf(html).querySelector('br'), null, `an unexpected <br> was rendered: ${html}`)
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
