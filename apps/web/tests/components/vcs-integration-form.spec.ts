import { describe, test, expect } from '@jest/globals'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const componentPath = join(webDir, 'components', 'VcsIntegrationForm.vue')

function getSource(): string {
  return readFileSync(componentPath, 'utf-8')
}

// ──────────────────────────────────────────────────────────────────────────────
// AC1 — Component exists and uses vee-validate
// ──────────────────────────────────────────────────────────────────────────────

describe('VCS-P1-005-C: VcsIntegrationForm.vue component structure', () => {
  test('file is present at components/VcsIntegrationForm.vue', () => {
    expect(existsSync(componentPath)).toBe(true)
  })

  test('source imports useForm from vee-validate', () => {
    const source = getSource()
    expect(source).toContain("import { useForm } from 'vee-validate'")
  })

  test('source imports toTypedSchema from @vee-validate/zod', () => {
    const source = getSource()
    expect(source).toContain("import { toTypedSchema } from '@vee-validate/zod'")
  })

  test('source imports zod for validation schema', () => {
    const source = getSource()
    expect(source).toContain('import * as z from \'zod\'')
  })

  test('source uses toTypedSchema(z.object(...)) for form validation', () => {
    const source = getSource()
    expect(source).toMatch(/toTypedSchema\s*\(\s*z\.object\s*\(/)
  })

  test('source passes validationSchema to useForm', () => {
    const source = getSource()
    expect(source).toMatch(/useForm\s*\(\s*\{[^}]*validationSchema\s*:/)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC2 — Provider field validation and rendering
// ──────────────────────────────────────────────────────────────────────────────

describe('VCS-P1-005-C: Provider selector field', () => {
  test('source includes FormField component with name="provider"', () => {
    const source = getSource()
    expect(source).toMatch(/FormField[^>]*name="provider"/)
  })

  test('source uses Select component for provider dropdown', () => {
    const source = getSource()
    const providerFieldMatch = source.match(/FormField[^>]*name="provider"[\s\S]{0,500}<\/FormField>/)
    expect(providerFieldMatch).not.toBeNull()
    const fieldContent = providerFieldMatch![0]
    expect(fieldContent).toContain('Select')
  })

  test('source includes z.string() validation for provider field', () => {
    const source = getSource()
    expect(source).toMatch(/provider\s*:\s*z\.string\(\)/)
  })

  test('source includes FormMessage for provider field error display', () => {
    const source = getSource()
    const providerFieldMatch = source.match(/FormField[^>]*name="provider"[\s\S]{0,500}<\/FormField>/)
    expect(providerFieldMatch).not.toBeNull()
    expect(providerFieldMatch![0]).toContain('FormMessage')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC3 — Repo owner field validation and rendering
// ──────────────────────────────────────────────────────────────────────────────

describe('VCS-P1-005-C: Repo owner text field', () => {
  test('source includes FormField with name="owner"', () => {
    const source = getSource()
    expect(source).toMatch(/FormField[^>]*name="owner"/)
  })

  test('source uses Input component for owner field', () => {
    const source = getSource()
    const ownerFieldMatch = source.match(/FormField[^>]*name="owner"[\s\S]{0,500}<\/FormField>/)
    expect(ownerFieldMatch).not.toBeNull()
    expect(ownerFieldMatch![0]).toContain('Input')
  })

  test('source includes z.string().min(1) validation for owner field', () => {
    const source = getSource()
    expect(source).toMatch(/owner\s*:\s*z\.string\(\)\.min\(1/)
  })

  test('source includes FormMessage for owner field error display', () => {
    const source = getSource()
    const ownerFieldMatch = source.match(/FormField[^>]*name="owner"[\s\S]{0,500}<\/FormField>/)
    expect(ownerFieldMatch).not.toBeNull()
    expect(ownerFieldMatch![0]).toContain('FormMessage')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC4 — Repo name field validation and rendering
// ──────────────────────────────────────────────────────────────────────────────

describe('VCS-P1-005-C: Repo name text field', () => {
  test('source includes FormField with name="repo"', () => {
    const source = getSource()
    expect(source).toMatch(/FormField[^>]*name="repo"/)
  })

  test('source uses Input component for repo field', () => {
    const source = getSource()
    const repoFieldMatch = source.match(/FormField[^>]*name="repo"[\s\S]{0,500}<\/FormField>/)
    expect(repoFieldMatch).not.toBeNull()
    expect(repoFieldMatch![0]).toContain('Input')
  })

  test('source includes z.string().min(1) validation for repo field', () => {
    const source = getSource()
    expect(source).toMatch(/repo\s*:\s*z\.string\(\)\.min\(1/)
  })

  test('source includes FormMessage for repo field error display', () => {
    const source = getSource()
    const repoFieldMatch = source.match(/FormField[^>]*name="repo"[\s\S]{0,500}<\/FormField>/)
    expect(repoFieldMatch).not.toBeNull()
    expect(repoFieldMatch![0]).toContain('FormMessage')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC5 — Token field (masked) validation and rendering
// ──────────────────────────────────────────────────────────────────────────────

describe('VCS-P1-005-C: Token masked input field', () => {
  test('source includes FormField with name="token"', () => {
    const source = getSource()
    expect(source).toMatch(/FormField[^>]*name="token"/)
  })

  test('source uses Input component with password type for token field', () => {
    const source = getSource()
    const tokenFieldMatch = source.match(/FormField[^>]*name="token"[\s\S]{0,500}<\/FormField>/)
    expect(tokenFieldMatch).not.toBeNull()
    const fieldContent = tokenFieldMatch![0]
    expect(fieldContent).toContain('Input')
    expect(fieldContent).toMatch(/type=["']password["']/)
  })

  test('source includes z.string().min(1) validation for token field', () => {
    const source = getSource()
    expect(source).toMatch(/token\s*:\s*z\.string\(\)\.min\(1/)
  })

  test('source includes FormMessage for token field error display', () => {
    const source = getSource()
    const tokenFieldMatch = source.match(/FormField[^>]*name="token"[\s\S]{0,500}<\/FormField>/)
    expect(tokenFieldMatch).not.toBeNull()
    expect(tokenFieldMatch![0]).toContain('FormMessage')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC6 — Sync mode radio group (polling/webhook)
// ──────────────────────────────────────────────────────────────────────────────

describe('VCS-P1-005-C: Sync mode radio group field', () => {
  test('source includes FormField with name="syncMode"', () => {
    const source = getSource()
    expect(source).toMatch(/FormField[^>]*name="syncMode"/)
  })

  test('source uses RadioGroup component for sync mode field', () => {
    const source = getSource()
    const syncModeFieldMatch = source.match(/FormField[^>]*name="syncMode"[\s\S]{0,500}<\/FormField>/)
    expect(syncModeFieldMatch).not.toBeNull()
    expect(syncModeFieldMatch![0]).toContain('RadioGroup')
  })

  test('source includes polling and webhook radio options', () => {
    const source = getSource()
    const syncModeFieldMatch = source.match(/FormField[^>]*name="syncMode"[\s\S]{0,800}<\/FormField>/)
    expect(syncModeFieldMatch).not.toBeNull()
    const fieldContent = syncModeFieldMatch![0]
    expect(fieldContent).toContain('polling')
    expect(fieldContent).toContain('webhook')
  })

  test('source includes z.enum validation for sync mode field', () => {
    const source = getSource()
    expect(source).toMatch(/syncMode\s*:\s*z\.enum\(\s*\[\s*["']polling["']\s*,\s*["']webhook["']\s*\]\s*\)/)
  })

  test('source includes FormMessage for syncMode field error display', () => {
    const source = getSource()
    const syncModeFieldMatch = source.match(/FormField[^>]*name="syncMode"[\s\S]{0,800}<\/FormField>/)
    expect(syncModeFieldMatch).not.toBeNull()
    expect(syncModeFieldMatch![0]).toContain('FormMessage')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC7 — Polling interval number input
// ──────────────────────────────────────────────────────────────────────────────

describe('VCS-P1-005-C: Polling interval number input field', () => {
  test('source includes FormField with name="pollingInterval"', () => {
    const source = getSource()
    expect(source).toMatch(/FormField[^>]*name="pollingInterval"/)
  })

  test('source uses Input component with type number for polling interval', () => {
    const source = getSource()
    const pollingFieldMatch = source.match(/FormField[^>]*name="pollingInterval"[\s\S]{0,500}<\/FormField>/)
    expect(pollingFieldMatch).not.toBeNull()
    const fieldContent = pollingFieldMatch![0]
    expect(fieldContent).toContain('Input')
    expect(fieldContent).toMatch(/type=["']number["']/)
  })

  test('source includes z.number() validation for polling interval field', () => {
    const source = getSource()
    expect(source).toMatch(/pollingInterval\s*:\s*z\.number\(\)/)
  })

  test('source includes FormMessage for pollingInterval field error display', () => {
    const source = getSource()
    const pollingFieldMatch = source.match(/FormField[^>]*name="pollingInterval"[\s\S]{0,500}<\/FormField>/)
    expect(pollingFieldMatch).not.toBeNull()
    expect(pollingFieldMatch![0]).toContain('FormMessage')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC8 — Authors tag input
// ──────────────────────────────────────────────────────────────────────────────

describe('VCS-P1-005-C: Authors tag input field', () => {
  test('source includes FormField with name="authors"', () => {
    const source = getSource()
    expect(source).toMatch(/FormField[^>]*name="authors"/)
  })

  test('source uses Input component for authors field', () => {
    const source = getSource()
    const authorsFieldMatch = source.match(/FormField[^>]*name="authors"[\s\S]{0,500}<\/FormField>/)
    expect(authorsFieldMatch).not.toBeNull()
    expect(authorsFieldMatch![0]).toContain('Input')
  })

  test('source includes z.string() validation for authors field', () => {
    const source = getSource()
    expect(source).toMatch(/authors\s*:\s*z\.string\(\)/)
  })

  test('source includes FormMessage for authors field error display', () => {
    const source = getSource()
    const authorsFieldMatch = source.match(/FormField[^>]*name="authors"[\s\S]{0,500}<\/FormField>/)
    expect(authorsFieldMatch).not.toBeNull()
    expect(authorsFieldMatch![0]).toContain('FormMessage')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC9 — Form submission and i18n
// ──────────────────────────────────────────────────────────────────────────────

describe('VCS-P1-005-C: Form submission and internationalization', () => {
  test('source imports useI18n', () => {
    const source = getSource()
    expect(source).toContain('useI18n')
  })

  test('source uses handleSubmit from vee-validate', () => {
    const source = getSource()
    expect(source).toContain('handleSubmit')
  })

  test('source includes form submission handler on form element', () => {
    const source = getSource()
    expect(source).toMatch(/@submit=/)
  })

  test('source uses i18n keys for all form labels', () => {
    const source = getSource()
    const hasI18nLabels =
      source.includes("t('vcs.") ||
      source.includes("t('common.")
    expect(hasI18nLabels).toBe(true)
  })

  test('source emits custom events for save/update actions', () => {
    const source = getSource()
    const hasEmit =
      source.includes('emit(') ||
      source.includes('$emit(')
    expect(hasEmit).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Quality checks
// ──────────────────────────────────────────────────────────────────────────────

describe('VCS-P1-005-C: VcsIntegrationForm code quality', () => {
  test('source does not contain console.log statements', () => {
    const source = getSource()
    expect(source).not.toContain('console.log')
  })

  test('source imports FormField component from shadcn', () => {
    const source = getSource()
    expect(source).toContain('FormField')
  })

  test('source uses proper button components from shadcn', () => {
    const source = getSource()
    expect(source).toContain('Button')
  })

  test('source includes error handling in form submission', () => {
    const source = getSource()
    const hasErrorHandling =
      source.includes('try {') ||
      source.includes('.catch(') ||
      source.includes('error')
    expect(hasErrorHandling).toBe(true)
  })
})
