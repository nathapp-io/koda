/**
 * P3b US-008 (AC-8 to AC-15): the global approval policy page, mounted for real over a fake `$api`.
 *
 * The page, its list, its keys table and its dialog all run as they do in the browser; the real
 * `useApprovalPolicies` runs underneath, so every assertion is on the HTTP call the page makes. The
 * project page (US-009) renders the same components over `{ kind: 'project', slug }`.
 */
import { describe, test, expect, beforeEach, jest } from '@jest/globals'
import { computed } from 'vue'
import { mountSfc, webFile, type Mounted, type FakeNode } from '../helpers/mount-sfc'
import { uiStubs, enI18n, enLocale } from '../helpers/fleet-harness'
import { allById, byId, call, typeInto } from '../helpers/roles-dom'
import { permissionSet } from '../../lib/permissions'
import * as apiModule from '../../composables/useApi'
import * as policiesModule from '../../composables/useApprovalPolicies'
import { ApiError, extractApiError } from '../../composables/useApi'
import { useRoles } from '../../composables/useRoles'
import type { Role } from '../../composables/useRoles'
import type { ApprovalPolicy, ApprovableKey } from '../../lib/approval-policies'

const pagePath = webFile('pages', 'admin', 'approval-policies.vue')
const keysTablePath = webFile('components', 'approvals', 'ApprovableKeysTable.vue')

const APPROVABLE: ApprovableKey[] = [
  { key: 'label.create', scope: 'project', risk: 'low', floor: 'none', default: 'none' },
  { key: 'label.update', scope: 'project', risk: 'low', floor: 'none', default: 'none' },
  { key: 'ticket.create', scope: 'project', risk: 'medium', floor: 'self', default: 'none' },
  { key: 'fleet.job.shell.escalate', scope: 'project', risk: 'high', floor: 'human', default: 'none' },
]

function policy(over: Partial<ApprovalPolicy> = {}): ApprovalPolicy {
  return {
    id: 'pol1', selector: '*|label.create|all', projectId: null, permissionPattern: 'label.create',
    principalType: null, roleId: null, principalId: null, mode: 'human', timeoutSec: 120, onTimeout: 'reject',
    requiredApprovals: 1, approverMustHoldAction: false, requireDistinctApprover: false,
    updatedByType: 'USER', updatedById: 'u1',
    createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
    ...over,
  }
}

const POLICIES: ApprovalPolicy[] = [
  policy({ id: 'pol1', permissionPattern: 'label.create' }),
  policy({ id: 'pol2', permissionPattern: 'label.*', mode: 'agent', timeoutSec: null }),
]

const ROLES: Role[] = [{
  id: 'r1', key: 'developer', name: 'Developer', description: '', scope: 'PROJECT',
  system: true, locked: false, permissions: ['ticket.read'], expandedKeys: ['ticket.read'],
}]

interface FakeApi {
  get: jest.Mock
  post: jest.Mock
  patch: jest.Mock
  delete: jest.Mock
}

function fakeApi(over: Partial<FakeApi> = {}): FakeApi {
  return {
    get: jest.fn(async (path: string) => {
      if (path.endsWith('/keys')) return { keys: APPROVABLE }
      if (path === '/roles') return ROLES
      return { total: POLICIES.length, current: 1, size: 100, hasNext: false, hasPrev: false, records: POLICIES }
    }) as jest.Mock,
    post: jest.fn(async (_path: string, body: Record<string, unknown>) => policy({ id: 'new', ...body })) as jest.Mock,
    patch: jest.fn(async (path: string, body: Record<string, unknown>) => policy({ id: path.split('/').pop(), ...body })) as jest.Mock,
    delete: jest.fn(async () => undefined) as jest.Mock,
    ...over,
  }
}

interface Mount { app: Mounted; api: FakeApi; toast: { error: jest.Mock; success: jest.Mock }; confirm: jest.Mock }

async function mountPage(options: { keys?: string[]; api?: Partial<FakeApi>; confirm?: boolean } = {}): Promise<Mount> {
  const api = fakeApi(options.api)
  const toast = { error: jest.fn(), success: jest.fn() }
  const confirm = jest.fn(() => options.confirm ?? true)
  ;(globalThis as Record<string, unknown>).window = { confirm }
  ;(globalThis as Record<string, unknown>).useApi = () => ({ $api: api })
  const held = permissionSet(options.keys ?? ['approval.policy.manage', 'role.read'])
  const app = mountSfc(pagePath, {
    components: uiStubs,
    alias: {
      '~/composables/useApi': apiModule,
      '~/composables/useApprovalPolicies': policiesModule,
    },
    globals: {
      useI18n: () => enI18n(),
      useAppToast: () => toast,
      useGlobalPermissions: () => ({ permissions: computed(() => held) }),
      useRoles,
    },
  })
  await settle()
  return { app, api, toast, confirm }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 12; i += 1) {
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
  }
}

const copy = (key: string): string => {
  const value = key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], enLocale)
  expect(typeof value).toBe('string')
  return value as string
}

const rowFor = (app: Mounted, id: string): FakeNode =>
  allById(app, 'policy-row').find((row) => row.props['data-id'] === id) as FakeNode

async function openCreate(app: Mounted): Promise<void> {
  call(byId(app, 'policy-create'), 'onClick')
  await settle()
}

/** The values of a native `<select>`'s options, in order. */
const optionValues = (app: Mounted, testid: string): unknown[] =>
  app.find('option', byId(app, testid)).map((option) => option.props.value)

async function submitForm(app: Mounted): Promise<void> {
  call(byId(app, 'policy-form'), 'onSubmit')
  await settle()
}

beforeEach(() => { (globalThis as Record<string, unknown>).useApi = undefined })

describe('AC-8: the page loads the keys it needs approval.policy.manage for', () => {
  test('mounting with the key requests GET /approval-policies/keys and lists the policies', async () => {
    const m = await mountPage({ keys: ['approval.policy.manage'] })

    expect(m.api.get).toHaveBeenCalledWith('/approval-policies/keys')
    expect(m.api.get).toHaveBeenCalledWith('/approval-policies', { query: { size: '100' } })
    expect(allById(m.app, 'policy-row')).toHaveLength(2)
    expect(allById(m.app, 'approvable-key-row')).toHaveLength(APPROVABLE.length)
    expect(allById(m.app, 'policy-create')).toHaveLength(1)
  })
})

describe('AC-9: without the key the page asks for nothing', () => {
  test('no manage permission shows the forbidden message and sends no request', async () => {
    const m = await mountPage({ keys: ['role.read'] })

    expect(m.app.text()).toContain(copy('approvals.policies.forbidden'))
    expect(m.api.get).not.toHaveBeenCalled()
    expect(allById(m.app, 'policy-row')).toHaveLength(0)
    expect(allById(m.app, 'policy-create')).toHaveLength(0)
  })

  test('a 403 on the load shows the same message', async () => {
    const m = await mountPage({
      keys: ['approval.policy.manage'],
      api: { get: jest.fn(async () => { throw new ApiError(40003, 'forbidden') }) as jest.Mock },
    })

    expect(m.app.text()).toContain(copy('approvals.policies.forbidden'))
  })
})

describe('AC-10: the keys table counts the overrides of every key', () => {
  test('label.create counts its own policy and the label.* one', async () => {
    const app = mountSfc(keysTablePath, {
      props: { keys: APPROVABLE, policies: POLICIES },
      components: uiStubs,
      globals: { useI18n: () => enI18n() },
    })
    await settle()

    const row = allById(app, 'approvable-key-row').find((node) => node.props['data-key'] === 'label.create') as FakeNode
    expect(app.textOf(byId(app, 'key-override-count', row))).toBe('2')

    const ticket = allById(app, 'approvable-key-row').find((node) => node.props['data-key'] === 'ticket.create') as FakeNode
    expect(app.textOf(byId(app, 'key-override-count', ticket))).toBe('0')
  })
})

describe('AC-11: a create posts exactly what the form chose', () => {
  test('pattern label.create, type AGENT, mode human, blank timeout', async () => {
    const m = await mountPage()

    await openCreate(m.app)
    typeInto(byId(m.app, 'policy-pattern'), 'label.create')
    call(byId(m.app, 'policy-subject-kind'), 'onChange', { target: { value: 'type' } })
    await settle()
    call(byId(m.app, 'policy-principal-type'), 'onChange', { target: { value: 'AGENT' } })
    call(byId(m.app, 'policy-mode'), 'onChange', { target: { value: 'human' } })
    await settle()
    await submitForm(m.app)

    expect(m.api.post).toHaveBeenCalledTimes(1)
    const [path, body] = m.api.post.mock.calls[0] as [string, Record<string, unknown>]
    expect(path).toBe('/approval-policies')
    expect(body).toEqual({
      permissionPattern: 'label.create',
      appliesTo: { kind: 'type', principalType: 'AGENT' },
      mode: 'human',
      onTimeout: 'reject',
    })
    expect(m.toast.success).toHaveBeenCalledTimes(1)
    expect(allById(m.app, 'policy-form')).toHaveLength(0)
  })

  test('a pattern covering no approvable key shows the pattern message and sends nothing', async () => {
    const m = await mountPage()

    await openCreate(m.app)
    typeInto(byId(m.app, 'policy-pattern'), 'nothing.here')
    await settle()

    expect(m.app.text()).toContain(copy('approvals.policies.validation.pattern'))
    expect(byId(m.app, 'policy-save').props.disabled).toBe(true)
    await submitForm(m.app)
    expect(m.api.post).not.toHaveBeenCalled()
  })

  test('the mode options follow the pattern, and a mode below the new floor moves up', async () => {
    const m = await mountPage()

    await openCreate(m.app)
    typeInto(byId(m.app, 'policy-pattern'), 'label.create')
    await settle()
    expect(optionValues(m.app, 'policy-mode')).toEqual(['none', 'self', 'agent', 'human'])

    call(byId(m.app, 'policy-mode'), 'onChange', { target: { value: 'agent' } })
    await settle()
    expect(byId(m.app, 'policy-mode').props.value).toBe('agent')

    // fleet.* is the human-floor shell key: agent is no longer a mode the policy may choose.
    typeInto(byId(m.app, 'policy-pattern'), 'fleet.*')
    await settle()
    expect(optionValues(m.app, 'policy-mode')).toEqual(['human'])
    expect(byId(m.app, 'policy-mode').props.value).toBe('human')
  })
})

describe('AC-12: the role subject kind needs the role read key', () => {
  test('without role.read the dialog offers only all and type, and never asks for roles', async () => {
    const m = await mountPage({ keys: ['approval.policy.manage'] })

    await openCreate(m.app)

    expect(optionValues(m.app, 'policy-subject-kind')).toEqual(['all', 'type'])
    expect(m.api.get).not.toHaveBeenCalledWith('/roles')
  })

  test('with role.read the kind is offered and the roles are loaded', async () => {
    const m = await mountPage({ keys: ['approval.policy.manage', 'role.read'] })

    await openCreate(m.app)

    expect(optionValues(m.app, 'policy-subject-kind')).toEqual(['all', 'type', 'role'])
    expect(m.api.get).toHaveBeenCalledWith('/roles')

    call(byId(m.app, 'policy-subject-kind'), 'onChange', { target: { value: 'role' } })
    await settle()
    expect(optionValues(m.app, 'policy-role')).toEqual(['', 'r1'])
  })

  test('a failed role load removes the kind again', async () => {
    const m = await mountPage({
      keys: ['approval.policy.manage', 'role.read'],
      api: {
        get: jest.fn(async (path: string) => {
          if (path === '/roles') throw new ApiError(50000, 'down')
          if (path.endsWith('/keys')) return { keys: APPROVABLE }
          return { total: 0, current: 1, size: 100, hasNext: false, hasPrev: false, records: [] }
        }) as jest.Mock,
      },
    })

    await openCreate(m.app)

    expect(optionValues(m.app, 'policy-subject-kind')).toEqual(['all', 'type'])
  })
})

describe('AC-13: an edit patches the five mutable fields', () => {
  test('a blank timeout sends timeoutSec: null and nothing else', async () => {
    const m = await mountPage()

    call(byId(m.app, 'policy-edit', rowFor(m.app, 'pol1')), 'onClick')
    await settle()
    expect(byId(m.app, 'policy-timeout').props.modelValue).toBe('120')

    typeInto(byId(m.app, 'policy-timeout'), '')
    await settle()
    await submitForm(m.app)

    expect(m.api.patch).toHaveBeenCalledTimes(1)
    const [path, body] = m.api.patch.mock.calls[0] as [string, Record<string, unknown>]
    expect(path).toBe('/approval-policies/pol1')
    expect(body).toEqual({
      mode: 'human',
      timeoutSec: null,
      onTimeout: 'reject',
      approverMustHoldAction: false,
      requireDistinctApprover: false,
    })
  })

  test('the pattern and the subject are not editable', async () => {
    const m = await mountPage()

    call(byId(m.app, 'policy-edit', rowFor(m.app, 'pol1')), 'onClick')
    await settle()

    expect(allById(m.app, 'policy-pattern')).toHaveLength(0)
    expect(allById(m.app, 'policy-subject-kind')).toHaveLength(0)
  })
})

describe('AC-14: delete asks first', () => {
  test('confirming sends DELETE /approval-policies/<id>', async () => {
    const m = await mountPage()

    call(byId(m.app, 'policy-delete', rowFor(m.app, 'pol1')), 'onClick')
    await settle()

    expect(m.confirm).toHaveBeenCalledTimes(1)
    expect(m.api.delete).toHaveBeenCalledTimes(1)
    expect(m.api.delete).toHaveBeenCalledWith('/approval-policies/pol1')
    expect(m.toast.success).toHaveBeenCalledTimes(1)
  })

  test('declining sends nothing', async () => {
    const m = await mountPage({ confirm: false })

    call(byId(m.app, 'policy-delete', rowFor(m.app, 'pol1')), 'onClick')
    await settle()

    expect(m.api.delete).not.toHaveBeenCalled()
  })
})

describe('AC-15: a refused create keeps the dialog open', () => {
  test('a 400 toasts extractApiError and keeps what was typed', async () => {
    const err = new ApiError(40000, 'approvals.invalidPolicy')
    const m = await mountPage({ api: { post: jest.fn(async () => { throw err }) as jest.Mock } })

    await openCreate(m.app)
    typeInto(byId(m.app, 'policy-pattern'), 'label.create')
    await settle()
    await submitForm(m.app)

    expect(m.toast.error).toHaveBeenCalledWith(extractApiError(err))
    expect(allById(m.app, 'policy-form')).toHaveLength(1)
    expect(byId(m.app, 'policy-pattern').props.modelValue).toBe('label.create')
  })
})
