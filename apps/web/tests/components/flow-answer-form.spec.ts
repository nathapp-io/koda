import { describe, expect, test, jest } from '@jest/globals'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import type { FleetFlowFeatureDto } from '~/lib/fleet-flows'

const feature: FleetFlowFeatureDto = { feature: 'f1', specPath: '', branch: null, dependsOn: [], state: 'WAITING_ANSWER', currentStep: null, prNumber: null, questionsJobId: 'j9', questions: [{ id: 'q1', question: 'First?' }, { id: 'q2', question: 'Second?' }], answers: null, answeredAt: null }
async function setup(answer: jest.Mock, formFeature: FleetFlowFeatureDto = feature) {
  const success = jest.fn(); const error = jest.fn()
  const mounted = mountSfc(webFile('components', 'fleet', 'flows', 'FlowAnswerForm.vue'), {
    props: { slug: 'web', flowId: 'f1', feature: formFeature },
    alias: { '~/composables/useFleetFlows': { useFleetFlows: () => ({ answer }) }, '~/composables/useApi': { extractApiError: (e: unknown) => e } },
    globals: { useI18n: () => ({ t: (key: string) => key }), useAppToast: () => ({ success, error }) },
    components: { NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' } },
  })
  return { mounted, success, error }
}
async function enterAnswers(wrapper: Awaited<ReturnType<typeof setup>>['mounted'], values: string[]) {
  const inputs = wrapper.find('input')
  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i]
    if (input) (input.props.onInput as (event: unknown) => void)({ target: { value: values[i] } })
  }
  const form = wrapper.one('form')
  if (!form) throw new Error('answer form did not render')
  await (form.props.onSubmit as (event: { preventDefault: () => void }) => Promise<void>)({ preventDefault: () => undefined })
  await Promise.resolve(); await Promise.resolve()
}

describe('FlowAnswerForm', () => {
  test('AC-4 question markup is literal text', async () => {
    const markupFeature = { ...feature, questions: [{ id: 'q1', question: '<i>q</i>' }] }
    const { mounted } = await setup(jest.fn(), markupFeature)
    expect(mounted.text()).toContain('<i>q</i>'); expect(mounted.find('i')).toHaveLength(0)
    mounted.unmount()
  })
  test('AC-5 validates required fields and never submits an empty answer', async () => {
    const answer = jest.fn(); const { mounted } = await setup(answer)
    const form = mounted.one('form')
    expect(form?.props.novalidate).toBe('')
    await enterAnswers(mounted, ['', 'B'])
    expect(mounted.text()).toContain('fleet.flows.answer.required'); expect(answer).not.toHaveBeenCalled()
    mounted.unmount()
  })
  test('AC-6 submits answer values in question order', async () => {
    const answer = jest.fn().mockResolvedValue({ kind: 'done', flow: {} }); const { mounted } = await setup(answer)
    await enterAnswers(mounted, ['A', 'B'])
    expect(answer).toHaveBeenCalledWith('f1', 'j9', [{ id: 'q1', answer: 'A' }, { id: 'q2', answer: 'B' }])
    mounted.unmount()
  })
  test('AC-7 done success emits answered', async () => {
    const { mounted, success } = await setup(jest.fn().mockResolvedValue({ kind: 'done', flow: {} }))
    await enterAnswers(mounted, ['A', 'B']); expect(success).toHaveBeenCalled(); expect(mounted.emitted('answered')).toBeTruthy(); mounted.unmount()
  })
  test('AC-8 pending approval displays link and emits answered', async () => {
    const { mounted, success } = await setup(jest.fn().mockResolvedValue({ kind: 'pending', request: {} }))
    await enterAnswers(mounted, ['A', 'B']); expect(success).toHaveBeenCalledWith('fleet.flows.toast.approvalRequested'); expect(mounted.find('a')[0]?.props.href).toBe('/web/approvals'); expect(mounted.emitted('answered')).toBeTruthy(); mounted.unmount()
  })
  test.each([403, 404, 409])('AC-9/11 refusal %i shows extracted error and emits answered', async code => {
    const failure = { code }; const { mounted, error } = await setup(jest.fn().mockRejectedValue(failure))
    await enterAnswers(mounted, ['A', 'B']); expect(error).toHaveBeenCalledWith(failure); expect(mounted.emitted('answered')).toBeTruthy(); mounted.unmount()
  })
})
