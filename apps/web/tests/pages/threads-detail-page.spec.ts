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
  kind: 'REPO',
  mode: 'read',
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
  pendingApprovals: [],
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
  /** The caller's project permission keys (Permissions P1); the archive and mode gates read them. */
  permissions?: string[]
} = {}) {
  const thread = ref(over.thread ?? threadDetail())
  const messages = ref(over.messages ?? [])
  const runners = ref(over.runners ?? [])
  let head: CapturedHead = {}
  const jobs = ref({ plan: null, run: over.job as never ?? null })
  const reloadThread = jest.fn(async () => undefined)
  const refreshJob = jest.fn(async () => undefined)
  // thread-agents-modes US-012: the page binds the mode control and the approval cards to these two controller actions.
  const changeMode = jest.fn(async () => ({ ok: true }))
  const decideApproval = jest.fn(async () => ({ ok: true }))
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
  // US-012: the mode control and the approval cards are the page's own children, mounted for real.
  const modeControl = loadSfc(webFile('components', 'fleet', 'threads', 'ThreadModeControl.vue'), { useI18n: () => enI18n() })
  const approvalCard = loadSfc(webFile('components', 'fleet', 'threads', 'ThreadApprovalCard.vue'), { useI18n: () => enI18n() })
  const app = mountSfc(pageFile, {
    components: {
      ...uiStubs,
      FleetThreadsThreadProjectCodeNotice: projectCodeNotice,
      ThreadModeControl: modeControl,
      FleetThreadsThreadModeControl: modeControl,
      ThreadApprovalCard: approvalCard,
      FleetThreadsThreadApprovalCard: approvalCard,
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
        changeMode,
        decideApproval,
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
      // Permissions P1 US-007: the page's archive-any control follows `thread.archive`; US-012 adds
      // the three mode keys the REPO mode control is limited to.
      useProjectPermissions: () => projectPermissionsStub(over.permissions ?? ['thread.archive']),
    },
  })
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 6; i += 1) {
      await new Promise((resolve) => { setImmediate(resolve) })
      await Vue.nextTick()
    }
  }
  return { app, settle, head: (): CapturedHead => head, useProjectEvents, reloadThread, refreshJob, jobs, useThreadHandoffJobs, changeMode, decideApproval }
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
/**
 * thread-agents-modes US-012 AC-5, AC-10: the page's mode control and session approvals.
 *
 * The mode control is REPO-only (a PROJECT thread has no worktree to publish, so it is always
 * `read`; a WORKSPACE one is not even on this page), and its Full button follows `thread.mode.full`.
 * Approvals are a separate list from `pendingQuestion` and the assistant `pendingActions`: one card
 * per `pendingApprovals` entry, rendered by the page itself, decided through the controller.
 */

/** The permission keys a REPO thread's mode control is limited to (US-005), plus the decision key of its approvals. */
const MODE_KEYS = ['thread.archive', 'thread.cap.update', 'thread.mode.ask', 'thread.mode.full', 'thread.answer']

const approval = (over: Record<string, unknown> = {}) => ({
  requestId: 'req1',
  tool: 'bash',
  summary: 'Run the migration',
  command: 'bun run db:migrate',
  reason: 'The schema changed',
  expiresAt: '2026-10-14T10:10:00.000Z',
  ...over,
})

describe('US-012 AC-5, AC-10: pages/[project]/threads/[id].vue — mode control and approvals', () => {
  test('AC-5: a REPO thread renders ThreadModeControl', async () => {
    const m = mountPage({ thread: threadDetail({ kind: 'REPO' }), permissions: MODE_KEYS })
    await m.settle()

    expect(m.app.one('[data-testid="thread-mode"]')).toBeDefined()
    expect(m.app.one('[data-testid="thread-mode-ask"]')).toBeDefined()
    m.app.unmount()
  })

  test('AC-5 (control): a PROJECT thread renders no ThreadModeControl', async () => {
    const m = mountPage({ thread: threadDetail({ kind: 'PROJECT', repoId: null, baseRef: null, feature: null }), permissions: MODE_KEYS })
    await m.settle()

    expect(m.app.one('[data-testid="thread-mode"]')).toBeUndefined()
    expect(m.app.one('[data-testid="thread-mode-ask"]')).toBeUndefined()
    m.app.unmount()
  })

  test('AC-5 (permissions): Full is disabled on the page when the caller lacks thread.mode.full', async () => {
    const m = mountPage({
      thread: threadDetail({ kind: 'REPO' }),
      permissions: ['thread.cap.update', 'thread.mode.ask'],
    })
    await m.settle()

    expect(m.app.one('[data-testid="thread-mode-full"]')?.props.disabled).toBe(true)
    expect(m.app.one('[data-testid="thread-mode-ask"]')?.props.disabled).toBe(false)
    m.app.unmount()
  })

  test('AC-10: the page renders one ThreadApprovalCard per pendingApprovals entry', async () => {
    const m = mountPage({
      thread: threadDetail({
        pendingApprovals: [approval(), approval({ requestId: 'req2', tool: 'write_file', summary: 'Write docs/plan.md' })],
      }),
      permissions: MODE_KEYS,
    })
    await m.settle()

    const cards = m.app.find('[data-testid="thread-approval"]')
    expect(cards).toHaveLength(2)
    expect(m.app.text()).toContain('bun run db:migrate')
    expect(m.app.text()).toContain('Write docs/plan.md')
    m.app.unmount()
  })

  test('AC-10 (empty): no approval card is rendered when pendingApprovals is empty', async () => {
    const m = mountPage({ thread: threadDetail({ pendingApprovals: [] }), permissions: MODE_KEYS })
    await m.settle()

    expect(m.app.find('[data-testid="thread-approval"]')).toHaveLength(0)
    m.app.unmount()
  })

  test('US-012 gate: a creator without thread.answer sees the request but no decision controls', async () => {
    const m = mountPage({
      thread: threadDetail({ pendingApprovals: [approval()] }),
      // The creator's role lacks the decision key: the card renders read-only (the API refuses anyway).
      permissions: ['thread.cap.update', 'thread.mode.ask', 'thread.mode.full'],
    })
    await m.settle()

    expect(m.app.one('[data-testid="thread-approval"]')).toBeDefined()
    expect(m.app.one('[data-testid="thread-approval-approve"]')).toBeUndefined()
    expect(m.app.one('[data-testid="thread-approval-awaiting"]')).toBeDefined()
    m.app.unmount()
  })

  test('US-012 wiring: Approve on a card reaches the controller action with its request id', async () => {
    const m = mountPage({ thread: threadDetail({ pendingApprovals: [approval({ requestId: 'req-9' })] }), permissions: MODE_KEYS })
    await m.settle()

    const approve = m.app.one('[data-testid="thread-approval-approve"]')
    expect(approve).toBeDefined()
    if (approve !== undefined) (approve.props.onClick as () => void)()
    await m.settle()

    expect(m.decideApproval).toHaveBeenCalledWith('req-9', 'allow')
    m.app.unmount()
  })

  test('US-012 wiring: choosing Ask reaches the controller mode action', async () => {
    const m = mountPage({ thread: threadDetail({ kind: 'REPO', mode: 'read' }), permissions: MODE_KEYS })
    await m.settle()

    const ask = m.app.one('[data-testid="thread-mode-ask"]')
    expect(ask).toBeDefined()
    if (ask !== undefined) (ask.props.onClick as () => void)()
    await m.settle()

    expect(m.changeMode).toHaveBeenCalledWith('ask')
    m.app.unmount()
  })
})
