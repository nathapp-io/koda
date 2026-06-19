import { describe, test, expect } from '@jest/globals'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const componentPath = join(webDir, 'components', 'EmptyState.vue')

function getSource(): string {
  return readFileSync(componentPath, 'utf-8')
}

describe('EmptyState.vue exists', () => {
  test('file is present at components/EmptyState.vue', () => {
    expect(existsSync(componentPath)).toBe(true)
  })
})

describe('EmptyState: required message prop', () => {
  test('source defines a message prop', () => {
    const source = getSource()
    expect(source).toContain('message')
    expect(source).toMatch(/defineProps/)
  })

  test('message prop is typed as string', () => {
    const source = getSource()
    expect(source).toMatch(/message\s*:\s*string/)
  })

  test('source renders message in the template', () => {
    const source = getSource()
    expect(source).toContain('{{ message }}')
  })
})

describe('EmptyState: optional icon prop', () => {
  test('source defines an optional icon prop', () => {
    const source = getSource()
    expect(source).toContain('icon')
    expect(source).toContain('Component')
  })

  test('icon prop uses optional marker', () => {
    const source = getSource()
    expect(source).toMatch(/icon\?/)
  })

  test('source falls back to Inbox icon when none provided', () => {
    const source = getSource()
    expect(source).toContain('Inbox')
    expect(source).toContain('lucide-vue-next')
  })

  test('source computes iconComponent with fallback to Inbox', () => {
    const source = getSource()
    expect(source).toContain('iconComponent')
    expect(source).toContain('computed')
  })
})

describe('EmptyState: renders dynamic icon', () => {
  test('source uses dynamic component for the icon', () => {
    const source = getSource()
    expect(source).toContain('<component')
    expect(source).toContain(':is="iconComponent"')
  })
})

describe('EmptyState: has an action slot', () => {
  test('source defines a named action slot', () => {
    const source = getSource()
    expect(source).toContain('slot')
    expect(source).toContain('action')
  })
})

describe('EmptyState: no console.log', () => {
  test('source does not contain console.log', () => {
    const source = getSource()
    expect(source).not.toContain('console.log')
  })
})
