import { describe, test, expect, jest, afterEach } from '@jest/globals'

type Fn = (...args: unknown[]) => Promise<unknown>
function install(api: { get?: Fn }) {
  (globalThis as Record<string, unknown>).useApi = () => ({ $api: api })
}
afterEach(() => { delete (globalThis as Record<string, unknown>).useApi })

async function fresh() {
  jest.resetModules()
  return import('../../composables/useActionPreview')
}

const detail = (pendingActions: unknown[]): Record<string, unknown> => ({ id: 't1', kind: 'PROJECT', pendingActions })

describe('useActionPreview (S5b 2aw-D10)', () => {
  test('a project thread path is read through the projects route (AC-13)', async () => {
    const get = jest.fn(async () => detail([{ id: 'a2', preview: 'Run the export' }]))
    install({ get })
    const { useActionPreview } = await fresh()
    await useActionPreview().load('/acme/threads/t1', 'a2')
    expect(get).toHaveBeenCalledWith('/projects/acme/threads/t1')
  })

  test('a workspace thread path is read as it is', async () => {
    const get = jest.fn(async () => detail([]))
    install({ get })
    const { useActionPreview } = await fresh()
    await useActionPreview().load('/threads/t1', 'a2')
    expect(get).toHaveBeenCalledWith('/threads/t1')
  })

  test('the answer is the preview of that action, and null when the thread no longer lists it (AC-14)', async () => {
    const get = jest.fn(async () => detail([
      { id: 'a1', preview: 'Older action' },
      { id: 'a2', preview: 'Run the export' },
    ]))
    install({ get })
    const { useActionPreview } = await fresh()
    const load = useActionPreview().load
    expect(await load('/acme/threads/t1', 'a2')).toBe('Run the export')
    // The thread still lists an older action, but not this one: it is no longer pending.
    expect(await load('/acme/threads/t1', 'gone')).toBeNull()
  })

  test('a path that is not a thread path rejects without asking the API (AC-15)', async () => {
    const get = jest.fn(async () => detail([]))
    install({ get })
    const { useActionPreview } = await fresh()
    await expect(useActionPreview().load('/acme/tickets/t1', 'a2')).rejects.toThrow()
    expect(get).not.toHaveBeenCalled()
  })

  test('a thread detail without pendingActions answers null', async () => {
    const get = jest.fn(async () => ({ id: 't1', pendingActions: null }))
    install({ get })
    const { useActionPreview } = await fresh()
    expect(await useActionPreview().load('/acme/threads/t1', 'a2')).toBeNull()
  })

  test('an entry whose preview is not a readable string rejects, so no panel approves an unread preview', async () => {
    const get = jest.fn(async () => detail([{ id: 'a2', preview: null }]))
    install({ get })
    const { useActionPreview } = await fresh()
    await expect(useActionPreview().load('/acme/threads/t1', 'a2')).rejects.toThrow()
  })

  test('a failed thread read propagates', async () => {
    const get = jest.fn(async () => { throw new Error('403') })
    install({ get })
    const { useActionPreview } = await fresh()
    await expect(useActionPreview().load('/acme/threads/t1', 'a2')).rejects.toThrow('403')
  })
})
