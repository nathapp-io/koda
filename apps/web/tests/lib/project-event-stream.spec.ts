import { beforeEach, describe, expect, jest, test } from '@jest/globals'
import {
  backoffMs,
  createProjectEventStream,
  EVENT_SOURCE_CLOSED,
  MAX_TERMINAL_FAILURES,
  type EventSourceLike,
  type LiveTicketEvent,
  type ProjectEventStreamDeps,
} from '~/lib/project-event-stream'

class FakeEventSource implements EventSourceLike {
  readyState = 0
  onopen: ((ev: unknown) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  closed = false
  private listeners: Record<string, Array<(ev: { data?: string }) => void>> = {}

  constructor(readonly url: string) {}

  addEventListener(type: string, listener: (ev: { data?: string }) => void): void {
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

  emit(type: string, data: unknown): void {
    for (const listener of this.listeners[type] ?? []) listener({ data: JSON.stringify(data) })
  }

  // Native network error, as the browser dispatches it to addEventListener
  // listeners: same `error` type but without a .data payload.
  listenerError(): void {
    for (const listener of this.listeners.error ?? []) listener({})
  }

  transientError(): void {
    this.readyState = 0
    this.onerror?.({})
  }

  terminalError(): void {
    this.readyState = EVENT_SOURCE_CLOSED
    this.onerror?.({})
  }
}

const liveEvent = (id: string, action: LiveTicketEvent['action'] = 'created'): LiveTicketEvent => ({
  id, type: 'ticket', action, projectId: 'p1', ticketId: 't1', actorId: 'u1', at: '2026-09-26T00:00:00.000Z',
})

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
}

function setup(refreshResults: boolean[] = []) {
  const sources: FakeEventSource[] = []
  let timers: Array<{ fn: () => void; ms: number }> = []
  const refreshQueue = [...refreshResults]
  const deps: ProjectEventStreamDeps = {
    createEventSource: (url) => {
      const es = new FakeEventSource(url)
      sources.push(es)
      return es
    },
    refreshAuth: jest.fn(async () => refreshQueue.shift() ?? true),
    setTimer: (fn, ms) => {
      const timer = { fn, ms }
      timers = [...timers, timer]
      return timer
    },
    clearTimer: (handle) => {
      timers = timers.filter(t => t !== handle)
    },
  }
  const onEvent = jest.fn()
  const onResync = jest.fn()
  const stream = createProjectEventStream('/api/projects/p1/events', { onEvent, onResync }, deps)
  const runTimers = (): number[] => {
    const due = timers
    timers = []
    due.forEach(t => t.fn())
    return due.map(t => t.ms)
  }
  return { sources, deps, onEvent, onResync, stream, runTimers, latest: () => sources[sources.length - 1] }
}

describe('backoffMs', () => {
  test('doubles from 1 s and caps at 30 s', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map(backoffMs)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000])
  })
})

describe('createProjectEventStream', () => {
  let s: ReturnType<typeof setup>

  beforeEach(() => {
    s = setup()
  })

  test('opens the given URL and delivers ticket events', () => {
    expect(s.latest().url).toBe('/api/projects/p1/events')
    s.latest().open()
    s.latest().emit('ticket', liveEvent('e1'))
    expect(s.onEvent).toHaveBeenCalledWith(liveEvent('e1'))
  })

  test('drops duplicate ids (outbox re-delivery)', () => {
    s.latest().open()
    s.latest().emit('ticket', liveEvent('e1'))
    s.latest().emit('ticket', liveEvent('e1'))
    expect(s.onEvent).toHaveBeenCalledTimes(1)
  })

  test('forgets ids beyond the 200-entry window', () => {
    s.latest().open()
    for (let i = 0; i <= 200; i += 1) s.latest().emit('ticket', liveEvent(`e${i}`))
    s.latest().emit('ticket', liveEvent('e0'))
    expect(s.onEvent).toHaveBeenCalledTimes(202)
  })

  test('ignores malformed payloads and ready/ping events', () => {
    s.latest().open()
    s.latest().emit('ticket', { id: 'x', type: 'ticket', action: 'exploded' })
    s.latest().emit('ticket', 'not an object')
    s.latest().emit('ready', {})
    s.latest().emit('ping', {})
    expect(s.onEvent).not.toHaveBeenCalled()
  })

  test('does not resync on the first open', () => {
    s.latest().open()
    expect(s.onResync).not.toHaveBeenCalled()
  })

  test('resyncs once when the browser reopens after a transient error', () => {
    s.latest().open()
    s.latest().transientError()
    s.latest().open()
    expect(s.onResync).toHaveBeenCalledTimes(1)
    expect(s.sources).toHaveLength(1)
  })

  test('after a terminal failure it refreshes auth, waits the backoff, reopens and resyncs', async () => {
    s.latest().open()
    s.latest().terminalError()
    await flush()
    expect(s.deps.refreshAuth).toHaveBeenCalledTimes(1)
    expect(s.sources[0].closed).toBe(true)

    expect(s.runTimers()).toEqual([1000])
    expect(s.sources).toHaveLength(2)
    s.latest().open()
    expect(s.onResync).toHaveBeenCalledTimes(1)
  })

  test('a server-sent error frame is terminal even while the socket is open', async () => {
    s.latest().open()
    s.latest().emit('error', { error: 'member_removed' })
    await flush()
    expect(s.deps.refreshAuth).toHaveBeenCalledTimes(1)
    expect(s.sources[0].closed).toBe(true)

    expect(s.runTimers()).toEqual([1000])
    expect(s.sources).toHaveLength(2)
    s.latest().open()
    expect(s.onResync).toHaveBeenCalledTimes(1)
  })

  test('a server-sent error frame does not double-fire when the close also lands', async () => {
    s.latest().open()
    s.latest().emit('error', { error: 'member_removed' })
    await flush()
    s.latest().terminalError()
    await flush()
    expect(s.deps.refreshAuth).toHaveBeenCalledTimes(1)
    expect(s.runTimers()).toEqual([1000])
    expect(s.sources).toHaveLength(2)
  })

  test('a data-less error via the listener stays transient while the socket is open', async () => {
    s.latest().open()
    s.latest().listenerError()
    await flush()
    expect(s.deps.refreshAuth).not.toHaveBeenCalled()
    expect(s.runTimers()).toEqual([])
    expect(s.sources).toHaveLength(1)
  })

  test('backs off 1 s, 2 s, 4 s … across consecutive terminal failures', async () => {
    const delays: number[] = []
    for (let i = 0; i < 3; i += 1) {
      s.latest().terminalError()
      await flush()
      delays.push(...s.runTimers())
    }
    expect(delays).toEqual([1000, 2000, 4000])
  })

  test(`stops after ${MAX_TERMINAL_FAILURES} consecutive terminal failures`, async () => {
    for (let i = 0; i < MAX_TERMINAL_FAILURES; i += 1) {
      s.latest().terminalError()
      await flush()
      s.runTimers()
    }
    const opened = s.sources.length
    s.latest().terminalError()
    await flush()
    expect(s.runTimers()).toEqual([])
    expect(s.sources).toHaveLength(opened)
  })

  test('a successful open resets the failure count', async () => {
    for (let i = 0; i < MAX_TERMINAL_FAILURES - 1; i += 1) {
      s.latest().terminalError()
      await flush()
      s.runTimers()
    }
    s.latest().open()
    s.latest().terminalError()
    await flush()
    expect(s.runTimers()).toEqual([1000])
  })

  test('stops at once when the auth refresh fails', async () => {
    const failing = setup([false])
    failing.latest().terminalError()
    await flush()
    expect(failing.runTimers()).toEqual([])
    expect(failing.sources).toHaveLength(1)
  })

  test('close() stops everything, including a pending reopen', async () => {
    s.latest().terminalError()
    await flush()
    s.stream.close()
    expect(s.runTimers()).toEqual([])
    expect(s.sources).toHaveLength(1)
  })

  test('close() during an in-flight auth refresh prevents the reopen', async () => {
    let resolveRefresh: (ok: boolean) => void = () => undefined
    ;(s.deps.refreshAuth as jest.Mock).mockImplementationOnce(() => new Promise<boolean>((resolve) => { resolveRefresh = resolve }))
    s.latest().terminalError()
    s.stream.close()
    resolveRefresh(true)
    await flush()
    expect(s.runTimers()).toEqual([])
    expect(s.sources).toHaveLength(1)
  })
})
