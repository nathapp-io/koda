import { afterEach, describe, expect, jest, test } from '@jest/globals'
import { ref } from 'vue'
import type { Ref } from 'vue'
import type { NotificationDto, NotificationPage } from '~/lib/notification-types'

const g = globalThis as Record<string, unknown>
const row = (id: string, readAt: string | null = null): NotificationDto => ({
  id, category: 'ASSIGNED', kind: 'ticket_assigned', title: 't', body: null, link: '/k/tickets/K-1', params: {},
  projectId: 'p1', actorId: 'u2', readAt, createdAt: '2026-10-08T00:00:00.000Z',
})
const page = (records: NotificationDto[], over: Partial<NotificationPage> = {}): NotificationPage =>
  ({ records, total: records.length, size: 10, current: 1, hasNext: false, ...over })

const state = new Map<string, Ref>()
let signedIn: { id: string } | null = { id: 'u1' }

async function load(api: { get: jest.Mock; post?: jest.Mock }) {
  g.useAuth = () => ({ user: ref(signedIn) })
  g.useApi = () => ({ $api: { post: jest.fn(async () => undefined), ...api } })
  g.useState = (key: string, init: () => unknown) => { if (!state.has(key)) state.set(key, ref(init())); return state.get(key) }
  return (await import('~/composables/useNotifications')).useNotifications()
}

describe('useNotifications (S4a §5)', () => {
  afterEach(() => { delete g.useApi; delete g.useState; delete g.useAuth; state.clear(); signedIn = { id: 'u1' } })

  test('refresh loads the unread count and the latest 10', async () => {
    const get = jest.fn(async (path: string) => (path.endsWith('/unread-count') ? { count: 3 } : page([row('a'), row('b')])))
    const n = await load({ get })
    await n.refresh()
    expect(get).toHaveBeenCalledWith('/me/notifications/unread-count')
    expect(get).toHaveBeenCalledWith('/me/notifications', { query: { current: '1', size: '10' } })
    expect(n.unreadCount.value).toBe(3)
    expect(n.latest.value.map((r) => r.id)).toEqual(['a', 'b'])
  })

  test('markRead posts to the encoded id route, then refreshes', async () => {
    const get = jest.fn(async (path: string) => (path.endsWith('/unread-count') ? { count: 0 } : page([])))
    const post = jest.fn(async () => undefined)
    const n = await load({ get, post })
    await n.markRead('c1/../x')
    expect(post).toHaveBeenCalledWith('/me/notifications/c1%2F..%2Fx/read')
    expect(get).toHaveBeenCalledWith('/me/notifications/unread-count')
  })

  test('markAllRead posts read-all, then refreshes', async () => {
    const get = jest.fn(async (path: string) => (path.endsWith('/unread-count') ? { count: 0 } : page([])))
    const post = jest.fn(async () => undefined)
    const n = await load({ get, post })
    await n.markAllRead()
    expect(post).toHaveBeenCalledWith('/me/notifications/read-all')
    expect(n.unreadCount.value).toBe(0)
  })

  test('list passes the page, a page size of 20 and the unread filter only when set', async () => {
    const get = jest.fn(async () => page([], { current: 2 }))
    const n = await load({ get })
    await n.list({ current: 2, unreadOnly: false })
    await n.list({ current: 1, unreadOnly: true })
    expect(get).toHaveBeenNthCalledWith(1, '/me/notifications', { query: { current: '2', size: '20' } })
    expect(get).toHaveBeenNthCalledWith(2, '/me/notifications', { query: { current: '1', size: '20', unread: 'true' } })
  })

  test('state is shared between callers in one tab (bell and page)', async () => {
    const get = jest.fn(async (path: string) => (path.endsWith('/unread-count') ? { count: 7 } : page([])))
    g.useAuth = () => ({ user: ref({ id: 'u1' }) })
    g.useApi = () => ({ $api: { get, post: jest.fn() } })
    g.useState = (key: string, init: () => unknown) => { if (!state.has(key)) state.set(key, ref(init())); return state.get(key) }
    const mod = await import('~/composables/useNotifications')
    await mod.useNotifications().refresh()
    expect(mod.useNotifications().unreadCount.value).toBe(7)
  })

  test('state is per signed-in user: the next user on this tab never sees the previous inbox (review fix)', async () => {
    const get = jest.fn(async (path: string) => (path.endsWith('/unread-count') ? { count: 4 } : page([row('secret')])))
    const first = await load({ get })
    await first.refresh()
    expect(first.latest.value.map((r) => r.id)).toEqual(['secret'])
    signedIn = { id: 'u2' }
    const second = await load({ get: jest.fn(async () => new Promise(() => undefined)) })
    expect(second.unreadCount.value).toBe(0)
    expect(second.latest.value).toEqual([])
  })
})
