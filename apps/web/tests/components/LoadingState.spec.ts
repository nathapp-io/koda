import { describe, test, expect } from '@jest/globals'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const componentPath = join(webDir, 'components', 'LoadingState.vue')

function getSource(): string {
  return readFileSync(componentPath, 'utf-8')
}

describe('LoadingState.vue exists', () => {
  test('file is present at components/LoadingState.vue', () => {
    expect(existsSync(componentPath)).toBe(true)
  })
})

describe('LoadingState: uses i18n', () => {
  test('source calls useI18n()', () => {
    const source = getSource()
    expect(source).toContain('useI18n()')
  })

  test('source uses t() function for translation', () => {
    const source = getSource()
    expect(source).toMatch(/\bt\s*\(/)
  })
})

describe('LoadingState: renders a spinning icon', () => {
  test('source imports Loader2 from lucide-vue-next', () => {
    const source = getSource()
    expect(source).toContain('Loader2')
    expect(source).toContain('lucide-vue-next')
  })

  test('source renders Loader2 in the template', () => {
    const source = getSource()
    expect(source).toContain('<Loader2')
  })

  test('source applies animate-spin class to the spinner', () => {
    const source = getSource()
    expect(source).toContain('animate-spin')
  })
})

describe('LoadingState: displays loading text', () => {
  test('source references common.loading i18n key', () => {
    const source = getSource()
    expect(source).toContain('common.loading')
  })
})

describe('LoadingState: no console.log', () => {
  test('source does not contain console.log', () => {
    const source = getSource()
    expect(source).not.toContain('console.log')
  })
})
