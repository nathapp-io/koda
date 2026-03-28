import { describe, test, expect } from '@jest/globals'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const componentPath = join(webDir, 'components', 'LanguageSwitcher.vue')

// ──────────────────────────────────────────────────────────────────────────────
// File existence
// ──────────────────────────────────────────────────────────────────────────────

describe('US-005: components/LanguageSwitcher.vue exists', () => {
  test('file is present at components/LanguageSwitcher.vue', () => {
    expect(existsSync(componentPath)).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC1 — Active locale button uses locale.value === loc.code
// ──────────────────────────────────────────────────────────────────────────────

describe('US-005 AC1: active locale toggle button uses locale.value comparison, not bare locale', () => {
  test('source does not compare bare locale Ref to loc.code (would always be false)', () => {
    const source = readFileSync(componentPath, 'utf-8')
    // The bug: comparing a Ref object to a string — always false
    expect(source).not.toContain('locale === loc.code')
  })

  test('source compares locale.value to loc.code for active class', () => {
    const source = readFileSync(componentPath, 'utf-8')
    expect(source).toContain('locale.value === loc.code')
  })

  test('active button class bg-primary text-primary-foreground font-medium is present', () => {
    const source = readFileSync(componentPath, 'utf-8')
    expect(source).toContain('bg-primary text-primary-foreground font-medium')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC2 — Non-active locale button receives muted class
// ──────────────────────────────────────────────────────────────────────────────

describe('US-005 AC2: non-active locale toggle button receives muted class', () => {
  test('source includes text-muted-foreground hover:text-foreground hover:bg-muted for non-active button', () => {
    const source = readFileSync(componentPath, 'utf-8')
    expect(source).toContain('text-muted-foreground hover:text-foreground hover:bg-muted')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC3 — Select :model-value is bound to locale.value (string), not bare locale (Ref)
// ──────────────────────────────────────────────────────────────────────────────

describe('US-005 AC3: Select model-value prop equals the string locale.value, not the Ref object', () => {
  test('source does not bind bare locale Ref as Select model-value', () => {
    const source = readFileSync(componentPath, 'utf-8')
    // The bug: passing Ref object instead of unwrapped string
    expect(source).not.toMatch(/:model-value="locale"/)
  })

  test('source binds locale.value as Select model-value', () => {
    const source = readFileSync(componentPath, 'utf-8')
    expect(source).toMatch(/:model-value="locale\.value"/)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC4 — switchLocale(code) passes code directly to setLocale (must not change)
// ──────────────────────────────────────────────────────────────────────────────

describe('US-005 AC4: switchLocale(code) calls setLocale with the same code string', () => {
  test('source defines switchLocale function accepting a code parameter', () => {
    const source = readFileSync(componentPath, 'utf-8')
    expect(source).toMatch(/function\s+switchLocale\s*\(\s*code/)
  })

  test('source calls setLocale(code) inside switchLocale', () => {
    const source = readFileSync(componentPath, 'utf-8')
    expect(source).toMatch(/setLocale\s*\(\s*code\s*\)/)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Quality — currentLocaleName computed uses locale.value (must not be changed)
// ──────────────────────────────────────────────────────────────────────────────

describe('US-005: currentLocaleName computed already uses locale.value correctly', () => {
  test('source uses locale.value in currentLocaleName computed', () => {
    const source = readFileSync(componentPath, 'utf-8')
    // This was already correct and must remain so
    expect(source).toContain('locale.value')
  })
})

describe('US-005: LanguageSwitcher.vue has no console.log statements', () => {
  test('source does not contain console.log', () => {
    const source = readFileSync(componentPath, 'utf-8')
    expect(source).not.toContain('console.log')
  })
})
