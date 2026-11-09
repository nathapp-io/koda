import { beforeAll, describe, expect, test, jest } from '@jest/globals'
import { dirname } from 'node:path'
import type { FleetFlowFeatureDto } from '~/lib/fleet-flows'

/**
 * AC-5 is a user-submission path, so it is exercised in a real DOM: the component is mounted with
 * Vue's runtime renderer inside jsdom, an answer is typed into one field and the other is left
 * empty, and the form is submitted through `requestSubmit()` — the browser's own submit entry point.
 *
 * Vue's runtime-dom captures `document` when it is first imported, so the jsdom globals below have
 * to exist before Vue (and with it the mount helper) is loaded. That is why the helper is imported
 * lazily in `beforeAll` instead of at the top of the file.
 */
const idpEntry = require.resolve('isomorphic-dompurify')
const jsdomEntry = require.resolve('jsdom', { paths: [dirname(idpEntry)] })
// Jest replaces `Module.createRequire`, so a require built that way loads jsdom through Jest's own
// module registry — which cannot parse jsdom's ESM-only dependencies. Node's real loader is used
// instead, so jsdom and its dependencies stay outside the registry.
const nodeLoader = require('module').Module as unknown as { _load: (id: string, parent: unknown, isMain: boolean) => unknown }
const { JSDOM } = nodeLoader._load(jsdomEntry, null, false) as {
  JSDOM: new (html: string, options?: { url?: string }) => { window: Window & typeof globalThis }
}
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
for (const key of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'SVGElement', 'Event', 'MouseEvent', 'navigator']) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
}

type MountHelpers = typeof import('../helpers/mount-sfc')
let helpers!: MountHelpers
let Vue!: typeof import('vue')

beforeAll(async () => {
  helpers = await import('../helpers/mount-sfc')
  Vue = await import('vue')
})

const feature: FleetFlowFeatureDto = { feature: 'f1', specPath: '', branch: null, dependsOn: [], state: 'WAITING_ANSWER', currentStep: null, prNumber: null, questionsJobId: 'j9', questions: [{ id: 'q1', question: 'First?' }, { id: 'q2', question: 'Second?' }], answers: null, answeredAt: null }
async function setup(answer: jest.Mock, formFeature: FleetFlowFeatureDto = feature) {
  const success = jest.fn(); const error = jest.fn()
  const mounted = helpers.mountSfc(helpers.webFile('components', 'fleet', 'flows', 'FlowAnswerForm.vue'), {
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

/** Mounts the real component in jsdom, so the form is driven by DOM events, not by vnode props. */
function mountInDom(answer: jest.Mock, formFeature: FleetFlowFeatureDto = feature) {
  const component = helpers.loadSfc(helpers.webFile('components', 'fleet', 'flows', 'FlowAnswerForm.vue'), {
    useI18n: () => ({ t: (key: string) => key }),
    useAppToast: () => ({ success: jest.fn(), error: jest.fn() }),
  }, {
    '~/composables/useFleetFlows': { useFleetFlows: () => ({ answer }) },
    '~/composables/useApi': { extractApiError: (e: unknown) => e },
  })
  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const app = Vue.createApp(component, { slug: 'web', flowId: 'f1', feature: formFeature })
  app.component('NuxtLink', { props: ['to'], template: '<a :href="to"><slot /></a>' })
  app.mount(container)
  return { app, container }
}

/** Lets the schema validation and the re-render that follows it settle. */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 20))
  await Vue.nextTick()
}

/** Waits (up to a second) for the rendered text to contain `text`. */
async function waitForText(container: HTMLElement, text: string): Promise<boolean> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if ((container.textContent ?? '').includes(text)) return true
    await new Promise(resolve => setTimeout(resolve, 20))
    await Vue.nextTick()
  }
  return (container.textContent ?? '').includes(text)
}

describe('FlowAnswerForm', () => {
  test('AC-4 question markup is literal text', async () => {
    const markupFeature = { ...feature, questions: [{ id: 'q1', question: '<i>q</i>' }] }
    const { mounted } = await setup(jest.fn(), markupFeature)
    expect(mounted.text()).toContain('<i>q</i>'); expect(mounted.find('i')).toHaveLength(0)
    mounted.unmount()
  })
  test('AC-5 submitting an empty answer shows the required message and never calls answer', async () => {
    const answer = jest.fn()
    const { app, container } = mountInDom(answer)
    const form = container.querySelector('form')
    const inputs = [...container.querySelectorAll('input')]
    expect(form).not.toBeNull()
    expect(inputs).toHaveLength(2)
    // The form opts out of the browser's native constraint validation, so the empty field reaches
    // the schema instead of being blocked by the `required` attribute.
    expect((form as HTMLFormElement).noValidate).toBe(true)
    // One answer is typed, the other is left empty.
    const second = inputs[1] as HTMLInputElement
    second.value = 'B'
    second.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    await settle()
    expect(container.textContent ?? '').not.toContain('fleet.flows.answer.required')
    ;(form as HTMLFormElement).requestSubmit()
    expect(await waitForText(container, 'fleet.flows.answer.required')).toBe(true)
    expect(container.textContent ?? '').toContain('fleet.flows.answer.required')
    expect(answer).not.toHaveBeenCalled()
    app.unmount()
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
