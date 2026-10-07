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
  runningFirstJobs,
  pickActiveJob,
  safePrUrl,
  storyRows,
  summarizeEvent,
  visibleTimelineEvents,
  wipPushStatus,
} from '~/lib/fleet-jobs'
import type { FleetJobDto, FleetJobEventDto } from '~/lib/fleet-types'

const job = (over: Partial<FleetJobDto> = {}): FleetJobDto => ({
  id: 'j1', projectId: 'p1', repoId: 'r1', ref: 'main', command: 'RUN', feature: 'f', planFrom: null, profiles: [],
  maxCostUsd: '5', bashMode: 'raw', selectorLabels: [], pinnedRunnerId: null, runnerId: null, leaseEpoch: 0,
  state: 'QUEUED', stateReason: null, requestedById: 'u1', queuedAt: '2026-10-01T00:00:00.000Z', assignedAt: null,
  startedAt: null, finishedAt: null, cancelRequestedAt: null, naxRunId: null, naxLogRunId: null, naxCostRunId: null,
  progress: null, currentStoryId: null, currentPhase: null, costSpentUsd: '0', lastHeartbeatAt: null,
  finishResult: null, escalationReason: null, exitCode: null, resultBranch: null, resultSha: null, resultPrUrl: null, wipPush: null, stories: null, storiesTruncated: false, postRun: null,
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

describe('wipPushStatus', () => {
  test('parses the three outcomes and ignores anything else', () => {
    expect(wipPushStatus('pushed')).toEqual({ key: 'pushed', reason: null })
    expect(wipPushStatus('none')).toEqual({ key: 'none', reason: null })
    expect(wipPushStatus('failed:diverged')).toEqual({ key: 'failed', reason: 'diverged' })
    expect(wipPushStatus(null)).toBeNull()
    expect(wipPushStatus(undefined)).toBeNull()
    expect(wipPushStatus('weird')).toBeNull()
  })
})

describe('storyRows', () => {
  const stories = [
    { id: 'US-001', title: 'Login', status: 'passed', attempts: 1, dependsOn: [] },
    { id: 'US-002', title: 'Logout', status: 'in-progress', attempts: 2, dependsOn: ['US-001'] },
    { id: 'US-003', title: 'Audit', status: 'regression-failed', attempts: 3, dependsOn: [] },
    { id: 'US-004', title: 'Docs', status: 'decomposed', attempts: 0, dependsOn: [] },
  ]

  test('one row per story; status picks the badge variant; the active job highlights its current story', () => {
    const rows = storyRows(job({ state: 'RUNNING', stories, currentStoryId: 'US-002', currentPhase: 'implement' }))
    expect(rows.map(r => [r.id, r.variant, r.current, r.phase])).toEqual([
      ['US-001', 'default', false, null],
      ['US-002', 'secondary', true, 'implement'],
      ['US-003', 'destructive', false, null],
      ['US-004', 'outline', false, null],
    ])
    expect(rows[1]).toEqual(expect.objectContaining({ title: 'Logout', status: 'in-progress', attempts: 2 }))
  })

  test('a finished job highlights nothing (D152)', () => {
    expect(storyRows(job({ state: 'FAILED', stories, currentStoryId: 'US-002', currentPhase: 'implement' })).some(r => r.current)).toBe(false)
  })

  test('no list, or junk entries, give no rows', () => {
    expect(storyRows(job({ stories: null }))).toEqual([])
    const junk = [null, 'x', { title: 'no id' }, { id: '' }, { id: 'US-9', attempts: 'many' }] as unknown as FleetJobDto['stories']
    expect(storyRows(job({ stories: junk }))).toEqual([
      { id: 'US-9', title: '', status: 'pending', attempts: 0, current: false, phase: null, variant: 'outline', dependsOn: [] },
    ])
  })

  test('dependsOn keeps non-empty string ids once each, in order, never the story itself (D439)', () => {
    const odd = [
      { id: 'US-001', title: 'a', status: 'passed', attempts: 1, dependsOn: [] },
      { id: 'US-002', title: 'b', status: 'pending', attempts: 0, dependsOn: ['US-001', 'US-001', '', 7, null, 'US-002', 'US-404'] },
      { id: 'US-003', title: 'c', status: 'pending', attempts: 0, dependsOn: 'US-001' },
      { id: 'US-004', title: 'd', status: 'pending', attempts: 0 },
    ] as unknown as FleetJobDto['stories']
    expect(storyRows(job({ stories: odd })).map(r => [r.id, r.dependsOn])).toEqual([
      ['US-001', []],
      ['US-002', ['US-001', 'US-404']],
      ['US-003', []],
      ['US-004', []],
    ])
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

describe('approval_request timeline rows (D297)', () => {
  test('the command\'s first line, or the raw text when the command was not parsed', () => {
    expect(summarizeEvent({ type: 'approval_request', runnerSeq: 4, payload: { command: 'git push\nmore' } }))
      .toEqual({ kind: 'approval', command: 'git push' })
    expect(summarizeEvent({ type: 'approval_request', runnerSeq: 4, payload: { command: '', rawDetail: 'request: ls' } }))
      .toEqual({ kind: 'approval', command: 'request: ls' })
    expect(summarizeEvent({ type: 'approval_request', runnerSeq: 4, payload: null })).toEqual({ kind: 'approval', command: '' })
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

describe('runningFirstJobs (slice 4)', () => {
  test('puts running jobs first, longest-running first, then the rest newest-queued first', () => {
    const sorted = runningFirstJobs([
      job({ id: 'queued-new', queuedAt: '2026-10-06T10:00:00Z' }),
      job({ id: 'run-long', state: 'RUNNING', startedAt: '2026-10-06T08:00:00Z' }),
      job({ id: 'queued-old', queuedAt: '2026-10-06T07:00:00Z' }),
      job({ id: 'upload', state: 'UPLOADING', startedAt: '2026-10-06T09:00:00Z' }),
      job({ id: 'run-recent', state: 'RUNNING', startedAt: '2026-10-06T09:30:00Z' }),
    ])
    expect(sorted.map((j) => j.id)).toEqual(['run-long', 'upload', 'run-recent', 'queued-new', 'queued-old'])
  })

  test('does not mutate the input and treats a missing startedAt as newest', () => {
    const input = [job({ id: 'a', state: 'RUNNING' }), job({ id: 'b', state: 'RUNNING', startedAt: '2026-10-06T06:00:00Z' })]
    const sorted = runningFirstJobs(input)
    expect(sorted.map((j) => j.id)).toEqual(['a', 'b'])
    expect(input.map((j) => j.id)).toEqual(['a', 'b'])
  })
})

import { isConfigJob, jobCommandLabelKey } from '~/lib/fleet-jobs'

describe('config jobs (S3 §6)', () => {
  test('isConfigJob is true only for the two config kinds', () => {
    expect(isConfigJob({ command: 'CONFIG_EDIT' })).toBe(true)
    expect(isConfigJob({ command: 'CONFIG_DRIFT' })).toBe(true)
    expect(isConfigJob({ command: 'RUN' })).toBe(false)
    expect(isConfigJob({ command: 'PLAN' })).toBe(false)
  })

  test('jobCommandLabelKey maps every kind under fleet.command', () => {
    expect(jobCommandLabelKey('CONFIG_EDIT')).toBe('fleet.command.CONFIG_EDIT')
    expect(jobCommandLabelKey('RUN')).toBe('fleet.command.RUN')
  })
})
