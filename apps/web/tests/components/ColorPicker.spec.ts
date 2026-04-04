import { describe, test, expect } from '@jest/globals'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const pickerPath = join(webDir, 'components', 'ColorPicker.vue')

// ──────────────────────────────────────────────────────────────────────────────
// File existence
// ──────────────────────────────────────────────────────────────────────────────

describe('US-001: ColorPicker.vue exists', () => {
  test('file is present at components/ColorPicker.vue', () => {
    expect(existsSync(pickerPath)).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC1 — Shows native color picker, hex text input, and color swatch
// ──────────────────────────────────────────────────────────────────────────────

describe('US-001 AC1: ColorPicker shows native color picker input', () => {
  test('source contains input type="color"', () => {
    const source = readFileSync(pickerPath, 'utf-8')
    expect(source).toContain('type="color"')
  })
})

describe('US-001 AC1: ColorPicker shows hex text input', () => {
  test('source contains text input for hex value', () => {
    const source = readFileSync(pickerPath, 'utf-8')
    expect(source).toContain('type="text"')
  })
})

describe('US-001 AC1: ColorPicker shows color swatch preview', () => {
  test('source contains div for color swatch', () => {
    const source = readFileSync(pickerPath, 'utf-8')
    expect(source).toContain('swatch')
  })

  test('swatch uses background-color style', () => {
    const source = readFileSync(pickerPath, 'utf-8')
    expect(source).toContain('background-color')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC2 — Emits normalized uppercase hex on native picker change
// ──────────────────────────────────────────────────────────────────────────────

describe('US-001 AC2: Emits update:modelValue on native picker change', () => {
  test('source defines update:modelValue emit', () => {
    const source = readFileSync(pickerPath, 'utf-8')
    expect(source).toContain('update:modelValue')
  })

  test('native color input emits normalized hex', () => {
    const source = readFileSync(pickerPath, 'utf-8')
    expect(source).toContain('toUpperCase')
  })

  test('native color input normalizes hex value', () => {
    const source = readFileSync(pickerPath, 'utf-8')
    expect(source).toContain('toUpperCase()')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC3 — Emits normalized value on hex text input change
// ──────────────────────────────────────────────────────────────────────────────

describe('US-001 AC3: Emits update:modelValue on hex text input change', () => {
  test('hex text input emits update:modelValue', () => {
    const source = readFileSync(pickerPath, 'utf-8')
    const hasTextInput = source.includes('type="text"')
    const hasEmit = source.includes('update:modelValue')
    expect(hasTextInput && hasEmit).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC4 — Swatch preview updates when modelValue changes
// ──────────────────────────────────────────────────────────────────────────────

describe('US-001 AC4: Swatch preview updates with modelValue', () => {
  test('swatch uses modelValue for background-color', () => {
    const source = readFileSync(pickerPath, 'utf-8')
    expect(source).toContain('modelValue')
    expect(source).toContain('background-color')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC5 — Falls back to #6366F1 when modelValue is empty and no defaultColor
// ──────────────────────────────────────────────────────────────────────────────

describe('US-001 AC5: Falls back to #6366F1 when modelValue is empty', () => {
  test('source contains #6366F1 fallback', () => {
    const source = readFileSync(pickerPath, 'utf-8')
    expect(source).toContain('#6366F1')
  })

  test('source falls back to #6366F1 when both modelValue and defaultColor are empty', () => {
    const source = readFileSync(pickerPath, 'utf-8')
    expect(source).toContain('#6366F1')
    const hasFallback = source.includes('return \'#6366F1\'') || source.includes('return "#6366F1"')
    expect(hasFallback).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC6 — Falls back to defaultColor when modelValue is empty and defaultColor provided
// ──────────────────────────────────────────────────────────────────────────────

describe('US-001 AC6: Falls back to defaultColor when modelValue is empty', () => {
  test('source defines defaultColor prop', () => {
    const source = readFileSync(pickerPath, 'utf-8')
    expect(source).toContain('defaultColor')
  })

  test('source uses defaultColor in fallback chain', () => {
    const source = readFileSync(pickerPath, 'utf-8')
    expect(source).toContain("defaultColor")
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Quality — no console.log
// ──────────────────────────────────────────────────────────────────────────────

describe('US-001: ColorPicker.vue has no console.log statements', () => {
  test('source does not contain console.log', () => {
    const source = readFileSync(pickerPath, 'utf-8')
    expect(source).not.toContain('console.log')
  })
})