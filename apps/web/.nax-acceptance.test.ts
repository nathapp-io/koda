import { describe, test, expect, beforeEach } from '@jest/globals'
import { readFileSync } from 'fs'
import { join } from 'path'
import { ref, computed } from 'vue'

// ── Paths (3 levels up from .nax/features/web-auth-security/ → apps/web) ─────

const webDir = join(__dirname, '../../..')
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
  test('AC-1: useCookie receives { secure: true } as second argument when initializing the token cookie', async () => {
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
  test("AC-2: useCookie receives { sameSite: 'strict' } as second argument when initializing the token cookie", async () => {
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
  test('AC-3: useCookie receives { maxAge: 604800 } as second argument when initializing the token cookie', async () => {
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
  test('AC-4: token.value equals the accessToken string returned by the API after login() resolves', async () => {
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
  test('AC-5: token.value is null after logout() is called', async () => {
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
  test('AC-6: fetchUser returns true and sets user.value to the AuthUser from the API response', async () => {
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
  test('AC-7: fetchUser returns false and does not call $fetch when token.value is null', async () => {
    const env = makeFakeEnv()
    // tokenRef.value is null by default in makeFakeEnv
    applyNuxtGlobals(env)
    const mod = await import(authPath)
    const auth = mod.useAuth()
    const result = await auth.fetchUser()
    expect(result).toBe(false)
    expect(env.fetchMock).not.toHaveBeenCalled()
  })
})

// ── AC-8: Empty body triggers validation; $api.post is not called ─────────────

describe('AC-8: empty body field triggers form validation and $api.post is not called', () => {
  test('AC-8: CommentThread body field uses z.string().min(1) and handleSubmit gates the API call', () => {
    const source = readFileSync(commentThreadPath, 'utf-8')
    // Zod schema must require a non-empty body
    expect(source).toMatch(/body\s*:\s*z\.string\(\)\.min\s*\(\s*1/)
    // handleSubmit from vee-validate blocks $api.post when validation fails
    expect(source).toContain('handleSubmit')
    expect(source).toContain('$api.post')
  })
})

// ── AC-9: Valid body calls $api.post with body and type values ────────────────

describe('AC-9: valid body and type call $api.post with body and type from form values', () => {
  test('AC-9: $api.post receives body and type extracted from the validated form values', () => {
    const source = readFileSync(commentThreadPath, 'utf-8')
    expect(source).toMatch(/body\s*:\s*values\.body/)
    expect(source).toMatch(/type\s*:\s*values\.type/)
  })
})

// ── AC-10: Invalid type triggers validation; $api.post is not called ──────────

describe("AC-10: type value not in ['GENERAL','VERIFICATION','FIX_REPORT','REVIEW'] triggers validation", () => {
  test("AC-10: type field schema is z.enum containing all four allowed comment types", () => {
    const source = readFileSync(commentThreadPath, 'utf-8')
    expect(source).toContain("z.enum(['GENERAL', 'VERIFICATION', 'FIX_REPORT', 'REVIEW'])")
  })
})

// ── AC-11: Successful comment resets form to initial values ───────────────────

describe("AC-11: successful comment submission calls resetForm() resetting body to '' and type to 'GENERAL'", () => {
  test("AC-11: resetForm() is called on success and initialValues define body: '' and type: 'GENERAL'", () => {
    const source = readFileSync(commentThreadPath, 'utf-8')
    expect(source).toContain('resetForm()')
    expect(source).toMatch(/body\s*:\s*['"]['"]/)
    expect(source).toContain("type: 'GENERAL'")
  })
})

// ── AC-12: CreateTicketDialog resets title to '' on success ──────────────────

describe("AC-12: CreateTicketDialog onSubmit() success calls resetForm() and restores title to ''", () => {
  test("AC-12: resetForm is destructured and called in onSubmit; initialValues has title: ''", () => {
    const source = readFileSync(createTicketPath, 'utf-8')
    // resetForm must be destructured from useForm
    expect(source).toMatch(/\bresetForm\b/)
    // resetForm() must be invoked in the success path
    expect(source).toMatch(/resetForm\s*\(/)
    // initialValues must define an empty title so reset restores to ''
    expect(source).toMatch(/title\s*:\s*['"]['"]/)
  })
})

// ── AC-13: CreateTicketDialog resets type to '' on success ───────────────────

describe("AC-13: CreateTicketDialog onSubmit() success calls resetForm() and restores type to ''", () => {
  test("AC-13: resetForm is called in onSubmit; initialValues has type: ''", () => {
    const source = readFileSync(createTicketPath, 'utf-8')
    expect(source).toMatch(/resetForm\s*\(/)
    expect(source).toMatch(/type\s*:\s*['"]['"]/)
  })
})

// ── AC-14: CreateTicketDialog resets priority to 'MEDIUM' on success ─────────

describe("AC-14: CreateTicketDialog onSubmit() success calls resetForm() and restores priority to 'MEDIUM'", () => {
  test("AC-14: resetForm is called in onSubmit; initialValues has priority: 'MEDIUM'", () => {
    const source = readFileSync(createTicketPath, 'utf-8')
    expect(source).toMatch(/resetForm\s*\(/)
    expect(source).toMatch(/priority\s*:\s*['"]MEDIUM['"]/)
  })
})

// ── AC-15: CreateTicketDialog resets description to '' on success ─────────────

describe("AC-15: CreateTicketDialog onSubmit() success calls resetForm() and restores description to ''", () => {
  test("AC-15: resetForm is called in onSubmit; initialValues has description: ''", () => {
    const source = readFileSync(createTicketPath, 'utf-8')
    expect(source).toMatch(/resetForm\s*\(/)
    expect(source).toMatch(/description\s*:\s*['"]['"]/)
  })
})

// ── AC-16: CreateProjectDialog resets name to '' on success ──────────────────

describe("AC-16: CreateProjectDialog onSubmit() success calls resetForm() and restores name to ''", () => {
  test("AC-16: resetForm is destructured and called in onSubmit; initialValues has name: ''", () => {
    const source = readFileSync(createProjectPath, 'utf-8')
    expect(source).toMatch(/\bresetForm\b/)
    expect(source).toMatch(/resetForm\s*\(/)
    expect(source).toMatch(/name\s*:\s*['"]['"]/)
  })
})

// ── AC-17: CreateProjectDialog resets slug to '' on success ──────────────────

describe("AC-17: CreateProjectDialog onSubmit() success calls resetForm() and restores slug to ''", () => {
  test("AC-17: resetForm is called in onSubmit; initialValues has slug: ''", () => {
    const source = readFileSync(createProjectPath, 'utf-8')
    expect(source).toMatch(/resetForm\s*\(/)
    expect(source).toMatch(/slug\s*:\s*['"]['"]/)
  })
})

// ── AC-18: CreateProjectDialog resets key to '' on success ───────────────────

describe("AC-18: CreateProjectDialog onSubmit() success calls resetForm() and restores key to ''", () => {
  test("AC-18: resetForm is called in onSubmit; initialValues has key: ''", () => {
    const source = readFileSync(createProjectPath, 'utf-8')
    expect(source).toMatch(/resetForm\s*\(/)
    expect(source).toMatch(/key\s*:\s*['"]['"]/)
  })
})

// ── AC-19: TicketActionPanel uses ApiError.firstError via extractApiError ─────

describe("AC-19: TicketActionPanel performAction() calls toast.error with ApiError's firstError via extractApiError", () => {
  test('AC-19: TicketActionPanel uses extractApiError and toast.error receives its return value', () => {
    const source = readFileSync(ticketActionPath, 'utf-8')
    expect(source).toContain('extractApiError')
    expect(source).toMatch(/toast\.error\s*\(\s*extractApiError/)
  })
})

// ── AC-20: CreateTicketDialog uses extractApiError for ApiError ───────────────

describe('AC-20: CreateTicketDialog onSubmit() calls toast.error with extractApiError for ApiError field errors', () => {
  test('AC-20: CreateTicketDialog uses extractApiError and toast.error receives its return value', () => {
    const source = readFileSync(createTicketPath, 'utf-8')
    expect(source).toContain('extractApiError')
    expect(source).toMatch(/toast\.error\s*\(\s*extractApiError/)
  })
})

// ── AC-21: CreateProjectDialog uses extractApiError for ApiError ──────────────

describe('AC-21: CreateProjectDialog onSubmit() calls toast.error with extractApiError for ApiError field errors', () => {
  test('AC-21: CreateProjectDialog uses extractApiError and toast.error receives its return value', () => {
    const source = readFileSync(createProjectPath, 'utf-8')
    expect(source).toContain('extractApiError')
    expect(source).toMatch(/toast\.error\s*\(\s*extractApiError/)
  })
})

// ── AC-22: CommentThread uses extractApiError instead of err.message ──────────

describe('AC-22: CommentThread onSubmit() calls toast.error with extractApiError(err) not err.message', () => {
  test('AC-22: CommentThread uses extractApiError and toast.error receives its return value', () => {
    const source = readFileSync(commentThreadPath, 'utf-8')
    expect(source).toContain('extractApiError')
    expect(source).toMatch(/toast\.error\s*\(\s*extractApiError/)
  })
})

// ── AC-23: labels.vue onSubmit() uses extractApiError; no console.error ───────

describe('AC-23: labels.vue onSubmit() calls toast.error with extractApiError(err) and does not call console.error', () => {
  test('AC-23: labels.vue uses extractApiError in toast.error and has no console.error calls', () => {
    const source = readFileSync(labelsPath, 'utf-8')
    expect(source).toContain('extractApiError')
    expect(source).toMatch(/toast\.error\s*\(\s*extractApiError/)
    expect(source).not.toContain('console.error')
  })
})

// ── AC-24: labels.vue deleteLabel() uses extractApiError; no console.error ────

describe('AC-24: labels.vue deleteLabel() calls toast.error with extractApiError(err) and does not call console.error', () => {
  test('AC-24: labels.vue deleteLabel catch uses extractApiError and has no console.error calls', () => {
    const source = readFileSync(labelsPath, 'utf-8')
    // extractApiError must be used (covers both onSubmit and deleteLabel catch blocks)
    expect(source).toContain('extractApiError')
    // No console.error anywhere in the file
    expect(source).not.toContain('console.error')
    // deleteLabel catch must not fall back to a hardcoded i18n key
    expect(source).not.toMatch(/toast\.error\s*\(\s*t\s*\(\s*['"]labels\.toast\.deleteFailed/)
  })
})

// ── AC-25: extractApiError returns error.message for a plain Error ─────────────

describe('AC-25: extractApiError returns error.message for a caught generic Error', () => {
  test('AC-25: extractApiError with a plain Error instance returns error.message as the display string', async () => {
    const mod = await import(apiPath)
    const { extractApiError } = mod
    const err = new Error('plain error message')
    expect(extractApiError(err)).toBe('plain error message')
  })
})

// ── AC-26: Active locale button receives highlighted class ────────────────────

describe("AC-26: active locale toggle button receives 'bg-primary text-primary-foreground font-medium' when locale matches", () => {
  test("AC-26: active button class includes 'bg-primary text-primary-foreground font-medium' based on locale === loc.code", () => {
    const source = readFileSync(langSwitcherPath, 'utf-8')
    expect(source).toContain('bg-primary text-primary-foreground font-medium')
    expect(source).toMatch(/locale\s*===\s*loc\.code/)
  })
})

// ── AC-27: Non-active locale button receives muted class ──────────────────────

describe("AC-27: non-active locale toggle button receives 'text-muted-foreground hover:text-foreground hover:bg-muted'", () => {
  test("AC-27: non-active button class includes 'text-muted-foreground hover:text-foreground hover:bg-muted'", () => {
    const source = readFileSync(langSwitcherPath, 'utf-8')
    expect(source).toContain('text-muted-foreground hover:text-foreground hover:bg-muted')
  })
})

// ── AC-28: Select model-value is the string value of locale ──────────────────

describe('AC-28: Select model-value prop equals the string locale value, not the Ref object', () => {
  test('AC-28: Select :model-value is bound to locale (Vue unwraps to string in template, not a raw Ref)', () => {
    const source = readFileSync(langSwitcherPath, 'utf-8')
    // Template must bind locale directly (Vue auto-unwraps ref to string)
    expect(source).toMatch(/:model-value="locale"/)
    // Must not explicitly access .value (which would be redundant and confusing)
    expect(source).not.toMatch(/:model-value="locale\.value"/)
  })
})

// ── AC-29: switchLocale(code) calls setLocale with the same code ──────────────

describe('AC-29: switchLocale(code) passes the locale code string directly to setLocale', () => {
  test('AC-29: switchLocale function accepts a code parameter and calls setLocale with that same code', () => {
    const source = readFileSync(langSwitcherPath, 'utf-8')
    expect(source).toMatch(/function\s+switchLocale\s*\(\s*code/)
    expect(source).toMatch(/setLocale\s*\(\s*code\s*\)/)
  })
})