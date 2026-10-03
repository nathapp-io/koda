# Fleet S1.5 Slice 1b — Approvals Web Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A human sees pending fleet approvals from a header badge, opens them in a project inbox
(`/:project/fleet/approvals`) or the admin inbox (`/admin/fleet/approvals`), and answers a budget override there:
**Raise and resume** (new limit, re-queue the jobs the pause cancelled before they started) or **Keep paused**. The
budget banner on the jobs list links straight to the override. A Playwright E2E proves the loop: hard stop on a scripted
runner, raise and resume from the inbox with re-queue, the cancelled job runs again.

**Architecture:** Same shape as slices 2b and 3b. A pure library (`lib/fleet-approvals.ts`: queries, sorting, payload
guard, permissions, decide bodies, re-queue result mapping, badge target), a transport composable
(`useFleetApprovals(base)` with the D224 mutation epoch, plus `useFleetApprovalCounts()`), three components (budget
decide panel, decided outcome, the inbox list shared by both pages), a header badge, and two thin pages. The project
event stream gains the `fleet_approval` notice and becomes **one shared EventSource per project per tab** (the page and
the header badge both listen). **No API change**: slice 1a's endpoints are consumed as merged.

**Tech Stack:** Nuxt 3 + Vue 3 `<script setup>`, shadcn-vue primitives, `useApi` (`$api`), `vue-i18n` (en + zh), Jest
with the `mountSfc` harness, Playwright with the scripted runner.

**Spec:** `docs/superpowers/specs/2026-10-02-fleet-s1-5-approvals-design.md` §1.3, §1.5, §1.7, §2.3, §2.5 (live), §5,
§7 (web unit, E2E (1)), §8 (slice 1b). Backend contract from
`docs/superpowers/plans/2026-10-02-fleet-s1-5-slice-1a-approvals-core.md` (D226-D238) and the merged code in
`apps/api/src/fleet/approvals/` (PR #193). UI patterns from
`docs/superpowers/plans/2026-10-02-fleet-s1b-slice-2b-budgets-web.md` (D173-D189) and
`docs/superpowers/plans/2026-10-02-fleet-s1b-slice-3b-schedules-web.md` (D213-D225).

## Global Constraints

- Routes (1a): `GET /projects/:slug/fleet/approvals?status=&type=&jobId=&current=&size=` and `GET /fleet/approvals?...`
  answer the standard page `{ records, total, current, size, hasNext, hasPrev }`, newest first (`requestedAt desc, id
  desc`), `size` 1..100 (default 20). `GET .../approvals/:id` adds `requeueCandidates[]` and
  `requeueCandidatesTruncated` **only for a pending budget approval**. `POST .../approvals/:id/decide` body
  `{ decision, amountUsd?, requeueJobIds?, comment? }` answers the updated `FleetApprovalDto` (no candidates).
  `GET /fleet/approval-counts` answers `{ total, unscoped, projects: [{ projectId, slug, pending }] }`.
- A project inbox lists **only its own project's** approvals (D230); approvals with `projectId: null` (global and runner
  policies) appear on the admin routes only. A no-project id on a project route answers 404 `fleet.approvals`.
- `FleetApprovalDto`: `id, type (budget_override_required | nax_bash_escalate), status (pending | approved | rejected |
  expired | cancelled), projectId, jobId, policyId, payload, outcome, requestedAt, expiresAt, decision (allow |
  allow_for_job | deny | raise_budget_and_resume | keep_paused | null), decidedById, decidedAt, resolvedBy (user | timeout
  | job_ended | superseded | manual_resume | window_reset | policy_deleted | null), comment`, plus the two candidate
  fields above. `RequeueCandidateDto`: `jobId, projectId, feature, queuedAt`.
- Budget payload (spec §1.2): `{ scopeType, scopeId, windowKind, windowStart, spentUsd, amountUsd }`, money as decimal
  strings. Budget outcome: `{ resumedAmountUsd, requeueResults: [{ jobId, ok, error? }] }`; `error` is a JSON string
  `{"code":"<i18n prefix>","args":{...}}` or `"unexpected error"` (1a `errorText`, D233). A manual resume stores
  `requeueResults: []` (D234).
- Decide rules (spec §1.3, §2.3): `raise_budget_and_resume` needs `amountUsd` (number, > 0, at most 4 decimals, at most
  1,000,000, above the window spend, else 400 `fleet.budgetAmountNotAboveSpend`); `requeueJobIds` must be a subset of
  the candidates (400 otherwise); **omitted means none** (D231). `comment` at most 1000 chars. A non-pending approval
  answers 409 `fleet.approvalNotPending`; a policy no longer paused answers 409 `fleet.budgetNotPaused`.
- Permissions (spec §1.7, A6): any project member reads the project inbox; a **budget** approval is decided by a project
  ADMIN (a global ADMIN resolves to project ADMIN, so `useProjectViewerRole().canManage` covers both) or a global ADMIN on
  the admin routes. The admin routes answer 403 (`ret 40003`) to anyone else. Decide controls are **hidden, not
  disabled** (spec §5). Bash approvals are decided from slice 2b.
- Live (spec §2.5): SSE event name `fleet_approval`, data `{ id, type: 'fleet_approval', projectId, approvalId, status,
  at }`, project-scoped approvals only, published after commit. No live channel exists for no-project approvals.
- Web conventions (`.nax/rules/web.md`): API calls only through composables with `useApi()`; `useAppToast()` +
  `extractApiError()` for errors; no hardcoded UI strings; semantic Tailwind tokens only; no raw `$fetch`; selects are
  native (`FleetNativeSelect`, 4b D137); checkboxes are native `<input type="checkbox">` (same reason: testable and
  `check()`-able in Playwright).
- i18n: every key in both `apps/web/i18n/locales/en.json` and `zh.json`; no `|` or `@` in any `fleet.*` message; dynamic
  keys are listed in the enum table of `apps/web/tests/i18n/fleet-locale-parity.spec.ts`.
- `openapi.json` and the generated CLI client must not change. API code must not change.
- Web tests: `cd apps/web && bun run test -- <path>`. Lint `cd apps/web && bun run lint`, types `cd apps/web && bun run
  type-check`. E2E: `cd apps/web && bun run test:e2e -- tests/e2e/fleet-approvals.e2e.spec.ts` (Postgres for e2e on
  :5433 must be up; Playwright starts the API and web). Never run bare `bun test` at the repo root.
- No emojis in source; no `console.log`; no `eslint-disable`; no hand edits under `*/generated/`; conventional commits;
  never push, never open a PR.
- New composables are imported **explicitly** (`import { useFleetApprovals } from '~/composables/useFleetApprovals'`) so
  the jest harness resolves them. `components/fleet/ApprovalInbox.vue` is `FleetApprovalInbox` in templates (Nuxt
  prefixes the `fleet/` directory).

## Decisions

Numbered D239-D254 (slice 1a ended at D238).

| # | Decision | Why |
|:--|:--|:--|
| D239 | Pages: project inbox `/:project/fleet/approvals`, admin inbox `/admin/fleet/approvals`. Navigation: an "Approvals" outline button first in the jobs-list header for every member; a sidebar "Approvals" link (icon `Inbox`) after Budgets for a global ADMIN; breadcrumb Fleet jobs > Approvals. | Same placement rules as Budgets and Schedules (D187, D216). |
| D240 | Pending tab loads **one page of 100** (`status=pending&size=100`) and shows `fleet.common.more` when `hasNext`; All tab pages 20 at a time, newest first. Pending is sorted client-side by `sortPending`: rows with `expiresAt` soonest first, then rows without one in the server's newest-first order. | Spec §5 "Pending sorted by soonest expiry"; the API has no expiry ordering and a pending queue past 100 is not a 1b concern. |
| D241 | One row expanded at a time; expanding fetches `GET :id` (candidates exist only there) and writes `?id=` with `router.replace`; collapsing removes it. A `?id=` on load expands that id; when it is not in the loaded list it is shown first as a "Linked approval" row. A 404 toasts the server message and clears the expansion. | Webhook `path` and the banner link both use `?id=` (spec §2.5). |
| D242 | The open panel is keyed `${id}:${status}`: a poll or live notice re-fetches the expanded approval **only when its status in the list changed**, so a human typing a new limit is never reset by a refresh. | A 30 s poll must not wipe a half-filled decision. |
| D243 | Budget panel: plain `ref` form state (no vee-validate: three fields, no FormField indirection to stub). Amount must parse (`parseAmount`) and be above the **payload's** `spentUsd` (`isAboveSpend`, integer units); errors show after the first submit attempt. Candidates are native checkboxes, all ticked (A4); `requeueJobIds` is **always sent** for a raise, `[]` when none ticked. Comment trimmed, blank omitted, over 1000 chars blocks submit. Truncated candidates show one note (the API gives a flag, not a count). | The server is still the authority (spend may have grown since the stop; its 400 message is shown). Sending `[]` explicitly keeps the body honest about D231. |
| D244 | Who may decide (`canDecide`): status `pending` **and** type budget **and** (admin inbox **or** `viewer.canManage`). Bash rows are never decidable in 1b and show `fleet.approvals.bashLater`. Non-deciders see `fleet.approvals.readOnly`. | Spec §1.7, §5 "hidden, not disabled"; 2b adds the bash rules. |
| D245 | Decided view (`FleetApprovalOutcome`): status, decision, `resolvedBy`, decided time, decider name, comment, raised limit, re-queue results. Re-queue results are shown **only for `resolvedBy: 'user'` raises**; a `manual_resume` shows "Resumed from the budgets page" and no list. A failed re-queue shows a translated reason from the stored code (`fleet.jobs` + `activeJobId` -> activeJob, `fleet.jobs` -> gone, `fleet.jobState` -> notCancelled, `fleet.budgetPaused` -> paused, anything else -> unknown), never raw JSON. | Settles #193 deferred item 2 in the UI without an API change: D234's `[]` on a manual resume must not read as "nothing was selected". |
| D246 | `useProjectEvents` shares **one EventSource per project URL per tab** through a ref-counted hub (`lib/project-event-hub.ts`); each subscriber gets every event type it has a handler for; the stream closes when the last subscriber leaves. | The header badge and the page both subscribe; two streams per tab would halve the browser's six-connection budget per origin. |
| D247 | Header badge (`FleetApprovalBadge`) for every signed-in user: `GET /fleet/approval-counts` on mount, 60 s visible-tab poll, `fleet_approval` notices of the current project (debounced 300 ms), and a module-level `approvalsVersion` bump after every successful decide. Hidden when the total is 0 or before the first successful load; a failed refresh keeps the last count. Shows the total, capped `99+`. Links to the current project's inbox; outside a project to the admin inbox for a global ADMIN, else to the first project with pending approvals. | Spec §5. The version bump covers the admin inbox, which has no live channel. |
| D248 | `BudgetBanner` also loads the project's pending budget approvals (`status=pending&type=budget_override_required&size=100`); a **paused** line whose policy has one gets a "Review override" link to `/<slug>/fleet/approvals?id=<id>`. A failed approvals load keeps the lines without links. Fleet-wide (global) policies never get the link in a project banner: their approval has no project (the badge and admin inbox carry it). | Spec §5; no `pendingApprovalId` on `BudgetPolicyDto`, so no API change. |
| D249 | `useFleetApprovals` keeps a module-level mutation epoch (D224): a load that started before a successful decide is dropped. `decide` puts the returned row in the list in place. | A slow poll must not resurrect a pending row. |
| D250 | Decide errors: every refusal toasts `extractApiError`; a **409** (`ret 40009` or `409`) also re-fetches the open approval and reloads the list (spec §5 "reload the row"). A success toasts the decision; a raise with failed re-queues also toasts how many failed. | The first decider wins; the second must see what happened. |
| D251 | Admin inbox names: project column and candidate job links from `useFleetRepos().loadProjects()` (id -> slug); decider names from the first page of `/admin/users`; unknown ids show `fleet.approvals.outcome.unknownUser`. Project inbox names from `useProjectMemberNames`. Budget scope text reuses `scopeName`/`scopeText` from `lib/fleet-budgets.ts`. | Names are cosmetic: a failed lookup leaves ids or the fallback on screen. |
| D252 | Live: the project inbox reloads on `fleet_approval` notices and resync (debounced 300 ms) plus a 30 s visible-tab poll; the admin inbox polls every 15 s (no live channel, spec "Out of scope"). | Same cadences as the budgets pages (D178). |
| D253 | `LiveFleetApprovalEvent` parsing accepts any non-empty `status` string (D139 rule: a notice only triggers a refetch). | A new API status must not be dropped. |
| D254 | E2E (spec §7 (1)): one spec, one test, `fleet-approvals.e2e.spec.ts`. API-created $0.50 project policy; scripted runner runs job A and spends $0.60 while job B (same runner, different feature) waits QUEUED because every sync reports `freeSlots: 0`; the hard stop cancels B. In the web: banner "Review override" -> inbox row expanded with B ticked -> limit 2 -> Raise and resume -> outcome shows B re-queued; badge count drops by one. Then A completes, B is assigned again, reports RUNNING, and the job page shows RUNNING; B completes. `beforeAll`/`afterAll` delete the project's own policies. | Proves the whole loop through real endpoints; the UI create path is already covered by `fleet-budgets.e2e.spec.ts`. |

## Review Focus

1. **A refresh while a human is mid-decision**: a 30 s poll or a live notice for an unrelated approval must not reset
   the typed limit, the ticks or the comment of the open panel. (Task 6: refresh with an unchanged status keeps the
   panel's form state; a changed status remounts it.)
2. **Two humans decide at once**: the loser gets 409; they must see the toast and the approval re-fetched as decided,
   and the list reloaded, not a panel still offering buttons. (Task 6.)
3. **A `?id=` link to an approval that is not in the loaded list** (already decided while the Pending tab is shown, on
   page 2, or another project's id): the first two open as a linked row; an unknown or foreign id toasts the 404 and
   leaves nothing expanded. (Task 6.)
4. **Re-queue results a human reads after the fact**: a failed re-queue shows a reason in words, never JSON; a manual
   resume never claims "No jobs were selected"; an outcome with a malformed `requeueResults` entry renders the valid
   rows only. (Task 1 `requeueResults`/`requeueFailure`, Task 5.)
5. **Readers who may not decide, and approval types this slice does not answer**: a project DEVELOPER or VIEWER sees no
   Raise/Keep buttons on a budget override, only the read-only line; a bash approval (2a may ship before 2b) renders
   with its type chip and the "later release" note instead of crashing on its payload. (Task 1 `canDecide`,
   `budgetPayload`; Tasks 5 and 6.)

---

## File Structure

| File | Responsibility |
|:--|:--|
| `apps/web/lib/fleet-types.ts` (modify) | Approval enums, `FleetApprovalDto`, `RequeueCandidateDto`, `ApprovalCountsDto`, `DecideApprovalBody`. |
| `apps/web/lib/fleet-approvals.ts` (create) | Pure helpers: query, `sortPending`, `budgetPayload`, `canDecide`, raise/keep bodies and validation, `requeueResults`, `requeueFailure`, `resumedAmount`, `pendingByPolicy`, `inboxPath`, `badgeTarget`, `badgeText`, `approvalSummary`. |
| `apps/web/lib/project-event-stream.ts` (modify) | `LiveFleetApprovalEvent`, `parseFleetApprovalEvent`, `onFleetApproval` handler. |
| `apps/web/lib/project-event-hub.ts` (create) | Ref-counted shared stream per URL (D246). |
| `apps/web/composables/useProjectEvents.ts` (modify) | Subscribe through the shared hub. |
| `apps/web/composables/useFleetApprovals.ts` (create) | Transport, list, mutation epoch, `approvalsVersion`, counts. |
| `apps/web/components/fleet/ApprovalBudgetPanel.vue` (create) | Pending budget decision form. |
| `apps/web/components/fleet/ApprovalOutcome.vue` (create) | Decided approval, read-only. |
| `apps/web/components/fleet/ApprovalInbox.vue` (create) | Tabs, type filter, rows, expansion, `?id=`, decide, polling, live. |
| `apps/web/components/fleet/ApprovalBadge.vue` (create) | Header badge. |
| `apps/web/components/fleet/BudgetBanner.vue` (modify) | "Review override" link (D248). |
| `apps/web/pages/[project]/fleet/approvals.vue` (create) | Project inbox page. |
| `apps/web/pages/admin/fleet/approvals.vue` (create) | Admin inbox page. |
| `apps/web/pages/[project]/fleet/index.vue` (modify) | Approvals button. |
| `apps/web/layouts/default.vue` (modify) | Badge in the header, admin sidebar link, breadcrumb. |
| `apps/web/i18n/locales/en.json`, `zh.json` (modify) | `fleet.approvals.*`, `fleet.jobs.approvals`, `fleet.budgets.banner.review`, `nav.fleetApprovals`. |
| `apps/web/tests/helpers/mount-sfc.ts`, `fleet-harness.ts` (modify) | Real approval components; `Textarea` stub. |
| `apps/web/tests/...` (create/modify) | Unit and component specs per task. |
| `apps/web/tests/e2e/fleet-approvals.e2e.spec.ts`, `fixtures/fleet-approvals-api.ts` (create) | Playwright flow. |
| `docs/deployment/runner.md`, the S1.5 spec §8 (modify) | Web notes, 1b plan notes. |

---

### Task 1: Wire types and the pure approvals library

**Files:**
- Modify: `apps/web/lib/fleet-types.ts` (append after the schedule types)
- Create: `apps/web/lib/fleet-approvals.ts`
- Test: `apps/web/tests/lib/fleet-approvals.spec.ts`

**Interfaces:**
- Consumes: `parseAmount`, `isAboveSpend`, `scopeName`, `scopeText`, `TranslateNamed`, `ScopeNames` from
  `~/lib/fleet-budgets`; `formatUsd` from `~/lib/fleet-jobs`; `BUDGET_SCOPE_TYPES`, `BUDGET_WINDOW_KINDS`,
  `BudgetScopeType`, `BudgetWindowKind` from `~/lib/fleet-types`.
- Produces (later tasks rely on these exact names):
  - types `ApprovalType`, `ApprovalStatus`, `ApprovalDecision`, `ApprovalResolvedBy`, `FleetApprovalDto`,
    `RequeueCandidateDto`, `ApprovalCountsDto`, `DecideApprovalBody`; consts `APPROVAL_TYPES`, `APPROVAL_STATUSES`,
    `APPROVAL_DECISIONS`, `APPROVAL_RESOLVED_BY`.
  - `type ApprovalBase = { kind: 'admin' } | { kind: 'project'; slug: string }`
  - `type ApprovalViewer = { kind: 'admin' } | { kind: 'project'; canManage: boolean }`
  - `type InboxTab = 'pending' | 'all'`; `INBOX_TABS`; `interface ApprovalListFilters { tab: InboxTab; type?: ApprovalType; page?: number }`
  - `buildApprovalQuery(f: ApprovalListFilters): Record<string, string>`
  - `sortPending(rows: readonly FleetApprovalDto[]): FleetApprovalDto[]`
  - `interface BudgetApprovalPayload`; `budgetPayload(a: Pick<FleetApprovalDto, 'type' | 'payload'>): BudgetApprovalPayload | null`
  - `canDecide(a: Pick<FleetApprovalDto, 'type' | 'status'>, viewer: ApprovalViewer): boolean`
  - `type RaiseError = 'amountInvalid' | 'notAbove' | null`; `raiseAmountError(input: string, spentUsd: string): RaiseError`
  - `commentTooLong(comment: string): boolean`; `MAX_COMMENT = 1000`
  - `toRaiseBody(input: { amount: string; selected: readonly string[]; comment: string }): DecideApprovalBody`
  - `toKeepPausedBody(comment: string): DecideApprovalBody`
  - `type RequeueFailure = 'gone' | 'activeJob' | 'notCancelled' | 'paused' | 'unknown'`; `REQUEUE_FAILURES`
  - `requeueFailure(error: unknown): RequeueFailure`
  - `interface RequeueResultView { jobId: string; ok: boolean; reason: RequeueFailure | null }`
  - `requeueResults(a: Pick<FleetApprovalDto, 'decision' | 'resolvedBy' | 'outcome'>): RequeueResultView[] | null`
  - `resumedAmount(a: Pick<FleetApprovalDto, 'outcome'>): string | null`
  - `pendingByPolicy(rows: readonly FleetApprovalDto[]): ReadonlyMap<string, string>`
  - `inboxPath(base: ApprovalBase, id?: string): string`
  - `badgeTarget(counts: ApprovalCountsDto, ctx: { slug: string | null; globalAdmin: boolean }): string | null`
  - `badgeText(total: number): string`; `BADGE_CAP = 99`
  - `approvalSummary(t: TranslateNamed, a: FleetApprovalDto, scopeLabel: (p: BudgetApprovalPayload) => string | null): string`
  - `INBOX_PENDING_SIZE = 100`, `INBOX_PAGE_SIZE = 20`

- [ ] **Step 1: Write the failing test**

Create `apps/web/tests/lib/fleet-approvals.spec.ts`:

```ts
import { describe, test, expect } from '@jest/globals'
import {
  approvalSummary, badgeTarget, badgeText, budgetPayload, buildApprovalQuery, canDecide, commentTooLong, inboxPath,
  pendingByPolicy, raiseAmountError, requeueFailure, requeueResults, resumedAmount, sortPending, toKeepPausedBody,
  toRaiseBody,
} from '../../lib/fleet-approvals'
import type { FleetApprovalDto } from '../../lib/fleet-types'
import { enI18n } from '../helpers/fleet-harness'

const budget = { scopeType: 'project', scopeId: 'p1', windowKind: 'calendar_month_utc', windowStart: '2026-10-01T00:00:00.000Z', spentUsd: '0.6000', amountUsd: '0.5000' }

const approval = (id: string, over: Partial<FleetApprovalDto> = {}): FleetApprovalDto => ({
  id, type: 'budget_override_required', status: 'pending', projectId: 'p1', jobId: null, policyId: 'pol1',
  payload: { ...budget }, outcome: null, requestedAt: '2026-10-03T10:00:00.000Z', expiresAt: null, decision: null,
  decidedById: null, decidedAt: null, resolvedBy: null, comment: null, ...over,
})

describe('buildApprovalQuery', () => {
  test('pending asks for one page of 100 pending rows', () => {
    expect(buildApprovalQuery({ tab: 'pending' })).toEqual({ status: 'pending', size: '100' })
  })
  test('all pages by 20 and sends current only past page 1', () => {
    expect(buildApprovalQuery({ tab: 'all', page: 1 })).toEqual({ size: '20' })
    expect(buildApprovalQuery({ tab: 'all', page: 3, type: 'nax_bash_escalate' })).toEqual({ size: '20', current: '3', type: 'nax_bash_escalate' })
  })
  test('pending ignores the page', () => {
    expect(buildApprovalQuery({ tab: 'pending', page: 4 })).toEqual({ status: 'pending', size: '100' })
  })
})

describe('sortPending', () => {
  test('soonest expiry first, then rows without one in their given order', () => {
    const rows = [
      approval('b1'), approval('x2', { expiresAt: '2026-10-03T10:09:00.000Z' }),
      approval('b2'), approval('x1', { expiresAt: '2026-10-03T10:05:00.000Z' }),
    ]
    expect(sortPending(rows).map((r) => r.id)).toEqual(['x1', 'x2', 'b1', 'b2'])
    expect(rows.map((r) => r.id)).toEqual(['b1', 'x2', 'b2', 'x1'])
  })
})

describe('budgetPayload', () => {
  test('reads a budget payload', () => {
    expect(budgetPayload(approval('a'))).toEqual(budget)
  })
  test('null for a bash approval and for a malformed budget payload (Review Focus 5)', () => {
    expect(budgetPayload(approval('a', { type: 'nax_bash_escalate', payload: { command: 'ls' } }))).toBeNull()
    expect(budgetPayload(approval('a', { payload: { ...budget, spentUsd: 0.6 } }))).toBeNull()
    expect(budgetPayload(approval('a', { payload: { ...budget, scopeType: 'galaxy' } }))).toBeNull()
  })
  test('a missing scopeId reads as null', () => {
    const withoutScopeId = { scopeType: 'global', windowKind: budget.windowKind, windowStart: budget.windowStart, spentUsd: budget.spentUsd, amountUsd: budget.amountUsd }
    expect(budgetPayload(approval('a', { payload: withoutScopeId }))?.scopeId).toBeNull()
  })
})

describe('canDecide (D244, Review Focus 5)', () => {
  const admin = { kind: 'admin' } as const
  const manager = { kind: 'project', canManage: true } as const
  const member = { kind: 'project', canManage: false } as const
  test('a pending budget override: admin inbox or project ADMIN', () => {
    expect(canDecide(approval('a'), admin)).toBe(true)
    expect(canDecide(approval('a'), manager)).toBe(true)
    expect(canDecide(approval('a'), member)).toBe(false)
  })
  test('never once decided, never a bash ask in 1b', () => {
    expect(canDecide(approval('a', { status: 'approved' }), admin)).toBe(false)
    expect(canDecide(approval('a', { type: 'nax_bash_escalate' }), admin)).toBe(false)
  })
})

describe('raise form', () => {
  test('the amount must parse and be above the spend', () => {
    expect(raiseAmountError('', '0.6000')).toBe('amountInvalid')
    expect(raiseAmountError('1.23456', '0.6000')).toBe('amountInvalid')
    expect(raiseAmountError('0.6', '0.6000')).toBe('notAbove')
    expect(raiseAmountError(' 2 ', '0.6000')).toBeNull()
  })
  test('raise always sends the selected ids, even none (D243)', () => {
    expect(toRaiseBody({ amount: '2', selected: [], comment: '  ' })).toEqual({ decision: 'raise_budget_and_resume', amountUsd: 2, requeueJobIds: [] })
    expect(toRaiseBody({ amount: '2.5', selected: ['j1'], comment: ' ok ' }))
      .toEqual({ decision: 'raise_budget_and_resume', amountUsd: 2.5, requeueJobIds: ['j1'], comment: 'ok' })
  })
  test('raise refuses an amount that was not validated', () => {
    expect(() => toRaiseBody({ amount: 'x', selected: [], comment: '' })).toThrow('not validated')
  })
  test('keep paused carries only the decision and a non-blank comment', () => {
    expect(toKeepPausedBody('')).toEqual({ decision: 'keep_paused' })
    expect(toKeepPausedBody(' wait ')).toEqual({ decision: 'keep_paused', comment: 'wait' })
  })
  test('a comment over 1000 characters is too long', () => {
    expect(commentTooLong('a'.repeat(1000))).toBe(false)
    expect(commentTooLong(` ${'a'.repeat(1001)} `)).toBe(true)
  })
})

describe('re-queue results (D245, Review Focus 4)', () => {
  const err = (code: string, args: Record<string, unknown> = {}) => JSON.stringify({ code, args })
  test('maps stored error codes to reasons', () => {
    expect(requeueFailure(err('fleet.jobs'))).toBe('gone')
    expect(requeueFailure(err('fleet.jobs', { activeJobId: 'j9' }))).toBe('activeJob')
    expect(requeueFailure(err('fleet.jobState', { state: 'QUEUED' }))).toBe('notCancelled')
    expect(requeueFailure(err('fleet.budgetPaused'))).toBe('paused')
    expect(requeueFailure(err('fleet.other'))).toBe('unknown')
    expect(requeueFailure('unexpected error')).toBe('unknown')
    expect(requeueFailure(undefined)).toBe('unknown')
    expect(requeueFailure('null')).toBe('unknown')
  })
  test('a user raise lists its results, skipping malformed entries', () => {
    const a = approval('a', {
      status: 'approved', decision: 'raise_budget_and_resume', resolvedBy: 'user',
      outcome: { resumedAmountUsd: '2.0000', requeueResults: [{ jobId: 'j1', ok: true }, { jobId: 'j2', ok: false, error: err('fleet.jobState') }, { ok: true }, 'junk'] },
    })
    expect(requeueResults(a)).toEqual([{ jobId: 'j1', ok: true, reason: null }, { jobId: 'j2', ok: false, reason: 'notCancelled' }])
    expect(resumedAmount(a)).toBe('2.0000')
  })
  test('a manual resume has no re-queue record to show', () => {
    const a = approval('a', { status: 'approved', decision: 'raise_budget_and_resume', resolvedBy: 'manual_resume', outcome: { resumedAmountUsd: '3.0000', requeueResults: [] } })
    expect(requeueResults(a)).toBeNull()
    expect(resumedAmount(a)).toBe('3.0000')
  })
  test('keep paused and missing outcomes have none', () => {
    expect(requeueResults(approval('a', { status: 'rejected', decision: 'keep_paused', resolvedBy: 'user' }))).toBeNull()
    expect(requeueResults(approval('a', { decision: 'raise_budget_and_resume', resolvedBy: 'user', outcome: null }))).toBeNull()
    expect(resumedAmount(approval('a'))).toBeNull()
  })
  test('a numeric resumed amount is shown as a string', () => {
    expect(resumedAmount(approval('a', { outcome: { resumedAmountUsd: 2 } }))).toBe('2')
  })
})

describe('pendingByPolicy (D248)', () => {
  test('maps policy id to the pending budget approval', () => {
    const rows = [approval('a1'), approval('a2', { policyId: 'pol2', status: 'approved' }), approval('a3', { policyId: null }), approval('a4', { type: 'nax_bash_escalate', policyId: 'pol3' })]
    expect([...pendingByPolicy(rows)]).toEqual([['pol1', 'a1']])
  })
})

describe('paths and badge (D241, D247)', () => {
  test('inbox paths', () => {
    expect(inboxPath({ kind: 'project', slug: 'koda' })).toBe('/koda/fleet/approvals')
    expect(inboxPath({ kind: 'project', slug: 'koda' }, 'a b')).toBe('/koda/fleet/approvals?id=a%20b')
    expect(inboxPath({ kind: 'admin' }, 'x')).toBe('/admin/fleet/approvals?id=x')
  })
  const counts = { total: 3, unscoped: 1, projects: [{ projectId: 'p2', slug: 'beta', pending: 2 }] }
  test('in a project the badge goes to that inbox', () => {
    expect(badgeTarget(counts, { slug: 'koda', globalAdmin: true })).toBe('/koda/fleet/approvals')
  })
  test('outside a project: admin inbox for a global admin, else the first project with pending', () => {
    expect(badgeTarget(counts, { slug: null, globalAdmin: true })).toBe('/admin/fleet/approvals')
    expect(badgeTarget(counts, { slug: null, globalAdmin: false })).toBe('/beta/fleet/approvals')
    expect(badgeTarget({ total: 0, unscoped: 0, projects: [] }, { slug: null, globalAdmin: false })).toBeNull()
  })
  test('the count caps at 99+', () => {
    expect(badgeText(7)).toBe('7')
    expect(badgeText(99)).toBe('99')
    expect(badgeText(100)).toBe('99+')
  })
})

describe('approvalSummary', () => {
  const { t } = enI18n()
  test('a budget override names the scope and the stop', () => {
    expect(approvalSummary(t, approval('a'), () => 'koda')).toBe('Budget for project koda stopped at $0.60 of $0.50')
  })
  test('a bash ask and a malformed budget fall back to fixed text', () => {
    expect(approvalSummary(t, approval('a', { type: 'nax_bash_escalate', payload: {} }), () => null)).toBe('A job asks to run a shell command')
    expect(approvalSummary(t, approval('a', { payload: {} }), () => null)).toBe('Budget override')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && bun run test -- tests/lib/fleet-approvals.spec.ts`
Expected: FAIL with "Cannot find module '../../lib/fleet-approvals'".

- [ ] **Step 3: Add the wire types**

Append to `apps/web/lib/fleet-types.ts`:

```ts
/** S1.5 slice 1a wire types (apps/api/src/fleet/approvals/dto). Money inside payload/outcome is a decimal string. */
export const APPROVAL_TYPES = ['budget_override_required', 'nax_bash_escalate'] as const
export type ApprovalType = (typeof APPROVAL_TYPES)[number]
export const APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'expired', 'cancelled'] as const
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number]
export const APPROVAL_DECISIONS = ['allow', 'allow_for_job', 'deny', 'raise_budget_and_resume', 'keep_paused'] as const
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number]
export const APPROVAL_RESOLVED_BY = ['user', 'timeout', 'job_ended', 'superseded', 'manual_resume', 'window_reset', 'policy_deleted'] as const
export type ApprovalResolvedBy = (typeof APPROVAL_RESOLVED_BY)[number]

export interface RequeueCandidateDto {
  jobId: string
  projectId: string
  feature: string
  queuedAt: string
}

export interface FleetApprovalDto {
  id: string
  type: ApprovalType
  status: ApprovalStatus
  projectId: string | null
  jobId: string | null
  policyId: string | null
  payload: Record<string, unknown>
  outcome: Record<string, unknown> | null
  requestedAt: string
  expiresAt: string | null
  decision: ApprovalDecision | null
  decidedById: string | null
  decidedAt: string | null
  resolvedBy: ApprovalResolvedBy | null
  comment: string | null
  /** GET :id of a pending budget approval only (spec §1.5). */
  requeueCandidates?: RequeueCandidateDto[]
  requeueCandidatesTruncated?: boolean
}

export interface ApprovalCountsDto {
  total: number
  unscoped: number
  projects: Array<{ projectId: string; slug: string; pending: number }>
}

export interface DecideApprovalBody {
  decision: ApprovalDecision
  amountUsd?: number
  requeueJobIds?: string[]
  comment?: string
}
```

- [ ] **Step 4: Write the library**

Create `apps/web/lib/fleet-approvals.ts`:

```ts
import { isAboveSpend, parseAmount, scopeText } from '~/lib/fleet-budgets'
import type { TranslateNamed } from '~/lib/fleet-budgets'
import { formatUsd } from '~/lib/fleet-jobs'
import { BUDGET_SCOPE_TYPES, BUDGET_WINDOW_KINDS } from '~/lib/fleet-types'
import type {
  ApprovalCountsDto, ApprovalType, BudgetScopeType, BudgetWindowKind, DecideApprovalBody, FleetApprovalDto,
} from '~/lib/fleet-types'

/** D240: the Pending tab is one page of this many; All pages by INBOX_PAGE_SIZE. */
export const INBOX_PENDING_SIZE = 100
export const INBOX_PAGE_SIZE = 20
export const BADGE_CAP = 99
/** apps/api decide-approval.dto `comment` MaxLength. */
export const MAX_COMMENT = 1000

export type ApprovalBase = { kind: 'admin' } | { kind: 'project'; slug: string }
export type ApprovalViewer = { kind: 'admin' } | { kind: 'project'; canManage: boolean }

export const INBOX_TABS = ['pending', 'all'] as const
export type InboxTab = (typeof INBOX_TABS)[number]

export interface ApprovalListFilters {
  tab: InboxTab
  type?: ApprovalType
  page?: number
}

/** Only set filters reach the query; `current` only past page 1 on the All tab (D240). */
export function buildApprovalQuery(f: ApprovalListFilters): Record<string, string> {
  return {
    ...(f.tab === 'pending' ? { status: 'pending' } : {}),
    ...(f.type ? { type: f.type } : {}),
    size: String(f.tab === 'pending' ? INBOX_PENDING_SIZE : INBOX_PAGE_SIZE),
    ...(f.tab === 'all' && f.page !== undefined && f.page > 1 ? { current: String(f.page) } : {}),
  }
}

/** D240: soonest `expiresAt` first (ISO instants compare as strings), then rows without one in their given order. */
export function sortPending(rows: readonly FleetApprovalDto[]): FleetApprovalDto[] {
  const expiring = rows
    .filter((r) => r.expiresAt !== null)
    .sort((a, b) => (a.expiresAt ?? '').localeCompare(b.expiresAt ?? '') || a.id.localeCompare(b.id))
  return [...expiring, ...rows.filter((r) => r.expiresAt === null)]
}

/** Spec §1.2 budget payload at the time of the stop. */
export interface BudgetApprovalPayload {
  scopeType: BudgetScopeType
  scopeId: string | null
  windowKind: BudgetWindowKind
  windowStart: string
  spentUsd: string
  amountUsd: string
}

const isString = (value: unknown): value is string => typeof value === 'string'

/** The budget payload, or null for another type or a payload that does not have the shape (Review Focus 5). */
export function budgetPayload(a: Pick<FleetApprovalDto, 'type' | 'payload'>): BudgetApprovalPayload | null {
  if (a.type !== 'budget_override_required') return null
  const p = a.payload
  const scopeId = p.scopeId ?? null
  if (!(BUDGET_SCOPE_TYPES as readonly unknown[]).includes(p.scopeType)) return null
  if (!(BUDGET_WINDOW_KINDS as readonly unknown[]).includes(p.windowKind)) return null
  if (!isString(p.windowStart) || !isString(p.spentUsd) || !isString(p.amountUsd)) return null
  if (scopeId !== null && !isString(scopeId)) return null
  return {
    scopeType: p.scopeType as BudgetScopeType,
    scopeId,
    windowKind: p.windowKind as BudgetWindowKind,
    windowStart: p.windowStart,
    spentUsd: p.spentUsd,
    amountUsd: p.amountUsd,
  }
}

/** D244 (spec §1.7): budget overrides only in 1b; the server stays the gate. */
export function canDecide(a: Pick<FleetApprovalDto, 'type' | 'status'>, viewer: ApprovalViewer): boolean {
  if (a.status !== 'pending' || a.type !== 'budget_override_required') return false
  return viewer.kind === 'admin' || viewer.canManage
}

export type RaiseError = 'amountInvalid' | 'notAbove' | null

/** D243: the new limit must parse and sit above the spend recorded at the stop (the server re-checks the live spend). */
export function raiseAmountError(input: string, spentUsd: string): RaiseError {
  const trimmed = input.trim()
  if (parseAmount(trimmed) === null) return 'amountInvalid'
  return isAboveSpend(trimmed, spentUsd) ? null : 'notAbove'
}

export const commentTooLong = (comment: string): boolean => comment.trim().length > MAX_COMMENT

const commentField = (comment: string): { comment?: string } => {
  const trimmed = comment.trim()
  return trimmed === '' ? {} : { comment: trimmed }
}

/** D243: `requeueJobIds` always sent, `[]` when nothing is ticked (D231: omitted would also mean none). */
export function toRaiseBody(input: { amount: string; selected: readonly string[]; comment: string }): DecideApprovalBody {
  const amountUsd = parseAmount(input.amount.trim())
  if (amountUsd === null) throw new Error('fleet-approvals: amount was not validated')
  return { decision: 'raise_budget_and_resume', amountUsd, requeueJobIds: [...input.selected], ...commentField(input.comment) }
}

export const toKeepPausedBody = (comment: string): DecideApprovalBody => ({ decision: 'keep_paused', ...commentField(comment) })

export const REQUEUE_FAILURES = ['gone', 'activeJob', 'notCancelled', 'paused', 'unknown'] as const
export type RequeueFailure = (typeof REQUEUE_FAILURES)[number]

/** D245: the reason behind a stored 1a `errorText` (`{"code","args"}` JSON or "unexpected error"). */
export function requeueFailure(error: unknown): RequeueFailure {
  if (!isString(error)) return 'unknown'
  let parsed: unknown
  try {
    parsed = JSON.parse(error)
  } catch {
    return 'unknown'
  }
  if (parsed === null || typeof parsed !== 'object') return 'unknown'
  const { code, args } = parsed as { code?: unknown; args?: unknown }
  switch (code) {
    case 'fleet.jobs':
      return args !== null && typeof args === 'object' && 'activeJobId' in args ? 'activeJob' : 'gone'
    case 'fleet.jobState':
      return 'notCancelled'
    case 'fleet.budgetPaused':
      return 'paused'
    default:
      return 'unknown'
  }
}

export interface RequeueResultView {
  jobId: string
  ok: boolean
  reason: RequeueFailure | null
}

/**
 * D245: the re-queue record of a raise decided in the inbox. Null for anything else, including a manual resume, whose
 * stored `[]` means "not offered", not "none selected" (#193 deferred item 2). Malformed entries are skipped.
 */
export function requeueResults(a: Pick<FleetApprovalDto, 'decision' | 'resolvedBy' | 'outcome'>): RequeueResultView[] | null {
  if (a.decision !== 'raise_budget_and_resume' || a.resolvedBy !== 'user') return null
  const raw = a.outcome?.requeueResults
  if (!Array.isArray(raw)) return null
  return raw.flatMap((entry: unknown): RequeueResultView[] => {
    if (entry === null || typeof entry !== 'object') return []
    const row = entry as { jobId?: unknown; ok?: unknown; error?: unknown }
    if (!isString(row.jobId) || typeof row.ok !== 'boolean') return []
    return [{ jobId: row.jobId, ok: row.ok, reason: row.ok ? null : requeueFailure(row.error) }]
  })
}

export function resumedAmount(a: Pick<FleetApprovalDto, 'outcome'>): string | null {
  const value = a.outcome?.resumedAmountUsd
  if (isString(value)) return value
  return typeof value === 'number' ? String(value) : null
}

/** D248: policy id -> its pending budget approval id. */
export function pendingByPolicy(rows: readonly FleetApprovalDto[]): ReadonlyMap<string, string> {
  return new Map(
    rows
      .filter((r) => r.status === 'pending' && r.type === 'budget_override_required' && r.policyId !== null)
      .map((r): [string, string] => [r.policyId as string, r.id]),
  )
}

export function inboxPath(base: ApprovalBase, id?: string): string {
  const root = base.kind === 'admin' ? '/admin/fleet/approvals' : `/${base.slug}/fleet/approvals`
  return id === undefined ? root : `${root}?id=${encodeURIComponent(id)}`
}

/** D247: where the header badge leads. */
export function badgeTarget(counts: ApprovalCountsDto, ctx: { slug: string | null; globalAdmin: boolean }): string | null {
  if (ctx.slug) return inboxPath({ kind: 'project', slug: ctx.slug })
  if (ctx.globalAdmin) return inboxPath({ kind: 'admin' })
  const first = counts.projects[0]
  return first ? inboxPath({ kind: 'project', slug: first.slug }) : null
}

export const badgeText = (total: number): string => (total > BADGE_CAP ? `${BADGE_CAP}+` : String(total))

/** One-line row summary. `scopeLabel` names a budget scope (pages know their repo, runner and project names). */
export function approvalSummary(
  t: TranslateNamed,
  a: FleetApprovalDto,
  scopeLabel: (p: BudgetApprovalPayload) => string | null,
): string {
  const budget = budgetPayload(a)
  if (budget) {
    return t('fleet.approvals.summary.budget', {
      scope: scopeText(t, budget, scopeLabel(budget)),
      spent: formatUsd(budget.spentUsd),
      amount: formatUsd(budget.amountUsd),
    })
  }
  return a.type === 'nax_bash_escalate' ? t('fleet.approvals.summary.bash') : t('fleet.approvals.type.budget_override_required')
}
```

Note: the `approvalSummary` test asserts English copy, so it only passes after Task 2 adds the keys. Run Step 5 with that
one `describe` expected to fail, and confirm it passes at the end of Task 2.

- [ ] **Step 5: Run test to verify it passes (except approvalSummary)**

Run: `cd apps/web && bun run test -- tests/lib/fleet-approvals.spec.ts`
Expected: every test PASS except the two in `describe('approvalSummary')`, which fail on missing i18n keys.

- [ ] **Step 6: Type-check and commit**

Run: `cd apps/web && bun run type-check`
Expected: no errors.

```bash
git add apps/web/lib/fleet-types.ts apps/web/lib/fleet-approvals.ts apps/web/tests/lib/fleet-approvals.spec.ts
git commit -m "feat(web): approval wire types and the pure approvals library (S1.5 1b)"
```

---

### Task 2: Approval strings in en and zh

**Files:**
- Modify: `apps/web/i18n/locales/en.json`, `apps/web/i18n/locales/zh.json`
- Modify: `apps/web/tests/i18n/fleet-locale-parity.spec.ts`

**Interfaces:**
- Produces: every `fleet.approvals.*` key the components below render; `fleet.jobs.approvals`;
  `fleet.budgets.banner.review`; `nav.fleetApprovals`.

- [ ] **Step 1: Write the failing test**

In `apps/web/tests/i18n/fleet-locale-parity.spec.ts`, replace the `'fleet.budgets.banner'` entry of `ENUMS` and add the
approval enums after `'fleet.schedules.form.placementMode'`:

```ts
  'fleet.budgets.banner': ['paused', 'warning', 'more', 'view', 'review'],
```

```ts
  'fleet.approvals.type': ['budget_override_required', 'nax_bash_escalate'],
  'fleet.approvals.status': ['pending', 'approved', 'rejected', 'expired', 'cancelled'],
  'fleet.approvals.decision': ['allow', 'allow_for_job', 'deny', 'raise_budget_and_resume', 'keep_paused'],
  'fleet.approvals.resolvedBy': ['user', 'timeout', 'job_ended', 'superseded', 'manual_resume', 'window_reset', 'policy_deleted'],
  'fleet.approvals.requeueFailure': ['gone', 'activeJob', 'notCancelled', 'paused', 'unknown'],
  'fleet.approvals.tabs': ['pending', 'all'],
  'fleet.approvals.empty': ['pending', 'all'],
  'fleet.approvals.validation': ['amountInvalid', 'notAbove', 'commentTooLong'],
  'fleet.approvals.toast': ['raise_budget_and_resume', 'keep_paused', 'requeueFailed'],
```

Add `'nav.fleetApprovals'` to the translated-in-both list:

```ts
  test.each(['nav.fleetRunners', 'nav.fleetRepos', 'nav.fleetBudgets', 'nav.fleetApprovals'])('%s is translated in both locales', (key) => {
```

And add after the schedule-keys test:

```ts
  test('the approval keys the pages render exist (S1.5 1b)', () => {
    for (const key of [
      'fleet.approvals.title', 'fleet.approvals.subtitleProject', 'fleet.approvals.subtitleAdmin', 'fleet.approvals.readOnly',
      'fleet.approvals.bashLater', 'fleet.approvals.linked', 'fleet.approvals.noProject', 'fleet.approvals.filters.allTypes',
      'fleet.approvals.summary.budget', 'fleet.approvals.summary.bash', 'fleet.approvals.budget.raise', 'fleet.approvals.budget.keep',
      'fleet.approvals.outcome.manualResume', 'fleet.approvals.outcome.requeueOk', 'fleet.approvals.badge.label', 'fleet.jobs.approvals',
    ]) {
      expect(String(at(en, key) ?? '').trim()).not.toBe('')
    }
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && bun run test -- tests/i18n/fleet-locale-parity.spec.ts`
Expected: FAIL (`fleet.approvals` missing; `fleet.budgets.banner` lacks `review`).

- [ ] **Step 3: Add the English strings**

In `en.json`: add `"fleetApprovals": "Approvals"` to `nav`; add `"approvals": "Approvals"` to `fleet.jobs`; add
`"review": "Review override"` to `fleet.budgets.banner`; add this block as `fleet.approvals` (after `fleet.schedules`):

```json
"approvals": {
  "title": "Approvals",
  "subtitleProject": "Decisions this project's fleet is waiting on.",
  "subtitleAdmin": "Every fleet decision, including fleet-wide and runner budgets.",
  "tabs": { "pending": "Pending", "all": "All" },
  "filters": { "type": "Type", "allTypes": "All types" },
  "type": { "budget_override_required": "Budget override", "nax_bash_escalate": "Shell command" },
  "status": { "pending": "Pending", "approved": "Approved", "rejected": "Rejected", "expired": "Expired", "cancelled": "Cancelled" },
  "decision": {
    "allow": "Allowed once",
    "allow_for_job": "Allowed for this job",
    "deny": "Denied",
    "raise_budget_and_resume": "Raised and resumed",
    "keep_paused": "Kept paused"
  },
  "resolvedBy": {
    "user": "Decided in the inbox",
    "timeout": "Timed out",
    "job_ended": "The job ended first",
    "superseded": "Replaced by a newer stop",
    "manual_resume": "Resumed from the budgets page",
    "window_reset": "The budget window rolled over",
    "policy_deleted": "The budget policy was deleted"
  },
  "summary": {
    "budget": "Budget for {scope} stopped at {spent} of {amount}",
    "bash": "A job asks to run a shell command"
  },
  "empty": { "pending": "Nothing is waiting for a decision.", "all": "No approvals yet." },
  "linked": "Linked approval",
  "noProject": "Fleet-wide",
  "readOnly": "You can read this approval. Only a project admin can decide a budget override.",
  "bashLater": "Shell command approvals are answered on this page from a later release.",
  "budget": {
    "summary": "{spent} spent of a {amount} limit ({window}).",
    "amount": "New limit (USD)",
    "amountHint": "Must be above the {spent} already spent.",
    "requeueTitle": "Re-queue jobs the pause cancelled before they started",
    "noCandidates": "No cancelled jobs to re-queue.",
    "truncated": "More cancelled jobs exist than are listed. Only the listed ones can be re-queued here.",
    "comment": "Comment (optional)",
    "raise": "Raise and resume",
    "keep": "Keep paused",
    "submitting": "Saving..."
  },
  "validation": {
    "amountInvalid": "Enter an amount above 0 with at most 4 decimals.",
    "notAbove": "The new limit must be above {spent}.",
    "commentTooLong": "Keep the comment to 1000 characters."
  },
  "outcome": {
    "decidedBy": "By {name}",
    "unknownUser": "a former member",
    "decidedAt": "On {at}",
    "manualResume": "Resumed from the budgets page. No jobs were offered for re-queue.",
    "raisedTo": "Limit raised to {amount}",
    "requeueTitle": "Re-queue",
    "requeueNone": "No jobs were selected for re-queue.",
    "requeueOk": "Re-queued",
    "comment": "Comment: {comment}"
  },
  "requeueFailure": {
    "gone": "Not re-queued: the job no longer exists.",
    "activeJob": "Not re-queued: another job for this feature is active.",
    "notCancelled": "Not re-queued: the job is no longer cancelled.",
    "paused": "Not re-queued: a fleet budget still pauses it.",
    "unknown": "Not re-queued."
  },
  "toast": {
    "raise_budget_and_resume": "Budget raised and resumed.",
    "keep_paused": "The budget stays paused.",
    "requeueFailed": "{count} job(s) could not be re-queued."
  },
  "badge": { "label": "{count} approvals waiting" }
}
```

- [ ] **Step 4: Add the Chinese strings**

In `zh.json`: `nav.fleetApprovals`: `"审批"`; `fleet.jobs.approvals`: `"审批"`; `fleet.budgets.banner.review`:
`"处理超额审批"`; and `fleet.approvals`:

```json
"approvals": {
  "title": "审批",
  "subtitleProject": "本项目的集群正在等待的决定。",
  "subtitleAdmin": "集群中的所有决定，包括全局和运行器预算。",
  "tabs": { "pending": "待处理", "all": "全部" },
  "filters": { "type": "类型", "allTypes": "全部类型" },
  "type": { "budget_override_required": "预算超额", "nax_bash_escalate": "Shell 命令" },
  "status": { "pending": "待处理", "approved": "已批准", "rejected": "已拒绝", "expired": "已过期", "cancelled": "已取消" },
  "decision": {
    "allow": "允许一次",
    "allow_for_job": "本任务内允许",
    "deny": "已拒绝",
    "raise_budget_and_resume": "已提高并恢复",
    "keep_paused": "保持暂停"
  },
  "resolvedBy": {
    "user": "在收件箱中决定",
    "timeout": "已超时",
    "job_ended": "任务已先结束",
    "superseded": "被新的停止取代",
    "manual_resume": "已在预算页面恢复",
    "window_reset": "预算周期已滚动",
    "policy_deleted": "预算策略已删除"
  },
  "summary": {
    "budget": "{scope} 的预算在 {spent} / {amount} 时停止",
    "bash": "有任务请求运行 shell 命令"
  },
  "empty": { "pending": "没有等待决定的审批。", "all": "暂无审批。" },
  "linked": "链接的审批",
  "noProject": "全局",
  "readOnly": "你可以查看此审批。只有项目管理员可以决定预算超额。",
  "bashLater": "Shell 命令审批将在后续版本中在此页面处理。",
  "budget": {
    "summary": "已花费 {spent}，限额 {amount}（{window}）。",
    "amount": "新限额（美元）",
    "amountHint": "必须高于已花费的 {spent}。",
    "requeueTitle": "重新排队在暂停时尚未开始就被取消的任务",
    "noCandidates": "没有可重新排队的已取消任务。",
    "truncated": "已取消的任务多于所列数量。此处只能重新排队所列任务。",
    "comment": "备注（可选）",
    "raise": "提高并恢复",
    "keep": "保持暂停",
    "submitting": "正在保存..."
  },
  "validation": {
    "amountInvalid": "请输入大于 0 且最多 4 位小数的金额。",
    "notAbove": "新限额必须高于 {spent}。",
    "commentTooLong": "备注不能超过 1000 个字符。"
  },
  "outcome": {
    "decidedBy": "由 {name}",
    "unknownUser": "已离开的成员",
    "decidedAt": "于 {at}",
    "manualResume": "已在预算页面恢复。没有提供可重新排队的任务。",
    "raisedTo": "限额已提高到 {amount}",
    "requeueTitle": "重新排队",
    "requeueNone": "没有选择要重新排队的任务。",
    "requeueOk": "已重新排队",
    "comment": "备注：{comment}"
  },
  "requeueFailure": {
    "gone": "未重新排队：任务已不存在。",
    "activeJob": "未重新排队：此功能已有活动任务。",
    "notCancelled": "未重新排队：任务已不再是取消状态。",
    "paused": "未重新排队：仍被集群预算暂停。",
    "unknown": "未重新排队。"
  },
  "toast": {
    "raise_budget_and_resume": "预算已提高并恢复。",
    "keep_paused": "预算保持暂停。",
    "requeueFailed": "{count} 个任务无法重新排队。"
  },
  "badge": { "label": "{count} 个审批等待处理" }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/web && bun run test -- tests/i18n tests/lib/fleet-approvals.spec.ts`
Expected: PASS, including `describe('approvalSummary')` from Task 1 and `used-keys-exist`.

- [ ] **Step 6: Commit**

```bash
git add apps/web/i18n/locales/en.json apps/web/i18n/locales/zh.json apps/web/tests/i18n/fleet-locale-parity.spec.ts
git commit -m "feat(web): approval strings in en and zh (S1.5 1b)"
```

---

### Task 3: `fleet_approval` live notices and one shared stream per project

**Files:**
- Modify: `apps/web/lib/project-event-stream.ts`
- Create: `apps/web/lib/project-event-hub.ts`
- Modify: `apps/web/composables/useProjectEvents.ts`
- Test: `apps/web/tests/lib/project-event-stream-fleet.spec.ts` (extend), `apps/web/tests/lib/project-event-hub.spec.ts`
  (create), `apps/web/tests/composables/useProjectEvents.spec.ts` (update)

**Interfaces:**
- Produces: `LiveFleetApprovalEvent { id; type: 'fleet_approval'; projectId; approvalId; status: string; at }`,
  `parseFleetApprovalEvent(raw: string): LiveFleetApprovalEvent | null`, `ProjectEventHandlers.onFleetApproval?:
  (event: LiveFleetApprovalEvent) => void`; `createProjectEventHub(deps: ProjectEventStreamDeps): ProjectEventHub` with
  `subscribe(url: string, handlers: ProjectEventHandlers): () => void`. `useProjectEvents(slug, handlers)` keeps its
  signature.

- [ ] **Step 1: Write the failing tests**

Append to `apps/web/tests/lib/project-event-stream-fleet.spec.ts` (it already defines `FakeEventSource` and `open`;
add `parseFleetApprovalEvent` and `LiveFleetApprovalEvent` to its import):

```ts
const approvalEvent = (id: string, over: Partial<LiveFleetApprovalEvent> = {}): LiveFleetApprovalEvent => ({
  id, type: 'fleet_approval', projectId: 'p1', approvalId: 'a1', status: 'pending', at: '2026-10-03T00:00:00.000Z', ...over,
})

describe('fleet_approval notices (S1.5 1b)', () => {
  test('parses a notice and accepts any non-empty status (D253)', () => {
    expect(parseFleetApprovalEvent(JSON.stringify(approvalEvent('e1')))).toEqual(approvalEvent('e1'))
    expect(parseFleetApprovalEvent(JSON.stringify(approvalEvent('e1', { status: 'brand_new' }))))?.toBeTruthy()
  })

  test('rejects other shapes', () => {
    expect(parseFleetApprovalEvent('not json')).toBeNull()
    expect(parseFleetApprovalEvent(JSON.stringify({ ...approvalEvent('e1'), type: 'fleet_job' }))).toBeNull()
    expect(parseFleetApprovalEvent(JSON.stringify({ ...approvalEvent('e1'), approvalId: 5 }))).toBeNull()
    expect(parseFleetApprovalEvent(JSON.stringify({ ...approvalEvent('e1'), status: '' }))).toBeNull()
  })

  test('delivers fleet_approval events once each, only when a handler is given', () => {
    const onFleetApproval = jest.fn()
    const source = open({ onFleetApproval, onResync: () => undefined })
    source.emit('fleet_approval', approvalEvent('e1'))
    source.emit('fleet_approval', approvalEvent('e1'))
    expect(onFleetApproval).toHaveBeenCalledTimes(1)

    const silent = open({ onResync: () => undefined })
    expect(silent.listenerTypes()).not.toContain('fleet_approval')
  })
})
```

Create `apps/web/tests/lib/project-event-hub.spec.ts`:

```ts
import { describe, expect, jest, test } from '@jest/globals'
import { createProjectEventHub } from '~/lib/project-event-hub'
import type { EventSourceLike } from '~/lib/project-event-stream'

class FakeEventSource implements EventSourceLike {
  readyState = 0
  onopen: ((ev: unknown) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  closed = false
  private listeners: Record<string, Array<(ev: { data: string }) => void>> = {}
  constructor(readonly url: string) {}
  addEventListener(type: string, listener: (ev: { data: string }) => void): void {
    this.listeners = { ...this.listeners, [type]: [...(this.listeners[type] ?? []), listener] }
  }
  close(): void { this.closed = true; this.readyState = 2 }
  emit(type: string, data: unknown): void {
    for (const listener of this.listeners[type] ?? []) listener({ data: JSON.stringify(data) })
  }
}

function hub() {
  const sources: FakeEventSource[] = []
  const h = createProjectEventHub({
    createEventSource: (url) => {
      const s = new FakeEventSource(url)
      sources.push(s)
      return s
    },
    refreshAuth: async () => true,
    setTimer: () => null,
    clearTimer: () => undefined,
  })
  return { h, sources }
}

const job = { id: 'e1', type: 'fleet_job', projectId: 'p1', jobId: 'j1', state: 'RUNNING', at: 'x' }
const approval = { id: 'e2', type: 'fleet_approval', projectId: 'p1', approvalId: 'a1', status: 'pending', at: 'x' }

describe('createProjectEventHub (D246)', () => {
  test('two subscribers to one URL share one EventSource and each gets the events it handles', () => {
    const { h, sources } = hub()
    const page = { onFleetJob: jest.fn(), onResync: jest.fn() }
    const badge = { onFleetApproval: jest.fn(), onResync: jest.fn() }
    h.subscribe('/api/projects/p1/events', page)
    h.subscribe('/api/projects/p1/events', badge)
    expect(sources).toHaveLength(1)

    sources[0].emit('fleet_job', job)
    sources[0].emit('fleet_approval', approval)
    expect(page.onFleetJob).toHaveBeenCalledTimes(1)
    expect(badge.onFleetApproval).toHaveBeenCalledTimes(1)
  })

  test('a resync reaches every subscriber', () => {
    const { h, sources } = hub()
    const a = { onResync: jest.fn() }
    const b = { onResync: jest.fn() }
    h.subscribe('/u', a)
    h.subscribe('/u', b)
    sources[0].onerror?.({})
    sources[0].onopen?.({})
    expect(a.onResync).toHaveBeenCalledTimes(1)
    expect(b.onResync).toHaveBeenCalledTimes(1)
  })

  test('the stream closes only when the last subscriber leaves; a later subscribe opens a new one', () => {
    const { h, sources } = hub()
    const offA = h.subscribe('/u', { onResync: () => undefined })
    const offB = h.subscribe('/u', { onResync: () => undefined })
    offA()
    expect(sources[0].closed).toBe(false)
    offB()
    expect(sources[0].closed).toBe(true)
    h.subscribe('/u', { onResync: () => undefined })
    expect(sources).toHaveLength(2)
  })

  test('unsubscribing twice, or the same handlers object subscribed twice, is safe', () => {
    const { h, sources } = hub()
    const handlers = { onFleetJob: jest.fn(), onResync: () => undefined }
    const off1 = h.subscribe('/u', handlers)
    h.subscribe('/u', handlers)
    off1()
    off1()
    sources[0].emit('fleet_job', job)
    expect(handlers.onFleetJob).toHaveBeenCalledTimes(1)
    expect(sources[0].closed).toBe(false)
  })

  test('different URLs get different streams', () => {
    const { h, sources } = hub()
    h.subscribe('/a', { onResync: () => undefined })
    h.subscribe('/b', { onResync: () => undefined })
    expect(sources.map((s) => s.url)).toEqual(['/a', '/b'])
  })
})
```

Replace the body of `apps/web/tests/composables/useProjectEvents.spec.ts`'s first and third tests (the source-shape
assertions) so they match the hub:

```ts
  test('subscribes only on mount (never during SSR) and unsubscribes on unmount', () => {
    expect(source).toMatch(/onMounted\(\(\) => \{[\s\S]*\.subscribe\(/)
    expect(source).toMatch(/onBeforeUnmount\(\(\) => \{[\s\S]*unsubscribe\?\.\(\)/)
  })

  test('targets the proxied events route with the slug encoded by apiPath', () => {
    expect(source).toContain('apiPath`/api/projects/${slug}/events`')
  })

  test('refreshes auth through useAuth, resolved during setup, read at call time by the shared hub', () => {
    expect(source).toContain('const { refresh } = useAuth()')
    expect(source).toContain('refreshAuth: () => latestRefresh()')
  })
```

(keep the `typeof EventSource === 'undefined'` test unchanged).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web && bun run test -- tests/lib/project-event-stream-fleet.spec.ts tests/lib/project-event-hub.spec.ts tests/composables/useProjectEvents.spec.ts`
Expected: FAIL (`parseFleetApprovalEvent` not exported, hub module missing, source shapes differ).

- [ ] **Step 3: Parse and deliver `fleet_approval`**

In `apps/web/lib/project-event-stream.ts`, after `LiveFleetJobEvent`:

```ts
/** S1.5 §2.5: content-free approval notice; the page refetches (project-scoped approvals only). */
export interface LiveFleetApprovalEvent {
  id: string
  type: 'fleet_approval'
  projectId: string
  approvalId: string
  /** Any non-empty string (D253, same rule as D139). */
  status: string
  at: string
}
```

Extend the handlers:

```ts
export interface ProjectEventHandlers {
  onEvent?: (event: LiveTicketEvent) => void
  onFleetJob?: (event: LiveFleetJobEvent) => void
  onFleetApproval?: (event: LiveFleetApprovalEvent) => void
  onResync: () => void
}
```

After `parseFleetJobEvent`:

```ts
export function parseFleetApprovalEvent(raw: string): LiveFleetApprovalEvent | null {
  try {
    const value = JSON.parse(raw) as Partial<LiveFleetApprovalEvent> | null
    if (!value || typeof value !== 'object') return null
    if (value.type !== 'fleet_approval' || typeof value.id !== 'string' || typeof value.approvalId !== 'string') return null
    if (typeof value.status !== 'string' || value.status.length === 0) return null
    return value as LiveFleetApprovalEvent
  }
  catch {
    return null
  }
}
```

In `open()`, after the `fleet_job` block:

```ts
    const onFleetApproval = handlers.onFleetApproval
    if (onFleetApproval) {
      es.addEventListener('fleet_approval', (ev) => {
        const event = parseFleetApprovalEvent(ev.data)
        if (event && isNew(event.id)) onFleetApproval(event)
      })
    }
```

- [ ] **Step 4: Write the hub**

Create `apps/web/lib/project-event-hub.ts`:

```ts
import { createProjectEventStream } from '~/lib/project-event-stream'
import type { ProjectEventHandlers, ProjectEventStreamDeps } from '~/lib/project-event-stream'

/** One subscription; its identity (not the handlers object) is what unsubscribe removes. */
interface Entry {
  handlers: ProjectEventHandlers
}

export interface ProjectEventHub {
  /** Returns the unsubscribe; calling it more than once is a no-op. */
  subscribe: (url: string, handlers: ProjectEventHandlers) => () => void
}

/**
 * D246: one EventSource per URL, shared by every subscriber in the tab (a page and the header badge). The fan-out
 * handlers define every event type, so the stream listens for all of them; each subscriber gets the ones it handles.
 */
export function createProjectEventHub(deps: ProjectEventStreamDeps): ProjectEventHub {
  let entries: ReadonlyMap<string, readonly Entry[]> = new Map()
  let streams: ReadonlyMap<string, { close: () => void }> = new Map()

  const current = (url: string): readonly Entry[] => entries.get(url) ?? []

  const fanOut = (url: string): ProjectEventHandlers => ({
    onEvent: (event) => { for (const e of current(url)) e.handlers.onEvent?.(event) },
    onFleetJob: (event) => { for (const e of current(url)) e.handlers.onFleetJob?.(event) },
    onFleetApproval: (event) => { for (const e of current(url)) e.handlers.onFleetApproval?.(event) },
    onResync: () => { for (const e of current(url)) e.handlers.onResync() },
  })

  function subscribe(url: string, handlers: ProjectEventHandlers): () => void {
    const entry: Entry = { handlers }
    entries = new Map([...entries, [url, [...current(url), entry]]])
    if (!streams.has(url)) streams = new Map([...streams, [url, createProjectEventStream(url, fanOut(url), deps)]])

    let active = true
    return () => {
      if (!active) return
      active = false
      const rest = current(url).filter((e) => e !== entry)
      if (rest.length > 0) {
        entries = new Map([...entries, [url, rest]])
        return
      }
      entries = new Map([...entries].filter(([key]) => key !== url))
      streams.get(url)?.close()
      streams = new Map([...streams].filter(([key]) => key !== url))
    }
  }

  return { subscribe }
}
```

- [ ] **Step 5: Subscribe through the hub**

Replace `apps/web/composables/useProjectEvents.ts`:

```ts
import { onBeforeUnmount, onMounted } from 'vue'
import { apiPath } from '~/lib/api-path'
import { createProjectEventHub } from '~/lib/project-event-hub'
import type { ProjectEventHub } from '~/lib/project-event-hub'
import type { EventSourceLike, ProjectEventHandlers } from '~/lib/project-event-stream'

let hub: ProjectEventHub | null = null
/** The newest component's useAuth().refresh; the shared stream reads it when it needs to recover. */
let latestRefresh: () => Promise<boolean> = async () => false

/** Created on first client mount only, so it never exists during SSR. */
function sharedHub(): ProjectEventHub {
  hub ??= createProjectEventHub({
    createEventSource: url => new EventSource(url) as unknown as EventSourceLike,
    refreshAuth: () => latestRefresh(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
  })
  return hub
}

/**
 * Live updates for one project (Track 1 Slice 5). Client-only: subscribes on mount and unsubscribes on unmount.
 * Every subscriber in the tab shares one EventSource per project (S1.5 1b D246).
 */
export function useProjectEvents(slug: string, handlers: ProjectEventHandlers): void {
  const { refresh } = useAuth()
  let unsubscribe: (() => void) | null = null

  onMounted(() => {
    if (typeof EventSource === 'undefined') return
    latestRefresh = refresh
    unsubscribe = sharedHub().subscribe(apiPath`/api/projects/${slug}/events`, handlers)
  })

  onBeforeUnmount(() => {
    unsubscribe?.()
    unsubscribe = null
  })
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd apps/web && bun run test -- tests/lib/project-event-stream.spec.ts tests/lib/project-event-stream-fleet.spec.ts tests/lib/project-event-hub.spec.ts tests/composables/useProjectEvents.spec.ts tests/pages/live-wiring.spec.ts`
Expected: PASS. If `live-wiring.spec.ts` asserts the old composable source, update only the assertions that name
`createProjectEventStream`/`stream?.close()` inside `useProjectEvents.ts` to the hub equivalents above.

- [ ] **Step 7: Commit**

```bash
git add apps/web/lib/project-event-stream.ts apps/web/lib/project-event-hub.ts apps/web/composables/useProjectEvents.ts apps/web/tests/lib/project-event-stream-fleet.spec.ts apps/web/tests/lib/project-event-hub.spec.ts apps/web/tests/composables/useProjectEvents.spec.ts
git commit -m "feat(web): fleet_approval live notices and one shared event stream per project (S1.5 1b D246)"
```

(add `tests/pages/live-wiring.spec.ts` only if Step 6 changed it)

---

### Task 4: Approvals transport and counts composables

**Files:**
- Create: `apps/web/composables/useFleetApprovals.ts`
- Test: `apps/web/tests/composables/useFleetApprovals.spec.ts`

**Interfaces:**
- Consumes: `buildApprovalQuery`, `sortPending`, `ApprovalBase`, `ApprovalListFilters` (Task 1).
- Produces:
  - `approvalRoot(base: ApprovalBase): string`, `approvalItem(base: ApprovalBase, id: string): string`
  - `approvalsVersion: Ref<number>` (module-level; bumped after every successful decide, D247)
  - `useFleetApprovals(base: ApprovalBase)` -> `{ approvals: Ref<FleetApprovalDto[]>, total: Ref<number>, page:
    Ref<number>, hasNext: Ref<boolean>, load(f: ApprovalListFilters): Promise<boolean>, get(id: string):
    Promise<FleetApprovalDto>, decide(id: string, body: DecideApprovalBody): Promise<FleetApprovalDto> }`; `load` answers
    false when its result was dropped (a newer load or a decide happened meanwhile).
  - `useFleetApprovalCounts()` -> `{ counts: Ref<ApprovalCountsDto | null>, load(): Promise<void> }`
  - `type FleetApprovalsApi = ReturnType<typeof useFleetApprovals>`

- [ ] **Step 1: Write the failing test**

Create `apps/web/tests/composables/useFleetApprovals.spec.ts`:

```ts
import { describe, test, expect, jest, afterEach } from '@jest/globals'
import type { FleetApprovalDto } from '../../lib/fleet-types'

type Fn = (...args: unknown[]) => Promise<unknown>
function install(api: { get?: Fn; post?: Fn }) {
  (globalThis as Record<string, unknown>).useApi = () => ({ $api: api })
}
afterEach(() => { delete (globalThis as Record<string, unknown>).useApi })

async function fresh() {
  jest.resetModules()
  return import('../../composables/useFleetApprovals')
}

const row = (id: string, over: Partial<FleetApprovalDto> = {}): FleetApprovalDto => ({
  id, type: 'budget_override_required', status: 'pending', projectId: 'p1', jobId: null, policyId: 'pol', payload: {},
  outcome: null, requestedAt: '2026-10-03T10:00:00.000Z', expiresAt: null, decision: null, decidedById: null,
  decidedAt: null, resolvedBy: null, comment: null, ...over,
})
const page = (records: FleetApprovalDto[], over: Record<string, unknown> = {}) => ({ records, total: records.length, current: 1, size: 100, hasNext: false, hasPrev: false, ...over })

describe('useFleetApprovals', () => {
  test('paths for both bases, slug and id encoded', async () => {
    const { approvalRoot, approvalItem } = await fresh()
    expect(approvalRoot({ kind: 'admin' })).toBe('/fleet/approvals')
    expect(approvalRoot({ kind: 'project', slug: 'a b' })).toBe('/projects/a%20b/fleet/approvals')
    expect(approvalItem({ kind: 'admin' }, 'x/y')).toBe('/fleet/approvals/x%2Fy')
    expect(approvalItem({ kind: 'project', slug: 'k' }, 'i')).toBe('/projects/k/fleet/approvals/i')
  })

  test('load sends the tab query and sorts pending rows', async () => {
    const get = jest.fn(async () => page([row('b'), row('x', { expiresAt: '2026-10-03T10:05:00.000Z' })], { hasNext: true }))
    install({ get })
    const { useFleetApprovals } = await fresh()
    const api = useFleetApprovals({ kind: 'project', slug: 'koda' })
    expect(await api.load({ tab: 'pending' })).toBe(true)
    expect(get).toHaveBeenCalledWith('/projects/koda/fleet/approvals', { query: { status: 'pending', size: '100' } })
    expect(api.approvals.value.map((a) => a.id)).toEqual(['x', 'b'])
    expect(api.hasNext.value).toBe(true)
  })

  test('the All tab keeps the server order', async () => {
    install({ get: jest.fn(async () => page([row('b'), row('x', { expiresAt: '2026-10-03T10:05:00.000Z' })])) })
    const { useFleetApprovals } = await fresh()
    const api = useFleetApprovals({ kind: 'admin' })
    await api.load({ tab: 'all', page: 1 })
    expect(api.approvals.value.map((a) => a.id)).toEqual(['b', 'x'])
  })

  test('a load that started before a decide is dropped (D249)', async () => {
    let release: (value: unknown) => void = () => undefined
    const get = jest.fn(() => new Promise((resolve) => { release = resolve }))
    const post = jest.fn(async () => row('a', { status: 'approved' }))
    install({ get, post })
    const { useFleetApprovals, approvalsVersion } = await fresh()
    const api = useFleetApprovals({ kind: 'admin' })
    api.approvals.value = [row('a')]
    const loading = api.load({ tab: 'pending' })
    await api.decide('a', { decision: 'keep_paused' })
    release(page([row('a')]))
    expect(await loading).toBe(false)
    expect(api.approvals.value[0].status).toBe('approved')
    expect(approvalsVersion.value).toBe(1)
  })

  test('decide posts to the decide route with a copy of the body', async () => {
    const post = jest.fn(async () => row('a', { status: 'approved' }))
    install({ post })
    const { useFleetApprovals } = await fresh()
    const api = useFleetApprovals({ kind: 'project', slug: 'koda' })
    const body = { decision: 'raise_budget_and_resume' as const, amountUsd: 2, requeueJobIds: ['j1'] }
    await api.decide('a', body)
    expect(post).toHaveBeenCalledWith('/projects/koda/fleet/approvals/a/decide', body)
    expect(post.mock.calls[0][1]).not.toBe(body)
  })

  test('a failed decide changes nothing', async () => {
    install({ post: jest.fn(async () => { throw new Error('409') }) })
    const { useFleetApprovals, approvalsVersion } = await fresh()
    const api = useFleetApprovals({ kind: 'admin' })
    api.approvals.value = [row('a')]
    await expect(api.decide('a', { decision: 'keep_paused' })).rejects.toThrow('409')
    expect(api.approvals.value[0].status).toBe('pending')
    expect(approvalsVersion.value).toBe(0)
  })
})

describe('useFleetApprovalCounts', () => {
  test('loads the counts; a stale answer is dropped', async () => {
    const answers: Array<(v: unknown) => void> = []
    install({ get: jest.fn(() => new Promise((resolve) => { answers.push(resolve) })) })
    const { useFleetApprovalCounts } = await fresh()
    const c = useFleetApprovalCounts()
    const first = c.load()
    const second = c.load()
    answers[1]({ total: 2, unscoped: 0, projects: [] })
    await second
    answers[0]({ total: 9, unscoped: 0, projects: [] })
    await first
    expect(c.counts.value?.total).toBe(2)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && bun run test -- tests/composables/useFleetApprovals.spec.ts`
Expected: FAIL with "Cannot find module '../../composables/useFleetApprovals'".

- [ ] **Step 3: Write the composable**

Create `apps/web/composables/useFleetApprovals.ts`:

```ts
import { ref } from 'vue'
import { apiPath } from '~/lib/api-path'
import { buildApprovalQuery, sortPending } from '~/lib/fleet-approvals'
import type { ApprovalBase, ApprovalListFilters } from '~/lib/fleet-approvals'
import type { ApprovalCountsDto, DecideApprovalBody, FleetApprovalDto, FleetPage } from '~/lib/fleet-types'

export const approvalRoot = (base: ApprovalBase): string =>
  base.kind === 'admin' ? '/fleet/approvals' : apiPath`/projects/${base.slug}/fleet/approvals`

export const approvalItem = (base: ApprovalBase, id: string): string =>
  base.kind === 'admin' ? apiPath`/fleet/approvals/${id}` : apiPath`/projects/${base.slug}/fleet/approvals/${id}`

/** D249 (D224 pattern): a load that started before a successful decide is dropped. */
let mutationEpoch = 0

/** D247: bumped after every successful decide; the header badge refreshes on it (the admin inbox has no live channel). */
export const approvalsVersion = ref(0)

/** Approvals of one base: one list page and the decide. */
export function useFleetApprovals(base: ApprovalBase) {
  const { $api } = useApi()
  const approvals = ref<FleetApprovalDto[]>([])
  const total = ref(0)
  const page = ref(1)
  const hasNext = ref(false)
  let latestLoadId = 0

  async function load(filters: ApprovalListFilters): Promise<boolean> {
    const loadId = ++latestLoadId
    const epoch = mutationEpoch
    const res = await $api.get<FleetPage<FleetApprovalDto>>(approvalRoot(base), { query: buildApprovalQuery(filters) })
    if (loadId !== latestLoadId || epoch !== mutationEpoch) return false
    const rows = res.records ?? []
    approvals.value = filters.tab === 'pending' ? sortPending(rows) : rows
    total.value = res.total ?? 0
    page.value = res.current ?? 1
    hasNext.value = res.hasNext === true
    return true
  }

  const get = (id: string): Promise<FleetApprovalDto> => $api.get<FleetApprovalDto>(approvalItem(base, id))

  async function decide(id: string, body: DecideApprovalBody): Promise<FleetApprovalDto> {
    const decided = await $api.post<FleetApprovalDto>(`${approvalItem(base, id)}/decide`, { ...body })
    mutationEpoch += 1
    approvalsVersion.value += 1
    approvals.value = approvals.value.map((a) => (a.id === decided.id ? decided : a))
    return decided
  }

  return { approvals, total, page, hasNext, load, get, decide }
}

export type FleetApprovalsApi = ReturnType<typeof useFleetApprovals>

/** Spec §2.3 `GET /fleet/approval-counts`: over the caller's memberships (plus unscoped for a global ADMIN). */
export function useFleetApprovalCounts() {
  const { $api } = useApi()
  const counts = ref<ApprovalCountsDto | null>(null)
  let latestLoadId = 0

  async function load(): Promise<void> {
    const loadId = ++latestLoadId
    const res = await $api.get<ApprovalCountsDto>('/fleet/approval-counts')
    if (loadId === latestLoadId) counts.value = res
  }

  return { counts, load }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && bun run test -- tests/composables/useFleetApprovals.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/composables/useFleetApprovals.ts apps/web/tests/composables/useFleetApprovals.spec.ts
git commit -m "feat(web): approvals transport and counts composables (S1.5 1b)"
```

---

### Task 5: Budget decide panel and decided outcome

**Files:**
- Create: `apps/web/components/fleet/ApprovalBudgetPanel.vue`, `apps/web/components/fleet/ApprovalOutcome.vue`
- Modify: `apps/web/tests/helpers/fleet-harness.ts` (add `['Textarea', 'textarea']` to the `uiStubs` list)
- Modify: `apps/web/tests/helpers/mount-sfc.ts` (register both components in `FLEET_COMPONENT_FILES` and
  `FleetComponentName`)
- Test: `apps/web/tests/components/fleet-approval-budget-panel.spec.ts`, `apps/web/tests/components/fleet-approval-outcome.spec.ts`

**Interfaces:**
- Consumes: Task 1 helpers; `formatUsd` (`~/lib/fleet-jobs`); `windowSinceDate` (`~/lib/fleet-budgets`); `codeLabel`
  (`~/lib/fleet-i18n`).
- Produces:
  - `FleetApprovalBudgetPanel` props `{ approval: FleetApprovalDto; canDecide: boolean; busy: boolean; jobLink:
    (projectId: string, jobId: string) => string | null }`, emits `decide(body: DecideApprovalBody)`. Test ids:
    `fleet-approval-budget-panel`, `fleet-approval-budget-summary`, `fleet-approval-amount`,
    `fleet-approval-amount-error`, `fleet-approval-candidate-<jobId>`, `fleet-approval-candidates-truncated`,
    `fleet-approval-comment`, `fleet-approval-comment-error`, `fleet-approval-raise`, `fleet-approval-keep`,
    `fleet-approval-readonly`.
  - `FleetApprovalOutcome` props `{ approval: FleetApprovalDto; nameOf: (userId: string) => string | null; jobLink:
    (projectId: string, jobId: string) => string | null }`. Test ids: `fleet-approval-outcome`,
    `fleet-approval-outcome-decision`, `fleet-approval-outcome-by`, `fleet-approval-outcome-raised`,
    `fleet-approval-outcome-manual`, `fleet-approval-requeue-none`, `fleet-approval-requeue-result-<jobId>` (with
    `data-ok`).

The panel is mounted per `${id}:${status}` by the inbox (D242), so its form state is initialised once from props.

- [ ] **Step 1: Register the harness pieces**

In `apps/web/tests/helpers/fleet-harness.ts`, add to the `uiStubs` list (after `['Label', 'label'],`):

```ts
    ['Textarea', 'textarea'],
```

In `apps/web/tests/helpers/mount-sfc.ts`, add to `FLEET_COMPONENT_FILES`:

```ts
  FleetApprovalBudgetPanel: 'ApprovalBudgetPanel.vue',
  FleetApprovalOutcome: 'ApprovalOutcome.vue',
```

and to `FleetComponentName`:

```ts
  | 'FleetApprovalBudgetPanel' | 'FleetApprovalOutcome'
```

- [ ] **Step 2: Write the failing tests**

Create `apps/web/tests/components/fleet-approval-budget-panel.spec.ts`:

```ts
import { describe, test, expect } from '@jest/globals'
import * as Vue from 'vue'
import { ref, computed } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { uiStubs, enI18n } from '../helpers/fleet-harness'
import type { FleetApprovalDto } from '../../lib/fleet-types'

const panel = webFile('components', 'fleet', 'ApprovalBudgetPanel.vue')

const approval = (over: Partial<FleetApprovalDto> = {}): FleetApprovalDto => ({
  id: 'a1', type: 'budget_override_required', status: 'pending', projectId: 'p1', jobId: null, policyId: 'pol1',
  payload: { scopeType: 'project', scopeId: 'p1', windowKind: 'calendar_month_utc', windowStart: '2026-10-01T00:00:00.000Z', spentUsd: '0.6000', amountUsd: '0.5000' },
  outcome: null, requestedAt: '2026-10-03T10:00:00.000Z', expiresAt: null, decision: null, decidedById: null, decidedAt: null,
  resolvedBy: null, comment: null,
  requeueCandidates: [
    { jobId: 'j1', projectId: 'p1', feature: 'feat-a', queuedAt: '2026-10-03T09:00:00.000Z' },
    { jobId: 'j2', projectId: 'p1', feature: 'feat-b', queuedAt: '2026-10-03T09:01:00.000Z' },
  ],
  requeueCandidatesTruncated: false,
  ...over,
})

function mount(props: Record<string, unknown> = {}) {
  const decided: unknown[] = []
  const app = mountSfc(panel, {
    components: uiStubs,
    props: { approval: approval(), canDecide: true, busy: false, jobLink: (_p: string, j: string) => `/koda/fleet/jobs/${j}`, onDecide: (b: unknown) => decided.push(b), ...props },
    globals: { ref, computed, useI18n: () => enI18n() },
  })
  const byId = (id: string) => app.find(`[data-testid="${id}"]`)
  const typeAmount = async (value: string) => {
    (byId('fleet-approval-amount')[0].props['onUpdate:modelValue'] as (v: string) => void)(value)
    await Vue.nextTick()
  }
  const click = async (id: string) => {
    (byId(id)[0].props.onClick as () => void)()
    await Vue.nextTick()
  }
  return { app, decided, byId, typeAmount, click }
}

describe('FleetApprovalBudgetPanel', () => {
  test('shows the stop and ticks every candidate (A4)', () => {
    const m = mount()
    expect(m.app.textOf(m.byId('fleet-approval-budget-summary')[0])).toBe('$0.60 spent of a $0.50 limit (Calendar month (UTC)).')
    expect(m.byId('fleet-approval-candidate-j1')[0].props.checked).toBe(true)
    expect(m.byId('fleet-approval-candidate-j2')[0].props.checked).toBe(true)
  })

  test('raise sends the new amount and the ticked ids', async () => {
    const m = mount()
    await m.typeAmount('2')
    ;(m.byId('fleet-approval-candidate-j2')[0].props.onChange as () => void)()
    await Vue.nextTick()
    await m.click('fleet-approval-raise')
    expect(m.decided).toEqual([{ decision: 'raise_budget_and_resume', amountUsd: 2, requeueJobIds: ['j1'] }])
  })

  test('an amount not above the spend shows an error and sends nothing', async () => {
    const m = mount()
    expect(m.byId('fleet-approval-amount-error')).toHaveLength(0)
    await m.typeAmount('0.6')
    await m.click('fleet-approval-raise')
    expect(m.decided).toEqual([])
    expect(m.app.textOf(m.byId('fleet-approval-amount-error')[0])).toBe('The new limit must be above $0.60.')
  })

  test('keep paused sends the decision with the comment', async () => {
    const m = mount()
    ;(m.byId('fleet-approval-comment')[0].props['onUpdate:modelValue'] as (v: string) => void)(' not now ')
    await Vue.nextTick()
    await m.click('fleet-approval-keep')
    expect(m.decided).toEqual([{ decision: 'keep_paused', comment: 'not now' }])
  })

  test('a comment over 1000 characters blocks both buttons', async () => {
    const m = mount()
    await m.typeAmount('2')
    ;(m.byId('fleet-approval-comment')[0].props['onUpdate:modelValue'] as (v: string) => void)('x'.repeat(1001))
    await Vue.nextTick()
    await m.click('fleet-approval-keep')
    await m.click('fleet-approval-raise')
    expect(m.decided).toEqual([])
    expect(m.byId('fleet-approval-comment-error')).toHaveLength(1)
  })

  test('no candidates and truncated candidates each say so', () => {
    expect(mount({ approval: approval({ requeueCandidates: [] }) }).app.text()).toContain('No cancelled jobs to re-queue.')
    expect(mount({ approval: approval({ requeueCandidatesTruncated: true }) }).byId('fleet-approval-candidates-truncated')).toHaveLength(1)
  })

  test('candidates link to their job when a link is known', () => {
    const m = mount({ jobLink: (_p: string, j: string) => (j === 'j1' ? '/koda/fleet/jobs/j1' : null) })
    const links = m.app.find('[data-stub="nuxt-link"]')
    expect(links.map((l) => l.props.to)).toEqual(['/koda/fleet/jobs/j1'])
  })

  test('a reader without the right sees the read-only line and no controls (Review Focus 5)', () => {
    const m = mount({ canDecide: false })
    expect(m.byId('fleet-approval-readonly')).toHaveLength(1)
    expect(m.byId('fleet-approval-raise')).toHaveLength(0)
    expect(m.byId('fleet-approval-keep')).toHaveLength(0)
    expect(m.byId('fleet-approval-amount')).toHaveLength(0)
  })

  test('busy disables both buttons', () => {
    const m = mount({ busy: true })
    expect(m.byId('fleet-approval-raise')[0].props.disabled).toBe(true)
    expect(m.byId('fleet-approval-keep')[0].props.disabled).toBe(true)
  })

  test('a malformed payload still renders the controls with the raw spend unknown', () => {
    const m = mount({ approval: approval({ payload: {} }) })
    expect(m.byId('fleet-approval-budget-summary')).toHaveLength(0)
    expect(m.byId('fleet-approval-raise')).toHaveLength(1)
  })
})
```

Note: the last test pins that a malformed payload does not crash. With no payload the amount check uses `'0'` as the
spend (any valid positive amount passes); the server's 400 is then shown by the inbox.

Create `apps/web/tests/components/fleet-approval-outcome.spec.ts`:

```ts
import { describe, test, expect } from '@jest/globals'
import { computed } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { uiStubs, enI18n } from '../helpers/fleet-harness'
import type { FleetApprovalDto } from '../../lib/fleet-types'

const outcome = webFile('components', 'fleet', 'ApprovalOutcome.vue')

const decided = (over: Partial<FleetApprovalDto> = {}): FleetApprovalDto => ({
  id: 'a1', type: 'budget_override_required', status: 'approved', projectId: 'p1', jobId: null, policyId: 'pol1', payload: {},
  outcome: { resumedAmountUsd: '2.0000', requeueResults: [{ jobId: 'j1', ok: true }, { jobId: 'j2', ok: false, error: JSON.stringify({ code: 'fleet.jobState', args: { state: 'QUEUED' } }) }] },
  requestedAt: '2026-10-03T10:00:00.000Z', expiresAt: null, decision: 'raise_budget_and_resume', decidedById: 'u1',
  decidedAt: '2026-10-03T10:05:00.000Z', resolvedBy: 'user', comment: 'go', ...over,
})

function mount(approval: FleetApprovalDto, nameOf: (id: string) => string | null = (id) => (id === 'u1' ? 'Ada' : null)) {
  const app = mountSfc(outcome, {
    components: uiStubs,
    props: { approval, nameOf, jobLink: (_p: string, j: string) => `/koda/fleet/jobs/${j}` },
    globals: { computed, useI18n: () => enI18n() },
  })
  return { app, byId: (id: string) => app.find(`[data-testid="${id}"]`) }
}

describe('FleetApprovalOutcome', () => {
  test('a raise decided in the inbox: decision, who, new limit, per-job results in words (Review Focus 4)', () => {
    const m = mount(decided())
    expect(m.app.textOf(m.byId('fleet-approval-outcome-decision')[0])).toContain('Raised and resumed')
    expect(m.app.textOf(m.byId('fleet-approval-outcome-by')[0])).toBe('By Ada')
    expect(m.app.textOf(m.byId('fleet-approval-outcome-raised')[0])).toBe('Limit raised to $2.00')
    expect(m.byId('fleet-approval-requeue-result-j1')[0].props['data-ok']).toBe('true')
    const failed = m.byId('fleet-approval-requeue-result-j2')[0]
    expect(failed.props['data-ok']).toBe('false')
    expect(m.app.textOf(failed)).toContain('Not re-queued: the job is no longer cancelled.')
    expect(m.app.text()).not.toContain('fleet.jobState')
    expect(m.app.text()).toContain('Comment: go')
  })

  test('a raise with nothing ticked says no jobs were selected', () => {
    const m = mount(decided({ outcome: { resumedAmountUsd: '2.0000', requeueResults: [] } }))
    expect(m.byId('fleet-approval-requeue-none')).toHaveLength(1)
  })

  test('a manual resume never claims nothing was selected (D245)', () => {
    const m = mount(decided({ resolvedBy: 'manual_resume', outcome: { resumedAmountUsd: '3.0000', requeueResults: [] }, comment: null }))
    expect(m.byId('fleet-approval-outcome-manual')).toHaveLength(1)
    expect(m.byId('fleet-approval-requeue-none')).toHaveLength(0)
    expect(m.app.textOf(m.byId('fleet-approval-outcome-raised')[0])).toBe('Limit raised to $3.00')
  })

  test('kept paused, and closed by the system with no decider', () => {
    const kept = mount(decided({ status: 'rejected', decision: 'keep_paused', outcome: null }))
    expect(kept.app.textOf(kept.byId('fleet-approval-outcome-decision')[0])).toContain('Kept paused')
    expect(kept.byId('fleet-approval-outcome-raised')).toHaveLength(0)

    const reset = mount(decided({ status: 'cancelled', decision: null, decidedById: null, resolvedBy: 'window_reset', outcome: null, comment: null }))
    expect(reset.app.text()).toContain('The budget window rolled over')
    expect(reset.byId('fleet-approval-outcome-by')).toHaveLength(0)
  })

  test('a decider who is no longer a member gets the fallback name', () => {
    const m = mount(decided(), () => null)
    expect(m.app.textOf(m.byId('fleet-approval-outcome-by')[0])).toBe('By a former member')
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd apps/web && bun run test -- tests/components/fleet-approval-budget-panel.spec.ts tests/components/fleet-approval-outcome.spec.ts`
Expected: FAIL (components missing).

- [ ] **Step 4: Write the budget panel**

Create `apps/web/components/fleet/ApprovalBudgetPanel.vue`:

```vue
<template>
  <div class="space-y-4 text-sm" data-testid="fleet-approval-budget-panel">
    <p v-if="payload" data-testid="fleet-approval-budget-summary">
      {{ t('fleet.approvals.budget.summary', { spent: formatUsd(payload.spentUsd), amount: formatUsd(payload.amountUsd), window: t(`fleet.budgets.window.${payload.windowKind}`) }) }}
    </p>

    <template v-if="canDecide">
      <div class="max-w-xs space-y-1">
        <Label for="fleet-approval-amount">{{ t('fleet.approvals.budget.amount') }}</Label>
        <Input id="fleet-approval-amount" v-model="amount" inputmode="decimal" data-testid="fleet-approval-amount" />
        <p v-if="amountMessage" class="text-xs text-destructive" data-testid="fleet-approval-amount-error">{{ amountMessage }}</p>
        <p v-else class="text-xs text-muted-foreground">{{ t('fleet.approvals.budget.amountHint', { spent: formatUsd(spent) }) }}</p>
      </div>

      <fieldset class="space-y-1">
        <legend class="font-medium">{{ t('fleet.approvals.budget.requeueTitle') }}</legend>
        <p v-if="candidates.length === 0" class="text-muted-foreground">{{ t('fleet.approvals.budget.noCandidates') }}</p>
        <label v-for="c in candidates" :key="c.jobId" class="flex items-center gap-2">
          <input
            type="checkbox"
            :checked="selected.includes(c.jobId)"
            :data-testid="`fleet-approval-candidate-${c.jobId}`"
            @change="toggle(c.jobId)"
          >
          <NuxtLink v-if="jobLink(c.projectId, c.jobId)" :to="jobLink(c.projectId, c.jobId)" class="text-primary underline-offset-4 hover:underline">{{ c.feature }}</NuxtLink>
          <span v-else>{{ c.feature }}</span>
          <span class="font-mono text-xs text-muted-foreground">{{ c.jobId.slice(0, 8) }}</span>
        </label>
        <p v-if="approval.requeueCandidatesTruncated" class="text-xs text-muted-foreground" data-testid="fleet-approval-candidates-truncated">
          {{ t('fleet.approvals.budget.truncated') }}
        </p>
      </fieldset>

      <div class="space-y-1">
        <Label for="fleet-approval-comment">{{ t('fleet.approvals.budget.comment') }}</Label>
        <Textarea id="fleet-approval-comment" v-model="comment" rows="2" data-testid="fleet-approval-comment" />
        <p v-if="commentInvalid" class="text-xs text-destructive" data-testid="fleet-approval-comment-error">{{ t('fleet.approvals.validation.commentTooLong') }}</p>
      </div>

      <div class="flex flex-wrap gap-2">
        <Button :disabled="busy" data-testid="fleet-approval-raise" @click="raise()">
          {{ busy ? t('fleet.approvals.budget.submitting') : t('fleet.approvals.budget.raise') }}
        </Button>
        <Button variant="outline" :disabled="busy" data-testid="fleet-approval-keep" @click="keep()">
          {{ t('fleet.approvals.budget.keep') }}
        </Button>
      </div>
    </template>
    <p v-else class="text-muted-foreground" data-testid="fleet-approval-readonly">{{ t('fleet.approvals.readOnly') }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { budgetPayload, commentTooLong, raiseAmountError, toKeepPausedBody, toRaiseBody } from '~/lib/fleet-approvals'
import { formatUsd } from '~/lib/fleet-jobs'
import type { DecideApprovalBody, FleetApprovalDto } from '~/lib/fleet-types'

// Mounted per `${id}:${status}` by FleetApprovalInbox (D242): the form state below is initialised once.
const props = defineProps<{
  approval: FleetApprovalDto
  canDecide: boolean
  busy: boolean
  jobLink: (projectId: string, jobId: string) => string | null
}>()

const emit = defineEmits<{ (e: 'decide', body: DecideApprovalBody): void }>()

const { t } = useI18n()

const payload = computed(() => budgetPayload(props.approval))
/** A malformed payload leaves the spend unknown: any valid amount passes here and the server decides. */
const spent = computed(() => payload.value?.spentUsd ?? '0')
const candidates = computed(() => props.approval.requeueCandidates ?? [])

const amount = ref('')
const comment = ref('')
/** A4: every candidate ticked by default. */
const selected = ref<readonly string[]>((props.approval.requeueCandidates ?? []).map((c) => c.jobId))
const attempted = ref(false)

const amountError = computed(() => raiseAmountError(amount.value, spent.value))
const amountMessage = computed(() => {
  if (!attempted.value || amountError.value === null) return ''
  return t(`fleet.approvals.validation.${amountError.value}`, { spent: formatUsd(spent.value) })
})
const commentInvalid = computed(() => commentTooLong(comment.value))

function toggle(jobId: string): void {
  selected.value = selected.value.includes(jobId) ? selected.value.filter((id) => id !== jobId) : [...selected.value, jobId]
}

function raise(): void {
  attempted.value = true
  if (amountError.value !== null || commentInvalid.value) return
  emit('decide', toRaiseBody({ amount: amount.value, selected: selected.value, comment: comment.value }))
}

function keep(): void {
  if (commentInvalid.value) return
  emit('decide', toKeepPausedBody(comment.value))
}
</script>
```

- [ ] **Step 5: Write the outcome**

Create `apps/web/components/fleet/ApprovalOutcome.vue`:

```vue
<template>
  <div class="space-y-2 text-sm" data-testid="fleet-approval-outcome">
    <p data-testid="fleet-approval-outcome-decision">
      <span class="font-medium">{{ label('fleet.approvals.status', approval.status) }}</span>
      <template v-if="approval.decision"> · {{ label('fleet.approvals.decision', approval.decision) }}</template>
      <template v-if="approval.resolvedBy"> · {{ label('fleet.approvals.resolvedBy', approval.resolvedBy) }}</template>
    </p>
    <p class="text-muted-foreground">
      <span v-if="approval.decidedById" data-testid="fleet-approval-outcome-by">{{ t('fleet.approvals.outcome.decidedBy', { name: deciderName }) }}</span>
      <span v-if="approval.decidedAt" class="ml-2">{{ t('fleet.approvals.outcome.decidedAt', { at: new Date(approval.decidedAt).toLocaleString() }) }}</span>
    </p>
    <p v-if="raised" data-testid="fleet-approval-outcome-raised">{{ t('fleet.approvals.outcome.raisedTo', { amount: formatUsd(raised) }) }}</p>
    <p v-if="approval.resolvedBy === 'manual_resume'" class="text-muted-foreground" data-testid="fleet-approval-outcome-manual">
      {{ t('fleet.approvals.outcome.manualResume') }}
    </p>

    <div v-if="results" class="space-y-1">
      <p class="font-medium">{{ t('fleet.approvals.outcome.requeueTitle') }}</p>
      <p v-if="results.length === 0" class="text-muted-foreground" data-testid="fleet-approval-requeue-none">{{ t('fleet.approvals.outcome.requeueNone') }}</p>
      <ul v-else class="space-y-1">
        <li
          v-for="r in results"
          :key="r.jobId"
          class="flex items-center gap-2"
          :data-testid="`fleet-approval-requeue-result-${r.jobId}`"
          :data-ok="String(r.ok)"
        >
          <NuxtLink v-if="link(r.jobId)" :to="link(r.jobId)" class="font-mono text-xs text-primary underline-offset-4 hover:underline">{{ r.jobId.slice(0, 8) }}</NuxtLink>
          <span v-else class="font-mono text-xs">{{ r.jobId.slice(0, 8) }}</span>
          <span :class="r.ok ? '' : 'text-destructive'">
            {{ r.ok ? t('fleet.approvals.outcome.requeueOk') : t(`fleet.approvals.requeueFailure.${r.reason ?? 'unknown'}`) }}
          </span>
        </li>
      </ul>
    </div>

    <p v-if="approval.comment">{{ t('fleet.approvals.outcome.comment', { comment: approval.comment }) }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { requeueResults, resumedAmount } from '~/lib/fleet-approvals'
import { codeLabel } from '~/lib/fleet-i18n'
import { formatUsd } from '~/lib/fleet-jobs'
import type { FleetApprovalDto } from '~/lib/fleet-types'

const props = defineProps<{
  approval: FleetApprovalDto
  nameOf: (userId: string) => string | null
  jobLink: (projectId: string, jobId: string) => string | null
}>()

const { t, te } = useI18n()
const label = (prefix: string, code: string): string => codeLabel(t, te, prefix, code)

const raised = computed(() => resumedAmount(props.approval))
const results = computed(() => requeueResults(props.approval))
const deciderName = computed(() =>
  (props.approval.decidedById ? props.nameOf(props.approval.decidedById) : null) ?? t('fleet.approvals.outcome.unknownUser'))
/** Re-queued jobs live in the approval's project; a no-project approval has no project to link into. */
const link = (jobId: string): string | null => (props.approval.projectId ? props.jobLink(props.approval.projectId, jobId) : null)
</script>
```

Note: `requeueResults` entries carry no `projectId`; for a global or runner policy (no project) the results render
without links. That is acceptable for 1b (the admin inbox shows the job id).

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd apps/web && bun run test -- tests/components/fleet-approval-budget-panel.spec.ts tests/components/fleet-approval-outcome.spec.ts`
Expected: PASS. If the `·` separators make an exact-text assertion awkward, keep the assertions as `toContain` as
written.

- [ ] **Step 7: Commit**

```bash
git add apps/web/components/fleet/ApprovalBudgetPanel.vue apps/web/components/fleet/ApprovalOutcome.vue apps/web/tests/helpers/fleet-harness.ts apps/web/tests/helpers/mount-sfc.ts apps/web/tests/components/fleet-approval-budget-panel.spec.ts apps/web/tests/components/fleet-approval-outcome.spec.ts
git commit -m "feat(web): budget override decide panel and decided outcome (S1.5 1b)"
```

---

### Task 6: The inbox component

**Files:**
- Create: `apps/web/components/fleet/ApprovalInbox.vue`
- Modify: `apps/web/tests/helpers/mount-sfc.ts` (register `FleetApprovalInbox: 'ApprovalInbox.vue'` and add it to
  `FleetComponentName`)
- Test: `apps/web/tests/components/fleet-approval-inbox.spec.ts`

**Interfaces:**
- Consumes: `useFleetApprovals` (Task 4), Task 1 helpers, Task 5 components; Nuxt globals `useRoute`, `useRouter`,
  `useAppToast`, `useVisiblePolling`, `useProjectEvents`, `useI18n`.
- Produces: `FleetApprovalInbox` props `{ base: ApprovalBase; viewer: ApprovalViewer; scopeLabel: (p:
  BudgetApprovalPayload) => string | null; nameOf: (userId: string) => string | null; jobLink: (projectId: string, jobId:
  string) => string | null; projectName?: (projectId: string | null) => string }`, emits `forbidden()`. Test ids:
  `fleet-approvals-tab-pending|all`, `fleet-approvals-type`, `fleet-approvals-list`, `fleet-approval-row-<id>` (with
  `data-status`, `data-type`, `data-linked`), `fleet-approval-toggle`, `fleet-approval-panel`, `fleet-approval-bash-later`,
  `fleet-approvals-prev`, `fleet-approvals-next`, `fleet-approvals-more`.

- [ ] **Step 1: Register the component in the harness**

In `apps/web/tests/helpers/mount-sfc.ts` add `FleetApprovalInbox: 'ApprovalInbox.vue',` to `FLEET_COMPONENT_FILES` and
`| 'FleetApprovalInbox'` to `FleetComponentName`.

- [ ] **Step 2: Write the failing test**

Create `apps/web/tests/components/fleet-approval-inbox.spec.ts`:

```ts
import { describe, test, expect, jest, afterEach } from '@jest/globals'
import * as Vue from 'vue'
import { ref, computed, watch, nextTick } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { uiStubs, enI18n, toastRecorder } from '../helpers/fleet-harness'
import { ApiError } from '../../composables/useApi'
import type { FleetApprovalDto } from '../../lib/fleet-types'

const inbox = webFile('components', 'fleet', 'ApprovalInbox.vue')

const budget = { scopeType: 'project', scopeId: 'p1', windowKind: 'calendar_month_utc', windowStart: '2026-10-01T00:00:00.000Z', spentUsd: '0.6000', amountUsd: '0.5000' }
const row = (id: string, over: Partial<FleetApprovalDto> = {}): FleetApprovalDto => ({
  id, type: 'budget_override_required', status: 'pending', projectId: 'p1', jobId: null, policyId: 'pol1', payload: { ...budget },
  outcome: null, requestedAt: '2026-10-03T10:00:00.000Z', expiresAt: null, decision: null, decidedById: null, decidedAt: null,
  resolvedBy: null, comment: null, ...over,
})
const page = (records: FleetApprovalDto[], over: Record<string, unknown> = {}) => ({ records, total: records.length, current: 1, size: 100, hasNext: false, hasPrev: false, ...over })

type Handlers = { onFleetApproval?: () => void; onResync: () => void }

afterEach(() => {
  delete (globalThis as Record<string, unknown>).useApi
  jest.useRealTimers()
})

function mount(opts: {
  get: jest.Mock
  post?: jest.Mock
  query?: Record<string, string>
  props?: Record<string, unknown>
}) {
  const api = { get: opts.get, post: opts.post ?? jest.fn() }
  ;(globalThis as Record<string, unknown>).useApi = () => ({ $api: api })
  const toast = toastRecorder()
  const replace = jest.fn()
  let pollTask: () => Promise<void> = async () => undefined
  let live: Handlers | null = null
  const forbidden: unknown[] = []
  const app = mountSfc(inbox, {
    components: uiStubs,
    fleetComponents: ['FleetApprovalBudgetPanel', 'FleetApprovalOutcome', 'FleetNativeSelect', 'FleetAge'],
    props: {
      base: { kind: 'project', slug: 'koda' },
      viewer: { kind: 'project', canManage: true },
      scopeLabel: () => 'koda',
      nameOf: (id: string) => (id === 'u1' ? 'Ada' : null),
      jobLink: (_p: string, j: string) => `/koda/fleet/jobs/${j}`,
      onForbidden: () => forbidden.push(true),
      ...opts.props,
    },
    globals: {
      ref, computed, watch, nextTick,
      onMounted: Vue.onMounted,
      onBeforeUnmount: Vue.onBeforeUnmount,
      useI18n: () => enI18n(),
      useAppToast: () => toast,
      useApi: () => ({ $api: api }),
      useRoute: () => ({ query: opts.query ?? {} }),
      useRouter: () => ({ replace }),
      useVisiblePolling: (fn: () => Promise<void>) => {
        pollTask = fn
        return { start: jest.fn(), stop: jest.fn(), runNow: async () => { await fn() }, isActive: () => true }
      },
      useProjectEvents: (_slug: string, handlers: Handlers) => { live = handlers },
    },
  })
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 6; i += 1) {
      await new Promise((resolve) => { setImmediate(resolve) })
      await Vue.nextTick()
    }
  }
  const byId = (id: string) => app.find(`[data-testid="${id}"]`)
  const rowEl = (id: string) => byId(`fleet-approval-row-${id}`)[0]
  const toggle = async (id: string) => {
    const button = app.find('[data-testid="fleet-approval-toggle"]', rowEl(id))[0]
    ;(button.props.onClick as () => void)()
    await settle()
  }
  return { app, api, toast, replace, forbidden, settle, byId, rowEl, toggle, poll: () => pollTask(), live: () => live }
}

describe('FleetApprovalInbox', () => {
  test('loads pending first, one page of 100 (D240)', async () => {
    const get = jest.fn(async () => page([row('a1')]))
    const m = mount({ get })
    await m.settle()
    expect(get).toHaveBeenCalledWith('/projects/koda/fleet/approvals', { query: { status: 'pending', size: '100' } })
    expect(m.rowEl('a1').props['data-status']).toBe('pending')
    expect(m.app.textOf(m.rowEl('a1'))).toContain('Budget for project koda stopped at $0.60 of $0.50')
    m.app.unmount()
  })

  test('the All tab and the type filter change the query', async () => {
    const get = jest.fn(async () => page([]))
    const m = mount({ get })
    await m.settle()
    ;(m.byId('fleet-approvals-tab-all')[0].props.onClick as () => void)()
    await m.settle()
    expect(get).toHaveBeenLastCalledWith('/projects/koda/fleet/approvals', { query: { size: '20' } })
    const select = m.byId('fleet-approvals-type')[0]
    ;(select.props.onChange as (e: unknown) => void)({ target: { value: 'budget_override_required' } })
    await m.settle()
    expect(get).toHaveBeenLastCalledWith('/projects/koda/fleet/approvals', { query: { size: '20', type: 'budget_override_required' } })
    m.app.unmount()
  })

  test('expanding fetches the approval and writes ?id=; collapsing removes it (D241)', async () => {
    const get = jest.fn(async (path: string) => (path.endsWith('/a1') ? row('a1', { requeueCandidates: [] }) : page([row('a1')])))
    const m = mount({ get })
    await m.settle()
    await m.toggle('a1')
    expect(get).toHaveBeenCalledWith('/projects/koda/fleet/approvals/a1')
    expect(m.replace).toHaveBeenLastCalledWith({ query: { id: 'a1' } })
    expect(m.byId('fleet-approval-budget-panel')).toHaveLength(1)
    await m.toggle('a1')
    expect(m.replace).toHaveBeenLastCalledWith({ query: {} })
    expect(m.byId('fleet-approval-panel')).toHaveLength(0)
    m.app.unmount()
  })

  test('?id= of an approval not in the list shows it first as a linked row (Review Focus 3)', async () => {
    const get = jest.fn(async (path: string) => (path.endsWith('/old') ? row('old', { status: 'approved', decision: 'keep_paused', resolvedBy: 'user' }) : page([row('a1')])))
    const m = mount({ get, query: { id: 'old' } })
    await m.settle()
    expect(m.rowEl('old').props['data-linked']).toBe('true')
    expect(m.byId('fleet-approval-outcome')).toHaveLength(1)
    m.app.unmount()
  })

  test('?id= that the server does not know toasts and expands nothing (Review Focus 3)', async () => {
    const get = jest.fn(async (path: string) => {
      if (path.endsWith('/nope')) throw new ApiError(40004, 'Approval not found')
      return page([row('a1')])
    })
    const m = mount({ get, query: { id: 'nope' } })
    await m.settle()
    expect(m.toast.errors).toEqual(['Approval not found'])
    expect(m.byId('fleet-approval-panel')).toHaveLength(0)
    expect(m.replace).toHaveBeenLastCalledWith({ query: {} })
    m.app.unmount()
  })

  test('a decide applies the result and toasts it', async () => {
    const detail = row('a1', { requeueCandidates: [{ jobId: 'j1', projectId: 'p1', feature: 'f', queuedAt: '2026-10-03T09:00:00.000Z' }] })
    const get = jest.fn(async (path: string) => (path.endsWith('/a1') ? detail : page([row('a1')])))
    const post = jest.fn(async () => row('a1', {
      status: 'approved', decision: 'raise_budget_and_resume', resolvedBy: 'user', decidedById: 'u1', decidedAt: '2026-10-03T10:05:00.000Z',
      outcome: { resumedAmountUsd: '2.0000', requeueResults: [{ jobId: 'j1', ok: false, error: '{"code":"fleet.jobs","args":{}}' }] },
    }))
    const m = mount({ get, post })
    await m.settle()
    await m.toggle('a1')
    ;(m.byId('fleet-approval-amount')[0].props['onUpdate:modelValue'] as (v: string) => void)('2')
    await m.settle()
    ;(m.byId('fleet-approval-raise')[0].props.onClick as () => void)()
    await m.settle()
    expect(post).toHaveBeenCalledWith('/projects/koda/fleet/approvals/a1/decide', { decision: 'raise_budget_and_resume', amountUsd: 2, requeueJobIds: ['j1'] })
    expect(m.toast.successes).toEqual(['Budget raised and resumed.'])
    expect(m.toast.errors).toEqual(['1 job(s) could not be re-queued.'])
    expect(m.byId('fleet-approval-outcome')).toHaveLength(1)
    m.app.unmount()
  })

  test('a 409 toasts, re-fetches the approval and reloads the list (D250, Review Focus 2)', async () => {
    let decided = false
    const get = jest.fn(async (path: string) => {
      if (path.endsWith('/a1')) return decided ? row('a1', { status: 'rejected', decision: 'keep_paused', resolvedBy: 'user', decidedById: 'u1' }) : row('a1', { requeueCandidates: [] })
      return page([row('a1', decided ? { status: 'rejected' } : {})])
    })
    const post = jest.fn(async () => {
      decided = true
      throw new ApiError(40009, 'This approval is no longer pending')
    })
    const m = mount({ get, post })
    await m.settle()
    await m.toggle('a1')
    const listCalls = get.mock.calls.filter(([p]) => !String(p).endsWith('/a1')).length
    ;(m.byId('fleet-approval-keep')[0].props.onClick as () => void)()
    await m.settle()
    expect(m.toast.errors).toEqual(['This approval is no longer pending'])
    expect(m.byId('fleet-approval-outcome')).toHaveLength(1)
    expect(m.byId('fleet-approval-keep')).toHaveLength(0)
    expect(get.mock.calls.filter(([p]) => !String(p).endsWith('/a1')).length).toBe(listCalls + 1)
    m.app.unmount()
  })

  test('a refresh with an unchanged status keeps the half-filled form (D242, Review Focus 1)', async () => {
    const get = jest.fn(async (path: string) => (path.endsWith('/a1') ? row('a1', { requeueCandidates: [] }) : page([row('a1'), row('a2')])))
    const m = mount({ get })
    await m.settle()
    await m.toggle('a1')
    ;(m.byId('fleet-approval-amount')[0].props['onUpdate:modelValue'] as (v: string) => void)('7')
    await m.settle()
    const detailCalls = get.mock.calls.filter(([p]) => String(p).endsWith('/a1')).length
    await m.poll()
    m.live()?.onFleetApproval?.()
    await m.settle()
    expect(get.mock.calls.filter(([p]) => String(p).endsWith('/a1')).length).toBe(detailCalls)
    expect(m.byId('fleet-approval-amount')[0].props.modelValue).toBe('7')
    m.app.unmount()
  })

  test('a refresh that finds the open approval decided elsewhere re-fetches it', async () => {
    let elsewhere = false
    const get = jest.fn(async (path: string) => {
      if (path.endsWith('/a1')) return elsewhere ? row('a1', { status: 'approved', decision: 'raise_budget_and_resume', resolvedBy: 'manual_resume' }) : row('a1', { requeueCandidates: [] })
      return page([row('a1', elsewhere ? { status: 'approved' } : {})])
    })
    const m = mount({ get })
    await m.settle()
    await m.toggle('a1')
    elsewhere = true
    await m.poll()
    await m.settle()
    expect(m.byId('fleet-approval-outcome-manual')).toHaveLength(1)
    m.app.unmount()
  })

  test('a reader without the right sees no decide buttons (Review Focus 5)', async () => {
    const get = jest.fn(async (path: string) => (path.endsWith('/a1') ? row('a1', { requeueCandidates: [] }) : page([row('a1')])))
    const m = mount({ get, props: { viewer: { kind: 'project', canManage: false } } })
    await m.settle()
    await m.toggle('a1')
    expect(m.byId('fleet-approval-readonly')).toHaveLength(1)
    expect(m.byId('fleet-approval-raise')).toHaveLength(0)
    m.app.unmount()
  })

  test('a pending bash ask renders read-only with the later-release note (Review Focus 5)', async () => {
    const bash = row('b1', { type: 'nax_bash_escalate', policyId: null, jobId: 'j1', payload: { command: 'rm -rf /' }, expiresAt: '2026-10-03T10:10:00.000Z' })
    const get = jest.fn(async (path: string) => (path.endsWith('/b1') ? bash : page([bash])))
    const m = mount({ get })
    await m.settle()
    expect(m.app.textOf(m.rowEl('b1'))).toContain('A job asks to run a shell command')
    await m.toggle('b1')
    expect(m.byId('fleet-approval-bash-later')).toHaveLength(1)
    expect(m.app.text()).not.toContain('rm -rf')
    m.app.unmount()
  })

  test('the admin inbox reports a 403 and stops (no rows, no toast)', async () => {
    const get = jest.fn(async () => { throw new ApiError(40003, 'Forbidden') })
    const m = mount({ get, props: { base: { kind: 'admin' }, viewer: { kind: 'admin' } } })
    await m.settle()
    expect(m.forbidden).toEqual([true])
    expect(m.toast.errors).toEqual([])
    m.app.unmount()
  })

  test('the admin inbox shows each row\'s project', async () => {
    const get = jest.fn(async () => page([row('a1'), row('g1', { projectId: null })]))
    const m = mount({ get, props: { base: { kind: 'admin' }, viewer: { kind: 'admin' }, projectName: (id: string | null) => (id === null ? 'Fleet-wide' : 'koda') } })
    await m.settle()
    expect(m.app.textOf(m.rowEl('a1'))).toContain('koda')
    expect(m.app.textOf(m.rowEl('g1'))).toContain('Fleet-wide')
    m.app.unmount()
  })

  test('pending with more than 100 says so; All pages', async () => {
    const get = jest.fn(async (_p: string, opts?: { query?: Record<string, string> }) =>
      page([row('a1')], { hasNext: true, current: Number(opts?.query?.current ?? '1') }))
    const m = mount({ get })
    await m.settle()
    expect(m.byId('fleet-approvals-more')).toHaveLength(1)
    ;(m.byId('fleet-approvals-tab-all')[0].props.onClick as () => void)()
    await m.settle()
    ;(m.byId('fleet-approvals-next')[0].props.onClick as () => void)()
    await m.settle()
    expect(get).toHaveBeenLastCalledWith('/projects/koda/fleet/approvals', { query: { size: '20', current: '2' } })
    m.app.unmount()
  })

  test('the project inbox subscribes to fleet_approval notices; the admin inbox does not', async () => {
    const project = mount({ get: jest.fn(async () => page([])) })
    await project.settle()
    expect(project.live()?.onFleetApproval).toBeDefined()
    project.app.unmount()
    const admin = mount({ get: jest.fn(async () => page([])), props: { base: { kind: 'admin' }, viewer: { kind: 'admin' } } })
    await admin.settle()
    expect(admin.live()).toBeNull()
    admin.app.unmount()
  })
})
```

The live notice in "a refresh with an unchanged status" goes through a 300 ms debouncer; the test asserts the poll
path directly and the notice must not throw. If the executor wants the debounced path covered, use
`jest.useFakeTimers()` and `jest.advanceTimersByTime(300)` around `onFleetApproval`.

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/web && bun run test -- tests/components/fleet-approval-inbox.spec.ts`
Expected: FAIL (component missing).

- [ ] **Step 4: Write the inbox**

Create `apps/web/components/fleet/ApprovalInbox.vue`:

```vue
<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-center gap-3">
      <div class="inline-flex rounded-md border border-border p-0.5" role="tablist">
        <Button
          v-for="name in INBOX_TABS"
          :key="name"
          size="sm"
          :variant="tab === name ? 'default' : 'ghost'"
          role="tab"
          :aria-selected="tab === name"
          :data-testid="`fleet-approvals-tab-${name}`"
          @click="tab = name"
        >
          {{ t(`fleet.approvals.tabs.${name}`) }}
        </Button>
      </div>
      <div class="w-56">
        <FleetNativeSelect id="fleet-approvals-type" v-model="type" :options="typeOptions" testid="fleet-approvals-type" />
      </div>
    </div>

    <p v-if="stale" class="text-sm text-muted-foreground">{{ t('fleet.common.stale') }}</p>
    <LoadingState v-if="pending" />
    <ErrorState v-else-if="loadFailed" @retry="reload()" />
    <template v-else-if="!forbidden">
      <EmptyState v-if="displayRows.length === 0" :message="t(`fleet.approvals.empty.${tab}`)" />
      <ul v-else class="divide-y divide-border rounded-md border border-border" data-testid="fleet-approvals-list">
        <li
          v-for="entry in displayRows"
          :key="entry.row.id"
          :data-testid="`fleet-approval-row-${entry.row.id}`"
          :data-status="entry.row.status"
          :data-type="entry.row.type"
          :data-linked="String(entry.linked)"
        >
          <p v-if="entry.linked" class="px-3 pt-2 text-xs font-medium text-muted-foreground">{{ t('fleet.approvals.linked') }}</p>
          <button
            type="button"
            class="flex w-full flex-wrap items-center gap-3 px-3 py-2 text-left text-sm hover:bg-accent"
            :aria-expanded="expandedId === entry.row.id"
            data-testid="fleet-approval-toggle"
            @click="toggle(entry.row.id)"
          >
            <Badge variant="outline">{{ label('fleet.approvals.type', entry.row.type) }}</Badge>
            <span class="min-w-0 flex-1">{{ approvalSummary(t, entry.row, scopeLabel) }}</span>
            <span v-if="projectName" class="text-xs text-muted-foreground">{{ projectName(entry.row.projectId) }}</span>
            <Badge :variant="entry.row.status === 'pending' ? 'default' : 'secondary'" data-testid="fleet-approval-status">
              {{ label('fleet.approvals.status', entry.row.status) }}
            </Badge>
            <span class="text-xs text-muted-foreground"><FleetAge :iso="entry.row.requestedAt" :now="now" mode="ago" /></span>
          </button>
          <div v-if="expandedId === entry.row.id" class="border-t border-border px-3 py-3" data-testid="fleet-approval-panel">
            <LoadingState v-if="detail === null || detail.id !== entry.row.id" />
            <template v-else>
              <FleetApprovalBudgetPanel
                v-if="detail.type === 'budget_override_required' && detail.status === 'pending'"
                :key="`${detail.id}:${detail.status}`"
                :approval="detail"
                :can-decide="canDecide(detail, viewer)"
                :busy="deciding"
                :job-link="jobLink"
                @decide="onDecide"
              />
              <p v-else-if="detail.status === 'pending'" class="text-sm text-muted-foreground" data-testid="fleet-approval-bash-later">
                {{ t('fleet.approvals.bashLater') }}
              </p>
              <FleetApprovalOutcome v-else :approval="detail" :name-of="nameOf" :job-link="jobLink" />
            </template>
          </div>
        </li>
      </ul>

      <p v-if="tab === 'pending' && api.hasNext.value" class="text-sm text-muted-foreground" data-testid="fleet-approvals-more">
        {{ t('fleet.common.more', { n: INBOX_PENDING_SIZE }) }}
      </p>
      <div v-if="tab === 'all' && (page > 1 || api.hasNext.value)" class="flex justify-end gap-2">
        <Button variant="outline" size="sm" :disabled="page <= 1" data-testid="fleet-approvals-prev" @click="goTo(page - 1)">{{ t('fleet.jobs.previous') }}</Button>
        <Button variant="outline" size="sm" :disabled="!api.hasNext.value" data-testid="fleet-approvals-next" @click="goTo(page + 1)">{{ t('fleet.jobs.next') }}</Button>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ApiError, extractApiError } from '~/composables/useApi'
import { useFleetApprovals } from '~/composables/useFleetApprovals'
import { isForbidden } from '~/composables/useFleetBudgetPage'
import { createDebouncer } from '~/lib/debounce'
import { approvalSummary, canDecide, INBOX_PENDING_SIZE, INBOX_TABS, requeueResults } from '~/lib/fleet-approvals'
import type { ApprovalBase, ApprovalViewer, BudgetApprovalPayload, InboxTab } from '~/lib/fleet-approvals'
import { codeLabel } from '~/lib/fleet-i18n'
import { APPROVAL_TYPES } from '~/lib/fleet-types'
import type { ApprovalType, DecideApprovalBody, FleetApprovalDto } from '~/lib/fleet-types'

const props = defineProps<{
  base: ApprovalBase
  viewer: ApprovalViewer
  scopeLabel: (p: BudgetApprovalPayload) => string | null
  nameOf: (userId: string) => string | null
  jobLink: (projectId: string, jobId: string) => string | null
  projectName?: (projectId: string | null) => string
}>()

const emit = defineEmits<{ (e: 'forbidden'): void }>()

/** D252: the project inbox also listens live; the admin inbox has no live channel. */
const POLL_MS = props.base.kind === 'admin' ? 15_000 : 30_000
/** Native selects cannot carry undefined; '' is "all types". */
const ALL = ''

const { t, te } = useI18n()
const toast = useAppToast()
const route = useRoute()
const router = useRouter()
const api = useFleetApprovals(props.base)

const label = (prefix: string, code: string): string => codeLabel(t, te, prefix, code)
const typeOptions = computed(() => [
  { value: ALL, label: t('fleet.approvals.filters.allTypes') },
  ...APPROVAL_TYPES.map((value) => ({ value, label: t(`fleet.approvals.type.${value}`) })),
])

const tab = ref<InboxTab>('pending')
const type = ref<string>(ALL)
const page = ref(1)
const now = ref(new Date())
const pending = ref(true)
const loaded = ref(false)
const loadFailed = ref(false)
const stale = ref(false)
const forbidden = ref(false)
const deciding = ref(false)

const initialId = typeof route.query.id === 'string' && route.query.id !== '' ? route.query.id : null
const expandedId = ref<string | null>(initialId)
/** GET :id of the expanded approval (candidates exist only there). */
const detail = ref<FleetApprovalDto | null>(null)

/** D241: the expanded approval first when it is not on the loaded page. */
const displayRows = computed(() => {
  const rows = api.approvals.value.map((row) => ({ row, linked: false }))
  const open = detail.value
  if (open === null || api.approvals.value.some((r) => r.id === open.id)) return rows
  return [{ row: open, linked: true }, ...rows]
})

const isConflict = (err: unknown): boolean => err instanceof ApiError && (err.code === 40009 || err.code === 409)

function writeQuery(id: string | null): void {
  const rest = Object.fromEntries(Object.entries(route.query).filter(([key]) => key !== 'id'))
  void router.replace({ query: id === null ? rest : { ...rest, id } })
}

async function loadDetail(id: string): Promise<void> {
  try {
    const fetched = await api.get(id)
    if (expandedId.value === id) detail.value = fetched
  } catch (err: unknown) {
    if (expandedId.value !== id) return
    toast.error(extractApiError(err))
    expandedId.value = null
    detail.value = null
    writeQuery(null)
  }
}

/** D242: the open approval is re-fetched only when its status in the list changed. */
function statusChanged(): boolean {
  const open = detail.value
  if (open === null) return false
  const listed = api.approvals.value.find((r) => r.id === open.id)
  return listed !== undefined && listed.status !== open.status
}

async function reload(): Promise<void> {
  now.value = new Date()
  try {
    const accepted = await api.load({ tab: tab.value, type: (type.value || undefined) as ApprovalType | undefined, page: page.value })
    if (!accepted) return
    loaded.value = true
    loadFailed.value = false
    stale.value = false
    if (statusChanged() && expandedId.value !== null) await loadDetail(expandedId.value)
  } catch (err: unknown) {
    if (isForbidden(err)) {
      forbidden.value = true
      emit('forbidden')
      polling.stop()
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

async function toggle(id: string): Promise<void> {
  if (expandedId.value === id) {
    expandedId.value = null
    detail.value = null
    writeQuery(null)
    return
  }
  expandedId.value = id
  detail.value = null
  writeQuery(id)
  await loadDetail(id)
}

async function onDecide(body: DecideApprovalBody): Promise<void> {
  const id = expandedId.value
  if (id === null) return
  deciding.value = true
  try {
    const decided = await api.decide(id, body)
    if (expandedId.value === id) detail.value = decided
    toast.success(t(`fleet.approvals.toast.${body.decision}`))
    const failed = (requeueResults(decided) ?? []).filter((r) => !r.ok).length
    if (failed > 0) toast.error(t('fleet.approvals.toast.requeueFailed', { count: failed }))
  } catch (err: unknown) {
    toast.error(extractApiError(err))
    if (isConflict(err)) {
      await loadDetail(id)
      await reload()
    }
  } finally {
    deciding.value = false
  }
}

function goTo(next: number): void {
  page.value = next
  void reload()
}

watch([tab, type], () => {
  page.value = 1
  void reload()
})

// Declared after reload, which it runs; reload only reaches `polling` when it is called.
const polling = useVisiblePolling(reload, POLL_MS)
const liveReload = createDebouncer(() => { void reload() }, 300)

onMounted(() => {
  void polling.runNow()
  polling.start()
  if (initialId !== null) void loadDetail(initialId)
})
onBeforeUnmount(() => {
  polling.stop()
  liveReload.cancel()
})
if (props.base.kind === 'project') {
  useProjectEvents(props.base.slug, {
    onFleetApproval: () => liveReload.trigger(),
    onResync: () => liveReload.trigger(),
  })
}
</script>
```

The pager reuses the jobs list's `fleet.jobs.previous` / `fleet.jobs.next` keys (no new keys).

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/web && bun run test -- tests/components/fleet-approval-inbox.spec.ts`
Expected: PASS.

- [ ] **Step 6: Lint, type-check, commit**

Run: `cd apps/web && bun run lint && bun run type-check`
Expected: clean.

```bash
git add apps/web/components/fleet/ApprovalInbox.vue apps/web/tests/helpers/mount-sfc.ts apps/web/tests/components/fleet-approval-inbox.spec.ts
git commit -m "feat(web): approvals inbox with expandable rows, ?id= links and decide (S1.5 1b)"
```

---

### Task 7: Project and admin inbox pages, navigation, breadcrumbs

**Files:**
- Create: `apps/web/pages/[project]/fleet/approvals.vue`, `apps/web/pages/admin/fleet/approvals.vue`
- Modify: `apps/web/pages/[project]/fleet/index.vue` (Approvals button), `apps/web/layouts/default.vue` (sidebar link,
  breadcrumb)
- Test: `apps/web/tests/pages/fleet-approvals-pages.spec.ts` (create), `apps/web/tests/layouts/default-fleet-nav.spec.ts`
  (extend), `apps/web/tests/layouts/fleet-jobs-nav.spec.ts` (extend), `apps/web/tests/pages/fleet-jobs-list.spec.ts`
  (extend)

**Interfaces:**
- Consumes: `FleetApprovalInbox` (Task 6); `useProjectViewerRole`, `useProjectMemberNames`, `useFleetDispatchOptions`,
  `useFleetRepos`, `useFleetRunners`, `useAdminUsers`; `scopeName` from `~/lib/fleet-budgets`.
- Produces: routes `/:project/fleet/approvals`, `/admin/fleet/approvals`; test ids `fleet-approvals-link` (jobs list
  button), `fleet-approvals-admin-only` (admin page 403 line).

- [ ] **Step 1: Write the failing tests**

Create `apps/web/tests/pages/fleet-approvals-pages.spec.ts` (stub the inbox and assert what each page hands it):

```ts
import { describe, test, expect, jest } from '@jest/globals'
import * as Vue from 'vue'
import { ref, computed } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { uiStubs, enI18n } from '../helpers/fleet-harness'

const projectPage = webFile('pages', '[project]', 'fleet', 'approvals.vue')
const adminPage = webFile('pages', 'admin', 'fleet', 'approvals.vue')

/** Captures the props the page hands the inbox. Declared props are camelCased by Vue; listeners stay in attrs. */
function inboxStub(seen: Array<Record<string, unknown>>) {
  return {
    name: 'StubFleetApprovalInbox',
    inheritAttrs: false,
    props: ['base', 'viewer', 'scopeLabel', 'nameOf', 'jobLink', 'projectName'],
    setup(props: Record<string, unknown>, { attrs }: { attrs: Record<string, unknown> }) {
      seen.push({ ...props, ...attrs })
      return () => Vue.h('x-stub-stub', { 'data-stub': 'approval-inbox' })
    },
  }
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) {
    await new Promise((resolve) => { setImmediate(resolve) })
    await Vue.nextTick()
  }
}

describe('project approvals page', () => {
  test('hands the inbox the project base, the viewer\'s rights and member names', async () => {
    const seen: Array<Record<string, unknown>> = []
    const app = mountSfc(projectPage, {
      components: { ...uiStubs, FleetApprovalInbox: inboxStub(seen) },
      globals: {
        ref, computed,
        onMounted: Vue.onMounted,
        definePageMeta: () => undefined,
        useRoute: () => ({ params: { project: 'koda' } }),
        useI18n: () => enI18n(),
        useProjectViewerRole: () => ({ data: ref({ canManage: true, viewerRole: 'ADMIN' }) }),
        useProjectMemberNames: () => ({ load: jest.fn(async () => undefined), nameOf: (id: string) => (id === 'u1' ? 'Ada' : null) }),
        useFleetDispatchOptions: () => ({ load: jest.fn(async () => undefined), repoName: (id: string) => `repo-${id}` }),
      },
    })
    await settle()
    const props = seen[0]
    expect(props.base).toEqual({ kind: 'project', slug: 'koda' })
    expect(props.viewer).toEqual({ kind: 'project', canManage: true })
    expect((props.nameOf as (id: string) => string | null)('u1')).toBe('Ada')
    expect((props.jobLink as (p: string, j: string) => string | null)('p1', 'j1')).toBe('/koda/fleet/jobs/j1')
    const scopeLabel = props.scopeLabel as (p: { scopeType: string; scopeId: string | null }) => string | null
    expect(scopeLabel({ scopeType: 'project', scopeId: 'p1' })).toBe('koda')
    expect(scopeLabel({ scopeType: 'repo', scopeId: 'r1' })).toBe('repo-r1')
    expect(app.text()).toContain('Approvals')
    app.unmount()
  })
})

describe('admin approvals page', () => {
  function mountAdmin(seen: Array<Record<string, unknown>>) {
    return mountSfc(adminPage, {
      components: { ...uiStubs, FleetApprovalInbox: inboxStub(seen) },
      globals: {
        ref, computed,
        onMounted: Vue.onMounted,
        definePageMeta: () => undefined,
        useI18n: () => enI18n(),
        useFleetRepos: () => ({ projects: ref([{ id: 'p1', slug: 'koda', name: 'Koda' }]), loadProjects: jest.fn(async () => undefined) }),
        useFleetRunners: () => ({ runners: ref([{ id: 'r1', name: 'mac-1' }]), load: jest.fn(async () => undefined) }),
        useAdminUsers: () => ({ users: ref([{ id: 'u1', email: 'ada@k.t', name: 'Ada' }]), load: jest.fn(async () => undefined) }),
      },
    })
  }

  test('names projects, runners and users from the admin lookups', async () => {
    const seen: Array<Record<string, unknown>> = []
    const app = mountAdmin(seen)
    await settle()
    const props = seen[0]
    expect(props.base).toEqual({ kind: 'admin' })
    expect(props.viewer).toEqual({ kind: 'admin' })
    const projectName = props.projectName as (id: string | null) => string
    expect(projectName('p1')).toBe('koda')
    expect(projectName(null)).toBe('Fleet-wide')
    expect(projectName('gone')).toBe('gone')
    const jobLink = props.jobLink as (p: string, j: string) => string | null
    expect(jobLink('p1', 'j1')).toBe('/koda/fleet/jobs/j1')
    expect(jobLink('gone', 'j1')).toBeNull()
    expect((props.nameOf as (id: string) => string | null)('u1')).toBe('Ada')
    const scopeLabel = props.scopeLabel as (p: { scopeType: string; scopeId: string | null }) => string | null
    expect(scopeLabel({ scopeType: 'runner', scopeId: 'r1' })).toBe('mac-1')
    expect(scopeLabel({ scopeType: 'project', scopeId: 'p1' })).toBe('koda')
    app.unmount()
  })

  test('a 403 from the inbox shows the admin-only line', async () => {
    const seen: Array<Record<string, unknown>> = []
    const app = mountAdmin(seen)
    await settle()
    ;(seen[0].onForbidden as () => void)()
    await settle()
    expect(app.find('[data-testid="fleet-approvals-admin-only"]')).toHaveLength(1)
    app.unmount()
  })
})
```

Extend `apps/web/tests/layouts/default-fleet-nav.spec.ts`'s first test:

```ts
    expect(html.match(/<a href="\/admin\/fleet\/approvals"[^>]*>[\s\S]*?<\/a>/)?.[0]).toContain('nav.fleetApprovals')
```

and add `'Inbox'` to the `arrayContaining` list of the icon test.

In `apps/web/tests/layouts/fleet-jobs-nav.spec.ts`, add the breadcrumb case next to the existing budgets/schedules
cases, asserting the leaf for `/<project>/fleet/approvals` is `fleet.approvals.title` (follow that file's existing
breadcrumb assertion style).

In `apps/web/tests/pages/fleet-jobs-list.spec.ts`, next to the existing Schedules/Budgets button assertions, assert a
`fleet-approvals-link` button exists for every member and navigates to `/koda/fleet/approvals` (follow the file's
`fleet-schedules-link` assertion).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web && bun run test -- tests/pages/fleet-approvals-pages.spec.ts tests/layouts/default-fleet-nav.spec.ts tests/layouts/fleet-jobs-nav.spec.ts tests/pages/fleet-jobs-list.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Write the project page**

Create `apps/web/pages/[project]/fleet/approvals.vue`:

```vue
<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { scopeName } from '~/lib/fleet-budgets'
import type { ApprovalBase, ApprovalViewer, BudgetApprovalPayload } from '~/lib/fleet-approvals'

definePageMeta({ layout: 'default' })

const route = useRoute()
const slug = route.params.project as string
const base: ApprovalBase = { kind: 'project', slug }
const { t } = useI18n()
const { data: role } = useProjectViewerRole(slug)
const people = useProjectMemberNames(slug)
const options = useFleetDispatchOptions(slug)

// D244: canManage is project ADMIN, and a global ADMIN resolves to project ADMIN.
const viewer = computed<ApprovalViewer>(() => ({ kind: 'project', canManage: role.value.canManage }))
const scopeLabel = (p: BudgetApprovalPayload): string | null =>
  scopeName(p, { project: slug, repo: options.repoName, runner: (id) => id })
// A project inbox holds only this project's approvals (D230), so every candidate is a job of this project.
const jobLink = (_projectId: string, jobId: string): string => `/${slug}/fleet/jobs/${jobId}`

onMounted(() => {
  // Names are cosmetic: a failure leaves ids or the fallback on screen.
  void people.load().catch(() => undefined)
  void options.load().catch(() => undefined)
})
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('fleet.approvals.title')" :subtitle="t('fleet.approvals.subtitleProject')" />
    <FleetApprovalInbox :base="base" :viewer="viewer" :scope-label="scopeLabel" :name-of="people.nameOf" :job-link="jobLink" />
  </div>
</template>
```

- [ ] **Step 4: Write the admin page**

Create `apps/web/pages/admin/fleet/approvals.vue`:

```vue
<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { scopeName } from '~/lib/fleet-budgets'
import type { ApprovalBase, ApprovalViewer, BudgetApprovalPayload } from '~/lib/fleet-approvals'

definePageMeta({ layout: 'default' })

const base: ApprovalBase = { kind: 'admin' }
const viewer: ApprovalViewer = { kind: 'admin' }
const { t } = useI18n()
const repos = useFleetRepos()
const runnersApi = useFleetRunners()
const usersApi = useAdminUsers()
const forbidden = ref(false)

// D251: lookups are cosmetic; a failure leaves ids or the fallback on screen.
const slugOf = (projectId: string): string | null => repos.projects.value.find((p) => p.id === projectId)?.slug ?? null
const projectName = (projectId: string | null): string =>
  projectId === null ? t('fleet.approvals.noProject') : (slugOf(projectId) ?? projectId)
const jobLink = (projectId: string, jobId: string): string | null => {
  const slug = slugOf(projectId)
  return slug === null ? null : `/${slug}/fleet/jobs/${jobId}`
}
const runnerName = (id: string): string => runnersApi.runners.value.find((r) => r.id === id)?.name ?? id
const scopeLabel = (p: BudgetApprovalPayload): string | null =>
  p.scopeType === 'project' && p.scopeId !== null
    ? projectName(p.scopeId)
    : scopeName(p, { project: null, repo: (id) => id, runner: runnerName })
const nameOf = (userId: string): string | null => {
  const user = usersApi.users.value.find((u) => u.id === userId)
  return user ? (user.name || user.email) : null
}

onMounted(() => {
  void repos.loadProjects().catch(() => undefined)
  void runnersApi.load().catch(() => undefined)
  void usersApi.load().catch(() => undefined)
})
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('fleet.approvals.title')" :subtitle="t('fleet.approvals.subtitleAdmin')" />
    <p v-if="forbidden" class="text-sm text-muted-foreground" data-testid="fleet-approvals-admin-only">{{ t('fleet.common.adminOnly') }}</p>
    <FleetApprovalInbox
      v-else
      :base="base"
      :viewer="viewer"
      :scope-label="scopeLabel"
      :name-of="nameOf"
      :job-link="jobLink"
      :project-name="projectName"
      @forbidden="forbidden = true"
    />
  </div>
</template>
```

- [ ] **Step 5: Navigation and breadcrumbs**

In `apps/web/pages/[project]/fleet/index.vue`, first inside `<template #actions>`:

```vue
        <Button variant="outline" data-testid="fleet-approvals-link" @click="navigateTo(`/${slug}/fleet/approvals`)">
          {{ t('fleet.jobs.approvals') }}
        </Button>
```

In `apps/web/layouts/default.vue`: add `Inbox` to the `lucide-vue-next` import; after the Budgets admin link:

```vue
        <NuxtLink v-if="isGlobalAdmin" to="/admin/fleet/approvals" :class="navLinkClass" :active-class="activeClass"><Inbox class="h-4 w-4 shrink-0" />{{ t('nav.fleetApprovals') }}</NuxtLink>
```

and in `fleetLeaf`, before the final `return`:

```ts
  if (path === `/${project}/fleet/approvals`) return t('fleet.approvals.title')
```

Update the doc comment of `fleetLeaf` to "dispatch, budgets, approvals, or (anything else) a job".

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd apps/web && bun run test -- tests/pages tests/layouts`
Expected: PASS.

- [ ] **Step 7: Lint, type-check, commit**

Run: `cd apps/web && bun run lint && bun run type-check`

```bash
git add "apps/web/pages/[project]/fleet/approvals.vue" apps/web/pages/admin/fleet/approvals.vue "apps/web/pages/[project]/fleet/index.vue" apps/web/layouts/default.vue apps/web/tests/pages/fleet-approvals-pages.spec.ts apps/web/tests/layouts/default-fleet-nav.spec.ts apps/web/tests/layouts/fleet-jobs-nav.spec.ts apps/web/tests/pages/fleet-jobs-list.spec.ts
git commit -m "feat(web): project and admin approvals pages, nav and breadcrumbs (S1.5 1b D239)"
```

---

### Task 8: Header badge

**Files:**
- Create: `apps/web/components/fleet/ApprovalBadge.vue`
- Modify: `apps/web/layouts/default.vue`
- Modify: every layout spec that renders `default.vue` with a component map (`grep -l "layouts', 'default.vue'\|layouts/default.vue\|'default.vue'" apps/web/tests -r`): register `FleetApprovalBadge: stub('FleetApprovalBadge')` (or that spec's equivalent stub helper) so the header renders.
- Test: `apps/web/tests/components/fleet-approval-badge.spec.ts`

**Interfaces:**
- Consumes: `useFleetApprovalCounts`, `approvalsVersion` (Task 4); `badgeTarget`, `badgeText` (Task 1).
- Produces: `FleetApprovalBadge` props `{ slug: string | null }`; test id `fleet-approval-badge` with `data-count`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/tests/components/fleet-approval-badge.spec.ts`:

```ts
import { describe, test, expect, jest, afterEach } from '@jest/globals'
import * as Vue from 'vue'
import { ref, computed, watch } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { uiStubs, enI18n } from '../helpers/fleet-harness'

const badge = webFile('components', 'fleet', 'ApprovalBadge.vue')

type Handlers = { onFleetApproval?: () => void; onResync: () => void }

afterEach(() => {
  delete (globalThis as Record<string, unknown>).useApi
  jest.useRealTimers()
})

function mount(get: jest.Mock, opts: { slug?: string | null; role?: 'ADMIN' | 'MEMBER' } = {}) {
  ;(globalThis as Record<string, unknown>).useApi = () => ({ $api: { get } })
  let task: () => Promise<void> = async () => undefined
  let live: Handlers | null = null
  const polling = { start: jest.fn(), stop: jest.fn(), runNow: async () => { await task() }, isActive: () => true }
  const app = mountSfc(badge, {
    components: uiStubs,
    props: { slug: opts.slug === undefined ? 'koda' : opts.slug },
    globals: {
      ref, computed, watch,
      onMounted: Vue.onMounted,
      onBeforeUnmount: Vue.onBeforeUnmount,
      useI18n: () => enI18n(),
      useApi: () => ({ $api: { get } }),
      useAuth: () => ({ user: ref({ id: 'u1', role: opts.role ?? 'MEMBER' }) }),
      useVisiblePolling: (fn: () => Promise<void>) => { task = fn; return polling },
      useProjectEvents: (_s: string, h: Handlers) => { live = h },
    },
  })
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 4; i += 1) {
      await new Promise((resolve) => { setImmediate(resolve) })
      await Vue.nextTick()
    }
  }
  const el = () => app.find('[data-testid="fleet-approval-badge"]')
  return { app, polling, settle, el, poll: () => task(), live: () => live }
}

const counts = (total: number) => ({ total, unscoped: 0, projects: total > 0 ? [{ projectId: 'p2', slug: 'beta', pending: total }] : [] })

describe('FleetApprovalBadge (D247)', () => {
  test('hidden while nothing is pending', async () => {
    const m = mount(jest.fn(async () => counts(0)))
    await m.settle()
    expect(m.el()).toHaveLength(0)
    m.app.unmount()
  })

  test('shows the total and links to the current project inbox', async () => {
    const get = jest.fn(async () => counts(3))
    const m = mount(get)
    await m.settle()
    expect(get).toHaveBeenCalledWith('/fleet/approval-counts')
    expect(m.el()[0].props['data-count']).toBe(3)
    expect(m.el()[0].props.to).toBe('/koda/fleet/approvals')
    expect(m.app.textOf(m.el()[0])).toContain('3')
    m.app.unmount()
  })

  test('outside a project: the first project with pending for a member, the admin inbox for an admin', async () => {
    const member = mount(jest.fn(async () => counts(2)), { slug: null })
    await member.settle()
    expect(member.el()[0].props.to).toBe('/beta/fleet/approvals')
    member.app.unmount()
    const admin = mount(jest.fn(async () => counts(2)), { slug: null, role: 'ADMIN' })
    await admin.settle()
    expect(admin.el()[0].props.to).toBe('/admin/fleet/approvals')
    admin.app.unmount()
  })

  test('over 99 shows 99+', async () => {
    const m = mount(jest.fn(async () => counts(150)))
    await m.settle()
    expect(m.app.textOf(m.el()[0])).toContain('99+')
    m.app.unmount()
  })

  test('a failed refresh keeps the last count; a failed first load shows nothing', async () => {
    let fail = false
    const get = jest.fn(async () => {
      if (fail) throw new Error('down')
      return counts(4)
    })
    const m = mount(get)
    await m.settle()
    fail = true
    await m.poll()
    await m.settle()
    expect(m.el()[0].props['data-count']).toBe(4)
    m.app.unmount()

    const broken = mount(jest.fn(async () => { throw new Error('down') }))
    await broken.settle()
    expect(broken.el()).toHaveLength(0)
    broken.app.unmount()
  })

  test('a fleet_approval notice of the project refreshes after 300 ms', async () => {
    const get = jest.fn(async () => counts(1))
    const m = mount(get)
    await m.settle()
    jest.useFakeTimers()
    const before = get.mock.calls.length
    m.live()?.onFleetApproval?.()
    jest.advanceTimersByTime(300)
    jest.useRealTimers()
    await m.settle()
    expect(get.mock.calls.length).toBe(before + 1)
    m.app.unmount()
  })

  test('outside a project it does not subscribe to a stream', async () => {
    const m = mount(jest.fn(async () => counts(1)), { slug: null })
    await m.settle()
    expect(m.live()).toBeNull()
    m.app.unmount()
  })

  test('starts and stops its 60 s poll', async () => {
    const m = mount(jest.fn(async () => counts(1)))
    await m.settle()
    expect(m.polling.start).toHaveBeenCalled()
    m.app.unmount()
    expect(m.polling.stop).toHaveBeenCalled()
  })
})
```

Add the decide-signal test inside the same `describe` (the badge imports the composable module explicitly, so the
test and the badge share one `approvalsVersion` ref in the jest module registry):

```ts
  test('a decide anywhere in the tab refreshes after 300 ms (approvalsVersion)', async () => {
    const { approvalsVersion } = await import('../../composables/useFleetApprovals')
    const get = jest.fn(async () => counts(2))
    const m = mount(get, { slug: null, role: 'ADMIN' })
    await m.settle()
    jest.useFakeTimers()
    const before = get.mock.calls.length
    approvalsVersion.value += 1
    await Vue.nextTick()
    jest.advanceTimersByTime(300)
    jest.useRealTimers()
    await m.settle()
    expect(get.mock.calls.length).toBe(before + 1)
    m.app.unmount()
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && bun run test -- tests/components/fleet-approval-badge.spec.ts`
Expected: FAIL (component missing).

- [ ] **Step 3: Write the badge**

Create `apps/web/components/fleet/ApprovalBadge.vue`:

```vue
<template>
  <NuxtLink
    v-if="target"
    :to="target"
    class="inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm font-medium text-foreground hover:bg-accent"
    :aria-label="t('fleet.approvals.badge.label', { count })"
    :title="t('fleet.approvals.badge.label', { count })"
    data-testid="fleet-approval-badge"
    :data-count="count"
  >
    <Inbox class="h-4 w-4" />
    <span class="rounded-full bg-destructive px-1.5 text-xs text-destructive-foreground">{{ badgeText(count) }}</span>
  </NuxtLink>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, watch } from 'vue'
import { Inbox } from 'lucide-vue-next'
import { approvalsVersion, useFleetApprovalCounts } from '~/composables/useFleetApprovals'
import { createDebouncer } from '~/lib/debounce'
import { badgeTarget, badgeText } from '~/lib/fleet-approvals'

/** D247: 60 s backstop; live notices and decides refresh sooner. */
const POLL_MS = 60_000

// Keyed by slug in the layout, so a project change mounts a fresh badge with the right subscription.
const props = defineProps<{ slug: string | null }>()

const { t } = useI18n()
const auth = useAuth()
const { counts, load } = useFleetApprovalCounts()

const count = computed(() => counts.value?.total ?? 0)
const target = computed(() => {
  if (counts.value === null || count.value === 0) return null
  return badgeTarget(counts.value, { slug: props.slug, globalAdmin: auth.user.value?.role === 'ADMIN' })
})

async function refresh(): Promise<void> {
  try {
    await load()
  } catch {
    // Cosmetic: keep the last count and try again at the next poll or notice.
  }
}

const polling = useVisiblePolling(refresh, POLL_MS)
const liveReload = createDebouncer(() => { void refresh() }, 300)

onMounted(() => {
  void polling.runNow()
  polling.start()
})
onBeforeUnmount(() => {
  polling.stop()
  liveReload.cancel()
})
watch(approvalsVersion, () => liveReload.trigger())
if (props.slug) {
  useProjectEvents(props.slug, {
    onFleetApproval: () => liveReload.trigger(),
    onResync: () => liveReload.trigger(),
  })
}
</script>
```

- [ ] **Step 4: Put it in the header**

In `apps/web/layouts/default.vue`, inside `<div class="flex items-center gap-4">` before the email `<span>`:

```vue
          <FleetApprovalBadge v-if="auth.user.value" :key="projectSlug ?? ''" :slug="projectSlug ?? null" />
```

Register `FleetApprovalBadge` as a stub in each layout spec that mounts `default.vue` with an explicit component map
(see Files). Run `cd apps/web && bun run test -- tests/layouts tests/app-nuxt-layout.spec.ts tests/composables/logout-async.spec.ts tests/pages`
and add the stub wherever a spec now fails or warns about an unresolved `FleetApprovalBadge`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/web && bun run test -- tests/components/fleet-approval-badge.spec.ts tests/layouts tests/pages tests/app-nuxt-layout.spec.ts tests/composables/logout-async.spec.ts`
Expected: PASS.

- [ ] **Step 6: Lint, type-check, commit**

Run: `cd apps/web && bun run lint && bun run type-check`

```bash
git add apps/web/components/fleet/ApprovalBadge.vue apps/web/layouts/default.vue apps/web/tests
git commit -m "feat(web): pending approvals badge in the header (S1.5 1b D247)"
```

---

### Task 9: "Review override" link on the budget banner

**Files:**
- Modify: `apps/web/components/fleet/BudgetBanner.vue`
- Test: `apps/web/tests/components/fleet-budget-banner.spec.ts` (extend)

**Interfaces:**
- Consumes: `approvalRoot` (Task 4), `pendingByPolicy`, `inboxPath` (Task 1).
- Produces: per paused line, `fleet-budget-banner-review` link (`data-policy` = policy id). `defineExpose({ refresh })`
  unchanged.

- [ ] **Step 1: Write the failing tests**

The banner now makes two GETs. In `fleet-budget-banner.spec.ts`, change existing mocks that return a policy array to
route by path: a helper

```ts
const routed = (policies: unknown, approvals: unknown = { records: [] }) =>
  jest.fn(async (path: string) => (path.includes('/fleet/approvals') ? approvals : policies))
```

Update the first test's assertion to
`expect(get).toHaveBeenCalledWith('/projects/koda/fleet/budgets')` (unchanged) **and**
`expect(get).toHaveBeenCalledWith('/projects/koda/fleet/approvals', { query: { status: 'pending', type: 'budget_override_required', size: '100' } })`.
Replace each `jest.fn(async () => [ ...policies ])` in the file with `routed([ ...policies ])` (the failing-load test
keeps a mock that always throws). Then add:

```ts
  const pendingApproval = (id: string, policyId: string) => ({
    id, type: 'budget_override_required', status: 'pending', projectId: 'p1', jobId: null, policyId, payload: {}, outcome: null,
    requestedAt: '2026-10-03T10:00:00.000Z', expiresAt: null, decision: null, decidedById: null, decidedAt: null, resolvedBy: null, comment: null,
  })

  test('a paused policy with a pending override links to it (D248)', async () => {
    const m = mountBanner(routed([policy('p', { scopeType: 'project', scopeId: 'p1', paused: true })], { records: [pendingApproval('a1', 'p')] }))
    await m.settle()
    const review = m.app.find('[data-testid="fleet-budget-banner-review"]')
    expect(review).toHaveLength(1)
    expect(review[0].props.to).toBe('/koda/fleet/approvals?id=a1')
    expect(m.app.textOf(review[0])).toBe('Review override')
    m.app.unmount()
  })

  test('no link for a warning line or a paused policy without a pending override', async () => {
    const m = mountBanner(routed(
      [policy('w', { scopeType: 'repo', scopeId: 'r1', warnReached: true }), policy('p', { paused: true })],
      { records: [pendingApproval('a1', 'w')] },
    ))
    await m.settle()
    expect(m.app.find('[data-testid="fleet-budget-banner-review"]')).toHaveLength(0)
    m.app.unmount()
  })

  test('a failed approvals load keeps the lines without links', async () => {
    const get = jest.fn(async (path: string) => {
      if (path.includes('/fleet/approvals')) throw new Error('down')
      return [policy('p', { paused: true })]
    })
    const m = mountBanner(get)
    await m.settle()
    expect(m.lines()).toHaveLength(1)
    expect(m.app.find('[data-testid="fleet-budget-banner-review"]')).toHaveLength(0)
    m.app.unmount()
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && bun run test -- tests/components/fleet-budget-banner.spec.ts`
Expected: FAIL (no approvals request, no review link).

- [ ] **Step 3: Implement**

In `apps/web/components/fleet/BudgetBanner.vue`, inside the line `<div v-for ...>`, replace `{{ lineText(line) }}`
with:

```vue
      {{ lineText(line) }}
      <NuxtLink
        v-if="line.status === 'paused' && reviewIds.get(line.policy.id)"
        :to="inboxPath({ kind: 'project', slug }, reviewIds.get(line.policy.id))"
        class="ml-2 font-medium underline-offset-4 hover:underline"
        data-testid="fleet-budget-banner-review"
        :data-policy="line.policy.id"
      >
        {{ t('fleet.budgets.banner.review') }}
      </NuxtLink>
```

In the script, add `ref` to the existing `vue` import, then these imports and state:

```ts
import { approvalRoot } from '~/composables/useFleetApprovals'
import { inboxPath, pendingByPolicy } from '~/lib/fleet-approvals'
import type { FleetApprovalDto, FleetPage } from '~/lib/fleet-types'
```

```ts
const { $api } = useApi()
/** D248: policy id -> its pending override; empty when the request fails. */
const reviewIds = ref<ReadonlyMap<string, string>>(new Map())

async function loadReviews(): Promise<void> {
  try {
    const res = await $api.get<FleetPage<FleetApprovalDto>>(approvalRoot({ kind: 'project', slug: props.slug }), {
      query: { status: 'pending', type: 'budget_override_required', size: '100' },
    })
    reviewIds.value = pendingByPolicy(res.records ?? [])
  } catch {
    reviewIds.value = new Map()
  }
}
```

and change `refresh` to run both:

```ts
async function refresh(): Promise<void> {
  try {
    await Promise.all([load(), loadReviews()])
  } catch {
    // Cosmetic on a page about something else: keep what was shown and try again at the next poll.
  }
}
```

(`slug` in the template is the `slug` prop; Vue exposes props by name in templates. If the existing template refers to
`slug` already through `props`, keep that style.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/web && bun run test -- tests/components/fleet-budget-banner.spec.ts tests/pages/fleet-jobs-list.spec.ts`
Expected: PASS. If `fleet-jobs-list.spec.ts` mocks `useApi().get` with a single answer for the banner, route the
approvals path there too.

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/fleet/BudgetBanner.vue apps/web/tests/components/fleet-budget-banner.spec.ts apps/web/tests/pages/fleet-jobs-list.spec.ts
git commit -m "feat(web): budget banner links a paused policy to its pending override (S1.5 1b D248)"
```

---

### Task 10: E2E (spec §7 (1)) and docs

**Files:**
- Create: `apps/web/tests/e2e/fixtures/fleet-approvals-api.ts`
- Create: `apps/web/tests/e2e/fleet-approvals.e2e.spec.ts`
- Modify: `docs/deployment/runner.md` (budget section), `docs/superpowers/specs/2026-10-02-fleet-s1-5-approvals-design.md` (§8 plan notes)

**Interfaces:**
- Consumes: `call`, `repoIdOf`, `dispatchRun`, `deleteOwnPolicies` from `./fixtures/fleet-budgets-api`; `ScriptedRunner`;
  `login`, `E2E_ADMIN`; `webLogin`, `waitForHydration`. Every test id from Tasks 5-9.

- [ ] **Step 1: Write the fixture**

Create `apps/web/tests/e2e/fixtures/fleet-approvals-api.ts`:

```ts
/**
 * Fleet S1.5 slice 1b: the API calls the approvals e2e makes outside the browser. Responses use the { ret, data } envelope.
 */
import { call } from './fleet-budgets-api';

export interface ApprovalRow {
  id: string;
  type: string;
  status: string;
  policyId: string | null;
}

export async function createProjectPolicy(token: string, slug: string, amountUsd: number): Promise<string> {
  const created = await call<{ id: string }>('POST', `/projects/${slug}/fleet/budgets`, token, {
    scopeType: 'project', windowKind: 'calendar_month_utc', amountUsd, warnPercent: null, hardStop: true, runningJobs: 'finish',
  });
  return created.id;
}

export async function pendingBudgetApprovals(token: string, slug: string): Promise<ApprovalRow[]> {
  const page = await call<{ records: ApprovalRow[] }>(
    'GET', `/projects/${slug}/fleet/approvals?status=pending&type=budget_override_required&size=100`, token,
  );
  return page.records;
}

export async function jobState(token: string, slug: string, jobId: string): Promise<string> {
  const job = await call<{ state: string }>('GET', `/projects/${slug}/fleet/jobs/${jobId}`, token);
  return job.state;
}
```

`GET /projects/:slug/fleet/jobs/:id` answers the `FleetJobDto` itself (verified: `FleetJobsService.get`), so `.state`
is read directly.

- [ ] **Step 2: Write the E2E**

Create `apps/web/tests/e2e/fleet-approvals.e2e.spec.ts`:

```ts
import { test, expect } from '@playwright/test';
import { login, E2E_ADMIN } from './fixtures/api-client';
import { createProjectPolicy, jobState, pendingBudgetApprovals } from './fixtures/fleet-approvals-api';
import { deleteOwnPolicies, dispatchRun, repoIdOf } from './fixtures/fleet-budgets-api';
import { waitForHydration, webLogin } from './fixtures/page-helpers';
import { ScriptedRunner, type Lease } from './fixtures/scripted-runner';

/**
 * Fleet S1.5 slice 1b (plan D254, spec §7 (1)): a budget hard stop raises an override; raise and resume from the
 * inbox re-queues the job the pause cancelled before it started, and that job runs again.
 * Project `fleet-e2e` and repo acme/e2e-app come from prisma/seed-e2e.ts.
 */
const SLUG = 'fleet-e2e';

test.describe('Fleet approvals (scripted runner)', () => {
  let token = '';
  let runner: ScriptedRunner;
  const suffix = Date.now().toString().slice(-6);

  test.beforeAll(async () => {
    const session = await login(E2E_ADMIN.email, E2E_ADMIN.password);
    token = session.token;
    runner = await ScriptedRunner.enroll(token, `e2e-approval-runner-${suffix}`);
    await deleteOwnPolicies(token, SLUG);
  });

  // Deleting the policy also closes any approval left pending (policy_deleted), so later specs start clean.
  test.afterAll(async () => {
    if (!token) return;
    await deleteOwnPolicies(token, SLUG);
  });

  test('hard stop -> raise and resume with re-queue -> the cancelled job runs again', async ({ page }) => {
    test.setTimeout(150_000);

    // 1. A $0.50 project policy; job A runs on the scripted runner, job B waits QUEUED behind it.
    await createProjectPolicy(token, SLUG, 0.5);
    const repoId = await repoIdOf(token, SLUG, 'acme/e2e-app');
    await runner.heartbeat();
    const jobA = await dispatchRun(token, SLUG, { repoId, feature: `appr-a-${suffix}`, maxCostUsd: 3, pinnedRunnerId: runner.id });
    const leaseA: Lease = await runner.acceptAssign(jobA);
    // Every sync after acceptAssign reports freeSlots 0, so B is never assigned before the stop.
    const jobB = await dispatchRun(token, SLUG, { repoId, feature: `appr-b-${suffix}`, maxCostUsd: 3, pinnedRunnerId: runner.id });

    // 2. A reports $0.60: over the limit. The hard stop pauses the project, cancels B and raises the override.
    await runner.report(leaseA, [
      { type: 'state', payload: { to: 'RUNNING' } },
      { type: 'snapshot', payload: { costSpentUsd: '0.6000', heartbeatAt: new Date().toISOString() } },
    ]);
    await expect.poll(async () => (await pendingBudgetApprovals(token, SLUG)).length, { timeout: 20_000 }).toBe(1);
    await expect.poll(() => jobState(token, SLUG, jobB), { timeout: 20_000 }).toBe('CANCELLED');
    const [approval] = await pendingBudgetApprovals(token, SLUG);

    // 3. The banner on the jobs list leads to the override; the header badge counts it.
    await webLogin(page);
    await page.goto(`/${SLUG}/fleet`);
    await waitForHydration(page);
    const badge = page.getByTestId('fleet-approval-badge');
    await expect(badge).toBeVisible();
    const before = Number(await badge.getAttribute('data-count'));
    expect(before).toBeGreaterThanOrEqual(1);
    await page.getByTestId('fleet-budget-banner-review').click();
    await page.waitForURL(new RegExp(`/${SLUG}/fleet/approvals\\?id=${approval.id}$`));
    await waitForHydration(page);

    // 4. The row is open with B offered and ticked; raise to $2 and resume.
    const row = page.getByTestId(`fleet-approval-row-${approval.id}`);
    await expect(row.getByTestId('fleet-approval-budget-panel')).toBeVisible();
    await expect(row.getByTestId(`fleet-approval-candidate-${jobB}`)).toBeChecked();
    await row.getByTestId('fleet-approval-amount').fill('2');
    await row.getByTestId('fleet-approval-raise').click();

    // 5. The outcome shows B re-queued; the badge drops by one.
    await expect(row.getByTestId(`fleet-approval-requeue-result-${jobB}`)).toHaveAttribute('data-ok', 'true');
    await expect.poll(async () => Number((await badge.getAttribute('data-count')) ?? '0'), { timeout: 10_000 }).toBe(before - 1);
    expect(await jobState(token, SLUG, jobB)).toBe('QUEUED');

    // 6. A finishes; B is assigned again and runs.
    await runner.report(leaseA, [{ type: 'state', payload: { to: 'UPLOADING' } }]);
    await runner.uploadBundle(leaseA, `bundle of ${jobA}`);
    await runner.report(leaseA, [
      { type: 'snapshot', payload: { finishResult: 'opened', resultBranch: `feat/appr-a-${suffix}`, resultPrUrl: 'https://github.com/acme/e2e-app/pull/11', costSpentUsd: '0.6000' } },
      { type: 'state', payload: { to: 'COMPLETED', exitCode: 0 } },
    ]);
    const leaseB: Lease = await runner.acceptAssign(jobB);
    await runner.report(leaseB, [{ type: 'state', payload: { to: 'RUNNING' } }]);
    await page.goto(`/${SLUG}/fleet/jobs/${jobB}`);
    await waitForHydration(page);
    await expect(page.getByTestId('fleet-job-state')).toHaveAttribute('data-state', 'RUNNING');

    // 7. Finish B so nothing stays active for the specs that follow.
    await runner.report(leaseB, [{ type: 'state', payload: { to: 'UPLOADING' } }]);
    await runner.uploadBundle(leaseB, `bundle of ${jobB}`);
    await runner.report(leaseB, [
      { type: 'snapshot', payload: { finishResult: 'opened', resultBranch: `feat/appr-b-${suffix}`, resultPrUrl: 'https://github.com/acme/e2e-app/pull/12', costSpentUsd: '0.1000' } },
      { type: 'state', payload: { to: 'COMPLETED', exitCode: 0 } },
    ]);
  });
});
```

The API polls are the source of truth for job states; the only UI state assertion is the job page in step 6.

- [ ] **Step 3: Run the E2E**

Run: `cd apps/web && bun run test:e2e -- tests/e2e/fleet-approvals.e2e.spec.ts`
Expected: 1 passed. Then run the fleet E2E set together to prove ordering and cleanup:
`cd apps/web && bun run test:e2e -- tests/e2e/fleet-approvals.e2e.spec.ts tests/e2e/fleet-budgets.e2e.spec.ts tests/e2e/fleet-dispatch.e2e.spec.ts tests/e2e/fleet-schedules.e2e.spec.ts`
Expected: all passed.

- [ ] **Step 4: Docs**

In `docs/deployment/runner.md`, in the budget section that 1a extended ("a hard stop pauses and now raises an approval
you must answer"), add:

```markdown
Answer the override in the web: the header badge counts pending approvals, the jobs-list banner has a "Review
override" link, and `/<project>/fleet/approvals` (project and repo budgets) or `/admin/fleet/approvals` (fleet-wide
and runner budgets) lists them. "Raise and resume" takes a new limit above the spend and re-queues the ticked jobs the
pause cancelled before they started; "Keep paused" leaves the pause (resume later from the budgets page).
```

In the spec's §8, after the 1a plan-notes bullet, add:

```markdown
- 1b plan notes (`docs/superpowers/plans/2026-10-03-fleet-s1-5-slice-1b-approvals-web.md`, D239-D254): Pending tab is
  one page of 100 sorted by expiry; one shared EventSource per project per tab (page + header badge); the open
  approval is re-fetched only when its status changes; re-queue results are shown only for inbox raises (a manual
  resume's `[]` is not "none selected"); the banner link reads the project's pending overrides (no API change).
```

- [ ] **Step 5: Full gates**

Run: `cd apps/web && bun run lint && bun run type-check && bun run test`
Expected: all clean and green. Run `bun run generate` at the repo root and confirm `git status` shows no change to
`openapi.json` or `apps/cli/src/generated/`.

- [ ] **Step 6: Commit**

```bash
git add apps/web/tests/e2e/fleet-approvals.e2e.spec.ts apps/web/tests/e2e/fixtures/fleet-approvals-api.ts docs/deployment/runner.md docs/superpowers/specs/2026-10-02-fleet-s1-5-approvals-design.md
git commit -m "test(web): approvals e2e — hard stop, raise and resume with re-queue (S1.5 1b D254); docs"
```

---

## Self-review notes

- Spec §5 items for 1b: inbox pages (Tasks 6-7), Pending default + All + type filter + expiry sort + `?id=` (Tasks 1, 6),
  budget panel with amount, candidates, "and N more" (as a truncation note, D243), Keep paused (Task 5), decided view
  (Task 5), badge with debounce + 60 s poll + link rules (Task 8), `BudgetBanner` link (Task 9), composable with
  mutation epoch (Task 4), hidden-not-disabled (Tasks 5-6), 409 toast + reload (Task 6), i18n + parity enums (Task 2).
  Bash panel, countdown (`useApprovalCountdown`), job-page callout/timeline, dispatch/schedule fields and the jobs-list
  marker are 2b.
- Spec §7 web unit: mappers (Task 1), composables with mutation epoch (Task 4), permission gating and option-gated
  buttons (budget only in 1b, Tasks 5-6), i18n parity (Task 2). E2E (1) is Task 10.
- No API change; `openapi.json` checked unchanged in Task 10.
