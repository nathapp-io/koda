import { describe, expect, jest, test } from '@jest/globals'
import * as Vue from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import type { Mounted } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'
import { ApiError, extractApiError } from '../../composables/useApi'
import { createThreadController } from '~/lib/thread-controller'
import type { ThreadDetailDto, ThreadMode } from '~/lib/thread-types'

/**
 * thread-agents-modes US-012 AC-1..AC-4: components/fleet/threads/ThreadModeControl.vue — the REPO thread's
 * execution-profile control.
 *
 * The control is handed the shared thread controller's `changeMode` action, so the transport under assertion is
 * the real one: `PATCH /projects/<slug>/threads/<id>/mode` with `{ mode }` (US-005). `allowed` is what the page
 * derived from the caller's permission keys (`read` needs `thread.cap.update`, `ask`/`full` their own
 * `thread.mode.*`), so a mode outside it renders disabled.
 */

const controlFile = webFile('components', 'fleet', 'threads', 'ThreadModeControl.vue')

const thread = (over: Partial<ThreadDetailDto> = {}): ThreadDetailDto => ({
  id: 'th1',
  kind: 'REPO',
  repoId: 'r1',
  baseRef: 'main',
  feature: 'add-auth',
  title: 'Auth spec',
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
  sendRefusal: null,
  writtenPaths: [],
  publishedSha: null,
  specPublished: false,
  lastWrite: null,
  handoff: { plan: null, run: null },
  mode: 'read',
  pendingApprovals: [],
  ...over,
})

const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) {
    await new Promise((resolve) => { setImmediate(resolve) })
    await Vue.nextTick()
  }
}

/**
 * Mounts the control over the REAL thread controller (fake `$api`), so a click reaches the same path and body the
 * browser sends. `patch` is the recorded transport; it rejects with `patchError` when the test simulates a refusal.
 */
function mountControl(over: {
  thread?: ThreadDetailDto
  allowed?: ThreadMode[]
  patchError?: unknown
  slug?: string
} = {}) {
  const get = jest.fn(async () => thread())
  const post = jest.fn(async () => ({}))
  const patch = jest.fn(async () => {
    if (over.patchError !== undefined) throw over.patchError
    return {}
  })
  const controller = createThreadController({
    api: { get, post, patch },
    slug: over.slug ?? 'acme',
    threadId: 'th1',
    openStream: () => ({ close: () => undefined }),
    setTimer: () => 0,
    clearTimer: () => undefined,
    now: () => 0,
  })
  const app: Mounted = mountSfc(controlFile, {
    props: {
      thread: over.thread ?? thread(),
      allowed: over.allowed ?? (['read', 'ask', 'full'] as ThreadMode[]),
      changeMode: controller.changeMode,
    },
    components: uiStubs,
    globals: { useI18n: () => enI18n() },
  })
  const byId = (id: string): ReturnType<Mounted['one']> => app.one(`[data-testid="${id}"]`)
  return {
    app,
    get,
    patch,
    byId,
    textOf: (id: string): string => {
      const found = byId(id)
      return found === undefined ? '' : app.textOf(found)
    },
    click: (id: string): void => {
      const found = byId(id)
      const onClick = found?.props.onClick
      if (typeof onClick === 'function') (onClick as () => void)()
    },
    disabled: (id: string): unknown => byId(id)?.props.disabled,
    pressed: (id: string): unknown => byId(id)?.props['aria-pressed'],
  }
}

describe('US-012 AC-1..AC-4: ThreadModeControl', () => {
  test("AC-1: the thread's current mode (ask) renders as the selected mode", async () => {
    const m = mountControl({ thread: thread({ mode: 'ask' }) })
    await settle()

    expect(m.pressed('thread-mode-ask')).toBe('true')
    expect(m.pressed('thread-mode-read')).toBe('false')
    expect(m.pressed('thread-mode-full')).toBe('false')
    m.app.unmount()
  })

  test('AC-2: choosing Ask calls the mode endpoint with { mode: ask }', async () => {
    const m = mountControl({ thread: thread({ mode: 'read' }) })
    await settle()

    m.click('thread-mode-ask')
    await settle()

    expect(m.patch).toHaveBeenCalledTimes(1)
    expect(m.patch).toHaveBeenCalledWith('/projects/acme/threads/th1/mode', { mode: 'ask' })
    m.app.unmount()
  })

  test('AC-3: Full is disabled when the caller lacks thread.mode.full, and the other modes stay usable', async () => {
    const m = mountControl({ allowed: ['read', 'ask'] })
    await settle()

    expect(m.disabled('thread-mode-full')).toBe(true)
    expect(m.disabled('thread-mode-read')).toBe(false)
    expect(m.disabled('thread-mode-ask')).toBe(false)
    m.app.unmount()
  })

  test('AC-3 (control): Full is enabled when the caller holds thread.mode.full', async () => {
    const m = mountControl({ allowed: ['read', 'ask', 'full'] })
    await settle()

    expect(m.disabled('thread-mode-full')).toBe(false)
    m.app.unmount()
  })

  test('AC-4: a 409 from the mode endpoint renders the API message in the control', async () => {
    const error = new ApiError(409, 'A turn is running. Stop it to change the mode.')
    const m = mountControl({ patchError: error })
    await settle()

    m.click('thread-mode-ask')
    await settle()

    expect(m.textOf('thread-mode-error')).toBe(extractApiError(error))
    expect(m.textOf('thread-mode-error')).toBe('A turn is running. Stop it to change the mode.')
    m.app.unmount()
  })
})
