import { describe, test, expect } from '@jest/globals'
import * as Vue from 'vue'
import { ref, computed, watch, nextTick } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { uiStubs, enI18n } from '../helpers/fleet-harness'
import type { ScheduleDto } from '../../lib/fleet-types'
import type { ScheduleViewer } from '../../lib/fleet-schedules'

const table = webFile('components', 'fleet', 'ScheduleTable.vue')

const schedule = (id: string, over: Partial<ScheduleDto> = {}): ScheduleDto => ({
  id, projectId: 'p1', repoId: 'r1', name: `s-${id}`, cron: '0 9 * * 1-5', timezone: 'UTC', feature: 'login', ref: 'main',
  profiles: [], maxCostUsd: '5.0000', selectorLabels: [], pinnedRunnerId: null, enabled: true,
  nextFireAt: '2026-10-05T09:00:00.000Z', lastFiredAt: null, lastJobId: null, lastPassedCount: 0, noProgressTicks: 0,
  noProgressLimit: 3, disabledReason: null, totalCostUsd: '0.0000', createdById: 'owner', updatedById: 'owner',
  createdAt: '2026-10-02T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z', ...over,
})

function mountTable(schedules: ScheduleDto[], viewer: ScheduleViewer) {
  const app = mountSfc(table, {
    components: uiStubs,
    props: {
      schedules, slug: 'koda', viewer, busy: false,
      repoName: (id: string) => (id === 'r1' ? 'acme/app' : id),
      ownerName: (id: string) => (id === 'owner' ? 'Olive' : null),
    },
    globals: { ref, computed, watch, nextTick, onMounted: Vue.onMounted, useI18n: () => enI18n() },
  })
  const row = (id: string) => app.find('[data-stub="tr"]').find((r) => r.props['data-testid'] === `fleet-schedule-row-${id}`)
  const buttons = (id: string): string[] => {
    const r = row(id)
    return r ? app.find('[data-stub="button"]', r).map((b) => String(b.props['data-testid'])) : ['<missing>']
  }
  return { app, row, buttons }
}

const OWNER: ScheduleViewer = { userId: 'owner', canWork: true, canManage: false }
const OTHER_DEV: ScheduleViewer = { userId: 'dev2', canWork: true, canManage: false }
const ADMIN: ScheduleViewer = { userId: 'admin', canWork: true, canManage: true }
const VIEWER: ScheduleViewer = { userId: 'v', canWork: false, canManage: false }

describe('FleetScheduleTable', () => {
  test('owner and project admin get Disable, Edit, Delete; another developer and a viewer get nothing (Review Focus 2)', () => {
    for (const [viewer, expected] of [
      [OWNER, ['fleet-schedule-disable', 'fleet-schedule-edit', 'fleet-schedule-delete']],
      [ADMIN, ['fleet-schedule-disable', 'fleet-schedule-edit', 'fleet-schedule-delete']],
      [OTHER_DEV, []],
      [VIEWER, []],
    ] as const) {
      const m = mountTable([schedule('a')], viewer)
      expect(m.buttons('a')).toEqual(expected)
      m.app.unmount()
    }
  })

  test('a disabled schedule offers Enable, shows "-" for next fire and its reason (Review Focus 3)', () => {
    const m = mountTable([schedule('a', { enabled: false, nextFireAt: null, disabledReason: null })], OWNER)
    expect(m.buttons('a')[0]).toBe('fleet-schedule-enable')
    expect(m.row('a')?.props['data-enabled']).toBe('false')
    const status = m.app.find('[data-stub="badge"]').find((b) => b.props['data-testid'] === 'fleet-schedule-status')
    expect(status?.props['data-status']).toBe('manual')
    expect(status && m.app.textOf(status).trim()).toBe('Disabled')
    const nextFire = m.app.find('[data-stub="td"]').find((c) => c.props['data-testid'] === 'fleet-schedule-next-fire')
    expect(nextFire && m.app.textOf(nextFire).trim()).toBe('-')
    m.app.unmount()
  })

  test('names the repo, the owner, a former owner, and links the name to the detail page', () => {
    const m = mountTable([schedule('a'), schedule('b', { createdById: 'gone', repoId: 'r-gone' })], ADMIN)
    const text = m.app.text()
    expect(text).toContain('acme/app')
    expect(text).toContain('Olive')
    expect(text).toContain('Former member')
    expect(text).toContain('r-gone')
    const link = m.app.find('[data-stub="nuxt-link"]').find((l) => l.props['data-testid'] === 'fleet-schedule-link')
    expect(link?.props.to).toBe('/koda/fleet/schedules/a')
    m.app.unmount()
  })

  test('buttons emit toggle with the target state, edit and remove with the row', () => {
    const m = mountTable([schedule('a')], OWNER)
    const r = m.row('a')
    if (!r) throw new Error('row a was not rendered')
    const click = (testid: string): void => {
      const b = m.app.find('[data-stub="button"]', r).find((x) => x.props['data-testid'] === testid)
      ;(b?.props.onClick as () => void)()
    }
    click('fleet-schedule-disable')
    click('fleet-schedule-edit')
    click('fleet-schedule-delete')
    expect(m.app.emitted('toggle')[0]?.[1]).toBe(false)
    expect((m.app.emitted('edit')[0]?.[0] as ScheduleDto).id).toBe('a')
    expect((m.app.emitted('remove')[0]?.[0] as ScheduleDto).id).toBe('a')
    m.app.unmount()
  })
})
