import { describe, expect, jest, test } from '@jest/globals'
import * as Vue from 'vue'
import { defineComponent, h, ref } from 'vue'
import { useField } from 'vee-validate'
import { mountSfc, webFile, loadSfc } from '../helpers/mount-sfc'
import type { FakeNode, Mounted } from '../helpers/mount-sfc'
import { i18nStub, toastRecorder, uiStubs } from '../helpers/fleet-harness'
import * as apiModule from '../../composables/useApi'
import { projectPermissionsStub } from '../helpers/permission-nav'
import { ApiError } from '../../composables/useApi'

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

/** A native-capable runner summary (SEAM-4: threadBackends feeds eligibleModels). */
const runnerWithModels = (models: string[], over: Record<string, unknown> = {}) => ({
  id: 'rn1', name: 'mac-1', os: 'linux', arch: 'x64', labels: [], enabled: true, online: true,
  profiles: [], threadBackends: { native: models, acp: [] }, projectThreads: false, ...over,
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
    const { value, handleChange, handleBlur } = useField<string>(() => props.name)
    return () => h('div', { ...attrs, 'data-field': props.name }, slots.default?.({ componentField: {
      modelValue: value.value,
      'onUpdate:modelValue': handleChange,
      onBlur: handleBlur,
    } }))
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
  skills?: Record<string, unknown>[]
  post?: jest.Mock
}

function mountPage(over: PageOver = {}) {
  const post = over.post ?? jest.fn(async () => ({ id: 'th9' }))
  const get = jest.fn(async () => ({}))
  const nav = jest.fn(async () => undefined)
  const push = jest.fn(async () => undefined)
  const runners = over.models ? [runnerWithModels(over.models, { projectThreads: over.projectThreads ?? false })] : []
  const app = mountSfc(pageFile, {
    components: { ...stubs, FormField, Input, FleetThreadsBackendPicker: backendPicker },
    fleetComponents: ['FleetNativeSelect'],
    alias: { '~/composables/useApi': apiModule },
    globals: {
      definePageMeta: () => undefined,
      useI18n: () => i18nStub(),
      useAppToast: () => toastRecorder(),
      useApi: () => ({ $api: { get, post } }),
      useRoute: () => ({ params: { project: 'web' } }),
      useRouter: () => ({ push, replace: jest.fn(async () => undefined) }),
      navigateTo: nav,
      // Permissions P1 US-007: the create form follows the project `thread.create` key.
      useProjectPermissions: () => projectPermissionsStub(['thread.create']),
      useFleetDispatchOptions: () => ({
        repos: ref([repo()]),
        runners: ref(runners),
        moreRepos: ref(false),
        moreRunners: ref(false),
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
  return { app, post, nav, push, settle }
}

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
      kind: 'REPO', repoId: 'r1', feature: 'add-auth', title: 'Auth spec', maxCostUsd: 5, backend: { kind: 'native', model: 'm1' },
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