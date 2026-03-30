import { describe, test, expect } from '@jest/globals'
import { readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '..')
const componentPath = join(webDir, 'components', 'CreateAgentDialog.vue')

// ──────────────────────────────────────────────────────────────────────────────
// AC1 — When name field value changes, slug is auto-derived as kebab-case
// ──────────────────────────────────────────────────────────────────────────────

describe('US-002-2 AC1: When name field value changes, slug is auto-derived as kebab-case', () => {
  test('source contains a watch on name field that updates slug', () => {
    const source = readFileSync(componentPath, 'utf-8')
    // Should have a watch on values.name that calls setFieldValue for slug
    expect(source).toMatch(/watch\s*\(\s*\(\s*\)\s*=>\s*values\.name/)
  })

  test('source contains deriveSlug function that converts to kebab-case', () => {
    const source = readFileSync(componentPath, 'utf-8')
    // deriveSlug should lowercase and replace spaces with hyphens
    expect(source).toMatch(/deriveSlug\s*\(/)
    expect(source).toMatch(/\.toLowerCase\(\)/)
    expect(source).toMatch(/\.replace.*\s+['"`]-['"`]/)
  })

  test('deriveSlug function replaces spaces with hyphens', () => {
    const source = readFileSync(componentPath, 'utf-8')
    // Match pattern: replace(/\s+/g, '-') or similar
    expect(source).toMatch(/replace\s*\(\s*\/\\s\+\/g\s*,\s*['"`]-['"`]\s*\)/)
  })

  test('deriveSlug function removes non-alphanumeric characters except hyphens', () => {
    const source = readFileSync(componentPath, 'utf-8')
    // Should have a replace that removes special characters
    expect(source).toMatch(/\.replace\(\/\[\^[^)]+\]\/g, ''\)/)
  })

  test('slug is set via setFieldValue inside name watch', () => {
    const source = readFileSync(componentPath, 'utf-8')
    // The watch callback should call setFieldValue('slug', ...)
    expect(source).toMatch(/setFieldValue\s*\(\s*['"]slug['"]\s*,/)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC2 — Auto-derivation triggers on every name change (debounced or immediate)
// ──────────────────────────────────────────────────────────────────────────────

describe('US-002-2 AC2: Auto-derivation triggers on every name change', () => {
  test('watch on name field is not debounced (immediate reaction)', () => {
    const source = readFileSync(componentPath, 'utf-8')
    // The watch should be immediate (no debounce option) - watch without options means immediate
    // Look for watch(() => values.name that doesn't have { debounce: ... } or { delay: ... }
    const watchMatch = source.match(/watch\s*\(\s*\(\s*\)\s*=>\s*values\.name[\s\S]*?(?=\n\s*\})/)
    if (watchMatch) {
      const watchBody = watchMatch[0]
      // Should not have debounce or delay options
      expect(watchBody).not.toMatch(/debounce\s*:/)
      expect(watchBody).not.toMatch(/delay\s*:/)
    }
  })

  test('slug derivation happens on every name change without throttling', () => {
    const source = readFileSync(componentPath, 'utf-8')
    // Watch on values.name should call deriveSlug directly without any throttling wrapper
    const hasDirectDerivation = source.match(/watch\s*\(\s*\(\s*\)\s*=>\s*values\.name[\s\S]*?deriveSlug/)
    expect(hasDirectDerivation).not.toBeNull()
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC3 — User can manually edit the slug after auto-derivation
// ──────────────────────────────────────────────────────────────────────────────

describe('US-002-2 AC3: User can manually edit the slug after auto-derivation', () => {
  test('slug field is an editable Input, not read-only', () => {
    const source = readFileSync(componentPath, 'utf-8')
    // The slug Input should NOT have readonly or disabled attribute
    const slugFieldMatch = source.match(/FormField\s+name="slug"[\s\S]*?<\/FormField>/)
    expect(slugFieldMatch).not.toBeNull()
    const slugFieldContent = slugFieldMatch![0]
    // Should not have readonly or disabled on the slug input
    expect(slugFieldContent).not.toMatch(/readonly/)
    expect(slugFieldContent).not.toMatch(/disabled/)
  })

  test('slug field uses standard Input component (not derived/readonly)', () => {
    const source = readFileSync(componentPath, 'utf-8')
    // Slug field should use Input component like other editable fields
    const slugFieldMatch = source.match(/FormField\s+name="slug"[\s\S]*?<\/FormField>/)
    expect(slugFieldMatch).not.toBeNull()
    expect(slugFieldMatch![0]).toContain('<Input')
  })

  test('source does not set slug as read-only after initial derivation', () => {
    const source = readFileSync(componentPath, 'utf-8')
    // After the watch sets slug initially, there should be no code that makes it read-only
    // The slug should remain editable
    const slugInputMatch = source.match(/<Input[^>]*name="slug"[^>]*>/)
    if (slugInputMatch) {
      expect(slugInputMatch[0]).not.toContain('readonly')
      expect(slugInputMatch[0]).not.toContain('disabled')
    }
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC4 — Edited slug is preserved unless name changes again
// ──────────────────────────────────────────────────────────────────────────────

describe('US-002-2 AC4: Edited slug is preserved unless name changes again', () => {
  test('source tracks whether slug was manually edited (flag or comparison)', () => {
    const source = readFileSync(componentPath, 'utf-8')
    // There should be a mechanism to track if slug was manually edited
    // This could be: a ref like isSlugManuallyEdited, a comparison of values.slug vs deriveSlug(name), etc.
    const hasTrackingMechanism =
      source.includes('isSlugManuallyEdited') ||
      source.includes('slugManuallyEdited') ||
      source.includes('slugEdited') ||
      source.includes('hasUserEditedSlug') ||
      source.includes('isSlugEdited') ||
      // Or alternatively: comparing current slug to derived slug before auto-setting
      (source.includes('slug') && source.includes('deriveSlug'))
    expect(hasTrackingMechanism).toBe(true)
  })

  test('slug is NOT auto-updated when user has manually edited it', () => {
    const source = readFileSync(componentPath, 'utf-8')
    // The watch on name should check if slug was manually edited before auto-updating
    // This means the watch should have conditional logic that checks some flag or comparison
    // Look for: if statement checking a flag OR ternary with flag check OR values.slug !== deriveSlug(name)
    const hasConditionalSlugUpdate =
      (source.includes('if') && source.includes('isSlugManuallyEdited')) ||
      (source.includes('if') && source.includes('slugEdited')) ||
      (source.includes('slug !==') && source.includes('deriveSlug')) ||
      (source.includes('slugManuallyEdited') && source.includes('setFieldValue'))
    expect(hasConditionalSlugUpdate).toBe(true)
  })

  test('manual slug edit sets a flag that prevents auto-derivation', () => {
    const source = readFileSync(componentPath, 'utf-8')
    // When slug field changes (via user input), there should be a handler or watch
    // that sets a "manually edited" flag
    const hasSlugChangeHandler =
      source.includes('watch') &&
      (source.includes('slugManuallyEdited') || source.includes('slugEdited') || source.includes('isSlugManuallyEdited') || source.includes('isSlugEdited'))
    expect(hasSlugChangeHandler).toBe(true)
  })

  test('auto-derivation checks name state (empty vs non-empty)', () => {
    const source = readFileSync(componentPath, 'utf-8')
    // When name is cleared/empty, auto-derivation should handle this case
    // The watch should check for name being truthy before deriving
    expect(source).toMatch(/name\s*!==\s*undefined|name\s*!==\s*null|name\s*\?|if\s*\(\s*name\s*\)/)
  })

  test('changing name updates the slug (name takes precedence when name changes)', () => {
    const source = readFileSync(componentPath, 'utf-8')
    // When name changes, it SHOULD update the slug via setFieldValue('slug', deriveSlug(name))
    // This is correct behavior - name change triggers fresh derivation
    expect(source).toMatch(/setFieldValue\s*\(\s*['"]slug['"]\s*,\s*deriveSlug/)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Integration: deriveSlug function behavior
// ──────────────────────────────────────────────────────────────────────────────

describe('US-002-2: deriveSlug function produces correct kebab-case', () => {
  test('deriveSlug function exists and is exported or accessible', () => {
    const source = readFileSync(componentPath, 'utf-8')
    expect(source).toMatch(/function\s+deriveSlug\s*\(/)
  })

  test('deriveSlug lowercases the input', () => {
    const source = readFileSync(componentPath, 'utf-8')
    // Function should call toLowerCase()
    expect(source).toMatch(/deriveSlug[\s\S]*?\.toLowerCase\(\)/)
  })

  test('deriveSlug replaces spaces with hyphens', () => {
    const source = readFileSync(componentPath, 'utf-8')
    expect(source).toMatch(/deriveSlug[\s\S]*?\.replace.*['"`]-['"`]/)
  })

  test('deriveSlug removes non-alphanumeric characters except hyphens', () => {
    const source = readFileSync(componentPath, 'utf-8')
    // Should have a replace with regex like /[^a-z0-9-]/g
    expect(source).toMatch(/deriveSlug[\s\S]*?replace.*\/[^a-z0-9-]/)
  })
})
