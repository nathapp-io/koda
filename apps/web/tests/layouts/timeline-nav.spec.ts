import { describe, test, expect } from '@jest/globals'
import { readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const layoutPath = join(webDir, 'layouts', 'default.vue')
const enLocalePath = join(webDir, 'i18n', 'locales', 'en.json')
const zhLocalePath = join(webDir, 'i18n', 'locales', 'zh.json')

// ─────────────────────────────────────────────────────────────────────────────
// Timeline AC9 — default layout exposes a /<slug>/timeline link in the
//                  project nav whose label resolves from `nav.timeline`
// ─────────────────────────────────────────────────────────────────────────────

describe('Timeline AC9: default layout has a /<slug>/timeline project nav link', () => {
  test('source contains a NuxtLink targeting /<slug>/timeline', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    expect(source).toMatch(/\/\$\{projectSlug\}\/timeline/)
  })

  test('source uses nav.timeline i18n key for the link label', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    expect(source).toMatch(/t\(['"]nav\.timeline['"]\)/)
  })

  test('source places the timeline link inside the project-scoped nav block', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    // Find the project-scoped block and confirm the timeline link is inside it
    const scopedStart = source.indexOf('projectSlug')
    const scopedEnd = source.indexOf('</template>', scopedStart)
    expect(scopedStart).toBeGreaterThan(-1)
    expect(scopedEnd).toBeGreaterThan(scopedStart)
    const scopedSection = source.slice(scopedStart, scopedEnd)
    expect(scopedSection).toMatch(/\/timeline/)
    expect(scopedSection).toMatch(/nav\.timeline/)
  })
})

describe('Timeline AC9: nav.timeline present in both en.json and zh.json', () => {
  test('en.json has nav.timeline as a non-empty string', () => {
    const en = JSON.parse(readFileSync(enLocalePath, 'utf-8'))
    expect(en.nav?.timeline).toBeDefined()
    expect(typeof en.nav.timeline).toBe('string')
    expect(en.nav.timeline.length).toBeGreaterThan(0)
  })

  test('zh.json has nav.timeline as a non-empty string', () => {
    const zh = JSON.parse(readFileSync(zhLocalePath, 'utf-8'))
    expect(zh.nav?.timeline).toBeDefined()
    expect(typeof zh.nav.timeline).toBe('string')
    expect(zh.nav.timeline.length).toBeGreaterThan(0)
  })
})
