import { afterEach, describe, expect, jest, test } from '@jest/globals'
import * as Vue from 'vue'
import { computed, defineComponent, h, nextTick, ref, watch } from 'vue'
import type { Component } from 'vue'
import { loadSfc, mountSfc, webFile } from '../helpers/mount-sfc'
import type { FakeNode, Mounted } from '../helpers/mount-sfc'
import { i18nStub, toastRecorder, uiStubs } from '../helpers/fleet-harness'
import type { ToastRecorder } from '../helpers/fleet-harness'
import * as apiModule from '../../composables/useApi'
import { ApiError, extractApiError } from '../../composables/useApi'
import { useWorkspaceThread as createWorkspaceThread } from '~/composables/useWorkspaceThread'
import { useProjectRunnerSummaries as createProjectRunnerSummaries } from '~/composables/useProjectRunnerSummaries'
import type { EventSourceLike } from '~/lib/project-event-stream'
import type { FleetRunnerSummary } from '~/lib/fleet-types'
import type { ChatMessageDto, ThreadDetailDto } from '~/lib/thread-types'

/**
 * US-006 AC-1..AC-10, AC-12, AC-13: pages/threads/[id].vue — the WORKSPACE thread detail page.
 *
 * The page is mounted for real (mount-sfc) with the REAL `useWorkspaceThread` (US-004) over a
 * stubbed `$api`, so the requests under assertion are the ones the page actually triggers:
 * `GET /threads/t1`, `/threads/t1/messages`, `POST /threads/t1/messages`,
 * `POST /threads/t1/archive` and `GET /projects/<homeProject.slug>/fleet/runners`.
 *
 * Two component sets are used. By default every thread component is a named marker (one div per
 * component, carrying the props the page handed it), which is what AC-2..AC-5 assert on. For the
 * composer/controls interaction (AC-7..AC-9) the REAL ThreadHeader / ThreadTimeline / ThreadControls
 * / ThreadComposer are registered instead, so a real Enter press reaches the real controller.
 */

const pageFile = webFile('pages', 'threads', '[id].vue')

/** The controller's live stream: one EventSource per mount, never opened (no `ready` frame). */
class StubEventSource implements EventSourceLike {
  static instances: StubEventSource[] = []
  readyState = 0
  onopen: ((ev: unknown) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null

  constructor(readonly url: string) {
    StubEventSource.instances.push(this)
  }

  addEventListener(): void {}
  close(): void {}
}

const g = globalThis as Record<string, unknown>

const workspaceThread = (over: Record<string, unknown> = {}): ThreadDetailDto => ({
  id: 't1',
  kind: 'WORKSPACE',
  repoId: null,
  baseRef: null,
  feature: null,
  homeProject: { slug: 'acme', name: 'Sandbox' },
  title: 'Plan the rollout',
  createdById: 'u1',
  runnerId: 'rn1',
  backend: { kind: 'native', model: 'gpt-5' },
  status: 'ACTIVE',
  archivedAt: null,
  skills: [],
  maxCostUsd: '5',
  costUsd: '0',
  tokens: null,
  specPath: null,
  pendingQuestion: null,
  session: null,
  lastActivityAt: '2026-10-14T00:00:00.000Z',
  createdAt: '2026-10-14T00:00:00.000Z',
  activeJob: null,
  writtenPaths: [],
  publishedSha: null,
  specPublished: false,
  lastWrite: null,
  sendRefusal: null,
  handoff: { plan: null, run: null },
  ...over,
})

const message = (over: Record<string, unknown> = {}): ChatMessageDto => ({
  id: 'm1',
  seq: 1,
  jobId: null,
  turnId: null,
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
  id: 'rn1',
  name: 'wk-mac',
  os: 'linux',
  arch: 'x64',
  labels: [],
  enabled: true,
  online: true,
  profiles: [],
  threadBackends: { native: ['m1'], acp: [] },
  projectThreads: true,
  workspaceThreads: true,
  ...over,
})

/**
 * One marker component: a div carrying the component's name, with every declared prop rendered as a
 * `data-prop-<name>` attribute. `inheritAttrs: false` keeps the page's listeners off the data
 * attributes (they are read, never fired).
 */
function marker(name: string, props: string[] = []): Component {
  return defineComponent({
    name: `Marker_${name}`,
    inheritAttrs: false,
    props,
    setup(markerProps: Record<string, unknown>) {
      return () => h('div', {
        'data-testid': name,
        ...Object.fromEntries(props.map(prop => [`data-prop-${prop}`, JSON.stringify(markerProps[prop] ?? null)])),
      })
    },
  })
}

/** The five components the page must render, and the three it must not. */
const MARKERS: Record<string, Component> = {
  ThreadHeader: marker('page-thread-header'),
  FleetThreadsThreadHeader: marker('page-thread-header'),
  ThreadControls: marker('page-thread-controls', ['isCreator']),
  FleetThreadsThreadControls: marker('page-thread-controls', ['isCreator']),
  ThreadKodaToolsNotice: marker('page-thread-koda-tools-notice'),
  FleetThreadsThreadKodaToolsNotice: marker('page-thread-koda-tools-notice'),
  ThreadTimeline: marker('page-thread-timeline', ['slug']),
  FleetThreadsThreadTimeline: marker('page-thread-timeline', ['slug']),
  ThreadComposer: marker('page-thread-composer', ['composerState', 'turnRunning']),
  FleetThreadsThreadComposer: marker('page-thread-composer', ['composerState', 'turnRunning']),
  ThreadActionBar: marker('page-thread-action-bar'),
  FleetThreadsThreadActionBar: marker('page-thread-action-bar'),
  ThreadStaleBanner: marker('page-thread-stale-banner'),
  FleetThreadsThreadStaleBanner: marker('page-thread-stale-banner'),
  ThreadProjectCodeNotice: marker('page-thread-project-code-notice'),
  FleetThreadsThreadProjectCodeNotice: marker('page-thread-project-code-notice'),
}

/** The real thread components, registered under both their contract and Nuxt auto-import names. */
function realComponents(): Record<string, Component> {
  const globals = { useI18n: () => i18nStub() }
  const inert = defineComponent({ name: 'InertChild', setup: () => () => h('div', '') })
  const header = loadSfc(webFile('components', 'fleet', 'threads', 'ThreadHeader.vue'), globals)
  const timeline = loadSfc(webFile('components', 'fleet', 'threads', 'ThreadTimeline.vue'), globals)
  const controls = loadSfc(webFile('components', 'fleet', 'threads', 'ThreadControls.vue'), globals)
  const composer = loadSfc(webFile('components', 'fleet', 'threads', 'ThreadComposer.vue'), globals)
  return {
    ...MARKERS,
    ThreadHeader: header,
    FleetThreadsThreadHeader: header,
    ThreadTimeline: timeline,
    FleetThreadsThreadTimeline: timeline,
    ThreadControls: controls,
    FleetThreadsThreadControls: controls,
    ThreadComposer: composer,
    FleetThreadsThreadComposer: composer,
    // The timeline's children: this spec asserts the page's wiring, not the transcript's own
    // rendering (tests/components/thread-timeline.spec.ts covers that).
    ThreadMessage: inert,
    FleetThreadsThreadMessage: inert,
    ThreadToolChip: inert,
    FleetThreadsThreadToolChip: inert,
    ThreadQuestionCard: inert,
    FleetThreadsThreadQuestionCard: inert,
    ThreadJobCard: inert,
    FleetThreadsThreadJobCard: inert,
    ThreadWriteMarker: inert,
    FleetThreadsThreadWriteMarker: inert,
    FleetJobStateBadge: inert,
  }
}

interface PostCall {
  path: string
  body: unknown
}

interface CapturedHead {
  title?: unknown
}

interface PageMount {
  app: Mounted
  get: jest.Mock
  post: jest.Mock
  patch: jest.Mock
  paths: string[]
  posts: PostCall[]
  toasts: ToastRecorder
  useWorkspaceThread: jest.Mock
  head: () => CapturedHead
  /** Resolves the pending `GET /threads/t1` (only meaningful with `threadGet: 'pending'`). */
  resolveThread: () => void
  settle: () => Promise<void>
}

/**
 * Mounts the page with the real `useWorkspaceThread` (spied, so AC-1 can see the id the page passed
 * it) and the real `useProjectRunnerSummaries`, both over the stubbed `$api`.
 */
function mountPage(over: {
  thread?: ThreadDetailDto
  messages?: ChatMessageDto[]
  runners?: FleetRunnerSummary[]
  /** 'resolve' (default) | 'pending' | 'notFound' | 'notFoundOnce' (the retry then succeeds). */
  threadGet?: 'resolve' | 'pending' | 'notFound' | 'notFoundOnce'
  /** The error `POST /threads/t1/messages` rejects with. */
  sendError?: unknown
  /** true registers the real thread components (the composer/controls interaction specs). */
  real?: boolean
} = {}): PageMount {
  const thread = over.thread ?? workspaceThread()
  const paths: string[] = []
  const posts: PostCall[] = []
  let threadAttempts = 0
  let resolvePending: ((value: ThreadDetailDto) => void) | null = null
  const pending = new Promise<ThreadDetailDto>((resolve) => { resolvePending = resolve })

  const get = jest.fn(async (path: string) => {
    paths.push(path)
    if (path === '/threads/t1') {
      threadAttempts += 1
      if (over.threadGet === 'pending') return pending
      if (over.threadGet === 'notFound' || (over.threadGet === 'notFoundOnce' && threadAttempts === 1)) {
        throw new ApiError(404, 'Thread not found')
      }
      return thread
    }
    if (path === '/threads/t1/messages') return { items: over.messages ?? [] }
    if (path === '/projects/acme/fleet/runners') return { records: over.runners ?? [], hasNext: false }
    return {}
  })
  const post = jest.fn(async (path: string, body?: unknown) => {
    posts.push({ path, body })
    if (path === '/threads/t1/messages' && over.sendError !== undefined) throw over.sendError
    return {}
  })
  const patch = jest.fn(async () => ({}))
  const toasts = toastRecorder()
  let head: CapturedHead = {}

  g.EventSource = StubEventSource
  g.useApi = () => ({ $api: { get, post, patch } })
  g.useAuth = () => ({ refresh: jest.fn(async () => true), user: ref({ id: 'u1', email: 'owner@k.t' }) })

  const useWorkspaceThread = jest.fn((id: string) => createWorkspaceThread(id))
  const useProjectRunnerSummaries = jest.fn(() => createProjectRunnerSummaries())

  const app = mountSfc(pageFile, {
    components: over.real === true ? { ...uiStubs, ...realComponents() } : { ...uiStubs, ...MARKERS },
    alias: { '~/composables/useApi': apiModule },
    globals: {
      ref, computed, watch, nextTick,
      definePageMeta: () => undefined,
      useI18n: () => i18nStub(),
      useApi: g.useApi,
      useAuth: g.useAuth,
      useRoute: () => ({ params: { id: 't1' } }),
      useAppToast: () => toasts,
      useHead: (value: unknown) => {
        Vue.watchEffect(() => {
          head = (typeof value === 'function' ? value() : value) as CapturedHead
        })
      },
      useWorkspaceThread,
      useProjectRunnerSummaries,
    },
  })

  const settle = async (): Promise<void> => {
    for (let i = 0; i < 8; i += 1) {
      await new Promise((resolve) => { setImmediate(resolve) })
      await Vue.nextTick()
    }
  }

  return {
    app,
    get,
    post,
    patch,
    paths,
    posts,
    toasts,
    useWorkspaceThread,
    head: () => head,
    resolveThread: () => resolvePending?.(thread),
    settle,
  }
}

/** The resolved title useHead received: `title` may be a value or a function. */
function headTitle(head: CapturedHead): unknown {
  return typeof head.title === 'function' ? (head.title as () => unknown)() : head.title
}

/** The first node with the given `data-testid`. */
const byTestId = (app: Mounted, id: string): FakeNode | undefined => app.one(`[data-testid="${id}"]`)

/** The first uiStubs element (they carry `data-stub`, not `data-testid`). */
const byStub = (app: Mounted, id: string): FakeNode | undefined => app.one(`[data-stub="${id}"]`)

/** The `data-prop-<name>` a marker rendered, JSON-decoded. */
function markerProp(app: Mounted, id: string, prop: string): unknown {
  const node = byTestId(app, id)
  return node === undefined ? undefined : JSON.parse(String(node.props[`data-prop-${prop}`]))
}

/** Fires an element's click handler. */
function click(node: FakeNode): void {
  (node.props.onClick as () => void)()
}

/** Fires a named listener prop (`@retry` reaches a stub as `onRetry`). */
function fire(node: FakeNode, handler: string): void {
  (node.props[handler] as () => void)()
}

/** The composer's textarea stub (or a native textarea). */
const textarea = (app: Mounted): FakeNode | undefined => app.one('[data-stub="textarea"]') ?? app.one('textarea')

/** Types `value` into the composer and presses Enter, exactly as a browser would. */
function typeAndEnter(app: Mounted, value: string): boolean {
  const field = textarea(app)
  if (field === undefined) return false
  const onUpdate = field.props['onUpdate:modelValue']
  const onInput = field.props.onInput
  if (typeof onUpdate === 'function') (onUpdate as (value: string) => void)(value)
  else if (typeof onInput === 'function') (onInput as (event: { target: { value: string } }) => void)({ target: { value: value } })
  else return false
  const onKeydown = field.props.onKeydown
  if (typeof onKeydown !== 'function') return false
  ;(onKeydown as (event: { key: string; shiftKey?: boolean; preventDefault: () => void }) => void)({
    key: 'Enter',
    shiftKey: false,
    preventDefault: () => undefined,
  })
  return true
}

afterEach(() => {
  StubEventSource.instances = []
  delete g.EventSource
  delete g.useApi
  delete g.useAuth
})

describe('US-006 AC-1..AC-6: pages/threads/[id].vue — the loaded thread', () => {
  test('AC-1: mounting for route id t1 loads the thread through useWorkspaceThread(t1) and requests GET /threads/t1', async () => {
    const m = mountPage()
    await m.settle()

    expect(m.useWorkspaceThread).toHaveBeenCalledWith('t1')
    expect(m.get).toHaveBeenCalledWith('/threads/t1')
    expect(m.paths[0]).toBe('/threads/t1')
    m.app.unmount()
  })

  test('AC-2: a loaded thread renders ThreadHeader, ThreadControls, ThreadKodaToolsNotice, ThreadTimeline and ThreadComposer', async () => {
    const m = mountPage()
    await m.settle()

    for (const id of ['page-thread-header', 'page-thread-controls', 'page-thread-koda-tools-notice', 'page-thread-timeline', 'page-thread-composer']) {
      expect(byTestId(m.app, id)).toBeDefined()
    }
    m.app.unmount()
  })

  test('AC-2 (real components): the real header, controls, timeline and composer render for a loaded thread', async () => {
    const m = mountPage({ real: true })
    await m.settle()

    expect(byTestId(m.app, 'thread-header')).toBeDefined()
    expect(byTestId(m.app, 'thread-controls')).toBeDefined()
    expect(byTestId(m.app, 'thread-timeline')).toBeDefined()
    expect(byTestId(m.app, 'thread-composer')).toBeDefined()
    expect(m.app.text()).toContain('Plan the rollout')
    m.app.unmount()
  })

  test('AC-3: the page renders no ThreadActionBar, no ThreadStaleBanner and no ThreadProjectCodeNotice', async () => {
    const m = mountPage()
    await m.settle()

    expect(byTestId(m.app, 'page-thread-timeline')).toBeDefined()
    expect(byTestId(m.app, 'page-thread-action-bar')).toBeUndefined()
    expect(byTestId(m.app, 'page-thread-stale-banner')).toBeUndefined()
    expect(byTestId(m.app, 'page-thread-project-code-notice')).toBeUndefined()
    m.app.unmount()
  })

  test('AC-4: ThreadControls receives is-creator true for a loaded thread', async () => {
    const m = mountPage()
    await m.settle()

    expect(markerProp(m.app, 'page-thread-controls', 'isCreator')).toBe(true)
    m.app.unmount()
  })

  test('AC-4 (real controls): the loaded thread shows the creator-only Raise cap control', async () => {
    const m = mountPage({ real: true })
    await m.settle()

    expect(byTestId(m.app, 'thread-raise-cap')).toBeDefined()
    m.app.unmount()
  })

  test('AC-4 (wiring): isCreator reaches composerState, so the loaded thread has a sendable composer', async () => {
    const m = mountPage()
    await m.settle()

    expect(markerProp(m.app, 'page-thread-composer', 'composerState')).toEqual({ canSend: true, reason: null })
    expect(markerProp(m.app, 'page-thread-composer', 'turnRunning')).toBe(false)
    m.app.unmount()
  })

  test('AC-5: ThreadTimeline receives the thread home project slug as its slug prop', async () => {
    const m = mountPage({ thread: workspaceThread({ homeProject: { slug: 'sandbox-2', name: 'Sandbox' } }) })
    await m.settle()

    expect(markerProp(m.app, 'page-thread-timeline', 'slug')).toBe('sandbox-2')
    m.app.unmount()
  })

  test('AC-6: after the thread has loaded the page reads GET /projects/acme/fleet/runners and never the project repo list', async () => {
    const m = mountPage({ real: true, runners: [runner()] })
    await m.settle()

    expect(m.get).toHaveBeenCalledWith('/projects/acme/fleet/runners', { query: { size: '100' } })
    expect(m.paths.filter(path => path.endsWith('/fleet/repos'))).toEqual([])
    // "after the thread has loaded": the thread read comes first, the summaries read follows it.
    expect(m.paths.indexOf('/projects/acme/fleet/runners')).toBeGreaterThan(m.paths.indexOf('/threads/t1'))
    // …and the summaries reach the header (the loaded runner line).
    expect(m.app.text()).toContain('wk-mac')
    m.app.unmount()
  })
})

describe('US-006 AC-7..AC-9: pages/threads/[id].vue — send and archive', () => {
  test('AC-7: sending from the composer posts to /threads/t1/messages', async () => {
    const m = mountPage({ real: true })
    await m.settle()

    expect(typeAndEnter(m.app, 'hello')).toBe(true)
    await m.settle()

    expect(m.posts).toEqual([{ path: '/threads/t1/messages', body: { text: 'hello', clientMessageId: expect.any(String) } }])
    m.app.unmount()
  })

  test('AC-8: confirming Archive in the controls posts to /threads/t1/archive', async () => {
    const m = mountPage({ real: true })
    await m.settle()

    const archive = byTestId(m.app, 'thread-archive')
    expect(archive).toBeDefined()
    if (archive !== undefined) click(archive)
    await m.settle()

    const confirm = byTestId(m.app, 'thread-archive-confirm')
    expect(confirm).toBeDefined()
    if (confirm !== undefined) click(confirm)
    await m.settle()

    expect(m.posts.map(call => call.path)).toEqual(['/threads/t1/archive'])
    m.app.unmount()
  })

  test('AC-9: a failed send toasts extractApiError of the error', async () => {
    const error = new ApiError(500, 'composer exploded')
    const m = mountPage({ real: true, sendError: error })
    await m.settle()

    expect(typeAndEnter(m.app, 'hello')).toBe(true)
    await m.settle()

    expect(m.toasts.errors).toEqual([extractApiError(error)])
    m.app.unmount()
  })
})

describe('US-006 wiring: pages/threads/[id].vue — the other session controls', () => {
  test('Wiring: End session posts to /threads/t1/end-session while the session is live', async () => {
    const m = mountPage({
      real: true,
      thread: workspaceThread({ activeJob: { id: 'j1', state: 'RUNNING' } }),
    })
    await m.settle()

    const end = byTestId(m.app, 'thread-end-session')
    expect(end).toBeDefined()
    if (end !== undefined) click(end)
    await m.settle()

    expect(m.posts.map(call => call.path)).toEqual(['/threads/t1/end-session'])
    m.app.unmount()
  })

  test('Wiring: confirming the Raise cap dialog patches /threads/t1 with the new cap', async () => {
    const m = mountPage({ real: true })
    await m.settle()

    const raise = byTestId(m.app, 'thread-raise-cap')
    expect(raise).toBeDefined()
    if (raise !== undefined) click(raise)
    await m.settle()

    const field = byTestId(m.app, 'thread-cap-input')
    expect(field).toBeDefined()
    const onInput = field?.props.onInput
    expect(typeof onInput).toBe('function')
    if (typeof onInput === 'function') (onInput as (event: { target: { value: string } }) => void)({ target: { value: '8' } })
    await m.settle()

    const confirm = byTestId(m.app, 'thread-cap-confirm')
    expect(confirm).toBeDefined()
    if (confirm !== undefined) click(confirm)
    await m.settle()

    expect(m.patch).toHaveBeenCalledWith('/threads/t1', { maxCostUsd: 8 })
    m.app.unmount()
  })

  test('Wiring: stopping a running turn posts to /threads/t1/stop', async () => {
    const m = mountPage({ real: true, messages: [message({ status: 'streaming' })] })
    await m.settle()

    const stop = byTestId(m.app, 'thread-stop')
    expect(stop).toBeDefined()
    if (stop !== undefined) click(stop)
    await m.settle()

    expect(m.posts.map(call => call.path)).toEqual(['/threads/t1/stop'])
    m.app.unmount()
  })
})

describe('US-006 AC-10, AC-12, AC-13: pages/threads/[id].vue — load failure, title and ordering', () => {
  test('AC-10: when GET /threads/t1 answers 404 the page shows the error state', async () => {
    const m = mountPage({ threadGet: 'notFound' })
    await m.settle()

    expect(byStub(m.app, 'error-state')).toBeDefined()
    expect(byStub(m.app, 'loading-state')).toBeUndefined()
    expect(byTestId(m.app, 'page-thread-header')).toBeUndefined()
    m.app.unmount()
  })

  test('AC-10 (retry): the error state retries the load and renders the thread when it succeeds', async () => {
    const m = mountPage({ threadGet: 'notFoundOnce' })
    await m.settle()

    const error = byStub(m.app, 'error-state')
    expect(error).toBeDefined()
    if (error !== undefined) fire(error, 'onRetry')
    await m.settle()

    expect(m.get.mock.calls.filter(call => call[0] === '/threads/t1')).toHaveLength(2)
    expect(byTestId(m.app, 'page-thread-header')).toBeDefined()
    expect(byStub(m.app, 'error-state')).toBeUndefined()
    m.app.unmount()
  })

  test('AC-12: the tab title gains the bullet prefix while a turn runs', async () => {
    const m = mountPage({ messages: [message({ status: 'streaming' })] })
    await m.settle()

    expect(headTitle(m.head())).toBe('• Plan the rollout')
    m.app.unmount()
  })

  test('AC-12 (control): the tab title is the bare thread title when no turn is running', async () => {
    const m = mountPage({ messages: [message({ status: 'complete' })] })
    await m.settle()

    expect(headTitle(m.head())).toBe('Plan the rollout')
    m.app.unmount()
  })

  test('AC-13: no /fleet/runners request is made while the thread request is still pending', async () => {
    const m = mountPage({ threadGet: 'pending' })
    await m.settle()

    expect(m.paths).toEqual(['/threads/t1'])
    expect(m.paths.filter(path => path.endsWith('/fleet/runners'))).toEqual([])
    // A pending thread is not a failed one: the page waits instead of claiming an error.
    expect(byStub(m.app, 'loading-state')).toBeDefined()
    expect(byStub(m.app, 'error-state')).toBeUndefined()

    m.resolveThread()
    await m.settle()

    expect(m.paths).toContain('/projects/acme/fleet/runners')
    expect(byTestId(m.app, 'page-thread-header')).toBeDefined()
    m.app.unmount()
  })
})
