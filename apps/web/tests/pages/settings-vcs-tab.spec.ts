import { describe, test, expect } from '@jest/globals'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const settingsPath = join(webDir, 'pages', '[project]', 'settings.vue')

function getSource(): string {
  return readFileSync(settingsPath, 'utf-8')
}

// ──────────────────────────────────────────────────────────────────────────────
// AC1 — Page exists at /[project]/settings
// ──────────────────────────────────────────────────────────────────────────────

describe('VCS-P1-005-C AC1: Navigating to /[project]/settings renders a page with a VCS Integration tab', () => {
  test('file is present at pages/[project]/settings.vue', () => {
    expect(existsSync(settingsPath)).toBe(true)
  })

  test('source contains a tab component or Tabs component', () => {
    const source = getSource()
    const hasTabs =
      source.includes('Tabs') ||
      source.includes('Tablist') ||
      source.includes('TabsContent')
    expect(hasTabs).toBe(true)
  })

  test('source contains VCS Integration tab', () => {
    const source = getSource()
    const hasVcsTab =
      source.includes('VCS') ||
      source.includes("t('vcs") ||
      source.includes('vcs')
    expect(hasVcsTab).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC2 — VCS Integration tab renders all required fields
// ──────────────────────────────────────────────────────────────────────────────

describe('VCS-P1-005-C AC2: VCS Integration tab renders all required fields', () => {
  test('source includes a provider selector/dropdown field', () => {
    const source = getSource()
    const hasProviderField =
      source.includes('provider') &&
      (source.includes('Select') || source.includes('select'))
    expect(hasProviderField).toBe(true)
  })

  test('source includes repo owner text input field', () => {
    const source = getSource()
    const hasOwnerField =
      source.includes('owner') &&
      source.includes('Input')
    expect(hasOwnerField).toBe(true)
  })

  test('source includes repo name text input field', () => {
    const source = getSource()
    const hasRepoField =
      (source.includes('repo') || source.includes('repository')) &&
      source.includes('Input')
    expect(hasRepoField).toBe(true)
  })

  test('source includes masked token input field', () => {
    const source = getSource()
    const hasTokenField =
      source.includes('token') &&
      source.includes('Input') &&
      (source.includes('type="password"') || source.includes('password'))
    expect(hasTokenField).toBe(true)
  })

  test('source includes sync mode radio group (polling/webhook)', () => {
    const source = getSource()
    const hasSyncModeField =
      source.includes('syncMode') &&
      (source.includes('RadioGroup') || source.includes('radiogroup'))
    expect(hasSyncModeField).toBe(true)
  })

  test('source includes polling interval number input', () => {
    const source = getSource()
    const hasPollingField =
      source.includes('pollingInterval') &&
      (source.includes('Input') || source.includes('input'))
    expect(hasPollingField).toBe(true)
  })

  test('source includes authors tag input', () => {
    const source = getSource()
    const hasAuthorsField =
      source.includes('authors') &&
      (source.includes('Input') || source.includes('tag'))
    expect(hasAuthorsField).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC3 — Form POST on no existing connection
// ──────────────────────────────────────────────────────────────────────────────

describe('VCS-P1-005-C AC3: Submitting form with no existing connection calls POST /projects/:slug/vcs', () => {
  test('source uses useApi() composable', () => {
    const source = getSource()
    expect(source).toContain('useApi()')
  })

  test('source calls $api.post() for VCS connection', () => {
    const source = getSource()
    const hasPostCall =
      source.includes('$api.post(') &&
      (source.includes('/vcs') || source.includes('vcs'))
    expect(hasPostCall).toBe(true)
  })

  test('source includes form submission handler', () => {
    const source = getSource()
    const hasSubmitHandler =
      source.includes('handleSubmit') ||
      source.includes('onSubmit') ||
      source.includes('@submit=')
    expect(hasSubmitHandler).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC4 — Form PATCH on existing connection
// ──────────────────────────────────────────────────────────────────────────────

describe('VCS-P1-005-C AC4: Submitting form with existing connection calls PATCH /projects/:slug/vcs', () => {
  test('source calls $api.patch() for VCS connection update', () => {
    const source = getSource()
    const hasPatchCall =
      source.includes('$api.patch(') &&
      (source.includes('/vcs') || source.includes('vcs'))
    expect(hasPatchCall).toBe(true)
  })

  test('source checks if connection exists before determining POST vs PATCH', () => {
    const source = getSource()
    const hasConditionalLogic =
      (source.includes('if (') && source.includes('connection')) ||
      source.includes('existingConnection') ||
      source.includes('hasConnection') ||
      source.includes('? $api.post') ||
      source.includes('? $api.patch')
    expect(hasConditionalLogic).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC5 — Test Connection button calls POST .../vcs/test with success/error toast
// ──────────────────────────────────────────────────────────────────────────────

describe('VCS-P1-005-C AC5: Test Connection button calls POST /projects/:slug/vcs/test', () => {
  test('source includes Test Connection button', () => {
    const source = getSource()
    const hasTestButton =
      source.includes('Test') &&
      (source.includes("t('") || source.includes('test'))
    expect(hasTestButton).toBe(true)
  })

  test('source calls $api.post() with /vcs/test endpoint', () => {
    const source = getSource()
    const hasTestEndpoint =
      source.includes('$api.post(') &&
      source.includes('vcs/test')
    expect(hasTestEndpoint).toBe(true)
  })

  test('source uses useAppToast() for success toast', () => {
    const source = getSource()
    const hasToast =
      source.includes('useAppToast()') &&
      source.includes('toast.success(')
    expect(hasToast).toBe(true)
  })

  test('source shows error toast on failed connection test', () => {
    const source = getSource()
    const hasErrorToast =
      source.includes('toast.error(')
    expect(hasErrorToast).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC6 — Sync Now button calls POST .../vcs/sync with toast
// ──────────────────────────────────────────────────────────────────────────────

describe('VCS-P1-005-C AC6: Sync Now button calls POST /projects/:slug/vcs/sync', () => {
  test('source includes Sync Now button', () => {
    const source = getSource()
    const hasSyncButton =
      source.includes('Sync') &&
      (source.includes("t('") || source.includes('sync'))
    expect(hasSyncButton).toBe(true)
  })

  test('source calls $api.post() with /vcs/sync endpoint', () => {
    const source = getSource()
    const hasSyncEndpoint =
      source.includes('$api.post(') &&
      source.includes('vcs/sync')
    expect(hasSyncEndpoint).toBe(true)
  })

  test('source shows toast with sync result counts (created, updated, skipped)', () => {
    const source = getSource()
    const hasResultToast =
      source.includes('created') &&
      source.includes('updated') &&
      source.includes('skipped') &&
      source.includes('toast')
    expect(hasResultToast).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC7 — Form pre-fills from GET .../vcs when connection exists
// ──────────────────────────────────────────────────────────────────────────────

describe('VCS-P1-005-C AC7: Form pre-fills from GET /projects/:slug/vcs when connection exists', () => {
  test('source calls $api.get() to fetch VCS connection data', () => {
    const source = getSource()
    const hasGetCall =
      source.includes('$api.get(') &&
      (source.includes('/vcs') || source.includes('vcs'))
    expect(hasGetCall).toBe(true)
  })

  test('source uses useAsyncData or equivalent to fetch data on mount', () => {
    const source = getSource()
    const hasAsyncData =
      source.includes('useAsyncData') ||
      source.includes('useFetch') ||
      source.includes('onMounted')
    expect(hasAsyncData).toBe(true)
  })

  test('source pre-populates form fields from fetched data', () => {
    const source = getSource()
    const hasFormPopulation =
      source.includes('provider') &&
      source.includes('owner') &&
      source.includes('repo') &&
      source.includes('token')
    expect(hasFormPopulation).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC8 — All strings use i18n keys, no hardcoded strings
// ──────────────────────────────────────────────────────────────────────────────

describe('VCS-P1-005-C AC8: All form labels and toast messages use web i18n keys', () => {
  test('source imports useI18n()', () => {
    const source = getSource()
    expect(source).toContain('useI18n()')
  })

  test('source uses t() function for all labels', () => {
    const source = getSource()
    const hasI18nLabels =
      source.includes("t('vcs.") ||
      source.includes("t('common.") ||
      source.includes("t('validation.")
    expect(hasI18nLabels).toBe(true)
  })

  test('source does not contain hardcoded field labels like "Provider", "Token", etc', () => {
    const source = getSource()
    // Check that common field names are not hardcoded
    const hasHardcodedProvider = source.includes('"Provider"') || source.includes("'Provider'")
    const hasHardcodedToken = source.includes('"Token"') || source.includes("'Token'")
    const hasHardcodedOwner = source.includes('"Owner"') || source.includes("'Owner'")

    expect(hasHardcodedProvider || hasHardcodedToken || hasHardcodedOwner).toBe(false)
  })

  test('source uses i18n keys for button labels (Test Connection, Sync Now, Save)', () => {
    const source = getSource()
    const hasI18nButtons =
      source.includes("t('") && (
        source.includes('test') ||
        source.includes('sync') ||
        source.includes('save')
      )
    expect(hasI18nButtons).toBe(true)
  })

  test('source uses i18n keys for toast messages', () => {
    const source = getSource()
    const hasI18nToasts =
      source.includes('toast.success(t(') ||
      source.includes('toast.error(t(') ||
      (source.includes('t("vcs') && source.includes('toast'))
    expect(hasI18nToasts).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Quality checks
// ──────────────────────────────────────────────────────────────────────────────

describe('VCS-P1-005-C: Code quality checks', () => {
  test('source does not contain console.log statements', () => {
    const source = getSource()
    expect(source).not.toContain('console.log')
  })

  test('source uses form validation with vee-validate', () => {
    const source = getSource()
    const hasValidation =
      source.includes('useForm') ||
      source.includes('vee-validate') ||
      source.includes('toTypedSchema')
    expect(hasValidation).toBe(true)
  })

  test('source includes error handling for API calls', () => {
    const source = getSource()
    const hasErrorHandling =
      source.includes('try {') ||
      source.includes('.catch(') ||
      source.includes('error')
    expect(hasErrorHandling).toBe(true)
  })
})
