import { describe, expect, it } from '@jest/globals'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'
import type { DashboardRunner } from '~/lib/fleet-dashboard-types'

const { FleetAge: _ageStub, ...stubs } = uiStubs
const mount = (props: Record<string, unknown>) =>
  mountSfc(webFile('components', 'fleet', 'dashboard', 'RunnerHealthList.vue'), {
    props, components: stubs, fleetComponents: ['FleetAge', 'FleetDashboardCredentialDigestChips'], globals: { useI18n: () => enI18n() },
  })
const byId = (app: ReturnType<typeof mountSfc>, id: string) => app.find(`[data-testid="${id}"]`)
const NOW = new Date('2026-10-05T12:00:00.000Z')

const runner = (id: string, over: Partial<DashboardRunner> = {}): DashboardRunner => ({
  id, name: id, os: 'darwin', arch: 'arm64', labels: [], enabled: true, online: true, lastSeenAt: '2026-10-05T11:59:50.000Z',
  capacity: 2, activeJobs: 1, naxVersion: '0.83.3', daemonVersion: '0.1.0',
  credentials: [
    { providerId: 'deepseek', available: true, kind: 'api-key', expiresAt: null, expired: false },
    { providerId: 'anthropic', available: false, kind: null, expiresAt: null, expired: false },
  ],
  ...over,
})

describe('FleetDashboardRunnerHealthList (spec §4.2, B5)', () => {
  it('admin scope: online state, busy/capacity, last seen, versions and credential chips', () => {
    const app = mount({ runners: [runner('wk-mac')], now: NOW, scope: 'global' })
    const row = byId(app, 'fleet-dashboard-runner')[0]
    expect(row.props['data-runner']).toBe('wk-mac')
    expect(row.props['data-online']).toBe('true')
    expect(app.textOf(row)).toContain('Online')
    expect(app.textOf(row)).toContain('Last seen 10s ago')
    expect(app.textOf(byId(app, 'fleet-dashboard-runner-busy')[0])).toBe('1 of 2 busy')
    expect(app.textOf(byId(app, 'fleet-dashboard-runner-versions')[0])).toBe('nax 0.83.3 · daemon 0.1.0')
    expect(byId(app, 'fleet-dashboard-credential').map((n) => [app.textOf(n), n.props['data-tone']])).toEqual([
      ['deepseek: API key', 'ok'], ['anthropic: unavailable', 'bad'],
    ])
  })

  it('project scope: no versions and no credential chips, even if the data had them', () => {
    const app = mount({ runners: [runner('wk-mac')], now: NOW, scope: 'project' })
    expect(byId(app, 'fleet-dashboard-runner-versions')).toHaveLength(0)
    expect(byId(app, 'fleet-dashboard-credentials')).toHaveLength(0)
    expect(app.text()).not.toContain('0.83.3')
  })

  it('an admin runner with unreadable capabilities says the nax version is unknown', () => {
    const app = mount({ runners: [runner('x', { naxVersion: null, credentials: [] })], now: NOW, scope: 'global' })
    expect(app.textOf(byId(app, 'fleet-dashboard-runner-versions')[0])).toBe('nax version unknown · daemon 0.1.0')
    expect(byId(app, 'fleet-dashboard-credentials')).toHaveLength(0)
  })

  it('offline and disabled runners say so in words', () => {
    const app = mount({ runners: [runner('x', { online: false, enabled: false })], now: NOW, scope: 'project' })
    const row = byId(app, 'fleet-dashboard-runner')[0]
    expect(row.props['data-online']).toBe('false')
    expect(app.textOf(row)).toContain('Offline')
    expect(app.textOf(row)).toContain('Disabled')
  })

  it('no runners shows the empty text', () => {
    const app = mount({ runners: [], now: NOW, scope: 'global' })
    expect(app.find('[data-stub="empty-state"]').map((n) => n.props.message)).toEqual(['No runners enrolled'])
  })
})
