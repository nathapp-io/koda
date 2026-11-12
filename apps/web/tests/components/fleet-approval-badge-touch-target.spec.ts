import { expect, jest, test } from '@jest/globals'
import { computed, ref, watch } from 'vue'
import * as Vue from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'
import * as api from '../../composables/useApi'
import * as inbox from '../../composables/useApprovalInbox'

function mount(supported: boolean) {
  const get = jest.fn(async () => ({ total: 1, unscoped: 0, projects: [] }))
  ;(globalThis as Record<string, unknown>).useApi = () => ({ $api: { get } })
  const notifications = { refresh: jest.fn(async () => undefined), decided: jest.fn(), enabled: ref(false), supported: ref(supported), toggleBrowserNotifications: jest.fn() }
  const app = mountSfc(webFile('components','fleet','ApprovalBadge.vue'), { props: { slug: 'web' }, components: uiStubs, alias: { '~/composables/useApi': api, '~/composables/useApprovalInbox': inbox, '~/composables/useApprovalRequestNotifications': { useApprovalRequestNotifications: () => notifications } }, globals: { ref, computed, watch, onMounted: Vue.onMounted, onBeforeUnmount: Vue.onBeforeUnmount, useI18n: () => enI18n(), useApi: () => ({ $api: { get } }), useAuth: () => ({ user: ref({ id: 'u1', role: 'MEMBER' }) }), useState: (_k: string, init: () => unknown) => ref(init()), useGlobalPermissions: () => ({ permissions: computed(() => ({ mayDecide: () => false })) }), useVisiblePolling: () => ({ start: jest.fn(), stop: jest.fn(), runNow: async () => undefined }), useProjectEvents: () => undefined, useHead: () => undefined, useAppToast: () => jest.fn() } })
  return app
}
test('AC-2: supported browser toggle has a responsive hit target', async () => {
 const app=mount(true); for(let i=0;i<6;i++) { await new Promise(r=>setImmediate(r)); await Vue.nextTick() }
 const node=app.find('[data-testid="fleet-approval-notifications"]')[0]
 for(const token of ['h-11','w-11','sm:h-9','sm:w-9']) expect(node.props.class).toContain(token)
 app.unmount()
})
test('AC-7: unsupported browser does not render the toggle', async () => {
 const app=mount(false); for(let i=0;i<6;i++) { await new Promise(r=>setImmediate(r)); await Vue.nextTick() }
 expect(app.find('[data-testid="fleet-approval-notifications"]')).toHaveLength(0)
 app.unmount()
})
