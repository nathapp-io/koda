import { beforeEach, describe, expect, jest, test } from '@jest/globals'
import { createThreadEventStream, parseThreadLiveEvent, type ThreadEventHandlers } from '~/lib/thread-event-stream'
import { EVENT_SOURCE_CLOSED, type EventSourceLike, type ProjectEventStreamDeps } from '~/lib/project-event-stream'

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

  emit(type: string, data: unknown): void {
    for (const listener of this.listeners[type] ?? []) listener({ data: JSON.stringify(data) })
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

/** Wire-shaped delta payload (the API's ThreadLiveEvent delta arm). */
const deltaPayload = (id: string, messageId: string, text: string): Record<string, unknown> => ({
  id,
  threadId: 'th1',
  at: '2026-10-14T00:00:00.000Z',
  type: 'delta',
  messageId,
  text,
})

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
}

function setup() {
  const sources: FakeEventSource[] = []
  let timers: Array<{ fn: () => void; ms: number }> = []
  const deps: ProjectEventStreamDeps = {
    createEventSource: (url) => {
      const es = new FakeEventSource(url)
      sources.push(es)
      return es
    },
    refreshAuth: jest.fn(async () => true),
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
    onDelta: jest.fn(),
    onMessage: jest.fn(),
    onQuestion: jest.fn(),
    onThread: jest.fn(),
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
  return { sources, handlers, stream, runTimers, latest: () => sources[sources.length - 1] }
}

describe('US-002 thread-event-stream', () => {
  let s: ReturnType<typeof setup>

  beforeEach(() => {
    s = setup()
  })

  test('US-002 AC11: marks the stream live when a ready frame arrives', () => {
    s.latest().open()
    s.latest().emit('ready', {})

    expect(s.handlers.onLiveChange).toHaveBeenCalledWith(true)
  })

  test('US-002 AC12: delivers a delta once when two frames carry the same id', () => {
    s.latest().open()
    s.latest().emit('delta', deltaPayload('e1', 'm1', 'hi'))
    s.latest().emit('delta', deltaPayload('e1', 'm1', 'hi'))

    expect(s.handlers.onDelta).toHaveBeenCalledTimes(1)
    expect(s.handlers.onDelta).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'm1', text: 'hi' }))
  })

  test('US-002 AC13: marks the stream not live when the EventSource reports a terminal error', async () => {
    s.latest().open()
    s.latest().terminalError()
    await flush()

    expect(s.handlers.onLiveChange).toHaveBeenCalledWith(false)
  })

  test('US-002 AC14: resyncs once when the connection that replaces a failed one opens', async () => {
    s.latest().open()
    s.latest().terminalError()
    await flush()
    expect(s.sources).toHaveLength(1)
    expect(s.sources[0].closed).toBe(true)

    expect(s.runTimers()).toEqual([1000])
    expect(s.sources).toHaveLength(2)
    s.latest().open()

    expect(s.handlers.onResync).toHaveBeenCalledTimes(1)
  })

  test('US-002: delivers parsed message, question and thread frames', () => {
    s.latest().open()
    s.latest().emit('message', { id: 'e2', threadId: 'th1', at: 't', type: 'message', messageId: 'm2' })
    s.latest().emit('question', { id: 'e3', threadId: 'th1', at: 't', type: 'question', requestId: 'q1', text: 'Which repo?' })
    s.latest().emit('thread', { id: 'e4', threadId: 'th1', at: 't', type: 'thread' })

    expect(s.handlers.onMessage).toHaveBeenCalledTimes(1)
    expect(s.handlers.onMessage).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'm2' }))
    expect(s.handlers.onQuestion).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'q1', text: 'Which repo?' }))
    expect(s.handlers.onThread).toHaveBeenCalledTimes(1)
  })

  test('US-002: a transient drop also marks the stream not live', () => {
    s.latest().open()
    s.latest().transientError()

    expect(s.handlers.onLiveChange).toHaveBeenCalledWith(false)
  })

  test('US-002: reopening after a transient drop resyncs once', () => {
    s.latest().open()
    s.latest().transientError()
    s.latest().open()

    expect(s.handlers.onResync).toHaveBeenCalledTimes(1)
  })

  test('US-002: malformed delta frames are ignored', () => {
    s.latest().open()
    s.latest().emit('delta', { id: 'e1', threadId: 'th1', type: 'delta', messageId: 'm1' })
    s.latest().emit('delta', 'not json')

    expect(s.handlers.onDelta).not.toHaveBeenCalled()
  })

  test('US-002: forgets ids beyond the 200-entry dedupe window', () => {
    s.latest().open()
    for (let i = 0; i <= 200; i += 1) s.latest().emit('delta', deltaPayload(`e${i}`, `m${i}`, 'x'))
    s.latest().emit('delta', deltaPayload('e0', 'm0', 'x'))

    expect(s.handlers.onDelta).toHaveBeenCalledTimes(202)
  })
})

describe('US-002 parseThreadLiveEvent', () => {
  test('US-002 AC10: parses a delta frame into the ThreadLiveEvent fields', () => {
    const event = parseThreadLiveEvent(
      'delta',
      '{"id":"e1","threadId":"th1","at":"x","type":"delta","messageId":"m1","text":"hi"}',
    )

    expect(event).toEqual({ id: 'e1', threadId: 'th1', at: 'x', type: 'delta', messageId: 'm1', text: 'hi' })
  })

  test('US-002: parses a message frame', () => {
    const event = parseThreadLiveEvent('message', '{"id":"e2","threadId":"th1","at":"x","type":"message","messageId":"m2"}')

    expect(event).toEqual({ id: 'e2', threadId: 'th1', at: 'x', type: 'message', messageId: 'm2' })
  })

  test('US-002: returns null for malformed frames or missing field types', () => {
    expect(parseThreadLiveEvent('delta', 'not json')).toBeNull()
    expect(parseThreadLiveEvent('delta', '{"id":"e1","threadId":"th1","at":"x","type":"delta","messageId":"m1"}')).toBeNull()
    expect(parseThreadLiveEvent('delta', '{"id":"e1","threadId":"th1","at":"x","type":"delta","messageId":5,"text":"hi"}')).toBeNull()
    expect(parseThreadLiveEvent('thread', '{"id":"e1","threadId":null,"at":"x","type":"thread"}')).toBeNull()
  })
})