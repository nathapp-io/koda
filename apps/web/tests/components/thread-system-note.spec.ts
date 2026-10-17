import { describe, test, expect, jest } from '@jest/globals'
import { mountSfc, webFile, loadSfc } from '../helpers/mount-sfc'
import type { Mounted, FakeNode } from '../helpers/mount-sfc'
import { uiStubs, i18nStub } from '../helpers/fleet-harness'
import type { ChatMessageDto } from '~/lib/thread-types'

jest.mock('marked', () => {
  function renderMarkdown(input: string): string {
    const md = String(input ?? '')
    return md
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

  return { __esModule: true, default: { sanitize: (dirty: string) => sanitizeHtml(dirty), addHook: jest.fn() } }
})

const messageFile = webFile('components', 'fleet', 'threads', 'ThreadMessage.vue')

const message = (over: Record<string, unknown> = {}): ChatMessageDto => ({
  id: 'm1',
  seq: 1,
  jobId: 'j1',
  turnId: 't1',
  role: 'assistant',
  authorUserId: null,
  clientMessageId: null,
  content: '',
  toolSummary: null,
  status: 'complete',
  errorReason: null,
  usage: null,
  costUsd: null,
  costSource: null,
  createdAt: '2026-10-14T00:00:00.000Z',
  ...over,
})

function tagsIn(app: { root: FakeNode }, tag: string): FakeNode[] {
  const found: FakeNode[] = []
  const walk = (node: FakeNode): void => {
    if (node.tag === tag) found.push(node)
    node.children.forEach(walk)
  }
  walk(app.root)
  return found
}

function mountMessage(msg: ChatMessageDto): Mounted {
  const realMessage = loadSfc(messageFile, { useI18n: () => i18nStub() })
  return mountSfc(messageFile, {
    props: { message: msg },
    components: { ...uiStubs, ThreadMessage: realMessage, FleetThreadsThreadMessage: realMessage },
    globals: { useI18n: () => i18nStub() },
  })
}

describe('ThreadMessage with role system (US-006 AC-1 to AC-5)', () => {
  test('AC-1: renders a thread-system-note element', () => {
    const app = mountMessage(message({ role: 'system', content: 'System note content' }))

    const systemNotes = app.find('[data-testid="thread-system-note"]')
    expect(systemNotes.length).toBe(1)
  })

  test('AC-2: renders the fleet.threads.message.system label inside thread-system-note', () => {
    const app = mountMessage(message({ role: 'system', content: 'System note content' }))

    const systemNotes = app.find('[data-testid="thread-system-note"]')
    expect(systemNotes.length).toBe(1)

    const noteText = app.textOf(systemNotes[0])
    expect(noteText).toContain('fleet.threads.message.system')
  })

  test('AC-3: renders the message content inside thread-system-note', () => {
    const app = mountMessage(message({ role: 'system', content: 'My system message' }))

    const systemNotes = app.find('[data-testid="thread-system-note"]')
    expect(systemNotes.length).toBe(1)

    const noteText = app.textOf(systemNotes[0])
    expect(noteText).toContain('My system message')
  })

  test('AC-4: with HTML content like "<b>x</b>" renders literal text, with no b element', () => {
    const app = mountMessage(message({ role: 'system', content: '<b>x</b>' }))

    const systemNotes = app.find('[data-testid="thread-system-note"]')
    expect(systemNotes.length).toBe(1)

    const noteText = app.textOf(systemNotes[0])
    expect(noteText).toContain('<b>x</b>')

    const bElements = tagsIn(app, 'b')
    expect(bElements.length).toBe(0)
  })

  test('AC-5: with role user renders no thread-system-note element', () => {
    const app = mountMessage(message({ role: 'user', content: 'User message' }))

    const systemNotes = app.find('[data-testid="thread-system-note"]')
    expect(systemNotes.length).toBe(0)
  })
})
