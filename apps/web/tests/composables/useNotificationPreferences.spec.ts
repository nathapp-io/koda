import { afterEach, describe, expect, jest, test } from '@jest/globals'

const g = globalThis as Record<string, unknown>
const ITEMS = [
  { category: 'ASSIGNED', inApp: true }, { category: 'MENTIONED', inApp: true }, { category: 'WATCHED_ACTIVITY', inApp: false },
  { category: 'FLEET_NEEDS_YOU', inApp: true }, { category: 'FLEET_HEALTH', inApp: true },
]

async function load(api: Record<string, jest.Mock>) {
  g.useApi = () => ({ $api: api })
  return (await import('~/composables/useNotificationPreferences')).useNotificationPreferences()
}

describe('useNotificationPreferences (S4a §3)', () => {
  afterEach(() => { delete g.useApi })

  test('load reads the five categories', async () => {
    const get = jest.fn(async () => ({ items: ITEMS }))
    const prefs = await load({ get })
    await prefs.load()
    expect(get).toHaveBeenCalledWith('/me/notification-preferences')
    expect(prefs.items.value).toEqual(ITEMS)
  })

  test('setInApp PUTs one change and keeps the returned list', async () => {
    const next = ITEMS.map((i) => (i.category === 'ASSIGNED' ? { ...i, inApp: false } : i))
    const put = jest.fn(async () => ({ items: next }))
    const prefs = await load({ get: jest.fn(async () => ({ items: ITEMS })), put })
    await prefs.load()
    await prefs.setInApp('ASSIGNED', false)
    expect(put).toHaveBeenCalledWith('/me/notification-preferences', { items: [{ category: 'ASSIGNED', inApp: false }] })
    expect(prefs.items.value).toEqual(next)
  })

  test('a failed PUT rethrows and keeps the previous list', async () => {
    const prefs = await load({ get: jest.fn(async () => ({ items: ITEMS })), put: jest.fn(async () => { throw new Error('down') }) })
    await prefs.load()
    await expect(prefs.setInApp('ASSIGNED', false)).rejects.toThrow('down')
    expect(prefs.items.value).toEqual(ITEMS)
  })
})
