import { describe, expect, jest, test } from '@jest/globals'
import * as Vue from 'vue'
import { defineComponent, h, ref } from 'vue'
import type { Ref } from 'vue'
import { loadSfc, mountSfc, webFile } from '../helpers/mount-sfc'
import type { FakeNode } from '../helpers/mount-sfc'
import { enI18n, i18nStub, toastRecorder, uiStubs, type ToastRecorder } from '../helpers/fleet-harness'
import { ApiError, extractApiError } from '../../composables/useApi'
import { projectPermissionsStub } from '../helpers/permission-nav'
import type { ApprovalRequestSummary } from '~/lib/approval-requests'
import { createThreadController } from '~/lib/thread-controller'
import type { ChatMessageDto, ThreadDetailDto } from '~/lib/thread-types'

/**
 * US-007 AC5, AC12, AC15: pages/[project]/threads/[id].vue — the detail page's wiring of
 * the composer and session controls.
 *
 * The page is mounted with the REAL page file but a stubbed useThread (US-003 covers the
 * controller), exactly like the US-006 detail-page spec. ThreadComposer / ThreadControls
 * are not created until US-007's implementation, so this spec registers test doubles that
 * implement the component contract (textarea where Enter emits `send`, Stop/end-session
 * controls that emit their events) under both the contract names and the Nuxt auto-import
 * names of a sub-directory component. The wiring under test — the page binding each emit
 * to the matching useThread method and the toast on a failed send — is all that the
 * assertions observe: typing into the composer textarea and pressing Enter must reach
 * `useThread().send('hello')`, an `endSession` emit must reach `endSession()` exactly
 * once, and a `{ ok: false, error }` send result must toast `extractApiError(error)`.
 */

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

/** An inert stand-in for the header/timeline components the page renders but this spec does not assert on. */
const inertThreadStub = defineComponent({
  name: 'InertThreadStub',
  setup: () => () => h('div', ''),
})

/**
 * A ThreadComposer double implementing the §4.62 contract: a textarea where Enter emits
 * `send` with the typed text (Shift+Enter never sends, whitespace never sends) and a Stop
 * control while `turnRunning`.
 */
/** The real composer, instantiated with the mounting test's translator so rendered copy can be asserted. */
const composerFor = (i18n: () => { t: (key: string, named?: Record<string, unknown>) => string; te: (key: string) => boolean }) =>
  loadSfc(webFile('components', 'fleet', 'threads', 'ThreadComposer.vue'), { useI18n: i18n })

/** A ThreadControls double: buttons that emit the three actions. */
const ActionBarStub = defineComponent({
  name: 'ThreadActionBarStub',
  emits: ['publish', 'plan', 'run'],
  setup(_props, { attrs, emit }) { return () => h('div', { ...attrs }, [
    h('button', { 'data-testid': 'handoff-plan', onClick: () => emit('plan', { maxCostUsd: 5 }) }),
    h('button', { 'data-testid': 'handoff-publish', onClick: () => emit('publish') }),
  ]) },
})

const ControlsStub = defineComponent({
  name: 'ThreadControlsStub',
  props: ['isCreator', 'canManage', 'sessionLabel', 'archived', 'maxCostUsd'],
  emits: ['endSession', 'raiseCap', 'archive'],
  setup(_props, { attrs, emit }) {
    return () => h('div', { ...attrs, 'data-testid': 'thread-controls' }, [
      h('button', { 'data-testid': 'controls-end-session', onClick: () => emit('endSession') }),
      h('button', { 'data-testid': 'controls-raise-cap', onClick: () => emit('raiseCap', 8) }),
      h('button', { 'data-testid': 'controls-archive', onClick: () => emit('archive') }),
    ])
  },
})

interface MountedPage {
  app: ReturnType<typeof mountSfc>
  messages: Ref<ChatMessageDto[]>
  send: jest.Mock
  plan: jest.Mock
  publish: jest.Mock
  endSession: jest.Mock
  toasts: ToastRecorder
  settle: () => Promise<void>
}

function mountPage(over: {
  send?: jest.Mock
  plan?: jest.Mock
  publish?: jest.Mock
  /** The transcript ref the page renders; the real controller writes into it when a test drives one. */
  messages?: Ref<ChatMessageDto[]>
  /** The translator the page and its children read; `i18nStub` unless a test asserts rendered copy. */
  i18n?: () => { t: (key: string, named?: Record<string, unknown>) => string; te: (key: string) => boolean }
} = {}): MountedPage {
  const thread = ref<ThreadDetailDto | null>(threadDetail())
  const messages = over.messages ?? ref<ChatMessageDto[]>([])
  const i18n = over.i18n ?? ((): ReturnType<typeof i18nStub> => i18nStub())
  const Composer = composerFor(i18n)
  const toasts = toastRecorder()
  const send = over.send ?? jest.fn(async () => ({ ok: true }))
  const endSession = jest.fn(async () => ({ ok: true }))
  const plan = over.plan ?? jest.fn(async () => ({ ok: true }))
  const publish = over.publish ?? jest.fn(async () => ({ ok: true }))
  const app = mountSfc(pageFile, {
    components: {
      ...uiStubs,
      ThreadHeader: inertThreadStub,
      FleetThreadsThreadHeader: inertThreadStub,
      FleetThreadsThreadStartFlow: { props: ['slug', 'thread'], template: '<aside data-testid="thread-start-flow" />' },
      FleetThreadsThreadPreApprovalCard: { props: ['slug', 'thread'], emits: ['changed'], template: '<button data-testid="thread-preapproval-card" @click="$emit(\'changed\')" />' },
      ThreadTimeline: inertThreadStub,
      FleetThreadsThreadTimeline: inertThreadStub,
      ThreadMessage: inertThreadStub,
      FleetThreadsThreadMessage: inertThreadStub,
      ThreadQuestionCard: inertThreadStub,
      FleetThreadsThreadQuestionCard: inertThreadStub,
      ThreadToolChip: inertThreadStub,
      FleetThreadsThreadToolChip: inertThreadStub,
      ThreadComposer: Composer,
      FleetThreadsThreadComposer: Composer,
      ThreadControls: ControlsStub,
      FleetThreadsThreadControls: ControlsStub,
      ThreadActionBar: ActionBarStub,
      FleetThreadsThreadActionBar: ActionBarStub,
      ThreadStaleBanner: inertThreadStub,
      FleetThreadsThreadStaleBanner: inertThreadStub,
    },
    globals: {
      definePageMeta: () => undefined,
      useI18n: i18n,
      useAppToast: () => toasts,
      useRoute: () => ({ params: { project: 'web', id: 'th1' } }),
      useAuth: () => ({ user: ref({ id: 'u1', email: 'owner@k.t', role: 'MEMBER' }) }),
      useProjectEvents: () => undefined,
      useThreadHandoffJobs: () => ({ jobs: ref({ plan: null, run: null }), sync: jest.fn(async () => undefined), refreshJob: jest.fn(async () => undefined), isHandoffJob: () => false }),
      useThread: () => ({
        thread,
        messages,
        live: ref(true),
        load: jest.fn(async () => undefined),
        start: jest.fn(),
        stop: jest.fn(),
        send,
        stopTurn: jest.fn(async () => ({ ok: true })),
        endSession,
        answer: jest.fn(async () => ({ ok: true })),
        raiseCap: jest.fn(async () => ({ ok: true })),
        archive: jest.fn(async () => ({ ok: true })),
        plan,
        publish,
        run: jest.fn(async () => ({ ok: true })),
        discard: jest.fn(async () => ({ ok: true })),
      }),
      useHead: () => undefined,
      useFleetDispatchOptions: () => ({
        runners: ref([]),
        repos: ref([]),
        moreRepos: ref(false),
        moreRunners: ref(false),
        profileOptions: ref([]),
        labelOptions: ref([]),
        load: jest.fn(async () => undefined),
        repoName: (id: string) => id,
        runnerName: (id: string | null) => id,
      }),
      // Permissions P1 US-007: ThreadControls' canManage prop follows the project `thread.archive` key.
      useProjectPermissions: () => projectPermissionsStub(['thread.archive', 'thread.message.send.own']),
    },
  })
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 6; i += 1) {
      await new Promise((resolve) => { setImmediate(resolve) })
      await Vue.nextTick()
    }
  }
  return { app, messages, send, plan, publish, endSession, toasts, settle }
}

/** Types into the page's composer textarea and presses Enter, exactly as a user would. */
function typeAndEnter(app: { one: (s: string) => FakeNode | undefined }, text: string): boolean {
  const component = app.one('[data-testid="thread-composer"]')
  if (component === undefined) return false
  const input = app.one('[data-testid="thread-composer-input"]')
  if (input === undefined) return false
  const onUpdate = input.props['onUpdate:modelValue']
  const onKeydown = input.props.onKeydown
  if (typeof onUpdate !== 'function' || typeof onKeydown !== 'function') return false
  ;(onUpdate as (value: string) => void)(text)
  ;(onKeydown as (event: { key: string; shiftKey?: boolean; preventDefault: () => void }) => void)({ key: 'Enter', preventDefault: () => undefined })
  return true
}

describe('US-007 AC5, AC12, AC15: pages/[project]/threads/[id].vue', () => {
  test('AC5: when ThreadControls emits endSession, the page calls useThread().endSession once', async () => {
    const m = mountPage()
    await m.settle()

    const end = m.app.one('[data-testid="controls-end-session"]')
    expect(end).toBeDefined()
    if (end === undefined) {
      m.app.unmount()
      return
    }
    (end.props.onClick as () => void)()
    await m.settle()

    expect(m.endSession).toHaveBeenCalledTimes(1)
    m.app.unmount()
  })

  test('AC12: typing hello in the ThreadComposer textarea and pressing Enter calls useThread().send with hello', async () => {
    const m = mountPage()
    await m.settle()

    expect(typeAndEnter(m.app, 'hello')).toBe(true)
    await m.settle()

    expect(m.send).toHaveBeenCalledTimes(1)
    expect(m.send).toHaveBeenCalledWith('hello')
    expect(m.app.one('[data-testid="thread-composer-input"]')?.props['model-value']).toBe('')
    m.app.unmount()
  })

  test('AC15: the page toasts extractApiError(error) when useThread().send resolves { ok: false, error }', async () => {
    const error = new Error('cap exceeded')
    const send = jest.fn(async () => ({ ok: false, error }))
    const m = mountPage({ send })
    await m.settle()

    expect(typeAndEnter(m.app, 'hello')).toBe(true)
    await m.settle()

    expect(m.toasts.errors).toEqual([extractApiError(error)])
    expect(m.app.one('[data-testid="thread-composer-input"]')?.props['model-value']).toBe('hello')
    m.app.unmount()
  })

  test('US-003 AC-14: action bar Plan calls the controller with its body', async () => {
    const m = mountPage()
    await m.settle()
    const button = m.app.one('[data-testid="handoff-plan"]')
    expect(button).toBeDefined()
    if (button?.props.onClick) (button.props.onClick as () => void)()
    await m.settle()
    expect(m.plan).toHaveBeenCalledWith({ maxCostUsd: 5 })
    m.app.unmount()
  })

  test('US-003 AC-15: a failed publish surfaces the API error via toast', async () => {
    const error = new ApiError(409, 'Runner offline')
    const publish = jest.fn(async () => ({ ok: false as const, error }))
    const m = mountPage({ publish })
    await m.settle()
    const button = m.app.one('[data-testid="handoff-publish"]')
    expect(button).toBeDefined()
    if (button?.props.onClick) (button.props.onClick as () => void)()
    await m.settle()
    expect(m.toasts.errors).toEqual([extractApiError(error)])
    m.app.unmount()
  })
})
/**
 * US-001: the message route is approval-gated, so a send can answer 202 with the approval request instead
 * of the message. These mounts run the REAL composer over the REAL thread controller, so the summary is
 * classified on the path the browser takes and the transcript is the controller's.
 */
describe('US-001: a thread send that waits for approval', () => {
  const REQUEST_ID = 'approval-thread.message.send'

  /** The body `ApprovalPendingFilter` answers a gated send with (HTTP 202), already unwrapped by `useApi`. */
  const pendingSummary = (): ApprovalRequestSummary => ({
    id: REQUEST_ID,
    permissionKey: 'thread.message.send',
    projectId: 'p1',
    actorType: 'USER',
    actorId: 'u1',
    onBehalfOfType: null,
    onBehalfOfId: null,
    origin: 'rest',
    redeem: false,
    requiredMode: 'human',
    status: 'pending',
    satisfiedBy: null,
    approverType: null,
    approverId: null,
    expiresAt: '2026-11-25T00:10:00.000Z',
    decidedAt: null,
    settledAt: null,
    createdAt: '2026-11-25T00:00:00.000Z',
  })

  /** A real controller over a fake API: only the messages route matters to these tests. */
  function controllerFor(post: jest.Mock) {
    return createThreadController({
      api: { get: jest.fn(async () => threadDetail()), post, patch: jest.fn() },
      slug: 'web',
      threadId: 'th1',
      openStream: () => ({ close: () => undefined }),
      setTimer: () => null,
      clearTimer: () => undefined,
      now: () => Date.parse('2026-11-25T00:00:00.000Z'),
    })
  }

  const sentMessage = (body: { clientMessageId: string; text: string }): ChatMessageDto => ({
    id: 'srv-1',
    seq: 1,
    jobId: null,
    turnId: null,
    role: 'user',
    authorUserId: 'u1',
    clientMessageId: body.clientMessageId,
    content: body.text,
    toolSummary: null,
    status: 'pending',
    errorReason: null,
    usage: null,
    costUsd: null,
    costSource: null,
    createdAt: '2026-11-25T00:00:00.000Z',
  })

  test('AC-3: the composer names the returned request id and no refusal is toasted', async () => {
    const controller = controllerFor(jest.fn(async () => pendingSummary()))
    const m = mountPage({ send: jest.fn(controller.send), messages: controller.messages, i18n: () => enI18n() })
    await m.settle()

    expect(typeAndEnter(m.app, 'hello')).toBe(true)
    await m.settle()

    const note = m.app.one('[data-testid="thread-composer-pending"]')
    expect(note).toBeDefined()
    expect(note ? m.app.textOf(note) : '').toContain(REQUEST_ID)
    // A pending approval is not a send refusal: the page shows no error for it.
    expect(m.toasts.errors).toEqual([])
    m.app.unmount()
  })

  test('AC-9: the transcript returns to its pre-submit messages', async () => {
    let answer: (value: unknown) => void = () => undefined
    const post = jest.fn(() => new Promise<unknown>((resolve) => { answer = resolve }))
    const controller = controllerFor(post)
    const m = mountPage({ send: jest.fn(controller.send), messages: controller.messages })
    await m.settle()
    const before = [...controller.messages.value]
    expect(before).toEqual([])

    expect(typeAndEnter(m.app, 'hello')).toBe(true)
    await m.settle()
    // While the POST is in flight the optimistic echo is held…
    expect(controller.messages.value.map(message => message.id)).toEqual([`local:${controller.messages.value[0].clientMessageId}`])
    expect(controller.messages.value[0].content).toBe('hello')

    answer(pendingSummary())
    await m.settle()

    // …and the pending answer leaves the transcript exactly as it was.
    expect(controller.messages.value).toEqual(before)
    m.app.unmount()
  })

  test('AC-13: an executed answer replaces the optimistic message and clears the draft', async () => {
    const post = jest.fn(async (_path: string, body: { clientMessageId: string; text: string }) => ({
      message: sentMessage(body),
      jobId: null,
    }))
    const controller = controllerFor(post)
    const m = mountPage({ send: jest.fn(controller.send), messages: controller.messages })
    await m.settle()

    expect(typeAndEnter(m.app, 'hello')).toBe(true)
    await m.settle()

    expect(controller.messages.value.map(message => message.id)).toEqual(['srv-1'])
    expect(controller.messages.value.some(message => message.id.startsWith('local:'))).toBe(false)
    expect(m.app.one('[data-testid="thread-composer-input"]')?.props['model-value']).toBe('')
    expect(m.app.one('[data-testid="thread-composer-pending"]')).toBeUndefined()
    m.app.unmount()
  })
})
