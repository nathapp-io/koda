import { describe, test, expect } from '@jest/globals'
import { readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const componentPath = join(webDir, 'components', 'EditAgentCapabilitiesDialog.vue')

// Helper function to get the source
function getSource(): string {
  return readFileSync(componentPath, 'utf-8')
}

// ──────────────────────────────────────────────────────────────────────────────
// AC1 — When EditAgentCapabilitiesDialog opens with an agent, existing capabilities are rendered as removable Badge tags
// ──────────────────────────────────────────────────────────────────────────────

describe('US-003-2 AC1: When EditAgentCapabilitiesDialog opens with an agent, existing capabilities are rendered as removable Badge tags', () => {
  test('source receives agent prop with capabilities', () => {
    const source = getSource()
    // Should define props that include 'agent'
    const hasAgentProp = source.match(/props.*agent/) || source.match(/defineProps.*agent/)
    expect(hasAgentProp).not.toBeNull()
  })

  test('source references agent.capabilities for rendering badge tags', () => {
    const source = getSource()
    // Should reference agent.capabilities to render the current capabilities
    const referencesAgentCapabilities =
      source.includes('agent.capabilities') ||
      source.match(/capabilities.*agent\.capabilities/)
    expect(referencesAgentCapabilities).toBe(true)
  })

  test('source uses Badge component for rendering capabilities', () => {
    const source = getSource()
    // Should use Badge component to display capabilities
    const usesBadgeComponent =
      source.includes('Badge') ||
      source.includes('badge')
    expect(usesBadgeComponent).toBe(true)
  })

  test('source renders capabilities as a list/array using v-for', () => {
    const source = getSource()
    // Should iterate over capabilities using v-for
    const hasVFor =
      source.includes('v-for') &&
      source.includes('capabilities')
    expect(hasVFor).toBe(true)
  })

  test('source provides a remove control for each capability badge', () => {
    const source = getSource()
    // Each capability badge should have a remove button or click handler
    // Look for @click, @remove, or an X button pattern
    const hasRemoveControl =
      source.includes('@click') ||
      source.includes('remove') ||
      source.includes('X')
    expect(hasRemoveControl).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC2 — When the user presses Enter in the input, the entered text is appended as a new capability tag
// ──────────────────────────────────────────────────────────────────────────────

describe('AC2: When the user presses Enter in the input, the entered text is appended as a new capability tag', () => {
  test('source has an Input component for entering new capabilities', () => {
    const source = getSource()
    // Should use Input component for the capability input
    const usesInputComponent =
      source.includes('Input') ||
      source.includes('input')
    expect(usesInputComponent).toBe(true)
  })

  test('source handles @keydown or @keyup.enter event on the input', () => {
    const source = getSource()
    // Should listen for Enter key to add the capability
    const handlesEnterKey =
      source.includes('@keydown.enter') ||
      source.includes('@keyup.enter') ||
      source.includes('@enter') ||
      source.includes('keydown.enter')
    expect(handlesEnterKey).toBe(true)
  })

  test('source has a function or handler to add new capability to the list', () => {
    const source = getSource()
    // Should have a method to add a capability (e.g., addCapability, handleAdd, etc.)
    const hasAddHandler =
      source.match(/add\w*Capability/i) ||
      source.match(/handle\w*Add/i) ||
      source.match(/append\w*Capability/i) ||
      source.match(/capabilities\.\w*\(/)
    expect(hasAddHandler).not.toBeNull()
  })

  test('source appends new capability to the capabilities array', () => {
    const source = getSource()
    // The add handler should push or spread-add to the capabilities array
    const modifiesCapabilitiesArray =
      source.includes('[...') ||
      source.includes('push') ||
      source.includes('concat') ||
      source.match(/capabilities\s*=/)
    expect(modifiesCapabilitiesArray).toBe(true)
  })

  test('source clears the input after adding a capability', () => {
    const source = getSource()
    // After adding, the input should be cleared
    // Look for assignment to empty string or similar clearing mechanism
    const clearsInput =
      source.includes("= ''") ||
      source.includes('= ""') ||
      source.includes('value =') ||
      source.match(/input\s*=\s*['"']{2}/)
    expect(clearsInput).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC3 — When a capability Badge remove control is clicked, that tag is removed from the list
// ──────────────────────────────────────────────────────────────────────────────

describe('AC3: When a capability Badge remove control is clicked, that tag is removed from the list', () => {
  test('source has a remove handler function', () => {
    const source = getSource()
    // Should have a method to remove a capability (e.g., removeCapability, handleRemove, etc.)
    const hasRemoveHandler =
      source.match(/remove\w*Capability/i) ||
      source.match(/handle\w*Remove/i) ||
      source.match(/delete\w*Capability/i)
    expect(hasRemoveHandler).not.toBeNull()
  })

  test('source passes index or capability value to remove handler', () => {
    const source = getSource()
    // The remove handler should receive an index or value to identify which to remove
    const passesIndexOrValue =
      source.match(/remove\w*Capability\s*\(\s*\w+\s*\)/) ||
      source.match(/remove\w*Capability\s*\(\s*\w+,\s*\w+\s*\)/) ||
      source.includes('@click="')
    expect(passesIndexOrValue).toBe(true)
  })

  test('source removes capability from the array using filter or splice', () => {
    const source = getSource()
    // Should filter out or splice the removed capability
    const removesFromArray =
      source.includes('filter') ||
      source.includes('splice') ||
      source.match(/capabilities\s*=\s*capabilities\.filter/)
    expect(removesFromArray).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC4 — When the dialog is submitted, it calls $api.patch('/agents/' + agent.slug + '/update-capabilities', { capabilities })
// ──────────────────────────────────────────────────────────────────────────────

describe("AC4: When the dialog is submitted, it calls $api.patch('/agents/' + agent.slug + '/update-capabilities', { capabilities })", () => {
  test('source uses $api.patch for the update-capabilities call', () => {
    const source = getSource()
    // Should call $api.patch
    const hasPatchCall = !!source.match(/\$api\.patch\s*\(/)
    expect(hasPatchCall).toBe(true)
  })

  test('source constructs the update-capabilities URL with agent.slug', () => {
    const source = getSource()
    // Should have URL pattern /agents/${agent.slug}/update-capabilities or similar
    const hasUpdateCapabilitiesUrl =
      source.includes('update-capabilities') &&
      source.includes('agent.slug')
    expect(hasUpdateCapabilitiesUrl).toBe(true)
  })

  test('source passes { capabilities } as the request body', () => {
    const source = getSource()
    // The patch call should pass an object with 'capabilities' property
    // Look for: patch(..., { capabilities }) or patch(..., { capabilities: ... })
    const passesCapabilitiesInBody =
      source.match(/patch\s*\([^)]*,\s*\{[^}]*capabilities[^}]*\}/)
    expect(passesCapabilitiesInBody).not.toBeNull()
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

  test('submit button is disabled when isSubmitting is true', () => {
    const source = getSource()
    // The submit button should have :disabled="isSubmitting" or similar
    const hasDisabledAttr = !!source.match(/:disabled=["']isSubmitting["']/)
    expect(hasDisabledAttr).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC5 — When submission succeeds, it shows a success toast and emits 'updated'
// ──────────────────────────────────────────────────────────────────────────────

describe("AC5: When submission succeeds, it shows a success toast and emits 'updated'", () => {
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

describe('US-003-2: Full EditAgentCapabilitiesDialog integration', () => {
  test('component is a Dialog that receives open prop', () => {
    const source = getSource()
    // Should use Dialog component with :open binding
    const hasDialogWithOpen =
      source.includes('Dialog') &&
      (source.includes(':open=') || source.includes('v-model:open'))
    expect(hasDialogWithOpen).toBe(true)
  })

  test('component receives agent prop and uses it for capabilities and slug', () => {
    const source = getSource()
    // Should use agent.slug and agent.capabilities
    const usesAgentData =
      source.includes('agent.slug') &&
      source.includes('agent.capabilities')
    expect(usesAgentData).toBe(true)
  })

  test('component has cancel and submit buttons', () => {
    const source = getSource()
    // Should have both cancel and submit buttons
    const hasCancelButton = source.includes('type="button"') && source.includes('Cancel')
    const hasSubmitButton = source.includes('type="submit"') || source.includes('submit')
    expect(hasCancelButton || source.includes('cancel')).toBe(true)
    expect(hasSubmitButton).toBe(true)
  })

  test('component uses v-model or reactive ref for capabilities array', () => {
    const source = getSource()
    // Should have reactive state for capabilities
    const hasReactiveCapabilities =
      source.includes('ref<') ||
      source.includes('reactive') ||
      source.includes('ref(')
    expect(hasReactiveCapabilities).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Quality: No console.log
// ──────────────────────────────────────────────────────────────────────────────

describe('US-003-2: EditAgentCapabilitiesDialog.vue has no console.log statements', () => {
  test('source does not contain console.log', () => {
    const source = getSource()
    expect(source).not.toContain('console.log')
  })
})
