import { beforeEach, describe, expect, jest, test } from '@jest/globals'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const composablePath = join(webDir, 'composables', 'useMemory.ts')

type FetchMock = jest.Mock<(url: string, options?: Record<string, unknown>) => Promise<unknown>>

function applyGlobals(fetchMock: FetchMock) {
  const globals = globalThis as Record<string, unknown>
  globals.useApi = () => ({
    $api: {
      get: async (path: string, options?: Record<string, unknown>) => {
        const result = await fetchMock(`http://localhost:3100${path}`, options)
        return (result as { data?: unknown })?.data ?? result
      },
      post: async (path: string, body?: Record<string, unknown>) => {
        const result = await fetchMock(`http://localhost:3100${path}`, { method: 'POST', body })
        return (result as { data?: unknown })?.data ?? result
      },
    },
  })
}

beforeEach(() => {
  const globals = globalThis as Record<string, unknown>
  globals.useApi = undefined
})

describe('useMemory retirement actions', () => {
  test('AC-1: sends trimmed decision reason', async () => {
    const fetchMock = jest.fn(async () => ({ data: { id: 'm1' } }))
    applyGlobals(fetchMock)
    const { useMemory } = await import(composablePath)
    await useMemory('sb').retireDecision('m1', ' obsolete ')
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:3100/memory/m1/retire', { method: 'POST', body: { reason: 'obsolete' } })
  })

  test('AC-2: omits empty decision reason', async () => {
    const fetchMock = jest.fn(async () => ({ data: { id: 'm1' } }))
    applyGlobals(fetchMock)
    const { useMemory } = await import(composablePath)
    await useMemory('sb').retireDecision('m1', '   ')
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:3100/memory/m1/retire', { method: 'POST', body: {} })
  })

  test('AC-3: sends note project and trimmed reason', async () => {
    const fetchMock = jest.fn(async () => ({ data: { id: 'n1' } }))
    applyGlobals(fetchMock)
    const { useMemory } = await import(composablePath)
    await useMemory('sb').retireNote('n1', 'p1', ' dup ')
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:3100/memory/notes/n1/retire', { method: 'POST', body: { projectId: 'p1', reason: 'dup' } })
  })

  test('AC-4: omits empty note reason', async () => {
    const fetchMock = jest.fn(async () => ({ data: { id: 'n1' } }))
    applyGlobals(fetchMock)
    const { useMemory } = await import(composablePath)
    await useMemory('sb').retireNote('n1', 'p1', '')
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:3100/memory/notes/n1/retire', { method: 'POST', body: { projectId: 'p1' } })
  })

  test('AC-5: returns retired for an item without permissionKey', async () => {
    const fetchMock = jest.fn(async () => ({ data: { id: 'm1', status: 'superseded' } }))
    applyGlobals(fetchMock)
    const { useMemory } = await import(composablePath)
    await expect(useMemory('sb').retireDecision('m1')).resolves.toEqual({ kind: 'retired' })
  })

  test('AC-6: preserves an approval request as pending', async () => {
    const request = { id: 'a1', permissionKey: 'memory.create', status: 'pending' }
    const fetchMock = jest.fn(async () => ({ data: request }))
    applyGlobals(fetchMock)
    const { useMemory } = await import(composablePath)
    await expect(useMemory('sb').retireNote('n1', 'p1')).resolves.toEqual({ kind: 'pending', request })
  })

  test('AC-7: propagates the same POST rejection', async () => {
    const error = new Error('denied')
    const fetchMock = jest.fn(async () => { throw error })
    applyGlobals(fetchMock)
    const { useMemory } = await import(composablePath)
    await expect(useMemory('sb').retireDecision('m1')).rejects.toBe(error)
  })

  test('AC-8: loadMore appends records after retire actions are exposed', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce({ data: { records: [{ id: 'm1' }], hasNext: true } })
      .mockResolvedValueOnce({ data: { records: [{ id: 'm2' }], hasNext: false } })
    applyGlobals(fetchMock)
    const { useMemory } = await import(composablePath)
    const memory = useMemory('sb')
    await memory.loadMemory()
    await memory.loadMore()
    expect(memory.items.value.map(item => item.id)).toEqual(['m1', 'm2'])
  })
})
