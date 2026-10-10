import { describe, test, expect } from '@jest/globals'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const palettePath = join(webDir, 'components', 'CommandPalette.vue')

describe('CommandPalette: project agents entry (issue #252)', () => {
  test('exists and offers the project roster as a command', () => {
    expect(existsSync(palettePath)).toBe(true)
    const source = readFileSync(palettePath, 'utf-8')
    expect(source).toContain("{ id: 'project-agents', label: t('nav.agents'), hint, icon: Bot, run: go(`/${slug}/agents`) }")
  })

  test('the entry is inside the project-scoped block, so it needs a project slug', () => {
    const source = readFileSync(palettePath, 'utf-8')
    const projectBlock = source.slice(source.indexOf('if (slug) {'), source.indexOf('for (const p of projects.value)'))
    expect(projectBlock).toContain("id: 'project-agents'")
  })

  test('the global registry command still points at /agents', () => {
    const source = readFileSync(palettePath, 'utf-8')
    expect(source).toContain("{ id: 'agents', label: t('nav.agents'), icon: Bot, run: go('/agents') }")
  })
})
