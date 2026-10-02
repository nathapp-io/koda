import { describe, test, expect, beforeEach, jest } from '@jest/globals'
import { join } from 'path'
import type { BudgetPolicyDto } from '../../lib/fleet-types'

const composablePath = join(__dirname, '../..', 'composables', 'useFleetBudgets.ts')

const row = (id: string, over: Partial<BudgetPolicyDto> = {}): BudgetPolicyDto => ({
  id, scopeType: 'global', scopeId: null, projectId: null, windowKind: 'calendar_month_utc', amountUsd: '5.0000',
  warnPercent: 80, hardStop: true, runningJobs: 'finish', paused: false, pausedAt: null,
  windowStart: '2026-10-01T00:00:00.000Z', spentUsd: '1.0000', warnReached: false, updatedById: 'u1',
  createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', ...over,
})

function withApi(api: Record<string, jest.Mock>): void {
  (globalThis as Record<string, unknown>).useApi = () => ({ $api: api })
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

describe('useFleetBudgets', () => {
  beforeEach(() => { (globalThis as Record<string, unknown>).useApi = undefined })

  test('paths: admin prefix, project prefix with an encoded slug, item and resume paths', async () => {
    const { budgetRoot, budgetItem } = await import(composablePath)
    expect(budgetRoot({ kind: 'admin' })).toBe('/fleet/budgets')
    expect(budgetRoot({ kind: 'project', slug: 'a b' })).toBe('/projects/a%20b/fleet/budgets')
    expect(budgetItem({ kind: 'admin' }, 'p1')).toBe('/fleet/budgets/p1')
    expect(budgetItem({ kind: 'project', slug: 'koda' }, 'p1')).toBe('/projects/koda/fleet/budgets/p1')
  })

  test('load reads the base list and sorts it by scope type', async () => {
    const get = jest.fn(async () => [row('r', { scopeType: 'runner', scopeId: 'r1' }), row('g')])
    withApi({ get })
    const { useFleetBudgets } = await import(composablePath)
    const budgets = useFleetBudgets({ kind: 'admin' })

    await budgets.load()

    expect(get).toHaveBeenCalledWith('/fleet/budgets')
    expect(budgets.policies.value.map((p) => p.id)).toEqual(['g', 'r'])
    expect(budgets.pending.value).toBe(false)
  })

  test('create posts the body to the base and inserts the answer in order', async () => {
    const body = { scopeType: 'global', windowKind: 'lifetime', amountUsd: 9, warnPercent: null, hardStop: true, runningJobs: 'finish' }
    const post = jest.fn(async () => row('new', { windowKind: 'lifetime' }))
    withApi({ get: jest.fn(async () => [row('old')]), post })
    const { useFleetBudgets } = await import(composablePath)
    const budgets = useFleetBudgets({ kind: 'admin' })
    await budgets.load()

    const created = await budgets.create(body as never)

    expect(post).toHaveBeenCalledWith('/fleet/budgets', body)
    expect(created.id).toBe('new')
    expect(budgets.policies.value.map((p) => p.id)).toEqual(['old', 'new'])
  })

  test('update patches the item and replaces the row', async () => {
    const patch = jest.fn(async () => row('p1', { amountUsd: '9.0000' }))
    withApi({ get: jest.fn(async () => [row('p1')]), patch })
    const { useFleetBudgets } = await import(composablePath)
    const budgets = useFleetBudgets({ kind: 'project', slug: 'koda' })
    await budgets.load()

    await budgets.update('p1', { amountUsd: 9 })

    expect(patch).toHaveBeenCalledWith('/projects/koda/fleet/budgets/p1', { amountUsd: 9 })
    expect(budgets.policies.value[0].amountUsd).toBe('9.0000')
  })

  test('resume posts an empty body to keep the amount and the amount when raised', async () => {
    const post = jest.fn(async () => row('p1', { paused: false }))
    withApi({ get: jest.fn(async () => [row('p1', { paused: true })]), post })
    const { useFleetBudgets } = await import(composablePath)
    const budgets = useFleetBudgets({ kind: 'project', slug: 'koda' })
    await budgets.load()

    await budgets.resume('p1')
    await budgets.resume('p1', 8)

    expect(post).toHaveBeenNthCalledWith(1, '/projects/koda/fleet/budgets/p1/resume', {})
    expect(post).toHaveBeenNthCalledWith(2, '/projects/koda/fleet/budgets/p1/resume', { amountUsd: 8 })
    expect(budgets.policies.value[0].paused).toBe(false)
  })

  test('remove deletes the item and drops the row', async () => {
    const del = jest.fn(async () => undefined)
    withApi({ get: jest.fn(async () => [row('a'), row('b', { windowKind: 'lifetime' })]), delete: del })
    const { useFleetBudgets } = await import(composablePath)
    const budgets = useFleetBudgets({ kind: 'admin' })
    await budgets.load()

    await budgets.remove('a')

    expect(del).toHaveBeenCalledWith('/fleet/budgets/a')
    expect(budgets.policies.value.map((p) => p.id)).toEqual(['b'])
  })

  test('a failed mutation leaves the list as it was and rethrows', async () => {
    withApi({ get: jest.fn(async () => [row('a')]), delete: jest.fn(async () => { throw new Error('gone') }) })
    const { useFleetBudgets } = await import(composablePath)
    const budgets = useFleetBudgets({ kind: 'admin' })
    await budgets.load()

    await expect(budgets.remove('a')).rejects.toThrow('gone')
    expect(budgets.policies.value.map((p) => p.id)).toEqual(['a'])
  })

  test('a load that started before a mutation cannot put the old row back (Review Focus 4)', async () => {
    const slow = deferred<BudgetPolicyDto[]>()
    const get = jest.fn()
      .mockImplementationOnce(async () => [row('p1', { paused: true })])
      .mockImplementationOnce(() => slow.promise)
    withApi({ get, post: jest.fn(async () => row('p1', { paused: false })) })
    const { useFleetBudgets } = await import(composablePath)
    const budgets = useFleetBudgets({ kind: 'admin' })
    await budgets.load()

    const poll = budgets.load()
    await budgets.resume('p1')
    slow.resolve([row('p1', { paused: true })])
    await poll

    expect(budgets.policies.value[0].paused).toBe(false)
  })

  test('only the newest load wins', async () => {
    const first = deferred<BudgetPolicyDto[]>()
    const second = deferred<BudgetPolicyDto[]>()
    const get = jest.fn().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise)
    withApi({ get })
    const { useFleetBudgets } = await import(composablePath)
    const budgets = useFleetBudgets({ kind: 'admin' })

    const a = budgets.load()
    const b = budgets.load()
    second.resolve([row('new')])
    await b
    first.resolve([row('old')])
    await a

    expect(budgets.policies.value.map((p) => p.id)).toEqual(['new'])
  })
})
