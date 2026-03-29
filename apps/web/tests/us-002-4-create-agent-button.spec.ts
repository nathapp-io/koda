import { describe, test, expect } from '@jest/globals'
import { readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '..')
const pagePath = join(webDir, 'pages', 'agents.vue')

// Helper function to get the source once
function getSource(): string {
  return readFileSync(pagePath, 'utf-8')
}

// ──────────────────────────────────────────────────────────────────────────────
// AC1 — 'Create Agent' button exists in agents.vue PageHeader
// ──────────────────────────────────────────────────────────────────────────────

describe('US-002-4 AC1: Create Agent button exists in agents.vue PageHeader', () => {
  test('source contains a Create Agent button in the template', () => {
    const source = getSource()
    // Should have a Button with text "Create Agent" or similar
    const hasCreateAgentButton =
      source.includes('Create Agent') ||
      source.includes("t('agents.createAgent')") ||
      source.includes('createAgent')
    expect(hasCreateAgentButton).toBe(true)
  })

  test('source has a Dialog component wrapping the Create Agent button', () => {
    const source = getSource()
    // Should have Dialog component
    expect(source).toContain('Dialog')
  })

  test('source uses DialogTrigger to open the dialog', () => {
    const source = getSource()
    // Should have DialogTrigger
    expect(source).toContain('DialogTrigger')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC2 — Clicking the button opens CreateAgentDialog
// ──────────────────────────────────────────────────────────────────────────────

describe('US-002-4 AC2: Clicking the button opens CreateAgentDialog', () => {
  test('source includes CreateAgentDialog component', () => {
    const source = getSource()
    // Should import and use CreateAgentDialog component
    const hasCreateAgentDialog =
      source.includes('CreateAgentDialog') ||
      source.includes('create-agent-dialog')
    expect(hasCreateAgentDialog).toBe(true)
  })

  test('source passes open state to CreateAgentDialog', () => {
    const source = getSource()
    // Should have a ref or state for dialog open status
    // and pass it to CreateAgentDialog via :open or :open=
    const hasOpenState =
      source.includes(':open=') ||
      source.includes('open=') ||
      source.includes(':open=')
    expect(hasOpenState).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC3 — When dialog emits 'created' event, refresh() is called
// ──────────────────────────────────────────────────────────────────────────────

describe("US-002-4 AC3: When dialog emits 'created' event, refresh() is called", () => {
  test('source listens for created event from CreateAgentDialog', () => {
    const source = getSource()
    // Should have @created handler on CreateAgentDialog
    const hasCreatedHandler =
      source.includes("@created=") ||
      source.includes('@created=') ||
      source.includes('v-on:created=')
    expect(hasCreatedHandler).toBe(true)
  })

  test('source calls refresh() when created event is emitted', () => {
    const source = getSource()
    // The handler for @created should call refresh()
    // Look for handleAgentCreated function that calls refresh()
    const hasRefreshInHandler =
      source.includes('handleAgentCreated') &&
      !!source.match(/function\s+handleAgentCreated[\s\S]{0,200}refresh/)
    expect(hasRefreshInHandler).toBe(true)
  })

  test('refresh function is available from useAsyncData in the page', () => {
    const source = getSource()
    // refresh should come from useAsyncData
    expect(source).toContain('refresh')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC4 — Dialog closes after 'created' event is emitted
// ──────────────────────────────────────────────────────────────────────────────

describe("US-002-4 AC4: Dialog closes after 'created' event is emitted", () => {
  test('CreateAgentDialog receives update:open to close the dialog', () => {
    const source = getSource()
    // CreateAgentDialog should receive update:open event
    // This is typically handled by the dialog itself emitting update:open(false)
    // The page just needs to pass the open state reactively
    const hasUpdateOpenBinding =
      source.includes('@update:open=') ||
      source.includes('v-on:update:open=')
    expect(hasUpdateOpenBinding).toBe(true)
  })

  test('open state is reactive (ref or computed)', () => {
    const source = getSource()
    // Should have a reactive open state variable
    // The Dialog component :open binding should reference a reactive variable
    const hasReactiveOpenState =
      source.match(/:open=["']\w+["']/) ||
      source.match(/v-model:open=/)
    expect(hasReactiveOpenState).not.toBeNull()
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Integration: Create Agent button and dialog integration
// ──────────────────────────────────────────────────────────────────────────────

describe('US-002-4: Full integration of Create Agent button and CreateAgentDialog', () => {
  test('CreateAgentDialog is used in the template with proper event binding', () => {
    const source = getSource()
    // CreateAgentDialog should be present with @created handler
    expect(source).toContain('CreateAgentDialog')
    expect(source).toContain('@created=')
    // Should also have :open binding
    expect(source).toMatch(/CreateAgentDialog[\s\S]{0,500}:open=/)
  })

  test('Dialog wraps the Create Agent button with DialogTrigger', () => {
    const source = getSource()
    // Dialog should contain DialogTrigger which contains the button
    const dialogTriggerPattern = /DialogTrigger[\s\S]{0,200}>[\s\S]{0,200}Button/
    expect(dialogTriggerPattern.test(source)).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Quality: No console.log
// ──────────────────────────────────────────────────────────────────────────────

describe('US-002-4: pages/agents.vue has no console.log statements', () => {
  test('source does not contain console.log', () => {
    const source = getSource()
    expect(source).not.toContain('console.log')
  })
})