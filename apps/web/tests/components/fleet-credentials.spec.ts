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
  kodaKeys: [{ providerId: 'claude', name: 'Team key', last4: 'abcd', updatedAt: '2026-10-06T00:00:00.000Z' }],
  runners: [
    { id: 'r1', name: 'wk-mac', enabled: true, online: true, readable: true, providerVault: true },
    { id: 'r2', name: 'old-box', enabled: true, online: false, readable: true, providerVault: false },
    { id: 'r3', name: 'broken', enabled: false, online: true, readable: false, providerVault: false },
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

describe('FleetCredentialsCredentialGrid — koda column and vault state (US-012)', () => {
  const rowFor = (app: ReturnType<typeof mountSfc>, providerId: string) => {
    const row = app.find('[data-testid="fleet-credentials-row"]').find((n) => n.props['data-provider'] === providerId)
    if (!row) throw new Error(`no row for ${providerId} in: ${app.text()}`)
    return row
  }

  test('AC-12: a koda column carries the key name and last4 on its provider row, and dashes elsewhere', () => {
    const app = mount('CredentialGrid.vue', {
      ...BOARD,
      kodaKeys: [{ providerId: 'claude', name: 'Team key', last4: 'abcd', updatedAt: '2026-10-06T00:00:00.000Z' }],
      providers: [...BOARD.providers, { providerId: 'openrouter', cells: {} }],
    })

    expect(app.textOf(byId(app, 'fleet-credentials-koda-head')[0])).toBe('Koda keys')
    const koda = app.find('[data-testid="fleet-credentials-koda"]', rowFor(app, 'claude'))
    expect(app.textOf(koda[0])).toBe('Team key · abcd')
    const empty = app.find('[data-testid="fleet-credentials-koda"]', rowFor(app, 'openrouter'))
    expect(app.textOf(empty[0])).toBe('-')
    app.unmount()
  })

  test('AC-13: a runner without the vault helper is marked vault off; a providerVault runner is not', () => {
    const app = mount('CredentialGrid.vue', BOARD)

    const head = (id: string) => {
      const found = byId(app, 'fleet-credentials-runner-head').find((n) => n.props['data-runner'] === id)
      if (!found) throw new Error(`no head for ${id} in: ${app.text()}`)
      return found
    }
    expect(app.find('[data-testid="fleet-credentials-vault-off"]', head('r1'))).toHaveLength(0)
    expect(app.textOf(byId(app, 'fleet-credentials-vault-off')[0])).toBe('Vault off')
    expect(app.find('[data-testid="fleet-credentials-vault-off"]', head('r2'))).toHaveLength(1)
    app.unmount()
  })

  test('AC-14: runner cells keep their labels — a missing cell reads Missing with koda keys present', () => {
    const app = mount('CredentialGrid.vue', BOARD)

    const cell = app.find('[data-testid="fleet-credentials-cell"]', rowFor(app, 'claude'))
      .find((n) => n.props['data-runner'] === 'r2')
    if (!cell) throw new Error(`no r2 cell in: ${app.text()}`)
    expect(cell.props['data-state']).toBe('missing')
    expect(app.textOf(cell)).toBe('Missing')
    app.unmount()
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
