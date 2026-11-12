import { expect, jest, test } from '@jest/globals'
import * as Vue from 'vue'
import { computed, h, ref, watch } from 'vue'
import type { VNodeChild } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'
import { permissionSet } from '~/lib/permissions'

const entry = { id: 'e1', key: 'ticket.create', resourceType: 'ticket', resourceId: 't1', projectId: 'p1', actor: { type: 'USER', id: 'u1' }, onBehalfOf: null, origin: 'rest', approval: { requiredMode: 'none', satisfiedBy: 'none', approverType: null, approverId: null, requestId: null }, correlationId: 'c1', summary: 'created', display: { actor: 'Ada', onBehalfOf: null, approver: null, project: { slug: 'web', name: 'Web' } }, createdAt: '2026-10-01T10:00:00Z' }
test('AC-1: one audit entry has a responsive expand hit target', async () => {
  const get = jest.fn(async (path: string) => path === '/audit/keys' ? { keys: [] } : ({ records: [entry], total: 1, current: 1, size: 50, hasNext: false, hasPrev: false }))
  const FilterBar = { setup(_p: unknown, { slots }: { slots: { default?: () => unknown } }) { return () => h('div', {}, slots.default?.() as VNodeChild) } }
  const { FleetNativeSelect: _drop, ...components } = uiStubs
  const app = mountSfc(webFile('pages','admin','audit.vue'), { components: { ...components, FilterBar }, fleetComponents: ['FleetNativeSelect'], globals: { ref, computed, watch, onMounted: Vue.onMounted, useI18n: () => enI18n(), useAppToast: () => ({ error: jest.fn() }), useApi: () => ({ $api: { get } }), useRoute: () => ({ query: {}, params: {} }), useRouter: () => ({ replace: jest.fn() }), useGlobalPermissions: () => ({ permissions: computed(() => permissionSet(['audit.read'])), pending: ref(false), error: ref(null), refresh: async () => undefined }), definePageMeta: () => undefined } })
  for (let i=0;i<6;i++) { await new Promise(resolve => setImmediate(resolve)); await Vue.nextTick() }
  const button = app.find('[data-testid="audit-expand"]')[0]
  expect(button.props.class).toEqual(expect.stringContaining('h-11'))
  for (const token of ['w-11','sm:h-8','sm:w-8']) expect(button.props.class).toContain(token)
  app.unmount()
})
