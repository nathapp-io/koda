import { describe, test, expect } from '@jest/globals'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const pagePath = join(webDir, 'pages', '[project]', 'agents.vue')

// ──────────────────────────────────────────────────────────────────────────────
// File existence
// ──────────────────────────────────────────────────────────────────────────────

describe('US-006: pages/[project]/agents.vue exists', () => {
  test('file is present at pages/[project]/agents.vue', () => {
    expect(existsSync(pagePath)).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC1 — fetches GET /agents via useApi() with useAsyncData and renders Table
// ──────────────────────────────────────────────────────────────────────────────

describe('US-006 AC1: fetches GET /agents via useApi() with useAsyncData', () => {
  test('source uses useAsyncData for data fetching', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toContain('useAsyncData')
  })

  test('source uses useApi composable', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toContain('useApi')
  })

  test('source calls $api.get for fetching agents', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toContain('$api.get')
  })

  test('source fetches from project-scoped /projects/${slug}/agents endpoint', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toMatch(/['"`]\/projects\/\$\{slug\}\/agents['"`]/)
  })

  test('source renders a Table component', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toContain('Table')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC2 — Each row shows Name, Slug, Roles as Badge list, Capabilities as Badge
//        list, Status badge, Actions dropdown
// ──────────────────────────────────────────────────────────────────────────────

describe('US-006 AC2: table columns — Name, Slug, Roles, Capabilities, Status, Actions', () => {
  test('source has Name column header', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toContain("t('agents.columns.name')")
  })

  test('source has Slug column header', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toContain("t('agents.columns.slug')")
  })

  test('source has Roles column header', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toContain("t('agents.columns.roles')")
  })

  test('source has Capabilities column header', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toContain("t('agents.columns.capabilities')")
  })

  test('source has Status column header', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toContain("t('agents.columns.status')")
  })

  test('source has Actions column header', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toContain("t('agents.columns.actions')")
  })

  test('source renders agent name in table rows', () => {
    const source = readFileSync(pagePath, 'utf-8')
    const hasName =
      source.includes('agent.name') ||
      source.includes('.name')
    expect(hasName).toBe(true)
  })

  test('source renders agent slug in table rows', () => {
    const source = readFileSync(pagePath, 'utf-8')
    const hasSlug =
      source.includes('agent.slug') ||
      source.includes('.slug')
    expect(hasSlug).toBe(true)
  })

  test('source renders roles using Badge components', () => {
    const source = readFileSync(pagePath, 'utf-8')
    const hasRolesBadge =
      (source.includes('roles') || source.includes('agent.roles')) &&
      source.includes('Badge')
    expect(hasRolesBadge).toBe(true)
  })

  test('source renders capabilities using Badge components', () => {
    const source = readFileSync(pagePath, 'utf-8')
    const hasCapabilitiesBadge =
      (source.includes('capabilities') || source.includes('agent.capabilities')) &&
      source.includes('Badge')
    expect(hasCapabilitiesBadge).toBe(true)
  })

  test('source uses DropdownMenu for the Actions column', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toContain('DropdownMenu')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC3–AC5 — status styling is token-based (UX redesign slice 5): the page maps
// each agent state to a ticket status token via lib/ticket-chips.ts and renders
// a dot+label chip. The palette classes (bg-green-100 etc.) were removed on
// purpose; state is never color alone — the i18n label always accompanies the dot.
// ──────────────────────────────────────────────────────────────────────────────

describe('US-006 AC3-AC5: status styling is token-based', () => {
  test('source maps ACTIVE to the done (green) status token', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toContain("ACTIVE: 'done'")
  })

  test('source maps PAUSED to the review (amber) status token', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toContain("PAUSED: 'review'")
  })

  test('source maps OFFLINE to the todo (muted) status token', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toContain("OFFLINE: 'todo'")
  })

  test('source renders dot+label chips via the shared chip classes', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toContain('~/lib/ticket-chips')
    expect(source).toContain('TICKET_CHIP_CLASS')
    expect(source).toContain('TICKET_DOT_CLASS')
    expect(source).toContain('statusDotClass')
  })

  test('source no longer hardcodes palette status colors', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).not.toContain('bg-green-100')
    expect(source).not.toContain('text-green-800')
    expect(source).not.toContain('bg-yellow-100')
    expect(source).not.toContain('text-yellow-800')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC6 — Actions dropdown allows selecting ACTIVE, PAUSED, or OFFLINE
// ──────────────────────────────────────────────────────────────────────────────

describe('US-006 AC6: Actions dropdown contains all three status options', () => {
  test('source uses DropdownMenuItem for status actions', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toContain('DropdownMenuItem')
  })

  test('dropdown contains ACTIVE option', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toContain('ACTIVE')
  })

  test('dropdown contains PAUSED option', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toContain('PAUSED')
  })

  test('dropdown contains OFFLINE option', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toContain('OFFLINE')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC7 — Status change triggers PATCH API call and shows toast.success on success
// ──────────────────────────────────────────────────────────────────────────────

describe('US-006 AC7: status change triggers PATCH and shows toast.success', () => {
  test('source calls $api.patch to update agent status', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toContain('$api.patch')
  })

  test('source shows toast.success on successful status change', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toContain('toast.success')
  })

  test('source patches to /agents/:id or /agents/:slug endpoint', () => {
    const source = readFileSync(pagePath, 'utf-8')
    const hasPatchEndpoint =
      source.includes('/agents/') ||
      source.includes('agents/${') ||
      source.includes('agents/`')
    expect(hasPatchEndpoint).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC8 — Status change shows toast.error on failure
// ──────────────────────────────────────────────────────────────────────────────

describe('US-006 AC8: status change shows toast.error on failure', () => {
  test('source shows toast.error on failed status change', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toContain('toast.error')
  })

  test('source has try/catch or error handling around the PATCH call', () => {
    const source = readFileSync(pagePath, 'utf-8')
    const hasErrorHandling =
      source.includes('try') ||
      source.includes('catch') ||
      source.includes('.catch(')
    expect(hasErrorHandling).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Quality — no console.log
// ──────────────────────────────────────────────────────────────────────────────

describe('US-006: pages/[project]/agents.vue has no console.log statements', () => {
  test('source does not contain console.log', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).not.toContain('console.log')
  })
})
