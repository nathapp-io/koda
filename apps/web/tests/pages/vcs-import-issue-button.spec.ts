import { describe, test, expect } from '@jest/globals'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const boardPagePath = join(webDir, 'pages', '[project]', 'index.vue')

// ──────────────────────────────────────────────────────────────────────────────
// AC2 — Board page renders an Import Issue button
// ──────────────────────────────────────────────────────────────────────────────

describe('VCS-P1-005-E AC2: Board page has Import Issue button', () => {
  test('board page exists', () => {
    expect(existsSync(boardPagePath)).toBe(true)
  })

  test('board page uses i18n for Import Issue button text', () => {
    const source = readFileSync(boardPagePath, 'utf-8')
    const hasImportIssueI18n =
      source.includes("t('vcs.importIssue')") ||
      source.includes("t('vcs.import')") ||
      source.includes('importIssue')
    expect(hasImportIssueI18n).toBe(true)
  })

  test('board page has a reactive state for Import Issue dialog visibility', () => {
    const source = readFileSync(boardPagePath, 'utf-8')
    const hasDialogState =
      source.includes('showImportDialog') ||
      source.includes('importDialogOpen') ||
      source.includes('isImportDialogOpen') ||
      source.includes('showImport')
    expect(hasDialogState).toBe(true)
  })

  test('board page renders Import Issue button that opens dialog', () => {
    const source = readFileSync(boardPagePath, 'utf-8')
    // Should have a button that toggles dialog state
    const hasButton =
      source.includes('@click=') && (
        source.includes('importDialog') ||
        source.includes('ImportDialog')
      )
    expect(hasButton).toBe(true)
  })

  test('Import Issue button uses Button component', () => {
    const source = readFileSync(boardPagePath, 'utf-8')
    expect(source).toContain('<Button')
  })

  test('no console.log in board page', () => {
    const source = readFileSync(boardPagePath, 'utf-8')
    expect(source).not.toContain('console.log')
  })
})
