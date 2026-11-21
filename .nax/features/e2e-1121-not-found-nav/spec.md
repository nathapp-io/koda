# SPEC: Not-found pages, page titles and palette ticket search from the 2026-11-21 A-Z e2e run

## Summary

This feature fixes the not-found and navigation findings from the 2026-11-21 A-Z end-to-end run on koda-wk (`2579ca3d`):
- An unknown project slug renders the full project chrome, then "Failed to load data / Retry" with HTTP 200 (F9).
- On that page the live-update stream keeps reopening against a 404 (F30).
- An unknown ticket ref shows the same generic error (F9).
- The Cmd+K palette finds no tickets (F10).
- Almost every page's browser title is the bare word "Koda" (F20).

The fixes:
- A global route check sends an unknown project slug to a full-page 404. The project page never mounts, so its stream never opens.
- The ticket page shows a "Ticket not found" state.
- `PageHeader` and the ticket page set the document title.
- The palette jumps to a typed ticket ref and searches ticket titles in the current project, through a new `search` query on the ticket list API.

The findings report is `projects/koda/e2e-2026-11-21/koda-wk-a-z-e2e-findings-2026-11-21.md` in the workspace repo.

## Motivation

- F9 (project): `/nope-404` matches `pages/[project]/index.vue`. `layouts/default.vue` reads the slug from the route and renders the project sidebar block, the page renders `PageHeader :title="slug"` with New Ticket and Import Issue, and the failed ticket list shows `ErrorState` (Retry). Nothing ever asks whether the project exists. The server answers with HTTP 200.
- F30: the same page calls `useProjectEvents(slug, ...)`. An `EventSource` cannot read the 404 status, so `lib/project-event-stream.ts` treats it as a terminal failure. It waits the backoff, refreshes the session (rotating the refresh token) and reopens, up to `MAX_TERMINAL_FAILURES` times.
- F9 (ticket): `pages/[project]/tickets/[ref].vue` passes a 404 from `GET /projects/:slug/tickets/:ref` to `useAsyncData`, whose `error` shows `ErrorState` with Retry. Retrying cannot help.
- F10: `components/CommandPalette.vue` filters only its static destinations and the project list. Typing `SB-1` shows "No matches". The ticket list route has no text filter. Only the agent tool can pass `titleContains`, which the repository already implements as a case-insensitive `contains`.
- F20: only the auth and invite pages, Account, and the two thread detail pages call `useHead({ title })`. `components/fleet/ApprovalBadge.vue` sets `titleTemplate: title => prefix + (title || 'Koda')`, so every other page is titled "Koda".

## Design

### Integration

Symbols this feature only reads:

- `ApiError` in `apps/web/composables/useApi.ts`: `code: number`, thrown by `$api` for every enveloped failure. A missing project or ticket arrives as `code` `40004` (`NotFoundAppException`). Precedents: `isNotFound` in `pages/[project]/flows/[id].vue` and `pages/[project]/fleet/schedules/[id].vue` accept `404` or `40004`.
- `extractErrorStatus(err): number | undefined` in the same file: the HTTP status of a FetchError without an envelope.
- `apiPath` (tagged template) in `apps/web/lib/api-path.ts`: encodes each interpolated segment.
- `useAuth().isAuthenticated: ComputedRef<boolean>`. `middleware/auth.global.ts` runs first (global middleware run in file-name order), so it has already hydrated the session or redirected.
- `GET /api/projects/:slug` (`ProjectsController.findBySlug`): `200` with the project, `404` (`40004`) for an unknown or soft-deleted slug, and `403` for a non-member.
- `GET /api/projects` returns `ProjectResponseDto[]`, which carry `id`, `name`, `slug` and `key` (the ref prefix).
- `TICKET_REF_PATTERN = /^([A-Z]+)-(\d+)$/` in `apps/api/src/common/utils/ticket-ref.util.ts`: a ref prefix is upper-case letters only.
- `createDebouncer(fn, ms): { trigger, cancel }` in `apps/web/lib/debounce.ts` (trailing edge).
- `TicketsService.findAll(slug, filters: TicketListFilterInput, page)` already forwards `filters.titleContains` to `PrismaTicketsRepository.findTicketPage`. That method applies `{ contains, mode: 'insensitive' }` to `title`. The koda agent tool (`fleet/assistant/tools/ticket-tools.ts`) is its only caller today.
- `tests/helpers/mount-sfc.ts`: `mountSfc`, `loadSfc(file, globals, alias)` (works for `.ts` modules too), `NUXT_AUTO_IMPORTS` and `AUTO_IMPORT_DEFAULTS`. `tests/helpers/fleet-harness.ts` `uiStubs` stub `PageHeader`, `NuxtLink`, `LoadingState` and `ErrorState`.
- Palette mount precedent: `tests/components/command-palette-threads.spec.ts`.

Symbols this feature changes. The baseline only locates the code and is never the interface to implement:

- `ListTicketsQuery` in `apps/api/src/tickets/dto/list-tickets.query.ts`.
  - Baseline: `status`, `type`, `priority`, `assignedTo`, `unassigned`.
  - Target: it also has `search?: string`, declared with `@ApiPropertyOptional({ maxLength: 100, description: 'Case-insensitive substring of the ticket title' })`, `@IsOptional()`, `@IsString()` and `@MaxLength(100)`.
- `TicketsController.findAll` in `apps/api/src/tickets/tickets.controller.ts`.
  - Baseline: `const { current, size, ...filters } = parseQuery(...)`.
  - Target: `const { current, size, search, ...filters } = parseQuery(...)`. The trimmed `search` is passed as `titleContains` when it is non-empty. A blank or absent `search` passes no `titleContains` key.
  - The route's `@ApiResponse` 400 description becomes 'Invalid filter, search or paging parameter'.
- `TicketListFilterInput` in `apps/api/src/tickets/tickets.service.ts` becomes `Omit<ListTicketsQuery, 'current' | 'size' | 'search'> & { assignedToAgentId?: string; titleContains?: string }`. Three comments change from "only the koda tool search" to "the koda tool search and the REST `search` query": the `TicketListFilterInput` doc comment in `tickets.service.ts`, the `titleContains` field comment in `apps/api/src/tickets/domain/ticket.domain.ts`, and the S5b comment above the `titleContains` line in `findTicketPage` (`prisma-tickets.repository.ts`). The repository code does not change.
- New `apps/web/lib/not-found.ts`: `isNotFoundError(err: unknown): boolean`, importing `ApiError` and `extractErrorStatus` from `~/composables/useApi`. It is true when `err` is an `ApiError` whose `code` is `404` or `40004`, or when `extractErrorStatus(err)` is `404`. It is false otherwise.
- New `apps/web/lib/project-route-check.ts`:

  ```ts
  import { isNotFoundError } from '~/lib/not-found'

  export type ProjectRouteVerdict = 'skip' | 'known' | 'found' | 'notFound' | 'unverified'

  export interface ProjectRouteDeps {
    /** Slugs this tab already proved exist. */
    known: readonly string[]
    fetchProject: (slug: string) => Promise<unknown>
  }

  export async function checkProjectRoute(slug: unknown, deps: ProjectRouteDeps): Promise<ProjectRouteVerdict> {
    if (typeof slug !== 'string' || slug === '') return 'skip'
    if (deps.known.includes(slug)) return 'known'
    try {
      await deps.fetchProject(slug)
      return 'found'
    } catch (err) {
      return isNotFoundError(err) ? 'notFound' : 'unverified'
    }
  }
  ```

- New `apps/web/middleware/project.global.ts`. It sorts after `auth.global.ts`, so it runs second:

  ```ts
  import { apiPath } from '~/lib/api-path'
  import { checkProjectRoute } from '~/lib/project-route-check'

  export default defineNuxtRouteMiddleware(async (to) => {
    if (!useAuth().isAuthenticated.value) return
    const known = useState<string[]>('koda-known-projects', () => [])
    const { $api } = useApi()
    const slug = to.params.project
    const verdict = await checkProjectRoute(slug, { known: known.value, fetchProject: s => $api.get(apiPath`/projects/${s}`) })
    if (verdict === 'found' && typeof slug === 'string') known.value = [...known.value, slug]
    if (verdict === 'notFound') {
      return abortNavigation(createError({ statusCode: 404, statusMessage: 'Not Found', fatal: true }))
    }
  })
  ```

  `useState` carries the verified slugs from SSR into hydration, so a project is checked at most once per tab. A `'unverified'` verdict (a 403, an outage) is not cached, and navigation continues to the page's own states.
- `apps/web/components/AppErrorPage.vue`.
  - Baseline: a 503 branch (unavailable, Retry) and a generic branch (`errorPage.generic.title` with the status code, Go to home).
  - Target: a new `v-else-if="error.statusCode === 404"` branch between them, containing:
    - `h1 data-testid="error-page-not-found-title"` with `t('errorPage.notFound.title')`;
    - `p.text-muted-foreground data-testid="error-page-not-found-body"` with `t('errorPage.notFound.body')`;
    - the same `error-page-home` button, which calls `goHome`.

    It has no Retry. The component also calls `useHead`, whose `title` is `${heading} · Koda`. `heading` is `t('errorPage.unavailable.title')` for 503, `t('errorPage.notFound.title')` for 404, and `t('errorPage.generic.title', { statusCode })` otherwise.
- New `apps/web/components/NotFoundState.vue`, with props `title: string`, `body?: string`, `backTo: string` and `backLabel: string`. It renders:
  - `div data-testid="not-found-state"` (`text-center py-12`);
  - `h1 data-testid="not-found-title"` with `title`;
  - `p.text-muted-foreground data-testid="not-found-body"` with `body`, rendered only when `body` is set;
  - a `NuxtLink data-testid="not-found-back"` to `backTo`, reading `backLabel`.

  It has no Retry.
- `apps/web/pages/[project]/tickets/[ref].vue`.
  - Baseline: the ticket `useAsyncData` fetcher is `() => $api.get(apiPath\`/projects/${slug}/tickets/${ref}\`)`. The template branches are `LoadingState` (pending), `ErrorState` (error), then the ticket grid.
  - Target: the fetcher awaits the same call in a `try`. A rejection for which `isNotFoundError` is true resolves `null`. Any other rejection is rethrown.
  - Target: `ticketNotFound = computed(() => !pending.value && !error.value && ticketData.value === null)`. Nuxt 4 starts `data` as `undefined`, so `null` only ever means not found.
  - Target: a new branch after `ErrorState`, `<NotFoundState v-else-if="ticketNotFound">`, with:
    - `title` `t('tickets.notFound.title')`;
    - `body` `t('tickets.notFound.body', { ref })`;
    - `back-to` `` `/${slug}` ``;
    - `back-label` `t('tickets.notFound.back')`.
  - Target: the page calls `useHead(() => ({ title: pageTitle.value }))`, where `pageTitle` is:
    - `${ticket.ref} ${ticket.title} · Koda` when the ticket is loaded;
    - `${t('tickets.notFound.title')} · Koda` when `ticketNotFound`;
    - `${ref} · Koda` otherwise, using the route ref.
- `apps/web/components/PageHeader.vue`: the props object is kept (`const props = defineProps<...>()`), and the component calls `useHead(() => ({ title: \`${props.title} · Koda\` }))`. Every page that renders a `PageHeader` gets a title from its heading. The `ApprovalBadge` `titleTemplate` still adds its count prefix.
- `apps/web/components/CommandPalette.vue`.
  - Baseline: the search box uses `v-model="query"`. `results` filters `commands` by label and hint. The local `Project` type has `id`, `name` and `slug`.
  - Target, input: the search box uses `:value="query"` and `@input="onQueryInput"`, where `onQueryInput(e: Event)` sets `query` from `(e.target as HTMLInputElement).value`. The behavior is the same, and the mount harness can type into it.
  - Target, project type: `Project` gains `key: string`, and its `id` becomes `string | number` (the API sends a string id).
  - Target, ref command: `refCommand` is a computed. When `parseTicketRefQuery(query)` returns `{ key, number }` and a loaded project has `key === parsed.key`, it is `{ id: 'ticket-ref', label: t('palette.openTicket', { ref: \`${key}-${number}\` }), hint: project.name, icon: Ticket, run: go(\`/${project.slug}/tickets/${key}-${number}\`) }`. Otherwise it is `null`.
  - Target, title search: `ticketResults` (`Command[]`) and `searching` (`boolean`) are refs, and a `requestSeq` counter starts at 0. A `watch(query)` handler cancels the debouncer, empties `ticketResults` and sets `searching` false. It then arms a new search only when all of these hold:
    - `props.projectSlug` is set;
    - the trimmed query is at least `PALETTE_TICKET_SEARCH_MIN` long;
    - `parseTicketRefQuery(query)` is `null`.

    The handler also increments `requestSeq` on every query change, before deciding whether to arm, so a response to an earlier query can never be applied. Arming sets `searching` true and triggers a `createDebouncer(runTicketSearch, PALETTE_TICKET_SEARCH_DEBOUNCE_MS)`.
  - Target, the search request: `runTicketSearch` takes `seq = ++requestSeq` and the trimmed query `q`. It calls `$api.get(apiPath\`/projects/${slug}/tickets\`, { query: { search: q, size: PALETTE_TICKET_SEARCH_SIZE } })`.
    - On success it maps `records` to `{ id: \`ticket-${t.id}\`, label: \`${t.ref} ${t.title}\`, hint: t('palette.ticket'), icon: Ticket, run: go(\`/${slug}/tickets/${t.ref}\`) }`.
    - On failure the result is an empty list, with no toast.
    - The result and `searching = false` apply only when `seq === requestSeq`.
  - Target, closing: closing the palette (`open` becomes false) cancels the debouncer, increments `requestSeq`, empties `ticketResults` and sets `searching` false.
  - Target, `results`: for a non-empty query, `results` is `[refCommand (when non-null), ...static matches as today, ...ticketResults]`. For an empty query it is `commands` as today.
  - Target, list items: while `searching` is true, the list shows `li data-testid="palette-searching"` with `t('palette.searching')`. The `palette.empty` item shows only when `results` is empty and `searching` is false.
- New `apps/web/lib/palette-tickets.ts`:
  - `PALETTE_TICKET_SEARCH_MIN = 2`, `PALETTE_TICKET_SEARCH_SIZE = 8`, `PALETTE_TICKET_SEARCH_DEBOUNCE_MS = 250`;
  - `parseTicketRefQuery(query: string): { key: string; number: number } | null`. It trims the query and matches `/^([A-Za-z]+)-(\d+)$/`. It returns the upper-cased letters and the parsed integer. It returns `null` when there is no match, when the digits are more than 9, or when the number is `0`.

New web i18n keys, in both `apps/web/i18n/locales/en.json` and `zh.json`:

| key | en | zh |
|---|---|---|
| `errorPage.notFound.title` | Page not found | 页面不存在 |
| `errorPage.notFound.body` | This page or project does not exist, or it was removed. | 该页面或项目不存在，或已被删除。 |
| `tickets.notFound.title` | Ticket not found | 工单不存在 |
| `tickets.notFound.body` | {ref} does not exist in this project, or it was deleted. | 此项目中不存在 {ref}，或它已被删除。 |
| `tickets.notFound.back` | Back to board | 返回看板 |
| `palette.openTicket` | Open ticket {ref} | 打开工单 {ref} |
| `palette.ticket` | Ticket | 工单 |
| `palette.searching` | Searching tickets… | 正在搜索工单… |

Changed web i18n values (same keys):

| key | en | zh |
|---|---|---|
| `palette.description` | Search pages, projects and tickets, then press Enter to open. | 搜索页面、项目和工单，按回车打开。 |
| `palette.placeholder` | Type a page, project or ticket… | 输入页面、项目或工单… |

After the API contract change, `bun run generate` from the repo root regenerates `openapi.json` and the CLI client.

### Failure Handling

- The project check gets a failure that is not a 404 (403, 5xx, network): the verdict is `'unverified'`, navigation continues, the slug is not cached, and the page shows its own loading and error states, as today.
- The ticket fetch fails with anything other than a 404: it is rethrown, and the page keeps showing `ErrorState` with Retry, as today.
- A palette title search fails: it shows no ticket results and no toast, and the palette keeps working for its other entries.
- A palette search response arrives after the query changed: it is dropped. (Closing also bumps `requestSeq`; reopening resets the query, which empties the results.)

## Out of Scope

- A project route answered with 403 (the viewer is not a member) keeps today's page error states: only a 404 becomes the not-found page.
- The verified-slug cache is never invalidated within a tab. A project deleted or renamed while the tab is open falls back to the page's own error states and the stream's existing capped retry.
- The live-update stream's handling of a 404 is unchanged: an `EventSource` cannot read the status, and the fix is that a missing project's page never mounts.
- Not-found states on other detail pages (thread, fleet job, job logs, repo config): unchanged. Flows and schedules already have their own.
- The HTTP status of the ticket not-found state: it stays 200, because only the project check aborts navigation.
- Palette ticket search across projects, by description or by ref number, and past the first 8 results.
- A CLI flag for the new `search` query: the generated client is only regenerated.
- An index for the title search: it is the repository's existing whole-column `contains`, bounded here by a 2-character minimum, a 250 ms debounce and a page size of 8.
- `%` and `_` in `search`: they mean whatever the existing `titleContains` query gives them, the same as the koda tool search.
- The thread detail pages' titles (the bare thread title, with no "· Koda"): unchanged.
- Adding the project name to project sub-page titles.
- Clearing the verified-slug cache (`koda-known-projects`) on logout or on a sign-in as another user in the same tab: it only skips a repeat existence check, and the page's own states still apply.
- Checking the SSR HTTP status of `/nope-404`, the browser tab titles, and the palette in a real browser: a post-deploy manual check on koda-wk, not a story.
- F11 and F13 (readable names, dashboard rows) and F3 and F18 (runner ACP probe): separate bundles.

## Stories

### US-001: Ticket list `search` query

No dependencies. Workdir: `apps/api`.

Add `search` to `ListTicketsQuery` and map it to `titleContains` in `TicketsController.findAll`, as in Design. Update the `TicketListFilterInput` type and the two comments. Then run `bun run generate` from the repo root, so that `openapi.json` and the CLI client document the new query. Check that the regenerated diff carries only the `search` change; drift from an outdated checkout is not part of this story.

### US-002: Not-found error classification and the project route verdict

No dependencies. Workdir: `apps/web`.

Add `lib/not-found.ts` (`isNotFoundError`) and `lib/project-route-check.ts` (`checkProjectRoute`) as in Design.

### US-003: Unknown project slug goes to a 404

Depends on US-002. Workdir: `apps/web`.

Add `middleware/project.global.ts` as in Design. Extend the mount harness so that a route middleware can be loaded, and so that every component calling `useHead` mounts without a test-supplied stub. Another merged feature (`e2e-1121-ticket-page`) already edited the same `mount-sfc.ts` lists; keep this edit additive.

### US-004: Ticket not-found state

Depends on US-002. Workdir: `apps/web`.

Add `components/NotFoundState.vue`, and show it on the ticket page when the ticket fetch is a 404, as in Design. Add the `tickets.notFound.*` keys in en and zh.

### US-005: Not-found error page and page titles

Depends on US-003, US-004. Workdir: `apps/web`.

Add the 404 branch to `AppErrorPage.vue` and its `errorPage.notFound.*` keys in en and zh. Set the document title from `PageHeader.vue`, the ticket page and `AppErrorPage.vue`, as in Design.

### US-006: Palette ticket ref jump

No dependencies. Workdir: `apps/web`.

Add `lib/palette-tickets.ts`, switch the palette search box to `:value` plus `@input`, widen the `Project` type, and add the ref command to `CommandPalette.vue`, as in Design. Add the `palette.openTicket` key and change the `palette.description` and `palette.placeholder` values in en and zh.

### US-007: Palette ticket title search

Depends on US-001, US-006. Workdir: `apps/web`.

Add the debounced, sequence-guarded title search to `CommandPalette.vue`, as in Design, with the `palette.ticket` and `palette.searching` keys in en and zh. It depends on US-006 because both edit `CommandPalette.vue`.

### Context Files

**US-001**
- `apps/api/src/tickets/prisma-tickets.repository.ts` — the existing `titleContains` filter
- `apps/api/src/approvals/dto/list-approval-policies.query.ts` — `@MaxLength` query precedent
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — section 13 ticket list and validation cases
- `apps/api/src/tickets/tickets.controller.spec.ts` — `findAll` controller unit precedent
- `apps/api/src/permissions/test-helpers/permission-fixtures.ts` — `grantRole` and `grantBaseline` for the new fixture project

**US-002**
- `apps/web/composables/useApi.ts` — `ApiError`, `extractErrorStatus`
- `apps/web/pages/[project]/flows/[id].vue` — `isNotFound` precedent (404 or 40004)

**US-003**
- `apps/web/middleware/auth.global.ts` — global middleware precedent and ordering
- `apps/web/tests/helpers/mount-sfc.ts` — `loadSfc` and the auto-import lists
- `apps/web/lib/project-route-check.ts` — created by US-002, called here

**US-004**
- `apps/web/components/ErrorState.vue` — sibling state component
- `apps/web/tests/helpers/permission-nav.ts` — `fakeAsyncData` ticket page harness
- `apps/web/tests/pages/ticket-detail-grid.spec.ts` — ticket page mount harness
- `apps/web/lib/not-found.ts` — created by US-002, called here

**US-005**
- `apps/web/components/fleet/ApprovalBadge.vue` — the `titleTemplate` that wraps every title
- `apps/web/pages/login.vue` — `useHead({ title })` with `· Koda` precedent
- `apps/web/pages/[project]/index.vue` — board page that renders `PageHeader :title="slug"`
- `apps/web/tests/components/app-error-page.spec.ts` — AppErrorPage mount harness and real-translator helper

**US-006**
- `apps/web/tests/components/command-palette-threads.spec.ts` — palette mount harness

**US-007**
- `apps/web/tests/components/command-palette-threads.spec.ts` — palette mount harness
- `apps/web/lib/debounce.ts` — `createDebouncer`

### Creates

**US-001**
None. The tests go into existing files (see Modifies).

**US-002**
- `apps/web/lib/not-found.ts`
- `apps/web/lib/project-route-check.ts`
- `apps/web/tests/lib/not-found.spec.ts` — AC-1 to AC-4
- `apps/web/tests/lib/project-route-check.spec.ts` — AC-5 to AC-10

**US-003**
- `apps/web/middleware/project.global.ts`
- `apps/web/tests/middleware/project-global.spec.ts`

**US-004**
- `apps/web/components/NotFoundState.vue`
- `apps/web/tests/components/not-found-state.spec.ts` — AC-8 to AC-11
- `apps/web/tests/pages/ticket-not-found.spec.ts` — AC-1 to AC-7

**US-005**
- `apps/web/tests/components/page-titles.spec.ts` — AC-6 to AC-13

**US-006**
- `apps/web/lib/palette-tickets.ts`
- `apps/web/tests/lib/palette-tickets.spec.ts` — AC-1 to AC-4
- `apps/web/tests/components/command-palette-ticket-ref.spec.ts` — AC-5 to AC-7

**US-007**
- `apps/web/tests/components/command-palette-ticket-search.spec.ts`

### Modifies

**US-001**
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — add a new `describe` in section 13 holding the AC-1 to AC-6 cases. The api-testing rule keeps endpoint coverage in this file, and every existing case stays unchanged.
- `apps/api/src/tickets/tickets.controller.spec.ts` — add the AC-7 and AC-8 cases next to the existing `findAll` tests. Those assert with `expect.objectContaining` and stay unchanged.
- `openapi.json` — regenerated by `bun run generate` for the new `search` query on the ticket list route.
- `apps/cli/src/generated/types.gen.ts` — regenerated by `bun run generate` for the new `search` query; never hand-edited.

**US-002**
None. These are new modules, and no existing test reads them.

**US-003**
- `apps/web/tests/helpers/mount-sfc.ts` — add `defineNuxtRouteMiddleware`, `abortNavigation` and `createError` to `NUXT_AUTO_IMPORTS`, so that the middleware spec can supply them through `globals`. Also add `useHead: () => undefined` to `AUTO_IMPORT_DEFAULTS`, so that every existing mount of a component that later calls `useHead` (`PageHeader`, `AppErrorPage`, the ticket page) still runs. A spec that tests a title overrides it through `globals`.

**US-004**
None. Existing ticket page mounts start their ticket `useAsyncData` pending (`fakeAsyncData`) or with a loaded ticket, so none of them reaches the new not-found branch.

**US-005**
- `apps/web/tests/components/app-error-page.spec.ts` — the tests "AC-10 generic error renders translated title", "post-review B5: the generic title renders through the real translator in both locales" and "AC-11 home clears error and redirects home" mount `statusCode: 404`. 404 now has its own branch, so those three mounts change to `statusCode: 500`, and B5 expects `['Something went wrong (500)', '发生错误（500）']`. The invariant: the generic branch renders `errorPage.generic.title` with the status code through the real translator in both locales, and its home button still redirects home. Add this story's AC-1 to AC-5 to this file. The 503 tests stay unchanged.

**US-006**
None. The palette specs that copy the component and replace `v-model="query"` with `:value="query"` still work: once the component uses `:value="query"`, the replace is a no-op and every existing assertion stands.

**US-007**
None. No existing test pins the palette's results list beyond the static and project entries, which are unchanged.

### Seams

- US-001 -> US-007: the palette sends `search` and `size` as query parameters of `GET /projects/:slug/tickets` (US-007 AC-1 pins the wire shape).
- US-002 -> US-003: the middleware decides through the real `checkProjectRoute` and aborts with a 404 (US-003 AC-1 and AC-2).
- US-002 -> US-004: the ticket page fetcher classifies its rejection with the real `isNotFoundError` (US-004 AC-1 and AC-2).
- US-005 internal: the board page gets its title through the real `PageHeader` (US-005 AC-13).

## Acceptance Criteria

### US-001

AC-1 to AC-6 run in a new `describe` in section 13 of `endpoint.e2e.spec.ts`. In its own `beforeAll` it creates a new project with its own member, granted through `grantRole`/`grantBaseline` as the api-testing rule requires. That project holds exactly three tickets: `Fix Login button` (priority `HIGH`), `Login page copy` (priority `LOW`) and `Logout crash` (priority `HIGH`). Tickets other sections create in the shared project never appear in these results.

1. [integration] `GET /api/projects/:slug/tickets?search=LOGIN` returns 200 with exactly the two tickets `Fix Login button` and `Login page copy`.
2. [integration] `GET /api/projects/:slug/tickets?search=%20login%20` returns the same two tickets as `search=login`.
3. [integration] `GET /api/projects/:slug/tickets?search=%20%20` returns all three tickets.
4. [integration] `GET /api/projects/:slug/tickets?search=login&priority=HIGH` returns exactly `Fix Login button`.
5. [integration] `GET /api/projects/:slug/tickets` with a `search` of 101 characters returns 400.
6. [integration] `GET /api/projects/:slug/tickets` with a `search` of 100 characters returns 200.
7. [unit] `TicketsController.findAll('koda', { search: ' login ' })` calls `TicketsService.findAll` with filters whose `titleContains` is `login` and which have no `search` key.
8. [unit] `TicketsController.findAll('koda', {})` calls `TicketsService.findAll` with filters that have no `titleContains` key.

### US-002

1. [unit] `isNotFoundError(new ApiError(40004, 'gone'))` returns `true`.
2. [unit] `isNotFoundError(new ApiError(404, 'gone'))` returns `true`.
3. [unit] `isNotFoundError({ status: 404 })` returns `true`.
4. [unit] `isNotFoundError(new ApiError(40003, 'forbidden'))` returns `false`.
5. [unit] `checkProjectRoute('web', { known: ['web'], fetchProject })` resolves `'known'`.
6. [unit] In that call, the `fetchProject` spy is called 0 times.
7. [unit] `checkProjectRoute('web', { known: [], fetchProject })` resolves `'found'` when `fetchProject` resolves.
8. [unit] `checkProjectRoute('nope', { known: [], fetchProject })` resolves `'notFound'` when `fetchProject` rejects with `new ApiError(40004, 'gone')`.
9. [unit] `checkProjectRoute('web', { known: [], fetchProject })` resolves `'unverified'` when `fetchProject` rejects with `new ApiError(50000, 'down')`.
10. [unit] `checkProjectRoute(undefined, { known: [], fetchProject })` resolves `'skip'`.

### US-003

Every AC loads the real `middleware/project.global.ts` through `loadSfc`, with these globals:
- `defineNuxtRouteMiddleware: fn => fn`;
- `createError: input => input`;
- `abortNavigation`, a recording spy;
- `useAuth`, which returns `{ isAuthenticated: { value: true } }` unless the AC says otherwise;
- `useState`, one shared `ref([])` per test;
- `useApi`, which returns `{ $api: { get } }` with a recording `get`.

The load passes `alias: { '~/composables/useApi': apiModule }` (with `import * as apiModule from '~/composables/useApi'`), as `command-palette-threads.spec.ts` does, so the `ApiError` the test constructs is the class `isNotFoundError` checks. The AC then calls the default export with a route object.

1. [unit] Called with `{ params: { project: 'nope' } }` while `$api.get` rejects with `new ApiError(40004, 'gone')`, the middleware calls `abortNavigation` exactly once.
2. [unit] In that call, the error passed to `abortNavigation` has `statusCode` `404` and `fatal` `true`.
3. [unit] Called with `{ params: { project: 'web' } }` while `$api.get` resolves, the middleware calls `$api.get` exactly once.
4. [unit] In that call, the path passed to `$api.get` is `/projects/web`.
5. [unit] After that call, a second middleware call with `{ params: { project: 'web' } }` in the same test makes no further `$api.get` call.
6. [unit] Called with `{ params: { project: 'web' } }` while `useAuth().isAuthenticated.value` is `false`, the middleware makes no `$api.get` call.
7. [unit] Called with `{ params: {} }` (a route without a project), the middleware makes no `$api.get` call.
8. [unit] Called with `{ params: { project: 'web' } }` while `$api.get` rejects with `new ApiError(50000, 'down')`, the middleware never calls `abortNavigation`.
9. [unit] After that call, a second middleware call with `{ params: { project: 'web' } }` in the same test calls `$api.get` again, for 2 calls in total.

### US-004

AC-1 to AC-7 mount the real ticket page with route `{ project: 'web', ref: 'WEB-404' }`. `NotFoundState`, `ErrorState` and `LoadingState` are stubbed and their props recorded. A `useAsyncData` stub records each fetcher by key and returns the `data`, `pending` and `error` refs the AC names. The mount passes `alias: { '~/composables/useApi': apiModule }`, so the `ApiError` the test constructs is the class `isNotFoundError` checks, and it aliases the page's child components to inert stubs as `ticket-detail-grid.spec.ts` does.

1. [unit] The fetcher recorded for key `ticket-web-WEB-404` resolves `null` when `$api.get` rejects with `new ApiError(40004, 'gone')`.
2. [unit] That fetcher rejects with the same error object when `$api.get` rejects with `new ApiError(50000, 'down')`.
3. [unit] With the ticket `useAsyncData` returning `data` `null`, `pending` `false` and `error` `null`, the page renders one `NotFoundState` whose `title` is `t('tickets.notFound.title')`.
4. [unit] In that mount, the `NotFoundState` `back-to` is `/web`.
5. [unit] In that mount, the `NotFoundState` `body` is `t('tickets.notFound.body', { ref: 'WEB-404' })`.
6. [unit] With the ticket `useAsyncData` returning `data` `null` and a non-null `error`, the page renders `ErrorState`.
7. [unit] In that mount, the page renders no `NotFoundState`.
8. [unit] `NotFoundState` mounted with `title` `Gone`, `back-to` `/web` and `back-label` `Back` renders `Gone` in `[data-testid="not-found-title"]`.
9. [unit] In that mount, `[data-testid="not-found-back"]` is a link whose `to` is `/web`.
10. [unit] In that mount, `[data-testid="not-found-back"]` reads `Back`.
11. [unit] `NotFoundState` mounted without `body` renders no `[data-testid="not-found-body"]` element.

### US-005

AC-6 to AC-13 supply a recording `useHead` through `globals`. Each evaluates the title of the last recorded input, calling it first when it is a function. AC-13 mounts the board page through `mountSfc`, with `PageHeader` in `components` set to `loadSfc(webFile('components', 'PageHeader.vue'), sameGlobals)`. That is the real component, loaded with the same recording `useHead`, not the `uiStubs` stub. Ticket page mounts alias the page's child components to inert stubs as `ticket-detail-grid.spec.ts` does, so a partial ticket fixture such as `{ ref, title }` renders.

1. [unit] `AppErrorPage` mounted with `{ statusCode: 404 }` shows `t('errorPage.notFound.title')` in `[data-testid="error-page-not-found-title"]`.
2. [unit] In that mount, `[data-testid="error-page-not-found-body"]` shows `t('errorPage.notFound.body')`.
3. [unit] In that mount, clicking `[data-testid="error-page-home"]` calls `clearError` with `{ redirect: '/' }`.
4. [unit] In that mount, no `[data-testid="error-page-retry"]` element is rendered.
5. [unit] `AppErrorPage` mounted with `{ statusCode: 500 }` renders no `[data-testid="error-page-not-found-title"]` element.
6. [unit] `PageHeader` mounted with `title` `Labels` records a title of `Labels · Koda`.
7. [unit] The ticket page, with the ticket loaded as `{ ref: 'WEB-7', title: 'Fix login' }`, records a title of `WEB-7 Fix login · Koda`.
8. [unit] The ticket page, with the ticket `useAsyncData` returning `data` `null`, `pending` `false` and `error` `null`, records a title of `t('tickets.notFound.title')` followed by ` · Koda`.
9. [unit] The ticket page with route ref `WEB-7`, while its ticket `useAsyncData` is still pending, records a title of `WEB-7 · Koda`.
10. [unit] `AppErrorPage` mounted with `{ statusCode: 404 }` records a title of `t('errorPage.notFound.title')` followed by ` · Koda`.
11. [unit] `AppErrorPage` mounted with `{ statusCode: 503 }` records a title of `t('errorPage.unavailable.title')` followed by ` · Koda`.
12. [unit] `AppErrorPage` mounted with `{ statusCode: 500 }` records a title of `t('errorPage.generic.title', { statusCode: 500 })` followed by ` · Koda`.
13. [unit] `pages/[project]/index.vue`, mounted for project `web` with the real `PageHeader`, records a title of `web · Koda`.

### US-006

AC-5 to AC-7 mount the real `CommandPalette.vue` with `open: false`, then call `setProps({ open: true })` and flush with `await Promise.resolve()` plus `nextTick()` (never `setImmediate`), so the palette's `open` watcher loads `/projects`. The spec defines `globalThis.HTMLInputElement` as an empty class in `beforeAll` and restores the previous value in `afterAll`, because the watcher's focus line reads it and Jest runs in the `node` environment. Every `onInput` call is followed by the same flush. Typing calls the search box's `onInput` handler with `{ target: { value } }`. `$api.get` for `/projects` resolves `[{ id: 'p1', name: 'Sandbox', slug: 'sandbox', key: 'SB' }, { id: 'p2', name: 'Web', slug: 'web', key: 'WEB' }]`.

1. [unit] `parseTicketRefQuery(' sb-12 ')` returns `{ key: 'SB', number: 12 }`.
2. [unit] `parseTicketRefQuery('SB-')` returns `null`.
3. [unit] `parseTicketRefQuery('WEB-0')` returns `null`.
4. [unit] `parseTicketRefQuery('WEB-1234567890')` (10 digits) returns `null`.
5. [unit] With no `projectSlug`, typing `sb-1` makes `ticket-ref` the first option id.
6. [unit] In that mount, activating the `ticket-ref` option navigates to `/sandbox/tickets/SB-1`.
7. [unit] With no `projectSlug`, typing `ZZ-1` (no project has key `ZZ`) renders no `ticket-ref` option.

### US-007

Every AC mounts the real `CommandPalette.vue` with `open: false`, then calls `setProps({ open: true })` and flushes with `await Promise.resolve()` plus `nextTick()` (never `setImmediate`, which fake timers hold), so the `open` watcher loads `/projects`. The spec defines `globalThis.HTMLInputElement` as an empty class in `beforeAll` and restores it in `afterAll` (Jest runs in the `node` environment). It types by calling the search box's `onInput` handler with `{ target: { value } }` and flushes after every `onInput`, so the query watcher runs once per keystroke. It runs the 250 ms debounce with Jest fake timers. `$api.get` is a recording spy: `/projects` resolves `[{ id: 'p2', name: 'Web', slug: 'web', key: 'WEB' }]`, and `/projects/web/tickets` resolves `{ records: [{ id: 't1', ref: 'WEB-3', title: 'Fix login' }] }` unless the AC says otherwise.

1. [unit] With `projectSlug` `web`, typing `login` and advancing 250 ms calls `$api.get` with `/projects/web/tickets` and `{ query: { search: 'login', size: 8 } }`.
2. [unit] After that request resolves, the palette renders an option with id `ticket-t1`.
3. [unit] In that mount, the `ticket-t1` option's label reads `WEB-3 Fix login`.
4. [unit] Activating the `ticket-t1` option navigates to `/web/tickets/WEB-3`.
5. [unit] With `projectSlug` `web`, typing `l` and advancing 250 ms makes no `/projects/web/tickets` request.
6. [unit] With no `projectSlug`, typing `login` and advancing 250 ms makes no request to any path ending in `/tickets`.
7. [unit] With `projectSlug` `web`, typing `lo` and then `login` within 100 ms, then advancing 250 ms, makes exactly one `/projects/web/tickets` request.
8. [unit] In that mount, that one request's `search` is `login`.
9. [unit] With `projectSlug` `web`, a `/projects/web/tickets` request for `logi` that resolves only after the query was changed to `xyz` (with no timer advanced after the change) adds no `ticket-t1` option.
10. [unit] With `projectSlug` `web`, a `/projects/web/tickets` request for `logi` that resolves only after the query was changed to `l` (with no timer advanced after the change) adds no `ticket-t1` option.
11. [unit] With `projectSlug` `web` and `/projects/web/tickets` rejecting, typing `login` and settling the request shows `t('palette.empty')`.
12. [unit] In that mount, no option id starts with `ticket-`.
13. [unit] With `projectSlug` `web`, typing `zzz-q` and advancing 250 ms while `/projects/web/tickets` has not yet resolved renders `[data-testid="palette-searching"]`.
14. [unit] With `projectSlug` `web`, typing `WEB-3` and advancing 250 ms makes no `/projects/web/tickets` request.
