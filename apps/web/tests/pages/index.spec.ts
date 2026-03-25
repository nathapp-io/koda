import { describe, test, expect } from '@jest/globals'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const indexPath = join(webDir, 'pages', 'index.vue')

// ──────────────────────────────────────────────────────────────────────────────
// AC7 — pages/index.vue updated with definePageMeta({ layout: 'default' })
// ──────────────────────────────────────────────────────────────────────────────

describe('US-002 AC7: pages/index.vue exists', () => {
  test('file is present at pages/index.vue', () => {
    expect(existsSync(indexPath)).toBe(true)
  })
})

describe('US-002 AC7: pages/index.vue uses definePageMeta with default layout', () => {
  test('source contains definePageMeta call', () => {
    const source = readFileSync(indexPath, 'utf-8')
    expect(source).toContain('definePageMeta')
  })

  test("definePageMeta sets layout to 'default'", () => {
    const source = readFileSync(indexPath, 'utf-8')
    expect(source).toMatch(/definePageMeta\s*\(\s*\{[^}]*layout\s*:\s*['"]default['"]/)
  })
})

describe('US-002 AC7: pages/index.vue has no console.log statements', () => {
  test('source does not contain console.log', () => {
    const source = readFileSync(indexPath, 'utf-8')
    expect(source).not.toContain('console.log')
  })
})
