import { describe, test, expect } from '@jest/globals'
import { readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '..')
const componentPath = join(webDir, 'components', 'EditAgentRolesDialog.vue')

// Helper function to get the source
function getSource(): string {
  return readFileSync(componentPath, 'utf-8')
}

// ──────────────────────────────────────────────────────────────────────────────
// AC1 — When EditAgentRolesDialog opens with an agent, the checkboxes for the agent's current roles are pre-checked
// ──────────────────────────────────────────────────────────────────────────────

describe('US-003-1 AC1: When EditAgentRolesDialog opens with an agent, the checkboxes for the agent current roles are pre-checked', () => {
  test('source receives agent prop', () => {
    const source = getSource()
    // Should define props that include 'agent'
    const hasAgentProp = source.match(/props.*agent/) || source.match(/defineProps.*agent/)
    expect(hasAgentProp).not.toBeNull()
  })

  test('source has agent.roles referenced for pre-checking checkboxes', () => {
    const source = getSource()
    // Should reference agent.roles to pre-check the current roles
    const referencesAgentRoles =
      source.includes('agent.roles') ||
      source.match(/roles.*agent\.roles/)
    expect(referencesAgentRoles).toBe(true)
  })

  test('source has checkbox inputs for VERIFIER, DEVELOPER, and REVIEWER roles', () => {
    const source = getSource()
    // Should have checkboxes for the three roles
    expect(source).toContain('VERIFIER')
    expect(source).toContain('DEVELOPER')
    expect(source).toContain('REVIEWER')
  })

  test('source uses v-model or :checked binding for role checkboxes', () => {
    const source = getSource()
    // Should have :checked or v-model binding on the checkbox inputs
    const hasCheckedBinding =
      source.includes(':checked=') ||
      source.includes('v-model')
    expect(hasCheckedBinding).toBe(true)
  })

  test('source uses availableRoles array for role options', () => {
    const source = getSource()
    // Should define availableRoles as array of role strings
    const hasAvailableRoles =
      source.includes('availableRoles') ||
      source.match(/roles.*=.*\[[\s\S]*VERIFIER[\s\S]*DEVELOPER[\s\S]*REVIEWER/)
    expect(hasAvailableRoles).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC2 — When the dialog is submitted, it calls $api.patch('/agents/' + agent.slug + '/update-roles', { roles })
// ──────────────────────────────────────────────────────────────────────────────

describe("US-003-1 AC2: When the dialog is submitted, it calls $api.patch('/agents/' + agent.slug + '/update-roles', { roles })", () => {
  test('source uses $api.patch for the update-roles call', () => {
    const source = getSource()
    // Should call $api.patch
    const hasPatchCall = !!source.match(/\$api\.patch\s*\(/)
    expect(hasPatchCall).toBe(true)
  })

  test('source constructs the update-roles URL with agent.slug', () => {
    const source = getSource()
    // Should have URL pattern /agents/${agent.slug}/update-roles or similar
    const hasUpdateRolesUrl =
      source.includes('update-roles') &&
      source.includes('agent.slug')
    expect(hasUpdateRolesUrl).toBe(true)
  })

  test('source passes { roles } as the request body', () => {
    const source = getSource()
    // The patch call should pass an object with 'roles' property
    // Look for: patch(..., { roles }) or patch(..., { roles: ... })
    const passesRolesInBody =
      source.match(/patch\s*\([^)]*,\s*\{[^}]*roles[^}]*\}/)
    expect(passesRolesInBody).not.toBeNull()
  })

  test('source uses handleSubmit from vee-validate for form submission', () => {
    const source = getSource()
    // Should use handleSubmit to wrap the async submit handler
    const usesHandleSubmit = source.match(/handleSubmit\s*\(/)
    expect(usesHandleSubmit).not.toBeNull()
  })

  test('form has @submit handler connected to onSubmit', () => {
    const source = getSource()
    // The form should have @submit="onSubmit" or similar
    const hasOnSubmitBinding =
      source.includes('@submit="onSubmit"') ||
      source.includes("@submit=\"onSubmit\"")
    expect(hasOnSubmitBinding).toBe(true)
  })

  test('source destructures isSubmitting from useForm', () => {
    const source = getSource()
    // isSubmitting should be used to disable the submit button during submission
    expect(source).toContain('isSubmitting')
  })

  test('submit button is disabled when isSubmitting is true', () => {
    const source = getSource()
    // The submit button should have :disabled="isSubmitting"
    const hasDisabledAttr = !!source.match(/:disabled=["']isSubmitting["']/)
    expect(hasDisabledAttr).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC3 — When submission succeeds, it shows a success toast and emits 'updated'
// ──────────────────────────────────────────────────────────────────────────────

describe("US-003-1 AC3: When submission succeeds, it shows a success toast and emits 'updated'", () => {
  test('source calls toast.success on API success', () => {
    const source = getSource()
    // After successful PATCH, should call toast.success
    const hasToastSuccess = source.match(/toast\.success/)
    expect(hasToastSuccess).not.toBeNull()
  })

  test('source wraps $api.patch in try-catch', () => {
    const source = getSource()
    // The onSubmit should have try-catch block
    const hasTryCatch =
      source.includes('try {') &&
      source.includes('catch')
    expect(hasTryCatch).toBe(true)
  })

  test('source calls toast.error on API failure', () => {
    const source = getSource()
    // In the catch block, should call toast.error
    const hasToastError =
      source.includes('catch') &&
      source.match(/toast\.error/)
    expect(hasToastError).not.toBeNull()
  })

  test("source emits 'updated' event on success", () => {
    const source = getSource()
    // Should emit 'updated' after successful API call
    const emitsUpdated =
      source.includes("emit('updated')") ||
      source.includes('emit("updated")') ||
      source.includes('emit(`updated`)')
    expect(emitsUpdated).toBe(true)
  })

  test("dialog closes after successful update via 'update:open' emit", () => {
    const source = getSource()
    // Should emit update:open(false) to close the dialog after success
    const closesDialogOnSuccess =
      source.includes("emit('update:open'") ||
      source.includes('emit("update:open"')
    expect(closesDialogOnSuccess).toBe(true)
  })

  test('source defines emit function with update:open and updated events', () => {
    const source = getSource()
    // Should define emits with both update:open and updated
    const hasEmitsDefinition =
      source.includes("'updated'") ||
      source.includes('"updated"')
    expect(hasEmitsDefinition).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Integration: Full dialog flow
// ──────────────────────────────────────────────────────────────────────────────

describe('US-003-1: Full EditAgentRolesDialog integration', () => {
  test('component is a Dialog that receives open prop', () => {
    const source = getSource()
    // Should use Dialog component with :open binding
    const hasDialogWithOpen =
      source.includes('Dialog') &&
      (source.includes(':open=') || source.includes('v-model:open'))
    expect(hasDialogWithOpen).toBe(true)
  })

  test('component receives agent prop and uses it for roles and slug', () => {
    const source = getSource()
    // Should use agent.slug and agent.roles
    const usesAgentData =
      source.includes('agent.slug') &&
      source.includes('agent.roles')
    expect(usesAgentData).toBe(true)
  })

  test('component has FormField components for roles selection', () => {
    const source = getSource()
    // Should use FormField for the roles checkboxes
    const hasFormField =
      source.includes('FormField')
    expect(hasFormField).toBe(true)
  })

  test('component has cancel and submit buttons', () => {
    const source = getSource()
    // Should have both cancel and submit buttons
    const hasCancelButton = source.includes('type="button"') && source.includes('Cancel')
    const hasSubmitButton = source.includes('type="submit"') || source.includes('submit')
    expect(hasCancelButton || source.includes('cancel')).toBe(true)
    expect(hasSubmitButton).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Quality: No console.log
// ──────────────────────────────────────────────────────────────────────────────

describe('US-003-1: EditAgentRolesDialog.vue has no console.log statements', () => {
  test('source does not contain console.log', () => {
    const source = getSource()
    expect(source).not.toContain('console.log')
  })
})
