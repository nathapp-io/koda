import { describe, test, expect, jest } from '@jest/globals'
import { readFileSync } from 'fs'
import { join } from 'path'
import { ref, computed } from 'vue'

const webDir = join(__dirname, '..')
const composablePath = join(webDir, 'composables', 'useAuth.ts')
const layoutPath = join(webDir, 'layouts', 'default.vue')

// ──────────────────────────────────────────────────────────────────────────────
// Helpers to build a controllable fake Nuxt environment
// ──────────────────────────────────────────────────────────────────────────────

function makeFakeEnv() {
  const tokenRef = ref<string | null>(null)
  const userRef = ref<unknown>(null)
  const navigateToMock = jest.fn().mockResolvedValue(undefined)
  const fakeRuntimeConfig = () => ({
    public: {
      apiBaseUrl: 'http://localhost:3000',
    },
  })
  const fetchMock = jest.fn((_url: string, _opts?: Record<string, unknown>) =>
    Promise.resolve({ accessToken: 'mock-jwt', user: { id: 1, email: 'a@b.com' } })
  )

  const fakeCookie = (name: string, _opts?: unknown) => {
    if (name === 'koda_token') return tokenRef
    return ref<string | null>(null)
  }

  const fakeState = (key: string, init?: () => unknown) => {
    if (key === 'koda_user') return userRef
    return ref(typeof init === 'function' ? init() : null)
  }

  return {
    tokenRef,
    userRef,
    fetchMock,
    fakeCookie,
    fakeState,
    fakeRuntimeConfig,
    navigateToMock,
  }
}

function applyNuxtGlobals(env: ReturnType<typeof makeFakeEnv>) {
  (globalThis as Record<string, unknown>).useCookie = env.fakeCookie
  ;(globalThis as Record<string, unknown>).useState = env.fakeState
  ;(globalThis as Record<string, unknown>).computed = computed
  ;(globalThis as Record<string, unknown>).$fetch = env.fetchMock
  ;(globalThis as Record<string, unknown>).useRuntimeConfig = env.fakeRuntimeConfig
  ;(globalThis as Record<string, unknown>).navigateTo = env.navigateToMock
}

// ──────────────────────────────────────────────────────────────────────────────
// US-004 AC1 — logout() returns Promise<void>
// ──────────────────────────────────────────────────────────────────────────────

describe('US-004 AC1: logout() returns Promise<void>', () => {
  test('source defines logout as async function with Promise<void> return type', () => {
    const source = readFileSync(composablePath, 'utf-8')
    // Check for async function logout with Promise<void> return type
    expect(source).toMatch(/async\s+function\s+logout.*:\s*Promise\s*<\s*void\s*>/)
  })

  test('logout() returns a promise that resolves', async () => {
    const env = makeFakeEnv()
    const { tokenRef, userRef } = env

    tokenRef.value = 'existing-jwt'
    userRef.value = { id: 1, email: 'a@b.com' }

    applyNuxtGlobals(env)

    const mod = await import(`${composablePath}`)
    const auth = mod.useAuth()

    const result = auth.logout()
    expect(result).toBeInstanceOf(Promise)

    await result
    expect(env.navigateToMock).toHaveBeenCalledWith('/login')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// US-004 AC2 — logout() sets token and user to null BEFORE navigateTo
// ──────────────────────────────────────────────────────────────────────────────

describe('US-004 AC2: logout() sets token and user to null before navigateTo', () => {
  test('logout() sets token.value to null', async () => {
    const env = makeFakeEnv()
    const { tokenRef, userRef } = env

    tokenRef.value = 'existing-jwt'
    userRef.value = { id: 1, email: 'a@b.com' }

    applyNuxtGlobals(env)

    const mod = await import(`${composablePath}`)
    const auth = mod.useAuth()

    await auth.logout()

    expect(tokenRef.value).toBeNull()
  })

  test('logout() sets user.value to null', async () => {
    const env = makeFakeEnv()
    const { tokenRef, userRef } = env

    tokenRef.value = 'existing-jwt'
    userRef.value = { id: 1, email: 'a@b.com' }

    applyNuxtGlobals(env)

    const mod = await import(`${composablePath}`)
    const auth = mod.useAuth()

    await auth.logout()

    expect(userRef.value).toBeNull()
  })

  test('logout() nullifies state before calling navigateTo', async () => {
    const env = makeFakeEnv()
    const { tokenRef, userRef } = env

    let tokenWasNullAtNavigateTo = false
    let userWasNullAtNavigateTo = false

    env.navigateToMock.mockImplementation(() => {
      tokenWasNullAtNavigateTo = tokenRef.value === null
      userWasNullAtNavigateTo = userRef.value === null
      return Promise.resolve()
    })

    tokenRef.value = 'existing-jwt'
    userRef.value = { id: 1, email: 'a@b.com' }

    applyNuxtGlobals(env)

    const mod = await import(`${composablePath}`)
    const auth = mod.useAuth()

    await auth.logout()

    expect(tokenWasNullAtNavigateTo).toBe(true)
    expect(userWasNullAtNavigateTo).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// US-004 AC3 — logout() awaits navigateTo (not fire-and-forget)
// ──────────────────────────────────────────────────────────────────────────────

describe('US-004 AC3: logout() awaits navigateTo (not fire-and-forget)', () => {
  test('logout() awaits navigateTo("/login")', async () => {
    const env = makeFakeEnv()
    const { tokenRef, userRef } = env

    let navigateToWasCalled = false
    let navigateToResolvedBeforeLogoutReturned = false

    env.navigateToMock.mockImplementation(() => {
      navigateToWasCalled = true
      return new Promise((resolve) => {
        setTimeout(() => {
          navigateToResolvedBeforeLogoutReturned = true
          resolve(undefined)
        }, 10)
      })
    })

    tokenRef.value = 'existing-jwt'
    userRef.value = { id: 1, email: 'a@b.com' }

    applyNuxtGlobals(env)

    const mod = await import(`${composablePath}`)
    const auth = mod.useAuth()

    await auth.logout()

    expect(navigateToWasCalled).toBe(true)
    expect(navigateToResolvedBeforeLogoutReturned).toBe(true)
  })

  test('logout() source contains "await navigateTo"', () => {
    const source = readFileSync(composablePath, 'utf-8')
    expect(source).toContain('await navigateTo')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// US-004 AC4 — sidebar does NOT have duplicate user section
// ──────────────────────────────────────────────────────────────────────────────

describe('US-004 AC4: default.vue sidebar does not have duplicate user section', () => {
  test('sidebar has no "border-t border-border p-4" div with user email', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    // Ensure user email/logout is not in a sidebar bottom section
    const hasSidebarUserSection = source.match(
      /<aside[^>]*>[\s\S]*?<div[^>]*class="[^"]*border-t\s+border-border\s+p-4[^"]*"[\s\S]*?<\/div>[\s\S]*?<\/aside>/
    )
    expect(hasSidebarUserSection).toBeNull()
  })

  test('sidebar still has navigation links (NuxtLink elements)', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    // Extract the aside section
    const asideMatch = source.match(/<aside[\s\S]*?<\/aside>/)
    expect(asideMatch).not.toBeNull()
    const asideContent = asideMatch?.[0] || ''
    expect(asideContent).toContain('NuxtLink')
    expect(asideContent).toContain("t('nav.dashboard')")
    expect(asideContent).toContain("t('nav.projects')")
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// US-004 AC5 — header still has user email and logout button
// ──────────────────────────────────────────────────────────────────────────────

describe('US-004 AC5: default.vue header has user email and logout button', () => {
  test('header renders user email span', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    // Check for user email display in header
    expect(source).toMatch(/<header[\s\S]*?<span[^>]*>[\s\S]*?auth\.user\.value\?\.email[\s\S]*?<\/span>[\s\S]*?<\/header>/)
  })

  test('header has logout button calling auth.logout()', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    // Check for logout button in header section
    expect(source).toMatch(/<header[\s\S]*?@click="auth\.logout\(\)"[\s\S]*?<\/header>/)
  })

  test('logout button has i18n label', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    // Extract header section
    const headerMatch = source.match(/<header[\s\S]*?<\/header>/)
    expect(headerMatch).not.toBeNull()
    const headerContent = headerMatch?.[0] || ''
    expect(headerContent).toContain("t('common.logout')")
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// US-004 AC6 — no console.log in modified files
// ──────────────────────────────────────────────────────────────────────────────

describe('US-004: no console.log in modified files', () => {
  test('useAuth.ts has no console.log', () => {
    const source = readFileSync(composablePath, 'utf-8')
    expect(source).not.toContain('console.log')
  })

  test('default.vue has no console.log', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    expect(source).not.toContain('console.log')
  })
})
