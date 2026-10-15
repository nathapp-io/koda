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
 * Text inside an existing link or a fenced code block is left alone; an inline code span whose
 * whole text is one of the paths is wrapped, code element and all.
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

/** The whole text is exactly one koda path for this slug? Then that path, else null. */
function wholePath(text: string, slug: string): string | null {
  return new RegExp(`^${pathPattern(slug)}$`).test(text) ? text : null
}

function anchor(path: string): string {
  return `<a href="${path}">${path}</a>`
}

/** Linkifies the koda paths that stand alone in one run of text. */
function linkifyText(text: string, slug: string): string {
  const pattern = new RegExp(pathPattern(slug), 'g')
  let out = ''
  let last = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    const start = match.index
    const end = start + match[0].length
    const before = start === 0 ? '' : text[start - 1]
    const after = end >= text.length ? '' : text[end]
    if (CONTINUES_PATH.test(before) || CONTINUES_PATH.test(after)) continue
    out += text.slice(last, start) + anchor(match[0])
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

/** Rewrites the standalone koda paths of already-sanitized HTML into links. */
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
      const path = content !== undefined && !content.startsWith('<') ? wholePath(content, slug) : null
      if (path !== null && isClosingTag(tokens[index + 2], 'code')) {
        out.push(`<a href="${path}">`, token, content, tokens[index + 2], '</a>')
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
