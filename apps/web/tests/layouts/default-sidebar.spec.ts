import { describe, test, expect } from '@jest/globals'
import { readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const layoutPath = join(webDir, 'layouts', 'default.vue')

// ──────────────────────────────────────────────────────────────────────────────
// AC9 — Agents navigation link added to sidebar under the current project context
// ──────────────────────────────────────────────────────────────────────────────

describe('US-006 AC9: Agents navigation link exists in layouts/default.vue sidebar', () => {
  test('source contains Agents navigation link text', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    expect(source).toContain("t('nav.agents')")
  })

  test('Agents link uses NuxtLink component', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    // Both NuxtLink and Agents must appear together
    expect(source).toContain('NuxtLink')
    expect(source).toContain("t('nav.agents')")
  })

  test('Agents link navigates to the agents page under project context', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    // The project block must link to the project roster, not only the global registry.
    const projectBlock = source.slice(source.indexOf('<template v-if="projectSlug">'))
    expect(projectBlock).toContain(':to="`/${projectSlug}/agents`"')
    // The global registry link is unchanged and stays outside the project block.
    expect(source.indexOf('<NuxtLink to="/agents"')).toBeLessThan(source.indexOf('<template v-if="projectSlug">'))
  })
})
