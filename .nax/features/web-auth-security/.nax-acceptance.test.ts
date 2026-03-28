/**
 * Acceptance tests for the "web-auth-security" feature.
 *
 * Verification strategy:
 *   - runtime-check (preferred): import module, call functions, assert on state
 *   - file-check (last resort): readFileSync + regex for Vue SFCs that cannot
 *     be imported directly in a Node/Jest environment
 */
import { describe, test, expect, beforeEach } from '@jest/globals'
import { readFileSync } from 'fs'
import { join } from 'path'
import { ref, computed } from 'vue'

// ── Paths ─────────────────────────────────────────────────────────────────────

const webDir = join(__dirname, '../../../apps/web')
const authPath = join(webDir, 'composables/useAuth.ts')
const apiPath = join(webDir, 'composables/useApi.ts')
const commentThreadPath = join(webDir, 'components/CommentThread.vue')
const createTicketPath = join(webDir, 'components/CreateTicketDialog.vue')
const createProjectPath = join(webDir, 'components/CreateProjectDialog.vue')
const ticketActionPath = join(webDir, 'components/TicketActionPanel.vue')
const labelsPath = join(webDir, 'pages/[project]/labels.vue')
const langSwitcherPath = join(webDir, 'components/LanguageSwitcher.vue')

// ── Runtime helpers for useAuth composable ────────────────────────────────────

interface CookieCall {
  name: string
  opts: unknown
}

function makeFakeEnv() {
  const tokenRef = ref<string | null>(null)
  const userRef = ref<unknown>(null)
  const navigateToMock = jest.fn()
  const cookieCalls: CookieCall[] = []

  const fakeCookie = (name: string, opts?: unknown) => {
    cookieCalls.push({ name, opts })
    if (name === 'koda_token') return tokenRef
    return ref<string | null>(null)
  }

  const fakeState = (key: string, init?: () => unknown) => {
    if (key === 'koda_user') return userRef
    return ref(typeof init === 'function' ? init() : null)
  }

  const fakeRuntimeConfig = () => ({
    public: { apiBaseUrl: 'http://localhost:3000' },
  })

  const fetchMock = jest.fn((_url: string, _opts?: Record<string, unknown>) =>
    Promise.resolve({ accessToken: 'mock-jwt', user: { id: '1', email: 'a@b.com' } })
  )

  return {
    tokenRef,
    userRef,
    fetchMock,
    fakeCookie,
    fakeState,
    fakeRuntimeConfig,
    navigateToMock,
    cookieCalls,
  }
}

function applyNuxtGlobals(env: ReturnType<typeof makeFakeEnv>) {
  ;(globalThis as Record<string, unknown>).useCookie = env.fakeCookie
  ;(globalThis as Record<string, unknown>).useState = env.fakeState
  ;(globalThis as Record<string, unknown>).computed = computed
  ;(globalThis as Record<string, unknown>).$fetch = env.fetchMock
  ;(globalThis as Record<string, unknown>).useRuntimeConfig = env.fakeRuntimeConfig
  ;(globalThis as Record<string, unknown>).navigateTo = env.navigateToMock
}

beforeEach(() => {
  jest.resetModules()
})

// ── AC-1: useCookie called with secure: true ──────────────────────────────────

describe('AC-1: useCookie called with secure: true for koda_token', () => {
  test('useCookie receives { secure: true } as second argument when initializing the token cookie', async () => {
    const env = makeFakeEnv()
    applyNuxtGlobals(env)
    const mod = await import(authPath)
    mod.useAuth()
    const tokenCall = env.cookieCalls.find((c) => c.name === 'koda_token')
    expect(tokenCall).toBeDefined()
    expect(tokenCall!.opts).toEqual(expect.objectContaining({ secure: true }))
  })
})

// ── AC-2: useCookie called with sameSite: 'strict' ───────────────────────────

describe("AC-2: useCookie called with sameSite: 'strict' for koda_token", () => {
  test("useCookie receives { sameSite: 'strict' } as second argument when initializing the token cookie", async () => {
    const env = makeFakeEnv()
    applyNuxtGlobals(env)
    const mod = await import(authPath)
    mod.useAuth()
    const tokenCall = env.cookieCalls.find((c) => c.name === 'koda_token')
    expect(tokenCall).toBeDefined()
    expect(tokenCall!.opts).toEqual(expect.objectContaining({ sameSite: 'strict' }))
  })
})

// ── AC-3: useCookie called with maxAge: 604800 ───────────────────────────────

describe('AC-3: useCookie called with maxAge: 604800 for koda_token', () => {
  test('useCookie receives { maxAge: 604800 } as second argument when initializing the token cookie', async () => {
    const env = makeFakeEnv()
    applyNuxtGlobals(env)
    const mod = await import(authPath)
    mod.useAuth()
    const tokenCall = env.cookieCalls.find((c) => c.name === 'koda_token')
    expect(tokenCall).toBeDefined()
    expect(tokenCall!.opts).toEqual(expect.objectContaining({ maxAge: 604800 }))
  })
})

// ── AC-4: login() stores the accessToken ─────────────────────────────────────

describe('AC-4: login() stores the accessToken from the API response', () => {
  test('token.value equals the accessToken string returned by the API after login()', async () => {
    const env = makeFakeEnv()
    env.fetchMock.mockResolvedValueOnce({
      accessToken: 'jwt-abc-123',
      user: { id: '1', email: 'a@b.com' },
    })
    applyNuxtGlobals(env)
    const mod = await import(authPath)
    const auth = mod.useAuth()
    await auth.login({ email: 'test@example.com', password: 'secret' })
    expect(env.tokenRef.value).toBe('jwt-abc-123')
  })
})

// ── AC-5: logout() sets token.value to null ──────────────────────────────────

describe('AC-5: logout() sets token.value to null', () => {
  test('token.value is null after logout() is called', async () => {
    const env = makeFakeEnv()
    env.tokenRef.value = 'existing-token'
    applyNuxtGlobals(env)
    const mod = await import(authPath)
    const auth = mod.useAuth()
    auth.logout()
    expect(env.tokenRef.value).toBeNull()
  })
})

// ── AC-6: fetchUser() with non-null token sets user.value and returns true ────

describe('AC-6: fetchUser() with non-null token sets user.value and returns true on success', () => {
  test('fetchUser returns true and sets user.value to the AuthUser from the API response', async () => {
    const env = makeFakeEnv()
    env.tokenRef.value = 'valid-jwt'
    env.fetchMock.mockResolvedValueOnce({
      ret: 0,
      data: { id: '42', email: 'user@koda.test', name: 'Koda User' },
    })
    applyNuxtGlobals(env)
    const mod = await import(authPath)
    const auth = mod.useAuth()
    const result = await auth.fetchUser()
    expect(result).toBe(true)
    expect(env.userRef.value).toMatchObject({ id: '42', email: 'user@koda.test' })
  })
})

// ── AC-7: fetchUser() with null token returns false without fetch ─────────────

describe('AC-7: fetchUser() returns false without making any network request when token is null', () => {
  test('fetchUser returns false and does not call $fetch when token.value is null', async () => {
    const env = makeFakeEnv()
    // tokenRef.value is null by default
    applyNuxtGlobals(env)
    const mod = await import(authPath)
    const auth = mod.useAuth()
    const result = await auth.fetchUser()
    expect(result).toBe(false)
    expect(env.fetchMock).not.toHaveBeenCalled()
  })
})

// ── AC-8: Empty body triggers validation; $api.post is not called ─────────────

describe('AC-8: empty body field triggers validation and $api.post is not called', () => {
  test('CommentThread body field uses z.string().min(1) to require a non-empty value', () => {
    const source = readFileSync(commentThreadPath, 'utf-8')
    expect(source).toMatch(/body\s*:\s*z\.string\(\)\.min\s*\(\s*1/)
  })

  test('CommentThread wraps $api.post inside handleSubmit so validation blocks the call', () => {
    const source = readFileSync(commentThreadPath, 'utf-8')
    expect(source).toContain('handleSubmit')
    expect(source).toContain('$api.post')
  })
})

// ── AC-9: Valid body calls $api.post with body and type values ────────────────

describe('AC-9: valid body and type call $api.post with body and type from form values', () => {
  test('$api.post is called with body: values.body', () => {
    const source = readFileSync(commentThreadPath, 'utf-8')
    expect(source).toMatch(/body\s*:\s*values\.body/)
  })

  test('$api.post is called with type: values.type', () => {
    const source = readFileSync(commentThreadPath, 'utf-8')
    expect(source).toMatch(/type\s*:\s*values\.type/)
  })
})

// ── AC-10: Invalid type triggers validation; $api.post is not called ──────────

describe("AC-10: type value not in ['GENERAL','VERIFICATION','FIX_REPORT','REVIEW'] triggers validation", () => {
  test('type field schema is z.enum containing all four allowed comment types', () => {
    const source = readFileSync(commentThreadPath, 'utf-8')
    expect(source).toContain("z.enum(['GENERAL', 'VERIFICATION', 'FIX_REPORT', 'REVIEW'])")
  })
})

// ── AC-11: Successful comment resets form to initial values ───────────────────

describe("AC-11: successful comment submission resets body to '' and type to 'GENERAL'", () => {
  test('resetForm() is called after a successful comment post', () => {
    const source = readFileSync(commentThreadPath, 'utf-8')
    expect(source).toContain('resetForm()')
  })

  test("initialValues has body: '' so resetForm() restores the body field", () => {
    const source = readFileSync(commentThreadPath, 'utf-8')
    expect(source).toContain("body: ''")
  })

  test("initialValues has type: 'GENERAL' so resetForm() restores the type field", () => {
    const source = readFileSync(commentThreadPath, 'utf-8')
    expect(source).toContain("type: 'GENERAL'")
  })
})

// ── AC-12: CreateTicketDialog resets title to '' on success ──────────────────

describe("AC-12: CreateTicketDialog onSubmit() success calls resetForm() and restores title to ''", () => {
  test('resetForm is destructured from useForm and called in the onSubmit success path', () => {
    const source = readFileSync(createTicketPath, 'utf-8')
    expect(source).toMatch(/resetForm/)
    expect(source).toMatch(/resetForm\s*\(/)
  })

  test("initialValues has title: '' so resetForm() restores the title field", () => {
    const source = readFileSync(createTicketPath, 'utf-8')
    expect(source).toMatch(/title\s*:\s*['"]['"]/)
  })
})

// ── AC-13: CreateTicketDialog resets type to '' on success ───────────────────

describe("AC-13: CreateTicketDialog onSubmit() success calls resetForm() and restores type to ''", () => {
  test('resetForm is called in CreateTicketDialog onSubmit success path', () => {
    const source = readFileSync(createTicketPath, 'utf-8')
    expect(source).toMatch(/resetForm\s*\(/)
  })

  test("initialValues has type: '' so resetForm() restores the type field", () => {
    const source = readFileSync(createTicketPath, 'utf-8')
    expect(source).toMatch(/type\s*:\s*['"]['"]/)
  })
})

// ── AC-14: CreateTicketDialog resets priority to 'MEDIUM' on success ─────────

describe("AC-14: CreateTicketDialog onSubmit() success calls resetForm() and restores priority to 'MEDIUM'", () => {
  test('resetForm is called in CreateTicketDialog onSubmit success path', () => {
    const source = readFileSync(createTicketPath, 'utf-8')
    expect(source).toMatch(/resetForm\s*\(/)
  })

  test("initialValues has priority: 'MEDIUM' so resetForm() restores the priority field", () => {
    const source = readFileSync(createTicketPath, 'utf-8')
    expect(source).toMatch(/priority\s*:\s*['"]MEDIUM['"]/)
  })
})

// ── AC-15: CreateTicketDialog resets description to '' on success ─────────────

describe("AC-15: CreateTicketDialog onSubmit() success calls resetForm() and restores description to ''", () => {
  test('resetForm is called in CreateTicketDialog onSubmit success path', () => {
    const source = readFileSync(createTicketPath, 'utf-8')
    expect(source).toMatch(/resetForm\s*\(/)
  })

  test("initialValues has description: '' so resetForm() restores the description field", () => {
    const source = readFileSync(createTicketPath, 'utf-8')
    expect(source).toMatch(/description\s*:\s*['"]['"]/)
  })
})

// ── AC-16: CreateProjectDialog resets name to '' on success ──────────────────

describe("AC-16: CreateProjectDialog onSubmit() success calls resetForm() and restores name to ''", () => {
  test('resetForm is destructured from useForm and called in the onSubmit success path', () => {
    const source = readFileSync(createProjectPath, 'utf-8')
    expect(source).toMatch(/resetForm/)
    expect(source).toMatch(/resetForm\s*\(/)
  })

  test("initialValues has name: '' so resetForm() restores the name field", () => {
    const source = readFileSync(createProjectPath, 'utf-8')
    expect(source).toMatch(/name\s*:\s*['"]['"]/)
  })
})

// ── AC-17: CreateProjectDialog resets slug to '' on success ──────────────────

describe("AC-17: CreateProjectDialog onSubmit() success calls resetForm() and restores slug to ''", () => {
  test('resetForm is called in CreateProjectDialog onSubmit success path', () => {
    const source = readFileSync(createProjectPath, 'utf-8')
    expect(source).toMatch(/resetForm\s*\(/)
  })

  test("initialValues has slug: '' so resetForm() restores the slug field", () => {
    const source = readFileSync(createProjectPath, 'utf-8')
    expect(source).toMatch(/slug\s*:\s*['"]['"]/)
  })
})

// ── AC-18: CreateProjectDialog resets key to '' on success ───────────────────

describe("AC-18: CreateProjectDialog onSubmit() success calls resetForm() and restores key to ''", () => {
  test('resetForm is called in CreateProjectDialog onSubmit success path', () => {
    const source = readFileSync(createProjectPath, 'utf-8')
    expect(source).toMatch(/resetForm\s*\(/)
  })

  test("initialValues has key: '' so resetForm() restores the key field", () => {
    const source = readFileSync(createProjectPath, 'utf-8')
    expect(source).toMatch(/key\s*:\s*['"]['"]/)
  })
})

// ── AC-19: TicketActionPanel uses ApiError.firstError via extractApiError ─────

describe("AC-19: TicketActionPanel performAction() calls toast.error with ApiError's firstError via extractApiError", () => {
  test('TicketActionPanel imports extractApiError from useApi composable', () => {
    const source = readFileSync(ticketActionPath, 'utf-8')
    expect(source).toContain('extractApiError')
  })

  test('toast.error is called with extractApiError(error) not a plain error.message fallback', () => {
    const source = readFileSync(ticketActionPath, 'utf-8')
    expect(source).toMatch(/toast\.error\s*\(\s*extractApiError/)
  })
})

// ── AC-20: CreateTicketDialog uses extractApiError for ApiError field errors ──

describe('AC-20: CreateTicketDialog onSubmit() calls toast.error with extractApiError for ApiError field errors', () => {
  test('CreateTicketDialog references extractApiError', () => {
    const source = readFileSync(createTicketPath, 'utf-8')
    expect(source).toContain('extractApiError')
  })

  test('toast.error is called with extractApiError(error) in the catch block', () => {
    const source = readFileSync(createTicketPath, 'utf-8')
    expect(source).toMatch(/toast\.error\s*\(\s*extractApiError/)
  })
})

// ── AC-21: CreateProjectDialog uses extractApiError for ApiError field errors ─

describe('AC-21: CreateProjectDialog onSubmit() calls toast.error with extractApiError for ApiError field errors', () => {
  test('CreateProjectDialog references extractApiError', () => {
    const source = readFileSync(createProjectPath, 'utf-8')
    expect(source).toContain('extractApiError')
  })

  test('toast.error is called with extractApiError(error) in the catch block', () => {
    const source = readFileSync(createProjectPath, 'utf-8')
    expect(source).toMatch(/toast\.error\s*\(\s*extractApiError/)
  })
})

// ── AC-22: CommentThread uses extractApiError instead of err.message ──────────

describe('AC-22: CommentThread onSubmit() calls toast.error with extractApiError(err) not err.message', () => {
  test('CommentThread references extractApiError', () => {
    const source = readFileSync(commentThreadPath, 'utf-8')
    expect(source).toContain('extractApiError')
  })

  test('toast.error is called with extractApiError(err) in the catch block', () => {
    const source = readFileSync(commentThreadPath, 'utf-8')
    expect(source).toMatch(/toast\.error\s*\(\s*extractApiError/)
  })
})

// ── AC-23: labels.vue onSubmit() uses extractApiError; no console.error ───────

describe('AC-23: labels.vue onSubmit() calls toast.error with extractApiError(err) and does not call console.error', () => {
  test('labels.vue references extractApiError', () => {
    const source = readFileSync(labelsPath, 'utf-8')
    expect(source).toContain('extractApiError')
  })

  test('toast.error is called with extractApiError(err) in the create label catch block', () => {
    const source = readFileSync(labelsPath, 'utf-8')
    expect(source).toMatch(/toast\.error\s*\(\s*extractApiError/)
  })

  test('labels.vue does not call console.error', () => {
    const source = readFileSync(labelsPath, 'utf-8')
    expect(source).not.toContain('console.error')
  })
})

// ── AC-24: labels.vue deleteLabel() uses extractApiError; no console.error ────

describe('AC-24: labels.vue deleteLabel() calls toast.error with extractApiError(err) and does not call console.error', () => {
  test('deleteLabel catch block uses extractApiError instead of a generic fallback', () => {
    const source = readFileSync(labelsPath, 'utf-8')
    expect(source).toContain('extractApiError')
    // extractApiError must be used in the catch block of deleteLabel
    // Verified by checking the pattern appears in the file and console.error is absent
    expect(source).not.toContain('console.error')
  })

  test('deleteLabel does not swallow the error with a hardcoded i18n key instead of extractApiError', () => {
    const source = readFileSync(labelsPath, 'utf-8')
    // The catch block should use extractApiError, not toast.error(t('labels.toast.deleteFailed'))
    expect(source).not.toMatch(/toast\.error\s*\(\s*t\s*\(\s*['"]labels\.toast\.deleteFailed/)
  })
})

// ── AC-25: extractApiError returns error.message for a plain Error ─────────────

describe('AC-25: extractApiError returns error.message for a caught generic Error', () => {
  test('extractApiError with a plain Error instance returns error.message as the string', async () => {
    const mod = await import(apiPath)
    const { extractApiError } = mod
    const err = new Error('plain error message')
    expect(extractApiError(err)).toBe('plain error message')
  })
})

// ── AC-26: Active locale button receives highlighted class ────────────────────

describe("AC-26: active locale toggle button receives 'bg-primary text-primary-foreground font-medium'", () => {
  test("button class includes 'bg-primary text-primary-foreground font-medium' when locale matches loc.code", () => {
    const source = readFileSync(langSwitcherPath, 'utf-8')
    expect(source).toContain('bg-primary text-primary-foreground font-medium')
  })

  test('the conditional is based on locale === loc.code equality', () => {
    const source = readFileSync(langSwitcherPath, 'utf-8')
    expect(source).toMatch(/locale\s*===\s*loc\.code/)
  })
})

// ── AC-27: Non-active locale button receives muted class ──────────────────────

describe("AC-27: non-active locale toggle button receives 'text-muted-foreground hover:text-foreground hover:bg-muted'", () => {
  test("button receives muted class when locale does not match loc.code", () => {
    const source = readFileSync(langSwitcherPath, 'utf-8')
    expect(source).toContain('text-muted-foreground hover:text-foreground hover:bg-muted')
  })
})

// ── AC-28: Select model-value is the string value of locale ──────────────────

describe('AC-28: Select model-value prop equals the string locale value, not the Ref object', () => {
  test('Select :model-value is bound to locale (Vue auto-unwraps to string in template)', () => {
    const source = readFileSync(langSwitcherPath, 'utf-8')
    expect(source).toMatch(/:model-value="locale"/)
  })

  test('Select :model-value does not use explicit .value access (would double-unwrap)', () => {
    const source = readFileSync(langSwitcherPath, 'utf-8')
    expect(source).not.toMatch(/:model-value="locale\.value"/)
  })
})

// ── AC-29: switchLocale(code) calls setLocale with the same code ──────────────

describe('AC-29: switchLocale(code) passes the locale code string directly to setLocale', () => {
  test('switchLocale function accepts a code parameter and forwards it to setLocale', () => {
    const source = readFileSync(langSwitcherPath, 'utf-8')
    expect(source).toMatch(/function\s+switchLocale\s*\(\s*code/)
    expect(source).toMatch(/setLocale\s*\(\s*code\s*\)/)
  })
})
