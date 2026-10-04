import { describe, expect, jest, test } from '@jest/globals'
import {
  createProjectEventStream,
  parseFleetApprovalEvent,
  parseFleetJobEvent,
  parseFleetLogEvent,
  type EventSourceLike,
  type LiveFleetApprovalEvent,
  type LiveFleetJobEvent,
  type LiveFleetLogEvent,
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

const logEvent = (id: string, over: Partial<LiveFleetLogEvent> = {}): LiveFleetLogEvent => ({
  id, type: 'fleet_log', projectId: 'p1', jobId: 'j1', leaseEpoch: 1, stream: 'run', size: 120, complete: false, at: '2026-10-04T00:00:00.000Z', ...over,
})

describe('fleet_log notices (S2a §2.3)', () => {
  test('parses a notice for each stream', () => {
    for (const stream of ['run', 'stdout', 'stderr'] as const) {
      expect(parseFleetLogEvent(JSON.stringify(logEvent('e1', { stream })))).toEqual(logEvent('e1', { stream }))
    }
    expect(parseFleetLogEvent(JSON.stringify(logEvent('e1', { complete: true, size: 0, leaseEpoch: 0 })))).toBeTruthy()
  })

  test.each([
    ['not JSON', 'not json'],
    ['another type', JSON.stringify({ ...logEvent('e1'), type: 'fleet_job' })],
    ['an unknown stream', JSON.stringify({ ...logEvent('e1'), stream: 'plan' })],
    ['a negative size', JSON.stringify({ ...logEvent('e1'), size: -1 })],
    ['a fractional epoch', JSON.stringify({ ...logEvent('e1'), leaseEpoch: 1.5 })],
    ['a string complete', JSON.stringify({ ...logEvent('e1'), complete: 'true' })],
    ['a missing job id', JSON.stringify({ ...logEvent('e1'), jobId: undefined })],
  ])('rejects %s', (_label, raw) => {
    expect(parseFleetLogEvent(raw)).toBeNull()
  })

  test('delivers fleet_log events once each, only when a handler is given', () => {
    const onFleetLog = jest.fn()
    const source = open({ onFleetLog, onResync: () => undefined })
    source.emit('fleet_log', logEvent('e1'))
    source.emit('fleet_log', logEvent('e1'))
    source.emit('fleet_log', logEvent('e2', { size: 240 }))
    expect(onFleetLog.mock.calls.map(([e]) => (e as LiveFleetLogEvent).size)).toEqual([120, 240])

    const silent = open({ onResync: () => undefined })
    expect(silent.listenerTypes()).not.toContain('fleet_log')
  })
})
