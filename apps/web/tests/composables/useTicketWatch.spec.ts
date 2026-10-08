import { afterEach, describe, expect, jest, test } from '@jest/globals'

const g = globalThis as Record<string, unknown>

async function load(api: Record<string, jest.Mock>) {
  g.useApi = () => ({ $api: api })
  return (await import('~/composables/useTicketWatch')).useTicketWatch('koda', 'KODA-1')
}

describe('useTicketWatch (S4a §3)', () => {
  afterEach(() => { delete g.useApi })

  test('load reads the caller watch state', async () => {
    const get = jest.fn(async () => ({ watching: false, count: 2 }))
    const w = await load({ get })
    await w.load()
    expect(get).toHaveBeenCalledWith('/projects/koda/tickets/KODA-1/watchers')
    expect(w.state.value).toEqual({ watching: false, count: 2 })
  })

  test('toggle watches with PUT when not watching, unwatches with DELETE when watching', async () => {
    const put = jest.fn(async () => ({ watching: true, count: 3 }))
    const del = jest.fn(async () => ({ watching: false, count: 2 }))
    const w = await load({ get: jest.fn(async () => ({ watching: false, count: 2 })), put, delete: del })
    await w.load()
    await w.toggle()
    expect(put).toHaveBeenCalledWith('/projects/koda/tickets/KODA-1/watch')
    expect(w.state.value).toEqual({ watching: true, count: 3 })
    await w.toggle()
    expect(del).toHaveBeenCalledWith('/projects/koda/tickets/KODA-1/watch')
    expect(w.state.value).toEqual({ watching: false, count: 2 })
    expect(w.busy.value).toBe(false)
  })

  test('toggle before load does nothing', async () => {
    const put = jest.fn()
    const w = await load({ get: jest.fn(), put, delete: jest.fn() })
    await w.toggle()
    expect(put).not.toHaveBeenCalled()
  })
})
