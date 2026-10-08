import { describe, expect, jest, test } from '@jest/globals'
import * as Vue from 'vue'
import { ref } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, toastRecorder, uiStubs } from '../helpers/fleet-harness'
import type { NotificationDto, NotificationPage } from '~/lib/notification-types'

const page = webFile('pages', 'notifications.vue')
const row = (id: string, readAt: string | null = null): NotificationDto => ({
  id, category: 'WATCHED_ACTIVITY', kind: 'ticket_commented', title: 't', body: 'nice fix', link: `/koda/tickets/KODA-${id}`,
  params: { ref: `KODA-${id}`, ticketTitle: 'x', actorName: 'Bo' }, projectId: 'p1', actorId: 'u2', readAt,
  createdAt: '2026-10-08T00:00:00.000Z',
})
const pageOf = (records: NotificationDto[], over: Partial<NotificationPage> = {}): NotificationPage =>
  ({ records, total: records.length, size: 20, current: 1, hasNext: false, ...over })

function mountPage(list: jest.Mock, opts: { markRead?: jest.Mock; markAllRead?: jest.Mock } = {}) {
  const fake = {
    unreadCount: ref(1), latest: ref([]), refresh: jest.fn(async () => undefined), list,
    markRead: opts.markRead ?? jest.fn(async () => undefined),
    markAllRead: opts.markAllRead ?? jest.fn(async () => undefined),
  }
  let live: (() => void) | null = null
  const navigate = jest.fn(async () => undefined)
  const toast = toastRecorder()
  const app = mountSfc(page, {
    components: uiStubs,
    alias: {
      '~/composables/useNotifications': { useNotifications: () => fake },
      '~/composables/useUserEvents': { useUserEvents: (fn: () => void) => { live = fn } },
    },
    globals: { useI18n: () => enI18n(), navigateTo: navigate, useAppToast: () => toast, definePageMeta: () => undefined },
  })
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 6; i += 1) {
      await new Promise((resolve) => { setImmediate(resolve) })
      await Vue.nextTick()
    }
  }
  const byId = (id: string) => app.find(`[data-testid="${id}"]`)
  const click = (id: string, index = 0) => (byId(id)[index].props.onClick as () => void)()
  return { app, fake, navigate, toast, settle, byId, click, live: () => live }
}

describe('/notifications (S4a §5)', () => {
  test('loads page 1 of everything on mount', async () => {
    const list = jest.fn(async () => pageOf([row('1'), row('2', '2026-10-08T01:00:00.000Z')]))
    const p = mountPage(list)
    await p.settle()
    expect(list).toHaveBeenCalledWith({ current: 1, unreadOnly: false })
    expect(p.byId('notifications-row')).toHaveLength(2)
    expect(p.app.textOf(p.byId('notifications-row')[0])).toContain('Bo commented on KODA-1')
    expect(p.app.textOf(p.byId('notifications-row')[0])).toContain('nice fix')
  })

  test('the Unread filter reloads page 1 with unreadOnly', async () => {
    const list = jest.fn(async () => pageOf([]))
    const p = mountPage(list)
    await p.settle()
    p.click('notifications-filter-unread')
    await p.settle()
    expect(list).toHaveBeenLastCalledWith({ current: 1, unreadOnly: true })
    expect(p.app.textOf(p.byId('notifications-empty')[0])).toBe('No unread notifications.')
    expect(p.byId('notifications-filter-unread')[0].props['aria-pressed']).toBe('true')
  })

  test('Next and Previous page through the list', async () => {
    const list = jest.fn(async (opts: { current: number }) => pageOf([row(String(opts.current))], { current: opts.current, hasNext: opts.current === 1 }))
    const p = mountPage(list as jest.Mock)
    await p.settle()
    expect(p.byId('notifications-prev')[0].props.disabled).toBe(true)
    p.click('notifications-next')
    await p.settle()
    expect(list).toHaveBeenLastCalledWith({ current: 2, unreadOnly: false })
    expect(p.byId('notifications-next')[0].props.disabled).toBe(true)
    p.click('notifications-prev')
    await p.settle()
    expect(list).toHaveBeenLastCalledWith({ current: 1, unreadOnly: false })
  })

  test('opening an unread row marks it read and navigates', async () => {
    const p = mountPage(jest.fn(async () => pageOf([row('5')])))
    await p.settle()
    p.click('notifications-row')
    await p.settle()
    expect(p.fake.markRead).toHaveBeenCalledWith('5')
    expect(p.navigate).toHaveBeenCalledWith('/koda/tickets/KODA-5')
  })

  test('Mark all read reloads the current page; a failure is reported', async () => {
    const list = jest.fn(async () => pageOf([row('1')]))
    const p = mountPage(list, { markAllRead: jest.fn(async () => { throw new Error('nope') }) })
    await p.settle()
    p.click('notifications-mark-all')
    await p.settle()
    expect(p.toast.errors).toEqual(['nope'])
  })

  test('a live notice reloads the page shown', async () => {
    const list = jest.fn(async () => pageOf([]))
    const p = mountPage(list)
    await p.settle()
    p.live()?.()
    await new Promise((resolve) => { setTimeout(resolve, 320) })
    await p.settle()
    expect(list).toHaveBeenCalledTimes(2)
  })

  test('a failed load shows the error state with retry', async () => {
    const list = jest.fn<() => Promise<NotificationPage>>().mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce(pageOf([row('1')]))
    const p = mountPage(list as jest.Mock)
    await p.settle()
    const error = p.app.find('[data-stub="error-state"]')
    expect(error).toHaveLength(1)
    ;(error[0].props.onRetry as () => void)()
    await p.settle()
    expect(p.byId('notifications-row')).toHaveLength(1)
  })
})
