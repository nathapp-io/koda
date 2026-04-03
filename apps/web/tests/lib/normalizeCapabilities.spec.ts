import { describe, test, expect } from '@jest/globals'
import { readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const utilsPath = join(webDir, 'lib', 'utils.ts')
const createDialogPath = join(webDir, 'components', 'CreateAgentDialog.vue')

function getUtilsSource(): string {
  return readFileSync(utilsPath, 'utf-8')
}

function getCreateDialogSource(): string {
  return readFileSync(createDialogPath, 'utf-8')
}

// ──────────────────────────────────────────────────────────────────────────────
// AC1 — Case-insensitive dedupe, preserves first-seen casing
// ──────────────────────────────────────────────────────────────────────────────

describe('US-003-A AC1: normalizeCapabilities preserves first-seen casing when deduping case-insensitively', () => {
  test('normalizeCapabilities is exported from lib/utils.ts', () => {
    const source = getUtilsSource()
    expect(source).toContain('export function normalizeCapabilities')
  })

  test('normalizeCapabilities(["Read-Code", "read-code", "READ-CODE"]) returns ["Read-Code"]', async () => {
    const utils = await import(utilsPath)
    const result = utils.normalizeCapabilities(['Read-Code', 'read-code', 'READ-CODE'])
    expect(result).toEqual(['Read-Code'])
  })

  test('normalizeCapabilities(["Foo", "foo", "FOO", "bar"]) returns ["Foo", "bar"]', async () => {
    const utils = await import(utilsPath)
    const result = utils.normalizeCapabilities(['Foo', 'foo', 'FOO', 'bar'])
    expect(result).toEqual(['Foo', 'bar'])
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC2 — Trims leading/trailing whitespace
// ──────────────────────────────────────────────────────────────────────────────

describe('US-003-A AC2: normalizeCapabilities trims leading and trailing whitespace', () => {
  test('normalizeCapabilities(["  trim me  ", "clean"]) returns ["trim me", "clean"]', async () => {
    const utils = await import(utilsPath)
    const result = utils.normalizeCapabilities(['  trim me  ', 'clean'])
    expect(result).toEqual(['trim me', 'clean'])
  })

  test('normalizeCapabilities preserves inner whitespace', async () => {
    const utils = await import(utilsPath)
    const result = utils.normalizeCapabilities(['  multi word  ', '  another one  '])
    expect(result).toEqual(['multi word', 'another one'])
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC3 — Removes empty and whitespace-only entries
// ──────────────────────────────────────────────────────────────────────────────

describe('US-003-A AC3: normalizeCapabilities removes empty and whitespace-only entries', () => {
  test('normalizeCapabilities(["valid", "", "   ", "also-valid"]) returns ["valid", "also-valid"]', async () => {
    const utils = await import(utilsPath)
    const result = utils.normalizeCapabilities(['valid', '', '   ', 'also-valid'])
    expect(result).toEqual(['valid', 'also-valid'])
  })

  test('normalizeCapabilities removes empty string entries', async () => {
    const utils = await import(utilsPath)
    const result = utils.normalizeCapabilities(['', '', ''])
    expect(result).toEqual([])
  })

  test('normalizeCapabilities removes whitespace-only entries', async () => {
    const utils = await import(utilsPath)
    const result = utils.normalizeCapabilities(['  ', '\t', '\n'])
    expect(result).toEqual([])
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC4 — Empty array returns empty array
// ──────────────────────────────────────────────────────────────────────────────

describe('US-003-A AC4: normalizeCapabilities([]) returns []', () => {
  test('normalizeCapabilities([]) returns []', async () => {
    const utils = await import(utilsPath)
    const result = utils.normalizeCapabilities([])
    expect(result).toEqual([])
  })

  test('normalizeCapabilities returns array (not null or undefined)', async () => {
    const utils = await import(utilsPath)
    const result = utils.normalizeCapabilities([])
    expect(result).toBeInstanceOf(Array)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC5 — Combined behavior: trim + remove empty + dedupe
// ──────────────────────────────────────────────────────────────────────────────

describe('US-003-A AC5: normalizeCapabilities combines trim, remove empty, and case-insensitive dedupe', () => {
  test('handles mixed case duplicates with whitespace', async () => {
    const utils = await import(utilsPath)
    const result = utils.normalizeCapabilities(['  Read-Code  ', '  read-code  ', 'READ-CODE'])
    expect(result).toEqual(['Read-Code'])
  })

  test('handles empty strings mixed with valid entries', async () => {
    const utils = await import(utilsPath)
    const result = utils.normalizeCapabilities(['foo', '', 'bar', '   ', 'baz'])
    expect(result).toEqual(['foo', 'bar', 'baz'])
  })

  test('first-seen casing is preserved across all transformations', async () => {
    const utils = await import(utilsPath)
    const result = utils.normalizeCapabilities(['  CAPABILITY  ', 'capability', '  Capability  '])
    expect(result).toEqual(['CAPABILITY'])
  })

  test('does not modify original array', async () => {
    const utils = await import(utilsPath)
    const original = ['Read-Code', 'read-code']
    utils.normalizeCapabilities(original)
    expect(original).toEqual(['Read-Code', 'read-code'])
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC6 — CreateAgentDialog addCapability does not add empty/whitespace input
// ──────────────────────────────────────────────────────────────────────────────

describe('US-003-A AC6: CreateAgentDialog addCapability does not add empty trimmed input', () => {
  test('source addCapability function trims input before checking', () => {
    const source = getCreateDialogSource()
    const addCapabilityMatch = source.match(/function addCapability\([\s\S]*?^\}/m)
    expect(addCapabilityMatch).not.toBeNull()
    expect(addCapabilityMatch![0]).toContain('.trim()')
  })

  test('source addCapability checks for empty string after trim', () => {
    const source = getCreateDialogSource()
    const hasEmptyCheck = source.match(/if\s*\(\s*value\s*&&.*!.*capabilitiesTags.*includes/)
    expect(hasEmptyCheck).not.toBeNull()
  })

  test('source addCapability does not add to capabilitiesTags when trimmed value is empty', () => {
    const source = getCreateDialogSource()
    const addCapabilityMatch = source.match(/function addCapability\([\s\S]*?^\}/m)
    expect(addCapabilityMatch).not.toBeNull()
    const funcBody = addCapabilityMatch![0]
    expect(funcBody).toContain('if (value')
    expect(funcBody).toContain('!capabilitiesTags.value.includes(value)')
  })
})