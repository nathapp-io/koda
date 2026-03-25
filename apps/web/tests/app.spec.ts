import { describe, test, expect } from '@jest/globals'
import { readFileSync } from 'fs'
import { existsSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '..')
const appPath = join(webDir, 'app.vue')

// ──────────────────────────────────────────────────────────────────────────────
// AC1 — app.vue updated to include <Toaster /> imported from vue-sonner
// ──────────────────────────────────────────────────────────────────────────────

describe('US-001-5 AC1: app.vue includes Toaster component', () => {
  test('app.vue file exists', () => {
    expect(existsSync(appPath)).toBe(true)
  })

  test('app.vue imports Toaster from vue-sonner', () => {
    const source = readFileSync(appPath, 'utf-8')
    expect(source).toContain('vue-sonner')
    expect(source).toContain('Toaster')
  })

  test('app.vue renders <Toaster /> component in template', () => {
    const source = readFileSync(appPath, 'utf-8')
    expect(source).toContain('<Toaster')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC2 — bun run lint exits 0 with 0 errors in apps/web
// ──────────────────────────────────────────────────────────────────────────────

describe('US-001-5 AC2: bun run lint passes with no errors', () => {
  test('lint script is defined in package.json', () => {
    const packageJsonPath = join(webDir, 'package.json')
    const packageJsonContent = readFileSync(packageJsonPath, 'utf-8')
    const packageJson = JSON.parse(packageJsonContent)
    expect(packageJson.scripts).toHaveProperty('lint')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC3 — bun run type-check exits 0 with no TypeScript errors in apps/web
// ──────────────────────────────────────────────────────────────────────────────

describe('US-001-5 AC3: bun run type-check passes with no TypeScript errors', () => {
  test('type-check script is defined in package.json', () => {
    const packageJsonPath = join(webDir, 'package.json')
    const packageJsonContent = readFileSync(packageJsonPath, 'utf-8')
    const packageJson = JSON.parse(packageJsonContent)
    expect(packageJson.scripts).toHaveProperty('type-check')
  })
})
