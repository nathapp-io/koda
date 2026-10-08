import { describe, expect, jest, test } from '@jest/globals'
import { createProjectEventHub } from '~/lib/project-event-hub'
import { createProjectEventStream, parseNotificationEvent, type EventSourceLike } from '~/lib/project-event-stream'

class FakeEventSource implements EventSourceLike {
  readyState = 0
  onopen: ((ev: unknown) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  private listeners: Record<string, Array<(ev: { data: string }) => void>> = {}
  addEventListener(type: string, listener: (ev: { data: string }) => void): void {
    this.listeners = { ...this.listeners, [type]: [...(this.listeners[type] ?? []), listener] }
  }
  close(): void { this.readyState = 2 }
  listenerTypes(): string[] { return Object.keys(this.listeners).sort() }
  emit(type: string, data: unknown): void {
    for (const listener of this.listeners[type] ?? []) listener({ data: JSON.stringify(data) })
  }
}

const deps = (sources: FakeEventSource[]) => ({
  createEventSource: () => { const es = new FakeEventSource(); sources.push(es); return es },
  refreshAuth: async () => true,
  setTimer: () => null,
  clearTimer: () => undefined,
})

const notice = (id: string) => ({ type: 'notification', userId: 'u1', id, at: '2026-10-08T00:00:00.000Z' })

describe('parseNotificationEvent (S4a §4)', () => {
  test('accepts a content-free notice', () => {
    expect(parseNotificationEvent(JSON.stringify(notice('n1')))).toEqual(notice('n1'))
  })
  test.each([
    ['another type', JSON.stringify({ ...notice('n1'), type: 'ticket' })],
    ['no id', JSON.stringify({ type: 'notification', userId: 'u1', at: 'x' })],
    ['not JSON', '{oops'],
    ['null', 'null'],
  ])('rejects %s', (_label, raw) => {
    expect(parseNotificationEvent(raw)).toBeNull()
  })
})

describe('createProjectEventStream notification listener', () => {
  test('listens for notification only when the subscriber handles it, and dedupes by id', () => {
    const sources: FakeEventSource[] = []
    const onNotification = jest.fn()
    createProjectEventStream('/api/me/events', { onNotification, onResync: () => undefined }, deps(sources))
    expect(sources[0].listenerTypes()).toEqual(['notification', 'ticket'])
    sources[0].emit('notification', notice('n1'))
    sources[0].emit('notification', notice('n1'))
    sources[0].emit('notification', notice('n2'))
    expect(onNotification).toHaveBeenCalledTimes(2)

    const silent: FakeEventSource[] = []
    createProjectEventStream('/api/projects/p/events', { onResync: () => undefined }, deps(silent))
    expect(silent[0].listenerTypes()).not.toContain('notification')
  })

  test('the hub fans a notice out to every subscriber of the URL', () => {
    const sources: FakeEventSource[] = []
    const hub = createProjectEventHub(deps(sources))
    const a = jest.fn()
    const b = jest.fn()
    hub.subscribe('/api/me/events', { onNotification: a, onResync: () => undefined })
    hub.subscribe('/api/me/events', { onNotification: b, onResync: () => undefined })
    expect(sources).toHaveLength(1)
    sources[0].emit('notification', notice('n9'))
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
  })
})
