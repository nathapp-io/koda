import { describe, expect, test } from '@jest/globals'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'
import type { CredentialBoard } from '~/lib/fleet-credential-board'

const file = (name: string): string => webFile('components', 'fleet', 'credentials', name)
const mount = (name: string, board: CredentialBoard) =>
  mountSfc(file(name), { props: { board }, components: uiStubs, globals: { useI18n: () => enI18n() } })
const byId = (app: ReturnType<typeof mountSfc>, id: string) => app.find(`[data-testid="${id}"]`)

const BOARD: CredentialBoard = {
  generatedAt: '2026-10-07T00:00:00.000Z',
  warnDays: 7,
  runners: [
    { id: 'r1', name: 'wk-mac', enabled: true, online: true, readable: true },
    { id: 'r2', name: 'old-box', enabled: true, online: false, readable: true },
    { id: 'r3', name: 'broken', enabled: false, online: true, readable: false },
  ],
  providers: [
    { providerId: 'claude', cells: { r1: { state: 'expiring', kind: 'oauth', expires: '2026-10-09T00:00:00.000Z' }, r2: { state: 'missing', kind: 'none' } } },
  ],
  profiles: [
    { name: 'fast', runners: { r1: { present: true, needs: { protocol: 'native', providers: ['claude'], sandbox: true } }, r2: { present: true, needs: { protocol: 'native', providers: ['claude'], sandbox: true }, misfit: 'provider_missing' } } },
  ],
}

describe('FleetCredentialsCredentialGrid (S3 §6)', () => {
  test('one header per runner, offline or disabled dimmed, unreadable runners marked', () => {
    const app = mount('CredentialGrid.vue', BOARD)
    expect(byId(app, 'fleet-credentials-runner-head').map((n) => [n.props['data-runner'], n.props['data-dimmed']]))
      .toEqual([['r1', 'false'], ['r2', 'true'], ['r3', 'true']])
    expect(app.text()).toContain('Capabilities unreadable')
  })

  test('a cell per provider and readable runner with state, kind and expiry date', () => {
    const app = mount('CredentialGrid.vue', BOARD)
    const cells = byId(app, 'fleet-credentials-cell')
    expect(cells.map((n) => [n.props['data-provider'], n.props['data-runner'], n.props['data-state']]))
      .toEqual([['claude', 'r1', 'expiring'], ['claude', 'r2', 'missing'], ['claude', 'r3', 'none']])
    const first = app.textOf(cells[0])
    expect(first).toContain('Expiring')
    expect(first).toContain('until 2026-10-09')
    expect(app.textOf(cells[2])).toBe('-')
  })
})

describe('FleetCredentialsProfileInventory (S3 §6)', () => {
  test('a row per profile with its needs and a cell per runner showing ready, misfit or unknown', () => {
    const app = mount('ProfileInventory.vue', BOARD)
    expect(byId(app, 'fleet-credentials-profile-row').map((n) => n.props['data-profile'])).toEqual(['fast'])
    expect(app.text()).toContain('native · claude')
    const cells = byId(app, 'fleet-credentials-profile-cell')
    expect(cells.map((n) => [n.props['data-runner'], n.props['data-misfit']])).toEqual([['r1', ''], ['r2', 'provider_missing'], ['r3', '']])
    expect(cells.map((n) => app.textOf(n))).toEqual(['Ready', expect.any(String), 'Unknown'])
    expect(app.textOf(cells[1])).not.toBe('Ready')
  })
})
