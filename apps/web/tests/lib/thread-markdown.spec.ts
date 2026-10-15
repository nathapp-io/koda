import { describe, test, expect, jest } from '@jest/globals'
import { createRequire } from 'node:module'

/**
 * US-006 AC1-AC8: `renderThreadMarkdown(content, slug)` turns the koda paths the knowledge tools
 * emit into links.
 *
 * The two heavyweight renderer packages jest cannot load (marked, isomorphic-dompurify) are
 * replaced by doubles, as tests/lib/markdown.spec.ts does; this one adds markdown-image rules and
 * inline/fenced code rules so the code-span link and the fenced-code skip are really exercised.
 * The HTML the renderer produced is asserted with a real parser (@vue/compiler-dom), so these are
 * element-tree assertions (an `a` wrapping a `code`), not substring checks.
 */

jest.mock('marked', () => {
  const escapeCode = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;')

  function renderMarkdown(input: string): string {
    const md = String(input ?? '')
    const codeSpans: string[] = []
    const blocks: string[] = []
    let html = md
      // Fenced code first, behind a placeholder, so neither the rules below nor the paragraph
      // wrapper touch its content (real marked emits the block as-is).
      .replace(/^```[^\n]*\n([\s\S]*?)```/gm, (_m, code: string) => {
        blocks.push(`<pre><code>${escapeCode(code)}</code></pre>`)
        return `@@BLOCK${blocks.length - 1}@@`
      })
      // Inline code through a placeholder, so the rules below cannot rewrite its content.
      .replace(/`([^`]+)`/g, (_m, code: string) => {
        codeSpans.push(code)
        return `@@CODE${codeSpans.length - 1}@@`
      })
      .replace(/^### (.*)$/gm, '<h3>$1</h3>')
      .replace(/^## (.*)$/gm, '<h2>$1</h2>')
      .replace(/^# (.*)$/gm, '<h1>$1</h1>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*]+)\*([^*]|$)/g, '$1<em>$2</em>$3')
      .replace(/!\[([^\]]+)\]\(([^)]+)\)/g, '<img src="$2" alt="$1">')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
      .replace(/^- (.*)$/gm, '<li>$1</li>')
      .replace(/(<li>[^<]*<\/li>\n?)+/g, '<ul>$&</ul>')
      .replace(/^(?!<[a-z])(.*\S.*)$/gm, '<p>$1</p>')
    html = html
      .replace(/(?:<p>\s*)?@@BLOCK(\d+)@@(?:\s*<\/p>)?/g, (_m, index: string) => blocks[Number(index)])
      .replace(/@@CODE(\d+)@@/g, (_m, index: string) => `<code>${escapeCode(codeSpans[Number(index)])}</code>`)
    return html
  }

  return { __esModule: true, marked: { parse: (input: string) => renderMarkdown(input) } }
})

jest.mock('isomorphic-dompurify', () => {
  const FORBID_TAGS = new Set(['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button'])
  const ALLOWED_URI_REGEXP = /^(?:(?:https?|mailto):|#|\/)/i
  const stripAttrs = ['onerror', 'onload', 'onclick', 'onmouseover', 'style']

  function sanitizeHtml(dirty: string): string {
    let result = String(dirty ?? '')
    for (const tag of FORBID_TAGS) {
      result = result.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, 'gi'), '')
      result = result.replace(new RegExp(`<${tag}\\b[^>]*\\/?>`, 'gi'), '')
    }
    for (const attr of stripAttrs) {
      result = result.replace(new RegExp(`\\s+${attr}\\s*=\\s*"[^"]*"`, 'gi'), '')
      result = result.replace(new RegExp(`\\s+${attr}\\s*=\\s*'[^']*'`, 'gi'), '')
    }
    // A href/src that is not http(s), mailto, a fragment or root-relative is emptied.
    result = result.replace(/(href|src)\s*=\s*"([^"]*)"/gi, (_m, attr: string, val: string) => {
      const safe = ALLOWED_URI_REGEXP.test(val) ? val : ''
      return `${attr}="${safe}"`
    })
    return result
  }

  return {
    __esModule: true,
    default: { sanitize: jest.fn((dirty: string) => sanitizeHtml(dirty)), addHook: jest.fn() },
  }
})

import { renderThreadMarkdown } from '../../lib/thread-markdown'
import DOMPurify from 'isomorphic-dompurify'

/** The sanitizer double, so a test can see how often (and with what) the module sanitizes. */
const sanitizeDouble = DOMPurify.sanitize as unknown as jest.Mock

// ── a real HTML parser, so the assertions are about elements, not substrings ──────────────────

const requireFromVue = createRequire(require.resolve('vue'))
const compilerDom = requireFromVue('@vue/compiler-dom') as {
  parse: (html: string) => { children: unknown[] }
}

interface HtmlNode {
  type: number
  tag?: string
  props?: Array<{ name?: string; value?: { content?: string } | string }>
  children?: HtmlNode[]
  content?: string
}

interface HtmlElement {
  tag: string
  attrs: Record<string, string>
  /** Text of this node when it is a text node; '' for an element. */
  text: string
  children: HtmlElement[]
}

function attributeValue(prop: { value?: { content?: string } | string }): string {
  if (typeof prop.value === 'string') return prop.value
  return prop.value?.content ?? ''
}

function buildTree(nodes: HtmlNode[]): HtmlElement[] {
  return nodes.flatMap((node) => {
    if (node.type === 2) return [{ tag: '#text', attrs: {}, text: node.content ?? '', children: [] }]
    if (node.type !== 1 || !node.tag) return []
    const attrs = Object.fromEntries((node.props ?? []).map(prop => [prop.name ?? '', attributeValue(prop)]))
    return [{ tag: node.tag, attrs, text: '', children: buildTree(node.children ?? []) }]
  })
}

/** The element/text tree of one HTML string. */
function treeOf(html: string): HtmlElement[] {
  return buildTree(compilerDom.parse(html).children as HtmlNode[])
}

/** Every element of the tree, depth-first. */
function flatten(elements: HtmlElement[]): HtmlElement[] {
  return elements.flatMap(element => [element, ...flatten(element.children)])
}

const elementsOf = (html: string, tag: string): HtmlElement[] =>
  flatten(treeOf(html)).filter(element => element.tag === tag)

/** Every element of one already-parsed tree, so ancestry can be compared by identity. */
const elementsOfTree = (tree: HtmlElement[], tag: string): HtmlElement[] =>
  flatten(tree).filter(element => element.tag === tag)

const textOf = (element: HtmlElement): string => element.text + element.children.map(textOf).join('')

/** Every attribute name of every element of a tree. */
const attributeNames = (tree: HtmlElement[]): string[] =>
  flatten(tree).flatMap(element => Object.keys(element.attrs))

// ── US-006 AC1-AC8 ───────────────────────────────────────────────────────────────────────────

describe('US-006 AC1-AC8: renderThreadMarkdown links koda ticket and job paths', () => {
  test('AC1: a plain ticket path in the text becomes a link to that path with that path as its text', () => {
    const html = renderThreadMarkdown('see /sandbox/tickets/SB-3 now', 'sandbox')

    const links = elementsOf(html, 'a')
    expect(links).toHaveLength(1)
    expect(links[0].attrs.href).toBe('/sandbox/tickets/SB-3')
    expect(textOf(links[0])).toBe('/sandbox/tickets/SB-3')
  })

  test('AC2: a plain job path becomes a link to that path', () => {
    const html = renderThreadMarkdown('job /sandbox/fleet/jobs/cmv9h6bqq000508tn60pd189y', 'sandbox')

    const links = elementsOf(html, 'a')
    expect(links).toHaveLength(1)
    expect(links[0].attrs.href).toBe('/sandbox/fleet/jobs/cmv9h6bqq000508tn60pd189y')
  })

  test('AC3: an inline code span whose whole text is a ticket path sits inside a link to that path', () => {
    const html = renderThreadMarkdown('run `/sandbox/tickets/SB-3` next', 'sandbox')

    const tree = treeOf(html)
    const links = elementsOfTree(tree, 'a')
    expect(links).toHaveLength(1)
    expect(links[0].attrs.href).toBe('/sandbox/tickets/SB-3')

    const code = elementsOfTree(tree, 'code')
    expect(code).toHaveLength(1)
    expect(textOf(code[0])).toBe('/sandbox/tickets/SB-3')
    expect(flatten(links[0].children)).toContain(code[0])
  })

  test('AC4: a path with another slug stays plain text', () => {
    const html = renderThreadMarkdown('/other/tickets/SB-3', 'sandbox')

    expect(elementsOf(html, 'a')).toEqual([])
    expect(html).toContain('/other/tickets/SB-3')
  })

  test('AC5: a ticket path inside a fenced code block stays plain text', () => {
    const html = renderThreadMarkdown('```\n/sandbox/tickets/SB-3\n```', 'sandbox')

    expect(elementsOf(html, 'pre')).toHaveLength(1)
    expect(elementsOf(html, 'a')).toEqual([])
    expect(html).toContain('/sandbox/tickets/SB-3')
  })

  test('AC6: a markdown link to the path is not linkified a second time', () => {
    const html = renderThreadMarkdown('[x](/sandbox/tickets/SB-3)', 'sandbox')

    const links = elementsOf(html, 'a')
    expect(links).toHaveLength(1)
    expect(links[0].attrs.href).toBe('/sandbox/tickets/SB-3')
  })

  test('AC7: without a slug the output is unchanged (no link)', () => {
    const html = renderThreadMarkdown('see /sandbox/tickets/SB-3')

    expect(elementsOf(html, 'a')).toEqual([])
    expect(html).toContain('/sandbox/tickets/SB-3')
  })

  test('AC8: an img with an onerror handler is removed and the ticket path is still linked', () => {
    const html = renderThreadMarkdown('<img src=x onerror=alert(1)> /sandbox/tickets/SB-3', 'sandbox')
    const tree = treeOf(html)

    expect(elementsOfTree(tree, 'img')).toEqual([])
    expect(attributeNames(tree)).not.toContain('onerror')
    expect(html).not.toContain('onerror')
    const links = elementsOfTree(tree, 'a')
    expect(links).toHaveLength(1)
    expect(links[0].attrs.href).toBe('/sandbox/tickets/SB-3')
  })

  test('a markdown link label holding a path is not rewritten', () => {
    const html = renderThreadMarkdown('[/other/tickets/SB-3](/other/tickets/SB-3)', 'sandbox')

    expect(elementsOf(html, 'a')).toHaveLength(1)
    expect(textOf(elementsOf(html, 'a')[0])).toBe('/other/tickets/SB-3')
  })

  test('an absolute URL ending with the path is not linked', () => {
    const html = renderThreadMarkdown('https://koda.example/sandbox/tickets/SB-3', 'sandbox')

    expect(elementsOf(html, 'a')).toEqual([])
  })

  test('an inline code span holding more than the path is not linked', () => {
    const html = renderThreadMarkdown('`see /sandbox/tickets/SB-3`', 'sandbox')

    expect(elementsOf(html, 'a')).toEqual([])
    expect(elementsOf(html, 'code')).toHaveLength(1)
  })

  test('two paths in one line each become their own link', () => {
    const html = renderThreadMarkdown('/sandbox/tickets/SB-3 then /sandbox/fleet/jobs/cmv9h6bqq000508tn60pd189y', 'sandbox')

    expect(elementsOf(html, 'a').map(link => link.attrs.href)).toEqual([
      '/sandbox/tickets/SB-3',
      '/sandbox/fleet/jobs/cmv9h6bqq000508tn60pd189y',
    ])
  })

  test('a job id that is too short or has uppercase characters is not linked', () => {
    expect(elementsOf(renderThreadMarkdown('/sandbox/fleet/jobs/short', 'sandbox'), 'a')).toEqual([])
    expect(elementsOf(renderThreadMarkdown('/sandbox/fleet/jobs/CMV9H6BQQ000508TN60PD189Y', 'sandbox'), 'a')).toEqual([])
  })

  test('a path that continues into another segment is not linked', () => {
    expect(elementsOf(renderThreadMarkdown('/sandbox/tickets/SB-3/edit', 'sandbox'), 'a')).toEqual([])
  })

  test('the text beside the path is left exactly as it was', () => {
    const html = renderThreadMarkdown('see /sandbox/tickets/SB-3 now', 'sandbox')

    expect(html).toContain('see ')
    expect(html).toContain(' now')
  })
})

// ── B1 (branch review): the linkifier must not re-open markup it only meant to read ───────────
//
// The linkifier runs on the sanitizer's output string. `>` inside a *quoted attribute value* is
// data, never the end of the tag, and isomorphic-dompurify 2.36.0 (the production sanitizer)
// hands those bytes back unchanged — it escapes `&` and `"` in an attribute value, never `<`/`>`:
//
//   $ node -e "const DP = require('isomorphic-dompurify'); console.log(DP.sanitize('<span title=\"> /sandbox/tickets/SB-3 <svg onload=alert(1)>\">hello</span>'))"
//   <span title="> /sandbox/tickets/SB-3 <svg onload=alert(1)>">hello</span>
//
// Splitting the string at the first `>` after `<` therefore read that attribute value as text,
// re-linked the path inside it and turned `<svg onload=alert(1)>` into a real element. jest
// cannot load the real sanitizer (isomorphic-dompurify needs jsdom, whose ESM dependencies jest
// does not transform — every spec here replaces it, as tests/lib/markdown.spec.ts explains), so
// the double answers these inputs with exactly the bytes the real sanitizer returns: the case
// below asserts that byte-for-byte equivalence, which is what makes the double faithful here.
const REAL_SANITIZER_ATTACK_OUTPUT = '<span title="> /sandbox/tickets/SB-3 <svg onload=alert(1)>">hello</span>'
const REAL_SANITIZER_TEXT_NODE_OUTPUT = '<span title="a > b <svg onload=alert(1)>">see /sandbox/tickets/SB-3 now</span>'

describe('B1: a `>` inside a quoted attribute value is not a tag boundary', () => {
  test('the sanitizer double hands the linkifier exactly what the real sanitizer returns', () => {
    // No slug: the output is `renderMarkdownOrEscape`'s, byte for byte — the linkifier's input.
    expect(renderThreadMarkdown(REAL_SANITIZER_ATTACK_OUTPUT)).toBe(REAL_SANITIZER_ATTACK_OUTPUT)
    expect(renderThreadMarkdown(REAL_SANITIZER_TEXT_NODE_OUTPUT)).toBe(REAL_SANITIZER_TEXT_NODE_OUTPUT)
  })

  test('an attribute value holding a `>` and a tag-like string stays an attribute value', () => {
    const html = renderThreadMarkdown(REAL_SANITIZER_ATTACK_OUTPUT, 'sandbox')

    // The path in this input sits in an attribute, not a text node, so nothing is linked and the
    // output is the sanitizer's own bytes.
    expect(html).toBe(REAL_SANITIZER_ATTACK_OUTPUT)

    const tree = treeOf(html)

    expect(elementsOfTree(tree, 'svg')).toEqual([])
    expect(attributeNames(tree)).not.toContain('onload')
    expect(attributeNames(tree)).not.toContain('onerror')
    // The attribute text was not rewritten as markup: the span's title is unchanged and the path
    // inside it (it is not a text node) is not a link.
    expect(elementsOfTree(tree, 'span')[0].attrs.title).toBe('> /sandbox/tickets/SB-3 <svg onload=alert(1)>')
    expect(elementsOfTree(tree, 'a')).toEqual([])
  })

  test('a path in a real text node is still linked when an earlier attribute holds a `>`', () => {
    const html = renderThreadMarkdown(REAL_SANITIZER_TEXT_NODE_OUTPUT, 'sandbox')
    const tree = treeOf(html)

    expect(elementsOfTree(tree, 'svg')).toEqual([])
    expect(attributeNames(tree)).not.toContain('onload')
    expect(elementsOfTree(tree, 'span')[0].attrs.title).toBe('a > b <svg onload=alert(1)>')

    const links = elementsOfTree(tree, 'a')
    expect(links).toHaveLength(1)
    expect(links[0].attrs.href).toBe('/sandbox/tickets/SB-3')
    expect(textOf(links[0])).toBe('/sandbox/tickets/SB-3')
  })

  test('the rewritten HTML is sanitized again before it is rendered', () => {
    sanitizeDouble.mockClear()
    renderThreadMarkdown('see /sandbox/tickets/SB-3 now', 'sandbox')

    expect(sanitizeDouble).toHaveBeenCalledTimes(2)
    // The second pass is the final output, anchors included — not the source HTML.
    expect(sanitizeDouble.mock.calls[1][0]).toContain('<a href="/sandbox/tickets/SB-3">')
  })

  test('without a slug the output is sanitized once (the S5a behaviour is unchanged)', () => {
    sanitizeDouble.mockClear()
    renderThreadMarkdown('see /sandbox/tickets/SB-3 now')

    expect(sanitizeDouble).toHaveBeenCalledTimes(1)
  })
})
