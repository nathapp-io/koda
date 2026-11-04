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
  autoReviewEnabledById: null, autoReviewEnabledByType: null, autoReviewEnabledAt: null,
  fixTrustDetectedChecks: false, fixAllowUnprotected: false, createdAt: '', ...over,
})

function mounted(options: { permitted?: boolean; outcome?: 'saved' | 'pending'; fail?: unknown; current?: FleetRepo } = {}) {
  const saved = { ...repo(), fixAllowUnprotected: true }
  const patch = jest.fn(async () => {
    if (options.fail) throw options.fail
    return options.outcome === 'saved' ? { kind: 'saved', repo: saved } : { kind: 'pending', request: { id: 'ap1' } }
  })
  const app = mountSfc(webFile('components', 'fleet', 'RepoFixUnprotected.vue'), {
    components: uiStubs, props: { repo: options.current ?? repo() },
    globals: {
      ref, computed: Vue.computed, useI18n: () => ({ t: (key: string) => key }),
      useGlobalPermissions: () => ({ permissions: { value: { has: () => options.permitted ?? true } } }),
    },
    alias: {
      '~/composables/useApi': { extractApiError: (err: unknown) => err instanceof Error ? err.message : 'API error' },
      '~/composables/useFleetRepos': { useFleetRepos: () => ({ setFixUnprotected: patch }) },
    },
  })
  return { app, patch, saved }
}

describe('FleetRepoFixUnprotected', () => {
  test('renders checked state from repo and always shows hint', () => {
    const on = mounted({ current: repo({ fixAllowUnprotected: true }) })
    expect(on.app.one('[data-stub="switch"]')?.props.checked).toBe(true)
    expect(on.app.one('[data-stub="switch"]')?.props['aria-label']).toBe('fleet.repos.fixUnprotected.toggle')
    expect(on.app.text()).toContain('fleet.repos.fixUnprotected.hint')
    on.app.unmount()
    const off = mounted()
    expect(off.app.one('[data-stub="switch"]')?.props.checked).toBe(false)
    expect(off.app.text()).toContain('fleet.repos.fixUnprotected.hint')
    off.app.unmount()
  })

  test('permission gate disables switch; saved toggle emits updated repo', async () => {
    const denied = mounted({ permitted: false })
    expect(denied.app.one('[data-stub="switch"]')?.props.disabled).toBe(true)
    denied.app.unmount()
    const saved = mounted({ outcome: 'saved' })
    await (saved.app.one('[data-stub="switch"]')?.props['onUpdate:checked'] as (v: boolean) => Promise<void>)(true)
    await Vue.nextTick()
    expect(saved.patch).toHaveBeenCalledWith('r1', { allowUnprotected: true })
    expect(saved.app.emitted('saved')).toEqual([[saved.saved]])
    saved.app.unmount()
  })

  test('pending toggle shows notice without emitting; failures render alert text', async () => {
    const pending = mounted()
    await (pending.app.one('[data-stub="switch"]')?.props['onUpdate:checked'] as (v: boolean) => Promise<void>)(true)
    await Vue.nextTick()
    expect(pending.app.text()).toContain('fleet.repos.fixUnprotected.pending')
    expect(pending.app.emitted('saved')).toEqual([])
    pending.app.unmount()
    const failed = mounted({ fail: new Error('denied by policy') })
    await (failed.app.one('[data-stub="switch"]')?.props['onUpdate:checked'] as (v: boolean) => Promise<void>)(true)
    await Vue.nextTick()
    expect(failed.app.one('[role="alert"]')).toBeDefined()
    expect(failed.app.text()).toContain('denied by policy')
    failed.app.unmount()
  })

  test('fix-unprotected keys have non-empty English and Chinese translations', () => {
    for (const locale of [enLocale, zhLocale]) {
      const keys = (locale as { fleet: { repos: { fixUnprotected: Record<string, string> } } }).fleet.repos.fixUnprotected
      for (const key of ['toggle', 'pending', 'hint']) expect(keys[key].trim().length).toBeGreaterThan(0)
    }
  })
})
