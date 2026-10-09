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

  test('serializes concurrent writes so an older response cannot overwrite the newer view', async () => {
    let resolveFirst!: (value: typeof VIEW) => void
    let resolveSecond!: (value: typeof VIEW) => void
    const firstResponse = new Promise<typeof VIEW>((resolve) => { resolveFirst = resolve })
    const secondResponse = new Promise<typeof VIEW>((resolve) => { resolveSecond = resolve })
    const put = jest.fn()
      .mockReturnValueOnce(firstResponse)
      .mockReturnValueOnce(secondResponse)
    const prefs = await load({ get: jest.fn(async () => VIEW), put })
    await prefs.load()

    const first = prefs.setEmail('MENTIONED', true)
    const second = prefs.setEmailEnabled(false)
    await Promise.resolve()
    expect(put).toHaveBeenCalledTimes(1)
    resolveFirst({ ...VIEW, items: ITEMS.map((item) => item.category === 'MENTIONED' ? { ...item, email: true } : item) })
    await first
    await Promise.resolve()
    expect(put).toHaveBeenCalledTimes(2)
    resolveSecond({ ...VIEW, emailEnabled: false, items: ITEMS.map((item) => item.category === 'MENTIONED' ? { ...item, email: true } : item) })
    await second
    expect(prefs.view.value.emailEnabled).toBe(false)
    expect(prefs.view.value.items.find((item) => item.category === 'MENTIONED')?.email).toBe(true)
  })

  test('a failed PUT rethrows and keeps the previous list', async () => {
    const prefs = await load({ get: jest.fn(async () => VIEW), put: jest.fn(async () => { throw new Error('down') }) })
    await prefs.load()
    await expect(prefs.setInApp('ASSIGNED', false)).rejects.toThrow('down')
    expect(prefs.view.value).toEqual(VIEW)
  })
})
