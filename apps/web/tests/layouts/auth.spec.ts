import { describe, test, expect } from '@jest/globals'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const layoutPath = join(webDir, 'layouts', 'auth.vue')

// ──────────────────────────────────────────────────────────────────────────────
// AC1 — layouts/auth.vue created with centered card layout using Shadcn Card
// ──────────────────────────────────────────────────────────────────────────────

describe('AC1: layouts/auth.vue exists', () => {
  test('file is present at layouts/auth.vue', () => {
    expect(existsSync(layoutPath)).toBe(true)
  })
})

describe('AC1: layouts/auth.vue uses Shadcn Card component', () => {
  test('source imports or uses the Card component', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    expect(source).toContain('Card')
  })

  test('source contains <Card or <card element', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    expect(source).toMatch(/<[Cc]ard[\s>]/)
  })
})

describe('AC1: layouts/auth.vue has centered layout', () => {
  test('source contains centering utility classes (flex items-center justify-center or equivalent)', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    // Must have some form of centering — flex+justify-center, grid+place-items-center, or margin auto
    const hasCenteredFlex = source.includes('justify-center') && source.includes('items-center')
    const hasGridCenter = source.includes('place-items-center')
    const hasMarginAuto = source.includes('mx-auto')
    expect(hasCenteredFlex || hasGridCenter || hasMarginAuto).toBe(true)
  })

  test('source contains min-h-screen or full-height class for vertical centering', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    expect(source).toMatch(/min-h-screen|h-screen|h-full/)
  })
})

describe('AC1: layouts/auth.vue renders slot for page content', () => {
  test('source contains <slot /> or <slot/>', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    expect(source).toMatch(/<slot\s*\/>|<slot><\/slot>/)
  })
})

describe('AC1: layouts/auth.vue has no console.log statements', () => {
  test('source does not contain console.log', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    expect(source).not.toContain('console.log')
  })
})
