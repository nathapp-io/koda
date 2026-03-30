import { describe, test, expect } from '@jest/globals'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const pagePath = join(webDir, 'pages', 'agents.vue')

// ──────────────────────────────────────────────────────────────────────────────
// File existence
// ──────────────────────────────────────────────────────────────────────────────

describe('US-003-3: pages/agents.vue exists', () => {
  test('file is present at pages/agents.vue', () => {
    expect(existsSync(pagePath)).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC1 — When pages/agents.vue receives 'updated' from either edit dialog,
//        it calls refresh()
// ──────────────────────────────────────────────────────────────────────────────

describe('US-003-3 AC1: refresh() is called on updated event from edit dialogs', () => {
  test('source imports EditAgentRolesDialog component', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toContain('EditAgentRolesDialog')
  })

  test('source imports EditAgentCapabilitiesDialog component', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toContain('EditAgentCapabilitiesDialog')
  })

  test('source has @updated handler that calls refresh', () => {
    const source = readFileSync(pagePath, 'utf-8')
    // Check for @updated listener that calls handleRolesUpdated or handleCapabilitiesUpdated
    // which in turn call refresh()
    expect(source).toMatch(/@updated="handle(Roles|Capabilities)Updated"/)
  })

  test('source has EditAgentRolesDialog with @updated listener', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toContain('@updated')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC2 — When the actions dropdown is opened for an agent row,
//        it contains 'Edit Roles' and 'Edit Capabilities' items
// ──────────────────────────────────────────────────────────────────────────────

describe('US-003-3 AC2: dropdown contains Edit Roles and Edit Capabilities items', () => {
  test('source uses DropdownMenuItem for Edit Roles', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toContain('Edit Roles')
  })

  test('source uses DropdownMenuItem for Edit Capabilities', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toContain('Edit Capabilities')
  })

  test('source opens EditAgentRolesDialog via dropdown menu item', () => {
    const source = readFileSync(pagePath, 'utf-8')
    // Should have a ref for roles dialog and it should be opened
    expect(source).toMatch(/EditAgentRolesDialog/)
  })

  test('source opens EditAgentCapabilitiesDialog via dropdown menu item', () => {
    const source = readFileSync(pagePath, 'utf-8')
    // Should have a ref for capabilities dialog and it should be opened
    expect(source).toMatch(/EditAgentCapabilitiesDialog/)
  })

  test('source has ref to track which agent is being edited for roles', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toMatch(/rolesDialogAgent|isRolesDialogOpen|selectedAgent/)
  })

  test('source has ref to track which agent is being edited for capabilities', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toMatch(/capabilitiesDialogAgent|isCapabilitiesDialogOpen|selectedAgent/)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Quality — no console.log
// ──────────────────────────────────────────────────────────────────────────────

describe('US-003-3: pages/agents.vue has no console.log statements', () => {
  test('source does not contain console.log', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).not.toContain('console.log')
  })
})