import { describe, test, expect } from '@jest/globals'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const registerPath = join(webDir, 'pages', 'register.vue')

// ──────────────────────────────────────────────────────────────────────────────
// AC1 — Outermost template element is <div class="w-full max-w-md space-y-8">
// ──────────────────────────────────────────────────────────────────────────────

describe('AC1: pages/register.vue exists and has correct outer structure', () => {
  test('file is present at pages/register.vue', () => {
    expect(existsSync(registerPath)).toBe(true)
  })

  test('outermost template element is <div class="w-full max-w-md space-y-8">', () => {
    const source = readFileSync(registerPath, 'utf-8')
    const templateMatch = source.match(/<template>([\s\S]*?)<\/template>/)
    if (templateMatch) {
      const templateContent = templateMatch[1].trim()
      // Verify the outermost element is the correct div
      expect(templateContent).toMatch(/^<div\s+class="w-full max-w-md space-y-8">/)
    }
  })

  test('template does not have outer flex min-h-screen wrapper', () => {
    const source = readFileSync(registerPath, 'utf-8')
    // Check that the template doesn't start with a flex min-h-screen wrapper
    const templateMatch = source.match(/<template>([\s\S]*?)<\/template>/)
    if (templateMatch) {
      const templateContent = templateMatch[1]
      // The first opening div should be the w-full max-w-md space-y-8 div
      const firstDivMatch = templateContent.match(/<div[^>]*>/)
      if (firstDivMatch) {
        const firstDiv = firstDivMatch[0]
        expect(firstDiv).not.toContain('flex')
        expect(firstDiv).not.toContain('min-h-screen')
      }
    }
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC4 — toast is accessed via useAppToast helper
// ──────────────────────────────────────────────────────────────────────────────

describe('AC4: toast is provided by useAppToast helper', () => {
  test('source accesses toast from useAppToast', () => {
    const source = readFileSync(registerPath, 'utf-8')
    expect(source).toContain('useAppToast(')
  })

  test('source does not directly import toast from vue-sonner', () => {
    const source = readFileSync(registerPath, 'utf-8')
    expect(source).not.toMatch(/import\s*\{\s*toast\s*\}\s*from\s*['"]vue-sonner['"]/)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC5 — No `error` ref variable declared
// ──────────────────────────────────────────────────────────────────────────────

describe('AC5: no error ref variable in register.vue', () => {
  test('source does not declare an error ref', () => {
    const source = readFileSync(registerPath, 'utf-8')
    // Check that there's no const error = ref(...) or similar pattern
    expect(source).not.toMatch(/const\s+error\s*=\s*ref\s*\(/)
  })

  test('source does not reference an error ref variable', () => {
    const source = readFileSync(registerPath, 'utf-8')
    // The word "error" might appear in error handling, but not as a standalone ref
    const hasErrorRef = source.match(/\berror\s*=\s*ref\s*\(/) ||
                       source.match(/const\s+error\s*:/) ||
                       source.match(/error\.value\s*=/)
    expect(hasErrorRef).toBeFalsy()
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC6 — No v-if="error" banner div in template
// ──────────────────────────────────────────────────────────────────────────────

describe('AC6: no error banner div with v-if="error"', () => {
  test('template does not contain v-if="error"', () => {
    const source = readFileSync(registerPath, 'utf-8')
    expect(source).not.toContain('v-if="error"')
  })

  test('template does not contain error banner div', () => {
    const source = readFileSync(registerPath, 'utf-8')
    // Make sure there's no div with error-related v-if conditions
    const hasErrorBanner = source.includes('v-if="error') ||
                          source.includes('v-show="error')
    expect(hasErrorBanner).toBe(false)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC2 — On error, toast.error(extractApiError(err)) is called
// ──────────────────────────────────────────────────────────────────────────────

describe('AC2: toast.error with extractApiError on registration failure', () => {
  test('source calls toast.error on registration failure', () => {
    const source = readFileSync(registerPath, 'utf-8')
    expect(source).toContain('toast.error(')
  })

  test('source uses extractApiError when calling toast.error', () => {
    const source = readFileSync(registerPath, 'utf-8')
    expect(source).toContain('extractApiError(')
    // Check that they're used together in error handling
    expect(source).toContain('toast.error(extractApiError(')
  })

  test('source imports extractApiError from useApi', () => {
    const source = readFileSync(registerPath, 'utf-8')
    expect(source).toContain('extractApiError')
    expect(source).toContain('useApi')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC3 — On success, toast.success(t('toast.loggedIn')) called before navigateTo
// ──────────────────────────────────────────────────────────────────────────────

describe('AC3: toast.success called before navigateTo on success', () => {
  test('source calls toast.success on registration success', () => {
    const source = readFileSync(registerPath, 'utf-8')
    expect(source).toContain('toast.success(')
  })

  test("source calls toast.success with t('toast.loggedIn')", () => {
    const source = readFileSync(registerPath, 'utf-8')
    expect(source).toContain("t('toast.loggedIn')")
  })

  test('source calls navigateTo after toast.success', () => {
    const source = readFileSync(registerPath, 'utf-8')
    expect(source).toContain('navigateTo(')
    // Extract the try block to verify order
    const tryBlockMatch = source.match(/try\s*\{([\s\S]*?)\}\s*catch/)
    if (tryBlockMatch) {
      const tryContent = tryBlockMatch[1]
      const toastIndex = tryContent.indexOf('toast.success(')
      const navigateIndex = tryContent.indexOf('navigateTo(')
      if (toastIndex !== -1 && navigateIndex !== -1) {
        expect(toastIndex).toBeLessThan(navigateIndex)
      }
    }
  })

  test('source has try/catch or error handling around register call', () => {
    const source = readFileSync(registerPath, 'utf-8')
    const hasTryCatch = source.includes('try {') || source.includes('try{')
    const hasCatchCallback = source.includes('.catch(')
    expect(hasTryCatch || hasCatchCallback).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Integration: definePageMeta and useAuth setup
// ──────────────────────────────────────────────────────────────────────────────

describe('Integration: register.vue setup', () => {
  test("source sets layout: 'auth' in definePageMeta", () => {
    const source = readFileSync(registerPath, 'utf-8')
    expect(source).toMatch(/definePageMeta\s*\(\s*\{[^}]*layout\s*:\s*['"]auth['"]/)
  })

  test('source imports or calls useAuth', () => {
    const source = readFileSync(registerPath, 'utf-8')
    expect(source).toContain('useAuth')
  })

  test('source calls register() method from useAuth', () => {
    const source = readFileSync(registerPath, 'utf-8')
    expect(source).toContain('.register(')
  })

  test('source uses useI18n for translations', () => {
    const source = readFileSync(registerPath, 'utf-8')
    expect(source).toContain('useI18n')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// No console.log
// ──────────────────────────────────────────────────────────────────────────────

describe('Code quality: no console.log statements', () => {
  test('source does not contain console.log', () => {
    const source = readFileSync(registerPath, 'utf-8')
    expect(source).not.toContain('console.log')
  })
})
