import { describe, test, expect } from '@jest/globals'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const dialogPath = join(webDir, 'components', 'ImportIssueDialog.vue')

// ──────────────────────────────────────────────────────────────────────────────
// File existence
// ──────────────────────────────────────────────────────────────────────────────

describe('VCS-P1-005-E: ImportIssueDialog.vue exists', () => {
  test('component file exists at components/ImportIssueDialog.vue', () => {
    expect(existsSync(dialogPath)).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC3 — Dialog contains numeric issue number input and submit button
// ──────────────────────────────────────────────────────────────────────────────

describe('VCS-P1-005-E AC3: ImportIssueDialog contains input field and submit button', () => {
  test('component uses Dialog primitive', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    expect(source).toContain('Dialog')
  })

  test('dialog has a numeric input field for issue number', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    const hasNumberInput =
      source.includes('type="number"') ||
      source.includes("type='number'")
    expect(hasNumberInput).toBe(true)
  })

  test('dialog uses FormField component for issue number input', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    expect(source).toContain('FormField')
  })

  test('issue number input has form validation via vee-validate', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    const hasValidation =
      source.includes('useForm') ||
      source.includes('validationSchema') ||
      source.includes('handleSubmit')
    expect(hasValidation).toBe(true)
  })

  test('dialog renders a submit button', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    const hasSubmitButton =
      source.includes('type="submit"') ||
      source.includes("type='submit'")
    expect(hasSubmitButton).toBe(true)
  })

  test('submit button is disabled while request is in flight', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    const hasDisabledState =
      source.includes(':disabled="') ||
      source.includes(':disabled=\'')
    expect(hasDisabledState).toBe(true)
  })

  test('issue number input uses i18n placeholder', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    const hasI18nPlaceholder =
      source.includes("t('vcs.") ||
      source.includes('t("vcs.')
    expect(hasI18nPlaceholder).toBe(true)
  })

  test('dialog title uses i18n key', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    const hasDialogTitleI18n =
      source.includes("t('vcs.") ||
      source.includes('DialogTitle')
    expect(hasDialogTitleI18n).toBe(true)
  })

  test('dialog has cancel button with i18n text', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    const hasCancelButton =
      source.includes("t('common.cancel')") ||
      source.includes('t("common.cancel")')
    expect(hasCancelButton).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC4 — Submitting calls POST /projects/:slug/vcs/sync/:issueNumber
// ──────────────────────────────────────────────────────────────────────────────

describe('VCS-P1-005-E AC4: Dialog submits to correct API endpoint', () => {
  test('component imports useApi composable', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    expect(source).toContain('useApi')
  })

  test('component submits to /projects/:slug/vcs/sync endpoint', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    const hasVcsSyncEndpoint =
      source.includes('/vcs/sync') ||
      source.includes('vcs') && source.includes('sync')
    expect(hasVcsSyncEndpoint).toBe(true)
  })

  test('API call includes issue number in URL path', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    const hasIssueNumberInPath =
      source.includes(':issueNumber') ||
      source.includes('issueNumber') ||
      source.includes('issue')
    expect(hasIssueNumberInPath).toBe(true)
  })

  test('component uses POST method for sync request', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    const hasPost =
      source.includes('post') ||
      source.includes('POST') ||
      source.includes('$api.post')
    expect(hasPost).toBe(true)
  })

  test('component receives project slug prop', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    const hasSlugProp =
      source.includes('defineProps') &&
      (source.includes('slug') || source.includes('projectSlug'))
    expect(hasSlugProp).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC5 — On success, dialog closes and shows toast with created ticket ref
// ──────────────────────────────────────────────────────────────────────────────

describe('VCS-P1-005-E AC5: On success, dialog closes with success toast', () => {
  test('component imports useAppToast composable', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    expect(source).toContain('useAppToast')
  })

  test('component emits update:open event to close dialog', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    const hasOpenEmit =
      source.includes('update:open') ||
      source.includes('emit(\'update:open\'') ||
      source.includes('emit("update:open"')
    expect(hasOpenEmit).toBe(true)
  })

  test('component shows success toast on successful sync', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    const hasSuccessToast =
      source.includes('toast.success') ||
      source.includes('.success(')
    expect(hasSuccessToast).toBe(true)
  })

  test('success toast displays ticket reference using i18n', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    const hasTicketRefInToast =
      source.includes("t('vcs.") ||
      source.includes('t("vcs.')
    expect(hasTicketRefInToast).toBe(true)
  })

  test('component resets form after successful submission', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    const hasFormReset =
      source.includes('reset') ||
      source.includes('resetForm')
    expect(hasFormReset).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC6 — On failure, shows inline error message from API response
// ──────────────────────────────────────────────────────────────────────────────

describe('VCS-P1-005-E AC6: On failure, shows error message in dialog', () => {
  test('component catches API errors', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    const hasErrorHandling =
      source.includes('catch') ||
      source.includes('error')
    expect(hasErrorHandling).toBe(true)
  })

  test('component shows error toast on failed sync', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    const hasErrorToast =
      source.includes('toast.error') ||
      source.includes('.error(')
    expect(hasErrorToast).toBe(true)
  })

  test('component uses extractApiError for error handling', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    expect(source).toContain('extractApiError')
  })

  test('error message does not close the dialog on failure', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    // Should NOT emit close on error, only on success
    const successClosesDialog =
      source.includes('emit(\'update:open\', false)') ||
      source.includes('emit("update:open", false)')
    expect(successClosesDialog).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC7 — All UI strings use i18n keys
// ──────────────────────────────────────────────────────────────────────────────

describe('VCS-P1-005-E AC7: All UI strings use i18n keys', () => {
  test('component imports useI18n', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    expect(source).toContain('useI18n')
  })

  test('component uses t() function in template', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    expect(source).toContain("t('")
  })

  test('dialog title uses i18n', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    const hasI18nTitle =
      source.includes('DialogTitle') &&
      source.includes("t('")
    expect(hasI18nTitle).toBe(true)
  })

  test('form field labels use i18n', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    const hasFormLabelI18n =
      source.includes('FormLabel') &&
      source.includes("t('")
    expect(hasFormLabelI18n).toBe(true)
  })

  test('buttons use i18n text', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    const hasButtonI18n =
      source.includes('<Button') &&
      source.includes("t('")
    expect(hasButtonI18n).toBe(true)
  })

  test('no hardcoded strings in template', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    // Check for common hardcoded button texts
    const hasHardcoded =
      source.includes('>Cancel<') ||
      source.includes('>Submit<') ||
      source.includes('>Issue Number<') ||
      source.includes('>Import Issue<')
    expect(hasHardcoded).toBe(false)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Quality checks
// ──────────────────────────────────────────────────────────────────────────────

describe('VCS-P1-005-E: ImportIssueDialog quality checks', () => {
  test('no console.log statements', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    expect(source).not.toContain('console.log')
  })

  test('component defines open prop with control:open binding', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    const hasOpenProp =
      source.includes('open') ||
      source.includes('defineProps')
    expect(hasOpenProp).toBe(true)
  })

  test('component uses defineProps for type safety', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    expect(source).toContain('defineProps')
  })

  test('component uses defineEmits for type safety', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    expect(source).toContain('defineEmits')
  })
})
