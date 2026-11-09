import { describe, expect, test, jest } from '@jest/globals'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, toastRecorder } from '../helpers/fleet-harness'
import type { FleetFlowDto, FleetFlowPage } from '~/lib/fleet-flows'

const flow = (id: string): FleetFlowDto => ({ id, projectId: 'p1', repoId: 'r1', threadId: null, entry: 'THREAD', createdBy: { type: 'USER', id: 'u1' }, branch: 'main', specSha: 'sha', pinnedRunnerId: null, roles: { reviewer: 'r', supervisor: 's' }, costCapUsd: '9.0000', spentUsd: '1.2500', state: 'RUNNING', approval: null, stopReason: null, stopDetail: null, endedAt: null, createdAt: '2026-01-01T00:00:00.000Z', features: ['alpha','beta'].map(feature => ({ feature, specPath: '', branch: null, dependsOn: [], state: 'RUNNING', currentStep: null, prNumber: null, questionsJobId: null, questions: null, answers: null, answeredAt: null })), url: '' })
const page = (records: FleetFlowDto[], over: Partial<FleetFlowPage> = {}): FleetFlowPage => ({ records, total: records.length, current: 1, size: 20, hasNext: false, hasPrev: false, ...over })
async function mountList(result: FleetFlowPage | Error) {
  const list = jest.fn(async (current: number) => { if (result instanceof Error) throw result; return { ...result, current } })
  const toast = toastRecorder()
  const mounted = mountSfc(webFile('pages', '[project]', 'flows', 'index.vue'), { globals: { useRoute: () => ({ params: { project: 'web' } }), useI18n: () => enI18n(), useAppToast: () => toast, useFleetFlows: () => ({ list }), formatUsd: (v: string) => `$${Number(v).toFixed(2)}`, useLocalePath: () => (p: string) => p }, alias: { '~/composables/useFleetFlows': { useFleetFlows: () => ({ list }) } }, components: { NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' } } })
  await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve))
  return { mounted, list, toast }
}
describe('project fleet flows list', () => {
  test('loads page one with linked rows, feature names, spend, cap and pagination', async () => {
    const m = await mountList(page([flow('f1')], { hasNext: true }))
    expect(m.list).toHaveBeenCalledWith(1)
    expect(m.mounted.find('a').some(a => a.props.href === '/web/flows/f1')).toBe(true)
    expect(m.mounted.text()).toContain('alpha'); expect(m.mounted.text()).toContain('Running')
    expect(m.mounted.text()).toContain('$1.25'); expect(m.mounted.text()).toContain('$9.00')
    const next = m.mounted.find('button').find(b => b.props['data-testid'] === 'flows-next')
    await (next?.props.onClick as () => Promise<void>)(); expect(m.list).toHaveBeenLastCalledWith(2)
    expect(m.mounted.find('button').find(b => b.props['data-testid'] === 'flows-prev')?.props.disabled).toBe(true)
    m.mounted.unmount()
  })
  test('empty state and failure toast without rows', async () => {
    const empty = await mountList(page([])); expect(empty.mounted.text()).toContain('No flows yet'); empty.mounted.unmount()
    const err = new Error('read failed'); const failed = await mountList(err)
    expect(failed.toast.errors).toContain('read failed'); expect(failed.mounted.find('a')).toHaveLength(0); failed.mounted.unmount()
  })
})
