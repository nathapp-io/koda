import { describe, test, expect, beforeEach, jest } from '@jest/globals'
import { join } from 'path'

const composablePath = join(__dirname, '../..', 'composables', 'useProjectAgents.ts')
interface Agent { slug: string; name: string; status: string; roles: string[]; capabilities: string[]; openTicketCount: number; openTicketRefs: string[]; addedAt: string; addedBy: { id: string; name: string | null } | null }
const agent = (slug: string, over: Partial<Agent> = {}): Agent => ({ slug, name: slug, status: 'ACTIVE', roles: ['CODER'], capabilities: ['code.write'], openTicketCount: 0, openTicketRefs: [], addedAt: '2026-01-01T00:00:00.000Z', addedBy: null, ...over })
const list = (over: { scoping?: boolean; items?: Agent[] } = {}) => ({ scoping: over.scoping ?? true, items: over.items ?? [] })
function withApi(api: Record<string, jest.Mock>): void { (globalThis as Record<string, unknown>).useApi = () => ({ $api: api }) }

describe('useProjectAgents', () => {
  beforeEach(() => { (globalThis as Record<string, unknown>).useApi = undefined })
  test('load populates items and scoping', async () => {
    const get = jest.fn(async () => list({ items: [agent('builder')] })); withApi({ get })
    const { useProjectAgents } = await import(composablePath); const roster = useProjectAgents('acme')
    await roster.load()
    expect(get).toHaveBeenCalledWith('/projects/acme/agents'); expect(roster.items.value.map(a => a.slug)).toEqual(['builder'])
    expect(roster.scoping.value).toBe(true); expect(roster.error.value).toBeNull()
  })
  test('load uses scoping false when response says false', async () => {
    withApi({ get: jest.fn(async () => list({ scoping: false, items: [agent('builder')] })) })
    const { useProjectAgents } = await import(composablePath)
    const roster = useProjectAgents('acme')
    await roster.load()
    expect(roster.scoping.value).toBe(false)
  })
  test('load maps malformed items to an empty roster', async () => {
    withApi({ get: jest.fn(async () => ({ scoping: true, items: 'not-an-array' })) })
    const { useProjectAgents } = await import(composablePath)
    const roster = useProjectAgents('acme')
    await roster.load()
    expect(roster.items.value).toEqual([])
  })
  test('load toggles pending while request is outstanding', async () => {
    let resolveGet: (value: unknown) => void = () => undefined
    const get = jest.fn(() => new Promise(resolve => { resolveGet = resolve }))
    withApi({ get })
    const { useProjectAgents } = await import(composablePath)
    const roster = useProjectAgents('acme')
    const pendingRequest = roster.load()
    expect(roster.pending.value).toBe(true)
    resolveGet(list({ items: [agent('builder')] }))
    await pendingRequest
    expect(roster.pending.value).toBe(false)
  })
  test('load defaults scoping to true for an empty response', async () => {
    withApi({ get: jest.fn(async () => ({})) }); const { useProjectAgents } = await import(composablePath); const roster = useProjectAgents('acme')
    await roster.load(); expect(roster.scoping.value).toBe(true); expect(roster.items.value).toEqual([])
  })
  test('load records rejection and clears pending', async () => {
    withApi({ get: jest.fn(async () => { throw new Error('roster down') }) }); const { useProjectAgents } = await import(composablePath); const roster = useProjectAgents('acme')
    await roster.load(); expect((roster.error.value as Error).message).toBe('roster down'); expect(roster.pending.value).toBe(false)
  })
  test('refresh re-runs load mapping', async () => {
    const get = jest.fn().mockImplementationOnce(async () => list({ items: [agent('a')] })).mockImplementationOnce(async () => list({ items: [agent('a'), agent('b')] }))
    withApi({ get }); const { useProjectAgents } = await import(composablePath); const roster = useProjectAgents('acme')
    await roster.load(); await roster.refresh(); expect(get).toHaveBeenCalledTimes(2); expect(roster.items.value.map(a => a.slug)).toEqual(['a', 'b'])
  })
  test('refresh rejection preserves earlier items and exposes error', async () => {
    const failure = new Error('refresh failed'); const get = jest.fn().mockImplementationOnce(async () => list({ items: [agent('kept')] })).mockImplementationOnce(async () => { throw failure })
    withApi({ get }); const { useProjectAgents } = await import(composablePath); const roster = useProjectAgents('web')
    await roster.load(); await roster.refresh(); expect(roster.error.value).toBe(failure); expect(roster.items.value.map(a => a.slug)).toEqual(['kept'])
  })
  test('keeps status changes but has no roster membership mutations', async () => {
    const patch = jest.fn(async () => ({})); withApi({ patch }); const { useProjectAgents } = await import(composablePath); const roster = useProjectAgents('web')
    expect(roster).not.toHaveProperty('add'); expect(roster).not.toHaveProperty('remove')
    await roster.changeStatus('agent-a', 'PAUSED'); expect(patch).toHaveBeenCalledWith('/projects/web/agents/agent-a', { status: 'PAUSED' })
  })
})
