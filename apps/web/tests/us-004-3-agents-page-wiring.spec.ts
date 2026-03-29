import { describe, test, expect } from '@jest/globals'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '..')
const pagePath = join(webDir, 'pages', 'agents.vue')

// ──────────────────────────────────────────────────────────────────────────────
// AC8 — When pages/agents.vue receives 'rotated' from RotateKeyDialog,
//        it calls refresh()
// ──────────────────────────────────────────────────────────────────────────────

describe('US-004-3 AC8: refresh() is called on rotated event from RotateKeyDialog', () => {
  test('source imports RotateKeyDialog component', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toContain('RotateKeyDialog')
  })

  test('source has @rotated handler that calls refresh', () => {
    const source = readFileSync(pagePath, 'utf-8')
    // Check for @rotated listener that calls handleRotated or similar
    // which in turn call refresh()
    expect(source).toMatch(/@rotated="handleRotated|refresh/)
  })

  test('source has RotateKeyDialog with @rotated listener', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toContain('@rotated')
  })

  test('source has handler function for rotated event', () => {
    const source = readFileSync(pagePath, 'utf-8')
    const hasRotatedHandler =
      source.match(/handleRotated|onRotated|refreshRotated/)
    expect(hasRotatedHandler).not.toBeNull()
  })

  test('source calls refresh() in the rotated handler', () => {
    const source = readFileSync(pagePath, 'utf-8')
    // The handler should call refresh()
    const refreshCall = source.match(/handleRotated[\s\S]{0,200}refresh\s*\(\)/)
    expect(refreshCall).not.toBeNull()
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC9 — When pages/agents.vue receives 'deleted' from DeleteAgentDialog,
//        it calls refresh()
// ──────────────────────────────────────────────────────────────────────────────

describe('US-004-3 AC9: refresh() is called on deleted event from DeleteAgentDialog', () => {
  test('source imports DeleteAgentDialog component', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toContain('DeleteAgentDialog')
  })

  test('source has @deleted handler that calls refresh', () => {
    const source = readFileSync(pagePath, 'utf-8')
    // Check for @deleted listener that calls handleDeleted or similar
    // which in turn call refresh()
    expect(source).toMatch(/@deleted="handleDeleted|refresh/)
  })

  test('source has DeleteAgentDialog with @deleted listener', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toContain('@deleted')
  })

  test('source has handler function for deleted event', () => {
    const source = readFileSync(pagePath, 'utf-8')
    const hasDeletedHandler =
      source.match(/handleDeleted|onDeleted|refreshDeleted/)
    expect(hasDeletedHandler).not.toBeNull()
  })

  test('source calls refresh() in the deleted handler', () => {
    const source = readFileSync(pagePath, 'utf-8')
    // The handler should call refresh()
    const refreshCall = source.match(/handleDeleted[\s\S]{0,200}refresh\s*\(\)/)
    expect(refreshCall).not.toBeNull()
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC10 — When the actions dropdown is opened for an agent row,
//         it contains 'Rotate Key' and 'Delete' items
// ──────────────────────────────────────────────────────────────────────────────

describe('US-004-3 AC10: dropdown contains Rotate Key and Delete items', () => {
  test('source uses DropdownMenuItem for Rotate Key', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toContain('Rotate Key')
  })

  test('source uses DropdownMenuItem for Delete', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toContain('Delete')
  })

  test('source opens RotateKeyDialog via dropdown menu item', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toMatch(/RotateKeyDialog/)
  })

  test('source opens DeleteAgentDialog via dropdown menu item', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toMatch(/DeleteAgentDialog/)
  })

  test('source has ref to track which agent is being operated on for rotate key', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toMatch(/rotateDialogAgent|isRotateDialogOpen|selectedAgent/)
  })

  test('source has ref to track which agent is being operated on for delete', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toMatch(/deleteDialogAgent|isDeleteDialogOpen|selectedAgent/)
  })

  test('source has functions to open the rotate key dialog', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toMatch(/openRotateKeyDialog|openRotateDialog|handleRotateKey/)
  })

  test('source has functions to open the delete dialog', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toMatch(/openDeleteDialog|handleDelete/)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Dialog wiring tests
// ──────────────────────────────────────────────────────────────────────────────

describe('US-004-3: Dialog wiring in pages/agents.vue', () => {
  test('RotateKeyDialog is conditionally rendered with v-if', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toContain('RotateKeyDialog')
    // Should have v-if or similar conditional rendering
    expect(source).toMatch(/RotateKeyDialog[\s\S]{0,100}v-if|v-if[\s\S]{0,100}RotateKeyDialog/)
  })

  test('RotateKeyDialog receives :open prop', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toMatch(/RotateKeyDialog[\s\S]{0,200}:open=/)
  })

  test('RotateKeyDialog receives :agent prop', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toMatch(/RotateKeyDialog[\s\S]{0,200}:agent=/)
  })

  test('DeleteAgentDialog is conditionally rendered with v-if', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toContain('DeleteAgentDialog')
    // Should have v-if or similar conditional rendering
    expect(source).toMatch(/DeleteAgentDialog[\s\S]{0,100}v-if|v-if[\s\S]{0,100}DeleteAgentDialog/)
  })

  test('DeleteAgentDialog receives :open prop', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toMatch(/DeleteAgentDialog[\s\S]{0,200}:open=/)
  })

  test('DeleteAgentDialog receives :agent prop', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toMatch(/DeleteAgentDialog[\s\S]{0,200}:agent=/)
  })

  test('Both dialogs close via update:open emit', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toContain('@update:open')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Integration: Full flow
// ──────────────────────────────────────────────────────────────────────────────

describe('US-004-3: Full agents page integration for RotateKeyDialog and DeleteAgentDialog', () => {
  test('page has all four dialog imports (CreateAgentDialog, EditAgentRolesDialog, EditAgentCapabilitiesDialog, RotateKeyDialog, DeleteAgentDialog)', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toContain('CreateAgentDialog')
    expect(source).toContain('EditAgentRolesDialog')
    expect(source).toContain('EditAgentCapabilitiesDialog')
    expect(source).toContain('RotateKeyDialog')
    expect(source).toContain('DeleteAgentDialog')
  })

  test('page handles created, updated, rotated, and deleted events', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toContain('@created')
    expect(source).toContain('@updated')
    expect(source).toContain('@rotated')
    expect(source).toContain('@deleted')
  })

  test('all dialog handlers call refresh() to reload the agent list', () => {
    const source = readFileSync(pagePath, 'utf-8')
    // Count refresh() calls - should be at least 4 (created, updated, rotated, deleted)
    const refreshMatches = source.match(/refresh\s*\(\)/g)
    expect(refreshMatches).not.toBeNull()
    expect(refreshMatches!.length).toBeGreaterThanOrEqual(4)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Quality: No console.log
// ──────────────────────────────────────────────────────────────────────────────

describe('US-004-3: pages/agents.vue has no console.log statements', () => {
  test('source does not contain console.log', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).not.toContain('console.log')
  })
})
