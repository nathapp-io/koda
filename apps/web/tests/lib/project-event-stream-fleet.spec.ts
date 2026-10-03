import { describe, expect, jest, test } from '@jest/globals'
import {
  createProjectEventStream,
  parseFleetApprovalEvent,
  parseFleetJobEvent,
  type EventSourceLike,
  type LiveFleetApprovalEvent,
  type LiveFleetJobEvent,
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

const fleetEvent = (id: string, over: Partial<LiveFleetJobEvent> = {}): LiveFleetJobEvent => ({
  id, type: 'fleet_job', projectId: 'p1', jobId: 'j1', state: 'RUNNING', at: '2026-10-01T00:00:00.000Z', ...over,
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

describe('parseFleetJobEvent', () => {
  test('accepts a well-formed fleet_job event', () => {
    expect(parseFleetJobEvent(JSON.stringify(fleetEvent('e1')))).toEqual(fleetEvent('e1'))
  })

  test.each([
    ['a ticket event', { id: 'e1', type: 'ticket', jobId: 'j1', state: 'RUNNING' }],
    ['no jobId', { id: 'e1', type: 'fleet_job', state: 'RUNNING' }],
    ['no id', { type: 'fleet_job', jobId: 'j1', state: 'RUNNING' }],
    ['a non-string state', { id: 'e1', type: 'fleet_job', jobId: 'j1', state: 42 }],
    ['an empty state', { id: 'e1', type: 'fleet_job', jobId: 'j1', state: '' }],
    ['a non-object', 'nope'],
    ['null', null],
  ])('rejects %s', (_name, value) => {
    expect(parseFleetJobEvent(JSON.stringify(value))).toBeNull()
  })

  test('rejects text that is not JSON', () => {
    expect(parseFleetJobEvent('{oops')).toBeNull()
  })

  test('accepts a state this web build does not know yet (it only triggers a refetch)', () => {
    expect(parseFleetJobEvent(JSON.stringify(fleetEvent('e1', { state: 'PAUSED' })))?.state).toBe('PAUSED')
  })
})

describe('createProjectEventStream with onFleetJob', () => {
  test('delivers fleet_job events to onFleetJob, not to onEvent', () => {
    const onEvent = jest.fn()
    const onFleetJob = jest.fn()
    const es = open({ onEvent, onFleetJob, onResync: jest.fn() })
    es.emit('fleet_job', fleetEvent('e1'))
    expect(onFleetJob).toHaveBeenCalledWith(fleetEvent('e1'))
    expect(onEvent).not.toHaveBeenCalled()
  })

  test('drops a redelivered fleet_job id', () => {
    const onFleetJob = jest.fn()
    const es = open({ onFleetJob, onResync: jest.fn() })
    es.emit('fleet_job', fleetEvent('e1'))
    es.emit('fleet_job', fleetEvent('e1', { state: 'COMPLETED' }))
    expect(onFleetJob).toHaveBeenCalledTimes(1)
  })

  test('ignores malformed fleet_job payloads', () => {
    const onFleetJob = jest.fn()
    const es = open({ onFleetJob, onResync: jest.fn() })
    es.emit('fleet_job', { id: 'e1', type: 'fleet_job', jobId: 'j1', state: 42 })
    expect(onFleetJob).not.toHaveBeenCalled()
  })

  test('a ticket-only page does not listen for fleet_job at all', () => {
    const es = open({ onEvent: jest.fn(), onResync: jest.fn() })
    expect(es.listenerTypes()).toEqual(['ticket'])
  })

  test('a fleet-only page still tolerates ticket events', () => {
    const onFleetJob = jest.fn()
    const es = open({ onFleetJob, onResync: jest.fn() })
    expect(() => es.emit('ticket', { id: 't1', type: 'ticket', action: 'created', projectId: 'p1', ticketId: 't1', actorId: 'u1', at: 'x' })).not.toThrow()
    expect(onFleetJob).not.toHaveBeenCalled()
  })
})

const approvalEvent = (id: string, over: Partial<LiveFleetApprovalEvent> = {}): LiveFleetApprovalEvent => ({
  id, type: 'fleet_approval', projectId: 'p1', approvalId: 'a1', status: 'pending', at: '2026-10-03T00:00:00.000Z', ...over,
})

describe('fleet_approval notices (S1.5 1b)', () => {
  test('parses a notice and accepts any non-empty status (D253)', () => {
    expect(parseFleetApprovalEvent(JSON.stringify(approvalEvent('e1')))).toEqual(approvalEvent('e1'))
    expect(parseFleetApprovalEvent(JSON.stringify(approvalEvent('e1', { status: 'brand_new' })))).toBeTruthy()
  })

  test('rejects other shapes', () => {
    expect(parseFleetApprovalEvent('not json')).toBeNull()
    expect(parseFleetApprovalEvent(JSON.stringify({ ...approvalEvent('e1'), type: 'fleet_job' }))).toBeNull()
    expect(parseFleetApprovalEvent(JSON.stringify({ ...approvalEvent('e1'), approvalId: 5 }))).toBeNull()
    expect(parseFleetApprovalEvent(JSON.stringify({ ...approvalEvent('e1'), status: '' }))).toBeNull()
  })

  test('delivers fleet_approval events once each, only when a handler is given', () => {
    const onFleetApproval = jest.fn()
    const source = open({ onFleetApproval, onResync: () => undefined })
    source.emit('fleet_approval', approvalEvent('e1'))
    source.emit('fleet_approval', approvalEvent('e1'))
    expect(onFleetApproval).toHaveBeenCalledTimes(1)

    const silent = open({ onResync: () => undefined })
    expect(silent.listenerTypes()).not.toContain('fleet_approval')
  })
})
