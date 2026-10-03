import { describe, expect, test } from '@jest/globals'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const webDir = path.join(__dirname, '../..')
const read = (...parts: string[]): string => readFileSync(path.join(webDir, ...parts), 'utf-8')
const dispatch = read('pages', '[project]', 'fleet', 'dispatch.vue')

describe('dispatch page', () => {
  test('validates with the shared schema and sends toDispatchBody', () => {
    expect(dispatch).toContain('toTypedSchema(buildDispatchSchema(t))')
    expect(dispatch).toContain('jobsApi.dispatch(toDispatchBody(formValues))')
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

  test('bash mode select and timeout only for RUN; the timeout only for gated/escalate (D299)', () => {
    expect(dispatch).toMatch(/<template v-if="values\.command === 'RUN'">[\s\S]*?name="bashMode"[\s\S]*?testid="dispatch-bash-mode"/)
    expect(dispatch).toMatch(/<FormField v-if="values\.bashMode !== 'raw'" v-slot="\{ componentField \}" name="approvalTimeoutMinutes">/)
    expect(dispatch).toContain('data-testid="dispatch-approval-timeout"')
    expect(dispatch).toContain("BASH_MODES.map(mode => ({ value: mode, label: t(`fleet.bash.mode.${mode}`) }))")
  })
})
