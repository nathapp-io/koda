import { describe, test, expect } from '@jest/globals'
import { readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const labelsPagePath = join(webDir, 'pages/[project]/labels.vue')
const _utilsPath = join(webDir, 'lib/utils.ts')

describe('US-004 AC1: Given label row contains valid color value, when table renders, then swatch background uses that color', () => {
  test('source renders color swatch with backgroundColor bound to label.color', () => {
    const source = readFileSync(labelsPagePath, 'utf-8')
    const hasColorSwatch =
      source.includes('label.color') &&
      source.includes('backgroundColor')
    expect(hasColorSwatch).toBe(true)
  })

  test('color swatch element uses inline style with backgroundColor', () => {
    const source = readFileSync(labelsPagePath, 'utf-8')
    const hasInlineStyle = source.includes(':style="{ backgroundColor:')
    expect(hasInlineStyle).toBe(true)
  })
})

describe('US-004 AC2: Given label row contains invalid persisted color value, when table renders, then swatch uses neutral fallback color', () => {
  test('source defines a fallback color constant for invalid colors', () => {
    const source = readFileSync(labelsPagePath, 'utf-8')
    const hasFallbackColor =
      source.includes('#E5E7EB') ||
      source.includes('#D1D5DB') ||
      source.includes('#9CA3AF') ||
      source.includes('fallbackColor') ||
      source.includes('NEUTRAL_COLOR') ||
      source.includes('invalidColor')
    expect(hasFallbackColor).toBe(true)
  })

  test('source defines a isValidColor or similar validation function for hex colors', () => {
    const source = readFileSync(labelsPagePath, 'utf-8')
    const hasValidation =
      source.includes('isValidColor') ||
      source.includes('isValidHex') ||
      source.includes('validColor') ||
      source.includes('/^#[0-9A-F]{6}$/')
    expect(hasValidation).toBe(true)
  })

  test('source uses a helper to get safe color for swatch rendering', () => {
    const source = readFileSync(labelsPagePath, 'utf-8')
    const hasSafeColorHelper =
      source.includes('getSafeColor') ||
      source.includes('safeColor') ||
      source.includes('fallbackColor') ||
      (source.includes('isValid') && source.includes('color'))
    expect(hasSafeColorHelper).toBe(true)
  })

  test('source applies fallback when color is invalid in the table row template', () => {
    const source = readFileSync(labelsPagePath, 'utf-8')
    const tableRowMatch = source.match(/<TableRow[\s\S]*?<\/TableRow>/)
    expect(tableRowMatch).not.toBeNull()
    const tableRowSource = tableRowMatch![0]
    const usesFallback =
      tableRowSource.includes('fallbackColor') ||
      tableRowSource.includes('getSafeColor') ||
      tableRowSource.includes('isValidColor') ||
      tableRowSource.includes('#E5E7EB') ||
      (tableRowSource.includes('?') && tableRowSource.includes(':'))
    expect(usesFallback).toBe(true)
  })
})

describe('US-004 AC3: When create label succeeds, then form resets to initial values', () => {
  test('source calls resetForm() after successful POST', () => {
    const source = readFileSync(labelsPagePath, 'utf-8')
    expect(source).toContain('resetForm')
  })

  test('resetForm is called after toast.success in onSubmit success path', () => {
    const source = readFileSync(labelsPagePath, 'utf-8')
    const toastSuccessIdx = source.indexOf("toast.success(t('labels.toast.created'))")
    const resetFormIdx = source.indexOf('resetForm()')
    expect(resetFormIdx).toBeGreaterThan(toastSuccessIdx)
  })
})

describe('US-004 AC4: When create label succeeds, then refresh() is invoked', () => {
  test('source calls refresh() after successful POST', () => {
    const source = readFileSync(labelsPagePath, 'utf-8')
    expect(source).toContain('refresh')
  })

  test('refresh is called after toast.success for label creation', () => {
    const source = readFileSync(labelsPagePath, 'utf-8')
    const toastSuccessIdx = source.indexOf("toast.success(t('labels.toast.created'))")
    const refreshIdx = source.indexOf('await refresh()')
    expect(refreshIdx).toBeGreaterThan(toastSuccessIdx)
  })
})

describe('US-004 AC5: When delete label succeeds, then refresh() is invoked', () => {
  test('source calls refresh() after successful DELETE', () => {
    const source = readFileSync(labelsPagePath, 'utf-8')
    const deleteLabelMatch = source.match(/async function deleteLabel[\s\S]*?\{[\s\S]*?\}\s*\}/)
    expect(deleteLabelMatch).not.toBeNull()
    const deleteLabelBody = deleteLabelMatch![0]
    expect(deleteLabelBody).toContain('refresh')
  })

  test('refresh is called after toast.success in deleteLabel function', () => {
    const source = readFileSync(labelsPagePath, 'utf-8')
    const deleteLabelMatch = source.match(/async function deleteLabel[\s\S]*?\{[\s\S]*?\}\s*\}/)
    expect(deleteLabelMatch).not.toBeNull()
    const deleteLabelBody = deleteLabelMatch![0]
    const toastSuccessMatch = deleteLabelBody.match(/toast\.success\([^)]+\)/)
    expect(toastSuccessMatch).not.toBeNull()
    const afterToast = deleteLabelBody.substring(deleteLabelBody.indexOf(toastSuccessMatch![0]) + toastSuccessMatch![0].length)
    expect(afterToast).toContain('refresh')
  })
})

describe('US-004 AC6: When delete label succeeds, then a localized success toast is shown', () => {
  test('source shows toast.success with i18n key after successful DELETE', () => {
    const source = readFileSync(labelsPagePath, 'utf-8')
    const deleteLabelMatch = source.match(/async function deleteLabel[\s\S]*?\{[\s\S]*?\}\s*\}/)
    expect(deleteLabelMatch).not.toBeNull()
    const deleteLabelBody = deleteLabelMatch![0]
    expect(deleteLabelBody).toContain("toast.success")
    expect(deleteLabelBody).toContain("labels.toast.deleted")
  })

  test('deleteLabel function uses t() for localized delete success message', () => {
    const source = readFileSync(labelsPagePath, 'utf-8')
    const deleteLabelMatch = source.match(/async function deleteLabel[\s\S]*?\{[\s\S]*?\}\s*\}/)
    expect(deleteLabelMatch).not.toBeNull()
    const deleteLabelBody = deleteLabelMatch![0]
    const toastSuccessMatch = deleteLabelBody.match(/toast\.success\([^)]+\)/)
    expect(toastSuccessMatch).not.toBeNull()
    expect(toastSuccessMatch![0]).toContain("t('labels.toast.deleted')")
  })
})
