import { describe, test, expect } from '@jest/globals'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const switcherPath = join(webDir, 'components', 'LanguageSwitcher.vue')

// ──────────────────────────────────────────────────────────────────────────────
// File existence
// ──────────────────────────────────────────────────────────────────────────────

describe('US-005: LanguageSwitcher.vue exists', () => {
  test('file is present at components/LanguageSwitcher.vue', () => {
    expect(existsSync(switcherPath)).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC1 — Active locale button receives correct classes
// ──────────────────────────────────────────────────────────────────────────────

describe('US-005 AC1: Active locale button receives bg-primary class', () => {
  test('source uses locale in toggle button class condition', () => {
    const source = readFileSync(switcherPath, 'utf-8')
    // In Vue templates, refs are auto-unwrapped — locale (not locale.value) is correct
    expect(source).toContain('locale === loc.code')
  })

  test('source applies bg-primary class when locale matches', () => {
    const source = readFileSync(switcherPath, 'utf-8')
    expect(source).toContain('bg-primary')
  })

  test('source applies text-primary-foreground class when locale matches', () => {
    const source = readFileSync(switcherPath, 'utf-8')
    expect(source).toContain('text-primary-foreground')
  })

  test('source applies font-medium class when locale matches', () => {
    const source = readFileSync(switcherPath, 'utf-8')
    expect(source).toContain('font-medium')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC2 — Inactive locale button receives correct classes
// ──────────────────────────────────────────────────────────────────────────────

describe('US-005 AC2: Inactive locale button receives muted classes', () => {
  test('source applies text-muted-foreground class when locale does not match', () => {
    const source = readFileSync(switcherPath, 'utf-8')
    expect(source).toContain('text-muted-foreground')
  })

  test('source applies hover:text-foreground class for hover state', () => {
    const source = readFileSync(switcherPath, 'utf-8')
    expect(source).toContain('hover:text-foreground')
  })

  test('source applies hover:bg-muted class for hover state', () => {
    const source = readFileSync(switcherPath, 'utf-8')
    expect(source).toContain('hover:bg-muted')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC3 — Select component receives string value, not Ref object
// ──────────────────────────────────────────────────────────────────────────────

describe('US-005 AC3: Select component model-value is a string', () => {
  test('source uses locale for Select model-value', () => {
    const source = readFileSync(switcherPath, 'utf-8')
    // In Vue templates, refs are auto-unwrapped — :model-value="locale" passes the string, not the Ref
    const hasSelectWithLocale = source.includes(':model-value="locale"')
    expect(hasSelectWithLocale).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC4 — switchLocale function receives and passes string code
// ──────────────────────────────────────────────────────────────────────────────

describe('US-005 AC4: switchLocale receives string code parameter', () => {
  test('source calls switchLocale with loc.code (string)', () => {
    const source = readFileSync(switcherPath, 'utf-8')
    expect(source).toContain('switchLocale(loc.code)')
  })

  test('source defines switchLocale function with code parameter', () => {
    const source = readFileSync(switcherPath, 'utf-8')
    expect(source).toContain('function switchLocale(code: string)')
  })

  test('source passes code string to setLocale', () => {
    const source = readFileSync(switcherPath, 'utf-8')
    // Within switchLocale function body, must call setLocale(code)
    const switchBody = source.match(/function switchLocale\(code: string\)\s*{([^}]+)}/)
    expect(switchBody).toBeTruthy()
    expect(switchBody?.[1]).toContain('setLocale(code)')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Preservation — currentLocaleName and switchLocale unchanged
// ──────────────────────────────────────────────────────────────────────────────

describe('US-005: currentLocaleName computed is unchanged', () => {
  test('source uses locale.value in currentLocaleName computed', () => {
    const source = readFileSync(switcherPath, 'utf-8')
    expect(source).toContain('locale.value')
  })

  test('source has currentLocaleName computed that finds matching locale', () => {
    const source = readFileSync(switcherPath, 'utf-8')
    expect(source).toContain('currentLocaleName')
    expect(source).toContain('allLocales.value.find')
  })
})

describe('US-005: switchLocale function is unchanged', () => {
  test('source has switchLocale function', () => {
    const source = readFileSync(switcherPath, 'utf-8')
    expect(source).toContain('function switchLocale(code: string)')
  })

  test('switchLocale calls setLocale with code', () => {
    const source = readFileSync(switcherPath, 'utf-8')
    expect(source).toContain('setLocale(code)')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Quality — no console.log
// ──────────────────────────────────────────────────────────────────────────────

describe('US-005: LanguageSwitcher.vue has no console.log statements', () => {
  test('source does not contain console.log', () => {
    const source = readFileSync(switcherPath, 'utf-8')
    expect(source).not.toContain('console.log')
  })
})
