/**
 * Fleet S5a B4-D1/D6 (US-006): the one piece of runner/agent text that reaches the DOM as HTML.
 *
 * Assistant thread message `content` renders through the shared sanitizer
 * (`renderMarkdownOrEscape`) and then every `img` element is removed, so agent-steered text
 * (repo content, prompt injection) can never make the browser fetch a URL. Links stay — they
 * need a click.
 *
 * Fleet S5b US-006 (1c-R2): the paths the knowledge tools emit (`/<slug>/tickets/<ref>`,
 * `/<slug>/fleet/jobs/<id>`) become links, given the project slug. Only the *text runs* of the
 * sanitized HTML are rewritten: the anchors this adds carry a path produced by a strict pattern,
 * never content-derived markup. The rewrite is followed by one more pass through the same
 * sanitizer, so whatever leaves this module is sanitized by construction (B1).
 *
 * A tag is scanned the way the HTML tokenizer scans one — a quoted attribute value is data, so a
 * `>` inside `title="a > b"` does not end the tag. Splitting at the first `>` (the branch-review
 * B1 defect) read attribute content as markup and could turn a `<svg onload=…>` quoted inside a
 * title into a real element. No DOM is built here on purpose: this runs during SSR too, where
 * `DOMParser` is not available, and `isomorphic-dompurify` does not expose its jsdom window.
 *
 * Fleet S5b US-007 (3c-2-D13): document citations (`o/n:docs/a.md@<sha>`) link to GitHub and outcome
 * citations (`job:<id>/feature-report.md`) to the job page, under the same rules.
 *
 * Text inside an existing link or a fenced code block is left alone; an inline code span whose
 * whole text is one of the paths or citations is wrapped, code element and all.
 */

import { renderMarkdownOrEscape, sanitizeHtmlFragment } from '~/lib/markdown'

/** Every `<img …>` element, case-insensitively, with or without a trailing slash or attributes. */
const IMG_TAG = /<img\b[^>]*>/gi

/** A ticket ref (`SB-3`) and a fleet job id (`cmv9h6bqq000508tn60pd189y`). */
const TICKET_REF = '[A-Za-z0-9]+-\\d+'
const JOB_ID = '[a-z0-9]{20,40}'

const VOID_TAGS = new Set(['br', 'col', 'hr', 'img', 'input', 'link', 'meta', 'source', 'wbr'])

/**
 * Characters that make an occurrence part of a longer token rather than a standalone path: a
 * match preceded or followed by one of these (an absolute URL, another path segment, a longer
 * ref) is left as text.
 */
const CONTINUES_PATH = /[A-Za-z0-9_/-]/

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function pathPattern(slug: string): string {
  return `/${escapeRegExp(slug)}/(?:tickets/${TICKET_REF}|fleet/jobs/${JOB_ID})`
}

/**
 * Fleet S5b US-007 (3c-2-D13): the citations the knowledge tools emit.
 * A document: `<owner>/<name>:<path>@<sha>[#<fragment>]`, linked to GitHub at that sha. An outcome:
 * `job:<jobId>/(feature-report.md|decisions.jsonl)[#<fragment>]`, linked to the job page. The path
 * excludes quotes, `<`, `>` and `&` as well as `@`, `#` and whitespace, so a match is attribute-safe.
 */
const CITATION_FRAGMENT_SOURCE = '[A-Za-z0-9_-]+'
const JOB_CITATION =
  `job:(?<jobId>${JOB_ID})/(?:feature-report\\.md|decisions\\.jsonl)(?:#${CITATION_FRAGMENT_SOURCE})?`

/**
 * B3: the document citation is parsed, not matched by an unanchored regex. `/<owner>/<name>:/` cannot be
 * anchored by a literal prefix, so the regex engine retried an open-ended `owner` (and an open-ended path)
 * at every character of a run, which is quadratic on an ordinary long token — 100,000 `a` characters took
 * seconds in the SSR/browser render path. `docCitations` walks each token once instead (see its comment).
 */
const CITATION_WORD = /[A-Za-z0-9_.-]/
/** The characters a citation's path may not hold; `@` among them is what keeps the backward walk linear. */
const CITATION_PATH_STOP = /[@#\s"'<>&`]/
const CITATION_SHA = /[0-9a-f]{7,40}/y
const CITATION_FRAGMENT = new RegExp(CITATION_FRAGMENT_SOURCE, 'y')

/** One linkable occurrence: its half-open span in a text run and the `<a …>` that opens its link. */
interface Citation {
  start: number
  end: number
  opening: string
}

/**
 * The koda paths and outcome citations of one text run, left to right. Both open with a literal
 * (`/<slug>/…`, `job:`), so a single regex pass over the run is linear and cannot backtrack over a long
 * token (B3).
 */
function prefixedCitations(text: string, slug: string): Citation[] {
  const pattern = new RegExp(`(?<path>${pathPattern(slug)})|${JOB_CITATION}`, 'g')
  const citations: Citation[] = []
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    const jobId = match.groups?.jobId
    const href = jobId === undefined ? match[0] : `/${slug}/fleet/jobs/${jobId}`
    citations.push({ start: match.index, end: match.index + match[0].length, opening: `<a href="${escapeAttribute(href)}">` })
  }
  return citations
}

/**
 * Every document citation of one text run, left to right. A citation holds no `CITATION_PATH_STOP`
 * character, so the whole prefix of a candidate lies in the run of ordinary characters that its `@` ends —
 * and `@` is itself a stop character, so those runs never overlap and the scan visits each character a
 * constant number of times (B3).
 */
function docCitations(text: string): Citation[] {
  const citations: Citation[] = []
  for (let at = text.indexOf('@'); at !== -1; at = text.indexOf('@', at + 1)) {
    const citation = docCitationAt(text, at)
    if (citation !== null) citations.push(citation)
  }
  return citations
}

/** The document citation whose sha tail starts after the `@` at `at`, or null when `at` starts none. */
function docCitationAt(text: string, at: number): Citation | null {
  CITATION_SHA.lastIndex = at + 1
  const sha = CITATION_SHA.exec(text)
  if (sha === null) return null
  let end = at + 1 + sha[0].length
  let fragment = ''
  if (text[end] === '#') {
    CITATION_FRAGMENT.lastIndex = end + 1
    const match = CITATION_FRAGMENT.exec(text)
    if (match !== null) {
      fragment = match[0]
      end += match[0].length + 1
    }
  }

  let regionStart = at
  while (regionStart > 0 && !CITATION_PATH_STOP.test(text[regionStart - 1])) regionStart -= 1
  const split = citationSplit(text, regionStart, at)
  if (split === null) return null

  const owner = text.slice(split.ownerStart, split.slash)
  const name = text.slice(split.slash + 1, split.colon)
  const docPath = text.slice(split.colon + 1, at)
  const hash = fragment === '' ? '' : `#${fragment}`
  const href = `https://github.com/${owner}/${name}/blob/${sha[0]}/${docPath}${hash}`
  return {
    start: split.ownerStart,
    end,
    opening: `<a href="${escapeAttribute(href)}" target="_blank" rel="noopener noreferrer">`,
  }
}

/**
 * The leftmost `owner/name:` the citation at `at` can start at, within the run of ordinary characters
 * `[regionStart, at)` — the same start the regex reads, because a greedy `owner` can only end at a `/` that
 * closes the word run it began in. The colons are read from a slice of that run, so a run with no colon never
 * sends a scan past it (B3): the run is the candidate's whole prefix, and `@` bounds it, so the slices of
 * distinct candidates never overlap and the work stays linear.
 */
function citationSplit(text: string, regionStart: number, at: number): { ownerStart: number; slash: number; colon: number } | null {
  const region = text.slice(regionStart, at)
  let best: { ownerStart: number; slash: number; colon: number } | null = null
  for (let colon = region.indexOf(':'); colon !== -1; colon = region.indexOf(':', colon + 1)) {
    // The path between the colon and the `@` must hold at least one character.
    if (colon + 1 >= region.length) continue
    const owner = ownerBefore(text, regionStart + colon, regionStart)
    if (owner === null) continue
    if (best === null || owner.ownerStart < best.ownerStart) best = { ...owner, colon: regionStart + colon }
  }
  return best
}

/** The non-empty `owner/name` a colon closes, or null when the colon follows neither. */
function ownerBefore(text: string, colon: number, regionStart: number): { ownerStart: number; slash: number } | null {
  let nameStart = colon
  while (nameStart > regionStart && CITATION_WORD.test(text[nameStart - 1])) nameStart -= 1
  if (nameStart === colon) return null
  const slash = nameStart - 1
  if (slash < regionStart || text[slash] !== '/') return null
  let ownerStart = slash
  while (ownerStart > regionStart && CITATION_WORD.test(text[ownerStart - 1])) ownerStart -= 1
  if (ownerStart === slash) return null
  return { ownerStart, slash }
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** The whole text is exactly one linkable path or citation for this slug? Then its opening anchor, else null. */
function wholeLink(text: string, slug: string): string | null {
  const citation = allCitations(text, slug).find((candidate) => candidate.start === 0 && candidate.end === text.length)
  return citation === undefined ? null : citation.opening
}

/** Every linkable occurrence of one text run, left to right. */
function allCitations(text: string, slug: string): Citation[] {
  return [...prefixedCitations(text, slug), ...docCitations(text)].sort((a, b) => a.start - b.start)
}

/** Linkifies the koda paths and knowledge citations that stand alone in one run of text. */
function linkifyText(text: string, slug: string): string {
  let out = ''
  // `copied` is how much of the text the output already holds; `cursor` is where the next occurrence may
  // start. A rejected occurrence consumes its span, exactly like a regex match the old loop skipped, and an
  // occurrence that starts inside a consumed span is dropped: an unanchored regex restarted at the consumed
  // span's end and re-parsed its tail as a second citation (the B3 differential note), which linked the tail of
  // a citation it had already linked. The tail of an already-linked citation is not standalone text.
  let copied = 0
  let cursor = 0
  for (const citation of allCitations(text, slug)) {
    if (citation.start < cursor) continue
    cursor = citation.end
    const before = citation.start === 0 ? '' : text[citation.start - 1]
    const after = citation.end >= text.length ? '' : text[citation.end]
    if (CONTINUES_PATH.test(before) || CONTINUES_PATH.test(after)) continue
    out += `${text.slice(copied, citation.start)}${citation.opening}${text.slice(citation.start, citation.end)}</a>`
    copied = citation.end
  }
  return out + text.slice(copied)
}

/**
 * The index of the `>` that closes the tag opening at `start` (`html[start] === '<'`), or -1 when
 * that `<` does not open a tag (it is text) or the tag is truncated.
 *
 * The scan follows the HTML tokenizer: inside a quoted attribute value every character is data, so
 * a `>` there does not end the tag, and `<` in front of anything but a letter, `/`, `!` or `?` is
 * text (the sanitizer hands `title="a > b"` back with the `>` unescaped, see B1).
 */
function tagEnd(html: string, start: number): number {
  let index = start + 1
  const next = html[index]
  if (next === undefined) return -1
  if (next === '!') {
    // `<!-- … -->` ends at the first `-->`; any other declaration (`<!doctype …>`) at its `>`.
    if (html.startsWith('<!--', start)) {
      const end = html.indexOf('-->', start + 4)
      return end === -1 ? -1 : end + 2
    }
    return html.indexOf('>', index)
  }
  if (next === '?') return html.indexOf('>', index)
  if (next === '/') index += 1
  if (!/[a-zA-Z]/.test(html[index] ?? '')) return -1
  while (/[a-zA-Z0-9-]/.test(html[index] ?? '')) index += 1
  while (index < html.length) {
    const char = html[index]
    if (char === '"' || char === "'") {
      const end = html.indexOf(char, index + 1)
      if (end === -1) return -1
      index = end + 1
      continue
    }
    if (char === '>') return index
    index += 1
  }
  return -1
}

/**
 * Splits sanitized HTML into tag and text runs, alternating and never empty. A `<` that does not
 * open a tag (or a truncated one) stays part of the text run it was found in.
 */
function tokenize(html: string): string[] {
  const tokens: string[] = []
  let text = ''
  let index = 0
  while (index < html.length) {
    const open = html.indexOf('<', index)
    if (open === -1) {
      text += html.slice(index)
      break
    }
    text += html.slice(index, open)
    const end = tagEnd(html, open)
    if (end === -1) {
      text += '<'
      index = open + 1
      continue
    }
    if (text !== '') {
      tokens.push(text)
      text = ''
    }
    tokens.push(html.slice(open, end + 1))
    index = end + 1
  }
  if (text !== '') tokens.push(text)
  return tokens
}

function tagOf(token: string): { name: string; closing: boolean; selfClosing: boolean } | null {
  const match = /^<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9-]*)/.exec(token)
  if (!match) return null
  return { name: match[2].toLowerCase(), closing: match[1] === '/', selfClosing: /\/>$/.test(token) }
}

function isClosingTag(token: string | undefined, name: string): boolean {
  if (token === undefined) return false
  const info = tagOf(token)
  return info !== null && info.closing && info.name === name
}

/** Rewrites the standalone koda paths and knowledge citations of already-sanitized HTML into links. */
function linkifyPaths(html: string, slug: string): string {
  const tokens = tokenize(html)
  const out: string[] = []
  const stack: string[] = []
  const inside = (name: string): boolean => stack.includes(name)
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!token.startsWith('<')) {
      // Inside an existing link, a fenced block, or a code span (whose whole-content case is
      // handled by the code branch below) the text is left exactly as it is.
      const skip = inside('a') || inside('pre') || inside('code')
      out.push(skip ? token : linkifyText(token, slug))
      continue
    }
    const info = tagOf(token)
    if (info === null) {
      out.push(token)
      continue
    }
    if (info.closing) {
      out.push(token)
      const open = stack.lastIndexOf(info.name)
      if (open !== -1) stack.splice(open, 1)
      continue
    }
    // An inline code span whose only content is a path: wrap the whole element in the link.
    if (info.name === 'code' && !info.selfClosing && !inside('a') && !inside('pre')) {
      const content = tokens[index + 1]
      const opening = content !== undefined && !content.startsWith('<') ? wholeLink(content, slug) : null
      if (opening !== null && isClosingTag(tokens[index + 2], 'code')) {
        out.push(opening, token, content, tokens[index + 2], '</a>')
        index += 2
        continue
      }
    }
    out.push(token)
    if (!info.selfClosing && !VOID_TAGS.has(info.name)) stack.push(info.name)
  }
  return out.join('')
}

/** B4-D6: assistant content through the shared sanitizer, images stripped, koda paths linked. */
export function renderThreadMarkdown(content: string, slug?: string): string {
  const html = renderMarkdownOrEscape(content).replace(IMG_TAG, '')
  if (!slug) return html
  // B1: the rewrite reads and re-serialises sanitized HTML, so its own output goes through the
  // sanitizer again — what this returns is sanitized whatever the rewrite did.
  return sanitizeHtmlFragment(linkifyPaths(html, slug))
}
