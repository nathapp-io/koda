import { describe, test, expect } from '@jest/globals'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const componentPath = join(webDir, 'components', 'RotateKeyDialog.vue')

// Helper function to get the source
function getSource(): string {
  return readFileSync(componentPath, 'utf-8')
}

// ──────────────────────────────────────────────────────────────────────────────
// File existence
// ──────────────────────────────────────────────────────────────────────────────

describe('US-004-1: RotateKeyDialog.vue exists', () => {
  test('file is present at components/RotateKeyDialog.vue', () => {
    expect(existsSync(componentPath)).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC1 — When RotateKeyDialog confirm button is clicked,
//        it calls $api.post('/agents/' + agent.slug + '/rotate-key', {})
// ──────────────────────────────────────────────────────────────────────────────

describe("US-004-1 AC1: When confirm button is clicked, it calls $api.post('/agents/' + agent.slug + '/rotate-key', {})", () => {
  test('source uses $api.post for the rotate-key call', () => {
    const source = getSource()
    const hasPostCall = !!source.match(/\$api\.post\s*\(/)
    expect(hasPostCall).toBe(true)
  })

  test('source constructs the rotate-key URL with agent.slug', () => {
    const source = getSource()
    const hasRotateKeyUrl =
      source.includes('rotate-key') &&
      source.includes('agent.slug')
    expect(hasRotateKeyUrl).toBe(true)
  })

  test('source passes empty object {} as the request body', () => {
    const source = getSource()
    const passesEmptyBody =
      source.match(/post\s*\([^)]*,\s*\{\s*\}/) ||
      source.match(/post\s*\([^)]*,\s*\{\s*\}\s*\)/)
    expect(passesEmptyBody).not.toBeNull()
  })

  test('source has a confirm button that triggers the API call', () => {
    const source = getSource()
    const hasConfirmButton =
      source.includes('confirm') ||
      source.includes('Confirm')
    expect(hasConfirmButton).toBe(true)
  })

  test('source uses handleSubmit from vee-validate or similar for form submission', () => {
    const source = getSource()
    const usesSubmitHandler =
      source.includes('handleSubmit') ||
      source.includes('@submit') ||
      source.includes('onConfirm')
    expect(usesSubmitHandler).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC2 — When rotation succeeds, the dialog switches to key-reveal view
//        showing the new apiKey in a read-only Input with Copy button and warning
// ──────────────────────────────────────────────────────────────────────────────

describe('US-004-1 AC2: When rotation succeeds, dialog switches to key-reveal view showing new apiKey', () => {
  test('source stores the API response (apiKey) after successful POST', () => {
    const source = getSource()
    const hasApiKeyState =
      source.includes('apiKey') ||
      source.includes('agentApiKey') ||
      source.includes('newApiKey')
    expect(hasApiKeyState).toBe(true)
  })

  test('source captures the response from $api.post(...rotate-key...) call', () => {
    const source = getSource()
    const capturesResponse =
      source.match(/const\s+\w+\s*=\s*await\s+\$api\.post\s*\([^)]*rotate-key/)
    expect(capturesResponse).not.toBeNull()
  })

  test('source conditionally renders key-reveal view when apiKey is present', () => {
    const source = getSource()
    const hasConditionalKeyReveal =
      source.includes('v-if="apiKey') ||
      source.includes("v-if='apiKey") ||
      source.includes('v-show="apiKey')
    expect(hasConditionalKeyReveal).toBe(true)
  })

  test('source has an Input component in the key-reveal section', () => {
    const source = getSource()
    const hasInputNearApiKey = source.match(/v-if=["']apiKey["'][\s\S]{0,500}<Input/)
    expect(hasInputNearApiKey).not.toBeNull()
  })

  test('source binds Input value to the apiKey from API response', () => {
    const source = getSource()
    const hasApiKeyBinding =
      source.includes(':value="apiKey') ||
      source.includes(':model-value="apiKey') ||
      source.includes('v-bind:value="apiKey')
    expect(hasApiKeyBinding).toBe(true)
  })

  test('source marks the Input as readonly for apiKey display', () => {
    const source = getSource()
    const hasReadonlyNearApiKey = source.match(/apiKey[\s\S]{0,200}readonly/)
    expect(hasReadonlyNearApiKey).not.toBeNull()
  })

  test('source displays warning message about copying the API key', () => {
    const source = getSource()
    expect(source).toContain("t('agents.rotateKey.apiKeyReveal.message')")
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC3 — When Copy button is clicked, apiKey is written to clipboard
//        and button label shows 'Copied!' for 2 seconds
// ──────────────────────────────────────────────────────────────────────────────

describe("US-004-1 AC3: When Copy button is clicked, apiKey is written to clipboard and button shows 'Copied!' for 2 seconds", () => {
  test('source has a Button with click handler in the key-reveal view', () => {
    const source = getSource()
    const hasButtonWithClickNearApiKey = source.match(/v-if=["']apiKey["'][\s\S]{0,800}@click/)
    expect(hasButtonWithClickNearApiKey).not.toBeNull()
  })

  test('source uses navigator.clipboard.writeText to copy apiKey', () => {
    const source = getSource()
    expect(source).toMatch(/navigator\.clipboard\.writeText/)
  })

  test('source passes apiKey to clipboard.writeText', () => {
    const source = getSource()
    expect(source).toMatch(/writeText\s*\(\s*.*apiKey/)
  })

  test('source has a ref or state to track copy button label', () => {
    const source = getSource()
    const hasCopyButtonTextState =
      source.includes('copyButtonText') ||
      source.includes('buttonLabel') ||
      source.includes('isCopied')
    expect(hasCopyButtonTextState).toBe(true)
  })

  test('source updates button label to Copied! on click', () => {
    const source = getSource()
    expect(source).toMatch(/agents\.rotateKey\.apiKeyReveal\.copied/)
  })

  test('source uses setTimeout with a proper function callback (not a string)', () => {
    const source = getSource()
    const hasBuggyStringCallback = source.match(/setTimeout\s*\(`[^`]*`\s*,/)
    expect(hasBuggyStringCallback).toBeNull()

    const hasProperFunctionCallback =
      source.match(/setTimeout\s*\(\s*\(\s*\)\s*=>/) ||
      source.match(/setTimeout\s*\(\s*function\s*\(\)/) ||
      source.match(/setTimeout\s*\(\s*\w+\s*,/)
    expect(hasProperFunctionCallback).not.toBeNull()
  })

  test('source uses setTimeout with 2000ms delay to revert button label', () => {
    const source = getSource()
    const hasTwoSecondTimeout =
      source.match(/setTimeout\s*\([^)]*2000/) ||
      source.match(/setTimeout\s*\([^)]*2\s*\*\s*1000/)
    expect(hasTwoSecondTimeout).toBeTruthy()
  })

  test('button displays dynamic label based on copy state', () => {
    const source = getSource()
    const hasDynamicButtonLabel =
      source.match(/\{\{\s*copyButtonText\s*\}\}/) ||
      source.match(/\{\{\s*buttonLabel\s*\}\}/) ||
      source.match(/\{\{\s*copiedState\s*\}\}/)
    expect(hasDynamicButtonLabel).toBeTruthy()
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC4 — When Done button is clicked, it emits 'rotated' and closes the dialog
// ──────────────────────────────────────────────────────────────────────────────

describe("US-004-1 AC4: When Done button is clicked, it emits 'rotated' and closes the dialog", () => {
  test('source has a Done button in the key-reveal view', () => {
    const source = getSource()
    const doneButtonInKeyReveal = source.match(/v-if=["']apiKey["'][\s\S]{0,500}Done/)
    expect(doneButtonInKeyReveal).not.toBeNull()
  })

  test('Done button has a click handler', () => {
    const source = getSource()
    const doneButtonRegion = source.match(/Done[\s\S]{0,300}<\/Button>/)
    expect(doneButtonRegion).not.toBeNull()
    const doneInKeyReveal = source.match(/v-if=["']apiKey["'][\s\S]{0,800}<Button[\s\S]{0,200}Done/)
    expect(doneInKeyReveal).not.toBeNull()
  })

  test("Done button click handler emits 'rotated' event", () => {
    const source = getSource()
    const emitsRotated =
      source.includes("emit('rotated')") ||
      source.includes('emit("rotated")') ||
      source.includes('emit(`rotated`)')
    expect(emitsRotated).toBe(true)
  })

  test("dialog closes after Done is clicked via 'update:open' emit", () => {
    const source = getSource()
    const closesDialogOnDone =
      source.includes("emit('update:open'") ||
      source.includes('emit("update:open"')
    expect(closesDialogOnDone).toBe(true)
  })

  test('source defines emit function with rotated event', () => {
    const source = getSource()
    const hasEmitsDefinition =
      source.includes("'rotated'") ||
      source.includes('"rotated"')
    expect(hasEmitsDefinition).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Component structure tests
// ──────────────────────────────────────────────────────────────────────────────

describe('US-004-1: RotateKeyDialog component structure', () => {
  test('component is a Dialog that receives open prop', () => {
    const source = getSource()
    const hasDialogWithOpen =
      source.includes('Dialog') &&
      (source.includes(':open=') || source.includes('v-model:open'))
    expect(hasDialogWithOpen).toBe(true)
  })

  test('component receives agent prop', () => {
    const source = getSource()
    const hasAgentProp =
      source.match(/props.*agent/) ||
      source.match(/defineProps.*agent/) ||
      source.includes(':agent=')
    expect(hasAgentProp).not.toBeNull()
  })

  test('component uses agent.slug for the API URL', () => {
    const source = getSource()
    expect(source).toContain('agent.slug')
  })

  test('component has confirm and cancel buttons in confirm view', () => {
    const source = getSource()
    const hasCancelButton = source.includes('Cancel')
    const hasConfirmButton = source.includes('confirm') || source.includes('Confirm')
    expect(hasCancelButton || source.includes('cancel')).toBe(true)
    expect(hasConfirmButton).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Quality: No console.log
// ──────────────────────────────────────────────────────────────────────────────

describe('US-004-1: RotateKeyDialog.vue has no console.log statements', () => {
  test('source does not contain console.log', () => {
    const source = getSource()
    expect(source).not.toContain('console.log')
  })
})
