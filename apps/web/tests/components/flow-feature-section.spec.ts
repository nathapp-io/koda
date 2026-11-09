import { describe, expect, test } from '@jest/globals'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import type { FleetFlowDto, FleetFlowFeatureDto, FleetFlowJobDto } from '~/lib/fleet-flows'

const flow: FleetFlowDto = {
  id: 'f1', projectId: 'p1', repoId: 'r1', threadId: null, entry: 'NAX', createdBy: { type: 'USER', id: 'u1' },
  branch: 'flow-branch', specSha: 's', pinnedRunnerId: null, roles: { reviewer: 'r', supervisor: 's' },
  costCapUsd: '10', spentUsd: '2', state: 'RUNNING', approval: null, stopReason: null, stopDetail: null,
  endedAt: null, createdAt: 'now', features: [], url: '/',
}
const feature: FleetFlowFeatureDto = {
  feature: 'US-1', specPath: 'a', branch: null, dependsOn: ['US-0'], state: 'RUNNING', currentStep: 'RUN',
  prNumber: 33, questionsJobId: null, questions: null, answers: null, answeredAt: null,
}
const job: FleetFlowJobDto = {
  id: 'j1', feature: 'US-1', step: 'RUN', command: 'RUN', state: 'COMPLETED', costUsd: '1.2500',
  queuedAt: 'now', finishedAt: null,
}

const mountSection = (props: Record<string, unknown>) => mountSfc(webFile('components', 'fleet', 'flows', 'FlowFeatureSection.vue'), {
  props: { slug: 'acme', flow, feature, repo: { provider: 'github', owner: 'o', name: 'r' }, jobs: [job], canAnswer: false, ...props },
  globals: { useI18n: () => ({ t: (key: string) => key }) },
  components: { NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' } },
})

describe('FlowFeatureSection', () => {
  test('renders feature details, branch, GitHub PR and jobs with project job links', () => {
    const mounted = mountSection({})
    expect(mounted.text()).toContain('US-1')
    expect(mounted.text()).toContain('fleet.flows.featureState.RUNNING')
    expect(mounted.text()).toContain('fleet.flows.step.RUN')
    expect(mounted.text()).toContain('US-0')
    expect(mounted.text()).toContain('flow-branch')
    expect(mounted.find('a').some(node => node.props.href === 'https://github.com/o/r/pull/33')).toBe(true)
    expect(mounted.text()).toContain('RUN')
    expect(mounted.text()).toContain('COMPLETED')
    expect(mounted.text()).toContain('$1.25')
    expect(mounted.find('a').some(node => node.props.href === '/acme/fleet/jobs/j1')).toBe(true)
    mounted.unmount()
  })

  test('renders a PR number without a link if repository is absent', () => {
    const mounted = mountSection({ repo: null })
    expect(mounted.text()).toContain('#33')
    expect(mounted.find('a').some(node => node.props.href?.includes('/pull/33'))).toBe(false)
    mounted.unmount()
  })
})
