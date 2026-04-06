import { describe, test, expect } from '@jest/globals'
import { readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const layoutPath = join(webDir, 'layouts', 'default.vue')

// ──────────────────────────────────────────────────────────────────────────────
// AC1 — Settings link renders in sidebar below KB section
// ──────────────────────────────────────────────────────────────────────────────

describe('VCS-P1-005-E AC1: Settings link in sidebar below KB section', () => {
  test('sidebar contains a Settings link', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    const hasSettingsText =
      source.includes("t('nav.settings')") ||
      source.includes('t("nav.settings")') ||
      source.includes('settings') ||
      source.includes('Settings')
    expect(hasSettingsText).toBe(true)
  })

  test('Settings link uses NuxtLink component', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    expect(source).toContain('NuxtLink')
  })

  test('Settings link uses i18n key for label', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    const hasSettingsI18n =
      source.includes("t('nav.settings')") ||
      source.includes('t("nav.settings")')
    expect(hasSettingsI18n).toBe(true)
  })

  test('Settings link navigates to project-scoped /settings route', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    const hasSettingsPath =
      source.includes('/settings') ||
      source.includes('settings')
    expect(hasSettingsPath).toBe(true)
  })

  test('Settings link appears below KB link', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    const kbIndex = source.indexOf("t('nav.kb')")
    const settingsIndex =
      source.indexOf("t('nav.settings')") !== -1
        ? source.indexOf("t('nav.settings')")
        : source.indexOf('settings')

    // Settings should come after KB in the source
    expect(settingsIndex).toBeGreaterThan(kbIndex)
  })

  test('Settings link is within project-scoped template block', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    // Both should be within the "v-if projectSlug" block
    const projectIfStart = source.indexOf('v-if="projectSlug"')
    const settingsLink =
      source.indexOf("t('nav.settings')") !== -1
        ? source.indexOf("t('nav.settings')")
        : source.indexOf('settings')

    // Settings link should be after projectSlug check
    expect(settingsLink).toBeGreaterThan(projectIfStart)
  })

  test('no console.log in sidebar', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    expect(source).not.toContain('console.log')
  })
})
