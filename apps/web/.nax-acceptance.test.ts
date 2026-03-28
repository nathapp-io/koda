import { describe, test, expect } from '@jest/globals'
import { readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../../..')
const componentsDir = join(webDir, 'components')
const pagesDir = join(webDir, 'pages')
const composablesDir = join(webDir, 'composables')
const layoutsDir = join(webDir, 'layouts')
const localesDir = join(webDir, 'i18n', 'locales')

// ─────────────────────────────────────────────────────────────────────────────
// US-001 — Fix CommentThread SSR/hydration & stale data
// ─────────────────────────────────────────────────────────────────────────────

describe('AC-1: CommentThread useAsyncData does not use await keyword', () => {
  test('useAsyncData call has no await prefix on the server', () => {
    const source = readFileSync(join(componentsDir, 'CommentThread.vue'), 'utf-8')
    // The fix removes `await` from `const { data, pending, error } = await useAsyncData(...)`
    expect(source).not.toMatch(/await\s+useAsyncData/)
    // useAsyncData itself must still be present
    expect(source).toContain('useAsyncData')
  })
})

describe('AC-2: CommentThread comments is a computed from data.value', () => {
  test('comments is declared as computed(() => data.value ?? [])', () => {
    const source = readFileSync(join(componentsDir, 'CommentThread.vue'), 'utf-8')
    expect(source).toMatch(/computed\s*\(\s*\(\s*\)\s*=>\s*data\.value\s*\?\?\s*\[\]/)
  })
})

describe('AC-3: CommentThread onSubmit calls refreshComments() instead of pushing to comments.value', () => {
  test('onSubmit calls refreshComments() after a successful post', () => {
    const source = readFileSync(join(componentsDir, 'CommentThread.vue'), 'utf-8')
    expect(source).toContain('refreshComments()')
  })

  test('onSubmit does not mutate comments.value directly via push', () => {
    const source = readFileSync(join(componentsDir, 'CommentThread.vue'), 'utf-8')
    expect(source).not.toContain('comments.value.push')
  })
})

describe('AC-4: CommentThread onSubmit calls resetForm() after refreshComments()', () => {
  test('resetForm() is called and appears after refreshComments() in source order', () => {
    const source = readFileSync(join(componentsDir, 'CommentThread.vue'), 'utf-8')
    const refreshIdx = source.indexOf('refreshComments()')
    const resetIdx = source.indexOf('resetForm()')
    expect(refreshIdx).toBeGreaterThanOrEqual(0)
    expect(resetIdx).toBeGreaterThanOrEqual(0)
    expect(resetIdx).toBeGreaterThan(refreshIdx)
  })
})

describe('AC-5: CommentThread template renders loading text via v-if="pending"', () => {
  test('template has a v-if="pending" branch for the loading state', () => {
    const source = readFileSync(join(componentsDir, 'CommentThread.vue'), 'utf-8')
    expect(source).toMatch(/v-if="pending"/)
  })
})

describe('AC-6: CommentThread template renders error text via v-else-if="error"', () => {
  test('template has a v-else-if="error" branch for the error state', () => {
    const source = readFileSync(join(componentsDir, 'CommentThread.vue'), 'utf-8')
    expect(source).toMatch(/v-else-if="error"/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// US-002 — Add loading & error states to all pages
// ─────────────────────────────────────────────────────────────────────────────

describe('AC-7: pages/index.vue renders centered Loading element and hides grid when pending', () => {
  test('template has v-if="pending" loading branch', () => {
    const source = readFileSync(join(pagesDir, 'index.vue'), 'utf-8')
    expect(source).toMatch(/v-if="pending"/)
  })

  test('pending and error are destructured from useAsyncData', () => {
    const source = readFileSync(join(pagesDir, 'index.vue'), 'utf-8')
    expect(source).toMatch(/\{\s*data[^}]*pending[^}]*\}|\{\s*data[^}]*,\s*pending/)
  })
})

describe('AC-8: pages/index.vue renders t("common.loadFailed") and retry Button when error', () => {
  test('template has v-else-if="error" branch', () => {
    const source = readFileSync(join(pagesDir, 'index.vue'), 'utf-8')
    expect(source).toMatch(/v-else-if="error"/)
  })

  test('error branch renders common.loadFailed i18n key', () => {
    const source = readFileSync(join(pagesDir, 'index.vue'), 'utf-8')
    expect(source).toContain("common.loadFailed")
  })

  test('error branch has a Button that calls refresh()', () => {
    const source = readFileSync(join(pagesDir, 'index.vue'), 'utf-8')
    expect(source).toMatch(/<Button[^>]*@click[^>]*refresh\(\)|<Button[^>]*>.*refresh\(\)/)
    // refresh must be referenced somewhere in the error branch
    expect(source).toContain('refresh()')
  })
})

describe('AC-9: pages/[project]/index.vue renders loading state when pending', () => {
  test('template has v-if="pending" loading branch', () => {
    const source = readFileSync(join(pagesDir, '[project]', 'index.vue'), 'utf-8')
    expect(source).toMatch(/v-if="pending"/)
  })
})

describe('AC-10: pages/[project]/index.vue renders error message and retry Button when error', () => {
  test('template has v-else-if="error" error branch', () => {
    const source = readFileSync(join(pagesDir, '[project]', 'index.vue'), 'utf-8')
    expect(source).toMatch(/v-else-if="error"/)
  })

  test('error branch contains a Button element', () => {
    const source = readFileSync(join(pagesDir, '[project]', 'index.vue'), 'utf-8')
    expect(source).toMatch(/<Button/)
  })
})

describe('AC-11: pages/[project]/agents.vue renders loading state when pending', () => {
  test('template has v-if="pending" loading branch', () => {
    const source = readFileSync(join(pagesDir, '[project]', 'agents.vue'), 'utf-8')
    expect(source).toMatch(/v-if="pending"/)
  })
})

describe('AC-12: pages/[project]/agents.vue renders error message and retry Button calling refresh()', () => {
  test('template has v-else-if="error" error branch', () => {
    const source = readFileSync(join(pagesDir, '[project]', 'agents.vue'), 'utf-8')
    expect(source).toMatch(/v-else-if="error"/)
  })

  test('error branch has a Button that calls refresh()', () => {
    const source = readFileSync(join(pagesDir, '[project]', 'agents.vue'), 'utf-8')
    expect(source).toMatch(/<Button/)
    expect(source).toContain('refresh()')
  })
})

describe('AC-13: pages/[project]/labels.vue renders error message and retry Button when error', () => {
  test('template has v-else-if="error" error branch', () => {
    const source = readFileSync(join(pagesDir, '[project]', 'labels.vue'), 'utf-8')
    expect(source).toMatch(/v-else-if="error"/)
  })

  test('error branch contains a Button element', () => {
    const source = readFileSync(join(pagesDir, '[project]', 'labels.vue'), 'utf-8')
    expect(source).toMatch(/<Button/)
  })
})

describe('AC-14: pages/[project]/tickets/[ref].vue uses v-if="pending" for loading (not hardcoded)', () => {
  test('template has v-if="pending" loading branch', () => {
    const source = readFileSync(join(pagesDir, '[project]', 'tickets', '[ref].vue'), 'utf-8')
    expect(source).toMatch(/v-if="pending"/)
  })

  test('loadingTicket text is not rendered in a v-else block (unconditionally when ticket is null)', () => {
    const source = readFileSync(join(pagesDir, '[project]', 'tickets', '[ref].vue'), 'utf-8')
    // The previous bug: `<div v-else ...>{{ t('common.loadingTicket') }}</div>`
    // After fix: loading text must only appear inside v-if="pending" branch, not v-else
    // We detect the specific pattern: v-else immediately followed by loadingTicket
    expect(source).not.toMatch(/v-else[^>]*>[\s\S]{0,200}common\.loadingTicket/)
  })
})

describe('AC-15: pages/[project]/tickets/[ref].vue renders error message and retry Button when error', () => {
  test('template has v-else-if="error" error branch', () => {
    const source = readFileSync(join(pagesDir, '[project]', 'tickets', '[ref].vue'), 'utf-8')
    expect(source).toMatch(/v-else-if="error"/)
  })

  test('error branch contains a Button element', () => {
    const source = readFileSync(join(pagesDir, '[project]', 'tickets', '[ref].vue'), 'utf-8')
    expect(source).toMatch(/<Button/)
  })
})

describe('AC-16: pages/[project]/kb.vue renders loading state when pending', () => {
  test('template has v-if="pending" loading branch', () => {
    const source = readFileSync(join(pagesDir, '[project]', 'kb.vue'), 'utf-8')
    expect(source).toMatch(/v-if="pending"/)
  })
})

describe('AC-17: pages/[project]/kb.vue renders error message and retry Button when error', () => {
  test('template has v-else-if="error" error branch', () => {
    const source = readFileSync(join(pagesDir, '[project]', 'kb.vue'), 'utf-8')
    expect(source).toMatch(/v-else-if="error"/)
  })

  test('error branch contains a Button element', () => {
    const source = readFileSync(join(pagesDir, '[project]', 'kb.vue'), 'utf-8')
    expect(source).toMatch(/<Button/)
  })
})

describe('AC-18: en.json t("common.loadFailed") returns "Failed to load data"', () => {
  test('en.json common.loadFailed equals "Failed to load data"', () => {
    const en = JSON.parse(readFileSync(join(localesDir, 'en.json'), 'utf-8'))
    expect(en.common.loadFailed).toBe('Failed to load data')
  })
})

describe('AC-19: en.json t("common.retry") returns "Retry"', () => {
  test('en.json common.retry equals "Retry"', () => {
    const en = JSON.parse(readFileSync(join(localesDir, 'en.json'), 'utf-8'))
    expect(en.common.retry).toBe('Retry')
  })
})

describe('AC-20: zh.json t("common.loadFailed") returns "加载失败"', () => {
  test('zh.json common.loadFailed equals "加载失败"', () => {
    const zh = JSON.parse(readFileSync(join(localesDir, 'zh.json'), 'utf-8'))
    expect(zh.common.loadFailed).toBe('加载失败')
  })
})

describe('AC-21: zh.json t("common.retry") returns "重试"', () => {
  test('zh.json common.retry equals "重试"', () => {
    const zh = JSON.parse(readFileSync(join(localesDir, 'zh.json'), 'utf-8'))
    expect(zh.common.retry).toBe('重试')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// US-003 — Fix register page layout & error handling
// ─────────────────────────────────────────────────────────────────────────────

describe('AC-22: register.vue outermost element is <div class="w-full max-w-md space-y-8"> with no outer flex wrapper', () => {
  test('template root element does not have flex min-h-screen wrapper', () => {
    const source = readFileSync(join(pagesDir, 'register.vue'), 'utf-8')
    const templateMatch = source.match(/<template>([\s\S]*?)<\/template>/)
    expect(templateMatch).not.toBeNull()
    const templateContent = templateMatch![1].trim()
    // The outer flex min-h-screen wrapper must be gone (auth layout provides it)
    expect(templateContent).not.toMatch(/flex\s+min-h-screen/)
  })

  test('template root element has class "w-full max-w-md space-y-8"', () => {
    const source = readFileSync(join(pagesDir, 'register.vue'), 'utf-8')
    expect(source).toMatch(/w-full max-w-md space-y-8/)
  })
})

describe('AC-23: register.vue calls toast.error(extractApiError(err)) on handleRegister error', () => {
  test('catch block calls toast.error(extractApiError(err))', () => {
    const source = readFileSync(join(pagesDir, 'register.vue'), 'utf-8')
    expect(source).toMatch(/toast\.error\s*\(\s*extractApiError\s*\(/)
  })
})

describe('AC-24: register.vue calls toast.success(t("toast.loggedIn")) before navigateTo("/") on success', () => {
  test('handleRegister calls toast.success with toast.loggedIn key', () => {
    const source = readFileSync(join(pagesDir, 'register.vue'), 'utf-8')
    expect(source).toMatch(/toast\.success\s*\(\s*t\s*\(\s*['"]toast\.loggedIn['"]\s*\)/)
  })

  test('toast.success call appears before navigateTo in source order', () => {
    const source = readFileSync(join(pagesDir, 'register.vue'), 'utf-8')
    const toastIdx = source.indexOf('toast.success')
    const navigateIdx = source.indexOf("navigateTo('/')")
    expect(toastIdx).toBeGreaterThanOrEqual(0)
    expect(navigateIdx).toBeGreaterThanOrEqual(0)
    expect(toastIdx).toBeLessThan(navigateIdx)
  })
})

describe('AC-25: register.vue imports toast from "vue-sonner"', () => {
  test('script section has: import { toast } from "vue-sonner"', () => {
    const source = readFileSync(join(pagesDir, 'register.vue'), 'utf-8')
    expect(source).toMatch(/import\s*\{[^}]*\btoast\b[^}]*\}\s*from\s*['"]vue-sonner['"]/)
  })
})

describe('AC-26: register.vue has no error ref variable', () => {
  test('script section does not declare: const error = ref(...)', () => {
    const source = readFileSync(join(pagesDir, 'register.vue'), 'utf-8')
    expect(source).not.toMatch(/const\s+error\s*=\s*ref\s*\(/)
  })
})

describe('AC-27: register.vue template has no v-if="error" banner div', () => {
  test('template does not contain v-if="error"', () => {
    const source = readFileSync(join(pagesDir, 'register.vue'), 'utf-8')
    expect(source).not.toMatch(/v-if="error"/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// US-004 — Make logout async & remove duplicate sidebar user section
// ─────────────────────────────────────────────────────────────────────────────

describe('AC-28: useAuth logout() is declared async and returns Promise<void>', () => {
  test('logout function is declared with async keyword', () => {
    const source = readFileSync(join(composablesDir, 'useAuth.ts'), 'utf-8')
    expect(source).toMatch(/async\s+function\s+logout\s*\(\s*\)/)
  })
})

describe('AC-29: useAuth logout() sets token.value = null and user.value = null before navigateTo', () => {
  test('token.value = null appears before navigateTo call', () => {
    const source = readFileSync(join(composablesDir, 'useAuth.ts'), 'utf-8')
    // Find first occurrence of both within the logout function body
    const logoutBodyStart = source.indexOf('async function logout')
    expect(logoutBodyStart).toBeGreaterThanOrEqual(0)
    const afterLogout = source.slice(logoutBodyStart)
    const tokenIdx = afterLogout.indexOf('token.value = null')
    const navigateIdx = afterLogout.indexOf('navigateTo')
    expect(tokenIdx).toBeGreaterThanOrEqual(0)
    expect(navigateIdx).toBeGreaterThanOrEqual(0)
    expect(tokenIdx).toBeLessThan(navigateIdx)
  })

  test('user.value = null appears before navigateTo call', () => {
    const source = readFileSync(join(composablesDir, 'useAuth.ts'), 'utf-8')
    const logoutBodyStart = source.indexOf('async function logout')
    expect(logoutBodyStart).toBeGreaterThanOrEqual(0)
    const afterLogout = source.slice(logoutBodyStart)
    const userIdx = afterLogout.indexOf('user.value = null')
    const navigateIdx = afterLogout.indexOf('navigateTo')
    expect(userIdx).toBeGreaterThanOrEqual(0)
    expect(navigateIdx).toBeGreaterThanOrEqual(0)
    expect(userIdx).toBeLessThan(navigateIdx)
  })
})

describe('AC-30: useAuth logout() awaits navigateTo("/login")', () => {
  test('logout body uses: await navigateTo("/login")', () => {
    const source = readFileSync(join(composablesDir, 'useAuth.ts'), 'utf-8')
    expect(source).toMatch(/await\s+navigateTo\s*\(\s*['"]\/login['"]\s*\)/)
  })
})

describe('AC-31: default.vue sidebar has no <div class="border-t border-border p-4"> user/logout section', () => {
  test('sidebar does not contain the duplicate border-t p-4 user section', () => {
    const source = readFileSync(join(layoutsDir, 'default.vue'), 'utf-8')
    // The duplicate bottom user section had exactly this class on the wrapper div
    expect(source).not.toMatch(/class="border-t border-border p-4"/)
  })
})

describe('AC-32: default.vue sidebar nav links section is still present and unchanged', () => {
  test('sidebar nav still contains NuxtLink elements', () => {
    const source = readFileSync(join(layoutsDir, 'default.vue'), 'utf-8')
    expect(source).toMatch(/<NuxtLink/)
  })

  test('sidebar nav still contains nav.dashboard and nav.projects links', () => {
    const source = readFileSync(join(layoutsDir, 'default.vue'), 'utf-8')
    expect(source).toContain("nav.dashboard")
    expect(source).toContain("nav.projects")
  })
})

describe('AC-33: default.vue header still has user email span and logout button', () => {
  test('header contains auth.user.value?.email span', () => {
    const source = readFileSync(join(layoutsDir, 'default.vue'), 'utf-8')
    expect(source).toContain('auth.user.value?.email')
  })

  test('header contains logout button calling auth.logout()', () => {
    const source = readFileSync(join(layoutsDir, 'default.vue'), 'utf-8')
    expect(source).toMatch(/auth\.logout\(\)/)
    expect(source).toContain('common.logout')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// US-005 — Use internal API URL for SSR requests
// ─────────────────────────────────────────────────────────────────────────────

describe('AC-34: useApi() on server uses useRuntimeConfig().apiInternalUrl as baseURL', () => {
  test('useApi.ts reads apiInternalUrl from runtimeConfig', () => {
    const source = readFileSync(join(composablesDir, 'useApi.ts'), 'utf-8')
    expect(source).toContain('apiInternalUrl')
  })

  test('useApi.ts conditionally selects baseURL via import.meta.server', () => {
    const source = readFileSync(join(composablesDir, 'useApi.ts'), 'utf-8')
    expect(source).toMatch(/import\.meta\.server/)
  })
})

describe('AC-35: useApi() on client uses useRuntimeConfig().public.apiBaseUrl as baseURL', () => {
  test('useApi.ts still references public.apiBaseUrl for client-side URL', () => {
    const source = readFileSync(join(composablesDir, 'useApi.ts'), 'utf-8')
    expect(source).toMatch(/public\.apiBaseUrl/)
  })

  test('useApi.ts baseURL selection uses ternary or conditional on import.meta.server', () => {
    const source = readFileSync(join(composablesDir, 'useApi.ts'), 'utf-8')
    // Must have both the server check and both URL options
    expect(source).toMatch(/import\.meta\.server/)
    expect(source).toMatch(/apiInternalUrl/)
    expect(source).toMatch(/public\.apiBaseUrl/)
  })
})

describe('AC-36: useAuth() on server uses useRuntimeConfig().apiInternalUrl as baseURL', () => {
  test('useAuth.ts reads apiInternalUrl from runtimeConfig', () => {
    const source = readFileSync(join(composablesDir, 'useAuth.ts'), 'utf-8')
    expect(source).toContain('apiInternalUrl')
  })

  test('useAuth.ts conditionally selects baseURL via import.meta.server', () => {
    const source = readFileSync(join(composablesDir, 'useAuth.ts'), 'utf-8')
    expect(source).toMatch(/import\.meta\.server/)
  })
})

describe('AC-37: useAuth() on client uses useRuntimeConfig().public.apiBaseUrl as baseURL', () => {
  test('useAuth.ts references public.apiBaseUrl for client-side URL', () => {
    const source = readFileSync(join(composablesDir, 'useAuth.ts'), 'utf-8')
    expect(source).toMatch(/public\.apiBaseUrl/)
  })
})

describe('AC-38: useAuth.ts constructs auth/login URL using apiInternalUrl during SSR', () => {
  test('login call uses baseURL variable that resolves to apiInternalUrl on server', () => {
    const source = readFileSync(join(composablesDir, 'useAuth.ts'), 'utf-8')
    // baseURL is computed with import.meta.server ? apiInternalUrl : apiBaseUrl
    expect(source).toMatch(/import\.meta\.server/)
    expect(source).toMatch(/apiInternalUrl/)
    // login fetch uses ${baseURL}/auth/login
    expect(source).toMatch(/\$\{baseURL\}\/auth\/login/)
  })
})

describe('AC-39: useApi.ts constructs GET request URL using apiInternalUrl during SSR', () => {
  test('GET path is prefixed with baseURL that resolves to apiInternalUrl on server', () => {
    const source = readFileSync(join(composablesDir, 'useApi.ts'), 'utf-8')
    // baseURL is computed with import.meta.server ? apiInternalUrl : apiBaseUrl
    expect(source).toMatch(/import\.meta\.server/)
    expect(source).toMatch(/apiInternalUrl/)
    // get() helper prefixes path with baseURL: `${baseURL}${path}`
    expect(source).toMatch(/\`\$\{baseURL\}\$\{path\}\`|\$\{baseURL\}\$\{path\}/)
  })
})