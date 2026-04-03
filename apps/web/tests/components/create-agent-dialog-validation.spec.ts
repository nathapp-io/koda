import { describe, test, expect } from '@jest/globals'
import { readFileSync } from 'fs'
import { existsSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const componentPath = join(webDir, 'components', 'CreateAgentDialog.vue')

// ──────────────────────────────────────────────────────────────────────────────
// AC1 — CreateAgentDialog.vue uses vee-validate with toTypedSchema(z.object)
// ──────────────────────────────────────────────────────────────────────────────

describe('US-002-1 AC1: CreateAgentDialog.vue uses vee-validate with toTypedSchema(z.object) for form validation', () => {
  test('CreateAgentDialog.vue exists in components directory', () => {
    expect(existsSync(componentPath)).toBe(true)
  })

  test('source imports useForm from vee-validate', () => {
    const source = readFileSync(componentPath, 'utf-8')
    expect(source).toContain("import { useForm } from 'vee-validate'")
  })

  test('source imports toTypedSchema from @vee-validate/zod', () => {
    const source = readFileSync(componentPath, 'utf-8')
    expect(source).toContain("import { toTypedSchema } from '@vee-validate/zod'")
  })

  test('source imports zod as * z', () => {
    const source = readFileSync(componentPath, 'utf-8')
    expect(source).toContain("import * as z from 'zod'")
  })

  test('source uses toTypedSchema(z.object(...)) for validation schema', () => {
    const source = readFileSync(componentPath, 'utf-8')
    expect(source).toMatch(/toTypedSchema\s*\(\s*z\.object\s*\(/)
  })

  test('source passes validationSchema to useForm', () => {
    const source = readFileSync(componentPath, 'utf-8')
    expect(source).toMatch(/useForm\s*\(\s*\{[^}]*validationSchema\s*:/)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC2 — name field is required
// ──────────────────────────────────────────────────────────────────────────────

describe('US-002-1 AC2: name field is required', () => {
  test('source contains FormField with name="name"', () => {
    const source = readFileSync(componentPath, 'utf-8')
    expect(source).toMatch(/FormField\s+name="name"/)
  })

  test('source defines name field in z.object schema with min(1) or non-optional', () => {
    const source = readFileSync(componentPath, 'utf-8')
    // Look for z.object with name field defined
    expect(source).toMatch(/name:\s*z\.string\(\)\.min\(1/)
  })

  test('source includes FormMessage for name field error display', () => {
    const source = readFileSync(componentPath, 'utf-8')
    // FormMessage should appear within the name FormField context
    const nameFieldMatch = source.match(/FormField\s+name="name"[\s\S]*?<\/FormField>/)
    expect(nameFieldMatch).not.toBeNull()
    expect(nameFieldMatch![0]).toContain('FormMessage')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC3 — slug field validates against pattern /^[a-z0-9-]+$/
// ──────────────────────────────────────────────────────────────────────────────

describe('US-002-1 AC3: slug field validates against pattern /^[a-z0-9-]+$/', () => {
  test('source contains FormField with name="slug"', () => {
    const source = readFileSync(componentPath, 'utf-8')
    expect(source).toMatch(/FormField\s+name="slug"/)
  })

  test('source defines slug field with regex pattern validation', () => {
    const source = readFileSync(componentPath, 'utf-8')
    // Should have .regex() with the lowercase alphanumeric dash pattern
    expect(source).toContain("regex(/^[a-z0-9-]+$/")
  })

  test('source includes FormMessage for slug field error display', () => {
    const source = readFileSync(componentPath, 'utf-8')
    const slugFieldMatch = source.match(/FormField\s+name="slug"[\s\S]*?<\/FormField>/)
    expect(slugFieldMatch).not.toBeNull()
    expect(slugFieldMatch![0]).toContain('FormMessage')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC4 — roles field requires at least one checkbox selected (VERIFIER, DEVELOPER, REVIEWER)
// ──────────────────────────────────────────────────────────────────────────────

describe('US-002-1 AC4: roles field requires at least one checkbox selected (VERIFIER, DEVELOPER, REVIEWER)', () => {
  test('source contains FormField with name="roles"', () => {
    const source = readFileSync(componentPath, 'utf-8')
    expect(source).toMatch(/FormField\s+name="roles"/)
  })

  test('source defines roles field with min(1) validation', () => {
    const source = readFileSync(componentPath, 'utf-8')
    // Roles should have a min validation to ensure at least one is selected
    expect(source).toContain('z.array(z.string()).min(1')
  })

  test('source contains checkboxes or inputs for VERIFIER, DEVELOPER, REVIEWER roles', () => {
    const source = readFileSync(componentPath, 'utf-8')
    expect(source).toContain('VERIFIER')
    expect(source).toContain('DEVELOPER')
    expect(source).toContain('REVIEWER')
  })

  test('source includes FormMessage for roles field error display', () => {
    const source = readFileSync(componentPath, 'utf-8')
    const rolesFieldMatch = source.match(/FormField\s+name="roles"[\s\S]*?<\/FormField>/)
    expect(rolesFieldMatch).not.toBeNull()
    expect(rolesFieldMatch![0]).toContain('FormMessage')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC5 — capabilities is an optional tag input field
// ──────────────────────────────────────────────────────────────────────────────

describe('US-002-1 AC5: capabilities is an optional tag input field', () => {
  test('source contains FormField with name="capabilities"', () => {
    const source = readFileSync(componentPath, 'utf-8')
    expect(source).toMatch(/FormField\s+name="capabilities"/)
  })

  test('source defines capabilities field as optional', () => {
    const source = readFileSync(componentPath, 'utf-8')
    // Capabilities should be optional - now uses z.array(z.string()).optional()
    const capabilitiesFieldMatch = source.match(/capabilities:\s*z\.array\(z\.string\(\)\)\.optional\(\)/)
    expect(capabilitiesFieldMatch).not.toBeNull()
  })

  test('source includes FormMessage for capabilities field error display', () => {
    const source = readFileSync(componentPath, 'utf-8')
    const capabilitiesFieldMatch = source.match(/FormField\s+name="capabilities"[\s\S]*?<\/FormField>/)
    expect(capabilitiesFieldMatch).not.toBeNull()
    expect(capabilitiesFieldMatch![0]).toContain('FormMessage')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC6 — maxConcurrentTickets defaults to 3, validates integer ≥ 1
// ──────────────────────────────────────────────────────────────────────────────

describe('US-002-1 AC6: maxConcurrentTickets defaults to 3, validates integer ≥ 1', () => {
  test('source contains FormField with name="maxConcurrentTickets"', () => {
    const source = readFileSync(componentPath, 'utf-8')
    expect(source).toMatch(/FormField\s+name="maxConcurrentTickets"/)
  })

  test('source defines maxConcurrentTickets field with default value of 3', () => {
    const source = readFileSync(componentPath, 'utf-8')
    // Should have .default(3) for the default value
    // Note: using [\s\S]* to match across method calls like .int().min(1)
    expect(source).toMatch(/maxConcurrentTickets:\s*z\.number\(\)[\s\S]*?\.default\s*\(\s*3\s*\)/)
  })

  test('source defines maxConcurrentTickets field with integer ≥ 1 validation', () => {
    const source = readFileSync(componentPath, 'utf-8')
    // Should have .int() and .min(1) for integer and >= 1 validation
    expect(source).toMatch(/\.int\(\)[^)]*\.min\(1\)/)
    expect(source).toContain('maxConcurrentTickets: z.number()')
  })

  test('source includes FormMessage for maxConcurrentTickets field error display', () => {
    const source = readFileSync(componentPath, 'utf-8')
    const maxConcurrentFieldMatch = source.match(/FormField\s+name="maxConcurrentTickets"[\s\S]*?<\/FormField>/)
    expect(maxConcurrentFieldMatch).not.toBeNull()
    expect(maxConcurrentFieldMatch![0]).toContain('FormMessage')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC7 — Validation errors are shown inline for each field on submission attempt
// ──────────────────────────────────────────────────────────────────────────────

describe('US-002-1 AC7: Validation errors are shown inline for each field on submission attempt', () => {
  test('each FormField contains FormMessage component for inline error display', () => {
    const source = readFileSync(componentPath, 'utf-8')
    // Count FormMessage occurrences - should have one for each field
    const formMessageMatches = source.match(/<FormMessage\s*\/?>/g)
    // We have 5 fields: name, slug, roles, capabilities, maxConcurrentTickets
    // Each should have a FormMessage
    expect(formMessageMatches).not.toBeNull()
    expect(formMessageMatches!.length).toBeGreaterThanOrEqual(5)
  })

  test('form uses handleSubmit for submission', () => {
    const source = readFileSync(componentPath, 'utf-8')
    expect(source).toMatch(/handleSubmit/)
  })

  test('submit button triggers validation on click', () => {
    const source = readFileSync(componentPath, 'utf-8')
    // The form should have a submit button
    expect(source).toMatch(/<Button[^>]*type="submit"/)
  })
})