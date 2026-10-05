import { describe, expect, it } from '@jest/globals'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const css = readFileSync(join(__dirname, '../..', 'assets', 'css', 'globals.css'), 'utf-8')
const darkAt = css.indexOf('.dark {')
const light = css.slice(0, darkAt)
const dark = css.slice(darkAt)

describe('chart tokens (D390)', () => {
  it('defines all 8 categorical slots and other in light and dark', () => {
    for (const name of ['1', '2', '3', '4', '5', '6', '7', '8', 'other']) {
      expect(light).toMatch(new RegExp(`--chart-${name}: #[0-9a-f]{6};`))
      expect(dark).toMatch(new RegExp(`--chart-${name}: #[0-9a-f]{6};`))
    }
  })

  it('uses the dataviz reference steps in their fixed order', () => {
    expect(light).toContain('--chart-1: #2a78d6;')
    expect(light).toContain('--chart-8: #e34948;')
    expect(dark).toContain('--chart-1: #3987e5;')
    expect(dark).toContain('--chart-7: #9085e9;')
  })

  it('themes unovis axes and tooltips from the app tokens', () => {
    expect(light).toContain('--vis-axis-tick-label-color: hsl(var(--muted-foreground));')
    expect(light).toContain('--vis-tooltip-background-color: hsl(var(--popover));')
  })
})
