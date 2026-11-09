import { describe, expect, test, jest } from '@jest/globals'
import * as Vue from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, toastRecorder } from '../helpers/fleet-harness'
import type { ThreadDetailDto } from '~/lib/thread-types'
import type { FleetFlowDto, FleetFlowPage } from '~/lib/fleet-flows'

const thread = (overrides: Partial<ThreadDetailDto> = {}): ThreadDetailDto => ({
  id: 't1', kind: 'REPO', repoId: 'r1', baseRef: 'main', feature: 'f-min', title: 'Thread', createdById: 'u1',
  runnerId: null, backend: { kind: 'native' }, status: 'ACTIVE', archivedAt: null, skills: [], maxCostUsd: '5',
  costUsd: '0', tokens: null, specPath: '.nax/features/f-min/spec.md', pendingQuestion: null, session: null,
  lastActivityAt: '', createdAt: '', activeJob: null, sendRefusal: null, writtenPaths: [], publishedSha: 'sha', specPublished: true,
  lastWrite: null, handoff: { plan: null, run: null }, preApproval: null, ...overrides,
})
const flow = (state: string): FleetFlowDto => ({
  id: `f-${state}`, projectId: 'p1', repoId: 'r1', threadId: 't1', entry: 'THREAD', createdBy: { type: 'USER', id: 'u1' },
  branch: 'main', specSha: 'sha', pinnedRunnerId: null, roles: { reviewer: 'r', supervisor: 's' }, costCapUsd: '9',
  spentUsd: '1', state, approval: null, stopReason: null, stopDetail: null, endedAt: null, createdAt: '', features: [], url: '',
})
const page = (records: FleetFlowDto[]): FleetFlowPage => ({ records, total: records.length, current: 1, size: 20, hasNext: false, hasPrev: false })

async function mountStart(records: FleetFlowDto[] = [], heldKeys = ['fleet.flow.create', 'fleet.flow.read'], reject = false) {
  const allowed = Vue.ref(heldKeys)
  const permissions = { value: { has: (key: string) => allowed.value.includes(key) } }
  const list = jest.fn(async (_page: number, _threadId: string) => {
    if (reject) throw new Error('read failed')
    return page(records)
  })
  const toast = toastRecorder()
  const mounted = mountSfc(webFile('components', 'fleet', 'threads', 'ThreadStartFlow.vue'), {
    props: { slug: 'web', thread: thread() },
    globals: { watch: Vue.watch, onMounted: Vue.onMounted, useI18n: () => enI18n(), useProjectPermissions: () => ({ permissions }), useAppToast: () => toast },
    alias: {
      '~/composables/useFleetFlows': { useFleetFlows: () => ({ list }) },
      '~/composables/useAuth': { useAuth: () => ({ user: Vue.ref({ id: 'u1' }) }) },
      '~/composables/useAppToast': { useAppToast: () => toast },
      '~/composables/useApi': { extractApiError: (error: unknown) => error instanceof Error ? error.message : 'API error' },
    },
    components: { FleetThreadsThreadStartFlowDialog: { props: ['open', 'thread', 'viewerId'], emits: ['submit', 'update:open'], template: '<div />' }, Button: { props: ['disabled'], template: '<button :disabled="disabled"><slot /></button>' } },
  })
  await Vue.nextTick()
  await new Promise(resolve => setImmediate(resolve))
  await Vue.nextTick()
  return { mounted, list, toast, grantRead: () => { allowed.value = [...allowed.value, 'fleet.flow.read'] } }
}

describe('ThreadStartFlow', () => {
  test('AC-1, AC-3 to AC-7: reflects publication and only live listed flows as blocked reasons', async () => {
    const available = await mountStart()
    expect(available.mounted.text()).toContain('Start flow')
    expect(available.mounted.one('button')?.props.disabled).toBe(false)
    available.mounted.unmount()

    const unpublished = await mountStart([], ['fleet.flow.create', 'fleet.flow.read'])
    unpublished.mounted.setProps({ thread: thread({ specPublished: false }) })
    await Vue.nextTick()
    expect(unpublished.mounted.one('button')?.props.disabled).toBe(true)
    expect(unpublished.mounted.text()).toContain('This thread has no published spec to start a flow from.')
    unpublished.mounted.unmount()

    const live = await mountStart([flow('RUNNING')])
    expect(live.mounted.one('button')?.props.disabled).toBe(true)
    expect(live.mounted.text()).toContain('A flow is already active for this thread.')
    live.mounted.unmount()

    const terminal = await mountStart([flow('COMPLETED'), flow('STOPPED')])
    expect(terminal.mounted.one('button')?.props.disabled).toBe(false)
    terminal.mounted.unmount()
  })

  test('AC-2: hides the control without fleet.flow.create', async () => {
    const result = await mountStart([], ['fleet.flow.read'])
    expect(result.mounted.text()).toBe('')
    result.mounted.unmount()
  })

  test('AC-8, AC-9, AC-10: skips unreadable flow list, and reads once on a late permission grant', async () => {
    const noRead = await mountStart([], ['fleet.flow.create'])
    expect(noRead.list).not.toHaveBeenCalled()
    expect(noRead.mounted.one('button')?.props.disabled).toBe(false)
    noRead.grantRead()
    await Vue.nextTick()
    await new Promise(resolve => setImmediate(resolve))
    expect(noRead.list).toHaveBeenCalledTimes(1)
    expect(noRead.list).toHaveBeenCalledWith(1, 't1')
    noRead.mounted.unmount()
  })

  test('AC-11, AC-12: treats list failure as no live flow without a toast', async () => {
    const result = await mountStart([], ['fleet.flow.create', 'fleet.flow.read'], true)
    expect(result.mounted.one('button')?.props.disabled).toBe(false)
    expect(result.toast.errors).toHaveLength(0)
    expect(result.toast.successes).toHaveLength(0)
    result.mounted.unmount()
  })
})
