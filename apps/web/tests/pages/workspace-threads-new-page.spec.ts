import { afterEach, describe, expect, jest, test } from '@jest/globals'
import * as Vue from 'vue'
import { defineComponent, h } from 'vue'
import { useField } from 'vee-validate'
import { mountSfc, webFile, loadSfc } from '../helpers/mount-sfc'
import type { FakeNode, Mounted } from '../helpers/mount-sfc'
import { i18nStub, uiStubs } from '../helpers/fleet-harness'
import * as apiModule from '../../composables/useApi'
import { ApiError } from '../../composables/useApi'
import { useFleetDispatchOptions } from '~/composables/useFleetDispatchOptions'
import type { FleetRunnerSummary } from '~/lib/fleet-types'

/**
 * US-005 AC-6..AC-11: pages/threads/new.vue — the personal (workspace) thread create form.
 *
 * The page is not project-scoped: it lists the caller's projects to pick a home project, and reads
 * the runner summaries of that project (or of the first listed one while Automatic is selected)
 * through the real `useFleetDispatchOptions`. `$api` is stubbed, so the assertions are on the
 * requests and the POST body the page really produces.
 */
const pageFile = webFile('pages', 'threads', 'new.vue')

const project = (slug: string, name: string, id = 1) => ({ id, slug, name })
const defaultProjects = [project('web', 'Web', 1), project('api', 'API', 2)]

/** A runner summary; WORKSPACE models come only from online, enabled runners advertising it. */
const runner = (over: Partial<FleetRunnerSummary> & { id: string }): FleetRunnerSummary => ({
  name: over.id,
  os: 'linux',
  arch: 'x64',
  labels: [],
  enabled: true,
  online: true,
  profiles: [],
  threadBackends: { native: [], acp: [] },
  projectThreads: false,
  workspaceThreads: true,
  ...over,
})

const native = (models: string[]): { native: string[]; acp: string[] } => ({ native: models, acp: [] })

// ── stubs (the create-user-dialog pattern: real vee-validate, real page, fake DOM) ─────────────

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

const g = globalThis as Record<string, unknown>

interface PageOver {
  projects?: unknown[]
  runners?: FleetRunnerSummary[]
  post?: jest.Mock
  projectsFail?: boolean
}

function mountPage(over: PageOver = {}) {
  const paths: string[] = []
  const get = jest.fn(async (path: string) => {
    paths.push(path)
    if (path === '/projects') {
      if (over.projectsFail === true) throw new ApiError(500, 'projects unavailable')
      return over.projects ?? defaultProjects
    }
    if (path.endsWith('/fleet/runners')) return { records: over.runners ?? [], hasNext: false }
    if (path.endsWith('/fleet/repos')) return { records: [], hasNext: false }
    return {}
  })
  const post = over.post ?? jest.fn(async () => ({ id: 'th9' }))
  const nav = jest.fn(async () => undefined)
  const api = () => ({ $api: { get, post } })
  g.useApi = api
  const app = mountSfc(pageFile, {
    components: { ...stubs, FormField, Input, FleetThreadsBackendPicker: backendPicker },
    fleetComponents: ['FleetNativeSelect'],
    alias: { '~/composables/useApi': apiModule },
    globals: {
      definePageMeta: () => undefined,
      useI18n: () => i18nStub(),
      useApi: api,
      useRoute: () => ({ params: {}, query: {} }),
      navigateTo: nav,
      useFleetDispatchOptions,
    },
  })
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 6; i += 1) {
      await new Promise((resolve) => { setImmediate(resolve) })
      await Vue.nextTick()
    }
  }
  return { app, get, post, nav, paths, settle }
}

// ── tree helpers ─────────────────────────────────────────────────────────────────────────────

const must = <T>(value: T | undefined, what: string): T => {
  if (value === undefined) throw new Error(`missing ${what}`)
  return value
}

const optionValues = (app: Mounted, select: FakeNode): string[] =>
  app.find('option', select).map((option) => String(option.props.value))

/** The labelled field control, inside the FormField the test stub marks with `data-field`. */
const fieldIn = (app: Mounted, field: string): FakeNode | undefined => app.one(`[data-field="${field}"]`)

const selectIn = (app: Mounted, field: string): FakeNode | undefined => {
  const div = fieldIn(app, field)
  return div ? app.find('select', div)[0] : undefined
}

const inputIn = (app: Mounted, field: string): FakeNode | undefined => {
  const div = fieldIn(app, field)
  return div ? app.find('input', div)[0] : undefined
}

/** Drives the home project select like a native change event. */
const pickHomeProject = (app: Mounted, value: string): void => {
  const select = must(selectIn(app, 'homeProject'), 'home project select')
  ;(select.props.onChange as (e: unknown) => void)({ target: { value } })
}

const typeInto = (app: Mounted, field: string, value: string): void => {
  const input = must(inputIn(app, field), `${field} input`)
  ;(input.props.onInput as (e: unknown) => void)({ target: { value } })
}

/** The model options the form offers (BackendPicker's own select, `thread-new-model`). */
const modelOptions = (app: Mounted): string[] => {
  const select = app.one('[data-testid="thread-new-model"]')
  return select ? optionValues(app, select) : []
}

async function submit(app: Mounted): Promise<void> {
  await Vue.nextTick()
  const form = must(app.one('form'), 'workspace thread create form')
  await (form.props.onSubmit as (e: { preventDefault: () => void }) => Promise<void>)({ preventDefault: jest.fn() })
}

afterEach(() => {
  delete g.useApi
})

describe('US-005 AC-6..AC-11: pages/threads/new.vue', () => {
  test('AC-6: the home project select offers Automatic first, then one option per project', async () => {
    const m = mountPage()
    await m.settle()

    const select = must(selectIn(m.app, 'homeProject'), 'home project select')
    expect(optionValues(m.app, select)).toEqual(['', 'web', 'api'])
    const options = m.app.find('option', select)
    expect(m.app.textOf(must(options[0], 'automatic option'))).toBe('fleet.threads.workspace.homeAutomatic')
    expect(m.app.textOf(must(options[1], 'first project option'))).toBe('Web')
    expect(m.app.textOf(must(options[2], 'second project option'))).toBe('API')
    m.app.unmount()
  })

  test('AC-7: with Automatic selected the runner summaries come from the first listed project', async () => {
    const m = mountPage({ runners: [runner({ id: 'rn1', threadBackends: native(['m1']) })] })
    await m.settle()

    expect(m.paths).toContain('/projects/web/fleet/runners')
    expect(m.paths).not.toContain('/projects/api/fleet/runners')
    m.app.unmount()
  })

  test('AC-7 (edge): picking a home project reads that project’s runner summaries', async () => {
    const m = mountPage({ runners: [runner({ id: 'rn1', threadBackends: native(['m1']) })] })
    await m.settle()

    pickHomeProject(m.app, 'api')
    await m.settle()

    expect(m.paths).toContain('/projects/api/fleet/runners')
    m.app.unmount()
  })

  test('AC-8: only models of online, enabled runners advertising workspaceThreads are offered', async () => {
    const m = mountPage({
      runners: [
        runner({ id: 'online', threadBackends: native(['m1', 'm2']) }),
        runner({ id: 'offline', online: false, threadBackends: native(['m3']) }),
        runner({ id: 'disabled', enabled: false, threadBackends: native(['m4']) }),
        runner({ id: 'repo-only', workspaceThreads: false, threadBackends: native(['m5']) }),
        runner({ id: 'acp-only', threadBackends: { native: [], acp: ['m6'] } }),
      ],
    })
    await m.settle()

    expect(modelOptions(m.app)).toEqual(['m1', 'm2'])
    m.app.unmount()
  })

  test('AC-9: submitting with Automatic posts a body without homeProject and opens the new thread', async () => {
    const m = mountPage({ runners: [runner({ id: 'rn1', threadBackends: native(['m1']) })] })
    await m.settle()

    typeInto(m.app, 'title', 't')
    await submit(m.app)

    expect(m.post).toHaveBeenCalledWith('/threads', { title: 't', maxCostUsd: 5, backend: { kind: 'native', model: 'm1' } })
    expect(m.nav).toHaveBeenCalledWith('/threads/th9')
    m.app.unmount()
  })

  test('AC-10: submitting with home project web posts a body whose homeProject is web', async () => {
    const m = mountPage({ runners: [runner({ id: 'rn1', threadBackends: native(['m1']) })] })
    await m.settle()

    pickHomeProject(m.app, 'web')
    await m.settle()
    typeInto(m.app, 'title', 't')
    await submit(m.app)

    expect(m.post).toHaveBeenCalledWith('/threads', {
      title: 't',
      maxCostUsd: 5,
      backend: { kind: 'native', model: 'm1' },
      homeProject: 'web',
    })
    m.app.unmount()
  })

  test('AC-11: a 403 threads.homeProjectAccess shows the API message and does not navigate', async () => {
    const post = jest.fn(async () => { throw new ApiError(403, 'threads.homeProjectAccess') })
    const m = mountPage({ runners: [runner({ id: 'rn1', threadBackends: native(['m1']) })], post })
    await m.settle()

    pickHomeProject(m.app, 'api')
    await m.settle()
    typeInto(m.app, 'title', 't')
    await submit(m.app)

    expect(m.app.text()).toContain('threads.homeProjectAccess')
    expect(m.nav).not.toHaveBeenCalled()
    m.app.unmount()
  })

  test('AC-6 (edge): with no projects listed no runner summaries load and no model is offered', async () => {
    const m = mountPage({ projects: [], runners: [runner({ id: 'rn1', threadBackends: native(['m1']) })] })
    await m.settle()

    const select = must(selectIn(m.app, 'homeProject'), 'home project select')
    expect(optionValues(m.app, select)).toEqual([''])
    expect(m.paths.filter(path => path.endsWith('/fleet/runners'))).toEqual([])
    expect(modelOptions(m.app)).toEqual([])
    m.app.unmount()
  })
})
