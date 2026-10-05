import { describe, expect, it } from '@jest/globals'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'
import type { DashboardActiveJob, DashboardRecentJob } from '~/lib/fleet-dashboard-types'

const file = (name: string): string => webFile('components', 'fleet', 'dashboard', name)
const { FleetAge: _ageStub, ...stubs } = uiStubs
const mount = (name: string, props: Record<string, unknown>) =>
  mountSfc(file(name), { props, components: stubs, fleetComponents: ['FleetAge'], globals: { useI18n: () => enI18n() } })
const byId = (app: ReturnType<typeof mountSfc>, id: string) => app.find(`[data-testid="${id}"]`)
const texts = (app: ReturnType<typeof mountSfc>, id: string) => byId(app, id).map((n) => app.textOf(n))

const NOW = new Date('2026-10-05T12:00:00.000Z')

const active = (id: string, over: Partial<DashboardActiveJob> = {}): DashboardActiveJob => ({
  id, projectSlug: 'koda', repo: 'acme/app', feature: `feat-${id}`, command: 'RUN', state: 'RUNNING', runnerId: 'r1', runnerName: 'wk-mac',
  currentStoryId: 'US-002', currentPhase: 'review', storiesDone: 3, storiesTotal: 5, costSpentUsd: '0.0664', maxCostUsd: '5.0000',
  queuedAt: '2026-10-05T11:00:00.000Z', startedAt: '2026-10-05T11:01:00.000Z', lastHeartbeatAt: '2026-10-05T11:58:00.000Z',
  pendingApprovals: 0, ...over,
})

const recent = (id: string, over: Partial<DashboardRecentJob> = {}): DashboardRecentJob => ({
  id, projectSlug: 'koda', repo: 'acme/app', feature: `feat-${id}`, command: 'RUN', state: 'COMPLETED', stateReason: null,
  runnerName: 'wk-mac', costSpentUsd: '0.1395', startedAt: '2026-10-05T11:40:00.000Z', finishedAt: '2026-10-05T11:55:00.000Z',
  resultPrUrl: 'https://github.com/acme/app/pull/2', ...over,
})

describe('FleetDashboardActiveRunsTable (spec §4.2)', () => {
  it('one row per job in API order, the feature linking to the job page', () => {
    const app = mount('ActiveRunsTable.vue', { jobs: [active('a'), active('b')], now: NOW, scope: 'project', truncated: false })
    expect(byId(app, 'fleet-dashboard-active-row').map((r) => r.props['data-job'])).toEqual(['a', 'b'])
    expect(byId(app, 'fleet-dashboard-active-link').map((n) => n.props.to)).toEqual(['/koda/fleet/jobs/a', '/koda/fleet/jobs/b'])
  })

  it('shows stories done/total, cost against the cap unchanged, story, phase and heartbeat age', () => {
    const app = mount('ActiveRunsTable.vue', { jobs: [active('a')], now: NOW, scope: 'project', truncated: false })
    expect(texts(app, 'fleet-dashboard-active-stories')).toEqual(['3/5'])
    expect(texts(app, 'fleet-dashboard-active-cost')).toEqual(['$0.0664 / $5.0000'])
    const row = app.textOf(byId(app, 'fleet-dashboard-active-row')[0])
    expect(row).toContain('US-002')
    expect(row).toContain('review')
    expect(row).toContain('2m ago')
    expect(row).toContain('Running')
  })

  it('the project column shows only in the admin scope', () => {
    const admin = mount('ActiveRunsTable.vue', { jobs: [active('a')], now: NOW, scope: 'global', truncated: false })
    const member = mount('ActiveRunsTable.vue', { jobs: [active('a')], now: NOW, scope: 'project', truncated: false })
    expect(admin.find('[data-stub="th"]').length).toBe(member.find('[data-stub="th"]').length + 1)
    expect(admin.text()).toContain('Project')
    expect(member.text()).not.toContain('Project')
  })

  it('a queued job reads Not assigned; a deleted runner reads Unknown; unknown stories read -', () => {
    const app = mount('ActiveRunsTable.vue', {
      jobs: [
        active('q', { state: 'QUEUED', runnerId: null, runnerName: null, storiesDone: null, storiesTotal: null, lastHeartbeatAt: null }),
        active('d', { runnerId: 'gone', runnerName: null }),
      ],
      now: NOW, scope: 'project', truncated: false,
    })
    expect(texts(app, 'fleet-dashboard-active-runner')).toEqual(['Not assigned', 'Unknown'])
    expect(texts(app, 'fleet-dashboard-active-stories')[0]).toBe('-')
  })

  it('flags pending approvals on the row', () => {
    const app = mount('ActiveRunsTable.vue', { jobs: [active('a', { pendingApprovals: 2 })], now: NOW, scope: 'project', truncated: false })
    expect(texts(app, 'fleet-dashboard-active-approvals')).toEqual(['2 approval(s) pending'])
  })

  it('a state the web does not know shows its raw code (Review Focus 4)', () => {
    const app = mount('ActiveRunsTable.vue', { jobs: [active('a', { state: 'HIBERNATING' })], now: NOW, scope: 'project', truncated: false })
    expect(app.textOf(byId(app, 'fleet-job-state')[0])).toBe('HIBERNATING')
  })

  it('says when the list was capped, and shows the empty state with no jobs', () => {
    const capped = mount('ActiveRunsTable.vue', { jobs: [active('a')], now: NOW, scope: 'project', truncated: true })
    expect(texts(capped, 'fleet-dashboard-active-truncated')).toEqual(['Showing the oldest 200 active jobs.'])
    const empty = mount('ActiveRunsTable.vue', { jobs: [], now: NOW, scope: 'project', truncated: false })
    expect(empty.find('[data-stub="empty-state"]').map((n) => n.props.message)).toEqual(['No active jobs'])
    expect(byId(empty, 'fleet-dashboard-active')).toHaveLength(0)
  })
})

describe('FleetDashboardRecentRunsList (spec §4.2, B6, D419)', () => {
  const props = (jobs: DashboardRecentJob[], over: Record<string, unknown> = {}) =>
    ({ jobs, now: NOW, scope: 'project', truncated: false, analyticsTo: '/koda/fleet/analytics', ...over })

  it('state, duration, cost unchanged, finished age and the job link', () => {
    const app = mount('RecentRunsList.vue', props([recent('a')]))
    expect(byId(app, 'fleet-dashboard-recent-row').map((r) => r.props['data-job'])).toEqual(['a'])
    expect(byId(app, 'fleet-dashboard-recent-link')[0].props.to).toBe('/koda/fleet/jobs/a')
    expect(texts(app, 'fleet-dashboard-recent-duration')).toEqual(['15m'])
    expect(texts(app, 'fleet-dashboard-recent-cost')).toEqual(['$0.1395'])
    const row = app.textOf(byId(app, 'fleet-dashboard-recent-row')[0])
    expect(row).toContain('Completed')
    expect(row).toContain('5m ago')
  })

  it('the PR link opens a new tab safely, and only for http(s) URLs', () => {
    const app = mount('RecentRunsList.vue', props([recent('a'), recent('b', { resultPrUrl: 'javascript:alert(1)' }), recent('c', { resultPrUrl: null })]))
    const links = byId(app, 'fleet-dashboard-recent-pr')
    expect(links.map((n) => n.props.href)).toEqual(['https://github.com/acme/app/pull/2'])
    expect(links[0].props.rel).toBe('noopener noreferrer')
    expect(links[0].props.target).toBe('_blank')
  })

  it('shows the state reason and - for a job that never started', () => {
    const app = mount('RecentRunsList.vue', props([recent('a', { state: 'CRASHED', stateReason: 'runner silent', startedAt: null })]))
    expect(texts(app, 'fleet-dashboard-recent-reason')).toEqual(['runner silent'])
    expect(texts(app, 'fleet-dashboard-recent-duration')).toEqual(['-'])
  })

  it('links to the Analytics page, notes the cap, and shows the empty text', () => {
    const app = mount('RecentRunsList.vue', props([recent('a')], { truncated: true }))
    expect(byId(app, 'fleet-dashboard-analytics-link')[0].props.to).toBe('/koda/fleet/analytics')
    expect(texts(app, 'fleet-dashboard-recent-truncated')).toEqual(['Showing the latest 20.'])
    const empty = mount('RecentRunsList.vue', props([]))
    expect(empty.find('[data-stub="empty-state"]').map((n) => n.props.message)).toEqual(['No runs in the last 24 hours'])
    expect(byId(empty, 'fleet-dashboard-analytics-link')).toHaveLength(1)
  })

  it('the project column shows only in the admin scope', () => {
    const admin = mount('RecentRunsList.vue', props([recent('a')], { scope: 'global' }))
    const member = mount('RecentRunsList.vue', props([recent('a')]))
    expect(admin.find('[data-stub="th"]').length).toBe(member.find('[data-stub="th"]').length + 1)
  })
})
