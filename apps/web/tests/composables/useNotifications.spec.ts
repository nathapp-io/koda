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

interface Deferred<T> { promise: Promise<T>; resolve: (value: T) => void; reject: (err: unknown) => void }

/** A promise the test settles by hand, so it decides whose refresh answers first. */
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

/**
 * An api double whose reads stay pending until the test answers them, one pair per refresh: that is what lets a test
 * let a refresh that started first answer last, which is the race K16 is about.
 */
function controlledApi() {
  const pending: Array<{ path: string; answer: Deferred<unknown> }> = []
  const get = jest.fn((path: string) => {
    const answer = deferred<unknown>()
    pending.push({ path, answer })
    return answer.promise
  })
  const settle = (each: (call: { path: string; answer: Deferred<unknown> }) => void): void => { pending.splice(0).forEach(each) }
  return {
    get,
    /** Answers both outstanding reads of one refresh with `count` and `records`. */
    answer: (count: number, records: NotificationDto[]) => settle((call) => {
      call.answer.resolve(call.path.endsWith('/unread-count') ? { count } : page(records))
    }),
    fail: (err: unknown) => settle((call) => { call.answer.reject(err) }),
  }
}

/** Let a settled promise's continuations run: markAllRead's post, then its refresh's two reads. */
async function flush(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await Promise.resolve()
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

  // K16: a bell refresh that started earlier must not put the badge back to unread after a newer refresh answered.
  test('a bell refresh that started first cannot undo a newer inbox refresh', async () => {
    const bell = controlledApi()
    const bellInbox = await load({ get: bell.get })
    const bellRun = bellInbox.refresh()
    const inbox = controlledApi()
    const inboxPage = await load({ get: inbox.get })
    const inboxRun = inboxPage.refresh()
    inbox.answer(0, [])
    await inboxRun
    expect(inboxPage.unreadCount.value).toBe(0)
    bell.answer(5, [])
    await bellRun
    expect(bellInbox.unreadCount.value).toBe(0)
  })

  test('the newest refresh owns the records, not just the count', async () => {
    const bell = controlledApi()
    const bellInbox = await load({ get: bell.get })
    const bellRun = bellInbox.refresh()
    const inbox = controlledApi()
    const inboxPage = await load({ get: inbox.get })
    const inboxRun = inboxPage.refresh()
    inbox.answer(0, [row('inbox')])
    await inboxRun
    bell.answer(5, [row('bell')])
    await bellRun
    expect(bellInbox.latest.value.map((r) => r.id)).toEqual(['inbox'])
  })

  test('Mark all read on one instance is not undone by a pending refresh of the other', async () => {
    const bell = controlledApi()
    const bellInbox = await load({ get: bell.get })
    const bellRun = bellInbox.refresh()
    const inbox = controlledApi()
    const inboxPage = await load({ get: inbox.get })
    const readAll = inboxPage.markAllRead()
    await flush()
    expect(inbox.get).toHaveBeenCalledTimes(2)
    inbox.answer(0, [])
    await readAll
    expect(inboxPage.unreadCount.value).toBe(0)
    bell.answer(5, [])
    await bellRun
    expect(bellInbox.unreadCount.value).toBe(0)
  })

  test('a failed newest refresh still supersedes the older one', async () => {
    state.set('notifications-unread:u1', ref(2))
    const bell = controlledApi()
    const bellInbox = await load({ get: bell.get })
    const bellRun = bellInbox.refresh()
    const inbox = controlledApi()
    const inboxPage = await load({ get: inbox.get })
    const inboxRun = inboxPage.refresh()
    inbox.fail(new Error('offline'))
    await expect(inboxRun).rejects.toThrow('offline')
    bell.answer(5, [])
    await bellRun
    expect(bellInbox.unreadCount.value).toBe(2)
  })
})
