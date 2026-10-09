import { describe, test, expect, beforeEach, jest } from '@jest/globals'
import { join } from 'path'

const composablePath = join(__dirname, '../..', 'composables', 'useProjectAgents.ts')

interface Agent {
  slug: string
  name: string
  status: string
  roles: string[]
  capabilities: string[]
  openTicketCount: number
  openTicketRefs: string[]
  addedAt: string
  addedBy: { id: string; name: string | null } | null
}

const agent = (slug: string, over: Partial<Agent> = {}): Agent => ({
  slug, name: slug, status: 'ACTIVE', roles: ['CODER'], capabilities: ['code.write'],
  openTicketCount: 0, openTicketRefs: [], addedAt: '2026-01-01T00:00:00.000Z', addedBy: null, ...over,
})

const list = (over: { scoping?: boolean; items?: Agent[] } = {}) => ({
  scoping: over.scoping ?? true,
  items: over.items ?? [],
})

function withApi(api: Record<string, jest.Mock>): void {
  (globalThis as Record<string, unknown>).useApi = () => ({ $api: api })
}

describe('useProjectAgents', () => {
  beforeEach(() => {
    (globalThis as Record<string, unknown>).useApi = undefined
  })

  test('load populates items and leaves scoping as true by default', async () => {
    const get = jest.fn(async () => list({ items: [agent('builder')] }))
    withApi({ get })
    const { useProjectAgents } = await import(composablePath)
    const roster = useProjectAgents('acme')

    await roster.load()

    expect(get).toHaveBeenCalledWith('/projects/acme/agents')
    expect(roster.items.value.map((a: Agent) => a.slug)).toEqual(['builder'])
    expect(roster.scoping.value).toBe(true)
    expect(roster.error.value).toBeNull()
  })

  test('load propagates the API scoping flag (false when the response says so)', async () => {
    const get = jest.fn(async () => list({ scoping: false, items: [agent('builder')] }))
    withApi({ get })
    const { useProjectAgents } = await import(composablePath)
    const roster = useProjectAgents('acme')

    await roster.load()

    expect(roster.scoping.value).toBe(false)
  })

  test('load defaults scoping to true when the response omits the field', async () => {
    // The API may send an empty body shape (`{}`) during incidents; the composable must still
    // treat scoping as the safe default (true) so the page does not flash the scoping-off note.
    const get = jest.fn(async () => ({}))
    withApi({ get })
    const { useProjectAgents } = await import(composablePath)
    const roster = useProjectAgents('acme')

    await roster.load()

    expect(roster.scoping.value).toBe(true)
    expect(roster.items.value).toEqual([])
  })

  test('load maps a non-array items field to an empty roster', async () => {
    const get = jest.fn(async () => ({ scoping: true, items: 'not-an-array' }))
    withApi({ get })
    const { useProjectAgents } = await import(composablePath)
    const roster = useProjectAgents('acme')

    await roster.load()

    expect(roster.items.value).toEqual([])
  })

  test('load records the thrown error and clears pending', async () => {
    const get = jest.fn(async () => { throw new Error('roster down') })
    withApi({ get })
    const { useProjectAgents } = await import(composablePath)
    const roster = useProjectAgents('acme')

    await roster.load()

    expect(roster.error.value).toBeInstanceOf(Error)
    expect((roster.error.value as Error).message).toBe('roster down')
    expect(roster.pending.value).toBe(false)
  })

  test('load toggles pending around the request', async () => {
    let pendingDuringCall: boolean | null = null
    const get = jest.fn(async (_path: string) => {
      // Capture the composable's `pending` flag while the request is in flight: it must be true.
      pendingDuringCall = (globalThis as Record<string, unknown>).__pendingProbe as boolean | null
      return list({ items: [agent('builder')] })
    })
    withApi({ get })
    const { useProjectAgents } = await import(composablePath)
    const roster = useProjectAgents('acme')

    // A watch on pending captures the mid-call value once the load starts.
    const { watch: vueWatch } = await import('vue')
    vueWatch(roster.pending, (value: boolean) => {
      if (value) pendingDuringCall = true
    })

    await roster.load()

    expect(roster.pending.value).toBe(false)
    // Mid-flight the composable must have flipped pending to true (the watch caught it).
    expect(pendingDuringCall).toBe(true)
  })

  test('refresh re-runs the load mapping', async () => {
    const get = jest.fn()
      .mockImplementationOnce(async () => list({ items: [agent('a')] }))
      .mockImplementationOnce(async () => list({ items: [agent('a'), agent('b')] }))
    withApi({ get })
    const { useProjectAgents } = await import(composablePath)
    const roster = useProjectAgents('acme')

    await roster.load()
    await roster.refresh()

    expect(get).toHaveBeenCalledTimes(2)
    expect(roster.items.value.map((a: Agent) => a.slug)).toEqual(['a', 'b'])
  })

  test('add posts { agentSlug } to /projects/:slug/agents and rethrows API errors', async () => {
    const post = jest.fn(async () => { throw new Error('conflict') })
    withApi({ post })
    const { useProjectAgents } = await import(composablePath)
    const roster = useProjectAgents('acme')

    await expect(roster.add('available-agent')).rejects.toThrow('conflict')
    expect(post).toHaveBeenCalledWith('/projects/acme/agents', { agentSlug: 'available-agent' })
  })

  test('remove DELETEs /projects/:slug/agents/:agentSlug and rethrows API errors', async () => {
    const del = jest.fn(async () => { throw new Error('stale counts') })
    withApi({ delete: del })
    const { useProjectAgents } = await import(composablePath)
    const roster = useProjectAgents('acme')

    await expect(roster.remove('builder')).rejects.toThrow('stale counts')
    expect(del).toHaveBeenCalledWith('/projects/acme/agents/builder')
  })

  test('remove on a slug with reserved characters is encoded by apiPath', async () => {
    const del = jest.fn(async () => ({}))
    withApi({ delete: del })
    const { useProjectAgents } = await import(composablePath)
    const roster = useProjectAgents('acme')

    await roster.remove('odd slug/with chars')

    // apiPath encodes each interpolated value; the resulting path must be a single, encoded segment
    // per interpolation so a path injection in the slug cannot add segments.
    expect(del).toHaveBeenCalledTimes(1)
    const calledPath = del.mock.calls[0][0] as string
    expect(calledPath.startsWith('/projects/acme/agents/')).toBe(true)
    expect(calledPath.includes(' ')).toBe(false)
    expect(calledPath.includes('/with ')).toBe(false)
  })

  test('add for a missing slug is forwarded as-is so the server decides', async () => {
    const post = jest.fn(async () => ({}))
    withApi({ post })
    const { useProjectAgents } = await import(composablePath)
    const roster = useProjectAgents('acme')

    await roster.add('available-agent')
    expect(post).toHaveBeenCalledWith('/projects/acme/agents', { agentSlug: 'available-agent' })
  })
})
