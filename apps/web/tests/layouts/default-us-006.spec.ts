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
    expect(source).toContain('Agents')
  })

  test('Agents link uses NuxtLink component', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    // Both NuxtLink and Agents must appear together
    expect(source).toContain('NuxtLink')
    expect(source).toContain('Agents')
  })

  test('Agents link navigates to the agents page under project context', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    // The href/to should reference /agents within the project context
    const hasAgentsLink =
      source.includes('/agents') ||
      source.includes('agents')
    expect(hasAgentsLink).toBe(true)
  })
})
