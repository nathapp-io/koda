import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals'
import { ApiError } from '~/composables/useApi'
import type { AgentChoice } from '~/lib/thread-create'
import type { ThreadAgent } from '~/lib/thread-types'
import { i18nStub, toastRecorder } from '../helpers/fleet-harness'
import type { ToastRecorder } from '../helpers/fleet-harness'
import { useAgentRecheck } from '~/composables/useAgentRecheck'

/**
 * US-009 AC-1..AC-7: `useAgentRecheck` — ask the runners to probe again, then re-read the runner
 * list until a fresh result arrives (or the bound is reached).
 *
 * The composable reads `useApi`, `useAppToast` and `useI18n` as Nuxt auto-imports, so the spec
 * installs them on globalThis the way `tests/composables/useFleetDispatchOptions.spec.ts` does.
 */

const g = globalThis as Record<string, unknown>

const T0 = '2026-11-22T02:00:00.000Z'
const LATER = '2026-11-22T02:05:00.000Z'

/** A codex choice that is not ready, with the two runners that could probe it. */
const codexChoice = (checkedAt: string | null): AgentChoice => ({
  agent: 'codex',
  available: false,
  reason: 'notReady',
  probe: { code: 'timeout', checkedAt, runnerIds: ['r1', 'r2'] },
  models: [],
  efforts: [],
})

/** A codex choice a fresh probe made startable. */
const readyCodex = (checkedAt: string): AgentChoice => ({
  agent: 'codex',
  available: true,
  reason: null,
  models: ['gpt-5-codex'],
  efforts: [],
  probe: { code: null, checkedAt, runnerIds: [] },
})

/** A claude choice that is not ready, on its own runner. */
const claudeChoice = (checkedAt: string | null): AgentChoice => ({
  agent: 'claude',
  available: false,
  reason: 'notReady',
  probe: { code: 'unavailable', checkedAt, runnerIds: ['r3'] },
  models: [],
  efforts: [],
})

interface Harness {
  post: jest.Mock
  reload: jest.Mock
  read: jest.Mock
  toasts: ToastRecorder
}

function harness(): Harness {
  const post = jest.fn(async () => ({}))
  const reload = jest.fn(async (): Promise<void> => undefined)
  const read = jest.fn((_agent: ThreadAgent): AgentChoice | undefined => codexChoice(T0))
  const toasts = toastRecorder()
  g.useApi = () => ({ $api: { post } })
  g.useAppToast = () => toasts
  g.useI18n = () => i18nStub()
  return { post, reload, read, toasts }
}

beforeEach(() => {
  jest.useRealTimers()
})

afterEach(() => {
  jest.useRealTimers()
  delete g.useApi
  delete g.useAppToast
  delete g.useI18n
})

describe('US-009 AC-1, AC-2: the re-probe request', () => {
  test('AC-1: posts /fleet/runners/<id>/reprobe once per probe runner id, with no body', async () => {
    const h = harness()
    const { recheck } = useAgentRecheck(h.reload, h.read, { intervalMs: 1, attempts: 1 })

    await recheck('codex')

    expect(h.post.mock.calls).toEqual([
      ['/fleet/runners/r1/reprobe'],
      ['/fleet/runners/r2/reprobe'],
    ])
  })

  test('AC-2: toasts fleet.threads.new.agent.recheckRequested once', async () => {
    const h = harness()
    const { recheck } = useAgentRecheck(h.reload, h.read, { intervalMs: 1, attempts: 1 })

    await recheck('codex')

    expect(h.toasts.successes).toEqual(['fleet.threads.new.agent.recheckRequested'])
  })
})

describe('US-009 AC-3..AC-5: the bounded refresh', () => {
  test('AC-3: reloads once per interval until checkedAt changes, then clears rechecking', async () => {
    jest.useFakeTimers()
    const h = harness()
    // The first reload still answers the old probe time; the second answers a fresh one.
    h.reload.mockImplementation(async () => {
      const count = h.reload.mock.calls.length
      h.read.mockImplementation((agent: ThreadAgent) =>
        agent === 'codex' ? codexChoice(count >= 2 ? LATER : T0) : undefined)
    })
    const { recheck, rechecking } = useAgentRecheck(h.reload, h.read, { intervalMs: 10_000 })

    const done = recheck('codex')
    await jest.advanceTimersByTimeAsync(0)
    await jest.advanceTimersByTimeAsync(10_000)
    await jest.advanceTimersByTimeAsync(10_000)
    await done

    expect(h.reload).toHaveBeenCalledTimes(2)
    expect(rechecking.value).toBeNull()
  })

  test('AC-4: stops after one reload when the agent has become available', async () => {
    jest.useFakeTimers()
    const h = harness()
    h.reload.mockImplementation(async () => {
      h.read.mockImplementation((agent: ThreadAgent) =>
        agent === 'codex' ? readyCodex(LATER) : undefined)
    })
    const { recheck, rechecking } = useAgentRecheck(h.reload, h.read, { intervalMs: 10_000 })

    const done = recheck('codex')
    await jest.advanceTimersByTimeAsync(0)
    await jest.advanceTimersByTimeAsync(10_000)
    await done

    expect(h.reload).toHaveBeenCalledTimes(1)
    expect(rechecking.value).toBeNull()
  })

  test('AC-5: reloads exactly 12 times when the probe never reports and then clears rechecking', async () => {
    jest.useFakeTimers()
    const h = harness()
    const { recheck, rechecking } = useAgentRecheck(h.reload, h.read, { intervalMs: 10_000 })

    const done = recheck('codex')
    await jest.advanceTimersByTimeAsync(0)
    await jest.advanceTimersByTimeAsync(10_000 * 12)
    await done

    expect(h.reload).toHaveBeenCalledTimes(12)
    expect(rechecking.value).toBeNull()
  })
})

describe('US-009 AC-6, AC-7: rechecking state and a rejected request', () => {
  test('AC-6: holds the agent in rechecking while the first reload is outstanding', async () => {
    jest.useFakeTimers()
    const h = harness()
    // The reload never settles: the state has to be readable while the refresh is in flight.
    h.reload.mockImplementation(() => new Promise<void>(() => undefined))
    const { recheck, rechecking } = useAgentRecheck(h.reload, h.read, { intervalMs: 10_000 })

    void recheck('codex')
    await jest.advanceTimersByTimeAsync(10_000)

    expect(h.post).toHaveBeenCalledTimes(2)
    expect(h.reload).toHaveBeenCalledTimes(1)
    expect(rechecking.value).toBe('codex')
  })

  test('AC-7: a rejected post toasts extractApiError, posts nothing more and never reloads', async () => {
    const h = harness()
    const error = new ApiError(403, 'fleet.runners.forbidden')
    h.post.mockImplementation(async () => { throw error })
    const { recheck, rechecking } = useAgentRecheck(h.reload, h.read, { intervalMs: 10_000 })

    await recheck('codex')

    expect(h.post.mock.calls).toEqual([['/fleet/runners/r1/reprobe']])
    expect(h.toasts.errors).toEqual(['fleet.runners.forbidden'])
    expect(h.reload).not.toHaveBeenCalled()
    expect(rechecking.value).toBeNull()
  })

  // F1 (review round 1): the pages do not see this read, so a failed reload must be reported here —
  // otherwise the person keeps the stale readiness and never learns the refresh stopped.
  test('F1: a rejected reload toasts extractApiError, stops the refresh and clears rechecking', async () => {
    jest.useFakeTimers()
    const h = harness()
    h.reload.mockImplementation(async () => { throw new ApiError(503, 'fleet.runners.unavailable') })
    const { recheck, rechecking } = useAgentRecheck(h.reload, h.read, { intervalMs: 10_000 })

    const done = recheck('codex')
    await jest.advanceTimersByTimeAsync(0)
    await jest.advanceTimersByTimeAsync(10_000)
    await done

    expect(h.reload).toHaveBeenCalledTimes(1)
    expect(h.toasts.errors).toEqual(['fleet.runners.unavailable'])
    expect(rechecking.value).toBeNull()
  })
})

/**
 * B1 (review round 2): `rechecking` names one agent, so two overlapping re-checks cannot both be
 * represented — the one that finished first cleared the state under the other, which re-enabled its
 * button and let a second post and a second polling loop start for the same agent.
 */
describe('B1: one re-check at a time', () => {
  test('B1: a click on another agent while the first is still posting is dropped and keeps the state', async () => {
    jest.useFakeTimers()
    const h = harness()
    // The first codex post stays pending: the first re-check owns `rechecking` for the whole test.
    let releaseFirstPost: (() => void) | undefined
    h.post.mockImplementation((path: string) => {
      if (path === '/fleet/runners/r1/reprobe' && releaseFirstPost === undefined) {
        return new Promise((resolve) => { releaseFirstPost = () => resolve({}) })
      }
      return Promise.resolve({})
    })
    // Codex reports a fresh probe time once the refresh has read the list; claude never settles.
    h.read.mockImplementation((agent: ThreadAgent) => agent === 'claude'
      ? claudeChoice(T0)
      : codexChoice(h.reload.mock.calls.length > 0 ? LATER : T0))
    const { recheck, rechecking } = useAgentRecheck(h.reload, h.read, { intervalMs: 10_000 })

    const first = recheck('codex')
    await jest.advanceTimersByTimeAsync(0)
    expect(rechecking.value).toBe('codex')

    // The second click neither posted nor replaced the shared state, and started no refresh.
    const second = recheck('claude')
    await jest.advanceTimersByTimeAsync(0)
    expect(h.post.mock.calls).toEqual([['/fleet/runners/r1/reprobe']])
    expect(h.reload).not.toHaveBeenCalled()
    expect(rechecking.value).toBe('codex')
    await second

    // The first re-check still owns the state: it posts r2 once and finishes its own refresh.
    releaseFirstPost?.()
    await jest.advanceTimersByTimeAsync(10_000)
    await first

    expect(h.post.mock.calls).toEqual([
      ['/fleet/runners/r1/reprobe'],
      ['/fleet/runners/r2/reprobe'],
    ])
    expect(h.reload).toHaveBeenCalledTimes(1)
    expect(rechecking.value).toBeNull()
  })

  test('B1: the guard is released, so a re-check started after it finished still works', async () => {
    const h = harness()
    h.read.mockImplementation((agent: ThreadAgent) => (agent === 'claude' ? claudeChoice(T0) : codexChoice(T0)))
    const { recheck, rechecking } = useAgentRecheck(h.reload, h.read, { intervalMs: 1, attempts: 1 })

    await recheck('codex')
    await recheck('claude')

    expect(h.post.mock.calls).toEqual([
      ['/fleet/runners/r1/reprobe'],
      ['/fleet/runners/r2/reprobe'],
      ['/fleet/runners/r3/reprobe'],
    ])
    expect(rechecking.value).toBeNull()
  })
})
