import { describe, expect, it } from '@jest/globals'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'

const table = webFile('components', 'fleet', 'analytics', 'IngestTable.vue')
const row = (over: Record<string, unknown> = {}) => ({
  id: 'i1', jobId: 'job-1', leaseEpoch: 2, projectId: 'proj-1', status: 'failed', attempts: 5, parserVersion: 1,
  files: {}, error: 'corrupt gzip', ingestedAt: null, updatedAt: '2026-10-05T00:00:00.000Z', ...over,
})

describe('FleetAnalyticsIngestTable (D397)', () => {
  it('shows status, ids as text, attempts and error, and asks to re-run a row', () => {
    const app = mountSfc(table, { props: { rows: [row(), row({ id: 'i2', jobId: 'job-2', status: 'done', error: null })], busyJobId: null }, components: uiStubs, globals: { useI18n: () => enI18n() } })
    const rows = app.find('[data-testid="fleet-ingest-row"]')
    expect(rows.map((r) => [r.props['data-job'], r.props['data-status']])).toEqual([['job-1', 'failed'], ['job-2', 'done']])
    expect(app.textOf(rows[0])).toContain('Failed')
    expect(app.textOf(rows[0])).toContain('job-1')
    expect(app.textOf(rows[0])).toContain('proj-1')
    expect(app.textOf(rows[0])).toContain('corrupt gzip')
    expect(app.textOf(rows[1])).toContain('Done')
    app.find('[data-testid="fleet-ingest-rerun"]')[1].props.onClick()
    expect(app.emitted('rerun')).toEqual([['job-2']])
  })

  it('disables the button of the row being re-run', () => {
    const app = mountSfc(table, { props: { rows: [row()], busyJobId: 'job-1' }, components: uiStubs, globals: { useI18n: () => enI18n() } })
    expect(app.find('[data-testid="fleet-ingest-rerun"]')[0].props.disabled).toBe(true)
  })
})
