import { describe, expect, jest, test } from '@jest/globals'
import { ref } from 'vue'
import * as Vue from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'
import type { NotificationDto, NotificationPage } from '~/lib/notification-types'

const record: NotificationDto = { id: 'n1', category: 'FLEET_NEEDS_YOU', kind: 'flow_stopped', title: 'Flow stopped', body: 'SPEC_REVIEW job cmw82: no verdict JSON', link: '/acme/flows/f12', params: { flowId: 'f12', feature: 'f12-max', stopReason: 'verdict_unreadable' }, projectId: 'p1', actorId: null, readAt: null, createdAt: '2026-10-08T00:00:00Z' }
const page: NotificationPage = { records: [record], total: 1, size: 20, current: 1, hasNext: false }

describe('flow notification wording', () => {
  test('AC-6 inbox renders translated stop detail rather than raw server body', async () => {
    const app = mountSfc(webFile('pages', 'notifications.vue'), {
      components: uiStubs,
      alias: { '~/composables/useNotifications': { useNotifications: () => ({ list: jest.fn(async () => page), markRead: jest.fn(), markAllRead: jest.fn(), unreadCount: ref(1) }) }, '~/composables/useUserEvents': { useUserEvents: jest.fn() } },
      globals: { useI18n: () => enI18n(), useAppToast: () => ({ error: jest.fn() }), definePageMeta: jest.fn(), navigateTo: jest.fn() },
    })
    for (let i = 0; i < 5; i++) { await new Promise(resolve => setImmediate(resolve)); await Vue.nextTick() }
    expect(app.text()).toContain('Verdict unreadable')
    expect(app.text()).not.toContain('SPEC_REVIEW')
    app.unmount()
  })

  test('AC-7 bell renders translated stop detail once its panel is opened', async () => {
    const fake = { unreadCount: ref(1), latest: ref([record]), refresh: jest.fn(async () => undefined), markRead: jest.fn(), markAllRead: jest.fn() }
    const app = mountSfc(webFile('components', 'NotificationBell.vue'), {
      components: uiStubs,
      alias: { '~/composables/useNotifications': { useNotifications: () => fake }, '~/composables/useUserEvents': { useUserEvents: jest.fn() } },
      globals: { useI18n: () => enI18n(), useAppToast: () => ({ error: jest.fn() }), navigateTo: jest.fn() },
    })
    app.find('[data-testid="notification-bell"]')[0].props.onClick()
    await Vue.nextTick()
    expect(app.text()).toContain('Verdict unreadable')
    expect(app.text()).not.toContain('SPEC_REVIEW')
    app.unmount()
  })
})
