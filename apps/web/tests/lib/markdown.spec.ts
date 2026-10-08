import { describe, test, expect, jest } from '@jest/globals'

jest.mock('marked', () => {
  function renderMarkdown(input: string): string {
    // Minimal markdown-to-HTML stub that handles the constructs our tests exercise.
    // It intentionally does NOT sanitize — the point of these tests is that
    // the sanitizer strips dangerous tags/attributes that the markdown layer
    // produces (or that are embedded directly in raw HTML).
    const md = String(input ?? '')
    return md
      .replace(/^### (.*)$/gm, '<h3>$1</h3>')
      .replace(/^## (.*)$/gm, '<h2>$1</h2>')
      .replace(/^# (.*)$/gm, '<h1>$1</h1>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*]+)\*([^*]|$)/g, '$1<em>$2</em>$3')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
      .replace(/^- (.*)$/gm, '<li>$1</li>')
      .replace(/(<li>[^<]*<\/li>\n?)+/g, '<ul>$&</ul>')
      .replace(/^(?!<[a-z])(.*\S.*)$/gm, '<p>$1</p>')
  }

  return {
    __esModule: true,
    marked: {
      parse: (input: string, _opts?: unknown) => renderMarkdown(input),
    },
  }
})

jest.mock('isomorphic-dompurify', () => {
  const FORBID_TAGS = new Set(['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button'])
  const ALLOWED_URI_REGEXP = /^(?:(?:https?|mailto):|#|\/)/i
  const stripAttrs = ['onerror', 'onload', 'onclick', 'onmouseover', 'style']

  function sanitizeHtml(dirty: string): string {
    let result = String(dirty ?? '')

    // Strip forbidden tags entirely (opening + content + closing).
    for (const tag of FORBID_TAGS) {
      const re = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, 'gi')
      result = result.replace(re, '')
      // Self-closing forms too.
      const self = new RegExp(`<${tag}\\b[^>]*\\/?>`, 'gi')
      result = result.replace(self, '')
    }

    // Strip dangerous attributes (on*= and style) anywhere they appear.
    for (const attr of stripAttrs) {
      const re = new RegExp(`\\s+${attr}\\s*=\\s*"[^"]*"`, 'gi')
      result = result.replace(re, '')
      const re2 = new RegExp(`\\s+${attr}\\s*=\\s*'[^']*'`, 'gi')
      result = result.replace(re2, '')
    }

    // Neutralize javascript: / data:text/html URLs in href/src.
    result = result.replace(/(href|src)\s*=\s*"([^"]*)"/gi, (_m, attr: string, val: string) => {
      const safe = ALLOWED_URI_REGEXP.test(val) ? val : ''
      return `${attr}="${safe}"`
    })
    result = result.replace(/(href|src)\s*=\s*'([^']*)'/gi, (_m, attr: string, val: string) => {
      const safe = ALLOWED_URI_REGEXP.test(val) ? val : ''
      return `${attr}='${safe}'`
    })

    return result
  }

  return {
    __esModule: true,
    default: {
      sanitize: (dirty: string, _opts?: unknown) => sanitizeHtml(dirty),
      addHook: jest.fn(),
    },
  }
})

import DOMPurify from 'isomorphic-dompurify'
import {
  renderSafeMarkdown,
  sanitizeHtmlFragment,
  escapeHtml,
  renderMarkdownOrEscape,
  keepClassAttribute,
} from '../../lib/markdown'
import { marked } from 'marked'

describe('renderSafeMarkdown - basic rendering', () => {
  test('returns empty string for empty input', () => {
    expect(renderSafeMarkdown('')).toBe('')
  })

  test('renders plain text wrapped in a paragraph', () => {
    const html = renderSafeMarkdown('hello world')
    expect(html).toContain('<p>hello world</p>')
  })

  test('renders headings, lists, and emphasis', () => {
    const md = '# Title\n\n- one\n- two\n\n**bold** and *italic*'
    const html = renderSafeMarkdown(md)
    expect(html).toContain('<h1>Title</h1>')
    expect(html).toContain('<li>one</li>')
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('<em>italic</em>')
  })
})

describe('renderSafeMarkdown - stored XSS sanitization (WEB-01)', () => {
  test('strips <script> tags from rendered markdown', () => {
    const html = renderSafeMarkdown('hello <script>alert(1)</script> world')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('alert(1)')
  })

  test('strips <img> onerror handler', () => {
    const html = renderSafeMarkdown('<img src="x" onerror="alert(1)">')
    expect(html).not.toContain('onerror')
    expect(html).not.toContain('alert(1)')
  })

  test('strips inline event handlers in raw HTML', () => {
    const html = renderSafeMarkdown('<a href="x" onclick="alert(1)">click</a>')
    expect(html).not.toContain('onclick')
    expect(html).not.toContain('alert(1)')
  })

  test('strips <iframe>, <object>, <embed>, <form> tags', () => {
    expect(renderSafeMarkdown('<iframe src="evil"></iframe>')).not.toContain('<iframe')
    expect(renderSafeMarkdown('<object data="x"></object>')).not.toContain('<object')
    expect(renderSafeMarkdown('<embed src="x">')).not.toContain('<embed')
    expect(renderSafeMarkdown('<form><input></form>')).not.toContain('<form')
    expect(renderSafeMarkdown('<form><input></form>')).not.toContain('<input')
  })

  test('neutralizes javascript: URLs in <a href>', () => {
    const html = renderSafeMarkdown('[click](javascript:alert(1))')
    expect(html.toLowerCase()).not.toContain('javascript:')
  })

  test('preserves safe http(s) and relative links', () => {
    const httpHtml = renderSafeMarkdown('[link](https://example.com)')
    expect(httpHtml).toContain('href="https://example.com"')
    const relHtml = renderSafeMarkdown('[link](/relative)')
    expect(relHtml).toContain('href="/relative"')
  })

  test('strips style attribute (CSS-based attacks)', () => {
    const html = renderSafeMarkdown('<p style="background:url(javascript:alert(1))">x</p>')
    expect(html.toLowerCase()).not.toContain('javascript:')
  })

  test('drops data: URIs in img src to prevent data exfiltration', () => {
    const html = renderSafeMarkdown('<img src="data:text/html,<script>alert(1)</script>">')
    expect(html.toLowerCase()).not.toContain('data:text/html')
    expect(html).not.toContain('<script')
  })
})

describe('sanitizeHtmlFragment', () => {
  test('returns empty string unchanged behavior is no-op', () => {
    expect(sanitizeHtmlFragment('')).toBe('')
  })

  test('strips dangerous tags from raw HTML input', () => {
    const result = sanitizeHtmlFragment('<div>safe</div><script>alert(1)</script>')
    expect(result).toContain('<div>safe</div>')
    expect(result).not.toContain('<script')
  })
})

describe('escapeHtml', () => {
  test('escapes every HTML-significant character', () => {
    expect(escapeHtml(`<img src=x onerror="a('b')">&`)).toBe('&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;')
  })
})

describe('renderMarkdownOrEscape (M24)', () => {
  test('returns the sanitized render when rendering succeeds', () => {
    expect(renderMarkdownOrEscape('**hi**')).toContain('hi')
  })

  test('returns escaped text in a <p> when the renderer throws', () => {
    const spy = jest.spyOn(marked, 'parse').mockImplementationOnce(() => { throw new Error('boom') })
    expect(renderMarkdownOrEscape('<script>alert(1)</script>')).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>')
    spy.mockRestore()
  })

  test('returns an empty string for empty input', () => {
    expect(renderMarkdownOrEscape('')).toBe('')
  })
})

describe('keepClassAttribute (sanitizer LOW)', () => {
  test.each([
    ['code', 'language-ts', true],
    ['code', 'language-c-sharp', true],
    ['code', 'fixed inset-0', false],
    ['code', 'language-ts fixed', false],
    ['div', 'language-ts', false],
    ['span', 'fixed inset-0 z-50', false],
    ['span', 'mention-chip', true],
    ['span', ' mention-chip ', true],
    ['span', 'mention-chip fixed', false],
    ['div', 'mention-chip', false],
  ])('<%s class="%s"> keep=%s', (tag, value, keep) => {
    expect(keepClassAttribute(tag, value)).toBe(keep)
  })

  test('is registered as an uponSanitizeAttribute hook', () => {
    const calls = (DOMPurify.addHook as jest.Mock).mock.calls
    const hook = calls.find(([name]) => name === 'uponSanitizeAttribute')?.[1]
    expect(hook).toBeDefined()
    const drop = { attrName: 'class', attrValue: 'fixed inset-0', keepAttr: true }
    hook({ nodeName: 'DIV' }, drop)
    expect(drop.keepAttr).toBe(false)
    const keep = { attrName: 'class', attrValue: 'language-ts', keepAttr: true }
    hook({ nodeName: 'CODE' }, keep)
    expect(keep.keepAttr).toBe(true)
  })
})
