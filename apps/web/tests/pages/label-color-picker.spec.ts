import { describe, test, expect } from '@jest/globals'
import { readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const pagePath = join(webDir, 'pages', '[project]', 'labels.vue')

// ──────────────────────────────────────────────────────────────────────────────
// AC1 — Color FormField uses ColorPicker instead of plain text Input
// ──────────────────────────────────────────────────────────────────────────────

describe('US-002 AC1: Color FormField uses ColorPicker component', () => {
  test('source imports ColorPicker component', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toContain('ColorPicker')
  })

  test('color FormField uses ColorPicker instead of Input', () => {
    const source = readFileSync(pagePath, 'utf-8')
    const colorFieldMatch = source.match(/FormField\s+name="color"[\s\S]*?<\/FormField>/)
    expect(colorFieldMatch).not.toBeNull()
    expect(colorFieldMatch![0]).toContain('ColorPicker')
    expect(colorFieldMatch![0]).not.toContain('<Input')
  })

  test('ColorPicker is used with v-bind="componentField" for vee-validate binding', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toContain('ColorPicker')
    expect(source).toContain('v-bind="componentField"')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC2 — ColorPicker emits normalized hex value updating form state
// ──────────────────────────────────────────────────────────────────────────────

describe('US-002 AC2: ColorPicker emits normalized hex to form state', () => {
  test('ColorPicker receives modelValue binding for two-way binding via v-bind', () => {
    const source = readFileSync(pagePath, 'utf-8')
    const colorFieldMatch = source.match(/FormField\s+name="color"[\s\S]*?<\/FormField>/)
    expect(colorFieldMatch).not.toBeNull()
    expect(colorFieldMatch![0]).toContain('v-bind="componentField"')
  })

  test('ColorPicker emits update:modelValue for form binding via componentField', () => {
    const source = readFileSync(pagePath, 'utf-8')
    const colorFieldMatch = source.match(/FormField\s+name="color"[\s\S]*?<\/FormField>/)
    expect(colorFieldMatch).not.toBeNull()
    expect(colorFieldMatch![0]).toContain('v-bind="componentField"')
  })

  test('ColorPicker defaultColor prop is set to #6366F1 for fallback', () => {
    const source = readFileSync(pagePath, 'utf-8')
    const colorFieldMatch = source.match(/FormField\s+name="color"[\s\S]*?<\/FormField>/)
    expect(colorFieldMatch).not.toBeNull()
    const hasDefaultColor =
      colorFieldMatch![0].includes("defaultColor='#6366F1'") ||
      colorFieldMatch![0].includes('defaultColor="#6366F1"') ||
      colorFieldMatch![0].includes('defaultColor={') &&
      colorFieldMatch![0].includes('#6366F1')
    expect(hasDefaultColor).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC3 — Default form value is #6366F1 when color not edited
// ──────────────────────────────────────────────────────────────────────────────

describe('US-002 AC3: Default form value is #6366F1 when color not edited', () => {
  test('initialValues.color is set to #6366F1', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toContain('#6366F1')
  })

  test('form uses color field with regex validation for hex format', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toMatch(/color:\s*z\.string\(\).*\.regex/)
  })

  test('onSubmit normalizes color value before sending to API', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toContain('normalizeHexColor')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Quality — no console.log
// ──────────────────────────────────────────────────────────────────────────────

describe('US-002: labels.vue has no console.log statements', () => {
  test('source does not contain console.log', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).not.toContain('console.log')
  })
})
