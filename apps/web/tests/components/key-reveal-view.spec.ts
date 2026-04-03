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
// AC1 — On API success, dialog switches from form to key-reveal view
// ──────────────────────────────────────────────────────────────────────────────

describe('US-002-3 AC1: On API success, dialog switches from form to key-reveal view', () => {
  test('source stores the API response (apiKey) after successful POST', () => {
    const source = getSource()
    // Should have a ref or reactive variable to store the returned apiKey
    const hasApiKeyState =
      source.includes('apiKey') ||
      source.includes('agentApiKey') ||
      source.includes('createdAgent')
    expect(hasApiKeyState).toBe(true)
  })

  test('source captures the response from $api.post(/agents, ...) call', () => {
    const source = getSource()
    // The POST call should CAPTURE the response (which contains apiKey)
    // Look for: const result = await $api.post or const response = ... etc
    // NOT just the raw call without assignment
    const capturesResponse =
      source.match(/const\s+\w+\s*=\s*await\s+\$api\.post\s*\(\s*['"]\/agents['"]/)
    expect(capturesResponse).not.toBeNull()
  })

  test('source conditionally renders key-reveal view when apiKey is present', () => {
    const source = getSource()
    // Should have v-if or v-show on a section that displays when apiKey exists
    const hasConditionalKeyReveal =
      source.includes('v-if="apiKey') ||
      source.includes("v-if='apiKey") ||
      source.includes('v-if="agent') ||
      source.includes("v-if='agent") ||
      source.includes('v-show="apiKey') ||
      source.includes("v-show='agent")
    expect(hasConditionalKeyReveal).toBe(true)
  })

  test('source stores apiKey from response before closing dialog', () => {
    const source = getSource()
    // The onSubmit should store the API response which contains apiKey
    // This means after "await $api.post" there should be something like "const apiKey ="
    // or similar pattern to capture the response
    const storesResponse = source.match(/await\s+\$api\.post\s*\(\s*['"]\/agents['"][\s\S]{0,100}apiKey/)
    expect(storesResponse).not.toBeNull()
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC2 — Read-only Input displays the returned apiKey value
// ──────────────────────────────────────────────────────────────────────────────

describe('US-002-3 AC2: Read-only Input displays the returned apiKey value', () => {
  test('source has an Input component in the key-reveal section', () => {
    const source = getSource()
    // The key-reveal section should have an Input (not a plain text display)
    // There should be an Input near/after the apiKey v-if
    const hasInputNearApiKey = source.match(/v-if=["']apiKey["'][\s\S]{0,500}<Input/)
    expect(hasInputNearApiKey).not.toBeNull()
  })

  test('source binds Input value to the apiKey from API response', () => {
    const source = getSource()
    // Input should have :value="apiKey" or :model-value="apiKey" or similar
    const hasApiKeyBinding =
      source.includes(':value="apiKey') ||
      source.includes('v-bind:value="apiKey') ||
      source.includes(':model-value="apiKey')
    expect(hasApiKeyBinding).toBe(true)
  })

  test('source marks the Input as readonly for apiKey display', () => {
    const source = getSource()
    // The apiKey display Input should be readonly
    // Look for readonly attribute near apiKey reference
    const hasReadonlyNearApiKey = source.match(/apiKey[\s\S]{0,200}readonly/)
    expect(hasReadonlyNearApiKey).not.toBeNull()
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC3 — Copy button writes apiKey to clipboard
// ──────────────────────────────────────────────────────────────────────────────

describe('US-002-3 AC3: Copy button writes apiKey to clipboard', () => {
  test('source has a Button with click handler in the key-reveal view', () => {
    const source = getSource()
    // The key-reveal section should have a Button with @click near apiKey
    const hasButtonWithClickNearApiKey = source.match(/v-if=["']apiKey["'][\s\S]{0,800}@click/)
    expect(hasButtonWithClickNearApiKey).not.toBeNull()
  })

  test('source uses navigator.clipboard.writeText to copy apiKey', () => {
    const source = getSource()
    // Should use clipboard API to write text
    expect(source).toMatch(/navigator\.clipboard\.writeText/)
  })

  test('source passes apiKey to clipboard.writeText', () => {
    const source = getSource()
    // The clipboard write should include apiKey
    expect(source).toMatch(/writeText\s*\(\s*.*apiKey/)
  })

  test('Copy button click handler calls copyToClipboard function', () => {
    const source = getSource()
    // Button should have @click="copyToClipboard" handler
    // The copyToClipboard function should be defined
    const hasCopyHandler = source.includes('@click="copyToClipboard"') ||
                          source.includes("@click=\"copyToClipboard\"") ||
                          source.includes('@click.once="copyToClipboard"')
    expect(hasCopyHandler).toBe(true)

    // The function copyToClipboard should be defined
    expect(source).toMatch(/function\s+copyToClipboard|const\s+copyToClipboard\s*=/)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC4 — Copy button label changes to 'Copied!' for 2 seconds then reverts
// ──────────────────────────────────────────────────────────────────────────────

describe("US-002-3 AC4: Copy button label changes to 'Copied!' for 2 seconds then reverts to 'Copy'", () => {
  test('source has a ref or state to track copy button label', () => {
    const source = getSource()
    // Should track button text state (e.g., copyButtonText, buttonLabel)
    const hasCopyButtonTextState =
      source.includes('copyButtonText') ||
      source.includes('buttonLabel') ||
      source.includes('isCopied') ||
      source.includes('copiedState')
    expect(hasCopyButtonTextState).toBe(true)
  })

  test('source updates button label using i18n key for copied state on click', () => {
    const source = getSource()
    // When copy is clicked, should set button text to i18n key for copied state
    expect(source).toMatch(/t\s*\(\s*['"]agents\.rotateKey\.apiKeyReveal\.copied['"]/)
  })

  test('source uses setTimeout with a FUNCTION callback (not a string)', () => {
    const source = getSource()
    // Should use setTimeout with a proper function callback, NOT a string
    // Bug pattern: setTimeout(`...`, 2000) - this is a string, not executable code
    // Correct pattern: setTimeout(() => { ... }, 2000) or setTimeout(function() { ... }, 2000)

    // Check that setTimeout does NOT use template literal or string as first argument
    const hasBuggyStringCallback = source.match(/setTimeout\s*\(`[^`]*`\s*,/)
    expect(hasBuggyStringCallback).toBeNull()

    // Check that setTimeout uses a function (arrow function or anonymous function)
    const hasProperFunctionCallback =
      source.match(/setTimeout\s*\(\s*\(\s*\)\s*=>/) ||  // arrow function
      source.match(/setTimeout\s*\(\s*function\s*\(\)/) ||  // anonymous function
      source.match(/setTimeout\s*\(\s*\w+\s*,/)  // function reference
    expect(hasProperFunctionCallback).not.toBeNull()
  })

  test('source uses setTimeout with 2000ms delay to revert button label', () => {
    const source = getSource()
    // Should use setTimeout with 2000ms to revert the button label
    const hasTwoSecondTimeout =
      source.match(/setTimeout\s*\([^)]*2000/) ||
      source.match(/setTimeout\s*\([^)]*2\s*\*\s*1000/)
    expect(hasTwoSecondTimeout).toBeTruthy()
  })

  test('source reverts button label back to Copy after timeout', () => {
    const source = getSource()
    // After setTimeout, should revert to "Copy"
    // This should happen inside the setTimeout callback
    const setTimeoutCallback = source.match(/setTimeout\s*\([\s\S]{0,200}\)/)
    expect(setTimeoutCallback).not.toBeNull()

    // The callback should contain logic to revert using i18n key for copy
    const callbackText = setTimeoutCallback![0]
    const revertsToCopy = callbackText.includes("t('agents.rotateKey.apiKeyReveal.copy')") || callbackText.includes('t("agents.rotateKey.apiKeyReveal.copy")')
    expect(revertsToCopy).toBe(true)
  })

  test('button displays dynamic label based on copy state', () => {
    const source = getSource()
    // Button should use dynamic label like {{ copyButtonText }} or similar
    const hasDynamicButtonLabel =
      source.match(/\{\{\s*copyButtonText\s*\}\}/) ||
      source.match(/\{\{\s*buttonLabel\s*\}\}/) ||
      source.match(/\{\{\s*copiedState\s*\}\}/)
    expect(hasDynamicButtonLabel).toBeTruthy()
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC5 — Warning message displayed
// ──────────────────────────────────────────────────────────────────────────────

describe("US-002-3 AC5: Warning message uses i18n key for apiKeyReveal.message", () => {
  test('source uses i18n key for warning message', () => {
    const source = getSource()
    // Should use i18n key for the warning message
    expect(source).toMatch(/t\s*\(\s*['"]agents\.rotateKey\.apiKeyReveal\.message['"]/)
  })

  test('source displays warning in the key-reveal section', () => {
    const source = getSource()
    // The warning should appear alongside the apiKey display using i18n
    const keyRevealSection = source.match(/v-if=["']apiKey["'][\s\S]*?<\/template>/)
    expect(keyRevealSection).not.toBeNull()
    const hasWarningInSection = keyRevealSection![0].includes("t('agents.rotateKey.apiKeyReveal.message')") || keyRevealSection![0].includes('t("agents.rotateKey.apiKeyReveal.message")')
    expect(hasWarningInSection).toBe(true)
  })

  test('warning message is visible to user in key-reveal view', () => {
    const source = getSource()
    // The warning should be inside the key-reveal section (v-if="apiKey")
    // using the i18n key
    const warningPattern = /v-if=["']apiKey["'][\s\S]{0,1000}t\s*\(\s*['"]agents\.rotateKey\.apiKeyReveal\.message['"]/
    const hasWarningElement = source.match(warningPattern)
    expect(hasWarningElement).not.toBeNull()
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC6 — Done button emits 'created' event and closes the dialog
// ──────────────────────────────────────────────────────────────────────────────

describe("US-002-3 AC6: Done button emits 'created' event and closes the dialog", () => {
  test('source has a Done button in the key-reveal view', () => {
    const source = getSource()
    // Should have a Button with "Done" text in the key-reveal section
    const doneButtonInKeyReveal = source.match(/v-if=["']apiKey["'][\s\S]{0,500}Done/)
    expect(doneButtonInKeyReveal).not.toBeNull()
  })

  test('Done button has a click handler', () => {
    const source = getSource()
    // The Done button should have @click handler
    const doneButtonRegion = source.match(/Done[\s\S]{0,300}<\/Button>/)
    expect(doneButtonRegion).not.toBeNull()
    // The Done button should be inside key-reveal section
    const doneInKeyReveal = source.match(/v-if=["']apiKey["'][\s\S]{0,800}<Button[\s\S]{0,200}Done/)
    expect(doneInKeyReveal).not.toBeNull()
  })

  test('Done button click handler emits created event', () => {
    const source = getSource()
    // When Done is clicked, should emit 'created'
    // The emit('created') should be in a function called from Done button's @click
    // Look for handleDone function that contains emit('created')
    const handleDoneFunction = source.match(/function\s+handleDone[\s\S]{0,500}/)
    expect(handleDoneFunction).not.toBeNull()
    expect(handleDoneFunction![0]).toContain("emit('created')")
  })

  test('Done button closes the dialog by emitting update:open with false', () => {
    const source = getSource()
    // When Done is clicked, should emit update:open(false) to close
    const handleDoneFunction = source.match(/function\s+handleDone[\s\S]{0,500}/)
    expect(handleDoneFunction).not.toBeNull()
    const hasCloseDialog = handleDoneFunction![0].includes("emit('update:open'")
    expect(hasCloseDialog).toBe(true)
  })

  test('Done button resets apiKey state after closing', () => {
    const source = getSource()
    // After closing, should reset apiKey.value = null for next use
    const handleDoneFunction = source.match(/function\s+handleDone[\s\S]{0,500}/)
    expect(handleDoneFunction).not.toBeNull()
    const resetsApiKey = handleDoneFunction![0].includes('apiKey.value = null')
    expect(resetsApiKey).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Integration: Key-reveal view exists as distinct section
// ──────────────────────────────────────────────────────────────────────────────

describe('US-002-3: Key-reveal view is a distinct section in the dialog', () => {
  test('source has a template section for key-reveal that is conditionally rendered', () => {
    const source = getSource()
    // There should be a v-if or v-show for the key-reveal content
    const hasKeyRevealVIf =
      source.match(/v-if=["']apiKey["']/) ||
      source.match(/v-if=["']agent/)
    expect(hasKeyRevealVIf).not.toBeNull()
  })

  test('form and key-reveal are mutually exclusive (v-if on apiKey)', () => {
    const source = getSource()
    // The dialog should show form OR key-reveal, not both
    // This means there should be a v-if on the key-reveal section
    const hasMutuallyExclusive = source.includes('v-if="apiKey') || source.includes("v-if='apiKey")
    expect(hasMutuallyExclusive).toBe(true)
  })

  test('key-reveal view shows Input, Copy button, warning, and Done button together', () => {
    const source = getSource()
    // The key-reveal section should contain all required elements using i18n
    const keyRevealSection = source.match(/v-if=["']apiKey["'][\s\S]{0,1500}<\/div>/)
    expect(keyRevealSection).not.toBeNull()
    const section = keyRevealSection![0]
    // Check for all required elements with i18n keys
    expect(section).toContain('<Input')
    expect(section).toContain('readonly')
    expect(section).toContain('copyToClipboard')
    expect(section).toMatch(/t\s*\(\s*['"]agents\.rotateKey\.apiKeyReveal\.message['"]/)
    expect(section).toMatch(/t\s*\(\s*['"]common\.done['"]/)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Quality: No console.log
// ──────────────────────────────────────────────────────────────────────────────

describe('US-002-3: CreateAgentDialog.vue has no console.log statements', () => {
  test('source does not contain console.log', () => {
    const source = getSource()
    expect(source).not.toContain('console.log')
  })
})
