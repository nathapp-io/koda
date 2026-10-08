import { afterEach, describe, expect, jest, test } from '@jest/globals'
import * as Vue from 'vue'
import { ref } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, toastRecorder, uiStubs } from '../helpers/fleet-harness'
import type { NotificationDto } from '~/lib/notification-types'

const bell = webFile('components', 'NotificationBell.vue')
const row = (id: string, readAt: string | null = null, link = `/koda/tickets/KODA-${id}`): NotificationDto => ({
  id, category: 'ASSIGNED', kind: 'ticket_assigned', title: 'fallback', body: null, link,
  params: { ref: `KODA-${id}`, ticketTitle: 'Fix', actorName: 'Ann' }, projectId: 'p1', actorId: 'u2', readAt,
  createdAt: '2026-10-08T00:00:00.000Z',
})

afterEach(() => { jest.useRealTimers() })

function mount(opts: { count?: number; latest?: NotificationDto[]; refresh?: jest.Mock; markRead?: jest.Mock; markAllRead?: jest.Mock } = {}) {
  const unreadCount = ref(opts.count ?? 0)
  const latest = ref<NotificationDto[]>(opts.latest ?? [])
  const fake = {
    unreadCount, latest,
    refresh: opts.refresh ?? jest.fn(async () => undefined),
    markRead: opts.markRead ?? jest.fn(async () => undefined),
    markAllRead: opts.markAllRead ?? jest.fn(async () => undefined),
    list: jest.fn(),
  }
  let live: (() => void) | null = null
  const navigate = jest.fn(async () => undefined)
  const toast = toastRecorder()
  const app = mountSfc(bell, {
    components: uiStubs,
    alias: {
      '~/composables/useNotifications': { useNotifications: () => fake },
      '~/composables/useUserEvents': { useUserEvents: (fn: () => void) => { live = fn } },
    },
    globals: {
      useI18n: () => enI18n(),
      navigateTo: navigate,
      useAppToast: () => toast,
    },
  })
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 4; i += 1) {
      await new Promise((resolve) => { setImmediate(resolve) })
      await Vue.nextTick()
    }
  }
  const byId = (id: string) => app.find(`[data-testid="${id}"]`)
  return { app, fake, navigate, toast, settle, byId, live: () => live, unreadCount, latest }
}

describe('NotificationBell (S4a §5)', () => {
  test('loads on mount and shows the unread count, capped at 99+', async () => {
    const m = mount({ count: 3 })
    await m.settle()
    expect(m.fake.refresh).toHaveBeenCalledTimes(1)
    expect(m.byId('notification-bell')[0].props['data-count']).toBe(3)
    expect(m.app.textOf(m.byId('notification-bell-count')[0])).toBe('3')
    m.unreadCount.value = 150
    await m.settle()
    expect(m.app.textOf(m.byId('notification-bell-count')[0])).toBe('99+')
    m.app.unmount()
  })

  test('no count badge when nothing is unread', async () => {
    const m = mount({ count: 0 })
    await m.settle()
    expect(m.byId('notification-bell-count')).toHaveLength(0)
    expect(String(m.byId('notification-bell')[0].props['aria-label'])).toBe('Notifications, 0 unread')
    m.app.unmount()
  })

  test('a live notice refreshes after the 300 ms debounce', async () => {
    jest.useFakeTimers()
    const m = mount()
    m.live()?.()
    m.live()?.()
    jest.advanceTimersByTime(300)
    jest.useRealTimers()
    await m.settle()
    // once on mount + once for the two debounced notices
    expect(m.fake.refresh).toHaveBeenCalledTimes(2)
    m.app.unmount()
  })

  test('Esc closes the open panel while focus is still on the bell button (review fix, a11y)', async () => {
    const m = mount({ count: 1, latest: [row('1')] })
    await m.settle()
    ;(m.byId('notification-bell')[0].props.onClick as () => void)()
    await m.settle()
    expect(m.byId('notification-panel')).toHaveLength(1)
    // The button sits inside the root element, so a keydown on it bubbles to the root handler.
    const root = m.byId('notification-bell')[0].parent as { props: Record<string, unknown> }
    ;(root.props.onKeydown as (e: unknown) => void)({ key: 'Escape' })
    await m.settle()
    expect(m.byId('notification-panel')).toHaveLength(0)
    m.app.unmount()
  })

  test('opening the panel lists the latest items, worded from kind + params', async () => {
    const m = mount({ count: 1, latest: [row('1'), row('2', '2026-10-08T01:00:00.000Z')] })
    await m.settle()
    expect(m.byId('notification-panel')).toHaveLength(0)
    ;(m.byId('notification-bell')[0].props.onClick as () => void)()
    await m.settle()
    const items = m.byId('notification-item')
    expect(items).toHaveLength(2)
    expect(m.app.textOf(items[0])).toContain('Ann assigned you KODA-1: Fix')
    expect(String(items[0].props.class)).toContain('font-medium')
    expect(String(items[1].props.class)).toContain('text-muted-foreground')
    m.app.unmount()
  })

  test('clicking an unread item marks it read, closes the panel and navigates to its link', async () => {
    const m = mount({ count: 1, latest: [row('7')] })
    await m.settle()
    ;(m.byId('notification-bell')[0].props.onClick as () => void)()
    await m.settle()
    ;(m.byId('notification-item')[0].props.onClick as () => void)()
    await m.settle()
    expect(m.fake.markRead).toHaveBeenCalledWith('7')
    expect(m.navigate).toHaveBeenCalledWith('/koda/tickets/KODA-7')
    expect(m.byId('notification-panel')).toHaveLength(0)
    m.app.unmount()
  })

  test('a read item is not marked again; an off-site link is never followed', async () => {
    const m = mount({ latest: [row('8', '2026-10-08T01:00:00.000Z', '//evil.example/x')] })
    await m.settle()
    ;(m.byId('notification-bell')[0].props.onClick as () => void)()
    await m.settle()
    ;(m.byId('notification-item')[0].props.onClick as () => void)()
    await m.settle()
    expect(m.fake.markRead).not.toHaveBeenCalled()
    expect(m.navigate).not.toHaveBeenCalled()
    m.app.unmount()
  })

  test('a failed mark-read still navigates', async () => {
    const m = mount({ count: 1, latest: [row('9')], markRead: jest.fn(async () => { throw new Error('down') }) })
    await m.settle()
    ;(m.byId('notification-bell')[0].props.onClick as () => void)()
    await m.settle()
    ;(m.byId('notification-item')[0].props.onClick as () => void)()
    await m.settle()
    expect(m.navigate).toHaveBeenCalledWith('/koda/tickets/KODA-9')
    m.app.unmount()
  })

  test('Mark all read calls the composable and is disabled with nothing unread', async () => {
    const m = mount({ count: 2, latest: [row('1')] })
    await m.settle()
    ;(m.byId('notification-bell')[0].props.onClick as () => void)()
    await m.settle()
    expect(m.byId('notification-mark-all')[0].props.disabled).toBe(false)
    ;(m.byId('notification-mark-all')[0].props.onClick as () => void)()
    await m.settle()
    expect(m.fake.markAllRead).toHaveBeenCalledTimes(1)
    m.unreadCount.value = 0
    await m.settle()
    expect(m.byId('notification-mark-all')[0].props.disabled).toBe(true)
    m.app.unmount()
  })

  test('an empty inbox says so; View all links to /notifications', async () => {
    const m = mount()
    await m.settle()
    ;(m.byId('notification-bell')[0].props.onClick as () => void)()
    await m.settle()
    expect(m.app.textOf(m.byId('notification-empty')[0])).toBe("You're all caught up.")
    expect(m.byId('notification-view-all')[0].props.to).toBe('/notifications')
    m.app.unmount()
  })

  test('a failed first load leaves the bell at 0 without throwing', async () => {
    const m = mount({ refresh: jest.fn(async () => { throw new Error('down') }) })
    await m.settle()
    expect(m.byId('notification-bell')[0].props['data-count']).toBe(0)
    m.app.unmount()
  })
})
