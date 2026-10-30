import { describe, test, expect, beforeEach, jest } from '@jest/globals'
import { computed } from 'vue'
import { mountSfc, webFile, type Mounted, type FakeNode } from '../helpers/mount-sfc'
import { uiStubs, enI18n, enLocale } from '../helpers/fleet-harness'
import { allById, byId, call, typeInto } from '../helpers/roles-dom'
import { permissionSet } from '../../lib/permissions'
import * as apiModule from '../../composables/useApi'
import * as policiesModule from '../../composables/useApprovalPolicies'
import { useProjectRoles } from '../../composables/useProjectRoles'
import { ApiError, extractApiError } from '../../composables/useApi'
import type { ApprovalPolicy, ApprovableKey } from '../../lib/approval-policies'

const pagePath = webFile('pages', '[project]', 'approval-policies.vue')
const APPROVABLE: ApprovableKey[] = [
  { key: 'label.create', scope: 'project', risk: 'low', floor: 'none', default: 'none' },
  { key: 'label.update', scope: 'project', risk: 'low', floor: 'none', default: 'none' },
]
function policy(over: Partial<ApprovalPolicy> = {}): ApprovalPolicy {
  return {
    id: 'pol1', selector: '*|label.create|all', projectId: 'project-1', permissionPattern: 'label.create',
    principalType: null, roleId: null, principalId: null, mode: 'human', timeoutSec: 120, onTimeout: 'reject',
    requiredApprovals: 1, approverMustHoldAction: false, requireDistinctApprover: false,
    updatedByType: 'USER', updatedById: 'u1', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', ...over,
  }
}
const GLOBAL = policy({ id: 'global', projectId: null, permissionPattern: 'label.*' })
const PROJECT = policy()
interface FakeApi { get: jest.Mock; post: jest.Mock; patch: jest.Mock; delete: jest.Mock }
function fakeApi(over: Partial<FakeApi> = {}): FakeApi {
  return {
    get: jest.fn(async (path: string) => {
      if (path.endsWith('/keys')) return { keys: APPROVABLE }
      if (path.endsWith('/roles')) return [{ id: 'r1', key: 'dev', name: 'Developer', description: '', system: true }]
      return { total: 2, current: 1, size: 100, hasNext: false, hasPrev: false, records: [GLOBAL, PROJECT] }
    }) as jest.Mock,
    post: jest.fn(async (_path: string, body: Record<string, unknown>) => policy({ id: 'new', ...body })) as jest.Mock,
    patch: jest.fn(async (path: string, body: Record<string, unknown>) => policy({ id: path.split('/').pop(), ...body })) as jest.Mock,
    delete: jest.fn(async () => undefined) as jest.Mock,
    ...over,
  }
}
interface MountedPage { app: Mounted; api: FakeApi; toast: { error: jest.Mock; success: jest.Mock }; confirm: jest.Mock }
async function mountPage(options: { keys?: string[]; api?: Partial<FakeApi>; confirm?: boolean } = {}): Promise<MountedPage> {
  const api = fakeApi(options.api)
  const toast = { error: jest.fn(), success: jest.fn() }
  const confirm = jest.fn(() => options.confirm ?? true)
  ;(globalThis as Record<string, unknown>).window = { confirm }
  ;(globalThis as Record<string, unknown>).useApi = () => ({ $api: api })
  const held = permissionSet(options.keys ?? ['approval.policy.read', 'approval.policy.manage', 'member.read'])
  const app = mountSfc(pagePath, {
    components: uiStubs,
    alias: { '~/composables/useApi': apiModule, '~/composables/useApprovalPolicies': policiesModule },
    globals: {
      useI18n: () => enI18n(), useAppToast: () => toast,
      useRoute: () => ({ params: { project: 'sandbox' } }),
      useProjectPermissions: () => ({ permissions: computed(() => held) }),
      useProjectRoles,
    },
  })
  await settle()
  return { app, api, toast, confirm }
}
async function settle(): Promise<void> {
  for (let i = 0; i < 12; i += 1) { await new Promise<void>((resolve) => setTimeout(resolve, 0)); await new Promise<void>((resolve) => setTimeout(resolve, 0)) }
}
const copy = (key: string): string => {
  const value = key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], enLocale)
  expect(typeof value).toBe('string'); return value as string
}
const rowFor = (app: Mounted, id: string): FakeNode => allById(app, 'policy-row').find((row) => row.props['data-id'] === id) as FakeNode
async function openCreate(app: Mounted): Promise<void> { call(byId(app, 'policy-create'), 'onClick'); await settle() }
async function submitForm(app: Mounted): Promise<void> { call(byId(app, 'policy-form'), 'onSubmit'); await settle() }

describe('project approval policies', () => {
  beforeEach(() => { (globalThis as Record<string, unknown>).useApi = undefined })

  test('AC-1: with read permission loads project keys and policies', async () => {
    const m = await mountPage({ keys: ['approval.policy.read'] })
    expect(m.api.get).toHaveBeenCalledWith('/projects/sandbox/approval-policies/keys')
    expect(m.api.get).toHaveBeenCalledWith('/projects/sandbox/approval-policies', { query: { size: '100' } })
  })

  test('AC-2: without read permission displays forbidden and requests nothing', async () => {
    const m = await mountPage({ keys: ['approval.policy.manage'] })
    expect(m.app.text()).toContain(copy('approvals.policies.forbidden'))
    expect(m.api.get).not.toHaveBeenCalled()
  })

  test('AC-3: global policy appears inherited and is read-only', async () => {
    const m = await mountPage()
    expect(m.app.text()).toContain(copy('approvals.policies.project.inherited'))
    expect(allById(m.app, 'policy-edit', rowFor(m.app, 'global'))).toHaveLength(0)
    expect(allById(m.app, 'policy-delete', rowFor(m.app, 'global'))).toHaveLength(0)
    expect(allById(m.app, 'policy-edit', rowFor(m.app, 'pol1'))).toHaveLength(1)
  })

  test('AC-4: without manage permission create is hidden', async () => {
    const m = await mountPage({ keys: ['approval.policy.read'] })
    expect(allById(m.app, 'policy-create')).toHaveLength(0)
  })

  test('AC-5: create posts to project policy route', async () => {
    const m = await mountPage()
    await openCreate(m.app)
    typeInto(byId(m.app, 'policy-pattern'), 'label.create')
    await submitForm(m.app)
    expect(m.api.post).toHaveBeenCalledWith('/projects/sandbox/approval-policies', expect.objectContaining({ permissionPattern: 'label.create' }))
  })

  test('AC-6: edit patches only mutable fields at project policy route', async () => {
    const m = await mountPage()
    call(byId(m.app, 'policy-edit', rowFor(m.app, 'pol1')), 'onClick')
    await settle(); await submitForm(m.app)
    expect(m.api.patch).toHaveBeenCalledWith('/projects/sandbox/approval-policies/pol1', expect.objectContaining({ mode: 'human' }))
    const body = (m.api.patch.mock.calls[0] as [string, Record<string, unknown>])[1]
    expect(body).not.toHaveProperty('permissionPattern')
    expect(body).not.toHaveProperty('appliesTo')
  })

  test('AC-7: confirming delete uses project policy route', async () => {
    const m = await mountPage()
    call(byId(m.app, 'policy-delete', rowFor(m.app, 'pol1')), 'onClick'); await settle()
    expect(m.api.delete).toHaveBeenCalledWith('/projects/sandbox/approval-policies/pol1')
  })

  test('AC-8: member.read exposes project roles in the role picker', async () => {
    const m = await mountPage()
    await openCreate(m.app)
    expect(m.api.get).toHaveBeenCalledWith('/projects/sandbox/roles')
    call(byId(m.app, 'policy-subject-kind'), 'onChange', { target: { value: 'role' } }); await settle()
    expect(m.app.find('option', byId(m.app, 'policy-role')).some((option) => option.props.value === 'r1')).toBe(true)
  })

  test('AC-9: override count combines inherited global and project policies', async () => {
    const m = await mountPage()
    const row = allById(m.app, 'approvable-key-row').find((node) => node.props['data-key'] === 'label.create') as FakeNode
    expect(m.app.textOf(byId(m.app, 'key-override-count', row))).toBe('2')
  })

  test('AC-10: a 403 during project page load shows forbidden', async () => {
    const m = await mountPage({ api: { get: jest.fn(async () => { throw new ApiError(40003, 'forbidden') }) as jest.Mock } })
    expect(m.app.text()).toContain(copy('approvals.policies.forbidden'))
  })

  test('role list failure omits role kind and surfaced write refusals keep the dialog open', async () => {
    const err = new ApiError(40000, 'refused')
    const m = await mountPage({ api: {
      get: jest.fn(async (path: string) => { if (path.endsWith('/roles')) throw new ApiError(50000, 'down'); if (path.endsWith('/keys')) return { keys: APPROVABLE }; return { records: [GLOBAL, PROJECT], hasNext: false } }) as jest.Mock,
      post: jest.fn(async () => { throw err }) as jest.Mock,
    } })
    await openCreate(m.app)
    expect(m.app.find('option', byId(m.app, 'policy-subject-kind')).map((option) => option.props.value)).toEqual(['all', 'type'])
    typeInto(byId(m.app, 'policy-pattern'), 'label.create'); await submitForm(m.app)
    expect(m.toast.error).toHaveBeenCalledWith(extractApiError(err))
    expect(allById(m.app, 'policy-form')).toHaveLength(1)
  })
})
