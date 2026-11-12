import { describe, test, expect } from '@jest/globals'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import type { FakeNode, Mounted } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'
import type { FleetJobDto } from '../../lib/fleet-types'

const file = webFile('components', 'fleet', 'FleetJobProgress.vue')
const job = (over: Partial<FleetJobDto> = {}): FleetJobDto => ({
  state: 'RUNNING',
  progress: { total: 5, passed: 2, failed: 0, paused: 0, blocked: 0, pending: 3 },
  currentStoryId: 'US-002',
  currentPhase: 'final-gates',
  costSpentUsd: '0.1000',
  maxCostUsd: '5.0000',
  ...over,
} as unknown as FleetJobDto)

const mount = (over: Partial<FleetJobDto> = {}): Mounted =>
  mountSfc(file, { props: { job: job(over) }, globals: { useI18n: enI18n }, components: uiStubs })
const byId = (app: Mounted, id: string): FakeNode => {
  const found = app.one(`[data-testid="${id}"]`)
  if (!found) throw new Error(`no ${id}`)
  return found
}
const field = (app: Mounted, id: string): string => app.textOf(byId(app, id))

describe('FleetJobProgress live fields (US-005)', () => {
  test('AC-1: RUNNING renders live fields and cost', () => {
    const app = mount({ state: 'RUNNING' })
    for (const id of ['fleet-job-progress', 'fleet-job-story', 'fleet-job-phase', 'fleet-job-cost']) {
      expect(app.one(`[data-testid="${id}"]`)).toBeDefined()
    }
    app.unmount()
  })

  test('AC-2: COMPLETED renders only cost', () => {
    const app = mount({ state: 'COMPLETED' })
    expect(app.one('[data-testid="fleet-job-cost"]')).toBeDefined()
    for (const id of ['fleet-job-progress', 'fleet-job-story', 'fleet-job-phase']) {
      expect(app.one(`[data-testid="${id}"]`)).toBeUndefined()
    }
    app.unmount()
  })

  test('AC-3: uses a three-column responsive grid', () => {
    const app = mount()
    const grid = app.one('dl')
    expect(grid?.props.class).toContain('grid-cols-1')
    expect(grid?.props.class).toContain('sm:grid-cols-3')
    expect(grid?.props.class).not.toContain('sm:grid-cols-4')
    app.unmount()
  })
})

describe('FleetJobProgress phase (D7)', () => {
  test('AC-4: a job at a known nax phase names it in English', () => {
    const app = mount({ currentPhase: 'final-gates' })
    expect(field(app, 'fleet-job-phase')).toBe('Final gates')
    app.unmount()
  })

  test('AC-5: a phase the web does not know is shown raw (R4)', () => {
    const app = mount({ currentPhase: 'half-built' })
    expect(field(app, 'fleet-job-phase')).toBe('half-built')
    app.unmount()
  })

  test('a job with no phase yet reads -', () => {
    const app = mount({ currentPhase: null })
    expect(field(app, 'fleet-job-phase')).toBe('-')
    app.unmount()
  })

  test('progress, story and cost keep their own rendering', () => {
    const app = mount()
    expect(field(app, 'fleet-job-progress')).toContain('2 of 5 stories passed, 0 failed')
    expect(field(app, 'fleet-job-story')).toBe('US-002')
    expect(field(app, 'fleet-job-cost')).toBe('$0.10 of $5.00')
    app.unmount()
  })
})
