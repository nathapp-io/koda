import { describe, expect, test } from '@jest/globals'
import {
  buildScheduleSchema, canChangeSchedule, formatDelta, formatInZone, historyRows, initialScheduleValues, isAcceptedTimeZone,
  isCronShape, normalizeCron, parseMaxCost, parseNoProgressLimit, placementOf, scheduleStatusKey, sortSchedules,
  toCreateScheduleBody, toSchedulePatchBody,
} from '../../lib/fleet-schedules'
import type { ScheduleFormValues } from '../../lib/fleet-schedules'
import type { FleetJobDto, ScheduleDto } from '../../lib/fleet-types'

const t = (key: string): string => key

const schedule = (over: Partial<ScheduleDto> = {}): ScheduleDto => ({
  id: 's1', projectId: 'p1', repoId: 'r1', name: 'nightly', cron: '0 9 * * 1-5', timezone: 'Asia/Singapore', feature: 'login',
  ref: 'main', profiles: ['fast'], maxCostUsd: '5.0000', selectorLabels: [], pinnedRunnerId: 'run1', enabled: true,
  nextFireAt: '2026-10-05T01:00:00.000Z', lastFiredAt: null, lastJobId: null, lastPassedCount: 0, noProgressTicks: 0,
  noProgressLimit: 3, disabledReason: null, totalCostUsd: '0.0000', createdById: 'u1', updatedById: 'u1',
  createdAt: '2026-10-02T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z', ...over,
})

const job = (id: string, progress: unknown, over: Partial<FleetJobDto> = {}): FleetJobDto => ({
  id, projectId: 'p1', repoId: 'r1', ref: 'main', command: 'RUN', feature: 'login', planFrom: null, profiles: [],
  maxCostUsd: '5.0000', bashMode: 'raw', selectorLabels: [], pinnedRunnerId: null, runnerId: null, leaseEpoch: 1,
  state: 'FAILED', stateReason: null, requestedById: 'u1', queuedAt: '2026-10-02T00:00:00.000Z', assignedAt: null,
  startedAt: null, finishedAt: null, cancelRequestedAt: null, naxRunId: null, naxLogRunId: null, naxCostRunId: null,
  progress, currentStoryId: null, currentPhase: null, costSpentUsd: '0.5000', lastHeartbeatAt: null, finishResult: null,
  escalationReason: null, exitCode: null, resultBranch: null, resultSha: null, resultPrUrl: null, wipPush: null,
  stories: null, storiesTruncated: false, scheduleId: 's1', coalescedCount: 0, ...over,
})

const p = (passed: number, total = 5) => ({ total, passed, failed: 0, paused: 0, blocked: 0, pending: total - passed })

const form = (over: Partial<ScheduleFormValues> = {}): ScheduleFormValues => ({
  name: ' nightly ', repoId: 'r1', feature: ' login ', cron: ' 0  9 * * 1-5 ', timezone: ' UTC ', ref: '', profiles: [],
  maxCostUsd: '2.5', placement: 'auto', selectorLabels: [], pinnedRunnerId: '', noProgressLimit: '3', ...over,
})

describe('cron and timezone checks (D219)', () => {
  test.each([
    ['0 9 * * 1-5', true], [' 0  9 * *   1-5 ', true], ['* * * *', false], ['* * * * * *', false], ['', false],
  ])('isCronShape(%j) is %s', (cron, ok) => {
    expect(isCronShape(cron)).toBe(ok)
  })

  test('normalizeCron collapses whitespace', () => {
    expect(normalizeCron(' 0  9 *\t* 1-5 ')).toBe('0 9 * * 1-5')
  })

  test.each([
    ['Asia/Singapore', true], ['UTC', true], ['Not/AZone', false], ['', false], ['+08:00', false], ['-05:00', false],
  ])('isAcceptedTimeZone(%j) is %s', (zone, ok) => {
    expect(isAcceptedTimeZone(zone)).toBe(ok)
  })
})

describe('numbers (D219)', () => {
  test.each([
    ['2.5', 2.5], ['0.0001', 0.0001], ['10000', 10000], ['0', null], ['10000.0001', null], ['1.23456', null], ['abc', null], ['', null],
  ])('parseMaxCost(%j) is %s', (input, expected) => {
    expect(parseMaxCost(input)).toBe(expected)
  })

  test.each([['1', 1], ['20', 20], ['3', 3], ['0', null], ['21', null], ['2.5', null], ['', null]])(
    'parseNoProgressLimit(%j) is %s', (input, expected) => {
      expect(parseNoProgressLimit(input)).toBe(expected)
    },
  )
})

describe('form schema', () => {
  test('create needs a repo and a valid feature; edit does not look at them', () => {
    const create = buildScheduleSchema(t, 'create')
    const bad = create.safeParse(form({ repoId: '', feature: '../x' }))
    expect(bad.success).toBe(false)
    const paths = bad.success ? [] : bad.error.issues.map((i) => i.path.join('.'))
    expect(paths).toEqual(expect.arrayContaining(['repoId', 'feature']))
    expect(buildScheduleSchema(t, 'edit').safeParse(form({ repoId: '', feature: '', ref: 'main' })).success).toBe(true)
  })

  test('edit needs a ref; create does not', () => {
    expect(buildScheduleSchema(t, 'create').safeParse(form({ ref: '' })).success).toBe(true)
    const edit = buildScheduleSchema(t, 'edit').safeParse(form({ ref: ' ' }))
    expect(edit.success ? [] : edit.error.issues.map((i) => i.path.join('.'))).toEqual(['ref'])
  })

  test('pin mode needs a runner, labels mode needs a label', () => {
    const s = buildScheduleSchema(t, 'create')
    const pin = s.safeParse(form({ placement: 'pin', pinnedRunnerId: '' }))
    expect(pin.success ? [] : pin.error.issues.map((i) => i.path.join('.'))).toEqual(['pinnedRunnerId'])
    const labels = s.safeParse(form({ placement: 'labels', selectorLabels: [] }))
    expect(labels.success ? [] : labels.error.issues.map((i) => i.path.join('.'))).toEqual(['selectorLabels'])
  })

  test('fields under v-if may arrive undefined (vee-validate unsets an unmounted field) and still validate', () => {
    const values = { ...form(), selectorLabels: undefined, pinnedRunnerId: undefined, profiles: undefined }
    expect(buildScheduleSchema(t, 'create').safeParse(values).success).toBe(true)
  })

  test.each([
    ['name', { name: '   ' }], ['cron', { cron: '* * * *' }], ['timezone', { timezone: '+08:00' }],
    ['maxCostUsd', { maxCostUsd: '0' }], ['noProgressLimit', { noProgressLimit: '21' }],
    ['profiles', { profiles: ['koda-job-x'] }], ['selectorLabels', { placement: 'labels' as const, selectorLabels: ['UPPER'] }],
  ])('rejects a bad %s', (path, over) => {
    const r = buildScheduleSchema(t, 'create').safeParse(form(over))
    expect(r.success ? [] : r.error.issues.map((i) => i.path.join('.'))).toContain(path)
  })
})

describe('bodies (D218)', () => {
  test('create trims, normalises the cron, omits a blank ref and empty lists, sends numbers', () => {
    expect(toCreateScheduleBody(form())).toEqual({
      name: 'nightly', repoId: 'r1', feature: 'login', cron: '0 9 * * 1-5', timezone: 'UTC', maxCostUsd: 2.5, noProgressLimit: 3,
    })
  })

  test('create sends only the chosen placement field', () => {
    const both = { selectorLabels: ['gpu'], pinnedRunnerId: 'run1' }
    expect(toCreateScheduleBody(form({ ...both, placement: 'pin' }))).toEqual(expect.objectContaining({ pinnedRunnerId: 'run1' }))
    expect(toCreateScheduleBody(form({ ...both, placement: 'pin' }))).not.toHaveProperty('selectorLabels')
    expect(toCreateScheduleBody(form({ ...both, placement: 'labels' }))).toEqual(expect.objectContaining({ selectorLabels: ['gpu'] }))
    expect(toCreateScheduleBody(form({ ...both, placement: 'labels' }))).not.toHaveProperty('pinnedRunnerId')
    expect(toCreateScheduleBody(form({ ...both, placement: 'auto' }))).not.toHaveProperty('pinnedRunnerId')
  })

  test('patch sends every editable field and clears the placement it does not use (Review Focus 1)', () => {
    expect(toSchedulePatchBody(form({ ref: 'main', placement: 'auto', pinnedRunnerId: 'run1', selectorLabels: ['gpu'] }))).toEqual({
      name: 'nightly', cron: '0 9 * * 1-5', timezone: 'UTC', ref: 'main', profiles: [], maxCostUsd: 2.5, noProgressLimit: 3,
      selectorLabels: [], pinnedRunnerId: null,
    })
    expect(toSchedulePatchBody(form({ ref: 'main', placement: 'pin', pinnedRunnerId: 'run1' }))).toEqual(
      expect.objectContaining({ selectorLabels: [], pinnedRunnerId: 'run1' }),
    )
  })

  test('the patch body never carries repoId or feature (D203)', () => {
    const body = toSchedulePatchBody(form({ ref: 'main' }))
    expect(body).not.toHaveProperty('repoId')
    expect(body).not.toHaveProperty('feature')
  })

  test('initial values: create defaults, edit from the stored schedule', () => {
    expect(initialScheduleValues(null, 'Asia/Singapore')).toEqual({
      name: '', repoId: '', feature: '', cron: '', timezone: 'Asia/Singapore', ref: '', profiles: [], maxCostUsd: '5',
      placement: 'auto', selectorLabels: [], pinnedRunnerId: '', noProgressLimit: '3',
    })
    expect(initialScheduleValues(schedule(), 'UTC')).toEqual(expect.objectContaining({
      timezone: 'Asia/Singapore', maxCostUsd: '5', placement: 'pin', pinnedRunnerId: 'run1', noProgressLimit: '3', ref: 'main',
    }))
    expect(placementOf(schedule({ pinnedRunnerId: null, selectorLabels: ['gpu'] }))).toBe('labels')
    expect(placementOf(schedule({ pinnedRunnerId: null }))).toBe('auto')
  })
})

describe('display (D220, Review Focus 3)', () => {
  test('formatInZone shows the instant in the schedule zone', () => {
    expect(formatInZone('2026-10-05T01:00:00.000Z', 'Asia/Singapore', 'en-US')).toMatch(/Oct 5, 2026.*9:00/)
    expect(formatInZone('2026-10-05T01:00:00.000Z', 'UTC', 'en-US')).toMatch(/Oct 5, 2026.*1:00/)
  })

  test('formatInZone: null is "-", a zone the runtime does not know falls back to UTC, garbage is shown raw', () => {
    expect(formatInZone(null, 'UTC')).toBe('-')
    expect(formatInZone('2026-10-05T01:00:00.000Z', 'Not/AZone', 'en-US')).toMatch(/1:00/)
    expect(formatInZone('not a date', 'UTC')).toBe('not a date')
  })

  test('scheduleStatusKey: enabled, a stored reason, or manual for a null reason', () => {
    expect(scheduleStatusKey(schedule())).toBe('enabled')
    expect(scheduleStatusKey(schedule({ enabled: false, disabledReason: 'completed' }))).toBe('completed')
    expect(scheduleStatusKey(schedule({ enabled: false, disabledReason: null }))).toBe('manual')
  })

  test('sortSchedules: by name, then id; the input is not mutated', () => {
    const list = [schedule({ id: 'b', name: 'zeta' }), schedule({ id: 'c', name: 'alpha' }), schedule({ id: 'a', name: 'alpha' })]
    expect(sortSchedules(list).map((s) => s.id)).toEqual(['a', 'c', 'b'])
    expect(list.map((s) => s.id)).toEqual(['b', 'c', 'a'])
  })
})

describe('permissions (D217, Review Focus 2)', () => {
  const s = schedule({ createdById: 'owner' })
  test.each([
    ['the owner who can work', { userId: 'owner', canWork: true, canManage: false }, true],
    ['a project admin', { userId: 'admin', canWork: true, canManage: true }, true],
    ['another developer', { userId: 'dev2', canWork: true, canManage: false }, false],
    ['the owner, demoted to viewer', { userId: 'owner', canWork: false, canManage: false }, false],
    ['nobody signed in', { userId: null, canWork: false, canManage: false }, false],
  ])('%s -> %s', (_name, viewer, expected) => {
    expect(canChangeSchedule(s, viewer)).toBe(expected)
  })
})

describe('history rows (D221, Review Focus 5)', () => {
  test('delta to the nearest older job with progress; jobs without progress are skipped as a baseline', () => {
    const rows = historyRows([job('j3', p(4)), job('j2', null), job('j1', p(1))], true)
    expect(rows.map((r) => [r.job.id, r.passed, r.total, r.delta])).toEqual([
      ['j3', 4, 5, 3], ['j2', null, null, null], ['j1', 1, 5, 1],
    ])
  })

  test('the oldest row of a page that is not the last has no delta', () => {
    const rows = historyRows([job('j3', p(4)), job('j2', p(2))], false)
    expect(rows.map((r) => r.delta)).toEqual([2, null])
  })

  test('cost, push outcome and budget stop come through', () => {
    const [row] = historyRows([job('j1', p(1), { wipPush: 'failed:rejected', stateReason: 'budget:pol1', costSpentUsd: '0.4200' })], true)
    expect(row.cost).toBe('$0.42')
    expect(row.wipPush).toEqual({ key: 'failed', reason: 'rejected' })
    expect(row.budgetPolicyId).toBe('pol1')
  })

  test('formatDelta', () => {
    expect([formatDelta(2), formatDelta(0), formatDelta(-1), formatDelta(null)]).toEqual(['+2', '0', '-1', '-'])
  })
})
