import { describe, expect, test } from '@jest/globals'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import * as Vue from 'vue'
import { useField } from 'vee-validate'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n } from '../helpers/fleet-harness'
import { projectPermissionsStub } from '../helpers/permission-nav'

const webDir = path.join(__dirname, '../..')
const read = (...parts: string[]): string => readFileSync(path.join(webDir, ...parts), 'utf-8')
const dispatch = read('pages', '[project]', 'fleet', 'dispatch.vue')
const dispatchPage = webFile('pages', '[project]', 'fleet', 'dispatch.vue')

function mountDispatch() {
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
    props: { modelValue: Array, suggestions: Array, placeholder: String, testId: String, groupByPrefix: Boolean },
    render(this: { $props: Record<string, unknown> }) {
      return Vue.h('x-token-input', {
        'data-testid': this.$props.testId,
        'data-group-by-prefix': String(Boolean(this.$props['group-by-prefix'] ?? this.$props.groupByPrefix)),
      })
    },
  }
  const app = mountSfc(dispatchPage, {
    components: {
      FormField,
      FormItem: { setup: (_p: unknown, { slots }: { slots: { default?: () => unknown } }) => () => Vue.h('div', slots.default?.() as never) },
      FormControl: { setup: (_p: unknown, { slots }: { slots: { default?: () => unknown } }) => () => Vue.h('div', slots.default?.() as never) },
      FormLabel: 'label', FormMessage: 'span', Input: 'input', Button: 'button', Label: 'label',
      PageHeader: 'header', ErrorState: 'div', LoadingState: 'x-loading-state', FleetPlacementResult: 'div', FleetBudgetBanner: 'div', NuxtLink: 'a',
    },
    fleetComponents: ['FleetNativeSelect'],
    alias: {
      '~/components/fleet/FleetTokenListInput.vue': TokenInput,
      '~/components/fleet/TicketPicker.vue': { props: ['testId'], render(this: { testId: string }) { return Vue.h('x-ticket-picker', { 'data-testid': this.testId }) } },
    },
    globals: {
      ref: Vue.ref, computed: Vue.computed, onMounted: Vue.onMounted,
      useRoute: () => ({ params: { project: 'koda' }, query: {} }),
      useI18n: () => enI18n(), useAppToast: () => ({ error: () => undefined }),
      useFleetDispatchOptions: () => ({
        repos: Vue.ref([{ id: 'repo-1', owner: 'acme', name: 'app', defaultBranch: 'main' }]),
        runners: Vue.ref([]), moreRepos: Vue.ref(false), moreRunners: Vue.ref(false),
        profileOptions: Vue.ref([]), labelOptions: Vue.ref([]), runnerName: () => '', load: async () => undefined,
      }),
      useProjectPermissions: () => projectPermissionsStub(['fleet.job.dispatch']),
      useFleetJobs: () => ({ dispatch: async () => null, findActiveJob: async () => null }),
    },
  })
  return { app, fields }
}

describe('dispatch page', () => {
  test('validates with the shared schema and sends toDispatchBody', () => {
    expect(dispatch).toContain('toTypedSchema(buildDispatchSchema(t))')
    expect(dispatch).toContain('jobsApi.dispatch(toDispatchBody(formValues, opts))')
  })

  test('a 409 (ret 409) looks up and links the active job (D121); other errors toast the API message', () => {
    expect(dispatch).toContain('err instanceof ApiError && err.code === 409')
    expect(dispatch).toContain('jobsApi.findActiveJob(formValues.repoId, dispatchFeatureOf(formValues))')
    expect(dispatch).toContain('data-testid="dispatch-conflict-link"')
    expect(dispatch).toContain('toast.error(extractApiError(err))')
  })

  test('placement modes clear the other field, so labels and pin never travel together', () => {
    expect(dispatch).toContain("if (mode !== 'labels') setFieldValue('selectorLabels', [])")
    expect(dispatch).toContain("if (mode !== 'pin') setFieldValue('pinnedRunnerId', '')")
  })

  test('PLAN shows the spec path; the placement result is rendered after submit', () => {
    expect(dispatch).toContain('v-if="values.command === \'PLAN\'"')
    expect(dispatch).toContain('<FleetPlacementResult v-if="result && \'job\' in result"')
  })

  test('repo, command and pin are native selects bound through FleetNativeSelect (4b D137)', () => {
    for (const testid of ['dispatch-repo', 'dispatch-command', 'dispatch-pin']) {
      expect(dispatch).toMatch(new RegExp(`<FleetNativeSelect v-bind="componentField"[^>]*testid="${testid}"`))
    }
    expect(dispatch).not.toContain('<SelectContent')
    expect(dispatch).not.toMatch(/<select[^>]*v-bind="componentField"/)
  })

  test('the form needs fleet.job.dispatch; other fleet job keys do not open it (Permissions P1 US-008)', () => {
    expect(dispatch).toContain("const canDispatch = computed(() => permissions.value.has('fleet.job.dispatch'))")
    expect(dispatch).toContain('<p v-if="!canDispatch"')
    expect(dispatch).not.toContain('canWorkOnFleet')
  })

  test('prefills command/repo/feature/ref from the query for PLAN -> RUN and Admin links (#205)', () => {
    expect(dispatch).toContain('dispatchPrefillFromQuery(')
    expect(dispatch).toContain('route.query')
    expect(dispatch).toContain("setFieldValue('command', prefill.command)")
    expect(dispatch).toContain("setFieldValue('repoId', prefill.repoId)")
    expect(dispatch).toContain("setFieldValue('feature', prefill.feature)")
    expect(dispatch).toContain("setFieldValue('ref', prefill.ref)")
    expect(dispatch).toContain('data-testid="dispatch-prefilled"')
    expect(dispatch).toContain("t('fleet.dispatch.prefilled')")
  })

  test('profile token list receives grouping and label token list does not', async () => {
    const { app } = mountDispatch()
    await Vue.nextTick()
    expect(app.one('[data-testid="dispatch-profiles"]')?.props['data-group-by-prefix']).toBe('true')
    const labels = app.one('[data-testid="placement-labels"]')
    if (!labels) throw new Error('Missing labels placement option')
    ;(labels.props.onChange as () => void)()
    await Vue.nextTick()
    expect(app.one('[data-testid="dispatch-labels"]')?.props['data-group-by-prefix']).toBe('false')
    app.unmount()
  })

  test('renders the English max-cost hint text in its hint element (#205)', async () => {
    const { app } = mountDispatch()
    await Vue.nextTick()
    const hint = app.one('[id="dispatch-max-cost-hint"]')
    if (!hint) throw new Error('Missing dispatch max-cost hint element')
    expect(app.textOf(hint)).toBe('The run is billed up to this amount.')
    app.unmount()
  })

  test('bash mode select and timeout only for RUN; the timeout only for gated/escalate (D299)', () => {
    expect(dispatch).toMatch(/<template v-if="values\.command === 'RUN'">[\s\S]*?name="bashMode"[\s\S]*?testid="dispatch-bash-mode"/)
    expect(dispatch).toMatch(/<FormField v-if="values\.bashMode !== 'raw'" v-slot="\{ componentField \}" name="approvalTimeoutMinutes">/)
    expect(dispatch).toContain('data-testid="dispatch-approval-timeout"')
    expect(dispatch).toContain("BASH_MODES.map(mode => ({ value: mode, label: t(`fleet.bash.mode.${mode}`) }))")
  })

  test('C9: a Tickets field bound to ticketRefs, prefilled from ?tickets= with its own notice (P7)', () => {
    expect(dispatch).toContain("import FleetTicketPicker from '~/components/fleet/TicketPicker.vue'")
    expect(dispatch).toMatch(/<FormField name="ticketRefs">[\s\S]*?<FleetTicketPicker[\s\S]*?:model-value="values\.ticketRefs \?\? \[\]"[\s\S]*?test-id="dispatch-tickets"[\s\S]*?@update:model-value="setFieldValue\('ticketRefs', \$event\)"/)
    expect(dispatch).toContain("setFieldValue('ticketRefs', prefill.ticketRefs)")
    expect(dispatch).toContain('prefilled.value = applied ? prefillNotice(prefill) : null')
    expect(dispatch).toContain("prefilled === 'review' ? t('fleet.dispatch.prefilledReview') : prefilled === 'ticket' ? t('fleet.dispatch.prefilledTicket') : t('fleet.dispatch.prefilled')")
  })

  test('#231: a non-active-job 409 on a RUN with tickets asks to confirm the open PR, then resends acknowledged', () => {
    expect(dispatch).toContain('const prConflict = ref<{ values: DispatchFormValues; tickets: string[] } | null>(null)')
    expect(dispatch).toContain("formValues.command === 'RUN'")
    expect(dispatch).toContain('data-testid="dispatch-pr-conflict"')
    expect(dispatch).toContain('data-testid="dispatch-pr-conflict-confirm"')
    expect(dispatch).toContain('submitDispatch(pending.values, { acknowledgeOpenPr: true })')
  })
})
