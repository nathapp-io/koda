import { describe, test, expect } from '@jest/globals'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'
import { storyRows } from '~/lib/fleet-jobs'
import type { FleetJobDto } from '../../lib/fleet-types'

const file = webFile('components', 'fleet', 'FleetJobStories.vue')
const base = {
  state: 'RUNNING', currentStoryId: 'US-002', currentPhase: 'implement', storiesTruncated: false,
  stories: [
    { id: 'US-001', title: 'Login form', status: 'passed', attempts: 1, dependsOn: [] },
    { id: 'US-002', title: 'Session cookie', status: 'in-progress', attempts: 2, dependsOn: ['US-001'] },
  ],
} as unknown as FleetJobDto
const mount = (over: Partial<FleetJobDto> = {}) =>
  mountSfc(file, { props: { rows: storyRows({ ...base, ...over }) }, globals: { useI18n: enI18n }, components: uiStubs })

describe('FleetJobStories, the List view (S1b §1.4, D443)', () => {
  test('one row per story with title, translated status and attempts', () => {
    const { find, textOf, unmount } = mount()
    const rows = find('[data-testid="fleet-job-story"]')
    expect(rows.map(r => r.props['data-story'])).toEqual(['US-001', 'US-002'])
    expect(textOf(rows[0])).toContain('Login form')
    expect(textOf(rows[0])).toContain('Passed')
    expect(textOf(rows[0])).toContain('Attempts: 1')
    expect(find('[data-stub="badge"]').map(b => b.props.variant)).toEqual(['default', 'secondary'])
    unmount()
  })

  test('highlights the current story with its phase while the job is active', () => {
    const { find, textOf, unmount } = mount()
    expect(find('[data-testid="fleet-job-story"]').map(r => r.props['data-current'])).toEqual(['false', 'true'])
    const phase = find('[data-testid="fleet-job-story-phase"]')
    expect(phase).toHaveLength(1)
    expect(textOf(phase[0])).toContain('implement')
    unmount()
  })

  test('a finished job highlights nothing', () => {
    const { find, unmount } = mount({ state: 'FAILED' })
    expect(find('[data-testid="fleet-job-story"]').map(r => r.props['data-current'])).toEqual(['false', 'false'])
    expect(find('[data-testid="fleet-job-story-phase"]')).toHaveLength(0)
    unmount()
  })

  test('a muted "depends on" line only for stories that have dependencies', () => {
    const { find, textOf, unmount } = mount()
    const deps = find('[data-testid="fleet-job-story-deps"]')
    expect(deps).toHaveLength(1)
    expect(textOf(deps[0])).toBe('Depends on US-001')
    unmount()
  })
})
