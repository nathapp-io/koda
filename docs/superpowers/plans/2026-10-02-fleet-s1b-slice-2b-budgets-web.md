# Fleet S1b Slice 2b — Budgets Web Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A global admin manages fleet-wide and runner budget policies on `/admin/fleet/budgets`; project members read
their project's policies on `/:project/fleet/budgets` (project ADMINs also create, edit, delete and resume them); and
every project fleet page shows a banner when a policy covering the project is paused or past its warn threshold. Web
only: the API, CLI and OpenAPI contract of slice 2a (PR #188) are used as merged.

**Architecture:** Two thin pages share one presentational stack: a pure library (`lib/fleet-budgets.ts`: decimal-safe
spend checks, form schemas and bodies, banner selection, scope labels), a transport composable
(`useFleetBudgets(base)`, `base` = admin or project route) and a page-state composable (`useFleetBudgetPage(base)`:
load, stale/forbidden handling, dialog state, delete). Three components (`FleetBudgetTable`, `FleetBudgetEditDialog`,
`FleetBudgetResumeDialog`) render a list and its two dialogs; `FleetBudgetBanner` is a self-loading alert placed on the
project's jobs list, dispatch and job pages. The server's `paused` and `warnReached` flags are the only source of
state; the client never recomputes them.

**Tech Stack:** Nuxt 3 + Vue 3 `<script setup>`, shadcn-vue primitives, `vee-validate` + `zod`, `useApi` (`$api`),
Jest with the `mountSfc` harness (unit/component), Playwright with the scripted runner (e2e), `vue-i18n` (en + zh).

**Spec:** `docs/superpowers/specs/2026-10-01-fleet-s1b-budgets-schedules-design.md` §2.4 (Web bullets), §4 (i18n, activity,
misfit labels), §5 (slice 2b); backend contract from `docs/superpowers/plans/2026-10-02-fleet-s1b-slice-2a-budgets-backend.md`
(D154-D172) and the merged code in `apps/api/src/fleet/budgets/`.

## Global Constraints

- Routes (2a D162): admin `/fleet/budgets` acts on **global and runner** policies; `/projects/:slug/fleet/budgets` acts on
  that project's **project and repo** policies and lists them plus the global ones, read-only. Another id answers 404
  `fleet.budgets`. `POST <prefix>/:id/resume { amountUsd? }`; resume of a policy that is not paused answers 409
  `fleet.budgetNotPaused`; an amount at or below the window spend answers 400 `fleet.budgetAmountNotAboveSpend`;
  a duplicate (scope, window) answers 409 `fleet.budgets`.
- Policy DTO (`BudgetPolicyDto`): `id, scopeType, scopeId, projectId, windowKind, amountUsd, warnPercent, hardStop,
  runningJobs, paused, pausedAt, windowStart, spentUsd, warnReached, updatedById, createdAt, updatedAt`. Money is a
  decimal **string**; `paused` is the *effective* pause (S1b §2.3); `warnReached` is spend >= amount * warnPercent / 100.
- Create/update bodies: `amountUsd` is a JSON number, > 0, at most 4 decimals, at most **1,000,000**; `warnPercent` is an
  integer **1-99**, `null` = no warn, omitted on create = 80; `hardStop` boolean; `runningJobs` `finish | cancel`;
  `windowKind` `calendar_month_utc | lifetime`; `scopeType` `global | project | repo | runner`. Scope and window are
  fixed after create (2a D161): `PATCH` takes only `amountUsd, warnPercent, hardStop, runningJobs`.
- Permissions (ruling B3): global and runner policies = global ADMIN; project and repo policies = project ADMIN or global
  ADMIN; project members read. The server is the gate; the web hides controls by `canManage` from
  `useProjectViewerRole` and shows the server's translated message on any refusal.
- Web conventions (`.nax/rules/web.md`): API calls only through composables with `useApi()`; `useAppToast()` +
  `extractApiError()` for errors; forms use `vee-validate` + `zod` with i18n messages; no hardcoded UI strings; semantic
  Tailwind tokens only (`text-muted-foreground`, `bg-muted`, `border-border`, `bg-destructive`); no raw `$fetch`.
- i18n: every key in both `apps/web/i18n/locales/en.json` and `zh.json`; no `|` or `@` in any `fleet.*` English or
  Chinese message (the parity spec rejects them); dynamic keys are listed in the enum table of
  `tests/i18n/fleet-locale-parity.spec.ts`.
- `FleetActivity` rows, webhooks and incidents already exist server-side (2a); this slice adds no API route, DTO,
  migration, i18n key under `apps/api`, or CLI command. `bun run generate` must leave `openapi.json` unchanged.
- Web tests: `cd apps/web && bun run test -- <path>` filters by path (jest). Never run bare `bun test` at the repo root.
  Lint is `cd apps/web && bun run lint` (`--max-warnings=0`); types `cd apps/web && bun run type-check`
  (`nuxt typecheck`); build `bunx turbo run build --filter=@nathapp/koda-web`.
- No emojis in source; no `console.log`; no `eslint-disable`; no hand edits under `*/generated/`; conventional commits;
  never push, never open a PR.
- Auto-imported composables and components: a new `components/fleet/BudgetTable.vue` is `FleetBudgetTable` in templates
  (directory prefix + file name). New composables are imported **explicitly** by the code that uses them
  (`import { useFleetBudgets } from '~/composables/useFleetBudgets'`) so the jest `mountSfc` harness resolves them
  without extending its auto-import list.

## Decisions

Numbered D173-D189 (slice 2a ended at D172; slice 3a uses D190+).

| # | Decision | Why |
|:--|:--|:--|
| D173 | **Web-only.** No API change was needed: the merged list rows already carry spend, window start, `paused`, `warnReached` and `pausedAt`, and the repo and runner lists the forms need exist (`/projects/:slug/fleet/repos`, `/fleet/runners`). `bun run generate` is run once as a no-diff check. | Spec §5 lists 2b as web. Verified against `budget-policy.dto.ts` and both controllers. |
| D174 | The admin page shows **only global and runner** policies, filtered client-side, although `GET /fleet/budgets` returns every policy (spec §2.4 "list of all policies"). | Mutations on that prefix answer 404 for project and repo policies (D162), so listing them there would show rows the admin cannot act on. Project and repo policies belong to their project page. |
| D175 | The project page renders two tables: the project's own (project and repo) policies, editable when `canManage`, and the fleet-wide (global) policies, always read-only with a hint that a global administrator sets them. Runner policies never appear there (the API does not return them). | Spec: "global policies read-only". A global admin sees the same page; to change a global policy they follow the hint to the admin page. |
| D176 | Edit rights on the project page = `viewer.canManage` (project ADMIN, or global ADMIN: the members endpoint reports `canManage` for both). Members see no buttons and one line saying who can change policies. A mutation the server still refuses (403 after a role change) shows the server's translated message. | Same rule as every other fleet page (`useProjectViewerRole`); the server stays authoritative. |
| D177 | One transport composable `useFleetBudgets(base)` builds the admin or project paths and owns the list; one page composable `useFleetBudgetPage(base)` owns load/stale/forbidden state, the create/edit/resume dialog state and delete. Both pages are thin templates over them. | `.nax/rules/web.md`: no duplicated page logic. The two pages differ only in route, names and live-refresh source. |
| D178 | Live refresh: the project page reloads on `fleet_job` notices (debounced 300 ms) and on resync, **plus a 30 s visible-tab poll**; the admin page polls every 15 s (as the Runners page does). The banner polls every 30 s and the jobs list nudges it on each notice. | `FleetJobLivePublisher` publishes only on job state transitions: a snapshot that raises spend, a warn, or a hard stop that cancels nothing emits no notice. Spec asks for "refreshed on `fleet_job` notices"; the poll is the backstop that makes the pause visible without a reload. |
| D179 | The banner is placed on the jobs list, the dispatch page and the job page, not on the budgets page (its table already shows each policy's state). It loads on its own, stays silent on a failed load (cosmetic), shows paused policies first, then warnings, at most 3 lines and "and N more", and counts a paused policy once even if it is also past its warn threshold. | Spec §2.4: banner on the project's fleet pages when any covering policy is paused or past its warn threshold, linking to the policy. A banner that errors would be noise on a page about something else. |
| D180 | Every banner line links to `/:project/fleet/budgets`, including lines about a fleet-wide policy (the project page lists it read-only with the admin hint). Banner text names the scope ("the whole fleet", "project x", "repo a/b"). | One destination; a project ADMIN cannot resume a global policy, and the page explains why. |
| D181 | Percent and bar width are display-only (integer floor of spent * 100 / amount in ten-thousandths, clamped to 100, so 100 appears only at or past the limit). Status badges use the server flags. Decimal comparisons that gate a submit (resume amount vs spend) use integer ten-thousandths (`toUnits`, `BigInt`), never floats. | The `0.1 + 0.2` vs `0.3` class of bug; the server uses `Prisma.Decimal` and the client must agree on equality. |
| D182 | The create dialog offers the scope types of its route (admin: global, runner; project: project, repo). `runner` and `repo` show a select of runner names (admin runner list) or repo names (project repo list); `global` and `project` send no `scopeId` (the project route sets it). The edit dialog shows no scope or window controls, only a fixed-after-create hint. | Mirrors `resolveScope` in `budgets.service.ts` and D161. |
| D183 | Form fields are strings in the form and converted on submit: `amountUsd` (regex `^\d{1,7}(\.\d{1,4})?$`, > 0, <= 1,000,000, sent as a number), `warnPercent` (blank = `null` = no warn; create is prefilled with 80), `hardStop` and `runningJobs` as native selects (`FleetNativeSelect`, plan 4b D137: the repo has no shadcn checkbox or switch). Edit always sends all four editable fields, because an explicit `null` warn is meaningful and an omitted one means "unchanged". | Matches the DTO validators; a blank warn field must be able to turn warnings off. |
| D184 | The resume dialog requires a new amount when the current amount is not above the window spend (the lowered-amount case, 2a Review Focus 4) and rejects a typed amount that is not above the spend, both before the request. Blank otherwise means "keep the amount" and sends `{}`. | The server would answer 400 `fleet.budgetAmountNotAboveSpend`; catching it first gives a precise hint instead of a toast. The server check stays (a race with new spend is still possible). |
| D185 | A refusal that means "your view is stale" (resume 409 `fleet.budgetNotPaused`, edit or delete 404 `fleet.budgets`) shows the server's message and reloads the list; the dialog stays open and its `failed` event triggers the reload. | No phantom rows, no silent no-ops. |
| D186 | Delete asks `window.confirm` (as the Runners page does) and the text says a paused scope resumes immediately (2a: deleting a paused policy clears the pause). | The consequence is the non-obvious part. |
| D187 | Navigation: a "Budgets" link in the global-admin sidebar group (Wallet icon, `nav.fleetBudgets`), and a "Budgets" button in the project jobs-list header for every member (plus the banner link). No project sidebar link. Breadcrumb leaf for `/:project/fleet/budgets` is the page title. | The project "Fleet jobs" sidebar link is prefix-active, so a second `/:project/fleet/budgets` link would highlight both. |
| D188 | The job page renders a `stateReason` of the form `budget:<policyId>` (what a budget cancel writes, 2a D156/D170) as "Stopped by a fleet budget" with a link to the budgets page; the raw reason stays in the element `title`. | Otherwise members read an opaque id. Cheap, pure helper `budgetStopPolicyId`. |
| D189 | E2E: one spec, two tests. (1) Project flow: create a project policy in the UI, drive a scripted runner past the limit, wait for the API to report `paused`, see the banner on the jobs list, resume with a raised limit in the UI, banner gone. (2) Admin flow: create and delete a global policy. The first test deletes its policy in `afterAll`, because a leftover paused project policy would block the `fleet-dispatch` e2e that runs after it alphabetically. | Needs the evaluator's ~1 s debounce (the test waits on the API, not a fixed sleep) and cleanup that survives a failed assertion. |

## Review Focus

1. **Equal-to-spend resume amount** (`0.3` typed while the window spend is `0.3000`, or `5` vs `5.0000`): must be refused
   before the request, and `0.3001` accepted; no float arithmetic anywhere in the gate. (Task 1 `isAboveSpend`, Task 5.)
2. **Paused policy whose limit was lowered below the spend** (amount `2`, spend `3`): the resume dialog must demand a
   higher limit instead of posting `{}` and surfacing a 400 toast. (Task 1 `buildResumeSchema`, Task 5.)
3. **A project member (not ADMIN) opens the budgets page**: sees rows and the fleet-wide table, no create/edit/resume/
   delete control anywhere, and a line saying who can change policies. (Task 6 read-only table, Task 8.)
4. **Stale view**: another admin already resumed or deleted the policy: resume 409 / delete 404 show the server's
   message, the list reloads, no phantom row, no stuck spinner. A slow poll that started before a successful mutation
   must not put the old row back. (Task 2.)
5. **Banner noise**: empty list, failed load, or only "within budget" rows render nothing; more than three flagged
   policies render three lines plus "and N more"; a paused policy that is also past its warn threshold appears once;
   a repo that no longer exists shows its raw id instead of crashing. (Task 1 `bannerLines`/`scopeName`, Task 9.)

---

## File Structure

| File | Responsibility |
|:--|:--|
| `apps/web/lib/fleet-types.ts` (modify) | `BudgetPolicyDto`, create/patch bodies, scope/window/running-jobs enums. |
| `apps/web/lib/fleet-budgets.ts` (create) | Pure helpers: `toUnits`, `isAboveSpend`, `parseAmount`, `parseWarn`, form schemas and body mappers, `bannerLines`, `scopeName`/`scopeText`, `spendPercent`, `sortPolicies`, `budgetStopPolicyId`. |
| `apps/web/composables/useFleetBudgets.ts` (create) | Transport + list state for one base (admin or project): `load, create, update, remove, resume, apply`. |
| `apps/web/composables/useFleetBudgetPage.ts` (create) | Page state: `refresh`, `pending/loadFailed/stale/forbidden`, dialog refs, `remove` with confirm, `onApplied`. |
| `apps/web/components/fleet/BudgetTable.vue` (create) | One table of policies (spend bar, rules, status, actions emitted). |
| `apps/web/components/fleet/BudgetEditDialog.vue` (create) | Create and edit form (vee-validate + zod). |
| `apps/web/components/fleet/BudgetResumeDialog.vue` (create) | Resume with optional raised limit. |
| `apps/web/components/fleet/BudgetBanner.vue` (create) | Self-loading paused/warn alert for project fleet pages. |
| `apps/web/pages/admin/fleet/budgets.vue` (create) | Admin page: global and runner policies. |
| `apps/web/pages/[project]/fleet/budgets.vue` (create) | Project page: own policies + read-only fleet-wide ones. |
| `apps/web/pages/[project]/fleet/index.vue`, `dispatch.vue`, `jobs/[id].vue` (modify) | Banner placement; Budgets button; budget stop reason. |
| `apps/web/layouts/default.vue` (modify) | Admin sidebar link, breadcrumb leaf. |
| `apps/web/i18n/locales/en.json`, `zh.json` (modify) | `fleet.budgets.*`, `nav.fleetBudgets`, `fleet.jobs.budgets`, `fleet.jobs.detail.budgetStop*`. |
| `apps/web/tests/helpers/mount-sfc.ts`, `fleet-harness.ts` (modify) | Register `FleetBudgetTable` as a real child; stubs for the dialogs and `ErrorState`. |
| `apps/web/tests/**` (create/modify) | Listed per task. |
| `apps/web/tests/e2e/fleet-budgets.e2e.spec.ts`, `fixtures/fleet-budgets-api.ts` (create) | Playwright flow. |
| `docs/deployment/runner.md`, the S1b spec (modify) | Where to manage budgets in the web; 2b notes. |

---

### Task 1: Wire types and the pure budgets library

**Files:**
- Modify: `apps/web/lib/fleet-types.ts` (append after `DispatchBody`)
- Create: `apps/web/lib/fleet-budgets.ts`
- Test: `apps/web/tests/lib/fleet-budgets.spec.ts`

**Interfaces:**
- Produces (all exported from `~/lib/fleet-budgets`):
  - `type Translate = (key: string, named?: Record<string, unknown>) => string`
  - `MAX_BUDGET_USD = 1_000_000`, `DEFAULT_WARN_PERCENT = 80`, `BANNER_MAX_LINES = 3`
  - `type BudgetRouteKind = 'admin' | 'project'`; `scopesFor(kind): readonly BudgetScopeType[]`; `isManagedOn(kind, policy): boolean`
  - `sortPolicies(policies): BudgetPolicyDto[]`
  - `toUnits(decimal: string): bigint | null` (ten-thousandths of a dollar); `isAboveSpend(amount: string, spent: string): boolean`
  - `parseAmount(input: string): number | null`; `parseWarn(input: string): { ok: true; value: number | null } | { ok: false }`
  - `interface BudgetFormValues { scopeType; scopeId: string; windowKind; amountUsd: string; warnPercent: string; hardStop: 'true' | 'false'; runningJobs }`
  - `initialFormValues(kind, policy | null): BudgetFormValues`; `buildBudgetSchema(t)`; `toCreateBody(values): NewBudgetPolicyBody`; `toPatchBody(values): BudgetPolicyPatchBody`
  - `buildResumeSchema(t, policy: Pick<BudgetPolicyDto, 'amountUsd' | 'spentUsd'>)`; `toResumeAmount(input): number | undefined`
  - `type BudgetStatus = 'paused' | 'warning' | 'ok'`; `budgetStatus(policy)`; `spendPercent(spent, amount): number`
  - `interface BannerLine { policy: BudgetPolicyDto; status: 'paused' | 'warning' }`; `bannerLines(policies): { lines: BannerLine[]; more: number }`
  - `interface ScopeNames { project: string | null; repo: (id: string) => string; runner: (id: string) => string }`; `scopeName(policy, names): string | null`; `scopeText(t, policy, name): string`
  - `windowSinceDate(iso: string): string` (the UTC date, `YYYY-MM-DD`); `budgetStopPolicyId(reason): string | null`
  - `needsScopeId(scopeType): boolean`
- Consumes: `formatUsd` from `~/lib/fleet-jobs`.

- [ ] **Step 1: Add the wire types**

Append to `apps/web/lib/fleet-types.ts`:

```ts
/** S1b slice 2a wire types (apps/api/src/fleet/budgets/dto). Money is a decimal string. */
export const BUDGET_SCOPE_TYPES = ['global', 'project', 'repo', 'runner'] as const
export type BudgetScopeType = (typeof BUDGET_SCOPE_TYPES)[number]
export const BUDGET_WINDOW_KINDS = ['calendar_month_utc', 'lifetime'] as const
export type BudgetWindowKind = (typeof BUDGET_WINDOW_KINDS)[number]
export const BUDGET_RUNNING_JOBS = ['finish', 'cancel'] as const
export type BudgetRunningJobs = (typeof BUDGET_RUNNING_JOBS)[number]

export interface BudgetPolicyDto {
  id: string
  scopeType: BudgetScopeType
  scopeId: string | null
  projectId: string | null
  windowKind: BudgetWindowKind
  amountUsd: string
  warnPercent: number | null
  hardStop: boolean
  runningJobs: BudgetRunningJobs
  /** Effectively paused now (S1b section 2.3); the web never recomputes it. */
  paused: boolean
  pausedAt: string | null
  windowStart: string
  spentUsd: string
  warnReached: boolean
  updatedById: string
  createdAt: string
  updatedAt: string
}

export interface NewBudgetPolicyBody {
  scopeType: BudgetScopeType
  scopeId?: string
  windowKind: BudgetWindowKind
  amountUsd: number
  warnPercent: number | null
  hardStop: boolean
  runningJobs: BudgetRunningJobs
}

export interface BudgetPolicyPatchBody {
  amountUsd?: number
  warnPercent?: number | null
  hardStop?: boolean
  runningJobs?: BudgetRunningJobs
}
```

- [ ] **Step 2: Write the failing library spec**

Create `apps/web/tests/lib/fleet-budgets.spec.ts`:

```ts
import { describe, expect, test } from '@jest/globals'
import {
  BANNER_MAX_LINES, bannerLines, budgetStatus, budgetStopPolicyId, buildBudgetSchema, buildResumeSchema, initialFormValues,
  isAboveSpend, isManagedOn, needsScopeId, parseAmount, parseWarn, scopeName, scopeText, scopesFor, sortPolicies,
  spendPercent, toCreateBody, toPatchBody, toResumeAmount, toUnits, windowSinceDate,
} from '../../lib/fleet-budgets'
import type { BudgetFormValues } from '../../lib/fleet-budgets'
import type { BudgetPolicyDto } from '../../lib/fleet-types'

const policy = (over: Partial<BudgetPolicyDto> = {}): BudgetPolicyDto => ({
  id: 'p1', scopeType: 'project', scopeId: 'proj1', projectId: 'proj1', windowKind: 'calendar_month_utc',
  amountUsd: '5.0000', warnPercent: 80, hardStop: true, runningJobs: 'finish', paused: false, pausedAt: null,
  windowStart: '2026-10-01T00:00:00.000Z', spentUsd: '1.0000', warnReached: false, updatedById: 'u1',
  createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', ...over,
})

/** Echoes the key and its named values so an assertion can see which message and arguments were used. */
const t = (key: string, named: Record<string, unknown> = {}): string =>
  Object.keys(named).length > 0 ? `${key}${JSON.stringify(named)}` : key

const values = (over: Partial<BudgetFormValues> = {}): BudgetFormValues => ({
  scopeType: 'global', scopeId: '', windowKind: 'calendar_month_utc', amountUsd: '10', warnPercent: '80',
  hardStop: 'true', runningJobs: 'finish', ...over,
})

describe('toUnits and isAboveSpend (decimal-safe, no floats)', () => {
  test.each([
    ['5.0000', 50000], ['0.3', 3000], ['12', 120000], ['0.0001', 1], [' 7.5 ', 75000],
  ])('toUnits(%p) = %p ten-thousandths', (input, units) => {
    expect(toUnits(input)).toBe(BigInt(units))
  })

  test.each([[''], ['-1'], ['1e-7'], ['0.12345'], ['abc'], ['1,5']])('toUnits(%p) is null', (input) => {
    expect(toUnits(input)).toBeNull()
  })

  test('an amount equal to the spend is not above it, whatever the trailing zeros', () => {
    expect(isAboveSpend('0.3', '0.3000')).toBe(false)
    expect(isAboveSpend('5', '5.0000')).toBe(false)
    expect(isAboveSpend('0.3001', '0.3')).toBe(true)
    expect(isAboveSpend('5.0001', '5.0000')).toBe(true)
    expect(isAboveSpend('4', '4.5')).toBe(false)
  })

  test('an unparsable value lets the server decide', () => {
    expect(isAboveSpend('x', '1')).toBe(true)
    expect(isAboveSpend('1', 'x')).toBe(true)
  })
})

describe('parseAmount and parseWarn', () => {
  test.each([
    ['0.5', 0.5], ['1000000', 1000000], ['0.0001', 0.0001], [' 2 ', 2], ['12.3456', 12.3456],
  ])('parseAmount(%p) = %p', (input, out) => {
    expect(parseAmount(input)).toBe(out)
  })

  test.each([[''], ['0'], ['0.0000'], ['1000000.0001'], ['12345678'], ['1.23456'], ['1e3'], ['1,5'], ['-2'], ['abc']])(
    'parseAmount(%p) is null',
    (input) => { expect(parseAmount(input)).toBeNull() },
  )

  test('parseWarn: blank is "no warn", 1-99 is a percent, anything else is rejected', () => {
    expect(parseWarn('')).toEqual({ ok: true, value: null })
    expect(parseWarn('  ')).toEqual({ ok: true, value: null })
    expect(parseWarn('80')).toEqual({ ok: true, value: 80 })
    expect(parseWarn(' 5 ')).toEqual({ ok: true, value: 5 })
    for (const bad of ['0', '100', '8.5', '-1', 'abc', '07x']) expect(parseWarn(bad)).toEqual({ ok: false })
  })
})

describe('scopes, ordering and ownership', () => {
  test('each route manages its own scope types (2a D162)', () => {
    expect(scopesFor('admin')).toEqual(['global', 'runner'])
    expect(scopesFor('project')).toEqual(['project', 'repo'])
    expect(isManagedOn('admin', policy({ scopeType: 'runner' }))).toBe(true)
    expect(isManagedOn('admin', policy({ scopeType: 'project' }))).toBe(false)
    expect(isManagedOn('project', policy({ scopeType: 'global' }))).toBe(false)
    expect(isManagedOn('project', policy({ scopeType: 'repo' }))).toBe(true)
  })

  test('needsScopeId is true for runner and repo only', () => {
    expect(['global', 'project', 'repo', 'runner'].map((s) => needsScopeId(s as never))).toEqual([false, false, true, true])
  })

  test('sortPolicies orders by scope type, then scope id, then window', () => {
    const rows = [
      policy({ id: 'a', scopeType: 'runner', scopeId: 'r2' }),
      policy({ id: 'b', scopeType: 'global', scopeId: null, windowKind: 'lifetime' }),
      policy({ id: 'c', scopeType: 'global', scopeId: null, windowKind: 'calendar_month_utc' }),
      policy({ id: 'd', scopeType: 'runner', scopeId: 'r1' }),
    ]
    expect(sortPolicies(rows).map((p) => p.id)).toEqual(['c', 'b', 'd', 'a'])
    expect(rows.map((p) => p.id)).toEqual(['a', 'b', 'c', 'd'])
  })
})

describe('labels and display helpers', () => {
  test('scopeName resolves names, falls back to the raw id and is null for global', () => {
    const names = { project: 'koda', repo: (id: string) => (id === 'r1' ? 'acme/app' : id), runner: (id: string) => `box-${id}` }
    expect(scopeName(policy({ scopeType: 'global', scopeId: null }), names)).toBeNull()
    expect(scopeName(policy({ scopeType: 'project' }), names)).toBe('koda')
    expect(scopeName(policy({ scopeType: 'repo', scopeId: 'r1' }), names)).toBe('acme/app')
    expect(scopeName(policy({ scopeType: 'repo', scopeId: 'gone' }), names)).toBe('gone')
    expect(scopeName(policy({ scopeType: 'runner', scopeId: '7' }), names)).toBe('box-7')
    expect(scopeName(policy({ scopeType: 'repo', scopeId: null }), names)).toBeNull()
  })

  test('scopeText asks the translator for the scope sentence', () => {
    expect(scopeText(t, policy({ scopeType: 'repo' }), 'acme/app')).toBe('fleet.budgets.scopeText.repo{"name":"acme/app"}')
    expect(scopeText(t, policy({ scopeType: 'global', scopeId: null }), null)).toBe('fleet.budgets.scopeText.global{"name":""}')
  })

  test('spendPercent floors, clamps and survives garbage', () => {
    expect(spendPercent('4.99', '5')).toBe(99)
    expect(spendPercent('5', '5')).toBe(100)
    expect(spendPercent('9', '5')).toBe(100)
    expect(spendPercent('0', '5')).toBe(0)
    expect(spendPercent('0.57', '1')).toBe(57)
    expect(spendPercent('x', '5')).toBe(0)
    expect(spendPercent('1', '0')).toBe(0)
  })

  test('budgetStatus follows the server flags: paused beats warning', () => {
    expect(budgetStatus({ paused: true, warnReached: true })).toBe('paused')
    expect(budgetStatus({ paused: false, warnReached: true })).toBe('warning')
    expect(budgetStatus({ paused: false, warnReached: false })).toBe('ok')
  })

  test('windowSinceDate is the UTC date of the window start', () => {
    expect(windowSinceDate('2026-10-01T00:00:00.000Z')).toBe('2026-10-01')
    expect(windowSinceDate('1970-01-01T00:00:00.000Z')).toBe('1970-01-01')
  })

  test('budgetStopPolicyId reads the reason a budget cancel writes (2a D156)', () => {
    expect(budgetStopPolicyId('budget:ckx123')).toBe('ckx123')
    for (const other of ['budget:', 'budget:a b', 'cancelled before start', '', null, undefined]) {
      expect(budgetStopPolicyId(other)).toBeNull()
    }
  })
})

describe('bannerLines', () => {
  const flagged = (id: string, over: Partial<BudgetPolicyDto>) => policy({ id, ...over })

  test('paused first, then warnings, ok rows hidden', () => {
    const { lines, more } = bannerLines([
      flagged('w1', { warnReached: true }),
      flagged('ok', {}),
      flagged('p1', { paused: true }),
    ])
    expect(lines.map((l) => [l.policy.id, l.status])).toEqual([['p1', 'paused'], ['w1', 'warning']])
    expect(more).toBe(0)
  })

  test('at most three lines, the rest counted', () => {
    const rows = [
      flagged('p1', { paused: true }), flagged('p2', { paused: true }), flagged('w1', { warnReached: true }),
      flagged('w2', { warnReached: true }), flagged('w3', { warnReached: true }),
    ]
    const { lines, more } = bannerLines(rows)
    expect(lines).toHaveLength(BANNER_MAX_LINES)
    expect(lines.map((l) => l.policy.id)).toEqual(['p1', 'p2', 'w1'])
    expect(more).toBe(2)
  })

  test('a paused policy that is also past its warn threshold appears once', () => {
    const { lines } = bannerLines([flagged('p1', { paused: true, warnReached: true })])
    expect(lines).toHaveLength(1)
    expect(lines[0].status).toBe('paused')
  })

  test('nothing flagged, nothing shown', () => {
    expect(bannerLines([])).toEqual({ lines: [], more: 0 })
    expect(bannerLines([flagged('ok', {})])).toEqual({ lines: [], more: 0 })
  })
})

describe('form values and bodies', () => {
  test('initialFormValues for a new policy depends on the route', () => {
    expect(initialFormValues('admin', null)).toEqual(values({ amountUsd: '' }))
    expect(initialFormValues('project', null).scopeType).toBe('project')
  })

  test('initialFormValues for an existing policy trims trailing zeros and maps null warn to blank', () => {
    expect(initialFormValues('project', policy({ amountUsd: '5.0000', warnPercent: null, hardStop: false, runningJobs: 'cancel' }))).toEqual({
      scopeType: 'project', scopeId: 'proj1', windowKind: 'calendar_month_utc', amountUsd: '5', warnPercent: '',
      hardStop: 'false', runningJobs: 'cancel',
    })
    expect(initialFormValues('admin', policy({ scopeType: 'global', scopeId: null, amountUsd: '0.5000' })).amountUsd).toBe('0.5')
    expect(initialFormValues('admin', policy({ amountUsd: '12.3400' })).amountUsd).toBe('12.34')
    expect(initialFormValues('admin', policy({ amountUsd: '100' })).amountUsd).toBe('100')
  })

  test('toCreateBody sends scopeId for runner and repo only, blank warn as null, hardStop as boolean', () => {
    expect(toCreateBody(values())).toEqual({
      scopeType: 'global', windowKind: 'calendar_month_utc', amountUsd: 10, warnPercent: 80, hardStop: true, runningJobs: 'finish',
    })
    expect(toCreateBody(values({ scopeType: 'runner', scopeId: 'r1', warnPercent: '', hardStop: 'false', runningJobs: 'cancel' }))).toEqual({
      scopeType: 'runner', scopeId: 'r1', windowKind: 'calendar_month_utc', amountUsd: 10, warnPercent: null, hardStop: false, runningJobs: 'cancel',
    })
    expect(toCreateBody(values({ scopeType: 'project', scopeId: 'stale' }))).not.toHaveProperty('scopeId')
  })

  test('toCreateBody refuses values the schema never validated', () => {
    expect(() => toCreateBody(values({ amountUsd: 'abc' }))).toThrow('not validated')
    expect(() => toCreateBody(values({ warnPercent: '100' }))).toThrow('not validated')
  })

  test('toPatchBody always sends the four editable fields, including an explicit null warn', () => {
    expect(toPatchBody(values({ amountUsd: '7.25', warnPercent: '' }))).toEqual({
      amountUsd: 7.25, warnPercent: null, hardStop: true, runningJobs: 'finish',
    })
  })
})

describe('buildBudgetSchema', () => {
  const schema = buildBudgetSchema(t)
  const issuePaths = (input: BudgetFormValues): string[] => {
    const result = schema.safeParse(input)
    return result.success ? [] : result.error.issues.map((i) => i.path.join('.'))
  }

  test('a complete global policy passes; blank warn passes', () => {
    expect(issuePaths(values())).toEqual([])
    expect(issuePaths(values({ warnPercent: '' }))).toEqual([])
  })

  test('amount and warn errors name their field and use i18n keys', () => {
    expect(issuePaths(values({ amountUsd: '' }))).toEqual(['amountUsd'])
    expect(issuePaths(values({ warnPercent: '150' }))).toEqual(['warnPercent'])
    const result = schema.safeParse(values({ amountUsd: '0' }))
    expect(result.success ? '' : result.error.issues[0].message).toBe('fleet.budgets.validation.amountInvalid')
  })

  test('runner and repo need a target, global and project do not', () => {
    expect(issuePaths(values({ scopeType: 'runner', scopeId: '' }))).toEqual(['scopeId'])
    expect(issuePaths(values({ scopeType: 'repo', scopeId: '' }))).toEqual(['scopeId'])
    expect(issuePaths(values({ scopeType: 'runner', scopeId: 'r1' }))).toEqual([])
    expect(issuePaths(values({ scopeType: 'project', scopeId: '' }))).toEqual([])
  })
})

describe('buildResumeSchema (D184)', () => {
  const run = (amountUsd: string, over: Partial<Pick<BudgetPolicyDto, 'amountUsd' | 'spentUsd'>> = {}) =>
    buildResumeSchema(t, { amountUsd: '10.0000', spentUsd: '9.0000', ...over }).safeParse({ amountUsd })

  test('blank keeps the amount when it is above the spend', () => {
    expect(run('').success).toBe(true)
  })

  test('blank is refused when the limit is not above the spend (lowered amount)', () => {
    const lowered = run('', { amountUsd: '2.0000', spentUsd: '3.0000' })
    expect(lowered.success).toBe(false)
    expect(lowered.success ? '' : lowered.error.issues[0].message).toBe('fleet.budgets.validation.amountRequired')
    expect(run('', { amountUsd: '3.0000', spentUsd: '3.0000' }).success).toBe(false)
  })

  test('a typed amount must be above the spend, decimal-exact', () => {
    expect(run('9', { spentUsd: '9.0000' }).success).toBe(false)
    expect(run('9.0001', { spentUsd: '9.0000' }).success).toBe(true)
    const refused = run('5', { spentUsd: '9.0000' })
    expect(refused.success ? '' : refused.error.issues[0].message).toContain('fleet.budgets.validation.resumeNotAbove')
  })

  test('a malformed amount is refused', () => {
    const bad = run('abc')
    expect(bad.success ? '' : bad.error.issues[0].message).toBe('fleet.budgets.validation.amountInvalid')
  })

  test('toResumeAmount: blank is "keep", otherwise the number', () => {
    expect(toResumeAmount('')).toBeUndefined()
    expect(toResumeAmount('  ')).toBeUndefined()
    expect(toResumeAmount(' 7.5 ')).toBe(7.5)
  })
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd apps/web && bun run test -- tests/lib/fleet-budgets.spec.ts`
Expected: FAIL with "Cannot find module '../../lib/fleet-budgets'".

- [ ] **Step 4: Implement the library**

Create `apps/web/lib/fleet-budgets.ts`:

```ts
import * as z from 'zod'
import { formatUsd } from '~/lib/fleet-jobs'
import { BUDGET_RUNNING_JOBS, BUDGET_SCOPE_TYPES, BUDGET_WINDOW_KINDS } from '~/lib/fleet-types'
import type {
  BudgetPolicyDto, BudgetPolicyPatchBody, BudgetRunningJobs, BudgetScopeType, BudgetWindowKind, NewBudgetPolicyBody,
} from '~/lib/fleet-types'

/** vue-i18n's `t`, narrowed to what the helpers need. */
export type Translate = (key: string, named?: Record<string, unknown>) => string

/** apps/api create-budget-policy.dto MAX_BUDGET_USD. */
export const MAX_BUDGET_USD = 1_000_000
export const DEFAULT_WARN_PERCENT = 80
export const BANNER_MAX_LINES = 3
/** Decimal(12,4): money has four decimals, so ten-thousandths of a dollar are exact integers. */
const UNITS_PER_USD = 10_000

export type BudgetRouteKind = 'admin' | 'project'

const ADMIN_SCOPES: readonly BudgetScopeType[] = ['global', 'runner']
const PROJECT_SCOPES: readonly BudgetScopeType[] = ['project', 'repo']

/** Plan 2a D162: the scope types each route prefix manages. */
export const scopesFor = (kind: BudgetRouteKind): readonly BudgetScopeType[] => (kind === 'admin' ? ADMIN_SCOPES : PROJECT_SCOPES)

export const isManagedOn = (kind: BudgetRouteKind, policy: Pick<BudgetPolicyDto, 'scopeType'>): boolean =>
  scopesFor(kind).includes(policy.scopeType)

/** Runner and repo policies name a target; global and project ones do not. */
export const needsScopeId = (scopeType: BudgetScopeType): boolean => scopeType === 'runner' || scopeType === 'repo'

/** Scope type, then scope id, then window kind: stable, and the order the pages group by. */
export function sortPolicies(policies: readonly BudgetPolicyDto[]): BudgetPolicyDto[] {
  return [...policies].sort((a, b) =>
    BUDGET_SCOPE_TYPES.indexOf(a.scopeType) - BUDGET_SCOPE_TYPES.indexOf(b.scopeType)
    || (a.scopeId ?? '').localeCompare(b.scopeId ?? '')
    || BUDGET_WINDOW_KINDS.indexOf(a.windowKind) - BUDGET_WINDOW_KINDS.indexOf(b.windowKind))
}

/** Ten-thousandths of a dollar from a decimal string of at most 4 decimals; null when unusable. */
export function toUnits(decimal: string): bigint | null {
  const match = /^(\d{1,12})(?:\.(\d{1,4}))?$/.exec(decimal.trim())
  if (!match) return null
  return BigInt(match[1]) * BigInt(UNITS_PER_USD) + BigInt((match[2] ?? '').padEnd(4, '0'))
}

/**
 * True when `amount` is strictly above `spent`, compared in integer units (never floats). An
 * unparsable value answers true: the server is the authority and will refuse it with its own message.
 */
export function isAboveSpend(amount: string, spent: string): boolean {
  const a = toUnits(amount)
  const s = toUnits(spent)
  if (a === null || s === null) return true
  return a > s
}

const AMOUNT_RE = /^\d{1,7}(?:\.\d{1,4})?$/

/** The create/update `amountUsd`: > 0, at most 4 decimals, at most MAX_BUDGET_USD; null when invalid. */
export function parseAmount(input: string): number | null {
  const trimmed = input.trim()
  if (!AMOUNT_RE.test(trimmed)) return null
  const units = toUnits(trimmed)
  if (units === null || units <= BigInt(0) || units > BigInt(MAX_BUDGET_USD) * BigInt(UNITS_PER_USD)) return null
  return Number(trimmed)
}

export type WarnParse = { ok: true; value: number | null } | { ok: false }

/** Blank = no warning (null); otherwise a whole number 1-99. */
export function parseWarn(input: string): WarnParse {
  const trimmed = input.trim()
  if (trimmed === '') return { ok: true, value: null }
  if (!/^\d{1,2}$/.test(trimmed)) return { ok: false }
  const value = Number(trimmed)
  return value >= 1 && value <= 99 ? { ok: true, value } : { ok: false }
}

export interface BudgetFormValues {
  scopeType: BudgetScopeType
  scopeId: string
  windowKind: BudgetWindowKind
  amountUsd: string
  warnPercent: string
  hardStop: 'true' | 'false'
  runningJobs: BudgetRunningJobs
}

/** "5.0000" -> "5", "0.5000" -> "0.5", "12.34" stays. */
function trimDecimal(decimal: string): string {
  return decimal.includes('.') ? decimal.replace(/0+$/, '').replace(/\.$/, '') : decimal
}

export function initialFormValues(kind: BudgetRouteKind, policy: BudgetPolicyDto | null): BudgetFormValues {
  if (policy === null) {
    return {
      scopeType: scopesFor(kind)[0], scopeId: '', windowKind: 'calendar_month_utc', amountUsd: '',
      warnPercent: String(DEFAULT_WARN_PERCENT), hardStop: 'true', runningJobs: 'finish',
    }
  }
  return {
    scopeType: policy.scopeType,
    scopeId: policy.scopeId ?? '',
    windowKind: policy.windowKind,
    amountUsd: trimDecimal(policy.amountUsd),
    warnPercent: policy.warnPercent === null ? '' : String(policy.warnPercent),
    hardStop: policy.hardStop ? 'true' : 'false',
    runningJobs: policy.runningJobs,
  }
}

/** The create/edit form. Mirrors the DTO validators; the server's message is still shown for anything else. */
export function buildBudgetSchema(t: Translate) {
  return z.object({
    scopeType: z.enum(BUDGET_SCOPE_TYPES),
    scopeId: z.string(),
    windowKind: z.enum(BUDGET_WINDOW_KINDS),
    amountUsd: z.string().refine((value) => parseAmount(value) !== null, t('fleet.budgets.validation.amountInvalid')),
    warnPercent: z.string().refine((value) => parseWarn(value).ok, t('fleet.budgets.validation.warnInvalid')),
    hardStop: z.enum(['true', 'false']),
    runningJobs: z.enum(BUDGET_RUNNING_JOBS),
  }).superRefine((value, ctx) => {
    if (needsScopeId(value.scopeType) && value.scopeId.trim() === '') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['scopeId'], message: t('fleet.budgets.validation.scopeRequired') })
    }
  })
}

function validated(values: BudgetFormValues): { amountUsd: number; warnPercent: number | null } {
  const amountUsd = parseAmount(values.amountUsd)
  const warn = parseWarn(values.warnPercent)
  if (amountUsd === null || !warn.ok) throw new Error('fleet-budgets: form values were not validated')
  return { amountUsd, warnPercent: warn.value }
}

export function toCreateBody(values: BudgetFormValues): NewBudgetPolicyBody {
  const { amountUsd, warnPercent } = validated(values)
  return {
    scopeType: values.scopeType,
    ...(needsScopeId(values.scopeType) ? { scopeId: values.scopeId } : {}),
    windowKind: values.windowKind,
    amountUsd,
    warnPercent,
    hardStop: values.hardStop === 'true',
    runningJobs: values.runningJobs,
  }
}

/** D183: all four editable fields, always, so a blank warn field really turns warnings off. */
export function toPatchBody(values: BudgetFormValues): BudgetPolicyPatchBody {
  const { amountUsd, warnPercent } = validated(values)
  return { amountUsd, warnPercent, hardStop: values.hardStop === 'true', runningJobs: values.runningJobs }
}

/** D184: blank keeps the amount only when it is still above the spend; a typed amount must be above it. */
export function buildResumeSchema(t: Translate, policy: Pick<BudgetPolicyDto, 'amountUsd' | 'spentUsd'>) {
  return z.object({
    amountUsd: z.string().superRefine((value, ctx) => {
      const trimmed = value.trim()
      if (trimmed === '') {
        if (!isAboveSpend(policy.amountUsd, policy.spentUsd)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: t('fleet.budgets.validation.amountRequired') })
        }
        return
      }
      if (parseAmount(trimmed) === null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: t('fleet.budgets.validation.amountInvalid') })
        return
      }
      if (!isAboveSpend(trimmed, policy.spentUsd)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: t('fleet.budgets.validation.resumeNotAbove', { spent: formatUsd(policy.spentUsd) }),
        })
      }
    }),
  })
}

export function toResumeAmount(input: string): number | undefined {
  const trimmed = input.trim()
  return trimmed === '' ? undefined : (parseAmount(trimmed) ?? undefined)
}

export type BudgetStatus = 'paused' | 'warning' | 'ok'

/** The server's flags decide (D181); the client never recomputes a pause or a warn. */
export function budgetStatus(policy: Pick<BudgetPolicyDto, 'paused' | 'warnReached'>): BudgetStatus {
  if (policy.paused) return 'paused'
  return policy.warnReached ? 'warning' : 'ok'
}

/** Display only: integer-floored (so 100 shows only at or past the limit) and exact, e.g. 0.57 of 1 is 57. */
export function spendPercent(spent: string, amount: string): number {
  const s = toUnits(spent)
  const a = toUnits(amount)
  if (s === null || a === null || a <= BigInt(0)) return 0
  const percent = (s * BigInt(100)) / a
  return percent > BigInt(100) ? 100 : Number(percent)
}

export interface BannerLine {
  policy: BudgetPolicyDto
  status: 'paused' | 'warning'
}

/** D179: paused first, then warnings, at most BANNER_MAX_LINES; `more` counts the rest. */
export function bannerLines(policies: readonly BudgetPolicyDto[]): { lines: BannerLine[]; more: number } {
  const flagged = policies.flatMap((policy): BannerLine[] => {
    const status = budgetStatus(policy)
    return status === 'ok' ? [] : [{ policy, status }]
  })
  const ordered = [...flagged.filter((l) => l.status === 'paused'), ...flagged.filter((l) => l.status === 'warning')]
  return { lines: ordered.slice(0, BANNER_MAX_LINES), more: Math.max(0, ordered.length - BANNER_MAX_LINES) }
}

export interface ScopeNames {
  project: string | null
  repo: (id: string) => string
  runner: (id: string) => string
}

/** The name behind a policy's scope; null for global (and for a repo/runner policy without a scope id). */
export function scopeName(policy: Pick<BudgetPolicyDto, 'scopeType' | 'scopeId'>, names: ScopeNames): string | null {
  switch (policy.scopeType) {
    case 'global': return null
    case 'project': return names.project ?? policy.scopeId
    case 'repo': return policy.scopeId === null ? null : names.repo(policy.scopeId)
    case 'runner': return policy.scopeId === null ? null : names.runner(policy.scopeId)
  }
}

/** "the whole fleet" / "project x" / "repo a/b" / "runner r", for sentences. */
export function scopeText(t: Translate, policy: Pick<BudgetPolicyDto, 'scopeType'>, name: string | null): string {
  return t(`fleet.budgets.scopeText.${policy.scopeType}`, { name: name ?? '' })
}

/** The window start is an ISO instant; its UTC date is what a monthly window "starts". */
export const windowSinceDate = (iso: string): string => iso.slice(0, 10)

const BUDGET_STOP_RE = /^budget:([A-Za-z0-9_-]{1,64})$/

/** D188: the policy id inside a job's `stateReason` when a budget stopped it (2a D156), else null. */
export function budgetStopPolicyId(reason: string | null | undefined): string | null {
  if (!reason) return null
  return BUDGET_STOP_RE.exec(reason)?.[1] ?? null
}
```

- [ ] **Step 5: Run the spec to verify it passes**

Run: `cd apps/web && bun run test -- tests/lib/fleet-budgets.spec.ts`
Expected: PASS (all describe blocks). If `toBe(BigInt(...))` reports a Jest serialization error on failure only, ignore; a pass is a pass.

- [ ] **Step 6: Lint the two files and commit**

Run: `cd apps/web && bunx eslint lib/fleet-budgets.ts lib/fleet-types.ts tests/lib/fleet-budgets.spec.ts --max-warnings=0`
Expected: no output.

```bash
git add apps/web/lib/fleet-types.ts apps/web/lib/fleet-budgets.ts apps/web/tests/lib/fleet-budgets.spec.ts
git commit -m "feat(web): fleet budgets wire types and pure helpers"
```

---

### Task 2: `useFleetBudgets` and `useFleetBudgetPage`

**Files:**
- Create: `apps/web/composables/useFleetBudgets.ts`
- Create: `apps/web/composables/useFleetBudgetPage.ts`
- Test: `apps/web/tests/composables/useFleetBudgets.spec.ts`
- Test: `apps/web/tests/composables/useFleetBudgetPage.spec.ts`

**Interfaces:**
- Consumes: `sortPolicies` and the body types from Task 1.
- Produces from `useFleetBudgets.ts`:
  - `type BudgetBase = { kind: 'admin' } | { kind: 'project'; slug: string }`
  - `budgetRoot(base): string`, `budgetItem(base, id): string`
  - `useFleetBudgets(base)` returns `{ policies: Ref<BudgetPolicyDto[]>, pending: Ref<boolean>, load(): Promise<void>, apply(dto): void, create(body): Promise<BudgetPolicyDto>, update(id, patch): Promise<BudgetPolicyDto>, remove(id): Promise<void>, resume(id, amountUsd?): Promise<BudgetPolicyDto> }`
- Produces from `useFleetBudgetPage.ts`: `isForbidden(err): boolean` and
  `useFleetBudgetPage(base)` returning `{ policies, pending, loadFailed, stale, forbidden, editOpen, editing, resumeOpen, resuming, refresh(): Promise<void>, openCreate(): void, openEdit(p): void, openResume(p): void, remove(p, confirmText: string): Promise<void>, onApplied(dto): void }`.

- [ ] **Step 1: Write the failing transport spec**

Create `apps/web/tests/composables/useFleetBudgets.spec.ts`:

```ts
import { describe, test, expect, beforeEach, jest } from '@jest/globals'
import { join } from 'path'
import type { BudgetPolicyDto } from '../../lib/fleet-types'

const composablePath = join(__dirname, '../..', 'composables', 'useFleetBudgets.ts')

const row = (id: string, over: Partial<BudgetPolicyDto> = {}): BudgetPolicyDto => ({
  id, scopeType: 'global', scopeId: null, projectId: null, windowKind: 'calendar_month_utc', amountUsd: '5.0000',
  warnPercent: 80, hardStop: true, runningJobs: 'finish', paused: false, pausedAt: null,
  windowStart: '2026-10-01T00:00:00.000Z', spentUsd: '1.0000', warnReached: false, updatedById: 'u1',
  createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', ...over,
})

function withApi(api: Record<string, jest.Mock>): void {
  ;(globalThis as Record<string, unknown>).useApi = () => ({ $api: api })
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

describe('useFleetBudgets', () => {
  beforeEach(() => { ;(globalThis as Record<string, unknown>).useApi = undefined })

  test('paths: admin prefix, project prefix with an encoded slug, item and resume paths', async () => {
    const { budgetRoot, budgetItem } = await import(composablePath)
    expect(budgetRoot({ kind: 'admin' })).toBe('/fleet/budgets')
    expect(budgetRoot({ kind: 'project', slug: 'a b' })).toBe('/projects/a%20b/fleet/budgets')
    expect(budgetItem({ kind: 'admin' }, 'p1')).toBe('/fleet/budgets/p1')
    expect(budgetItem({ kind: 'project', slug: 'koda' }, 'p1')).toBe('/projects/koda/fleet/budgets/p1')
  })

  test('load reads the base list and sorts it by scope type', async () => {
    const get = jest.fn(async () => [row('r', { scopeType: 'runner', scopeId: 'r1' }), row('g')])
    withApi({ get })
    const { useFleetBudgets } = await import(composablePath)
    const budgets = useFleetBudgets({ kind: 'admin' })

    await budgets.load()

    expect(get).toHaveBeenCalledWith('/fleet/budgets')
    expect(budgets.policies.value.map((p) => p.id)).toEqual(['g', 'r'])
    expect(budgets.pending.value).toBe(false)
  })

  test('create posts the body to the base and inserts the answer in order', async () => {
    const body = { scopeType: 'global', windowKind: 'lifetime', amountUsd: 9, warnPercent: null, hardStop: true, runningJobs: 'finish' }
    const post = jest.fn(async () => row('new', { windowKind: 'lifetime' }))
    withApi({ get: jest.fn(async () => [row('old')]), post })
    const { useFleetBudgets } = await import(composablePath)
    const budgets = useFleetBudgets({ kind: 'admin' })
    await budgets.load()

    const created = await budgets.create(body as never)

    expect(post).toHaveBeenCalledWith('/fleet/budgets', body)
    expect(created.id).toBe('new')
    expect(budgets.policies.value.map((p) => p.id)).toEqual(['old', 'new'])
  })

  test('update patches the item and replaces the row', async () => {
    const patch = jest.fn(async () => row('p1', { amountUsd: '9.0000' }))
    withApi({ get: jest.fn(async () => [row('p1')]), patch })
    const { useFleetBudgets } = await import(composablePath)
    const budgets = useFleetBudgets({ kind: 'project', slug: 'koda' })
    await budgets.load()

    await budgets.update('p1', { amountUsd: 9 })

    expect(patch).toHaveBeenCalledWith('/projects/koda/fleet/budgets/p1', { amountUsd: 9 })
    expect(budgets.policies.value[0].amountUsd).toBe('9.0000')
  })

  test('resume posts an empty body to keep the amount and the amount when raised', async () => {
    const post = jest.fn(async () => row('p1', { paused: false }))
    withApi({ get: jest.fn(async () => [row('p1', { paused: true })]), post })
    const { useFleetBudgets } = await import(composablePath)
    const budgets = useFleetBudgets({ kind: 'project', slug: 'koda' })
    await budgets.load()

    await budgets.resume('p1')
    await budgets.resume('p1', 8)

    expect(post).toHaveBeenNthCalledWith(1, '/projects/koda/fleet/budgets/p1/resume', {})
    expect(post).toHaveBeenNthCalledWith(2, '/projects/koda/fleet/budgets/p1/resume', { amountUsd: 8 })
    expect(budgets.policies.value[0].paused).toBe(false)
  })

  test('remove deletes the item and drops the row', async () => {
    const del = jest.fn(async () => undefined)
    withApi({ get: jest.fn(async () => [row('a'), row('b', { windowKind: 'lifetime' })]), delete: del })
    const { useFleetBudgets } = await import(composablePath)
    const budgets = useFleetBudgets({ kind: 'admin' })
    await budgets.load()

    await budgets.remove('a')

    expect(del).toHaveBeenCalledWith('/fleet/budgets/a')
    expect(budgets.policies.value.map((p) => p.id)).toEqual(['b'])
  })

  test('a failed mutation leaves the list as it was and rethrows', async () => {
    withApi({ get: jest.fn(async () => [row('a')]), delete: jest.fn(async () => { throw new Error('gone') }) })
    const { useFleetBudgets } = await import(composablePath)
    const budgets = useFleetBudgets({ kind: 'admin' })
    await budgets.load()

    await expect(budgets.remove('a')).rejects.toThrow('gone')
    expect(budgets.policies.value.map((p) => p.id)).toEqual(['a'])
  })

  test('a load that started before a mutation cannot put the old row back (Review Focus 4)', async () => {
    const slow = deferred<BudgetPolicyDto[]>()
    const get = jest.fn()
      .mockImplementationOnce(async () => [row('p1', { paused: true })])
      .mockImplementationOnce(() => slow.promise)
    withApi({ get, post: jest.fn(async () => row('p1', { paused: false })) })
    const { useFleetBudgets } = await import(composablePath)
    const budgets = useFleetBudgets({ kind: 'admin' })
    await budgets.load()

    const poll = budgets.load()
    await budgets.resume('p1')
    slow.resolve([row('p1', { paused: true })])
    await poll

    expect(budgets.policies.value[0].paused).toBe(false)
  })

  test('only the newest load wins', async () => {
    const first = deferred<BudgetPolicyDto[]>()
    const second = deferred<BudgetPolicyDto[]>()
    const get = jest.fn().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise)
    withApi({ get })
    const { useFleetBudgets } = await import(composablePath)
    const budgets = useFleetBudgets({ kind: 'admin' })

    const a = budgets.load()
    const b = budgets.load()
    second.resolve([row('new')])
    await b
    first.resolve([row('old')])
    await a

    expect(budgets.policies.value.map((p) => p.id)).toEqual(['new'])
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/web && bun run test -- tests/composables/useFleetBudgets.spec.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `useFleetBudgets`**

Create `apps/web/composables/useFleetBudgets.ts`:

```ts
import { ref } from 'vue'
import { apiPath } from '~/lib/api-path'
import { sortPolicies } from '~/lib/fleet-budgets'
import type { BudgetPolicyDto, BudgetPolicyPatchBody, NewBudgetPolicyBody } from '~/lib/fleet-types'

/** Which route prefix a page talks to (2a D162): admin = global and runner policies, project = that project's. */
export type BudgetBase = { kind: 'admin' } | { kind: 'project'; slug: string }

export const budgetRoot = (base: BudgetBase): string =>
  base.kind === 'admin' ? '/fleet/budgets' : apiPath`/projects/${base.slug}/fleet/budgets`

export const budgetItem = (base: BudgetBase, id: string): string =>
  base.kind === 'admin' ? apiPath`/fleet/budgets/${id}` : apiPath`/projects/${base.slug}/fleet/budgets/${id}`

/**
 * Mutation epoch, shared by every instance on the page (the page and its dialogs each call this
 * composable): a poll that started before a successful mutation carries older rows and is dropped,
 * the next poll brings fresh ones. Same reasoning as useFleetRunners.
 */
let mutationEpoch = 0

/** Budget policies of one base: the list and the four mutations. Plain arrays, no paging (2a D163). */
export function useFleetBudgets(base: BudgetBase) {
  const { $api } = useApi()
  const policies = ref<BudgetPolicyDto[]>([])
  const pending = ref(false)
  let latestLoadId = 0

  async function load(): Promise<void> {
    const loadId = ++latestLoadId
    const epoch = mutationEpoch
    pending.value = true
    try {
      const rows = await $api.get<BudgetPolicyDto[]>(budgetRoot(base))
      if (loadId !== latestLoadId || epoch !== mutationEpoch) return
      policies.value = sortPolicies(rows ?? [])
    } finally {
      if (loadId === latestLoadId) pending.value = false
    }
  }

  /** Puts a saved row in the list (replacing the same id) and invalidates in-flight loads. */
  function apply(saved: BudgetPolicyDto): void {
    mutationEpoch += 1
    policies.value = sortPolicies([...policies.value.filter((p) => p.id !== saved.id), saved])
  }

  async function create(body: NewBudgetPolicyBody): Promise<BudgetPolicyDto> {
    const created = await $api.post<BudgetPolicyDto>(budgetRoot(base), { ...body })
    apply(created)
    return created
  }

  async function update(id: string, patch: BudgetPolicyPatchBody): Promise<BudgetPolicyDto> {
    const updated = await $api.patch<BudgetPolicyDto>(budgetItem(base, id), { ...patch })
    apply(updated)
    return updated
  }

  /** `amountUsd` omitted keeps the amount; the server refuses an amount not above the window spend. */
  async function resume(id: string, amountUsd?: number): Promise<BudgetPolicyDto> {
    const resumed = await $api.post<BudgetPolicyDto>(`${budgetItem(base, id)}/resume`, amountUsd === undefined ? {} : { amountUsd })
    apply(resumed)
    return resumed
  }

  async function remove(id: string): Promise<void> {
    await $api.delete(budgetItem(base, id))
    mutationEpoch += 1
    policies.value = policies.value.filter((p) => p.id !== id)
  }

  return { policies, pending, load, apply, create, update, resume, remove }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd apps/web && bun run test -- tests/composables/useFleetBudgets.spec.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Write the failing page-state spec**

Create `apps/web/tests/composables/useFleetBudgetPage.spec.ts`:

```ts
import { describe, test, expect, afterEach, jest } from '@jest/globals'
import { join } from 'path'
import { ApiError } from '../../composables/useApi'
import { enI18n, toastRecorder } from '../helpers/fleet-harness'
import type { BudgetPolicyDto } from '../../lib/fleet-types'

const pagePath = join(__dirname, '../..', 'composables', 'useFleetBudgetPage.ts')

const row = (id: string, over: Partial<BudgetPolicyDto> = {}): BudgetPolicyDto => ({
  id, scopeType: 'global', scopeId: null, projectId: null, windowKind: 'calendar_month_utc', amountUsd: '5.0000',
  warnPercent: 80, hardStop: true, runningJobs: 'finish', paused: false, pausedAt: null,
  windowStart: '2026-10-01T00:00:00.000Z', spentUsd: '1.0000', warnReached: false, updatedById: 'u1',
  createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', ...over,
})

interface Setup {
  toasts: ReturnType<typeof toastRecorder>
  api: Record<string, jest.Mock>
}

function setup(api: Record<string, jest.Mock>, confirmResult = true): Setup {
  const toasts = toastRecorder()
  const g = globalThis as Record<string, unknown>
  g.useApi = () => ({ $api: api })
  g.useI18n = () => enI18n()
  g.useAppToast = () => toasts
  g.window = { confirm: () => confirmResult }
  return { toasts, api }
}

describe('useFleetBudgetPage', () => {
  // No jest.resetModules(): a reset would hand the composable a second copy of ApiError and break `instanceof`.
  afterEach(() => {
    const g = globalThis as Record<string, unknown>
    for (const key of ['useApi', 'useI18n', 'useAppToast', 'window']) delete g[key]
  })

  test('isForbidden recognises the envelope 40003 and a plain 403', async () => {
    const { isForbidden } = await import(pagePath)
    expect(isForbidden(new ApiError(40003, 'no'))).toBe(true)
    expect(isForbidden(new ApiError(403, 'no'))).toBe(true)
    expect(isForbidden(new ApiError(500, 'no'))).toBe(false)
    expect(isForbidden(new Error('x'))).toBe(false)
  })

  test('refresh loads the list and ends pending', async () => {
    setup({ get: jest.fn(async () => [row('a')]) })
    const { useFleetBudgetPage } = await import(pagePath)
    const page = useFleetBudgetPage({ kind: 'admin' })
    expect(page.pending.value).toBe(true)

    await page.refresh()

    expect(page.policies.value.map((p) => p.id)).toEqual(['a'])
    expect(page.pending.value).toBe(false)
    expect(page.loadFailed.value).toBe(false)
  })

  test('a failed first load reports once; a later failure only marks the data stale', async () => {
    const get = jest.fn()
      .mockImplementationOnce(async () => { throw new Error('boom') })
      .mockImplementationOnce(async () => [row('a')])
      .mockImplementationOnce(async () => { throw new Error('boom again') })
    const { toasts } = setup({ get })
    const { useFleetBudgetPage } = await import(pagePath)
    const page = useFleetBudgetPage({ kind: 'admin' })

    await page.refresh()
    expect(page.loadFailed.value).toBe(true)
    expect(toasts.errors).toEqual(['boom'])

    await page.refresh()
    expect(page.loadFailed.value).toBe(false)

    await page.refresh()
    expect(page.stale.value).toBe(true)
    expect(page.policies.value).toHaveLength(1)
    expect(toasts.errors).toEqual(['boom'])
  })

  test('a 403 sets forbidden without a toast', async () => {
    const { toasts } = setup({ get: jest.fn(async () => { throw new ApiError(40003, 'forbidden') }) })
    const { useFleetBudgetPage } = await import(pagePath)
    const page = useFleetBudgetPage({ kind: 'admin' })

    await page.refresh()

    expect(page.forbidden.value).toBe(true)
    expect(toasts.errors).toEqual([])
  })

  test('dialog state: create clears the policy, edit and resume carry it', async () => {
    setup({ get: jest.fn(async () => []) })
    const { useFleetBudgetPage } = await import(pagePath)
    const page = useFleetBudgetPage({ kind: 'admin' })
    const p = row('a')

    page.openEdit(p)
    expect([page.editOpen.value, page.editing.value?.id]).toEqual([true, 'a'])
    page.openCreate()
    expect([page.editOpen.value, page.editing.value]).toEqual([true, null])
    page.openResume(p)
    expect([page.resumeOpen.value, page.resuming.value?.id]).toEqual([true, 'a'])
  })

  test('onApplied puts a saved row in the list', async () => {
    setup({ get: jest.fn(async () => [row('a')]) })
    const { useFleetBudgetPage } = await import(pagePath)
    const page = useFleetBudgetPage({ kind: 'admin' })
    await page.refresh()

    page.onApplied(row('a', { amountUsd: '9.0000' }))

    expect(page.policies.value[0].amountUsd).toBe('9.0000')
  })

  test('remove asks first; declined sends nothing', async () => {
    const del = jest.fn(async () => undefined)
    setup({ get: jest.fn(async () => [row('a')]), delete: del }, false)
    const { useFleetBudgetPage } = await import(pagePath)
    const page = useFleetBudgetPage({ kind: 'admin' })
    await page.refresh()

    await page.remove(row('a'), 'sure?')

    expect(del).not.toHaveBeenCalled()
    expect(page.policies.value).toHaveLength(1)
  })

  test('remove deletes, toasts and drops the row', async () => {
    const del = jest.fn(async () => undefined)
    const { toasts } = setup({ get: jest.fn(async () => [row('a')]), delete: del })
    const { useFleetBudgetPage } = await import(pagePath)
    const page = useFleetBudgetPage({ kind: 'admin' })
    await page.refresh()

    await page.remove(row('a'), 'sure?')

    expect(del).toHaveBeenCalledWith('/fleet/budgets/a')
    expect(page.policies.value).toEqual([])
    expect(toasts.successes).toEqual(['Budget policy deleted'])
  })

  test('a delete the server refuses (already gone) toasts its message and reloads (D185)', async () => {
    const get = jest.fn()
      .mockImplementationOnce(async () => [row('a')])
      .mockImplementationOnce(async () => [])
    const del = jest.fn(async () => { throw new ApiError(404, 'Budget policy not found') })
    const { toasts } = setup({ get, delete: del })
    const { useFleetBudgetPage } = await import(pagePath)
    const page = useFleetBudgetPage({ kind: 'admin' })
    await page.refresh()

    await page.remove(row('a'), 'sure?')
    await page.refresh()

    expect(toasts.errors).toEqual(['Budget policy not found'])
    expect(get).toHaveBeenCalledTimes(2)
    expect(page.policies.value).toEqual([])
  })
})
```

Note: the English toast copy asserted above comes from Task 3 (`fleet.budgets.toast.deleted` = "Budget policy deleted"). This spec therefore fails until Task 3 lands; run it at the end of Task 3 (Step 6 there) and keep the code here.

- [ ] **Step 6: Implement `useFleetBudgetPage`**

Create `apps/web/composables/useFleetBudgetPage.ts`:

```ts
import { ref } from 'vue'
import { ApiError, extractApiError } from '~/composables/useApi'
import { useFleetBudgets } from '~/composables/useFleetBudgets'
import type { BudgetBase } from '~/composables/useFleetBudgets'
import type { BudgetPolicyDto } from '~/lib/fleet-types'

/** ApiError.code is the envelope `ret`: a 403 arrives as ret 40003 (see pages/admin/users.vue). */
export function isForbidden(err: unknown): boolean {
  return err instanceof ApiError && (err.code === 40003 || err.code === 403)
}

/**
 * State shared by the admin and project budgets pages (D177): the list with its load/stale/forbidden
 * flags, the create/edit and resume dialog state, and delete. Pages add only their names, their live
 * refresh source and their template.
 */
export function useFleetBudgetPage(base: BudgetBase) {
  const { t } = useI18n()
  const toast = useAppToast()
  const budgets = useFleetBudgets(base)

  const loaded = ref(false)
  const pending = ref(true)
  const loadFailed = ref(false)
  const stale = ref(false)
  const forbidden = ref(false)

  const editOpen = ref(false)
  const editing = ref<BudgetPolicyDto | null>(null)
  const resumeOpen = ref(false)
  const resuming = ref<BudgetPolicyDto | null>(null)

  /** The first load reports; a failed poll keeps the last rows and marks them stale. */
  async function refresh(): Promise<void> {
    try {
      await budgets.load()
      loaded.value = true
      loadFailed.value = false
      stale.value = false
    } catch (err: unknown) {
      if (isForbidden(err)) {
        forbidden.value = true
      } else if (loaded.value) {
        stale.value = true
      } else {
        loadFailed.value = true
        toast.error(extractApiError(err))
      }
    } finally {
      pending.value = false
    }
  }

  function openCreate(): void {
    editing.value = null
    editOpen.value = true
  }

  function openEdit(policy: BudgetPolicyDto): void {
    editing.value = policy
    editOpen.value = true
  }

  function openResume(policy: BudgetPolicyDto): void {
    resuming.value = policy
    resumeOpen.value = true
  }

  /** D186: the confirm text says what deleting a paused policy does. A refusal reloads the list (D185). */
  async function remove(policy: BudgetPolicyDto, confirmText: string): Promise<void> {
    if (!window.confirm(confirmText)) return
    try {
      await budgets.remove(policy.id)
      toast.success(t('fleet.budgets.toast.deleted'))
    } catch (err: unknown) {
      toast.error(extractApiError(err))
      void refresh()
    }
  }

  function onApplied(saved: BudgetPolicyDto): void {
    budgets.apply(saved)
  }

  return {
    policies: budgets.policies, pending, loadFailed, stale, forbidden,
    editOpen, editing, resumeOpen, resuming,
    refresh, openCreate, openEdit, openResume, remove, onApplied,
  }
}
```

- [ ] **Step 7: Commit (the page-state spec runs green at the end of Task 3)**

Run: `cd apps/web && bun run test -- tests/composables/useFleetBudgets.spec.ts`
Expected: PASS.

```bash
git add apps/web/composables/useFleetBudgets.ts apps/web/composables/useFleetBudgetPage.ts apps/web/tests/composables/useFleetBudgets.spec.ts apps/web/tests/composables/useFleetBudgetPage.spec.ts
git commit -m "feat(web): fleet budgets transport and page-state composables"
```

---

### Task 3: Locale strings (en, zh) and parity tests

**Files:**
- Modify: `apps/web/i18n/locales/en.json`, `apps/web/i18n/locales/zh.json`
- Modify: `apps/web/tests/i18n/fleet-locale-parity.spec.ts`

**Interfaces:**
- Produces the keys every later task renders. Dynamic key families (listed in the parity spec): `fleet.budgets.scope.<global|project|repo|runner>`, `fleet.budgets.window.<calendar_month_utc|lifetime>`, `fleet.budgets.status.<paused|warning|ok>`, `fleet.budgets.runningJobs.<finish|cancel>`, `fleet.budgets.hardStop.<on|off>`, `fleet.budgets.scopeText.<type>`, `fleet.budgets.banner.<paused|warning>`.

- [ ] **Step 1: Extend the parity spec first**

In `apps/web/tests/i18n/fleet-locale-parity.spec.ts`, add to the `ENUMS` record (after `'fleet.runners.chip.kind'`):

```ts
  'fleet.budgets.scope': ['global', 'project', 'repo', 'runner'],
  'fleet.budgets.scopeText': ['global', 'project', 'repo', 'runner'],
  'fleet.budgets.window': ['calendar_month_utc', 'lifetime'],
  'fleet.budgets.status': ['paused', 'warning', 'ok'],
  'fleet.budgets.runningJobs': ['finish', 'cancel'],
  'fleet.budgets.hardStop': ['on', 'off'],
  'fleet.budgets.banner': ['paused', 'warning', 'more', 'view'],
```

and extend the translated-nav test list from `['nav.fleetRunners', 'nav.fleetRepos']` to `['nav.fleetRunners', 'nav.fleetRepos', 'nav.fleetBudgets']`.

Run: `cd apps/web && bun run test -- tests/i18n/fleet-locale-parity.spec.ts`
Expected: FAIL (the new enum paths are undefined).

- [ ] **Step 2: English keys**

Edit `apps/web/i18n/locales/en.json` with four anchored edits (never rewrite the file: it does not round-trip through `JSON.stringify`).

1. In `nav`, replace `    "fleetJobs": "Fleet jobs"` with:

```json
    "fleetJobs": "Fleet jobs",
    "fleetBudgets": "Budgets"
```

2. In `fleet.jobs`, replace the line `      "dispatch": "Dispatch",` (the one right under `"subtitle": "nax runs and plans dispatched to fleet runners",`) with:

```json
      "dispatch": "Dispatch",
      "budgets": "Budgets",
```

3. In `fleet.jobs.detail`, replace `        "cancelRequested": "Cancel requested at {at}"` with:

```json
        "cancelRequested": "Cancel requested at {at}",
        "budgetStop": "Stopped by a fleet budget",
        "budgetStopLink": "View budgets"
```

4. Insert this block inside `fleet`, immediately before the line `    "repos": {` (4-space indent, there is exactly one):

```json
    "budgets": {
      "title": "Fleet budgets",
      "subtitleAdmin": "Spending caps for the whole fleet and for single runners.",
      "subtitleProject": "Spending caps for this project and its repos. Fleet-wide caps are shown read-only.",
      "empty": "No budget policies yet.",
      "readOnly": "Only project administrators can change budget policies.",
      "sections": {
        "own": "Project and repo policies",
        "global": "Fleet-wide policies",
        "globalHint": "Set by a global administrator. They apply to every project."
      },
      "actions": {
        "create": "Add policy",
        "edit": "Edit",
        "delete": "Delete",
        "resume": "Resume"
      },
      "table": {
        "scope": "Scope",
        "window": "Window",
        "spend": "Spend",
        "rules": "Rules",
        "status": "Status"
      },
      "scope": {
        "global": "Whole fleet",
        "project": "Project",
        "repo": "Repo",
        "runner": "Runner"
      },
      "scopeText": {
        "global": "the whole fleet",
        "project": "project {name}",
        "repo": "repo {name}",
        "runner": "runner {name}"
      },
      "window": {
        "calendar_month_utc": "Calendar month (UTC)",
        "lifetime": "Lifetime"
      },
      "windowSince": "since {date}",
      "status": {
        "paused": "Paused",
        "warning": "Warning",
        "ok": "Within budget"
      },
      "spend": {
        "of": "{spent} of {amount}",
        "percent": "{percent}%"
      },
      "rules": {
        "warnAt": "Warns at {percent}%",
        "noWarn": "No warning",
        "hardStopOn": "Pauses at the limit",
        "hardStopOff": "Alerts only",
        "runningFinish": "Running jobs finish",
        "runningCancel": "Running jobs are cancelled"
      },
      "pausedSince": "Paused {at}",
      "runningJobs": {
        "finish": "Let running jobs finish",
        "cancel": "Cancel running jobs"
      },
      "hardStop": {
        "on": "Pause the scope at the limit",
        "off": "Only warn, never pause"
      },
      "form": {
        "createTitle": "Add budget policy",
        "editTitle": "Edit budget policy",
        "scopeType": "Scope",
        "scopeRunner": "Runner",
        "scopeRepo": "Repo",
        "choosePlaceholder": "Choose...",
        "windowKind": "Window",
        "amount": "Limit (USD)",
        "amountHint": "Up to 4 decimals, at most 1,000,000.",
        "warnPercent": "Warn at (% of the limit)",
        "warnHint": "A whole number from 1 to 99. Leave blank for no warning.",
        "hardStop": "At the limit",
        "runningJobs": "Running jobs at a hard stop",
        "fixedHint": "Scope and window cannot change after creation. Delete the policy and add a new one instead.",
        "submit": "Save",
        "submitting": "Saving..."
      },
      "resume": {
        "title": "Resume budget",
        "summary": "Spent {spent} of {amount} in this window.",
        "amount": "New limit (USD)",
        "keepHint": "Leave blank to keep the current limit.",
        "raiseHint": "The current limit is not above the spend. Enter a higher limit.",
        "submit": "Resume",
        "submitting": "Resuming..."
      },
      "validation": {
        "amountInvalid": "Enter an amount above 0 with at most 4 decimals, up to 1,000,000.",
        "warnInvalid": "Enter a whole number from 1 to 99, or leave blank.",
        "scopeRequired": "Choose a scope.",
        "amountRequired": "The limit is not above the current spend. Enter a higher limit.",
        "resumeNotAbove": "The limit must be above the current spend of {spent}."
      },
      "toast": {
        "created": "Budget policy created",
        "updated": "Budget policy saved",
        "deleted": "Budget policy deleted",
        "resumed": "Budget resumed"
      },
      "deleteConfirm": "Delete the budget policy for {scope}? A paused scope resumes immediately.",
      "banner": {
        "paused": "Fleet budget paused for {scope}: {spent} of {amount} spent. New jobs are refused until it is resumed.",
        "warning": "Fleet budget for {scope} is at {percent}% ({spent} of {amount}).",
        "more": "and {count} more",
        "view": "View budgets"
      }
    },
```

- [ ] **Step 3: Chinese keys**

The same four edits in `apps/web/i18n/locales/zh.json` (same anchors, the Chinese lines are `    "fleetJobs": "Fleet 任务"`, `      "dispatch": "派发",`, and `        "cancelRequested": "已于 {at} 请求取消"`):

```json
    "fleetJobs": "Fleet 任务",
    "fleetBudgets": "预算"
```

```json
      "dispatch": "派发",
      "budgets": "预算",
```

```json
        "cancelRequested": "已于 {at} 请求取消",
        "budgetStop": "因 Fleet 预算而停止",
        "budgetStopLink": "查看预算"
```

and before `    "repos": {`:

```json
    "budgets": {
      "title": "Fleet 预算",
      "subtitleAdmin": "整个 Fleet 以及单台执行机的支出上限。",
      "subtitleProject": "此项目及其仓库的支出上限。Fleet 全局上限仅供查看。",
      "empty": "暂无预算策略。",
      "readOnly": "只有项目管理员可以修改预算策略。",
      "sections": {
        "own": "项目与仓库策略",
        "global": "Fleet 全局策略",
        "globalHint": "由全局管理员设置，对所有项目生效。"
      },
      "actions": {
        "create": "添加策略",
        "edit": "编辑",
        "delete": "删除",
        "resume": "恢复"
      },
      "table": {
        "scope": "范围",
        "window": "周期",
        "spend": "支出",
        "rules": "规则",
        "status": "状态"
      },
      "scope": {
        "global": "整个 Fleet",
        "project": "项目",
        "repo": "仓库",
        "runner": "执行机"
      },
      "scopeText": {
        "global": "整个 Fleet",
        "project": "项目 {name}",
        "repo": "仓库 {name}",
        "runner": "执行机 {name}"
      },
      "window": {
        "calendar_month_utc": "自然月（UTC）",
        "lifetime": "累计"
      },
      "windowSince": "自 {date} 起",
      "status": {
        "paused": "已暂停",
        "warning": "预警",
        "ok": "预算内"
      },
      "spend": {
        "of": "{spent} / {amount}",
        "percent": "{percent}%"
      },
      "rules": {
        "warnAt": "达到 {percent}% 时预警",
        "noWarn": "不预警",
        "hardStopOn": "达到上限时暂停",
        "hardStopOff": "仅提醒",
        "runningFinish": "运行中的任务继续完成",
        "runningCancel": "取消运行中的任务"
      },
      "pausedSince": "暂停于 {at}",
      "runningJobs": {
        "finish": "让运行中的任务完成",
        "cancel": "取消运行中的任务"
      },
      "hardStop": {
        "on": "达到上限时暂停该范围",
        "off": "仅预警，不暂停"
      },
      "form": {
        "createTitle": "添加预算策略",
        "editTitle": "编辑预算策略",
        "scopeType": "范围",
        "scopeRunner": "执行机",
        "scopeRepo": "仓库",
        "choosePlaceholder": "请选择...",
        "windowKind": "周期",
        "amount": "上限（USD）",
        "amountHint": "最多 4 位小数，不超过 1,000,000。",
        "warnPercent": "预警阈值（占上限的百分比）",
        "warnHint": "1 到 99 的整数，留空表示不预警。",
        "hardStop": "达到上限时",
        "runningJobs": "硬性暂停时对运行中的任务",
        "fixedHint": "创建后范围和周期不可更改。请删除该策略后重新添加。",
        "submit": "保存",
        "submitting": "保存中..."
      },
      "resume": {
        "title": "恢复预算",
        "summary": "本周期已支出 {spent} / {amount}。",
        "amount": "新的上限（USD）",
        "keepHint": "留空则保持当前上限。",
        "raiseHint": "当前上限不高于已支出金额，请输入更高的上限。",
        "submit": "恢复",
        "submitting": "恢复中..."
      },
      "validation": {
        "amountInvalid": "请输入大于 0、最多 4 位小数且不超过 1,000,000 的金额。",
        "warnInvalid": "请输入 1 到 99 的整数，或留空。",
        "scopeRequired": "请选择范围。",
        "amountRequired": "当前上限不高于已支出金额，请输入更高的上限。",
        "resumeNotAbove": "上限必须高于当前已支出的 {spent}。"
      },
      "toast": {
        "created": "预算策略已创建",
        "updated": "预算策略已保存",
        "deleted": "预算策略已删除",
        "resumed": "预算已恢复"
      },
      "deleteConfirm": "删除 {scope} 的预算策略？已暂停的范围将立即恢复。",
      "banner": {
        "paused": "{scope}的 Fleet 预算已暂停：已支出 {spent} / {amount}。恢复前将拒绝新任务。",
        "warning": "{scope}的 Fleet 预算已达 {percent}%（{spent} / {amount}）。",
        "more": "另有 {count} 项",
        "view": "查看预算"
      }
    },
```

- [ ] **Step 4: Validate both files parse and the parity spec passes**

Run: `cd apps/web && node -e "for (const l of ['en','zh']) JSON.parse(require('fs').readFileSync('i18n/locales/'+l+'.json','utf8'))" && git diff --stat i18n`
Expected: no parse error; the diff stat shows insertions only (no deletions other than the three edited lines, each deleted and re-added with a trailing comma).

Run: `cd apps/web && bun run test -- tests/i18n`
Expected: PASS (parity, used-keys, the other i18n specs).

- [ ] **Step 5: Run the page-state spec that was waiting on these strings**

Run: `cd apps/web && bun run test -- tests/composables/useFleetBudgetPage.spec.ts`
Expected: PASS (9 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/web/i18n/locales/en.json apps/web/i18n/locales/zh.json apps/web/tests/i18n/fleet-locale-parity.spec.ts
git commit -m "feat(web): fleet budgets locale strings (en, zh)"
```

---

### Task 4: Create and edit dialog

**Files:**
- Create: `apps/web/components/fleet/BudgetEditDialog.vue`
- Test: `apps/web/tests/components/fleet-budget-edit-dialog.spec.ts`

**Interfaces:**
- Consumes: Task 1 (`buildBudgetSchema`, `initialFormValues`, `needsScopeId`, `scopesFor`, `toCreateBody`, `toPatchBody`), Task 2 (`useFleetBudgets`, `BudgetBase`), Task 3 keys.
- Produces: `<FleetBudgetEditDialog v-model:open :base :policy :repo-options? :runner-options? @saved @failed />`.
  `policy = null` creates; a policy edits it. `repoOptions` / `runnerOptions` are `{ value: string; label: string }[]`
  (default `[]`). Emits `update:open`, `saved(policy: BudgetPolicyDto)`, `failed()` (the server refused; the page reloads).
  Test ids: form `fleet-budget-form`; selects `fleet-budget-scope-type`, `fleet-budget-scope-id`, `fleet-budget-window`,
  `fleet-budget-hard-stop`, `fleet-budget-running-jobs`; inputs `fleet-budget-amount`, `fleet-budget-warn`;
  `fleet-budget-fixed-hint` (edit mode only).

- [ ] **Step 1: Write the failing spec**

Create `apps/web/tests/components/fleet-budget-edit-dialog.spec.ts`:

```ts
import { describe, test, expect, afterEach, jest } from '@jest/globals'
import * as Vue from 'vue'
import { ref, computed, watch, nextTick } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { uiStubs, enI18n, toastRecorder } from '../helpers/fleet-harness'
import * as apiModule from '../../composables/useApi'
import { ApiError } from '../../composables/useApi'
import type { BudgetPolicyDto } from '../../lib/fleet-types'
import type { FakeNode } from '../helpers/mount-sfc'

const dialog = webFile('components', 'fleet', 'BudgetEditDialog.vue')

const policy = (over: Partial<BudgetPolicyDto> = {}): BudgetPolicyDto => ({
  id: 'p1', scopeType: 'global', scopeId: null, projectId: null, windowKind: 'calendar_month_utc', amountUsd: '5.0000',
  warnPercent: 80, hardStop: true, runningJobs: 'finish', paused: false, pausedAt: null,
  windowStart: '2026-10-01T00:00:00.000Z', spentUsd: '1.0000', warnReached: false, updatedById: 'u1',
  createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', ...over,
})

interface Api { post: jest.Mock; patch: jest.Mock }

function harness(over: Partial<Api> = {}) {
  const api: Api = {
    post: jest.fn(async () => policy({ id: 'new' })),
    patch: jest.fn(async (_path: string, body: unknown) => policy({ ...(body as Partial<BudgetPolicyDto>) } as Partial<BudgetPolicyDto>)),
    ...over,
  }
  const toasts = toastRecorder()
  ;(globalThis as Record<string, unknown>).useApi = () => ({ $api: api })
  // vee-validate validates asynchronously, then the request settles: drain both before asserting.
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 6; i += 1) {
      await new Promise((resolve) => { setImmediate(resolve) })
      await new Promise((resolve) => { setTimeout(resolve, 0) })
      await Vue.nextTick()
    }
  }
  return { api, toasts, flush }
}

function mountDialog(props: Record<string, unknown>, api: Api, toasts: ReturnType<typeof toastRecorder>) {
  return mountSfc(dialog, {
    components: uiStubs,
    props,
    alias: { '~/composables/useApi': apiModule },
    globals: {
      ref, computed, watch, nextTick,
      onMounted: Vue.onMounted,
      onBeforeUnmount: Vue.onBeforeUnmount,
      useI18n: () => enI18n(),
      useAppToast: () => toasts,
      useApi: () => ({ $api: api }),
    },
  })
}

const submit = async (app: ReturnType<typeof mountDialog>): Promise<void> => {
  await (app.one('form')?.props.onSubmit as () => Promise<void>)()
}

const selects = (app: ReturnType<typeof mountDialog>): FakeNode[] => app.find('[data-stub="fleet-select"]')
const select = (app: ReturnType<typeof mountDialog>, testid: string): FakeNode | undefined =>
  selects(app).find((s) => s.props.testid === testid)
const optionValues = (node: FakeNode | undefined): string[] =>
  ((node?.props.options ?? []) as Array<{ value: string }>).map((o) => o.value)

afterEach(() => { delete (globalThis as Record<string, unknown>).useApi })

describe('FleetBudgetEditDialog (behaviour)', () => {
  test('editing patches all four editable fields on the admin route, then emits saved and closes', async () => {
    const { api, toasts, flush } = harness()
    const app = mountDialog({ open: true, base: { kind: 'admin' }, policy: policy() }, api, toasts)
    await flush()

    await submit(app)
    await flush()

    expect(api.patch).toHaveBeenCalledWith('/fleet/budgets/p1', { amountUsd: 5, warnPercent: 80, hardStop: true, runningJobs: 'finish' })
    expect(app.emitted('saved')).toHaveLength(1)
    expect(app.emitted('update:open').at(-1)).toEqual([false])
    expect(toasts.successes).toEqual(['Budget policy saved'])
    app.unmount()
  })

  test('the project route patches under the project prefix', async () => {
    const { api, toasts, flush } = harness()
    const app = mountDialog(
      { open: true, base: { kind: 'project', slug: 'koda' }, policy: policy({ scopeType: 'project', scopeId: 'proj1', projectId: 'proj1' }) },
      api, toasts,
    )
    await flush()

    await submit(app)
    await flush()

    expect(api.patch).toHaveBeenCalledWith('/projects/koda/fleet/budgets/p1', expect.objectContaining({ amountUsd: 5 }))
    app.unmount()
  })

  test('a policy without a warn threshold sends an explicit null (blank means "no warning")', async () => {
    const { api, toasts, flush } = harness()
    const app = mountDialog({ open: true, base: { kind: 'admin' }, policy: policy({ warnPercent: null, hardStop: false, runningJobs: 'cancel' }) }, api, toasts)
    await flush()

    await submit(app)
    await flush()

    expect(api.patch).toHaveBeenCalledWith('/fleet/budgets/p1', { amountUsd: 5, warnPercent: null, hardStop: false, runningJobs: 'cancel' })
    app.unmount()
  })

  test('a refusal shows the server message, keeps the dialog open and tells the page to reload', async () => {
    const { api, toasts, flush } = harness({ patch: jest.fn(async () => { throw new ApiError(404, 'Budget policy not found') }) })
    const app = mountDialog({ open: true, base: { kind: 'admin' }, policy: policy() }, api, toasts)
    await flush()

    await submit(app)
    await flush()

    expect(toasts.errors).toEqual(['Budget policy not found'])
    expect(app.emitted('saved')).toHaveLength(0)
    expect(app.emitted('update:open')).toHaveLength(0)
    expect(app.emitted('failed')).toHaveLength(1)
    app.unmount()
  })

  test('creating with an empty limit is blocked before any request', async () => {
    const { api, toasts, flush } = harness()
    const app = mountDialog({ open: true, base: { kind: 'admin' }, policy: null }, api, toasts)
    await flush()

    await submit(app)
    await flush()

    expect(api.post).not.toHaveBeenCalled()
    expect(app.emitted('saved')).toHaveLength(0)
    app.unmount()
  })

  test('create mode offers scope and window; edit mode shows neither, only the fixed-after-create hint', async () => {
    const { api, toasts, flush } = harness()
    const creating = mountDialog({ open: true, base: { kind: 'admin' }, policy: null }, api, toasts)
    await flush()
    expect(selects(creating).map((s) => s.props.testid)).toEqual([
      'fleet-budget-scope-type', 'fleet-budget-window', 'fleet-budget-hard-stop', 'fleet-budget-running-jobs',
    ])
    expect(creating.find('[data-testid="fleet-budget-fixed-hint"]')).toHaveLength(0)
    creating.unmount()

    const editing = mountDialog({ open: true, base: { kind: 'admin' }, policy: policy() }, api, toasts)
    await flush()
    expect(selects(editing).map((s) => s.props.testid)).toEqual(['fleet-budget-hard-stop', 'fleet-budget-running-jobs'])
    expect(editing.find('[data-testid="fleet-budget-fixed-hint"]')).toHaveLength(1)
    editing.unmount()
  })

  test('each route offers its own scope types (2a D162)', async () => {
    const { api, toasts, flush } = harness()
    const admin = mountDialog({ open: true, base: { kind: 'admin' }, policy: null }, api, toasts)
    await flush()
    expect(optionValues(select(admin, 'fleet-budget-scope-type'))).toEqual(['global', 'runner'])
    admin.unmount()

    const project = mountDialog({ open: true, base: { kind: 'project', slug: 'koda' }, policy: null }, api, toasts)
    await flush()
    expect(optionValues(select(project, 'fleet-budget-scope-type'))).toEqual(['project', 'repo'])
    project.unmount()
  })

  test('the window, hard-stop and running-jobs selects list the API values', async () => {
    const { api, toasts, flush } = harness()
    const app = mountDialog({ open: true, base: { kind: 'admin' }, policy: null }, api, toasts)
    await flush()
    expect(optionValues(select(app, 'fleet-budget-window'))).toEqual(['calendar_month_utc', 'lifetime'])
    expect(optionValues(select(app, 'fleet-budget-hard-stop'))).toEqual(['true', 'false'])
    expect(optionValues(select(app, 'fleet-budget-running-jobs'))).toEqual(['finish', 'cancel'])
    app.unmount()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/web && bun run test -- tests/components/fleet-budget-edit-dialog.spec.ts`
Expected: FAIL, cannot resolve `BudgetEditDialog.vue`.

- [ ] **Step 3: Implement the dialog**

Create `apps/web/components/fleet/BudgetEditDialog.vue`:

```vue
<template>
  <Dialog :open="open" @update:open="$emit('update:open', $event)">
    <DialogContent class="sm:max-w-[520px]">
      <DialogHeader>
        <DialogTitle>{{ policy ? t('fleet.budgets.form.editTitle') : t('fleet.budgets.form.createTitle') }}</DialogTitle>
      </DialogHeader>

      <form class="space-y-4" data-testid="fleet-budget-form" @submit="onSubmit">
        <template v-if="!policy">
          <FormField v-slot="{ componentField }" name="scopeType">
            <FormItem>
              <FormLabel>{{ t('fleet.budgets.form.scopeType') }}</FormLabel>
              <FormControl>
                <FleetNativeSelect v-bind="componentField" :options="scopeOptions" testid="fleet-budget-scope-type" />
              </FormControl>
              <FormMessage />
            </FormItem>
          </FormField>

          <template v-if="needsTarget">
            <FormField v-slot="{ componentField }" name="scopeId">
              <FormItem>
                <FormLabel>{{ targetLabel }}</FormLabel>
                <FormControl>
                  <FleetNativeSelect
                    v-bind="componentField"
                    :options="targetOptions"
                    :placeholder="t('fleet.budgets.form.choosePlaceholder')"
                    testid="fleet-budget-scope-id"
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            </FormField>
          </template>

          <FormField v-slot="{ componentField }" name="windowKind">
            <FormItem>
              <FormLabel>{{ t('fleet.budgets.form.windowKind') }}</FormLabel>
              <FormControl>
                <FleetNativeSelect v-bind="componentField" :options="windowOptions" testid="fleet-budget-window" />
              </FormControl>
              <FormMessage />
            </FormItem>
          </FormField>
        </template>
        <p v-else class="text-sm text-muted-foreground" data-testid="fleet-budget-fixed-hint">{{ t('fleet.budgets.form.fixedHint') }}</p>

        <FormField v-slot="{ componentField }" name="amountUsd">
          <FormItem>
            <FormLabel>{{ t('fleet.budgets.form.amount') }}</FormLabel>
            <FormControl><Input v-bind="componentField" inputmode="decimal" data-testid="fleet-budget-amount" /></FormControl>
            <p class="text-xs text-muted-foreground">{{ t('fleet.budgets.form.amountHint') }}</p>
            <FormMessage />
          </FormItem>
        </FormField>

        <FormField v-slot="{ componentField }" name="warnPercent">
          <FormItem>
            <FormLabel>{{ t('fleet.budgets.form.warnPercent') }}</FormLabel>
            <FormControl><Input v-bind="componentField" inputmode="numeric" data-testid="fleet-budget-warn" /></FormControl>
            <p class="text-xs text-muted-foreground">{{ t('fleet.budgets.form.warnHint') }}</p>
            <FormMessage />
          </FormItem>
        </FormField>

        <FormField v-slot="{ componentField }" name="hardStop">
          <FormItem>
            <FormLabel>{{ t('fleet.budgets.form.hardStop') }}</FormLabel>
            <FormControl>
              <FleetNativeSelect v-bind="componentField" :options="hardStopOptions" testid="fleet-budget-hard-stop" />
            </FormControl>
            <FormMessage />
          </FormItem>
        </FormField>

        <FormField v-slot="{ componentField }" name="runningJobs">
          <FormItem>
            <FormLabel>{{ t('fleet.budgets.form.runningJobs') }}</FormLabel>
            <FormControl>
              <FleetNativeSelect v-bind="componentField" :options="runningOptions" testid="fleet-budget-running-jobs" />
            </FormControl>
            <FormMessage />
          </FormItem>
        </FormField>

        <div class="flex justify-end gap-2">
          <Button type="button" variant="outline" @click="$emit('update:open', false)">{{ t('common.cancel') }}</Button>
          <Button type="submit" :disabled="isSubmitting" data-testid="fleet-budget-submit">
            {{ isSubmitting ? t('fleet.budgets.form.submitting') : t('fleet.budgets.form.submit') }}
          </Button>
        </div>
      </form>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { computed, watch } from 'vue'
import { useForm } from 'vee-validate'
import { toTypedSchema } from '@vee-validate/zod'
import { extractApiError } from '~/composables/useApi'
import { useFleetBudgets } from '~/composables/useFleetBudgets'
import type { BudgetBase } from '~/composables/useFleetBudgets'
import { buildBudgetSchema, initialFormValues, needsScopeId, scopesFor, toCreateBody, toPatchBody } from '~/lib/fleet-budgets'
import { BUDGET_RUNNING_JOBS, BUDGET_WINDOW_KINDS } from '~/lib/fleet-types'
import type { BudgetPolicyDto } from '~/lib/fleet-types'

const props = withDefaults(defineProps<{
  open: boolean
  base: BudgetBase
  /** null creates a policy; a policy edits it (scope and window stay fixed, 2a D161). */
  policy: BudgetPolicyDto | null
  repoOptions?: Array<{ value: string; label: string }>
  runnerOptions?: Array<{ value: string; label: string }>
}>(), { repoOptions: () => [], runnerOptions: () => [] })

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void
  (e: 'saved', policy: BudgetPolicyDto): void
  (e: 'failed'): void
}>()

const { t } = useI18n()
const toast = useAppToast()
const { create, update } = useFleetBudgets(props.base)

const scopeOptions = computed(() => scopesFor(props.base.kind).map((scope) => ({ value: scope, label: t(`fleet.budgets.scope.${scope}`) })))
const windowOptions = computed(() => BUDGET_WINDOW_KINDS.map((kind) => ({ value: kind, label: t(`fleet.budgets.window.${kind}`) })))
const hardStopOptions = computed(() => [
  { value: 'true', label: t('fleet.budgets.hardStop.on') },
  { value: 'false', label: t('fleet.budgets.hardStop.off') },
])
const runningOptions = computed(() => BUDGET_RUNNING_JOBS.map((mode) => ({ value: mode, label: t(`fleet.budgets.runningJobs.${mode}`) })))

const { handleSubmit, isSubmitting, resetForm, values: formValues, setFieldValue } = useForm({
  validationSchema: toTypedSchema(buildBudgetSchema(t)),
  initialValues: initialFormValues(props.base.kind, props.policy),
})

const needsTarget = computed(() => needsScopeId(formValues.scopeType ?? 'global'))
const targetOptions = computed(() => (formValues.scopeType === 'runner' ? props.runnerOptions : props.repoOptions))
const targetLabel = computed(() => (formValues.scopeType === 'runner' ? t('fleet.budgets.form.scopeRunner') : t('fleet.budgets.form.scopeRepo')))

// The dialog is reused across rows and between create and edit: reload the values whenever it opens.
watch(() => [props.open, props.policy?.id] as const, ([open]) => {
  if (open) resetForm({ values: initialFormValues(props.base.kind, props.policy) })
})

// A target picked for one scope type means nothing for the other.
watch(() => formValues.scopeType, (next, previous) => {
  if (!props.policy && next !== previous) setFieldValue('scopeId', '')
})

const onSubmit = handleSubmit(async (values) => {
  try {
    const saved = props.policy
      ? await update(props.policy.id, toPatchBody(values))
      : await create(toCreateBody(values))
    toast.success(t(props.policy ? 'fleet.budgets.toast.updated' : 'fleet.budgets.toast.created'))
    emit('saved', saved)
    emit('update:open', false)
  } catch (err: unknown) {
    // D185: stay open so the admin keeps their input; the page reloads in case the view is stale.
    toast.error(extractApiError(err))
    emit('failed')
  }
})
</script>
```

- [ ] **Step 4: Run the spec**

Run: `cd apps/web && bun run test -- tests/components/fleet-budget-edit-dialog.spec.ts`
Expected: PASS (8 tests). If the `selects` order assertion fails because the stub list also contains selects from a nested template, print `selects(app).map((s) => s.props.testid)` and fix the template order, not the test.

- [ ] **Step 5: Lint and commit**

Run: `cd apps/web && bunx eslint components/fleet/BudgetEditDialog.vue tests/components/fleet-budget-edit-dialog.spec.ts --max-warnings=0`
Expected: no output.

```bash
git add apps/web/components/fleet/BudgetEditDialog.vue apps/web/tests/components/fleet-budget-edit-dialog.spec.ts
git commit -m "feat(web): fleet budget create and edit dialog"
```

---

### Task 5: Resume dialog

**Files:**
- Create: `apps/web/components/fleet/BudgetResumeDialog.vue`
- Test: `apps/web/tests/components/fleet-budget-resume-dialog.spec.ts`

**Interfaces:**
- Consumes: Task 1 (`buildResumeSchema`, `isAboveSpend`, `toResumeAmount`, `formatUsd` from `~/lib/fleet-jobs`), Task 2 (`useFleetBudgets`).
- Produces: `<FleetBudgetResumeDialog v-model:open :base :policy @resumed @failed />` with a required `policy`
  (mount it with `v-if="policy" :key="policy.id"` so the schema is built per policy). Emits `update:open`,
  `resumed(policy: BudgetPolicyDto)`, `failed()`. Test ids: `fleet-budget-resume-summary`, `fleet-budget-resume-form`,
  `fleet-budget-resume-amount`, `fleet-budget-resume-hint`.

- [ ] **Step 1: Write the failing spec**

Create `apps/web/tests/components/fleet-budget-resume-dialog.spec.ts`:

```ts
import { describe, test, expect, afterEach, jest } from '@jest/globals'
import * as Vue from 'vue'
import { ref, computed, watch, nextTick } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { uiStubs, enI18n, toastRecorder } from '../helpers/fleet-harness'
import * as apiModule from '../../composables/useApi'
import { ApiError } from '../../composables/useApi'
import type { BudgetPolicyDto } from '../../lib/fleet-types'

const dialog = webFile('components', 'fleet', 'BudgetResumeDialog.vue')

const paused = (over: Partial<BudgetPolicyDto> = {}): BudgetPolicyDto => ({
  id: 'p1', scopeType: 'global', scopeId: null, projectId: null, windowKind: 'calendar_month_utc', amountUsd: '10.0000',
  warnPercent: 80, hardStop: true, runningJobs: 'finish', paused: true, pausedAt: '2026-10-02T00:00:00.000Z',
  windowStart: '2026-10-01T00:00:00.000Z', spentUsd: '9.0000', warnReached: true, updatedById: 'u1',
  createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z', ...over,
})

function harness(over: { post?: jest.Mock } = {}) {
  const api = { post: jest.fn(async () => paused({ paused: false, pausedAt: null })), ...over }
  const toasts = toastRecorder()
  ;(globalThis as Record<string, unknown>).useApi = () => ({ $api: api })
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 6; i += 1) {
      await new Promise((resolve) => { setImmediate(resolve) })
      await new Promise((resolve) => { setTimeout(resolve, 0) })
      await Vue.nextTick()
    }
  }
  return { api, toasts, flush }
}

function mountDialog(props: Record<string, unknown>, api: { post: jest.Mock }, toasts: ReturnType<typeof toastRecorder>) {
  return mountSfc(dialog, {
    components: uiStubs,
    props,
    alias: { '~/composables/useApi': apiModule },
    globals: {
      ref, computed, watch, nextTick,
      onMounted: Vue.onMounted,
      onBeforeUnmount: Vue.onBeforeUnmount,
      useI18n: () => enI18n(),
      useAppToast: () => toasts,
      useApi: () => ({ $api: api }),
    },
  })
}

const submit = async (app: ReturnType<typeof mountDialog>): Promise<void> => {
  await (app.one('form')?.props.onSubmit as () => Promise<void>)()
}

afterEach(() => { delete (globalThis as Record<string, unknown>).useApi })

describe('FleetBudgetResumeDialog (behaviour)', () => {
  test('shows how much was spent against the limit', async () => {
    const { api, toasts, flush } = harness()
    const app = mountDialog({ open: true, base: { kind: 'admin' }, policy: paused() }, api, toasts)
    await flush()

    const summary = app.find('[data-testid="fleet-budget-resume-summary"]')
    expect(summary).toHaveLength(1)
    expect(app.textOf(summary[0])).toBe('Spent $9.00 of $10.00 in this window.')
    app.unmount()
  })

  test('a blank amount resumes with an empty body, then emits resumed and closes', async () => {
    const { api, toasts, flush } = harness()
    const app = mountDialog({ open: true, base: { kind: 'admin' }, policy: paused() }, api, toasts)
    await flush()

    await submit(app)
    await flush()

    expect(api.post).toHaveBeenCalledWith('/fleet/budgets/p1/resume', {})
    expect(app.emitted('resumed')).toHaveLength(1)
    expect(app.emitted('update:open').at(-1)).toEqual([false])
    expect(toasts.successes).toEqual(['Budget resumed'])
    app.unmount()
  })

  test('the project route resumes under the project prefix', async () => {
    const { api, toasts, flush } = harness()
    const app = mountDialog(
      { open: true, base: { kind: 'project', slug: 'koda' }, policy: paused({ scopeType: 'project', scopeId: 'proj1', projectId: 'proj1' }) },
      api, toasts,
    )
    await flush()

    await submit(app)
    await flush()

    expect(api.post).toHaveBeenCalledWith('/projects/koda/fleet/budgets/p1/resume', {})
    app.unmount()
  })

  test('a lowered limit (not above the spend) cannot be resumed without a new limit (Review Focus 2)', async () => {
    const { api, toasts, flush } = harness()
    const app = mountDialog({ open: true, base: { kind: 'admin' }, policy: paused({ amountUsd: '2.0000', spentUsd: '3.0000' }) }, api, toasts)
    await flush()

    await submit(app)
    await flush()

    expect(api.post).not.toHaveBeenCalled()
    expect(app.emitted('resumed')).toHaveLength(0)
    const hint = app.find('[data-testid="fleet-budget-resume-hint"]')
    expect(app.textOf(hint[0])).toBe('The current limit is not above the spend. Enter a higher limit.')
    app.unmount()
  })

  test('a limit exactly equal to the spend is also blocked, whatever the trailing zeros (Review Focus 1)', async () => {
    const { api, toasts, flush } = harness()
    const app = mountDialog({ open: true, base: { kind: 'admin' }, policy: paused({ amountUsd: '3', spentUsd: '3.0000' }) }, api, toasts)
    await flush()

    await submit(app)
    await flush()

    expect(api.post).not.toHaveBeenCalled()
    app.unmount()
  })

  test('with room left the hint says a blank keeps the limit', async () => {
    const { api, toasts, flush } = harness()
    const app = mountDialog({ open: true, base: { kind: 'admin' }, policy: paused() }, api, toasts)
    await flush()

    const hint = app.find('[data-testid="fleet-budget-resume-hint"]')
    expect(app.textOf(hint[0])).toBe('Leave blank to keep the current limit.')
    app.unmount()
  })

  test('a refusal (already resumed elsewhere) shows the server message and asks the page to reload (D185)', async () => {
    const { api, toasts, flush } = harness({ post: jest.fn(async () => { throw new ApiError(409, 'This budget policy is not paused') }) })
    const app = mountDialog({ open: true, base: { kind: 'admin' }, policy: paused() }, api, toasts)
    await flush()

    await submit(app)
    await flush()

    expect(toasts.errors).toEqual(['This budget policy is not paused'])
    expect(app.emitted('resumed')).toHaveLength(0)
    expect(app.emitted('failed')).toHaveLength(1)
    expect(app.emitted('update:open')).toHaveLength(0)
    app.unmount()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/web && bun run test -- tests/components/fleet-budget-resume-dialog.spec.ts`
Expected: FAIL, cannot resolve `BudgetResumeDialog.vue`.

- [ ] **Step 3: Implement the dialog**

Create `apps/web/components/fleet/BudgetResumeDialog.vue`:

```vue
<template>
  <Dialog :open="open" @update:open="$emit('update:open', $event)">
    <DialogContent class="sm:max-w-[460px]">
      <DialogHeader>
        <DialogTitle>{{ t('fleet.budgets.resume.title') }}</DialogTitle>
      </DialogHeader>

      <p class="text-sm" data-testid="fleet-budget-resume-summary">
        {{ t('fleet.budgets.resume.summary', { spent: formatUsd(policy.spentUsd), amount: formatUsd(policy.amountUsd) }) }}
      </p>

      <form class="space-y-4" data-testid="fleet-budget-resume-form" @submit="onSubmit">
        <FormField v-slot="{ componentField }" name="amountUsd">
          <FormItem>
            <FormLabel>{{ t('fleet.budgets.resume.amount') }}</FormLabel>
            <FormControl><Input v-bind="componentField" inputmode="decimal" data-testid="fleet-budget-resume-amount" /></FormControl>
            <p class="text-xs text-muted-foreground" data-testid="fleet-budget-resume-hint">
              {{ needsRaise ? t('fleet.budgets.resume.raiseHint') : t('fleet.budgets.resume.keepHint') }}
            </p>
            <FormMessage />
          </FormItem>
        </FormField>

        <div class="flex justify-end gap-2">
          <Button type="button" variant="outline" @click="$emit('update:open', false)">{{ t('common.cancel') }}</Button>
          <Button type="submit" :disabled="isSubmitting" data-testid="fleet-budget-resume-submit">
            {{ isSubmitting ? t('fleet.budgets.resume.submitting') : t('fleet.budgets.resume.submit') }}
          </Button>
        </div>
      </form>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { watch } from 'vue'
import { useForm } from 'vee-validate'
import { toTypedSchema } from '@vee-validate/zod'
import { extractApiError } from '~/composables/useApi'
import { useFleetBudgets } from '~/composables/useFleetBudgets'
import type { BudgetBase } from '~/composables/useFleetBudgets'
import { buildResumeSchema, isAboveSpend, toResumeAmount } from '~/lib/fleet-budgets'
import { formatUsd } from '~/lib/fleet-jobs'
import type { BudgetPolicyDto } from '~/lib/fleet-types'

// Mounted per policy (`v-if` + `:key` on the page), so the schema below is built once for this policy.
const props = defineProps<{ open: boolean; base: BudgetBase; policy: BudgetPolicyDto }>()

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void
  (e: 'resumed', policy: BudgetPolicyDto): void
  (e: 'failed'): void
}>()

const { t } = useI18n()
const toast = useAppToast()
const { resume } = useFleetBudgets(props.base)

/** D184: a limit that is not above the spend cannot be kept, a new one is required. */
const needsRaise = !isAboveSpend(props.policy.amountUsd, props.policy.spentUsd)

const { handleSubmit, isSubmitting, resetForm } = useForm({
  validationSchema: toTypedSchema(buildResumeSchema(t, props.policy)),
  initialValues: { amountUsd: '' },
})

watch(() => props.open, (open) => {
  if (open) resetForm()
})

const onSubmit = handleSubmit(async (values) => {
  try {
    const resumed = await resume(props.policy.id, toResumeAmount(values.amountUsd))
    toast.success(t('fleet.budgets.toast.resumed'))
    emit('resumed', resumed)
    emit('update:open', false)
  } catch (err: unknown) {
    // D185: 409 fleet.budgetNotPaused or 404 means the view is stale; the server's message says which.
    toast.error(extractApiError(err))
    emit('failed')
  }
})
</script>
```

- [ ] **Step 4: Run the spec**

Run: `cd apps/web && bun run test -- tests/components/fleet-budget-resume-dialog.spec.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Lint and commit**

Run: `cd apps/web && bunx eslint components/fleet/BudgetResumeDialog.vue tests/components/fleet-budget-resume-dialog.spec.ts --max-warnings=0`
Expected: no output.

```bash
git add apps/web/components/fleet/BudgetResumeDialog.vue apps/web/tests/components/fleet-budget-resume-dialog.spec.ts
git commit -m "feat(web): fleet budget resume dialog"
```

---

### Task 6: Policy table (and the harness additions the pages need)

**Files:**
- Create: `apps/web/components/fleet/BudgetTable.vue`
- Modify: `apps/web/tests/helpers/mount-sfc.ts` (`FLEET_COMPONENT_FILES`, `FleetComponentName`)
- Modify: `apps/web/tests/helpers/fleet-harness.ts` (stubs: `ErrorState`, the two budget dialogs)
- Test: `apps/web/tests/components/fleet-budget-table.spec.ts`

**Interfaces:**
- Consumes: Task 1 (`budgetStatus`, `spendPercent`, `windowSinceDate`), `codeLabel` from `~/lib/fleet-i18n`, `formatUsd`.
- Produces: `<FleetBudgetTable :policies :editable :scope-name :testid? @edit @remove @resume />`.
  `scopeName: (policy: BudgetPolicyDto) => string | null`. Rows carry `data-testid="fleet-budget-row-<id>"` and
  `data-status="paused|warning|ok"`; the status badge `data-testid="fleet-budget-status"`; the spend text
  `fleet-budget-spend`. Buttons (only when `editable`): Resume (only on a `paused` row), Edit, Delete.
  Harness: `mountSfc(..., { fleetComponents: ['FleetBudgetTable'] })` mounts the real table; `uiStubs` gains
  `ErrorState` (`data-stub="error-state"`), `FleetBudgetEditDialog` (`data-stub="fleet-budget-edit-dialog"`, attrs
  `open`, `data-policy` = policy id or `''`) and `FleetBudgetResumeDialog` (`data-stub="fleet-budget-resume-dialog"`, same).

- [ ] **Step 1: Extend the harness**

In `apps/web/tests/helpers/mount-sfc.ts`, change the file map and the name type:

```ts
const FLEET_COMPONENT_FILES: Record<FleetComponentName, string> = {
  FleetAge: 'Age.vue',
  FleetRunnerCapabilityChips: 'RunnerCapabilityChips.vue',
  FleetRepoReachabilityBadge: 'RepoReachabilityBadge.vue',
  FleetNativeSelect: 'NativeSelect.vue',
  FleetBudgetTable: 'BudgetTable.vue',
}
```

```ts
export type FleetComponentName =
  | 'FleetAge' | 'FleetRunnerCapabilityChips' | 'FleetRepoReachabilityBadge' | 'FleetNativeSelect' | 'FleetBudgetTable'
```

In `apps/web/tests/helpers/fleet-harness.ts`, add `['ErrorState', 'error-state'],` to the stub list (next to `['LoadingState', 'loading-state'], ['EmptyState', 'empty-state'],`) and, after the `FleetEnrollmentTokenDialog` stub inside the existing `Object.assign(uiStubs, { ... })`, add:

```ts
  FleetBudgetEditDialog: {
    name: 'StubFleetBudgetEditDialog',
    props: ['open', 'policy'],
    setup(props: { open?: boolean; policy?: { id?: string } | null }, { attrs }: { attrs: Record<string, unknown> }) {
      return () =>
        h('x-stub-stub', { ...attrs, 'data-stub': 'fleet-budget-edit-dialog', open: props.open === true, 'data-policy': props.policy?.id ?? '' })
    },
  },
  FleetBudgetResumeDialog: {
    name: 'StubFleetBudgetResumeDialog',
    props: ['open', 'policy'],
    setup(props: { open?: boolean; policy?: { id?: string } | null }, { attrs }: { attrs: Record<string, unknown> }) {
      return () =>
        h('x-stub-stub', { ...attrs, 'data-stub': 'fleet-budget-resume-dialog', open: props.open === true, 'data-policy': props.policy?.id ?? '' })
    },
  },
```

- [ ] **Step 2: Write the failing table spec**

Create `apps/web/tests/components/fleet-budget-table.spec.ts`:

```ts
import { describe, test, expect } from '@jest/globals'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { uiStubs, enI18n } from '../helpers/fleet-harness'
import type { BudgetPolicyDto } from '../../lib/fleet-types'
import type { FakeNode } from '../helpers/mount-sfc'

const table = webFile('components', 'fleet', 'BudgetTable.vue')

const policy = (id: string, over: Partial<BudgetPolicyDto> = {}): BudgetPolicyDto => ({
  id, scopeType: 'global', scopeId: null, projectId: null, windowKind: 'calendar_month_utc', amountUsd: '5.0000',
  warnPercent: 80, hardStop: true, runningJobs: 'finish', paused: false, pausedAt: null,
  windowStart: '2026-10-01T00:00:00.000Z', spentUsd: '1.0000', warnReached: false, updatedById: 'u1',
  createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', ...over,
})

function mountTable(policies: BudgetPolicyDto[], editable: boolean, scopeName: (p: BudgetPolicyDto) => string | null = () => null) {
  return mountSfc(table, {
    components: uiStubs,
    props: { policies, editable, scopeName },
    globals: { useI18n: () => enI18n() },
  })
}

const rowOf = (app: ReturnType<typeof mountTable>, id: string): FakeNode => {
  const row = app.find('[data-stub="tr"]').find((r) => r.props['data-testid'] === `fleet-budget-row-${id}`)
  if (!row) throw new Error(`no row ${id}`)
  return row
}
const buttonLabels = (app: ReturnType<typeof mountTable>, id: string): string[] =>
  app.find('[data-stub="button"]', rowOf(app, id)).map((b) => app.textOf(b))

describe('FleetBudgetTable', () => {
  test('one row per policy with the scope name, window and spend text', () => {
    const app = mountTable(
      [
        policy('g'),
        policy('r', { scopeType: 'repo', scopeId: 'r1', windowKind: 'lifetime', spentUsd: '2.5000' }),
      ],
      false,
      (p) => (p.scopeType === 'repo' ? 'acme/app' : null),
    )
    const repo = app.textOf(rowOf(app, 'r'))
    expect(repo).toContain('Repo')
    expect(repo).toContain('acme/app')
    expect(repo).toContain('Lifetime')
    expect(repo).toContain('$2.50 of $5.00')
    expect(repo).toContain('50%')
    const global = app.textOf(rowOf(app, 'g'))
    expect(global).toContain('Whole fleet')
    expect(global).toContain('Calendar month (UTC)')
    expect(global).toContain('since 2026-10-01')
    app.unmount()
  })

  test('status follows the server flags and the row carries it', () => {
    const app = mountTable([policy('ok'), policy('warn', { warnReached: true, scopeId: 'w' }), policy('stop', { paused: true, warnReached: true, scopeId: 'z' })], false)
    expect(['ok', 'warn', 'stop'].map((id) => rowOf(app, id).props['data-status'])).toEqual(['ok', 'warning', 'paused'])
    expect(app.textOf(rowOf(app, 'ok'))).toContain('Within budget')
    expect(app.textOf(rowOf(app, 'warn'))).toContain('Warning')
    expect(app.textOf(rowOf(app, 'stop'))).toContain('Paused')
    app.unmount()
  })

  test('the percentage is floored: 4.99 of 5.00 shows 99%, never 100%', () => {
    const app = mountTable([policy('a', { spentUsd: '4.9900' })], false)
    expect(app.textOf(rowOf(app, 'a'))).toContain('99%')
    app.unmount()
  })

  test('rules: warn threshold or none, hard stop or alert only, running-jobs mode only when it applies', () => {
    const app = mountTable([
      policy('a', { warnPercent: 90, runningJobs: 'cancel' }),
      policy('b', { warnPercent: null, hardStop: false, scopeId: 'b' }),
    ], false)
    const a = app.textOf(rowOf(app, 'a'))
    expect(a).toContain('Warns at 90%')
    expect(a).toContain('Pauses at the limit')
    expect(a).toContain('Running jobs are cancelled')
    const b = app.textOf(rowOf(app, 'b'))
    expect(b).toContain('No warning')
    expect(b).toContain('Alerts only')
    expect(b).not.toContain('Running jobs')
    app.unmount()
  })

  test('a read-only table has no buttons at all (Review Focus 3)', () => {
    const app = mountTable([policy('a', { paused: true })], false)
    expect(buttonLabels(app, 'a')).toEqual([])
    app.unmount()
  })

  test('an editable table offers Edit and Delete, and Resume only on a paused row', () => {
    const app = mountTable([policy('ok'), policy('stop', { paused: true, scopeId: 's' })], true)
    expect(buttonLabels(app, 'ok')).toEqual(['Edit', 'Delete'])
    expect(buttonLabels(app, 'stop')).toEqual(['Resume', 'Edit', 'Delete'])
    app.unmount()
  })

  test('the buttons emit the row policy', () => {
    const rows = [policy('stop', { paused: true })]
    const app = mountTable(rows, true)
    const click = (label: string): void => {
      const button = app.find('[data-stub="button"]', rowOf(app, 'stop')).find((b) => app.textOf(b) === label)
      ;(button?.props.onClick as () => void)()
    }
    click('Resume')
    click('Edit')
    click('Delete')
    expect(app.emitted('resume')).toEqual([[rows[0]]])
    expect(app.emitted('edit')).toEqual([[rows[0]]])
    expect(app.emitted('remove')).toEqual([[rows[0]]])
    app.unmount()
  })

  test('a paused row shows when it was paused', () => {
    const app = mountTable([policy('stop', { paused: true, pausedAt: '2026-10-02T03:04:05.000Z' })], false)
    // The badge says Paused; the line under it says Paused <local date and time>.
    expect(app.textOf(rowOf(app, 'stop'))).toMatch(/Paused\s*Paused \S/)
    app.unmount()
  })
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd apps/web && bun run test -- tests/components/fleet-budget-table.spec.ts`
Expected: FAIL, cannot resolve `BudgetTable.vue`.

- [ ] **Step 4: Implement the table**

Create `apps/web/components/fleet/BudgetTable.vue`:

```vue
<template>
  <div class="overflow-x-auto" :data-testid="testid">
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{{ t('fleet.budgets.table.scope') }}</TableHead>
          <TableHead>{{ t('fleet.budgets.table.window') }}</TableHead>
          <TableHead>{{ t('fleet.budgets.table.spend') }}</TableHead>
          <TableHead>{{ t('fleet.budgets.table.rules') }}</TableHead>
          <TableHead>{{ t('fleet.budgets.table.status') }}</TableHead>
          <TableHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow
          v-for="policy in policies"
          :key="policy.id"
          :data-testid="`fleet-budget-row-${policy.id}`"
          :data-status="budgetStatus(policy)"
        >
          <TableCell>
            <div class="font-medium">{{ label('fleet.budgets.scope', policy.scopeType) }}</div>
            <div v-if="scopeName(policy)" class="break-all text-xs text-muted-foreground">{{ scopeName(policy) }}</div>
          </TableCell>
          <TableCell>
            <div>{{ label('fleet.budgets.window', policy.windowKind) }}</div>
            <div v-if="policy.windowKind === 'calendar_month_utc'" class="text-xs text-muted-foreground">
              {{ t('fleet.budgets.windowSince', { date: windowSinceDate(policy.windowStart) }) }}
            </div>
          </TableCell>
          <TableCell class="min-w-[10rem]">
            <div data-testid="fleet-budget-spend">
              {{ t('fleet.budgets.spend.of', { spent: formatUsd(policy.spentUsd), amount: formatUsd(policy.amountUsd) }) }}
            </div>
            <div
              class="mt-1 h-1.5 w-full rounded bg-muted"
              role="progressbar"
              aria-valuemin="0"
              aria-valuemax="100"
              :aria-valuenow="percent(policy)"
            >
              <div class="h-1.5 rounded" :class="barClass(policy)" :style="{ width: `${percent(policy)}%` }" />
            </div>
            <div class="text-xs text-muted-foreground">{{ t('fleet.budgets.spend.percent', { percent: percent(policy) }) }}</div>
          </TableCell>
          <TableCell class="text-sm">
            <div>{{ policy.warnPercent === null ? t('fleet.budgets.rules.noWarn') : t('fleet.budgets.rules.warnAt', { percent: policy.warnPercent }) }}</div>
            <div>{{ policy.hardStop ? t('fleet.budgets.rules.hardStopOn') : t('fleet.budgets.rules.hardStopOff') }}</div>
            <div v-if="policy.hardStop">
              {{ policy.runningJobs === 'cancel' ? t('fleet.budgets.rules.runningCancel') : t('fleet.budgets.rules.runningFinish') }}
            </div>
          </TableCell>
          <TableCell>
            <Badge :variant="badgeVariant(policy)" data-testid="fleet-budget-status">{{ label('fleet.budgets.status', budgetStatus(policy)) }}</Badge>
            <div v-if="policy.paused && policy.pausedAt" class="mt-1 text-xs text-muted-foreground">
              {{ t('fleet.budgets.pausedSince', { at: new Date(policy.pausedAt).toLocaleString() }) }}
            </div>
          </TableCell>
          <TableCell class="space-x-1 whitespace-nowrap text-right">
            <template v-if="editable">
              <Button v-if="policy.paused" size="sm" data-testid="fleet-budget-resume" @click="emit('resume', policy)">
                {{ t('fleet.budgets.actions.resume') }}
              </Button>
              <Button size="sm" variant="outline" data-testid="fleet-budget-edit" @click="emit('edit', policy)">
                {{ t('fleet.budgets.actions.edit') }}
              </Button>
              <Button size="sm" variant="destructive" data-testid="fleet-budget-delete" @click="emit('remove', policy)">
                {{ t('fleet.budgets.actions.delete') }}
              </Button>
            </template>
          </TableCell>
        </TableRow>
      </TableBody>
    </Table>
  </div>
</template>

<script setup lang="ts">
import { codeLabel } from '~/lib/fleet-i18n'
import { budgetStatus, spendPercent, windowSinceDate } from '~/lib/fleet-budgets'
import { formatUsd } from '~/lib/fleet-jobs'
import type { BudgetPolicyDto } from '~/lib/fleet-types'

defineProps<{
  policies: BudgetPolicyDto[]
  /** Shows Resume, Edit and Delete; a read-only table (members, fleet-wide policies on a project page) has no buttons. */
  editable: boolean
  scopeName: (policy: BudgetPolicyDto) => string | null
  testid?: string
}>()

const emit = defineEmits<{
  (e: 'edit', policy: BudgetPolicyDto): void
  (e: 'remove', policy: BudgetPolicyDto): void
  (e: 'resume', policy: BudgetPolicyDto): void
}>()

const { t, te } = useI18n()

const label = (prefix: string, code: string): string => codeLabel(t, te, prefix, code)
const percent = (policy: BudgetPolicyDto): number => spendPercent(policy.spentUsd, policy.amountUsd)

const BAR_CLASS = { paused: 'bg-destructive', warning: 'bg-secondary-foreground', ok: 'bg-primary' } as const
const BADGE_VARIANT = { paused: 'destructive', warning: 'secondary', ok: 'outline' } as const
const barClass = (policy: BudgetPolicyDto): string => BAR_CLASS[budgetStatus(policy)]
const badgeVariant = (policy: BudgetPolicyDto) => BADGE_VARIANT[budgetStatus(policy)]
</script>
```

- [ ] **Step 5: Run the spec**

Run: `cd apps/web && bun run test -- tests/components/fleet-budget-table.spec.ts`
Expected: PASS (8 tests).

- [ ] **Step 6: Lint and commit**

Run: `cd apps/web && bunx eslint components/fleet/BudgetTable.vue tests/components/fleet-budget-table.spec.ts tests/helpers --max-warnings=0`
Expected: no output.

```bash
git add apps/web/components/fleet/BudgetTable.vue apps/web/tests/components/fleet-budget-table.spec.ts apps/web/tests/helpers/mount-sfc.ts apps/web/tests/helpers/fleet-harness.ts
git commit -m "feat(web): fleet budget policy table and test harness additions"
```

---

### Task 7: Admin page, sidebar link and breadcrumb

**Files:**
- Create: `apps/web/pages/admin/fleet/budgets.vue`
- Modify: `apps/web/layouts/default.vue`
- Modify: `apps/web/tests/layouts/default-fleet-nav.spec.ts`, `apps/web/tests/layouts/fleet-jobs-nav.spec.ts`
- Test: `apps/web/tests/pages/admin-fleet-budgets.spec.ts`

**Interfaces:**
- Consumes: Tasks 1-6. `useFleetRunners` (existing) for runner names and options; `useVisiblePolling` (existing).
- Produces: route `/admin/fleet/budgets` (global admin). Test ids: header button `fleet-budget-create`. Layout:
  `fleetLeaf(project, path)` returns the breadcrumb leaf for `/:project/fleet/*` (used again by Task 8's route).

- [ ] **Step 1: Write the failing page spec**

Create `apps/web/tests/pages/admin-fleet-budgets.spec.ts`:

```ts
import { describe, test, expect, afterEach, jest } from '@jest/globals'
import * as Vue from 'vue'
import { ref, computed, watch, nextTick } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { uiStubs, enI18n, toastRecorder } from '../helpers/fleet-harness'
import * as apiModule from '../../composables/useApi'
import { ApiError } from '../../composables/useApi'
import { useFleetRunners } from '../../composables/useFleetRunners'
import type { BudgetPolicyDto } from '../../lib/fleet-types'

const page = webFile('pages', 'admin', 'fleet', 'budgets.vue')

const policy = (id: string, over: Partial<BudgetPolicyDto> = {}): BudgetPolicyDto => ({
  id, scopeType: 'global', scopeId: null, projectId: null, windowKind: 'calendar_month_utc', amountUsd: '5.0000',
  warnPercent: 80, hardStop: true, runningJobs: 'finish', paused: false, pausedAt: null,
  windowStart: '2026-10-01T00:00:00.000Z', spentUsd: '1.0000', warnReached: false, updatedById: 'u1',
  createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', ...over,
})

const runnerPage = {
  records: [{ id: 'r1', name: 'box-1' }], total: 1, current: 1, size: 100, hasNext: false, hasPrev: false,
}

interface Api { get: jest.Mock; delete: jest.Mock; post: jest.Mock; patch: jest.Mock }

function makeApi(rows: BudgetPolicyDto[], over: Partial<Api> = {}): Api {
  return {
    get: jest.fn(async (path: string) => (path === '/fleet/runners' ? runnerPage : rows)),
    post: jest.fn(async () => ({})),
    patch: jest.fn(async () => ({})),
    delete: jest.fn(async () => undefined),
    ...over,
  }
}

/** Mounts the page with a fake `$api`; `useVisiblePolling` is stubbed so the test drives refreshes. */
function mountBudgets(api: Api, confirmResult = true) {
  const toasts = toastRecorder()
  const stop = jest.fn()
  let task: () => Promise<void> = async () => undefined
  const polling = { start: jest.fn(), stop, runNow: async (): Promise<void> => { await task() }, isActive: () => true }
  globalThis.window = { confirm: () => confirmResult } as never
  ;(globalThis as Record<string, unknown>).useApi = () => ({ $api: api })

  const app = mountSfc(page, {
    components: uiStubs,
    fleetComponents: ['FleetBudgetTable'],
    alias: { '~/composables/useApi': apiModule },
    globals: {
      ref, computed, watch, nextTick,
      onMounted: Vue.onMounted,
      onBeforeUnmount: Vue.onBeforeUnmount,
      useI18n: () => enI18n(),
      useAppToast: () => toasts,
      useApi: () => ({ $api: api }),
      useVisiblePolling: (pageTask: () => Promise<void>) => {
        task = pageTask
        return polling
      },
      useFleetRunners: () => useFleetRunners(),
    },
  })

  const settle = async (): Promise<void> => {
    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => { setImmediate(resolve) })
      await Vue.nextTick()
    }
  }
  const rowIds = (): string[] =>
    app.find('[data-stub="tr"]')
      .map((r) => r.props['data-testid'])
      .filter((id): id is string => typeof id === 'string' && id.startsWith('fleet-budget-row-'))
  const rowButton = (id: string, label: string) => {
    const row = app.find('[data-stub="tr"]').find((r) => r.props['data-testid'] === `fleet-budget-row-${id}`)
    if (!row) throw new Error(`no row ${id} in: ${rowIds().join(',')}`)
    const button = app.find('[data-stub="button"]', row).find((b) => app.textOf(b) === label)
    if (!button) throw new Error(`no button "${label}" on row ${id}`)
    return { onClick: () => (button.props.onClick as () => void | Promise<void>)() }
  }
  return { app, api, toasts, stop, settle, rowIds, rowButton }
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).window
  delete (globalThis as Record<string, unknown>).useApi
})

describe('Fleet admin Budgets page', () => {
  test('lists global and runner policies only (D174), with the runner name', async () => {
    const m = mountBudgets(makeApi([
      policy('g'),
      policy('rn', { scopeType: 'runner', scopeId: 'r1' }),
      policy('pr', { scopeType: 'project', scopeId: 'x', projectId: 'x' }),
      policy('rp', { scopeType: 'repo', scopeId: 'y', projectId: 'x' }),
    ]))
    await m.settle()

    expect(m.rowIds()).toEqual(['fleet-budget-row-g', 'fleet-budget-row-rn'])
    expect(m.app.text()).toContain('box-1')
    m.app.unmount()
  })

  test('an empty list says so', async () => {
    const m = mountBudgets(makeApi([]))
    await m.settle()
    expect(m.app.text()).toContain('No budget policies yet.')
    m.app.unmount()
  })

  test('a 403 shows the admin-only line, hides the table and stops polling', async () => {
    const m = mountBudgets(makeApi([], { get: jest.fn(async () => { throw new ApiError(40003, 'forbidden') }) }))
    await m.settle()

    expect(m.app.text()).toContain('Only global administrators can manage the fleet.')
    expect(m.rowIds()).toEqual([])
    expect(m.stop).toHaveBeenCalled()
    m.app.unmount()
  })

  test('Resume on a row opens the resume dialog for that policy', async () => {
    const m = mountBudgets(makeApi([policy('g', { paused: true, pausedAt: '2026-10-02T00:00:00.000Z' })]))
    await m.settle()
    expect(m.app.find('[data-stub="fleet-budget-resume-dialog"]')).toHaveLength(0)

    await m.rowButton('g', 'Resume').onClick()
    await m.settle()

    const dialog = m.app.find('[data-stub="fleet-budget-resume-dialog"]')
    expect(dialog).toHaveLength(1)
    expect(dialog[0].props.open).toBe(true)
    expect(dialog[0].props['data-policy']).toBe('g')
    m.app.unmount()
  })

  test('Edit opens the edit dialog for that policy; Add policy opens it empty', async () => {
    const m = mountBudgets(makeApi([policy('g')]))
    await m.settle()

    await m.rowButton('g', 'Edit').onClick()
    await m.settle()
    let dialog = m.app.find('[data-stub="fleet-budget-edit-dialog"]')[0]
    expect([dialog.props.open, dialog.props['data-policy']]).toEqual([true, 'g'])

    const create = m.app.find('[data-stub="button"]').find((b) => b.props['data-testid'] === 'fleet-budget-create')
    await (create?.props.onClick as () => void)()
    await m.settle()
    dialog = m.app.find('[data-stub="fleet-budget-edit-dialog"]')[0]
    expect([dialog.props.open, dialog.props['data-policy']]).toEqual([true, ''])
    m.app.unmount()
  })

  test('Delete asks first, then deletes on the admin route and drops the row', async () => {
    const m = mountBudgets(makeApi([policy('g')]))
    await m.settle()

    await m.rowButton('g', 'Delete').onClick()
    await m.settle()

    expect(m.api.delete).toHaveBeenCalledWith('/fleet/budgets/g')
    expect(m.rowIds()).toEqual([])
    expect(m.toasts.successes).toEqual(['Budget policy deleted'])
    m.app.unmount()
  })

  test('a declined confirm deletes nothing', async () => {
    const m = mountBudgets(makeApi([policy('g')]), false)
    await m.settle()

    await m.rowButton('g', 'Delete').onClick()
    await m.settle()

    expect(m.api.delete).not.toHaveBeenCalled()
    expect(m.rowIds()).toEqual(['fleet-budget-row-g'])
    m.app.unmount()
  })

  test('deleting a policy that is already gone shows the server message and reloads (Review Focus 4)', async () => {
    const m = mountBudgets(makeApi([policy('g')], { delete: jest.fn(async () => { throw new ApiError(404, 'Budget policy not found') }) }))
    await m.settle()

    await m.rowButton('g', 'Delete').onClick()
    await m.settle()

    expect(m.toasts.errors).toEqual(['Budget policy not found'])
    const listCalls = m.api.get.mock.calls.filter(([path]) => path === '/fleet/budgets')
    expect(listCalls).toHaveLength(2)
    m.app.unmount()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/web && bun run test -- tests/pages/admin-fleet-budgets.spec.ts`
Expected: FAIL, cannot resolve `pages/admin/fleet/budgets.vue`.

- [ ] **Step 3: Implement the admin page**

Create `apps/web/pages/admin/fleet/budgets.vue`:

```vue
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { useFleetBudgetPage } from '~/composables/useFleetBudgetPage'
import type { BudgetBase } from '~/composables/useFleetBudgets'
import { isManagedOn, scopeName, scopeText } from '~/lib/fleet-budgets'
import type { BudgetPolicyDto } from '~/lib/fleet-types'

definePageMeta({ layout: 'default' })

/** Not project-scoped, so there is no event stream: poll like the Runners page (D178). */
const POLL_MS = 15_000

const base: BudgetBase = { kind: 'admin' }
const { t } = useI18n()
const runnersApi = useFleetRunners()
const {
  policies, pending, loadFailed, stale, forbidden, editOpen, editing, resumeOpen, resuming,
  refresh, openCreate, openEdit, openResume, remove, onApplied,
} = useFleetBudgetPage(base)

// D174: this prefix only acts on global and runner policies, so only those are listed.
const rows = computed(() => policies.value.filter((p) => isManagedOn('admin', p)))
const runnerOptions = computed(() => runnersApi.runners.value.map((r) => ({ value: r.id, label: r.name })))
const runnerName = (id: string): string => runnersApi.runners.value.find((r) => r.id === id)?.name ?? id
const nameOf = (p: BudgetPolicyDto): string | null => scopeName(p, { project: null, repo: (id) => id, runner: runnerName })
const confirmText = (p: BudgetPolicyDto): string => t('fleet.budgets.deleteConfirm', { scope: scopeText(t, p, nameOf(p)) })

async function poll(): Promise<void> {
  await refresh()
  if (forbidden.value) polling.stop()
}

// Declared after poll, which it runs; poll only reaches `polling` when it is called.
const polling = useVisiblePolling(poll, POLL_MS)

onMounted(() => {
  void polling.runNow()
  polling.start()
  // Runner names are cosmetic: a failure leaves ids on screen.
  void runnersApi.load().catch(() => undefined)
})
onBeforeUnmount(polling.stop)
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('fleet.budgets.title')" :subtitle="t('fleet.budgets.subtitleAdmin')">
      <template #actions>
        <Button :disabled="forbidden" data-testid="fleet-budget-create" @click="openCreate()">
          {{ t('fleet.budgets.actions.create') }}
        </Button>
      </template>
    </PageHeader>

    <p v-if="forbidden" class="text-sm text-muted-foreground">{{ t('fleet.common.adminOnly') }}</p>

    <template v-else>
      <p v-if="stale" class="text-sm text-muted-foreground">{{ t('fleet.common.stale') }}</p>
      <LoadingState v-if="pending" />
      <ErrorState v-else-if="loadFailed" @retry="refresh()" />
      <EmptyState v-else-if="rows.length === 0" :message="t('fleet.budgets.empty')" />
      <FleetBudgetTable
        v-else
        testid="fleet-budgets-admin"
        :policies="rows"
        :editable="true"
        :scope-name="nameOf"
        @edit="openEdit"
        @resume="openResume"
        @remove="(p) => remove(p, confirmText(p))"
      />
    </template>

    <FleetBudgetEditDialog
      v-model:open="editOpen"
      :base="base"
      :policy="editing"
      :runner-options="runnerOptions"
      @saved="onApplied"
      @failed="refresh()"
    />
    <FleetBudgetResumeDialog
      v-if="resuming"
      :key="resuming.id"
      v-model:open="resumeOpen"
      :base="base"
      :policy="resuming"
      @resumed="onApplied"
      @failed="refresh()"
    />
  </div>
</template>
```

- [ ] **Step 4: Run the page spec**

Run: `cd apps/web && bun run test -- tests/pages/admin-fleet-budgets.spec.ts`
Expected: PASS (8 tests). If the 403 test fails because the first `get` for runners also throws, the runner load is wrapped in `.catch` and must not matter; the budgets `get` throws for every path in that test by design.

- [ ] **Step 5: Layout: admin link and breadcrumb leaf (tests first)**

In `apps/web/tests/layouts/default-fleet-nav.spec.ts`, extend the first test and add one:

```ts
  test('a global admin sees Runners, Repos and Budgets links with their nav labels', async () => {
    const html = await render(true)
    expect(html.match(/<a href="\/admin\/fleet\/runners"[^>]*>[\s\S]*?<\/a>/)?.[0]).toContain('nav.fleetRunners')
    expect(html.match(/<a href="\/admin\/fleet\/repos"[^>]*>[\s\S]*?<\/a>/)?.[0]).toContain('nav.fleetRepos')
    expect(html.match(/<a href="\/admin\/fleet\/budgets"[^>]*>[\s\S]*?<\/a>/)?.[0]).toContain('nav.fleetBudgets')
  })
```

(replace the existing first `test('a global admin sees Runners and Repos links ...` with the above) and change the icon test's expectation to `expect.arrayContaining(['Server', 'FolderGit2', 'Wallet'])`.

In `apps/web/tests/layouts/fleet-jobs-nav.spec.ts`, inside the breadcrumbs test add:

```ts
    expect(layout).toContain("t('fleet.budgets.title')")
```

Run: `cd apps/web && bun run test -- tests/layouts`
Expected: FAIL (no Wallet import, no budgets link, no title key in the layout).

- [ ] **Step 6: Edit the layout**

In `apps/web/layouts/default.vue`:

1. Add `Wallet` to the lucide import: `import { LayoutDashboard, Kanban, Bot, Tag, BookOpen, Clock, Brain, Code2, Activity, Users, Server, FolderGit2, Rocket, Wallet } from 'lucide-vue-next'`.
2. After the `/admin/fleet/repos` link add:

```vue
        <NuxtLink v-if="isGlobalAdmin" to="/admin/fleet/budgets" :class="navLinkClass" :active-class="activeClass"><Wallet class="h-4 w-4 shrink-0" />{{ t('nav.fleetBudgets') }}</NuxtLink>
```

3. Replace the leaf computation in the `breadcrumbItems` block. Above `const breadcrumbItems`, add:

```ts
/** The last crumb under `/:project/fleet/*`: dispatch, budgets, or (anything else) a job. */
function fleetLeaf(project: string, path: string): string {
  if (path === `/${project}/fleet/dispatch`) return t('fleet.jobs.dispatch')
  if (path === `/${project}/fleet/budgets`) return t('fleet.budgets.title')
  return t('fleet.jobs.detail.title')
}
```

and change `const leaf = path === `/${project}/fleet/dispatch` ? t('fleet.jobs.dispatch') : t('fleet.jobs.detail.title')` to `const leaf = fleetLeaf(project, path)`.

Run: `cd apps/web && bun run test -- tests/layouts tests/pages/admin-fleet-budgets.spec.ts`
Expected: PASS.

- [ ] **Step 7: Lint and commit**

Run: `cd apps/web && bunx eslint pages/admin/fleet/budgets.vue layouts/default.vue tests/pages/admin-fleet-budgets.spec.ts tests/layouts --max-warnings=0`
Expected: no output.

```bash
git add apps/web/pages/admin/fleet/budgets.vue apps/web/layouts/default.vue apps/web/tests/pages/admin-fleet-budgets.spec.ts apps/web/tests/layouts
git commit -m "feat(web): admin fleet budgets page and sidebar link"
```

---

### Task 8: Project budgets page and the jobs-list entry point

**Files:**
- Create: `apps/web/pages/[project]/fleet/budgets.vue`
- Modify: `apps/web/pages/[project]/fleet/index.vue` (Budgets button in the header actions only; the banner is Task 9)
- Modify: `apps/web/tests/helpers/mount-sfc.ts` (add `'useProjectEvents'` to `NUXT_AUTO_IMPORTS`)
- Modify: `apps/web/tests/pages/fleet-jobs-list.spec.ts`
- Test: `apps/web/tests/pages/fleet-budgets-project-page.spec.ts`

**Interfaces:**
- Consumes: Tasks 1-7; existing `useProjectViewerRole(slug)` (`data.value.canManage`), `useFleetDispatchOptions(slug)`
  (`repos`, `repoName`, `load`), `useProjectEvents(slug, { onFleetJob, onResync })`, `createDebouncer`.
- Produces: route `/:project/fleet/budgets`. Test ids: `fleet-budgets-own`, `fleet-budgets-global`,
  `fleet-budgets-global-section`, `fleet-budget-readonly`, `fleet-budget-create`; the jobs list gets `fleet-budgets-link`.

- [ ] **Step 1: Harness: let a mounted page call `useProjectEvents`**

In `apps/web/tests/helpers/mount-sfc.ts`, add `'useProjectEvents',` to the `NUXT_AUTO_IMPORTS` array (after `'useAdminUsers'`).

- [ ] **Step 2: Write the failing page spec**

Create `apps/web/tests/pages/fleet-budgets-project-page.spec.ts`:

```ts
import { describe, test, expect, afterEach, jest } from '@jest/globals'
import * as Vue from 'vue'
import { ref, computed, watch, nextTick } from 'vue'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { uiStubs, enI18n, toastRecorder } from '../helpers/fleet-harness'
import * as apiModule from '../../composables/useApi'
import type { BudgetPolicyDto } from '../../lib/fleet-types'

const pageFile = webFile('pages', '[project]', 'fleet', 'budgets.vue')
const source = readFileSync(path.join(__dirname, '../..', 'pages', '[project]', 'fleet', 'budgets.vue'), 'utf-8')

const policy = (id: string, over: Partial<BudgetPolicyDto> = {}): BudgetPolicyDto => ({
  id, scopeType: 'project', scopeId: 'proj1', projectId: 'proj1', windowKind: 'calendar_month_utc', amountUsd: '5.0000',
  warnPercent: 80, hardStop: true, runningJobs: 'finish', paused: false, pausedAt: null,
  windowStart: '2026-10-01T00:00:00.000Z', spentUsd: '1.0000', warnReached: false, updatedById: 'u1',
  createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', ...over,
})

const ROWS = [
  policy('pp'),
  policy('rp', { scopeType: 'repo', scopeId: 'r1', paused: true, pausedAt: '2026-10-02T00:00:00.000Z' }),
  policy('rg', { scopeType: 'repo', scopeId: 'gone' }),
  policy('g', { scopeType: 'global', scopeId: null, projectId: null }),
]

function mountProject(rows: BudgetPolicyDto[], canManage: boolean, get?: jest.Mock) {
  const api = { get: get ?? jest.fn(async () => rows), delete: jest.fn(async () => undefined), post: jest.fn(), patch: jest.fn() }
  const toasts = toastRecorder()
  let task: () => Promise<void> = async () => undefined
  const polling = { start: jest.fn(), stop: jest.fn(), runNow: async (): Promise<void> => { await task() }, isActive: () => true }
  globalThis.window = { confirm: () => true } as never
  ;(globalThis as Record<string, unknown>).useApi = () => ({ $api: api })

  const app = mountSfc(pageFile, {
    components: uiStubs,
    fleetComponents: ['FleetBudgetTable'],
    alias: { '~/composables/useApi': apiModule },
    globals: {
      ref, computed, watch, nextTick,
      onMounted: Vue.onMounted,
      onBeforeUnmount: Vue.onBeforeUnmount,
      useI18n: () => enI18n(),
      useAppToast: () => toasts,
      useApi: () => ({ $api: api }),
      useRoute: () => ({ params: { project: 'koda' } }),
      useProjectViewerRole: () => ({ data: ref({ canManage, viewerRole: canManage ? 'ADMIN' : 'VIEWER' }) }),
      useFleetDispatchOptions: () => ({
        repos: ref([{ id: 'r1', owner: 'acme', name: 'app' }]),
        repoName: (id: string) => (id === 'r1' ? 'acme/app' : id),
        load: async () => undefined,
      }),
      useProjectEvents: () => undefined,
      useVisiblePolling: (pageTask: () => Promise<void>) => {
        task = pageTask
        return polling
      },
    },
  })
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => { setImmediate(resolve) })
      await Vue.nextTick()
    }
  }
  const rowIds = (): string[] =>
    app.find('[data-stub="tr"]')
      .map((r) => r.props['data-testid'])
      .filter((id): id is string => typeof id === 'string' && id.startsWith('fleet-budget-row-'))
      .map((id) => id.replace('fleet-budget-row-', ''))
  const buttonLabels = (): string[] => app.find('[data-stub="button"]').map((b) => app.textOf(b))
  return { app, api, settle, rowIds, buttonLabels }
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).window
  delete (globalThis as Record<string, unknown>).useApi
})

describe('Project budgets page (behaviour)', () => {
  test('a member sees every policy but not one control (Review Focus 3)', async () => {
    const m = mountProject(ROWS, false)
    await m.settle()

    // The project's own table first (project, then repo policies by scope id), then the fleet-wide table.
    expect(m.rowIds()).toEqual(['pp', 'rg', 'rp', 'g'])
    expect(m.buttonLabels()).toEqual([])
    expect(m.app.find('[data-stub="fleet-budget-edit-dialog"]')).toHaveLength(0)
    expect(m.app.find('[data-stub="fleet-budget-resume-dialog"]')).toHaveLength(0)
    expect(m.app.text()).toContain('Only project administrators can change budget policies.')
    m.app.unmount()
  })

  test('a project admin gets controls on the project and repo policies, none on the fleet-wide one', async () => {
    const m = mountProject(ROWS, true)
    await m.settle()

    const own = m.app.find('[data-stub="tr"]').filter((r) => String(r.props['data-testid']).startsWith('fleet-budget-row-'))
    const labelsOf = (id: string): string[] => {
      const row = own.find((r) => r.props['data-testid'] === `fleet-budget-row-${id}`)
      return row ? m.app.find('[data-stub="button"]', row).map((b) => m.app.textOf(b)) : ['<missing>']
    }
    expect(labelsOf('pp')).toEqual(['Edit', 'Delete'])
    expect(labelsOf('rp')).toEqual(['Resume', 'Edit', 'Delete'])
    expect(labelsOf('g')).toEqual([])
    expect(m.app.text()).not.toContain('Only project administrators can change budget policies.')
    m.app.unmount()
  })

  test('repo policies show the repo name; a repo that no longer exists shows its raw id', async () => {
    const m = mountProject(ROWS, false)
    await m.settle()

    const text = m.app.text()
    expect(text).toContain('acme/app')
    expect(text).toContain('gone')
    m.app.unmount()
  })

  test('the fleet-wide section carries the hint and disappears when there are no global policies', async () => {
    const withGlobal = mountProject(ROWS, false)
    await withGlobal.settle()
    expect(withGlobal.app.text()).toContain('Set by a global administrator. They apply to every project.')
    withGlobal.app.unmount()

    const without = mountProject(ROWS.filter((p) => p.scopeType !== 'global'), false)
    await without.settle()
    expect(without.app.text()).not.toContain('Fleet-wide policies')
    without.app.unmount()
  })

  test('no own policies shows the empty state, not a table', async () => {
    const m = mountProject([policy('g', { scopeType: 'global', scopeId: null })], true)
    await m.settle()
    expect(m.app.text()).toContain('No budget policies yet.')
    m.app.unmount()
  })

  test('a failed first load shows the retry state and a retry loads again', async () => {
    const get = jest.fn()
      .mockImplementationOnce(async () => { throw new Error('down') })
      .mockImplementationOnce(async () => ROWS)
    const m = mountProject(ROWS, false, get)
    await m.settle()
    const error = m.app.find('[data-stub="error-state"]')
    expect(error).toHaveLength(1)

    await (error[0].props.onRetry as () => Promise<void>)()
    await m.settle()

    expect(m.rowIds()).toContain('pp')
    m.app.unmount()
  })
})

describe('Project budgets page (wiring)', () => {
  test('talks to the project route through the shared page composable', () => {
    expect(source).toContain("const base: BudgetBase = { kind: 'project', slug }")
    expect(source).toContain('useFleetBudgetPage(base)')
  })

  test('creating and the two dialogs exist only for a manager', () => {
    expect(source).toMatch(/<Button v-if="canManage"[^>]*data-testid="fleet-budget-create"/)
    expect(source).toContain('<FleetBudgetEditDialog\n      v-if="canManage"')
    expect(source).toContain('v-if="canManage && resuming"')
  })

  test('own policies are editable by a manager; the fleet-wide table never is', () => {
    expect(source).toContain(':editable="canManage"')
    expect(source).toContain(':editable="false"')
  })

  test('refreshes on fleet_job notices, debounced, plus a 30 s poll (D178)', () => {
    expect(source).toContain('const POLL_MS = 30_000')
    expect(source).toContain('onFleetJob: () => liveReload.trigger()')
    expect(source).toContain('onResync: () => liveReload.trigger()')
    expect(source).toContain('liveReload.cancel()')
  })
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd apps/web && bun run test -- tests/pages/fleet-budgets-project-page.spec.ts`
Expected: FAIL, cannot resolve `pages/[project]/fleet/budgets.vue`.

- [ ] **Step 4: Implement the page**

Create `apps/web/pages/[project]/fleet/budgets.vue`:

```vue
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { useFleetBudgetPage } from '~/composables/useFleetBudgetPage'
import type { BudgetBase } from '~/composables/useFleetBudgets'
import { createDebouncer } from '~/lib/debounce'
import { isManagedOn, scopeName, scopeText } from '~/lib/fleet-budgets'
import type { BudgetPolicyDto } from '~/lib/fleet-types'

definePageMeta({ layout: 'default' })

/**
 * fleet_job notices fire on job state changes only: a snapshot that raises spend, a warn, or a hard
 * stop that cancels nothing sends none, so the poll is what makes a new pause visible (D178).
 */
const POLL_MS = 30_000

const route = useRoute()
const slug = route.params.project as string
const base: BudgetBase = { kind: 'project', slug }
const { t } = useI18n()
const { data: viewer } = useProjectViewerRole(slug)
const options = useFleetDispatchOptions(slug)
const {
  policies, pending, loadFailed, stale, editOpen, editing, resumeOpen, resuming,
  refresh, openCreate, openEdit, openResume, remove, onApplied,
} = useFleetBudgetPage(base)

// D176: the server is the gate; this only decides which controls to draw.
const canManage = computed(() => viewer.value.canManage)
// D175: the project's own policies (editable) and the fleet-wide ones (read-only).
const own = computed(() => policies.value.filter((p) => isManagedOn('project', p)))
const fleetWide = computed(() => policies.value.filter((p) => p.scopeType === 'global'))
const repoOptions = computed(() => options.repos.value.map((r) => ({ value: r.id, label: `${r.owner}/${r.name}` })))
const nameOf = (p: BudgetPolicyDto): string | null =>
  scopeName(p, { project: slug, repo: options.repoName, runner: (id) => id })
const confirmText = (p: BudgetPolicyDto): string => t('fleet.budgets.deleteConfirm', { scope: scopeText(t, p, nameOf(p)) })

const polling = useVisiblePolling(refresh, POLL_MS)
const liveReload = createDebouncer(() => { void refresh() }, 300)

onMounted(() => {
  void polling.runNow()
  polling.start()
  // Repo names are cosmetic: a failure leaves ids on screen.
  void options.load().catch(() => undefined)
})
onBeforeUnmount(() => {
  polling.stop()
  liveReload.cancel()
})
useProjectEvents(slug, {
  onFleetJob: () => liveReload.trigger(),
  onResync: () => liveReload.trigger(),
})
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('fleet.budgets.title')" :subtitle="t('fleet.budgets.subtitleProject')">
      <template #actions>
        <Button v-if="canManage" data-testid="fleet-budget-create" @click="openCreate()">
          {{ t('fleet.budgets.actions.create') }}
        </Button>
      </template>
    </PageHeader>

    <p v-if="!canManage" class="text-sm text-muted-foreground" data-testid="fleet-budget-readonly">{{ t('fleet.budgets.readOnly') }}</p>
    <p v-if="stale" class="text-sm text-muted-foreground">{{ t('fleet.common.stale') }}</p>

    <LoadingState v-if="pending" />
    <ErrorState v-else-if="loadFailed" @retry="refresh()" />
    <template v-else>
      <section class="space-y-2">
        <h2 class="text-sm font-medium">{{ t('fleet.budgets.sections.own') }}</h2>
        <EmptyState v-if="own.length === 0" :message="t('fleet.budgets.empty')" />
        <FleetBudgetTable
          v-else
          testid="fleet-budgets-own"
          :policies="own"
          :editable="canManage"
          :scope-name="nameOf"
          @edit="openEdit"
          @resume="openResume"
          @remove="(p) => remove(p, confirmText(p))"
        />
      </section>

      <section v-if="fleetWide.length > 0" class="space-y-2" data-testid="fleet-budgets-global-section">
        <h2 class="text-sm font-medium">{{ t('fleet.budgets.sections.global') }}</h2>
        <p class="text-xs text-muted-foreground">{{ t('fleet.budgets.sections.globalHint') }}</p>
        <FleetBudgetTable testid="fleet-budgets-global" :policies="fleetWide" :editable="false" :scope-name="nameOf" />
      </section>
    </template>

    <FleetBudgetEditDialog
      v-if="canManage"
      v-model:open="editOpen"
      :base="base"
      :policy="editing"
      :repo-options="repoOptions"
      @saved="onApplied"
      @failed="refresh()"
    />
    <FleetBudgetResumeDialog
      v-if="canManage && resuming"
      :key="resuming.id"
      v-model:open="resumeOpen"
      :base="base"
      :policy="resuming"
      @resumed="onApplied"
      @failed="refresh()"
    />
  </div>
</template>
```

- [ ] **Step 5: Run the page spec**

Run: `cd apps/web && bun run test -- tests/pages/fleet-budgets-project-page.spec.ts`
Expected: PASS (10 tests).

- [ ] **Step 6: The Budgets button on the jobs list**

In `apps/web/pages/[project]/fleet/index.vue`, in the `PageHeader` `#actions` slot, add before the dispatch button:

```vue
        <Button variant="outline" data-testid="fleet-budgets-link" @click="navigateTo(`/${slug}/fleet/budgets`)">
          {{ t('fleet.jobs.budgets') }}
        </Button>
```

Append to `describe('fleet jobs list', ...)` in `apps/web/tests/pages/fleet-jobs-list.spec.ts`:

```ts
  test('every member gets a Budgets button next to Dispatch (D187)', () => {
    expect(list).toMatch(/<Button variant="outline" data-testid="fleet-budgets-link" @click="navigateTo\(`\/\$\{slug\}\/fleet\/budgets`\)">/)
    expect(list.indexOf('fleet-budgets-link')).toBeLessThan(list.indexOf('fleet-dispatch-button'))
  })
```

Run: `cd apps/web && bun run test -- tests/pages/fleet-jobs-list.spec.ts tests/pages/fleet-budgets-project-page.spec.ts`
Expected: PASS.

- [ ] **Step 7: Lint and commit**

Run: `cd apps/web && bunx eslint "pages/[project]/fleet" tests/pages tests/helpers --max-warnings=0`
Expected: no output.

```bash
git add "apps/web/pages/[project]/fleet/budgets.vue" "apps/web/pages/[project]/fleet/index.vue" apps/web/tests/pages apps/web/tests/helpers/mount-sfc.ts
git commit -m "feat(web): project fleet budgets page and jobs-list entry point"
```

---

### Task 9: Paused banner and the job-page budget stop reason

**Files:**
- Create: `apps/web/components/fleet/BudgetBanner.vue`
- Modify: `apps/web/pages/[project]/fleet/index.vue`, `apps/web/pages/[project]/fleet/dispatch.vue`, `apps/web/pages/[project]/fleet/jobs/[id].vue`
- Test: `apps/web/tests/components/fleet-budget-banner.spec.ts`
- Test: `apps/web/tests/pages/fleet-budget-banner-placement.spec.ts`

**Interfaces:**
- Consumes: Task 1 (`bannerLines`, `scopeName`, `scopeText`, `spendPercent`, `budgetStopPolicyId`), Task 2 (`useFleetBudgets({ kind: 'project', slug })`), `formatUsd`.
- Produces: `<FleetBudgetBanner :slug :repo-name? />` exposing `refresh(): Promise<void>` (`defineExpose`). Test ids:
  `fleet-budget-banner`, `fleet-budget-banner-line` (attrs `data-status`, `data-policy`), `fleet-budget-banner-more`,
  `fleet-budget-banner-link`; on the job page `fleet-job-budget-link`.

- [ ] **Step 1: Write the failing banner spec**

Create `apps/web/tests/components/fleet-budget-banner.spec.ts`:

```ts
import { describe, test, expect, afterEach, jest } from '@jest/globals'
import * as Vue from 'vue'
import { ref, computed, watch, nextTick } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { uiStubs, enI18n } from '../helpers/fleet-harness'
import type { BudgetPolicyDto } from '../../lib/fleet-types'

const banner = webFile('components', 'fleet', 'BudgetBanner.vue')

const policy = (id: string, over: Partial<BudgetPolicyDto> = {}): BudgetPolicyDto => ({
  id, scopeType: 'global', scopeId: null, projectId: null, windowKind: 'calendar_month_utc', amountUsd: '5.0000',
  warnPercent: 80, hardStop: true, runningJobs: 'finish', paused: false, pausedAt: null,
  windowStart: '2026-10-01T00:00:00.000Z', spentUsd: '1.0000', warnReached: false, updatedById: 'u1',
  createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', ...over,
})

const NuxtLink = {
  name: 'StubNuxtLink',
  props: ['to'],
  setup(props: { to?: string }, { slots, attrs }: { slots: { default?: () => unknown }; attrs: Record<string, unknown> }) {
    return () => Vue.h('x-stub-stub', { ...attrs, 'data-stub': 'nuxt-link', to: props.to }, slots.default?.() as never)
  },
}

function mountBanner(get: jest.Mock, props: Record<string, unknown> = {}) {
  ;(globalThis as Record<string, unknown>).useApi = () => ({ $api: { get } })
  let task: () => Promise<void> = async () => undefined
  const polling = { start: jest.fn(), stop: jest.fn(), runNow: async (): Promise<void> => { await task() }, isActive: () => true }
  const app = mountSfc(banner, {
    components: { ...uiStubs, NuxtLink },
    props: { slug: 'koda', ...props },
    globals: {
      ref, computed, watch, nextTick,
      onMounted: Vue.onMounted,
      onBeforeUnmount: Vue.onBeforeUnmount,
      useI18n: () => enI18n(),
      useApi: () => ({ $api: { get } }),
      useVisiblePolling: (fn: () => Promise<void>) => {
        task = fn
        return polling
      },
    },
  })
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 4; i += 1) {
      await new Promise((resolve) => { setImmediate(resolve) })
      await Vue.nextTick()
    }
  }
  return { app, polling, settle, lines: () => app.find('[data-testid="fleet-budget-banner-line"]') }
}

afterEach(() => { delete (globalThis as Record<string, unknown>).useApi })

describe('FleetBudgetBanner', () => {
  test('loads the project list and shows paused before warning, each with scope, spend and amount', async () => {
    const get = jest.fn(async () => [
      policy('w', { scopeType: 'repo', scopeId: 'r1', warnReached: true, spentUsd: '4.2500' }),
      policy('p', { paused: true, spentUsd: '6.0000', warnReached: true }),
    ])
    const m = mountBanner(get, { repoName: (id: string) => (id === 'r1' ? 'acme/app' : id) })
    await m.settle()

    expect(get).toHaveBeenCalledWith('/projects/koda/fleet/budgets')
    expect(m.lines().map((l) => [l.props['data-policy'], l.props['data-status']])).toEqual([['p', 'paused'], ['w', 'warning']])
    expect(m.app.textOf(m.lines()[0])).toBe('Fleet budget paused for the whole fleet: $6.00 of $5.00 spent. New jobs are refused until it is resumed.')
    expect(m.app.textOf(m.lines()[1])).toBe('Fleet budget for repo acme/app is at 85% ($4.25 of $5.00).')
    m.app.unmount()
  })

  test('links to the project budgets page', async () => {
    const m = mountBanner(jest.fn(async () => [policy('p', { paused: true })]))
    await m.settle()
    const link = m.app.find('[data-testid="fleet-budget-banner-link"]')
    expect(link).toHaveLength(1)
    expect(link[0].props.to).toBe('/koda/fleet/budgets')
    expect(m.app.textOf(link[0])).toBe('View budgets')
    m.app.unmount()
  })

  test('nothing flagged renders nothing (Review Focus 5)', async () => {
    const m = mountBanner(jest.fn(async () => [policy('ok'), policy('ok2', { scopeId: 'x', scopeType: 'project' })]))
    await m.settle()
    expect(m.app.find('[data-testid="fleet-budget-banner"]')).toHaveLength(0)
    m.app.unmount()
  })

  test('a failed load renders nothing and does not throw', async () => {
    const m = mountBanner(jest.fn(async () => { throw new Error('down') }))
    await m.settle()
    expect(m.app.find('[data-testid="fleet-budget-banner"]')).toHaveLength(0)
    m.app.unmount()
  })

  test('more than three flagged policies show three lines and a count of the rest', async () => {
    const rows = ['a', 'b', 'c', 'd', 'e'].map((id, i) => policy(id, { scopeType: 'repo', scopeId: `r${i}`, paused: i < 2, warnReached: true }))
    const m = mountBanner(jest.fn(async () => rows))
    await m.settle()

    expect(m.lines()).toHaveLength(3)
    const more = m.app.find('[data-testid="fleet-budget-banner-more"]')
    expect(m.app.textOf(more[0])).toBe('and 2 more')
    m.app.unmount()
  })

  test('a paused policy that is also past its warn threshold is one line', async () => {
    const m = mountBanner(jest.fn(async () => [policy('p', { paused: true, warnReached: true })]))
    await m.settle()
    expect(m.lines()).toHaveLength(1)
    m.app.unmount()
  })

  test('a repo the page does not know shows its raw id', async () => {
    const m = mountBanner(jest.fn(async () => [policy('p', { scopeType: 'repo', scopeId: 'gone', paused: true })]))
    await m.settle()
    expect(m.app.textOf(m.lines()[0])).toContain('repo gone')
    m.app.unmount()
  })

  test('polls on its own every 30 seconds', async () => {
    const m = mountBanner(jest.fn(async () => []))
    await m.settle()
    expect(m.polling.start).toHaveBeenCalled()
    m.app.unmount()
    expect(m.polling.stop).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/web && bun run test -- tests/components/fleet-budget-banner.spec.ts`
Expected: FAIL, cannot resolve `BudgetBanner.vue`.

- [ ] **Step 3: Implement the banner**

Create `apps/web/components/fleet/BudgetBanner.vue`:

```vue
<template>
  <div v-if="view.lines.length > 0" class="space-y-2" data-testid="fleet-budget-banner">
    <div
      v-for="line in view.lines"
      :key="line.policy.id"
      class="rounded-md border px-3 py-2 text-sm"
      :class="line.status === 'paused' ? 'border-destructive text-destructive' : 'border-border bg-muted'"
      :role="line.status === 'paused' ? 'alert' : 'status'"
      data-testid="fleet-budget-banner-line"
      :data-status="line.status"
      :data-policy="line.policy.id"
    >
      {{ lineText(line) }}
    </div>
    <div class="flex items-center gap-3 text-sm">
      <span v-if="view.more > 0" class="text-muted-foreground" data-testid="fleet-budget-banner-more">
        {{ t('fleet.budgets.banner.more', { count: view.more }) }}
      </span>
      <NuxtLink
        :to="`/${slug}/fleet/budgets`"
        class="font-medium text-primary underline-offset-4 hover:underline"
        data-testid="fleet-budget-banner-link"
      >
        {{ t('fleet.budgets.banner.view') }}
      </NuxtLink>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { useFleetBudgets } from '~/composables/useFleetBudgets'
import { bannerLines, scopeName, scopeText, spendPercent } from '~/lib/fleet-budgets'
import type { BannerLine } from '~/lib/fleet-budgets'
import { formatUsd } from '~/lib/fleet-jobs'

/** D179: the banner polls for itself; the jobs list also nudges it on fleet_job notices. */
const POLL_MS = 30_000

const props = defineProps<{ slug: string; repoName?: (id: string) => string }>()

const { t } = useI18n()
const { policies, load } = useFleetBudgets({ kind: 'project', slug: props.slug })

const view = computed(() => bannerLines(policies.value))

async function refresh(): Promise<void> {
  try {
    await load()
  } catch {
    // Cosmetic on a page about something else: keep what was shown and try again at the next poll.
  }
}

const polling = useVisiblePolling(refresh, POLL_MS)
onMounted(() => {
  void polling.runNow()
  polling.start()
})
onBeforeUnmount(polling.stop)
defineExpose({ refresh })

const nameFor = (line: BannerLine): string | null =>
  scopeName(line.policy, {
    project: props.slug,
    repo: (id) => props.repoName?.(id) ?? id,
    runner: (id) => id,
  })

const lineText = (line: BannerLine): string =>
  t(`fleet.budgets.banner.${line.status}`, {
    scope: scopeText(t, line.policy, nameFor(line)),
    spent: formatUsd(line.policy.spentUsd),
    amount: formatUsd(line.policy.amountUsd),
    percent: spendPercent(line.policy.spentUsd, line.policy.amountUsd),
  })
</script>
```

- [ ] **Step 4: Run the banner spec**

Run: `cd apps/web && bun run test -- tests/components/fleet-budget-banner.spec.ts`
Expected: PASS (8 tests). If the exact-text assertions differ only by whitespace around `$`, compare against the printed value and keep the English copy from Task 3 as the authority.

- [ ] **Step 5: Write the failing placement spec**

Create `apps/web/tests/pages/fleet-budget-banner-placement.spec.ts`:

```ts
import { describe, expect, test } from '@jest/globals'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const webDir = path.join(__dirname, '../..')
const read = (...parts: string[]): string => readFileSync(path.join(webDir, ...parts), 'utf-8')
const list = read('pages', '[project]', 'fleet', 'index.vue')
const dispatch = read('pages', '[project]', 'fleet', 'dispatch.vue')
const detail = read('pages', '[project]', 'fleet', 'jobs', '[id].vue')

describe('budget banner placement (D179)', () => {
  test.each([
    ['jobs list', list],
    ['dispatch', dispatch],
    ['job detail', detail],
  ])('%s shows the banner for this project with repo names from its options', (_name, source) => {
    expect(source).toContain('<FleetBudgetBanner')
    expect(source).toMatch(/<FleetBudgetBanner[^>]*:slug="slug"[^>]*:repo-name="options\.repoName"/)
  })

  test('the jobs list nudges the banner on every notice, inside the same debounce', () => {
    expect(list).toContain('const banner = ref<{ refresh: () => Promise<void> } | null>(null)')
    expect(list).toMatch(/<FleetBudgetBanner ref="banner"/)
    expect(list).toMatch(/createDebouncer\(\(\) => \{ void reload\(\); void banner\.value\?\.refresh\(\) \}, 300\)/)
  })

  test('the banner sits under the header, above the filters', () => {
    expect(list.indexOf('<FleetBudgetBanner')).toBeGreaterThan(list.indexOf('</PageHeader>'))
    expect(list.indexOf('<FleetBudgetBanner')).toBeLessThan(list.indexOf('fleet-filter-state'))
  })
})

describe('job page budget stop reason (D188)', () => {
  test('a budget:<id> reason renders as text and a link; any other reason renders raw', () => {
    expect(detail).toContain("const budgetPolicyId = computed(() => budgetStopPolicyId(job.value?.stateReason))")
    expect(detail).toMatch(/<template v-if="budgetPolicyId">[\s\S]*?fleet\.jobs\.detail\.budgetStop[\s\S]*?fleet-job-budget-link[\s\S]*?<\/template>\s*<template v-else>\{\{ job\.stateReason \}\}<\/template>/)
    expect(detail).toContain(':title="job.stateReason"')
  })
})
```

Run: `cd apps/web && bun run test -- tests/pages/fleet-budget-banner-placement.spec.ts`
Expected: FAIL (no banner, no link yet).

- [ ] **Step 6: Place the banner and render the stop reason**

`apps/web/pages/[project]/fleet/index.vue`:

1. Replace `const liveReload = createDebouncer(() => { void reload() }, 300)` with:

```ts
const banner = ref<{ refresh: () => Promise<void> } | null>(null)
const liveReload = createDebouncer(() => { void reload(); void banner.value?.refresh() }, 300)
```

2. Immediately after the closing `</PageHeader>` add: `<FleetBudgetBanner ref="banner" :slug="slug" :repo-name="options.repoName" />`.

`apps/web/pages/[project]/fleet/dispatch.vue`: after the self-closing `<PageHeader ... />` line add `<FleetBudgetBanner :slug="slug" :repo-name="options.repoName" />`.

`apps/web/pages/[project]/fleet/jobs/[id].vue`:

1. Add `budgetStopPolicyId` to the imports: `import { budgetStopPolicyId } from '~/lib/fleet-budgets'`.
2. Under `const wipPush = computed(...)` add: `const budgetPolicyId = computed(() => budgetStopPolicyId(job.value?.stateReason))`.
3. After `</PageHeader>` (inside `<template v-else>`) add `<FleetBudgetBanner :slug="slug" :repo-name="options.repoName" />`.
4. Replace the state-reason span with:

```vue
        <span v-if="job.stateReason" class="text-sm text-muted-foreground" :title="job.stateReason" data-testid="fleet-job-state-reason">
          <template v-if="budgetPolicyId">
            {{ t('fleet.jobs.detail.budgetStop') }}
            <NuxtLink :to="`/${slug}/fleet/budgets`" class="text-primary underline-offset-4 hover:underline" data-testid="fleet-job-budget-link">{{ t('fleet.jobs.detail.budgetStopLink') }}</NuxtLink>
          </template>
          <template v-else>{{ job.stateReason }}</template>
        </span>
```

Run: `cd apps/web && bun run test -- tests/pages tests/components/fleet-budget-banner.spec.ts tests/i18n`
Expected: PASS. The existing job-detail and jobs-list wiring specs must still pass unchanged.

- [ ] **Step 7: Lint and commit**

Run: `cd apps/web && bunx eslint components/fleet/BudgetBanner.vue "pages/[project]/fleet" tests/components tests/pages --max-warnings=0`
Expected: no output.

```bash
git add apps/web/components/fleet/BudgetBanner.vue "apps/web/pages/[project]/fleet" apps/web/tests/components/fleet-budget-banner.spec.ts apps/web/tests/pages/fleet-budget-banner-placement.spec.ts
git commit -m "feat(web): paused and warning banner on project fleet pages, budget stop reason on the job page"
```

---

### Task 10: E2E, docs and whole-slice verification

**Files:**
- Create: `apps/web/tests/e2e/fixtures/fleet-budgets-api.ts`
- Create: `apps/web/tests/e2e/fleet-budgets.e2e.spec.ts`
- Modify: `docs/deployment/runner.md`, `docs/superpowers/specs/2026-10-01-fleet-s1b-budgets-schedules-design.md`

**Interfaces:**
- Consumes: the whole slice; existing fixtures `login`/`E2E_ADMIN`, `webLogin`/`waitForHydration`, `ScriptedRunner`
  (`enroll`, `heartbeat`, `acceptAssign`, `report`, `uploadBundle`); seeded project `fleet-e2e` with repo `acme/e2e-app`.
- Produces: `fleet-budgets.e2e.spec.ts` (two tests) and the fixture functions `repoIdOf`, `dispatchRun`, `listPolicies`,
  `deleteOwnPolicies`.

- [ ] **Step 1: The API fixture**

Create `apps/web/tests/e2e/fixtures/fleet-budgets-api.ts`:

```ts
/**
 * Fleet S1b slice 2b: the API calls the budgets e2e makes outside the browser (dispatching a job for the
 * scripted runner, reading policy state, cleaning up). Responses use the { ret, data } envelope.
 */
const API_URL = process.env['E2E_API_URL'] ?? 'http://localhost:3102';

async function call<T>(method: string, path: string, token: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_URL}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} failed: ${res.status} ${text}`);
  if (text === '') return undefined as T;
  const parsed = JSON.parse(text) as { ret?: number; data?: T };
  if (parsed.ret !== 0) throw new Error(`${method} ${path} answered ret ${String(parsed.ret)}: ${text}`);
  return parsed.data as T;
}

export interface PolicyRow {
  id: string;
  scopeType: string;
  paused: boolean;
  spentUsd: string;
  amountUsd: string;
}

/** The fleet repo id for `owner/name` in a project. */
export async function repoIdOf(token: string, slug: string, fullName: string): Promise<string> {
  const page = await call<{ records: Array<{ id: string; owner: string; name: string }> }>('GET', `/projects/${slug}/fleet/repos?size=100`, token);
  const repo = page.records.find((r) => `${r.owner}/${r.name}` === fullName);
  if (!repo) throw new Error(`No fleet repo ${fullName} in ${slug}`);
  return repo.id;
}

/** Dispatches a RUN pinned to one runner and returns the job id. */
export async function dispatchRun(
  token: string,
  slug: string,
  input: { repoId: string; feature: string; maxCostUsd: number; pinnedRunnerId: string },
): Promise<string> {
  const result = await call<{ job: { id: string } }>('POST', `/projects/${slug}/fleet/jobs`, token, { command: 'RUN', ...input });
  return result.job.id;
}

export const listPolicies = (token: string, slug: string): Promise<PolicyRow[]> =>
  call<PolicyRow[]>('GET', `/projects/${slug}/fleet/budgets`, token);

/** Removes the project's own (project and repo) policies; global ones are not this spec's to touch. */
export async function deleteOwnPolicies(token: string, slug: string): Promise<void> {
  const rows = await listPolicies(token, slug);
  for (const row of rows.filter((r) => r.scopeType === 'project' || r.scopeType === 'repo')) {
    await call<void>('DELETE', `/projects/${slug}/fleet/budgets/${row.id}`, token);
  }
}
```

- [ ] **Step 2: The e2e spec**

Create `apps/web/tests/e2e/fleet-budgets.e2e.spec.ts`:

```ts
import { test, expect } from '@playwright/test';
import { login, E2E_ADMIN } from './fixtures/api-client';
import { deleteOwnPolicies, dispatchRun, listPolicies, repoIdOf } from './fixtures/fleet-budgets-api';
import { waitForHydration, webLogin } from './fixtures/page-helpers';
import { ScriptedRunner, type Lease } from './fixtures/scripted-runner';

/**
 * Fleet S1b slice 2b (plan D189): budgets in the web. A project policy is created in the UI, a scripted
 * runner spends past it, the banner appears on the jobs list, and a resume with a raised limit clears it.
 * Project `fleet-e2e` and repo acme/e2e-app come from prisma/seed-e2e.ts.
 */
const SLUG = 'fleet-e2e';

test.describe('Fleet budgets (scripted runner)', () => {
  let token = '';
  let runner: ScriptedRunner;
  const suffix = Date.now().toString().slice(-6);
  const feature = `bud-${suffix}`;

  test.beforeAll(async () => {
    const session = await login(E2E_ADMIN.email, E2E_ADMIN.password);
    token = session.token;
    runner = await ScriptedRunner.enroll(token, `e2e-budget-runner-${suffix}`);
    await deleteOwnPolicies(token, SLUG);
  });

  // A paused project policy left behind would block the dispatch e2e that runs after this file.
  test.afterAll(async () => {
    await deleteOwnPolicies(token, SLUG);
  });

  test('a limit passed by a running job pauses the project: banner, then resume with a raised limit', async ({ page }) => {
    test.setTimeout(120_000);
    await webLogin(page);

    // 1. Create a $0.50 monthly project policy in the UI.
    await page.goto(`/${SLUG}/fleet/budgets`);
    await waitForHydration(page);
    await page.getByTestId('fleet-budget-create').click();
    await page.getByTestId('fleet-budget-scope-type').selectOption('project');
    await page.getByTestId('fleet-budget-amount').fill('0.5');
    await page.getByTestId('fleet-budget-submit').click();
    const rows = page.getByTestId('fleet-budgets-own').locator('[data-testid^="fleet-budget-row-"]');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toHaveAttribute('data-status', 'ok');

    // 2. A scripted runner starts a job and reports $0.60 spent: over the limit.
    const repoId = await repoIdOf(token, SLUG, 'acme/e2e-app');
    await runner.heartbeat();
    const jobId = await dispatchRun(token, SLUG, { repoId, feature, maxCostUsd: 3, pinnedRunnerId: runner.id });
    const lease: Lease = await runner.acceptAssign(jobId);
    await runner.report(lease, [
      { type: 'state', payload: { to: 'RUNNING' } },
      { type: 'snapshot', payload: { costSpentUsd: '0.6000', heartbeatAt: new Date().toISOString() } },
    ]);

    // 3. The evaluator runs about a second after the sync: wait on the API, not on a sleep.
    await expect
      .poll(async () => (await listPolicies(token, SLUG)).some((p) => p.scopeType === 'project' && p.paused), { timeout: 20_000 })
      .toBe(true);

    // 4. The jobs list shows the banner.
    await page.goto(`/${SLUG}/fleet`);
    await waitForHydration(page);
    const banner = page.getByTestId('fleet-budget-banner');
    await expect(banner).toBeVisible();
    await expect(banner.getByTestId('fleet-budget-banner-line')).toHaveAttribute('data-status', 'paused');
    await expect(banner).toContainText('$0.60 of $0.50');

    // 5. Follow the banner link and resume with a raised limit.
    await banner.getByTestId('fleet-budget-banner-link').click();
    await page.waitForURL(new RegExp(`/${SLUG}/fleet/budgets$`));
    await waitForHydration(page);
    await expect(rows.first()).toHaveAttribute('data-status', 'paused');
    await rows.first().getByTestId('fleet-budget-resume').click();
    await page.getByTestId('fleet-budget-resume-amount').fill('2');
    await page.getByTestId('fleet-budget-resume-submit').click();
    await expect(rows.first()).toHaveAttribute('data-status', 'ok');

    // 6. The banner is gone. Wait for the banner's own list request first: a count of 0 before the
    // load would pass for the wrong reason.
    const listLoaded = page.waitForResponse(
      (res) => res.url().includes(`/projects/${SLUG}/fleet/budgets`) && res.request().method() === 'GET' && res.status() === 200,
    );
    await page.goto(`/${SLUG}/fleet`);
    await listLoaded;
    await waitForHydration(page);
    await expect(page.getByTestId('fleet-budget-banner')).toHaveCount(0);

    // 7. Finish the job so nothing stays active (same sequence as the dispatch e2e).
    await runner.report(lease, [{ type: 'state', payload: { to: 'UPLOADING' } }]);
    await runner.uploadBundle(lease, `bundle of ${jobId}`);
    await runner.report(lease, [
      {
        type: 'snapshot',
        payload: {
          finishResult: 'opened', resultBranch: `feat/${feature}`,
          resultPrUrl: 'https://github.com/acme/e2e-app/pull/9', costSpentUsd: '0.6000',
        },
      },
      { type: 'state', payload: { to: 'COMPLETED', exitCode: 0 } },
    ]);
  });

  test('a global admin adds and deletes a fleet-wide policy', async ({ page }) => {
    await webLogin(page);
    await page.goto('/admin/fleet/budgets');
    await waitForHydration(page);

    await page.getByTestId('fleet-budget-create').click();
    await page.getByTestId('fleet-budget-window').selectOption('lifetime');
    await page.getByTestId('fleet-budget-amount').fill('1000');
    await page.getByTestId('fleet-budget-submit').click();

    const rows = page.locator('[data-testid^="fleet-budget-row-"]');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('Whole fleet');
    await expect(rows.first()).toContainText('Lifetime');

    page.once('dialog', (dialog) => { void dialog.accept(); });
    await rows.first().getByTestId('fleet-budget-delete').click();
    await expect(rows).toHaveCount(0);
  });
});
```

- [ ] **Step 3: Run the targeted e2e (and the dispatch e2e after it)**

Run:

```bash
cd apps/api && bun run test:db:up
cd apps/web && bunx playwright test tests/e2e/fleet-budgets.e2e.spec.ts tests/e2e/fleet-dispatch.e2e.spec.ts
```

Expected: 3 passed. The dispatch spec running second proves the budgets spec left no paused policy behind. If the first test
times out waiting for `paused`, read `GET /projects/fleet-e2e/fleet/budgets` (the poll's source): a `spentUsd` of `0` means the
job's `firstStartedAt` was not set by the RUNNING report (a slice 2a behaviour; check `job-transitions.service.ts` before
changing the web). A 429 on login means the local throttle cascade (the e2e config already raises the limit to 50/min): wait a
minute and rerun only this file; CI runs the full suite green. Do not run the whole e2e directory locally.

- [ ] **Step 4: Docs**

In `docs/deployment/runner.md`, after the sentence ending "...instead of starting a second one." (the paragraph right under the CLI code block in "Operate from the CLI"), add:

```md
Budgets are also managed on the web: global and runner policies on `/admin/fleet/budgets` (global admins), project and
repo policies on `/<project>/fleet/budgets` (members read; project ADMINs add, edit, delete and resume). A paused or
past-warn policy that covers a project shows as a banner on that project's fleet pages. The CLI and the web call the same
routes, so a pause resumed in one shows in the other within 30 seconds.
```

In `docs/superpowers/specs/2026-10-01-fleet-s1b-budgets-schedules-design.md`, under `### 2.4`, after the `- Web (2b):` bullet group, add:

```md
- 2b plan notes (`2026-10-02-fleet-s1b-slice-2b-budgets-web.md`): the admin page lists only global and runner policies,
  because the admin prefix acts on nothing else (D174); the project page shows its own policies plus the global ones
  read-only (D175); a poll backs up the `fleet_job` notices because spend changes and warns emit none (D178); the project
  page is reached from the jobs-list header and the banner, not the sidebar (D187); the job page shows a budget stop
  reason as text with a link (D188).
```

- [ ] **Step 5: Whole-slice verification**

Run each and expect the stated result.

```bash
cd apps/web && bun run test
```
Expected: every suite passes (the new fleet-budget suites plus all existing ones).

```bash
cd apps/web && bun run lint
```
Expected: exit 0 with no warnings (`--max-warnings=0`).

```bash
cd apps/web && bun run type-check
```
Expected: exit 0. If it fails on missing generated types, run `bunx nuxt prepare` once and repeat. `type-check` covers the `.vue` files; the Jest harness does not.

```bash
bunx turbo run build --filter=@nathapp/koda-web
```
Expected: the web build succeeds (CI job `web build`).

```bash
# apps/api/.env must exist (copy it from the main checkout if this one has none), or api:export-spec exits 1 silently
bun run generate && git status --short openapi.json
```
Expected: no output from `git status` (this slice changes no API contract, D173). `apps/cli/src/generated` is gitignored.

```bash
git diff --stat e94aa04c...HEAD -- apps/api apps/cli apps/runner packages
```
Expected: empty (web and docs only).

- [ ] **Step 6: Commit and hand over**

```bash
git add apps/web/tests/e2e docs/deployment/runner.md docs/superpowers/specs/2026-10-01-fleet-s1b-budgets-schedules-design.md
git commit -m "test(web): fleet budgets e2e; docs: where to manage budgets in the web"
```

CI map for the PR (human opens it): `changes` + `type-check`, `lint`, `web build`, `policy-gates`, `test`, `integration`,
`e2e`, `smoke`, `evaluate`. This slice can only move `type-check`, `lint`, `web build`, `test` and `e2e`; the other jobs run
unchanged code. The PR body should state: web-only, no API or CLI change; the narrowings D174 (admin page omits project/repo
policies), D178 (poll backs up notices), D187 (no project sidebar link); and that slice 3b (schedules web) reuses
`FleetNativeSelect`-based forms, `useFleetBudgetPage`'s pattern and the banner placement.
