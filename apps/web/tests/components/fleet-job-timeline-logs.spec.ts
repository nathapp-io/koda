import { describe, expect, test } from '@jest/globals'
import { computed } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'

const file = webFile('components', 'fleet', 'FleetJobTimeline.vue')
const mount = (props: Record<string, unknown>) =>
  mountSfc(file, { props: { events: [], hasMore: false, loading: false, ...props }, globals: { computed, useI18n: () => enI18n() }, components: uiStubs })

describe('FleetJobTimeline log rows (spec §4.2)', () => {
  test('one "Full log" row per attempt, linking to the viewer for that attempt', () => {
    const m = mount({ logAttempts: [2, 1], logsHref: '/koda/fleet/jobs/j1/logs' })
    const links = m.find('[data-testid="fleet-job-timeline-logs"]')
    expect(links.map((l) => l.props.to)).toEqual([
      { path: '/koda/fleet/jobs/j1/logs', query: { epoch: '2' } },
      { path: '/koda/fleet/jobs/j1/logs', query: { epoch: '1' } },
    ])
    expect(m.textOf(links[0])).toContain('Full log of attempt 2')
    m.unmount()
  })

  test('no attempts, or no href (older callers), render no rows; the section is the #timeline anchor', () => {
    const none = mount({ logAttempts: [], logsHref: '/x' })
    expect(none.find('[data-testid="fleet-job-timeline-logs"]')).toHaveLength(0)
    expect(none.find('[data-testid="fleet-job-timeline"]')[0].props.id).toBe('timeline')
    none.unmount()
    const legacy = mount({})
    expect(legacy.find('[data-testid="fleet-job-timeline-logs"]')).toHaveLength(0)
    legacy.unmount()
  })
})
