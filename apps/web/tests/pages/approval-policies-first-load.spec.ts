/**
 * web-ssr-data-loading US-002 (R2-15): the approval-policy pages show their loading state until the
 * first load has finished or failed, whatever `pending` says.
 *
 * On the server the permission watcher runs while permissions are still pending, so no load starts and
 * `pending` stays false; on the hydrating client the load has just started. Both must render the
 * loading branch, so the stubbed `useApprovalPolicies` here reports `pending` false while its first
 * `list` never resolves: the server's state.
 */
import { describe, test, expect, jest } from '@jest/globals'
import { computed, ref } from 'vue'
import { mountSfc, webFile, type Mounted } from '../helpers/mount-sfc'
import { uiStubs, enI18n, enLocale } from '../helpers/fleet-harness'
import * as apiModule from '../../composables/useApi'
import { ApiError } from '../../composables/useApi'
import { permissionSet } from '../../lib/permissions'
import { useRoles } from '../../composables/useRoles'
import { useProjectRoles } from '../../composables/useProjectRoles'

type Page = 'admin' | 'project'
const pagePath = (page: Page): string =>
  page === 'admin' ? webFile('pages', 'admin', 'approval-policies.vue') : webFile('pages', '[project]', 'approval-policies.vue')

/** `list` outcome for the first load: never settles, resolves, or rejects with the given error. */
type FirstLoad = { kind: 'hang' } | { kind: 'empty' } | { kind: 'reject'; error: unknown }

function policiesStub(first: FirstLoad) {
  const policies = ref<unknown[]>([])
  const keys = ref<unknown[]>([])
  const list = jest.fn(async () => {
    if (first.kind === 'hang') return new Promise<never>(() => undefined)
    if (first.kind === 'reject') throw first.error
    policies.value = []
    return []
  })
  return {
    useApprovalPolicies: () => ({
      policies,
      keys,
      pending: ref(false),
      list,
      loadKeys: async () => [],
      create: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
    }),
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
}

async function mountPage(page: Page, first: FirstLoad): Promise<Mounted> {
  (globalThis as Record<string, unknown>).useApi = () => ({ $api: { get: jest.fn(async () => ({ records: [] })) } })
  const held = permissionSet(page === 'admin' ? ['approval.policy.manage', 'role.read'] : ['approval.policy.read', 'approval.policy.manage', 'member.read'])
  const app = mountSfc(pagePath(page), {
    components: uiStubs,
    alias: { '~/composables/useApi': apiModule, '~/composables/useApprovalPolicies': policiesStub(first) },
    globals: {
      useI18n: () => enI18n(),
      useAppToast: () => ({ error: jest.fn(), success: jest.fn() }),
      useGlobalPermissions: () => ({ permissions: computed(() => held) }),
      useProjectPermissions: () => ({ permissions: computed(() => held) }),
      useRoute: () => ({ params: { project: 'sandbox' } }),
      useRoles,
      useProjectRoles,
    },
  })
  await settle()
  return app
}

const copy = (key: string): string =>
  key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], enLocale) as string
const loading = (app: Mounted): boolean => app.find('[data-stub="loading-state"]').length > 0
const has = (app: Mounted, id: string): boolean => app.find(`[data-testid="${id}"]`).length > 0
const emptyList = (app: Mounted): boolean =>
  app.find('[data-stub="empty-state"]').some((node) => node.props.message === copy('approvals.policies.list.empty'))
const incompleteError = (): Error => Object.assign(new Error('short list'), { code: 'incompletePolicyList' })

describe('US-002: /admin/approval-policies first load', () => {
  test('AC-1: before the first load completes, with pending false, the page shows LoadingState, not the empty list', async () => {
    const app = await mountPage('admin', { kind: 'hang' })
    expect(loading(app)).toBe(true)
    expect(emptyList(app)).toBe(false)
    app.unmount()
  })

  test('AC-2 (regression guard): a failed first load shows retry, not LoadingState', async () => {
    const app = await mountPage('admin', { kind: 'reject', error: new ApiError(500, 'boom') })
    expect(has(app, 'policies-retry')).toBe(true)
    expect(loading(app)).toBe(false)
    app.unmount()
  })

  test('AC-3: a 403 on the first load shows the forbidden message, neither LoadingState nor retry', async () => {
    const app = await mountPage('admin', { kind: 'reject', error: new ApiError(403, 'forbidden') })
    expect(has(app, 'policies-forbidden')).toBe(true)
    expect(loading(app)).toBe(false)
    expect(has(app, 'policies-retry')).toBe(false)
    app.unmount()
  })

  test('AC-4 (regression guard): an empty first load shows the empty list, not LoadingState', async () => {
    const app = await mountPage('admin', { kind: 'empty' })
    expect(emptyList(app)).toBe(true)
    expect(loading(app)).toBe(false)
    app.unmount()
  })

  test('AC-5: an incomplete first load shows the incomplete state, not LoadingState', async () => {
    const app = await mountPage('admin', { kind: 'reject', error: incompleteError() })
    expect(has(app, 'policies-incomplete')).toBe(true)
    expect(loading(app)).toBe(false)
    app.unmount()
  })
})

describe('US-002: /<project>/approval-policies first load', () => {
  test('AC-6: before the first load completes, with pending false, the page shows LoadingState, not the empty list', async () => {
    const app = await mountPage('project', { kind: 'hang' })
    expect(loading(app)).toBe(true)
    expect(emptyList(app)).toBe(false)
    app.unmount()
  })

  test('AC-7 (regression guard): a failed first load shows retry, not LoadingState', async () => {
    const app = await mountPage('project', { kind: 'reject', error: new ApiError(500, 'boom') })
    expect(has(app, 'policies-retry')).toBe(true)
    expect(loading(app)).toBe(false)
    app.unmount()
  })

  test('AC-8: a 403 on the first load shows the forbidden message, neither LoadingState nor retry', async () => {
    const app = await mountPage('project', { kind: 'reject', error: new ApiError(403, 'forbidden') })
    expect(has(app, 'policies-forbidden')).toBe(true)
    expect(loading(app)).toBe(false)
    expect(has(app, 'policies-retry')).toBe(false)
    app.unmount()
  })
})
