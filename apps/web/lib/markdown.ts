import DOMPurify from 'isomorphic-dompurify'
import { marked } from 'marked'

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
