/**
 * US-004: the Memory page retire flow, driven through the real page, the real `useMemory` /
 * `useProjectRef` composables and the real `MemoryRetireDialog`.
 *
 * Only the API client is a double: `$api` records every GET/POST, so the assertions are on the
 * requests the browser would make (AC-1/AC-2's POST, AC-6's page-1 refresh, AC-8/AC-12's absent
 * refresh) rather than on a mocked composable's internals. The page reads its API through Nuxt's
 * auto-imported `useApi` (globals below) while `useMemory` is instantiated from its real module, so
 * `globalThis.useApi` is the seam that module sees (the pattern `add-skill-source-dialog.spec.ts`
 * uses for the same reason).
 */
import { afterEach, describe, expect, jest, test } from '@jest/globals'
import { h, nextTick } from 'vue'
import type { VNodeChild } from 'vue'
import { loadSfc, mountSfc, webFile } from '../helpers/mount-sfc'
import type { Mounted } from '../helpers/mount-sfc'
import { i18nStub, toastRecorder, uiStubs } from '../helpers/fleet-harness'
import { projectPermissionsStub } from '../helpers/permission-nav'
import * as apiModule from '../../composables/useApi'
import { ApiError } from '../../composables/useApi'
import * as memoryModule from '../../composables/useMemory'

const page = webFile('pages', '[project]', 'memory.vue')
const dialogFile = webFile('components', 'memory', 'MemoryRetireDialog.vue')
const formFieldFile = webFile('components', 'ui', 'form', 'FormField.vue')
const formMessageFile = webFile('components', 'ui', 'form', 'FormMessage.vue')

/** Every label the page renders is its i18n key, so a button is addressed by the key it shows. */
const t = i18nStub().t

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) {
    await new Promise((resolve) => { setImmediate(resolve) })
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    await nextTick()
  }
}

function memoryItem(kind: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: kind === 'NOTE' ? 'n1' : 'm1',
    subject: 'subject',
    predicate: 'predicate',
    object: 'body',
    kind,
    confidence: 1,
    status: 'active',
    description: 'description',
    scope: 'project',
    ...over,
  }
}

function memoryAnswer(records: unknown[], over: Record<string, unknown> = {}): Record<string, unknown> {
  return { records, total: records.length, current: 1, size: 20, hasNext: false, hasPrev: false, ...over }
}

/**
 * A native `button` keeps the row action and the dialog's confirm button clickable and lets a test
 * read `disabled` off the element. The real `MemoryRetireDialog` is mounted, never stubbed; its
 * `Dialog` renders its content only while `open`, exactly as the shadcn primitive does, so
 * "the confirm button is gone" means "the dialog closed".
 */
const Button = { template: '<button><slot /></button>' }
const Dialog = {
  name: 'StubDialog',
  props: { open: { type: Boolean, default: false } },
  inheritAttrs: false,
  setup(props: { open: boolean }, { slots }: { slots: Record<string, (() => VNodeChild) | undefined> }) {
    return () => h('div', { 'data-stub': 'dialog', open: props.open }, props.open ? (slots.default?.() as VNodeChild[]) : [])
  },
}
const PageHeader = { template: '<div><slot name="icon" /><slot /></div>' }
const FilterBar = { template: '<div><slot /></div>' }
const LoadingState = { template: '<div />' }

const keysFor = (kind: string): string[] => (kind === 'NOTE' ? ['memory.create'] : ['memory.decision.retire'])

interface SetupOptions {
  kind?: string
  /** Ordered answers to `GET /projects/sb/memory`, one per call (the last one repeats). */
  memory?: unknown[]
  project?: () => Promise<unknown>
  post?: (path: string, body: Record<string, unknown>) => Promise<unknown>
}

function setup(options: SetupOptions = {}) {
  const kind = options.kind ?? 'DECISION'
  const answers = options.memory ?? [memoryAnswer([memoryItem(kind)])]
  const projectAnswer = options.project ?? (async () => ({ id: 'project-id' }))
  const postAnswer = options.post ?? (async () => ({}))

  const memoryRequests: Array<Record<string, string> | undefined> = []
  const projectRequests: string[] = []
  const posts: Array<{ path: string; body: Record<string, unknown> }> = []
  const toasts = toastRecorder()

  const api = {
    get: jest.fn(async (path: string, request?: { query?: Record<string, string> }) => {
      if (path === '/projects/sb/memory') {
        memoryRequests.push(request?.query)
        return answers[Math.min(memoryRequests.length - 1, answers.length - 1)] ?? memoryAnswer([])
      }
      projectRequests.push(path)
      return projectAnswer()
    }),
    post: jest.fn(async (path: string, body: Record<string, unknown>) => {
      posts.push({ path, body })
      return postAnswer(path, body)
    }),
  }

  // The page resolves its project id and lists memory through the real composables, which read the
  // Nuxt auto-imported `useApi`. The globals below cover the composables the harness instantiates;
  // `globalThis.useApi` covers the copy this spec imports to capture the composable's refs.
  ;(globalThis as Record<string, unknown>).useApi = () => ({ $api: api })
  const captured: { memory?: ReturnType<typeof memoryModule.useMemory> } = {}
  const memoryExports = {
    useMemory: (slug: string) => {
      const memory = memoryModule.useMemory(slug)
      captured.memory = memory
      return memory
    },
    watchDebouncedMemorySearch: memoryModule.watchDebouncedMemorySearch,
  }

  const app = mountSfc(page, {
    components: {
      ...uiStubs,
      Button,
      Dialog,
      PageHeader,
      FilterBar,
      LoadingState,
      FormField: loadSfc(formFieldFile),
      FormMessage: loadSfc(formMessageFile),
      MemoryRetireDialog: loadSfc(dialogFile, { useI18n: () => i18nStub() }),
    },
    alias: { '~/composables/useMemory': memoryExports, '~/composables/useApi': apiModule },
    globals: {
      useRoute: () => ({ params: { project: 'sb' } }),
      useI18n: () => i18nStub(),
      useAppToast: () => toasts,
      useProjectPermissions: () => projectPermissionsStub(keysFor(kind)),
      useApi: () => ({ $api: api }),
    },
  })

  return {
    app,
    toasts,
    memoryRequests,
    projectRequests,
    posts,
    memory: () => captured.memory,
  }
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).useApi
})

function buttonByText(app: Mounted, text: string) {
  return app.find('button').find((candidate) => app.textOf(candidate) === text)
}

/** The dialog's confirm button, or `undefined` when the dialog is closed. */
function confirmButton(app: Mounted) {
  return buttonByText(app, t('memory.retire.confirm'))
}

/** Clicks the row's Retire action and waits for the dialog to render. */
async function openRetire(app: Mounted): Promise<void> {
  const action = buttonByText(app, t('memory.retire.action'))
  expect(action).toBeDefined()
  ;(action?.props.onClick as (() => void) | undefined)?.()
  await flush()
  expect(app.one('form')).toBeDefined()
  expect(confirmButton(app)).toBeDefined()
}

function typeReason(app: Mounted, value: string): void {
  const field = app.one('[data-testid="memory-retire-reason"]')
  expect(field).toBeDefined()
  ;(field?.props['onUpdate:modelValue'] as ((value: string) => void) | undefined)?.(value)
}

/** Submits the dialog's real vee-validate form, as pressing "Retire memory" in a browser would. */
async function submit(app: Mounted): Promise<void> {
  const form = app.one('form')
  expect(form).toBeDefined()
  await (form?.props.onSubmit as ((event: { preventDefault: () => void }) => Promise<void>) | undefined)?.({ preventDefault: () => undefined })
  await flush()
}

describe('US-004 Memory retire flow', () => {
  test('AC-1: confirming a DECISION row posts the typed reason for that row', async () => {
    const x = setup({ kind: 'DECISION' })
    await flush()
    await openRetire(x.app)
    typeReason(x.app, 'obsolete')
    await flush()
    await submit(x.app)
    expect(x.posts).toEqual([{ path: '/memory/m1/retire', body: { reason: 'obsolete' } }])
    x.app.unmount()
  })

  test('AC-2: confirming a NOTE row sends the project id the slug resolved to', async () => {
    const x = setup({ kind: 'NOTE' })
    await flush()
    await openRetire(x.app)
    typeReason(x.app, 'duplicate')
    await flush()
    await submit(x.app)
    expect(x.projectRequests).toEqual(['/projects/sb'])
    expect(x.posts).toEqual([{ path: '/memory/notes/n1/retire', body: { projectId: 'project-id', reason: 'duplicate' } }])
    x.app.unmount()
  })

  test('AC-3/AC-4: a failed project lookup toasts its message and sends no retire POST', async () => {
    const x = setup({ kind: 'NOTE', project: async () => { throw new ApiError(404, 'Project missing') } })
    await flush()
    await openRetire(x.app)
    await submit(x.app)
    expect(x.toasts.errors).toEqual(['Project missing'])
    expect(x.posts).toHaveLength(0)
    x.app.unmount()
  })

  test('AC-5/AC-13: a retired answer toasts memory.retire.done and closes the dialog', async () => {
    const x = setup({ kind: 'DECISION', post: async () => ({ id: 'm1', status: 'retired' }) })
    await flush()
    await openRetire(x.app)
    await submit(x.app)
    expect(x.toasts.successes).toEqual(['memory.retire.done'])
    expect(confirmButton(x.app)).toBeUndefined()
    x.app.unmount()
  })

  test('AC-6: after Load more, a retired answer refreshes page 1 through applyFilters', async () => {
    const x = setup({
      kind: 'DECISION',
      memory: [
        memoryAnswer([memoryItem('DECISION')], { hasNext: true }),
        memoryAnswer([memoryItem('DECISION', { id: 'm2' })], { current: 2 }),
      ],
    })
    await flush()
    expect(x.memoryRequests).toHaveLength(1)

    const loadMore = buttonByText(x.app, t('memory.loadMore'))
    expect(loadMore).toBeDefined()
    ;(loadMore?.props.onClick as (() => void) | undefined)?.()
    await flush()
    expect(x.memoryRequests[1]).toEqual({ current: '2' })

    await openRetire(x.app)
    await submit(x.app)
    expect(x.memoryRequests).toHaveLength(3)
    expect(x.memoryRequests[2] ?? {}).not.toHaveProperty('current')
    x.app.unmount()
  })

  test('AC-7/AC-8/AC-9: a pending answer toasts, closes the dialog and does not refresh', async () => {
    const x = setup({ kind: 'DECISION', post: async () => ({ permissionKey: 'memory.decision.retire' }) })
    await flush()
    await openRetire(x.app)
    await submit(x.app)
    expect(x.toasts.successes).toEqual(['memory.retire.pending'])
    expect(x.memoryRequests).toHaveLength(1)
    expect(confirmButton(x.app)).toBeUndefined()
    x.app.unmount()
  })

  test.each<[string, Error]>([
    ['403', new ApiError(403, 'Decision is not active')],
    ['404', new ApiError(404, 'Decision is not active')],
    ['409', new ApiError(409, 'Decision is not active')],
    ['422', new ApiError(422, 'Decision is not active')],
    ['400', new ApiError(400, 'Decision is not active')],
    ['a network', new Error('Failed to fetch')],
  ])('AC-10/AC-11/AC-12: a %s rejection toasts, keeps the dialog open and does not refresh', async (_status, failure) => {
    const x = setup({ kind: 'DECISION', post: async () => { throw failure } })
    await flush()
    await openRetire(x.app)
    await submit(x.app)
    expect(x.toasts.errors).toEqual([failure.message])
    expect(x.memoryRequests).toHaveLength(1)
    expect(confirmButton(x.app)).toBeDefined()
    x.app.unmount()
  })

  test('AC-14: the confirm button is disabled while the retire request is in flight', async () => {
    let release: (value: unknown) => void = () => undefined
    const x = setup({ kind: 'DECISION', post: () => new Promise((resolve) => { release = resolve }) })
    await flush()
    await openRetire(x.app)
    await submit(x.app)
    expect(x.posts).toHaveLength(1)
    expect(confirmButton(x.app)?.props.disabled).toBe(true)
    release({})
    await flush()
    expect(confirmButton(x.app)).toBeUndefined()
    x.app.unmount()
  })

  test('AC-15: a completed retire keeps the selected status filter on the refresh', async () => {
    const x = setup({ kind: 'DECISION' })
    await flush()
    const memory = x.memory()
    expect(memory).toBeDefined()
    if (memory) memory.statusFilter.value = 'active'
    await openRetire(x.app)
    typeReason(x.app, 'obsolete')
    await flush()
    await submit(x.app)
    expect(x.memoryRequests).toHaveLength(2)
    expect(x.memoryRequests[1]).toEqual({ status: 'active' })
    x.app.unmount()
  })
})
