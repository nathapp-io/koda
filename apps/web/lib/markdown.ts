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

DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
  if (data.attrName !== 'class') return
  if (!keepClassAttribute(node.nodeName, data.attrValue)) data.keepAttr = false
})


/** M24: never throws and never returns unsanitized HTML. */
export function renderMarkdownOrEscape(markdown: string): string {
  if (!markdown) return ''
  try {
    return renderSafeMarkdown(markdown)
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
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button'],
    FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'style'],
  })
}

export function renderSafeMarkdown(markdown: string): string {
  if (!markdown) return ''
  const rendered = marked.parse(markdown, { async: false }) as string
  return sanitizeHtml(rendered)
}

export function sanitizeHtmlFragment(html: string): string {
  return sanitizeHtml(html)
}
