import { afterEach, describe, expect, jest, test } from '@jest/globals'
import * as Vue from 'vue'
import { defineComponent, h, ref } from 'vue'
import { useField } from 'vee-validate'
import { mountSfc, webFile, loadSfc } from '../helpers/mount-sfc'
import type { FakeNode, Mounted } from '../helpers/mount-sfc'
import { enI18n, i18nStub, toastRecorder, uiStubs } from '../helpers/fleet-harness'
import * as apiModule from '../../composables/useApi'
import { globalPermissionsStub, projectPermissionsStub } from '../helpers/permission-nav'
import { ApiError } from '../../composables/useApi'
import { useFleetDispatchOptions } from '~/composables/useFleetDispatchOptions'

/**
 * US-005 AC11-AC15: pages/[project]/threads/new.vue — the validated create-thread form.
 *
 * The page is the dispatch form's sibling: vee-validate + toTypedSchema(buildThreadCreateSchema(t)),
 * repos/runners from useFleetDispatchOptions, skills from useProjectSkills, the create POST through
 * the established useApi wrapper and navigation through navigateTo.
 *
 * The vee-validate binding is exercised for real: the custom FormField stub registers each field
 * with the page's useForm (identifying itself with a data-field attribute so the test can drive
 * fields by name), and the Input stub turns a native input event into update:modelValue — the
 * same probe create-user-dialog.spec.ts uses.
 */

const pageFile = webFile('pages', '[project]', 'threads', 'new.vue')

// ── fixtures ─────────────────────────────────────────────────────────────────

const repo = (over: Record<string, unknown> = {}) => ({
  id: 'r1', projectId: 'p1', provider: 'github', owner: 'acme', name: 'app',
  defaultBranch: 'main', githubInstallationId: '7', createdAt: '2026-10-01T00:00:00.000Z', ...over,
})

/** A runner summary: native models plus, when given, the ACP agents and discovery offers the agent select reads. */
const runnerWithModels = (
  models: string[],
  over: Record<string, unknown> = {},
  acp: { acp?: string[]; acpOffers?: Record<string, unknown>[] } = {},
) => ({
  id: 'rn1', name: 'mac-1', os: 'linux', arch: 'x64', labels: [], enabled: true, online: true,
  profiles: [],
  threadBackends: { native: models, acp: acp.acp ?? [], ...(acp.acpOffers ? { acpOffers: acp.acpOffers } : {}) },
  projectThreads: false, ...over,
})

const skill = (over: Record<string, unknown> = {}) => ({
  id: 's1', name: 'spec-review', description: 'Reviews the request spec', enabled: true,
  source: { id: 'src1', gitUrl: 'https://github.com/nathapp-io/nax-spec-kit-skills', ref: 'main',
    resolvedSha: 'a1b2c3d4e5f6a7b8c9d0e1f', status: 'OK' },
  ...over,
})

// ── stubs (create-user-dialog pattern: real vee-validate, real page, fake DOM) ─

const FormField = defineComponent({
  name: 'TestFormField',
  props: { name: { type: String, required: true } },
  setup(props, { attrs, slots }) {
    const { value, handleChange, handleBlur, errorMessage } = useField<string>(() => props.name)
    return () => h('div', { ...attrs, 'data-field': props.name }, [
      ...(slots.default?.({ componentField: {
        modelValue: value.value,
        'onUpdate:modelValue': handleChange,
        onBlur: handleBlur,
      } }) ?? []),
      errorMessage.value ? h('p', { 'data-field-error': props.name }, errorMessage.value) : null,
    ])
  },
})

const Input = defineComponent({
  name: 'TestInput',
  props: { modelValue: String },
  emits: ['update:modelValue'],
  setup(_props, { attrs, emit }) {
    return () => h('input', { ...attrs, onInput: (event: Event) => emit('update:modelValue', (event.target as HTMLInputElement).value) })
  },
})

const { FleetNativeSelect: _fleetNativeStub, ...stubs } = uiStubs
const backendPicker = loadSfc(webFile('components', 'fleet', 'threads', 'BackendPicker.vue'), { useI18n: () => i18nStub() })
type PageOver = {
  /** Native models the single online enabled runner offers; undefined => none eligible. */
  models?: string[]
  /** Whether that runner advertises projectThreads (S5b): only then does it offer PROJECT models. */
  projectThreads?: boolean
  /** The ACP agents and discovery offers that runner reports (thread-agents-modes US-011). */
  acp?: { acp?: string[]; acpOffers?: Record<string, unknown>[] }
  /** The project keys the caller holds; the default is the create key alone. */
  permissions?: string[]
  /** The global (no project) keys the caller holds; the Re-check gate reads `fleet.runner.update` there. */
  globalKeys?: string[]
  /** Mount with the real `useFleetDispatchOptions` over the fake transport, so `options.load` really reloads. */
  realDispatch?: boolean
  /** The runner summaries the transport answers `/fleet/runners` with (real-dispatch mounts only). */
  dispatchRunners?: Record<string, unknown>[]
  /** Mount with the real English copy instead of the key-echo stub (label assertions). */
  englishCopy?: boolean
  /** The repos `useFleetDispatchOptions` reports; the default is the single plain `acme/app`. */
  repos?: Record<string, unknown>[]
  skills?: Record<string, unknown>[]
  post?: jest.Mock
  settled?: boolean
}

/** One runner summary as the workspace/project form reads it (threadBackends carries the agents). */
const acpOffer = (agent: string, over: Record<string, unknown> = {}) => ({
  agent, launchable: true, loggedIn: true, models: [], efforts: [], ...over,
})

function mountPage(over: PageOver = {}) {
  const g = globalThis as Record<string, unknown>
  const post = over.post ?? jest.fn(async () => ({ id: 'th9' }))
  const paths: string[] = []
  // The transport answers the two fleet lists the dispatch form reads (so the real
  // `useFleetDispatchOptions` can reload), and `{}` everywhere else.
  const get = jest.fn(async (path: string) => {
    paths.push(path)
    if (path.endsWith('/fleet/runners')) {
      return { records: over.dispatchRunners ?? runners, hasNext: false }
    }
    if (path.endsWith('/fleet/repos')) return { records: over.repos ?? [repo()], hasNext: false }
    return {}
  })
  const nav = jest.fn(async () => undefined)
  const push = jest.fn(async () => undefined)
  const runners = over.models ? [runnerWithModels(over.models, { projectThreads: over.projectThreads ?? false }, over.acp ?? {})] : []
  const api = () => ({ $api: { get, post } })
  // The real `useFleetDispatchOptions` (US-009 AC-10) resolves `useApi` as an auto-import, which in
  // this harness lives on globalThis rather than on the mount globals.
  g.useApi = api
  const app = mountSfc(pageFile, {
    components: { ...stubs, FormField, Input, FleetThreadsBackendPicker: backendPicker },
    fleetComponents: ['FleetNativeSelect'],
    alias: { '~/composables/useApi': apiModule },
    globals: {
      definePageMeta: () => undefined,
      useI18n: () => (over.englishCopy === true ? enI18n() : i18nStub()),
      useAppToast: () => toastRecorder(),
      useApi: api,
      useRoute: () => ({ params: { project: 'web' } }),
      useRouter: () => ({ push, replace: jest.fn(async () => undefined) }),
      navigateTo: nav,
      // Permissions P1 US-007: the create form follows the project `thread.create` key, and the
      // REPO mode select follows the two `thread.mode.*` keys (thread-agents-modes US-011).
      useProjectPermissions: () => projectPermissionsStub(over.permissions ?? ['thread.create']),
      // US-009: the Re-check of a not-ready agent follows the global `fleet.runner.update` key.
      useGlobalPermissions: () => globalPermissionsStub(over.globalKeys ?? []),
      useFleetDispatchOptions: over.realDispatch === true
        ? useFleetDispatchOptions
        : () => ({
            repos: ref(over.repos ?? [repo()]),
            runners: ref(runners),
            moreRepos: ref(false),
            moreRunners: ref(false),
            settled: ref(over.settled ?? true),
            load: jest.fn(async () => undefined),
            profileOptions: ref([]),
            labelOptions: ref([]),
            repoName: (id: string) => id,
            runnerName: (id: string | null) => id,
          }),
      useProjectSkills: () => ({ list: jest.fn(async () => (over.skills ?? [])) }),
    },
  })
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 6; i += 1) {
      await new Promise((resolve) => { setImmediate(resolve) })
      await Vue.nextTick()
    }
  }
  return { app, post, nav, push, paths, settle }
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).useApi
})

// ── tree helpers ─────────────────────────────────────────────────────────────

const optionValues = (app: Mounted, select: FakeNode): string[] =>
  app.find('option', select).map((option) => String(option.props.value))

const selectsWith = (app: Mounted, value: string): FakeNode[] =>
  app.find('select').filter((select) => optionValues(app, select).includes(value))

/** The only select inside the FormField named `field` (the dispatch-page FormField convention). */
const selectIn = (app: Mounted, field: string): FakeNode | undefined => {
  const div = app.one(`[data-field="${field}"]`)
  return div ? app.find('select', div)[0] : undefined
}

const inputIn = (app: Mounted, field: string): FakeNode | undefined => {
  const div = app.one(`[data-field="${field}"]`)
  return div ? app.find('input', div)[0] : undefined
}

const submitButton = (app: Mounted): FakeNode | undefined =>
  app.find('[data-stub="button"]').find((button) => button.props.type === 'submit')

const must = <T>(value: T | undefined, what: string): T => {
  if (value === undefined) throw new Error(`missing ${what}`)
  return value
}

/** Fills every required field with valid values (dispatch defaults: cap 5, effort/ref empty) and submits. */
async function fillAndSubmit(app: Mounted): Promise<void> {
  const change = (select: FakeNode, value: string): void => {
    const onChange = select.props.onChange as (e: unknown) => void
    onChange({ target: { value } })
  }
  const type = (input: FakeNode, value: string): void => {
    const onInput = input.props.onInput as (e: unknown) => void
    onInput({ target: { value } })
  }
  // The repo select is the only select inside the repoId FormField (dispatch-page convention);
  // fall back to content matching (its options include r1) if the form is laid out differently.
  const repoSelect = selectIn(app, 'repoId') ?? selectsWith(app, 'r1')[0]
  change(must(repoSelect, 'repo select'), 'r1')
  // BackendPicker renders the model select (options include m1) and the effort select (options include low..xhigh).
  change(must(selectsWith(app, 'm1')[0], 'model select'), 'm1')
  type(must(inputIn(app, 'feature'), 'feature input'), 'add-auth')
  type(must(inputIn(app, 'title'), 'title input'), 'Auth spec')
  type(must(inputIn(app, 'maxCostUsd'), 'cap input'), '5')
  await Vue.nextTick()
  const form = must(app.one('form'), 'thread create form')
  await (form.props.onSubmit as (e: { preventDefault: () => void }) => Promise<void>)({ preventDefault: jest.fn() })
}

describe('US-005 AC11-AC15: pages/[project]/threads/new.vue', () => {
  test('AC11: the submit button stays disabled when no runner offers a model', async () => {
    const m = mountPage({})
    await m.settle()

    const submit = submitButton(m.app)
    expect(submit).toBeDefined()
    expect(submit?.props.disabled).toBe(true)
    m.app.unmount()
  })

  test('AC12: submitting valid values posts toCreateThreadBody(values) to /projects/web/threads', async () => {
    const m = mountPage({ models: ['m1'] })
    await m.settle()

    await fillAndSubmit(m.app)

    expect(m.post).toHaveBeenCalledWith('/projects/web/threads', {
      kind: 'REPO', repoId: 'r1', feature: 'add-auth', title: 'Auth spec', maxCostUsd: 5,
      backend: { kind: 'native', model: 'm1' },
      // thread-agents-modes US-011: a REPO create body always carries the mode, native unchanged.
      mode: 'read',
    })
    m.app.unmount()
  })

  test('AC13: after the create post resolves a thread with id th9, the page navigates to /web/threads/th9', async () => {
    const m = mountPage({ models: ['m1'] })
    await m.settle()

    await fillAndSubmit(m.app)

    const path = '/web/threads/th9'
    const navigated = m.nav.mock.calls.some(([to]) => to === path) || m.push.mock.calls.some(([to]) => to === path)
    expect(navigated).toBe(true)
    m.app.unmount()
  })

  test('AC14: when the create post rejects with an ApiError, the page shows extractApiError(error)', async () => {
    const post = jest.fn(async () => { throw new ApiError(409, 'A thread for add-auth already exists') })
    const m = mountPage({ models: ['m1'], post })
    await m.settle()

    await fillAndSubmit(m.app)

    expect(m.app.text()).toContain('A thread for add-auth already exists')
    m.app.unmount()
  })

  test('AC15: lists the enabled project skill spec-review with the first 7 characters of source.resolvedSha', async () => {
    const m = mountPage({
      models: ['m1'],
      skills: [skill({ enabled: true, source: { id: 'src1', gitUrl: 'https://github.com/nathapp-io/nax-spec-kit-skills', ref: 'main', resolvedSha: 'a1b2c3d4e5f6a7b8c9d0e1f', status: 'OK' } })],
    })
    await m.settle()

    const text = m.app.text()
    expect(text).toContain('spec-review')
    expect(text).toContain('a1b2c3d')
    m.app.unmount()
  })
})

// ── US-007: the scope picker (Repo | Project), PROJECT hides the repo fields ──────────────────

/** Drives the scope select (the FormField named kind) like a native change event. */
function setScope(app: Mounted, value: 'REPO' | 'PROJECT'): void {
  const select = must(selectIn(app, 'kind'), 'scope select')
  ;(select.props.onChange as (e: unknown) => void)({ target: { value } })
}

/** Types into a named text input (the Input stub turns input events into update:modelValue). */
function typeInto(app: Mounted, field: string, value: string): void {
  const input = must(inputIn(app, field), `${field} input`)
  ;(input.props.onInput as (e: unknown) => void)({ target: { value } })
}

describe('US-007 AC7-AC9: pages/[project]/threads/new.vue scope picker', () => {
  test('AC7: the scope select offers Repo and Project with Repo selected by default', async () => {
    const m = mountPage({ models: ['m1'] })
    await m.settle()

    const select = must(selectIn(m.app, 'kind'), 'scope select')
    expect(optionValues(m.app, select)).toEqual(['REPO', 'PROJECT'])
    expect(select.props.value).toBe('REPO')
    m.app.unmount()
  })

  test('AC8: choosing Project hides the repo, base-ref and feature fields and keeps the rest', async () => {
    const m = mountPage({ models: ['m1'], projectThreads: true })
    await m.settle()

    expect(m.app.one('[data-field="repoId"]')).toBeDefined()
    expect(m.app.one('[data-field="baseRef"]')).toBeDefined()
    expect(m.app.one('[data-field="feature"]')).toBeDefined()

    setScope(m.app, 'PROJECT')
    await Vue.nextTick()

    expect(m.app.one('[data-field="repoId"]')).toBeUndefined()
    expect(m.app.one('[data-field="baseRef"]')).toBeUndefined()
    expect(m.app.one('[data-field="feature"]')).toBeUndefined()
    expect(m.app.one('[data-field="title"]')).toBeDefined()
    expect(m.app.one('[data-field="maxCostUsd"]')).toBeDefined()
    m.app.unmount()
  })

  test('AC8 (edge): switching back to Repo restores the repo fields with the values they held', async () => {
    const m = mountPage({ models: ['m1'], projectThreads: true })
    await m.settle()

    const repoSelect = must(selectIn(m.app, 'repoId'), 'repo select')
    ;(repoSelect.props.onChange as (e: unknown) => void)({ target: { value: 'r1' } })
    await Vue.nextTick()

    setScope(m.app, 'PROJECT')
    await Vue.nextTick()
    setScope(m.app, 'REPO')
    await Vue.nextTick()

    expect(must(selectIn(m.app, 'repoId'), 'repo select').props.value).toBe('r1')
    m.app.unmount()
  })

  test('AC9: submitting the Project scope posts a PROJECT body with no repo fields', async () => {
    const m = mountPage({ models: ['m1'], projectThreads: true })
    await m.settle()

    setScope(m.app, 'PROJECT')
    await Vue.nextTick()
    typeInto(m.app, 'title', 'Project chat')
    typeInto(m.app, 'maxCostUsd', '5')
    await Vue.nextTick()

    const form = must(m.app.one('form'), 'thread create form')
    await (form.props.onSubmit as (e: { preventDefault: () => void }) => Promise<void>)({ preventDefault: jest.fn() })

    expect(m.post).toHaveBeenCalledWith('/projects/web/threads', {
      kind: 'PROJECT',
      title: 'Project chat',
      maxCostUsd: 5,
      backend: { kind: 'native', model: 'm1' },
    })
    m.app.unmount()
  })
})
// ── US-011: agent and mode on the project new-thread form ──────────────────────────────────────

/** The agent select the picker renders (a raw <select>, so its options are readable directly). */
const agentSelect = (app: Mounted): FakeNode | undefined => app.one('[data-testid="thread-new-agent"]')

/** The mode select lives in the FormField named mode, like the scope and repo fields. */
const modeSelect = (app: Mounted): FakeNode | undefined => selectIn(app, 'mode')

/** Picks an agent through the picker's own select, the way a person does. */
function chooseAgent(app: Mounted, agent: string): void {
  const select = must(agentSelect(app), 'agent select')
  ;(select.props.onChange as (e: unknown) => void)({ target: { value: agent } })
}

/** The codex offer the ACP tests use: launchable, logged in, with its own model list. */
const codexAcp = {
  acp: ['codex'],
  acpOffers: [acpOffer('codex', { models: ['gpt-5-codex', 'gpt-5-codex-mini'], efforts: ['low', 'high'] })],
}

/** Fills the REPO fields (repo, feature, title, cap) without touching agent, model or mode. */
async function fillRepoFields(app: Mounted): Promise<void> {
  const change = (select: FakeNode, value: string): void => {
    const onChange = select.props.onChange as (e: unknown) => void
    onChange({ target: { value } })
  }
  change(must(selectIn(app, 'repoId'), 'repo select'), 'r1')
  typeInto(app, 'feature', 'add-auth')
  typeInto(app, 'title', 'Auth spec')
  typeInto(app, 'maxCostUsd', '5')
  await Vue.nextTick()
}

async function submitForm(app: Mounted): Promise<void> {
  const form = must(app.one('form'), 'thread create form')
  await (form.props.onSubmit as (e: { preventDefault: () => void }) => Promise<void>)({ preventDefault: jest.fn() })
}

describe('US-011 AC-6..AC-8: the REPO mode select follows the caller’s project keys', () => {
  test('AC-6: Read and Ask, not Full, when the caller holds thread.mode.ask but not thread.mode.full', async () => {
    const m = mountPage({ models: ['m1'], permissions: ['thread.create', 'thread.mode.ask'], englishCopy: true })
    await m.settle()

    const select = must(modeSelect(m.app), 'mode select')
    expect(optionValues(m.app, select)).toEqual(['read', 'ask'])
    expect(m.app.find('option', select).map((option) => m.app.textOf(option))).toEqual(['Read', 'Ask'])
    m.app.unmount()
  })

  test('AC-7: Read, Ask and Full when the caller holds both thread.mode keys', async () => {
    const m = mountPage({ models: ['m1'], permissions: ['thread.create', 'thread.mode.ask', 'thread.mode.full'], englishCopy: true })
    await m.settle()

    const select = must(modeSelect(m.app), 'mode select')
    expect(optionValues(m.app, select)).toEqual(['read', 'ask', 'full'])
    expect(m.app.find('option', select).map((option) => m.app.textOf(option))).toEqual(['Read', 'Ask', 'Full'])
    m.app.unmount()
  })

  test('AC-6 (edge): Read alone when the caller holds no mode key', async () => {
    const m = mountPage({ models: ['m1'] })
    await m.settle()

    expect(optionValues(m.app, must(modeSelect(m.app), 'mode select'))).toEqual(['read'])
    m.app.unmount()
  })

  test('AC-7 (edge): choosing a mode the caller may not use is impossible — the select offers only permitted ones', async () => {
    const m = mountPage({ models: ['m1'], permissions: ['thread.create', 'thread.mode.ask'] })
    await m.settle()

    expect(optionValues(m.app, must(modeSelect(m.app), 'mode select'))).not.toContain('full')
    m.app.unmount()
  })

  test('AC-8: the PROJECT scope shows no mode select', async () => {
    const m = mountPage({ models: ['m1'], projectThreads: true, permissions: ['thread.create', 'thread.mode.ask', 'thread.mode.full'] })
    await m.settle()

    expect(modeSelect(m.app)).toBeDefined()

    setScope(m.app, 'PROJECT')
    await Vue.nextTick()

    expect(modeSelect(m.app)).toBeUndefined()
    m.app.unmount()
  })
})

describe('US-011 AC-9, AC-10: the submitted body carries the chosen agent and mode', () => {
  test('AC-9: Codex with gpt-5-codex and mode Ask posts an acp backend and mode ask', async () => {
    const m = mountPage({ models: ['m1'], permissions: ['thread.create', 'thread.mode.ask'], acp: codexAcp })
    await m.settle()

    chooseAgent(m.app, 'codex')
    await Vue.nextTick()
    await fillRepoFields(m.app)
    await Vue.nextTick()

    // The model select now lists Codex's models; pick gpt-5-codex.
    ;(must(selectsWith(m.app, 'gpt-5-codex')[0], 'codex model select').props.onChange as (e: unknown) => void)({ target: { value: 'gpt-5-codex' } })
    ;(must(modeSelect(m.app), 'mode select').props.onChange as (e: unknown) => void)({ target: { value: 'ask' } })
    await Vue.nextTick()

    await submitForm(m.app)

    expect(m.post).toHaveBeenCalledWith('/projects/web/threads', {
      kind: 'REPO',
      repoId: 'r1',
      feature: 'add-auth',
      title: 'Auth spec',
      maxCostUsd: 5,
      backend: { kind: 'acp', agent: 'codex', model: 'gpt-5-codex' },
      mode: 'ask',
    })
    m.app.unmount()
  })

  test('AC-10: Native with an unchanged mode posts backend.kind native and mode read', async () => {
    const m = mountPage({ models: ['m1'] })
    await m.settle()

    await fillAndSubmit(m.app)

    const [, body] = m.post.mock.calls[0] as [string, { backend: { kind: string }; mode: string }]
    expect(body.backend.kind).toBe('native')
    expect(body.mode).toBe('read')
    m.app.unmount()
  })

  // F2: a ready ACP agent may advertise no model, and the API's acp backend takes none. The form must
  // still create the thread (the agent then uses its own default model).
  test('F2: a model-less ready ACP agent can be submitted, posting an acp backend without a model', async () => {
    const m = mountPage({ models: [], acp: { acp: ['claude'], acpOffers: [acpOffer('claude', { models: [], efforts: ['high'] })] } })
    await m.settle()

    // Native can start nothing here, so the form picks the ready ACP agent by itself.
    expect(must(agentSelect(m.app), 'agent select').props.value).toBe('claude')
    expect(must(submitButton(m.app), 'submit button').props.disabled).toBe(false)

    await fillRepoFields(m.app)
    await submitForm(m.app)

    expect(m.post).toHaveBeenCalledWith('/projects/web/threads', {
      kind: 'REPO',
      repoId: 'r1',
      feature: 'add-auth',
      title: 'Auth spec',
      maxCostUsd: 5,
      backend: { kind: 'acp', agent: 'claude' },
      mode: 'read',
    })
    m.app.unmount()
  })

  test('AC-9 (edge): switching agent resets the model to the new agent’s first model and clears the effort', async () => {
    const m = mountPage({ models: ['m1'], acp: codexAcp })
    await m.settle()

    ;(must(selectsWith(m.app, 'm1')[0], 'native model select').props.onChange as (e: unknown) => void)({ target: { value: 'm1' } })
    chooseAgent(m.app, 'codex')
    await Vue.nextTick()

    expect(must(selectsWith(m.app, 'gpt-5-codex')[0], 'codex model select').props.value).toBe('gpt-5-codex')
    expect(must(selectsWith(m.app, 'high')[0], 'codex effort select').props.value).toBe('')
    m.app.unmount()
  })
})

// ── US-005 (K9): the repo chooser tells two repos with one owner/name apart ────────────────────

/** The fixture: `acme/app` on gitlab.com and on a self-hosted GitLab. */
const TWO_HOST_REPOS = [
  { ...repo(), id: 'r1', host: 'https://gitlab.com' },
  { ...repo(), id: 'r2', host: 'https://gitlab.example.com' },
]

describe('US-004 AC-3..AC-7: project thread create guidance', () => {
  test('AC-3: unavailable chosen agent explains why Create is disabled', async () => {
    const m = mountPage({ models: ['m1'], englishCopy: true })
    await m.settle()
    chooseAgent(m.app, 'codex')
    await Vue.nextTick()

    expect(m.app.one('[data-testid="thread-new-unavailable"]')).toBeDefined()
    expect(m.app.text()).toContain('The chosen agent is not available on an online runner. Choose another agent or try again later.')
    expect(submitButton(m.app)?.props.disabled).toBe(true)
    m.app.unmount()
  })

  test('AC-4: available agent and pending runner discovery do not show unavailable warning', async () => {
    const available = mountPage({ models: ['m1'], englishCopy: true })
    await available.settle()
    expect(available.app.one('[data-testid="thread-new-unavailable"]')).toBeUndefined()
    available.app.unmount()

    const pending = mountPage({ settled: false, englishCopy: true })
    await pending.settle()
    expect(pending.app.one('[data-testid="thread-new-unavailable"]')).toBeUndefined()
    pending.app.unmount()
  })

  test('AC-5: missing repository shows its field error and sends no POST', async () => {
    const m = mountPage({ models: ['m1'] })
    await m.settle()
    typeInto(m.app, 'title', 'Auth spec')
    await submitForm(m.app)

    const error = must(m.app.one('[data-field-error="repoId"]'), 'repo field error')
    expect(m.app.textOf(error)).toBe('fleet.threads.new.validation.repoRequired')
    expect(m.post).not.toHaveBeenCalled()
    m.app.unmount()
  })

  test('AC-6: repository and feature are marked required accessibly', async () => {
    const m = mountPage({ models: ['m1'] })
    await m.settle()

    const requiredLabels = m.app.find('[data-stub="form-label"]')
      .map(node => m.app.textOf(node))
      .filter(text => text.includes('*'))
    expect(requiredLabels).toEqual(expect.arrayContaining(['fleet.threads.new.repo *', 'fleet.threads.new.feature *']))
    expect(m.app.one('[data-testid="thread-new-feature"]')?.props['aria-required']).toBe('true')
    m.app.unmount()
  })

  test('AC-7: Feature and selected repository Base ref have contextual hints', async () => {
    const m = mountPage({ models: ['m1'], englishCopy: true })
    await m.settle()
    const repoSelect = must(selectIn(m.app, 'repoId'), 'repo select')
    ;(repoSelect.props.onChange as (event: unknown) => void)({ target: { value: 'r1' } })
    await Vue.nextTick()

    expect(m.app.text()).toContain('Names the branch and the nax feature, for example fix-login-redirect')
    expect(m.app.text()).toContain('Leave empty to start from main')
    m.app.unmount()
  })
})

describe('US-005 AC-9: pages/[project]/threads/new.vue repo chooser', () => {
  test('AC-9: a shared owner/name is labelled with its host', async () => {
    const m = mountPage({ models: ['m1'], repos: TWO_HOST_REPOS })
    await m.settle()

    const select = must(selectIn(m.app, 'repoId'), 'repo select')
    const choices = m.app.find('option', select).filter((option) => String(option.props.value) !== '')
    expect(choices.map((option) => String(option.props.value))).toEqual(['r1', 'r2'])
    expect(choices.map((option) => m.app.textOf(option))).toEqual([
      'acme/app (gitlab.com)',
      'acme/app (gitlab.example.com)',
    ])
    m.app.unmount()
  })
})

// ── US-009: the readiness notice and its Re-check on the project form ─────────────────────────

const T0 = '2026-11-22T02:00:00.000Z'

/** The codex probe that timed out at T0: launchable on r1, login unconfirmed. */
const codexTimeoutOffer = (): Record<string, unknown> => acpOffer('codex', {
  launchable: true,
  loggedIn: null,
  checkedAt: T0,
  lastError: { code: 'timeout', at: T0 },
})

/** AC-8 fixture: online, enabled, REPO-capable r1 with native m1, whose codex probe timed out at T0. */
const timeoutRunner = (): Record<string, unknown> => runnerWithModels(['m1'], { id: 'r1' }, { acp: [], acpOffers: [codexTimeoutOffer()] })

/**
 * A runner that already reports codex ready (so codex has nothing to re-check), plus a claude probe
 * that timed out: the notice area does render on this mount, just never for codex.
 */
const readyCodexRunner = (): Record<string, unknown> => runnerWithModels(['m1'], { id: 'r1' }, {
  acp: ['codex'],
  acpOffers: [
    acpOffer('codex', { checkedAt: T0 }),
    acpOffer('claude', {
      launchable: true,
      loggedIn: null,
      checkedAt: T0,
      lastError: { code: 'timeout', at: T0 },
    }),
  ],
})

/** AC-8 fixture: online, enabled, REPO-capable r1 with native m1, whose codex and claude probes timed out at T0. */
const twoNotReadyRunner = (): Record<string, unknown> => runnerWithModels(['m1'], { id: 'r1' }, {
  acp: [],
  acpOffers: [
    codexTimeoutOffer(),
    acpOffer('claude', { launchable: true, loggedIn: null, checkedAt: T0, lastError: { code: 'timeout', at: T0 } }),
  ],
})

const readinessNotice = (app: Mounted): FakeNode | undefined => app.one('[data-testid="agent-readiness-codex"]')
const recheckButton = (app: Mounted): FakeNode | undefined => app.one('[data-testid="agent-recheck-codex"]')

/** Clicks a rendered button the way a person does. */
const click = (node: FakeNode): void => {
  const onClick = node.props.onClick as (() => void) | undefined
  must(onClick, 'click handler')()
}

describe('US-009 AC-8..AC-10, AC-12: agent readiness on pages/[project]/threads/new.vue', () => {
  test('AC-8: a not-ready codex renders its notice with the timeout text while native stays chosen', async () => {
    const m = mountPage({
      models: ['m1'],
      acp: { acp: [], acpOffers: [codexTimeoutOffer()] },
      globalKeys: ['fleet.runner.update'],
      englishCopy: true,
    })
    await m.settle()

    expect(must(agentSelect(m.app), 'agent select').props.value).toBe('native')
    expect(m.app.textOf(must(readinessNotice(m.app), 'codex readiness notice')))
      .toContain(enI18n().t('fleet.threads.new.agent.probe.timeout'))
    m.app.unmount()
  })

  test('AC-9: clicking agent-recheck-codex posts /fleet/runners/r1/reprobe', async () => {
    const m = mountPage({
      realDispatch: true,
      dispatchRunners: [timeoutRunner()],
      globalKeys: ['fleet.runner.update'],
    })
    await m.settle()

    // The refresh the click starts schedules its first read 10 s out; the post itself settles now.
    jest.useFakeTimers({ doNotFake: ['setImmediate'] })
    try {
      click(must(recheckButton(m.app), 're-check button'))
      await m.settle()

      expect(m.post.mock.calls).toEqual([['/fleet/runners/r1/reprobe']])
    }
    finally {
      jest.useRealTimers()
    }
    m.app.unmount()
  })

  test('AC-10: a re-check reloads the runner list through options.load and keeps the chosen native', async () => {
    const m = mountPage({
      realDispatch: true,
      dispatchRunners: [timeoutRunner()],
      globalKeys: ['fleet.runner.update'],
    })
    await m.settle()
    const runnersBefore = m.paths.filter(path => path.endsWith('/fleet/runners')).length

    jest.useFakeTimers({ doNotFake: ['setImmediate'] })
    try {
      click(must(recheckButton(m.app), 're-check button'))
      await jest.advanceTimersByTimeAsync(10_000)

      expect(m.paths.filter(path => path.endsWith('/fleet/runners')).length).toBe(runnersBefore + 1)
      expect(must(agentSelect(m.app), 'agent select').props.value).toBe('native')
    }
    finally {
      jest.useRealTimers()
    }
    m.app.unmount()
  })

  test('AC-12: a runner whose codex is in acp renders no codex readiness notice', async () => {
    const m = mountPage({
      realDispatch: true,
      dispatchRunners: [readyCodexRunner()],
      globalKeys: ['fleet.runner.update'],
    })
    await m.settle()

    // The not-ready claude still renders its own notice: the absence of codex's is about codex.
    expect(m.app.one('[data-testid="agent-readiness-claude"]')).toBeDefined()
    expect(readinessNotice(m.app)).toBeUndefined()
    m.app.unmount()
  })

  // B1 (review round 2): only one re-check runs at a time, so every notice is locked while one is in
  // flight. Without this a second click started a second post and a second polling loop, and the
  // first one to finish re-enabled the other's button.
  test('B1: while codex re-checks, the claude button is disabled and a second codex click posts nothing', async () => {
    const m = mountPage({
      realDispatch: true,
      dispatchRunners: [twoNotReadyRunner()],
      globalKeys: ['fleet.runner.update'],
    })
    await m.settle()
    const claudeButton = (): FakeNode | undefined => m.app.one('[data-testid="agent-recheck-claude"]')
    expect(must(claudeButton(), 'claude re-check button').props.disabled).toBeFalsy()

    jest.useFakeTimers({ doNotFake: ['setImmediate'] })
    try {
      // The post settles now; the 10 s refresh keeps the re-check running, so the state stays held.
      click(must(recheckButton(m.app), 'codex re-check button'))
      await m.settle()

      expect(must(recheckButton(m.app), 'codex re-check button').props.disabled).toBe(true)
      expect(must(claudeButton(), 'claude re-check button').props.disabled).toBe(true)
      // The notice keeps its own copy: only the button state is locked.
      expect(m.app.textOf(must(claudeButton(), 'claude re-check button')))
        .toContain('fleet.threads.new.agent.recheck')

      click(must(recheckButton(m.app), 'codex re-check button'))
      await m.settle()
      expect(m.post.mock.calls).toEqual([['/fleet/runners/r1/reprobe']])
    }
    finally {
      jest.useRealTimers()
    }
    m.app.unmount()
  })
})
