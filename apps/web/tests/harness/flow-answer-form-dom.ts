import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const requireFromSanitizer = createRequire(createRequire(import.meta.url).resolve('isomorphic-dompurify'))
const { JSDOM } = requireFromSanitizer('jsdom') as { JSDOM: new (html: string) => { window: Window & typeof globalThis } }
const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', { url: 'http://localhost/' })
for (const key of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'SVGElement', 'Event', 'MouseEvent', 'navigator']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
}

const Vue = await import('vue')
const { parse, compileScript } = await import('vue/compiler-sfc')
const { useForm } = await import('vee-validate')
const { toTypedSchema } = await import('@vee-validate/zod')
const { z } = await import('zod')
const source = await readFile(new URL('../../components/fleet/flows/FlowAnswerForm.vue', import.meta.url), 'utf8')
let compiled = compileScript(parse(source, { filename: 'FlowAnswerForm.vue' }).descriptor, { id: 'flow-answer-dom', inlineTemplate: true }).content
compiled = compiled.replace(/import\s*\{([\s\S]*?)\}\s*from ['"]vue['"];?/g, (_match, names: string) => `const {${names.replace(/\s+as\s+/g, ':')}} = Vue;`)
compiled = compiled.replace(/import\s*\{([\s\S]*?)\}\s*from ['"]vee-validate['"];?/g, 'const { useForm } = veeValidate;')
compiled = compiled.replace(/import\s*\{([\s\S]*?)\}\s*from ['"]@vee-validate\/zod['"];?/g, 'const { toTypedSchema } = veeZod;')
compiled = compiled.replace(/import\s*\{([\s\S]*?)\}\s*from ['"]zod['"];?/g, 'const { z } = zod;')
compiled = compiled.replace(/import\s*\{[^}]*\}\s*from ['"]~\/composables\/useApi['"];?/g, 'const { extractApiError } = mocks;')
compiled = compiled.replace(/import\s*\{[^}]*\}\s*from ['"]~\/composables\/useFleetFlows['"];?/g, 'const { useFleetFlows } = mocks;')
compiled = compiled.replace(/import\s*\{[^}]*\}\s*from ['"]~\/lib\/fleet-flows['"];?/g, 'const { openQuestions } = mocks;')
compiled = ts.transpileModule(compiled, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
compiled = compiled.replace(/Object\.defineProperty\(exports, [^\n]+\n/, '').replace('exports.default =', 'return')
const answer = async (): Promise<never> => { throw new Error('invalid form must not call answer') }
const mocks = {
  extractApiError: (error: unknown) => error,
  useFleetFlows: () => ({ answer }),
  openQuestions: (feature: { questions: Array<{ id: string; question: string }> | null; answeredAt: string | null }) => feature.answeredAt === null ? feature.questions ?? [] : [],
}
const factory = new Function('Vue', 'veeValidate', 'veeZod', 'zod', 'mocks', 'useI18n', 'useAppToast', compiled) as (...args: unknown[]) => Vue.Component
const component = factory(Vue, { useForm }, { toTypedSchema }, { z }, mocks, () => ({ t: (key: string) => key }), () => ({ success() {}, error() {} }))
const app = Vue.createApp(component, {
  slug: 'web', flowId: 'flow-1',
  feature: { feature: 'feature-1', questionsJobId: 'job-1', questions: [{ id: 'q1', question: 'First?' }, { id: 'q2', question: 'Second?' }], answeredAt: null },
})
app.config.globalProperties.useI18n = () => ({ t: (key: string) => key })
app.config.globalProperties.useAppToast = () => ({ success() {}, error() {} })
app.component('NuxtLink', { props: ['to'], template: '<a :href="to"><slot /></a>' })
const root = dom.window.document.querySelector('#app')
if (!root) throw new Error('DOM mount root missing')
app.mount(root)

const form = dom.window.document.querySelector('form')
const inputs = [...dom.window.document.querySelectorAll('input')]
if (!form || inputs.length !== 2) throw new Error('real answer form did not render its form and two inputs')
assert.equal(form.noValidate, true, 'native constraint validation must not block schema validation')
const first = inputs[0]
const second = inputs[1]
if (!first || !second) throw new Error('answer form inputs missing')
first.value = ''
second.value = 'B'
first.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
second.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
form.requestSubmit()
await new Promise(resolve => setTimeout(resolve, 50))
assert.match(dom.window.document.body.textContent ?? '', /fleet\.flows\.answer\.required/)
app.unmount()
console.log('PASS FlowAnswerForm DOM submit: empty answer shows schema error without calling answer')
