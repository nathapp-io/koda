import { describe, expect, test, jest } from '@jest/globals'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, toastRecorder } from '../helpers/fleet-harness'
import * as Vue from 'vue'
import type { FleetFlowDto, FleetFlowPage } from '~/lib/fleet-flows'
const flow: FleetFlowDto = { id: 'f1', projectId: 'p1', repoId: 'r1', threadId: 't1', entry: 'THREAD', createdBy: { type: 'USER', id: 'u1' }, branch: 'main', specSha: 'sha', pinnedRunnerId: null, roles: { reviewer: 'r', supervisor: 's' }, costCapUsd: '9', spentUsd: '1', state: 'WAITING_ANSWER', approval: null, stopReason: null, stopDetail: null, endedAt: null, createdAt: '', features: [], url: '' }
const page = (records: FleetFlowDto[]): FleetFlowPage => ({ records, total: records.length, current: 1, size: 20, hasNext: false, hasPrev: false })
async function mountPanel(records: FleetFlowDto[], keys = ['fleet.flow.read'], reject = false) {
 const list = jest.fn(async (_page: number, _threadId?: string) => { if (reject) throw Error('nope'); return page(records) })
 const toast = toastRecorder()
 const mounted = mountSfc(webFile('components', 'fleet', 'threads', 'ThreadFlowsPanel.vue'), { props: { slug: 'web', threadId: 't1' }, globals: { onMounted: Vue.onMounted, watch: Vue.watch, useI18n: () => enI18n(), useAppToast: () => toast, useProjectPermissions: () => ({ permissions: { value: { has: (key: string) => keys.includes(key) } } }), useFleetFlows: () => ({ list }) }, alias: { '~/composables/useFleetFlows': { useFleetFlows: () => ({ list }) } }, components: { NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' } } })
 await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve))
 return { mounted, list, toast }
}
describe('ThreadFlowsPanel', () => {
 test('filters to the thread and links state rows; quietly hides empty, denied and failed reads', async () => {
  const shown = await mountPanel([flow]); expect(shown.list).toHaveBeenCalledWith(1, 't1'); expect(shown.mounted.text()).toContain('Waiting for answers'); expect(shown.mounted.find('a').some(a => a.props.href === '/web/flows/f1')).toBe(true); shown.mounted.unmount()
  const empty = await mountPanel([]); expect(empty.mounted.text()).toBe(''); empty.mounted.unmount()
  const denied = await mountPanel([flow], []); expect(denied.list).not.toHaveBeenCalled(); expect(denied.mounted.text()).toBe(''); denied.mounted.unmount()
  const failed = await mountPanel([flow], ['fleet.flow.read'], true); expect(failed.mounted.text()).toBe(''); expect(failed.toast.errors).toHaveLength(0); failed.mounted.unmount()
 })
})
