import { describe, expect, it } from '@jest/globals'
import { readdirSync, readFileSync } from 'node:fs'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'
import { dashboardTiles } from '~/lib/fleet-dashboard'
import type { AttentionItem } from '~/lib/fleet-dashboard-types'

const dir = webFile('components', 'fleet', 'dashboard')
const file = (name: string): string => webFile('components', 'fleet', 'dashboard', name)
/** The real FleetAge is mounted, so its stub is dropped. */
const { FleetAge: _ageStub, ...stubs } = uiStubs
const mount = (name: string, props: Record<string, unknown>) =>
  mountSfc(file(name), { props, components: stubs, fleetComponents: ['FleetAge'], globals: { useI18n: () => enI18n() } })
const byId = (app: ReturnType<typeof mountSfc>, id: string) => app.find(`[data-testid="${id}"]`)

const GEN = '2026-10-05T12:00:00.000Z'
const NOW = new Date('2026-10-05T12:00:10.000Z')
const job = (over: Partial<AttentionItem>): AttentionItem => ({
  key: 'job_silent:j1', kind: 'job_silent', severity: 'error', subjectType: 'job', subjectId: 'j1', subjectName: 'subtract',
  projectSlug: 'koda', since: '2026-10-05T11:50:00.000Z', stage: 'running', silentSec: 590, runnerName: 'wk-mac', ...over,
})
const runner: AttentionItem = {
  key: 'runner_unhealthy:r1', kind: 'runner_unhealthy', severity: 'warning', subjectType: 'runner', subjectId: 'r1',
  subjectName: 'linux-1', projectSlug: null, since: null, conditions: [{ type: 'offline', jobsHeld: 0 }, { type: 'configuration' }],
}
const unplaceable = job({
  key: 'job_unplaceable:j2', kind: 'job_unplaceable', severity: 'warning', subjectId: 'j2', subjectName: 'multiply', stage: undefined,
  verdict: 'no_fit', reasons: [{ runnerName: 'wk-mac', reason: 'labels' }], reasonsTotal: 3,
})

describe('dashboard components never render HTML from data (Review Focus 1)', () => {
  it('no component in components/fleet/dashboard uses v-html', () => {
    for (const name of readdirSync(dir).filter((f) => f.endsWith('.vue'))) {
      expect({ name, vHtml: readFileSync(file(name), 'utf-8').includes('v-html') }).toEqual({ name, vHtml: false })
    }
  })
})

describe('FleetDashboardTiles (D423)', () => {
  it('one link per count, to its section, with the tone and the label', () => {
    const app = mount('Tiles.vue', { tiles: dashboardTiles({ runnersOnline: 1, runnersTotal: 2, queued: 0, running: 3, attention: 1 }) })
    const tile = (id: string) => byId(app, `fleet-dashboard-tile-${id}`)[0]
    expect(tile('runners').props.href).toBe('#fleet-dashboard-runners')
    expect(tile('runners').props['data-tone']).toBe('warn')
    expect(tile('attention').props.href).toBe('#fleet-dashboard-attention')
    expect(tile('attention').props['data-tone']).toBe('bad')
    expect(app.textOf(byId(app, 'fleet-dashboard-tile-runners-value')[0])).toBe('1/2')
    expect(app.textOf(tile('running'))).toContain('Running')
    expect(app.textOf(byId(app, 'fleet-dashboard-tile-running-value')[0])).toBe('3')
  })
})

describe('FleetDashboardAttentionList (spec §4.2, D418, D419)', () => {
  it('keeps the server order and marks each item with its key, kind and severity', () => {
    const app = mount('AttentionList.vue', { items: [job({}), unplaceable, runner], generatedAt: GEN, now: NOW, scope: 'global' })
    expect(byId(app, 'fleet-dashboard-attention-item').map((n) => [n.props['data-key'], n.props['data-kind'], n.props['data-severity']])).toEqual([
      ['job_silent:j1', 'job_silent', 'error'],
      ['job_unplaceable:j2', 'job_unplaceable', 'warning'],
      ['runner_unhealthy:r1', 'runner_unhealthy', 'warning'],
    ])
  })

  it('words each item: severity, subject, project, age, summary, details and the rest counted', () => {
    const app = mount('AttentionList.vue', { items: [job({}), unplaceable, runner], generatedAt: GEN, now: NOW, scope: 'global' })
    const [silent, misfit, sick] = byId(app, 'fleet-dashboard-attention-item')
    expect(app.textOf(silent)).toContain('Error')
    expect(app.textOf(silent)).toContain('subtract')
    expect(app.textOf(silent)).toContain('koda')
    expect(app.textOf(silent)).toContain('10m ago')
    expect(app.textOf(byId(app, 'fleet-dashboard-attention-summary')[0])).toBe('No heartbeat for 10m on wk-mac')
    expect(app.textOf(misfit)).toContain('No runner fits right now')
    expect(app.textOf(misfit)).toContain('wk-mac: Runner lacks a required label')
    expect(app.textOf(misfit)).toContain('and 2 more runner(s)')
    expect(app.find('[data-testid="fleet-dashboard-attention-detail"]', sick).map((n) => app.textOf(n)))
      .toEqual(['Offline', 'Configuration problem (ask a fleet admin)'])
  })

  it('links jobs to the job page, approvals to the inbox, runners to the admin Runners page (admin scope)', () => {
    const approval = job({ key: 'job_waiting_approval:j3', kind: 'job_waiting_approval', subjectId: 'j3', pending: 1, oldestSec: 30 })
    const app = mount('AttentionList.vue', { items: [job({}), approval, runner], generatedAt: GEN, now: NOW, scope: 'global' })
    expect(byId(app, 'fleet-dashboard-attention-link').map((n) => n.props.to)).toEqual([
      '/koda/fleet/jobs/j1', '/koda/fleet/approvals', '/admin/fleet/runners',
    ])
  })

  it('project scope: runner items are plain text and the project slug is not repeated', () => {
    const app = mount('AttentionList.vue', { items: [job({}), runner], generatedAt: GEN, now: NOW, scope: 'project' })
    expect(byId(app, 'fleet-dashboard-attention-link').map((n) => n.props.to)).toEqual(['/koda/fleet/jobs/j1'])
    expect(app.text()).toContain('linux-1')
    expect(byId(app, 'fleet-dashboard-attention-project')).toHaveLength(0)
  })

  it('shows markup in a name as text, never as an element (Review Focus 1)', () => {
    const evil = '<img src=x onerror=alert(1)>'
    const app = mount('AttentionList.vue', {
      items: [job({ subjectName: evil, runnerName: evil })], generatedAt: GEN, now: NOW, scope: 'global',
    })
    expect(app.text()).toContain(evil)
    expect(app.find('img')).toHaveLength(0)
  })

  it('an empty list says All clear', () => {
    const app = mount('AttentionList.vue', { items: [], generatedAt: GEN, now: NOW, scope: 'global' })
    expect(app.textOf(byId(app, 'fleet-dashboard-all-clear')[0])).toBe('All clear')
    expect(byId(app, 'fleet-dashboard-attention-list')).toHaveLength(0)
  })
})
