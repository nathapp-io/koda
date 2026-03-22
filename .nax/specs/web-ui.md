# Feature: web-ui

## Overview

Build the Nuxt 3 web UI for Koda — the human-facing interface for managing projects, viewing ticket boards, transitioning tickets, managing agents, and adding comments. Built on the pre-generated `@hey-api/fetch` client at `apps/web/generated/`. All component patterns are documented in `apps/web/CLAUDE.md` (loaded as context). The API runs at `NUXT_PUBLIC_API_BASE_URL` (default `http://localhost:3100/api`).

**Branch:** `feat/web-ui`  
**Working directory:** `apps/web`  
**Depends on:** Phase 3 (generated client), Phase 4R (API)  
**Stack:** Nuxt 3, Shadcn-nuxt, Tailwind CSS, VeeValidate + Zod, vue-sonner

---

## Architecture Constraints

These rules are **non-negotiable** for every file generated.

### Component Rules
- Install Shadcn components via CLI only: `bunx shadcn-vue@latest add <name>` — NEVER hand-write UI primitives
- All forms use `vee-validate` + `zod` via `toTypedSchema()` — never raw `v-model` without validation
- Import `toast` from `vue-sonner` for notifications — add `<Toaster />` to `app.vue` once
- Use `useApi()` composable for ALL API calls — never use `$fetch` or `useFetch` directly
- Auth token stored in `useCookie('koda_token')` — never localStorage
- All pages under `pages/` except `login.vue` must be protected by `middleware/auth.ts`

### API Client Rules
- The `useApi()` composable in `composables/useApi.ts` already exists — extend it, don't replace it
- API responses are shaped as `{ ret: 0, data: T }` — always unwrap `.data` from the response
- Use `$api.get('/projects')` etc. — base URL already set from `config.public.apiBaseUrl`
- Auth header: set `Authorization: Bearer <token>` in every authenticated request via a request interceptor in `useApi`

### Styling Rules
- Use Shadcn CSS variables for colors (`text-muted-foreground`, `bg-background`) — never hardcode `text-gray-500`
- Use `space-y-*` for vertical stacking inside forms/cards; `gap-*` inside flex/grid
- Dark mode via `@nuxtjs/color-mode` with `classSuffix: ''` — class-based, no `dark:` overrides needed in Shadcn internals

### Quality Rules
- `bun run lint` must pass with 0 errors (configured to `--max-warnings=0` for TS files, generated/ excluded)
- `bun run type-check` must pass (runs `nuxt typecheck`)
- `bun run build` must succeed (Nuxt SSR build)

---

## Environment Setup

**`nuxt.config.ts`** already exists and is configured. Ensure `runtimeConfig.public.apiBaseUrl` is accessible.

**`.env`** (local dev, not committed):
```env
NUXT_PUBLIC_API_BASE_URL=http://localhost:3100/api
```

---

## Requirements

### US-001 — Shadcn Components Install + Auth Foundation

Install required Shadcn-nuxt components and implement the auth composable with token management.

**Install these components** (run from `apps/web`):
```bash
bunx shadcn-vue@latest add button card badge dialog input textarea select label form table separator avatar sonner dropdown-menu
```

**Files to create/modify:**
```
apps/web/
├── composables/
│   ├── useAuth.ts          ← JWT cookie management (new)
│   └── useApi.ts           ← Add Authorization header injection (modify)
├── middleware/
│   └── auth.ts             ← Redirect to /login if no token (new)
├── pages/
│   └── login.vue           ← Update existing scaffold to working form
├── layouts/
│   └── auth.vue            ← Centered card layout for login (new)
└── app.vue                 ← Add <Toaster /> and default color mode setup (modify)
```

**`composables/useAuth.ts`:**
```typescript
export const useAuth = () => {
  const token = useCookie<string | null>('koda_token', { secure: false, sameSite: 'lax' })
  const user = useState<{ id: string; name: string; email: string; role: string } | null>('auth_user', () => null)

  const login = async (email: string, password: string) => {
    const { $api } = useApi()
    const res = await $api.post('/auth/login', { email, password })
    token.value = (res as any).data.accessToken
    user.value = (res as any).data.user
    await navigateTo('/')
  }

  const logout = () => {
    token.value = null
    user.value = null
    navigateTo('/login')
  }

  const isAuthenticated = computed(() => !!token.value)

  return { token, user, login, logout, isAuthenticated }
}
```

**Modify `composables/useApi.ts`** — inject Authorization header when token exists:
```typescript
export const useApi = () => {
  const config = useRuntimeConfig()
  const baseURL = config.public.apiBaseUrl
  const { token } = useAuth()

  const headers = () => token.value ? { Authorization: `Bearer ${token.value}` } : {}

  const get = (path: string, options: Record<string, unknown> = {}) =>
    $fetch(`${baseURL}${path}`, { ...options, headers: headers() })
  // ... same pattern for post, patch, delete_
}
```

**`middleware/auth.ts`:**
```typescript
export default defineNuxtRouteMiddleware((to) => {
  const { isAuthenticated } = useAuth()
  if (!isAuthenticated.value && to.path !== '/login') {
    return navigateTo('/login')
  }
  if (isAuthenticated.value && to.path === '/login') {
    return navigateTo('/')
  }
})
```

**`pages/login.vue`** — working login form:
- Email + password fields with VeeValidate + Zod
- Zod schema: `email: z.string().email()`, `password: z.string().min(8)`
- On success: `toast.success('Welcome back!')`, redirect to `/`
- On error: `toast.error('Invalid credentials')`
- Uses `layouts/auth.vue` via `definePageMeta({ layout: 'auth' })`

**Acceptance Criteria:**
- [ ] All Shadcn components installed (components/ui/ directory populated)
- [ ] `useAuth()` composable manages token in cookie
- [ ] `useApi()` injects Bearer token on every request
- [ ] `middleware/auth.ts` redirects unauthenticated users to /login
- [ ] `middleware/auth.ts` redirects authenticated users away from /login
- [ ] Login form validates email format and min password length
- [ ] Login success shows toast and redirects to /
- [ ] Login failure shows error toast
- [ ] `app.vue` includes `<Toaster />` component
- [ ] `bun run lint` passes; `bun run type-check` passes

---

### US-002 — App Layout (Sidebar + Header)

Build the default layout with sidebar navigation and top header for authenticated pages.

**Files to create/modify:**
```
apps/web/
├── layouts/
│   └── default.vue         ← Sidebar + header layout (new)
└── pages/
    └── index.vue           ← Update to use default layout
```

**`layouts/default.vue`:**
- Left sidebar (fixed, `w-56`): Koda logo, project list navigation links, bottom user menu
- Top header: current page title slot, dark mode toggle button, user display + logout dropdown
- Main content area: `<slot />` with `px-6 py-4` padding
- Dark mode toggle: `useColorMode()` — sun/moon icon button
- Mobile: sidebar collapses (use `v-show` with toggle state, not CSS media breakpoints)

**Sidebar navigation structure:**
```
[KODA logo]
──────────
Dashboard
Projects
──────────
[User name]  [logout]
```

**Acceptance Criteria:**
- [ ] Default layout renders sidebar with navigation links
- [ ] Dark mode toggle switches between light/dark using `useColorMode()`
- [ ] Sidebar shows current user name from `useAuth().user`
- [ ] Logout button calls `useAuth().logout()`
- [ ] Layout is used by pages/index.vue
- [ ] `bun run lint` passes; `bun run type-check` passes

---

### US-003 — Project List Dashboard (`pages/index.vue`)

Project list page showing all projects with stats and a create project dialog.

**Files to create/modify:**
```
apps/web/
├── pages/
│   └── index.vue                      ← Project grid with create button (rewrite)
└── components/
    └── CreateProjectDialog.vue        ← New project form in Dialog (new)
```

**`pages/index.vue`:**
- Fetches `GET /projects` via `useApi().$api.get('/projects')` on mount using `useAsyncData`
- Grid layout (`grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4`)
- Each project renders as a Card: name, key badge, description (truncated), "View Board" button
- "New Project" button (top right) — admin only, opens `CreateProjectDialog`
- Empty state: "No projects yet" with create button

**`components/CreateProjectDialog.vue`:**
- Fields: name (`z.string().min(3)`), slug (auto-derived from name, `z.string().regex(/^[a-z0-9-]+$/)`), key (`z.string().min(2).max(6).regex(/^[A-Z]+$/)`)
- Auto-derive slug from name: `name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')`
- On success: `toast.success('Project created')`, emit `created` event, refresh list
- On error: `toast.error('Failed to create project')`

**Acceptance Criteria:**
- [ ] Project list fetched from API and displayed as cards
- [ ] Each card shows project name, key badge, description
- [ ] "View Board" button navigates to `/${project.slug}`
- [ ] "New Project" button opens CreateProjectDialog
- [ ] Slug auto-derives from name input
- [ ] Project key is auto-uppercased
- [ ] Create success shows toast and refreshes list
- [ ] Empty state shown when no projects
- [ ] `bun run lint` passes; `bun run type-check` passes

---

### US-004 — Ticket Kanban Board (`pages/[project]/index.vue`)

Kanban board showing tickets organized by status columns with ability to create new tickets.

**Files to create/modify:**
```
apps/web/
├── pages/
│   └── [project]/
│       └── index.vue                  ← Kanban board page (new)
└── components/
    ├── TicketCard.vue                 ← Single ticket card (new)
    ├── TicketBoard.vue                ← Board with columns (new)
    └── CreateTicketDialog.vue         ← New ticket form (new)
```

**Status columns (in order):** `CREATED`, `VERIFIED`, `IN_PROGRESS`, `VERIFY_FIX`, `CLOSED`, `REJECTED`

**`TicketBoard.vue`:**
- 6 columns side-by-side with horizontal scroll (`overflow-x-auto`)
- Column header: status name + ticket count badge
- Each column shows filtered `TicketCard` list
- "New Ticket" button in CREATED column header

**`TicketCard.vue`:**
- Shows: `ref` (mono font), title, type badge, priority badge, assignee avatar (if assigned)
- `@click` emits `open` event with ticket data for navigation to detail page
- Priority colors: CRITICAL=red, HIGH=orange, MEDIUM=secondary, LOW=outline
- Type colors: BUG=red border, ENHANCEMENT=blue border

**`CreateTicketDialog.vue`:**
- Fields: title (`z.string().min(3)`), type (`z.enum(['BUG', 'ENHANCEMENT'])`), priority (`z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'])`), description (`z.string().optional()`)
- POST to `/projects/${slug}/tickets`
- On success: toast + refresh board

**`pages/[project]/index.vue`:**
- Reads `slug` from `useRoute().params.project`
- Fetches `GET /projects/${slug}/tickets` and groups by status
- Shows `<TicketBoard>` component
- Card click navigates to `/${slug}/tickets/${ref}`

**Acceptance Criteria:**
- [ ] Board shows 6 status columns with correct names
- [ ] Tickets grouped by status and displayed as TicketCard components
- [ ] TicketCard shows ref, title, type badge, priority badge
- [ ] Create ticket dialog opens from CREATED column header button
- [ ] New ticket appears in CREATED column after creation
- [ ] Ticket card click navigates to detail page
- [ ] Board fetches tickets for the correct project slug
- [ ] `bun run lint` passes; `bun run type-check` passes

---

### US-005 — Ticket Detail Page (`pages/[project]/tickets/[ref].vue`)

Full ticket detail view with metadata, action buttons based on status, and comments thread.

**Files to create/modify:**
```
apps/web/
├── pages/
│   └── [project]/
│       └── tickets/
│           └── [ref].vue              ← Ticket detail (new)
└── components/
    ├── TicketActionPanel.vue          ← Action buttons per status (new)
    └── CommentThread.vue              ← Comments list + add form (new)
```

**`pages/[project]/tickets/[ref].vue`:**
- Two-column layout: left (2/3) = ticket info + comments, right (1/3) = metadata + actions
- Fetches `GET /projects/${slug}/tickets/${ref}`
- Fetches `GET /projects/${slug}/tickets/${ref}/comments`
- Left column: title, description (pre-wrap), status/priority/type badges, created info
- Right column: `<TicketActionPanel>` + metadata (assignee, created date)

**`TicketActionPanel.vue`** — action buttons based on `ticket.status`:

| Status | Available actions |
|--------|------------------|
| `CREATED` | Verify (requires comment), Reject (requires comment) |
| `VERIFIED` | Start |
| `IN_PROGRESS` | Submit Fix (requires comment + optional gitRef), Reject (requires comment) |
| `VERIFY_FIX` | Approve Fix (verify-fix pass), Fail Fix (verify-fix fail, requires comment) |
| `CLOSED` / `REJECTED` | No actions |

Each action with "requires comment" opens a Dialog with a Textarea before submitting.

**API calls for transitions:**
- Verify: `POST /projects/${slug}/tickets/${ref}/verify { body, type: 'VERIFICATION' }`
- Start: `POST /projects/${slug}/tickets/${ref}/start`
- Fix: `POST /projects/${slug}/tickets/${ref}/fix { body, type: 'FIX_REPORT' }`
- Verify-fix: `POST /projects/${slug}/tickets/${ref}/verify-fix?approve=true|false { body, type: 'REVIEW' }`
- Reject: `POST /projects/${slug}/tickets/${ref}/reject { body, type: 'GENERAL' }`

**`CommentThread.vue`:**
- Sorted chronological list of comments
- Comment type pill: VERIFICATION=blue, FIX_REPORT=orange, REVIEW=green, GENERAL=gray
- "Add Comment" form at bottom: body (required), type select (GENERAL|VERIFICATION|FIX_REPORT|REVIEW)
- POST to `/projects/${slug}/tickets/${ref}/comments`

**Acceptance Criteria:**
- [ ] Ticket detail shows title, description, status, priority, type badges
- [ ] Action buttons shown match allowed transitions for current status
- [ ] Closed/rejected tickets show no action buttons
- [ ] Transitions requiring comment open a confirmation dialog with textarea
- [ ] Successful transition shows toast and refreshes ticket status
- [ ] Comments thread loads and displays chronologically
- [ ] Comment type shown as colored pill
- [ ] Add comment form submits and appends comment without full page reload
- [ ] `bun run lint` passes; `bun run type-check` passes

---

### US-006 — Agent List Page (`pages/[project]/agents.vue`)

Agent management page showing all agents with their roles, capabilities and status.

**Files to create/modify:**
```
apps/web/
└── pages/
    └── [project]/
        └── agents.vue                 ← Agent list (new)
```

**`pages/[project]/agents.vue`:**
- Fetches `GET /agents` via `useApi().$api.get('/agents')` using `useAsyncData`
- Table view with columns: Name | Slug | Roles | Capabilities | Status | Actions
- Status badge: ACTIVE=green, PAUSED=yellow, OFFLINE=gray
- Roles and capabilities shown as small Badges in cell
- Admin-only actions: edit status via dropdown (ACTIVE/PAUSED/OFFLINE)
- Navigation link in sidebar: "Agents" under the current project

**Acceptance Criteria:**
- [ ] Agent list loads from API and displayed in table
- [ ] Each row shows name, slug, roles badges, capability badges, status badge
- [ ] Admin can change agent status via dropdown
- [ ] Status change shows toast on success/failure
- [ ] Page accessible via sidebar navigation
- [ ] `bun run lint` passes; `bun run type-check` passes

---

### US-007 — Build & Quality Gate

Verify the full application builds cleanly and all quality checks pass.

**Checks to run from `apps/web`:**
```bash
bun run lint        # must exit 0, 0 errors
bun run type-check  # must exit 0
bun run build       # must exit 0, "Build complete!" in output
```

**Acceptance Criteria:**
- [ ] `bun run lint` exits 0 with 0 errors (generated/ excluded already)
- [ ] `bun run type-check` exits 0 (no TypeScript errors)
- [ ] `bun run build` exits 0 and outputs "✨ Build complete!"
- [ ] No `@ts-ignore` or `any` types in new files except where explicitly needed
- [ ] All imports resolve correctly (no missing modules)
- [ ] `components/ui/` populated with all required Shadcn components

---

## Dependency Order

```
US-001 (Shadcn + Auth Foundation)
  └→ US-002 (App Layout)
       └→ US-003 (Project List)
            └→ US-004 (Ticket Board)
                 └→ US-005 (Ticket Detail)
                      └→ US-006 (Agent List)
                           └→ US-007 (Build & Quality Gate)
```

---

## Files to Create

| File | Purpose | US |
|:-----|:--------|:---|
| `composables/useAuth.ts` | JWT cookie auth management | US-001 |
| `middleware/auth.ts` | Route protection | US-001 |
| `layouts/auth.vue` | Centered card layout for login | US-001 |
| `layouts/default.vue` | Sidebar + header layout | US-002 |
| `pages/index.vue` | Project list dashboard | US-003 |
| `components/CreateProjectDialog.vue` | Create project modal | US-003 |
| `pages/[project]/index.vue` | Ticket kanban board | US-004 |
| `components/TicketCard.vue` | Ticket card component | US-004 |
| `components/TicketBoard.vue` | Board columns container | US-004 |
| `components/CreateTicketDialog.vue` | Create ticket modal | US-004 |
| `pages/[project]/tickets/[ref].vue` | Ticket detail page | US-005 |
| `components/TicketActionPanel.vue` | Status-based actions | US-005 |
| `components/CommentThread.vue` | Comments list + form | US-005 |
| `pages/[project]/agents.vue` | Agent list table | US-006 |

---

## Pre-Launch Checklist

- [x] All forms use VeeValidate + Zod (`toTypedSchema`)
- [x] Auth token in cookie (`useCookie`), not localStorage
- [x] API calls via `useApi()` composable only
- [x] API responses unwrapped (`.data` from `{ ret, data }`)
- [x] Quality gate story is the **final story** (US-007)
- [x] Shadcn components installed via CLI in US-001 (not hand-written)
- [x] Dark mode via `@nuxtjs/color-mode` classSuffix: ''
- [x] Per-package nax config disables `requireTests` (web has no unit tests)
- [x] No hardcoded colors — use Shadcn CSS variables
