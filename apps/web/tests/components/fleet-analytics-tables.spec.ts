import { describe, expect, it } from '@jest/globals'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'

const file = (name: string): string => webFile('components', 'fleet', 'analytics', name)
const mount = (name: string, props: Record<string, unknown>) => mountSfc(file(name), { props, components: uiStubs, globals: { useI18n: () => enI18n() } })
const byId = (app: ReturnType<typeof mountSfc>, id: string) => app.find(`[data-testid="${id}"]`)

describe('FleetAnalyticsStoryTable', () => {
  it('links each story to its job and shows attempts, first pass and unchanged cost', () => {
    const app = mount('StoryTable.vue', {
      slug: 'koda', testid: 'stories',
      rows: [{ jobId: 'j1', leaseEpoch: 1, featureName: 'multiply', storyId: 'US-001', attempts: 3, firstPassSuccess: false, success: true, costUsd: '0.1395', completedAt: null }],
    })
    const row = byId(app, 'stories-row')[0]
    expect(app.find('[data-stub="nuxt-link"]', row)[0].props.to).toBe('/koda/fleet/jobs/j1')
    expect(app.textOf(row)).toContain('US-001')
    expect(app.textOf(row)).toContain('multiply')
    expect(app.textOf(row)).toContain('3')
    expect(app.textOf(row)).toContain('No')
    expect(app.textOf(row)).toContain('$0.1395')
  })
})

describe('FleetAnalyticsJobTable', () => {
  it('shows cost, ledger and drift as given and a dash before ingest', () => {
    const app = mount('JobTable.vue', {
      slug: 'koda', testid: 'jobs',
      rows: [
        { jobId: 'j1', command: 'RUN', featureName: 'substract', state: 'ESCALATED', costUsd: '0.1573', ledgerCostUsd: '0.1573', driftUsd: '0.0000', finishedAt: null },
        { jobId: 'j2', command: 'PLAN', featureName: 'subtract', state: 'COMPLETED', costUsd: '0.0044', ledgerCostUsd: null, driftUsd: null, finishedAt: '2026-10-05T12:00:00.000Z' },
      ],
    })
    const [first, second] = byId(app, 'jobs-row')
    expect(app.find('[data-stub="nuxt-link"]', first)[0].props.to).toBe('/koda/fleet/jobs/j1')
    expect(app.textOf(first)).toContain('Escalated')
    expect(app.textOf(first)).toContain('$0.1573')
    expect(app.textOf(first)).toContain('$0.0000')
    expect(app.textOf(second)).toContain('$0.0044')
    expect(app.textOf(second)).toMatch(/\$0\.0044\s*-\s*-/)
  })
})

describe('FleetAnalyticsIngestNotice (D401)', () => {
  it('stays hidden with nothing pending or failed', () => {
    expect(byId(mount('IngestNotice.vue', { pending: 0, failed: 0, admin: true }), 'fleet-analytics-ingest-notice')).toHaveLength(0)
  })

  it('counts both and links admins to ingest health', () => {
    const member = mount('IngestNotice.vue', { pending: 2, failed: 1, admin: false })
    expect(member.text()).toContain('2 runs not yet analysed, 1 failed.')
    expect(byId(member, 'fleet-analytics-ingest-link')).toHaveLength(0)
    const admin = mount('IngestNotice.vue', { pending: 0, failed: 1, admin: true })
    expect(byId(admin, 'fleet-analytics-ingest-link')[0].props.to).toBe('/admin/fleet/analytics')
  })
})
