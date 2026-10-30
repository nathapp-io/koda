import { afterEach, describe, expect, jest, test } from '@jest/globals'

type Fn = (...args: unknown[]) => Promise<unknown>
function install(api: { get?: Fn }) {
  (globalThis as Record<string, unknown>).useApi = () => ({ $api: api })
}
afterEach(() => { delete (globalThis as Record<string, unknown>).useApi })

async function fresh() {
  jest.resetModules()
  return import('~/composables/useProjectRef')
}

// ─────────────────────────────────────────────────────────────────────────────
// US-001 AC-14 — a slug resolved to its id
// ─────────────────────────────────────────────────────────────────────────────

describe('US-001 AC-14: useProjectRef', () => {
  test('AC-14: load resolves GET /projects/sandbox into the id', async () => {
    const get = jest.fn(async () => ({ id: 'p1' }))
    install({ get })
    const { useProjectRef } = await fresh()
    const project = useProjectRef('sandbox')

    expect(project.id.value).toBeNull()
    await project.load()

    expect(get).toHaveBeenCalledWith('/projects/sandbox')
    expect(project.id.value).toBe('p1')
  })

  test('AC-14 (edge): the slug is escaped into one path segment', async () => {
    const get = jest.fn(async () => ({ id: 'p1' }))
    install({ get })
    const { useProjectRef } = await fresh()

    await useProjectRef('a b').load()

    expect(get).toHaveBeenCalledWith('/projects/a%20b')
  })

  test('AC-14 (edge): load returns the id, and answers null for a project without one', async () => {
    const found = jest.fn(async () => ({ id: 'p1' }))
    install({ get: found })
    const { useProjectRef } = await fresh()
    expect(await useProjectRef('sandbox').load()).toBe('p1')

    const missing = jest.fn(async () => ({}))
    install({ get: missing })
    const fresh2 = await fresh()
    expect(await fresh2.useProjectRef('sandbox').load()).toBeNull()
  })

  test('AC-14 (edge): a failed load throws so the caller presents it, and keeps no id', async () => {
    install({ get: jest.fn(async () => { throw new Error('404') }) })
    const { useProjectRef } = await fresh()
    const project = useProjectRef('sandbox')

    await expect(project.load()).rejects.toThrow('404')
    expect(project.id.value).toBeNull()
  })
})
