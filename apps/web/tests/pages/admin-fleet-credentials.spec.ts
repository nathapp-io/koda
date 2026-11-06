import { describe, expect, jest, test } from '@jest/globals'
import * as Vue from 'vue'
import { computed, ref, shallowRef } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'
import * as apiModule from '../../composables/useApi'
import { ApiError } from '../../composables/useApi'
import type { CredentialBoard } from '~/lib/fleet-credential-board'

const page = webFile('pages', 'admin', 'fleet', 'credentials.vue')
const BOARD: CredentialBoard = {
  generatedAt: '2026-10-07T00:00:00.000Z', warnDays: 7,
  kodaKeys: [],
  runners: [{ id: 'r1', name: 'wk-mac', enabled: true, online: true, readable: true, providerVault: true }],
  providers: [{ providerId: 'claude', cells: { r1: { state: 'ok', kind: 'oauth' } } }],
  profiles: [{ name: 'fast', runners: { r1: { present: true, needs: { protocol: 'native', providers: ['claude'], sandbox: false } } } }],
}

type Get = jest.Mock<(path: string) => Promise<unknown>>

function mountPage(get: Get) {
  const app = mountSfc(page, {
    components: uiStubs,
    fleetComponents: ['FleetCredentialsCredentialGrid', 'FleetCredentialsProfileInventory'],
    alias: { '~/composables/useApi': apiModule },
    globals: {
      ref, computed, shallowRef, onMounted: Vue.onMounted,
      useI18n: () => enI18n(),
      useApi: () => ({ $api: { get } }),
      definePageMeta: () => undefined,
    },
  })
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 6; i += 1) {
      await new Promise((resolve) => { setImmediate(resolve) })
      await Vue.nextTick()
    }
  }
  return { app, settle, byId: (id: string) => app.find(`[data-testid="${id}"]`) }
}

describe('admin credential board page (S3 §6)', () => {
  test('loads the board on mount and renders both tabs', async () => {
    const get: Get = jest.fn(async () => BOARD)
    const p = mountPage(get)
    await p.settle()
    expect(get.mock.calls.map(([path]) => path)).toEqual(['/fleet/credential-board'])
    expect(p.app.find('[data-stub="page-header"]')[0].props.title).toBe('Credential board')
    expect(p.byId('fleet-credentials-grid')).toHaveLength(1)
    expect(p.byId('fleet-credentials-profiles')).toHaveLength(1)
    expect(p.byId('fleet-credentials-tab-grid')).toHaveLength(1)
    expect(p.byId('fleet-credentials-tab-profiles')).toHaveLength(1)
  })

  test('Refresh reloads', async () => {
    const get: Get = jest.fn(async () => BOARD)
    const p = mountPage(get)
    await p.settle()
    ;(p.byId('fleet-credentials-refresh')[0].props.onClick as () => void)()
    await p.settle()
    expect(get).toHaveBeenCalledTimes(2)
  })

  test.each([40003, 403])('a %s shows the admin-only note and no board', async (code) => {
    const p = mountPage(jest.fn(async () => { throw new ApiError(code, 'forbidden') }) as Get)
    await p.settle()
    expect(p.app.textOf(p.byId('fleet-credentials-forbidden')[0])).toBe('Only global administrators can manage the fleet.')
    expect(p.byId('fleet-credentials-grid')).toHaveLength(0)
  })
})

/** C10 US-012: the koda column and the vault marker, rendered by the real grid on the page. */
describe('admin credential board page — koda keys and runner vault state (US-012)', () => {
  const KODA_BOARD: CredentialBoard = {
    generatedAt: '2026-10-07T00:00:00.000Z', warnDays: 7,
    kodaKeys: [
      { providerId: 'openrouter', name: 'Team key', last4: 'abcd', updatedAt: '2026-10-06T00:00:00.000Z' },
      { providerId: 'anthropic', name: 'Billing A', last4: 'wxyz', updatedAt: '2026-10-05T00:00:00.000Z' },
    ],
    runners: [
      { id: 'r1', name: 'wk-mac', enabled: true, online: true, readable: true, providerVault: false },
      { id: 'r2', name: 'vault-box', enabled: true, online: true, readable: true, providerVault: true },
    ],
    providers: [
      { providerId: 'anthropic', cells: { r1: { state: 'missing', kind: 'none' } } },
      { providerId: 'openrouter', cells: { r1: { state: 'ok', kind: 'api-key' } } },
    ],
    profiles: [],
  }

  const rowFor = (app: ReturnType<typeof mountPage>['app'], providerId: string): NonNullable<ReturnType<typeof app.one>> => {
    const row = app.find('[data-testid="fleet-credentials-row"]').find((n) => n.props['data-provider'] === providerId)
    if (!row) throw new Error(`no row for ${providerId} in: ${app.text()}`)
    return row
  }

  test('AC-12: a koda column shows each key name and last4 on its provider row', async () => {
    const p = mountPage(jest.fn(async () => KODA_BOARD) as Get)
    await p.settle()

    const heads = p.app.find('[data-testid="fleet-credentials-koda-head"]')
    expect(heads).toHaveLength(1)
    expect(p.app.textOf(heads[0])).toBe('Koda keys')

    const openrouter = p.app.find('[data-testid="fleet-credentials-koda"]', rowFor(p.app, 'openrouter'))
    expect(p.app.textOf(openrouter[0])).toContain('Team key')
    expect(p.app.textOf(openrouter[0])).toContain('abcd')

    const anthropic = p.app.find('[data-testid="fleet-credentials-koda"]', rowFor(p.app, 'anthropic'))
    expect(p.app.textOf(anthropic[0])).toContain('Billing A')
    expect(p.app.textOf(anthropic[0])).toContain('wxyz')
  })

  test('AC-12: stored GLOBAL keys render even when no runner is enrolled', async () => {
    const p = mountPage(jest.fn(async () => ({ ...KODA_BOARD, runners: [], profiles: [] })) as Get)
    await p.settle()

    expect(p.app.find('[data-testid="fleet-credentials-grid"]')).toHaveLength(1)
    expect(p.app.find('[data-stub="empty-state"]')).toHaveLength(0)
    expect(p.app.text()).toContain('Team key')
    expect(p.app.text()).toContain('abcd')
  })

  test('AC-13: a runner with providerVault false is marked vault off', async () => {
    const p = mountPage(jest.fn(async () => KODA_BOARD) as Get)
    await p.settle()

    const head = (runnerId: string) => {
      const found = p.app.find('[data-testid="fleet-credentials-runner-head"]').find((n) => n.props['data-runner'] === runnerId)
      if (!found) throw new Error(`no head for ${runnerId}`)
      return found
    }
    const off = p.app.find('[data-testid="fleet-credentials-vault-off"]', head('r1'))
    expect(off).toHaveLength(1)
    expect(p.app.textOf(off[0])).toBe('Vault off')
    expect(p.app.textOf(head('r2'))).not.toContain('Vault off')
  })

  test('AC-14: a missing cell still reads Missing beside the koda column', async () => {
    const p = mountPage(jest.fn(async () => KODA_BOARD) as Get)
    await p.settle()

    const cells = p.app.find('[data-testid="fleet-credentials-cell"]', rowFor(p.app, 'anthropic'))
    // One cell per runner, exactly as before the koda column existed.
    expect(cells.map((n) => n.props['data-runner'])).toEqual(['r1', 'r2'])
    const missing = cells[0]
    expect(missing.props['data-state']).toBe('missing')
    expect(p.app.textOf(missing)).toBe('Missing')
    // The koda column did not displace the runner cells: two providers x two runners.
    expect(p.app.find('[data-testid="fleet-credentials-cell"]')).toHaveLength(4)
    expect(p.app.find('[data-testid="fleet-credentials-koda"]')).toHaveLength(2)
  })
})
