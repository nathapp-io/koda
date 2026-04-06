import { describe, test, expect } from '@jest/globals'
import { readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const enLocalesPath = join(webDir, 'i18n', 'locales', 'en.json')
const zhLocalesPath = join(webDir, 'i18n', 'locales', 'zh.json')

// ──────────────────────────────────────────────────────────────────────────────
// i18n keys for sidebar Settings link
// ──────────────────────────────────────────────────────────────────────────────

describe('VCS-P1-005-E: i18n translations for Settings link', () => {
  test('en.json contains nav.settings key', () => {
    const content = readFileSync(enLocalesPath, 'utf-8')
    const json = JSON.parse(content)
    expect(json.nav).toBeDefined()
    expect(json.nav.settings).toBeDefined()
    expect(typeof json.nav.settings).toBe('string')
    expect(json.nav.settings.length).toBeGreaterThan(0)
  })

  test('zh.json contains nav.settings key', () => {
    const content = readFileSync(zhLocalesPath, 'utf-8')
    const json = JSON.parse(content)
    expect(json.nav).toBeDefined()
    expect(json.nav.settings).toBeDefined()
    expect(typeof json.nav.settings).toBe('string')
    expect(json.nav.settings.length).toBeGreaterThan(0)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// i18n keys for Import Issue dialog
// ──────────────────────────────────────────────────────────────────────────────

describe('VCS-P1-005-E: i18n translations for Import Issue dialog', () => {
  test('en.json contains vcs.importIssue.title key', () => {
    const content = readFileSync(enLocalesPath, 'utf-8')
    const json = JSON.parse(content)
    expect(json.vcs).toBeDefined()
    expect(json.vcs.importIssue).toBeDefined()
    expect(json.vcs.importIssue.title).toBeDefined()
  })

  test('zh.json contains vcs.importIssue.title key', () => {
    const content = readFileSync(zhLocalesPath, 'utf-8')
    const json = JSON.parse(content)
    expect(json.vcs).toBeDefined()
    expect(json.vcs.importIssue).toBeDefined()
    expect(json.vcs.importIssue.title).toBeDefined()
  })

  test('en.json contains vcs.importIssue.button key', () => {
    const content = readFileSync(enLocalesPath, 'utf-8')
    const json = JSON.parse(content)
    expect(json.vcs.importIssue).toBeDefined()
    expect(json.vcs.importIssue.button).toBeDefined()
  })

  test('zh.json contains vcs.importIssue.button key', () => {
    const content = readFileSync(zhLocalesPath, 'utf-8')
    const json = JSON.parse(content)
    expect(json.vcs.importIssue).toBeDefined()
    expect(json.vcs.importIssue.button).toBeDefined()
  })

  test('en.json contains vcs.importIssue.label key for issue number field', () => {
    const content = readFileSync(enLocalesPath, 'utf-8')
    const json = JSON.parse(content)
    expect(json.vcs.importIssue).toBeDefined()
    expect(json.vcs.importIssue.label).toBeDefined()
  })

  test('zh.json contains vcs.importIssue.label key', () => {
    const content = readFileSync(zhLocalesPath, 'utf-8')
    const json = JSON.parse(content)
    expect(json.vcs.importIssue).toBeDefined()
    expect(json.vcs.importIssue.label).toBeDefined()
  })

  test('en.json contains vcs.importIssue.placeholder key', () => {
    const content = readFileSync(enLocalesPath, 'utf-8')
    const json = JSON.parse(content)
    expect(json.vcs.importIssue).toBeDefined()
    expect(json.vcs.importIssue.placeholder).toBeDefined()
  })

  test('zh.json contains vcs.importIssue.placeholder key', () => {
    const content = readFileSync(zhLocalesPath, 'utf-8')
    const json = JSON.parse(content)
    expect(json.vcs.importIssue).toBeDefined()
    expect(json.vcs.importIssue.placeholder).toBeDefined()
  })

  test('en.json contains vcs.importIssue.submit key for submit button', () => {
    const content = readFileSync(enLocalesPath, 'utf-8')
    const json = JSON.parse(content)
    expect(json.vcs.importIssue).toBeDefined()
    expect(json.vcs.importIssue.submit).toBeDefined()
  })

  test('zh.json contains vcs.importIssue.submit key', () => {
    const content = readFileSync(zhLocalesPath, 'utf-8')
    const json = JSON.parse(content)
    expect(json.vcs.importIssue).toBeDefined()
    expect(json.vcs.importIssue.submit).toBeDefined()
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// i18n keys for Import Issue toast messages
// ──────────────────────────────────────────────────────────────────────────────

describe('VCS-P1-005-E: i18n translations for Import Issue toast messages', () => {
  test('en.json contains vcs.importIssue.success key for success toast', () => {
    const content = readFileSync(enLocalesPath, 'utf-8')
    const json = JSON.parse(content)
    expect(json.vcs.importIssue).toBeDefined()
    expect(json.vcs.importIssue.success).toBeDefined()
  })

  test('zh.json contains vcs.importIssue.success key', () => {
    const content = readFileSync(zhLocalesPath, 'utf-8')
    const json = JSON.parse(content)
    expect(json.vcs.importIssue).toBeDefined()
    expect(json.vcs.importIssue.success).toBeDefined()
  })

  test('en.json contains vcs.importIssue.error key for error message', () => {
    const content = readFileSync(enLocalesPath, 'utf-8')
    const json = JSON.parse(content)
    expect(json.vcs.importIssue).toBeDefined()
    expect(json.vcs.importIssue.error).toBeDefined()
  })

  test('zh.json contains vcs.importIssue.error key', () => {
    const content = readFileSync(zhLocalesPath, 'utf-8')
    const json = JSON.parse(content)
    expect(json.vcs.importIssue).toBeDefined()
    expect(json.vcs.importIssue.error).toBeDefined()
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// i18n validation messages
// ──────────────────────────────────────────────────────────────────────────────

describe('VCS-P1-005-E: i18n validation messages for Import Issue dialog', () => {
  test('en.json contains vcs.importIssue.validation keys', () => {
    const content = readFileSync(enLocalesPath, 'utf-8')
    const json = JSON.parse(content)
    expect(json.vcs.importIssue).toBeDefined()
    expect(json.vcs.importIssue.validation).toBeDefined()
  })

  test('zh.json contains vcs.importIssue.validation keys', () => {
    const content = readFileSync(zhLocalesPath, 'utf-8')
    const json = JSON.parse(content)
    expect(json.vcs.importIssue).toBeDefined()
    expect(json.vcs.importIssue.validation).toBeDefined()
  })

  test('en.json contains vcs.importIssue.validation.required key', () => {
    const content = readFileSync(enLocalesPath, 'utf-8')
    const json = JSON.parse(content)
    expect(json.vcs.importIssue.validation).toBeDefined()
    expect(json.vcs.importIssue.validation.required).toBeDefined()
  })

  test('zh.json contains vcs.importIssue.validation.required key', () => {
    const content = readFileSync(zhLocalesPath, 'utf-8')
    const json = JSON.parse(content)
    expect(json.vcs.importIssue.validation).toBeDefined()
    expect(json.vcs.importIssue.validation.required).toBeDefined()
  })

  test('en.json contains vcs.importIssue.validation.invalidNumber key', () => {
    const content = readFileSync(enLocalesPath, 'utf-8')
    const json = JSON.parse(content)
    expect(json.vcs.importIssue.validation).toBeDefined()
    expect(json.vcs.importIssue.validation.invalidNumber).toBeDefined()
  })

  test('zh.json contains vcs.importIssue.validation.invalidNumber key', () => {
    const content = readFileSync(zhLocalesPath, 'utf-8')
    const json = JSON.parse(content)
    expect(json.vcs.importIssue.validation).toBeDefined()
    expect(json.vcs.importIssue.validation.invalidNumber).toBeDefined()
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// i18n value checks
// ──────────────────────────────────────────────────────────────────────────────

describe('VCS-P1-005-E: i18n translation values are non-empty strings', () => {
  test('all Settings link values are non-empty strings', () => {
    const content = readFileSync(enLocalesPath, 'utf-8')
    const json = JSON.parse(content)
    expect(typeof json.nav.settings).toBe('string')
    expect(json.nav.settings.length).toBeGreaterThan(0)
  })

  test('all Import Issue dialog values are non-empty strings', () => {
    const enContent = readFileSync(enLocalesPath, 'utf-8')
    const enJson = JSON.parse(enContent)
    const values = [
      enJson.vcs.importIssue.title,
      enJson.vcs.importIssue.button,
      enJson.vcs.importIssue.label,
      enJson.vcs.importIssue.placeholder,
      enJson.vcs.importIssue.submit,
      enJson.vcs.importIssue.success,
      enJson.vcs.importIssue.error,
    ]
    values.forEach((value) => {
      expect(typeof value).toBe('string')
      expect(value.length).toBeGreaterThan(0)
    })
  })
})
