import { describe, expect, it } from '@jest/globals'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'

const table = webFile('components', 'fleet', 'analytics', 'IngestTable.vue')
const row = (jobId: string, projectId: string) => ({
  id: `${jobId}-${projectId}`, jobId, leaseEpoch: 2, projectId, status: 'failed' as const, attempts: 1, parserVersion: 1,
  files: {}, error: null, ingestedAt: null, updatedAt: '2026-10-05T00:00:00.000Z',
})

describe('FleetAnalyticsIngestTable project labels and links', () => {
  it('labels known projects, preserves unknown ids, links known jobs, shortens ids, and contains the table', () => {
    const longJobId = 'cmwaryvzf008i07s1ojm2l6qg'
    const app = mountSfc(table, {
      props: {
        rows: [row(longJobId, 'proj-1'), row('job-1', 'missing-project')],
        busyJobId: null,
        projects: [{ id: 'proj-1', slug: 'acme', name: 'Acme' }],
      },
      components: uiStubs,
      globals: { useI18n: () => enI18n() },
    })
    const rows = app.find('[data-testid="fleet-ingest-row"]')
    expect(app.textOf(rows[0])).toContain('Acme')
    expect(app.textOf(rows[1])).toContain('missing-project')
    const link = app.one('[data-stub="nuxt-link"]', rows[0])
    expect(link?.props.to).toBe('/acme/fleet/jobs/cmwaryvzf008i07s1ojm2l6qg')
    expect(app.find('[data-stub="nuxt-link"]', rows[1])).toHaveLength(0)
    expect(app.textOf(rows[1])).toContain('job-1')
    const shortId = app.one('[title="cmwaryvzf008i07s1ojm2l6qg"]', rows[0])
    expect(shortId && app.textOf(shortId)).toBe('cmwaryvz')
    expect(app.textOf(rows[0])).toContain('#2')
    const wrapper = app.one('[data-testid="fleet-ingest-table"]')?.parent
    expect(wrapper?.props.class).toContain('overflow-x-auto')
    expect(wrapper?.props.class).toContain('relative')
    app.unmount()
  })
})
