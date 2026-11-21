import { describe, expect, test } from '@jest/globals'
import { createRequire } from 'node:module'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import type { FakeNode } from '../helpers/mount-sfc'
import { i18nStub, uiStubs } from '../helpers/fleet-harness'
import type { ChatMessageDto } from '~/lib/thread-types'

const requireFromVue = createRequire(require.resolve('vue'))
const compilerDom = requireFromVue('@vue/compiler-dom') as { parse: (html: string) => { children: HtmlNode[] } }

interface HtmlNode { type: number; tag?: string; children?: HtmlNode[]; content?: string }

const componentFile = webFile('components', 'fleet', 'threads', 'ThreadMessage.vue')
const message = (overrides: Partial<ChatMessageDto>): ChatMessageDto => ({
  id: 'm1', seq: 1, jobId: null, turnId: null, role: 'assistant', authorUserId: null,
  clientMessageId: null, content: '', toolSummary: null, status: 'complete', errorReason: null,
  usage: null, costUsd: null, costSource: null, createdAt: '2026-10-14T00:00:00.000Z', ...overrides,
})

function mountMessage(value: ChatMessageDto) {
  return mountSfc(componentFile, {
    props: { message: value }, components: uiStubs,
    alias: {
      '~/lib/thread-markdown': {
        renderThreadMarkdown: (content: string) => {
          const code = /^```(?:[a-zA-Z]*)\n([\s\S]*?)\n```$/.exec(content)
          return code ? `<pre><code>${code[1]}</code></pre>` : content
        },
      },
    },
    globals: { useI18n: () => i18nStub() },
  })
}

function descendants(node: HtmlNode): HtmlNode[] {
  return (node.children ?? []).flatMap(child => [child, ...descendants(child)])
}

function htmlElements(app: { root: FakeNode }): HtmlNode[] {
  const strings: string[] = []
  const visit = (node: FakeNode): void => {
    if (typeof node.props.innerHTML === 'string') strings.push(node.props.innerHTML)
    node.children.forEach(visit)
  }
  visit(app.root)
  return strings.flatMap(html => compilerDom.parse(html).children.flatMap(node => [node, ...descendants(node)]))
}

describe('US-003 ThreadMessage overflow and interpolation', () => {
  test('AC-1: assistant code block scrolls inside a constrained message root', () => {
    const line = 'x'.repeat(300)
    const app = mountMessage(message({ content: ['```ts', line, '```'].join('\n') }))
    const body = app.find('[data-testid="thread-message"]')[0]
    expect(body).toBeDefined()
    expect(String(body?.props.class)).toContain('min-w-0')
    expect(String(body?.props.class)).toContain('max-w-full')
    const assistantBody = app.root.children.flatMap(node => node.children).find(node => node.props.innerHTML !== undefined)
    expect(String(assistantBody?.props.class)).toContain('overflow-x-auto')
    expect(htmlElements(app).some(node => node.tag === 'pre')).toBe(true)
    app.unmount()
  })

  test('AC-2: user markup-looking content stays literal and constrained', () => {
    const app = mountMessage(message({ role: 'user', content: '<b>literal</b>' }))
    const body = app.find('[data-testid="thread-message"]')[0]
    expect(app.text()).toContain('<b>literal</b>')
    expect(app.find('b')).toHaveLength(0)
    expect(body?.props.class).toContain('min-w-0')
    expect(body?.props.class).toContain('max-w-full')
    app.unmount()
  })
})
