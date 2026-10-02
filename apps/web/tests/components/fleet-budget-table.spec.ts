import { describe, test, expect } from '@jest/globals'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { uiStubs, enI18n } from '../helpers/fleet-harness'
import type { BudgetPolicyDto } from '../../lib/fleet-types'
import type { FakeNode } from '../helpers/mount-sfc'

const table = webFile('components', 'fleet', 'BudgetTable.vue')

const policy = (id: string, over: Partial<BudgetPolicyDto> = {}): BudgetPolicyDto => ({
  id, scopeType: 'global', scopeId: null, projectId: null, windowKind: 'calendar_month_utc', amountUsd: '5.0000',
  warnPercent: 80, hardStop: true, runningJobs: 'finish', paused: false, pausedAt: null,
  windowStart: '2026-10-01T00:00:00.000Z', spentUsd: '1.0000', warnReached: false, updatedById: 'u1',
  createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', ...over,
})

function mountTable(policies: BudgetPolicyDto[], editable: boolean, scopeName: (p: BudgetPolicyDto) => string | null = () => null) {
  return mountSfc(table, {
    components: uiStubs,
    props: { policies, editable, scopeName },
    globals: { useI18n: () => enI18n() },
  })
}

const rowOf = (app: ReturnType<typeof mountTable>, id: string): FakeNode => {
  const row = app.find('[data-stub="tr"]').find((r) => r.props['data-testid'] === `fleet-budget-row-${id}`)
  if (!row) throw new Error(`no row ${id}`)
  return row
}
const buttonLabels = (app: ReturnType<typeof mountTable>, id: string): string[] =>
  app.find('[data-stub="button"]', rowOf(app, id)).map((b) => app.textOf(b))

describe('FleetBudgetTable', () => {
  test('one row per policy with the scope name, window and spend text', () => {
    const app = mountTable(
      [
        policy('g'),
        policy('r', { scopeType: 'repo', scopeId: 'r1', windowKind: 'lifetime', spentUsd: '2.5000' }),
      ],
      false,
      (p) => (p.scopeType === 'repo' ? 'acme/app' : null),
    )
    const repo = app.textOf(rowOf(app, 'r'))
    expect(repo).toContain('Repo')
    expect(repo).toContain('acme/app')
    expect(repo).toContain('Lifetime')
    expect(repo).toContain('$2.50 of $5.00')
    expect(repo).toContain('50%')
    const global = app.textOf(rowOf(app, 'g'))
    expect(global).toContain('Whole fleet')
    expect(global).toContain('Calendar month (UTC)')
    expect(global).toContain('since 2026-10-01')
    app.unmount()
  })

  test('status follows the server flags and the row carries it', () => {
    const app = mountTable([policy('ok'), policy('warn', { warnReached: true, scopeId: 'w' }), policy('stop', { paused: true, warnReached: true, scopeId: 'z' })], false)
    expect(['ok', 'warn', 'stop'].map((id) => rowOf(app, id).props['data-status'])).toEqual(['ok', 'warning', 'paused'])
    expect(app.textOf(rowOf(app, 'ok'))).toContain('Within budget')
    expect(app.textOf(rowOf(app, 'warn'))).toContain('Warning')
    expect(app.textOf(rowOf(app, 'stop'))).toContain('Paused')
    app.unmount()
  })

  test('the percentage is floored: 4.99 of 5.00 shows 99%, never 100%', () => {
    const app = mountTable([policy('a', { spentUsd: '4.9900' })], false)
    expect(app.textOf(rowOf(app, 'a'))).toContain('99%')
    app.unmount()
  })

  test('rules: warn threshold or none, hard stop or alert only, running-jobs mode only when it applies', () => {
    const app = mountTable([
      policy('a', { warnPercent: 90, runningJobs: 'cancel' }),
      policy('b', { warnPercent: null, hardStop: false, scopeId: 'b' }),
    ], false)
    const a = app.textOf(rowOf(app, 'a'))
    expect(a).toContain('Warns at 90%')
    expect(a).toContain('Pauses at the limit')
    expect(a).toContain('Running jobs are cancelled')
    const b = app.textOf(rowOf(app, 'b'))
    expect(b).toContain('No warning')
    expect(b).toContain('Alerts only')
    expect(b).not.toContain('Running jobs')
    app.unmount()
  })

  test('a read-only table has no buttons at all (Review Focus 3)', () => {
    const app = mountTable([policy('a', { paused: true })], false)
    expect(buttonLabels(app, 'a')).toEqual([])
    app.unmount()
  })

  test('an editable table offers Edit and Delete, and Resume only on a paused row', () => {
    const app = mountTable([policy('ok'), policy('stop', { paused: true, scopeId: 's' })], true)
    expect(buttonLabels(app, 'ok')).toEqual(['Edit', 'Delete'])
    expect(buttonLabels(app, 'stop')).toEqual(['Resume', 'Edit', 'Delete'])
    app.unmount()
  })

  test('the buttons emit the row policy', () => {
    const rows = [policy('stop', { paused: true })]
    const app = mountTable(rows, true)
    const click = (label: string): void => {
      const button = app.find('[data-stub="button"]', rowOf(app, 'stop')).find((b) => app.textOf(b) === label)
      ;(button?.props.onClick as () => void)()
    }
    click('Resume')
    click('Edit')
    click('Delete')
    expect(app.emitted('resume')).toEqual([[rows[0]]])
    expect(app.emitted('edit')).toEqual([[rows[0]]])
    expect(app.emitted('remove')).toEqual([[rows[0]]])
    app.unmount()
  })

  test('a paused row shows when it was paused', () => {
    const app = mountTable([policy('stop', { paused: true, pausedAt: '2026-10-02T03:04:05.000Z' })], false)
    // The badge says Paused; the line under it says Paused <local date and time>.
    expect(app.textOf(rowOf(app, 'stop'))).toMatch(/Paused\s*Paused \S/)
    app.unmount()
  })
})
