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

  return { __esModule: true, default: { sanitize: (dirty: string) => sanitizeHtml(dirty), addHook: jest.fn() } }
})

import { renderThreadMarkdown } from '../../lib/thread-markdown'

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

    expect(elementsOf(html, 'img')).toEqual([])
    expect(html).not.toContain('onerror')
    const links = elementsOf(html, 'a')
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
