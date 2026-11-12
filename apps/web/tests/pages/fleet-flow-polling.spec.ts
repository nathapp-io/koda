import { afterEach, describe, expect, jest, test } from '@jest/globals'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import type { FleetFlowDto, FleetFlowOverviewDto } from '~/lib/fleet-flows'

const flow = (state: string, branch = 'feature/branch'): FleetFlowDto => ({
  id: 'f-1', projectId: 'p-1', repoId: 'r-1', threadId: null, entry: 'THREAD',
  createdBy: { type: 'USER', id: 'creator' }, branch, specSha: 'sha', pinnedRunnerId: null,
  roles: { reviewer: 'review-model', supervisor: 'supervisor-model' }, costCapUsd: '10.0000', spentUsd: '2.5000',
  state, approval: null, stopReason: null, stopDetail: null, endedAt: null,
  createdAt: '2026-01-02T03:04:05.000Z', features: [], url: '/acme/flows/f-1',
})
const overview = (ticketRef: string | null = null): FleetFlowOverviewDto => ({
  repo: null, ticketRef, jobs: [], truncated: false, unknownCostCount: 0,
})

afterEach(() => jest.useRealTimers())

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

async function mountPage(options: {
  initialFlow?: FleetFlowDto
  initialGetError?: unknown
  initialGetPromise?: Promise<FleetFlowDto>
  initialOverview?: FleetFlowOverviewDto
  getResults?: Array<FleetFlowDto | Error>
  overviewResults?: Array<FleetFlowOverviewDto | Error>
} = {}) {
  jest.useFakeTimers()
  let getCalls = 0
  let overviewCalls = 0
  const get = jest.fn<() => Promise<FleetFlowDto>>(async () => {
    const call = getCalls++
    if (call === 0 && options.initialGetError) throw options.initialGetError
    if (call === 0 && options.initialGetPromise) return options.initialGetPromise
    const result = options.getResults?.[call - 1]
    if (result instanceof Error) throw result
    return result ?? options.initialFlow ?? flow('RUNNING')
  })
  const getOverview = jest.fn<() => Promise<FleetFlowOverviewDto>>(async () => {
    const call = overviewCalls++
    const result = options.overviewResults?.[call - 1]
    if (result instanceof Error) throw result
    return result ?? options.initialOverview ?? overview()
  })
  const polling = (task: () => Promise<void>, ms: number) => {
    let handle: ReturnType<typeof setInterval> | null = null
    return {
      start: jest.fn(() => { if (handle === null) handle = setInterval(() => { void task() }, ms) }),
      stop: jest.fn(() => { if (handle !== null) clearInterval(handle); handle = null }),
      runNow: task,
      isActive: () => handle !== null,
    }
  }
  const mounted = mountSfc(webFile('pages', '[project]', 'flows', '[id].vue'), {
    globals: {
      useRoute: () => ({ params: { project: 'acme', id: 'f-1' } }),
      useI18n: () => ({ t: (key: string) => key, te: () => false }),
      useAppToast: () => ({ success: jest.fn(), error: jest.fn() }),
      useFleetFlows: () => ({ get, overview: getOverview }),
      useProjectMemberNames: () => ({ members: [], load: jest.fn<() => Promise<void>>().mockResolvedValue(undefined), nameOf: () => null }),
      useProjectPermissions: () => ({ permissions: { value: { has: () => false } } }),
      useVisiblePolling: polling,
    },
    alias: {
      '~/composables/useFleetFlows': { useFleetFlows: () => ({ get, overview: getOverview }) },
      '~/composables/useVisiblePolling': { useVisiblePolling: polling },
      '~/composables/useApi': { ApiError: class extends Error { code = 404 } },
      '~/composables/useProjectMemberNames': { useProjectMemberNames: () => ({ members: [], load: jest.fn<() => Promise<void>>().mockResolvedValue(undefined), nameOf: () => null }) },
      '~/composables/usePermissions': { useProjectPermissions: () => ({ permissions: { value: { has: () => false } } }) },
    },
    components: {
      LoadingState: { template: '<div>loading</div>' },
      FlowFeatureSection: { template: '<article />' },
      PageHeader: { template: '<header><slot name="actions" /></header>', props: ['title', 'subtitle'] },
      NuxtLink: { template: '<a :href="to"><slot /></a>', props: ['to'] },
    },
  })
  await settle()
  return { mounted, get, getOverview }
}

describe('fleet flow detail polling (US-011)', () => {
  test('AC-1 polls the flow and overview after 15 seconds for a live flow', async () => {
    const page = await mountPage()
    expect(page.get).toHaveBeenCalledTimes(1)
    expect(page.getOverview).toHaveBeenCalledTimes(1)
    await jest.advanceTimersByTimeAsync(15_000)
    expect(page.get).toHaveBeenCalledTimes(2)
    expect(page.getOverview).toHaveBeenCalledTimes(2)
    page.mounted.unmount()
  })

  test('AC-2 stops after a poll returns a terminal flow', async () => {
    const page = await mountPage({ getResults: [flow('COMPLETED')] })
    await jest.advanceTimersByTimeAsync(15_000)
    expect(page.get).toHaveBeenCalledTimes(2)
    await jest.advanceTimersByTimeAsync(15_000)
    expect(page.get).toHaveBeenCalledTimes(2)
    page.mounted.unmount()
  })

  test('AC-3 does not poll a flow that was terminal on first load', async () => {
    const page = await mountPage({ initialFlow: flow('COMPLETED') })
    await jest.advanceTimersByTimeAsync(15_000)
    expect(page.get).toHaveBeenCalledTimes(1)
    page.mounted.unmount()
  })

  test('AC-4 does not poll after the initial flow read fails', async () => {
    const page = await mountPage({ initialGetError: new Error('offline') })
    await jest.advanceTimersByTimeAsync(15_000)
    expect(page.get).toHaveBeenCalledTimes(1)
    page.mounted.unmount()
  })

  test('AC-5 stops polling when the page unmounts', async () => {
    const page = await mountPage()
    page.mounted.unmount()
    await jest.advanceTimersByTimeAsync(15_000)
    expect(page.get).toHaveBeenCalledTimes(1)
  })

  test('does not start polling when the first load completes after unmount', async () => {
    let resolveFirstGet!: (value: FleetFlowDto) => void
    const firstGet = new Promise<FleetFlowDto>((resolve) => { resolveFirstGet = resolve })
    const page = await mountPage({ initialGetPromise: firstGet })
    page.mounted.unmount()
    resolveFirstGet(flow('RUNNING'))
    await settle()
    await jest.advanceTimersByTimeAsync(15_000)
    expect(page.get).toHaveBeenCalledTimes(1)
  })

  test('AC-6 retains the flow after a poll get fails and retries next tick', async () => {
    const page = await mountPage({ getResults: [new Error('temporary'), flow('RUNNING')] })
    await jest.advanceTimersByTimeAsync(15_000)
    expect(page.mounted.text()).toContain('feature/branch')
    expect(page.get).toHaveBeenCalledTimes(2)
    await jest.advanceTimersByTimeAsync(15_000)
    expect(page.get).toHaveBeenCalledTimes(3)
    page.mounted.unmount()
  })

  test('AC-7 retains prior overview after a poll overview failure and retries next tick', async () => {
    const job = (id: string) => ({ id, feature: null, step: 'RUN', command: 'RUN', state: 'QUEUED', costUsd: '0.5', queuedAt: 'now', finishedAt: null })
    const page = await mountPage({ initialOverview: { ...overview(), jobs: [job('j-1')] }, overviewResults: [new Error('temporary'), { ...overview(), jobs: [job('j-2')] }] })
    await jest.advanceTimersByTimeAsync(15_000)
    expect(page.mounted.find('a').some(node => node.props.href === '/acme/fleet/jobs/j-1')).toBe(true)
    expect(page.getOverview).toHaveBeenCalledTimes(2)
    await jest.advanceTimersByTimeAsync(15_000)
    expect(page.getOverview).toHaveBeenCalledTimes(3)
    expect(page.mounted.find('a').some(node => node.props.href === '/acme/fleet/jobs/j-2')).toBe(true)
    page.mounted.unmount()
  })
})
