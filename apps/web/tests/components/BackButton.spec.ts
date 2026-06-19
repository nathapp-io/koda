import { describe, test, expect } from '@jest/globals'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const componentPath = join(webDir, 'components', 'BackButton.vue')

function getSource(): string {
  return readFileSync(componentPath, 'utf-8')
}

describe('BackButton.vue exists', () => {
  test('file is present at components/BackButton.vue', () => {
    expect(existsSync(componentPath)).toBe(true)
  })
})

describe('BackButton: receives required to prop', () => {
  test('source defines a "to" prop', () => {
    const source = getSource()
    expect(source).toContain('to')
    expect(source).toMatch(/defineProps/)
  })

  test('to prop is typed as string', () => {
    const source = getSource()
    expect(source).toMatch(/to\s*:\s*string/)
  })
})

describe('BackButton: renders a navigation link', () => {
  test('source uses NuxtLink for navigation', () => {
    const source = getSource()
    expect(source).toContain('NuxtLink')
  })

  test('NuxtLink binds to prop', () => {
    const source = getSource()
    expect(source).toMatch(/:to="to"/)
  })
})

describe('BackButton: renders a back icon', () => {
  test('source imports ArrowLeft icon from lucide-vue-next', () => {
    const source = getSource()
    expect(source).toContain('ArrowLeft')
    expect(source).toContain('lucide-vue-next')
  })

  test('source renders ArrowLeft in the template', () => {
    const source = getSource()
    expect(source).toContain('<ArrowLeft')
  })
})

describe('BackButton: uses a ghost icon Button', () => {
  test('source renders Button with ghost variant', () => {
    const source = getSource()
    expect(source).toContain('Button')
    expect(source).toContain('ghost')
  })

  test('source uses size="icon" on Button', () => {
    const source = getSource()
    expect(source).toContain('size="icon"')
  })
})

describe('BackButton: no console.log', () => {
  test('source does not contain console.log', () => {
    const source = getSource()
    expect(source).not.toContain('console.log')
  })
})
