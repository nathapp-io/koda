import { describe, expect, test } from '@jest/globals'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const webDir = path.join(__dirname, '../..')
const read = (...parts: string[]): string => readFileSync(path.join(webDir, ...parts), 'utf-8')
const dispatch = read('pages', '[project]', 'fleet', 'dispatch.vue')

describe('dispatch page', () => {
  test('validates with the shared schema and sends toDispatchBody', () => {
    expect(dispatch).toContain('toTypedSchema(buildDispatchSchema(t))')
    expect(dispatch).toContain('jobsApi.dispatch(toDispatchBody(formValues, opts))')
  })

  test('a 409 (ret 409) looks up and links the active job (D121); other errors toast the API message', () => {
    expect(dispatch).toContain('err instanceof ApiError && err.code === 409')
    expect(dispatch).toContain('jobsApi.findActiveJob(formValues.repoId, formValues.feature.trim())')
    expect(dispatch).toContain('data-testid="dispatch-conflict-link"')
    expect(dispatch).toContain('toast.error(extractApiError(err))')
  })

  test('placement modes clear the other field, so labels and pin never travel together', () => {
    expect(dispatch).toContain("if (mode !== 'labels') setFieldValue('selectorLabels', [])")
    expect(dispatch).toContain("if (mode !== 'pin') setFieldValue('pinnedRunnerId', '')")
  })

  test('PLAN shows the spec path; the placement result is rendered after submit', () => {
    expect(dispatch).toContain('v-if="values.command === \'PLAN\'"')
    expect(dispatch).toContain('<FleetPlacementResult v-if="result"')
  })

  test('repo, command and pin are native selects bound through FleetNativeSelect (4b D137)', () => {
    for (const testid of ['dispatch-repo', 'dispatch-command', 'dispatch-pin']) {
      expect(dispatch).toMatch(new RegExp(`<FleetNativeSelect v-bind="componentField"[^>]*testid="${testid}"`))
    }
    expect(dispatch).not.toContain('<SelectContent')
    expect(dispatch).not.toMatch(/<select[^>]*v-bind="componentField"/)
  })

  test('only project ADMIN and DEVELOPER get the form, through the shared rule', () => {
    expect(dispatch).toContain('const canWork = computed(() => canWorkOnFleet(viewer.value))')
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

  test('max cost carries a visible hint instead of a silent prefill (#205)', () => {
    expect(dispatch).toContain("t('fleet.dispatch.maxCostHint')")
    expect(dispatch).toContain('data-testid="dispatch-max-cost"')
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
    expect(dispatch).toContain("prefilled === 'ticket' ? t('fleet.dispatch.prefilledTicket') : t('fleet.dispatch.prefilled')")
  })

  test('#231: a non-active-job 409 on a RUN with tickets asks to confirm the open PR, then resends acknowledged', () => {
    expect(dispatch).toContain('const prConflict = ref<{ values: DispatchFormValues; tickets: string[] } | null>(null)')
    expect(dispatch).toContain("formValues.command === 'RUN'")
    expect(dispatch).toContain('data-testid="dispatch-pr-conflict"')
    expect(dispatch).toContain('data-testid="dispatch-pr-conflict-confirm"')
    expect(dispatch).toContain('submitDispatch(pending.values, { acknowledgeOpenPr: true })')
  })
})
