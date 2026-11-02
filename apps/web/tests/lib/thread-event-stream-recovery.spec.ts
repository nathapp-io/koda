/**
 * US-007 (E/BUG-3) — the thread event stream recovers like the project one: an outage keeps it
 * retrying, an unauthorized session stops it.
 *
 *   AC-12: refreshAuth 'unauthorized' after an error schedules no reopen
 *   AC-13: seven consecutive 'unavailable' outcomes each schedule a reopen
 */
import { beforeEach, describe, expect, jest, test } from '@jest/globals'
import { createThreadEventStream, type ThreadEventHandlers } from '~/lib/thread-event-stream'
import {
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

/** A thread stream whose refreshAuth repeats `outcome`; `runTimers()` fires the pending reopen. */
function setup(outcome: RefreshOutcome) {
  const sources: FakeEventSource[] = []
  let timers: Array<{ fn: () => void; ms: number }> = []
  const deps: ProjectEventStreamDeps = {
    createEventSource: (url) => {
      const es = new FakeEventSource(url)
      sources.push(es)
      return es
    },
    refreshAuth: jest.fn(async () => outcome),
    setTimer: (fn, ms) => {
      const timer = { fn, ms }
      timers = [...timers, timer]
      return timer
    },
    clearTimer: (handle) => {
      timers = timers.filter(t => t !== handle)
    },
  }
  const handlers: ThreadEventHandlers = {
    onResync: jest.fn(),
    onLiveChange: jest.fn(),
  }
  const stream = createThreadEventStream('/api/projects/web/threads/th1/events', handlers, deps)
  const runTimers = (): number[] => {
    const due = timers
    timers = []
    due.forEach(t => t.fn())
    return due.map(t => t.ms)
  }
  const fail = async (): Promise<void> => {
    sources[sources.length - 1].terminalError()
    await flush()
  }
  return {
    sources,
    deps,
    handlers,
    stream,
    runTimers,
    fail,
    refreshCalls: () => (deps.refreshAuth as jest.Mock).mock.calls.length,
    latest: () => sources[sources.length - 1],
  }
}

describe('US-007 AC-12: an unauthorized thread recovery stops the stream', () => {
  let s: ReturnType<typeof setup>

  beforeEach(() => {
    s = setup('unauthorized')
  })

  test('AC-12: refreshAuth unauthorized after an error schedules no reopen', async () => {
    s.latest().open()
    await s.fail()

    expect(s.refreshCalls()).toBe(1)
    expect(s.runTimers()).toEqual([])
    expect(s.sources).toHaveLength(1)
    expect(s.sources[0].closed).toBe(true)
    expect(s.handlers.onLiveChange).toHaveBeenCalledWith(false)
  })
})

describe('US-007 AC-13: a thread stream survives an outage', () => {
  test('AC-13: seven consecutive unavailable outcomes each schedule a reopen', async () => {
    const s = setup('unavailable')
    s.latest().open()

    const delays: number[] = []
    for (let i = 0; i < 7; i += 1) {
      await s.fail()
      delays.push(...s.runTimers())
    }

    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30_000, 30_000])
    expect(s.refreshCalls()).toBe(7)
    expect(s.sources).toHaveLength(8)
  })

  test('AC-13 (edge): the unauthorized cap still applies to ok outcomes, not to outages', async () => {
    const s = setup('ok')
    s.latest().open()

    for (let i = 0; i < MAX_TERMINAL_FAILURES; i += 1) {
      await s.fail()
      s.runTimers()
    }
    const opened = s.sources.length
    await s.fail()

    expect(s.refreshCalls()).toBe(MAX_TERMINAL_FAILURES)
    expect(s.runTimers()).toEqual([])
    expect(s.sources).toHaveLength(opened)
  })
})
