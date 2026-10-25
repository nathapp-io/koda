import { afterEach, describe, expect, jest, test } from '@jest/globals'
import { EMPTY_AUDIT_FILTERS, auditApiQuery, type AuditFilters } from '~/lib/audit-log'
import type { AuditEntry } from '~/composables/useAuditLog'

const composablePath = '~/composables/useAuditLog'
const g = globalThis as Record<string, unknown>

type Fn = (...args: unknown[]) => Promise<unknown>

function install(api: { get?: Fn }) {
  g.useApi = () => ({ $api: api })
}

afterEach(() => {
  delete g.useApi
})

const filters = (over: Partial<AuditFilters> = {}): AuditFilters => ({ ...EMPTY_AUDIT_FILTERS, ...over })

const entry = (id: string, over: Partial<AuditEntry> = {}): AuditEntry => ({
  id,
  key: 'ticket.create',
  resourceType: 'ticket',
  resourceId: `t-${id}`,
  projectId: 'p1',
  actor: { type: 'USER', id: 'u1' },
  onBehalfOf: null,
  origin: 'rest',
  approval: { requiredMode: 'none', satisfiedBy: 'none', approverType: null, approverId: null, requestId: null },
  correlationId: 'c-1',
  summary: 'created',
  display: { actor: 'Ada', onBehalfOf: null, approver: null, project: { slug: 'web', name: 'Web' } },
  createdAt: '2026-10-01T10:00:00.000Z',
  ...over,
})

const page = (records: AuditEntry[], over: Record<string, unknown> = {}) => ({
  records, total: records.length, current: 1, size: 50, hasNext: false, hasPrev: false, ...over,
})

describe('useAuditLog', () => {
  // AC-11
  test('load reads GET /audit with the API query of the filters', async () => {
    const get = jest.fn(async () => page([]))
    install({ get })
    const { useAuditLog } = await import(composablePath)
    const log = useAuditLog()
    const f = filters({ key: 'ticket.create', actorType: 'AGENT', page: 2 })

    await log.load(f)

    expect(get).toHaveBeenCalledWith('/audit', { query: auditApiQuery(f) })
    expect(get).toHaveBeenCalledWith('/audit', { query: { key: 'ticket.create', actorType: 'AGENT', current: '2', size: '50' } })
  })

  // AC-12
  test('a resolved load fills the entries, the total and hasNext', async () => {
    const get = jest.fn(async () => page([entry('a')], { total: 1, hasNext: true }))
    install({ get })
    const { useAuditLog } = await import(composablePath)
    const log = useAuditLog()

    expect(log.entries.value).toEqual([])
    expect(log.pending.value).toBe(false)
    await log.load(EMPTY_AUDIT_FILTERS)

    expect(log.entries.value).toHaveLength(1)
    expect(log.entries.value[0]).toEqual(entry('a'))
    expect(log.total.value).toBe(1)
    expect(log.hasNext.value).toBe(true)
    expect(log.pending.value).toBe(false)
  })

  test('pending is true while the request is in flight', async () => {
    let release: (value: unknown) => void = () => undefined
    const get = jest.fn(() => new Promise((resolve) => { release = resolve }))
    install({ get })
    const { useAuditLog } = await import(composablePath)
    const log = useAuditLog()

    const loading = log.load(EMPTY_AUDIT_FILTERS)
    expect(log.pending.value).toBe(true)
    release(page([entry('a')]))
    await loading
    expect(log.pending.value).toBe(false)
  })

  // AC-13
  test('loadKeys reads GET /audit/keys once and stores the keys', async () => {
    const get = jest.fn(async () => ({ keys: ['comment.create'] }))
    install({ get })
    const { useAuditLog } = await import(composablePath)
    const log = useAuditLog()

    await log.loadKeys()

    expect(get).toHaveBeenCalledWith('/audit/keys')
    expect(log.keys.value).toEqual(['comment.create'])
    expect(log.pending.value).toBe(false)
  })

  // AC-14
  test('a rejected load rethrows and keeps the previous entries, total and hasNext', async () => {
    const failure = new Error('boom')
    let call = 0
    const get = jest.fn(async () => {
      call += 1
      if (call === 1) return page([entry('a'), entry('b')], { total: 2, hasNext: true })
      throw failure
    })
    install({ get })
    const { useAuditLog } = await import(composablePath)
    const log = useAuditLog()
    await log.load(EMPTY_AUDIT_FILTERS)
    const before = log.entries.value

    await expect(log.load(filters({ page: 2 }))).rejects.toThrow('boom')

    expect(log.entries.value).toEqual(before)
    expect(log.entries.value.map((e) => e.id)).toEqual(['a', 'b'])
    expect(log.total.value).toBe(2)
    expect(log.hasNext.value).toBe(true)
    expect(log.pending.value).toBe(false)
  })

  test('a rejected keys load rethrows and keeps the previous keys', async () => {
    let call = 0
    const get = jest.fn(async () => {
      call += 1
      if (call === 1) return { keys: ['comment.create'] }
      throw new Error('nope')
    })
    install({ get })
    const { useAuditLog } = await import(composablePath)
    const log = useAuditLog()
    await log.loadKeys()

    await expect(log.loadKeys()).rejects.toThrow('nope')

    expect(log.keys.value).toEqual(['comment.create'])
    expect(log.pending.value).toBe(false)
  })
})
