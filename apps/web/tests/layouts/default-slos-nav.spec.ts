import { describe, test, expect } from '@jest/globals'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const layoutPath = join(webDir, 'layouts', 'default.vue')
const enJsonPath = join(webDir, 'i18n', 'locales', 'en.json')
const zhJsonPath = join(webDir, 'i18n', 'locales', 'zh.json')

// ─────────────────────────────────────────────────────────────────────────────
// AC7 — The default layout renders a top-level navigation link to /admin/slos
//       whose label resolves from nav.slos.
// ─────────────────────────────────────────────────────────────────────────────

describe('US-006 AC7: default layout contains a top-level link to /admin/slos with nav.slos label', () => {
  test('layouts/default.vue exists', () => {
    expect(existsSync(layoutPath)).toBe(true)
  })

  test('layouts/default.vue source contains a NuxtLink with to="/admin/slos"', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    expect(source).toMatch(/to=["']\/admin\/slos["']/)
  })

  test('layouts/default.vue source renders the SLO link label via t("nav.slos")', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    expect(source).toContain("t('nav.slos')")
  })

  test('the SLO link is rendered at the top level (not inside the projectSlug-only template)', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    // Find the project-scoped template block and the SLO link location.
    const projectScopeStart = source.indexOf('v-if="projectSlug"')
    const slosLinkIndex = source.indexOf('to="/admin/slos"')
    // The SLO link must appear BEFORE the project-scoped template so it is
    // visible to all authenticated users (matching /agents).
    expect(projectScopeStart).toBeGreaterThan(-1)
    expect(slosLinkIndex).toBeGreaterThan(-1)
    expect(slosLinkIndex).toBeLessThan(projectScopeStart)
  })
})

describe('US-006 AC7: i18n provides nav.slos for both locales', () => {
  test('en.json contains a non-empty nav.slos entry', () => {
    const en = JSON.parse(readFileSync(enJsonPath, 'utf-8')) as {
      nav?: Record<string, string>
    }
    const slos = en.nav?.slos
    expect(typeof slos).toBe('string')
    expect(slos?.length).toBeGreaterThan(0)
  })

  test('zh.json contains a non-empty nav.slos entry', () => {
    const zh = JSON.parse(readFileSync(zhJsonPath, 'utf-8')) as {
      nav?: Record<string, string>
    }
    const slos = zh.nav?.slos
    expect(typeof slos).toBe('string')
    expect(slos?.length).toBeGreaterThan(0)
  })
})
