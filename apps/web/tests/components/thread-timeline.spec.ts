import { describe, test, expect, jest } from '@jest/globals'
import * as Vue from 'vue'
import { createRequire } from 'node:module'
import { mountSfc, webFile, loadSfc } from '../helpers/mount-sfc'
import type { FakeNode, Mounted } from '../helpers/mount-sfc'
import { uiStubs, i18nStub } from '../helpers/fleet-harness'
import type {
  ChatMessageDto,
  ThreadDetailDto,
  ToolSummaryEntry,
} from '~/lib/thread-types'
import type { FleetJobDto, FleetRunnerSummary } from '~/lib/fleet-types'

/**
 * US-006 AC1-AC13: the thread transcript components under components/fleet/threads/.
 *
 * B4-D1 is the security spine of these tests: assistant `content` is the ONE piece of
 * runner/agent text that reaches the DOM as HTML (through renderThreadMarkdown — sanitized,
 * images removed); user messages, `errorReason`, tool input/preview and question text are
 * interpolation-only. The sanitized HTML is asserted with a DOM-capable check: the v-html
 * string the component produced is parsed with a real HTML parser (@vue/compiler-dom parses
 * into an element/attribute tree), never by assuming mount-sfc's fake renderer parses
 * innerHTML into the tree it walks.
 *
 * The real apps/web/lib/markdown.ts (and the real renderThreadMarkdown once implemented) run
 * here; only the two heavyweight packages jest cannot load (marked, isomorphic-dompurify) are
 * replaced by the same minimal doubles tests/lib/markdown.spec.ts uses, extended with a
 * markdown-image rule so the image-removal behaviour is actually exercised.
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
      // Markdown images (before links, like marked): ![alt](src) -> <img src alt>.
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

// ── DOM-capable HTML assertions ────────────────────────────────────────────────────────────
//
// mount-sfc's fake renderer records v-html as an `innerHTML` prop and never parses it; these
// tests parse that string with a real HTML parser (@vue/compiler-dom) into an element tree.
const requireFromVue = createRequire(require.resolve('vue'))
const compilerDom = requireFromVue('@vue/compiler-dom') as {
  parse: (html: string) => { children: unknown[] }
}

interface HtmlNode {
  type: number
  tag?: string
  props?: Array<{ name?: string; value?: unknown }>
  children?: HtmlNode[]
  content?: string
}

interface HtmlElement {
  tag: string
  attrs: string[]
  text: string
  children: HtmlElement[]
}

/** Every element of one HTML string: tag, attribute names and descendant text (a tiny DOM). */
function parsedElements(html: string): HtmlElement[] {
  const roots = compilerDom.parse(html).children as HtmlNode[]
  const visit = (node: HtmlNode): HtmlElement[] => {
    if (node.type !== 1 || node.tag === undefined || node.tag === '') return []
    const children = (node.children ?? []).flatMap(visit)
    const ownText = (node.children ?? [])
      .filter(c => c.type === 2 && c.content !== undefined)
      .map(c => c.content as string)
      .join('')
    return [{ tag: node.tag, attrs: (node.props ?? []).map(p => p.name ?? ''), text: ownText, children }, ...children]
  }
  return roots.flatMap(visit)
}

function textOfElement(element: HtmlElement): string {
  return element.text + element.children.map(textOfElement).join('')
}

/** Every `innerHTML` string a mounted component bound via v-html. */
function innerHtmlOf(app: { root: FakeNode }): string[] {
  const htmls: string[] = []
  const walk = (node: FakeNode): void => {
    if (typeof node.props.innerHTML === 'string') htmls.push(node.props.innerHTML as string)
    node.children.forEach(walk)
  }
  walk(app.root)
  return htmls
}

/** The parsed elements of everything the component rendered via v-html. */
function renderedElements(app: Mounted): HtmlElement[] {
  return innerHtmlOf(app).flatMap(parsedElements)
}

/** Elements of one tag in the fake renderer tree (native elements, not v-html content). */
function tagsIn(app: { root: FakeNode }, tag: string): FakeNode[] {
  const found: FakeNode[] = []
  const walk = (node: FakeNode): void => {
    if (node.tag === tag) found.push(node)
    node.children.forEach(walk)
  }
  walk(app.root)
  return found
}

/** The first element that carries an onClick handler (the chip's expand/collapse control). */
function clickFirst(app: Mounted): void {
  const found: FakeNode[] = []
  const walk = (node: FakeNode): void => {
    if (typeof node.props.onClick === 'function') found.push(node)
    node.children.forEach(walk)
  }
  walk(app.root)
  expect(found.length).toBeGreaterThan(0)
  ;(found[0].props.onClick as () => void)()
}

// ── fixtures ────────────────────────────────────────────────────────────────────────────────

const threadFile = webFile('components', 'fleet', 'threads', 'ThreadHeader.vue')
const timelineFile = webFile('components', 'fleet', 'threads', 'ThreadTimeline.vue')
const messageFile = webFile('components', 'fleet', 'threads', 'ThreadMessage.vue')
const toolChipFile = webFile('components', 'fleet', 'threads', 'ThreadToolChip.vue')
const questionCardFile = webFile('components', 'fleet', 'threads', 'ThreadQuestionCard.vue')
const writeMarkerFile = webFile('components', 'fleet', 'threads', 'ThreadWriteMarker.vue')
const jobCardFile = webFile('components', 'fleet', 'threads', 'ThreadJobCard.vue')
const badgeFile = webFile('components', 'fleet', 'FleetJobStateBadge.vue')

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
  tokens: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0 },
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

const runner = (over: Record<string, unknown> = {}): FleetRunnerSummary => ({
  id: 'r1',
  name: 'wk-mac',
  os: 'linux',
  arch: 'x64',
  labels: [],
  enabled: true,
  online: true,
  profiles: [],
  threadBackends: { native: ['m1'], acp: [] },
  ...over,
})

const toolEntry = (over: Record<string, unknown> = {}): ToolSummaryEntry => ({
  callId: 'c1',
  name: 'search_repo',
  input: '',
  isError: null,
  preview: '',
  decidedBy: null,
  ...over,
})

// ── mount helpers ──────────────────────────────────────────────────────────────────────────

function mountMessage(message: ChatMessageDto): Mounted {
  return mountSfc(messageFile, {
    props: { message },
    components: uiStubs,
    globals: { useI18n: () => i18nStub() },
  })
}

function mountToolChip(entry: ToolSummaryEntry, messageStatus: string): Mounted {
  return mountSfc(toolChipFile, {
    props: { entry, messageStatus },
    components: uiStubs,
    globals: { useI18n: () => i18nStub() },
  })
}

function mountTimeline(
  thread: ThreadDetailDto,
  messages: ChatMessageDto[],
  extra: { jobs?: { plan: FleetJobDto | null; run: FleetJobDto | null }; slug?: string } = {},
): Mounted {
  // The timeline's children resolve under either the contract names (explicit imports) or the
  // Nuxt auto-import names a sub-directory component receives; register the real files for both.
  const realMessage = loadSfc(messageFile, { useI18n: () => i18nStub() })
  const realCard = loadSfc(questionCardFile, { useI18n: () => i18nStub() })
  const realWrite = loadSfc(writeMarkerFile, { useI18n: () => i18nStub() })
  const realJob = loadSfc(jobCardFile, { useI18n: () => i18nStub() })
  return mountSfc(timelineFile, {
    props: { thread, messages, isCreator: true, jobs: extra.jobs ?? { plan: null, run: null }, slug: extra.slug ?? 'web' },
    components: {
      ...uiStubs,
      ThreadMessage: realMessage,
      FleetThreadsThreadMessage: realMessage,
      ThreadQuestionCard: realCard,
      FleetThreadsThreadQuestionCard: realCard,
      ThreadWriteMarker: realWrite,
      FleetThreadsThreadWriteMarker: realWrite,
      ThreadJobCard: realJob,
      FleetThreadsThreadJobCard: realJob,
      FleetJobStateBadge: loadSfc(badgeFile, { useI18n: () => i18nStub() }),
      NuxtLink: { name: 'StubNuxtLink', props: ['to'], setup: (p: { to: string }, { slots }: { slots: Record<string, () => unknown> }) => () => Vue.h('a', { href: p.to }, slots.default?.()) },
    },
    globals: { useI18n: () => i18nStub() },
  })
}

function mountHeader(thread: ThreadDetailDto, runners: FleetRunnerSummary[]): Mounted {
  return mountSfc(threadFile, {
    props: { thread, runners },
    components: uiStubs,
    globals: { useI18n: () => i18nStub() },
  })
}

// ── US-006: transcript components ──────────────────────────────────────────────────────────

describe('US-006 AC1-AC13: components/fleet/threads transcript components', () => {
  test('AC1: an assistant message whose content is **bold** renders a strong element with text bold', () => {
    const app = mountMessage(message({ content: '**bold**' }))

    const strong = renderedElements(app).find(element => element.tag === 'strong')
    expect(strong).toBeDefined()
    expect(strong && textOfElement(strong)).toBe('bold')
  })

  test('AC2: an assistant message whose content is <img src=x onerror=alert(1)> renders no element with an onerror attribute', () => {
    const app = mountMessage(message({ content: '<img src=x onerror=alert(1)>' }))

    const withOnError = renderedElements(app).filter(element => element.attrs.includes('onerror'))
    expect(withOnError).toEqual([])
  })

  test('AC3: a user message whose content is <b>hi</b> renders the literal text <b>hi</b> and no b element', () => {
    const app = mountMessage(message({ role: 'user', content: '<b>hi</b>' }))

    expect(app.text()).toContain('<b>hi</b>')
    expect(tagsIn(app, 'b')).toEqual([])
    expect(innerHtmlOf(app)).toEqual([])
  })

  test('AC4: an errored message whose errorReason is <i>crashed</i> renders the literal text <i>crashed</i> and no i element', () => {
    const app = mountMessage(message({ status: 'errored', errorReason: '<i>crashed</i>' }))

    expect(app.text()).toContain('<i>crashed</i>')
    expect(tagsIn(app, 'i')).toEqual([])
  })

  test('AC5: a streaming assistant message shows the streaming indicator', () => {
    const app = mountMessage(message({ status: 'streaming', content: 'Hi' }))

    expect(app.one('[data-testid="thread-streaming"]')).toBeDefined()
  })

  test('AC6: a ThreadToolChip decided by profile shows the fleet.threads.tool.denied label', () => {
    const app = mountToolChip(
      toolEntry({ name: 'search_repo', isError: true, decidedBy: 'profile' }),
      'streaming',
    )

    expect(app.text()).toContain('fleet.threads.tool.denied')
  })

  test('AC7: clicking a collapsed ThreadToolChip whose preview is <b>x</b> shows the literal text <b>x</b>', async () => {
    const app = mountToolChip(
      toolEntry({ name: 'search_repo', isError: null, decidedBy: null, preview: '<b>x</b>' }),
      'complete',
    )

    expect(app.text()).not.toContain('<b>x</b>')

    clickFirst(app)
    await Vue.nextTick()

    expect(app.text()).toContain('<b>x</b>')
    expect(tagsIn(app, 'b')).toEqual([])
  })

  test('AC8: ThreadTimeline with a thread whose session.contextReset is true shows the fleet.threads.detail.contextReset marker', () => {
    const app = mountTimeline(
      threadDetail({ session: { jobId: 'j1', state: 'closed', resumed: false, contextReset: true, reason: null, at: '2026-10-14T00:00:00.000Z' } }),
      [],
    )

    expect(app.text()).toContain('fleet.threads.detail.contextReset')
  })

  test('AC9: ThreadTimeline with a pending question shows the question text Which DB?', () => {
    const app = mountTimeline(
      threadDetail({ pendingQuestion: { requestId: 'q1', text: 'Which DB?', expiresAt: '2026-10-12T10:00:00Z' } }),
      [],
    )

    expect(app.text()).toContain('Which DB?')
  })

  test('AC10: ThreadHeader with runnerId r1 and an online runner wk-mac shows wk-mac with the fleet.common.online label', () => {
    const app = mountHeader(threadDetail({ runnerId: 'r1' }), [runner({ id: 'r1', name: 'wk-mac', online: true })])

    expect(app.text()).toContain('wk-mac')
    expect(app.text()).toContain('fleet.common.online')
  })

  test('AC11: ThreadHeader shows the cost text $0 / $5', () => {
    const app = mountHeader(threadDetail({ costUsd: '0', maxCostUsd: '5' }), [])

    expect(app.text()).toContain('$0 / $5')
  })

  test('AC12: an assistant message whose content is ![x](https://evil.example/a.png) renders no img element', () => {
    const app = mountMessage(message({ content: '![x](https://evil.example/a.png)' }))

    expect(renderedElements(app).filter(element => element.tag === 'img')).toEqual([])
  })

  test('AC13: ThreadHeader with nested skills shows both skill names spec-review and spec-writing', () => {
    const app = mountHeader(
      threadDetail({
        skills: [{
          sourceId: 's1',
          owner: 'o',
          repo: 'r',
          sha: 'abc',
          skills: [
            { name: 'spec-review', dir: 'skills/spec-review', description: '' },
            { name: 'spec-writing', dir: 'skills/spec-writing', description: '' },
          ],
        }],
      }),
      [],
    )

    expect(app.text()).toContain('spec-review')
    expect(app.text()).toContain('spec-writing')
  })
})
// ── US-004: the timeline shows the latest write and the latest PLAN and RUN ────────────────

describe('US-004 AC-13: ThreadTimeline places the write marker and the job card among the messages', () => {
  test('AC-13: a thread with messages at 10:00 and 10:05, a published write at 10:02 and a PLAN queued at 10:06 renders the markers in order between the messages', () => {
    const planJob: FleetJobDto = {
      id: 'p1',
      projectId: 'p',
      repoId: 'r1',
      ref: 'feat/add-auth',
      command: 'PLAN',
      feature: 'add-auth',
      planFrom: null,
      profiles: [],
      maxCostUsd: '5',
      bashMode: 'raw',
      approvalTimeoutSec: 600,
      pendingApprovals: 0,
      selectorLabels: [],
      pinnedRunnerId: null,
      runnerId: null,
      leaseEpoch: 0,
      state: 'COMPLETED',
      stateReason: null,
      requestedById: 'u1',
      queuedAt: '2026-10-14T10:06:00.000Z',
      assignedAt: null,
      startedAt: null,
      finishedAt: null,
      cancelRequestedAt: null,
      naxRunId: null,
      naxLogRunId: null,
      naxCostRunId: null,
      progress: null,
      currentStoryId: null,
      currentPhase: null,
      costSpentUsd: '0.1200',
      lastHeartbeatAt: null,
      finishResult: null,
      escalationReason: null,
      exitCode: null,
      resultBranch: null,
      resultSha: null,
      resultPrUrl: null,
      wipPush: null,
      stories: null,
      storiesTruncated: false,
      postRun: null,
      scheduleId: null,
      coalescedCount: 0,
      workflow: null,
    }
    const app = mountTimeline(
      threadDetail({
        lastWrite: { kind: 'published', jobId: 'w1', at: '2026-10-14T10:02:00.000Z', sha: 'abcdef1234567', paths: ['a.md'], ignored: [] },
        handoff: { plan: { jobId: 'p1', state: 'COMPLETED', stateReason: null }, run: null },
      }),
      [
        message({ id: 'm1', role: 'user', content: 'first', createdAt: '2026-10-14T10:00:00.000Z' }),
        message({ id: 'm2', role: 'user', content: 'second', createdAt: '2026-10-14T10:05:00.000Z' }),
      ],
      { jobs: { plan: planJob, run: null }, slug: 'web' },
    )

    // The rendered order of the messages (`thread-message`) and the two markers, in document order.
    const order: string[] = []
    const walk = (node: FakeNode): void => {
      const id = node.props['data-testid']
      if (id === 'thread-message') order.push('thread-message')
      else if (id === 'thread-write-marker') order.push('thread-write-marker')
      else if (id === 'thread-job-card') order.push('thread-job-card')
      node.children.forEach(walk)
    }
    walk(app.root)
    expect(order).toEqual(['thread-message', 'thread-write-marker', 'thread-message', 'thread-job-card'])
  })
})
