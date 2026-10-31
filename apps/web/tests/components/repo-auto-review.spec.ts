import { describe, test, expect, jest } from '@jest/globals'
import * as Vue from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { uiStubs } from '../helpers/fleet-harness'
import { ref } from 'vue'
import enLocale from '../../i18n/locales/en.json'
import zhLocale from '../../i18n/locales/zh.json'
import type { FleetRepo } from '../../lib/fleet-types'

const repo = (over: Partial<FleetRepo> = {}): FleetRepo => ({
  id: 'r1', projectId: 'p', provider: 'github', owner: 'org', name: 'repo', defaultBranch: 'main',
  githubInstallationId: '7', autoReview: false, autoReviewProfiles: [], autoReviewMaxCostUsd: '1.0000',
  autoReviewEnabledById: null, autoReviewEnabledByType: null, autoReviewEnabledAt: null, createdAt: '', ...over,
})
const mounted = (options: { saved?: boolean; permitted?: boolean; fail?: unknown; current?: FleetRepo } = {}) => {
  const patch = jest.fn(async () => { if (options.fail) throw options.fail; return options.saved ? { ...repo(), autoReview: true } : { permissionKey: 'fleet.repo.review.configure' } })
  const api = { patch }
  const app = mountSfc(webFile('components', 'fleet', 'RepoAutoReview.vue'), {
    components: uiStubs, props: { repo: options.current ?? repo() },
    globals: {
      ref, computed: Vue.computed, useI18n: () => ({ t: (key: string) => key }),
      useGlobalPermissions: () => ({ permissions: { value: { has: () => options.permitted ?? true } } }),
      useApi: () => ({ $api: api }),
    },
    alias: { '~/composables/useApi': { extractApiError: (err: unknown) => err instanceof Error ? err.message : 'API error' } },
  })
  return { app, patch }
}

describe('FleetRepoAutoReview', () => {
  test('English and Chinese define the same auto-review keys (AC-13)', () => {
    const en = (enLocale as Record<string, unknown>).fleet as Record<string, unknown>
    const zh = (zhLocale as Record<string, unknown>).fleet as Record<string, unknown>
    const enKeys = Object.keys(en.repos && (en.repos as Record<string, unknown>).autoReview as Record<string, unknown>).sort()
    const zhKeys = Object.keys(zh.repos && (zh.repos as Record<string, unknown>).autoReview as Record<string, unknown>).sort()
    expect(enKeys.length).toBeGreaterThan(0)
    expect(zhKeys).toEqual(enKeys)
  })
  test('lists stored profiles when enabled (AC-4)', () => {
    const { app } = mounted({ current: repo({ autoReview: true, autoReviewProfiles: ['native-ds', 'review'] }) })
    expect(app.text()).toContain('native-ds'); expect(app.text()).toContain('review'); app.unmount()
  })
  test('switch is permission-disabled and enabled repo edit opens settings (AC-3, AC-7)', async () => {
    const { app } = mounted({ permitted: false })
    expect(app.one('[data-stub="switch"]')?.props.disabled).toBe(true); app.unmount()
    const edit = mounted({ current: repo({ autoReview: true, autoReviewProfiles: ['native-ds'], autoReviewMaxCostUsd: '2.5000' }) })
    const button = edit.app.find('[data-stub="button"]')[0]
    ;(button.props.onClick as () => void)(); await Vue.nextTick()
    expect(edit.app.text()).toContain('fleet.repos.autoReview.title')
    edit.app.unmount()
  })
  test('enable gesture opens dialog without patching; pending off retains persisted checked prop and notice (AC-11)', async () => {
    const enabling = mounted()
    ;(enabling.app.one('[data-stub="switch"]')?.props['onUpdate:checked'] as (v: boolean) => void)(true); await Vue.nextTick()
    expect(enabling.app.text()).toContain('fleet.repos.autoReview.title'); expect(enabling.patch).not.toHaveBeenCalled(); enabling.app.unmount()
    const onRepo = repo({ autoReview: true })
    const pending = mounted({ current: onRepo })
    await (pending.app.one('[data-stub="switch"]')?.props['onUpdate:checked'] as (v: boolean) => Promise<void>)(false)
    await Vue.nextTick()
    expect(pending.patch).toHaveBeenCalledWith('/fleet/repos/r1/auto-review', { enabled: false })
    expect(pending.app.one('[data-stub="switch"]')?.props.checked).toBe(true)
    expect(pending.app.text()).toContain('fleet.repos.autoReview.pending'); pending.app.unmount()
  })
  test('switch-off API refusal is visible outside dialog (AC-12)', async () => {
    const { app } = mounted({ current: repo({ autoReview: true }), fail: new Error('denied by policy') })
    await (app.one('[data-stub="switch"]')?.props['onUpdate:checked'] as (v: boolean) => Promise<void>)(false); await Vue.nextTick()
    expect(app.text()).toContain('denied by policy'); expect(app.find('[role="alert"]')).toHaveLength(1); app.unmount()
  })
})
