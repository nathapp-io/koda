import { describe, test, expect } from '@jest/globals'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const barPath = join(webDir, 'components', 'FilterBar.vue')

describe('FilterBar (slice 3 shared pattern)', () => {
  test('exists and keeps the filter grid classes literal for the Tailwind JIT', () => {
    expect(existsSync(barPath)).toBe(true)
    const source = readFileSync(barPath, 'utf-8')
    expect(source).toContain('grid gap-3 sm:grid-cols-4')
    expect(source).not.toMatch(/grid-cols-\$\{/) // dynamic classes never reach the JIT
  })

  test('the fleet jobs list uses it for its four filters', () => {
    const page = readFileSync(join(webDir, 'pages', '[project]', 'fleet', 'index.vue'), 'utf-8')
    expect(page).toContain('<FilterBar>')
    expect(page).toContain('</FilterBar>')
  })
})
