import { describe, expect, test } from '@jest/globals'
import { readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const source = readFileSync(join(webDir, 'components', 'PageHeader.vue'), 'utf-8')

describe('PageHeader icon slot', () => {
  test('renders an optional #icon slot before the title', () => {
    expect(source).toContain('<slot name="icon" />')
    expect(source.indexOf('<slot name="icon" />')).toBeGreaterThan(-1)
    expect(source.indexOf('<slot name="icon" />')).toBeLessThan(source.indexOf('<h1'))
  })

  test('icon sits in a bordered muted square', () => {
    expect(source).toContain('h-10 w-10')
    expect(source).toContain('rounded-md border border-border')
    expect(source).toContain('bg-muted/40')
  })

  test('title, subtitle and actions slots are unchanged', () => {
    expect(source).toContain('text-3xl font-bold tracking-tight')
    expect(source).toContain('v-if="subtitle"')
    expect(source).toContain('<slot name="actions" />')
  })
})
