# SPEC: Permissions P2 — Admin Audit Log Page

## Summary

Adds the P2 web page of the permission redesign: **Admin → Audit log** (`/admin/audit`), for holders of the global key `audit.read`. It lists `AuditEntry` rows newest first, shows who acted (and on whose behalf), who approved, the project, the resource and the change summary, and filters by key, actor type, actor, approver, project, resource, correlation and UTC date window. Filters live in the URL query.

Two small API changes make the page usable by an auditor who holds only `audit.read`:
- `GET /api/audit` entries gain a `display` block with resolved names (actor, on-behalf-of, approver, project slug and name), and the route gains a `correlationId` filter.
- A new `GET /api/audit/keys` returns the distinct keys present, which feed the key filter.

## Motivation

- The redesign doc (`docs/superpowers/specs/2026-10-18-permission-approval-redesign-design.md` §6, "P2 page") calls for an Audit log page: "Filter by actor, approver, key, project and date." P2 features 1–7 now record audit entries for every REST route, tool and fleet system writer, but the only way to read them is `GET /api/audit` with raw ids.
- `AuditEntryDto` carries only ids (`actor.id`, `approval.approverId`, `projectId`). The web cannot turn them into names for an auditor: the user, agent and runner list routes need other keys (`user.read`, `agent.read`, `fleet.runner.read`), and the project list shows only the caller's projects. So the API resolves names itself, in one batch per page.
- The key filter needs the set of keys that occur. The permission catalog does not cover it (audit keys include `runner.sync`, `thread.*` and `system.*` keys that are not catalog entries), so the API lists the distinct keys present.

## Design

### Rulings and decisions carried from earlier features

- `GET /api/audit` exists (P2 `permissions-p2-audit-entry` US-006): `@Requires('audit.read')`, query `ListAuditQuery`, response a page envelope `{ total, current, size, hasNext, hasPrev, records: AuditEntryDto[] }`, newest first (`createdAt desc, id desc`). `from` / `to` accept `YYYY-MM-DD` (a UTC day, `to` inclusive to `23:59:59.999Z`) or a UTC instant ending in `Z`; a reversed window is a 400 (`audit.auditQuery`).
- `audit.read` is a global key. There is no project-scoped audit view in P2.
- Web permission gating reads `useGlobalPermissions()` and gates on the key the route needs, never on a role name (`.nax/rules/web.md` § Permission Gating). A gate only hides a control; every API refusal is still surfaced with `extractApiError()`.
- The `@ApiResponse` of audit routes carries no `type` (precedent: `AuditController.list`, `FleetActivityController`), so no component schema is added to `openapi.json`.

### API: names on audit entries (US-001)

`AuditEntryDto` gains a `display` block, filled by `AuditLogService.list` after the page is read:

```ts
export interface AuditDisplay {
  actor: string | null;       // USER: name, else email; AGENT: Agent.name; RUNNER: Runner.name; SYSTEM: null
  onBehalfOf: string | null;  // USER: name, else email; AGENT: Agent.name; null when there is no onBehalfOf
  approver: string | null;    // USER: name, else email; AGENT: Agent.name; null when there is no approver
  project: { slug: string; name: string } | null;  // null when projectId is null
}
```

- A principal or project that no longer exists (or never existed: ids are not foreign keys) resolves to `null`. A soft-deleted project still resolves (the audit log is history).
- A `USER` whose `name` is null or blank resolves to the email.
- `SYSTEM` actors are never looked up: their `actor.id` is the component id (`scheduler`, `outbox`, `budget`, ...) and the web shows it as is.
- Resolution is one batch per page: `AuditLogService.list` collects the distinct ids per kind across the page's records (actor, onBehalfOf, approver, projectId) and calls `PrismaAuditEntryRepository.findDisplayNames` **once**. An empty page, or a page whose four id lists are all empty (for example only `SYSTEM` actors with no project), does not call it. `findDisplayNames` issues at most one `findMany` per non-empty id list (users, agents, runners, projects), selecting only the label fields.
- `AuditEntryDto.from(record, display?)`: `display` defaults to the all-null block, so existing callers keep their behaviour. `AuditLogService.list` maps with a closure (`(r) => AuditEntryDto.from(r, displayFor(r))`), never by passing `AuditEntryDto.from` itself to `remapPage` (which would pass the array index as `display`).
- `AuditDisplay`, `EMPTY_AUDIT_DISPLAY` (all four fields `null`) and `AuditDisplayNames` live in `apps/api/src/audit/domain/audit-entry.domain.ts`. `AuditDisplayNames` is `{ users: Map<string, string>; agents: Map<string, string>; runners: Map<string, string>; projects: Map<string, { slug: string; name: string }> }`, keyed by id.
- **Designer's call — cross-module label reads.** `.nax/rules/api-data.md` § Layering says a module reads another module's data through that module's service. `findDisplayNames` instead reads the label columns of `User`, `Agent`, `Runner` and `Project` from the audit repository, because the owning modules do not export a by-ids label lookup (`UsersModule` exports nothing), and wiring four domain modules into the global `AuditLogModule` couples it to all of them for a label projection. The read is a read-only label projection (`id` plus the label columns, `select` only), one `findMany` per kind, and never writes.

### API: correlation filter (US-002)

`ListAuditQuery` and the filter chain gain `correlationId` (`@IsOptional() @IsString() @MaxLength(128)`, exact match), passed through `AuditLogService.list` and `PrismaAuditEntryRepository.findPage` like the other id filters. It lets the page show every write of one request or run.

### API: `GET /api/audit/keys` (US-002)

- `test/e2e/api-endpoint/endpoint.e2e.spec.ts` gains the route (200 with the admin token, 401 without credentials), as `.nax/rules/api-testing.md` requires for endpoint changes.

- `AuditController.keys()`, `@Get('keys')`, `@UseGuards(RequiresGuard)`, `@Requires('audit.read')`, returns `JsonResponse.Ok({ keys })`.
- `keys` is the distinct `AuditEntry.key` values, sorted ascending (`PrismaAuditEntryRepository.findDistinctKeys()`: `findMany({ distinct: ['key'], select: { key: true }, orderBy: { key: 'asc' } })`), exposed through `AuditLogService.keys()`. The key set is small (catalog keys plus system and runner keys), so there is no paging.
- `openapi.json` is regenerated with `bun run api:export-spec` from the repo root, in US-002, after both contract changes exist; it gains the `GET /api/audit/keys` operation and the `correlationId` query parameter on `GET /api/audit`.

### Web: query model and composable (US-003)

`lib/audit-log.ts` (pure, no Vue):

```ts
export type AuditActorType = 'USER' | 'AGENT' | 'RUNNER' | 'SYSTEM'
export interface AuditFilters {
  key: string; actorType: AuditActorType | ''; actorId: string; approverId: string
  projectId: string; resourceType: string; resourceId: string; correlationId: string
  from: string; to: string   // 'YYYY-MM-DD' or ''
  page: number               // >= 1
}
export const EMPTY_AUDIT_FILTERS: AuditFilters
export const AUDIT_PAGE_SIZE = 50
export function parseAuditRoute(query: Record<string, QueryValue>): AuditFilters
export function auditRouteQuery(filters: AuditFilters): Record<string, string>
export function auditApiQuery(filters: AuditFilters): Record<string, string>
export function withFilter(filters: AuditFilters, patch: Partial<Omit<AuditFilters, 'page'>>): AuditFilters
export function relatedFilters(correlationId: string): AuditFilters
export function principalLabel(principal: { type: string; id: string }, name: string | null): string
```

- `QueryValue` (a route query value: string, null, undefined or an array of them) is defined locally in `lib/audit-log.ts`; the helpers in `lib/fleet-log-query.ts` are module-private, so `first` and `cut` are copied, not imported.
- `parseAuditRoute` reads the first string of each route value, trimmed, cut to 128 characters; an `actorType` outside the four types becomes `''`; a `from` / `to` that is not `YYYY-MM-DD` becomes `''`; `page` is a positive integer, else 1. Mirrors `lib/fleet-log-query.ts` (`first`, `cut`).
- `auditRouteQuery` emits only non-empty fields, and `page` only when it is above 1.
- `auditApiQuery` emits the non-empty filter fields plus `current` (the page) and `size` (`'50'`), all as strings. Field names are the API's (`ListAuditQuery`): `key`, `actorType`, `actorId`, `approverId`, `projectId`, `resourceType`, `resourceId`, `correlationId`, `from`, `to`.
- `withFilter` returns a new object with the patch applied and `page` reset to 1; it never mutates its input.
- `relatedFilters` returns `EMPTY_AUDIT_FILTERS` with only `correlationId` set.
- `principalLabel` returns `name` when it is a non-empty string, else the id.

`composables/useAuditLog.ts`, the only place the page touches the API (`.nax/rules/web.md` § API Access):

```ts
export interface AuditEntry { /* AuditEntryDto fields, including display */ }
export function useAuditLog(): {
  entries: Ref<AuditEntry[]>; total: Ref<number>; hasNext: Ref<boolean>; pending: Ref<boolean>
  keys: Ref<string[]>
  load(filters: AuditFilters): Promise<void>   // GET /audit with auditApiQuery(filters)
  loadKeys(): Promise<void>                    // GET /audit/keys
}
```

A failed `load` or `loadKeys` rethrows and leaves the previous state in place (`useAdminUsers` pattern).

### Web: Admin → Audit log page (US-004 to US-007)

`pages/admin/audit.vue`, layout `default`, title and subtitle via `PageHeader`:

- **Explicit imports.** `audit.vue` imports `useAuditLog` from `~/composables/useAuditLog` and the helpers from `~/lib/audit-log` explicitly (the test harness `mountSfc` injects only its fixed `NUXT_AUTO_IMPORTS` list, which does not hold `useAuditLog`).
- **State in the URL.** The page derives its filters with `parseAuditRoute(route.query)` and loads on mount and on every route-query change. Every control writes the URL with `router.replace({ query: auditRouteQuery(next) })` and never loads directly (pattern: `pages/admin/fleet/analytics.vue`).
- **Filter row** (`FilterBar`): key select and actor type select as `FleetNativeSelect` (`components/fleet/NativeSelect.vue`, `testid` prop rendered as `data-testid`, emits `update:modelValue`; page tests register the real component as `fleet-analytics-page.spec.ts` does), date `from` and `to` inputs (the ui `Input` with `type="date"`, bound with `:model-value` and `@update:model-value`, not a native `v-model` input; labelled as UTC days), and a Refresh button. The key options are "All keys" (`''`) plus `keys`, plus the current `filters.key` when it is set and not in `keys` (so a URL key or a failed keys load never leaves the select blank). Actor type options: all (`''`), USER, AGENT, RUNNER, SYSTEM.
- **Test ids** the ACs rely on: `audit-row` (one per entry), `audit-actor` / `audit-project` / `audit-resource` (the clickable cells), `audit-key-filter` and `audit-actor-type-filter` (the `FleetNativeSelect` `testid`s), `audit-from`, `audit-to`, `audit-refresh`, `audit-chip` (with `data-filter` = `actor` | `approver` | `project` | `resource` | `correlation`) and its `audit-chip-remove` button, `audit-prev`, `audit-next`, `audit-admin-only`, `audit-empty`, `audit-expand`, `audit-detail`, `audit-show-related`.
- **Active filter chips** (US-005) for the id filters (actor, approver, project, resource, correlation). An actor, approver or project chip shows the name from the first loaded entry that carries the same id (`display.*`), else the raw id; a resource chip shows `resourceType/resourceId`; a correlation chip shows the raw correlation id. Each chip and has a remove button that writes the URL without that filter (actor removes both `actorType` and `actorId`; resource removes both `resourceType` and `resourceId`).
- **Table**, one row per entry: local time (`toLocaleString` in the active locale), key, actor (`principalLabel(actor, display.actor)` with an actor-type badge, and "on behalf of <name>" when `onBehalfOf` is set), project (`display.project.slug`, else the raw `projectId`, else a dash), resource (`resourceType` and `resourceId`), summary (interpolated text, never `v-html`).
- **Click to filter.** Clicking a row's actor applies `{ actorType, actorId }`; its project applies `{ projectId }`; its resource applies `{ resourceType, resourceId }` (all through `withFilter`).
- **Paging.** Previous and Next buttons (US-006); Next is disabled when `hasNext` is false, Previous on page 1. They write `page` into the URL.
- **States.** A 403 (envelope code 40003 or 403; reuse the existing `isForbidden` helper pattern of `pages/admin/roles.vue`) shows the page's admin-only message and no table. An empty page shows an empty-state message.
- **Row detail** (US-007): an expand control on each row shows `components/audit/AuditEntryDetail.vue`, which `audit.vue` imports explicitly (`import AuditEntryDetail from '~/components/audit/AuditEntryDetail.vue'`, as `roles.vue` imports `RoleEditorDialog`). Prop `entry: AuditEntry` (the type exported by `useAuditLog.ts`). It shows: origin label, correlation id with a "Show related" button that emits `related` with the correlation id (the page then writes `auditRouteQuery(relatedFilters(correlationId))`), approval `requiredMode` and `satisfiedBy` labels, approver (`principalLabel` over `approval.approverType` / `approverId` and `display.approver`) when present, approval request id when present, `onBehalfOf` principal when present, and the full ISO `createdAt`.
- **Navigation** (US-007): `layouts/default.vue` gains a `/admin/audit` link in the Admin section, gated on `audit.read` and included in `showAdminNav`; `components/CommandPalette.vue` gains an `audit` command to `/admin/audit` when the global set holds `audit.read`.
- **i18n**: `nav.audit` and the `admin.audit.*` keys in both `i18n/locales/en.json` and `zh.json`, including labels for the four actor types, the five origins (`rest`, `mcp`, `thread`, `runner`, `system`) and the four `satisfiedBy` values (`none`, `self`, `agent`, `human`).

### Integration

Read-only symbols (verified at `35769e6d`):

- `AuditController` — `apps/api/src/audit/audit.controller.ts`, `list(@Query() rawQuery: ListAuditQuery)` with `parseQuery(ListAuditQuery, rawQuery)` and `toPageResult(...)`.
- `Requires` / `RequiresGuard` — `apps/api/src/permissions/requires.decorator.ts`, `requires.guard.ts`.
- `parseQuery`, `toPageResult`, `remapPage`, `KodaPageQuery` — `apps/api/src/common/dto/koda-page.query.ts`.
- `useGlobalPermissions()` — `apps/web/composables/usePermissions.ts`, `{ permissions: ComputedRef<PermissionSet> }` with `has(key)`.
- `ApiError`, `extractApiError`, `useApi` — `apps/web/composables/useApi.ts`.
- `PageHeader`, `FilterBar` (`components/FilterBar.vue`), `FleetNativeSelect` (`components/fleet/NativeSelect.vue`); `components/ui/{input,button,badge,table}`.
- Test harnesses: `tests/pages/fleet-analytics-page.spec.ts` (reactive `route.query` and a `replace` spy that writes it, `useRoute` / `useRouter` globals), `tests/helpers/fleet-harness.ts` (`uiStubs` stubs `FleetNativeSelect` but not `FilterBar`: a page test registers a passthrough `FilterBar` stub that renders its slot), `tests/helpers/permission-nav.ts` (`ADMIN_NAV_KEYS`, `adminNavFlags`, which mirror the layout's admin flags).

Mutated symbols. The baseline exists only to locate the code; implement the target.

- `AuditEntryDto` — `apps/api/src/audit/dto/audit-entry.dto.ts`
  - Baseline: `static from(r: AuditEntryRecord): AuditEntryDto`, no `display` property.
  - Target: `@ApiProperty({ type: Object }) declare display: AuditDisplay;` and `static from(r: AuditEntryRecord, display: AuditDisplay = EMPTY_AUDIT_DISPLAY): AuditEntryDto`.
- `AuditLogService` — `apps/api/src/audit/audit-log.service.ts`
  - Baseline: `list(query, page)` returns `remapPage(await this.repo.findPage(filters, page), AuditEntryDto.from)`; `AuditListQuery` has no `correlationId`; no `keys()`.
  - Target: `list` passes `correlationId` through, then resolves names with one `findDisplayNames` call and maps with `AuditEntryDto.from(record, display)`; `keys(): Promise<string[]>` returns `repo.findDistinctKeys()`.
- `PrismaAuditEntryRepository` — `apps/api/src/audit/prisma-audit-entry.repository.ts`
  - Baseline: `findPage(filters, page)` only.
  - Target: `findPage` also matches `correlationId`; new `findDisplayNames(ids: { userIds: string[]; agentIds: string[]; runnerIds: string[]; projectIds: string[] }): Promise<AuditDisplayNames>` (maps by id: users and agents and runners to a label string, projects to `{ slug, name }`); new `findDistinctKeys(): Promise<string[]>`.
- `AuditEntryFilters` — `apps/api/src/audit/domain/audit-entry.domain.ts`: gains `correlationId?: string`; the file also gains `AuditDisplay`, `EMPTY_AUDIT_DISPLAY` and `AuditDisplayNames`.
- `ListAuditQuery` — `apps/api/src/audit/dto/list-audit.query.ts`: gains `correlationId?: string` (`@IsOptional() @IsString() @MaxLength(128)`).
- `layouts/default.vue`: gains `canReadAudit = computed(() => globalPermissions.value.has('audit.read'))`, the link, and the `showAdminNav` term.
- `components/CommandPalette.vue`: gains `canReadAudit` and the `audit` command.

### Failure Handling

| Situation | Behaviour |
|:--|:--|
| An entry's actor, on-behalf-of or approver id matches no row | That `display` field is `null`; the request succeeds. |
| An entry's `projectId` matches no project | `display.project` is `null`; the request succeeds. |
| `findDisplayNames` throws (database error) | `AuditLogService.list` rejects with that error; no partial page is returned (fail closed). |
| `GET /api/audit/keys` by a caller without `audit.read` | 403, as `GET /api/audit`. |
| Route query value invalid (unknown `actorType`, malformed date, non-positive page) | `parseAuditRoute` drops it to its empty value; no request error. |
| `GET /audit` refused with 403 | Page shows its admin-only message, no table. |
| `GET /audit` refused otherwise (for example the 400 reversed window) | `toast.error(extractApiError(err))`; the table keeps its last loaded rows. |
| `GET /audit/keys` fails | `toast.error(extractApiError(err))`; the entry table still renders. |

## Out of Scope

- Exporting audit entries (CSV, JSON download) is out of scope.
- A project-scoped audit page or project-admin access to audit entries is out of scope: `audit.read` stays a global key.
- Live updates, polling or SSE on the audit page are out of scope; the page loads on mount, on URL change and on Refresh.
- A CLI `koda audit` command and regenerating `apps/cli/src/generated/` are out of scope.
- Free-text or prefix search over keys, summaries or resource ids is out of scope; the key filter is an exact match chosen from `GET /api/audit/keys`.
- Filtering by origin or by on-behalf-of principal is out of scope.
- Actor, approver or project picker dropdowns are out of scope; those filters are applied by clicking a row value and removed through their chip.
- Linking a row's resource to its own page (ticket, job, thread) is out of scope.
- Date filtering in the browser's time zone is out of scope: `from` / `to` are UTC days, as the API defines them.
- Retention, deletion or redaction of audit entries is out of scope.
- An `AuditEntryDto` or `AuditKeysDto` component schema in `openapi.json` is out of scope (the routes' `@ApiResponse` carries no `type`, as on `AuditController.list`).
- Updating `docs/ux/redesign/MASTER-PLAN.md` is out of scope (this page is not a redesign slice).
- Discarding out-of-order `GET /audit` responses when the URL changes quickly is out of scope; each load writes its result when it resolves.
- Auditing the remaining writers, assistant tools and the coverage guard are out of scope (next feature, `permissions-p2-audit-integrations`).


## Stories

1. **US-001: Audit entries carry resolved names** — `Workdir: apps/api` — No dependencies. `AuditEntryDto.display`, the `AuditDisplay` types in the domain file, `PrismaAuditEntryRepository.findDisplayNames`, and the one-batch resolution in `AuditLogService.list`.
2. **US-002: Correlation filter and `GET /api/audit/keys`** — `Workdir: apps/api` — Depends on US-001. The `correlationId` filter through `ListAuditQuery`, `AuditEntryFilters`, `AuditLogService.list` and `findPage`; `AuditController.keys`, `AuditLogService.keys`, `PrismaAuditEntryRepository.findDistinctKeys`; the endpoint e2e and spec-integrity entries; and the regenerated `openapi.json` (last, so it carries both contract changes).
3. **US-003: Web audit query model and `useAuditLog`** — `Workdir: apps/web` — Depends on US-002. Creates `lib/audit-log.ts` and `composables/useAuditLog.ts`.
4. **US-004: Audit log page: list, filters and click-to-filter** — `Workdir: apps/web` — Depends on US-003. Creates `pages/admin/audit.vue` with the URL-held filters, the key and actor-type selects, the date inputs, the table and click-to-filter, and the `admin.audit.*` locale keys it uses in both locales.
5. **US-005: Audit log page: active-filter chips** — `Workdir: apps/web` — Depends on US-004. The active-filter chips (labels and remove buttons) in `pages/admin/audit.vue`, with their locale keys.
6. **US-006: Audit log page: paging, refresh and states** — `Workdir: apps/web` — Depends on US-005. Previous / Next / Refresh and the admin-only, error and empty states in `pages/admin/audit.vue`, with their locale keys.
7. **US-007: Audit row detail and navigation** — `Workdir: apps/web` — Depends on US-006. Creates `components/audit/AuditEntryDetail.vue` and the row expand control; the `/admin/audit` sidebar link and the command palette entry gated on `audit.read`; `nav.audit` and the detail locale keys in both locales.

### Context Files

**US-001**
- `apps/api/src/audit/audit-log.service.ts` — `list`, edited
- `apps/api/src/audit/prisma-audit-entry.repository.ts` — gains `findDisplayNames`, edited
- `apps/api/src/audit/dto/audit-entry.dto.ts` — `AuditEntryDto.from`, edited
- `apps/api/src/audit/domain/audit-entry.domain.ts` — gains the display types, edited
- `apps/api/test/integration/audit/audit-route.integration.spec.ts` — boot, fixture and request helpers to mirror, read

**US-002**
- `apps/api/src/audit/audit.controller.ts` — gains `keys`, edited
- `apps/api/src/audit/dto/list-audit.query.ts` — gains `correlationId`, edited
- `apps/api/src/audit/prisma-audit-entry.repository.ts` — `findPage` filter and `findDistinctKeys`, edited
- `apps/api/src/audit/audit-log.service.ts` — filter pass-through and `keys`, edited
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — the `GET /api/audit` block at lines 342-348 to mirror, edited

**US-003**
- `apps/web/lib/fleet-log-query.ts` — the module-private `first` / `cut` route-query helpers to copy, read
- `apps/web/composables/useAdminUsers.ts` — paged load composable to mirror, read
- `apps/web/composables/useApi.ts` — `$api.get`, read

**US-004**
- `apps/web/tests/pages/fleet-analytics-page.spec.ts` — page harness with reactive `route.query`, `replace` spy and `settle()`, read
- `apps/web/pages/admin/fleet/analytics.vue` — `router.replace` URL-held state, read
- `apps/web/components/fleet/NativeSelect.vue` — `FleetNativeSelect` props and events, read
- `apps/web/components/FilterBar.vue` — filter row slot, read
- `apps/web/composables/useAuditLog.ts` — created by US-003, used here

**US-005**
- `apps/web/pages/admin/audit.vue` — created by US-004, edited here
- `apps/web/pages/admin/roles.vue` — `isForbidden` and the admin-only state, read
- `apps/web/pages/admin/users.vue` — Previous / Next buttons, read
- `apps/web/tests/pages/fleet-analytics-page.spec.ts` — page harness, read

**US-006**
- `apps/web/pages/admin/audit.vue` — created by US-004, edited here
- `apps/web/pages/admin/roles.vue` — `isForbidden` and the admin-only state, read
- `apps/web/pages/admin/users.vue` — Previous / Next buttons, read
- `apps/web/tests/pages/fleet-analytics-page.spec.ts` — page harness, read

**US-007**
- `apps/web/pages/admin/audit.vue` — created by US-004, gains the expand control here
- `apps/web/layouts/default.vue` — admin nav gates, edited
- `apps/web/components/CommandPalette.vue` — gated commands, edited
- `apps/web/tests/layouts/default-permission-nav.spec.ts` — `ADMIN_LINKS` table and layout render harness, edited
- `apps/web/tests/components/command-palette-roles.spec.ts` — palette mount harness to copy, read

### Creates

**US-001**
- `apps/api/test/integration/audit/audit-display.integration.spec.ts` — `display` names over the real route
- `apps/api/src/audit/prisma-audit-entry.repository.spec.ts` — `findDisplayNames` query shape over a fake Prisma client

**US-002**
- `apps/api/test/integration/audit/audit-keys.integration.spec.ts` — the correlation filter and `GET /api/audit/keys`

**US-003**
- `apps/web/lib/audit-log.ts` — the pure query model
- `apps/web/composables/useAuditLog.ts` — the API composable
- `apps/web/tests/lib/audit-log.spec.ts`
- `apps/web/tests/composables/use-audit-log.spec.ts`

**US-004**
- `apps/web/pages/admin/audit.vue` — the page
- `apps/web/tests/pages/admin-audit.spec.ts` — list, filters and click-to-filter

**US-005**
- `apps/web/tests/pages/admin-audit-chips.spec.ts` — the active-filter chips

**US-006**
- `apps/web/tests/pages/admin-audit-states.spec.ts` — paging, refresh and states

**US-007**
- `apps/web/components/audit/AuditEntryDetail.vue` — the row detail
- `apps/web/tests/components/audit-entry-detail.spec.ts`
- `apps/web/tests/components/command-palette-audit.spec.ts`

### Modifies

**US-001**
- `apps/api/src/audit/audit-log.service.ts` — `list` resolves names with one `findDisplayNames` call per non-empty page and maps each record with `AuditEntryDto.from(record, display)` through a closure.
- `apps/api/src/audit/prisma-audit-entry.repository.ts` — gains `findDisplayNames` (one `select`-only `findMany` per non-empty id list over user, agent, runner and project); `findPage` is unchanged.
- `apps/api/src/audit/dto/audit-entry.dto.ts` — `AuditEntryDto` gains `display` and `from` takes an optional display defaulting to `EMPTY_AUDIT_DISPLAY`.
- `apps/api/src/audit/domain/audit-entry.domain.ts` — gains `AuditDisplay`, `EMPTY_AUDIT_DISPLAY` and `AuditDisplayNames`.
- `apps/api/src/audit/audit-log.service.spec.ts` — the `setup()` mock repository gains `findDisplayNames` resolving four empty Maps (`AuditLogService.list` now calls it once per non-empty page); the existing AC-1..AC-7 assertions are unchanged, and new cases for the one-batch call, the empty page and the rejected lookup are added.
- `apps/api/src/audit/dto/audit-entry.dto.spec.ts` — gains the case that `AuditEntryDto.from(record)` without a display yields the all-null `display`; the existing AC-8..AC-13 assertions are unchanged.

**US-002**
- `apps/api/src/audit/dto/list-audit.query.ts` — `ListAuditQuery` gains `correlationId` (`@IsOptional() @IsString() @MaxLength(128)`).
- `apps/api/src/audit/domain/audit-entry.domain.ts` — `AuditEntryFilters` gains `correlationId`.
- `apps/api/src/audit/audit-log.service.ts` — `AuditListQuery` and `list` pass `correlationId` through; gains `keys()`.
- `apps/api/src/audit/prisma-audit-entry.repository.ts` — `findPage` matches `correlationId`; gains `findDistinctKeys`.
- `apps/api/src/audit/audit.controller.ts` — gains `@Get('keys')` `keys()` under `@Requires('audit.read')`.
- `apps/api/src/audit/audit-log.service.spec.ts` — gains the cases for the `correlationId` pass-through and `keys()`; existing assertions unchanged.
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — gains GET /api/audit/keys returning 200 with the admin token and 401 without credentials, beside the GET /api/audit cases; existing cases unchanged.
- `apps/api/test/integration/openapi-spec/spec-integrity.integration.spec.ts` — its expected-endpoint list gains the entry with path '/api/audit/keys' and method 'get'; the existing entries and the decorator checks are unchanged.
- `openapi.json` — regenerated with bun run api:export-spec (repo root) so it gains the GET /api/audit/keys operation and the correlationId query parameter on GET /api/audit; unrelated drift from the regeneration is allowed.

**US-003**

None. US-003 only creates files.

**US-004**
- `apps/web/i18n/locales/en.json` — gains the `admin.audit` keys the page uses (title, subtitle, filter labels, column headers, actor-type labels, on-behalf-of text); existing keys are unchanged.
- `apps/web/i18n/locales/zh.json` — gains the same `admin.audit` keys in Chinese; existing keys are unchanged.

**US-005**
- `apps/web/i18n/locales/en.json` — gains the `admin.audit` chip keys (chip labels, remove); existing keys are unchanged.
- `apps/web/i18n/locales/zh.json` — gains the same keys in Chinese; existing keys are unchanged.

**US-006**
- `apps/web/i18n/locales/en.json` — gains the `admin.audit` paging, refresh, admin-only and empty-state keys; existing keys are unchanged.
- `apps/web/i18n/locales/zh.json` — gains the same keys in Chinese; existing keys are unchanged.

**US-007**
- `apps/web/layouts/default.vue` — gains `canReadAudit` (`audit.read`), the link to /admin/audit in the Admin section and the `showAdminNav` term.
- `apps/web/components/CommandPalette.vue` — gains `canReadAudit` and the `audit` command to /admin/audit.
- `apps/web/tests/layouts/default-permission-nav.spec.ts` — `ADMIN_LINKS` gains the entry for /admin/audit with key audit.read, so its existing per-key and no-key loops cover the new link; existing assertions unchanged.
- `apps/web/tests/helpers/permission-nav.ts` — `ADMIN_NAV_KEYS` gains `'audit.read'` and `adminNavFlags` gains `canReadAudit`, so it keeps mirroring the layout's admin flags.
- `apps/web/i18n/locales/en.json` — gains `nav.audit` and the `admin.audit.detail` keys (origin, satisfiedBy and requiredMode labels, show related); existing keys are unchanged.
- `apps/web/i18n/locales/zh.json` — gains the same keys in Chinese; existing keys are unchanged.

### Seams

- US-001 → US-003/US-004 (data): the web reads `display.actor`, `display.onBehalfOf`, `display.approver` and `display.project.slug`, all declared on `AuditEntryDto.display` by US-001.
- US-002 → US-003: `useAuditLog.loadKeys` reads `GET /audit/keys` `{ keys }` (US-003 AC-13).
- US-003 → US-004: the page loads through the real `useAuditLog` and `lib/audit-log.ts`; US-004 AC-1 and AC-3 assert the `$api.get` calls the mounted page makes.
- US-005 and US-006 build on the page US-004 creates; their ACs mount the same page.
- US-007: the row expand control in the mounted page renders `AuditEntryDetail` for that entry (US-007 AC-1), and the detail's `related` event reaches `router.replace` through the page (US-007 AC-7).

## Acceptance Criteria

### US-001: Audit entries carry resolved names (`Workdir: apps/api`)

Integration ACs boot the app like `audit-route.integration.spec.ts` (`bootHttpApp`, `seedFleetHttpWorld`, `fixtureDb(app)`) and call `GET /api/audit` with the root user's token. Entries are inserted directly with `db.auditEntry.create` through `fixtureDb(app)`. Named users are the seeded `world.ids` users with their name set by `db.user.update` (no new users are created). Agents come from `seedFleetHttpAgent`, runners from `insertRunner(db, { name })`, and a soft-deleted project from setting `deletedAt` on the seeded `ops` project.

1. [integration] An entry whose actor is a `USER` named `Ada` is returned with `display.actor` equal to `Ada`.
2. [integration] An entry whose actor is a `USER` whose `name` is null is returned with `display.actor` equal to that user's email.
3. [integration] An entry whose actor is a `USER` whose `name` is `'   '` is returned with `display.actor` equal to that user's email.
4. [integration] An entry whose actor is an `AGENT` is returned with `display.actor` equal to that agent's `name`.
5. [integration] An entry whose actor is a `RUNNER` created with name `wk-mac` is returned with `display.actor` equal to `wk-mac`.
6. [integration] An entry whose actor is `SYSTEM` with id `scheduler` is returned with `display.actor` null.
7. [integration] An entry with `onBehalfOfType` `USER` and `onBehalfOfId` a user named `Bea` is returned with `display.onBehalfOf` equal to `Bea`.
8. [integration] An entry with `approverType` `AGENT` and `approverId` an agent is returned with `display.approver` equal to that agent's `name`.
9. [integration] An entry whose `projectId` is the soft-deleted `ops` project is returned with `display.project` equal to `{ slug: 'ops', name: <the ops project's name> }`.
10. [integration] An entry whose `USER` actor id, `onBehalfOfId`, `approverId` and `projectId` are all `ghost` (matching no row) is returned with `display` equal to `{ actor: null, onBehalfOf: null, approver: null, project: null }`.
11. [unit] `AuditLogService.list` over a page of three records whose actors are the same `USER` `u1` and whose `projectId`s are `p1`, `p1` and `p2` records exactly one `findDisplayNames` call, whose argument is `{ userIds: ['u1'], agentIds: [], runnerIds: [], projectIds: ['p1', 'p2'] }`.
12. [unit] `AuditLogService.list` over an empty page does not call `findDisplayNames`.
13. [unit] When `findDisplayNames` rejects with an error, `AuditLogService.list` rejects with that same error.
14. [unit] `PrismaAuditEntryRepository.findDisplayNames({ userIds: ['u1'], agentIds: [], runnerIds: [], projectIds: [] })` over a fake Prisma client makes no `findMany` call other than `user.findMany`.
15. [unit] `AuditEntryDto.from(record)` called without a display returns `display` equal to `{ actor: null, onBehalfOf: null, approver: null, project: null }`.

### US-002: Correlation filter and `GET /api/audit/keys` (`Workdir: apps/api`)

Integration ACs use the same boot and fixtures as `audit-route.integration.spec.ts`.

1. [integration] With three entries whose `correlationId` values are `c-1`, `c-1` and `c-2`, `GET /api/audit?correlationId=c-1` returns exactly the two `c-1` entries.
2. [unit] `AuditLogService.list` given `correlationId: 'c-1'` calls `findPage` with filters whose `correlationId` is `c-1`.
3. [integration] With entries keyed `comment.create`, `ticket.create` and `comment.create`, `GET /api/audit/keys` as the root user returns 200 with `data.keys` equal to `['comment.create', 'ticket.create']`.
4. [integration] With no audit entries, `GET /api/audit/keys` as the root user returns 200 with `data.keys` equal to `[]`.
5. [integration] `GET /api/audit/keys` as a user holding only the `project-admin` role in one project returns 403.
6. [integration] `GET /api/audit/keys` with the seeded global agent's key returns 403.
7. [integration] `GET /api/audit/keys` without credentials returns 401.
8. [integration] In `endpoint.e2e.spec.ts`, `GET /api/audit/keys` with the admin token returns 200.
9. [integration] In `endpoint.e2e.spec.ts`, `GET /api/audit/keys` without credentials returns 401.
10. [integration] `GET /api/audit?correlationId=<a 129-character string>` returns 400.

### US-003: Web audit query model and `useAuditLog` (`Workdir: apps/web`)

1. [unit] `parseAuditRoute({})` returns `EMPTY_AUDIT_FILTERS`, whose string fields are all `''` and whose `page` is 1.
2. [unit] `parseAuditRoute({ key: ' ticket.create ', actorId: ['a1', 'a2'], projectId: 'p1', from: '2026-10-01', page: '3' })` returns `EMPTY_AUDIT_FILTERS` with `key` `ticket.create`, `actorId` `a1`, `projectId` `p1`, `from` `2026-10-01` and `page` 3.
3. [unit] `parseAuditRoute({ actorType: 'BOGUS', to: 'yesterday', page: 'abc' })` returns `EMPTY_AUDIT_FILTERS`.
4. [unit] `parseAuditRoute({ resourceId: <a 200-character string> })` returns a `resourceId` of 128 characters.
5. [unit] `auditRouteQuery` of `EMPTY_AUDIT_FILTERS` with `key` `ticket.create` and `page` 2 returns `{ key: 'ticket.create', page: '2' }`.
6. [unit] `auditApiQuery` of `EMPTY_AUDIT_FILTERS` with `actorType` `AGENT`, `actorId` `a1`, `from` `2026-10-01` and `page` 2 returns `{ actorType: 'AGENT', actorId: 'a1', from: '2026-10-01', current: '2', size: '50' }`.
7. [unit] `withFilter` of filters with `key` `ticket.create` and `page` 3, patched with `{ projectId: 'p1' }`, returns filters with `key` `ticket.create`, `projectId` `p1` and `page` 1.
8. [unit] `relatedFilters('c-1')` returns `EMPTY_AUDIT_FILTERS` with `correlationId` `c-1`.
9. [unit] `principalLabel({ type: 'USER', id: 'u1' }, 'Ada')` returns `Ada`.
10. [unit] `principalLabel({ type: 'SYSTEM', id: 'scheduler' }, null)` returns `scheduler`.
11. [unit] `useAuditLog().load(filters)` over a fake `$api` calls `$api.get('/audit', { query: auditApiQuery(filters) })`.
12. [unit] After `useAuditLog().load(filters)` resolves over a fake `$api` answering one entry with `total` 1 and `hasNext` true, `entries` holds that one entry and `hasNext` is true.
13. [unit] `useAuditLog().loadKeys()` over a fake `$api` answering `{ keys: ['comment.create'] }` calls `$api.get('/audit/keys')` and sets `keys` to `['comment.create']`.
14. [unit] When a second `load` rejects, `load` rethrows the error and `entries` keeps the entries of the first load.

### US-004: Audit log page: list, filters and click-to-filter (`Workdir: apps/web`)

ACs mount `pages/admin/audit.vue` for real (harness: `tests/pages/fleet-analytics-page.spec.ts`): a fake `$api`, a reactive `route` whose `query` the `replace` spy overwrites, `useRoute` / `useRouter` globals, a global permission set holding `audit.read`, `uiStubs` plus a passthrough `FilterBar` stub, and the real `useAuditLog` underneath. Controls are found by the test ids in the Design.

1. [unit] Mounted with an empty route query, the page calls `$api.get('/audit', { query: { current: '1', size: '50' } })`.
2. [unit] Mounted with an empty route query, the page calls `$api.get('/audit/keys')`.
3. [unit] Mounted with route query `{ key: 'ticket.create', actorType: 'AGENT', from: '2026-10-01' }`, the page calls `$api.get('/audit', ...)` with query `{ key: 'ticket.create', actorType: 'AGENT', from: '2026-10-01', current: '1', size: '50' }`.
4. [unit] With `GET /audit` answering an entry with `key` `ticket.create`, actor `USER` `u1`, `display.actor` `Ada`, `display.project.slug` `web`, resource `ticket` / `t1` and summary `created`, its `audit-row` shows each of `ticket.create`, `Ada`, `web`, `ticket`, `t1` and `created`.
5. [unit] An `audit-row` whose entry has `onBehalfOf` `{ type: 'USER', id: 'u2' }` and `display.onBehalfOf` `Bea` shows `Bea`.
6. [unit] When the route query changes from `{}` to `{ projectId: 'p1' }` after mount, the page calls `$api.get('/audit', ...)` again with query `{ projectId: 'p1', current: '1', size: '50' }`.
7. [unit] Emitting `update:modelValue` with `comment.create` from the `audit-key-filter` select calls `router.replace` with `{ query: { key: 'comment.create' } }`.
8. [unit] Emitting `update:modelValue` with `RUNNER` from the `audit-actor-type-filter` select calls `router.replace` with `{ query: { actorType: 'RUNNER' } }`.
9. [unit] Setting the `audit-from` input to `2026-10-01` on route query `{ page: '3' }` calls `router.replace` with `{ query: { from: '2026-10-01' } }`.
10. [unit] Clicking the `audit-actor` cell of a row whose actor is `{ type: 'AGENT', id: 'a1' }` calls `router.replace` with `{ query: { actorType: 'AGENT', actorId: 'a1' } }`.
11. [unit] Clicking the `audit-project` cell of a row whose `projectId` is `p1` calls `router.replace` with `{ query: { projectId: 'p1' } }`.
12. [unit] Clicking the `audit-resource` cell of a row with resource `ticket` / `t1` calls `router.replace` with `{ query: { resourceType: 'ticket', resourceId: 't1' } }`.
13. [unit] Mounted with route query `{ key: 'legacy.key' }` while `GET /audit/keys` answers `{ keys: ['comment.create'] }`, the `audit-key-filter` select's options include `legacy.key`.

### US-005: Audit log page: active-filter chips (`Workdir: apps/web`)

ACs mount `pages/admin/audit.vue` with the same harness as US-004.

1. [unit] Mounted with route query `{ actorType: 'AGENT', actorId: 'a1' }` and an entry whose actor is `a1` with `display.actor` `bot`, the `audit-chip` with `data-filter` `actor` shows `bot`.
2. [unit] Clicking `audit-chip-remove` on the actor chip, with route query `{ actorType: 'AGENT', actorId: 'a1', key: 'ticket.create' }`, calls `router.replace` with `{ query: { key: 'ticket.create' } }`.
3. [unit] Mounted with route query `{ approverId: 'u9' }` and no entry carrying `u9`, the `audit-chip` with `data-filter` `approver` shows `u9`.
4. [unit] Clicking `audit-chip-remove` on the project chip, with route query `{ projectId: 'p1', key: 'ticket.create' }`, calls `router.replace` with `{ query: { key: 'ticket.create' } }`.
5. [unit] Clicking `audit-chip-remove` on the resource chip, with route query `{ resourceType: 'ticket', resourceId: 't1' }`, calls `router.replace` with `{ query: {} }`.
6. [unit] Clicking `audit-chip-remove` on the correlation chip, with route query `{ correlationId: 'c-1' }`, calls `router.replace` with `{ query: {} }`.

### US-006: Audit log page: paging, refresh and states (`Workdir: apps/web`)

ACs mount `pages/admin/audit.vue` with the same harness as US-004.

1. [unit] With `GET /audit` answering `hasNext` true on page 1, clicking `audit-next` calls `router.replace` with `{ query: { page: '2' } }`.
2. [unit] Mounted on page 1, the `audit-prev` button is disabled.
3. [unit] With `GET /audit` answering `hasNext` false, the `audit-next` button is disabled.
4. [unit] Mounted with route query `{ page: '2', key: 'ticket.create' }`, clicking `audit-prev` calls `router.replace` with `{ query: { key: 'ticket.create' } }`.
5. [unit] Clicking `audit-refresh` calls `$api.get('/audit', ...)` again with the same query as the mount load.
6. [unit] When `GET /audit` rejects with an `ApiError` whose code is 40003, the page renders `audit-admin-only`.
7. [unit] When `GET /audit` rejects with a 400 `ApiError` after a first successful load, the page calls `toast.error(extractApiError(err))`.
8. [unit] When `GET /audit` rejects with a 400 `ApiError` after a first successful load, the page still renders the `audit-row`s of the first load.
9. [unit] When `GET /audit/keys` rejects, the page calls `toast.error(extractApiError(err))`.
10. [unit] With `GET /audit` answering no entries, the page renders `audit-empty` and no `audit-row`.
11. [unit] When `GET /audit/keys` rejects, the page still renders the `audit-row`s from `GET /audit`.

### US-007: Audit row detail and navigation (`Workdir: apps/web`)

1. [unit] In the mounted `pages/admin/audit.vue` (US-004 harness), clicking a row's `audit-expand` control renders `audit-detail` showing that entry's `correlationId`.
2. [unit] `AuditEntryDetail` mounted with an entry whose `origin` is `mcp`, `approval.satisfiedBy` `human`, `approverType` `USER`, `approverId` `u2`, `display.approver` `Bea` and `requestId` `pa1` shows the `mcp` origin label, the `human` satisfied-by label, `Bea` and `pa1`.
3. [unit] `AuditEntryDetail` mounted with an entry whose `approval.satisfiedBy` is `none` and whose approver is null shows no approver and no request id.
4. [unit] `AuditEntryDetail` mounted with an entry whose `approval.requiredMode` is `human` shows the `human` required-mode label.
5. [unit] `AuditEntryDetail` mounted with an entry whose `onBehalfOf` is `{ type: 'USER', id: 'u2' }` and `display.onBehalfOf` `Bea`, and `createdAt` `2026-10-25T09:19:52.501Z`, shows `Bea` and `2026-10-25T09:19:52.501Z`.
6. [unit] Clicking `audit-show-related` in `AuditEntryDetail` mounted with an entry whose `correlationId` is `c-1` emits `related` with `c-1`.
7. [unit] In the mounted page with route query `{ key: 'ticket.create', page: '2' }`, clicking `audit-show-related` in an expanded row whose `correlationId` is `c-1` calls `router.replace` with `{ query: { correlationId: 'c-1' } }`.
8. [unit] `layouts/default.vue` rendered with a global set holding only `audit.read` renders the `/admin/audit` link and the Admin section label.
9. [unit] `layouts/default.vue` rendered with a global set holding `role.read` and not `audit.read` renders no `/admin/audit` link.
10. [unit] `CommandPalette` with a global set holding `audit.read` offers the `audit` command, and running it navigates to `/admin/audit`.
11. [unit] `CommandPalette` with a global set without `audit.read` offers no `audit` command.
