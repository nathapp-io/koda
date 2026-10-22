import { describe, test, expect, jest } from '@jest/globals'
import * as Vue from 'vue'
import { ref } from 'vue'
import { createRequire } from 'node:module'
import { mountSfc, webFile, loadSfc } from '../helpers/mount-sfc'
import type { FakeNode } from '../helpers/mount-sfc'
import { uiStubs, i18nStub, toastRecorder, enI18n } from '../helpers/fleet-harness'
import type { ChatMessageDto, ThreadDetailDto } from '~/lib/thread-types'
import type { FleetRunnerSummary } from '~/lib/fleet-types'
import { projectPermissionsStub } from '../helpers/permission-nav'

/**
 * US-006 AC14-AC15: pages/[project]/threads/[id].vue — the thread detail page.
 *
 * The page is mounted with a stubbed useThread (the controller itself is covered by US-003)
 * but with the REAL ThreadHeader / ThreadTimeline / ThreadMessage components, so the page's
 * wiring — the pieces it hands each component and the running-turn tab title — is what the
 * assertions pin. Assistant content goes through the real markdown chain (mocked marked and
 * isomorphic-dompurify, as tests/lib/markdown.spec.ts does), and the 'Hi there' text is read
 * out of the v-html string with a real HTML parser rather than the fake renderer's tree.
 */

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

const requireFromVue = createRequire(require.resolve('vue'))
const compilerDom = requireFromVue('@vue/compiler-dom') as {
  parse: (html: string) => { children: unknown[] }
}

interface HtmlNode {
  type: number
  tag?: string
  children?: HtmlNode[]
  content?: string
}

/** The text of everything the page rendered through v-html (assistant markdown), parsed for real. */
function renderedHtmlText(app: { root: FakeNode }): string {
  const htmls: string[] = []
  const walk = (node: FakeNode): void => {
    if (typeof node.props.innerHTML === 'string') htmls.push(node.props.innerHTML as string)
    node.children.forEach(walk)
  }
  walk(app.root)
  const text = (node: HtmlNode): string =>
    node.type === 2 && node.content !== undefined
      ? node.content
      : (node.children ?? []).map(text).join('')
  return htmls.map(html => (compilerDom.parse(html).children as HtmlNode[]).map(text).join(' ')).join(' ')
}

const pageFile = webFile('pages', '[project]', 'threads', '[id].vue')

const threadDetail = (over: Record<string, unknown> = {}): ThreadDetailDto => ({
  id: 'th1',
  repoId: 'r1',
  baseRef: 'main',
  feature: 'add-auth',
  title: 'Auth spec',
  createdById: 'u1',
  runnerId: 'r1',
  backend: { kind: 'native', model: 'gpt-5' },
  status: 'ACTIVE',
  archivedAt: null,
  skills: [],
  maxCostUsd: '5',
  costUsd: '0',
  tokens: null,
  specPath: '.nax/features/add-auth/prd.json',
  pendingQuestion: null,
  session: null,
  lastActivityAt: '2026-10-14T00:00:00.000Z',
  createdAt: '2026-10-14T00:00:00.000Z',
  activeJob: null,
  sendRefusal: null,
  writtenPaths: [],
  publishedSha: null,
  specPublished: false,
  lastWrite: null,
  handoff: { plan: null, run: null },
  ...over,
})

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

interface CapturedHead {
  title?: unknown
}

/**
 * Mounts the page with a stubbed useThread (US-003 covers the controller) and the real thread
 * components registered under the names the page binds. useHead is captured the same way
 * fleet-approval-badge.spec.ts does, so the running-turn title is observable.
 */
function mountPage(over: {
  thread?: ThreadDetailDto
  messages?: ChatMessageDto[]
  runners?: FleetRunnerSummary[]
  job?: Record<string, unknown> | null
} = {}) {
  const thread = ref(over.thread ?? threadDetail())
  const messages = ref(over.messages ?? [])
  const runners = ref(over.runners ?? [])
  let head: CapturedHead = {}
  const jobs = ref({ plan: null, run: over.job as never ?? null })
  const reloadThread = jest.fn(async () => undefined)
  const refreshJob = jest.fn(async () => undefined)
  const useThreadHandoffJobs = jest.fn(() => ({ jobs, sync: jest.fn(async () => undefined), refreshJob, isHandoffJob: (id: string) => id === 'r1' }))
  const useProjectEvents = jest.fn()
  // The real thread components under both the contract names (explicit imports) and the Nuxt
  // auto-import names a sub-directory component receives, so the page's wiring is what a test sees.
  const header = loadSfc(webFile('components', 'fleet', 'threads', 'ThreadHeader.vue'), { useI18n: () => i18nStub() })
  const timeline = loadSfc(webFile('components', 'fleet', 'threads', 'ThreadTimeline.vue'), { useI18n: () => i18nStub() })
  const threadMessage = loadSfc(webFile('components', 'fleet', 'threads', 'ThreadMessage.vue'), { useI18n: () => i18nStub() })
  const toolChip = loadSfc(webFile('components', 'fleet', 'threads', 'ThreadToolChip.vue'), { useI18n: () => i18nStub() })
  const questionCard = loadSfc(webFile('components', 'fleet', 'threads', 'ThreadQuestionCard.vue'), { useI18n: () => i18nStub() })
  const jobCard = loadSfc(webFile('components', 'fleet', 'threads', 'ThreadJobCard.vue'), { useI18n: () => i18nStub() })
  // US-008: the project-code notice is mounted by the page itself, so the real component (not a
  // stub) is what AC-6 asserts on.
  const projectCodeNotice = loadSfc(webFile('components', 'fleet', 'threads', 'ThreadProjectCodeNotice.vue'), { useI18n: () => enI18n() })
  const app = mountSfc(pageFile, {
    components: {
      ...uiStubs,
      FleetThreadsThreadProjectCodeNotice: projectCodeNotice,
      ThreadHeader: header,
      FleetThreadsThreadHeader: header,
      ThreadTimeline: timeline,
      FleetThreadsThreadTimeline: timeline,
      ThreadMessage: threadMessage,
      FleetThreadsThreadMessage: threadMessage,
      ThreadToolChip: toolChip,
      FleetThreadsThreadToolChip: toolChip,
      ThreadQuestionCard: questionCard,
      FleetThreadsThreadQuestionCard: questionCard,
      ThreadJobCard: jobCard,
      FleetThreadsThreadJobCard: jobCard,
    },
    globals: {
      definePageMeta: () => undefined,
      useI18n: () => i18nStub(),
      useAppToast: () => toastRecorder(),
      useRoute: () => ({ params: { project: 'web', id: 'th1' } }),
      useAuth: () => ({ user: ref({ id: 'u1', email: 'owner@k.t', role: 'MEMBER' }) }),
      useThread: () => ({
        thread,
        messages,
        live: ref(true),
        load: jest.fn(async () => undefined),
        start: jest.fn(),
        stop: jest.fn(),
        reloadThread,
      }),
      useThreadHandoffJobs,
      useProjectEvents,
      useHead: (value: unknown) => {
        Vue.watchEffect(() => {
          head = (typeof value === 'function' ? value() : value) as CapturedHead
        })
      },
      useFleetDispatchOptions: () => ({
        runners,
        load: jest.fn(async () => undefined),
        repos: ref([]),
        moreRepos: ref(false),
        moreRunners: ref(false),
        profileOptions: ref([]),
        labelOptions: ref([]),
        repoName: (id: string) => id,
        runnerName: (id: string | null) => id,
      }),
      // Permissions P1 US-007: the page's archive-any control follows `thread.archive`.
      useProjectPermissions: () => projectPermissionsStub(['thread.archive']),
    },
  })
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 6; i += 1) {
      await new Promise((resolve) => { setImmediate(resolve) })
      await Vue.nextTick()
    }
  }
  return { app, settle, head: (): CapturedHead => head, useProjectEvents, reloadThread, refreshJob, jobs, useThreadHandoffJobs }
}

/** The resolved title useHead received: `title` may be a value or a function. */
function headTitle(head: CapturedHead): unknown {
  return typeof head.title === 'function' ? (head.title as () => unknown)() : head.title
}

describe('US-006 AC14-AC15: pages/[project]/threads/[id].vue', () => {
  test('AC14: with a stubbed useThread holding t and one assistant message Hi there, ThreadHeader shows the title Auth spec and ThreadTimeline shows Hi there', async () => {
    const m = mountPage({ messages: [message({ content: 'Hi there' })] })
    await m.settle()

    expect(m.app.text()).toContain('Auth spec')
    expect(renderedHtmlText(m.app)).toContain('Hi there')
    m.app.unmount()
  })

  test('US-005 AC-11: a fleet event for a handoff job reloads the thread', async () => {
    const m = mountPage()
    const handlers = m.useProjectEvents.mock.calls[0]?.[1] as { onFleetJob: (event: { jobId: string }) => void }
    handlers.onFleetJob({ jobId: 'r1' })
    expect(m.reloadThread).toHaveBeenCalledTimes(1)
    expect(m.refreshJob).toHaveBeenCalledWith('r1')
    m.app.unmount()
  })

  test('US-005 AC-12: an unrelated fleet event is ignored', async () => {
    const m = mountPage()
    const handlers = m.useProjectEvents.mock.calls[0]?.[1] as { onFleetJob: (event: { jobId: string }) => void }
    handlers.onFleetJob({ jobId: 'zz' })
    expect(m.reloadThread).not.toHaveBeenCalled()
    expect(m.refreshJob).not.toHaveBeenCalled()
    m.app.unmount()
  })

  test('US-005 AC-13: project stream resync reloads the thread', async () => {
    const m = mountPage()
    const handlers = m.useProjectEvents.mock.calls[0]?.[1] as { onResync: () => void }
    handlers.onResync()
    expect(m.reloadThread).toHaveBeenCalledTimes(1)
    m.app.unmount()
  })

  test('US-005 AC-14: the loaded RUN detail renders its workflow outcome in the thread card', async () => {
    const run = { id: 'r1', state: 'RUNNING', queuedAt: '2026-10-14T00:00:00.000Z', costSpentUsd: '0', workflow: { runId: 'n1', outcome: 'draft', workflowPassed: false, reasons: [], openItems: [] } }
    const m = mountPage({
      thread: threadDetail({ handoff: { plan: null, run: { jobId: 'r1', state: 'RUNNING', stateReason: null } } }),
      job: run,
    })
    await m.settle()
    expect(m.app.one('[data-testid="thread-job-card-outcome"]')).toBeDefined()
    expect(m.app.text()).toContain('fleet.jobs.workflow.outcome.draft')
    m.app.unmount()
  })

  test('AC15: the page sets the document title to • Auth spec while a held message is streaming', async () => {
    const m = mountPage({ messages: [message({ status: 'streaming' })] })
    await m.settle()

    expect(headTitle(m.head())).toBe('• Auth spec')
    m.app.unmount()
  })

  test('US-008 AC-6: a PROJECT thread whose live session reports projectCodeUnavailableOn renders the project-code notice', async () => {
    const m = mountPage({
      thread: threadDetail({
        kind: 'PROJECT',
        session: {
          jobId: 'j1', state: 'live', resumed: false, contextReset: false, reason: null, at: '',
          projectCodeUnavailableOn: 'wk-mac',
        },
      }),
    })
    await m.settle()

    const notice = m.app.one('[data-testid="thread-project-code-notice"]')
    expect(notice).toBeDefined()
    expect(notice === undefined ? null : m.app.textOf(notice)).toContain('wk-mac')
    m.app.unmount()
  })
})