import { describe, expect, it } from '@jest/globals'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import type { FleetComponentName } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'
import type { FleetDashboard } from '~/lib/fleet-dashboard-types'

const REAL: FleetComponentName[] = [
  'FleetAge', 'FleetDashboardTiles', 'FleetDashboardAttentionList', 'FleetDashboardActiveRunsTable', 'FleetDashboardRecentRunsList',
  'FleetDashboardRunnerHealthList', 'FleetDashboardCredentialDigestChips',
]
const { FleetAge: _ageStub, ...stubs } = uiStubs
const mount = (props: Record<string, unknown>) =>
  mountSfc(webFile('components', 'fleet', 'dashboard', 'Overview.vue'), {
    props: { failed: false, staleSince: null, now: new Date('2026-10-05T12:00:05.000Z'), scope: 'global', analyticsTo: '/admin/fleet/analytics', ...props },
    components: stubs, fleetComponents: REAL, globals: { useI18n: () => enI18n() },
  })
const byId = (app: ReturnType<typeof mountSfc>, id: string) => app.find(`[data-testid="${id}"]`)

const EMPTY: FleetDashboard = {
  generatedAt: '2026-10-05T12:00:00.000Z',
  counts: { runnersOnline: 0, runnersTotal: 0, queued: 0, running: 0, attention: 0 },
  runners: [], activeJobs: [], activeTruncated: false, recentJobs: [], recentTruncated: false, attention: [],
}

const FULL: FleetDashboard = {
  ...EMPTY,
  counts: { runnersOnline: 1, runnersTotal: 1, queued: 0, running: 1, attention: 1 },
  runners: [{
    id: 'r1', name: 'wk-mac', os: 'darwin', arch: 'arm64', labels: [], enabled: true, online: true, lastSeenAt: '2026-10-05T11:59:59.000Z',
    capacity: 2, activeJobs: 1, naxVersion: '0.83.3', daemonVersion: '0.1.0', credentials: [],
  }],
  activeJobs: [{
    id: 'j1', projectSlug: 'koda', repo: 'acme/app', feature: 'subtract', command: 'RUN', state: 'RUNNING', runnerId: 'r1', runnerName: 'wk-mac',
    currentStoryId: 'US-001', currentPhase: 'run', storiesDone: 0, storiesTotal: 1, costSpentUsd: '0.0100', maxCostUsd: '5.0000',
    queuedAt: '2026-10-05T11:00:00.000Z', startedAt: '2026-10-05T11:00:05.000Z', lastHeartbeatAt: '2026-10-05T11:45:00.000Z', pendingApprovals: 0,
  }],
  attention: [{
    key: 'job_silent:j1', kind: 'job_silent', severity: 'error', subjectType: 'job', subjectId: 'j1', subjectName: 'subtract',
    projectSlug: 'koda', since: '2026-10-05T11:45:00.000Z', stage: 'running', silentSec: 900, runnerName: 'wk-mac',
  }],
}

describe('FleetDashboardOverview (spec §4, D420, D422)', () => {
  it('loading before the first snapshot, the error state with Retry when it failed', () => {
    const loading = mount({ snapshot: null })
    expect(loading.find('[data-stub="loading-state"]')).toHaveLength(1)
    const failed = mount({ snapshot: null, failed: true })
    expect(byId(failed, 'fleet-dashboard-error')).toHaveLength(1)
    const errorState = failed.find('[data-stub="error-state"]')[0]
    ;(errorState.props.onRetry as () => void)()
    expect(failed.emitted('retry')).toHaveLength(1)
  })

  it('an empty fleet: zero tiles, All clear, and every section empty (Review Focus 5)', () => {
    const app = mount({ snapshot: EMPTY })
    expect(['runners', 'queued', 'running', 'attention'].map((id) => app.textOf(byId(app, `fleet-dashboard-tile-${id}-value`)[0])))
      .toEqual(['0/0', '0', '0', '0'])
    expect(byId(app, 'fleet-dashboard-all-clear')).toHaveLength(1)
    expect(app.find('[data-stub="empty-state"]').map((n) => n.props.message))
      .toEqual(['No active jobs', 'No runners enrolled', 'No runs in the last 24 hours'])
  })

  it('a snapshot: the four sections in order, with their anchors, and the updated age', () => {
    const app = mount({ snapshot: FULL })
    expect(['attention', 'active', 'runners', 'recent'].map((s) => byId(app, `fleet-dashboard-section-${s}`)[0]?.props.id)).toEqual([
      'fleet-dashboard-attention', 'fleet-dashboard-active', 'fleet-dashboard-runners', 'fleet-dashboard-recent',
    ])
    expect(app.textOf(byId(app, 'fleet-dashboard-updated')[0])).toBe('Updated 5s ago')
    expect(byId(app, 'fleet-dashboard-attention-item')[0].props['data-key']).toBe('job_silent:j1')
    expect(byId(app, 'fleet-dashboard-active-row')[0].props['data-job']).toBe('j1')
    expect(byId(app, 'fleet-dashboard-runner')[0].props['data-runner']).toBe('r1')
    expect(byId(app, 'fleet-dashboard-stale')).toHaveLength(0)
  })

  it('a stale snapshot stays on screen with the note', () => {
    const app = mount({ snapshot: FULL, staleSince: '09:07' })
    expect(app.textOf(byId(app, 'fleet-dashboard-stale')[0])).toBe('Could not refresh. Showing data from 09:07.')
    expect(byId(app, 'fleet-dashboard-attention-item')).toHaveLength(1)
  })
})
