import { describe, expect, test } from '@jest/globals'
import {
  bundleFileName,
  canCancelJob,
  canRequeueJob,
  canWorkOnFleet,
  extractProgress,
  formatUsd,
  isActiveJobState,
  isTerminalJobState,
  mayHaveBundle,
  mergeEvents,
  pickActiveJob,
  safePrUrl,
  summarizeEvent,
  visibleTimelineEvents,
} from '~/lib/fleet-jobs'
import type { FleetJobDto, FleetJobEventDto } from '~/lib/fleet-types'

const job = (over: Partial<FleetJobDto> = {}): FleetJobDto => ({
  id: 'j1', projectId: 'p1', repoId: 'r1', ref: 'main', command: 'RUN', feature: 'f', planFrom: null, profiles: [],
  maxCostUsd: '5', bashMode: 'raw', selectorLabels: [], pinnedRunnerId: null, runnerId: null, leaseEpoch: 0,
  state: 'QUEUED', stateReason: null, requestedById: 'u1', queuedAt: '2026-10-01T00:00:00.000Z', assignedAt: null,
  startedAt: null, finishedAt: null, cancelRequestedAt: null, naxRunId: null, naxLogRunId: null, naxCostRunId: null,
  progress: null, currentStoryId: null, currentPhase: null, costSpentUsd: '0', lastHeartbeatAt: null,
  finishResult: null, escalationReason: null, exitCode: null, resultBranch: null, resultSha: null, resultPrUrl: null,
  ...over,
})

describe('state groups', () => {
  test('active and terminal partition every state', () => {
    for (const s of ['QUEUED', 'ASSIGNED', 'RUNNING', 'UPLOADING']) expect([isActiveJobState(s), isTerminalJobState(s)]).toEqual([true, false])
    for (const s of ['COMPLETED', 'FAILED', 'ESCALATED', 'CRASHED', 'CANCELLED']) expect([isActiveJobState(s), isTerminalJobState(s)]).toEqual([false, true])
  })

  test('a bundle may exist from UPLOADING on, never while QUEUED/ASSIGNED/RUNNING', () => {
    expect(['QUEUED', 'ASSIGNED', 'RUNNING'].map(mayHaveBundle)).toEqual([false, false, false])
    expect(['UPLOADING', 'COMPLETED', 'CANCELLED', 'CRASHED'].map(mayHaveBundle)).toEqual([true, true, true, true])
  })
})

describe('permissions', () => {
  test('canWorkOnFleet: project ADMIN (canManage) or DEVELOPER', () => {
    expect(canWorkOnFleet({ canManage: true, viewerRole: 'ADMIN' })).toBe(true)
    expect(canWorkOnFleet({ canManage: false, viewerRole: 'DEVELOPER' })).toBe(true)
    expect(canWorkOnFleet({ canManage: false, viewerRole: 'VIEWER' })).toBe(false)
    expect(canWorkOnFleet({ canManage: false, viewerRole: null })).toBe(false)
  })

  const dev = { userId: 'u2', canWork: true }
  const viewer = { userId: 'u3', canWork: false }
  const requester = { userId: 'u1', canWork: false }

  test('cancel: workers and the requester, only while unfinished', () => {
    expect(canCancelJob(job({ state: 'RUNNING' }), dev)).toBe(true)
    expect(canCancelJob(job({ state: 'RUNNING' }), requester)).toBe(true)
    expect(canCancelJob(job({ state: 'RUNNING' }), viewer)).toBe(false)
    expect(canCancelJob(job({ state: 'COMPLETED' }), dev)).toBe(false)
    expect(canCancelJob(job({ state: 'RUNNING' }), { userId: null, canWork: false })).toBe(false)
  })

  test('requeue: workers only, from CRASHED, FAILED or CANCELLED', () => {
    expect(['CRASHED', 'FAILED', 'CANCELLED'].map(state => canRequeueJob(job({ state: state as FleetJobDto['state'] }), dev))).toEqual([true, true, true])
    expect(canRequeueJob(job({ state: 'ESCALATED' }), dev)).toBe(false)
    expect(canRequeueJob(job({ state: 'COMPLETED' }), dev)).toBe(false)
    expect(canRequeueJob(job({ state: 'FAILED' }), requester)).toBe(false)
  })
})

describe('formatUsd', () => {
  test.each([
    ['0.4200', '$0.42'],
    ['12', '$12.00'],
    ['0', '$0.00'],
    ['0.0042', '$0.0042'],
    ['10000.0000', '$10000.00'],
  ])('%s -> %s', (input, out) => {
    expect(formatUsd(input)).toBe(out)
  })

  test('null, empty and garbage', () => {
    expect(formatUsd(null)).toBe('-')
    expect(formatUsd('  ')).toBe('-')
    expect(formatUsd('abc')).toBe('abc')
  })
})

describe('extractProgress', () => {
  test('reads nax counters', () => {
    expect(extractProgress({ total: 4, passed: 1, failed: 1, paused: 0, blocked: 0, pending: 2 })).toEqual({ total: 4, passed: 1, failed: 1, pending: 2 })
  })

  test('missing counters default to 0', () => {
    expect(extractProgress({ total: 3 })).toEqual({ total: 3, passed: 0, failed: 0, pending: 0 })
  })

  test.each([[null], [[]], ['x'], [{}], [{ total: 0 }], [{ total: -1 }], [{ total: 1.5 }], [{ total: '3' }]])('unusable %p -> null', (value) => {
    expect(extractProgress(value)).toBeNull()
  })
})

describe('safePrUrl', () => {
  test('keeps https only', () => {
    expect(safePrUrl('https://github.com/acme/app/pull/7')).toBe('https://github.com/acme/app/pull/7')
    expect(safePrUrl('http://github.com/acme/app/pull/7')).toBeNull()
    expect(safePrUrl('javascript:alert(1)')).toBeNull()
    expect(safePrUrl('not a url')).toBeNull()
    expect(safePrUrl(null)).toBeNull()
  })
})

describe('summarizeEvent', () => {
  test('server transition', () => {
    expect(summarizeEvent({ type: 'state', runnerSeq: null, payload: { from: 'QUEUED', to: 'ASSIGNED', by: 'server', reason: null } }))
      .toEqual({ kind: 'transition', from: 'QUEUED', to: 'ASSIGNED', reason: null, source: 'server' })
  })

  test('the server row written at dispatch has no from', () => {
    expect(summarizeEvent({ type: 'state', runnerSeq: null, payload: { from: null, to: 'QUEUED', by: 'server', reason: null } }))
      .toEqual({ kind: 'transition', from: null, to: 'QUEUED', reason: null, source: 'server' })
  })

  test('runner-reported state has no from', () => {
    expect(summarizeEvent({ type: 'state', runnerSeq: 3, payload: { to: 'FAILED', reason: 'capability mismatch: sandbox' } }))
      .toEqual({ kind: 'transition', from: null, to: 'FAILED', reason: 'capability mismatch: sandbox', source: 'runner' })
  })

  test('a state event without to is unknown', () => {
    expect(summarizeEvent({ type: 'state', runnerSeq: 1, payload: {} })).toEqual({ kind: 'unknown', type: 'state' })
  })

  test('snapshot lists story, phase, progress, cost and finish result in that order', () => {
    expect(summarizeEvent({
      type: 'snapshot', runnerSeq: 2,
      payload: { currentStoryId: 'US-001', currentPhase: 'implement', progress: { total: 2, passed: 1 }, costSpentUsd: '0.4200', finishResult: 'opened' },
    })).toEqual({ kind: 'snapshot', parts: ['US-001', 'implement', '1/2', '$0.42', 'opened'] })
  })

  test('an empty snapshot has no parts', () => {
    expect(summarizeEvent({ type: 'snapshot', runnerSeq: 2, payload: { currentStoryId: null } })).toEqual({ kind: 'snapshot', parts: [] })
  })

  test('lifecycle and log', () => {
    expect(summarizeEvent({ type: 'lifecycle', runnerSeq: 4, payload: { level: 'warn', message: 'watcher error' } }))
      .toEqual({ kind: 'lifecycle', level: 'warn', message: 'watcher error' })
    const long = 'x'.repeat(400)
    expect(summarizeEvent({ type: 'log', runnerSeq: 5, payload: { text: long } })).toEqual({ kind: 'log', text: `${'x'.repeat(300)}...` })
  })

  test('a non-object payload never throws', () => {
    expect(summarizeEvent({ type: 'lifecycle', runnerSeq: 1, payload: null })).toEqual({ kind: 'lifecycle', level: 'info', message: '' })
    expect(summarizeEvent({ type: 'bogus' as 'log', runnerSeq: 1, payload: 'x' })).toEqual({ kind: 'unknown', type: 'bogus' })
  })
})

describe('visibleTimelineEvents', () => {
  const ev = (id: string, type: FleetJobEventDto['type'], runnerSeq: number | null): FleetJobEventDto =>
    ({ id, seq: 0, leaseEpoch: 1, runnerSeq, type, payload: {}, createdAt: '2026-10-01T00:00:00.000Z' })

  test("drops the runner's own state rows (the server writes the applied transition too) and keeps everything else", () => {
    const events = [ev('q', 'state', null), ev('r', 'state', 3), ev('s', 'state', null), ev('n', 'snapshot', 4), ev('l', 'log', 5)]
    expect(visibleTimelineEvents(events).map(e => e.id)).toEqual(['q', 's', 'n', 'l'])
    expect(events).toHaveLength(5)
  })
})

describe('pickActiveJob', () => {
  test('first active record wins; none -> null', () => {
    const records = [job({ id: 'old', state: 'COMPLETED' }), job({ id: 'live', state: 'RUNNING' })]
    expect(pickActiveJob(records)?.id).toBe('live')
    expect(pickActiveJob([job({ state: 'FAILED' })])).toBeNull()
    expect(pickActiveJob([])).toBeNull()
  })
})

test('bundleFileName', () => {
  expect(bundleFileName('j1')).toBe('koda-job-j1.tar.gz')
})

describe('mergeEvents', () => {
  const ev = (id: string, seq: number, type: FleetJobEventDto['type'] = 'log'): FleetJobEventDto =>
    ({ id, seq, leaseEpoch: 1, runnerSeq: seq, type, payload: {}, createdAt: '2026-10-01T00:00:00.000Z' })

  test('appends new rows, replaces refetched ones, orders by seq, never mutates', () => {
    const loaded = [ev('a', 1), ev('b', 2)]
    const merged = mergeEvents(loaded, [ev('b', 2, 'state'), ev('c', 3)])
    expect(merged.map(e => [e.id, e.type])).toEqual([['a', 'log'], ['b', 'state'], ['c', 'log']])
    expect(loaded.map(e => e.type)).toEqual(['log', 'log'])
  })
})
