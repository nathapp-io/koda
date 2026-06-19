import { describe, test, expect } from '@jest/globals'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const componentPath = join(webDir, 'components', 'KbVerdictBanner.vue')

function getSource(): string {
  return readFileSync(componentPath, 'utf-8')
}

describe('KbVerdictBanner.vue exists', () => {
  test('file is present at components/KbVerdictBanner.vue', () => {
    expect(existsSync(componentPath)).toBe(true)
  })
})

describe('KbVerdictBanner: required props', () => {
  test('source defines a verdict prop', () => {
    const source = getSource()
    expect(source).toContain('verdict')
    expect(source).toMatch(/defineProps/)
  })

  test('verdict prop accepts likely_duplicate, possibly_related, no_match, and null', () => {
    const source = getSource()
    expect(source).toContain('likely_duplicate')
    expect(source).toContain('possibly_related')
    expect(source).toContain('no_match')
    expect(source).toMatch(/null/)
  })

  test('source defines an optional bestMatch prop', () => {
    const source = getSource()
    expect(source).toContain('bestMatch')
    expect(source).toMatch(/bestMatch\?/)
  })
})

describe('KbVerdictBanner: uses i18n', () => {
  test('source calls useI18n()', () => {
    const source = getSource()
    expect(source).toContain('useI18n()')
  })

  test('source uses t() for translating verdict labels', () => {
    const source = getSource()
    expect(source).toMatch(/t\s*\(\s*['"]kb\.verdict/)
  })
})

describe('KbVerdictBanner: verdict config computation', () => {
  test('source computes verdictConfig based on verdict prop', () => {
    const source = getSource()
    expect(source).toContain('verdictConfig')
    expect(source).toContain('computed')
  })

  test('verdictConfig uses a switch statement on verdict', () => {
    const source = getSource()
    expect(source).toContain('switch')
    expect(source).toContain('verdict')
  })

  test('source handles likely_duplicate case', () => {
    const source = getSource()
    expect(source).toContain("case 'likely_duplicate'")
  })

  test('source handles possibly_related case', () => {
    const source = getSource()
    expect(source).toContain("case 'possibly_related'")
  })

  test('source handles no_match case', () => {
    const source = getSource()
    expect(source).toContain("case 'no_match'")
  })

  test('default case returns null for unknown verdict', () => {
    const source = getSource()
    expect(source).toContain('default:')
    expect(source).toContain('return null')
  })
})

describe('KbVerdictBanner: conditional rendering', () => {
  test('source renders nothing when verdictConfig is null (uses v-if)', () => {
    const source = getSource()
    expect(source).toContain('v-if="verdictConfig"')
  })
})

describe('KbVerdictBanner: bestMatch display', () => {
  test('source uses bestMatch prop when provided for description', () => {
    const source = getSource()
    expect(source).toContain('bestMatch')
  })

  test('source uses kb.verdict.bestMatch i18n key when bestMatch is provided for likely_duplicate', () => {
    const source = getSource()
    expect(source).toContain('kb.verdict.bestMatch')
  })

  test('source uses kb.verdict.closestMatch i18n key when bestMatch is provided for possibly_related', () => {
    const source = getSource()
    expect(source).toContain('kb.verdict.closestMatch')
  })
})

describe('KbVerdictBanner: no console.log', () => {
  test('source does not contain console.log', () => {
    const source = getSource()
    expect(source).not.toContain('console.log')
  })
})
