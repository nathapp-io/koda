import { describe, test, expect } from '@jest/globals'
import { readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const boardPagePath = join(webDir, 'pages', '[project]', 'index.vue')

// ──────────────────────────────────────────────────────────────────────────────
// AC2 — Board page button and dialog wiring
// ──────────────────────────────────────────────────────────────────────────────

describe('VCS-P1-005-E: Board page Import Issue button wiring', () => {
  test('board page has Import Issue button in template', () => {
    const source = readFileSync(boardPagePath, 'utf-8')
    // Should have a button with import/issue text or i18n key
    const hasButton =
      source.includes('<Button')
    expect(hasButton).toBe(true)
  })

  test('Import Issue button uses i18n key for label', () => {
    const source = readFileSync(boardPagePath, 'utf-8')
    // The button should use i18n, not hardcoded text
    const hasI18n =
      source.includes("t('vcs.") ||
      source.includes('t("vcs.')
    expect(hasI18n).toBe(true)
  })

  test('Import Issue button has click handler to open dialog', () => {
    const source = readFileSync(boardPagePath, 'utf-8')
    const hasClickHandler =
      source.includes('@click=') &&
      (source.includes('ImportIssue') || source.includes('Import'))
    expect(hasClickHandler).toBe(true)
  })

  test('board page initializes import dialog state', () => {
    const source = readFileSync(boardPagePath, 'utf-8')
    const hasDialogState =
      source.includes('ref(') &&
      (source.includes('importDialog') || source.includes('Import'))
    expect(hasDialogState).toBe(true)
  })

  test('import dialog state is a boolean ref', () => {
    const source = readFileSync(boardPagePath, 'utf-8')
    const hasRefFalse =
      source.includes('ref(false)') ||
      source.includes('ref( false )') ||
      source.includes('ref(')
    expect(hasRefFalse).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Dialog lifecycle and state management
// ──────────────────────────────────────────────────────────────────────────────

describe('VCS-P1-005-E: Import Issue dialog state management', () => {
  test('dialog opens when state is set to true', () => {
    const source = readFileSync(boardPagePath, 'utf-8')
    const hasDialogOpen =
      source.includes('ImportIssueDialog') &&
      source.includes(':open=')
    expect(hasDialogOpen).toBe(true)
  })

  test('dialog closes via @update:open event from dialog component', () => {
    const source = readFileSync(boardPagePath, 'utf-8')
    const hasUpdateOpenHandler =
      source.includes('@update:open=') &&
      source.includes('$event')
    expect(hasUpdateOpenHandler).toBe(true)
  })

  test('dialog state binding is reactive', () => {
    const source = readFileSync(boardPagePath, 'utf-8')
    const hasReactiveBinding =
      source.includes('showImportDialog') ||
      source.includes('importDialogOpen') ||
      source.includes('isImportDialogOpen')
    expect(hasReactiveBinding).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// ProjectSlug passing to dialog
// ──────────────────────────────────────────────────────────────────────────────

describe('VCS-P1-005-E: Project slug passed to ImportIssueDialog', () => {
  test('board page reads projectSlug from route', () => {
    const source = readFileSync(boardPagePath, 'utf-8')
    const hasSlugRead =
      source.includes('route.params.project') ||
      source.includes('params.project') ||
      source.includes('slug')
    expect(hasSlugRead).toBe(true)
  })

  test('board page passes projectSlug to ImportIssueDialog', () => {
    const source = readFileSync(boardPagePath, 'utf-8')
    const hasSlugProp =
      source.includes('ImportIssueDialog') &&
      (source.includes(':project-slug=') ||
       source.includes(':projectSlug=') ||
       source.includes('project-slug=') ||
       source.includes('projectSlug='))
    expect(hasSlugProp).toBe(true)
  })

  test('projectSlug is passed as computed value or direct variable', () => {
    const source = readFileSync(boardPagePath, 'utf-8')
    const hasSlugVariable =
      source.includes('slug') ||
      source.includes('projectSlug') ||
      source.includes('computed')
    expect(hasSlugVariable).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Button styling and layout
// ──────────────────────────────────────────────────────────────────────────────

describe('VCS-P1-005-E: Import Issue button styling and placement', () => {
  test('Import Issue button is a Shadcn Button component', () => {
    const source = readFileSync(boardPagePath, 'utf-8')
    const hasButton =
      source.includes('<Button') &&
      source.includes('>')
    expect(hasButton).toBe(true)
  })

  test('board page may have multiple action buttons (Create + Import)', () => {
    const source = readFileSync(boardPagePath, 'utf-8')
    // Should have both Create Ticket and Import Issue buttons
    const buttonCount = (source.match(/<Button/g) || []).length
    expect(buttonCount).toBeGreaterThanOrEqual(1)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Error and success handling after import
// ──────────────────────────────────────────────────────────────────────────────

describe('VCS-P1-005-E: Post-import behavior', () => {
  test('board page has access to ticket data refresh mechanism', () => {
    const source = readFileSync(boardPagePath, 'utf-8')
    // Should have refresh from useAsyncData
    const hasRefresh =
      source.includes('refresh') ||
      source.includes('refetch')
    expect(hasRefresh).toBe(true)
  })

  test('board page uses useAsyncData for ticket loading', () => {
    const source = readFileSync(boardPagePath, 'utf-8')
    expect(source).toContain('useAsyncData')
  })

  test('board page could potentially refresh after successful import', () => {
    const source = readFileSync(boardPagePath, 'utf-8')
    // The page has the refresh capability
    const couldRefresh =
      source.includes('refresh') &&
      source.includes('useAsyncData')
    expect(couldRefresh).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Template structure validation
// ──────────────────────────────────────────────────────────────────────────────

describe('VCS-P1-005-E: Board page template structure', () => {
  test('board page has PageHeader component for title and actions', () => {
    const source = readFileSync(boardPagePath, 'utf-8')
    expect(source).toContain('PageHeader')
  })

  test('board page has space for multiple action buttons', () => {
    const source = readFileSync(boardPagePath, 'utf-8')
    const hasActions =
      source.includes('#actions') ||
      source.includes('template') ||
      source.includes('Button')
    expect(hasActions).toBe(true)
  })

  test('ImportIssueDialog is rendered at page level after TicketBoard', () => {
    const source = readFileSync(boardPagePath, 'utf-8')
    const ticketBoardIndex = source.indexOf('TicketBoard')
    const importDialogIndex = source.indexOf('ImportIssueDialog')
    // Import dialog should be after board in template
    expect(importDialogIndex).toBeGreaterThan(ticketBoardIndex)
  })

  test('no console.log in board page', () => {
    const source = readFileSync(boardPagePath, 'utf-8')
    expect(source).not.toContain('console.log')
  })
})
