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
  runners: [{ id: 'r1', name: 'wk-mac', enabled: true, online: true, readable: true }],
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
