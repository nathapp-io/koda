# SPEC: Web UX & Reliability Fixes

## Summary

Fix 5 groups of UX and reliability bugs in the Koda web app (`apps/web/`): CommentThread SSR/hydration issues, missing loading/error states on all pages, register page layout and error handling, minor cleanup (async logout, duplicate UI elements), and SSR API URL routing.

## Motivation

A deep bug scan (GitHub issues #33, #34, #40, #42, #44) found:
1. `CommentThread` uses `await useAsyncData` without a `<Suspense>` boundary — SSR hydration mismatch and stale data after refresh.
2. No page handles `useAsyncData` errors — network failures show infinite loading instead of an error message.
3. The register page has a double-wrapped layout (auth layout + its own full-screen wrapper) and inconsistent error handling compared to the login page.
4. Minor issues: `logout()` doesn't await `navigateTo`, duplicate logout button in sidebar + header.
5. SSR API calls use the public relative `/api` URL instead of the internal `apiInternalUrl` — unnecessary proxy round-trip.

## Design

### US-001: CommentThread hydration fix

In `apps/web/components/CommentThread.vue`:
1. Remove `await` from `useAsyncData` — the parent page `[ref].vue` does not wrap `<CommentThread>` in `<Suspense>`.
2. Replace the one-time `ref` assignment with a `computed` so data stays in sync after refresh:

Current (broken):
```ts
const { data, pending, error } = await useAsyncData<Comment[]>(...)
const comments = ref([] as Comment[])
comments.value = data.value ?? []
```

Fixed:
```ts
const { data, pending, error, refresh: refreshComments } = useAsyncData<Comment[]>(...)
const comments = computed(() => data.value ?? [])
```

3. After posting a new comment, call `refreshComments()` instead of `comments.value.push(newComment)` (since `comments` is now a computed).

### US-002: Loading and error states for all pages

Every page that uses `useAsyncData` must destructure `pending` and `error`, then render three states:
- Loading: a centered spinner or "Loading..." text
- Error: a visible error message with a "Retry" button that calls `refresh()`
- Data: the current content

Affected pages:
- `pages/index.vue` — project list
- `pages/[project]/index.vue` — ticket board
- `pages/[project]/agents.vue` — agents list
- `pages/[project]/labels.vue` — labels list
- `pages/[project]/tickets/[ref].vue` — ticket detail
- `pages/[project]/kb.vue` — knowledge base

Pattern to follow:
```html
<div v-if="pending" class="flex items-center justify-center py-12">
  <span class="text-muted-foreground">{{ t('common.loading') }}</span>
</div>
<div v-else-if="error" class="flex flex-col items-center justify-center py-12 gap-4">
  <p class="text-destructive">{{ t('common.loadFailed') }}</p>
  <Button variant="outline" @click="refresh()">{{ t('common.retry') }}</Button>
</div>
<div v-else>
  <!-- existing content -->
</div>
```

New i18n keys needed in `en.json` and `zh.json`:
- `common.loading` — "Loading..."
- `common.loadFailed` — "Failed to load data"
- `common.retry` — "Retry"

### US-003: Register page layout and error handling

In `apps/web/pages/register.vue`:
1. Remove the outer `<div class="flex min-h-screen items-center justify-center bg-background">` wrapper — the `auth` layout already provides this.
2. Replace inline error rendering (`<div v-if="error">`) with `toast.error()` pattern matching the login page.
3. Add `toast.success(t('toast.loggedIn'))` after successful registration, matching the login page.

The template should start with `<div class="w-full max-w-md space-y-8">` directly (same as login.vue).

### US-004: Cleanup — async logout, duplicate sidebar UI

Three minor fixes:

**a) Async logout** in `apps/web/composables/useAuth.ts`:
```ts
async function logout(): Promise<void> {
  token.value = null
  user.value = null
  await navigateTo('/login')
}
```

**b) Remove duplicate user email + logout from sidebar** in `apps/web/layouts/default.vue`:
Remove lines ~57-68 (the `<div class="border-t border-border p-4">` sidebar bottom section). Keep only the header version.

### US-005: SSR API URL routing

In `apps/web/composables/useApi.ts` and `apps/web/composables/useAuth.ts`, use the server-side internal URL during SSR instead of the public relative `/api`:

```ts
const baseURL = import.meta.server
  ? useRuntimeConfig().apiInternalUrl
  : useRuntimeConfig().public.apiBaseUrl
```

This avoids the proxy round-trip during SSR and prevents failures in non-Docker environments.

**Important:** `useAuth.ts` has a comment explaining it uses `$fetch` directly to avoid circular dependency with `useApi`. Both files need the same `import.meta.server` check independently.

### Failure Handling

- If SSR API URL change causes issues (e.g., `apiInternalUrl` not configured), the proxy fallback still works via `routeRules` in `nuxt.config.ts`.
- Loading/error states are purely additive — they don't change the happy path.
- Register page layout change is cosmetic — if it looks wrong, it's visually obvious.

## Stories

### US-001: Fix CommentThread SSR/hydration and stale data (GitHub #34)

Remove `await` from `useAsyncData`, replace `ref` with `computed`, and use `refresh()` after posting a comment.

**Complexity:** medium

**Depends on:** none

#### Context Files
- `apps/web/components/CommentThread.vue` — the component with all 3 issues
- `apps/web/pages/[project]/tickets/[ref].vue` — parent page that renders `<CommentThread>` (no Suspense wrapper)

#### Acceptance Criteria
- `useAsyncData` call does NOT use `await` keyword
- `comments` is a `computed(() => data.value ?? [])` not a `ref`
- After successfully posting a new comment, `refreshComments()` (or equivalent refresh function from useAsyncData) is called instead of `comments.value.push()`
- The `pending` and `error` values from `useAsyncData` are still used in the template for loading/error states
- The template still renders the comment list from `comments` (now computed)
- The `resetForm()` call after posting a comment is preserved

### US-002: Add loading and error states to all pages (GitHub #40)

Add `pending` and `error` destructuring to all `useAsyncData` calls and render loading/error/data states.

**Complexity:** medium

**Depends on:** none

#### Context Files
- `apps/web/pages/index.vue` — project list page
- `apps/web/pages/[project]/index.vue` — ticket board page
- `apps/web/pages/[project]/agents.vue` — agents list page
- `apps/web/pages/[project]/labels.vue` — labels list page (already has `refresh`)
- `apps/web/pages/[project]/tickets/[ref].vue` — ticket detail page
- `apps/web/pages/[project]/kb.vue` — knowledge base page
- `apps/web/i18n/locales/en.json` — add new i18n keys
- `apps/web/i18n/locales/zh.json` — add new i18n keys (Chinese translations)

#### Acceptance Criteria
- `pages/index.vue` destructures `pending` and `error` from `useAsyncData` and shows loading state when `pending` is true
- `pages/index.vue` shows an error message with a retry button when `error` is truthy
- `pages/[project]/index.vue` destructures `pending` and `error` and shows loading/error states
- `pages/[project]/agents.vue` destructures `pending` and `error` and shows loading/error states
- `pages/[project]/labels.vue` destructures `error` and shows an error state (it may already have `pending` handled via empty state)
- `pages/[project]/tickets/[ref].vue` destructures `pending` and `error` and replaces the always-shown "Loading ticket..." with a proper `v-if="pending"` / `v-else-if="error"` / `v-else` pattern
- `pages/[project]/kb.vue` destructures `pending` and `error` and shows loading/error states
- `en.json` contains keys `common.loading`, `common.loadFailed`, and `common.retry`
- `zh.json` contains the same keys with Chinese translations: `common.loading` = "加载中...", `common.loadFailed` = "加载失败", `common.retry` = "重试"
- All error states include a retry `<Button>` that calls the page's `refresh()` function

### US-003: Fix register page layout and error handling (GitHub #42)

Remove double layout wrapper and switch to toast-based error handling matching the login page.

**Complexity:** simple

**Depends on:** none

#### Context Files
- `apps/web/pages/register.vue` — the page to fix
- `apps/web/pages/login.vue` — reference: correct layout (no outer wrapper) and uses toast for errors
- `apps/web/layouts/auth.vue` — the auth layout that already provides the full-screen centered wrapper

#### Acceptance Criteria
- `register.vue` template does NOT have a `<div class="flex min-h-screen items-center justify-center bg-background">` wrapper
- `register.vue` template starts with `<div class="w-full max-w-md space-y-8">` as the outermost element
- The inline `<div v-if="error">` error banner is removed from the template
- The `error` ref variable is removed from the script
- On registration failure, `toast.error(extractApiError(err))` is called (using `vue-sonner`)
- On successful registration, `toast.success(t('toast.loggedIn'))` is called before `navigateTo('/')`
- `toast` is imported from `vue-sonner`
- `extractApiError` is still imported from `~/composables/useApi`

### US-004: Cleanup — async logout and duplicate sidebar UI (GitHub #44)

Make `logout()` async and remove duplicate user email + logout button from sidebar.

**Complexity:** simple

**Depends on:** none

#### Context Files
- `apps/web/composables/useAuth.ts` — `logout()` function (lines ~58-62)
- `apps/web/layouts/default.vue` — sidebar bottom section (lines ~57-68) and header section (lines ~92-100)

#### Acceptance Criteria
- `useAuth().logout()` is declared as `async function logout(): Promise<void>`
- `logout()` uses `await navigateTo('/login')` instead of bare `navigateTo('/login')`
- The sidebar `<div class="border-t border-border p-4">` section containing user email and logout button is removed from `default.vue`
- The header still contains the user email display and logout button (unchanged)
- The sidebar still contains the nav links (unchanged)

### US-005: Use internal API URL for SSR requests (GitHub #33)

Detect server vs client context in `useApi.ts` and `useAuth.ts` and use `apiInternalUrl` during SSR.

**Complexity:** simple

**Depends on:** none

#### Context Files
- `apps/web/composables/useApi.ts` — `useApi()` reads `config.public.apiBaseUrl` (line ~89)
- `apps/web/composables/useAuth.ts` — `useAuth()` reads `config.public.apiBaseUrl` (line ~31)
- `apps/web/nuxt.config.ts` — defines `runtimeConfig.apiInternalUrl` and `runtimeConfig.public.apiBaseUrl`

#### Acceptance Criteria
- `useApi.ts` computes `baseURL` using `import.meta.server ? useRuntimeConfig().apiInternalUrl : useRuntimeConfig().public.apiBaseUrl`
- `useAuth.ts` computes `baseURL` using the same pattern: `import.meta.server ? useRuntimeConfig().apiInternalUrl : useRuntimeConfig().public.apiBaseUrl`
- The `apiInternalUrl` value is read from `useRuntimeConfig()` (server-only, no `.public`)
- The `apiBaseUrl` value is still read from `useRuntimeConfig().public.apiBaseUrl` on the client
- Both composables still construct API URLs by concatenating `baseURL` with the endpoint path (e.g., `${baseURL}/auth/login`)

## Acceptance Criteria

See per-story acceptance criteria above. US-001 through US-005 are independent and can be implemented in any order.
