import { afterEach, describe, expect, jest, test } from '@jest/globals'

const g = globalThis as Record<string, unknown>
const ITEMS = [
  { category: 'ASSIGNED', inApp: true, email: true }, { category: 'MENTIONED', inApp: true, email: false }, { category: 'WATCHED_ACTIVITY', inApp: false, email: true },
  { category: 'FLEET_NEEDS_YOU', inApp: true, email: true }, { category: 'FLEET_HEALTH', inApp: true, email: false },
]
const VIEW = { emailAvailable: true, emailEnabled: true, items: ITEMS }

async function load(api: Record<string, jest.Mock>) {
  g.useApi = () => ({ $api: api })
  return (await import('~/composables/useNotificationPreferences')).useNotificationPreferences()
}

describe('useNotificationPreferences (S4a §3)', () => {
  afterEach(() => { delete g.useApi })

  test('load stores email settings and all category preferences', async () => {
    const get = jest.fn(async () => VIEW)
    const prefs = await load({ get })
    await prefs.load()
    expect(get).toHaveBeenCalledWith('/me/notification-preferences')
    expect(prefs.view.value).toEqual(VIEW)
  })

  test('setInApp PUTs one change and keeps the returned list', async () => {
    const next = ITEMS.map((i) => (i.category === 'MENTIONED' ? { ...i, inApp: false } : i))
    const put = jest.fn(async () => ({ ...VIEW, items: next }))
    const prefs = await load({ get: jest.fn(async () => VIEW), put })
    await prefs.load()
    await prefs.setInApp('MENTIONED', false)
    expect(put).toHaveBeenCalledWith('/me/notification-preferences', { items: [{ category: 'MENTIONED', inApp: false }] })
    expect(prefs.view.value.items).toEqual(next)
  })

  test('setEmail persists only the email field', async () => {
    const put = jest.fn(async () => VIEW)
    const prefs = await load({ get: jest.fn(async () => VIEW), put })
    await prefs.setEmail('MENTIONED', false)
    expect(put).toHaveBeenCalledWith('/me/notification-preferences', { items: [{ category: 'MENTIONED', email: false }] })
  })

  test('setEmailEnabled persists only the master field', async () => {
    const put = jest.fn(async () => VIEW)
    const prefs = await load({ get: jest.fn(async () => VIEW), put })
    await prefs.setEmailEnabled(false)
    expect(put).toHaveBeenCalledWith('/me/notification-preferences', { emailEnabled: false })
  })

  test('a failed PUT rethrows and keeps the previous list', async () => {
    const prefs = await load({ get: jest.fn(async () => VIEW), put: jest.fn(async () => { throw new Error('down') }) })
    await prefs.load()
    await expect(prefs.setInApp('ASSIGNED', false)).rejects.toThrow('down')
    expect(prefs.view.value).toEqual(VIEW)
  })
})
