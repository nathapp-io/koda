import { describe, expect, jest, test } from '@jest/globals'
import * as Vue from 'vue'
import { defineComponent, h, ref } from 'vue'
import type { VNodeChild } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import type { FakeNode } from '../helpers/mount-sfc'
import { i18nStub, toastRecorder, uiStubs, type ToastRecorder } from '../helpers/fleet-harness'
import { extractApiError } from '../../composables/useApi'
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
const ComposerStub = defineComponent({
  name: 'ThreadComposerStub',
  props: ['composerState', 'turnRunning'],
  emits: ['send', 'stop'],
  setup(_props, { attrs, emit }) {
    let draft = ''
    const children: VNodeChild[] = [
      h('textarea', {
        'data-testid': 'composer-input',
        onInput: (event: { target: { value: string } }) => { draft = event.target.value },
        onKeydown: (event: { key: string; shiftKey?: boolean }) => {
          if (event.key === 'Enter' && !event.shiftKey && draft.trim().length > 0) emit('send', draft)
        },
      }),
    ]
    return () => h('div', { ...attrs, 'data-testid': 'thread-composer' }, children)
  },
})

/** A ThreadControls double: buttons that emit the three actions. */
const ControlsStub = defineComponent({
  name: 'ThreadControlsStub',
  props: ['isCreator', 'canManage', 'sessionLabel', 'archived'],
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
  send: jest.Mock
  endSession: jest.Mock
  toasts: ToastRecorder
  settle: () => Promise<void>
}

function mountPage(over: { send?: jest.Mock } = {}): MountedPage {
  const thread = ref<ThreadDetailDto | null>(threadDetail())
  const messages = ref<ChatMessageDto[]>([])
  const toasts = toastRecorder()
  const send = over.send ?? jest.fn(async () => ({ ok: true }))
  const endSession = jest.fn(async () => ({ ok: true }))
  const app = mountSfc(pageFile, {
    components: {
      ...uiStubs,
      ThreadHeader: inertThreadStub,
      FleetThreadsThreadHeader: inertThreadStub,
      ThreadTimeline: inertThreadStub,
      FleetThreadsThreadTimeline: inertThreadStub,
      ThreadMessage: inertThreadStub,
      FleetThreadsThreadMessage: inertThreadStub,
      ThreadQuestionCard: inertThreadStub,
      FleetThreadsThreadQuestionCard: inertThreadStub,
      ThreadToolChip: inertThreadStub,
      FleetThreadsThreadToolChip: inertThreadStub,
      ThreadComposer: ComposerStub,
      FleetThreadsThreadComposer: ComposerStub,
      ThreadControls: ControlsStub,
      FleetThreadsThreadControls: ControlsStub,
    },
    globals: {
      definePageMeta: () => undefined,
      useI18n: () => i18nStub(),
      useAppToast: () => toasts,
      useRoute: () => ({ params: { project: 'web', id: 'th1' } }),
      useAuth: () => ({ user: ref({ id: 'u1', email: 'owner@k.t', role: 'MEMBER' }) }),
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
      useProjectViewerRole: () => ({ data: ref({ canManage: true, viewerRole: 'DEVELOPER' }) }),
    },
  })
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 6; i += 1) {
      await new Promise((resolve) => { setImmediate(resolve) })
      await Vue.nextTick()
    }
  }
  return { app, send, endSession, toasts, settle }
}

/** Types into the page's composer textarea and presses Enter, exactly as a user would. */
function typeAndEnter(app: { one: (s: string) => FakeNode | undefined }, text: string): boolean {
  const component = app.one('[data-testid="thread-composer"]')
  if (component === undefined) return false
  const input = app.one('[data-testid="composer-input"]')
  if (input === undefined) return false
  const onInput = input.props.onInput
  const onKeydown = input.props.onKeydown
  if (typeof onInput !== 'function' || typeof onKeydown !== 'function') return false
  ;(onInput as (event: { target: { value: string } }) => void)({ target: { value: text } })
  ;(onKeydown as (event: { key: string }) => void)({ key: 'Enter' })
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

    expect(m.send).toHaveBeenCalledWith('hello')
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
    m.app.unmount()
  })
})