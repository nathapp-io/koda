import { afterEach, describe, expect, jest, test } from '@jest/globals'
import { ApiError, extractApiError } from '~/composables/useApi'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import type { FleetFlowDto, FleetFlowOverviewDto } from '~/lib/fleet-flows'

const flow = (state = 'RUNNING'): FleetFlowDto => ({
  id: 'flow-1', projectId: 'p-1', repoId: 'r-1', threadId: null, entry: 'THREAD',
  createdBy: { type: 'USER', id: 'creator' }, branch: 'feature/branch', specSha: 'sha', pinnedRunnerId: null,
  roles: { reviewer: 'reviewer', supervisor: 'supervisor' }, costCapUsd: '10.0000', spentUsd: '2.0000',
  state, approval: null, stopReason: null, stopDetail: null, endedAt: null,
  createdAt: '2026-01-02T03:04:05.000Z', features: [], url: '/web/flows/flow-1',
})
const overview: FleetFlowOverviewDto = { repo: null, ticketRef: null, jobs: [], truncated: false, unknownCostCount: 0 }

afterEach(() => {
  delete (globalThis as { window?: unknown }).window
})

async function mountPage(options: {
  state?: string
  allowed?: boolean
  stop?: jest.Mock<() => Promise<{ kind: 'done'; flow: FleetFlowDto } | { kind: 'pending'; request: { permissionKey: string } }>>
  get?: jest.Mock<() => Promise<FleetFlowDto>>
} = {}) {
  const get = options.get ?? jest.fn<() => Promise<FleetFlowDto>>().mockResolvedValue(flow(options.state))
  const overviewGet = jest.fn<() => Promise<FleetFlowOverviewDto>>().mockResolvedValue(overview)
  const stop = options.stop ?? jest.fn<() => Promise<{ kind: 'done'; flow: FleetFlowDto } | { kind: 'pending'; request: { permissionKey: string } }>>().mockResolvedValue({ kind: 'done', flow: flow('STOPPED') })
  const success = jest.fn()
  const error = jest.fn()
  const toast = { success, error }
  const confirm = jest.fn(() => true)
  ;(globalThis as { window?: { confirm: jest.Mock } }).window = { confirm }
  const mounted = mountSfc(webFile('pages', '[project]', 'flows', '[id].vue'), {
    globals: {
      useRoute: () => ({ params: { project: 'web', id: 'flow-1' } }),
      useI18n: () => ({ t: (key: string) => key }),
      useAppToast: () => toast,
      useFleetFlows: () => ({ get, overview: overviewGet, stop }),
      useProjectMemberNames: () => ({ members: [], load: jest.fn<() => Promise<void>>().mockResolvedValue(undefined), nameOf: () => null }),
      useProjectPermissions: () => ({ permissions: { value: { has: (key: string) => key === 'fleet.flow.stop' && (options.allowed ?? true) } } }),
    },
    alias: {
      '~/composables/useFleetFlows': { useFleetFlows: () => ({ get, overview: overviewGet, stop }) },
      '~/composables/useVisiblePolling': { useVisiblePolling: () => ({ start: jest.fn(), stop: jest.fn(), runNow: async () => undefined, isActive: () => false }) },
      '~/composables/useApi': { ApiError, extractApiError },
      '~/composables/useProjectMemberNames': { useProjectMemberNames: () => ({ members: [], load: jest.fn<() => Promise<void>>().mockResolvedValue(undefined), nameOf: () => null }) },
      '~/composables/usePermissions': { useProjectPermissions: () => ({ permissions: { value: { has: (key: string) => key === 'fleet.flow.stop' && (options.allowed ?? true) } } }) },
    },
    components: {
      LoadingState: { template: '<div>loading</div>' },
      FlowFeatureSection: { template: '<article />' },
      PageHeader: { template: '<header><slot name="actions" /></header>', props: ['title', 'subtitle'] },
      NuxtLink: { template: '<a :href="to"><slot /></a>', props: ['to'] },
    },
  })
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  return { mounted, get, stop, success, error, confirm }
}

async function clickStop(mounted: Awaited<ReturnType<typeof mountPage>>['mounted']): Promise<void> {
  const button = mounted.find('button').find(node => mounted.textOf(node) === 'fleet.flows.stop.button')
  if (!button) throw new Error('Stop button not found')
  ;(button.props.onClick as (() => void) | undefined)?.()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('fleet flow Stop action (US-008)', () => {
  test('AC-1 Stop appears for a live flow with permission', async () => {
    const page = await mountPage()
    expect(page.mounted.find('button').some(node => page.mounted.textOf(node) === 'fleet.flows.stop.button')).toBe(true)
    page.mounted.unmount()
  })

  test('AC-2 Stop is hidden without permission and flow header remains visible', async () => {
    const page = await mountPage({ allowed: false })
    expect(page.mounted.find('button')).toHaveLength(0)
    expect(page.mounted.text()).toContain('feature/branch')
    expect(page.mounted.text()).toContain('$2.00 / $10.00')
    page.mounted.unmount()
  })

  test('AC-3 Stop is hidden for completed flow', async () => {
    const page = await mountPage({ state: 'COMPLETED' })
    expect(page.mounted.find('button')).toHaveLength(0)
    page.mounted.unmount()
  })

  test('AC-4 declining confirmation does not call stop', async () => {
    const page = await mountPage()
    page.confirm.mockReturnValue(false)
    await clickStop(page.mounted)
    expect(page.confirm).toHaveBeenCalled()
    expect(page.stop).not.toHaveBeenCalled()
    page.mounted.unmount()
  })

  test('AC-5 confirms stop, reports done and reloads the flow', async () => {
    const page = await mountPage()
    await clickStop(page.mounted)
    expect(page.stop).toHaveBeenCalledWith('flow-1')
    expect(page.success).toHaveBeenCalledWith('fleet.flows.toast.stopped')
    expect(page.get).toHaveBeenCalledTimes(2)
    page.mounted.unmount()
  })

  test('AC-6 and AC-9 pending stop links to approvals and reloads the flow', async () => {
    const stop = jest.fn<() => Promise<{ kind: 'pending'; request: { permissionKey: string } }>>().mockResolvedValue({ kind: 'pending', request: { permissionKey: 'fleet.flow.stop' } })
    const page = await mountPage({ stop })
    await clickStop(page.mounted)
    expect(page.success).toHaveBeenCalledWith('fleet.flows.toast.approvalRequested')
    expect(page.mounted.find('a').some(node => node.props.href === '/web/approvals')).toBe(true)
    expect(page.get).toHaveBeenCalledTimes(2)
    page.mounted.unmount()
  })

  test.each([403, 404, 409])('AC-7/8 refused stop with %i shows extracted error and reloads', async (status) => {
    const stop = jest.fn<() => Promise<{ kind: 'done'; flow: FleetFlowDto }>>().mockRejectedValue(new ApiError(status, 'Stop refused'))
    const page = await mountPage({ stop })
    await clickStop(page.mounted)
    expect(page.error).toHaveBeenCalledWith(extractApiError(new ApiError(status, 'Stop refused')))
    expect(page.get).toHaveBeenCalledTimes(2)
    page.mounted.unmount()
  })
})
