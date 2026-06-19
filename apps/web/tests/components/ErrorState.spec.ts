import { describe, test, expect } from '@jest/globals'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const componentPath = join(webDir, 'components', 'ErrorState.vue')

function getSource(): string {
  return readFileSync(componentPath, 'utf-8')
}

describe('ErrorState.vue exists', () => {
  test('file is present at components/ErrorState.vue', () => {
    expect(existsSync(componentPath)).toBe(true)
  })
})

describe('ErrorState: uses i18n', () => {
  test('source calls useI18n()', () => {
    const source = getSource()
    expect(source).toContain('useI18n()')
  })

  test('source uses t() for translation', () => {
    const source = getSource()
    expect(source).toMatch(/\bt\s*\(/)
  })
})

describe('ErrorState: shows an error icon', () => {
  test('source imports AlertCircle from lucide-vue-next', () => {
    const source = getSource()
    expect(source).toContain('AlertCircle')
    expect(source).toContain('lucide-vue-next')
  })

  test('source renders AlertCircle in the template', () => {
    const source = getSource()
    expect(source).toContain('<AlertCircle')
  })
})

describe('ErrorState: emits retry event', () => {
  test('source defines a retry emit', () => {
    const source = getSource()
    expect(source).toContain('defineEmits')
    expect(source).toContain('retry')
  })

  test('source emits retry on button click', () => {
    const source = getSource()
    expect(source).toMatch(/emit\s*\(\s*['"]retry['"]/)
  })
})

describe('ErrorState: has a retry button', () => {
  test('source renders a Button component', () => {
    const source = getSource()
    expect(source).toContain('Button')
  })

  test('button click triggers emit retry', () => {
    const source = getSource()
    expect(source).toContain('@click')
    expect(source).toContain('retry')
  })
})

describe('ErrorState: displays error message', () => {
  test('source shows loadFailed i18n key', () => {
    const source = getSource()
    expect(source).toContain('loadFailed')
  })

  test('source shows retry i18n key', () => {
    const source = getSource()
    expect(source).toContain('retry')
  })
})

describe('ErrorState: no console.log', () => {
  test('source does not contain console.log', () => {
    const source = getSource()
    expect(source).not.toContain('console.log')
  })
})
