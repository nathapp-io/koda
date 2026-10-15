/**
 * Fleet S5a B4-D1/D6 (US-006): the one piece of runner/agent text that reaches the DOM as HTML.
 *
 * Assistant thread message `content` renders through the shared sanitizer
 * (`renderMarkdownOrEscape`) and then every `img` element is removed, so agent-steered text
 * (repo content, prompt injection) can never make the browser fetch a URL. Links stay — they
 * need a click.
 *
 * Fleet S5b US-006 (1c-R2): the paths the knowledge tools emit (`/<slug>/tickets/<ref>`,
 * `/<slug>/fleet/jobs/<id>`) become links, given the project slug. Only the text of the
 * sanitized HTML is rewritten: the anchors this adds carry a path produced by a strict pattern,
 * never content-derived markup, so the sanitizer still runs first and nothing is re-parsed.
 * Text inside an existing link or a fenced code block is left alone; an inline code span whose
 * whole text is one of the paths is wrapped, code element and all.
 */

import { renderMarkdownOrEscape } from '~/lib/markdown'

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

/** Splits sanitized HTML into tag and text runs (`<` cannot appear inside a text run). */
function tokenize(html: string): string[] {
  const tokens: string[] = []
  let index = 0
  while (index < html.length) {
    const open = html.indexOf('<', index)
    if (open === -1) {
      tokens.push(html.slice(index))
      break
    }
    const close = html.indexOf('>', open)
    if (close === -1) {
      tokens.push(html.slice(index))
      break
    }
    if (open > index) tokens.push(html.slice(index, open))
    tokens.push(html.slice(open, close + 1))
    index = close + 1
  }
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
  return slug ? linkifyPaths(html, slug) : html
}
