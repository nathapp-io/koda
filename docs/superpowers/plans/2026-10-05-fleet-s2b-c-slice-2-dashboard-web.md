# Fleet S2b (c) Slice 2 — Dashboard Web + E2E Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A global admin opens `/admin/fleet` and a project member opens `/<project>/fleet/overview` and, on one
screen refreshed every 10 s while the tab is visible, sees which runners are up, what is running and how far along
it is, what finished in the last 24 h, and a ranked "needs attention" list. An E2E proves that a silent RUNNING job and
an unplaceable QUEUED job show on the admin page and do not leak into another project's page.

**Architecture:** Web only; slice 1 (#217) shipped both snapshot routes and the DTO. Pure modules own every decision a
test can pin: `lib/fleet-dashboard-types.ts` (wire types) and `lib/fleet-dashboard.ts` (server-clock ages, attention
wording as i18n keys + params, links, tiles, credential chips, text helpers). One composable,
`useFleetDashboard(scope)`, owns the request, the 10 s poll, a 1 s clock tick and the error state. Presentational
components in `components/fleet/dashboard/` take props only; `Overview.vue` composes them so the admin and project
pages are thin wrappers that differ only in scope, header and the 403 text.

**Tech Stack:** Nuxt 3.21 + `shadcn-nuxt` 0.10 (`radix-vue`) + Tailwind 3 + vue-i18n, Jest 29 (node environment,
`mountSfc`), Playwright. No new dependency. No API change.

**Spec:** `docs/superpowers/specs/2026-10-05-fleet-s2b-c-dashboard-design.md` §4 (all of it), §5 web and E2E rows,
§6 slice 2. Rulings B1, B2, B5, B6. Builds on slice 1 (#217, D402-D414): routes `GET /fleet/dashboard` and
`GET /projects/:slug/fleet/dashboard`, DTO `apps/api/src/fleet/dashboard/dto/fleet-dashboard.dto.ts`.

## Global Constraints

- Branch: `feat/fleet-s2b-dashboard-web` (already created from main `5241f541`). Do not switch branches.
- Web tests: Jest 29, `testEnvironment: node`, no DOM. Components and pages mount through `tests/helpers/mount-sfc.ts`
  (`mountSfc`); pure modules are imported through `~/`. Specs live in
  `apps/web/tests/{lib,composables,components,pages,i18n,layouts}/*.spec.ts` and import from `@jest/globals`.
  Run: `cd apps/web && bun run test -- <paths>`.
- `mountSfc` injects only the names in `NUXT_AUTO_IMPORTS` (`tests/helpers/mount-sfc.ts:113-118`). A page or
  composable that needs another auto-import imports it explicitly from `~/composables/...`. Components are never
  auto-imported in tests: pass them through `components:` (stubs) or `fleetComponents:` (real files listed in
  `FLEET_COMPONENT_FILES`). A component that renders `FleetJobStateBadge` imports it explicitly, as
  `pages/[project]/fleet/index.vue:8` does.
- Tailwind scans only `components/`, `layouts/`, `pages/`, `plugins/`, `app.vue`: class names live in `.vue` files,
  never in `lib/` or `composables/`.
- API paths with a variable go through the `apiPath` tagged template (`lib/api-path.ts`);
  `tests/lib/api-path-guard.spec.ts` fails an untagged template path.
- **Money:** the API sends 4-place decimal strings. Show them with `usd()` (`lib/fleet-analytics-format.ts`); never sum,
  round or re-format money in the browser.
- **The API sends no prose** (spec §2). Every attention line is worded in the web from the item's structured fields
  through `apps/web/i18n/locales/{en,zh}.json`. Never render `subjectName`, `runnerName`, `reason`, `providerId` or
  any other field as HTML: text interpolation only, no `v-html` anywhere in `components/fleet/dashboard/`.
- i18n: every key in both `en.json` and `zh.json`. No `|` or `@` anywhere under `fleet` or `nav`
  (`tests/i18n/fleet-locale-parity.spec.ts`). A subtree rendered through dynamic keys is pinned in that spec's `ENUMS`
  map with its exact key set.
- Polling only (B2): 10 s while the tab is visible, through `useVisiblePolling`; no SSE, no new live event.
- Access: the admin page is for global ADMIN (a 403 shows `fleet.common.adminOnly` and stops polling); the project
  page is for project members (a 403 shows `fleet.dashboard.forbidden` and stops polling). Agent principals get 403
  from the API on the project route; the web treats it the same way.
- Project scope (B5): the project page never shows credential chips, nax or daemon versions, and links no runner
  item (members cannot open the admin Runners page). The API already nulls those fields; the web must not render a
  placeholder that implies they exist.
- E2E resets the `koda_e2e` database (`prisma migrate reset`). Prisma refuses that from an AI agent without the
  user's consent: **ask the user first**, then run with
  `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION="<their exact consent message>"`.
- No emojis; no `console.log` in `apps/web` sources; build new objects and arrays, never mutate inputs or props.
- Web lint runs with `--max-warnings=0`; `bun run type-check` (`nuxt typecheck`) must pass.
- Every snippet names real files and helpers. If a name in a snippet does not exist in the code, that is a plan
  defect: stop and report it.

## Decisions

Numbered from D415 (slice 1 ended at D414).

| # | Decision | Why |
|:--|:--|:--|
| D415 | Wire types are hand-written in `lib/fleet-dashboard-types.ts`, mirroring `fleet-dashboard.dto.ts`. Enum-like wire fields (`kind`, `severity`, `verdict`, condition `type`, `why`, misfit `reason`, job `state`) are typed `string`; the known values are exported `as const` lists used by the wording code and pinned by the locale parity spec. | The web has no generated client. A newer API value must degrade to generic text, never crash (Review Focus 4). |
| D416 | Ages use the **server clock**: `now = generatedAt + (client time since the snapshot arrived)`, never negative (`serverNow`). A 1 s client tick advances it between polls. Server-measured seconds (`silentSec`, `oldestSec`) are advanced the same way (`liveSec`). | Spec §4.1 "ages from `generatedAt` plus a ticking client clock (clamped at 0)". Never comparing the browser clock with server time makes skew harmless. |
| D417 | Durations in attention lines use the coarse largest-unit form the fleet pages already use (`3m`, not `3m 10s`): `secParts` mirrors `ageParts` and renders through `fleet.common.duration.*`. | One age style across the app; the CLI keeps its own finer format. |
| D418 | Attention wording is data: `attentionMessage(item, generatedAt, now)` returns `{summary, details, more}` of `I18nText = {key, params?, ages?, labels?}`; `renderText(text, t, te)` turns one into a string (ages through `fleet.common.duration.*`, labels such as `fleet.misfit.<reason>` translated first, an unknown label falls back to its raw code as `codeLabel` does). Unplaceable items list every shown misfit reason as a detail (all verdicts), plus "and N more runner(s)" when `reasonsTotal` exceeds the 20 shown. Runner items have no summary; their conditions are the details. | Spec §4.1 "attention wording keys and params from item fields". Pure and testable with the real `en.json` (`enI18n`). |
| D419 | Links: job items open the job page `/<slug>/fleet/jobs/<id>`; approval items open `/<slug>/fleet/approvals` (both scopes); runner items open `/admin/fleet/runners` in the admin scope and are plain text in the project scope. Active and recent rows link the feature cell to the job page. A recent row's PR link renders only for an `http:`/`https:` URL (`safeHttpUrl`), with `rel="noopener noreferrer"`. | Spec §4.2. The API already filters PR URLs (`event-payloads.ts` `httpUrl`); the web check is defence in depth for an `href`. |
| D420 | Errors: the first load failing shows the shared `ErrorState` with Retry and keeps polling (no toast: a 10 s poll would toast-spam); a later failure keeps the last snapshot and shows "Could not refresh. Showing data from HH:MM." (`hhmm` of the client time of the last success); the next success clears it. A 403 (`isForbidden`, envelope `ret` 40003 or HTTP 403) stops both pollers and shows the scope's no-access text. | Spec §4.3. |
| D421 | **Spec correction (§4.1):** `useFleetDashboard(scope, deps?)` returns `{data, error, pending, forbidden, lastSuccessAt, now, refresh, start, stop}`; the **page** calls `start` in `onMounted` and `stop` in `onBeforeUnmount`. `start` runs the first load at once and starts the 10 s poller and the 1 s clock; `deps` (`PollingDeps`, a clock) exist for tests. | Lifecycle hooks registered inside a composable cannot be unit-tested outside a component; the runners and budgets pages already wire polling this way. |
| D422 | **Spec correction (§4.2):** component files drop the `Dashboard` prefix so Nuxt names them `FleetDashboard<File>`: `Tiles.vue`, `AttentionList.vue`, `ActiveRunsTable.vue`, `RunnerHealthList.vue`, `RecentRunsList.vue`, `CredentialDigestChips.vue`, plus `Overview.vue`, which composes them with the loading, error, stale and "updated" states. Both pages render `FleetDashboardOverview`. | Matches `components/fleet/analytics/Panel.vue` -> `FleetAnalyticsPanel`; one composition keeps the two scopes identical (B1). |
| D423 | Tiles: runners `online/total` (warn tone when any runner is offline), queued, running, attention (bad tone when above 0). Each tile is a link to its section anchor (`#fleet-dashboard-runners`, `#fleet-dashboard-active` for queued and running, `#fleet-dashboard-attention`). | Spec §4.2 "each tile scrolls to its section". |
| D424 | Credential chips (admin only) from the digest: unavailable -> "`{provider}`: unavailable" (bad); no stored kind (exec, ambient or none) -> "`{provider}`" (ok); stored kind -> the existing `fleet.runners.chip.credential` / `credentialExpires` / `credentialExpired` keys with the kind label from `fleet.runners.chip.kind.*` (expired = warn); an expired credential with no date -> "`{provider}`: `{kind}`, expired". | Spec §4.2 reuses `fleet.runners.chip.*`; the digest has no exec/ambient detail, and an unavailable credential must say so in words, not only by color. |
| D425 | Navigation: one key `nav.fleetOverview`. The admin link `/admin/fleet` (icon `Gauge`) is the first admin fleet link; the project link `/<slug>/fleet/overview` (icon `Gauge`) sits above Fleet jobs; `fleetLeaf()` returns `fleet.dashboard.title` for `/fleet/overview`; the command palette gains the project entry. The UX master plan's Decisions log records the two new links. | Spec §4.1; `docs/ux/redesign/MASTER-PLAN.md` asks every navigation change to be logged there. |
| D426 | E2E (`tests/e2e/fleet-dashboard.e2e.spec.ts`): a scripted runner pinned job goes RUNNING and reports a snapshot whose `heartbeatAt` is 15 minutes old (above both thresholds: one poll, error severity), while a background keep-alive syncs every 5 s so the runner stays online; a second job is dispatched unpinned with `selectorLabels: ['e2e-dashboard-nowhere']`, so no runner fits and it stays QUEUED. `playwright.config.ts` sets `FLEET_JOB_QUEUED_WARN_SEC: '10'` (the env schema minimum) so the dry-run reports it within the test. Assertions key on `data-key="<kind>:<jobId>"`. A fresh project created by the test shows neither job id on its overview. Cleanup cancels the QUEUED job and completes the RUNNING one. | Spec §5 E2E. A job-scoped key is immune to other specs' data; 10 s is the smallest legal threshold and touches no other spec (only the dashboard reads it). |

## Review Focus

1. **A runner name, feature or misfit reason containing HTML or control characters** (`<img src=x onerror=alert(1)>`):
   the attention list, tables and chips show it as text. Pinned in Task 4 (source guard: no `v-html` in
   `components/fleet/dashboard/`) and Task 4 (an attention item whose `subjectName` is markup renders it verbatim as
   text).
2. **Browser clock skew** (the client clock hours ahead of or behind the server): ages never go negative and never
   jump by the skew, because they are measured from `generatedAt` plus client time elapsed since arrival. Pinned in
   Task 1 (`serverNow` with a receive time far from `generatedAt`; `liveSec` with an earlier `now`).
3. **The API failing after a successful load, then recovering** (502 during a koda-wk redeploy): the last snapshot
   stays on screen with the stale note, no toast, polling continues, and the next success clears the note. A 403
   mid-session stops polling. Pinned in Task 3 (composable) and Task 7 (page).
4. **A newer API value** (an unknown verdict, condition type, misfit reason, kind or job state): the line shows
   generic text or the raw code instead of crashing or showing an i18n key path. Pinned in Task 2
   (`attentionMessage` / `renderText` fallbacks) and Task 5 (unknown state badge falls back through `codeLabel`).
5. **An empty fleet** (no runners, no jobs, no attention): tiles read `0/0`, `0`, `0`, `0`; every section shows its
   empty text; "All clear" shows. Pinned in Task 6 (`Overview` with an empty snapshot).

---

## File Structure

Create (web):

- `apps/web/lib/fleet-dashboard-types.ts` — wire types and the known enum value lists (D415).
- `apps/web/lib/fleet-dashboard.ts` — `serverNow`, `secParts`, `liveSec`, `hhmm`, `I18nText`, `renderText`,
  `attentionMessage`, `attentionLink`, `jobPath`, `dashboardTiles`, `digestChips`, `storiesText`, `costText`,
  `durationParts`, `safeHttpUrl`, `SECTION_IDS`, `DASHBOARD_POLL_MS`, `CLOCK_TICK_MS`.
- `apps/web/composables/useFleetDashboard.ts` — the request, both pollers, error state (D420, D421).
- `apps/web/components/fleet/dashboard/`: `Tiles.vue`, `AttentionList.vue`, `ActiveRunsTable.vue`,
  `RunnerHealthList.vue`, `RecentRunsList.vue`, `CredentialDigestChips.vue`, `Overview.vue`.
- `apps/web/pages/admin/fleet/index.vue`, `apps/web/pages/[project]/fleet/overview.vue`.
- Tests: `tests/lib/fleet-dashboard.spec.ts`, `tests/lib/fleet-dashboard-attention.spec.ts`,
  `tests/composables/useFleetDashboard.spec.ts`, `tests/components/fleet-dashboard-attention.spec.ts`,
  `tests/components/fleet-dashboard-tables.spec.ts`, `tests/components/fleet-dashboard-runners.spec.ts`,
  `tests/components/fleet-dashboard-overview.spec.ts`, `tests/pages/fleet-dashboard-pages.spec.ts`,
  `tests/e2e/fleet-dashboard.e2e.spec.ts`.

Modify (web):

- `apps/web/i18n/locales/en.json`, `zh.json` — `nav.fleetOverview`, `fleet.dashboard.*`.
- `apps/web/tests/i18n/fleet-locale-parity.spec.ts` — `ENUMS` pins.
- `apps/web/tests/helpers/mount-sfc.ts` — `FLEET_COMPONENT_FILES` entries and the `FleetComponentName` union.
- `apps/web/layouts/default.vue` (+ `tests/layouts/default-fleet-nav.spec.ts`, `tests/layouts/fleet-jobs-nav.spec.ts`).
- `apps/web/components/CommandPalette.vue`.
- `apps/web/playwright.config.ts` — `FLEET_JOB_QUEUED_WARN_SEC`.

Modify (docs): the spec (D421, D422 corrections), `docs/ux/redesign/MASTER-PLAN.md` (Decisions log),
`.nax/mono/apps/web/context.md` (+ `nax generate`).

---
### Task 1: Wire types and the time, text and tile helpers

**Files:**
- Create: `apps/web/lib/fleet-dashboard-types.ts`
- Create: `apps/web/lib/fleet-dashboard.ts`
- Test: `apps/web/tests/lib/fleet-dashboard.spec.ts`

**Interfaces:**
- Consumes: `ageParts`, `AgeParts` (`lib/fleet-age.ts`); `usd` (`lib/fleet-analytics-format.ts`).
- Produces (types, `lib/fleet-dashboard-types.ts`): `FleetDashboard`, `DashboardCounts`, `DashboardRunner`,
  `DashboardCredential`, `DashboardActiveJob`, `DashboardRecentJob`, `AttentionItem`, `AttentionReason`,
  `RunnerCondition`, `DashboardScope = {kind: 'global'} | {kind: 'project'; slug: string}`,
  `ScopeKind = DashboardScope['kind']`; value lists `ATTENTION_KINDS`, `SEVERITIES`, `UNPLACEABLE_VERDICTS`,
  `CONDITION_TYPES`, `CREDENTIAL_WHY`, `TILE_IDS`.
- Produces (`lib/fleet-dashboard.ts`): `DASHBOARD_POLL_MS = 10_000`, `CLOCK_TICK_MS = 1_000`,
  `SECTION_IDS: {attention, active, runners, recent}`, `serverNow(generatedAt: string, receivedAtMs: number, clientNowMs: number): Date`,
  `secParts(sec: number): AgeParts`, `liveSec(baseSec: number | undefined, generatedAt: string, now: Date): number`,
  `hhmm(ms: number): string`, `jobPath(slug: string, id: string): string`,
  `storiesText(done: number | null, total: number | null): string`, `costText(spent: string, max: string): string`,
  `durationParts(startedAt: string | null, finishedAt: string): AgeParts | null`, `safeHttpUrl(url: string | null): string | null`,
  `DashboardTile = {id: TileId; value: string; href: string; tone: 'ok' | 'warn' | 'bad'}`,
  `dashboardTiles(c: DashboardCounts): DashboardTile[]`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/tests/lib/fleet-dashboard.spec.ts`:

```ts
import { describe, expect, test } from '@jest/globals'
import {
  costText, dashboardTiles, durationParts, hhmm, jobPath, liveSec, safeHttpUrl, secParts, serverNow, storiesText,
} from '~/lib/fleet-dashboard'

const GEN = '2026-10-05T12:00:00.000Z'
const at = (iso: string): number => Date.parse(iso)

describe('serverNow (D416)', () => {
  test('advances generatedAt by the client time elapsed since the snapshot arrived', () => {
    const received = at('2026-10-05T12:00:01.000Z')
    expect(serverNow(GEN, received, received + 5_000).toISOString()).toBe('2026-10-05T12:00:05.000Z')
  })

  test('a client clock hours away from the server changes nothing (Review Focus 2)', () => {
    const ahead = at('2026-10-05T15:00:00.000Z')
    expect(serverNow(GEN, ahead, ahead + 2_000).toISOString()).toBe('2026-10-05T12:00:02.000Z')
    const behind = at('2026-10-05T09:00:00.000Z')
    expect(serverNow(GEN, behind, behind + 2_000).toISOString()).toBe('2026-10-05T12:00:02.000Z')
  })

  test('a client clock stepping backwards never moves server time before generatedAt', () => {
    const received = at('2026-10-05T12:00:00.000Z')
    expect(serverNow(GEN, received, received - 60_000).toISOString()).toBe(GEN)
  })
})

describe('liveSec and secParts (D416, D417)', () => {
  test('adds the whole seconds since generatedAt to a server-measured age', () => {
    expect(liveSec(190, GEN, new Date('2026-10-05T12:00:10.900Z'))).toBe(200)
  })

  test('never goes below the base, and treats a missing base as 0', () => {
    expect(liveSec(190, GEN, new Date('2026-10-05T11:59:00.000Z'))).toBe(190)
    expect(liveSec(undefined, GEN, new Date('2026-10-05T12:00:30.000Z'))).toBe(30)
    expect(liveSec(-5, GEN, new Date(GEN))).toBe(0)
  })

  test('an unparseable generatedAt keeps the base', () => {
    expect(liveSec(42, 'not a date', new Date(GEN))).toBe(42)
  })

  test('secParts uses the largest whole unit, like ageParts', () => {
    expect(secParts(0)).toEqual({ n: 0, unit: 's' })
    expect(secParts(59)).toEqual({ n: 59, unit: 's' })
    expect(secParts(190)).toEqual({ n: 3, unit: 'm' })
    expect(secParts(7_260)).toEqual({ n: 2, unit: 'h' })
    expect(secParts(200_000)).toEqual({ n: 2, unit: 'd' })
    expect(secParts(-3)).toEqual({ n: 0, unit: 's' })
  })
})

describe('text helpers', () => {
  test('hhmm is the local wall-clock time with two-digit fields', () => {
    expect(hhmm(new Date(2026, 9, 5, 9, 7, 30).getTime())).toBe('09:07')
    expect(hhmm(new Date(2026, 9, 5, 23, 59).getTime())).toBe('23:59')
  })

  test('jobPath is the project job page', () => {
    expect(jobPath('koda', 'job1')).toBe('/koda/fleet/jobs/job1')
  })

  test('storiesText shows done/total, or - when unknown or truncated', () => {
    expect(storiesText(3, 5)).toBe('3/5')
    expect(storiesText(0, 0)).toBe('0/0')
    expect(storiesText(null, 5)).toBe('-')
    expect(storiesText(null, null)).toBe('-')
  })

  test('costText shows the API money unchanged against the cap', () => {
    expect(costText('0.0664', '5.0000')).toBe('$0.0664 / $5.0000')
  })

  test('durationParts measures start to finish, null without a start or with a bad finish', () => {
    expect(durationParts('2026-10-05T11:50:00.000Z', '2026-10-05T12:00:00.000Z')).toEqual({ n: 10, unit: 'm' })
    expect(durationParts(null, GEN)).toBeNull()
    expect(durationParts('2026-10-05T11:50:00.000Z', 'nope')).toBeNull()
  })

  test('safeHttpUrl keeps only http and https URLs (D419)', () => {
    expect(safeHttpUrl('https://github.com/acme/app/pull/1')).toBe('https://github.com/acme/app/pull/1')
    expect(safeHttpUrl('http://gitlab.local/a/b/-/merge_requests/2')).toBe('http://gitlab.local/a/b/-/merge_requests/2')
    expect(safeHttpUrl('javascript:alert(1)')).toBeNull()
    expect(safeHttpUrl('not a url')).toBeNull()
    expect(safeHttpUrl(null)).toBeNull()
  })
})

describe('dashboardTiles (D423)', () => {
  test('four tiles linking to their sections, with tones from the counts', () => {
    expect(dashboardTiles({ runnersOnline: 1, runnersTotal: 2, queued: 3, running: 4, attention: 2 })).toEqual([
      { id: 'runners', value: '1/2', href: '#fleet-dashboard-runners', tone: 'warn' },
      { id: 'queued', value: '3', href: '#fleet-dashboard-active', tone: 'ok' },
      { id: 'running', value: '4', href: '#fleet-dashboard-active', tone: 'ok' },
      { id: 'attention', value: '2', href: '#fleet-dashboard-attention', tone: 'bad' },
    ])
  })

  test('an empty fleet reads 0/0 and every tone is ok (Review Focus 5)', () => {
    expect(dashboardTiles({ runnersOnline: 0, runnersTotal: 0, queued: 0, running: 0, attention: 0 }).map((t) => [t.value, t.tone]))
      .toEqual([['0/0', 'ok'], ['0', 'ok'], ['0', 'ok'], ['0', 'ok']])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && bun run test -- tests/lib/fleet-dashboard.spec.ts`
Expected: FAIL with `Cannot find module '~/lib/fleet-dashboard'`.

- [ ] **Step 3: Write the wire types**

Create `apps/web/lib/fleet-dashboard-types.ts`:

```ts
/**
 * Wire types of GET /fleet/dashboard and GET /projects/:slug/fleet/dashboard (S2b (c) spec §1.2, §2).
 * Hand-written (the web has no generated client); mirrors apps/api/src/fleet/dashboard/dto/fleet-dashboard.dto.ts.
 * D415: enum-like fields are `string` on the wire so a newer API value degrades to generic text; the known values
 * are the lists below, pinned against the locale files by tests/i18n/fleet-locale-parity.spec.ts.
 */

export const ATTENTION_KINDS = ['job_silent', 'job_waiting_approval', 'job_unplaceable', 'runner_unhealthy'] as const
export const SEVERITIES = ['error', 'warning'] as const
export const UNPLACEABLE_VERDICTS = [
  'never', 'budget_paused', 'runners_paused', 'waiting_capacity', 'no_fit', 'no_runners', 'fits_not_placed',
] as const
export const CONDITION_TYPES = ['offline', 'credential', 'stale_nax', 'configuration'] as const
export const CREDENTIAL_WHY = ['missing', 'unavailable', 'expired'] as const
export const TILE_IDS = ['runners', 'queued', 'running', 'attention'] as const

export type Severity = (typeof SEVERITIES)[number]
export type TileId = (typeof TILE_IDS)[number]

export interface DashboardCounts {
  runnersOnline: number
  runnersTotal: number
  /** QUEUED jobs in scope (not capped). */
  queued: number
  /** ASSIGNED + RUNNING + UPLOADING jobs in scope (not capped). */
  running: number
  attention: number
}

export interface DashboardCredential {
  providerId: string
  /** nax's verdict (ignores OAuth access-token expiry). */
  available: boolean
  kind: 'api-key' | 'oauth' | null
  expiresAt: string | null
  expired: boolean
}

export interface DashboardRunner {
  id: string
  name: string
  os: string
  arch: string
  labels: string[]
  enabled: boolean
  online: boolean
  lastSeenAt: string
  capacity: number
  /** Runner-held jobs of every project. */
  activeJobs: number
  /** Global admin scope only; null in project scope or when capabilities are unreadable. */
  naxVersion: string | null
  /** Global admin scope only. */
  daemonVersion: string | null
  /** Global admin scope only; empty in project scope. */
  credentials: DashboardCredential[]
}

export interface DashboardActiveJob {
  id: string
  projectSlug: string
  /** "owner/name". */
  repo: string
  feature: string
  command: string
  state: string
  runnerId: string | null
  runnerName: string | null
  currentStoryId: string | null
  currentPhase: string | null
  storiesDone: number | null
  storiesTotal: number | null
  /** Decimal as string. */
  costSpentUsd: string
  /** Decimal as string. */
  maxCostUsd: string
  queuedAt: string
  startedAt: string | null
  lastHeartbeatAt: string | null
  pendingApprovals: number
}

export interface DashboardRecentJob {
  id: string
  projectSlug: string
  repo: string
  feature: string
  command: string
  state: string
  stateReason: string | null
  runnerName: string | null
  /** Decimal as string. */
  costSpentUsd: string
  startedAt: string | null
  finishedAt: string
  resultPrUrl: string | null
}

export interface AttentionReason {
  runnerName: string
  /** A placement MisfitReason (fleet.misfit.*). */
  reason: string
}

export interface RunnerCondition {
  type: string
  jobsHeld?: number
  providerId?: string
  why?: string
  version?: string
  latest?: string
}

/** Spec §2: one flat shape; fields after `since` belong to one kind each. */
export interface AttentionItem {
  /** `${kind}:${subjectId}`, stable across polls. */
  key: string
  kind: string
  severity: string
  subjectType: 'job' | 'runner'
  subjectId: string
  /** Job feature or runner name. */
  subjectName: string
  /** null for runner items. */
  projectSlug: string | null
  since: string | null
  stage?: string
  silentSec?: number
  runnerName?: string | null
  pending?: number
  oldestSec?: number
  verdict?: string
  reasons?: AttentionReason[]
  reasonsTotal?: number
  conditions?: RunnerCondition[]
}

export interface FleetDashboard {
  /** Server time every age is measured against. */
  generatedAt: string
  counts: DashboardCounts
  runners: DashboardRunner[]
  /** Oldest first, at most 200. */
  activeJobs: DashboardActiveJob[]
  activeTruncated: boolean
  /** Finished in the last 24 h, newest first, at most 20. */
  recentJobs: DashboardRecentJob[]
  recentTruncated: boolean
  /** Errors first, then oldest since. */
  attention: AttentionItem[]
}

/** Spec §1.1: the admin route sees every project; the project route one project. */
export type DashboardScope = { kind: 'global' } | { kind: 'project'; slug: string }
export type ScopeKind = DashboardScope['kind']
```

- [ ] **Step 4: Write the helpers**

Create `apps/web/lib/fleet-dashboard.ts`:

```ts
import { ageParts } from '~/lib/fleet-age'
import type { AgeParts } from '~/lib/fleet-age'
import { usd } from '~/lib/fleet-analytics-format'
import type { DashboardCounts, TileId } from '~/lib/fleet-dashboard-types'

/** Spec §4.1 / B2: one snapshot request per 10 s while the tab is visible. */
export const DASHBOARD_POLL_MS = 10_000
/** D416: the client clock that advances ages between polls. */
export const CLOCK_TICK_MS = 1_000

/** Section anchors the tiles link to (D423). */
export const SECTION_IDS = {
  attention: 'fleet-dashboard-attention',
  active: 'fleet-dashboard-active',
  runners: 'fleet-dashboard-runners',
  recent: 'fleet-dashboard-recent',
} as const

/**
 * D416: server time now = generatedAt + client time elapsed since the snapshot arrived, never before generatedAt.
 * The browser clock is never compared with server time, so skew between them cannot distort an age.
 */
export function serverNow(generatedAt: string, receivedAtMs: number, clientNowMs: number): Date {
  return new Date(Date.parse(generatedAt) + Math.max(0, clientNowMs - receivedAtMs))
}

/** D417: seconds in the largest whole unit (190 s -> 3 m), the form `ageParts` uses. */
export function secParts(sec: number): AgeParts {
  const s = Math.max(0, Math.floor(sec))
  if (s >= 86_400) return { n: Math.floor(s / 86_400), unit: 'd' }
  if (s >= 3_600) return { n: Math.floor(s / 3_600), unit: 'h' }
  if (s >= 60) return { n: Math.floor(s / 60), unit: 'm' }
  return { n: s, unit: 's' }
}

/** D416: an age the server measured at generatedAt (silentSec, oldestSec), advanced to `now`. */
export function liveSec(baseSec: number | undefined, generatedAt: string, now: Date): number {
  const ms = now.getTime() - Date.parse(generatedAt)
  const elapsed = Number.isNaN(ms) ? 0 : Math.max(0, Math.floor(ms / 1000))
  return Math.max(0, baseSec ?? 0) + elapsed
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** D420: the local wall-clock time of a client timestamp, for "showing data from HH:MM". */
export function hhmm(ms: number): string {
  const d = new Date(ms)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** The project job page (same form as pages/[project]/fleet/index.vue). */
export function jobPath(slug: string, id: string): string {
  return `/${slug}/fleet/jobs/${id}`
}

/** "3/5"; "-" when the API could not count (no stories, or the list was truncated). */
export function storiesText(done: number | null, total: number | null): string {
  return done === null || total === null ? '-' : `${done}/${total}`
}

/** Money as the API sent it, against the job's cap. */
export function costText(spent: string, max: string): string {
  return `${usd(spent)} / ${usd(max)}`
}

/** How long a finished job ran; null without a start time or with an unreadable finish time. */
export function durationParts(startedAt: string | null, finishedAt: string): AgeParts | null {
  const end = Date.parse(finishedAt)
  if (startedAt === null || Number.isNaN(end)) return null
  return ageParts(startedAt, new Date(end))
}

/** D419: a link target only for http(s) URLs. */
export function safeHttpUrl(url: string | null): string | null {
  if (url === null) return null
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? url : null
  } catch {
    return null
  }
}

export interface DashboardTile {
  id: TileId
  value: string
  href: string
  tone: 'ok' | 'warn' | 'bad'
}

/** D423: the four count tiles, each linking to its section. */
export function dashboardTiles(c: DashboardCounts): DashboardTile[] {
  return [
    { id: 'runners', value: `${c.runnersOnline}/${c.runnersTotal}`, href: `#${SECTION_IDS.runners}`, tone: c.runnersOnline < c.runnersTotal ? 'warn' : 'ok' },
    { id: 'queued', value: String(c.queued), href: `#${SECTION_IDS.active}`, tone: 'ok' },
    { id: 'running', value: String(c.running), href: `#${SECTION_IDS.active}`, tone: 'ok' },
    { id: 'attention', value: String(c.attention), href: `#${SECTION_IDS.attention}`, tone: c.attention > 0 ? 'bad' : 'ok' },
  ]
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/web && bun run test -- tests/lib/fleet-dashboard.spec.ts`
Expected: PASS (all tests). If `hhmm` fails, the test built its date in UTC: it must use the local-time `Date` constructor shown.

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/fleet-dashboard-types.ts apps/web/lib/fleet-dashboard.ts apps/web/tests/lib/fleet-dashboard.spec.ts
git commit -m "feat(web): fleet dashboard wire types, server-clock ages and tiles (S2b (c) slice 2, D415-D417, D423)"
```

---

### Task 2: Locale keys and attention wording

**Files:**
- Modify: `apps/web/i18n/locales/en.json`, `apps/web/i18n/locales/zh.json` (`nav.fleetOverview`, new `fleet.dashboard` subtree)
- Modify: `apps/web/tests/i18n/fleet-locale-parity.spec.ts` (`ENUMS`)
- Modify: `apps/web/lib/fleet-dashboard.ts` (append)
- Test: `apps/web/tests/lib/fleet-dashboard-attention.spec.ts`

**Interfaces:**
- Consumes: Task 1 (`secParts`, `liveSec`, `jobPath`, types and value lists); `ChipTone` (`lib/fleet-capabilities.ts`).
- Produces: `I18nText = {key: string; params?: Readonly<Record<string, string | number>>; ages?: Readonly<Record<string, AgeParts>>; labels?: Readonly<Record<string, string>>}`,
  `Translate = (key: string, named?: Record<string, unknown>) => string`, `HasKey = (key: string) => boolean`,
  `renderText(text: I18nText, t: Translate, te: HasKey): string`,
  `AttentionMessage = {summary: I18nText | null; details: I18nText[]; more: number}`,
  `attentionMessage(item: AttentionItem, generatedAt: string, now: Date): AttentionMessage`,
  `severityOf(item: AttentionItem): Severity`, `attentionLink(item: AttentionItem, scope: ScopeKind): string | null`,
  `DigestChip = {id: string; text: I18nText; tone: ChipTone}`, `digestChips(creds: readonly DashboardCredential[]): DigestChip[]`.
- Produces (i18n): every key under `fleet.dashboard` listed in Step 3, and `nav.fleetOverview`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/tests/lib/fleet-dashboard-attention.spec.ts`:

```ts
import { describe, expect, test } from '@jest/globals'
import { attentionLink, attentionMessage, digestChips, renderText, severityOf } from '~/lib/fleet-dashboard'
import type { AttentionMessage } from '~/lib/fleet-dashboard'
import type { AttentionItem } from '~/lib/fleet-dashboard-types'
import { enI18n } from '../helpers/fleet-harness'

const GEN = '2026-10-05T12:00:00.000Z'
const NOW = new Date('2026-10-05T12:00:10.000Z')
const { t, te } = enI18n()

const item = (over: Partial<AttentionItem>): AttentionItem => ({
  key: 'job_silent:j1', kind: 'job_silent', severity: 'warning', subjectType: 'job', subjectId: 'j1',
  subjectName: 'subtract', projectSlug: 'koda', since: '2026-10-05T11:56:50.000Z', ...over,
})

/** The message as the browser shows it: summary, then one line per detail, then the "more" line. */
function words(m: AttentionMessage): string[] {
  return [
    ...(m.summary ? [renderText(m.summary, t, te)] : []),
    ...m.details.map((d) => renderText(d, t, te)),
    ...(m.more > 0 ? [t('fleet.dashboard.attention.more', { n: m.more })] : []),
  ]
}

describe('attentionMessage (D418)', () => {
  test('a silent running job: heartbeat age advanced to now, and the runner', () => {
    const m = attentionMessage(item({ stage: 'running', silentSec: 190, runnerName: 'wk-mac' }), GEN, NOW)
    expect(words(m)).toEqual(['No heartbeat for 3m on wk-mac'])
  })

  test('an assigned job that never started', () => {
    const m = attentionMessage(item({ stage: 'starting', silentSec: 360, runnerName: 'wk-mac' }), GEN, NOW)
    expect(words(m)).toEqual(['Assigned to wk-mac 6m ago, not started'])
  })

  test('a silent job whose runner name is unknown says so instead of printing null', () => {
    const m = attentionMessage(item({ stage: 'running', silentSec: 200, runnerName: null }), GEN, NOW)
    expect(words(m)).toEqual(['No heartbeat for 3m on Unknown'])
  })

  test('approvals: count and the oldest age', () => {
    const m = attentionMessage(item({ kind: 'job_waiting_approval', key: 'job_waiting_approval:j1', pending: 2, oldestSec: 170 }), GEN, NOW)
    expect(words(m)).toEqual(['2 approval(s) pending, oldest 3m'])
  })

  test('unplaceable: the verdict, one line per shown runner with its translated reason, and the rest counted', () => {
    const m = attentionMessage(item({
      kind: 'job_unplaceable', key: 'job_unplaceable:j1', verdict: 'no_fit',
      reasons: [{ runnerName: 'linux-1', reason: 'provider_missing' }, { runnerName: 'wk-mac', reason: 'offline' }], reasonsTotal: 5,
    }), GEN, NOW)
    expect(words(m)).toEqual([
      'No runner fits right now',
      'linux-1: A profile needs a provider the runner has no credential for',
      'wk-mac: Runner is offline',
      'and 3 more runner(s)',
    ])
  })

  test.each([
    ['never', 'No runner can ever run this'],
    ['budget_paused', 'Budget paused; this job will be cancelled'],
    ['runners_paused', 'Every runner is budget-paused'],
    ['waiting_capacity', 'Waiting for a free runner'],
    ['no_runners', 'No runner can take this job'],
    ['fits_not_placed', 'A runner fits but the job has not been placed'],
  ])('verdict %s', (verdict, text) => {
    expect(words(attentionMessage(item({ kind: 'job_unplaceable', verdict, reasons: [] }), GEN, NOW))).toEqual([text])
  })

  test('a runner: no summary, one line per condition', () => {
    const m = attentionMessage(item({
      kind: 'runner_unhealthy', key: 'runner_unhealthy:r1', subjectType: 'runner', subjectId: 'r1', subjectName: 'wk-mac', projectSlug: null,
      conditions: [
        { type: 'offline', jobsHeld: 2 },
        { type: 'credential', providerId: 'deepseek', why: 'expired' },
        { type: 'credential', providerId: 'anthropic', why: 'missing' },
        { type: 'credential', providerId: 'openai', why: 'unavailable' },
        { type: 'stale_nax', version: '0.83.1', latest: '0.83.3' },
      ],
    }), GEN, NOW)
    expect(m.summary).toBeNull()
    expect(words(m)).toEqual([
      'Offline, holding 2 job(s)',
      'API key for deepseek has expired',
      'No credential for anthropic',
      'Credential for openai is unavailable',
      'nax 0.83.1 is behind 0.83.3',
    ])
  })

  test('project scope: offline without held jobs, and the collapsed configuration condition', () => {
    const m = attentionMessage(item({
      kind: 'runner_unhealthy', subjectType: 'runner', projectSlug: null,
      conditions: [{ type: 'offline', jobsHeld: 0 }, { type: 'configuration' }],
    }), GEN, NOW)
    expect(words(m)).toEqual(['Offline', 'Configuration problem (ask a fleet admin)'])
  })

  test('newer API values degrade to generic text, never a key path (Review Focus 4)', () => {
    expect(words(attentionMessage(item({ kind: 'job_cursed' }), GEN, NOW))).toEqual(['Needs attention'])
    expect(words(attentionMessage(item({ kind: 'job_unplaceable', verdict: 'moon_phase', reasons: [{ runnerName: 'r', reason: 'gremlins' }] }), GEN, NOW)))
      .toEqual(['Not placed', 'r: gremlins'])
    expect(words(attentionMessage(item({ kind: 'runner_unhealthy', conditions: [{ type: 'overheated' }, { type: 'credential', providerId: 'x', why: 'stolen' }] }), GEN, NOW)))
      .toEqual(['Problem: overheated', 'Credential for x is unavailable'])
  })
})

describe('severityOf and attentionLink (D419)', () => {
  test('anything but error reads as a warning', () => {
    expect(severityOf(item({ severity: 'error' }))).toBe('error')
    expect(severityOf(item({ severity: 'warning' }))).toBe('warning')
    expect(severityOf(item({ severity: 'critical' }))).toBe('warning')
  })

  test('job items open the job page, approval items the inbox, in both scopes', () => {
    expect(attentionLink(item({}), 'global')).toBe('/koda/fleet/jobs/j1')
    expect(attentionLink(item({}), 'project')).toBe('/koda/fleet/jobs/j1')
    expect(attentionLink(item({ kind: 'job_waiting_approval' }), 'project')).toBe('/koda/fleet/approvals')
  })

  test('runner items open the admin Runners page only in the admin scope', () => {
    const runner = item({ kind: 'runner_unhealthy', subjectType: 'runner', subjectId: 'r1', projectSlug: null })
    expect(attentionLink(runner, 'global')).toBe('/admin/fleet/runners')
    expect(attentionLink(runner, 'project')).toBeNull()
  })

  test('a job item without a project slug has no link', () => {
    expect(attentionLink(item({ projectSlug: null }), 'global')).toBeNull()
  })
})

describe('digestChips (D424)', () => {
  const chip = (c: Parameters<typeof digestChips>[0][number]) => {
    const [only] = digestChips([c])
    return [renderText(only.text, t, te), only.tone]
  }

  test('an unavailable credential says so in words', () => {
    expect(chip({ providerId: 'deepseek', available: false, kind: 'api-key', expiresAt: null, expired: false })).toEqual(['deepseek: unavailable', 'bad'])
  })

  test('no stored kind (exec, ambient or none) shows the provider alone', () => {
    expect(chip({ providerId: 'anthropic', available: true, kind: null, expiresAt: null, expired: false })).toEqual(['anthropic', 'ok'])
  })

  test('stored kinds reuse the runners chip keys', () => {
    expect(chip({ providerId: 'deepseek', available: true, kind: 'api-key', expiresAt: null, expired: false })).toEqual(['deepseek: API key', 'ok'])
    expect(chip({ providerId: 'claude', available: true, kind: 'oauth', expiresAt: '2026-11-01T00:00:00.000Z', expired: false }))
      .toEqual(['claude: OAuth until 2026-11-01', 'ok'])
    expect(chip({ providerId: 'claude', available: true, kind: 'oauth', expiresAt: '2026-10-01T00:00:00.000Z', expired: true }))
      .toEqual(['claude: OAuth, expired 2026-10-01', 'warn'])
    expect(chip({ providerId: 'x', available: true, kind: 'api-key', expiresAt: null, expired: true })).toEqual(['x: API key, expired', 'warn'])
  })

  test('one chip per credential, keyed by provider', () => {
    expect(digestChips([
      { providerId: 'a', available: true, kind: null, expiresAt: null, expired: false },
      { providerId: 'b', available: true, kind: null, expiresAt: null, expired: false },
    ]).map((c) => c.id)).toEqual(['credential:a', 'credential:b'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && bun run test -- tests/lib/fleet-dashboard-attention.spec.ts`
Expected: FAIL (`attentionMessage` is not exported).

- [ ] **Step 3: Add the locale keys**

In `apps/web/i18n/locales/en.json`, add `"fleetOverview": "Fleet overview"` to `nav` right after `"fleetAnalytics"`,
and add this `dashboard` object inside `fleet` (after `"analytics"`, keeping the file's key order otherwise):

```json
"dashboard": {
  "title": "Fleet overview",
  "adminSubtitle": "Every runner and the active jobs of every project. Refreshes every 10 seconds.",
  "projectSubtitle": "This project's jobs and the health of every runner. Refreshes every 10 seconds.",
  "forbidden": "You do not have access to this project.",
  "updated": "Updated",
  "staleSince": "Could not refresh. Showing data from {time}.",
  "severity": {
    "error": "Error",
    "warning": "Warning"
  },
  "tiles": {
    "runners": "Runners online",
    "queued": "Queued",
    "running": "Running",
    "attention": "Needs attention"
  },
  "sections": {
    "attention": "Needs attention",
    "active": "Active jobs",
    "runners": "Runners",
    "recent": "Finished in the last 24 hours"
  },
  "attention": {
    "allClear": "All clear",
    "silent": "No heartbeat for {age} on {runner}",
    "notStarted": "Assigned to {runner} {age} ago, not started",
    "approvals": "{n} approval(s) pending, oldest {age}",
    "misfitOn": "{runner}: {reason}",
    "more": "and {n} more runner(s)",
    "unknown": "Needs attention",
    "verdict": {
      "never": "No runner can ever run this",
      "budget_paused": "Budget paused; this job will be cancelled",
      "runners_paused": "Every runner is budget-paused",
      "waiting_capacity": "Waiting for a free runner",
      "no_fit": "No runner fits right now",
      "no_runners": "No runner can take this job",
      "fits_not_placed": "A runner fits but the job has not been placed",
      "unknown": "Not placed"
    },
    "condition": {
      "offline": "Offline",
      "offlineHolding": "Offline, holding {n} job(s)",
      "staleNax": "nax {version} is behind {latest}",
      "configuration": "Configuration problem (ask a fleet admin)",
      "unknown": "Problem: {code}",
      "credential": {
        "missing": "No credential for {provider}",
        "unavailable": "Credential for {provider} is unavailable",
        "expired": "API key for {provider} has expired"
      }
    }
  },
  "active": {
    "empty": "No active jobs",
    "truncated": "Showing the oldest 200 active jobs.",
    "unassigned": "Not assigned",
    "approvals": "{n} approval(s) pending",
    "columns": {
      "feature": "Feature",
      "project": "Project",
      "repo": "Repo",
      "state": "State",
      "runner": "Runner",
      "story": "Story",
      "phase": "Phase",
      "stories": "Stories",
      "cost": "Cost / max",
      "heartbeat": "Heartbeat"
    }
  },
  "runners": {
    "empty": "No runners enrolled",
    "busy": "{active} of {capacity} busy",
    "lastSeen": "Last seen",
    "nax": "nax {version}",
    "naxUnknown": "nax version unknown",
    "daemon": "daemon {version}",
    "credentialUnavailable": "{provider}: unavailable",
    "credentialServed": "{provider}",
    "credentialExpiredUndated": "{provider}: {kind}, expired"
  },
  "recent": {
    "empty": "No runs in the last 24 hours",
    "truncated": "Showing the latest 20.",
    "pr": "Pull request",
    "analyticsLink": "Spend and quality over time",
    "columns": {
      "feature": "Feature",
      "project": "Project",
      "state": "State",
      "runner": "Runner",
      "duration": "Duration",
      "cost": "Cost",
      "finished": "Finished"
    }
  }
}
```

In `apps/web/i18n/locales/zh.json`, add `"fleetOverview": "集群概览"` to `nav` after `"fleetAnalytics"`, and the same
`dashboard` structure inside `fleet` with these values (same keys, same placeholders):

```json
"dashboard": {
  "title": "集群概览",
  "adminSubtitle": "所有执行机及所有项目的活动任务，每 10 秒刷新一次。",
  "projectSubtitle": "本项目的任务及所有执行机的健康状况，每 10 秒刷新一次。",
  "forbidden": "你没有此项目的访问权限。",
  "updated": "更新于",
  "staleSince": "刷新失败，显示的是 {time} 的数据。",
  "severity": {
    "error": "错误",
    "warning": "警告"
  },
  "tiles": {
    "runners": "在线执行机",
    "queued": "排队中",
    "running": "运行中",
    "attention": "需要关注"
  },
  "sections": {
    "attention": "需要关注",
    "active": "活动任务",
    "runners": "执行机",
    "recent": "最近 24 小时内完成"
  },
  "attention": {
    "allClear": "一切正常",
    "silent": "{runner} 上已 {age} 没有心跳",
    "notStarted": "{age}前已分配给 {runner}，尚未开始",
    "approvals": "{n} 个审批待处理，最早的已等待 {age}",
    "misfitOn": "{runner}：{reason}",
    "more": "还有 {n} 台执行机",
    "unknown": "需要关注",
    "verdict": {
      "never": "没有任何执行机能运行此任务",
      "budget_paused": "预算已暂停，此任务将被取消",
      "runners_paused": "所有执行机的预算都已暂停",
      "waiting_capacity": "正在等待空闲的执行机",
      "no_fit": "目前没有合适的执行机",
      "no_runners": "没有执行机可以接收此任务",
      "fits_not_placed": "有合适的执行机，但任务尚未分配",
      "unknown": "未分配"
    },
    "condition": {
      "offline": "离线",
      "offlineHolding": "离线，持有 {n} 个任务",
      "staleNax": "nax {version} 落后于 {latest}",
      "configuration": "配置有问题（请联系集群管理员）",
      "unknown": "问题：{code}",
      "credential": {
        "missing": "缺少 {provider} 的凭据",
        "unavailable": "{provider} 的凭据当前不可用",
        "expired": "{provider} 的 API 密钥已过期"
      }
    }
  },
  "active": {
    "empty": "没有活动任务",
    "truncated": "仅显示最早的 200 个活动任务。",
    "unassigned": "未分配",
    "approvals": "{n} 个审批待处理",
    "columns": {
      "feature": "功能",
      "project": "项目",
      "repo": "仓库",
      "state": "状态",
      "runner": "执行机",
      "story": "故事",
      "phase": "阶段",
      "stories": "故事进度",
      "cost": "费用 / 上限",
      "heartbeat": "心跳"
    }
  },
  "runners": {
    "empty": "尚未注册执行机",
    "busy": "{capacity} 个槽位中 {active} 个忙碌",
    "lastSeen": "最后在线",
    "nax": "nax {version}",
    "naxUnknown": "nax 版本未知",
    "daemon": "守护进程 {version}",
    "credentialUnavailable": "{provider}：不可用",
    "credentialServed": "{provider}",
    "credentialExpiredUndated": "{provider}：{kind}，已过期"
  },
  "recent": {
    "empty": "最近 24 小时内没有运行",
    "truncated": "仅显示最近的 20 个。",
    "pr": "拉取请求",
    "analyticsLink": "查看费用和质量趋势",
    "columns": {
      "feature": "功能",
      "project": "项目",
      "state": "状态",
      "runner": "执行机",
      "duration": "耗时",
      "cost": "费用",
      "finished": "完成时间"
    }
  }
}
```

Note the English `"{age}"` values render through `fleet.common.duration.*` (`3m`), so `"No heartbeat for {age}"` reads
"No heartbeat for 3m"; the zh `notStarted` places `{age}` directly before "前" because `fleet.common.duration.m` is
"{n} 分钟".

- [ ] **Step 4: Pin the dynamic subtrees in the parity spec**

In `apps/web/tests/i18n/fleet-locale-parity.spec.ts`, add to `ENUMS` (after the `fleet.analytics.ingestStatus` line):

```ts
  'fleet.dashboard.severity': ['error', 'warning'],
  'fleet.dashboard.tiles': ['runners', 'queued', 'running', 'attention'],
  'fleet.dashboard.attention.verdict': ['never', 'budget_paused', 'runners_paused', 'waiting_capacity', 'no_fit', 'no_runners', 'fits_not_placed', 'unknown'],
  'fleet.dashboard.attention.condition.credential': ['missing', 'unavailable', 'expired'],
```

and extend the nav translation test list
`test.each(['nav.fleetRunners', 'nav.fleetRepos', 'nav.fleetBudgets', 'nav.fleetApprovals'])` with `'nav.fleetOverview'`.

Then add an import at the top of the spec (after the `@jest/globals` import):

```ts
import { CREDENTIAL_WHY, SEVERITIES, TILE_IDS, UNPLACEABLE_VERDICTS } from '~/lib/fleet-dashboard-types'
```

and one test at the end of the `describe` block, which ties the pins to the web's own value lists so a new API
value cannot ship without its wording:

```ts
  test('the dashboard pins match the wire value lists (D415)', () => {
    expect([...ENUMS['fleet.dashboard.severity']].sort()).toEqual([...SEVERITIES].sort())
    expect([...ENUMS['fleet.dashboard.tiles']].sort()).toEqual([...TILE_IDS].sort())
    expect(ENUMS['fleet.dashboard.attention.verdict'].filter((v) => v !== 'unknown').sort()).toEqual([...UNPLACEABLE_VERDICTS].sort())
    expect([...ENUMS['fleet.dashboard.attention.condition.credential']].sort()).toEqual([...CREDENTIAL_WHY].sort())
  })
```

- [ ] **Step 5: Write the wording code**

Append to `apps/web/lib/fleet-dashboard.ts`. First extend the imports at the top of the file so they read:

```ts
import { ageParts } from '~/lib/fleet-age'
import type { AgeParts } from '~/lib/fleet-age'
import { usd } from '~/lib/fleet-analytics-format'
import type { ChipTone } from '~/lib/fleet-capabilities'
import { CREDENTIAL_WHY, UNPLACEABLE_VERDICTS } from '~/lib/fleet-dashboard-types'
import type {
  AttentionItem, DashboardCounts, DashboardCredential, RunnerCondition, ScopeKind, Severity, TileId,
} from '~/lib/fleet-dashboard-types'
```

Then append:

```ts
/** D418: one translatable line. `ages` render through fleet.common.duration.*; `labels` are keys translated first. */
export interface I18nText {
  key: string
  params?: Readonly<Record<string, string | number>>
  ages?: Readonly<Record<string, AgeParts>>
  labels?: Readonly<Record<string, string>>
}

export type Translate = (key: string, named?: Record<string, unknown>) => string
export type HasKey = (key: string) => boolean

/** A label key with no translation shows its last segment: the raw server code (same rule as `codeLabel`, D126). */
const labelText = (key: string, t: Translate, te: HasKey): string => (te(key) ? t(key) : key.slice(key.lastIndexOf('.') + 1))

export function renderText(text: I18nText, t: Translate, te: HasKey): string {
  const ages = Object.entries(text.ages ?? {}).map(([name, age]) => [name, t(`fleet.common.duration.${age.unit}`, { n: age.n })] as const)
  const labels = Object.entries(text.labels ?? {}).map(([name, key]) => [name, labelText(key, t, te)] as const)
  return t(text.key, { ...(text.params ?? {}), ...Object.fromEntries(ages), ...Object.fromEntries(labels) })
}

export interface AttentionMessage {
  /** The line under the subject; null for a runner item, whose conditions are the message. */
  summary: I18nText | null
  details: I18nText[]
  /** Misfit runners beyond the ones listed (reasonsTotal minus the shown reasons). */
  more: number
}

const A = 'fleet.dashboard.attention'
const known = (list: readonly string[], value: string | undefined): value is string => value !== undefined && list.includes(value)

/** The runner name, or the translated "Unknown" when the API had none (a deleted runner). */
const runnerArg = (name: string | null | undefined): Pick<I18nText, 'params' | 'labels'> =>
  name ? { params: { runner: name } } : { labels: { runner: 'fleet.common.unknown' } }

function conditionText(c: RunnerCondition): I18nText {
  switch (c.type) {
    case 'offline':
      return (c.jobsHeld ?? 0) > 0 ? { key: `${A}.condition.offlineHolding`, params: { n: c.jobsHeld ?? 0 } } : { key: `${A}.condition.offline` }
    case 'credential':
      return { key: `${A}.condition.credential.${known(CREDENTIAL_WHY, c.why) ? c.why : 'unavailable'}`, params: { provider: c.providerId ?? '-' } }
    case 'stale_nax':
      return { key: `${A}.condition.staleNax`, params: { version: c.version ?? '-', latest: c.latest ?? '-' } }
    case 'configuration':
      return { key: `${A}.condition.configuration` }
    default:
      return { key: `${A}.condition.unknown`, params: { code: c.type } }
  }
}

function unplaceable(item: AttentionItem): AttentionMessage {
  const reasons = item.reasons ?? []
  const verdict = known(UNPLACEABLE_VERDICTS, item.verdict) ? item.verdict : 'unknown'
  return {
    summary: { key: `${A}.verdict.${verdict}` },
    details: reasons.map((r) => ({ key: `${A}.misfitOn`, params: { runner: r.runnerName }, labels: { reason: `fleet.misfit.${r.reason}` } })),
    more: Math.max(0, (item.reasonsTotal ?? reasons.length) - reasons.length),
  }
}

/** D418: the words for one attention item, from its structured fields only (the API sends no prose, spec §2). */
export function attentionMessage(item: AttentionItem, generatedAt: string, now: Date): AttentionMessage {
  const one = (summary: I18nText): AttentionMessage => ({ summary, details: [], more: 0 })
  switch (item.kind) {
    case 'job_silent':
      return one({
        key: item.stage === 'starting' ? `${A}.notStarted` : `${A}.silent`,
        ...runnerArg(item.runnerName),
        ages: { age: secParts(liveSec(item.silentSec, generatedAt, now)) },
      })
    case 'job_waiting_approval':
      return one({ key: `${A}.approvals`, params: { n: item.pending ?? 0 }, ages: { age: secParts(liveSec(item.oldestSec, generatedAt, now)) } })
    case 'job_unplaceable':
      return unplaceable(item)
    case 'runner_unhealthy':
      return { summary: null, details: (item.conditions ?? []).map(conditionText), more: 0 }
    default:
      return one({ key: `${A}.unknown` })
  }
}

/** Anything but `error` reads as a warning (D415: a newer severity never hides an item). */
export function severityOf(item: AttentionItem): Severity {
  return item.severity === 'error' ? 'error' : 'warning'
}

/** D419: where an attention item leads; null renders the subject as plain text. */
export function attentionLink(item: AttentionItem, scope: ScopeKind): string | null {
  if (item.subjectType === 'runner') return scope === 'global' ? '/admin/fleet/runners' : null
  if (item.projectSlug === null) return null
  if (item.kind === 'job_waiting_approval') return `/${item.projectSlug}/fleet/approvals`
  return jobPath(item.projectSlug, item.subjectId)
}

export interface DigestChip {
  id: string
  text: I18nText
  tone: ChipTone
}

/** D424: admin credential chips from the dashboard digest, reusing the Runners page chip keys. */
export function digestChips(creds: readonly DashboardCredential[]): DigestChip[] {
  return creds.map((c): DigestChip => {
    const id = `credential:${c.providerId}`
    const provider = { provider: c.providerId }
    if (!c.available) return { id, tone: 'bad', text: { key: 'fleet.dashboard.runners.credentialUnavailable', params: provider } }
    if (c.kind === null) return { id, tone: 'ok', text: { key: 'fleet.dashboard.runners.credentialServed', params: provider } }
    const labels = { kind: `fleet.runners.chip.kind.${c.kind}` }
    const expires = c.expiresAt ? c.expiresAt.slice(0, 10) : null
    if (c.expired) {
      return expires
        ? { id, tone: 'warn', text: { key: 'fleet.runners.chip.credentialExpired', params: { ...provider, expires }, labels } }
        : { id, tone: 'warn', text: { key: 'fleet.dashboard.runners.credentialExpiredUndated', params: provider, labels } }
    }
    return expires
      ? { id, tone: 'ok', text: { key: 'fleet.runners.chip.credentialExpires', params: { ...provider, expires }, labels } }
      : { id, tone: 'ok', text: { key: 'fleet.runners.chip.credential', params: provider, labels } }
  })
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd apps/web && bun run test -- tests/lib/fleet-dashboard-attention.spec.ts tests/lib/fleet-dashboard.spec.ts tests/i18n`
Expected: PASS. `tests/i18n` includes the parity spec and the used-keys guard; a failure naming a key means en and zh
diverged or a `|`/`@` slipped in.

- [ ] **Step 7: Commit**

```bash
git add apps/web/i18n/locales/en.json apps/web/i18n/locales/zh.json apps/web/tests/i18n/fleet-locale-parity.spec.ts apps/web/lib/fleet-dashboard.ts apps/web/tests/lib/fleet-dashboard-attention.spec.ts
git commit -m "feat(web): fleet dashboard locale keys and attention wording (S2b (c) slice 2, D418, D419, D424)"
```

---

### Task 3: `useFleetDashboard` — request, polling, clock and errors

**Files:**
- Create: `apps/web/composables/useFleetDashboard.ts`
- Test: `apps/web/tests/composables/useFleetDashboard.spec.ts`

**Interfaces:**
- Consumes: `useVisiblePolling`, `PollingDeps` (`composables/useVisiblePolling.ts`); `isForbidden`
  (`composables/useFleetBudgetPage.ts:8`); `apiPath`; Task 1 (`serverNow`, `hhmm`, `DASHBOARD_POLL_MS`, `CLOCK_TICK_MS`,
  `FleetDashboard`, `DashboardScope`); the `useApi` auto-import (`$api.get<T>(path)` resolves the envelope's `data`
  and throws `ApiError(code, message)`).
- Produces: `dashboardPath(scope: DashboardScope): string`;
  `useFleetDashboard(scope: DashboardScope, deps?: {polling?: PollingDeps; clock?: () => number})` returning
  `{data: ShallowRef<FleetDashboard | null>, error: ShallowRef<unknown>, pending: Ref<boolean>, forbidden: Ref<boolean>, lastSuccessAt: Ref<number | null>, now: ComputedRef<Date>, failed: ComputedRef<boolean>, staleSince: ComputedRef<string | null>, refresh(): Promise<void>, start(): void, stop(): void}`.
  `failed` = no snapshot yet and the last load failed; `staleSince` = `hhmm(lastSuccessAt)` while a later poll is failing, else null.

- [ ] **Step 1: Write the failing test**

Create `apps/web/tests/composables/useFleetDashboard.spec.ts`:

```ts
import { afterEach, describe, expect, jest, test } from '@jest/globals'
import { ApiError } from '~/composables/useApi'
import type { PollingDeps } from '~/composables/useVisiblePolling'
import { hhmm } from '~/lib/fleet-dashboard'
import type { FleetDashboard } from '~/lib/fleet-dashboard-types'

const g = globalThis as Record<string, unknown>
const GEN = '2026-10-05T12:00:00.000Z'

const snapshot = (over: Partial<FleetDashboard> = {}): FleetDashboard => ({
  generatedAt: GEN,
  counts: { runnersOnline: 1, runnersTotal: 1, queued: 0, running: 0, attention: 0 },
  runners: [], activeJobs: [], activeTruncated: false, recentJobs: [], recentTruncated: false, attention: [],
  ...over,
})

/** Records every interval the composable asks for; `fire(ms)` runs that poller's task. */
function fakePolling() {
  const intervals = new Map<number, () => void>()
  const cleared: number[] = []
  const deps: PollingDeps = {
    isHidden: () => false,
    setInterval: (fn, ms) => { intervals.set(ms, fn); return ms },
    clearInterval: (handle) => { cleared.push(handle as number); intervals.delete(handle as number) },
    onVisible: () => () => undefined,
  }
  return { deps, intervals, cleared }
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => { setImmediate(resolve) })
}

async function load(get: jest.Mock) {
  g.useApi = () => ({ $api: { get } })
  const { useFleetDashboard, dashboardPath } = await import('~/composables/useFleetDashboard')
  return { useFleetDashboard, dashboardPath }
}

describe('useFleetDashboard (spec §4.1, D420, D421)', () => {
  afterEach(() => { delete g.useApi })

  test('the admin route is plain, the project route encodes the slug', async () => {
    const { dashboardPath } = await load(jest.fn())
    expect(dashboardPath({ kind: 'global' })).toBe('/fleet/dashboard')
    expect(dashboardPath({ kind: 'project', slug: 'my proj' })).toBe('/projects/my%20proj/fleet/dashboard')
  })

  test('start loads at once and polls every 10 s, with a 1 s clock', async () => {
    const get = jest.fn(async () => snapshot())
    const { useFleetDashboard } = await load(get)
    const poll = fakePolling()
    const dash = useFleetDashboard({ kind: 'global' }, { polling: poll.deps, clock: () => 1_000 })

    dash.start()
    await settle()
    expect(get).toHaveBeenCalledTimes(1)
    expect(get).toHaveBeenCalledWith('/fleet/dashboard')
    expect([...poll.intervals.keys()].sort((a, b) => a - b)).toEqual([1_000, 10_000])
    expect(dash.data.value?.generatedAt).toBe(GEN)

    poll.intervals.get(10_000)?.()
    await settle()
    expect(get).toHaveBeenCalledTimes(2)

    dash.stop()
    expect(poll.intervals.size).toBe(0)
  })

  test('now is server time: generatedAt plus client time since arrival, advanced by the clock tick (D416)', async () => {
    let clock = 50_000
    const { useFleetDashboard } = await load(jest.fn(async () => snapshot()))
    const poll = fakePolling()
    const dash = useFleetDashboard({ kind: 'global' }, { polling: poll.deps, clock: () => clock })

    dash.start()
    await settle()
    expect(dash.now.value.toISOString()).toBe(GEN)

    clock += 7_000
    poll.intervals.get(1_000)?.()
    await settle()
    expect(dash.now.value.toISOString()).toBe('2026-10-05T12:00:07.000Z')
  })

  test('a failed poll keeps the last snapshot and its success time; the next success clears the error (Review Focus 3)', async () => {
    const get = jest.fn<() => Promise<FleetDashboard>>()
      .mockResolvedValueOnce(snapshot())
      .mockRejectedValueOnce(new ApiError(50000, 'bad gateway'))
      .mockResolvedValueOnce(snapshot({ generatedAt: '2026-10-05T12:00:20.000Z' }))
    let clock = 1_000
    const { useFleetDashboard } = await load(get)
    const poll = fakePolling()
    const dash = useFleetDashboard({ kind: 'project', slug: 'koda' }, { polling: poll.deps, clock: () => clock })

    dash.start()
    await settle()
    expect(dash.lastSuccessAt.value).toBe(1_000)

    clock = 11_000
    await dash.refresh()
    expect(dash.data.value?.generatedAt).toBe(GEN)
    expect(dash.error.value).toBeInstanceOf(ApiError)
    expect(dash.lastSuccessAt.value).toBe(1_000)
    expect(dash.staleSince.value).toBe(hhmm(1_000))
    expect(dash.failed.value).toBe(false)
    expect(poll.intervals.has(10_000)).toBe(true)

    clock = 21_000
    await dash.refresh()
    expect(dash.error.value).toBeNull()
    expect(dash.staleSince.value).toBeNull()
    expect(dash.lastSuccessAt.value).toBe(21_000)
    expect(dash.data.value?.generatedAt).toBe('2026-10-05T12:00:20.000Z')
  })

  test.each([40003, 403])('a 403 (code %s) sets forbidden, stops both pollers and never asks again', async (code) => {
    const get = jest.fn(async () => { throw new ApiError(code, 'forbidden') })
    const { useFleetDashboard } = await load(get)
    const poll = fakePolling()
    const dash = useFleetDashboard({ kind: 'global' }, { polling: poll.deps, clock: () => 0 })

    dash.start()
    await settle()
    expect(dash.forbidden.value).toBe(true)
    expect(poll.intervals.size).toBe(0)

    await dash.refresh()
    expect(get).toHaveBeenCalledTimes(1)
  })

  test('the first load failing leaves data null and the error set, and keeps polling', async () => {
    const { useFleetDashboard } = await load(jest.fn(async () => { throw new Error('API down') }))
    const poll = fakePolling()
    const dash = useFleetDashboard({ kind: 'global' }, { polling: poll.deps, clock: () => 0 })

    dash.start()
    await settle()
    expect(dash.data.value).toBeNull()
    expect(dash.error.value).toBeInstanceOf(Error)
    expect(dash.forbidden.value).toBe(false)
    expect(dash.failed.value).toBe(true)
    expect(dash.staleSince.value).toBeNull()
    expect(poll.intervals.has(10_000)).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && bun run test -- tests/composables/useFleetDashboard.spec.ts`
Expected: FAIL with `Cannot find module '~/composables/useFleetDashboard'`.

- [ ] **Step 3: Write the composable**

Create `apps/web/composables/useFleetDashboard.ts`:

```ts
import { computed, ref, shallowRef } from 'vue'
import { isForbidden } from '~/composables/useFleetBudgetPage'
import { useVisiblePolling } from '~/composables/useVisiblePolling'
import type { PollingDeps } from '~/composables/useVisiblePolling'
import { apiPath } from '~/lib/api-path'
import { CLOCK_TICK_MS, DASHBOARD_POLL_MS, hhmm, serverNow } from '~/lib/fleet-dashboard'
import type { DashboardScope, FleetDashboard } from '~/lib/fleet-dashboard-types'

/** Spec §1.1: one snapshot route per scope. */
export function dashboardPath(scope: DashboardScope): string {
  return scope.kind === 'global' ? '/fleet/dashboard' : apiPath`/projects/${scope.slug}/fleet/dashboard`
}

/**
 * Fleet S2b (c) spec §4.1 (D420, D421): the fleet health snapshot for one scope, refreshed every 10 s while the tab
 * is visible, plus a 1 s clock so ages advance between polls. A failed poll keeps the last snapshot; a 403 stops
 * everything. The page calls `start` in onMounted and `stop` in onBeforeUnmount.
 */
export function useFleetDashboard(scope: DashboardScope, deps: { polling?: PollingDeps; clock?: () => number } = {}) {
  const { $api } = useApi()
  const clock = deps.clock ?? ((): number => Date.now())
  const data = shallowRef<FleetDashboard | null>(null)
  const error = shallowRef<unknown>(null)
  const pending = ref(false)
  const forbidden = ref(false)
  const lastSuccessAt = ref<number | null>(null)
  const receivedAt = ref(0)
  const clientNow = ref(clock())

  async function refresh(): Promise<void> {
    if (forbidden.value) return
    pending.value = true
    try {
      const next = await $api.get<FleetDashboard>(dashboardPath(scope))
      const at = clock()
      data.value = next
      error.value = null
      receivedAt.value = at
      clientNow.value = at
      lastSuccessAt.value = at
    } catch (err: unknown) {
      error.value = err
      if (isForbidden(err)) {
        forbidden.value = true
        stop()
      }
    } finally {
      pending.value = false
    }
  }

  const poller = useVisiblePolling(refresh, DASHBOARD_POLL_MS, deps.polling)
  const ticker = useVisiblePolling(async () => { clientNow.value = clock() }, CLOCK_TICK_MS, deps.polling)

  function start(): void {
    void poller.runNow()
    poller.start()
    ticker.start()
  }

  function stop(): void {
    poller.stop()
    ticker.stop()
  }

  /** D416: server time now; before the first snapshot, the client clock (nothing is aged yet). */
  const now = computed(() =>
    data.value ? serverNow(data.value.generatedAt, receivedAt.value, clientNow.value) : new Date(clientNow.value))

  /** D420: no snapshot yet and the last load failed (the page shows ErrorState with Retry). */
  const failed = computed(() => error.value !== null && data.value === null)
  /** D420: a later poll failed; the client time of the last success, as HH:MM. */
  const staleSince = computed(() =>
    (error.value !== null && data.value !== null && lastSuccessAt.value !== null ? hhmm(lastSuccessAt.value) : null))

  return { data, error, pending, forbidden, lastSuccessAt, now, failed, staleSince, refresh, start, stop }
}
```

`useVisiblePolling(task, ms, deps = browserPollingDeps())` takes `undefined` as "use the browser", so passing
`deps.polling` through is correct in production.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && bun run test -- tests/composables/useFleetDashboard.spec.ts tests/lib/api-path-guard.spec.ts`
Expected: PASS. If the 403 test sees two `setInterval` handles left, `stop()` was not reached from `refresh` (check
`isForbidden` matches both 40003 and 403).

- [ ] **Step 5: Commit**

```bash
git add apps/web/composables/useFleetDashboard.ts apps/web/tests/composables/useFleetDashboard.spec.ts
git commit -m "feat(web): useFleetDashboard polling, server clock and stale state (S2b (c) slice 2, D416, D420, D421)"
```

---
### Task 4: Tiles and the attention list

**Files:**
- Create: `apps/web/components/fleet/dashboard/Tiles.vue`
- Create: `apps/web/components/fleet/dashboard/AttentionList.vue`
- Modify: `apps/web/tests/helpers/mount-sfc.ts` (`FLEET_COMPONENT_FILES`, `FleetComponentName`)
- Test: `apps/web/tests/components/fleet-dashboard-attention.spec.ts`

**Interfaces:**
- Consumes: Task 1 (`DashboardTile`, `dashboardTiles`), Task 2 (`attentionMessage`, `attentionLink`, `severityOf`,
  `renderText`, `I18nText`), `FleetAge` (`components/fleet/Age.vue`, props `iso`, `now`, `mode`).
- Produces: `FleetDashboardTiles` (props `tiles: readonly DashboardTile[]`); `FleetDashboardAttentionList` (props
  `items: readonly AttentionItem[]`, `generatedAt: string`, `now: Date`, `scope: ScopeKind`). Test ids:
  `fleet-dashboard-tiles`, `fleet-dashboard-tile-<id>` (+ `data-tone`), `fleet-dashboard-tile-<id>-value`,
  `fleet-dashboard-all-clear`, `fleet-dashboard-attention-list`, `fleet-dashboard-attention-item` (+ `data-key`,
  `data-kind`, `data-severity`), `fleet-dashboard-attention-link`, `fleet-dashboard-attention-summary`,
  `fleet-dashboard-attention-detail`, `fleet-dashboard-attention-more`.
- Produces (harness): `FleetComponentName` gains `FleetDashboardTiles`, `FleetDashboardAttentionList`,
  `FleetDashboardActiveRunsTable`, `FleetDashboardRecentRunsList`, `FleetDashboardRunnerHealthList`,
  `FleetDashboardCredentialDigestChips`, `FleetDashboardOverview` (Tasks 5-7 rely on these names).

- [ ] **Step 1: Register the dashboard components in the test harness**

In `apps/web/tests/helpers/mount-sfc.ts`, add to `FLEET_COMPONENT_FILES` (after the `FleetAnalyticsIngestTable` line):

```ts
  FleetDashboardTiles: 'dashboard/Tiles.vue',
  FleetDashboardAttentionList: 'dashboard/AttentionList.vue',
  FleetDashboardActiveRunsTable: 'dashboard/ActiveRunsTable.vue',
  FleetDashboardRecentRunsList: 'dashboard/RecentRunsList.vue',
  FleetDashboardRunnerHealthList: 'dashboard/RunnerHealthList.vue',
  FleetDashboardCredentialDigestChips: 'dashboard/CredentialDigestChips.vue',
  FleetDashboardOverview: 'dashboard/Overview.vue',
```

and extend the `FleetComponentName` union at the end of the file:

```ts
  | 'FleetAnalyticsIngestNotice' | 'FleetAnalyticsIngestTable'
  | 'FleetDashboardTiles' | 'FleetDashboardAttentionList' | 'FleetDashboardActiveRunsTable' | 'FleetDashboardRecentRunsList'
  | 'FleetDashboardRunnerHealthList' | 'FleetDashboardCredentialDigestChips' | 'FleetDashboardOverview'
```

(The first line above already exists; append the two new lines after it.) A file is only read when a test mounts it,
so registering the Task 5-7 names now is safe.

- [ ] **Step 2: Write the failing test**

Create `apps/web/tests/components/fleet-dashboard-attention.spec.ts`:

```ts
import { describe, expect, it } from '@jest/globals'
import { readdirSync, readFileSync } from 'node:fs'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'
import { dashboardTiles } from '~/lib/fleet-dashboard'
import type { AttentionItem } from '~/lib/fleet-dashboard-types'

const dir = webFile('components', 'fleet', 'dashboard')
const file = (name: string): string => webFile('components', 'fleet', 'dashboard', name)
/** The real FleetAge is mounted, so its stub is dropped. */
const { FleetAge: _ageStub, ...stubs } = uiStubs
const mount = (name: string, props: Record<string, unknown>) =>
  mountSfc(file(name), { props, components: stubs, fleetComponents: ['FleetAge'], globals: { useI18n: () => enI18n() } })
const byId = (app: ReturnType<typeof mountSfc>, id: string) => app.find(`[data-testid="${id}"]`)

const GEN = '2026-10-05T12:00:00.000Z'
const NOW = new Date('2026-10-05T12:00:10.000Z')
const job = (over: Partial<AttentionItem>): AttentionItem => ({
  key: 'job_silent:j1', kind: 'job_silent', severity: 'error', subjectType: 'job', subjectId: 'j1', subjectName: 'subtract',
  projectSlug: 'koda', since: '2026-10-05T11:50:00.000Z', stage: 'running', silentSec: 590, runnerName: 'wk-mac', ...over,
})
const runner: AttentionItem = {
  key: 'runner_unhealthy:r1', kind: 'runner_unhealthy', severity: 'warning', subjectType: 'runner', subjectId: 'r1',
  subjectName: 'linux-1', projectSlug: null, since: null, conditions: [{ type: 'offline', jobsHeld: 0 }, { type: 'configuration' }],
}
const unplaceable = job({
  key: 'job_unplaceable:j2', kind: 'job_unplaceable', severity: 'warning', subjectId: 'j2', subjectName: 'multiply', stage: undefined,
  verdict: 'no_fit', reasons: [{ runnerName: 'wk-mac', reason: 'labels' }], reasonsTotal: 3,
})

describe('dashboard components never render HTML from data (Review Focus 1)', () => {
  it('no component in components/fleet/dashboard uses v-html', () => {
    for (const name of readdirSync(dir).filter((f) => f.endsWith('.vue'))) {
      expect({ name, vHtml: readFileSync(file(name), 'utf-8').includes('v-html') }).toEqual({ name, vHtml: false })
    }
  })
})

describe('FleetDashboardTiles (D423)', () => {
  it('one link per count, to its section, with the tone and the label', () => {
    const app = mount('Tiles.vue', { tiles: dashboardTiles({ runnersOnline: 1, runnersTotal: 2, queued: 0, running: 3, attention: 1 }) })
    const tile = (id: string) => byId(app, `fleet-dashboard-tile-${id}`)[0]
    expect(tile('runners').props.href).toBe('#fleet-dashboard-runners')
    expect(tile('runners').props['data-tone']).toBe('warn')
    expect(tile('attention').props.href).toBe('#fleet-dashboard-attention')
    expect(tile('attention').props['data-tone']).toBe('bad')
    expect(app.textOf(byId(app, 'fleet-dashboard-tile-runners-value')[0])).toBe('1/2')
    expect(app.textOf(tile('running'))).toContain('Running')
    expect(app.textOf(byId(app, 'fleet-dashboard-tile-running-value')[0])).toBe('3')
  })
})

describe('FleetDashboardAttentionList (spec §4.2, D418, D419)', () => {
  it('keeps the server order and marks each item with its key, kind and severity', () => {
    const app = mount('AttentionList.vue', { items: [job({}), unplaceable, runner], generatedAt: GEN, now: NOW, scope: 'global' })
    expect(byId(app, 'fleet-dashboard-attention-item').map((n) => [n.props['data-key'], n.props['data-kind'], n.props['data-severity']])).toEqual([
      ['job_silent:j1', 'job_silent', 'error'],
      ['job_unplaceable:j2', 'job_unplaceable', 'warning'],
      ['runner_unhealthy:r1', 'runner_unhealthy', 'warning'],
    ])
  })

  it('words each item: severity, subject, project, age, summary, details and the rest counted', () => {
    const app = mount('AttentionList.vue', { items: [job({}), unplaceable, runner], generatedAt: GEN, now: NOW, scope: 'global' })
    const [silent, misfit, sick] = byId(app, 'fleet-dashboard-attention-item')
    expect(app.textOf(silent)).toContain('Error')
    expect(app.textOf(silent)).toContain('subtract')
    expect(app.textOf(silent)).toContain('koda')
    expect(app.textOf(silent)).toContain('10m ago')
    expect(app.textOf(byId(app, 'fleet-dashboard-attention-summary')[0])).toBe('No heartbeat for 10m on wk-mac')
    expect(app.textOf(misfit)).toContain('No runner fits right now')
    expect(app.textOf(misfit)).toContain('wk-mac: Runner lacks a required label')
    expect(app.textOf(misfit)).toContain('and 2 more runner(s)')
    expect(app.find('[data-testid="fleet-dashboard-attention-detail"]', sick).map((n) => app.textOf(n)))
      .toEqual(['Offline', 'Configuration problem (ask a fleet admin)'])
  })

  it('links jobs to the job page, approvals to the inbox, runners to the admin Runners page (admin scope)', () => {
    const approval = job({ key: 'job_waiting_approval:j3', kind: 'job_waiting_approval', subjectId: 'j3', pending: 1, oldestSec: 30 })
    const app = mount('AttentionList.vue', { items: [job({}), approval, runner], generatedAt: GEN, now: NOW, scope: 'global' })
    expect(byId(app, 'fleet-dashboard-attention-link').map((n) => n.props.to)).toEqual([
      '/koda/fleet/jobs/j1', '/koda/fleet/approvals', '/admin/fleet/runners',
    ])
  })

  it('project scope: runner items are plain text and the project slug is not repeated', () => {
    const app = mount('AttentionList.vue', { items: [job({}), runner], generatedAt: GEN, now: NOW, scope: 'project' })
    expect(byId(app, 'fleet-dashboard-attention-link').map((n) => n.props.to)).toEqual(['/koda/fleet/jobs/j1'])
    expect(app.text()).toContain('linux-1')
    expect(byId(app, 'fleet-dashboard-attention-project')).toHaveLength(0)
  })

  it('shows markup in a name as text, never as an element (Review Focus 1)', () => {
    const evil = '<img src=x onerror=alert(1)>'
    const app = mount('AttentionList.vue', {
      items: [job({ subjectName: evil, runnerName: evil })], generatedAt: GEN, now: NOW, scope: 'global',
    })
    expect(app.text()).toContain(evil)
    expect(app.find('img')).toHaveLength(0)
  })

  it('an empty list says All clear', () => {
    const app = mount('AttentionList.vue', { items: [], generatedAt: GEN, now: NOW, scope: 'global' })
    expect(app.textOf(byId(app, 'fleet-dashboard-all-clear')[0])).toBe('All clear')
    expect(byId(app, 'fleet-dashboard-attention-list')).toHaveLength(0)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/web && bun run test -- tests/components/fleet-dashboard-attention.spec.ts`
Expected: FAIL (`ENOENT` for `components/fleet/dashboard`). The v-html guard needs the directory to exist.

- [ ] **Step 4: Write the components**

Create `apps/web/components/fleet/dashboard/Tiles.vue`:

```vue
<script setup lang="ts">
import type { DashboardTile } from '~/lib/fleet-dashboard'

/** D423: the four counts; each tile links to its section. */
defineProps<{ tiles: readonly DashboardTile[] }>()
const { t } = useI18n()
</script>

<template>
  <ul class="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="fleet-dashboard-tiles">
    <li v-for="tile in tiles" :key="tile.id">
      <a
        :href="tile.href"
        class="block rounded-md border border-border p-3 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        :data-testid="`fleet-dashboard-tile-${tile.id}`"
        :data-tone="tile.tone"
      >
        <span class="block text-xs text-muted-foreground">{{ t(`fleet.dashboard.tiles.${tile.id}`) }}</span>
        <span
          class="mt-1 block text-xl font-semibold"
          :class="{ 'text-status-review': tile.tone === 'warn', 'text-destructive': tile.tone === 'bad' }"
          :data-testid="`fleet-dashboard-tile-${tile.id}-value`"
        >{{ tile.value }}</span>
      </a>
    </li>
  </ul>
</template>
```

Create `apps/web/components/fleet/dashboard/AttentionList.vue`:

```vue
<script setup lang="ts">
import { computed } from 'vue'
import { attentionLink, attentionMessage, renderText, severityOf } from '~/lib/fleet-dashboard'
import type { I18nText } from '~/lib/fleet-dashboard'
import type { AttentionItem, ScopeKind } from '~/lib/fleet-dashboard-types'

/** Spec §4.2: what needs a human, in server order (errors first). Every line is worded here (D418). */
const props = defineProps<{ items: readonly AttentionItem[]; generatedAt: string; now: Date; scope: ScopeKind }>()
const { t, te } = useI18n()

const say = (text: I18nText): string => renderText(text, (key, named) => t(key, named ?? {}), te)

const rows = computed(() =>
  props.items.map((item) => {
    const message = attentionMessage(item, props.generatedAt, props.now)
    return {
      item,
      severity: severityOf(item),
      link: attentionLink(item, props.scope),
      summary: message.summary ? say(message.summary) : null,
      details: message.details.map(say),
      more: message.more,
    }
  }))
</script>

<template>
  <p v-if="items.length === 0" class="text-sm text-muted-foreground" data-testid="fleet-dashboard-all-clear">
    {{ t('fleet.dashboard.attention.allClear') }}
  </p>
  <ul v-else class="divide-y divide-border rounded-md border border-border" data-testid="fleet-dashboard-attention-list">
    <li
      v-for="row in rows"
      :key="row.item.key"
      class="flex items-start gap-3 p-3"
      data-testid="fleet-dashboard-attention-item"
      :data-key="row.item.key"
      :data-kind="row.item.kind"
      :data-severity="row.item.severity"
    >
      <Badge :variant="row.severity === 'error' ? 'destructive' : 'outline'" class="shrink-0">
        {{ t(`fleet.dashboard.severity.${row.severity}`) }}
      </Badge>
      <div class="min-w-0 flex-1 space-y-1">
        <div class="flex flex-wrap items-baseline gap-x-2">
          <NuxtLink
            v-if="row.link"
            :to="row.link"
            class="break-all font-medium text-primary underline-offset-4 hover:underline"
            data-testid="fleet-dashboard-attention-link"
          >{{ row.item.subjectName }}</NuxtLink>
          <span v-else class="break-all font-medium">{{ row.item.subjectName }}</span>
          <span
            v-if="scope === 'global' && row.item.projectSlug"
            class="text-xs text-muted-foreground"
            data-testid="fleet-dashboard-attention-project"
          >{{ row.item.projectSlug }}</span>
          <span v-if="row.item.since" class="text-xs text-muted-foreground"><FleetAge :iso="row.item.since" :now="now" mode="ago" /></span>
        </div>
        <p v-if="row.summary" class="text-sm" data-testid="fleet-dashboard-attention-summary">{{ row.summary }}</p>
        <ul v-if="row.details.length > 0" class="list-disc space-y-0.5 pl-5 text-sm text-muted-foreground">
          <li v-for="(detail, i) in row.details" :key="i" data-testid="fleet-dashboard-attention-detail">{{ detail }}</li>
        </ul>
        <p v-if="row.more > 0" class="text-xs text-muted-foreground" data-testid="fleet-dashboard-attention-more">
          {{ t('fleet.dashboard.attention.more', { n: row.more }) }}
        </p>
      </div>
    </li>
  </ul>
</template>
```

The `(key, named) => t(key, named ?? {})` wrapper adapts vue-i18n's overloaded `t` to `Translate`; keep it if
`nuxt typecheck` accepts plain `t` too, it costs nothing.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/web && bun run test -- tests/components/fleet-dashboard-attention.spec.ts`
Expected: PASS. If `'10m ago'` is missing, `FleetAge` rendered as a stub: the spec must drop the `FleetAge` stub and
pass `fleetComponents: ['FleetAge']`, as shown.

- [ ] **Step 6: Commit**

```bash
git add apps/web/components/fleet/dashboard/Tiles.vue apps/web/components/fleet/dashboard/AttentionList.vue apps/web/tests/helpers/mount-sfc.ts apps/web/tests/components/fleet-dashboard-attention.spec.ts
git commit -m "feat(web): fleet dashboard tiles and attention list (S2b (c) slice 2, D418, D419, D423)"
```

---

### Task 5: Active and recent jobs

**Files:**
- Create: `apps/web/components/fleet/dashboard/ActiveRunsTable.vue`
- Create: `apps/web/components/fleet/dashboard/RecentRunsList.vue`
- Test: `apps/web/tests/components/fleet-dashboard-tables.spec.ts`

**Interfaces:**
- Consumes: Task 1 (`jobPath`, `storiesText`, `costText`, `durationParts`, `safeHttpUrl`, `DashboardActiveJob`,
  `DashboardRecentJob`, `ScopeKind`), `usd`, `FleetJobStateBadge` (explicit import, `components/fleet/FleetJobStateBadge.vue`,
  prop `state`, renders `data-testid="fleet-job-state"` and falls back to the raw state through `codeLabel`), `FleetAge`.
- Produces: `FleetDashboardActiveRunsTable` (props `jobs`, `now: Date`, `scope: ScopeKind`, `truncated: boolean`);
  `FleetDashboardRecentRunsList` (props `jobs`, `now: Date`, `scope: ScopeKind`, `truncated: boolean`, `analyticsTo: string`).
  Test ids: `fleet-dashboard-active`, `fleet-dashboard-active-row` (+ `data-job`), `fleet-dashboard-active-link`,
  `fleet-dashboard-active-runner`, `fleet-dashboard-active-stories`, `fleet-dashboard-active-cost`,
  `fleet-dashboard-active-approvals`, `fleet-dashboard-active-truncated`, `fleet-dashboard-recent`,
  `fleet-dashboard-recent-row` (+ `data-job`), `fleet-dashboard-recent-link`, `fleet-dashboard-recent-duration`,
  `fleet-dashboard-recent-cost`, `fleet-dashboard-recent-reason`, `fleet-dashboard-recent-pr`,
  `fleet-dashboard-recent-truncated`, `fleet-dashboard-analytics-link`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/tests/components/fleet-dashboard-tables.spec.ts`:

```ts
import { describe, expect, it } from '@jest/globals'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'
import type { DashboardActiveJob, DashboardRecentJob } from '~/lib/fleet-dashboard-types'

const file = (name: string): string => webFile('components', 'fleet', 'dashboard', name)
const { FleetAge: _ageStub, ...stubs } = uiStubs
const mount = (name: string, props: Record<string, unknown>) =>
  mountSfc(file(name), { props, components: stubs, fleetComponents: ['FleetAge'], globals: { useI18n: () => enI18n() } })
const byId = (app: ReturnType<typeof mountSfc>, id: string) => app.find(`[data-testid="${id}"]`)
const texts = (app: ReturnType<typeof mountSfc>, id: string) => byId(app, id).map((n) => app.textOf(n))

const NOW = new Date('2026-10-05T12:00:00.000Z')

const active = (id: string, over: Partial<DashboardActiveJob> = {}): DashboardActiveJob => ({
  id, projectSlug: 'koda', repo: 'acme/app', feature: `feat-${id}`, command: 'RUN', state: 'RUNNING', runnerId: 'r1', runnerName: 'wk-mac',
  currentStoryId: 'US-002', currentPhase: 'review', storiesDone: 3, storiesTotal: 5, costSpentUsd: '0.0664', maxCostUsd: '5.0000',
  queuedAt: '2026-10-05T11:00:00.000Z', startedAt: '2026-10-05T11:01:00.000Z', lastHeartbeatAt: '2026-10-05T11:58:00.000Z',
  pendingApprovals: 0, ...over,
})

const recent = (id: string, over: Partial<DashboardRecentJob> = {}): DashboardRecentJob => ({
  id, projectSlug: 'koda', repo: 'acme/app', feature: `feat-${id}`, command: 'RUN', state: 'COMPLETED', stateReason: null,
  runnerName: 'wk-mac', costSpentUsd: '0.1395', startedAt: '2026-10-05T11:40:00.000Z', finishedAt: '2026-10-05T11:55:00.000Z',
  resultPrUrl: 'https://github.com/acme/app/pull/2', ...over,
})

describe('FleetDashboardActiveRunsTable (spec §4.2)', () => {
  it('one row per job in API order, the feature linking to the job page', () => {
    const app = mount('ActiveRunsTable.vue', { jobs: [active('a'), active('b')], now: NOW, scope: 'project', truncated: false })
    expect(byId(app, 'fleet-dashboard-active-row').map((r) => r.props['data-job'])).toEqual(['a', 'b'])
    expect(byId(app, 'fleet-dashboard-active-link').map((n) => n.props.to)).toEqual(['/koda/fleet/jobs/a', '/koda/fleet/jobs/b'])
  })

  it('shows stories done/total, cost against the cap unchanged, story, phase and heartbeat age', () => {
    const app = mount('ActiveRunsTable.vue', { jobs: [active('a')], now: NOW, scope: 'project', truncated: false })
    expect(texts(app, 'fleet-dashboard-active-stories')).toEqual(['3/5'])
    expect(texts(app, 'fleet-dashboard-active-cost')).toEqual(['$0.0664 / $5.0000'])
    const row = app.textOf(byId(app, 'fleet-dashboard-active-row')[0])
    expect(row).toContain('US-002')
    expect(row).toContain('review')
    expect(row).toContain('2m ago')
    expect(row).toContain('Running')
  })

  it('the project column shows only in the admin scope', () => {
    const admin = mount('ActiveRunsTable.vue', { jobs: [active('a')], now: NOW, scope: 'global', truncated: false })
    const member = mount('ActiveRunsTable.vue', { jobs: [active('a')], now: NOW, scope: 'project', truncated: false })
    expect(admin.find('[data-stub="th"]').length).toBe(member.find('[data-stub="th"]').length + 1)
    expect(admin.text()).toContain('Project')
    expect(member.text()).not.toContain('Project')
  })

  it('a queued job reads Not assigned; a deleted runner reads Unknown; unknown stories read -', () => {
    const app = mount('ActiveRunsTable.vue', {
      jobs: [
        active('q', { state: 'QUEUED', runnerId: null, runnerName: null, storiesDone: null, storiesTotal: null, lastHeartbeatAt: null }),
        active('d', { runnerId: 'gone', runnerName: null }),
      ],
      now: NOW, scope: 'project', truncated: false,
    })
    expect(texts(app, 'fleet-dashboard-active-runner')).toEqual(['Not assigned', 'Unknown'])
    expect(texts(app, 'fleet-dashboard-active-stories')[0]).toBe('-')
  })

  it('flags pending approvals on the row', () => {
    const app = mount('ActiveRunsTable.vue', { jobs: [active('a', { pendingApprovals: 2 })], now: NOW, scope: 'project', truncated: false })
    expect(texts(app, 'fleet-dashboard-active-approvals')).toEqual(['2 approval(s) pending'])
  })

  it('a state the web does not know shows its raw code (Review Focus 4)', () => {
    const app = mount('ActiveRunsTable.vue', { jobs: [active('a', { state: 'HIBERNATING' })], now: NOW, scope: 'project', truncated: false })
    expect(app.textOf(byId(app, 'fleet-job-state')[0])).toBe('HIBERNATING')
  })

  it('says when the list was capped, and shows the empty state with no jobs', () => {
    const capped = mount('ActiveRunsTable.vue', { jobs: [active('a')], now: NOW, scope: 'project', truncated: true })
    expect(texts(capped, 'fleet-dashboard-active-truncated')).toEqual(['Showing the oldest 200 active jobs.'])
    const empty = mount('ActiveRunsTable.vue', { jobs: [], now: NOW, scope: 'project', truncated: false })
    expect(empty.find('[data-stub="empty-state"]').map((n) => n.props.message)).toEqual(['No active jobs'])
    expect(byId(empty, 'fleet-dashboard-active')).toHaveLength(0)
  })
})

describe('FleetDashboardRecentRunsList (spec §4.2, B6, D419)', () => {
  const props = (jobs: DashboardRecentJob[], over: Record<string, unknown> = {}) =>
    ({ jobs, now: NOW, scope: 'project', truncated: false, analyticsTo: '/koda/fleet/analytics', ...over })

  it('state, duration, cost unchanged, finished age and the job link', () => {
    const app = mount('RecentRunsList.vue', props([recent('a')]))
    expect(byId(app, 'fleet-dashboard-recent-row').map((r) => r.props['data-job'])).toEqual(['a'])
    expect(byId(app, 'fleet-dashboard-recent-link')[0].props.to).toBe('/koda/fleet/jobs/a')
    expect(texts(app, 'fleet-dashboard-recent-duration')).toEqual(['15m'])
    expect(texts(app, 'fleet-dashboard-recent-cost')).toEqual(['$0.1395'])
    const row = app.textOf(byId(app, 'fleet-dashboard-recent-row')[0])
    expect(row).toContain('Completed')
    expect(row).toContain('5m ago')
  })

  it('the PR link opens a new tab safely, and only for http(s) URLs', () => {
    const app = mount('RecentRunsList.vue', props([recent('a'), recent('b', { resultPrUrl: 'javascript:alert(1)' }), recent('c', { resultPrUrl: null })]))
    const links = byId(app, 'fleet-dashboard-recent-pr')
    expect(links.map((n) => n.props.href)).toEqual(['https://github.com/acme/app/pull/2'])
    expect(links[0].props.rel).toBe('noopener noreferrer')
    expect(links[0].props.target).toBe('_blank')
  })

  it('shows the state reason and - for a job that never started', () => {
    const app = mount('RecentRunsList.vue', props([recent('a', { state: 'CRASHED', stateReason: 'runner silent', startedAt: null })]))
    expect(texts(app, 'fleet-dashboard-recent-reason')).toEqual(['runner silent'])
    expect(texts(app, 'fleet-dashboard-recent-duration')).toEqual(['-'])
  })

  it('links to the Analytics page, notes the cap, and shows the empty text', () => {
    const app = mount('RecentRunsList.vue', props([recent('a')], { truncated: true }))
    expect(byId(app, 'fleet-dashboard-analytics-link')[0].props.to).toBe('/koda/fleet/analytics')
    expect(texts(app, 'fleet-dashboard-recent-truncated')).toEqual(['Showing the latest 20.'])
    const empty = mount('RecentRunsList.vue', props([]))
    expect(empty.find('[data-stub="empty-state"]').map((n) => n.props.message)).toEqual(['No runs in the last 24 hours'])
    expect(byId(empty, 'fleet-dashboard-analytics-link')).toHaveLength(1)
  })

  it('the project column shows only in the admin scope', () => {
    const admin = mount('RecentRunsList.vue', props([recent('a')], { scope: 'global' }))
    const member = mount('RecentRunsList.vue', props([recent('a')]))
    expect(admin.find('[data-stub="th"]').length).toBe(member.find('[data-stub="th"]').length + 1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && bun run test -- tests/components/fleet-dashboard-tables.spec.ts`
Expected: FAIL (cannot read `ActiveRunsTable.vue`).

- [ ] **Step 3: Write the components**

Create `apps/web/components/fleet/dashboard/ActiveRunsTable.vue`:

```vue
<script setup lang="ts">
import FleetJobStateBadge from '~/components/fleet/FleetJobStateBadge.vue'
import { costText, jobPath, storiesText } from '~/lib/fleet-dashboard'
import type { DashboardActiveJob, ScopeKind } from '~/lib/fleet-dashboard-types'

/** Spec §4.2: what is queued or running now, oldest first; the feature opens the job page. */
defineProps<{ jobs: readonly DashboardActiveJob[]; now: Date; scope: ScopeKind; truncated: boolean }>()
const { t } = useI18n()

/** A queued job has no runner yet; a held job whose runner was deleted has an id but no name. */
function runnerText(job: DashboardActiveJob): string {
  if (job.runnerName) return job.runnerName
  return job.runnerId === null ? t('fleet.dashboard.active.unassigned') : t('fleet.common.unknown')
}
</script>

<template>
  <EmptyState v-if="jobs.length === 0" :message="t('fleet.dashboard.active.empty')" />
  <div v-else class="space-y-2">
    <div class="overflow-x-auto">
      <Table data-testid="fleet-dashboard-active">
        <TableHeader>
          <TableRow>
            <TableHead>{{ t('fleet.dashboard.active.columns.feature') }}</TableHead>
            <TableHead v-if="scope === 'global'">{{ t('fleet.dashboard.active.columns.project') }}</TableHead>
            <TableHead>{{ t('fleet.dashboard.active.columns.repo') }}</TableHead>
            <TableHead>{{ t('fleet.dashboard.active.columns.state') }}</TableHead>
            <TableHead>{{ t('fleet.dashboard.active.columns.runner') }}</TableHead>
            <TableHead>{{ t('fleet.dashboard.active.columns.story') }}</TableHead>
            <TableHead>{{ t('fleet.dashboard.active.columns.phase') }}</TableHead>
            <TableHead>{{ t('fleet.dashboard.active.columns.stories') }}</TableHead>
            <TableHead>{{ t('fleet.dashboard.active.columns.cost') }}</TableHead>
            <TableHead>{{ t('fleet.dashboard.active.columns.heartbeat') }}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow v-for="job in jobs" :key="job.id" data-testid="fleet-dashboard-active-row" :data-job="job.id">
            <TableCell>
              <NuxtLink
                :to="jobPath(job.projectSlug, job.id)"
                class="break-all font-medium text-primary underline-offset-4 hover:underline"
                data-testid="fleet-dashboard-active-link"
              >{{ job.feature }}</NuxtLink>
              <Badge v-if="job.pendingApprovals > 0" variant="destructive" class="ml-2" data-testid="fleet-dashboard-active-approvals">
                {{ t('fleet.dashboard.active.approvals', { n: job.pendingApprovals }) }}
              </Badge>
            </TableCell>
            <TableCell v-if="scope === 'global'">{{ job.projectSlug }}</TableCell>
            <TableCell class="text-muted-foreground">{{ job.repo }}</TableCell>
            <TableCell><FleetJobStateBadge :state="job.state" /></TableCell>
            <TableCell data-testid="fleet-dashboard-active-runner">{{ runnerText(job) }}</TableCell>
            <TableCell>{{ job.currentStoryId ?? '-' }}</TableCell>
            <TableCell>{{ job.currentPhase ?? '-' }}</TableCell>
            <TableCell data-testid="fleet-dashboard-active-stories">{{ storiesText(job.storiesDone, job.storiesTotal) }}</TableCell>
            <TableCell class="whitespace-nowrap" data-testid="fleet-dashboard-active-cost">{{ costText(job.costSpentUsd, job.maxCostUsd) }}</TableCell>
            <TableCell class="whitespace-nowrap"><FleetAge :iso="job.lastHeartbeatAt" :now="now" mode="ago" /></TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>
    <p v-if="truncated" class="text-xs text-muted-foreground" data-testid="fleet-dashboard-active-truncated">
      {{ t('fleet.dashboard.active.truncated') }}
    </p>
  </div>
</template>
```

Create `apps/web/components/fleet/dashboard/RecentRunsList.vue`:

```vue
<script setup lang="ts">
import { computed } from 'vue'
import FleetJobStateBadge from '~/components/fleet/FleetJobStateBadge.vue'
import { usd } from '~/lib/fleet-analytics-format'
import { durationParts, jobPath, safeHttpUrl } from '~/lib/fleet-dashboard'
import type { DashboardRecentJob, ScopeKind } from '~/lib/fleet-dashboard-types'

/** Spec §4.2, B6: jobs finished in the last 24 h (newest first, at most 20), with a link to the Analytics page. */
const props = defineProps<{ jobs: readonly DashboardRecentJob[]; now: Date; scope: ScopeKind; truncated: boolean; analyticsTo: string }>()
const { t } = useI18n()

const rows = computed(() =>
  props.jobs.map((job) => {
    const duration = durationParts(job.startedAt, job.finishedAt)
    return {
      job,
      duration: duration ? t(`fleet.common.duration.${duration.unit}`, { n: duration.n }) : '-',
      prUrl: safeHttpUrl(job.resultPrUrl),
    }
  }))
</script>

<template>
  <div class="space-y-2">
    <EmptyState v-if="jobs.length === 0" :message="t('fleet.dashboard.recent.empty')" />
    <div v-else class="overflow-x-auto">
      <Table data-testid="fleet-dashboard-recent">
        <TableHeader>
          <TableRow>
            <TableHead>{{ t('fleet.dashboard.recent.columns.feature') }}</TableHead>
            <TableHead v-if="scope === 'global'">{{ t('fleet.dashboard.recent.columns.project') }}</TableHead>
            <TableHead>{{ t('fleet.dashboard.recent.columns.state') }}</TableHead>
            <TableHead>{{ t('fleet.dashboard.recent.columns.runner') }}</TableHead>
            <TableHead>{{ t('fleet.dashboard.recent.columns.duration') }}</TableHead>
            <TableHead>{{ t('fleet.dashboard.recent.columns.cost') }}</TableHead>
            <TableHead>{{ t('fleet.dashboard.recent.columns.finished') }}</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow v-for="row in rows" :key="row.job.id" data-testid="fleet-dashboard-recent-row" :data-job="row.job.id">
            <TableCell>
              <NuxtLink
                :to="jobPath(row.job.projectSlug, row.job.id)"
                class="break-all font-medium text-primary underline-offset-4 hover:underline"
                data-testid="fleet-dashboard-recent-link"
              >{{ row.job.feature }}</NuxtLink>
            </TableCell>
            <TableCell v-if="scope === 'global'">{{ row.job.projectSlug }}</TableCell>
            <TableCell>
              <FleetJobStateBadge :state="row.job.state" />
              <div v-if="row.job.stateReason" class="mt-1 text-xs text-muted-foreground" data-testid="fleet-dashboard-recent-reason">
                {{ row.job.stateReason }}
              </div>
            </TableCell>
            <TableCell>{{ row.job.runnerName ?? '-' }}</TableCell>
            <TableCell data-testid="fleet-dashboard-recent-duration">{{ row.duration }}</TableCell>
            <TableCell class="whitespace-nowrap" data-testid="fleet-dashboard-recent-cost">{{ usd(row.job.costSpentUsd) }}</TableCell>
            <TableCell class="whitespace-nowrap"><FleetAge :iso="row.job.finishedAt" :now="now" mode="ago" /></TableCell>
            <TableCell>
              <a
                v-if="row.prUrl"
                :href="row.prUrl"
                target="_blank"
                rel="noopener noreferrer"
                class="text-primary underline-offset-4 hover:underline"
                data-testid="fleet-dashboard-recent-pr"
              >{{ t('fleet.dashboard.recent.pr') }}</a>
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>
    <p v-if="truncated" class="text-xs text-muted-foreground" data-testid="fleet-dashboard-recent-truncated">
      {{ t('fleet.dashboard.recent.truncated') }}
    </p>
    <NuxtLink :to="analyticsTo" class="inline-block text-sm text-primary underline-offset-4 hover:underline" data-testid="fleet-dashboard-analytics-link">
      {{ t('fleet.dashboard.recent.analyticsLink') }}
    </NuxtLink>
  </div>
</template>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && bun run test -- tests/components/fleet-dashboard-tables.spec.ts`
Expected: PASS. If `FleetJobStateBadge` fails to resolve `useI18n`, the harness did not pass globals to the
explicitly imported child: `instantiate` passes the parent's `globals`, so check the spec mounts with `globals:
{ useI18n }` as shown.

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/fleet/dashboard/ActiveRunsTable.vue apps/web/components/fleet/dashboard/RecentRunsList.vue apps/web/tests/components/fleet-dashboard-tables.spec.ts
git commit -m "feat(web): fleet dashboard active and recent job tables (S2b (c) slice 2, D419)"
```

---

### Task 6: Runner health, credential chips and the overview composition

**Files:**
- Create: `apps/web/components/fleet/dashboard/CredentialDigestChips.vue`
- Create: `apps/web/components/fleet/dashboard/RunnerHealthList.vue`
- Create: `apps/web/components/fleet/dashboard/Overview.vue`
- Test: `apps/web/tests/components/fleet-dashboard-runners.spec.ts`
- Test: `apps/web/tests/components/fleet-dashboard-overview.spec.ts`

**Interfaces:**
- Consumes: Task 1 (`dashboardTiles`, `SECTION_IDS`), Task 2 (`digestChips`, `renderText`), Tasks 4-5 components,
  `ChipTone` (`lib/fleet-capabilities.ts`), `ErrorState` (emits `retry`), `LoadingState`, `EmptyState` (prop `message`).
- Produces: `FleetDashboardCredentialDigestChips` (props `credentials: readonly DashboardCredential[]`);
  `FleetDashboardRunnerHealthList` (props `runners`, `now: Date`, `scope: ScopeKind`);
  `FleetDashboardOverview` (props `snapshot: FleetDashboard | null`, `failed: boolean`, `staleSince: string | null`,
  `now: Date`, `scope: ScopeKind`, `analyticsTo: string`; emits `retry`). Test ids: `fleet-dashboard-credentials`,
  `fleet-dashboard-credential` (+ `data-tone`), `fleet-dashboard-runners-list`, `fleet-dashboard-runner`
  (+ `data-runner`, `data-online`), `fleet-dashboard-runner-busy`, `fleet-dashboard-runner-versions`,
  `fleet-dashboard`, `fleet-dashboard-error`, `fleet-dashboard-updated`, `fleet-dashboard-stale`,
  `fleet-dashboard-section-<attention|active|runners|recent>`.

- [ ] **Step 1: Write the failing runner test**

Create `apps/web/tests/components/fleet-dashboard-runners.spec.ts`:

```ts
import { describe, expect, it } from '@jest/globals'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'
import type { DashboardRunner } from '~/lib/fleet-dashboard-types'

const { FleetAge: _ageStub, ...stubs } = uiStubs
const mount = (props: Record<string, unknown>) =>
  mountSfc(webFile('components', 'fleet', 'dashboard', 'RunnerHealthList.vue'), {
    props, components: stubs, fleetComponents: ['FleetAge', 'FleetDashboardCredentialDigestChips'], globals: { useI18n: () => enI18n() },
  })
const byId = (app: ReturnType<typeof mountSfc>, id: string) => app.find(`[data-testid="${id}"]`)
const NOW = new Date('2026-10-05T12:00:00.000Z')

const runner = (id: string, over: Partial<DashboardRunner> = {}): DashboardRunner => ({
  id, name: id, os: 'darwin', arch: 'arm64', labels: [], enabled: true, online: true, lastSeenAt: '2026-10-05T11:59:50.000Z',
  capacity: 2, activeJobs: 1, naxVersion: '0.83.3', daemonVersion: '0.1.0',
  credentials: [
    { providerId: 'deepseek', available: true, kind: 'api-key', expiresAt: null, expired: false },
    { providerId: 'anthropic', available: false, kind: null, expiresAt: null, expired: false },
  ],
  ...over,
})

describe('FleetDashboardRunnerHealthList (spec §4.2, B5)', () => {
  it('admin scope: online state, busy/capacity, last seen, versions and credential chips', () => {
    const app = mount({ runners: [runner('wk-mac')], now: NOW, scope: 'global' })
    const row = byId(app, 'fleet-dashboard-runner')[0]
    expect(row.props['data-runner']).toBe('wk-mac')
    expect(row.props['data-online']).toBe('true')
    expect(app.textOf(row)).toContain('Online')
    expect(app.textOf(row)).toContain('Last seen 10s ago')
    expect(app.textOf(byId(app, 'fleet-dashboard-runner-busy')[0])).toBe('1 of 2 busy')
    expect(app.textOf(byId(app, 'fleet-dashboard-runner-versions')[0])).toBe('nax 0.83.3 · daemon 0.1.0')
    expect(byId(app, 'fleet-dashboard-credential').map((n) => [app.textOf(n), n.props['data-tone']])).toEqual([
      ['deepseek: API key', 'ok'], ['anthropic: unavailable', 'bad'],
    ])
  })

  it('project scope: no versions and no credential chips, even if the data had them', () => {
    const app = mount({ runners: [runner('wk-mac')], now: NOW, scope: 'project' })
    expect(byId(app, 'fleet-dashboard-runner-versions')).toHaveLength(0)
    expect(byId(app, 'fleet-dashboard-credentials')).toHaveLength(0)
    expect(app.text()).not.toContain('0.83.3')
  })

  it('an admin runner with unreadable capabilities says the nax version is unknown', () => {
    const app = mount({ runners: [runner('x', { naxVersion: null, credentials: [] })], now: NOW, scope: 'global' })
    expect(app.textOf(byId(app, 'fleet-dashboard-runner-versions')[0])).toBe('nax version unknown · daemon 0.1.0')
    expect(byId(app, 'fleet-dashboard-credentials')).toHaveLength(0)
  })

  it('offline and disabled runners say so in words', () => {
    const app = mount({ runners: [runner('x', { online: false, enabled: false })], now: NOW, scope: 'project' })
    const row = byId(app, 'fleet-dashboard-runner')[0]
    expect(row.props['data-online']).toBe('false')
    expect(app.textOf(row)).toContain('Offline')
    expect(app.textOf(row)).toContain('Disabled')
  })

  it('no runners shows the empty text', () => {
    const app = mount({ runners: [], now: NOW, scope: 'global' })
    expect(app.find('[data-stub="empty-state"]').map((n) => n.props.message)).toEqual(['No runners enrolled'])
  })
})
```

- [ ] **Step 2: Write the failing overview test**

Create `apps/web/tests/components/fleet-dashboard-overview.spec.ts`:

```ts
import { describe, expect, it } from '@jest/globals'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import type { FleetComponentName } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'
import type { FleetDashboard } from '~/lib/fleet-dashboard-types'

const REAL: FleetComponentName[] = [
  'FleetAge', 'FleetDashboardTiles', 'FleetDashboardAttentionList', 'FleetDashboardActiveRunsTable', 'FleetDashboardRecentRunsList',
  'FleetDashboardRunnerHealthList', 'FleetDashboardCredentialDigestChips',
]
const { FleetAge: _ageStub, ...stubs } = uiStubs
const mount = (props: Record<string, unknown>) =>
  mountSfc(webFile('components', 'fleet', 'dashboard', 'Overview.vue'), {
    props: { failed: false, staleSince: null, now: new Date('2026-10-05T12:00:05.000Z'), scope: 'global', analyticsTo: '/admin/fleet/analytics', ...props },
    components: stubs, fleetComponents: REAL, globals: { useI18n: () => enI18n() },
  })
const byId = (app: ReturnType<typeof mountSfc>, id: string) => app.find(`[data-testid="${id}"]`)

const EMPTY: FleetDashboard = {
  generatedAt: '2026-10-05T12:00:00.000Z',
  counts: { runnersOnline: 0, runnersTotal: 0, queued: 0, running: 0, attention: 0 },
  runners: [], activeJobs: [], activeTruncated: false, recentJobs: [], recentTruncated: false, attention: [],
}

const FULL: FleetDashboard = {
  ...EMPTY,
  counts: { runnersOnline: 1, runnersTotal: 1, queued: 0, running: 1, attention: 1 },
  runners: [{
    id: 'r1', name: 'wk-mac', os: 'darwin', arch: 'arm64', labels: [], enabled: true, online: true, lastSeenAt: '2026-10-05T11:59:59.000Z',
    capacity: 2, activeJobs: 1, naxVersion: '0.83.3', daemonVersion: '0.1.0', credentials: [],
  }],
  activeJobs: [{
    id: 'j1', projectSlug: 'koda', repo: 'acme/app', feature: 'subtract', command: 'RUN', state: 'RUNNING', runnerId: 'r1', runnerName: 'wk-mac',
    currentStoryId: 'US-001', currentPhase: 'run', storiesDone: 0, storiesTotal: 1, costSpentUsd: '0.0100', maxCostUsd: '5.0000',
    queuedAt: '2026-10-05T11:00:00.000Z', startedAt: '2026-10-05T11:00:05.000Z', lastHeartbeatAt: '2026-10-05T11:45:00.000Z', pendingApprovals: 0,
  }],
  attention: [{
    key: 'job_silent:j1', kind: 'job_silent', severity: 'error', subjectType: 'job', subjectId: 'j1', subjectName: 'subtract',
    projectSlug: 'koda', since: '2026-10-05T11:45:00.000Z', stage: 'running', silentSec: 900, runnerName: 'wk-mac',
  }],
}

describe('FleetDashboardOverview (spec §4, D420, D422)', () => {
  it('loading before the first snapshot, the error state with Retry when it failed', () => {
    const loading = mount({ snapshot: null })
    expect(loading.find('[data-stub="loading-state"]')).toHaveLength(1)
    const failed = mount({ snapshot: null, failed: true })
    expect(byId(failed, 'fleet-dashboard-error')).toHaveLength(1)
    const errorState = failed.find('[data-stub="error-state"]')[0]
    ;(errorState.props.onRetry as () => void)()
    expect(failed.emitted('retry')).toHaveLength(1)
  })

  it('an empty fleet: zero tiles, All clear, and every section empty (Review Focus 5)', () => {
    const app = mount({ snapshot: EMPTY })
    expect(['runners', 'queued', 'running', 'attention'].map((id) => app.textOf(byId(app, `fleet-dashboard-tile-${id}-value`)[0])))
      .toEqual(['0/0', '0', '0', '0'])
    expect(byId(app, 'fleet-dashboard-all-clear')).toHaveLength(1)
    expect(app.find('[data-stub="empty-state"]').map((n) => n.props.message))
      .toEqual(['No active jobs', 'No runners enrolled', 'No runs in the last 24 hours'])
  })

  it('a snapshot: the four sections in order, with their anchors, and the updated age', () => {
    const app = mount({ snapshot: FULL })
    expect(['attention', 'active', 'runners', 'recent'].map((s) => byId(app, `fleet-dashboard-section-${s}`)[0]?.props.id)).toEqual([
      'fleet-dashboard-attention', 'fleet-dashboard-active', 'fleet-dashboard-runners', 'fleet-dashboard-recent',
    ])
    expect(app.textOf(byId(app, 'fleet-dashboard-updated')[0])).toBe('Updated 5s ago')
    expect(byId(app, 'fleet-dashboard-attention-item')[0].props['data-key']).toBe('job_silent:j1')
    expect(byId(app, 'fleet-dashboard-active-row')[0].props['data-job']).toBe('j1')
    expect(byId(app, 'fleet-dashboard-runner')[0].props['data-runner']).toBe('r1')
    expect(byId(app, 'fleet-dashboard-stale')).toHaveLength(0)
  })

  it('a stale snapshot stays on screen with the note', () => {
    const app = mount({ snapshot: FULL, staleSince: '09:07' })
    expect(app.textOf(byId(app, 'fleet-dashboard-stale')[0])).toBe('Could not refresh. Showing data from 09:07.')
    expect(byId(app, 'fleet-dashboard-attention-item')).toHaveLength(1)
  })
})
```

- [ ] **Step 3: Run both tests to verify they fail**

Run: `cd apps/web && bun run test -- tests/components/fleet-dashboard-runners.spec.ts tests/components/fleet-dashboard-overview.spec.ts`
Expected: FAIL (cannot read `RunnerHealthList.vue` / `Overview.vue`).

- [ ] **Step 4: Write the components**

Create `apps/web/components/fleet/dashboard/CredentialDigestChips.vue`:

```vue
<script setup lang="ts">
import { computed } from 'vue'
import type { ChipTone } from '~/lib/fleet-capabilities'
import { digestChips, renderText } from '~/lib/fleet-dashboard'
import type { DashboardCredential } from '~/lib/fleet-dashboard-types'

/** D424: admin-only credential chips from the dashboard digest (raw capabilities never reach this page). */
const props = defineProps<{ credentials: readonly DashboardCredential[] }>()
const { t, te } = useI18n()

const chips = computed(() =>
  digestChips(props.credentials).map((chip) => ({
    id: chip.id,
    tone: chip.tone,
    text: renderText(chip.text, (key, named) => t(key, named ?? {}), te),
  })))

function variantOf(tone: ChipTone): 'secondary' | 'outline' | 'destructive' {
  if (tone === 'bad') return 'destructive'
  return tone === 'warn' ? 'outline' : 'secondary'
}
</script>

<template>
  <div v-if="chips.length > 0" class="flex flex-wrap gap-1" data-testid="fleet-dashboard-credentials">
    <Badge v-for="chip in chips" :key="chip.id" :variant="variantOf(chip.tone)" data-testid="fleet-dashboard-credential" :data-tone="chip.tone">
      {{ chip.text }}
    </Badge>
  </div>
</template>
```

Create `apps/web/components/fleet/dashboard/RunnerHealthList.vue`:

```vue
<script setup lang="ts">
import type { DashboardRunner, ScopeKind } from '~/lib/fleet-dashboard-types'

/** Spec §4.2, B5: every runner; versions and credentials only in the admin scope. */
defineProps<{ runners: readonly DashboardRunner[]; now: Date; scope: ScopeKind }>()
const { t } = useI18n()
</script>

<template>
  <EmptyState v-if="runners.length === 0" :message="t('fleet.dashboard.runners.empty')" />
  <ul v-else class="divide-y divide-border rounded-md border border-border" data-testid="fleet-dashboard-runners-list">
    <li
      v-for="runner in runners"
      :key="runner.id"
      class="flex flex-wrap items-center gap-x-4 gap-y-2 p-3"
      data-testid="fleet-dashboard-runner"
      :data-runner="runner.id"
      :data-online="runner.online ? 'true' : 'false'"
    >
      <div class="flex min-w-0 items-center gap-2">
        <span class="h-2.5 w-2.5 shrink-0 rounded-full" :class="runner.online ? 'bg-status-done' : 'bg-status-todo'" aria-hidden="true" />
        <span class="break-all font-medium">{{ runner.name }}</span>
        <span class="text-xs text-muted-foreground">{{ runner.os }}/{{ runner.arch }}</span>
      </div>
      <Badge :variant="runner.online ? 'secondary' : 'outline'">
        {{ runner.online ? t('fleet.common.online') : t('fleet.common.offline') }}
      </Badge>
      <Badge v-if="!runner.enabled" variant="destructive">{{ t('fleet.common.disabled') }}</Badge>
      <span class="text-sm" data-testid="fleet-dashboard-runner-busy">
        {{ t('fleet.dashboard.runners.busy', { active: runner.activeJobs, capacity: runner.capacity }) }}
      </span>
      <span class="text-xs text-muted-foreground">
        {{ t('fleet.dashboard.runners.lastSeen') }} <FleetAge :iso="runner.lastSeenAt" :now="now" mode="ago" />
      </span>
      <template v-if="scope === 'global'">
        <span class="text-xs text-muted-foreground" data-testid="fleet-dashboard-runner-versions">
          {{ runner.naxVersion ? t('fleet.dashboard.runners.nax', { version: runner.naxVersion }) : t('fleet.dashboard.runners.naxUnknown') }}<template v-if="runner.daemonVersion"> · {{ t('fleet.dashboard.runners.daemon', { version: runner.daemonVersion }) }}</template>
        </span>
        <FleetDashboardCredentialDigestChips :credentials="runner.credentials" />
      </template>
    </li>
  </ul>
</template>
```

Create `apps/web/components/fleet/dashboard/Overview.vue`:

```vue
<script setup lang="ts">
import { computed } from 'vue'
import { SECTION_IDS, dashboardTiles } from '~/lib/fleet-dashboard'
import type { FleetDashboard, ScopeKind } from '~/lib/fleet-dashboard-types'

/**
 * Fleet S2b (c) spec §4 (B1, D422): one layout for both scopes. Loading, the first-load error, the stale note and
 * the four sections; the page owns the data (useFleetDashboard) and the 403 text.
 */
const props = defineProps<{
  snapshot: FleetDashboard | null
  failed: boolean
  staleSince: string | null
  now: Date
  scope: ScopeKind
  analyticsTo: string
}>()
const emit = defineEmits<{ retry: [] }>()
const { t } = useI18n()

const tiles = computed(() => (props.snapshot ? dashboardTiles(props.snapshot.counts) : []))
</script>

<template>
  <div class="space-y-6" data-testid="fleet-dashboard">
    <div v-if="snapshot === null && failed" data-testid="fleet-dashboard-error">
      <ErrorState @retry="emit('retry')" />
    </div>
    <LoadingState v-else-if="snapshot === null" />
    <template v-else>
      <p class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span data-testid="fleet-dashboard-updated">{{ t('fleet.dashboard.updated') }} <FleetAge :iso="snapshot.generatedAt" :now="now" mode="ago" /></span>
        <span v-if="staleSince" role="status" class="text-status-review" data-testid="fleet-dashboard-stale">
          {{ t('fleet.dashboard.staleSince', { time: staleSince }) }}
        </span>
      </p>

      <FleetDashboardTiles :tiles="tiles" />

      <section :id="SECTION_IDS.attention" class="scroll-mt-20 space-y-3" data-testid="fleet-dashboard-section-attention">
        <h2 class="text-sm font-semibold">{{ t('fleet.dashboard.sections.attention') }}</h2>
        <FleetDashboardAttentionList :items="snapshot.attention" :generated-at="snapshot.generatedAt" :now="now" :scope="scope" />
      </section>

      <section :id="SECTION_IDS.active" class="scroll-mt-20 space-y-3" data-testid="fleet-dashboard-section-active">
        <h2 class="text-sm font-semibold">{{ t('fleet.dashboard.sections.active') }}</h2>
        <FleetDashboardActiveRunsTable :jobs="snapshot.activeJobs" :now="now" :scope="scope" :truncated="snapshot.activeTruncated" />
      </section>

      <section :id="SECTION_IDS.runners" class="scroll-mt-20 space-y-3" data-testid="fleet-dashboard-section-runners">
        <h2 class="text-sm font-semibold">{{ t('fleet.dashboard.sections.runners') }}</h2>
        <FleetDashboardRunnerHealthList :runners="snapshot.runners" :now="now" :scope="scope" />
      </section>

      <section :id="SECTION_IDS.recent" class="scroll-mt-20 space-y-3" data-testid="fleet-dashboard-section-recent">
        <h2 class="text-sm font-semibold">{{ t('fleet.dashboard.sections.recent') }}</h2>
        <FleetDashboardRecentRunsList
          :jobs="snapshot.recentJobs"
          :now="now"
          :scope="scope"
          :truncated="snapshot.recentTruncated"
          :analytics-to="analyticsTo"
        />
      </section>
    </template>
  </div>
</template>
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/web && bun run test -- tests/components/fleet-dashboard-runners.spec.ts tests/components/fleet-dashboard-overview.spec.ts tests/components/fleet-dashboard-attention.spec.ts tests/components/fleet-dashboard-tables.spec.ts`
Expected: PASS. The v-html guard in the attention spec now also covers the three new files.

- [ ] **Step 6: Lint the new files**

Run: `cd apps/web && bunx eslint components/fleet/dashboard lib/fleet-dashboard.ts lib/fleet-dashboard-types.ts composables/useFleetDashboard.ts tests/components/fleet-dashboard-*.spec.ts tests/lib/fleet-dashboard*.spec.ts tests/composables/useFleetDashboard.spec.ts --max-warnings=0`
Expected: no output. The `_ageStub` destructuring follows the existing `_nativeSelectStub` pattern in
`tests/pages/fleet-analytics-page.spec.ts`; if lint flags it, use the same disable comment that file uses.

- [ ] **Step 7: Commit**

```bash
git add apps/web/components/fleet/dashboard/CredentialDigestChips.vue apps/web/components/fleet/dashboard/RunnerHealthList.vue apps/web/components/fleet/dashboard/Overview.vue apps/web/tests/components/fleet-dashboard-runners.spec.ts apps/web/tests/components/fleet-dashboard-overview.spec.ts
git commit -m "feat(web): fleet dashboard runner health, credential chips and overview (S2b (c) slice 2, D422, D424)"
```

---
### Task 7: The admin and project overview pages

**Files:**
- Create: `apps/web/pages/admin/fleet/index.vue`
- Create: `apps/web/pages/[project]/fleet/overview.vue`
- Test: `apps/web/tests/pages/fleet-dashboard-pages.spec.ts`

**Interfaces:**
- Consumes: Task 3 (`useFleetDashboard` -> `{data, forbidden, failed, staleSince, now, refresh, start, stop}`),
  Task 6 (`FleetDashboardOverview`), `PageHeader` (props `title`, `subtitle`), `useRoute` (`params.project`).
- Produces: routes `/admin/fleet` and `/<project>/fleet/overview`; test id `fleet-dashboard-forbidden`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/tests/pages/fleet-dashboard-pages.spec.ts`:

```ts
import { describe, expect, jest, test } from '@jest/globals'
import * as Vue from 'vue'
import { computed, ref, watch } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import type { FleetComponentName } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'
import * as apiModule from '../../composables/useApi'
import { ApiError } from '../../composables/useApi'
import type { FleetDashboard } from '~/lib/fleet-dashboard-types'

const adminPage = webFile('pages', 'admin', 'fleet', 'index.vue')
const projectPage = webFile('pages', '[project]', 'fleet', 'overview.vue')
const REAL: FleetComponentName[] = [
  'FleetAge', 'FleetDashboardOverview', 'FleetDashboardTiles', 'FleetDashboardAttentionList', 'FleetDashboardActiveRunsTable',
  'FleetDashboardRecentRunsList', 'FleetDashboardRunnerHealthList', 'FleetDashboardCredentialDigestChips',
]
const { FleetAge: _ageStub, ...stubs } = uiStubs

const runnerItem = {
  key: 'runner_unhealthy:r1', kind: 'runner_unhealthy', severity: 'warning', subjectType: 'runner' as const, subjectId: 'r1',
  subjectName: 'wk-mac', projectSlug: null, since: null, conditions: [{ type: 'configuration' }],
}

const snapshot = (scope: 'global' | 'project'): FleetDashboard => ({
  generatedAt: new Date().toISOString(),
  counts: { runnersOnline: 1, runnersTotal: 1, queued: 0, running: 0, attention: 1 },
  runners: [{
    id: 'r1', name: 'wk-mac', os: 'darwin', arch: 'arm64', labels: [], enabled: true, online: true, lastSeenAt: new Date().toISOString(),
    capacity: 2, activeJobs: 0,
    naxVersion: scope === 'global' ? '0.83.3' : null,
    daemonVersion: scope === 'global' ? '0.1.0' : null,
    credentials: scope === 'global' ? [{ providerId: 'deepseek', available: true, kind: 'api-key', expiresAt: null, expired: false }] : [],
  }],
  activeJobs: [], activeTruncated: false, recentJobs: [], recentTruncated: false,
  attention: [runnerItem],
})

/** The page's composable gets this instead of the browser poller: tasks by interval, and start/stop calls. */
function fakePolling() {
  const tasks = new Map<number, () => Promise<void>>()
  const started: number[] = []
  const stopped: number[] = []
  const module = {
    useVisiblePolling: (task: () => Promise<void>, ms: number) => {
      tasks.set(ms, task)
      return { start: () => { started.push(ms) }, stop: () => { stopped.push(ms) }, runNow: () => task(), isActive: () => true }
    },
  }
  return { module, started, stopped, poll: async (): Promise<void> => { await tasks.get(10_000)?.() } }
}

type Get = jest.Mock<(path: string) => Promise<unknown>>

function mountPage(file: string, get: Get) {
  const polling = fakePolling()
  const app = mountSfc(file, {
    components: stubs,
    fleetComponents: REAL,
    alias: { '~/composables/useApi': apiModule, '~/composables/useVisiblePolling': polling.module },
    globals: {
      ref, computed, watch, onMounted: Vue.onMounted, onBeforeUnmount: Vue.onBeforeUnmount,
      useI18n: () => enI18n(),
      useApi: () => ({ $api: { get } }),
      useRoute: () => ({ params: { project: 'koda' } }),
      definePageMeta: () => undefined,
    },
  })
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 6; i += 1) {
      await new Promise((resolve) => { setImmediate(resolve) })
      await Vue.nextTick()
    }
  }
  const byId = (id: string) => app.find(`[data-testid="${id}"]`)
  return { app, polling, settle, byId }
}

describe('admin fleet overview page (spec §4.1)', () => {
  test('loads the admin snapshot on mount, polls every 10 s with a 1 s clock, and stops on unmount', async () => {
    const get: Get = jest.fn(async () => snapshot('global'))
    const p = mountPage(adminPage, get)
    await p.settle()
    expect(get.mock.calls.map(([path]) => path)).toEqual(['/fleet/dashboard'])
    expect([...p.polling.started].sort((a, b) => a - b)).toEqual([1_000, 10_000])
    expect(p.app.find('[data-stub="page-header"]')[0].props.title).toBe('Fleet overview')
    expect(p.byId('fleet-dashboard-attention-link').map((n) => n.props.to)).toEqual(['/admin/fleet/runners'])
    expect(p.byId('fleet-dashboard-credential')).toHaveLength(1)
    expect(p.byId('fleet-dashboard-analytics-link')[0].props.to).toBe('/admin/fleet/analytics')
    p.app.unmount()
    expect([...p.polling.stopped].sort((a, b) => a - b)).toEqual([1_000, 10_000])
  })

  test.each([40003, 403])('a 403 (%s) shows the admin-only note, no overview, and stops polling', async (code) => {
    const p = mountPage(adminPage, jest.fn(async () => { throw new ApiError(code, 'forbidden') }) as Get)
    await p.settle()
    expect(p.app.textOf(p.byId('fleet-dashboard-forbidden')[0])).toBe('Only global administrators can manage the fleet.')
    expect(p.byId('fleet-dashboard')).toHaveLength(0)
    expect([...p.polling.stopped].sort((a, b) => a - b)).toEqual([1_000, 10_000])
  })

  test('a failed poll keeps the snapshot with the stale note; the next success clears it (Review Focus 3)', async () => {
    const get = jest.fn<(path: string) => Promise<unknown>>()
      .mockResolvedValueOnce(snapshot('global'))
      .mockRejectedValueOnce(new ApiError(50000, 'bad gateway'))
      .mockResolvedValueOnce(snapshot('global'))
    const p = mountPage(adminPage, get)
    await p.settle()

    await p.polling.poll()
    await p.settle()
    expect(p.app.textOf(p.byId('fleet-dashboard-stale')[0])).toMatch(/^Could not refresh\. Showing data from \d\d:\d\d\.$/)
    expect(p.byId('fleet-dashboard-attention-item')).toHaveLength(1)

    await p.polling.poll()
    await p.settle()
    expect(p.byId('fleet-dashboard-stale')).toHaveLength(0)
  })

  test('the first load failing shows the error state; Retry asks again', async () => {
    const get = jest.fn<(path: string) => Promise<unknown>>()
      .mockRejectedValueOnce(new Error('API down'))
      .mockResolvedValueOnce(snapshot('global'))
    const p = mountPage(adminPage, get)
    await p.settle()
    expect(p.byId('fleet-dashboard-error')).toHaveLength(1)

    ;(p.app.find('[data-stub="error-state"]')[0].props.onRetry as () => void)()
    await p.settle()
    expect(get).toHaveBeenCalledTimes(2)
    expect(p.byId('fleet-dashboard-tiles')).toHaveLength(1)
  })
})

describe('project fleet overview page (spec §4.1, B5)', () => {
  test('loads the project snapshot; runner items are plain text and no credential chip shows', async () => {
    const get: Get = jest.fn(async () => snapshot('project'))
    const p = mountPage(projectPage, get)
    await p.settle()
    expect(get.mock.calls.map(([path]) => path)).toEqual(['/projects/koda/fleet/dashboard'])
    expect(p.byId('fleet-dashboard-attention-item')).toHaveLength(1)
    expect(p.byId('fleet-dashboard-attention-link')).toHaveLength(0)
    expect(p.byId('fleet-dashboard-credentials')).toHaveLength(0)
    expect(p.byId('fleet-dashboard-runner-versions')).toHaveLength(0)
    expect(p.byId('fleet-dashboard-analytics-link')[0].props.to).toBe('/koda/fleet/analytics')
  })

  test('a 403 shows the no-access text and stops polling', async () => {
    const p = mountPage(projectPage, jest.fn(async () => { throw new ApiError(40003, 'forbidden') }) as Get)
    await p.settle()
    expect(p.app.textOf(p.byId('fleet-dashboard-forbidden')[0])).toBe('You do not have access to this project.')
    expect(p.polling.stopped).toContain(10_000)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && bun run test -- tests/pages/fleet-dashboard-pages.spec.ts`
Expected: FAIL (cannot read `pages/admin/fleet/index.vue`).

- [ ] **Step 3: Write the pages**

Create `apps/web/pages/admin/fleet/index.vue`:

```vue
<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue'
import { useFleetDashboard } from '~/composables/useFleetDashboard'

definePageMeta({ layout: 'default' })

/** Fleet S2b (c) spec §4.1: every runner and the active jobs of every project (global admin; others see the 403 note). */
const { t } = useI18n()
const { data, forbidden, failed, staleSince, now, refresh, start, stop } = useFleetDashboard({ kind: 'global' })

onMounted(start)
onBeforeUnmount(stop)
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('fleet.dashboard.title')" :subtitle="t('fleet.dashboard.adminSubtitle')" />
    <p v-if="forbidden" class="text-sm text-muted-foreground" data-testid="fleet-dashboard-forbidden">{{ t('fleet.common.adminOnly') }}</p>
    <FleetDashboardOverview
      v-else
      :snapshot="data"
      :failed="failed"
      :stale-since="staleSince"
      :now="now"
      scope="global"
      analytics-to="/admin/fleet/analytics"
      @retry="refresh()"
    />
  </div>
</template>
```

Create `apps/web/pages/[project]/fleet/overview.vue`:

```vue
<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue'
import { useFleetDashboard } from '~/composables/useFleetDashboard'

definePageMeta({ layout: 'default' })

/** Fleet S2b (c) spec §4.1 (B1, B5): this project's jobs and the health of every runner (project members). */
const route = useRoute()
const { t } = useI18n()
const slug = route.params.project as string
const { data, forbidden, failed, staleSince, now, refresh, start, stop } = useFleetDashboard({ kind: 'project', slug })

onMounted(start)
onBeforeUnmount(stop)
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('fleet.dashboard.title')" :subtitle="t('fleet.dashboard.projectSubtitle')" />
    <p v-if="forbidden" class="text-sm text-muted-foreground" data-testid="fleet-dashboard-forbidden">{{ t('fleet.dashboard.forbidden') }}</p>
    <FleetDashboardOverview
      v-else
      :snapshot="data"
      :failed="failed"
      :stale-since="staleSince"
      :now="now"
      scope="project"
      :analytics-to="`/${slug}/fleet/analytics`"
      @retry="refresh()"
    />
  </div>
</template>
```

`start` and `stop` take no arguments, so passing them straight to `onMounted` / `onBeforeUnmount` is safe.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && bun run test -- tests/pages/fleet-dashboard-pages.spec.ts`
Expected: PASS. If the 403 test shows the generic error state instead, `isForbidden` saw a second copy of `ApiError`:
the spec must alias `'~/composables/useApi'` to the module it throws from (as shown), which also reaches the
composable's `useFleetBudgetPage` import.

- [ ] **Step 5: Commit**

```bash
git add apps/web/pages/admin/fleet/index.vue "apps/web/pages/[project]/fleet/overview.vue" apps/web/tests/pages/fleet-dashboard-pages.spec.ts
git commit -m "feat(web): admin and project fleet overview pages (S2b (c) slice 2, spec §4.1, D420)"
```

---

### Task 8: Navigation, breadcrumb and command palette

**Files:**
- Modify: `apps/web/layouts/default.vue` (lucide import line 2, `fleetLeaf` ~line 39-45, admin links ~line 153, project fleet links ~line 213)
- Modify: `apps/web/components/CommandPalette.vue` (import line 2, project commands ~line 39)
- Modify: `apps/web/tests/layouts/default-fleet-nav.spec.ts`, `apps/web/tests/layouts/fleet-jobs-nav.spec.ts`
- Modify: `docs/ux/redesign/MASTER-PLAN.md` (§10 Decisions log)

**Interfaces:**
- Consumes: `nav.fleetOverview`, `fleet.dashboard.title` (Task 2); routes from Task 7.
- Produces: nothing new for later tasks (the E2E navigates by URL).

- [ ] **Step 1: Write the failing layout assertions**

In `apps/web/tests/layouts/default-fleet-nav.spec.ts`, inside the first test
(`'a global admin sees Runners, Repos and Budgets links with their nav labels'`), add before its closing `})`:

```ts
    expect(html.match(/<a href="\/admin\/fleet"[^>]*>[\s\S]*?<\/a>/)?.[0]).toContain('nav.fleetOverview')
    // D425: the overview is the first admin fleet link.
    expect(html.indexOf('href="/admin/fleet"')).toBeLessThan(html.indexOf('href="/admin/fleet/runners"'))
```

and in the icon test change the expected list to:

```ts
    expect(layoutIconNames(layoutSource)).toEqual(expect.arrayContaining(['Server', 'FolderGit2', 'Wallet', 'Inbox', 'Gauge']))
```

In `apps/web/tests/layouts/fleet-jobs-nav.spec.ts`, add at the end of the `describe` block:

```ts
  test('a project link to /:project/fleet/overview with Gauge above Fleet jobs, and its breadcrumb leaf (S2b (c) D425)', () => {
    expect(projectLinks).toContain(':to="`/${projectSlug}/fleet/overview`"')
    expect(projectLinks).toMatch(/<Gauge class="h-4 w-4 shrink-0" \/>\s*\{\{ t\('nav\.fleetOverview'\) \}\}/)
    expect(projectLinks.indexOf('/fleet/overview`')).toBeLessThan(projectLinks.indexOf(':to="`/${projectSlug}/fleet`"'))
    expect(layout).toContain("if (path === `/${project}/fleet/overview`) return t('fleet.dashboard.title')")
  })
```

- [ ] **Step 2: Run the layout tests to verify they fail**

Run: `cd apps/web && bun run test -- tests/layouts/default-fleet-nav.spec.ts tests/layouts/fleet-jobs-nav.spec.ts`
Expected: FAIL on the new assertions only (no `/admin/fleet` link, no `Gauge`).

- [ ] **Step 3: Edit the layout**

In `apps/web/layouts/default.vue`:

1. Add `Gauge` to the lucide import on line 2 (after `BarChart3`):

```ts
import { LayoutDashboard, Kanban, Bot, Tag, BookOpen, Clock, Brain, Code2, Activity, Users, Server, FolderGit2, Rocket, Wallet, Inbox, BarChart3, Gauge, Settings, Search, Menu } from 'lucide-vue-next'
```

2. In `fleetLeaf`, add the overview case as the first line of the function body and update its doc comment:

```ts
/** The last crumb under `/:project/fleet/*`: overview, dispatch, budgets, approvals, analytics, or (anything else) a job. */
function fleetLeaf(project: string, path: string): string {
  if (path === `/${project}/fleet/overview`) return t('fleet.dashboard.title')
  if (path === `/${project}/fleet/dispatch`) return t('fleet.jobs.dispatch')
```

(the remaining lines of the function stay as they are).

3. Insert the admin link directly **before** the `/admin/fleet/runners` link:

```vue
        <NuxtLink v-if="isGlobalAdmin" to="/admin/fleet" :class="navLinkClass" :active-class="activeClass"><Gauge class="h-4 w-4 shrink-0" />{{ t('nav.fleetOverview') }}</NuxtLink>

```

4. In the project block, directly after `<p :class="sectionLabelClass">{{ t('nav.sectionFleet') }}</p>` and before the
`/${projectSlug}/fleet` link, insert:

```vue
            <NuxtLink
              :to="`/${projectSlug}/fleet/overview`"
              :class="navLinkClass"
              :active-class="activeClass"
            >
              <Gauge class="h-4 w-4 shrink-0" />
              {{ t('nav.fleetOverview') }}
            </NuxtLink>
```

`pages/admin/fleet/index.vue` and `pages/admin/fleet/runners.vue` are sibling routes (there is no
`pages/admin/fleet.vue` parent), so the overview link is not marked active on the Runners page; the same holds for
`/fleet/overview` and `/fleet`.

- [ ] **Step 4: Add the command palette entry**

In `apps/web/components/CommandPalette.vue`, add `Gauge` to the lucide import on line 2 (after `Rocket`), and in the
project `list.push(...)` insert before the `id: 'fleet'` entry:

```ts
      { id: 'fleet-overview', label: t('nav.fleetOverview'), hint, icon: Gauge, run: go(`/${slug}/fleet/overview`) },
```

- [ ] **Step 5: Log the navigation change in the UX master plan**

In `docs/ux/redesign/MASTER-PLAN.md` §10 Decisions log, append a row at the end of the table:

```markdown
| 2026-10-05 | Fleet overview links: `/admin/fleet` first in the admin fleet group, `/<project>/fleet/overview` above Fleet jobs (icon `Gauge`, label `nav.fleetOverview`), plus a command palette entry | Fleet S2b (c) dashboard (spec `docs/superpowers/specs/2026-10-05-fleet-s2b-c-dashboard-design.md` §4.1); slice 4 (fleet pages) restyles it with the rest |
```

- [ ] **Step 6: Run the layout tests and the nav-related specs**

Run: `cd apps/web && bun run test -- tests/layouts tests/i18n`
Expected: PASS (all layout specs, not only the two edited: `default.spec.ts` and `default-sidebar.spec.ts` render the
same template).

- [ ] **Step 7: Commit**

```bash
git add apps/web/layouts/default.vue apps/web/components/CommandPalette.vue apps/web/tests/layouts/default-fleet-nav.spec.ts apps/web/tests/layouts/fleet-jobs-nav.spec.ts docs/ux/redesign/MASTER-PLAN.md
git commit -m "feat(web): fleet overview navigation, breadcrumb and palette entry (S2b (c) slice 2, D425)"
```

---

### Task 9: E2E — a silent job and an unplaceable job from a scripted runner

**Files:**
- Modify: `apps/web/playwright.config.ts` (API `env`)
- Create: `apps/web/tests/e2e/fleet-dashboard.e2e.spec.ts`

**Interfaces:**
- Consumes: `ScriptedRunner` (`enroll`, `heartbeat`, `acceptAssign`, `report`, `id`), `Lease`
  (`tests/e2e/fixtures/scripted-runner.ts`); `call`, `dispatchRun`, `repoIdOf` (`fixtures/fleet-budgets-api.ts`);
  `login`, `createProject`, `deleteProject`, `E2E_ADMIN` (`fixtures/api-client.ts`); `generateUniqueProjectKey`,
  `waitForHydration`, `webLogin` (`fixtures/page-helpers.ts`); the seeded project `fleet-e2e` with repo `acme/e2e-app`;
  test ids from Tasks 4-7.
- Produces: nothing for later tasks.

- [ ] **Step 1: Let the dry-run report a queued job within the test**

In `apps/web/playwright.config.ts`, in the API `webServer` `env` block, after `FLEET_SWEEP_ENABLED: 'true',` add:

```ts
        // S2b (c) D426: the dashboard reports a queued job no runner fits after 10 s (the env schema minimum) instead
        // of 60 s. Only the dashboard reads this threshold.
        FLEET_JOB_QUEUED_WARN_SEC: '10',
```

- [ ] **Step 2: Write the E2E spec**

Create `apps/web/tests/e2e/fleet-dashboard.e2e.spec.ts`:

```ts
import { test, expect } from '@playwright/test';
import { createProject, deleteProject, login, E2E_ADMIN } from './fixtures/api-client';
import { call, dispatchRun, repoIdOf } from './fixtures/fleet-budgets-api';
import { generateUniqueProjectKey, waitForHydration, webLogin } from './fixtures/page-helpers';
import { ScriptedRunner } from './fixtures/scripted-runner';
import type { Lease } from './fixtures/scripted-runner';

/**
 * Fleet S2b (c) slice 2 (spec §5 E2E, D426): a scripted runner keeps syncing (stays online) while it holds a RUNNING
 * job whose nax heartbeat is 15 minutes old, and a second job waits QUEUED with a selector label no runner has. The
 * admin overview shows both attention items; the project overview of a fresh project shows neither job. Every
 * assertion keys on this run's job ids, so other specs' data and retries cannot change it.
 * API polls stay at one request per 2 s (the global throttle is 100 a minute; /fleet/runner/* is exempt).
 */
const SLUG = 'fleet-e2e';
const POLL = { intervals: [2_000] };

interface Snapshot {
  attention: Array<{ key: string; severity: string }>;
}

test.describe('Fleet dashboard (scripted runner)', () => {
  let token = '';
  let runner: ScriptedRunner;
  let repoId = '';
  const suffix = Date.now().toString().slice(-6);
  const otherSlug = `dash-other-${suffix}`;
  const silentFeature = `dash-silent-${suffix}`;
  const queuedFeature = `dash-queued-${suffix}`;

  test.beforeAll(async () => {
    token = (await login(E2E_ADMIN.email, E2E_ADMIN.password)).token;
    runner = await ScriptedRunner.enroll(token, `e2e-dashboard-runner-${suffix}`);
    repoId = await repoIdOf(token, SLUG, 'acme/e2e-app');
    await createProject(token, { name: `Dashboard other ${suffix}`, slug: otherSlug, key: generateUniqueProjectKey('DO') });
  });

  test.afterAll(async () => {
    await deleteProject(token, otherSlug).catch(() => undefined);
  });

  test('a silent running job and an unplaceable queued job show on the admin overview, and not on another project', async ({ page }) => {
    test.setTimeout(120_000);
    await runner.heartbeat();
    const silentId = await dispatchRun(token, SLUG, { repoId, feature: silentFeature, maxCostUsd: 3, pinnedRunnerId: runner.id });
    const lease: Lease = await runner.acceptAssign(silentId);
    await runner.report(lease, [
      { type: 'state', payload: { to: 'RUNNING' } },
      {
        type: 'snapshot',
        payload: { heartbeatAt: new Date(Date.now() - 15 * 60_000).toISOString(), currentStoryId: 'US-001', currentPhase: 'run' },
      },
    ]);
    const queued = await call<{ job: { id: string } }>('POST', `/projects/${SLUG}/fleet/jobs`, token, {
      command: 'RUN', repoId, feature: queuedFeature, maxCostUsd: 1, selectorLabels: ['e2e-dashboard-nowhere'],
    });
    const queuedId = queued.job.id;
    // D426: an offline runner's jobs are reported on the runner item instead, so keep this runner syncing.
    const keepAlive = setInterval(() => { void runner.heartbeat().catch(() => undefined); }, 5_000);

    try {
      const ours = (snap: Snapshot): string[] =>
        snap.attention.map((a) => a.key).filter((k) => k.endsWith(`:${silentId}`) || k.endsWith(`:${queuedId}`)).sort();
      await expect.poll(async () => ours(await call<Snapshot>('GET', '/fleet/dashboard', token)), { timeout: 45_000, ...POLL })
        .toEqual([`job_silent:${silentId}`, `job_unplaceable:${queuedId}`].sort());

      await webLogin(page);
      await page.goto('/admin/fleet');
      await waitForHydration(page);
      const silent = page.locator(`[data-testid="fleet-dashboard-attention-item"][data-key="job_silent:${silentId}"]`);
      await expect(silent).toHaveAttribute('data-severity', 'error', { timeout: 15_000 });
      await expect(silent).toContainText(silentFeature);
      await expect(silent).toContainText('No heartbeat for');
      await expect(page.locator(`[data-testid="fleet-dashboard-attention-item"][data-key="job_unplaceable:${queuedId}"]`)).toContainText(queuedFeature);
      await expect(page.locator(`[data-testid="fleet-dashboard-active-row"][data-job="${silentId}"]`)).toContainText('US-001');
      await expect(page.locator(`[data-testid="fleet-dashboard-runner"][data-runner="${runner.id}"]`)).toHaveAttribute('data-online', 'true');

      await page.goto(`/${SLUG}/fleet/overview`);
      await waitForHydration(page);
      await expect(page.locator(`[data-testid="fleet-dashboard-attention-item"][data-key="job_silent:${silentId}"]`)).toBeVisible({ timeout: 15_000 });

      await page.goto(`/${otherSlug}/fleet/overview`);
      await waitForHydration(page);
      await expect(page.getByTestId('fleet-dashboard-tiles')).toBeVisible({ timeout: 15_000 });
      const html = await page.getByTestId('fleet-dashboard').innerHTML();
      for (const leak of [silentId, queuedId, silentFeature, queuedFeature]) expect(html).not.toContain(leak);
    } finally {
      clearInterval(keepAlive);
      await call('POST', `/projects/${SLUG}/fleet/jobs/${queuedId}/cancel`, token).catch(() => undefined);
      await runner.report(lease, [
        { type: 'state', payload: { to: 'UPLOADING' } },
        { type: 'state', payload: { to: 'COMPLETED', exitCode: 0 } },
      ]).catch(() => undefined);
    }
  });
});
```

- [ ] **Step 3: Type-check and lint the spec**

Run: `cd apps/web && bunx eslint tests/e2e/fleet-dashboard.e2e.spec.ts playwright.config.ts --max-warnings=0 && bunx playwright test tests/e2e/fleet-dashboard.e2e.spec.ts --list`
Expected: lint clean; `--list` prints the one test (it loads the spec without running it).

- [ ] **Step 4: Run the E2E (ask the user for consent first)**

The run resets `koda_e2e`. **Stop and ask the user** for consent to the Prisma reset; then, with the test Postgres up:

```bash
cd apps/api && bun run test:db:up
cd ../web && PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION="<the user's exact consent message>" bunx playwright test tests/e2e/fleet-dashboard.e2e.spec.ts --reporter=line
```

Expected: `1 passed`. Then run the whole fleet suite once, because the new spec leaves a cancelled job and a completed
job behind and the config change applies to every spec:

```bash
PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION="<the user's exact consent message>" bunx playwright test tests/e2e/fleet-*.e2e.spec.ts --reporter=line
```

Expected: all pass. If `job_silent` never appears, check the snapshot event was accepted (the job page shows story
`US-001`) and that `keepAlive` runs (the runner row reads `data-online="true"`). If `job_unplaceable` never appears,
the job may have been placed (another runner with label `e2e-dashboard-nowhere`, impossible in the seed) or the
global oldest-50 QUEUED window is full of leftovers from other specs: look at the QUEUED jobs on the
`/fleet-e2e/fleet` page (or `GET /projects/fleet-e2e/fleet/jobs`) before changing the test.

- [ ] **Step 5: Commit**

```bash
git add apps/web/playwright.config.ts apps/web/tests/e2e/fleet-dashboard.e2e.spec.ts
git commit -m "test(e2e): fleet dashboard silent and unplaceable jobs from a scripted runner (S2b (c) slice 2, D426)"
```

---

### Task 10: Spec corrections, agent guidance, full verification and handoff

**Files:**
- Modify: `docs/superpowers/specs/2026-10-05-fleet-s2b-c-dashboard-design.md` (§4.1, §4.2)
- Modify: `.nax/mono/apps/web/context.md` (new section after "Fleet analytics (S2b)")
- Regenerate: the generated agent files (`nax generate`)

- [ ] **Step 1: Correct the spec (D421, D422)**

In the spec §4.1, replace the `composables/useFleetDashboard.ts(scope)` bullet with:

```markdown
- `composables/useFleetDashboard.ts(scope)` returns `{data, error, pending, forbidden, lastSuccessAt, now, failed,
  staleSince, refresh, start, stop}`; the page calls `start` in `onMounted` and `stop` in `onBeforeUnmount` (slice 2
  D421). `start` loads at once, polls every 10 s with `useVisiblePolling` and ticks a 1 s clock; it refetches on
  becoming visible.
```

In §4.2, change the heading line to:

```markdown
### 4.2 Components (`components/fleet/dashboard/`, presentational, props only)

File names drop the `Dashboard` prefix (slice 2 D422): `Tiles.vue`, `AttentionList.vue`, `ActiveRunsTable.vue`,
`RunnerHealthList.vue`, `RecentRunsList.vue`, `CredentialDigestChips.vue`, plus `Overview.vue`, which composes them
for both pages. Nuxt names them `FleetDashboard<File>`.
```

(keep the bullet list under it as is).

- [ ] **Step 2: Add the web agent guidance**

In `.nax/mono/apps/web/context.md`, after the "Fleet analytics (S2b)" section (it ends with the `assignSlots` bullet),
add:

```markdown
## Fleet overview (S2b (c))

- `/admin/fleet` (global admin) and `/:project/fleet/overview` (members) both render `FleetDashboardOverview` from
  `components/fleet/dashboard/`; data comes from `useFleetDashboard(scope)` (10 s poll while visible, 1 s clock, a
  failed poll keeps the last snapshot, a 403 stops polling). No SSE.
- The API sends attention items as structured fields, never prose: word them in `lib/fleet-dashboard.ts`
  (`attentionMessage` -> i18n keys + params, `renderText`). A new API enum value needs its key under
  `fleet.dashboard` and its pin in `tests/i18n/fleet-locale-parity.spec.ts`.
- Ages are measured on the server clock (`serverNow`: `generatedAt` + client time since arrival), never by comparing
  the browser clock with server time.
- The project scope never shows credential chips, versions or runner links (B5); the API already nulls them.
```

- [ ] **Step 3: Regenerate every agent file**

Run from the repo root: `nax generate && nax generate --all-packages`
Expected: `CLAUDE.md`/`AGENTS.md`/`GEMINI.md`/`codex.md` under `apps/web` change; root files unchanged or
metadata-only. Never hand-edit them and never regenerate a single `--package` only. If `nax generate` also writes
`.cursorrules`, `.windsurfrules` or `.aider.conf.yml`, commit those too.

- [ ] **Step 4: Full verification**

Run from the repo root:

```bash
bun run lint
bun run type-check
bun run test
cd apps/web && bun run build
```

Expected: everything PASS (`bun run test` covers the web Jest suite, the API unit specs and the CLI specs; no API
or CLI file changed, so their counts match main). Record the web test counts and the E2E result from Task 9 for the
PR body. Do not mark this done on a red run; fix and re-run.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-10-05-fleet-s2b-c-dashboard-design.md .nax/mono/apps/web/context.md apps/web/CLAUDE.md apps/web/AGENTS.md apps/web/GEMINI.md apps/web/codex.md
git commit -m "docs(fleet): S2b (c) slice 2 spec corrections (D421, D422) and web agent guidance"
```

Adjust the `git add` list to the files `git status` shows as changed by `nax generate`.

- [ ] **Step 6: Whole-branch review, then hand off (no push without approval)**

Request a whole-branch code review of `main..feat/fleet-s2b-dashboard-web` against the spec
(superpowers:requesting-code-review), including the Review Focus list at the top of this plan. Fix Critical and
Important findings, at most 2 fix rounds. Then report to the user: test counts, the E2E result, deferred minors, and
the proposed PR title `feat(fleet): S2b (c) slice 2 — fleet overview web pages and E2E (D415-D426)`. **Do not push or
open the PR until the user approves.** After merge, the deploy to koda-wk is a separate, user-approved step
(`~/koda-wk/scripts/build-images.sh <sha>` then `deploy.sh`); no migration ships in this slice.
