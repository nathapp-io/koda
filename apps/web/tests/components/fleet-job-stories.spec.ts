import { describe, test, expect } from '@jest/globals'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'
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
  mountSfc(file, { props: { job: { ...base, ...over } }, globals: { useI18n: enI18n }, components: uiStubs })

describe('FleetJobStories (S1b §1.4)', () => {
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

  test('the truncation note shows only when the list was cut', () => {
    const plain = mount()
    expect(plain.find('[data-testid="fleet-job-stories-truncated"]')).toHaveLength(0)
    plain.unmount()
    const cut = mount({ storiesTruncated: true })
    const note = cut.find('[data-testid="fleet-job-stories-truncated"]')
    expect(note).toHaveLength(1)
    expect(cut.textOf(note[0])).toContain('first 2 stories')
    cut.unmount()
  })

  test('without a list it renders nothing (the page keeps the counts only)', () => {
    const { find, unmount } = mount({ stories: null })
    expect(find('[data-testid="fleet-job-stories"]')).toHaveLength(0)
    unmount()
  })
})
