import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '..')
const appPath = join(webDir, 'app.vue')

// ──────────────────────────────────────────────────────────────────────────────
// AC8 — app.vue updated to not duplicate navigation
//        (renders NuxtPage inside NuxtLayout)
// ──────────────────────────────────────────────────────────────────────────────

describe('US-002 AC8: app.vue uses NuxtLayout to delegate navigation', () => {
  test('source contains <NuxtLayout> wrapper component', () => {
    const source = readFileSync(appPath, 'utf-8')
    expect(source).toContain('NuxtLayout')
  })

  test('source contains <NuxtPage /> inside NuxtLayout', () => {
    const source = readFileSync(appPath, 'utf-8')
    expect(source).toContain('NuxtPage')
  })

  test('NuxtPage is nested inside NuxtLayout in the template', () => {
    const source = readFileSync(appPath, 'utf-8')
    const nuxtLayoutIndex = source.indexOf('NuxtLayout')
    const nuxtPageIndex = source.indexOf('NuxtPage')
    // NuxtLayout must appear before NuxtPage (NuxtPage is nested inside)
    expect(nuxtLayoutIndex).toBeGreaterThanOrEqual(0)
    expect(nuxtPageIndex).toBeGreaterThan(nuxtLayoutIndex)
  })
})

describe('US-002 AC8: app.vue does not duplicate navigation from layout', () => {
  test('source does not contain inline <nav> element (navigation belongs to layout)', () => {
    const source = readFileSync(appPath, 'utf-8')
    expect(source).not.toMatch(/<nav[\s>]/)
  })

  test('source does not contain duplicate Dashboard or Projects nav links', () => {
    const source = readFileSync(appPath, 'utf-8')
    // app.vue should not contain inline nav links — those live in layouts/default.vue
    expect(source).not.toMatch(/NuxtLink[^>]*to=.*["']\/["'].*Projects/)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC9 & AC10 — bun run lint and type-check scripts are defined
// ──────────────────────────────────────────────────────────────────────────────

describe('US-002 AC9: bun run lint script is defined', () => {
  test('lint script is defined in package.json', () => {
    const packageJsonPath = join(webDir, 'package.json')
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'))
    expect(packageJson.scripts).toHaveProperty('lint')
  })
})

describe('US-002 AC10: bun run type-check script is defined', () => {
  test('type-check script is defined in package.json', () => {
    const packageJsonPath = join(webDir, 'package.json')
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'))
    expect(packageJson.scripts).toHaveProperty('type-check')
  })
})
