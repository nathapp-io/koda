import { describe, test, expect } from '@jest/globals'
import { readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '..')
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
      source.match(/const\s+\w+\s*=\s*await\s+\$api\.post\s*\(\s*['"]\/agents['"]/) ||
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
    // Currently the source does: await $api.post(...) without capturing result
    // So this test should fail (RED phase)
    const storesResponse = source.match(/await\s+\$api\.post\s*\(\s*['"]\/agents['"][\s\S]{0,50}const\s+\w+/)
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
  test('source has a Copy button in the key-reveal view', () => {
    const source = getSource()
    // Should have a Button with "Copy" text in the key-reveal section
    // Check for Button with Copy text near apiKey
    const hasCopyButtonNearApiKey = source.match(/v-if=["']apiKey["'][\s\S]{0,800}Copy/)
    expect(hasCopyButtonNearApiKey).not.toBeNull()
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

  test('Copy button has a click handler', () => {
    const source = getSource()
    // Button should have @click handler near the Copy button
    // Find the Copy button region and check for @click in that region
    const copyButtonRegion = source.match(/Copy[\s\S]{0,100}<Button/)
    if (copyButtonRegion) {
      const hasClickHandler = copyButtonRegion[0].includes('@click')
      expect(hasClickHandler).toBe(true)
    } else {
      // Button might come before text, check if Button has Copy and @click nearby
      const buttonWithCopy = source.match(/<Button[^>]*>[\s\S]{0,50}Copy[\s\S]{0,50}<\/Button>/)
      if (buttonWithCopy) {
        expect(buttonWithCopy[0]).toContain('@click')
      } else {
        // Check for Copy in a button with @click before it
        const copyWithClickNear = source.match(/@click[^>]*>[\s\S]{0,50}Copy/)
        expect(copyWithClickNear).not.toBeNull()
      }
    }
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

  test('source updates button label to Copied! on click', () => {
    const source = getSource()
    // When copy is clicked, should set button text to "Copied!"
    expect(source).toMatch(/Copied!/)
  })

  test('source uses setTimeout to revert button label after 2 seconds', () => {
    const source = getSource()
    // Should use setTimeout with 2000ms to revert the button label
    const hasTwoSecondTimeout =
      source.match(/setTimeout\s*\([^)]*2000/) ||
      source.match(/setTimeout\s*\([^)]*2\s*\*\s*1000/)
    expect(hasTwoSecondTimeout).toBe(true)
  })

  test('source reverts button label back to Copy after timeout', () => {
    const source = getSource()
    // After setTimeout, should revert to "Copy"
    // Look for: setTimeout that sets button text back to Copy
    const hasRevertToCopy = source.includes("'Copy'") && source.includes('setTimeout')
    expect(hasRevertToCopy).toBe(true)
  })

  test('button displays dynamic label based on copy state', () => {
    const source = getSource()
    // Button should use dynamic label like {{ copyButtonText }} or similar
    const hasDynamicButtonLabel =
      source.match(/\{\{\s*copyButtonText\s*\}\}/) ||
      source.match(/\{\{\s*buttonLabel\s*\}\}/) ||
      (source.includes('copyButtonText') && source.includes('{{'))
    expect(hasDynamicButtonLabel).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC5 — Warning message displayed
// ──────────────────────────────────────────────────────────────────────────────

describe("US-002-3 AC5: Warning message 'Copy this API key now. It will not be shown again.' is displayed", () => {
  test('source contains the warning text about copying the API key', () => {
    const source = getSource()
    // Should contain the warning message
    expect(source).toContain('Copy this API key now')
    expect(source).toContain('will not be shown again')
  })

  test('source displays warning in the key-reveal section', () => {
    const source = getSource()
    // The warning should appear alongside the apiKey display
    // After the Input showing the apiKey, there should be warning text
    const keyRevealSection = source.match(/v-if=["']apiKey["'][\s\S]*?<\/template>/)
    expect(keyRevealSection).not.toBeNull()
    const hasWarningInSection = keyRevealSection![0].includes('Copy this API key now')
    expect(hasWarningInSection).toBe(true)
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

  test('Done button click handler emits created event', () => {
    const source = getSource()
    // When Done is clicked, should emit 'created'
    // Find Done button region and check for emit('created') nearby
    const doneButtonRegion = source.match(/Done[\s\S]{0,200}emit\s*\(\s*['"]created['"]/)
    expect(doneButtonRegion).not.toBeNull()
  })

  test('Done button closes the dialog', () => {
    const source = getSource()
    // When Done is clicked, should emit update:open(false) to close
    // Find Done button region and check for update:open emission nearby
    const doneClosesDialog = source.match(/Done[\s\S]{0,200}update:open/)
    expect(doneClosesDialog).not.toBeNull()
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
