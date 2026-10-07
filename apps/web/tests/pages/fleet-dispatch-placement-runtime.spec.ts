import { describe, expect, test } from '@jest/globals'
import * as Vue from 'vue'
import { useField } from 'vee-validate'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, toastRecorder } from '../helpers/fleet-harness'

const dispatchPage = webFile('pages', '[project]', 'fleet', 'dispatch.vue')

describe('fleet dispatch placement form runtime', () => {
  test('submits after labels are entered and placement switches to auto', async () => {
    const fields: Record<string, { value: { value: unknown } }> = {}
    let dispatched: unknown[] = []
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
    const RadioGroup = {
      emits: ['update:modelValue'],
      setup(_props: unknown, { emit }: { emit: (event: string, value: string) => void }) {
        return () => Vue.h('x-radio-group', [
          Vue.h('button', { 'data-testid': 'mode-labels', onClick: () => emit('update:modelValue', 'labels') }),
          Vue.h('button', { 'data-testid': 'mode-auto', onClick: () => emit('update:modelValue', 'auto') }),
        ])
      },
    }
    const api = { dispatch: async (body: unknown) => {
      dispatched = [...dispatched, body]
      return { placement: { assigned: false, runnerId: null, misfits: [] }, job: { id: 'job-1' } }
    } }
    const toast = toastRecorder()
    const app = mountSfc(dispatchPage, {
      components: {
        FormField,
        RadioGroup,
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
          repos: Vue.ref([{ id: 'repo-1', owner: 'acme', name: 'app', defaultBranch: 'main' }]),
          runners: Vue.ref([]), moreRepos: Vue.ref(false), moreRunners: Vue.ref(false),
          profileOptions: Vue.ref([]), labelOptions: Vue.ref([]), runnerName: () => '',
          load: async () => undefined,
        }),
        useProjectViewerRole: () => ({ data: Vue.ref({ canManage: false, viewerRole: 'DEVELOPER' }) }),
        useFleetJobs: () => ({ dispatch: api.dispatch, findActiveJob: async () => null }),
        canWorkOnFleet: () => true,
      },
    })

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
    click('mode-labels')
    await Vue.nextTick()
    click('dispatch-labels-input')
    await Vue.nextTick()
    expect(fields.selectorLabels.value.value).toEqual(['gpu'])
    click('mode-auto')
    await Vue.nextTick()

    await submit({ preventDefault: () => undefined, stopPropagation: () => undefined } as unknown as Event)

    expect(dispatched).toHaveLength(1)
    app.unmount()
  })
})
