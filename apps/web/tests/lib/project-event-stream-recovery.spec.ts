/**
 * US-007 (E/BUG-3) — the project event stream's recovery loop keeps a live stream alive
 * through an API outage and gives up only when the session is actually gone.
 *
 *   AC-7:  refreshAuth 'unauthorized' after an error schedules no reopen
 *   AC-8:  eight consecutive 'unavailable' outcomes each schedule a reopen, capped at 30 s
 *   AC-9:  'ok' outcomes stop at the sixth error without a sixth refresh
 *   AC-10: an onopen resets the delay, so the next recovery waits 1 s again
 *   AC-11: a legacy boolean `true` (not a RefreshOutcome) fails closed, like 'unauthorized'
 */
import { beforeEach, describe, expect, jest, test } from '@jest/globals'
import {
  createProjectEventStream,
  EVENT_SOURCE_CLOSED,
  MAX_TERMINAL_FAILURES,
  type EventSourceLike,
  type ProjectEventStreamDeps,
} from '~/lib/project-event-stream'
import type { RefreshOutcome } from '~/composables/useAuth'

class FakeEventSource implements EventSourceLike {
  readyState = 0
  onopen: ((ev: unknown) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  closed = false
  private listeners: Record<string, Array<(ev: { data: string }) => void>> = {}

  constructor(readonly url: string) {}

  addEventListener(type: string, listener: (ev: { data: string }) => void): void {
    this.listeners = { ...this.listeners, [type]: [...(this.listeners[type] ?? []), listener] }
  }

  close(): void {
    this.closed = true
    this.readyState = EVENT_SOURCE_CLOSED
  }

  open(): void {
    this.readyState = 1
    this.onopen?.({})
  }

  terminalError(): void {
    this.readyState = EVENT_SOURCE_CLOSED
    this.onerror?.({})
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
}

/**
 * Builds a stream whose refreshAuth answers the queued outcomes in order (the last one repeats).
 * `runTimers()` fires every scheduled reopen and returns their delays, in order.
 */
function setup(outcomes: readonly RefreshOutcome[] = ['ok']) {
  const sources: FakeEventSource[] = []
  let timers: Array<{ fn: () => void; ms: number }> = []
  let cursor = 0
  const settled = (): RefreshOutcome => {
    const list = outcomes.length === 0 ? ['ok'] : outcomes
    const value = list[Math.min(cursor, list.length - 1)] ?? 'ok'
    cursor += 1
    return value
  }
  const deps: ProjectEventStreamDeps = {
    createEventSource: (url) => {
      const es = new FakeEventSource(url)
      sources.push(es)
      return es
    },
    refreshAuth: jest.fn(async () => settled()),
    setTimer: (fn, ms) => {
      const timer = { fn, ms }
      timers = [...timers, timer]
      return timer
    },
    clearTimer: (handle) => {
      timers = timers.filter(t => t !== handle)
    },
  }
  const onResync = jest.fn()
  const stream = createProjectEventStream('/api/projects/p1/events', { onResync }, deps)
  const runTimers = (): number[] => {
    const due = timers
    timers = []
    due.forEach(t => t.fn())
    return due.map(t => t.ms)
  }
  /** One terminal failure followed by the recovery attempt settling. */
  const fail = async (): Promise<void> => {
    sources[sources.length - 1].terminalError()
    await flush()
  }
  const refreshCalls = (): number => (deps.refreshAuth as jest.Mock).mock.calls.length
  return { sources, deps, stream, runTimers, fail, refreshCalls, latest: () => sources[sources.length - 1] }
}

describe('US-007 AC-7: an unauthorized recovery stops the stream', () => {
  let s: ReturnType<typeof setup>

  beforeEach(() => {
    s = setup(['unauthorized'])
  })

  test('AC-7: refreshAuth unauthorized after an error schedules no reopen', async () => {
    s.latest().open()
    await s.fail()

    expect(s.refreshCalls()).toBe(1)
    expect(s.runTimers()).toEqual([])
    expect(s.sources).toHaveLength(1)
    expect(s.sources[0].closed).toBe(true)
  })
})

describe('US-007 AC-8: an outage never stops the stream', () => {
  test('AC-8: eight consecutive unavailable outcomes each schedule a reopen, delays capped at 30 s', async () => {
    const s = setup(['unavailable'])
    s.latest().open()

    const delays: number[] = []
    for (let i = 0; i < 8; i += 1) {
      await s.fail()
      delays.push(...s.runTimers())
    }

    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30_000, 30_000, 30_000])
    expect(s.refreshCalls()).toBe(8)
    expect(s.sources).toHaveLength(9)
  })
})

describe(`US-007 AC-9: authorized recoveries stop after ${MAX_TERMINAL_FAILURES}`, () => {
  test('AC-9: five ok outcomes stop at the sixth error without a sixth refreshAuth call', async () => {
    const s = setup(['ok'])
    s.latest().open()

    const delays: number[] = []
    for (let i = 0; i < MAX_TERMINAL_FAILURES; i += 1) {
      await s.fail()
      delays.push(...s.runTimers())
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000])
    expect(s.refreshCalls()).toBe(MAX_TERMINAL_FAILURES)

    const opened = s.sources.length
    await s.fail()

    expect(s.refreshCalls()).toBe(MAX_TERMINAL_FAILURES)
    expect(s.runTimers()).toEqual([])
    expect(s.sources).toHaveLength(opened)
  })
})

describe('US-007 AC-10: a reopen resets the delay', () => {
  test('AC-10: after unavailable errors and an onopen the next recovery waits 1 s again', async () => {
    const s = setup(['unavailable', 'unavailable'])
    s.latest().open()

    await s.fail()
    expect(s.runTimers()).toEqual([1000])
    await s.fail()
    expect(s.runTimers()).toEqual([2000])

    s.latest().open()
    await s.fail()
    expect(s.runTimers()).toEqual([1000])
  })
})

describe('US-007 AC-11: an unknown outcome fails closed', () => {
  test('AC-11: refreshAuth resolving true schedules no reopen', async () => {
    const s = setup()
    const booleanRefresh = jest.fn(async () => true)
    ;(s.deps as { refreshAuth: unknown }).refreshAuth = booleanRefresh
    s.latest().open()

    await s.fail()

    expect(booleanRefresh).toHaveBeenCalledTimes(1)
    expect(s.runTimers()).toEqual([])
    expect(s.sources).toHaveLength(1)
  })
})
