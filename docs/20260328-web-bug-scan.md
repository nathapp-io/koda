# Web Bug Scan — Koda (`apps/web`)

**Date:** 2026-03-28
**Scope:** All `.vue` and `.ts` source files in `apps/web/` (excluding `generated/`, `.nuxt/`, `node_modules/`, `tests/`)
**Reviewer:** Deep automated scan

---

## Summary

| Severity  | Count |
|-----------|-------|
| CRITICAL  | 2     |
| HIGH      | 7     |
| MEDIUM    | 6     |
| LOW       | 4     |
| **Total** | **19** |

---

## CRITICAL

---

### BUG-1 — Auth middleware is not global and never runs

**File:** `apps/web/middleware/auth.ts`
**Severity:** CRITICAL

**Description:**
The middleware file is named `auth.ts`, not `auth.global.ts`. In Nuxt 3, only files named `*.global.ts` are automatically applied to every route. Named middleware (e.g., `auth.ts`) must be explicitly declared in each page via `definePageMeta({ middleware: 'auth' })`. No page in this codebase calls that. As a result, **the auth middleware never runs**, and unauthenticated users can freely access every protected page.

Additionally, the two-bug context at the top of this scan mentions this was a known regression — it was fixed previously but the fix may not have been committed, as the file is still `auth.ts` (not `auth.global.ts`).

**Impact:** Complete authentication bypass. Every page except login/register is unprotected. An unauthenticated visitor navigating directly to `/`, `/<project>`, `/<project>/tickets/<ref>`, etc., will not be redirected to `/login`.

**Fix:** Rename `middleware/auth.ts` to `middleware/auth.global.ts`. No page-level `definePageMeta` changes needed — global middleware runs on all routes automatically.

---

### BUG-2 — `useApi` uses `/api` (public relative path) during SSR, causing absolute-URL failures on the server

**File:** `apps/web/composables/useApi.ts` (line 89), `apps/web/composables/useAuth.ts` (line 31)
**Severity:** CRITICAL

**Description:**
Both `useApi` and `useAuth` read `config.public.apiBaseUrl`, which is always `/api` (a relative path). During SSR, `$fetch('/api/...')` resolves relative to `http://localhost:3101` (the Nuxt dev server), **not** to the internal API service. The `nuxt.config.ts` correctly defines a `runtimeConfig.apiInternalUrl` for server-side use and a `routeRules` proxy for browser requests, but `useApi`/`useAuth` never use `apiInternalUrl` on the server side.

This means all `useAsyncData` calls (which run on the server during SSR) will attempt to reach `/api` as a relative path on the Nuxt server — which in Docker works only because the proxy is set up via `routeRules`, but this is a round-trip through the proxy instead of a direct internal call. More importantly, `useAuth.login()` and `useAuth.register()` use `$fetch` directly with `config.public.apiBaseUrl`, which will also resolve incorrectly if called server-side.

**Impact:** On non-Docker environments or direct node invocations (e.g., `nuxt preview`, SSR unit tests), API calls from server-side rendering context may fail or return unexpected results. In Docker the proxy round-trip works but adds latency to every server-rendered page.

**Fix:** In `useApi.ts` and `useAuth.ts`, detect the server vs. client context and use `config.apiInternalUrl` (server) vs. `config.public.apiBaseUrl` (client):
```ts
const baseURL = import.meta.server
  ? useRuntimeConfig().apiInternalUrl
  : useRuntimeConfig().public.apiBaseUrl
```

---

## HIGH

---

### BUG-3 — `CommentThread` uses `await useAsyncData` at component top level — SSR/hydration hazard

**File:** `apps/web/components/CommentThread.vue` (line 29)
**Severity:** HIGH

**Description:**
`useAsyncData` is called with `await` at the top level of a `<script setup>` component:
```ts
const { data, pending, error } = await useAsyncData<Comment[]>(...)
```
Using `await` on `useAsyncData` in a non-page component (not a page with Nuxt's Suspense boundary) means the component is async. This is only safe in Nuxt when the consuming parent wraps the component in `<Suspense>`. The `[ref].vue` page renders `<CommentThread>` without any `<Suspense>` wrapper.

In Nuxt 3, async components in non-page contexts require explicit `<Suspense>` handling; without it, the component may silently not render on SSR, or cause a hydration mismatch (empty comments list on SSR, populated on client). The initial assignment `comments.value = data.value ?? []` runs once at setup time and never updates if `refresh()` is called — `comments` is a separate `ref` decoupled from `data`.

**Impact:**
1. SSR may return an empty comment list (no Suspense boundary, async component falls back silently).
2. After `refresh()` calls, `data.value` is updated but `comments.value` is not — new data never appears unless the page fully remounts.
3. Potential hydration mismatch: server renders empty, client re-fetches and populates, causing a visible flash.

**Fix:**
- Remove `await` from `useAsyncData` call.
- Replace the one-time `comments.value = data.value ?? []` assignment with a `computed`: `const comments = computed(() => data.value ?? [])`. Or use a `watch` on `data` to keep `comments` in sync.
- Wrap `<CommentThread>` in `<Suspense>` in the parent page if async behavior is intentional.

---

### BUG-4 — `CommentThread` comment schema lacks `toTypedSchema` wrapper — vee-validate validation silently does nothing

**File:** `apps/web/components/CommentThread.vue` (lines 44-47, 49-55)
**Severity:** HIGH

**Description:**
The form uses a raw Zod schema as `validationSchema` in `useForm`, but never calls `toTypedSchema()` on it:
```ts
// WRONG — raw Zod object passed directly
const commentSchema = z.object({ ... })
const { handleSubmit, resetForm } = useForm({
  validationSchema: commentSchema,
  ...
})
```
`vee-validate` 4.x expects the schema to be wrapped with `toTypedSchema()` (from `@vee-validate/zod`) to be usable as a validation schema. Without `toTypedSchema`, the schema is passed as an unknown object and vee-validate will not validate the fields. The `body` field (required, min 1) will never trigger a validation error.

**Impact:** Users can submit the comment form with an empty body. The API will return an error, but the form shows no validation feedback in-place. The `body: z.string().min(1, ...)` constraint is completely ignored on the client.

**Fix:** Import `toTypedSchema` from `@vee-validate/zod` and wrap the schema:
```ts
import { toTypedSchema } from '@vee-validate/zod'
const commentSchema = toTypedSchema(z.object({
  body: z.string().min(1, t('comments.validation.bodyRequired')),
  type: z.enum(['GENERAL', 'VERIFICATION', 'FIX_REPORT', 'REVIEW']),
}))
```

---

### BUG-5 — `CreateTicketDialog` and `CreateProjectDialog` do not reset the form on success — stale values on reopen

**File:** `apps/web/components/CreateTicketDialog.vue` (line 109), `apps/web/components/CreateProjectDialog.vue` (line 81)
**Severity:** HIGH

**Description:**
Neither dialog calls `resetForm()` after a successful submission. vee-validate retains field state (values, errors, dirty flags) in memory even after the dialog is closed via `emit('update:open', false)`. When the user opens the dialog again, all previously typed values are still present. This is confusing UX and can lead to accidental duplicate submissions.

`CreateProjectDialog` also has a `watch` on `values.name` to auto-derive `slug`. If stale name is still in state when the dialog reopens, the slug field will reflect an old value.

**Impact:** UX: previously entered data visible in reopened dialogs. For `CreateProjectDialog` the auto-derived slug from prior state may be wrong.

**Fix:** Destructure `resetForm` from `useForm()` and call it after `emit('created')`:
```ts
const { handleSubmit, isSubmitting, resetForm } = useForm({ ... })
// In onSubmit success:
emit('created')
emit('update:open', false)
resetForm()
```

---

### BUG-6 — `TicketActionPanel` error handler doesn't use `extractApiError` — loses structured API error messages

**File:** `apps/web/components/TicketActionPanel.vue` (line 53)
**Severity:** HIGH

**Description:**
The `performAction` catch block only handles plain `Error` instances:
```ts
const message = error instanceof Error ? error.message : t('tickets.toast.actionFailed')
toast.error(message)
```
When the API returns a 4xx/5xx with a `JsonResponse` error body, `useApi` converts it to an `ApiError`. `ApiError` is a subclass of `Error`, so `error instanceof Error` is `true` — however, `error.message` for an `ApiError` is just the top-level message string. The `ApiError.firstError` getter (which also extracts field-level errors) is never called. More importantly, non-ApiError thrown objects (like network errors that are not Error instances) will silently show the generic fallback without the actual cause.

The same pattern is used in `CreateTicketDialog.vue` (line 128), `CreateProjectDialog.vue` (line 117), and `CommentThread.vue` (line 68).

**Impact:** Loss of error detail from the API. For example, if the API returns `{ ret: 422, errors: { body: ['Body is required'] } }`, the user sees a generic toast message rather than "Body is required".

**Fix:** Use `extractApiError` from `useApi.ts` for all catch blocks:
```ts
import { extractApiError } from '~/composables/useApi'
// ...
} catch (error: unknown) {
  toast.error(extractApiError(error))
}
```

---

### BUG-7 — `agents.vue` fetches `/agents` (global endpoint) instead of `/projects/:slug/agents`

**File:** `apps/web/pages/[project]/agents.vue` (line 20)
**Severity:** HIGH

**Description:**
The agents page is nested under a `[project]` route and displays agents in the context of a specific project. However, the API call fetches all agents globally:
```ts
() => $api.get('/agents') as Promise<Agent[]>
```
If the API has a project-scoped agents endpoint (e.g., `/projects/:slug/agents`), this page should use it. Even if the API currently returns all agents regardless, this violates the page's intended scope and will show wrong data if/when project-level agent filtering is added. The `slug` variable is extracted from route params but never used in the fetch call.

**Impact:** The page shows agents from all projects, not just the current project's agents. If the API ever enforces project-level scoping, this page will break.

**Fix:** Use the project-scoped endpoint if available:
```ts
() => $api.get(`/projects/${slug}/agents`) as Promise<Agent[]>
```
(Verify against the OpenAPI spec in `openapi.json` which endpoint is correct.)

---

### SEC-1 — `koda_token` cookie has no security attributes — vulnerable to XSS token theft

**File:** `apps/web/composables/useAuth.ts` (line 33)
**Severity:** HIGH

**Description:**
The JWT auth token is stored in a cookie with default (insecure) options:
```ts
const token = useCookie('koda_token')
```
Without explicit options, `useCookie` in Nuxt creates a cookie that is:
- **Not `httpOnly`** — accessible to JavaScript (XSS can steal it)
- **Not `secure`** — sent over HTTP as well as HTTPS
- **No explicit `sameSite`** — defaults to `Lax` in modern browsers, but not enforced by the app

The `koda_token` is used as a Bearer token in the `Authorization` header, making it equivalent to a session token. If an XSS vulnerability exists anywhere in the app, an attacker can read the cookie and impersonate the user.

**Impact:** If any XSS is present (e.g., unsanitized user content in ticket descriptions, comments, or labels), the token is trivially exfiltrable. MEDIUM risk even without XSS, since most modern browsers allow JS to read cookies unless `httpOnly` is set.

**Fix:** Add security options to `useCookie`:
```ts
const token = useCookie('koda_token', {
  httpOnly: false,  // must be false if client JS needs to read it for Authorization header
  secure: true,     // only send over HTTPS
  sameSite: 'strict',
  maxAge: 60 * 60 * 24 * 7, // set explicit expiry
})
```
Note: since `useApi` reads `token.value` client-side to build the `Authorization` header, `httpOnly: true` is not viable without switching to a different auth flow (e.g., server-only cookie + server proxy handles auth headers). The minimum fix is `secure: true` and `sameSite: 'strict'`.

---

### BUG-8 — No loading or error state for `useAsyncData` calls in most pages — silent failures

**Files:** `apps/web/pages/index.vue`, `apps/web/pages/[project]/index.vue`, `apps/web/pages/[project]/agents.vue`, `apps/web/pages/[project]/labels.vue`, `apps/web/pages/[project]/tickets/[ref].vue`, `apps/web/pages/[project]/kb.vue`
**Severity:** HIGH

**Description:**
None of the `useAsyncData` calls in pages destructure the `pending` or `error` return values:
```ts
const { data: ticketsData, refresh } = useAsyncData(...)
// No: const { data, pending, error, refresh } = useAsyncData(...)
```
If a network error occurs during SSR or client-side navigation, `data` will be `null`, and the page silently renders an empty state (e.g., empty board, "Loading ticket..." that never resolves for the ticket detail page). There is no user-visible error message for fetch failures in these pages.

The ticket detail page (`[ref].vue`) is the most impactful: when `ticketData` is null due to a fetch error, it shows the `v-else` message `t('common.loadingTicket')` ("Loading ticket...") indefinitely, as there is no distinction between "still loading" and "failed to load".

**Impact:** Network errors, 401/403 auth failures, and 404s are invisible to the user. The page appears to be loading forever rather than showing an actionable error.

**Fix:** Destructure `pending` and `error` from `useAsyncData` and render appropriate states:
```ts
const { data, pending, error, refresh } = useAsyncData(...)
```
```html
<div v-if="pending">Loading...</div>
<div v-else-if="error">Failed to load: {{ error.message }}</div>
<div v-else>...</div>
```

---

## MEDIUM

---

### BUG-9 — `LanguageSwitcher` compares `locale` ref directly instead of `locale.value` — active locale highlight never works

**File:** `apps/web/components/LanguageSwitcher.vue` (line 31)
**Severity:** MEDIUM

**Description:**
In the toggle-buttons branch (2 locales), the active-state class binding compares the `locale` ref object directly against a string:
```html
locale === loc.code
```
`locale` is a `Ref<string>`, not a plain string. `Ref<string> === 'en'` is always `false`. The active locale button is never highlighted. The `Select` branch (line 42) passes `:model-value="locale"` (the ref object) rather than `:model-value="locale.value"`, which will also cause incorrect behavior (the select will not show the current locale as selected).

**Impact:** The language switcher toggle buttons never show the active locale as highlighted. The dropdown variant (`> 2 locales`) passes a ref object as the model value, which will likely show as blank/wrong.

**Fix:** Change line 31 to compare `locale.value`:
```html
locale.value === loc.code
```
And line 42 to bind the unwrapped value:
```html
<Select v-else :model-value="locale.value" @update:model-value="switchLocale">
```

---

### BUG-10 — `register.vue` does not use `definePageMeta({ layout: 'default' })` correctly; its layout is overridden by the inner `min-h-screen` div

**File:** `apps/web/pages/register.vue`
**Severity:** MEDIUM

**Description:**
`register.vue` uses `definePageMeta({ layout: 'auth' })`, which renders it inside `layouts/auth.vue`. The auth layout already provides a full-screen centered card wrapper (`<div class="flex min-h-screen items-center justify-center">`). However, the register page template also has its own outer `<div class="flex min-h-screen items-center justify-center bg-background">` wrapper (lines 2-74), resulting in **double nested full-screen flex centering**. The inner page effectively tries to fill another full-screen container inside the layout card.

This causes the register page to render incorrectly — the page content overflows the `max-w-md` card provided by the auth layout, and the background is applied twice.

**Impact:** Visual regression: register page layout is broken compared to the login page, which does not have the extra outer wrapper.

**Fix:** Remove the outer `<div class="flex min-h-screen items-center justify-center bg-background">` wrapper from `register.vue`. The auth layout provides this wrapper. The register template should start directly with the `<div class="w-full max-w-md space-y-8">` inner container.

---

### BUG-11 — `register.vue` does not use `vue-sonner` toast for errors — inconsistent UX

**File:** `apps/web/pages/register.vue`
**Severity:** MEDIUM

**Description:**
The login page uses `toast.error()` to display API errors (consistent with all other pages). The register page stores errors in a local `error` ref and displays them in an inline error `<div>`. This means:
- The register page has an inline banner that login does not have
- Successful registration redirects to `/` but no success toast is shown (login shows `toast.success(t('toast.loggedIn'))`)
- Error handling is inconsistent between the two auth pages

**Impact:** UX inconsistency. Minor but visible to users.

**Fix:** Replace inline error rendering with `toast.error(extractApiError(err))` and add `toast.success(t('toast.loggedIn'))` after successful registration, matching the login page pattern.

---

### BUG-12 — `CommentThread` initial comment list sync is one-time only — `refresh()` doesn't update displayed comments

**File:** `apps/web/components/CommentThread.vue` (lines 34-35)
**Severity:** MEDIUM

**Description:**
The comments displayed in the template come from a `ref`:
```ts
const comments = ref([] as Comment[])
comments.value = data.value ?? []
```
This one-time assignment is made at setup time. When a new comment is added (`comments.value.push(newComment)` on line 63), the local ref is updated — good. However, there is no `watch` on `data.value`, so if `refresh()` is ever called (it isn't explicitly called anywhere in this component, but any parent page calling refresh could invalidate the `useAsyncData` cache), the `data` ref from `useAsyncData` would update but `comments.value` would remain stale.

Also, directly mutating `comments.value` via `.push()` breaks immutability patterns and is inconsistent with how the rest of the app manages reactive state.

**Impact:** Calling `refresh()` on the `useAsyncData` key externally would silently leave `comments` showing stale data. Mutating `comments.value` directly is fragile.

**Fix:** Replace the `ref` + one-time assignment with a `computed`:
```ts
const comments = computed(() => data.value ?? [])
```
For the optimistic local update on add, either re-fetch (call refresh) or append to a local array alongside the computed. The cleanest fix is to call `refresh()` after posting a new comment, removing the `.push()`.

---

### BUG-13 — `[project]/index.vue` has no `definePageMeta({ layout: 'default' })` — uses Nuxt default layout, not the app default layout

**File:** `apps/web/pages/[project]/index.vue`
**Severity:** MEDIUM

**Description:**
The project board page (`[project]/index.vue`) has no `definePageMeta` call. Pages without an explicit layout declaration use Nuxt's built-in default layout, which is `layouts/default.vue`. In this app that happens to be correct. However, the sibling pages `[project]/agents.vue`, `[project]/labels.vue`, `[project]/tickets/[ref].vue`, and `[project]/kb.vue` also have no `definePageMeta` calls.

Only `pages/index.vue` and `pages/[project]/kb.vue` have `definePageMeta({ layout: 'default' })`. If the default layout were ever changed at the Nuxt config level, all pages without explicit declarations would silently change layout.

This is a maintainability and intent-clarity issue. It's particularly confusing that `pages/index.vue` explicitly declares `layout: 'default'` while `pages/[project]/index.vue` does not.

**Impact:** Currently benign, but fragile. If a new default layout is added to the app, these pages would silently switch layouts.

**Fix:** Add `definePageMeta({ layout: 'default' })` to all project-level pages for consistency.

---

### BUG-14 — `useAuth.logout()` is not `async` but calls `navigateTo()` which returns a Promise — navigation may not complete

**File:** `apps/web/composables/useAuth.ts` (lines 58-62)
**Severity:** MEDIUM

**Description:**
```ts
function logout(): void {
  token.value = null
  user.value = null
  navigateTo('/login')
}
```
`navigateTo()` in Nuxt is async and returns a `Promise`. Calling it without `await` means the navigation is fired but not awaited. If any code runs after `logout()` returns (before the navigation completes), it may attempt to use `token`/`user` state or trigger reactive updates in a partially-cleared state. The callers in `default.vue` (`@click="auth.logout()"`) do not await either — this is currently harmless because the click handler doesn't do anything after calling logout, but it is a latent bug.

**Impact:** Currently low risk. If logout error handling or post-logout cleanup is ever added, the unawaited navigation will cause ordering bugs.

**Fix:** Make `logout` async and await `navigateTo`:
```ts
async function logout(): Promise<void> {
  token.value = null
  user.value = null
  await navigateTo('/login')
}
```

---

## LOW

---

### BUG-15 — `labels.vue` has `console.error` calls that should be removed before production

**File:** `apps/web/pages/[project]/labels.vue` (lines 45, 56)
**Severity:** LOW

**Description:**
```ts
console.error('createLabel failed:', err)
console.error('deleteLabel failed:', err)
```
`console.log/error/warn` in production code is prohibited by the project's coding standards (see `CLAUDE.md`). These will appear in browser developer tools in production.

**Impact:** Information leakage in production console. Potential exposure of internal error details.

**Fix:** Remove the `console.error` calls. The `toast.error()` call already handles user-visible error reporting.

---

### BUG-16 — `default.vue` layout renders duplicate logout button and user email (both sidebar and header)

**File:** `apps/web/layouts/default.vue`
**Severity:** LOW

**Description:**
The default layout renders the user's email and a logout button in both the sidebar bottom section (lines 58-67) and the header right area (lines 92-100). This is clearly duplicate rendering — the logout is triggered from two places, and the email is displayed twice. When the sidebar is hidden (`sidebarOpen = false`), the sidebar controls are hidden via `v-show`, but the header duplicates remain.

**Impact:** UX issue — the email appears twice on screen. Two logout buttons with identical behavior. When the sidebar is toggled off, one set disappears but the header copy remains, which may confuse users.

**Fix:** Remove the logout button and user email from the sidebar bottom section (lines 57-68) since the header provides these controls. Keep only the sidebar nav links in the sidebar.

---

### BUG-17 — `KbAddDocumentDialog` error message for missing fields is not i18n translated

**File:** `apps/web/components/KbAddDocumentDialog.vue` (line 28)
**Severity:** LOW

**Description:**
```ts
toast.error('Source ID and Content are required.')
```
This validation message is a hardcoded English string rather than using `t('...')` from `useI18n`. All other user-facing strings in the app use i18n keys. This will not translate when the user switches to Chinese (`zh` locale).

**Impact:** One string is always shown in English regardless of locale setting.

**Fix:** Add a translation key (e.g., `kb.documents.validation.requiredFields`) to `en.json` and `zh.json`, and use `t('kb.documents.validation.requiredFields')`.

---

### BUG-18 — `[ref].vue` formatDate uses hardcoded `'en-US'` locale for date formatting

**File:** `apps/web/pages/[project]/tickets/[ref].vue` (line 73)
**Severity:** LOW

**Description:**
```ts
function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString('en-US', { ... })
}
```
The date is always formatted as `en-US` regardless of the user's selected locale. The same `formatDate` pattern is used in `kb.vue` (line 71) as `new Date(dateStr).toLocaleDateString()` (which does respect the browser locale, so that one is fine). The `[ref].vue` version hardcodes the locale.

**Impact:** Chinese-locale users see "Mar 28, 2026" instead of a locale-appropriate date format.

**Fix:** Use the active i18n locale:
```ts
const { locale } = useI18n()
function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString(locale.value, {
    year: 'numeric', month: 'short', day: 'numeric',
  })
}
```

---

## Additional Observations (Not Bugs — Informational)

1. **`ThemeSwitcher.vue` uses emoji icons** (lines 5-7: `'🖥️'`, `'☀️'`, `'🌙'`). Project coding standards (`CLAUDE.md`) prohibit emojis in code. These should be replaced with `lucide-vue-next` icon components.

2. **`KbVerdictBanner.vue` and `KbResultCard.vue` have hardcoded English strings** in the `verdictConfig` computed (`'Likely Duplicate'`, `'Possibly Related'`, `'No Match'`, etc.) that are not run through `t()`. These are not in the i18n locale files.

3. **`[project]/kb.vue` description is hardcoded English** (line 84): `"Search and manage documents for the {{ slug }} project."` — should be an i18n key.

4. **`KbAddDocumentDialog.vue` description is hardcoded English** (line 59): `"Index a document into the knowledge base for this project."` — should be an i18n key.

5. **`useAsyncData` key collision risk**: `pages/index.vue` uses the static key `'projects'` (line 70). If multiple tabs/navigations cause this key to collide with SSR cache, stale data could be served. Prefer namespaced keys like `'projects-list'` throughout.

---

## File Coverage

All source files read and analyzed:

- `nuxt.config.ts` — reviewed
- `package.json` — reviewed
- `composables/useApi.ts` — reviewed
- `composables/useAuth.ts` — reviewed
- `middleware/auth.ts` — reviewed
- `layouts/default.vue` — reviewed
- `layouts/auth.vue` — reviewed
- `app.vue` — reviewed
- `pages/login.vue` — reviewed
- `pages/register.vue` — reviewed
- `pages/index.vue` — reviewed
- `pages/[project]/index.vue` — reviewed
- `pages/[project]/agents.vue` — reviewed
- `pages/[project]/tickets/[ref].vue` — reviewed
- `pages/[project]/kb.vue` — reviewed
- `pages/[project]/labels.vue` — reviewed
- `components/TicketBoard.vue` — reviewed
- `components/TicketCard.vue` — reviewed
- `components/TicketActionPanel.vue` — reviewed
- `components/CommentThread.vue` — reviewed
- `components/CreateTicketDialog.vue` — reviewed
- `components/CreateProjectDialog.vue` — reviewed
- `components/KbAddDocumentDialog.vue` — reviewed
- `components/KbResultCard.vue` — reviewed
- `components/KbVerdictBanner.vue` — reviewed
- `components/LanguageSwitcher.vue` — reviewed
- `components/ThemeSwitcher.vue` — reviewed
- `lib/utils.ts` — reviewed (no issues)
- `i18n/locales/en.json` — reviewed
- `i18n/locales/zh.json` — reviewed (structure matches en.json)
- All `components/ui/**` — reviewed (standard shadcn-vue components, no issues)
