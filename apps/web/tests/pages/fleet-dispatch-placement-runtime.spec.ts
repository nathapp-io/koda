import { describe, expect, test } from '@jest/globals'
import * as Vue from 'vue'
import { useField } from 'vee-validate'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import type { Mounted } from '../helpers/mount-sfc'
import { enI18n, toastRecorder } from '../helpers/fleet-harness'
import { projectPermissionsStub } from '../helpers/permission-nav'

const dispatchPage = webFile('pages', '[project]', 'fleet', 'dispatch.vue')

/** US-005: the fixture the repo-chooser case mounts — one owner/name on two forges. */
const TWO_HOST_REPOS = [
  { id: 'r1', owner: 'acme', name: 'app', host: 'https://gitlab.com', defaultBranch: 'main' },
  { id: 'r2', owner: 'acme', name: 'app', host: 'https://gitlab.example.com', defaultBranch: 'main' },
]

type Fields = Record<string, { value: { value: unknown } }>

/**
 * The dispatch page mounted on the stubs this spec needs: a FormField that registers its field with
 * the page's real `useForm`, a token list that emits a label, and a `useFleetJobs` double that records
 * the body it was dispatched with (`bodies`).
 */
function mountDispatch(repos: Record<string, unknown>[]): { app: Mounted; fields: Fields; bodies: unknown[] } {
  const fields: Fields = {}
  const bodies: unknown[] = []
  const FormField = {
    props: ['name'],
    setup(props: { name: string }, { slots }: { slots: { default?: (arg: unknown) => unknown } }) {
      const field = useField(() => props.name)
      fields[props.name] = field
      const componentField = Vue.computed(() => ({
        modelValue: field.value.value,
        'onUpdate:modelValue': field.handleChange,
        onBlur: field.handleBlur,
      }))
      return () => Vue.h('x-field', slots.default?.({ componentField: componentField.value }) as never)
    },
  }
  const TokenInput = {
    emits: ['update:modelValue'],
    props: ['testId'],
    setup(props: { testId: string }, { emit }: { emit: (event: string, value: string[]) => void }) {
      return () => Vue.h('button', { 'data-testid': `${props.testId}-input`, onClick: () => emit('update:modelValue', ['gpu']) })
    },
  }
  const api = { dispatch: async (body: unknown) => {
    bodies.push(body)
    return { placement: { assigned: false, runnerId: null, misfits: [] }, job: { id: 'job-1' } }
  } }
  const toast = toastRecorder()
  const app = mountSfc(dispatchPage, {
    components: {
      FormField,
      FormItem: { setup: (_p: unknown, { slots }: { slots: { default?: () => unknown } }) => () => Vue.h('div', slots.default?.() as never) },
      FormControl: { setup: (_p: unknown, { slots }: { slots: { default?: () => unknown } }) => () => Vue.h('div', slots.default?.() as never) },
      FormLabel: 'label', FormMessage: 'span', Input: 'input', Button: 'button', Label: 'label',
      PageHeader: 'header', ErrorState: 'div', FleetPlacementResult: 'div',
    },
    alias: {
      '~/components/fleet/FleetTokenListInput.vue': TokenInput,
      '~/components/fleet/TicketPicker.vue': { render: () => null },
    },
    globals: {
      ref: Vue.ref, computed: Vue.computed, onMounted: Vue.onMounted,
      useRoute: () => ({ params: { project: 'koda' } }),
      useI18n: () => enI18n(), useAppToast: () => toast,
      useFleetDispatchOptions: () => ({
        repos: Vue.ref(repos),
        runners: Vue.ref([]), moreRepos: Vue.ref(false), moreRunners: Vue.ref(false),
        profileOptions: Vue.ref([]), labelOptions: Vue.ref([]), runnerName: () => '',
        load: async () => undefined,
      }),
      // Permissions P1 US-008: the form is open to whoever holds the dispatch key.
      useProjectPermissions: () => projectPermissionsStub(['fleet.job.dispatch']),
      useFleetJobs: () => ({ dispatch: api.dispatch, findActiveJob: async () => null }),
    },
  })
  return { app, fields, bodies }
}

describe('fleet dispatch placement form runtime', () => {
  test('submits after labels are entered and placement switches to auto', async () => {
    const { app, fields, bodies } = mountDispatch([{ id: 'repo-1', owner: 'acme', name: 'app', defaultBranch: 'main' }])

    fields.repoId.value.value = 'repo-1'
    fields.feature.value.value = 'feature'
    await Vue.nextTick()
    const form = app.one('[data-testid="dispatch-form"]')
    if (!form) throw new Error('dispatch form did not render')
    const submit = form.props.onSubmit as (event: Event) => Promise<void>
    const click = (testid: string): void => {
      const target = app.one(`[data-testid="${testid}"]`)
      if (!target) throw new Error(`missing placement control: ${testid}`)
      expect(typeof target.props.onClick).toBe('function')
      if (typeof target.props.onClick !== 'function') throw new Error(`placement control is not clickable: ${testid}`)
      target.props.onClick()
    }
    const labelsRadio = app.one('[data-testid="placement-labels"]')
    if (!labelsRadio) throw new Error('Missing labels radio')
    ;(labelsRadio.props.onChange as () => void)()
    await Vue.nextTick()
    click('dispatch-labels-input')
    await Vue.nextTick()
    expect(fields.selectorLabels.value.value).toEqual(['gpu'])
    const autoRadio = app.one('[data-testid="placement-auto"]')
    if (!autoRadio) throw new Error('Missing auto radio')
    ;(autoRadio.props.onChange as () => void)()
    await Vue.nextTick()

    await submit({ preventDefault: () => undefined, stopPropagation: () => undefined } as unknown as Event)

    expect(bodies).toHaveLength(1)
    app.unmount()
  })

  /**
   * US-005 AC-8 (K9): the dispatch page's repo chooser tells two repos apart that share `owner/name`.
   * The page hands `FleetNativeSelect` its options, so reading them is reading what a person picks from.
   */
  test('US-005 AC-8: the repo chooser labels a shared owner/name with its host', async () => {
    const { app } = mountDispatch(TWO_HOST_REPOS)
    await Vue.nextTick()

    const repoSelect = app.find('FleetNativeSelect').find((node) => node.props.id === 'dispatch-repo')
    expect(repoSelect).toBeDefined()
    expect(repoSelect?.props.options).toEqual([
      { value: 'r1', label: 'acme/app (gitlab.com)' },
      { value: 'r2', label: 'acme/app (gitlab.example.com)' },
    ])
    app.unmount()
  })
})
