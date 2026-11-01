import { describe, expect, jest, test } from '@jest/globals'
import * as Vue from 'vue'
import { useField } from 'vee-validate'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, toastRecorder } from '../helpers/fleet-harness'
import { projectPermissionsStub } from '../helpers/permission-nav'
import * as apiModule from '../../composables/useApi'

const dispatchPage = webFile('pages', '[project]', 'fleet', 'dispatch.vue')

function mountDispatch(dispatch: jest.Mock, findActiveJob: jest.Mock, query: Record<string, unknown> = {}) {
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
    render(this: { testId: string }) { return Vue.h('x-token-input', { 'data-testid': this.testId }) },
  }
  const toast = toastRecorder()
  const app = mountSfc(dispatchPage, {
    components: {
      FormField,
      FormItem: { setup: (_p: unknown, { slots }: { slots: { default?: () => unknown } }) => () => Vue.h('div', slots.default?.() as never) },
      FormControl: { setup: (_p: unknown, { slots }: { slots: { default?: () => unknown } }) => () => Vue.h('div', slots.default?.() as never) },
      FormLabel: 'label', FormMessage: 'span', Input: 'input', Button: 'button', Label: 'label',
      PageHeader: 'header', ErrorState: 'div', FleetPlacementResult: 'div', FleetBudgetBanner: 'div',
      NuxtLink: { props: ['to'], setup(props: { to: string }, { slots }: { slots: { default?: () => unknown } }) { return () => Vue.h('a', { to: props.to }, slots.default?.() as never) } },
      RadioGroup: { setup: (_props: unknown, { slots }: { slots: { default?: () => unknown } }) => () => Vue.h('div', slots.default?.() as never) },
      RadioGroupItem: 'input',
    },
    fleetComponents: ['FleetNativeSelect'],
    alias: {
      '~/composables/useApi': apiModule,
      '~/components/fleet/FleetTokenListInput.vue': TokenInput,
      '~/components/fleet/TicketPicker.vue': { props: ['testId'], render(this: { testId: string }) { return Vue.h('x-ticket-picker', { 'data-testid': this.testId }) } },
    },
    globals: {
      ref: Vue.ref, computed: Vue.computed, onMounted: Vue.onMounted,
      useRoute: () => ({ params: { project: 'koda' }, query }),
      useI18n: () => enI18n(), useAppToast: () => toast,
      useFleetDispatchOptions: () => ({
        repos: Vue.ref([{ id: 'r1', owner: 'acme', name: 'app', defaultBranch: 'main' }]),
        runners: Vue.ref([]), moreRepos: Vue.ref(false), moreRunners: Vue.ref(false),
        profileOptions: Vue.ref([]), labelOptions: Vue.ref([]), runnerName: () => '', load: async () => undefined,
      }),
      useProjectPermissions: () => projectPermissionsStub(['fleet.job.dispatch']),
      useFleetJobs: () => ({ dispatch, findActiveJob }),
    },
  })
  return { app, fields, toast }
}

async function submit(app: ReturnType<typeof mountDispatch>['app']): Promise<void> {
  await Vue.nextTick()
  await Vue.nextTick()
  const form = app.one('[data-testid="dispatch-form"]')
  if (!form || typeof form.props.onSubmit !== 'function') throw new Error('dispatch form did not render')
  await (form.props.onSubmit as (event: Event) => Promise<void>)({ preventDefault() {}, stopPropagation() {} } as unknown as Event)
  for (let i = 0; i < 4; i += 1) await Vue.nextTick()
}

async function valuesFor(fields: Record<string, { value: { value: unknown } }>, command: string, prNumber = ''): Promise<void> {
  fields.repoId.value.value = 'r1'
  fields.command.value.value = command
  await Vue.nextTick()
  fields.prNumber.value.value = prNumber
}

describe('mounted fleet PR dispatch submission', () => {
  test('AC-1/2: FIX sends command and numeric PR number', async () => {
    const dispatch = jest.fn(async () => null)
    const find = jest.fn(async () => null)
    const m = mountDispatch(dispatch, find)
    await valuesFor(m.fields, 'FIX', '23')
    await submit(m.app)
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({ command: 'FIX', prNumber: 23 })
    m.app.unmount()
  })

  test('AC-3: empty FIX PR number blocks dispatch', async () => {
    const dispatch = jest.fn(async () => null)
    const m = mountDispatch(dispatch, jest.fn(async () => null))
    await valuesFor(m.fields, 'FIX')
    await submit(m.app)
    expect(dispatch).not.toHaveBeenCalled()
    m.app.unmount()
  })

  test('AC-4/5: FIX 409 queries canonical PR feature and links active job', async () => {
    const dispatch = jest.fn(async () => { throw new apiModule.ApiError(409, 'conflict') })
    const find = jest.fn(async () => ({ id: 'j9' }))
    const m = mountDispatch(dispatch, find)
    await valuesFor(m.fields, 'FIX', '23')
    await submit(m.app)
    expect(find).toHaveBeenCalledWith('r1', 'review-pr-23')
    expect(m.app.one('[data-testid="dispatch-conflict-link"]')?.props.to).toBe('/koda/fleet/jobs/j9')
    expect(m.toast.errors).toContain('conflict')
    m.app.unmount()
  })

  test.each(['', '0', '023', '+5', '1e3', '2147483648'])('AC-6: %s blocks REVIEW and FIX', async (prNumber) => {
    for (const command of ['REVIEW', 'FIX']) {
      const dispatch = jest.fn(async () => null)
      const m = mountDispatch(dispatch, jest.fn(async () => null))
      await valuesFor(m.fields, command, prNumber)
      await submit(m.app)
      expect(dispatch).not.toHaveBeenCalled()
      m.app.unmount()
    }
  })

  test('AC-7: RUN 409 lookup uses trimmed feature', async () => {
    const dispatch = jest.fn(async () => { throw new apiModule.ApiError(409, 'conflict') })
    const find = jest.fn(async () => null)
    const m = mountDispatch(dispatch, find)
    m.fields.repoId.value.value = 'r1'
    m.fields.feature.value.value = 'login'
    await submit(m.app)
    expect(find).toHaveBeenCalledWith('r1', 'login')
    m.app.unmount()
  })

  test('AC-8: RUN ticket conflict remains a confirmation when no active job exists', async () => {
    const dispatch = jest.fn(async () => { throw new apiModule.ApiError(409, 'open PR') })
    const find = jest.fn(async () => null)
    const m = mountDispatch(dispatch, find)
    m.fields.repoId.value.value = 'r1'
    m.fields.feature.value.value = 'login'
    m.fields.ticketRefs.value.value = ['KD-1']
    await submit(m.app)
    expect(find).toHaveBeenCalledWith('r1', 'login')
    expect(m.app.one('[data-testid="dispatch-pr-conflict"]')).toBeDefined()
    m.app.unmount()
  })
})
