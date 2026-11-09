import { describe, expect, test } from '@jest/globals'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import type { FleetFlowDto, FleetFlowFeatureDto, FleetFlowJobDto } from '~/lib/fleet-flows'

const flow: FleetFlowDto = { id: 'f1', projectId: 'p1', repoId: 'r1', threadId: null, entry: 'NAX', createdBy: { type: 'USER', id: 'u1' }, branch: 'flow-branch', specSha: 's', pinnedRunnerId: null, roles: { reviewer: 'r', supervisor: 's' }, costCapUsd: '10', spentUsd: '2', state: 'RUNNING', approval: null, stopReason: null, stopDetail: null, endedAt: null, createdAt: 'now', features: [], url: '/' }
const feature: FleetFlowFeatureDto = { feature: 'US-1', specPath: 'a', branch: null, dependsOn: ['US-0'], state: 'RUNNING', currentStep: 'RUN', prNumber: 33, questionsJobId: 'j1', questions: [{ id: 'q1', question: 'question one' }, { id: 'q2', question: 'question two' }], answers: null, answeredAt: null }
const job: FleetFlowJobDto = { id: 'j1', feature: 'US-1', step: 'RUN', command: 'RUN', state: 'COMPLETED', costUsd: '1.2500', queuedAt: 'now', finishedAt: null }
const mountSection = (props: Record<string, unknown>) => mountSfc(webFile('components', 'fleet', 'flows', 'FlowFeatureSection.vue'), { props: { slug: 'web', flow, feature, repo: null, jobs: [job], canAnswer: false, ...props }, globals: { useI18n: () => ({ t: (key: string) => key }) }, components: { NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' }, FlowAnswerForm: { props: ['feature'], template: '<form data-answer=""><label v-for="q in feature.questions">{{q.question}}<input></label></form>' } } })
describe('FlowFeatureSection answer gating', () => {
 test('AC-1 renders one input per open question only for waiting flow', () => { const m = mountSection({ flow: { ...flow, state: 'WAITING_ANSWER' }, canAnswer: true }); expect(m.find('input')).toHaveLength(2); expect(m.text()).toContain('question one'); m.unmount() })
 test('AC-2 suppresses form without permission', () => { const m = mountSection({ flow: { ...flow, state: 'WAITING_ANSWER' }, canAnswer: false }); expect(m.find('[data-answer]')).toHaveLength(0); m.unmount() })
 test('AC-3 suppresses form while running', () => { const m = mountSection({ canAnswer: true }); expect(m.find('[data-answer]')).toHaveLength(0); m.unmount() })
 test('AC-12 retains job link without permission', () => { const m = mountSection({ canAnswer: false }); expect(m.find('[href="/web/fleet/jobs/j1"]')).toHaveLength(1); m.unmount() })
})
