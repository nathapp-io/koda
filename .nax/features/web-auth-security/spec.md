# SPEC: Web Auth & Form Security Fixes

## Summary

Fix 5 bugs in the Koda web app (`apps/web/`) related to auth cookie security, broken form validation, missing form resets, inconsistent error handling, and a broken locale switcher. All are small, isolated fixes with no cross-dependencies.

## Motivation

A deep bug scan (GitHub issues #35, #36, #37, #38, #41) found:
1. The `koda_token` auth cookie has no `secure` or `sameSite` attributes — vulnerable to token theft via XSS.
2. `CommentThread` passes a raw Zod schema to vee-validate without `toTypedSchema()` — client validation silently does nothing.
3. `CreateTicketDialog` and `CreateProjectDialog` don't call `resetForm()` after success — stale values appear when reopened.
4. Multiple components use `error instanceof Error ? error.message : ...` instead of the existing `extractApiError()` utility — loses structured API error details.
5. `LanguageSwitcher` compares a `Ref<string>` object against a string literal — the active locale is never highlighted.

## Design

### US-001: Cookie hardening

In `apps/web/composables/useAuth.ts`, the `useCookie('koda_token')` call needs security options:

```ts
const token = useCookie('koda_token', {
  secure: true,
  sameSite: 'strict' as const,
  maxAge: 60 * 60 * 24 * 7, // 7 days
})
```

Note: `httpOnly` cannot be `true` because client-side JS reads the token to set the `Authorization` header in `useApi.ts`. This is a documented trade-off.

### US-002: toTypedSchema fix

In `apps/web/components/CommentThread.vue`, the raw Zod schema must be wrapped with `toTypedSchema()` from `@vee-validate/zod`, matching the pattern already used in `CreateTicketDialog.vue` and `CreateProjectDialog.vue`.

Current (broken):
```ts
const commentSchema = z.object({ ... })
const { handleSubmit, resetForm } = useForm({ validationSchema: commentSchema })
```

Fixed:
```ts
import { toTypedSchema } from '@vee-validate/zod'
const commentSchema = toTypedSchema(z.object({ ... }))
const { handleSubmit, resetForm } = useForm({ validationSchema: commentSchema })
```

### US-003: Dialog form reset

Both `CreateTicketDialog.vue` and `CreateProjectDialog.vue` must call `resetForm()` after successful submission. The function is already available from `useForm()` in `CreateTicketDialog` (but not destructured) and already destructured in `CreateProjectDialog` (but not called).

Pattern:
```ts
// After success:
emit('created')
emit('update:open', false)
resetForm()
```

### US-004: extractApiError usage

Four components use a manual error extraction pattern instead of `extractApiError()`:
- `TicketActionPanel.vue` (line ~53)
- `CreateTicketDialog.vue` (line ~128)
- `CreateProjectDialog.vue` (line ~117)
- `CommentThread.vue` (line ~68)

Replace all with:
```ts
import { extractApiError } from '~/composables/useApi'
// ...
} catch (error: unknown) {
  toast.error(extractApiError(error))
}
```

Also remove `console.error` calls in `labels.vue` catch blocks (lines ~45, ~56) and use `extractApiError` there too.

### US-005: LanguageSwitcher ref comparison

In `apps/web/components/LanguageSwitcher.vue`:
- Line 31: `locale === loc.code` → `locale.value === loc.code` (toggle button active state)
- Line 42: `:model-value="locale"` → `:model-value="locale.value"` (Select dropdown binding)

### Failure Handling

All changes are purely client-side. If any fix breaks the UI, it will be caught by existing tests. No server-side changes.

## Stories

### US-001: Harden koda_token cookie security attributes (GitHub #38)

Add `secure`, `sameSite`, and `maxAge` options to the `useCookie('koda_token')` call in `useAuth.ts`.

**Complexity:** simple

#### Context Files
- `apps/web/composables/useAuth.ts` — the cookie is created here (line ~33)
- `apps/web/composables/useApi.ts` — reads `auth.token.value` client-side for Authorization header

#### Acceptance Criteria
- `useCookie('koda_token', ...)` is called with `secure: true` option
- `useCookie('koda_token', ...)` is called with `sameSite: 'strict'` option
- `useCookie('koda_token', ...)` is called with a `maxAge` of `604800` (7 days in seconds)
- `useAuth().login()` still stores the access token in the cookie after successful login
- `useAuth().logout()` still clears the cookie (sets token to null)
- `useAuth().fetchUser()` still reads the token from the cookie for the Authorization header

### US-002: Fix CommentThread form validation with toTypedSchema (GitHub #35)

Wrap the raw Zod schema in `CommentThread.vue` with `toTypedSchema()` so vee-validate actually validates form fields.

**Complexity:** simple

**Depends on:** none

#### Context Files
- `apps/web/components/CommentThread.vue` — the broken schema (lines ~44-55)
- `apps/web/components/CreateTicketDialog.vue` — reference: already uses `toTypedSchema` correctly
- `apps/web/components/CreateProjectDialog.vue` — reference: already uses `toTypedSchema` correctly

#### Acceptance Criteria
- `CommentThread.vue` imports `toTypedSchema` from `@vee-validate/zod`
- The `commentSchema` variable is wrapped: `toTypedSchema(z.object({ ... }))`
- `useForm({ validationSchema: commentSchema })` receives the wrapped schema
- The Zod constraints (`body: z.string().min(1, ...)`) are preserved inside the wrapper
- The `type` enum constraint (`z.enum([...])`) is preserved inside the wrapper

### US-003: Reset dialog forms after successful submission (GitHub #36)

Call `resetForm()` in both `CreateTicketDialog.vue` and `CreateProjectDialog.vue` after a successful create, so reopened dialogs start clean.

**Complexity:** simple

**Depends on:** none

#### Context Files
- `apps/web/components/CreateTicketDialog.vue` — needs `resetForm` destructured from `useForm()` and called after success
- `apps/web/components/CreateProjectDialog.vue` — has `resetForm` available but not called; also has watchers on `values.name` and `values.key`

#### Acceptance Criteria
- `CreateTicketDialog.vue` destructures `resetForm` from `useForm()` (it currently only has `handleSubmit` and `isSubmitting`)
- `CreateTicketDialog.vue` calls `resetForm()` after `emit('created')` and `emit('update:open', false)` in the success path
- `CreateProjectDialog.vue` calls `resetForm()` after `emit('created')` and `emit('update:open', false)` in the success path
- After `resetForm()`, form fields return to their initial values (`title: ''`, `type: ''`, `priority: 'MEDIUM'`, `description: ''` for tickets; `name: ''`, `slug: ''`, `key: ''` for projects)

### US-004: Use extractApiError in all error catch blocks (GitHub #37)

Replace manual `error instanceof Error ? error.message : ...` patterns with `extractApiError()` from `useApi.ts` across all components. Also remove `console.error` calls in `labels.vue`.

**Complexity:** simple

**Depends on:** none

#### Context Files
- `apps/web/composables/useApi.ts` — defines `extractApiError()` (already exported)
- `apps/web/components/TicketActionPanel.vue` — catch block at line ~53
- `apps/web/components/CreateTicketDialog.vue` — catch block at line ~128
- `apps/web/components/CreateProjectDialog.vue` — catch block at line ~117
- `apps/web/components/CommentThread.vue` — catch block at line ~68
- `apps/web/pages/[project]/labels.vue` — two catch blocks with `console.error` (lines ~45, ~56)

#### Acceptance Criteria
- `TicketActionPanel.vue` imports `extractApiError` from `~/composables/useApi` and uses it in the catch block: `toast.error(extractApiError(error))`
- `CreateTicketDialog.vue` imports `extractApiError` and uses it in the catch block instead of `error instanceof Error ? error.message : ...`
- `CreateProjectDialog.vue` imports `extractApiError` and uses it in the catch block instead of `error instanceof Error ? error.message : ...`
- `CommentThread.vue` imports `extractApiError` and uses it in the catch block instead of `error instanceof Error ? err.message : ...`
- `labels.vue` removes `console.error('createLabel failed:', err)` and uses `toast.error(extractApiError(err))` instead
- `labels.vue` removes `console.error('deleteLabel failed:', err)` and uses `toast.error(extractApiError(err))` instead
- `labels.vue` imports `extractApiError` from `~/composables/useApi`

### US-005: Fix LanguageSwitcher ref value comparison (GitHub #41)

Fix the `locale` ref comparison so the active language button is highlighted and the dropdown shows the correct selection.

**Complexity:** simple

**Depends on:** none

#### Context Files
- `apps/web/components/LanguageSwitcher.vue` — the broken comparisons (lines ~31, ~42)

#### Acceptance Criteria
- The toggle button active-state class uses `locale.value === loc.code` (not `locale === loc.code`)
- The `Select` component binds `:model-value="locale.value"` (not `:model-value="locale"`)
- The `switchLocale` function call remains unchanged (`@click="switchLocale(loc.code)"` and `@update:model-value="switchLocale"`)
- The `currentLocaleName` computed still works correctly (it already uses `locale.value`)

## Acceptance Criteria

See per-story acceptance criteria above. All stories are independent and can be implemented in any order.
