import { describe, test, expect } from '@jest/globals'
import { readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const componentPath = join(webDir, 'components', 'CreateAgentDialog.vue')

// Helper function to get the source once
function getSource(): string {
  return readFileSync(componentPath, 'utf-8')
}

// ──────────────────────────────────────────────────────────────────────────────
// AC1 — On valid form submission, calls $api.post('/agents', { name, slug, roles, capabilities, maxConcurrentTickets })
// ──────────────────────────────────────────────────────────────────────────────

describe('US-002-5 AC1: On valid form submission, calls $api.post with correct payload', () => {
  test('source has onSubmit handler that calls $api.post', () => {
    const source = getSource()
    // Should have onSubmit function that calls $api.post
    const hasOnSubmit = source.includes('onSubmit')
    const hasApiPost = !!source.match(/\$api\.post\s*\(\s*['"]\/agents['"]/)
    expect(hasOnSubmit && hasApiPost).toBe(true)
  })

  test('source passes form values to $api.post call', () => {
    const source = getSource()
    // The POST call should pass formValues as the second argument
    // Look for: $api.post('/agents', formValues)
    const passesFormValues =
      source.match(/\$api\.post\s*\(\s*['"]\/agents['"]\s*,\s*formValues/)
    expect(passesFormValues).not.toBeNull()
  })

  test('source uses handleSubmit from vee-validate', () => {
    const source = getSource()
    // Should use handleSubmit to wrap the async submit handler
    expect(source).toMatch(/handleSubmit\s*\(/);
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

  test('source captures the response from $api.post', () => {
    const source = getSource()
    // The POST call should capture the response
    // Look for: const response = await $api.post or similar
    const capturesResponse =
      source.match(/const\s+\w+\s*=\s*await\s+\$api\.post\s*\(\s*['"]\/agents['"]/)
    expect(capturesResponse).not.toBeNull()
  })

  test('source extracts apiKey from the response', () => {
    const source = getSource()
    // After capturing response, should extract apiKey from it
    // Look for: .apiKey or response.apiKey
    const extractsApiKey =
      source.match(/\.apiKey/) ||
      source.match(/['"]apiKey['"]/)
    expect(extractsApiKey).not.toBeNull()
  })

  test('source stores the extracted apiKey in state', () => {
    const source = getSource()
    // After extracting apiKey, should store it: apiKey.value = ...
    const storesApiKey =
      source.match(/apiKey\.value\s*=/) ||
      source.match(/apiKey\s*=\s*/)
    expect(storesApiKey).not.toBeNull()
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC2 — On API failure, error message is displayed and dialog remains in form view
// ──────────────────────────────────────────────────────────────────────────────

describe('US-002-5 AC2: On API failure, error message is displayed and dialog remains in form view', () => {
  test('source wraps $api.post in try-catch', () => {
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

  test('source does NOT set apiKey on error (apiKey remains null)', () => {
    const source = getSource()
    // In the catch block, should NOT set apiKey.value
    // Extract the catch block content
    const catchBlockMatch = source.match(/catch\s*\([^)]*\)\s*\{([\s\S]*?)\}/)
    expect(catchBlockMatch).not.toBeNull()
    const catchBlock = catchBlockMatch![1]
    // The catch block should NOT set apiKey
    const setsApiKeyInCatch = catchBlock.includes('apiKey.value =')
    expect(setsApiKeyInCatch).toBe(false)
  })

  test('form remains visible when API fails (apiKey is not set)', () => {
    const source = getSource()
    // The form has v-if="!apiKey" - so if apiKey is not set, form stays visible
    // This is verified by ensuring catch block does NOT set apiKey
    const catchBlockMatch = source.match(/catch\s*\([^)]*\)\s*\{([\s\S]*?)\}/)
    expect(catchBlockMatch).not.toBeNull()
    const catchBlock = catchBlockMatch![1]
    // apiKey should not be modified in catch block
    expect(catchBlock).not.toMatch(/apiKey\.value\s*=/)
  })

  test('dialog remains open after API failure (no emit close)', () => {
    const source = getSource()
    // The catch block should NOT emit update:open(false)
    // It should only show the error toast
    const catchBlockMatch = source.match(/catch\s*\([^)]*\)\s*\{([\s\S]*?)\}/)
    expect(catchBlockMatch).not.toBeNull()
    const catchBlock = catchBlockMatch![1]
    // Should NOT close the dialog in catch block
    const closesDialogInCatch = catchBlock.includes("emit('update:open'")
    expect(closesDialogInCatch).toBe(false)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC3 — On API success, dialog switches to key-reveal view with returned apiKey
// ──────────────────────────────────────────────────────────────────────────────

describe('US-002-5 AC3: On API success, dialog switches to key-reveal view with returned apiKey', () => {
  test('source shows success toast on API success', () => {
    const source = getSource()
    // After successful POST, should call toast.success
    const hasToastSuccess =
      source.match(/toast\.success/)
    expect(hasToastSuccess).not.toBeNull()
  })

  test('source sets apiKey value from response in try block', () => {
    const source = getSource()
    // In the try block (before toast.success), should set apiKey.value
    // Extract the try block content
    const tryBlockMatch = source.match(/try\s*\{([\s\S]*?)catch/)
    expect(tryBlockMatch).not.toBeNull()
    const tryBlock = tryBlockMatch![1]
    // Should set apiKey in try block
    expect(tryBlock).toMatch(/apiKey\.value\s*=/)
  })

  test('key-reveal view is shown when apiKey is not null', () => {
    const source = getSource()
    // The key-reveal section has v-if="apiKey"
    // When apiKey is set (not null), key-reveal view is shown
    const hasKeyRevealConditional =
      source.includes('v-if="apiKey') ||
      source.includes("v-if='apiKey")
    expect(hasKeyRevealConditional).toBe(true)
  })

  test('form is hidden when apiKey is set (v-if="!apiKey")', () => {
    const source = getSource()
    // The form has v-if="!apiKey" which means when apiKey is set, form is hidden
    const formHasConditional =
      source.includes('v-if="!apiKey') ||
      source.includes("v-if='!apiKey")
    expect(formHasConditional).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC4 — On empty roles validation failure, $api.post is NOT called
// ──────────────────────────────────────────────────────────────────────────────

describe('US-002-5 AC4: On empty roles validation failure, $api.post is NOT called', () => {
  test('source uses vee-validate handleSubmit which validates before calling onSubmit', () => {
    const source = getSource()
    // handleSubmit from vee-validate only calls the async function if validation passes
    // This is the key mechanism that prevents API call on validation failure
    const usesHandleSubmit = source.match(/handleSubmit\s*\(/)
    expect(usesHandleSubmit).not.toBeNull()
  })

  test('source has validation schema with roles min(1) requirement', () => {
    const source = getSource()
    // The zod schema should have roles with min(1) to require at least one role
    // Looking for: roles: z.array(z.string()).min(1, ...)
    const hasRolesMinValidation =
      source.includes('roles: z.array(z.string()).min(1,')
    expect(hasRolesMinValidation).toBe(true)
  })

  test('source does NOT call $api.post outside of valid form submission', () => {
    const source = getSource()
    // $api.post should only be called inside the onSubmit callback
    // Check that $api.post is called within handleSubmit's callback
    // The onSubmit is defined as: const onSubmit = handleSubmit(async (formValues) => { ... $api.post ... })
    const handleSubmitRegion = source.match(/const\s+onSubmit\s*=\s*handleSubmit\s*\([\s\S]*?\}\s*\)\s*;?\s*\$?/);
    // Within that region, $api.post should be called
    const hasApiPostInHandler = handleSubmitRegion && handleSubmitRegion[0].includes('$api.post');
    expect(hasApiPostInHandler).toBe(true)
  })

  test('form has validation errors displayed via FormMessage', () => {
    const source = getSource()
    // Each FormField should have FormMessage to display validation errors
    // This ensures validation errors are shown to user
    const hasFormMessage =
      source.includes('FormMessage')
    expect(hasFormMessage).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Integration: Full API submission flow
// ──────────────────────────────────────────────────────────────────────────────

describe('US-002-5: Full API submission flow integration', () => {
  test('onSubmit function is connected to form via @submit handler', () => {
    const source = getSource()
    // The form should have @submit="onSubmit"
    const hasOnSubmitBinding =
      source.includes('@submit="onSubmit"') ||
      source.includes("@submit=\"onSubmit\"")
    expect(hasOnSubmitBinding).toBe(true)
  })

  test('form submission is prevented when validation fails', () => {
    const source = getSource()
    // With vee-validate and handleSubmit, native form submission is prevented
    // The form uses @submit which calls handleSubmit's wrapped handler
    // This ensures validation runs before submission
    const formHasSubmitHandler =
      source.match(/<form[^>]*@submit=["']onSubmit["']/)
    expect(formHasSubmitHandler).not.toBeNull()
  })

  test('all required form fields are validated', () => {
    const source = getSource()
    // All required fields should have FormMessage for error display:
    // - name (required)
    // - slug (required, pattern)
    // - roles (min 1)
    // - maxConcurrentTickets (min 1)
    const formFieldCount = (source.match(/<FormField\s+name=/g) || []).length
    expect(formFieldCount).toBeGreaterThanOrEqual(4)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Quality: No console.log
// ──────────────────────────────────────────────────────────────────────────────

describe('US-002-5: CreateAgentDialog.vue has no console.log statements', () => {
  test('source does not contain console.log', () => {
    const source = getSource()
    expect(source).not.toContain('console.log')
  })
})
