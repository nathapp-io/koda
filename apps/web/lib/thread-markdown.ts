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
const REPO_PART = '[A-Za-z0-9_.-]+'
const CITATION_PATH = '[^@#\\s"\'<>&`]+'
const CITATION_FRAGMENT = '[A-Za-z0-9_-]+'
const DOC_CITATION =
  `(?<owner>${REPO_PART})/(?<name>${REPO_PART}):(?<docPath>${CITATION_PATH})@(?<sha>[0-9a-f]{7,40})(?:#(?<docFragment>${CITATION_FRAGMENT}))?`
const JOB_CITATION =
  `job:(?<jobId>${JOB_ID})/(?:feature-report\\.md|decisions\\.jsonl)(?:#${CITATION_FRAGMENT})?`

/** One alternation over everything this module links; the named group says which one matched. */
function linkPattern(slug: string, flags: string, whole = false): RegExp {
  const body = `(?<path>${pathPattern(slug)})|(?<doc>${DOC_CITATION})|(?<job>${JOB_CITATION})`
  return new RegExp(whole ? `^(?:${body})$` : body, flags)
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** The opening `<a …>` for one match of {@link linkPattern}. */
function openingAnchor(match: RegExpExecArray, slug: string): string {
  const groups = match.groups ?? {}
  if (groups.doc !== undefined) {
    const fragment = groups.docFragment === undefined ? '' : `#${groups.docFragment}`
    const href = `https://github.com/${groups.owner}/${groups.name}/blob/${groups.sha}/${groups.docPath}${fragment}`
    return `<a href="${escapeAttribute(href)}" target="_blank" rel="noopener noreferrer">`
  }
  if (groups.job !== undefined) return `<a href="${escapeAttribute(`/${slug}/fleet/jobs/${groups.jobId}`)}">`
  return `<a href="${match[0]}">`
}

/** The whole text is exactly one linkable path or citation for this slug? Then its opening anchor, else null. */
function wholeLink(text: string, slug: string): string | null {
  const match = linkPattern(slug, '', true).exec(text)
  return match === null ? null : openingAnchor(match, slug)
}

/** Linkifies the koda paths and knowledge citations that stand alone in one run of text. */
function linkifyText(text: string, slug: string): string {
  const pattern = linkPattern(slug, 'g')
  let out = ''
  let last = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    const start = match.index
    const end = start + match[0].length
    const before = start === 0 ? '' : text[start - 1]
    const after = end >= text.length ? '' : text[end]
    if (CONTINUES_PATH.test(before) || CONTINUES_PATH.test(after)) continue
    out += `${text.slice(last, start)}${openingAnchor(match, slug)}${match[0]}</a>`
    last = end
  }
  return out + text.slice(last)
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
