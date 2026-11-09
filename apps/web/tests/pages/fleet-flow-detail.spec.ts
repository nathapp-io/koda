import { describe, expect, test, jest } from '@jest/globals'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ApiError } from '~/composables/useApi'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import type { FleetFlowDto, FleetFlowOverviewDto } from '~/lib/fleet-flows'

const webDir = join(__dirname, '../..')
const read = (...p: string[]): string => readFileSync(join(webDir, ...p), 'utf-8')

const flow = (overrides: Partial<FleetFlowDto> = {}): FleetFlowDto => ({
  id: 'f-1', projectId: 'p-1', repoId: 'r-1', threadId: null, entry: 'THREAD',
  createdBy: { type: 'USER', id: 'creator' }, branch: 'feature/branch', specSha: 'sha', pinnedRunnerId: null,
  roles: { reviewer: 'review-model', supervisor: 'supervisor-model' }, costCapUsd: '10.0000', spentUsd: '2.5000',
  state: 'RUNNING', approval: null, stopReason: null, stopDetail: null, endedAt: null,
  createdAt: '2026-01-02T03:04:05.000Z', features: [], url: '/acme/flows/f-1', ...overrides,
})
const overview = (overrides: Partial<FleetFlowOverviewDto> = {}): FleetFlowOverviewDto => ({
  repo: null, ticketRef: null, jobs: [], truncated: false, unknownCostCount: 0, ...overrides,
})
const waitingFeature = { feature: 'US-1', specPath: 'a', branch: null, dependsOn: [], state: 'WAITING_ANSWER', currentStep: null, prNumber: null, questionsJobId: 'j1', questions: [{ id: 'q1', question: 'Q?' }], answers: null, answeredAt: null }

type AnswerResult = { kind: 'done'; flow: FleetFlowDto } | { kind: 'pending'; request: { permissionKey: string } }

async function mountPage(options: {
  flow?: FleetFlowDto
  overview?: FleetFlowOverviewDto
  getError?: unknown
  overviewError?: unknown
  memberName?: string | null
  permissions?: string[]
  answer?: jest.Mock<() => Promise<AnswerResult>>
} = {}) {
  const get = jest.fn<() => Promise<FleetFlowDto>>(() => options.getError ? Promise.reject(options.getError) : Promise.resolve(options.flow ?? flow()))
  const getOverview = jest.fn<() => Promise<FleetFlowOverviewDto>>(() => options.overviewError ? Promise.reject(options.overviewError) : Promise.resolve(options.overview ?? overview()))
  const answer = options.answer ?? jest.fn<() => Promise<AnswerResult>>().mockResolvedValue({ kind: 'done', flow: flow() })
  const nameOf = jest.fn((id: string) => id ? options.memberName ?? null : null)
  const load = jest.fn<() => Promise<void>>().mockResolvedValue(undefined)
  const has = (key: string): boolean => (options.permissions ?? []).includes(key)
  const mounted = mountSfc(webFile('pages', '[project]', 'flows', '[id].vue'), {
    globals: {
      useRoute: () => ({ params: { project: 'acme', id: 'f-1' } }),
      useI18n: () => ({ t: (key: string, params?: Record<string, unknown>) => params ? `${key} ${Object.values(params).join(' ')}` : key }),
      useAppToast: () => ({ success: jest.fn(), error: jest.fn() }),
      useFleetFlows: () => ({ get, overview: getOverview, answer }),
      useProjectMemberNames: () => ({ members: [], load, nameOf }),
      useProjectPermissions: () => ({ permissions: { value: { has } } }),
    },
    alias: {
      '~/composables/useFleetFlows': { useFleetFlows: () => ({ get, overview: getOverview, answer }) },
      '~/composables/useVisiblePolling': { useVisiblePolling: () => ({ start: jest.fn(), stop: jest.fn(), runNow: async () => undefined, isActive: () => false }) },
      '~/composables/useApi': { ApiError },
      '~/composables/useProjectMemberNames': { useProjectMemberNames: () => ({ members: [], load, nameOf }) },
      '~/composables/usePermissions': { useProjectPermissions: () => ({ permissions: { value: { has } } }) },
    },
    components: {
      LoadingState: { template: '<div>loading</div>' },
      PageHeader: { props: ['title', 'subtitle'], template: '<header>{{ title }} {{ subtitle }}<slot name="actions" /><slot /></header>' },
      NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
    },
  })
  await Promise.resolve()
  await Promise.resolve()
  return { mounted, get, getOverview, nameOf, load, answer }
}

/** The page renders the real feature section, which renders the real answer form. */
async function submitAnswer(mounted: Awaited<ReturnType<typeof mountPage>>['mounted'], answer: string): Promise<void> {
  const input = mounted.find('input')[0]
  if (!input) throw new Error('answer form input not found')
  ;(input.props.onInput as (event: unknown) => void)({ target: { value: answer } })
  const form = mounted.one('form')
  if (!form) throw new Error('answer form not rendered')
  await (form.props.onSubmit as (event: { preventDefault: () => void }) => Promise<void>)({ preventDefault: () => undefined })
  // The page reloads the flow after the answer; let that read and its re-render settle.
  for (let i = 0; i < 6; i++) await Promise.resolve()
}

describe('fleet flow detail page (US-006)', () => {
  test('AC-1 the page and the section import the components they render', () => {
    // Nuxt registers these under `FleetFlowsFlowFeatureSection`/`FleetFlowsFlowAnswerForm`, so the
    // short tags only resolve when the call sites import the components themselves.
    expect(read('pages', '[project]', 'flows', '[id].vue')).toContain("import FlowFeatureSection from '~/components/fleet/flows/FlowFeatureSection.vue'")
    expect(read('components', 'fleet', 'flows', 'FlowFeatureSection.vue')).toContain("import FlowAnswerForm from '~/components/fleet/flows/FlowAnswerForm.vue'")
  })

  test('AC-1 loads flow and overview once and renders state and branch', async () => {
    const { mounted, get, getOverview } = await mountPage()
    expect(get).toHaveBeenCalledTimes(1)
    expect(get).toHaveBeenCalledWith('f-1')
    expect(getOverview).toHaveBeenCalledTimes(1)
    expect(getOverview).toHaveBeenCalledWith('f-1')
    expect(mounted.text()).toContain('fleet.flows.state.RUNNING')
    expect(mounted.text()).toContain('feature/branch')
    mounted.unmount()
  })

  test('AC-2 formats spend and cap and shows unknown cost count', async () => {
    const { mounted } = await mountPage({ overview: overview({ unknownCostCount: 2 }) })
    expect(mounted.text()).toContain('$2.50')
    expect(mounted.text()).toContain('$10.00')
    expect(mounted.text()).toContain('fleet.flows.detail.unknownCost 2')
    mounted.unmount()
  })

  test('AC-3 omits unknown-cost text when count is zero', async () => {
    const { mounted } = await mountPage()
    expect(mounted.text()).not.toContain('fleet.flows.detail.unknownCost')
    mounted.unmount()
  })

  test('AC-4 pending approval links to approvals', async () => {
    const { mounted } = await mountPage({ flow: flow({ state: 'PENDING', approval: { mode: 'REQUEST', approverId: null, approvedAt: null, approvalRequestId: 'a-1' } }) })
    expect(mounted.text()).toContain('fleet.flows.detail.pendingApproval')
    expect(mounted.find('a').some((node) => node.props.href === '/acme/approvals')).toBe(true)
    mounted.unmount()
  })

  test('AC-5 approved flow shows mode and resolved approver', async () => {
    const { mounted, nameOf } = await mountPage({
      flow: flow({ state: 'APPROVED', approval: { mode: 'PRE_APPROVED', approverId: 'u-1', approvedAt: '2026-01-03T00:00:00.000Z', approvalRequestId: null } }),
      memberName: 'Ada Lovelace',
    })
    expect(nameOf).toHaveBeenCalledWith('u-1')
    expect(mounted.text()).toContain('fleet.flows.detail.approvalModeValue.PRE_APPROVED')
    expect(mounted.text()).toContain('Ada Lovelace')
    mounted.unmount()
  })

  test('AC-6 shows stop text and linked ticket', async () => {
    const { mounted } = await mountPage({
      flow: flow({ state: 'STOPPED', stopReason: 'failed', stopDetail: 'runner stopped' }),
      overview: overview({ ticketRef: 'SB-7' }),
    })
    expect(mounted.text()).toContain('failed')
    expect(mounted.text()).toContain('runner stopped')
    expect(mounted.find('a').some((node) => node.props.href === '/acme/tickets/SB-7')).toBe(true)
    mounted.unmount()
  })

  test('AC-7 renders stop detail as text and not markup', async () => {
    const { mounted } = await mountPage({ flow: flow({ state: 'STOPPED', stopDetail: '<b>x</b>' }) })
    expect(mounted.text()).toContain('<b>x</b>')
    expect(mounted.find('b')).toHaveLength(0)
    mounted.unmount()
  })

  test('AC-8 maps not-found ApiError to the not-found state', async () => {
    const { mounted } = await mountPage({ getError: new ApiError(404, 'missing') })
    expect(mounted.text()).toContain('fleet.flows.detail.notFound')
    mounted.unmount()
  })

  test('404 envelope code 40004 also maps to not-found', async () => {
    const { mounted } = await mountPage({ getError: new ApiError(40004, 'missing') })
    expect(mounted.text()).toContain('fleet.flows.detail.notFound')
    mounted.unmount()
  })

  test('overview failure does not hide a successfully loaded flow', async () => {
    const { mounted } = await mountPage({ overviewError: new Error('overview unavailable') })
    expect(mounted.text()).toContain('feature/branch')
    expect(mounted.text()).not.toContain('fleet.flows.detail.loadFailed')
    mounted.unmount()
  })

  test('AC-9 maps other initial failures to load-failed', async () => {
    const { mounted } = await mountPage({ getError: new ApiError(500, 'failed') })
    expect(mounted.text()).toContain('fleet.flows.detail.loadFailed')
    mounted.unmount()
  })

  test('AC-10 renders entry, role models and creation time', async () => {
    const { mounted } = await mountPage()
    expect(mounted.text()).toContain('THREAD')
    expect(mounted.text()).toContain('review-model')
    expect(mounted.text()).toContain('supervisor-model')
    expect(mounted.text()).toContain('2026-01-02T03:04:05.000Z')
    mounted.unmount()
  })

  test('AC-1 renders feature sections in DTO order and AC-8 lists featureless jobs', async () => {
    const features = [
      { feature: 'z-feature', specPath: 'z', branch: null, dependsOn: [], state: 'RUNNING', currentStep: null, prNumber: null, questionsJobId: null, questions: null, answers: null, answeredAt: null },
      { feature: 'a-feature', specPath: 'a', branch: null, dependsOn: [], state: 'PENDING', currentStep: null, prNumber: null, questionsJobId: null, questions: null, answers: null, answeredAt: null },
    ]
    const jobs = [
      { id: 'flow-job', feature: null, step: 'RUN', command: 'RUN', state: 'QUEUED', costUsd: '0.5', queuedAt: 'now', finishedAt: null },
    ]
    const { mounted } = await mountPage({ flow: flow({ features }), overview: overview({ jobs, truncated: true }) })
    const sections = mounted.find('section').filter(node => typeof node.props['data-feature'] === 'string').map(node => node.props['data-feature'])
    expect(sections).toEqual(['z-feature', 'a-feature'])
    expect(mounted.text()).toContain('fleet.flows.detail.flowJobs')
    expect(mounted.text()).toContain('RUN · RUN · QUEUED · $0.50')
    expect(mounted.find('a').some(node => node.props.href === '/acme/fleet/jobs/flow-job')).toBe(true)
    expect(mounted.text()).toContain('fleet.flows.detail.truncated')
    mounted.unmount()
  })

  test('AC-9 omits Flow jobs when jobs are associated with features; AC-10 keeps features if overview fails', async () => {
    const features = [{ feature: 'US-1', specPath: 'a', branch: null, dependsOn: [], state: 'RUNNING', currentStep: null, prNumber: null, questionsJobId: null, questions: null, answers: null, answeredAt: null }]
    const associated = { id: 'j1', feature: 'US-1', step: null, command: 'RUN', state: 'QUEUED', costUsd: '0.5', queuedAt: 'now', finishedAt: null }
    const successful = await mountPage({ flow: flow({ features }), overview: overview({ jobs: [associated] }) })
    expect(successful.mounted.text()).not.toContain('fleet.flows.detail.flowJobs')
    successful.mounted.unmount()
    const failed = await mountPage({ flow: flow({ features }), overviewError: new Error('offline') })
    expect(failed.mounted.text()).toContain('US-1')
    expect(failed.mounted.text()).toContain('fleet.flows.detail.jobsFailed')
    failed.mounted.unmount()
  })

  test('AC-10 reloads flow after feature answer event', async () => {
    const { mounted, get, answer } = await mountPage({
      flow: flow({ state: 'WAITING_ANSWER', features: [waitingFeature] }),
      permissions: ['fleet.flow.answer'],
    })
    expect(mounted.find('form')).toHaveLength(1)
    await submitAnswer(mounted, 'A')
    expect(answer).toHaveBeenCalledWith('f-1', 'j1', [{ id: 'q1', answer: 'A' }])
    expect(get).toHaveBeenCalledTimes(2)
    mounted.unmount()
  })

  test('AC-8 a pending answer keeps the approvals link after the page reloads the flow', async () => {
    const answer = jest.fn<() => Promise<AnswerResult>>().mockResolvedValue({ kind: 'pending', request: { permissionKey: 'fleet.flow.answer' } })
    const { mounted, get } = await mountPage({
      flow: flow({ state: 'WAITING_ANSWER', features: [waitingFeature] }),
      permissions: ['fleet.flow.answer'],
      answer,
    })
    await submitAnswer(mounted, 'A')
    expect(get).toHaveBeenCalledTimes(2)
    expect(mounted.find('a').filter(node => node.props.href === '/acme/approvals').length).toBeGreaterThan(0)
    mounted.unmount()
  })

  test('AC-11 falls back to approver id when member name is unavailable', async () => {
    const { mounted } = await mountPage({
      flow: flow({ state: 'APPROVED', approval: { mode: 'REQUEST', approverId: 'former-user', approvedAt: null, approvalRequestId: null } }),
    })
    expect(mounted.text()).toContain('former-user')
    mounted.unmount()
  })
})
