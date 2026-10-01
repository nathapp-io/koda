import { describe, test, expect, afterEach, jest } from '@jest/globals'
import * as Vue from 'vue'
import { ref, computed, watch, nextTick } from 'vue'
import { mountSfc } from '../helpers/mount-sfc'
import {
  enrollmentDialog, runnerEditDialog, uiStubs, enI18n, toastRecorder,
} from '../helpers/fleet-harness'
import * as apiModule from '../../composables/useApi'
import { ApiError } from '../../composables/useApi'
import { useFleetRunners } from '../../composables/useFleetRunners'
import type { FleetEnrollmentCreated, FleetRunner } from '../../lib/fleet-types'
import type { FakeNode } from '../helpers/mount-sfc'

type Node = FakeNode

const runner: FleetRunner = {
  id: 'alpha', name: 'alpha', os: 'linux', arch: 'x64', labels: ['gpu', 'linux'], capacity: 3,
  capabilities: {}, daemonVersion: '0.1.0', protocolVersion: 1, enabled: true,
  lastSeenAt: '2026-10-01T12:00:00Z', createdAt: '2026-10-01T00:00:00Z',
  bootId: 'b1', bootedAt: '2026-10-01T12:00:00Z', online: true,
}

const enrollment: FleetEnrollmentCreated = {
  id: 'e1', labels: ['gpu'], expiresAt: '2026-10-02T00:00:00Z', usedAt: null,
  runnerId: null, createdById: 'u1', createdAt: '2026-10-01T00:00:00Z', token: 'ke_secret',
}

interface Api {
  get: jest.Mock
  patch: jest.Mock
  post: jest.Mock
  delete: jest.Mock
}

function harness(over: Partial<Api> = {}): { api: Api; toasts: ReturnType<typeof toastRecorder>; flush: () => Promise<void> } {
  const api: Api = {
    get: jest.fn(async () => ({ records: [runner], total: 1, current: 1, size: 100, hasNext: false, hasPrev: false })),
    patch: jest.fn(async () => runner),
    post: jest.fn(async () => enrollment),
    delete: jest.fn(async () => ({})),
    ...over,
  }
  const toasts = toastRecorder()
  ;(globalThis as Record<string, unknown>).useApi = () => ({ $api: api })
  globalThis.window = { location: { origin: 'https://koda.example.com' } } as never
  globalThis.navigator = { clipboard: { writeText: jest.fn(async () => undefined) } } as never
  // A pending request settles through several microtask and macrotask hops (vee-validate's
  // validation, then the fetch), so drain both before asserting.
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 6; i += 1) {
      await new Promise((resolve) => { setImmediate(resolve) })
      await new Promise((resolve) => { setTimeout(resolve, 0) })
      await Vue.nextTick()
    }
  }
  return { api, toasts, flush }
}

const mountDialog = (file: string, props: Record<string, unknown>, api: Api, toasts: ReturnType<typeof toastRecorder>) =>
  mountSfc(file, {
    components: uiStubs,
    props,
    alias: { '~/composables/useApi': apiModule },
    globals: {
      ref, computed, watch, nextTick,
      onMounted: Vue.onMounted,
      onBeforeUnmount: Vue.onBeforeUnmount,
      useI18n: () => enI18n(),
      useAppToast: () => toasts,
      useApi: () => ({ $api: api }),
      useFleetRunners: () => useFleetRunners(),
    },
  })

/** Fails with a clear message instead of a null-dereference, so a missing node reads as a cause. */
function requireNode(found: Node | undefined, what: string): Node {
  if (!found) throw new Error(`no ${what} rendered`)
  return found
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).window
  delete (globalThis as Record<string, unknown>).navigator
  delete (globalThis as Record<string, unknown>).useApi
})

describe('Fleet enrollment token dialog (behaviour)', () => {
  test('submitting posts to the enrollments endpoint and then shows the token and enroll command', async () => {
    const { api, toasts, flush } = harness()
    const app = mountDialog(enrollmentDialog, { open: true }, api, toasts)
    await flush()

    const form = app.one('form')
    await (form.props.onSubmit as () => Promise<void>)()
    await flush()

    // The labels field starts empty (parseLabels('') is []); label parsing itself is unit-tested.
    expect(api.post).toHaveBeenCalledWith('/fleet/enrollments', { labels: [] })
    expect(app.text()).toContain('ke_secret')
    expect(app.text()).toContain('koda-runner enroll --server https://koda.example.com --token ke_secret')
    app.unmount()
  })

  test('the token is hidden again after closing, because it is shown once', async () => {
    const { api, toasts, flush } = harness()
    const app = mountDialog(enrollmentDialog, { open: true }, api, toasts)
    await flush()
    await (app.one('form').props.onSubmit as () => Promise<void>)()
    await flush()
    expect(app.text()).toContain('ke_secret')

    // Done closes: the dialog emits false, and a fresh mount shows the form again with no token.
    app.emitted('update:open')
    const done = app.find('[data-stub="button"]').find((b) => app.textOf(b) === 'Done')
    ;(done.props.onClick as () => void)()
    await Vue.nextTick()
    expect(app.emitted('update:open').at(-1)).toEqual([false])

    const reopened = mountDialog(enrollmentDialog, { open: true }, api, toasts)
    await flush()
    expect(reopened.text()).not.toContain('ke_secret')
    app.unmount()
    reopened.unmount()
  })

  test('Esc and an outside click are refused while a token is showing', async () => {
    const { api, toasts, flush } = harness()
    const app = mountDialog(enrollmentDialog, { open: true }, api, toasts)
    await flush()
    await (app.one('form').props.onSubmit as () => Promise<void>)()
    await flush()

    const content = requireNode(app.one('[data-stub="dialog-content"]'), 'dialog content')
    const escape = { preventDefault: jest.fn() }
    const outside = { preventDefault: jest.fn() }
    ;(content.props.onEscapeKeyDown as (e: unknown) => void)(escape)
    ;(content.props.onInteractOutside as (e: unknown) => void)(outside)

    expect(escape.preventDefault).toHaveBeenCalled()
    expect(outside.preventDefault).toHaveBeenCalled()
    app.unmount()
  })

  test('Esc and an outside click are refused while the create request is in flight', async () => {
    let release: (v: FleetEnrollmentCreated) => void = () => undefined
    const { api, toasts, flush } = harness({
      post: jest.fn(() => new Promise((resolve) => { release = resolve as never })),
    })
    const app = mountDialog(enrollmentDialog, { open: true }, api, toasts)
    await flush()

    // Deliberately not awaited: the request stays in flight while the close paths are exercised.
    void (app.one('form').props.onSubmit as () => Promise<void>)()
    await Vue.nextTick()

    // Closing now would drop a token the server has already minted, and shown only once.
    const content = requireNode(app.one('[data-stub="dialog-content"]'), 'dialog content')
    const escape = { preventDefault: jest.fn() }
    const outside = { preventDefault: jest.fn() }
    ;(content.props.onEscapeKeyDown as (e: unknown) => void)(escape)
    ;(content.props.onInteractOutside as (e: unknown) => void)(outside)
    expect(escape.preventDefault).toHaveBeenCalled()
    expect(outside.preventDefault).toHaveBeenCalled()

    // Cancel is disabled too, so the token cannot be discarded by clicking it either.
    const cancel = app.find('[data-stub="button"]').find((b) => app.textOf(b) === 'Cancel')
    expect(cancel.props.disabled).toBe(true)

    release(enrollment)
    app.unmount()
  })

  // The `tokenLost` toast is a safety net for a late reply after a close that raced the request. With
  // guardClose refusing every close while submitting, that path is unreachable through the UI, so it
  // is left as defence in depth rather than pinned by a test that would have to fake the race.

  test('a failed create toasts the API message and shows no token', async () => {
    const { api, toasts, flush } = harness({
      post: jest.fn(async () => { throw new ApiError(40010, 'not allowed') }),
    })
    const app = mountDialog(enrollmentDialog, { open: true }, api, toasts)
    await flush()
    await (app.one('form').props.onSubmit as () => Promise<void>)()
    await flush()

    expect(toasts.errors).toEqual(['not allowed'])
    expect(app.text()).not.toContain('ke_secret')
    app.unmount()
  })

  test('copying a token without a Clipboard API reports it instead of failing silently', async () => {
    const { api, toasts, flush } = harness()
    ;(globalThis as Record<string, unknown>).navigator = {} as never
    const app = mountDialog(enrollmentDialog, { open: true }, api, toasts)
    await flush()
    await (app.one('form').props.onSubmit as () => Promise<void>)()
    await flush()

    // Plain http (the VPN phase) has no navigator.clipboard: `copy` must toast, not crash.
    const copy = app.find('[data-stub="button"]').find((b) => app.textOf(b) === 'Copy')
    ;(copy.props.onClick as () => Promise<void>)()
    await flush()

    expect(toasts.errors).toHaveLength(1)
    app.unmount()
  })
})

describe('Fleet runner edit dialog (behaviour)', () => {
  test('submitting patches both labels and capacity, then emits saved and closes', async () => {
    const { api, toasts, flush } = harness()
    const app = mountDialog(runnerEditDialog, { open: true, runner }, api, toasts)
    await flush()

    const form = app.one('form')
    await (form.props.onSubmit as () => Promise<void>)()
    await flush()

    expect(api.patch).toHaveBeenCalledWith('/fleet/runners/alpha', { labels: ['gpu', 'linux'], capacity: 3 })
    expect(app.emitted('saved')).toHaveLength(1)
    expect(app.emitted('update:open').at(-1)).toEqual([false])
    expect(toasts.successes).toHaveLength(1)
    app.unmount()
  })

  test('a failed patch toasts the API message and leaves the dialog open', async () => {
    const { api, toasts, flush } = harness({
      patch: jest.fn(async () => { throw new Error('runner is busy') }),
    })
    const app = mountDialog(runnerEditDialog, { open: true, runner }, api, toasts)
    await flush()
    await (app.one('form').props.onSubmit as () => Promise<void>)()
    await flush()

    expect(toasts.errors).toEqual(['runner is busy'])
    expect(app.emitted('saved')).toHaveLength(0)
    expect(app.emitted('update:open')).toHaveLength(0)
    app.unmount()
  })

  test('the capacity field is bounded by the API range', async () => {
    const { api, toasts, flush } = harness()
    const app = mountDialog(runnerEditDialog, { open: true, runner }, api, toasts)
    await flush()

    const numbers = app.find('[data-stub="input"]').filter((i) => i.props.type === 'number')
    expect(numbers).toHaveLength(1)
    expect(numbers[0].props.min).toBe(1)
    expect(numbers[0].props.max).toBe(16)
    app.unmount()
  })
})