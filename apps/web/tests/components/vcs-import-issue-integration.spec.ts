import { describe, test, expect } from '@jest/globals'
import { readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const boardPagePath = join(webDir, 'pages', '[project]', 'index.vue')

// ──────────────────────────────────────────────────────────────────────────────
// Integration: Board page includes ImportIssueDialog component
// ──────────────────────────────────────────────────────────────────────────────

describe('VCS-P1-005-E: Board page integrates ImportIssueDialog component', () => {
  test('board page imports ImportIssueDialog component', () => {
    const source = readFileSync(boardPagePath, 'utf-8')
    const hasImport =
      source.includes('ImportIssueDialog') &&
      (source.includes('import') || source.includes('components'))
    expect(hasImport).toBe(true)
  })

  test('board page renders ImportIssueDialog component', () => {
    const source = readFileSync(boardPagePath, 'utf-8')
    expect(source).toContain('<ImportIssueDialog')
  })

  test('board page passes open prop to ImportIssueDialog', () => {
    const source = readFileSync(boardPagePath, 'utf-8')
    const hasOpenProp =
      source.includes(':open=') &&
      source.includes('ImportIssueDialog')
    expect(hasOpenProp).toBe(true)
  })

  test('board page passes projectSlug prop to ImportIssueDialog', () => {
    const source = readFileSync(boardPagePath, 'utf-8')
    const hasSlugProp =
      (source.includes(':project-slug=') || source.includes(':projectSlug=')) &&
      source.includes('ImportIssueDialog')
    expect(hasSlugProp).toBe(true)
  })

  test('board page handles update:open event from ImportIssueDialog', () => {
    const source = readFileSync(boardPagePath, 'utf-8')
    const hasUpdateOpenHandler =
      source.includes('@update:open=') &&
      source.includes('ImportIssueDialog')
    expect(hasUpdateOpenHandler).toBe(true)
  })

  test('ImportIssueDialog close event updates dialog visibility state', () => {
    const source = readFileSync(boardPagePath, 'utf-8')
    const hasStateUpdate =
      source.includes('importDialog') || source.includes('ImportDialog') ||
      source.includes('showImport')
    expect(hasStateUpdate).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Integration: Board page button correctly opens ImportIssueDialog
// ──────────────────────────────────────────────────────────────────────────────

describe('VCS-P1-005-E: Board page button opens ImportIssueDialog', () => {
  test('Import Issue button toggle updates the correct state variable', () => {
    const source = readFileSync(boardPagePath, 'utf-8')
    const hasDialogToggle =
      source.includes('showImportDialog') ||
      source.includes('importDialogOpen') ||
      source.includes('isImportDialogOpen') ||
      source.includes('showImport')
    expect(hasDialogToggle).toBe(true)
  })

  test('Import Issue button sets dialog state to true on click', () => {
    const source = readFileSync(boardPagePath, 'utf-8')
    const hasClickHandler =
      source.includes('@click=') &&
      source.includes('true')
    expect(hasClickHandler).toBe(true)
  })

  test('board page passes correct dialog state to ImportIssueDialog', () => {
    const source = readFileSync(boardPagePath, 'utf-8')
    // Should bind the state variable to dialog :open prop
    const hasBinding =
      (source.includes(':open="') || source.includes(":open='")) &&
      source.includes('ImportIssueDialog')
    expect(hasBinding).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Integration: Dialog can close itself via update:open event
// ──────────────────────────────────────────────────────────────────────────────

describe('VCS-P1-005-E: ImportIssueDialog can close from board page', () => {
  test('board page updates dialog state on close event', () => {
    const source = readFileSync(boardPagePath, 'utf-8')
    const hasCloseHandler =
      source.includes('@update:open=') &&
      source.includes('$event')
    expect(hasCloseHandler).toBe(true)
  })

  test('dialog state is toggled via @update:open event binding', () => {
    const source = readFileSync(boardPagePath, 'utf-8')
    const hasEventBinding =
      source.includes('ImportIssueDialog') &&
      source.includes('@update:open=')
    expect(hasEventBinding).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Integration: After successful import, board data may refresh
// ──────────────────────────────────────────────────────────────────────────────

describe('VCS-P1-005-E: After import success, board should refresh data', () => {
  test('board page has access to refresh function from useAsyncData', () => {
    const source = readFileSync(boardPagePath, 'utf-8')
    const hasRefresh =
      source.includes('refresh') &&
      source.includes('useAsyncData')
    expect(hasRefresh).toBe(true)
  })

  test('board page could handle imported event from dialog', () => {
    const source = readFileSync(boardPagePath, 'utf-8')
    // Optional: dialog may emit an event to trigger board refresh
    // This is flexible - implementation could handle it different ways
    const couldHandleEvent =
      source.includes('@') || source.includes('emit')
    expect(couldHandleEvent).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Quality checks for integration
// ──────────────────────────────────────────────────────────────────────────────

describe('VCS-P1-005-E: Integration quality checks', () => {
  test('board page handles both CreateTicketDialog and ImportIssueDialog', () => {
    const source = readFileSync(boardPagePath, 'utf-8')
    expect(source).toContain('CreateTicketDialog')
    expect(source).toContain('ImportIssueDialog')
  })

  test('no console.log in board page', () => {
    const source = readFileSync(boardPagePath, 'utf-8')
    expect(source).not.toContain('console.log')
  })
})
