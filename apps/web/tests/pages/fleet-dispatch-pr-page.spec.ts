import { describe, expect, test } from '@jest/globals'
import * as Vue from 'vue'
import { useField } from 'vee-validate'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, toastRecorder } from '../helpers/fleet-harness'
import { projectPermissionsStub } from '../helpers/permission-nav'

const dispatchPage = webFile('pages', '[project]', 'fleet', 'dispatch.vue')

function mountDispatch(query: Record<string, unknown> = {}, permissionKeys: string[] = ['fleet.job.dispatch'], permissionPending = false) {
  const fields: Record<string, { value: { value: unknown } }> = {}
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
    props: ['modelValue', 'testId'],
    render(this: { testId: string }) {
      return Vue.h('x-token-input', { 'data-testid': this.testId, modelValue: (this as unknown as { $props: { modelValue: unknown } }).$props.modelValue })
    },
  }
  const toast = toastRecorder()
  const app = mountSfc(dispatchPage, {
    components: {
      FormField,
      FormItem: { setup: (_p: unknown, { slots }: { slots: { default?: () => unknown } }) => () => Vue.h('div', slots.default?.() as never) },
      FormControl: { setup: (_p: unknown, { slots }: { slots: { default?: () => unknown } }) => () => Vue.h('div', slots.default?.() as never) },
      FormLabel: 'label', FormMessage: 'span', Input: 'input', Button: 'button', Label: 'label',
      PageHeader: 'header', ErrorState: 'div', LoadingState: 'x-loading-state', FleetPlacementResult: 'div', FleetBudgetBanner: 'div', NuxtLink: 'a',
      RadioGroup: { setup: (_props: unknown, { slots }: { slots: { default?: () => unknown } }) => () => Vue.h('div', slots.default?.() as never) },
      RadioGroupItem: 'input',
    },
    fleetComponents: ['FleetNativeSelect'],
    alias: {
      '~/components/fleet/FleetTokenListInput.vue': TokenInput,
      '~/components/fleet/TicketPicker.vue': {
        props: ['testId'],
        render(this: { testId: string }) { return Vue.h('x-ticket-picker', { 'data-testid': this.testId }) },
      },
    },
    globals: {
      ref: Vue.ref, computed: Vue.computed, onMounted: Vue.onMounted,
      useRoute: () => ({ params: { project: 'koda' }, query }),
      useI18n: () => enI18n(), useAppToast: () => toast,
      useFleetDispatchOptions: () => ({
        repos: Vue.ref([{ id: 'repo-1', owner: 'acme', name: 'app', defaultBranch: 'main' }]),
        runners: Vue.ref([]), moreRepos: Vue.ref(false), moreRunners: Vue.ref(false),
        profileOptions: Vue.ref([]), labelOptions: Vue.ref([]), runnerName: () => '', load: async () => undefined,
      }),
      useProjectPermissions: () => projectPermissionsStub(permissionKeys, { pending: permissionPending }),
      useFleetJobs: () => ({ dispatch: async () => null, findActiveJob: async () => null }),
    },
  })
  return { app, fields }
}

describe('fleet dispatch PR commands', () => {
  test('pending permissions show loading without a denial; settled permissions gate by key', async () => {
    const pending = mountDispatch({}, [], true)
    await Vue.nextTick()
    expect(pending.app.one('x-loading-state')).toBeDefined()
    expect(pending.app.one('[data-testid="dispatch-no-permission"]')).toBeUndefined()
    pending.app.unmount()

    const denied = mountDispatch({}, [])
    await Vue.nextTick()
    expect(denied.app.one('[data-testid="dispatch-no-permission"]')).toBeDefined()
    denied.app.unmount()

    const allowed = mountDispatch()
    await Vue.nextTick()
    expect(allowed.app.one('[data-testid="dispatch-no-permission"]')).toBeUndefined()
    allowed.app.unmount()
  })
  test.each(['RUN', 'PLAN', 'REVIEW', 'FIX'])('%s fields have label associations', async (command) => {
    const { app, fields } = mountDispatch()
    await Vue.nextTick()
    fields.command.value.value = command
    await Vue.nextTick()
    for (const name of ['repo', 'command', 'max-cost', ...(command === 'RUN' || command === 'PLAN' ? ['ref', 'feature'] : ['pr-number']), ...(command === 'PLAN' ? ['plan-from'] : []), ...(command === 'RUN' ? ['bash-mode'] : [])]) {
      const control = app.one(`[data-testid="dispatch-${name}"]`)
      expect(control).toBeDefined()
      expect(control?.props.id).toBeTruthy()
      expect(app.one(`[for="${control?.props.id}"]`)).toBeDefined()
    }
    app.unmount()
  })

  test('placement uses one native radio per choice and switches placement fields', async () => {
    const { app } = mountDispatch()
    await Vue.nextTick()
    const labels = app.one('[data-testid="placement-labels"]')
    if (!labels) throw new Error('Missing labels placement')
    expect(labels.tag).toBe('input')
    expect(labels.props.type).toBe('radio')
    expect(labels.props.name).toBe('dispatch-placement')
    ;(labels.props.onChange as () => void)()
    await Vue.nextTick()
    expect(app.one('[data-testid="dispatch-labels"]')).toBeDefined()
    const pin = app.one('[data-testid="placement-pin"]')
    if (!pin) throw new Error('Missing pin placement')
    ;(pin.props.onChange as () => void)()
    await Vue.nextTick()
    expect(app.one('[data-testid="dispatch-pin"]')).toBeDefined()
    expect(app.one('[data-testid="dispatch-labels"]')).toBeUndefined()
    app.unmount()
  })

  test('AC-1: command select offers RUN, PLAN, REVIEW and FIX', async () => {
    const { app } = mountDispatch()
    await Vue.nextTick()
    const command = app.one('[data-testid="dispatch-command"]')
    expect(command).toBeDefined()
    expect(app.find('option', command).map(option => option.props.value).filter(value => typeof value === 'string')).toEqual(['RUN', 'PLAN', 'REVIEW', 'FIX'])
    app.unmount()
  })

  test('AC-2: FIX renders the PR number input', async () => {
    const { app, fields } = mountDispatch()
    await Vue.nextTick()
    fields.command.value.value = 'FIX'
    await Vue.nextTick()
    expect(app.one('[data-testid="dispatch-pr-number"]')).toBeDefined()
    app.unmount()
  })

  test.each(['dispatch-feature', 'dispatch-ref', 'dispatch-plan-from', 'dispatch-tickets'])('AC-3: FIX hides %s', async (testId) => {
    const { app, fields } = mountDispatch()
    await Vue.nextTick()
    fields.command.value.value = 'FIX'
    await Vue.nextTick()
    expect(app.one(`[data-testid="${testId}"]`)).toBeUndefined()
    app.unmount()
  })

  test('AC-4: RUN renders feature', async () => {
    const { app } = mountDispatch()
    await Vue.nextTick()
    expect(app.one('[data-testid="dispatch-feature"]')).toBeDefined()
    app.unmount()
  })

  test('AC-5: RUN renders tickets', async () => {
    const { app } = mountDispatch()
    await Vue.nextTick()
    expect(app.one('[data-testid="dispatch-tickets"]')).toBeDefined()
    app.unmount()
  })

  test('AC-6: RUN does not render PR number', async () => {
    const { app } = mountDispatch()
    await Vue.nextTick()
    expect(app.one('[data-testid="dispatch-pr-number"]')).toBeUndefined()
    app.unmount()
  })

  test('AC-7/8/9: review query prefills PR and profiles and shows review notice', async () => {
    const { app } = mountDispatch({ command: 'FIX', repoId: 'repo-1', prNumber: '23', profiles: 'native-codex' })
    await Vue.nextTick()
    await Vue.nextTick()
    expect(app.one('[data-testid="dispatch-pr-number"]')?.props.modelValue).toBe('23')
    expect(app.one('[data-testid="dispatch-profiles"]')?.props.modelValue).toEqual(['native-codex'])
    const notice = app.one('[data-testid="dispatch-prefilled"]')
    if (!notice) throw new Error('review prefill notice did not render')
    expect(app.textOf(notice)).toBe(enI18n().t('fleet.dispatch.prefilledReview'))
    app.unmount()
  })
})
