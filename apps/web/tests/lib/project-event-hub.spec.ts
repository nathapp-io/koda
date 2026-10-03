import { describe, expect, jest, test } from '@jest/globals'
import { createProjectEventHub } from '~/lib/project-event-hub'
import type { EventSourceLike } from '~/lib/project-event-stream'

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
  close(): void { this.closed = true; this.readyState = 2 }
  emit(type: string, data: unknown): void {
    for (const listener of this.listeners[type] ?? []) listener({ data: JSON.stringify(data) })
  }
}

function hub() {
  const sources: FakeEventSource[] = []
  const h = createProjectEventHub({
    createEventSource: (url) => {
      const s = new FakeEventSource(url)
      sources.push(s)
      return s
    },
    refreshAuth: async () => true,
    setTimer: () => null,
    clearTimer: () => undefined,
  })
  return { h, sources }
}

const job = { id: 'e1', type: 'fleet_job', projectId: 'p1', jobId: 'j1', state: 'RUNNING', at: 'x' }
const approval = { id: 'e2', type: 'fleet_approval', projectId: 'p1', approvalId: 'a1', status: 'pending', at: 'x' }

describe('createProjectEventHub (D246)', () => {
  test('two subscribers to one URL share one EventSource and each gets the events it handles', () => {
    const { h, sources } = hub()
    const page = { onFleetJob: jest.fn(), onResync: jest.fn() }
    const badge = { onFleetApproval: jest.fn(), onResync: jest.fn() }
    h.subscribe('/api/projects/p1/events', page)
    h.subscribe('/api/projects/p1/events', badge)
    expect(sources).toHaveLength(1)

    sources[0].emit('fleet_job', job)
    sources[0].emit('fleet_approval', approval)
    expect(page.onFleetJob).toHaveBeenCalledTimes(1)
    expect(badge.onFleetApproval).toHaveBeenCalledTimes(1)
  })

  test('a resync reaches every subscriber', () => {
    const { h, sources } = hub()
    const a = { onResync: jest.fn() }
    const b = { onResync: jest.fn() }
    h.subscribe('/u', a)
    h.subscribe('/u', b)
    sources[0].onerror?.({})
    sources[0].onopen?.({})
    expect(a.onResync).toHaveBeenCalledTimes(1)
    expect(b.onResync).toHaveBeenCalledTimes(1)
  })

  test('the stream closes only when the last subscriber leaves; a later subscribe opens a new one', () => {
    const { h, sources } = hub()
    const offA = h.subscribe('/u', { onResync: () => undefined })
    const offB = h.subscribe('/u', { onResync: () => undefined })
    offA()
    expect(sources[0].closed).toBe(false)
    offB()
    expect(sources[0].closed).toBe(true)
    h.subscribe('/u', { onResync: () => undefined })
    expect(sources).toHaveLength(2)
  })

  test('unsubscribing twice, or the same handlers object subscribed twice, is safe', () => {
    const { h, sources } = hub()
    const handlers = { onFleetJob: jest.fn(), onResync: () => undefined }
    const off1 = h.subscribe('/u', handlers)
    h.subscribe('/u', handlers)
    off1()
    off1()
    sources[0].emit('fleet_job', job)
    expect(handlers.onFleetJob).toHaveBeenCalledTimes(1)
    expect(sources[0].closed).toBe(false)
  })

  test('different URLs get different streams', () => {
    const { h, sources } = hub()
    h.subscribe('/a', { onResync: () => undefined })
    h.subscribe('/b', { onResync: () => undefined })
    expect(sources.map((s) => s.url)).toEqual(['/a', '/b'])
  })
})
