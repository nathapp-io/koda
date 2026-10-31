import { describe, expect, jest, test } from '@jest/globals'
import * as streamModule from '~/lib/project-event-stream'
import {
  createProjectEventStream,
  parseApprovalRequestEvent,
  type EventSourceLike,
  type LiveApprovalRequestEvent,
  type ProjectEventHandlers,
} from '~/lib/project-event-stream'

class FakeEventSource implements EventSourceLike {
  readyState = 0
  onopen: ((ev: unknown) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  private listeners: Record<string, Array<(ev: { data: string }) => void>> = {}

  addEventListener(type: string, listener: (ev: { data: string }) => void): void {
    this.listeners = { ...this.listeners, [type]: [...(this.listeners[type] ?? []), listener] }
  }

  close(): void {
    this.readyState = 2
  }

  listenerTypes(): string[] {
    return Object.keys(this.listeners).sort()
  }

  emit(type: string, data: unknown): void {
    for (const listener of this.listeners[type] ?? []) listener({ data: JSON.stringify(data) })
  }
}

const notice = (over: Partial<LiveApprovalRequestEvent> = {}): LiveApprovalRequestEvent => ({
  id: 'r1:pending', type: 'approval_request', projectId: 'p1', requestId: 'r1', status: 'pending', at: '2026-10-30T00:00:00.000Z', ...over,
})

function open(handlers: ProjectEventHandlers): FakeEventSource {
  let source: FakeEventSource | null = null
  createProjectEventStream('/api/projects/p1/events', handlers, {
    createEventSource: () => {
      source = new FakeEventSource()
      return source
    },
    refreshAuth: async () => true,
    setTimer: () => null,
    clearTimer: () => undefined,
  })
  if (!source) throw new Error('no event source opened')
  return source
}

describe('parseApprovalRequestEvent (P3b US-001)', () => {
  test('accepts a well-formed approval_request notice', () => {
    expect(parseApprovalRequestEvent(JSON.stringify(notice()))).toEqual(notice())
  })

  test('accepts a status this web build does not know yet (it only triggers a refetch)', () => {
    expect(parseApprovalRequestEvent(JSON.stringify(notice({ status: 'held' })))?.status).toBe('held')
  })

  test.each([
    ['not JSON', 'not json'],
    ['a fleet_approval event', JSON.stringify({ id: 'e1', type: 'fleet_approval', projectId: 'p1', approvalId: 'a1', status: 'pending', at: 'x' })],
    ['no request id', JSON.stringify({ id: 'e1', type: 'approval_request', projectId: 'p1', status: 'pending', at: 'x' })],
    ['an empty id', JSON.stringify({ ...notice(), id: '' })],
    ['a numeric request id', JSON.stringify({ ...notice(), requestId: 5 })],
    ['an empty status', JSON.stringify({ ...notice(), status: '' })],
    ['null', JSON.stringify(null)],
  ])('rejects %s', (_label, raw) => {
    expect(parseApprovalRequestEvent(raw)).toBeNull()
  })
})

describe('createProjectEventStream with onApprovalRequest (P3b US-001)', () => {
  test('delivers approval_request notices once each', () => {
    const onApprovalRequest = jest.fn()
    const source = open({ onApprovalRequest, onResync: () => undefined })
    source.emit('approval_request', notice())
    source.emit('approval_request', notice())
    source.emit('approval_request', notice({ id: 'r1:approved', status: 'approved' }))

    expect(onApprovalRequest.mock.calls.map(([e]) => (e as LiveApprovalRequestEvent).id)).toEqual(['r1:pending', 'r1:approved'])
  })

  test('a page that did not ask for them never listens', () => {
    const source = open({ onResync: () => undefined })
    expect(source.listenerTypes()).not.toContain('approval_request')
  })
})

// US-007 AC-1: the fleet approval adapter is retired, so nothing opens a listener for its notice any more.
describe('US-007 AC-1: the stream no longer listens for fleet_approval', () => {
  test('AC-1: given only onApprovalRequest and onResync, it adds no fleet_approval listener', () => {
    const source = open({ onApprovalRequest: jest.fn(), onResync: () => undefined })

    // The listener the subscriber asked for is there, so the assertion below is not vacuous...
    expect(source.listenerTypes()).toContain('approval_request')
    // ...and the retired one is not.
    expect(source.listenerTypes()).not.toContain('fleet_approval')
  })

  test('AC-1: the retired notice parser is gone, so no fleet_approval frame can be routed either', () => {
    expect(streamModule).not.toHaveProperty('parseFleetApprovalEvent')
  })
})
