import { describe, expect, test, jest } from '@jest/globals'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import type { FleetFlowDto, FleetFlowFeatureDto, FleetFlowJobDto } from '~/lib/fleet-flows'

const flow: FleetFlowDto = { id: 'f1', projectId: 'p1', repoId: 'r1', threadId: null, entry: 'NAX', createdBy: { type: 'USER', id: 'u1' }, branch: 'flow-branch', specSha: 's', pinnedRunnerId: null, roles: { reviewer: 'r', supervisor: 's' }, costCapUsd: '10', spentUsd: '2', state: 'RUNNING', approval: null, stopReason: null, stopDetail: null, endedAt: null, createdAt: 'now', features: [], url: '/' }
const feature: FleetFlowFeatureDto = { feature: 'US-1', specPath: 'a', branch: null, dependsOn: ['US-0'], state: 'RUNNING', currentStep: 'RUN', prNumber: 33, questionsJobId: 'j1', questions: [{ id: 'q1', question: 'question one' }, { id: 'q2', question: 'question two' }], answers: null, answeredAt: null }
const job: FleetFlowJobDto = { id: 'j1', feature: 'US-1', step: 'RUN', command: 'RUN', state: 'COMPLETED', costUsd: '1.2500', queuedAt: 'now', finishedAt: null }
/**
 * The section imports the answer form itself, so the real form is mounted here: the test needs
 * the composable the form calls, not a stub that stands in for it.
 */
type LocaleValue = string | { [key: string]: LocaleValue }
const en = JSON.parse(readFileSync(join(__dirname, '../../i18n/locales/en.json'), 'utf8')) as LocaleValue
const localeValue = (key: string): LocaleValue | undefined => key.split('.').reduce<LocaleValue | undefined>((value, part) => typeof value === 'object' ? value[part] : undefined, en)
const english = (key: string): string => {
  const value = localeValue(key)
  return typeof value === 'string' ? value : key
}
const mountSection = (props: Record<string, unknown>, useEnglish = false) => mountSfc(webFile('components', 'fleet', 'flows', 'FlowFeatureSection.vue'), {
  props: { slug: 'web', flow, feature, repo: null, jobs: [job], canAnswer: false, ...props },
  globals: { useI18n: () => ({ t: useEnglish ? english : (key: string) => key, te: useEnglish ? (key: string) => typeof localeValue(key) === 'string' : () => false }), useAppToast: () => ({ success: jest.fn(), error: jest.fn() }) },
  alias: { '~/composables/useFleetFlows': { useFleetFlows: () => ({ answer: jest.fn() }) } },
  components: { NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' } },
})
describe('FlowFeatureSection answer gating', () => {
 test('AC-1 renders one input per open question only for waiting flow', () => { const m = mountSection({ flow: { ...flow, state: 'WAITING_ANSWER' }, canAnswer: true }); expect(m.find('input')).toHaveLength(2); expect(m.text()).toContain('question one'); m.unmount() })
 test('AC-2 suppresses form without permission', () => { const m = mountSection({ flow: { ...flow, state: 'WAITING_ANSWER' }, canAnswer: false }); expect(m.find('form')).toHaveLength(0); m.unmount() })
 test('AC-3 suppresses form while running', () => { const m = mountSection({ canAnswer: true }); expect(m.find('form')).toHaveLength(0); m.unmount() })
 test('AC-11 renders localized command and state labels', () => {
  const m = mountSection({ jobs: [{ ...job, command: 'AGENT', state: 'COMPLETED' }] }, true)
  expect(m.text()).toContain('Agent task')
  expect(m.text()).toContain('Completed')
  m.unmount()
 })
 test('AC-12 renders the localized pull-request label with a separating space', () => {
  const m = mountSection({ repo: { provider: 'github', owner: 'nathapp', name: 'koda' } }, true)
  const pullRequestLine = m.find('p').find((node) => m.textOf(node).includes('Pull request'))
  if (!pullRequestLine) throw new Error('pull request line not rendered')
  expect(m.textOf(pullRequestLine)).toBe('Pull request #33')
  m.unmount()
 })
 test('AC-12 retains job link without permission', () => { const m = mountSection({ canAnswer: false }); expect(m.find('[href="/web/fleet/jobs/j1"]')).toHaveLength(1); m.unmount() })
 test('AC-1 a later question round gives the answer form a fresh set of fields', async () => {
  const m = mountSection({ flow: { ...flow, state: 'WAITING_ANSWER' }, canAnswer: true })
  const typed = m.find('input')[0]
  ;(typed?.props.onInput as (event: unknown) => void)({ target: { value: 'A' } })
  await Promise.resolve(); await Promise.resolve()
  expect(m.find('input')[0]?.props.value).toBe('A')
  // Polling hands the section a later round: a new job that reuses the ordinal question id.
  m.setProps({ feature: { ...feature, questionsJobId: 'j2', questions: [{ id: 'q1', question: 'question one' }] } })
  await Promise.resolve(); await Promise.resolve()
  expect(m.find('input')).toHaveLength(1)
  // The answer typed for the round that was on screen is gone.
  expect(m.find('input')[0]?.props.value).toBe('')
  m.unmount()
 })
})
