import DOMPurify from 'isomorphic-dompurify'
import { marked } from 'marked'
import { escapeHtml } from './escape-html'

export { escapeHtml }

const ALLOWED_TAGS = [
  'a', 'b', 'blockquote', 'br', 'code', 'del', 'div', 'em', 'h1', 'h2', 'h3',
  'h4', 'h5', 'h6', 'hr', 'i', 'img', 'ins', 'kbd', 'li', 'mark', 'ol', 'p',
  'pre', 's', 'span', 'strong', 'sub', 'sup', 'table', 'tbody', 'td', 'th',
  'thead', 'tr', 'ul',
]

const ALLOWED_ATTR = [
  'class', 'href', 'title', 'alt', 'src', 'width', 'height',
  'colspan', 'rowspan', 'scope', 'start', 'rel', 'target',
]

const ALLOWED_URI_REGEXP = /^(?:(?:https?|mailto):|#|\/)/i

/**
 * #289: DOMPurify tests every attribute outside its URI-safe list against ALLOWED_URI_REGEXP, so
 * these plain-value attributes (`_blank`, `noopener noreferrer`, `3`) were silently dropped. They
 * never hold a URL, so they skip the URI test; `href` and `src` still take it.
 */
const URI_SAFE_ATTR = ['rel', 'target', 'colspan', 'rowspan', 'scope', 'start', 'width', 'height']

const LANGUAGE_CLASS = /^language-[\w-]+$/

/**
 * `class` is kept only on <code> with a single `language-*` token (syntax
 * highlighting), and on <span> as exactly `mention-chip` (S4a @mention chips).
 * Anything else, e.g. `fixed inset-0`, could restyle page chrome from user content.
 */
export function keepClassAttribute(tagName: string, value: string): boolean {
  const tag = tagName.toLowerCase()
  const trimmed = value.trim()
  if (tag === 'code') return LANGUAGE_CLASS.test(trimmed)
  return tag === 'span' && trimmed === 'mention-chip'
}

/** Attributes that skip the URI test only because they are numbers; anything else is dropped. */
const NUMERIC_ATTR = new Set(['colspan', 'rowspan', 'start', 'width', 'height'])
const SMALL_NUMBER = /^\d{1,4}$/

DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
  if (NUMERIC_ATTR.has(data.attrName)) {
    if (!SMALL_NUMBER.test(data.attrValue)) data.keepAttr = false
    return
  }
  if (data.attrName !== 'class') return
  if (!keepClassAttribute(node.nodeName, data.attrValue)) data.keepAttr = false
})

/**
 * A link may only open a new tab, and one that does never gets a handle on this page (tab-nabbing):
 * `target` survives only as `_blank` on <a>, which forces `rel`; without it `rel` has no use and goes.
 */
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  const newTab = node.nodeName.toLowerCase() === 'a' && node.getAttribute('target') === '_blank'
  if (newTab) {
    node.setAttribute('rel', 'noopener noreferrer')
    return
  }
  node.removeAttribute('target')
  node.removeAttribute('rel')
})


/**
 * M24: never throws and never returns unsanitized HTML. `breaks` keeps a single typed newline as a
 * `<br>`; a one-argument caller gets marked's default (`false`) and renders exactly as before.
 */
export function renderMarkdownOrEscape(markdown: string, options: { breaks?: boolean } = {}): string {
  if (!markdown) return ''
  try {
    return renderSafeMarkdown(markdown, options)
  } catch {
    return `<p>${escapeHtml(markdown)}</p>`
  }
}

function sanitizeHtml(dirty: string): string {
  return DOMPurify.sanitize(dirty, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
    ALLOWED_URI_REGEXP,
    ADD_URI_SAFE_ATTR: URI_SAFE_ATTR,
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button'],
    FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'style'],
  })
}

export function renderSafeMarkdown(markdown: string, options: { breaks?: boolean } = {}): string {
  if (!markdown) return ''
  const rendered = marked.parse(markdown, { async: false, breaks: options.breaks === true }) as string
  return sanitizeHtml(rendered)
}

export function sanitizeHtmlFragment(html: string): string {
  return sanitizeHtml(html)
}

/** Every `<img …>` element, case-insensitively, with or without a trailing slash or attributes. */
const IMG_TAG = /<img\b[^>]*>/gi

/**
 * US-002: markdown that may be rendered for anyone — a comment can be written by an agent (MCP,
 * fleet), so it must never make the browser fetch a URL. The same rule `renderThreadMarkdown`
 * applies to thread messages: the shared sanitizer, then every image removed.
 *
 * The second sanitize is not optional. Stripping an `img` tag with a regex over *serialized* HTML
 * can end an attribute early — a link `title` holding `<img b=` swallows the anchor's own `>` — so
 * the text after it re-parses as attributes of that element. A string that re-parses with a live
 * handler attribute must not reach `v-html`, and the sanitizer is what removes it.
 */
export function renderMarkdownWithoutImages(markdown: string, options: { breaks?: boolean } = {}): string {
  return sanitizeHtmlFragment(renderMarkdownOrEscape(markdown, options).replace(IMG_TAG, ''))
}
