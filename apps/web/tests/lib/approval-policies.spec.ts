/**
 * P3b US-008 (AC-1 to AC-7): the pure half of the approval-policy pages — the pattern floor, the mode
 * options, the override count and the dialog's schema and bodies — plus the paged list client.
 *
 * The floors, modes and timeouts here are the API's (`apps/api/src/approvals/approval-policy.validation.ts`):
 * these helpers only keep the form from offering a value the API would refuse. The API stays the
 * authority, and the dialog toasts whatever it answers.
 */
import { describe, test, expect, jest, afterEach } from '@jest/globals'
import {
  buildPolicySchema,
  modeOptions,
  overrideCount,
  parseTimeout,
  patternCovers,
  patternFloor,
  policyItem,
  policyKeysPath,
  policyRoot,
  toCreateBody,
  toPatchBody,
} from '../../lib/approval-policies'
import type { ApprovalPolicy, ApprovableKey, PolicyFormValues } from '../../lib/approval-policies'
import { useApprovalPolicies } from '../../composables/useApprovalPolicies'

/** The keys table's rows, as `GET /approval-policies/keys` answers them. */
const KEYS: ApprovableKey[] = [
  { key: 'fleet.job.shell.escalate', scope: 'project', risk: 'high', floor: 'human', default: 'none' },
  { key: 'fleet.budget.override', scope: 'project', risk: 'high', floor: 'agent', default: 'none' },
  { key: 'label.create', scope: 'project', risk: 'low', floor: 'none', default: 'none' },
  { key: 'ticket.create', scope: 'project', risk: 'medium', floor: 'self', default: 'none' },
]

function policy(over: Partial<ApprovalPolicy> = {}): ApprovalPolicy {
  return {
    id: 'p1', selector: '*|label.create|all', projectId: null, permissionPattern: 'label.create',
    principalType: null, roleId: null, principalId: null, mode: 'human', timeoutSec: null, onTimeout: 'reject',
    requiredApprovals: 1, approverMustHoldAction: false, requireDistinctApprover: false,
    updatedByType: 'USER', updatedById: 'u1',
    createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
    ...over,
  }
}

const formValues = (over: Partial<PolicyFormValues> = {}): PolicyFormValues => ({
  mode: 'human', timeoutSec: '', onTimeout: 'reject', approverMustHoldAction: false, requireDistinctApprover: false,
  ...over,
})

/** The `t` the schema is built with: the message is the i18n key, which is what an assertion reads. */
const t = (key: string): string => key

const messagesFor = (schema: ReturnType<typeof buildPolicySchema>, values: PolicyFormValues): string[] => {
  const result = schema.safeParse(values)
  return result.success ? [] : result.error.issues.map((issue) => issue.message)
}

describe('AC-1: patternFloor answers the strictest floor under a prefix', () => {
  test("fleet.* covers the human shell key and the agent budget key, so the floor is 'human'", () => {
    expect(patternFloor('fleet.*', KEYS)).toBe('human')
  })

  test('a prefix whose keys all share a weaker floor answers that floor', () => {
    const keys: ApprovableKey[] = [
      { key: 'label.create', scope: 'project', risk: 'low', floor: 'none', default: 'none' },
      { key: 'label.update', scope: 'project', risk: 'low', floor: 'self', default: 'none' },
    ]
    expect(patternFloor('label.*', keys)).toBe('self')
  })

  test('an exact pattern answers its own key floor', () => {
    expect(patternFloor('label.create', KEYS)).toBe('none')
    expect(patternFloor('ticket.create', KEYS)).toBe('self')
  })
})

describe('AC-2: a pattern covering no approvable key answers null', () => {
  test('nothing.here covers nothing', () => {
    expect(patternFloor('nothing.here', KEYS)).toBeNull()
  })

  test('a bare prefix without the wildcard covers nothing, and so does an empty pattern', () => {
    expect(patternFloor('fleet', KEYS)).toBeNull()
    expect(patternFloor('fleet.*.deep', KEYS)).toBeNull()
    expect(patternFloor('', KEYS)).toBeNull()
  })
})

describe('AC-3: modeOptions offers the floor and everything stricter', () => {
  test("'agent' offers agent and human", () => {
    expect(modeOptions('agent')).toEqual(['agent', 'human'])
  })

  test('the ends of the ranking', () => {
    expect(modeOptions('none')).toEqual(['none', 'self', 'agent', 'human'])
    expect(modeOptions('human')).toEqual(['human'])
  })

  test('a null floor offers nothing (the pattern is refused before a mode is chosen)', () => {
    expect(modeOptions(null)).toEqual([])
  })
})

describe('AC-4: overrideCount counts the policies whose pattern matches one key', () => {
  test('label.create and label.* count for label.create; ticket.* does not', () => {
    const policies = [
      policy({ id: 'p1', permissionPattern: 'label.create' }),
      policy({ id: 'p2', permissionPattern: 'label.*' }),
      policy({ id: 'p3', permissionPattern: 'ticket.*' }),
    ]
    expect(overrideCount('label.create', policies)).toBe(2)
  })

  test('a deeper wildcard only covers the keys under its own prefix', () => {
    expect(patternCovers('a.b.*', 'a.b.c')).toBe(true)
    expect(patternCovers('a.*', 'a.b.c')).toBe(true)
    expect(patternCovers('a.*', 'ab.c')).toBe(false)
    expect(patternCovers('label.create', 'label.create')).toBe(true)
    expect(patternCovers('label.create', 'label.creates')).toBe(false)
  })

  test('no matching policy counts zero', () => {
    expect(overrideCount('label.create', [])).toBe(0)
  })
})

describe('AC-5: the schema refuses a timeout the API would refuse', () => {
  test('a timeout of 30 is rejected with the timeout message', () => {
    expect(messagesFor(buildPolicySchema(t, 'none'), formValues({ timeoutSec: '30' })))
      .toContain('approvals.policies.validation.timeout')
    expect(messagesFor(buildPolicySchema(t, 'none'), formValues({ timeoutSec: 30 })))
      .toContain('approvals.policies.validation.timeout')
  })

  test('the bounds and the blank timeout', () => {
    const schema = buildPolicySchema(t, 'none')
    expect(messagesFor(schema, formValues({ timeoutSec: '' }))).toEqual([])
    expect(messagesFor(schema, formValues({ timeoutSec: '60' }))).toEqual([])
    expect(messagesFor(schema, formValues({ timeoutSec: '2592000' }))).toEqual([])
    expect(messagesFor(schema, formValues({ timeoutSec: '59' }))).toContain('approvals.policies.validation.timeout')
    expect(messagesFor(schema, formValues({ timeoutSec: '2592001' }))).toContain('approvals.policies.validation.timeout')
    expect(messagesFor(schema, formValues({ timeoutSec: '90.5' }))).toContain('approvals.policies.validation.timeout')
    expect(messagesFor(schema, formValues({ timeoutSec: 'soon' }))).toContain('approvals.policies.validation.timeout')
  })
})

describe('AC-6: approve-on-timeout needs a none floor', () => {
  test("a human floor refuses onTimeout: 'approve' with the timeoutApprove message", () => {
    expect(messagesFor(buildPolicySchema(t, 'human'), formValues({ onTimeout: 'approve' })))
      .toContain('approvals.policies.validation.timeoutApprove')
  })

  test('a none floor accepts it, and reject is always accepted', () => {
    expect(messagesFor(buildPolicySchema(t, 'none'), formValues({ onTimeout: 'approve' }))).toEqual([])
    expect(messagesFor(buildPolicySchema(t, 'human'), formValues({ onTimeout: 'reject' }))).toEqual([])
  })

  test('a mode below the floor is refused with the mode message', () => {
    expect(messagesFor(buildPolicySchema(t, 'human'), formValues({ mode: 'agent' })))
      .toContain('approvals.policies.validation.mode')
  })
})

describe('the dialog bodies', () => {
  test('a create body carries only what the form set', () => {
    expect(toCreateBody('label.create', { kind: 'type', principalType: 'AGENT' }, formValues())).toEqual({
      permissionPattern: 'label.create',
      appliesTo: { kind: 'type', principalType: 'AGENT' },
      mode: 'human',
      onTimeout: 'reject',
    })
  })

  test('a create body adds a timeout and the two flags only when they were set', () => {
    expect(toCreateBody('label.create', { kind: 'all' }, formValues({
      timeoutSec: '600', approverMustHoldAction: true, requireDistinctApprover: true,
    }))).toEqual({
      permissionPattern: 'label.create',
      appliesTo: { kind: 'all' },
      mode: 'human',
      onTimeout: 'reject',
      timeoutSec: 600,
      approverMustHoldAction: true,
      requireDistinctApprover: true,
    })
  })

  test('a role subject travels as the role id', () => {
    expect(toCreateBody('label.create', { kind: 'role', roleId: 'r1' }, formValues()).appliesTo)
      .toEqual({ kind: 'role', roleId: 'r1' })
  })

  test('a patch carries the five mutable fields, a blank timeout as null, and nothing else', () => {
    expect(toPatchBody(formValues())).toEqual({
      mode: 'human', timeoutSec: null, onTimeout: 'reject',
      approverMustHoldAction: false, requireDistinctApprover: false,
    })
  })

  test('parseTimeout reads the form text', () => {
    expect(parseTimeout('')).toBeNull()
    expect(parseTimeout('   ')).toBeNull()
    expect(parseTimeout('600')).toBe(600)
    expect(parseTimeout(600)).toBe(600)
    expect(parseTimeout('soon')).toBeNull()
  })
})

describe('the policy paths', () => {
  test('global and project bases, with the slug and id encoded', () => {
    expect(policyRoot({ kind: 'global' })).toBe('/approval-policies')
    expect(policyRoot({ kind: 'project', slug: 'a b' })).toBe('/projects/a%20b/approval-policies')
    expect(policyItem({ kind: 'global' }, 'x/y')).toBe('/approval-policies/x%2Fy')
    expect(policyItem({ kind: 'project', slug: 'koda' }, 'p1')).toBe('/projects/koda/approval-policies/p1')
    expect(policyKeysPath({ kind: 'global' })).toBe('/approval-policies/keys')
    expect(policyKeysPath({ kind: 'project', slug: 'koda' })).toBe('/projects/koda/approval-policies/keys')
  })
})

type Fn = (path: string, options?: { query: Record<string, string> }) => Promise<unknown>

function install(api: { get?: Fn; post?: Fn; patch?: Fn; delete?: Fn }): void {
  (globalThis as Record<string, unknown>).useApi = () => ({ $api: api })
}

afterEach(() => { delete (globalThis as Record<string, unknown>).useApi })

const page = (records: ApprovalPolicy[], over: Record<string, unknown> = {}): Record<string, unknown> => ({
  total: records.length, current: 1, size: 100, hasNext: false, hasPrev: false, records, ...over,
})

describe('AC-7: list() reads every page so an override count sees every policy', () => {
  test('a first answer with hasNext: true requests page 2 with current: 2', async () => {
    const get = jest.fn(async (_path: string, options?: { query: Record<string, string> }) =>
      (options?.query.current === '2'
        ? page([policy({ id: 'p2', permissionPattern: 'label.*' })], { total: 2, current: 2, hasPrev: true })
        : page([policy({ id: 'p1' })], { total: 2, hasNext: true }))) as unknown as Fn
    install({ get })

    const policies = useApprovalPolicies({ kind: 'global' })
    const rows = await policies.list()

    expect(get).toHaveBeenCalledTimes(2)
    expect(get).toHaveBeenNthCalledWith(1, '/approval-policies', { query: { size: '100' } })
    expect(get).toHaveBeenNthCalledWith(2, '/approval-policies', { query: { current: '2', size: '100' } })
    expect(rows.map((row) => row.id)).toEqual(['p1', 'p2'])
    expect(policies.policies.value.map((row) => row.id)).toEqual(['p1', 'p2'])
  })

  test('a project base reads the project route and one page stops when hasNext is false', async () => {
    const get = jest.fn(async () => page([policy({ id: 'p1', projectId: 'p1' })])) as unknown as Fn
    install({ get })

    const policies = useApprovalPolicies({ kind: 'project', slug: 'koda' })
    await policies.list()

    expect(get).toHaveBeenCalledTimes(1)
    expect(get).toHaveBeenCalledWith('/projects/koda/approval-policies', { query: { size: '100' } })
  })

  test('a hasNext answer with no records stops instead of paging forever', async () => {
    const get = jest.fn(async () => page([], { hasNext: true })) as unknown as Fn
    install({ get })

    await useApprovalPolicies({ kind: 'global' }).list()

    expect(get).toHaveBeenCalledTimes(1)
  })

  test('list() keeps paging past a hundred pages until hasNext is false', async () => {
    const total = 150
    const get = jest.fn(async (_path: string, options?: { query: Record<string, string> }) => {
      const current = Number(options?.query.current ?? '1')
      return page([policy({ id: `p${current}` })], { total, current, hasNext: current < total, hasPrev: current > 1 })
    }) as unknown as Fn
    install({ get })

    const rows = await useApprovalPolicies({ kind: 'global' }).list()

    expect(get).toHaveBeenCalledTimes(total)
    expect(get).toHaveBeenNthCalledWith(101, '/approval-policies', { query: { current: '101', size: '100' } })
    expect(rows).toHaveLength(total)
    expect(rows[total - 1]?.id).toBe(`p${total}`)
  })
})

describe('useApprovalPolicies mutations', () => {
  test('keys load from the base route', async () => {
    const get = jest.fn(async () => ({ keys: KEYS })) as unknown as Fn
    install({ get })

    const policies = useApprovalPolicies({ kind: 'project', slug: 'koda' })
    expect(await policies.loadKeys()).toEqual(KEYS)
    expect(get).toHaveBeenCalledWith('/projects/koda/approval-policies/keys')
  })

  test('create, update and remove keep the loaded list in step', async () => {
    const created = policy({ id: 'p2', permissionPattern: 'label.*' })
    const updated = policy({ id: 'p2', permissionPattern: 'label.*', mode: 'agent' })
    install({
      get: jest.fn(async () => page([policy({ id: 'p1' })])) as unknown as Fn,
      post: jest.fn(async () => created) as unknown as Fn,
      patch: jest.fn(async () => updated) as unknown as Fn,
      delete: jest.fn(async () => undefined) as unknown as Fn,
    })

    const policies = useApprovalPolicies({ kind: 'global' })
    await policies.list()
    await policies.create({ permissionPattern: 'label.*' })
    expect(policies.policies.value.map((row) => row.id)).toEqual(['p1', 'p2'])

    await policies.update('p2', { mode: 'agent' })
    expect(policies.policies.value.find((row) => row.id === 'p2')?.mode).toBe('agent')

    await policies.remove('p2')
    expect(policies.policies.value.map((row) => row.id)).toEqual(['p1'])
  })
})
