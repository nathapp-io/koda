# Fleet S1.5 Slice 2b — Bash Approvals Web, CLI Fields and E2E Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A project developer answers a nax shell-command ask from the koda web: the inbox row shows the masked
command, a countdown to nax's deadline, and **Allow once** / **Allow for this job** / **Deny** (only what nax offered;
a cut command can only be denied), then shows whether the runner delivered the answer. The job page calls out
"Waiting for approval (N)" and lists the job's asks; the jobs list marks jobs that need approval. The dispatch form,
the schedule dialog and the CLI (`dispatch`, `schedule add|edit`) set `bashMode` and the ask timeout. Playwright proves
the loop on the scripted runner (spec §7 E2E (2) allow and (3) expire), and a human-run live check proves it on a real
`nax run`.

**Architecture:** Web-first slice on top of the merged 2a contract; **no API change**. A small pure library for bash
mode fields (`lib/fleet-bash-mode.ts`), bash additions to `lib/fleet-approvals.ts` (payload guard, choices, decide
body, countdown, delivery view), a 1-second clock composable, one new decide panel, one new job-page section, and
edits to the inbox, outcome, job page, jobs list, dispatch page, schedule dialog and detail page. CLI gains two flags
on three commands. The runner gets one 2a deferred fix (an answer past nax's deadline is refused without a POST) and
one test gate. The scripted E2E runner learns protocol v2, the relay capability, `approval_request` and
`APPROVAL_ANSWER`.

**Tech Stack:** Nuxt 3 + Vue 3 `<script setup>`, shadcn-vue primitives, vee-validate + zod (dispatch, schedule),
`useApi` (`$api`), `vue-i18n` (en + zh), Jest with the `mountSfc` harness, Playwright with the scripted runner;
commander + Jest (CLI); Bun test (runner).

**Spec:** `docs/superpowers/specs/2026-10-02-fleet-s1-5-approvals-design.md` §1.2, §1.3, §1.6, §1.7, §2.3, §5, §6, §7
(web unit, E2E (2) (3), live check), §8 (slice 2b). Backend contract: `docs/superpowers/plans/2026-10-03-fleet-s1-5-slice-2a-approval-relay.md`
(D255-D287) and the merged code (PR #196, `24583b7f`). Web patterns: `docs/superpowers/plans/2026-10-03-fleet-s1-5-slice-1b-approvals-web.md`
(D239-D254).

## Global Constraints

- **No API change.** `openapi.json`, `apps/cli/src/generated/*` and everything under `apps/api/` stay untouched
  (`git diff --stat main -- apps/api openapi.json apps/cli/src/generated` is empty at the end).
- Bash payload (2a, `apps/api/src/fleet/sync/approval-request-payload.ts`): `{ command, commandTruncated, maskedCount,
  root, stage, storyId, featureName, reason, options[], rawDetail? }`. `command` is `''` when the runner could not parse
  nax's text; then `rawDetail` holds it. `options` is a non-empty subset of `allow | allow-remember | deny` that always
  contains `deny`. Text fields are capped at 12 KiB (`APPROVAL_TEXT_MAX_BYTES`).
- Bash decide (2a `bash-decision.ts`, D267, D287): `allow` needs `allow` offered and `!commandTruncated`;
  `allow_for_job` needs `allow-remember` offered and `!commandTruncated`; `deny` always. A bash decide with `amountUsd`
  or `requeueJobIds` answers 400 `fleet.approvalInput`. A decide that finds the ask expired or its job gone commits
  that close and answers **409**.
- Bash permissions (spec §1.7, 2a D266): project **DEVELOPER or ADMIN** decides a bash ask (`canWorkOnFleet` in
  `lib/fleet-jobs.ts`; a global ADMIN resolves to project ADMIN on the members endpoint); budget asks stay project ADMIN
  (`canManage`). The admin inbox decides both. Decide controls are **hidden, not disabled**.
- Delivery (2a D268): the runner's ack of `APPROVAL_ANSWER` is stored as `outcome.delivery = { result: 'ok' |
  'rejected', detail: string | null, at }`; **no live event** is published for it. Known runner details:
  `ask_not_pending`, `job_not_running`, `invalid payload`, `callback_failed:<status>`, and (this slice) `ask_expired`.
- Job fields (2a): `FleetJobDto.bashMode` (`raw | gated | escalate`), `approvalTimeoutSec` (30..3600, default 600),
  `pendingApprovals` (count). `ScheduleDto` gains `bashMode` and `approvalTimeoutSec`. Dispatch and schedule create
  accept both optionally; schedule PATCH treats an **omitted** field as unchanged (3a D203). A PLAN job with a non-raw
  `bashMode` answers 400; a gated/escalate job only runs on a runner with the relay (misfit `approvals_relay`).
- `GET /projects/:slug/fleet/approvals?jobId=<id>&size=100` lists one job's approvals (2a `list` filter), newest first.
- Live: SSE `fleet_approval` is content-free (`{ id, type, projectId, approvalId, status, at }`) and fires on create
  and every status change of project-scoped approvals only.
- Web conventions (`.nax/rules/web.md`): API only through composables with `useApi()`; `useAppToast()` +
  `extractApiError()`; no hardcoded UI strings; semantic Tailwind tokens; native selects through `FleetNativeSelect`;
  new composables imported explicitly (`import { useApprovalCountdown } from '~/composables/useApprovalCountdown'`);
  components under `components/fleet/` are `Fleet<Name>` in templates and must be registered in the
  `FLEET_COMPONENT_FILES` table of `apps/web/tests/helpers/mount-sfc.ts` to mount for real in tests.
- i18n: every key in both `apps/web/i18n/locales/en.json` and `zh.json`; no `|` or `@` in any `fleet.*` message
  (command text reaches messages only as a named parameter); dynamic keys listed in the `ENUMS` table of
  `apps/web/tests/i18n/fleet-locale-parity.spec.ts`.
- Commands: web `cd apps/web && bun run test -- <path>`, `bun run lint`, `bun run type-check`; CLI
  `cd apps/cli && bun run test -- <path>`, `bun run lint`, `bun run type-check`; runner `cd apps/runner && bun test
  <path>`, `bun run lint`, `bun run type-check`; E2E `cd apps/web && bun run test:e2e -- tests/e2e/<file>` (Postgres
  for e2e on :5433 must be up). Never run bare `bun test` at the repo root.
- No emojis, no `console.log` in web/runner source, no `eslint-disable`, no hand edits under `*/generated/`;
  conventional commits; never push, never open a PR.

## Decisions

Numbered D288-D306 (slice 2a ended at D287).

| # | Decision | Why |
|:--|:--|:--|
| D288 | **No API change.** Every screen reads the 2a contract as merged: `pendingApprovals` drives the callout and the jobs-list marker, `?jobId=` lists a job's asks, `expiresAt` drives the countdown, `outcome.delivery` the delivery line. | 2a shipped the whole wire contract (D281: "Web: types + i18n parity only"); 2b is the UI on it. |
| D289 | `bashPayload(a)` guards the payload like `budgetPayload` does: every field type-checked; `command === ''` without `rawDetail` is malformed. A malformed bash payload renders "This ask could not be read" and offers **Deny only**. | Fail closed (spec success criterion 4): a human never allows text the page could not show. The server accepts a deny on any bash ask. |
| D290 | `ApprovalViewer` for a project gains `canWork` (`canWorkOnFleet(role)`). `canDecide`: pending, and admin inbox, or budget + `canManage`, or bash + `canWork`. A bash non-decider sees `fleet.approvals.readOnlyBash`. | Spec §1.7: bash = DEVELOPER+, budget = ADMIN; 1b's `canDecide` refused every bash ask. |
| D291 | `bashChoices(payload)`: a cut command (`commandTruncated`) offers `['deny']`; otherwise `allow` when `allow` is offered, `allow_for_job` when `allow-remember` is offered, and always `deny`, in that order. An unparsed ask (`command === ''`) is decided on `rawDetail` under the same rules, with a note that nax's text could not be split into a command. | Mirrors 2a `checkBashDecision` (the server refuses anything else with 400); 2a Review Focus 1 allows raw text only when not cut. |
| D292 | Countdown: `secondsLeft(expiresAt, now)` (ceil, floored at 0, null without an expiry) and `countdownText` (`m:ss`, `h:mm:ss` from an hour). `useApprovalCountdown()` ticks a `now` ref every second while mounted (`createCountdownClock` is the testable core). At 0 the bash panel hides its buttons and says nax has denied the command; the server sweep (15 s) then marks it expired. | Spec §5 countdown; deciding at 0 can only end in a 409 (`expiresAt` is `min(nax deadline, requestedAt + timeout)`), so offering buttons there would mislead. |
| D293 | Bash decide body `{ decision, comment? }` (`toBashBody`), never `amountUsd` or `requeueJobIds`. One optional comment (max 1000, same rule as budget). Toasts `fleet.approvals.toast.<decision>`. | 2a D287 400s budget fields on a bash decide. |
| D294 | Decided bash approvals (`FleetApprovalOutcome`): the command (or raw text) read-only, then a delivery line for `resolvedBy: 'user'` only: `delivered` (`result: 'ok'`), `failed` (`rejected`, shows the runner detail), or `waiting` (no delivery stored yet; any other stored shape reads as `failed` with no detail). | Spec §5 "delivery result"; a timeout or job-end close sent nothing, so no delivery line. |
| D295 | While the open approval is a bash ask decided by a user whose delivery is still `waiting`, every inbox reload (30 s poll, live notice) also re-fetches it. | 2a D268 publishes no live event for the ack; without this the line would read "waiting" until the human re-opened the row. Bounded to one GET per reload while one row is open. |
| D296 | Row summary for a bash ask: `Run {command} ({stage})` with the first line of the command (or of `rawDetail`), cut at 80 characters with `...` when longer or multi-line. A pending bash row also shows its countdown. | Spec §5 "summary"; the full text is in the panel. |
| D297 | Job page: (1) a "Shell approvals" line in the details grid (`Off` or `Escalate, asks wait 10 min`); (2) a callout "Waiting for approval (N)" when `pendingApprovals > 0`, with **Review** linking to the inbox `?id=` of the job's pending ask that expires first (the inbox root when the list is not loaded); (3) an **Approvals** section (`FleetJobApprovals`) listing the job's approvals (`?jobId=`, size 100): type, command preview, status, decision or `resolvedBy`, countdown when pending, "Open" link to the inbox row. The section shows when the job is not raw or has approvals. The page reloads the job and its approvals on `fleet_approval` notices (debounced with the existing 300 ms reload). Decisions are made in the inbox only. (4) The timeline renders `approval_request` events as "Approval requested: {command}". | Spec §5 "callout" and "Approvals timeline section"; one decide surface keeps the 409/expiry handling in one place. The `approval_request` event is already stored as a job event (2a appends every runner event). |
| D298 | Web timeout fields are **minutes** (spec §5): text input, a number with at most 2 decimals, converted with `Math.round(min * 60)` and valid when the result is 30..3600 s (0.5 to 60 min). `minutesText(sec)` shows a stored value with at most 2 decimals; every whole second in range round-trips exactly, so editing a schedule whose timeout came from the CLI (say 90 s) never changes it. Default 10 (600 s). | The API takes seconds; the spec asks for minutes; the round-trip property keeps PATCH honest. |
| D299 | Dispatch form: `bashMode` native select (labels Off / Gated / Escalate, help text about `Bash(...)` grants and relay runners) and the timeout field, shown **only for RUN**, the timeout only for gated/escalate. Body: a raw (or PLAN) job sends neither field; a gated/escalate RUN sends both. | Spec §5 "PLAN keeps raw"; the server would 400 a non-raw PLAN. Omitting raw keeps today's bodies byte-identical. |
| D300 | Schedule dialog: the same two fields plus a warning that asks of a scheduled run may wait until the timeout. Create sends both only for gated/escalate. PATCH always sends `bashMode`, and sends `approvalTimeoutSec` only for gated/escalate (raw omits it, so the stored value is kept). The schedule detail page shows the same "Shell approvals" line as the job page. | Spec §1.6/§5; D218 sends every editable field, but a raw schedule's hidden timeout must not be validated or overwritten. |
| D301 | CLI: `--bash-mode <raw\|gated\|escalate>` and `--approval-timeout <seconds>` (30..3600, commander `InvalidArgumentError` on bad input) on `koda fleet dispatch`, `schedule add` and `schedule edit`. Dispatch: a non-raw mode with `--plan` and a timeout without a gated/escalate mode are refused before any request (exit 3). `schedule add`: the timeout without gated/escalate is refused (exit 3). `schedule edit`: both are passed through as given (the stored mode may already be gated). `job show` gains "Bash mode" and "Pending approvals" rows; `schedule show` prints the bash mode in its template line. | Lifts 2a D287 now that the web has the matching fields; seconds match the API and the existing CLI style (`--max-cost` in USD, not cents). |
| D302 | Runner (2a deferred item 1): `ApprovalRelay.answer` refuses an ask whose journalled `deadlineAt` has passed: it deletes the pending ask, sends no POST, and acks `rejected` / `ask_expired`. | Closes the clock-skew audit window: nax has already denied that ask, so a recorded `ok` would be false. |
| D303 | Runner (2a deferred item 3): `test/integration/approval-relay.integration.spec.ts` is wrapped in `describe.skipIf(!enabled)` with `enabled = KODA_DB_TESTS === '1'`, like every other runner integration spec. | Gate parity; CI already sets the variable. |
| D304 | Not taken, not filed: 2a deferred items 2 (`fit()` may shrink a parsed command to empty; it fails safe as a rejected event) and 4 (sweeper `jobId IS NOT NULL`, receiver content-length pre-check), and 1b deferred item 1 (`badgeTarget` defensive). Nil blast radius. | Scope discipline; each fails safe today. |
| D305 | E2E `fleet-bash-approvals.e2e.spec.ts`, two tests on one relay-capable scripted runner (enrolled with protocol v2 and `approvals: { relay: true }`). (2) escalate RUN -> `approval_request` -> jobs-list marker -> job-page callout -> Review -> inbox row with the command, masked note and countdown -> **Allow once** -> outcome "waiting" -> the runner receives `APPROVAL_ANSWER { choice: 'allow' }` and acks ok -> reload shows "delivered" -> job completes; the job page lists the ask as approved and the timeline shows "Approval requested". (3) An ask with a deadline 8 s out: the panel's buttons disappear when the countdown reaches 0; the API reports `expired` within 45 s (sweeper); the reloaded row reads Expired / Timed out; no `APPROVAL_ANSWER` reaches the runner. API polling stays at 1 request per 2 s (global throttle 100/min; `/fleet/runner/*` is exempt). | Spec §7 E2E (2)(3) through real endpoints; scripted runner as in 1b (D128 pattern). |
| D306 | Live check (spec §7) is **human-run and billed**, approval at launch, after the PR's gates are green: one real `nax run` with `bashMode: escalate` on one local runner against a local koda; one ask allowed, one denied; the job page and nax's `approval-audit/<runId>.jsonl` agree. It needs a GitHub App on the test repo (R5 brokers all runner git); if that is not available the check is reported as blocked, like the S1 live check. | Spec §7; never launched by an executor (standing ruling: billed runs need approval at launch). |

## Review Focus

1. **An ask a human must not allow**: a cut command, an option nax did not offer, or a payload the page cannot read.
   Expected: a cut command shows the notice and only **Deny**; "Allow for this job" only when nax offered
   `allow-remember`; a malformed payload shows "could not be read" and only **Deny**; an unparsed ask shows the raw
   text and a note. (Task 2 `bashChoices`/`bashPayload`, Task 3 panel tests.)
2. **The countdown runs out while the row is open**: before the 15 s sweep marks it expired. Expected: at 0 the
   buttons disappear and the panel says nax has denied it; a decide that races expiry gets 409, a toast, and the row
   re-fetched as expired. (Task 3 panel test at 0; Task 4 inbox 409 test with a bash row.)
3. **The answer is decided but the runner has not delivered it yet**: Expected: the outcome says "waiting", and the
   next poll re-fetches the open row so it turns "delivered" or "failed (detail)" without re-opening it. (Task 2
   `deliveryView`; Task 4 inbox test.)
4. **Who sees buttons**: a VIEWER sees a read-only line on a bash ask; a DEVELOPER sees bash buttons but still no
   budget buttons; the admin inbox decides both. (Task 2 `canDecide`; Task 4 inbox and page tests.)
5. **Editing a schedule without touching its bash fields**: a timeout stored by the CLI as 90 s must PATCH back as
   90 s; switching an escalate schedule to raw with an emptied timeout field must save (no validation error, no
   timeout sent). (Task 1 round-trip test; Task 8 schedule mapper tests.)

---

## File Structure

| File | Responsibility |
|:--|:--|
| `apps/web/lib/fleet-types.ts` (modify) | `BashMode`; bash fields on `DispatchBody`, `ScheduleDto`, `NewScheduleBody`, `SchedulePatchBody`; `approval_request` event type. |
| `apps/web/lib/fleet-bash-mode.ts` (create) | Modes, timeout minutes <-> seconds, body fragments, "Shell approvals" text. |
| `apps/web/lib/fleet-approvals.ts` (modify) | `bashPayload`, `canDecide` (bash), `bashChoices`, `toBashBody`, `secondsLeft`, `countdownText`, `deliveryView`, `commandPreview`, `firstPending`, bash summary. |
| `apps/web/composables/useApprovalCountdown.ts` (create) | 1-second clock. |
| `apps/web/composables/useFleetApprovals.ts` (modify) | `listForJob(jobId)`. |
| `apps/web/components/fleet/ApprovalBashPanel.vue` (create) | Pending bash ask: text, facts, countdown, choices, comment. |
| `apps/web/components/fleet/ApprovalOutcome.vue` (modify) | Bash command and delivery line. |
| `apps/web/components/fleet/ApprovalInbox.vue` (modify) | Bash panel, row countdown, clock, delivery refetch. |
| `apps/web/components/fleet/JobApprovals.vue` (create) | Job page approvals section. |
| `apps/web/pages/[project]/fleet/approvals.vue` (modify) | `canWork` in the viewer. |
| `apps/web/pages/[project]/fleet/jobs/[id].vue` (modify) | Callout, shell approvals line, approvals section, live. |
| `apps/web/lib/fleet-jobs.ts`, `components/fleet/FleetJobTimeline.vue` (modify) | `approval_request` timeline row. |
| `apps/web/pages/[project]/fleet/index.vue` (modify) | Needs-approval marker, live reload. |
| `apps/web/lib/fleet-dispatch.ts`, `pages/[project]/fleet/dispatch.vue` (modify) | Bash fields. |
| `apps/web/lib/fleet-schedules.ts`, `components/fleet/ScheduleEditDialog.vue`, `pages/[project]/fleet/schedules/[id].vue` (modify) | Bash fields and line. |
| `apps/web/i18n/locales/en.json`, `zh.json` (modify) | `fleet.bash.*`, bash keys under `fleet.approvals.*`, `fleet.jobs.*`, `fleet.schedules.detail.bash`. |
| `apps/web/tests/helpers/mount-sfc.ts` (modify) | Register `FleetApprovalBashPanel`, `FleetJobApprovals`. |
| `apps/cli/src/commands/fleet-shared.ts`, `fleet-dispatch.ts`, `fleet-schedule.ts`, `fleet-job.ts` (modify) | Flags, parsers, show rows. |
| `apps/runner/src/approvals/approval-relay.ts` (modify), `test/integration/approval-relay.integration.spec.ts` (modify) | D302, D303. |
| `apps/web/tests/e2e/fixtures/scripted-runner.ts`, `fleet-approvals-api.ts`, `fleet-budgets-api.ts` (modify); `tests/e2e/fleet-bash-approvals.e2e.spec.ts` (create) | E2E. |
| `docs/deployment/runner.md`, the S1.5 spec §8 (modify) | Operator notes, 2b plan notes. |

---

### Task 1: Bash mode library and wire types

**Files:**
- Create: `apps/web/lib/fleet-bash-mode.ts`
- Modify: `apps/web/lib/fleet-types.ts`
- Modify: `apps/web/i18n/locales/en.json`, `apps/web/i18n/locales/zh.json`, `apps/web/tests/i18n/fleet-locale-parity.spec.ts`
- Test: `apps/web/tests/lib/fleet-bash-mode.spec.ts`

**Interfaces:**
- Produces: `BashMode` (fleet-types); `BASH_MODES`, `DEFAULT_APPROVAL_TIMEOUT_SEC`, `MIN_APPROVAL_TIMEOUT_SEC`,
  `MAX_APPROVAL_TIMEOUT_SEC`, `parseTimeoutMinutes(input: string): number | null`, `minutesText(sec: number): string`,
  `usesRelay(mode: BashMode): boolean`, `isBashTimeoutValid(mode: BashMode, minutes: string): boolean`,
  `bashCreateFields(mode, minutes): { bashMode?: BashMode; approvalTimeoutSec?: number }`,
  `bashPatchFields(mode, minutes): { bashMode: BashMode; approvalTimeoutSec?: number }`,
  `bashSummary(t: TranslateNamed, mode: BashMode, sec: number): string`. i18n `fleet.bash.*`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/tests/lib/fleet-bash-mode.spec.ts`:

```ts
import { describe, expect, test } from '@jest/globals'
import {
  BASH_MODES, bashCreateFields, bashPatchFields, bashSummary, DEFAULT_APPROVAL_TIMEOUT_SEC, isBashTimeoutValid,
  minutesText, parseTimeoutMinutes, usesRelay,
} from '../../lib/fleet-bash-mode'
import { enI18n } from '../helpers/fleet-harness'

describe('fleet bash mode (D298)', () => {
  test('modes are the API enum, raw first', () => {
    expect([...BASH_MODES]).toEqual(['raw', 'gated', 'escalate'])
    expect(usesRelay('raw')).toBe(false)
    expect(usesRelay('gated')).toBe(true)
    expect(usesRelay('escalate')).toBe(true)
  })

  test('minutes parse to whole seconds in 30..3600', () => {
    expect(parseTimeoutMinutes('10')).toBe(600)
    expect(parseTimeoutMinutes(' 0.5 ')).toBe(30)
    expect(parseTimeoutMinutes('60')).toBe(3600)
    expect(parseTimeoutMinutes('1.25')).toBe(75)
  })

  test.each(['', '0', '0.4', '60.01', '61', '1.234', '-1', '1e1', 'ten', '1,5', '.5'])('%p is refused', (input) => {
    expect(parseTimeoutMinutes(input)).toBeNull()
  })

  test('every whole second in range survives the minutes round trip (Review Focus 5)', () => {
    for (let sec = 30; sec <= 3600; sec += 1) expect(parseTimeoutMinutes(minutesText(sec))).toBe(sec)
  })

  test('the default reads as 10 minutes; 90 s reads as 1.5', () => {
    expect(minutesText(DEFAULT_APPROVAL_TIMEOUT_SEC)).toBe('10')
    expect(minutesText(90)).toBe('1.5')
  })

  test('only a relay mode needs a valid timeout', () => {
    expect(isBashTimeoutValid('raw', '')).toBe(true)
    expect(isBashTimeoutValid('escalate', '')).toBe(false)
    expect(isBashTimeoutValid('gated', '5')).toBe(true)
  })

  test('create fields: raw sends nothing, a relay mode sends both (D299, D300)', () => {
    expect(bashCreateFields('raw', 'garbage')).toEqual({})
    expect(bashCreateFields('escalate', '2')).toEqual({ bashMode: 'escalate', approvalTimeoutSec: 120 })
  })

  test('patch fields: the mode always travels, the timeout only for a relay mode (D300)', () => {
    expect(bashPatchFields('raw', '')).toEqual({ bashMode: 'raw' })
    expect(bashPatchFields('gated', '1.5')).toEqual({ bashMode: 'gated', approvalTimeoutSec: 90 })
  })

  test('a relay mode with an unvalidated timeout throws instead of sending a guess', () => {
    expect(() => bashCreateFields('gated', 'x')).toThrow('not validated')
  })

  test('the shell approvals line', () => {
    const { t } = enI18n()
    expect(bashSummary(t, 'raw', 600)).toBe('Off')
    expect(bashSummary(t, 'escalate', 90)).toBe('Escalate, asks wait 1.5 min')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && bun run test -- tests/lib/fleet-bash-mode.spec.ts`
Expected: FAIL with "Cannot find module '../../lib/fleet-bash-mode'".

- [ ] **Step 3: Write the types**

In `apps/web/lib/fleet-types.ts`:

1. Above `export interface FleetJobDto`, add:

```ts
/** S1.5 §1.6: gated/escalate relay nax's bash asks to the approvals inbox; RUN jobs only. */
export type BashMode = 'raw' | 'gated' | 'escalate'
```

2. In `FleetJobDto`, replace `bashMode: 'raw' | 'gated' | 'escalate'` with `bashMode: BashMode`.

3. In `FleetJobEventDto`, replace the `type` line with:

```ts
  /** `approval_request`: a bash ask the runner relayed (S1.5 2a); its payload carries the masked command. */
  type: 'state' | 'snapshot' | 'lifecycle' | 'log' | 'approval_request'
```

4. Replace the `DispatchBody` comment and add two fields at its end:

```ts
/** POST /projects/:slug/fleet/jobs body; a raw job sends neither bash field (server default raw / 600 s). */
export interface DispatchBody {
  repoId: string
  command: 'RUN' | 'PLAN'
  feature: string
  maxCostUsd: number
  ref?: string
  planFrom?: string
  profiles?: string[]
  selectorLabels?: string[]
  pinnedRunnerId?: string
  bashMode?: BashMode
  approvalTimeoutSec?: number
}
```

5. In `ScheduleDto`, after `pinnedRunnerId: string | null`, add:

```ts
  /** S1.5 2a: copied into every job the schedule dispatches. */
  bashMode: BashMode
  approvalTimeoutSec: number
```

6. In `NewScheduleBody`, after `noProgressLimit: number`, add `bashMode?: BashMode` and `approvalTimeoutSec?: number`.

7. In `SchedulePatchBody`, after `noProgressLimit: number`, add:

```ts
  bashMode: BashMode
  /** Omitted for raw: the stored value is kept (D300). */
  approvalTimeoutSec?: number
```

- [ ] **Step 4: Write the library**

Create `apps/web/lib/fleet-bash-mode.ts`:

```ts
import type { TranslateNamed } from '~/lib/fleet-budgets'
import type { BashMode } from '~/lib/fleet-types'

/** apps/api dispatch-fleet-job.dto and create-schedule.dto (S1.5 §1.6). */
export const BASH_MODES = ['raw', 'gated', 'escalate'] as const
export const DEFAULT_APPROVAL_TIMEOUT_SEC = 600
export const MIN_APPROVAL_TIMEOUT_SEC = 30
export const MAX_APPROVAL_TIMEOUT_SEC = 3600

/** Plain decimal minutes, at most 2 decimals: no sign, exponent or comma. */
const MINUTES_RE = /^\d{1,2}(?:\.\d{1,2})?$/

export const usesRelay = (mode: BashMode): boolean => mode !== 'raw'

/** D298: typed minutes -> whole seconds in 30..3600, else null. */
export function parseTimeoutMinutes(input: string): number | null {
  const trimmed = input.trim()
  if (!MINUTES_RE.test(trimmed)) return null
  const sec = Math.round(Number(trimmed) * 60)
  return sec >= MIN_APPROVAL_TIMEOUT_SEC && sec <= MAX_APPROVAL_TIMEOUT_SEC ? sec : null
}

/** D298: stored seconds -> the minutes the form shows. Two decimals are within 0.3 s, so it round-trips exactly. */
export const minutesText = (sec: number): string => String(Math.round((sec / 60) * 100) / 100)

/** A raw job has no ask timeout to check. */
export const isBashTimeoutValid = (mode: BashMode, minutes: string): boolean =>
  !usesRelay(mode) || parseTimeoutMinutes(minutes) !== null

function seconds(minutes: string): number {
  const sec = parseTimeoutMinutes(minutes)
  if (sec === null) throw new Error('fleet-bash-mode: timeout was not validated')
  return sec
}

/** Dispatch and schedule create (D299, D300): a raw job sends neither field, so today's bodies are unchanged. */
export function bashCreateFields(mode: BashMode, minutes: string): { bashMode?: BashMode; approvalTimeoutSec?: number } {
  return usesRelay(mode) ? { bashMode: mode, approvalTimeoutSec: seconds(minutes) } : {}
}

/** Schedule PATCH (D300): the mode always travels; a raw patch omits the timeout so the stored one is kept (3a D203). */
export function bashPatchFields(mode: BashMode, minutes: string): { bashMode: BashMode; approvalTimeoutSec?: number } {
  return usesRelay(mode) ? { bashMode: mode, approvalTimeoutSec: seconds(minutes) } : { bashMode: 'raw' }
}

/** The "Shell approvals" line on the job and schedule pages (D297, D300). */
export function bashSummary(t: TranslateNamed, mode: BashMode, sec: number): string {
  if (!usesRelay(mode)) return t('fleet.bash.mode.raw')
  return t('fleet.bash.summary', { mode: t(`fleet.bash.mode.${mode}`), minutes: minutesText(sec) })
}
```

- [ ] **Step 5: Add the i18n keys**

In `apps/web/i18n/locales/en.json`, inside `fleet`, add a sibling of `approvals`:

```json
"bash": {
  "mode": {
    "raw": "Off",
    "gated": "Gated",
    "escalate": "Escalate"
  },
  "modeLabel": "Shell command approvals",
  "modeHint": "Gated asks only on the repo's ask rules; escalate also asks for any command outside the stage's grants. Both need Bash(...) allow rules in the repo's nax config and a runner with the approval relay.",
  "timeout": "Ask timeout (minutes)",
  "timeoutHint": "An unanswered ask is denied after this long (0.5 to 60 minutes).",
  "scheduleWarning": "A scheduled run may raise asks when nobody is watching. They are denied when the timeout passes.",
  "summary": "{mode}, asks wait {minutes} min",
  "validation": {
    "timeout": "Enter 0.5 to 60 minutes, with at most 2 decimals."
  }
}
```

In `zh.json`, the same keys:

```json
"bash": {
  "mode": {
    "raw": "关闭",
    "gated": "受控",
    "escalate": "升级审批"
  },
  "modeLabel": "Shell 命令审批",
  "modeHint": "受控模式只在仓库的 ask 规则命中时询问；升级审批模式对阶段授权之外的任何命令也会询问。两者都需要仓库 nax 配置中的 Bash(...) 允许规则，以及带审批中继的 runner。",
  "timeout": "询问超时（分钟）",
  "timeoutHint": "未答复的询问在此时间后被拒绝（0.5 到 60 分钟）。",
  "scheduleWarning": "定时运行可能在无人值守时发起询问，超时后会被拒绝。",
  "summary": "{mode}，询问等待 {minutes} 分钟",
  "validation": {
    "timeout": "请输入 0.5 到 60 分钟，最多两位小数。"
  }
}
```

In `apps/web/tests/i18n/fleet-locale-parity.spec.ts`, add to `ENUMS`:

```ts
  'fleet.bash.mode': ['raw', 'gated', 'escalate'],
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd apps/web && bun run test -- tests/lib/fleet-bash-mode.spec.ts tests/i18n/fleet-locale-parity.spec.ts`
Expected: PASS.

Run: `cd apps/web && bun run type-check`
Expected: clean. (The web tsconfig excludes specs, so test fixtures that lack the new `ScheduleDto` fields are fixed
in Task 8, where their expectations change; no source file builds a `ScheduleDto` literal.)

- [ ] **Step 7: Commit**

```bash
git add apps/web/lib/fleet-bash-mode.ts apps/web/lib/fleet-types.ts apps/web/i18n/locales/en.json apps/web/i18n/locales/zh.json apps/web/tests/lib/fleet-bash-mode.spec.ts apps/web/tests/i18n/fleet-locale-parity.spec.ts
git commit -m "feat(web): bash mode library and wire types (S1.5 2b, D298)"
```

---

### Task 2: Bash approval helpers

**Files:**
- Modify: `apps/web/lib/fleet-approvals.ts`
- Modify: `apps/web/i18n/locales/en.json`, `zh.json`, `apps/web/tests/i18n/fleet-locale-parity.spec.ts`
- Test: `apps/web/tests/lib/fleet-approvals.spec.ts`

**Interfaces:**
- Consumes: `FleetApprovalDto`, `DecideApprovalBody` (fleet-types).
- Produces (all exported from `lib/fleet-approvals.ts`):
  - `APPROVAL_OPTIONS = ['allow', 'allow-remember', 'deny'] as const`, `type ApprovalOption`
  - `interface BashApprovalPayload { command: string; commandTruncated: boolean; maskedCount: number; root: string;
    stage: string; storyId: string | null; featureName: string; reason: string; options: ApprovalOption[];
    rawDetail: string | null }`
  - `bashPayload(a: Pick<FleetApprovalDto, 'type' | 'payload'>): BashApprovalPayload | null`
  - `ApprovalViewer = { kind: 'admin' } | { kind: 'project'; canManage: boolean; canWork: boolean }`
  - `canDecide(a: Pick<FleetApprovalDto, 'type' | 'status'>, viewer: ApprovalViewer): boolean`
  - `type BashDecision = 'allow' | 'allow_for_job' | 'deny'`, `bashChoices(p: BashApprovalPayload | null): BashDecision[]`
  - `toBashBody(decision: BashDecision, comment: string): DecideApprovalBody`
  - `secondsLeft(expiresAt: string | null, now: Date): number | null`, `countdownText(sec: number): string`
  - `type DeliveryView = { state: 'delivered' } | { state: 'failed'; detail: string | null } | { state: 'waiting' }`,
    `deliveryView(a: Pick<FleetApprovalDto, 'type' | 'resolvedBy' | 'outcome'>): DeliveryView | null`
  - `commandPreview(p: BashApprovalPayload): string`
  - `firstPending(rows: readonly FleetApprovalDto[]): FleetApprovalDto | null`
  - `approvalSummary` now renders bash asks as `Run {command} ({stage})`.

- [ ] **Step 1: Write the failing tests**

In `apps/web/tests/lib/fleet-approvals.spec.ts`:

1. Extend the import list with `bashChoices, bashPayload, commandPreview, countdownText, deliveryView, firstPending,
   secondsLeft, toBashBody`.

2. Replace the two viewer constants inside `describe('canDecide (D244, Review Focus 5)'` with:

```ts
  const manager = { kind: 'project', canManage: true, canWork: true } as const
  const member = { kind: 'project', canManage: false, canWork: false } as const
  const developer = { kind: 'project', canManage: false, canWork: true } as const
```

and replace the line `expect(canDecide(approval('a', { type: 'nax_bash_escalate' }), admin)).toBe(false)` with:

```ts
    // D290: bash asks are decided by DEVELOPER+, budget overrides still by ADMIN only.
    const bash = approval('a', { type: 'nax_bash_escalate', policyId: null })
    expect(canDecide(bash, admin)).toBe(true)
    expect(canDecide(bash, developer)).toBe(true)
    expect(canDecide(bash, member)).toBe(false)
    expect(canDecide(approval('a'), developer)).toBe(false)
    expect(canDecide({ ...bash, status: 'expired' }, admin)).toBe(false)
```

3. Replace the test `'a bash ask and a malformed budget fall back to fixed text'` with:

```ts
  test('a bash ask names its command and stage; malformed payloads fall back to fixed text (D296)', () => {
    expect(approvalSummary(t, approval('a', { type: 'nax_bash_escalate', payload: bashFields() }), () => null))
      .toBe('Run git push --force origin HEAD (execution)')
    expect(approvalSummary(t, approval('a', { type: 'nax_bash_escalate', payload: {} }), () => null)).toBe('A job asks to run a shell command')
    expect(approvalSummary(t, approval('a', { payload: {} }), () => null)).toBe('Budget override')
  })
```

4. Add, at file end:

```ts
const bashFields = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  command: 'git push --force origin HEAD', commandTruncated: false, maskedCount: 1, root: '/work/app', stage: 'execution',
  storyId: 'US-001', featureName: 'login', reason: 'not covered by the stage grants', options: ['allow', 'allow-remember', 'deny'],
  ...over,
})
const bashRow = (over: Partial<FleetApprovalDto> = {}, payload: Record<string, unknown> = {}): FleetApprovalDto =>
  approval('b1', { type: 'nax_bash_escalate', policyId: null, jobId: 'j1', payload: bashFields(payload), expiresAt: '2026-10-03T10:10:00.000Z', ...over })

describe('bashPayload (D289, Review Focus 1)', () => {
  test('a well-formed ask is read in full; rawDetail is null when absent', () => {
    expect(bashPayload(bashRow())).toEqual({ ...bashFields(), rawDetail: null })
  })
  test('an unparsed ask carries its raw text', () => {
    expect(bashPayload(bashRow({}, { command: '', rawDetail: 'request: rm -rf build' }))?.rawDetail).toBe('request: rm -rf build')
  })
  test.each([
    ['a missing command', { command: undefined }],
    ['an empty command without raw text', { command: '' }],
    ['a non-boolean truncation flag', { commandTruncated: 'no' }],
    ['a negative masked count', { maskedCount: -1 }],
    ['a fractional masked count', { maskedCount: 1.5 }],
    ['an unknown option', { options: ['allow', 'yolo'] }],
    ['options that are not a list', { options: 'allow' }],
    ['a numeric story id', { storyId: 7 }],
    ['a numeric raw detail', { rawDetail: 3 }],
  ])('%s is malformed', (_name, over) => {
    expect(bashPayload(bashRow({}, over))).toBeNull()
  })
  test('a budget approval is not a bash ask', () => {
    expect(bashPayload(approval('a'))).toBeNull()
  })
})

describe('bashChoices (D291, Review Focus 1)', () => {
  const p = (over: Record<string, unknown> = {}) => bashPayload(bashRow({}, over))
  test('every offered choice, in order', () => {
    expect(bashChoices(p())).toEqual(['allow', 'allow_for_job', 'deny'])
  })
  test('allow-remember not offered: no "for this job"', () => {
    expect(bashChoices(p({ options: ['allow', 'deny'] }))).toEqual(['allow', 'deny'])
  })
  test('a cut command can only be denied', () => {
    expect(bashChoices(p({ commandTruncated: true }))).toEqual(['deny'])
  })
  test('an unreadable payload can only be denied', () => {
    expect(bashChoices(null)).toEqual(['deny'])
  })
  test('an unparsed, uncut ask is decided like any other', () => {
    expect(bashChoices(p({ command: '', rawDetail: 'x' }))).toEqual(['allow', 'allow_for_job', 'deny'])
  })
})

describe('toBashBody (D293)', () => {
  test('decision and trimmed comment only, never budget fields', () => {
    expect(toBashBody('allow', '  ok  ')).toEqual({ decision: 'allow', comment: 'ok' })
    expect(toBashBody('deny', '   ')).toEqual({ decision: 'deny' })
  })
})

describe('countdown (D292)', () => {
  const now = new Date('2026-10-03T10:00:00.000Z')
  test('whole seconds left, rounded up, floored at 0', () => {
    expect(secondsLeft('2026-10-03T10:00:00.500Z', now)).toBe(1)
    expect(secondsLeft('2026-10-03T10:10:00.000Z', now)).toBe(600)
    expect(secondsLeft('2026-10-03T09:59:00.000Z', now)).toBe(0)
  })
  test('no expiry, or an unreadable one, has no countdown', () => {
    expect(secondsLeft(null, now)).toBeNull()
    expect(secondsLeft('soon', now)).toBeNull()
  })
  test('m:ss under an hour, h:mm:ss from an hour', () => {
    expect(countdownText(0)).toBe('0:00')
    expect(countdownText(65)).toBe('1:05')
    expect(countdownText(600)).toBe('10:00')
    expect(countdownText(3725)).toBe('1:02:05')
  })
})

describe('deliveryView (D294, Review Focus 3)', () => {
  const decided = (outcome: Record<string, unknown> | null, resolvedBy: FleetApprovalDto['resolvedBy'] = 'user') =>
    bashRow({ status: 'approved', decision: 'allow', resolvedBy, outcome })
  test('no ack yet reads as waiting', () => {
    expect(deliveryView(decided(null))).toEqual({ state: 'waiting' })
    expect(deliveryView(decided({}))).toEqual({ state: 'waiting' })
  })
  test('ok and rejected acks', () => {
    expect(deliveryView(decided({ delivery: { result: 'ok', detail: null, at: 'x' } }))).toEqual({ state: 'delivered' })
    expect(deliveryView(decided({ delivery: { result: 'rejected', detail: 'callback_failed:429', at: 'x' } })))
      .toEqual({ state: 'failed', detail: 'callback_failed:429' })
  })
  test('an unknown stored shape never claims delivery', () => {
    expect(deliveryView(decided({ delivery: { result: 'maybe' } }))).toEqual({ state: 'failed', detail: null })
    expect(deliveryView(decided({ delivery: 'ok' }))).toEqual({ state: 'failed', detail: null })
  })
  test('a timeout, a job end or a budget approval has no delivery line', () => {
    expect(deliveryView(decided(null, 'timeout'))).toBeNull()
    expect(deliveryView(approval('a', { status: 'approved', resolvedBy: 'user' }))).toBeNull()
  })
})

describe('commandPreview (D296)', () => {
  const p = (over: Record<string, unknown>) => bashPayload(bashRow({}, over))
  test('the first line, cut at 80 characters', () => {
    expect(commandPreview(p({})!)).toBe('git push --force origin HEAD')
    expect(commandPreview(p({ command: 'x'.repeat(81) })!)).toBe(`${'x'.repeat(80)}...`)
    expect(commandPreview(p({ command: 'echo a\necho b' })!)).toBe('echo a...')
  })
  test('an unparsed ask previews its raw text', () => {
    expect(commandPreview(p({ command: '', rawDetail: 'request: ls\nruns in: /w' })!)).toBe('request: ls...')
  })
})

describe('firstPending (D297)', () => {
  test('the pending ask that expires first', () => {
    const rows = [
      bashRow({ id: 'late', expiresAt: '2026-10-03T10:20:00.000Z' }),
      bashRow({ id: 'done', status: 'approved', expiresAt: '2026-10-03T10:01:00.000Z' }),
      bashRow({ id: 'soon', expiresAt: '2026-10-03T10:05:00.000Z' }),
    ]
    expect(firstPending(rows)?.id).toBe('soon')
    expect(firstPending([])).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && bun run test -- tests/lib/fleet-approvals.spec.ts`
Expected: FAIL (missing exports; `canDecide` bash expectations).

- [ ] **Step 3: Implement**

In `apps/web/lib/fleet-approvals.ts`:

1. Replace the `ApprovalViewer` line with:

```ts
/** D290: `canManage` = project ADMIN (budget overrides), `canWork` = DEVELOPER+ (bash asks), both from the members endpoint. */
export type ApprovalViewer = { kind: 'admin' } | { kind: 'project'; canManage: boolean; canWork: boolean }
```

2. Replace `canDecide` with:

```ts
/** Spec §1.7 (D244, D290): budget overrides by project ADMIN, bash asks by DEVELOPER+, everything on the admin inbox. */
export function canDecide(a: Pick<FleetApprovalDto, 'type' | 'status'>, viewer: ApprovalViewer): boolean {
  if (a.status !== 'pending') return false
  if (viewer.kind === 'admin') return true
  return a.type === 'budget_override_required' ? viewer.canManage : viewer.canWork
}
```

3. After `budgetPayload`, add:

```ts
/** The choices nax offers on a bash ask (2a `ApprovalOption`). */
export const APPROVAL_OPTIONS = ['allow', 'allow-remember', 'deny'] as const
export type ApprovalOption = (typeof APPROVAL_OPTIONS)[number]

/** Spec §1.2 bash payload; `rawDetail` is null when the runner parsed nax's text. */
export interface BashApprovalPayload {
  command: string
  commandTruncated: boolean
  maskedCount: number
  root: string
  stage: string
  storyId: string | null
  featureName: string
  reason: string
  options: ApprovalOption[]
  rawDetail: string | null
}

const isOption = (value: unknown): value is ApprovalOption => (APPROVAL_OPTIONS as readonly unknown[]).includes(value)

/** D289: the bash payload, or null for another type or a payload without the shape (only Deny is then offered). */
export function bashPayload(a: Pick<FleetApprovalDto, 'type' | 'payload'>): BashApprovalPayload | null {
  if (a.type !== 'nax_bash_escalate') return null
  const p = a.payload
  const storyId = p.storyId ?? null
  const rawDetail = p.rawDetail ?? null
  if (!isString(p.command) || typeof p.commandTruncated !== 'boolean') return null
  if (typeof p.maskedCount !== 'number' || !Number.isInteger(p.maskedCount) || p.maskedCount < 0) return null
  if (!isString(p.root) || !isString(p.stage) || !isString(p.featureName) || !isString(p.reason)) return null
  if (storyId !== null && !isString(storyId)) return null
  if (rawDetail !== null && !isString(rawDetail)) return null
  if (!Array.isArray(p.options) || !p.options.every(isOption)) return null
  if (p.command === '' && rawDetail === null) return null
  return {
    command: p.command, commandTruncated: p.commandTruncated, maskedCount: p.maskedCount, root: p.root, stage: p.stage,
    storyId, featureName: p.featureName, reason: p.reason, options: [...p.options], rawDetail,
  }
}

export type BashDecision = 'allow' | 'allow_for_job' | 'deny'

/** D291 (2a `checkBashDecision`): a cut or unreadable ask is deny-only; otherwise only what nax offered, then deny. */
export function bashChoices(p: BashApprovalPayload | null): BashDecision[] {
  if (p === null || p.commandTruncated) return ['deny']
  return [
    ...(p.options.includes('allow') ? ['allow' as const] : []),
    ...(p.options.includes('allow-remember') ? ['allow_for_job' as const] : []),
    'deny',
  ]
}
```

4. After `toKeepPausedBody`, add:

```ts
/** D293: a bash decide never carries budget fields (2a D287 answers 400). */
export const toBashBody = (decision: BashDecision, comment: string): DecideApprovalBody => ({ decision, ...commentField(comment) })

/** D292: whole seconds before nax denies the ask, 0 once passed; null without a readable expiry. */
export function secondsLeft(expiresAt: string | null, now: Date): number | null {
  if (expiresAt === null) return null
  const at = Date.parse(expiresAt)
  if (Number.isNaN(at)) return null
  return Math.max(0, Math.ceil((at - now.getTime()) / 1000))
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** D292: `m:ss`, or `h:mm:ss` from an hour (a skewed expiry can sit past the 60-minute cap). */
export function countdownText(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`
}

export type DeliveryView = { state: 'delivered' } | { state: 'failed'; detail: string | null } | { state: 'waiting' }

/**
 * D294 (2a D268): the runner's ack of the answer, for a bash ask a user decided. Null where nothing was sent (a
 * timeout or job-end close, or a budget approval). An unknown stored shape reads as failed: never a false "delivered".
 */
export function deliveryView(a: Pick<FleetApprovalDto, 'type' | 'resolvedBy' | 'outcome'>): DeliveryView | null {
  if (a.type !== 'nax_bash_escalate' || a.resolvedBy !== 'user') return null
  const raw = a.outcome?.delivery
  if (raw === undefined || raw === null) return { state: 'waiting' }
  if (typeof raw !== 'object') return { state: 'failed', detail: null }
  const { result, detail } = raw as { result?: unknown; detail?: unknown }
  if (result === 'ok') return { state: 'delivered' }
  return { state: 'failed', detail: result === 'rejected' && isString(detail) ? detail : null }
}

const PREVIEW_CHARS = 80

/** D296: the first line of the command (or of nax's raw text), cut at 80 characters; `...` marks anything left out. */
export function commandPreview(p: BashApprovalPayload): string {
  const text = p.command !== '' ? p.command : (p.rawDetail ?? '')
  const first = text.split('\n')[0] ?? ''
  if (first.length > PREVIEW_CHARS) return `${first.slice(0, PREVIEW_CHARS)}...`
  return text.includes('\n') ? `${first}...` : first
}

/** D297: the job's pending ask that nax denies first (the job-page callout opens it). */
export const firstPending = (rows: readonly FleetApprovalDto[]): FleetApprovalDto | null =>
  sortPending(rows.filter((r) => r.status === 'pending'))[0] ?? null
```

5. In `approvalSummary`, replace the final `return` with:

```ts
  const bash = bashPayload(a)
  if (bash) return t('fleet.approvals.summary.bashCommand', { command: commandPreview(bash), stage: bash.stage })
  return a.type === 'nax_bash_escalate' ? t('fleet.approvals.summary.bash') : t('fleet.approvals.type.budget_override_required')
```

- [ ] **Step 4: Add the i18n keys**

In `en.json` under `fleet.approvals.summary` add `"bashCommand": "Run {command} ({stage})"`; in `zh.json`
`"bashCommand": "运行 {command}（{stage}）"`. (The panel and outcome keys come in Tasks 3 and 4.)

- [ ] **Step 5: Run the tests**

Run: `cd apps/web && bun run test -- tests/lib/fleet-approvals.spec.ts tests/i18n`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/fleet-approvals.ts apps/web/tests/lib/fleet-approvals.spec.ts apps/web/i18n/locales/en.json apps/web/i18n/locales/zh.json
git commit -m "feat(web): bash approval payload, choices, countdown and delivery helpers (S1.5 2b, D289-D296)"
```

---

### Task 3: Countdown clock and the bash decide panel

**Files:**
- Create: `apps/web/composables/useApprovalCountdown.ts`
- Create: `apps/web/components/fleet/ApprovalBashPanel.vue`
- Modify: `apps/web/tests/helpers/mount-sfc.ts` (register the component)
- Modify: `apps/web/i18n/locales/en.json`, `zh.json`, `apps/web/tests/i18n/fleet-locale-parity.spec.ts`
- Test: `apps/web/tests/composables/useApprovalCountdown.spec.ts`, `apps/web/tests/components/fleet-approval-bash-panel.spec.ts`

**Interfaces:**
- Consumes: Task 2 `bashPayload`, `bashChoices`, `toBashBody`, `secondsLeft`, `countdownText`, `commentTooLong`.
- Produces:
  - `createCountdownClock(timers?: { set: (fn: () => void, ms: number) => unknown; clear: (handle: unknown) => void }, tickMs?: number): { now: Ref<Date>; start(): void; stop(): void }`
  - `useApprovalCountdown(): { now: Ref<Date> }` (ticks while the calling component is mounted)
  - `FleetApprovalBashPanel` props `{ approval: FleetApprovalDto; canDecide: boolean; busy: boolean; now: Date }`,
    emits `decide(body: DecideApprovalBody)`. Test ids: `fleet-approval-bash-panel`, `-bash-command`, `-bash-raw`,
    `-bash-raw-hint`, `-bash-unreadable`, `-bash-masked`, `-bash-truncated`, `-bash-countdown`, `-bash-allow`,
    `-bash-allow_for_job`, `-bash-deny`, `fleet-approval-comment`, `fleet-approval-readonly`.

- [ ] **Step 1: Write the failing clock test**

Create `apps/web/tests/composables/useApprovalCountdown.spec.ts`:

```ts
import { describe, expect, jest, test } from '@jest/globals'
import { createCountdownClock } from '../../composables/useApprovalCountdown'

describe('createCountdownClock (D292)', () => {
  test('ticks once a second after start and stops cleanly', () => {
    jest.useFakeTimers({ now: new Date('2026-10-03T10:00:00.000Z') })
    const clock = createCountdownClock()
    clock.start()
    jest.advanceTimersByTime(3000)
    expect(clock.now.value.toISOString()).toBe('2026-10-03T10:00:03.000Z')
    clock.stop()
    jest.advanceTimersByTime(5000)
    expect(clock.now.value.toISOString()).toBe('2026-10-03T10:00:03.000Z')
    jest.useRealTimers()
  })

  test('start twice keeps one timer; stop before start is harmless', () => {
    const set = jest.fn(() => 1)
    const clear = jest.fn()
    const clock = createCountdownClock({ set, clear })
    clock.stop()
    clock.start()
    clock.start()
    clock.stop()
    expect(set).toHaveBeenCalledTimes(1)
    expect(clear).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/web && bun run test -- tests/composables/useApprovalCountdown.spec.ts`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement the clock**

Create `apps/web/composables/useApprovalCountdown.ts`:

```ts
import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { Ref } from 'vue'

interface Timers {
  set: (fn: () => void, ms: number) => unknown
  clear: (handle: unknown) => void
}

const systemTimers: Timers = {
  set: (fn, ms) => setInterval(fn, ms),
  clear: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
}

/** D292: a `now` that moves once a second while started. */
export function createCountdownClock(timers: Timers = systemTimers, tickMs = 1000): { now: Ref<Date>; start(): void; stop(): void } {
  const now = ref(new Date())
  let handle: unknown = null
  return {
    now,
    start() {
      if (handle !== null) return
      handle = timers.set(() => { now.value = new Date() }, tickMs)
    },
    stop() {
      if (handle === null) return
      timers.clear(handle)
      handle = null
    },
  }
}

/** D292: approval countdowns; client-only (the timer starts on mount). */
export function useApprovalCountdown(): { now: Ref<Date> } {
  const clock = createCountdownClock()
  onMounted(() => clock.start())
  onBeforeUnmount(() => clock.stop())
  return { now: clock.now }
}
```

- [ ] **Step 4: Run the clock test**

Run: `cd apps/web && bun run test -- tests/composables/useApprovalCountdown.spec.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing panel test**

In `apps/web/tests/helpers/mount-sfc.ts`, register the component in both places: append
`| 'FleetApprovalBashPanel'` to the `FleetComponentName` union, and add to `FLEET_COMPONENT_FILES` (after
`FleetApprovalInbox: 'ApprovalInbox.vue',`):

```ts
  FleetApprovalBashPanel: 'ApprovalBashPanel.vue',
```

Create `apps/web/tests/components/fleet-approval-bash-panel.spec.ts`:

```ts
import { describe, expect, test } from '@jest/globals'
import { ref, computed } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'
import type { DecideApprovalBody, FleetApprovalDto } from '../../lib/fleet-types'

const panel = webFile('components', 'fleet', 'ApprovalBashPanel.vue')
const NOW = new Date('2026-10-03T10:00:00.000Z')

const payload = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  command: 'git push --force origin HEAD', commandTruncated: false, maskedCount: 2, root: '/work/app', stage: 'execution',
  storyId: 'US-001', featureName: 'login', reason: 'not covered by the stage grants', options: ['allow', 'allow-remember', 'deny'],
  ...over,
})
const ask = (over: Partial<FleetApprovalDto> = {}, p: Record<string, unknown> = {}): FleetApprovalDto => ({
  id: 'b1', type: 'nax_bash_escalate', status: 'pending', projectId: 'p1', jobId: 'j1', policyId: null, payload: payload(p),
  outcome: null, requestedAt: '2026-10-03T09:55:00.000Z', expiresAt: '2026-10-03T10:05:00.000Z', decision: null,
  decidedById: null, decidedAt: null, resolvedBy: null, comment: null, ...over,
})

function mount(approval: FleetApprovalDto, props: Record<string, unknown> = {}) {
  const decided: DecideApprovalBody[] = []
  const app = mountSfc(panel, {
    components: uiStubs,
    props: { approval, canDecide: true, busy: false, now: NOW, onDecide: (b: DecideApprovalBody) => decided.push(b), ...props },
    globals: { ref, computed, useI18n: () => enI18n() },
  })
  const byId = (id: string) => app.find(`[data-testid="${id}"]`)
  const click = (id: string) => (byId(id)[0].props.onClick as () => void)()
  return { app, decided, byId, click }
}

describe('FleetApprovalBashPanel', () => {
  test('shows the masked command, the masked count and the facts', () => {
    const m = mount(ask())
    expect(m.app.textOf(m.byId('fleet-approval-bash-command')[0])).toBe('git push --force origin HEAD')
    expect(m.app.textOf(m.byId('fleet-approval-bash-masked')[0])).toContain('2 secret values masked')
    const text = m.app.text()
    for (const fact of ['/work/app', 'execution', 'US-001', 'login', 'not covered by the stage grants']) expect(text).toContain(fact)
    m.app.unmount()
  })

  test('every offered choice, and the decide body carries only the decision and the comment (D293)', () => {
    const m = mount(ask())
    expect(m.byId('fleet-approval-bash-allow')).toHaveLength(1)
    expect(m.byId('fleet-approval-bash-allow_for_job')).toHaveLength(1)
    expect(m.byId('fleet-approval-bash-deny')).toHaveLength(1)
    m.click('fleet-approval-bash-allow_for_job')
    expect(m.decided).toEqual([{ decision: 'allow_for_job' }])
    m.app.unmount()
  })

  test('allow-remember not offered hides "Allow for this job" (Review Focus 1)', () => {
    const m = mount(ask({}, { options: ['allow', 'deny'] }))
    expect(m.byId('fleet-approval-bash-allow_for_job')).toHaveLength(0)
    m.app.unmount()
  })

  test('a cut command shows the notice and only Deny (Review Focus 1)', () => {
    const m = mount(ask({}, { commandTruncated: true }))
    expect(m.byId('fleet-approval-bash-truncated')).toHaveLength(1)
    expect(m.byId('fleet-approval-bash-allow')).toHaveLength(0)
    expect(m.byId('fleet-approval-bash-deny')).toHaveLength(1)
    m.app.unmount()
  })

  test('an unparsed ask shows the raw text and the hint', () => {
    const m = mount(ask({}, { command: '', rawDetail: 'request: rm -rf build' }))
    expect(m.byId('fleet-approval-bash-command')).toHaveLength(0)
    expect(m.app.textOf(m.byId('fleet-approval-bash-raw')[0])).toBe('request: rm -rf build')
    expect(m.byId('fleet-approval-bash-raw-hint')).toHaveLength(1)
    m.app.unmount()
  })

  test('an unreadable payload says so and offers only Deny (D289)', () => {
    const m = mount(ask({ payload: { command: 42 } }))
    expect(m.byId('fleet-approval-bash-unreadable')).toHaveLength(1)
    expect(m.byId('fleet-approval-bash-allow')).toHaveLength(0)
    expect(m.byId('fleet-approval-bash-deny')).toHaveLength(1)
    m.app.unmount()
  })

  test('the countdown; at 0 the buttons are gone and the panel says nax denied it (Review Focus 2)', () => {
    const running = mount(ask())
    expect(running.app.textOf(running.byId('fleet-approval-bash-countdown')[0])).toContain('5:00')
    running.app.unmount()
    const over = mount(ask({ expiresAt: '2026-10-03T09:59:59.000Z' }))
    expect(over.app.textOf(over.byId('fleet-approval-bash-countdown')[0])).toContain('timed out')
    expect(over.byId('fleet-approval-bash-deny')).toHaveLength(0)
    expect(over.byId('fleet-approval-readonly')).toHaveLength(0)
    over.app.unmount()
  })

  test('a reader without the right sees the read-only line, never buttons (Review Focus 4)', () => {
    const m = mount(ask(), { canDecide: false })
    expect(m.byId('fleet-approval-readonly')).toHaveLength(1)
    expect(m.byId('fleet-approval-bash-deny')).toHaveLength(0)
    m.app.unmount()
  })

  test('a comment over 1000 characters blocks the decide', () => {
    const m = mount(ask())
    const textarea = m.byId('fleet-approval-comment')[0]
    ;(textarea.props['onUpdate:modelValue'] as (v: string) => void)('x'.repeat(1001))
    m.click('fleet-approval-bash-deny')
    expect(m.decided).toEqual([])
    m.app.unmount()
  })

  test('busy disables the buttons', () => {
    const m = mount(ask(), { busy: true })
    expect(m.byId('fleet-approval-bash-deny')[0].props.disabled).toBe(true)
    m.app.unmount()
  })
})
```

(The `Textarea` stub forwards `v-model` as `modelValue` / `onUpdate:modelValue`, exactly as
`fleet-approval-budget-panel.spec.ts` drives it.)

- [ ] **Step 6: Run it to verify it fails**

Run: `cd apps/web && bun run test -- tests/components/fleet-approval-bash-panel.spec.ts`
Expected: FAIL (component file missing).

- [ ] **Step 7: Implement the panel**

Create `apps/web/components/fleet/ApprovalBashPanel.vue`:

```vue
<template>
  <div class="space-y-3 text-sm" data-testid="fleet-approval-bash-panel">
    <p v-if="payload === null" class="text-destructive" data-testid="fleet-approval-bash-unreadable">{{ t('fleet.approvals.bash.unreadable') }}</p>
    <template v-else>
      <div v-if="payload.command !== ''" class="space-y-1">
        <p class="font-medium">{{ t('fleet.approvals.bash.command') }}</p>
        <pre class="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 font-mono text-xs" data-testid="fleet-approval-bash-command">{{ payload.command }}</pre>
      </div>
      <div v-else class="space-y-1">
        <p class="font-medium">{{ t('fleet.approvals.bash.rawDetail') }}</p>
        <p class="text-muted-foreground" data-testid="fleet-approval-bash-raw-hint">{{ t('fleet.approvals.bash.rawHint') }}</p>
        <pre class="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 font-mono text-xs" data-testid="fleet-approval-bash-raw">{{ payload.rawDetail }}</pre>
      </div>
      <p v-if="payload.maskedCount > 0" class="text-muted-foreground" data-testid="fleet-approval-bash-masked">
        {{ t('fleet.approvals.bash.masked', { count: payload.maskedCount }) }}
      </p>
      <p v-if="payload.commandTruncated" class="text-destructive" data-testid="fleet-approval-bash-truncated">{{ t('fleet.approvals.bash.truncated') }}</p>
      <dl class="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
        <div><dt class="text-muted-foreground">{{ t('fleet.approvals.bash.root') }}</dt><dd class="break-all font-mono text-xs">{{ payload.root }}</dd></div>
        <div><dt class="text-muted-foreground">{{ t('fleet.approvals.bash.stage') }}</dt><dd>{{ payload.stage }}</dd></div>
        <div><dt class="text-muted-foreground">{{ t('fleet.approvals.bash.story') }}</dt><dd>{{ payload.storyId ?? '-' }}</dd></div>
        <div><dt class="text-muted-foreground">{{ t('fleet.approvals.bash.feature') }}</dt><dd class="break-all">{{ payload.featureName }}</dd></div>
        <div class="sm:col-span-2"><dt class="text-muted-foreground">{{ t('fleet.approvals.bash.reason') }}</dt><dd class="whitespace-pre-wrap break-all">{{ payload.reason }}</dd></div>
      </dl>
    </template>

    <p v-if="left !== null" :class="left === 0 ? 'text-destructive' : 'text-muted-foreground'" data-testid="fleet-approval-bash-countdown">
      {{ left === 0 ? t('fleet.approvals.bash.timedOut') : t('fleet.approvals.bash.expiresIn', { time: countdownText(left) }) }}
    </p>

    <template v-if="canDecide && left !== 0">
      <div class="space-y-1">
        <Label for="fleet-approval-bash-comment">{{ t('fleet.approvals.budget.comment') }}</Label>
        <Textarea id="fleet-approval-bash-comment" v-model="comment" rows="2" data-testid="fleet-approval-comment" />
        <p v-if="commentInvalid" class="text-xs text-destructive" data-testid="fleet-approval-comment-error">{{ t('fleet.approvals.validation.commentTooLong') }}</p>
      </div>
      <div class="flex flex-wrap gap-2">
        <Button
          v-for="choice in choices"
          :key="choice"
          :variant="choice === 'allow' ? 'default' : 'outline'"
          :disabled="busy"
          :data-testid="`fleet-approval-bash-${choice}`"
          @click="decide(choice)"
        >
          {{ t(`fleet.approvals.bash.action.${choice}`) }}
        </Button>
      </div>
    </template>
    <p v-else-if="!canDecide" class="text-muted-foreground" data-testid="fleet-approval-readonly">{{ t('fleet.approvals.readOnlyBash') }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { bashChoices, bashPayload, commentTooLong, countdownText, secondsLeft, toBashBody } from '~/lib/fleet-approvals'
import type { BashDecision } from '~/lib/fleet-approvals'
import type { DecideApprovalBody, FleetApprovalDto } from '~/lib/fleet-types'

// Mounted per `${id}:${status}:${fetch}` by FleetApprovalInbox (D242, D250): the comment below is initialised once.
const props = defineProps<{
  approval: FleetApprovalDto
  canDecide: boolean
  busy: boolean
  /** The inbox's 1-second clock (D292). */
  now: Date
}>()

const emit = defineEmits<{ (e: 'decide', body: DecideApprovalBody): void }>()

const { t } = useI18n()

const payload = computed(() => bashPayload(props.approval))
const choices = computed(() => bashChoices(payload.value))
const left = computed(() => secondsLeft(props.approval.expiresAt, props.now))
const comment = ref('')
const commentInvalid = computed(() => commentTooLong(comment.value))

function decide(choice: BashDecision): void {
  if (commentInvalid.value) return
  emit('decide', toBashBody(choice, comment.value))
}
</script>
```

- [ ] **Step 8: Add the i18n keys**

`en.json`, under `fleet.approvals`, add (and add `"readOnlyBash"` next to `"readOnly"`):

```json
"readOnlyBash": "You can read this ask. Only a project developer or admin can answer it.",
"bash": {
  "command": "Command (secrets masked by nax)",
  "rawDetail": "What nax sent",
  "rawHint": "The runner could not split nax's text into a command. You are deciding on the full text below.",
  "unreadable": "This ask could not be read. It can only be denied.",
  "masked": "{count} secret values masked",
  "truncated": "The command is too long to show in full. It can only be denied.",
  "root": "Runs in",
  "stage": "Stage",
  "story": "Story",
  "feature": "Feature",
  "reason": "Why nax asks",
  "expiresIn": "nax denies it in {time} unless answered.",
  "timedOut": "This ask timed out and nax has denied the command.",
  "action": {
    "allow": "Allow once",
    "allow_for_job": "Allow for this job",
    "deny": "Deny"
  }
}
```

`zh.json`:

```json
"readOnlyBash": "你可以查看此询问。只有项目开发者或管理员可以答复。",
"bash": {
  "command": "命令（nax 已遮蔽密钥）",
  "rawDetail": "nax 发送的内容",
  "rawHint": "runner 无法从 nax 的文本中拆出命令。你将基于下面的完整文本做出决定。",
  "unreadable": "无法读取此询问，只能拒绝。",
  "masked": "已遮蔽 {count} 个密钥值",
  "truncated": "命令过长，无法完整显示，只能拒绝。",
  "root": "运行目录",
  "stage": "阶段",
  "story": "故事",
  "feature": "功能",
  "reason": "nax 询问的原因",
  "expiresIn": "若不答复，nax 将在 {time} 后拒绝。",
  "timedOut": "此询问已超时，nax 已拒绝该命令。",
  "action": {
    "allow": "允许一次",
    "allow_for_job": "本任务内允许",
    "deny": "拒绝"
  }
}
```

In `fleet-locale-parity.spec.ts` `ENUMS`, add `'fleet.approvals.bash.action': ['allow', 'allow_for_job', 'deny'],`.

- [ ] **Step 9: Run the tests**

Run: `cd apps/web && bun run test -- tests/components/fleet-approval-bash-panel.spec.ts tests/composables/useApprovalCountdown.spec.ts tests/i18n`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add apps/web/composables/useApprovalCountdown.ts apps/web/components/fleet/ApprovalBashPanel.vue apps/web/tests/helpers/mount-sfc.ts apps/web/tests/composables/useApprovalCountdown.spec.ts apps/web/tests/components/fleet-approval-bash-panel.spec.ts apps/web/i18n/locales/en.json apps/web/i18n/locales/zh.json apps/web/tests/i18n/fleet-locale-parity.spec.ts
git commit -m "feat(web): bash approval decide panel and countdown clock (S1.5 2b, D291-D293)"
```

---

### Task 4: Inbox and outcome answer bash asks

**Files:**
- Modify: `apps/web/components/fleet/ApprovalInbox.vue`, `apps/web/components/fleet/ApprovalOutcome.vue`
- Modify: `apps/web/pages/[project]/fleet/approvals.vue`
- Modify: `apps/web/i18n/locales/en.json`, `zh.json`, `apps/web/tests/i18n/fleet-locale-parity.spec.ts`
- Test: `apps/web/tests/components/fleet-approval-inbox.spec.ts`, `apps/web/tests/components/fleet-approval-outcome.spec.ts`,
  `apps/web/tests/pages/fleet-approvals-pages.spec.ts`

**Interfaces:**
- Consumes: Task 2 (`canDecide`, `deliveryView`, `bashPayload`, `secondsLeft`, `countdownText`), Task 3
  (`FleetApprovalBashPanel`, `useApprovalCountdown`).
- Produces: inbox row test id `fleet-approval-countdown` (pending rows with an expiry); outcome test ids
  `fleet-approval-outcome-command` and `fleet-approval-outcome-delivery` (attribute `data-delivery` =
  `delivered | failed | waiting`).

- [ ] **Step 1: Write the failing outcome tests**

In `apps/web/tests/components/fleet-approval-outcome.spec.ts` (its `mount(approval)` helper returns `{ app, byId }`), add:

```ts
const bashDecided = (over: Partial<FleetApprovalDto> = {}): FleetApprovalDto => ({
  id: 'b1', type: 'nax_bash_escalate', status: 'approved', projectId: 'p1', jobId: 'j1', policyId: null,
  payload: { command: 'git push --force origin HEAD', commandTruncated: false, maskedCount: 0, root: '/w', stage: 'execution',
    storyId: null, featureName: 'login', reason: 'r', options: ['allow', 'deny'] },
  outcome: null, requestedAt: '2026-10-03T10:00:00.000Z', expiresAt: '2026-10-03T10:10:00.000Z', decision: 'allow',
  decidedById: 'u1', decidedAt: '2026-10-03T10:01:00.000Z', resolvedBy: 'user', comment: null, ...over,
})

describe('FleetApprovalOutcome, bash (D294)', () => {
  test('shows the command and a waiting delivery until the runner acks', () => {
    const m = mount(bashDecided())
    expect(m.app.textOf(m.byId('fleet-approval-outcome-command')[0])).toBe('git push --force origin HEAD')
    expect(m.byId('fleet-approval-outcome-delivery')[0].props['data-delivery']).toBe('waiting')
    m.app.unmount()
  })

  test('delivered and failed acks', () => {
    const ok = mount(bashDecided({ outcome: { delivery: { result: 'ok', detail: null, at: 'x' } } }))
    expect(ok.byId('fleet-approval-outcome-delivery')[0].props['data-delivery']).toBe('delivered')
    ok.app.unmount()
    const bad = mount(bashDecided({ outcome: { delivery: { result: 'rejected', detail: 'callback_failed:429', at: 'x' } } }))
    expect(bad.byId('fleet-approval-outcome-delivery')[0].props['data-delivery']).toBe('failed')
    expect(bad.app.text()).toContain('callback_failed:429')
    bad.app.unmount()
  })

  test('an ask that timed out shows its raw text and no delivery line', () => {
    const m = mount(bashDecided({
      status: 'expired', decision: null, resolvedBy: 'timeout', decidedById: null,
      payload: { ...bashDecided().payload, command: '', rawDetail: 'request: ls' },
    }))
    expect(m.app.textOf(m.byId('fleet-approval-outcome-command')[0])).toBe('request: ls')
    expect(m.byId('fleet-approval-outcome-delivery')).toHaveLength(0)
    expect(m.app.text()).toContain('Timed out')
    m.app.unmount()
  })
})
```

- [ ] **Step 2: Write the failing inbox tests**

In `apps/web/tests/components/fleet-approval-inbox.spec.ts`:

1. In `mount(...)`, add an optional `now?: Date` to `opts`, create the clock before `mountSfc`, and change three
   options:

```ts
  const clock = Vue.ref(opts.now ?? new Date('2026-10-03T10:05:00.000Z'))
```

```ts
    fleetComponents: ['FleetApprovalBudgetPanel', 'FleetApprovalBashPanel', 'FleetApprovalOutcome', 'FleetNativeSelect', 'FleetAge'],
    alias: {
      '~/composables/useApi': apiModule,
      // D292: a fixed clock; the real one ticks with setInterval.
      '~/composables/useApprovalCountdown': { useApprovalCountdown: () => ({ now: clock }) },
    },
```

and the default viewer prop becomes `viewer: { kind: 'project', canManage: true, canWork: true },`.

2. Replace the reader test's viewer with `{ kind: 'project', canManage: false, canWork: false }`.

3. Replace the test `'a pending bash ask renders read-only with the later-release note (Review Focus 5)'` with:

```ts
  const bashPayloadFields = { command: 'rm -rf build', commandTruncated: false, maskedCount: 0, root: '/w', stage: 'execution',
    storyId: 'US-001', featureName: 'login', reason: 'outside the grants', options: ['allow', 'allow-remember', 'deny'] }
  const bashRow = (id: string, over: Partial<FleetApprovalDto> = {}) =>
    row(id, { type: 'nax_bash_escalate', policyId: null, jobId: 'j1', payload: { ...bashPayloadFields }, expiresAt: '2026-10-03T10:10:00.000Z', ...over })

  test('a pending bash ask shows its command and countdown in the row and opens the bash panel', async () => {
    const bash = bashRow('b1')
    const get = jest.fn(async (path: string) => (path.endsWith('/b1') ? bash : page([bash])))
    const m = mount({ get })
    await m.settle()
    expect(m.app.textOf(m.rowEl('b1'))).toContain('Run rm -rf build (execution)')
    expect(m.app.textOf(m.app.find('[data-testid="fleet-approval-countdown"]', m.rowEl('b1'))[0])).toBe('5:00')
    await m.toggle('b1')
    expect(m.byId('fleet-approval-bash-panel')).toHaveLength(1)
    expect(m.byId('fleet-approval-bash-allow')).toHaveLength(1)
    m.app.unmount()
  })

  test('a developer allows; the outcome waits for delivery and the next poll re-fetches it (D295, Review Focus 3)', async () => {
    const bash = bashRow('b1')
    const decided = bashRow('b1', { status: 'approved', decision: 'allow', resolvedBy: 'user', decidedById: 'u1', outcome: null })
    const delivered = { ...decided, outcome: { delivery: { result: 'ok', detail: null, at: '2026-10-03T10:05:10.000Z' } } }
    let stored: FleetApprovalDto = bash
    const get = jest.fn(async (path: string) => (path.endsWith('/b1') ? stored : page(stored.status === 'pending' ? [stored] : [])))
    const post = jest.fn(async () => { stored = decided; return decided })
    const m = mount({ get, post, props: { viewer: { kind: 'project', canManage: false, canWork: true } } })
    await m.settle()
    await m.toggle('b1')
    ;(m.byId('fleet-approval-bash-allow')[0].props.onClick as () => void)()
    await m.settle()
    expect(post).toHaveBeenCalledWith('/projects/koda/fleet/approvals/b1/decide', { decision: 'allow' })
    expect(m.toast.successes).toEqual(['Allowed. The runner passes the answer to nax.'])
    expect(m.byId('fleet-approval-outcome-delivery')[0].props['data-delivery']).toBe('waiting')
    stored = delivered
    await m.poll()
    await m.settle()
    expect(m.byId('fleet-approval-outcome-delivery')[0].props['data-delivery']).toBe('delivered')
    m.app.unmount()
  })

  test('a bash decide that races expiry gets 409: toast, and the row is re-fetched as expired (Review Focus 2)', async () => {
    const bash = bashRow('b1')
    const expired = bashRow('b1', { status: 'expired', resolvedBy: 'timeout' })
    let stored: FleetApprovalDto = bash
    const get = jest.fn(async (path: string) => (path.endsWith('/b1') ? stored : page(stored.status === 'pending' ? [stored] : [])))
    const post = jest.fn(async () => { stored = expired; throw new ApiError(409, 'This approval is no longer pending') })
    const m = mount({ get, post })
    await m.settle()
    await m.toggle('b1')
    ;(m.byId('fleet-approval-bash-deny')[0].props.onClick as () => void)()
    await m.settle()
    expect(m.toast.errors).toEqual(['This approval is no longer pending'])
    expect(m.app.textOf(m.byId('fleet-approval-outcome-decision')[0])).toContain('Expired')
    m.app.unmount()
  })

  test('a viewer reads a bash ask; a developer gets bash buttons but no budget buttons (Review Focus 4)', async () => {
    const bash = bashRow('b1')
    const budgetRow = row('a1', { requeueCandidates: [] })
    const get = jest.fn(async (path: string) => (path.endsWith('/b1') ? bash : path.endsWith('/a1') ? budgetRow : page([bash, row('a1')])))
    const viewerOnly = mount({ get, props: { viewer: { kind: 'project', canManage: false, canWork: false } } })
    await viewerOnly.settle()
    await viewerOnly.toggle('b1')
    expect(viewerOnly.byId('fleet-approval-readonly')).toHaveLength(1)
    expect(viewerOnly.byId('fleet-approval-bash-deny')).toHaveLength(0)
    viewerOnly.app.unmount()
    const developer = mount({ get, props: { viewer: { kind: 'project', canManage: false, canWork: true } } })
    await developer.settle()
    await developer.toggle('b1')
    expect(developer.byId('fleet-approval-bash-deny')).toHaveLength(1)
    await developer.toggle('a1')
    expect(developer.byId('fleet-approval-raise')).toHaveLength(0)
    expect(developer.byId('fleet-approval-readonly')).toHaveLength(1)
    developer.app.unmount()
  })
```

4. In `apps/web/tests/pages/fleet-approvals-pages.spec.ts`, change the viewer expectation to
   `expect(props.viewer).toEqual({ kind: 'project', canManage: true, canWork: true })` (the stubbed role is
   `{ canManage: true, viewerRole: 'ADMIN' }`), and add a second mount with
   `useProjectViewerRole: () => ({ data: ref({ canManage: false, viewerRole: 'DEVELOPER' }) })` that expects
   `{ kind: 'project', canManage: false, canWork: true }` (copy the first mount block of that test; only the role stub
   and the expectation change).

- [ ] **Step 3: Run them to verify they fail**

Run: `cd apps/web && bun run test -- tests/components/fleet-approval-inbox.spec.ts tests/components/fleet-approval-outcome.spec.ts tests/pages/fleet-approvals-pages.spec.ts`
Expected: FAIL (no bash panel, no delivery line, viewer without `canWork`).

- [ ] **Step 4: Implement the outcome**

In `apps/web/components/fleet/ApprovalOutcome.vue`:

1. After the first `<p data-testid="fleet-approval-outcome-decision">...</p>` block's sibling `<p class="text-muted-foreground">` (the decider line), add:

```vue
    <pre
      v-if="bashText !== null"
      class="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 font-mono text-xs"
      data-testid="fleet-approval-outcome-command"
    >{{ bashText }}</pre>
    <p v-if="delivery" :data-delivery="delivery.state" :class="delivery.state === 'failed' ? 'text-destructive' : 'text-muted-foreground'" data-testid="fleet-approval-outcome-delivery">
      {{ deliveryText }}
    </p>
```

2. In the script, extend the import to `import { bashPayload, deliveryView, requeueResults, resumedAmount } from '~/lib/fleet-approvals'` and add:

```ts
/** D294: what the human decided on: the command, or nax's raw text when it was not parsed. */
const bashText = computed(() => {
  const bash = bashPayload(props.approval)
  return bash === null ? null : (bash.command !== '' ? bash.command : (bash.rawDetail ?? ''))
})
const delivery = computed(() => deliveryView(props.approval))
const deliveryText = computed(() => {
  const d = delivery.value
  if (d === null) return ''
  return d.state === 'failed'
    ? t('fleet.approvals.delivery.failed', { detail: d.detail ?? '-' })
    : t(`fleet.approvals.delivery.${d.state}`)
})
```

- [ ] **Step 5: Implement the inbox**

In `apps/web/components/fleet/ApprovalInbox.vue`:

1. Imports: add `import { useApprovalCountdown } from '~/composables/useApprovalCountdown'` and extend the
   fleet-approvals import to `approvalSummary, canDecide, countdownText, deliveryView, INBOX_PENDING_SIZE, INBOX_TABS,
   requeueResults, secondsLeft`.

2. Replace `const now = ref(new Date())` with:

```ts
/** D292: one clock for row ages and countdowns. */
const { now } = useApprovalCountdown()
```

and delete the line `now.value = new Date()` at the top of `reload()`.

3. Replace `displayRows` with:

```ts
/** D241: the expanded approval first when it is not on the loaded page. `left` drives the row countdown (D296). */
const displayRows = computed(() => {
  const withLeft = (row: FleetApprovalDto, linked: boolean) =>
    ({ row, linked, left: row.status === 'pending' ? secondsLeft(row.expiresAt, now.value) : null })
  const rows = api.approvals.value.map((row) => withLeft(row, false))
  const open = detail.value
  if (open === null || api.approvals.value.some((r) => r.id === open.id)) return rows
  return [withLeft(open, true), ...rows]
})
```

4. Add after `statusChanged()`:

```ts
/** D295: the runner's ack has no live event, so a decided ask whose delivery is not in yet is re-fetched on reload. */
const awaitingDelivery = (): boolean => detail.value !== null && deliveryView(detail.value)?.state === 'waiting'
```

and in `reload()` change the re-fetch line to:

```ts
    if ((statusChanged() || awaitingDelivery()) && expandedId.value !== null) await loadDetail(expandedId.value)
```

5. In the row button, after the status `<Badge>`, add:

```vue
            <span
              v-if="entry.left !== null"
              class="font-mono text-xs"
              :class="entry.left === 0 ? 'text-destructive' : 'text-muted-foreground'"
              data-testid="fleet-approval-countdown"
            >{{ countdownText(entry.left) }}</span>
```

6. Replace the `<p v-else-if="detail.status === 'pending'" ... data-testid="fleet-approval-bash-later">...</p>` block with:

```vue
              <FleetApprovalBashPanel
                v-else-if="detail.type === 'nax_bash_escalate' && detail.status === 'pending'"
                :key="`${detail.id}:${detail.status}:${detailVersion}`"
                :approval="detail"
                :can-decide="canDecide(detail, viewer)"
                :busy="deciding"
                :now="now"
                @decide="onDecide"
              />
```

- [ ] **Step 6: Pass `canWork` from the project page**

In `apps/web/pages/[project]/fleet/approvals.vue`, add `import { canWorkOnFleet } from '~/lib/fleet-jobs'` and replace
the viewer line with:

```ts
// D244 / D290: canManage is project ADMIN (a global ADMIN resolves to it); canWork is DEVELOPER+.
const viewer = computed<ApprovalViewer>(() => ({ kind: 'project', canManage: role.value.canManage, canWork: canWorkOnFleet(role.value) }))
```

- [ ] **Step 7: i18n**

`en.json` under `fleet.approvals`: delete `"bashLater"`; add to `toast`:
`"allow": "Allowed. The runner passes the answer to nax.", "allow_for_job": "Allowed for this job. The runner passes the answer to nax.", "deny": "Denied. The runner passes the answer to nax."`;
add:

```json
"delivery": {
  "delivered": "Delivered to nax.",
  "failed": "Not delivered to nax ({detail}). nax denies the command when its timeout passes.",
  "waiting": "Not confirmed by the runner yet."
}
```

`zh.json`: delete `"bashLater"`; `toast`: `"allow": "已允许，runner 会将答复转交 nax。", "allow_for_job": "已在本任务内允许，runner 会将答复转交 nax。", "deny": "已拒绝，runner 会将答复转交 nax。"`;

```json
"delivery": {
  "delivered": "已送达 nax。",
  "failed": "未送达 nax（{detail}）。超时后 nax 将拒绝该命令。",
  "waiting": "runner 尚未确认。"
}
```

In `fleet-locale-parity.spec.ts`: change the `'fleet.approvals.toast'` entry to
`['raise_budget_and_resume', 'keep_paused', 'requeueFailed', 'allow', 'allow_for_job', 'deny']`, add
`'fleet.approvals.delivery': ['delivered', 'failed', 'waiting'],`, and remove `'fleet.approvals.bashLater'` from the
"keys the pages render" list.

- [ ] **Step 8: Run the tests**

Run: `cd apps/web && bun run test -- tests/components/fleet-approval-inbox.spec.ts tests/components/fleet-approval-outcome.spec.ts tests/pages/fleet-approvals-pages.spec.ts tests/i18n tests/lib/fleet-approvals.spec.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/web/components/fleet/ApprovalInbox.vue apps/web/components/fleet/ApprovalOutcome.vue "apps/web/pages/[project]/fleet/approvals.vue" apps/web/i18n/locales/en.json apps/web/i18n/locales/zh.json apps/web/tests
git commit -m "feat(web): answer bash asks in the approvals inbox, show delivery (S1.5 2b, D290, D294, D295)"
```

---

### Task 5: Job page callout, approvals section and timeline row

**Files:**
- Create: `apps/web/components/fleet/JobApprovals.vue`
- Modify: `apps/web/composables/useFleetApprovals.ts`, `apps/web/pages/[project]/fleet/jobs/[id].vue`,
  `apps/web/lib/fleet-jobs.ts`, `apps/web/components/fleet/FleetJobTimeline.vue`, `apps/web/tests/helpers/mount-sfc.ts`
- Modify: `apps/web/i18n/locales/en.json`, `zh.json`
- Test: `apps/web/tests/components/fleet-job-approvals.spec.ts`, `apps/web/tests/pages/fleet-job-detail.spec.ts`,
  `apps/web/tests/lib/fleet-jobs.spec.ts`, `apps/web/tests/composables/useFleetApprovals.spec.ts`

**Interfaces:**
- Consumes: Task 1 `bashSummary`; Task 2 `bashPayload`, `commandPreview`, `countdownText`, `secondsLeft`,
  `firstPending`, `inboxPath`; Task 3 `useApprovalCountdown`.
- Produces: `useFleetApprovals(base).listForJob(jobId: string): Promise<FleetApprovalDto[]>`; `FleetJobApprovals`
  props `{ slug: string; approvals: FleetApprovalDto[]; now: Date }`, test ids `fleet-job-approvals`,
  `fleet-job-approval-<id>` (`data-status`), `fleet-job-approval-open-<id>`, `fleet-job-approval-countdown`; job page
  test ids `fleet-job-approval-callout`, `fleet-job-approval-review`, `fleet-job-bash`; `TimelineEntry` kind
  `approval`.

- [ ] **Step 1: Write the failing tests**

1. `apps/web/tests/composables/useFleetApprovals.spec.ts`, add inside `describe('useFleetApprovals'` (it uses the
   file's `install`, `fresh`, `row` and `page` helpers):

```ts
  test('listForJob reads one job\'s approvals, one page of 100 (D297)', async () => {
    const get = jest.fn(async () => page([row('b1', { type: 'nax_bash_escalate', jobId: 'j1' })]))
    install({ get })
    const { useFleetApprovals } = await fresh()
    const api = useFleetApprovals({ kind: 'project', slug: 'koda' })
    expect((await api.listForJob('j1')).map((a) => a.id)).toEqual(['b1'])
    expect(get).toHaveBeenCalledWith('/projects/koda/fleet/approvals', { query: { jobId: 'j1', size: '100' } })
  })
```

2. `apps/web/tests/lib/fleet-jobs.spec.ts`, add:

```ts
describe('approval_request timeline rows (D297)', () => {
  test('the command\'s first line, or the raw text when the command was not parsed', () => {
    expect(summarizeEvent({ type: 'approval_request', runnerSeq: 4, payload: { command: 'git push\nmore' } }))
      .toEqual({ kind: 'approval', command: 'git push' })
    expect(summarizeEvent({ type: 'approval_request', runnerSeq: 4, payload: { command: '', rawDetail: 'request: ls' } }))
      .toEqual({ kind: 'approval', command: 'request: ls' })
    expect(summarizeEvent({ type: 'approval_request', runnerSeq: 4, payload: null })).toEqual({ kind: 'approval', command: '' })
  })
})
```

(import `summarizeEvent` if the file does not already).

3. In `apps/web/tests/helpers/mount-sfc.ts`, append `| 'FleetJobApprovals'` to `FleetComponentName` and add
   `FleetJobApprovals: 'JobApprovals.vue',` to `FLEET_COMPONENT_FILES`. Create
   `apps/web/tests/components/fleet-job-approvals.spec.ts`:

```ts
import { describe, expect, test } from '@jest/globals'
import { computed } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'
import type { FleetApprovalDto } from '../../lib/fleet-types'

const section = webFile('components', 'fleet', 'JobApprovals.vue')
const NOW = new Date('2026-10-03T10:05:00.000Z')
const ask = (id: string, over: Partial<FleetApprovalDto> = {}): FleetApprovalDto => ({
  id, type: 'nax_bash_escalate', status: 'pending', projectId: 'p1', jobId: 'j1', policyId: null,
  payload: { command: 'git push --force origin HEAD', commandTruncated: false, maskedCount: 0, root: '/w', stage: 'execution',
    storyId: null, featureName: 'login', reason: 'r', options: ['allow', 'deny'] },
  outcome: null, requestedAt: '2026-10-03T10:00:00.000Z', expiresAt: '2026-10-03T10:10:00.000Z', decision: null,
  decidedById: null, decidedAt: null, resolvedBy: null, comment: null, ...over,
})

function mount(approvals: FleetApprovalDto[]) {
  const app = mountSfc(section, {
    components: uiStubs,
    props: { slug: 'koda', approvals, now: NOW },
    globals: { computed, useI18n: () => enI18n() },
  })
  return { app, byId: (id: string) => app.find(`[data-testid="${id}"]`) }
}

describe('FleetJobApprovals (D297)', () => {
  test('one row per approval: preview, status, decision, countdown only while pending, link to the inbox row', () => {
    const m = mount([ask('b2'), ask('b1', { status: 'approved', decision: 'allow', resolvedBy: 'user' })])
    const pending = m.byId('fleet-job-approval-b2')[0]
    expect(pending.props['data-status']).toBe('pending')
    expect(m.app.textOf(pending)).toContain('git push --force origin HEAD')
    expect(m.app.textOf(m.app.find('[data-testid="fleet-job-approval-countdown"]', pending)[0])).toBe('5:00')
    const done = m.byId('fleet-job-approval-b1')[0]
    expect(m.app.textOf(done)).toContain('Allowed once')
    expect(m.app.find('[data-testid="fleet-job-approval-countdown"]', done)).toHaveLength(0)
    expect(m.byId('fleet-job-approval-open-b1')[0].props.to).toBe('/koda/fleet/approvals?id=b1')
    m.app.unmount()
  })

  test('a job with no asks says so; a malformed payload still renders', () => {
    const empty = mount([])
    expect(empty.byId('fleet-job-approvals-empty')).toHaveLength(1)
    empty.app.unmount()
    const odd = mount([ask('b3', { payload: {}, status: 'expired', resolvedBy: 'timeout' })])
    expect(odd.app.textOf(odd.byId('fleet-job-approval-b3')[0])).toContain('A job asks to run a shell command')
    expect(odd.app.textOf(odd.byId('fleet-job-approval-b3')[0])).toContain('Timed out')
    odd.app.unmount()
  })
})
```

4. `apps/web/tests/pages/fleet-job-detail.spec.ts`, add inside `describe('job detail'`:

```ts
  test('S1.5 2b: callout, shell approvals line, approvals section, live reload on fleet_approval (D297)', () => {
    expect(detail).toContain("import { useFleetApprovals } from '~/composables/useFleetApprovals'")
    expect(detail).toContain("import { useApprovalCountdown } from '~/composables/useApprovalCountdown'")
    expect(detail).toMatch(/<div v-if="job\.pendingApprovals > 0"[^>]*data-testid="fleet-job-approval-callout"/)
    expect(detail).toContain(':to="reviewHref"')
    expect(detail).toContain("inboxPath({ kind: 'project', slug }, firstPending(jobApprovals.value)?.id)")
    expect(detail).toContain('bashSummary(t, job.bashMode, job.approvalTimeoutSec)')
    expect(detail).toMatch(/<FleetJobApprovals v-if="showApprovals" :slug="slug" :approvals="jobApprovals" :now="now" \/>/)
    expect(detail).toContain("job.value.bashMode !== 'raw' || jobApprovals.value.length > 0")
    expect(liveHandlers(detail)).toContain('onFleetApproval: () => liveReload.trigger()')
    expect(detail).toMatch(/async function reloadSilently\(\)[\s\S]*?await loadApprovals\(\)/)
    expect(timeline).toContain("case 'approval':")
  })
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/web && bun run test -- tests/composables/useFleetApprovals.spec.ts tests/lib/fleet-jobs.spec.ts tests/components/fleet-job-approvals.spec.ts tests/pages/fleet-job-detail.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `listForJob`**

In `apps/web/composables/useFleetApprovals.ts`, extend the lib import to `buildApprovalQuery, INBOX_PENDING_SIZE,
sortPending`, and inside `useFleetApprovals` before `return`:

```ts
  /** D297: every approval of one job (job page), newest first, one page of 100. */
  async function listForJob(jobId: string): Promise<FleetApprovalDto[]> {
    const res = await $api.get<FleetPage<FleetApprovalDto>>(approvalRoot(base), { query: { jobId, size: String(INBOX_PENDING_SIZE) } })
    return res.records ?? []
  }
```

and return it: `return { approvals, total, page, hasNext, load, get, decide, listForJob }`.

- [ ] **Step 4: Implement the timeline row**

In `apps/web/lib/fleet-jobs.ts`, add `| { kind: 'approval'; command: string }` to `TimelineEntry`, and in
`summarizeEvent` before `default:`:

```ts
    case 'approval_request': {
      // S1.5 2a: a relayed bash ask; the full text lives on the approval, the timeline shows its first line.
      const body = text(p.command) ?? text(p.rawDetail) ?? ''
      const first = body.split('\n')[0] ?? ''
      return { kind: 'approval', command: first.length > LOG_PREVIEW ? `${first.slice(0, LOG_PREVIEW)}...` : first }
    }
```

In `apps/web/components/fleet/FleetJobTimeline.vue` `describe()`, before `default:`:

```ts
    case 'approval':
      return t('fleet.jobs.timeline.approval', { command: entry.command })
```

- [ ] **Step 5: Implement the section**

Create `apps/web/components/fleet/JobApprovals.vue`:

```vue
<template>
  <section class="space-y-3" data-testid="fleet-job-approvals">
    <h2 class="text-lg font-semibold">{{ t('fleet.jobs.approvalsSection.title') }}</h2>
    <p v-if="rows.length === 0" class="text-sm text-muted-foreground" data-testid="fleet-job-approvals-empty">{{ t('fleet.jobs.approvalsSection.empty') }}</p>
    <ul v-else class="divide-y divide-border rounded-md border border-border">
      <li
        v-for="row in rows"
        :key="row.id"
        class="flex flex-wrap items-center gap-3 px-3 py-2 text-sm"
        :data-testid="`fleet-job-approval-${row.id}`"
        :data-status="row.status"
      >
        <span class="min-w-0 flex-1 break-all font-mono text-xs">{{ row.preview }}</span>
        <Badge :variant="row.status === 'pending' ? 'default' : 'secondary'">{{ label('fleet.approvals.status', row.status) }}</Badge>
        <span v-if="row.detail" class="text-xs text-muted-foreground">{{ row.detail }}</span>
        <span v-if="row.left !== null" class="font-mono text-xs text-muted-foreground" data-testid="fleet-job-approval-countdown">{{ countdownText(row.left) }}</span>
        <span class="text-xs text-muted-foreground"><FleetAge :iso="row.requestedAt" :now="now" mode="ago" /></span>
        <NuxtLink :to="row.href" class="text-xs text-primary underline-offset-4 hover:underline" :data-testid="`fleet-job-approval-open-${row.id}`">
          {{ t('fleet.jobs.approvalsSection.open') }}
        </NuxtLink>
      </li>
    </ul>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { bashPayload, commandPreview, countdownText, inboxPath, secondsLeft } from '~/lib/fleet-approvals'
import { codeLabel } from '~/lib/fleet-i18n'
import type { FleetApprovalDto } from '~/lib/fleet-types'

// D297: read-only; decisions are made in the inbox (one place for 409 and expiry handling).
const props = defineProps<{ slug: string; approvals: FleetApprovalDto[]; now: Date }>()

const { t, te } = useI18n()
const label = (prefix: string, code: string): string => codeLabel(t, te, prefix, code)

const rows = computed(() => props.approvals.map((a) => {
  const bash = bashPayload(a)
  return {
    id: a.id,
    status: a.status,
    requestedAt: a.requestedAt,
    preview: bash ? commandPreview(bash) : t('fleet.approvals.summary.bash'),
    detail: a.decision ? label('fleet.approvals.decision', a.decision) : (a.resolvedBy ? label('fleet.approvals.resolvedBy', a.resolvedBy) : null),
    left: a.status === 'pending' ? secondsLeft(a.expiresAt, props.now) : null,
    href: inboxPath({ kind: 'project', slug: props.slug }, a.id),
  }
}))
</script>
```

- [ ] **Step 6: Wire the job page**

In `apps/web/pages/[project]/fleet/jobs/[id].vue`:

1. Imports, after the existing ones:

```ts
import { useApprovalCountdown } from '~/composables/useApprovalCountdown'
import { useFleetApprovals } from '~/composables/useFleetApprovals'
import { firstPending, inboxPath } from '~/lib/fleet-approvals'
import { bashSummary } from '~/lib/fleet-bash-mode'
import FleetJobApprovals from '~/components/fleet/JobApprovals.vue'
```

and add `FleetApprovalDto` to the `~/lib/fleet-types` type import.

2. After `const { data: viewerRole } = useProjectViewerRole(slug)`:

```ts
const approvalsApi = useFleetApprovals({ kind: 'project', slug })
const { now } = useApprovalCountdown()
/** D297: this job's approvals (bash asks), newest first. */
const jobApprovals = ref<FleetApprovalDto[]>([])
```

3. After `cancelPending`:

```ts
const showApprovals = computed(() => job.value !== null && (job.value.bashMode !== 'raw' || jobApprovals.value.length > 0))
/** D297: Review opens the ask nax denies first; the inbox itself before the list has loaded. */
const reviewHref = computed(() => inboxPath({ kind: 'project', slug }, firstPending(jobApprovals.value)?.id))

async function loadApprovals(): Promise<void> {
  jobApprovals.value = await approvalsApi.listForJob(jobId)
}
```

4. In `initializeRelatedData()`, add `void loadApprovals().catch((err: unknown) => toast.error(extractApiError(err)))`.

5. In `reloadSilently()`, after `job.value = await jobsApi.get(jobId)`, add `await loadApprovals()`.

6. In `useProjectEvents(slug, {`, add `onFleetApproval: () => liveReload.trigger(),` before `onResync`.

7. Template: after the closing `</div>` of the state row (`flex flex-wrap items-center gap-3`), add:

```vue
      <div v-if="job.pendingApprovals > 0" class="flex flex-wrap items-center gap-3 rounded-md border border-primary p-4 text-sm" data-testid="fleet-job-approval-callout">
        <span class="font-medium">{{ t('fleet.jobs.detail.waitingApproval', { count: job.pendingApprovals }) }}</span>
        <NuxtLink :to="reviewHref" class="text-primary underline-offset-4 hover:underline" data-testid="fleet-job-approval-review">{{ t('fleet.jobs.detail.reviewApproval') }}</NuxtLink>
      </div>
```

In the details `<dl>`, after the profiles `<div>`:

```vue
        <div><dt class="text-muted-foreground">{{ t('fleet.jobs.detail.bash') }}</dt><dd data-testid="fleet-job-bash">{{ bashSummary(t, job.bashMode, job.approvalTimeoutSec) }}</dd></div>
```

Before `<FleetJobTimeline ...>`:

```vue
      <FleetJobApprovals v-if="showApprovals" :slug="slug" :approvals="jobApprovals" :now="now" />
```

- [ ] **Step 7: i18n**

`en.json`: under `fleet.jobs.detail` add `"bash": "Shell approvals"`, `"waitingApproval": "Waiting for approval ({count})"`,
`"reviewApproval": "Review"`; under `fleet.jobs` add
`"approvalsSection": { "title": "Approvals", "empty": "No shell command asks yet.", "open": "Open" }`; under
`fleet.jobs.timeline` add `"approval": "Approval requested: {command}"`.

`zh.json`: `"bash": "Shell 审批"`, `"waitingApproval": "等待审批（{count}）"`, `"reviewApproval": "查看"`;
`"approvalsSection": { "title": "审批", "empty": "尚无 Shell 命令询问。", "open": "打开" }`;
`"approval": "请求审批：{command}"`.

- [ ] **Step 8: Run the tests**

Run: `cd apps/web && bun run test -- tests/composables/useFleetApprovals.spec.ts tests/lib/fleet-jobs.spec.ts tests/components/fleet-job-approvals.spec.ts tests/pages/fleet-job-detail.spec.ts tests/i18n`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/web/components/fleet/JobApprovals.vue apps/web/composables/useFleetApprovals.ts "apps/web/pages/[project]/fleet/jobs/[id].vue" apps/web/lib/fleet-jobs.ts apps/web/components/fleet/FleetJobTimeline.vue apps/web/i18n/locales/en.json apps/web/i18n/locales/zh.json apps/web/tests
git commit -m "feat(web): job page approval callout, approvals section and ask timeline row (S1.5 2b, D297)"
```

---

### Task 6: Jobs list "needs approval" marker

**Files:**
- Modify: `apps/web/pages/[project]/fleet/index.vue`, `apps/web/i18n/locales/en.json`, `zh.json`
- Test: `apps/web/tests/pages/fleet-jobs-list.spec.ts`

**Interfaces:**
- Produces: test id `fleet-job-needs-approval-<jobId>`.

- [ ] **Step 1: Write the failing test**

In `apps/web/tests/pages/fleet-jobs-list.spec.ts`, add inside `describe('fleet jobs list'`:

```ts
  test('a job with pending approvals is marked next to its state, and the list reloads on fleet_approval (spec §5)', () => {
    expect(list).toMatch(/<FleetJobStateBadge :state="job\.state" \/>\s*<Badge v-if="job\.pendingApprovals > 0"[^>]*:data-testid="`fleet-job-needs-approval-\$\{job\.id\}`"/)
    expect(list).toContain("t('fleet.jobs.needsApproval', { count: job.pendingApprovals })")
    expect(liveHandlers(list)).toContain('onFleetApproval: () => liveReload.trigger()')
  })
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/web && bun run test -- tests/pages/fleet-jobs-list.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `apps/web/pages/[project]/fleet/index.vue`, replace `<TableCell><FleetJobStateBadge :state="job.state" /></TableCell>` with:

```vue
              <TableCell>
                <div class="flex flex-wrap items-center gap-2">
                  <FleetJobStateBadge :state="job.state" />
                  <Badge v-if="job.pendingApprovals > 0" variant="default" :data-testid="`fleet-job-needs-approval-${job.id}`">{{ t('fleet.jobs.needsApproval', { count: job.pendingApprovals }) }}</Badge>
                </div>
              </TableCell>
```

and in its `useProjectEvents(slug, {` object add `onFleetApproval: () => liveReload.trigger(),` before `onResync`.

`en.json` `fleet.jobs`: `"needsApproval": "Needs approval ({count})"`; `zh.json`: `"needsApproval": "待审批（{count}）"`.

- [ ] **Step 4: Run the tests**

Run: `cd apps/web && bun run test -- tests/pages/fleet-jobs-list.spec.ts tests/i18n`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "apps/web/pages/[project]/fleet/index.vue" apps/web/i18n/locales/en.json apps/web/i18n/locales/zh.json apps/web/tests/pages/fleet-jobs-list.spec.ts
git commit -m "feat(web): mark jobs that need approval in the jobs list (S1.5 2b)"
```

---

### Task 7: Dispatch form bash fields

**Files:**
- Modify: `apps/web/lib/fleet-dispatch.ts`, `apps/web/pages/[project]/fleet/dispatch.vue`
- Test: `apps/web/tests/lib/fleet-dispatch.spec.ts`, `apps/web/tests/pages/fleet-dispatch-page.spec.ts`

**Interfaces:**
- Consumes: Task 1 `BASH_MODES`, `bashCreateFields`, `isBashTimeoutValid`, `minutesText`, `DEFAULT_APPROVAL_TIMEOUT_SEC`.
- Produces: `DispatchFormValues` gains `bashMode: BashMode` and `approvalTimeoutMinutes?: string`; test ids
  `dispatch-bash-mode`, `dispatch-approval-timeout`.

- [ ] **Step 1: Write the failing tests**

In `apps/web/tests/lib/fleet-dispatch.spec.ts`, add:

```ts
describe('bash fields (D299)', () => {
  test('defaults: raw, 10 minutes', () => {
    expect(DISPATCH_DEFAULTS.bashMode).toBe('raw')
    expect(DISPATCH_DEFAULTS.approvalTimeoutMinutes).toBe('10')
  })

  test('a gated or escalate RUN needs a valid timeout; raw and PLAN do not', () => {
    expect(messages(valid({ bashMode: 'escalate', approvalTimeoutMinutes: '' }))).toEqual(['fleet.bash.validation.timeout'])
    expect(messages(valid({ bashMode: 'gated', approvalTimeoutMinutes: '61' }))).toEqual(['fleet.bash.validation.timeout'])
    expect(messages(valid({ bashMode: 'escalate', approvalTimeoutMinutes: '5' }))).toEqual([])
    expect(messages(valid({ bashMode: 'raw', approvalTimeoutMinutes: '' }))).toEqual([])
    expect(messages(valid({ command: 'PLAN', planFrom: 'docs/s.md', bashMode: 'escalate', approvalTimeoutMinutes: '' }))).toEqual([])
  })

  test('the timeout field may arrive undefined (unmounted under v-if) for a raw job', () => {
    expect(messages({ ...valid(), approvalTimeoutMinutes: undefined })).toEqual([])
  })

  test('body: raw sends no bash fields; an escalate RUN sends both; a PLAN never does', () => {
    expect(toDispatchBody(valid())).not.toHaveProperty('bashMode')
    expect(toDispatchBody(valid())).not.toHaveProperty('approvalTimeoutSec')
    expect(toDispatchBody(valid({ bashMode: 'escalate', approvalTimeoutMinutes: '2' }))).toEqual(expect.objectContaining({ bashMode: 'escalate', approvalTimeoutSec: 120 }))
    const plan = toDispatchBody(valid({ command: 'PLAN', planFrom: 'docs/s.md', bashMode: 'escalate', approvalTimeoutMinutes: '2' }))
    expect(plan).not.toHaveProperty('bashMode')
    expect(plan).not.toHaveProperty('approvalTimeoutSec')
  })
})
```

In `apps/web/tests/pages/fleet-dispatch-page.spec.ts`, add:

```ts
  test('bash mode select and timeout only for RUN; the timeout only for gated/escalate (D299)', () => {
    expect(dispatch).toMatch(/<template v-if="values\.command === 'RUN'">[\s\S]*?name="bashMode"[\s\S]*?testid="dispatch-bash-mode"/)
    expect(dispatch).toMatch(/<FormField v-if="values\.bashMode !== 'raw'" v-slot="\{ componentField \}" name="approvalTimeoutMinutes">/)
    expect(dispatch).toContain('data-testid="dispatch-approval-timeout"')
    expect(dispatch).toContain("BASH_MODES.map(mode => ({ value: mode, label: t(`fleet.bash.mode.${mode}`) }))")
  })
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/web && bun run test -- tests/lib/fleet-dispatch.spec.ts tests/pages/fleet-dispatch-page.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the library**

In `apps/web/lib/fleet-dispatch.ts`:

1. Imports: add `import { BASH_MODES, bashCreateFields, DEFAULT_APPROVAL_TIMEOUT_SEC, isBashTimeoutValid, minutesText } from '~/lib/fleet-bash-mode'`.

2. In the `z.object({...})`, after `pinnedRunnerId: z.string().optional(),`:

```ts
    bashMode: z.enum(BASH_MODES),
    /** Under v-if: may be undefined when unmounted (the D182 trap). */
    approvalTimeoutMinutes: z.string().optional(),
```

3. In the `superRefine`, add:

```ts
    if (v.command === 'RUN' && !isBashTimeoutValid(v.bashMode, v.approvalTimeoutMinutes ?? '')) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['approvalTimeoutMinutes'], message: t('fleet.bash.validation.timeout') })
    }
```

4. `DISPATCH_DEFAULTS`: add `bashMode: 'raw',` and `approvalTimeoutMinutes: minutesText(DEFAULT_APPROVAL_TIMEOUT_SEC),`.

5. `toDispatchBody`: update the doc comment to `/** Form values -> request body: trims, drops empty optionals, planFrom only for PLAN, bash fields only for a gated/escalate RUN (D299). */`
   and add as the last spread:

```ts
    ...(v.command === 'RUN' ? bashCreateFields(v.bashMode, v.approvalTimeoutMinutes ?? '') : {}),
```

- [ ] **Step 4: Implement the page**

In `apps/web/pages/[project]/fleet/dispatch.vue`:

1. Import `import { BASH_MODES } from '~/lib/fleet-bash-mode'`.

2. After `commandOptions`:

```ts
const bashOptions = computed(() => BASH_MODES.map(mode => ({ value: mode, label: t(`fleet.bash.mode.${mode}`) })))
```

3. After the `maxCostUsd` `FormField`, add:

```vue
      <template v-if="values.command === 'RUN'">
        <FormField v-slot="{ componentField }" name="bashMode">
          <FormItem>
            <FormLabel>{{ t('fleet.bash.modeLabel') }}</FormLabel>
            <FormControl>
              <FleetNativeSelect v-bind="componentField" :options="bashOptions" testid="dispatch-bash-mode" />
            </FormControl>
            <p class="text-xs text-muted-foreground">{{ t('fleet.bash.modeHint') }}</p>
            <FormMessage />
          </FormItem>
        </FormField>
        <FormField v-if="values.bashMode !== 'raw'" v-slot="{ componentField }" name="approvalTimeoutMinutes">
          <FormItem>
            <FormLabel>{{ t('fleet.bash.timeout') }}</FormLabel>
            <FormControl>
              <Input v-bind="componentField" inputmode="decimal" data-testid="dispatch-approval-timeout" />
            </FormControl>
            <p class="text-xs text-muted-foreground">{{ t('fleet.bash.timeoutHint') }}</p>
            <FormMessage />
          </FormItem>
        </FormField>
      </template>
```

- [ ] **Step 5: Run the tests and type-check**

Run: `cd apps/web && bun run test -- tests/lib/fleet-dispatch.spec.ts tests/pages/fleet-dispatch-page.spec.ts tests/pages/fleet-dispatch-placement-runtime.spec.ts`
Expected: PASS.
Run: `cd apps/web && bun run type-check`
Expected: no errors from `fleet-dispatch.ts` or `dispatch.vue`.

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/fleet-dispatch.ts "apps/web/pages/[project]/fleet/dispatch.vue" apps/web/tests/lib/fleet-dispatch.spec.ts apps/web/tests/pages/fleet-dispatch-page.spec.ts
git commit -m "feat(web): bash mode and ask timeout on the dispatch form (S1.5 2b, D299)"
```

---

### Task 8: Schedule dialog and detail bash fields

**Files:**
- Modify: `apps/web/lib/fleet-schedules.ts`, `apps/web/components/fleet/ScheduleEditDialog.vue`,
  `apps/web/pages/[project]/fleet/schedules/[id].vue`, `apps/web/i18n/locales/en.json`, `zh.json`
- Test: `apps/web/tests/lib/fleet-schedules.spec.ts`, `apps/web/tests/components/fleet-schedule-edit-dialog.spec.ts`,
  `apps/web/tests/pages/fleet-schedule-detail.spec.ts`

**Interfaces:**
- Consumes: Task 1 `BASH_MODES`, `bashCreateFields`, `bashPatchFields`, `isBashTimeoutValid`, `minutesText`,
  `DEFAULT_APPROVAL_TIMEOUT_SEC`, `bashSummary`.
- Produces: `ScheduleFormValues` gains `bashMode: BashMode` and `approvalTimeoutMinutes: string`; test ids
  `fleet-schedule-bash-mode`, `fleet-schedule-approval-timeout`, `fleet-schedule-bash-warning`, `fleet-schedule-bash`.

- [ ] **Step 1: Write the failing tests**

In `apps/web/tests/lib/fleet-schedules.spec.ts`:

1. Add `bashMode: 'raw', approvalTimeoutSec: 600,` to the `schedule()` fixture (after `pinnedRunnerId: 'run1',`) and
   `bashMode: 'raw', approvalTimeoutMinutes: '10',` to the `form()` fixture (after `noProgressLimit: '3',`).

2. In `'patch sends every editable field ...'`, add `bashMode: 'raw',` to the first `toEqual` object.

3. In `'initial values: ...'`, add `bashMode: 'raw', approvalTimeoutMinutes: '10',` to the create-defaults object.

4. Add:

```ts
describe('bash fields (D300, Review Focus 5)', () => {
  test('a relay mode needs a valid timeout; raw does not, even with the field emptied', () => {
    const bad = buildScheduleSchema(t, 'create').safeParse(form({ bashMode: 'escalate', approvalTimeoutMinutes: '' }))
    expect(bad.success ? [] : bad.error.issues.map((i) => i.path.join('.'))).toContain('approvalTimeoutMinutes')
    expect(buildScheduleSchema(t, 'edit').safeParse(form({ ref: 'main', bashMode: 'raw', approvalTimeoutMinutes: '' })).success).toBe(true)
  })

  test('fields may arrive undefined and default to raw', () => {
    const values = { ...form(), bashMode: undefined, approvalTimeoutMinutes: undefined }
    expect(buildScheduleSchema(t, 'create').safeParse(values).success).toBe(true)
  })

  test('create: raw sends nothing, escalate sends both', () => {
    expect(toCreateScheduleBody(form())).not.toHaveProperty('bashMode')
    expect(toCreateScheduleBody(form({ bashMode: 'escalate', approvalTimeoutMinutes: '15' })))
      .toEqual(expect.objectContaining({ bashMode: 'escalate', approvalTimeoutSec: 900 }))
  })

  test('patch: the mode always travels; raw omits the timeout so the stored one is kept', () => {
    expect(toSchedulePatchBody(form({ ref: 'main', bashMode: 'raw', approvalTimeoutMinutes: '' }))).not.toHaveProperty('approvalTimeoutSec')
    expect(toSchedulePatchBody(form({ ref: 'main', bashMode: 'gated', approvalTimeoutMinutes: '1.5' })))
      .toEqual(expect.objectContaining({ bashMode: 'gated', approvalTimeoutSec: 90 }))
  })

  test('a CLI-made 90 s timeout loads as 1.5 minutes and patches back as 90 s', () => {
    const values = initialScheduleValues(schedule({ bashMode: 'escalate', approvalTimeoutSec: 90 }), 'UTC')
    expect(values).toEqual(expect.objectContaining({ bashMode: 'escalate', approvalTimeoutMinutes: '1.5' }))
    expect(toSchedulePatchBody(values)).toEqual(expect.objectContaining({ approvalTimeoutSec: 90 }))
  })
})
```

In `apps/web/tests/components/fleet-schedule-edit-dialog.spec.ts`:

1. Add `bashMode: 'raw', approvalTimeoutSec: 600,` to its `schedule()` fixture.

2. In `'edit of a pinned schedule patches every editable field ...'`, add `bashMode: 'raw'` to the expected PATCH body.

3. Add:

```ts
  test('an escalate schedule shows the timeout and the warning, and patches the stored 90 s back unchanged', async () => {
    const { api, toasts, flush } = harness()
    const app = mountDialog({ open: true, schedule: schedule({ bashMode: 'escalate', approvalTimeoutSec: 90 }) }, api, toasts)
    await flush()
    expect(testids(app)).toEqual(expect.arrayContaining(['fleet-schedule-bash-mode', 'fleet-schedule-approval-timeout']))
    expect(app.find('[data-testid="fleet-schedule-bash-warning"]')).toHaveLength(1)
    await submit(app)
    await flush()
    expect(api.patch).toHaveBeenCalledWith('/projects/koda/fleet/schedules/s1', expect.objectContaining({ bashMode: 'escalate', approvalTimeoutSec: 90 }))
    app.unmount()
  })

  test('a raw schedule hides the timeout and the warning', async () => {
    const { api, toasts, flush } = harness()
    const app = mountDialog({ open: true, schedule: schedule() }, api, toasts)
    await flush()
    expect(testids(app)).toContain('fleet-schedule-bash-mode')
    expect(testids(app)).not.toContain('fleet-schedule-approval-timeout')
    expect(app.find('[data-testid="fleet-schedule-bash-warning"]')).toHaveLength(0)
    app.unmount()
  })
```

In `apps/web/tests/pages/fleet-schedule-detail.spec.ts` (the page source is the `detail` constant), add a top-level test:

```ts
test('the template shows the shell approvals line (D300)', () => {
  expect(detail).toContain('data-testid="fleet-schedule-bash"')
  expect(detail).toContain('bashSummary(t, schedule.bashMode, schedule.approvalTimeoutSec)')
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/web && bun run test -- tests/lib/fleet-schedules.spec.ts tests/components/fleet-schedule-edit-dialog.spec.ts tests/pages/fleet-schedule-detail.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the library**

In `apps/web/lib/fleet-schedules.ts`:

1. Imports: `import { BASH_MODES, bashCreateFields, bashPatchFields, DEFAULT_APPROVAL_TIMEOUT_SEC, isBashTimeoutValid, minutesText } from '~/lib/fleet-bash-mode'`, and add `BashMode` to the fleet-types type import.

2. `ScheduleFormValues`: add `bashMode: BashMode` and `approvalTimeoutMinutes: string` after `noProgressLimit`.

3. Schema object, after `noProgressLimit: ...`:

```ts
    bashMode: z.enum(BASH_MODES).default('raw'),
    approvalTimeoutMinutes: text,
```

and in its `superRefine`, add:

```ts
    if (!isBashTimeoutValid(v.bashMode, v.approvalTimeoutMinutes)) issue('approvalTimeoutMinutes', 'fleet.bash.validation.timeout')
```

4. `initialScheduleValues`: the create branch adds `bashMode: 'raw', approvalTimeoutMinutes: minutesText(DEFAULT_APPROVAL_TIMEOUT_SEC),`;
   the edit branch adds `bashMode: s.bashMode, approvalTimeoutMinutes: minutesText(s.approvalTimeoutSec),`.

5. `toCreateScheduleBody`: add `...bashCreateFields(v.bashMode, v.approvalTimeoutMinutes),` as the last spread.

6. `toSchedulePatchBody`: add `...bashPatchFields(v.bashMode, v.approvalTimeoutMinutes),` as the last line of the object.

- [ ] **Step 4: Implement the dialog and the detail page**

In `apps/web/components/fleet/ScheduleEditDialog.vue`:

1. Import `import { BASH_MODES } from '~/lib/fleet-bash-mode'`; add
   `const bashOptions = computed(() => BASH_MODES.map((mode) => ({ value: mode, label: t(`fleet.bash.mode.${mode}`) })))`.

2. After the pin `FormField` (before the buttons row), add:

```vue
        <FormField v-slot="{ componentField }" name="bashMode">
          <FormItem>
            <FormLabel>{{ t('fleet.bash.modeLabel') }}</FormLabel>
            <FormControl>
              <FleetNativeSelect v-bind="componentField" :options="bashOptions" testid="fleet-schedule-bash-mode" />
            </FormControl>
            <p class="text-xs text-muted-foreground">{{ t('fleet.bash.modeHint') }}</p>
            <FormMessage />
          </FormItem>
        </FormField>

        <template v-if="formValues.bashMode && formValues.bashMode !== 'raw'">
          <FormField v-slot="{ componentField }" name="approvalTimeoutMinutes">
            <FormItem>
              <FormLabel>{{ t('fleet.bash.timeout') }}</FormLabel>
              <FormControl><Input v-bind="componentField" inputmode="decimal" data-testid="fleet-schedule-approval-timeout" /></FormControl>
              <p class="text-xs text-muted-foreground">{{ t('fleet.bash.timeoutHint') }}</p>
              <FormMessage />
            </FormItem>
          </FormField>
          <p class="text-xs text-muted-foreground" data-testid="fleet-schedule-bash-warning">{{ t('fleet.bash.scheduleWarning') }}</p>
        </template>
```

In `apps/web/pages/[project]/fleet/schedules/[id].vue`, import `import { bashSummary } from '~/lib/fleet-bash-mode'`
and after the `placement` `<div>` in the template `<dl>`:

```vue
          <div><dt class="text-muted-foreground">{{ t('fleet.schedules.detail.bash') }}</dt><dd data-testid="fleet-schedule-bash">{{ bashSummary(t, schedule.bashMode, schedule.approvalTimeoutSec) }}</dd></div>
```

`en.json` `fleet.schedules.detail`: `"bash": "Shell approvals"`; `zh.json`: `"bash": "Shell 审批"`.

- [ ] **Step 5: Run the tests and type-check**

Run: `cd apps/web && bun run test -- tests/lib/fleet-schedules.spec.ts tests/components/fleet-schedule-edit-dialog.spec.ts tests/pages/fleet-schedule-detail.spec.ts tests/components/fleet-schedule-table.spec.ts tests/i18n`
Expected: PASS.
Run: `cd apps/web && bun run type-check && bun run lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/fleet-schedules.ts apps/web/components/fleet/ScheduleEditDialog.vue "apps/web/pages/[project]/fleet/schedules/[id].vue" apps/web/i18n/locales/en.json apps/web/i18n/locales/zh.json apps/web/tests
git commit -m "feat(web): bash mode and ask timeout on schedules (S1.5 2b, D300)"
```

---

### Task 9: CLI `--bash-mode` and `--approval-timeout`

**Files:**
- Modify: `apps/cli/src/commands/fleet-shared.ts`, `apps/cli/src/commands/fleet-dispatch.ts`,
  `apps/cli/src/commands/fleet-schedule.ts`, `apps/cli/src/commands/fleet-job.ts`
- Test: `apps/cli/src/commands/fleet-shared.spec.ts`, `fleet-dispatch.spec.ts`, `fleet-schedule.spec.ts`, `fleet-job.spec.ts`

**Interfaces:**
- Consumes: generated `DispatchFleetJobDto`, `CreateScheduleDto`, `UpdateScheduleDto`, `FleetJobDto`, `ScheduleDto`
  (all already carry `bashMode` / `approvalTimeoutSec` from 2a).
- Produces (fleet-shared): `type BashMode = 'raw' | 'gated' | 'escalate'`, `parseBashMode(value: string): BashMode`,
  `parseApprovalTimeout(value: string): number` (both throw commander `InvalidArgumentError`), `bashModeText(mode,
  sec): string`.

- [ ] **Step 1: Write the failing tests**

`apps/cli/src/commands/fleet-shared.spec.ts`, add (import the three new names from `./fleet-shared`):

```ts
describe('bash mode flags (D301)', () => {
  it('parses the three modes and refuses anything else', () => {
    expect(parseBashMode('escalate')).toBe('escalate');
    expect(() => parseBashMode('yolo')).toThrow('expected raw, gated or escalate');
  });

  it('parses whole seconds 30..3600', () => {
    expect(parseApprovalTimeout('30')).toBe(30);
    expect(parseApprovalTimeout('3600')).toBe(3600);
    for (const bad of ['29', '3601', '1.5', '10m', '', '-60']) expect(() => parseApprovalTimeout(bad)).toThrow('whole number of seconds');
  });

  it('describes a job or schedule mode', () => {
    expect(bashModeText('raw', 600)).toBe('raw');
    expect(bashModeText('escalate', 90)).toBe('escalate (asks wait 90 s)');
  });
});
```

`apps/cli/src/commands/fleet-dispatch.spec.ts`, add:

```ts
  it('sends --bash-mode and --approval-timeout on a RUN (D301)', async () => {
    (fleetJobsControllerDispatch as jest.Mock).mockResolvedValue({ ret: 0, data: { job: job(), placement: { assigned: true, runnerId: 'r1', misfits: [] } } });
    await run('--repo', 'acme/app', '--feature', 'login', '--max-cost', '5', '--bash-mode', 'escalate', '--approval-timeout', '900');
    expect(fleetJobsControllerDispatch).toHaveBeenCalledWith({
      path: { slug: 'web' },
      body: { repoId: 'fr1', command: 'RUN', feature: 'login', maxCostUsd: 5, bashMode: 'escalate', approvalTimeoutSec: 900 },
    });
  });

  it('refuses a relay mode on a PLAN, and a timeout without a relay mode, before dispatching (exit 3)', async () => {
    await run('--repo', 'acme/app', '--feature', 'f', '--max-cost', '1', '--plan', 'docs/s.md', '--bash-mode', 'gated');
    expect(exitSpy).toHaveBeenLastCalledWith(3);
    await run('--repo', 'acme/app', '--feature', 'f', '--max-cost', '1', '--approval-timeout', '60');
    expect(exitSpy).toHaveBeenLastCalledWith(3);
    await run('--repo', 'acme/app', '--feature', 'f', '--max-cost', '1', '--bash-mode', 'raw', '--approval-timeout', '60');
    expect(exitSpy).toHaveBeenLastCalledWith(3);
    expect(fleetJobsControllerDispatch).not.toHaveBeenCalled();
  });

  it('rejects a bad --bash-mode or --approval-timeout before any request', async () => {
    await expect(run('--repo', 'acme/app', '--feature', 'f', '--max-cost', '1', '--bash-mode', 'loud')).rejects.toMatchObject({ code: 'commander.invalidArgument' });
    await expect(run('--repo', 'acme/app', '--feature', 'f', '--max-cost', '1', '--approval-timeout', '5')).rejects.toMatchObject({ code: 'commander.invalidArgument' });
    expect(fleetJobsControllerDispatch).not.toHaveBeenCalled();
  });
```

`apps/cli/src/commands/fleet-schedule.spec.ts`, add `bashMode: 'raw', approvalTimeoutSec: 600,` to `row()` and add:

```ts
  it('add and edit pass --bash-mode and --approval-timeout (D301)', async () => {
    (projectFleetSchedulesControllerCreate as jest.Mock).mockResolvedValue(ok(row()));
    await run('add', '--repo', 'acme/app', '--feature', 'login', '--cron', '0 9 * * 1-5', '--timezone', 'UTC', '--max-cost', '5', '--bash-mode', 'gated', '--approval-timeout', '120');
    expect(projectFleetSchedulesControllerCreate).toHaveBeenLastCalledWith({
      path: { slug: 'web' },
      body: { name: 'login', repoId: 'fr1', feature: 'login', cron: '0 9 * * 1-5', timezone: 'UTC', maxCostUsd: 5, bashMode: 'gated', approvalTimeoutSec: 120 },
    });
    (projectFleetSchedulesControllerUpdate as jest.Mock).mockResolvedValue(ok(row()));
    await run('edit', 's1', '--approval-timeout', '300');
    expect(projectFleetSchedulesControllerUpdate).toHaveBeenLastCalledWith({ path: { slug: 'web', id: 's1' }, body: { approvalTimeoutSec: 300 } });
    await run('edit', 's1', '--bash-mode', 'raw');
    expect(projectFleetSchedulesControllerUpdate).toHaveBeenLastCalledWith({ path: { slug: 'web', id: 's1' }, body: { bashMode: 'raw' } });
  });

  it('add refuses a timeout without a relay mode (exit 3)', async () => {
    await run('add', '--repo', 'acme/app', '--feature', 'login', '--cron', '0 9 * * 1-5', '--timezone', 'UTC', '--max-cost', '5', '--approval-timeout', '120');
    expect(exitSpy).toHaveBeenLastCalledWith(3);
    expect(projectFleetSchedulesControllerCreate).not.toHaveBeenCalled();
  });
```

In its existing `'show prints the schedule and its last jobs ...'` test, add
`expect(out()).toContain('bash raw')` after the existing expectations (the template line gains `, bash <mode text>`).

`apps/cli/src/commands/fleet-job.spec.ts`, in `'show prints the job fields ...'`, change the job to
`job({ bashMode: 'escalate', approvalTimeoutSec: 600, pendingApprovals: 2 })` and add `'escalate (asks wait 600 s)'` and
`'Pending approvals'` to the `want` list.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/cli && bun run test -- src/commands/fleet-shared.spec.ts src/commands/fleet-dispatch.spec.ts src/commands/fleet-schedule.spec.ts src/commands/fleet-job.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the parsers**

In `apps/cli/src/commands/fleet-shared.ts`, add `import { InvalidArgumentError } from 'commander';` (merge into an
existing commander import if there is one) and:

```ts
/** S1.5 §1.6: gated/escalate relay nax's bash asks to the koda approvals inbox (RUN jobs only). */
export type BashMode = 'raw' | 'gated' | 'escalate';
const BASH_MODES: readonly BashMode[] = ['raw', 'gated', 'escalate'];

export function parseBashMode(value: string): BashMode {
  if (!(BASH_MODES as readonly string[]).includes(value)) throw new InvalidArgumentError('expected raw, gated or escalate');
  return value as BashMode;
}

/** 30..3600 whole seconds (DispatchFleetJobDto.approvalTimeoutSec). */
export function parseApprovalTimeout(value: string): number {
  if (!/^\d{2,4}$/.test(value) || Number(value) < 30 || Number(value) > 3600) {
    throw new InvalidArgumentError('expected a whole number of seconds from 30 to 3600');
  }
  return Number(value);
}

export const bashModeText = (mode: BashMode, sec: number): string => (mode === 'raw' ? 'raw' : `${mode} (asks wait ${sec} s)`);

/** D301: a timeout means nothing without a relay mode; a PLAN job stays raw. Returns the refusal, or null. */
export function bashFlagProblem(o: { bashMode?: BashMode; approvalTimeout?: number; plan?: string }): string | null {
  const relay = o.bashMode !== undefined && o.bashMode !== 'raw';
  if (relay && o.plan) return '--bash-mode gated/escalate applies to nax run only: a --plan job stays raw';
  if (o.approvalTimeout !== undefined && !relay) return '--approval-timeout needs --bash-mode gated or escalate';
  return null;
}
```

- [ ] **Step 4: Wire dispatch**

In `apps/cli/src/commands/fleet-dispatch.ts`:

1. Import `bashFlagProblem, parseApprovalTimeout, parseBashMode, type BashMode` from `./fleet-shared`.
2. `DispatchOptions` gains `bashMode?: BashMode; approvalTimeout?: number;`.
3. First line of `buildBody`: `const bashProblem = bashFlagProblem(o); if (bashProblem) return invalid(bashProblem);`
4. Body spreads, after `...(o.ref ? { ref: o.ref } : {}),`:

```ts
    ...(o.bashMode ? { bashMode: o.bashMode } : {}),
    ...(o.approvalTimeout !== undefined ? { approvalTimeoutSec: o.approvalTimeout } : {}),
```

5. Options, after `--pin`:

```ts
    .option('--bash-mode <mode>', 'Shell command approvals: raw (default), gated or escalate; gated/escalate send asks to the approvals inbox (RUN only)', parseBashMode)
    .option('--approval-timeout <seconds>', 'Seconds an ask waits for a decision before nax denies it (30-3600, default 600); gated/escalate only', parseApprovalTimeout)
```

- [ ] **Step 5: Wire schedules and show rows**

In `apps/cli/src/commands/fleet-schedule.ts`:

1. Import `bashFlagProblem, bashModeText, parseApprovalTimeout, parseBashMode, type BashMode` from `./fleet-shared`.
2. `AddOptions` and `EditOptions` gain `bashMode?: BashMode; approvalTimeout?: number;`.
3. `registerAdd`: the same two `.option(...)` lines as dispatch (text: `'... ; gated/escalate asks of a scheduled run may wait until the timeout'` for `--bash-mode`); in the action, after the `--pin`/`--label` check:

```ts
        const bashProblem = bashFlagProblem(o);
        if (bashProblem) return handleFleetValidation(bashProblem);
```

and in `body`, after the stall-after spread:

```ts
          ...(o.bashMode ? { bashMode: o.bashMode } : {}),
          ...(o.approvalTimeout !== undefined ? { approvalTimeoutSec: o.approvalTimeout } : {}),
```

4. `registerEdit`: the two options (`--bash-mode <mode>` "Change the shell command approval mode", `--approval-timeout
   <seconds>` "Seconds an ask waits (30-3600)"), and in `editBody` the same two spreads. No cross-check on edit (the
   stored mode may already be gated).
5. `registerShow`: change the template line to:

```ts
          console.log(`Template: ${found.maxCostUsd} USD per run, ref ${found.ref}, bash ${bashModeText(found.bashMode, found.approvalTimeoutSec)}, stalls after ${found.noProgressLimit} runs without progress (${found.noProgressTicks} so far)`);
```

In `apps/cli/src/commands/fleet-job.ts`, import `bashModeText` from `./fleet-shared` and in `showRows` add after the
`Profiles` row:

```ts
    ['Bash mode', bashModeText(j.bashMode, j.approvalTimeoutSec)], ['Pending approvals', String(j.pendingApprovals)],
```

- [ ] **Step 6: Run the tests, lint and type-check**

Run: `cd apps/cli && bun run test -- src/commands && bun run lint && bun run type-check`
Expected: PASS, clean.

- [ ] **Step 7: Commit**

```bash
git add apps/cli/src/commands
git commit -m "feat(cli): --bash-mode and --approval-timeout on dispatch and schedules (S1.5 2b, D301)"
```

---

### Task 10: Runner refuses answers past nax's deadline; gate the relay integration spec

**Files:**
- Modify: `apps/runner/src/approvals/approval-relay.ts`, `apps/runner/src/approvals/approval-relay.spec.ts`,
  `apps/runner/test/integration/approval-relay.integration.spec.ts`

**Interfaces:**
- Produces: `ApprovalRelay.answer` may return `{ result: 'rejected', detail: 'ask_expired' }`.

- [ ] **Step 1: Make the fixtures current, then write the failing test**

In `apps/runner/src/approvals/approval-relay.spec.ts`, the fixture ask was created in September 2026, which is before
the spec's `NOW`; with D302 every answer to it would be `ask_expired`. Pin it to the test clock:

```ts
const naxAsk = (id = 'ask-1f2e3d4c') => ({ ...fixtures.a_simple, id, createdAt: NOW.getTime(), callbackUrl: callbackFor(id) });
```

and change the deadline expectation in `'an ask is journalled, appended once ...'` to
`deadlineAt: new Date(NOW.getTime() + fixtures.a_simple.timeout).toISOString()`.

Add:

```ts
  test('an answer after nax\'s deadline is refused ask_expired, never posted, and the ask is cleared (D302)', async () => {
    const endpoint = await relay.open(job());
    await send(endpoint, { ...naxAsk(), createdAt: NOW.getTime() - fixtures.a_simple.timeout });   // deadline == NOW
    expect(await relay.answer(answerCommand('allow'))).toEqual({ result: 'rejected', detail: 'ask_expired' });
    expect(answers).toHaveLength(0);
    expect(journal.getPendingAsk('j1', 1, 'ask-1f2e3d4c')).toBeNull();
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/runner && bun test src/approvals/approval-relay.spec.ts`
Expected: the new test FAILS (`{ result: 'ok' }`); the others pass.

- [ ] **Step 3: Implement**

In `ApprovalRelay.answer`, right after `if (!ask) return { result: 'rejected', detail: 'ask_not_pending' };`:

```ts
    // Plan D302: nax has already denied an ask past its deadline; recording "ok" for it would be false.
    if (Date.parse(ask.deadlineAt) <= this.deps.now().getTime()) {
      journal.deletePendingAsk(command.jobId, command.leaseEpoch, p.naxAskId);
      return { result: 'rejected', detail: 'ask_expired' };
    }
```

- [ ] **Step 4: Gate the integration spec (D303)**

In `apps/runner/test/integration/approval-relay.integration.spec.ts`:

1. Add `const enabled = process.env['KODA_DB_TESTS'] === '1';` after the imports.
2. Move the top-level `beforeAll` / `afterAll` inside the `describe`, and change the describe line to
   `describe.skipIf(!enabled)('approval relay (S1.5 2a)', () => {`.
3. `afterAll(async () => { await world?.close(); });` (world is unset when skipped).
4. Update the header comment's run line to
   `Run: cd apps/runner && KODA_DB_TESTS=1 bun run test:integration test/integration/approval-relay.integration.spec.ts`.

- [ ] **Step 5: Run the tests**

Run: `cd apps/runner && bun test src/approvals && bun run test:integration test/integration/approval-relay.integration.spec.ts`
Expected: unit PASS; the integration file reports its tests as skipped (no `KODA_DB_TESTS`).
Run: `cd apps/runner && bun run lint && bun run type-check`
Expected: clean.
If the API test database is up, also run `cd apps/runner && KODA_DB_TESTS=1 bun run test:integration test/integration/approval-relay.integration.spec.ts` (it needs `bunx turbo run build --filter=@nathapp/koda-api` first) and expect PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/runner/src/approvals/approval-relay.ts apps/runner/src/approvals/approval-relay.spec.ts apps/runner/test/integration/approval-relay.integration.spec.ts
git commit -m "fix(runner): refuse approval answers past nax's deadline; gate relay integration spec (S1.5 2b, D302, D303)"
```

---

### Task 11: E2E — allow and expire on a relay-capable scripted runner

**Files:**
- Modify: `apps/web/tests/e2e/fixtures/scripted-runner.ts`, `apps/web/tests/e2e/fixtures/fleet-budgets-api.ts`,
  `apps/web/tests/e2e/fixtures/fleet-approvals-api.ts`
- Create: `apps/web/tests/e2e/fleet-bash-approvals.e2e.spec.ts`

**Interfaces:**
- Produces (scripted runner): `ScriptedRunner.enroll(adminToken, name, opts?: { relay?: boolean })`;
  `report()` accepts `type: 'approval_request'`; `takeCommand(type, jobId, ack, timeoutMs?)`; `commandsFor(jobId)`.
  `bashAsk(over?)` in `fleet-approvals-api.ts`; `dispatchRun` accepts `bashMode` and `approvalTimeoutSec`.

- [ ] **Step 1: Extend the scripted runner**

In `apps/web/tests/e2e/fixtures/scripted-runner.ts`:

1. `SyncCommand` becomes:

```ts
interface SyncCommand {
  commandId: string;
  type: 'ASSIGN' | 'CANCEL' | 'READOPT' | 'ABANDON' | 'APPROVAL_ANSWER';
  jobId: string;
  leaseEpoch: number;
  payload: Record<string, unknown>;
}
```

2. `type EventType = 'state' | 'snapshot' | 'lifecycle' | 'log' | 'approval_request';`

3. The class keeps the protocol version it enrolled with:

```ts
  private constructor(
    readonly id: string,
    readonly name: string,
    private readonly apiKey: string,
    private readonly protocolVersion: number,
  ) {}

  /**
   * Issues a single-use enrollment token as the admin and enrolls over HTTP, like `koda-runner enroll`. With `relay`
   * the runner speaks protocol v2 and reports the approval relay (S1.5 2a D271), so gated/escalate jobs place on it.
   */
  static async enroll(adminToken: string, name: string, opts: { relay?: boolean } = {}): Promise<ScriptedRunner> {
    const protocolVersion = opts.relay ? 2 : 1;
    const capabilities = opts.relay ? { ...E2E_RUNNER_CAPABILITIES, approvals: { relay: true } } : E2E_RUNNER_CAPABILITIES;
    const { token } = await call<{ token: string }>('/fleet/enrollments', { method: 'POST', token: adminToken, body: { labels: ['e2e'] } });
    const { runnerId, apiKey } = await call<{ runnerId: string; apiKey: string }>('/fleet/runner/enroll', {
      method: 'POST',
      body: {
        enrollmentToken: token, name, os: 'linux', arch: 'x64', daemonVersion: DAEMON_VERSION,
        protocolVersion, bootId: BOOT_ID, labels: [], capabilities,
      },
    });
    return new ScriptedRunner(runnerId, name, apiKey, protocolVersion);
  }
```

4. In `sync`, replace `protocolVersion: 1,` with `protocolVersion: this.protocolVersion,`.

5. Add after `acceptAssign`:

```ts
  /** Idle syncs until a command of `type` for `jobId` arrives; acks it with `ack` and returns it (S1.5 APPROVAL_ANSWER). */
  async takeCommand(
    type: SyncCommand['type'],
    jobId: string,
    ack: { result: 'ok' | 'rejected'; detail?: string },
    timeoutMs = 15_000,
  ): Promise<SyncCommand> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const reply = await this.sync({});
      const found = reply.commands.find((c) => c.type === type && c.jobId === jobId);
      if (found) {
        await this.sync({ commandAcks: [{ commandId: found.commandId, leaseEpoch: found.leaseEpoch, result: ack.result, ...(ack.detail ? { detail: ack.detail } : {}) }] });
        return found;
      }
    }
    throw new Error(`No ${type} for job ${jobId} within ${timeoutMs} ms`);
  }

  /** One idle sync: the commands the server has for `jobId` right now (none are acked). */
  async commandsFor(jobId: string): Promise<SyncCommand[]> {
    return (await this.sync({})).commands.filter((c) => c.jobId === jobId);
  }
```

In `apps/web/tests/e2e/fixtures/fleet-budgets-api.ts`, widen `dispatchRun`'s input to
`input: { repoId: string; feature: string; maxCostUsd: number; pinnedRunnerId: string; bashMode?: 'raw' | 'gated' | 'escalate'; approvalTimeoutSec?: number }`.

In `apps/web/tests/e2e/fixtures/fleet-approvals-api.ts`, add:

```ts
import { randomBytes } from 'node:crypto';

export interface BashApprovalRow extends ApprovalRow {
  jobId: string | null;
  expiresAt: string | null;
}

/** A real-shaped relayed ask (2a ApprovalRequestEventPayload); `deadlineAt` 10 minutes out unless overridden. */
export function bashAsk(over: Record<string, unknown> = {}): Record<string, unknown> & { naxAskId: string; command: string } {
  return {
    naxAskId: `ask-${randomBytes(4).toString('hex')}`,
    deadlineAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    command: 'git push --force origin HEAD',
    commandTruncated: false,
    maskedCount: 1,
    root: '/work/e2e-app',
    stage: 'execution',
    storyId: 'US-001',
    featureName: 'bash-e2e',
    reason: 'not covered by the stage grants',
    options: ['allow', 'allow-remember', 'deny'],
    ...over,
  } as Record<string, unknown> & { naxAskId: string; command: string };
}

/** Every approval of one job (2a `jobId` filter). */
export async function jobApprovals(token: string, slug: string, jobId: string): Promise<BashApprovalRow[]> {
  const page = await call<{ records: BashApprovalRow[] }>('GET', `/projects/${slug}/fleet/approvals?jobId=${jobId}&size=100`, token);
  return page.records;
}
```

- [ ] **Step 2: Write the spec**

Create `apps/web/tests/e2e/fleet-bash-approvals.e2e.spec.ts`:

```ts
import { test, expect } from '@playwright/test';
import { login, E2E_ADMIN } from './fixtures/api-client';
import { bashAsk, jobApprovals } from './fixtures/fleet-approvals-api';
import { dispatchRun, repoIdOf } from './fixtures/fleet-budgets-api';
import { waitForHydration, webLogin } from './fixtures/page-helpers';
import { ScriptedRunner, type Lease } from './fixtures/scripted-runner';

/**
 * Fleet S1.5 slice 2b (plan D305, spec §7 E2E (2) and (3)): a relay-capable scripted runner raises bash asks for an
 * escalate job. (2) A human allows one from the inbox and the runner receives the answer; (3) an unanswered ask expires.
 * API polls stay at one request per 2 s: the global throttle is 100 requests a minute (only /fleet/runner/* is exempt).
 * Project `fleet-e2e` and repo acme/e2e-app come from prisma/seed-e2e.ts.
 */
const SLUG = 'fleet-e2e';
const POLL = { intervals: [2_000] };

test.describe('Fleet bash approvals (scripted relay runner)', () => {
  let token = '';
  let runner: ScriptedRunner;
  let repoId = '';
  const suffix = Date.now().toString().slice(-6);

  test.beforeAll(async () => {
    const session = await login(E2E_ADMIN.email, E2E_ADMIN.password);
    token = session.token;
    runner = await ScriptedRunner.enroll(token, `e2e-relay-runner-${suffix}`, { relay: true });
    repoId = await repoIdOf(token, SLUG, 'acme/e2e-app');
  });

  async function startEscalateJob(feature: string, approvalTimeoutSec: number): Promise<{ jobId: string; lease: Lease }> {
    await runner.heartbeat();
    const jobId = await dispatchRun(token, SLUG, { repoId, feature, maxCostUsd: 3, pinnedRunnerId: runner.id, bashMode: 'escalate', approvalTimeoutSec });
    const lease = await runner.acceptAssign(jobId);
    await runner.report(lease, [{ type: 'state', payload: { to: 'RUNNING' } }]);
    return { jobId, lease };
  }

  async function finish(lease: Lease, feature: string, pr: number): Promise<void> {
    await runner.report(lease, [{ type: 'state', payload: { to: 'UPLOADING' } }]);
    await runner.uploadBundle(lease, `bundle of ${lease.jobId}`);
    await runner.report(lease, [
      { type: 'snapshot', payload: { finishResult: 'opened', resultBranch: `feat/${feature}`, resultPrUrl: `https://github.com/acme/e2e-app/pull/${pr}`, costSpentUsd: '0.1000' } },
      { type: 'state', payload: { to: 'COMPLETED', exitCode: 0 } },
    ]);
  }

  test('(2) an escalate ask is allowed in the web, delivered to the runner, and the job completes', async ({ page }) => {
    test.setTimeout(150_000);
    const feature = `bash-allow-${suffix}`;
    const { jobId, lease } = await startEscalateJob(feature, 600);
    const ask = bashAsk({ featureName: feature });
    await runner.report(lease, [{ type: 'approval_request', payload: ask }]);
    await expect.poll(async () => (await jobApprovals(token, SLUG, jobId)).filter((a) => a.status === 'pending').length, { timeout: 20_000, ...POLL }).toBe(1);
    const [approval] = await jobApprovals(token, SLUG, jobId);

    // The jobs list marks the job; the job page calls it out and Review opens the inbox row.
    await webLogin(page);
    await page.goto(`/${SLUG}/fleet`);
    await waitForHydration(page);
    await expect(page.getByTestId(`fleet-job-needs-approval-${jobId}`)).toBeVisible();
    await page.goto(`/${SLUG}/fleet/jobs/${jobId}`);
    await waitForHydration(page);
    await expect(page.getByTestId('fleet-job-approval-callout')).toContainText('1');
    await page.getByTestId('fleet-job-approval-review').click();
    await page.waitForURL(new RegExp(`/${SLUG}/fleet/approvals\\?id=${approval.id}$`));
    await waitForHydration(page);

    // The row shows the masked command, the masked note and the countdown; Allow once decides it.
    const row = page.getByTestId(`fleet-approval-row-${approval.id}`);
    await expect(row.getByTestId('fleet-approval-bash-command')).toHaveText(ask.command);
    await expect(row.getByTestId('fleet-approval-bash-masked')).toBeVisible();
    await expect(row.getByTestId('fleet-approval-countdown')).toBeVisible();
    await row.getByTestId('fleet-approval-bash-allow').click();
    await expect(row.getByTestId('fleet-approval-outcome-decision')).toContainText('Allowed once');
    await expect(row.getByTestId('fleet-approval-outcome-delivery')).toHaveAttribute('data-delivery', 'waiting');

    // The runner receives exactly the human's answer and acks it; the reloaded row reads delivered.
    const answer = await runner.takeCommand('APPROVAL_ANSWER', jobId, { result: 'ok' });
    expect(answer.payload).toEqual({ approvalId: approval.id, naxAskId: ask.naxAskId, choice: 'allow' });
    await page.reload();
    await waitForHydration(page);
    await expect(row.getByTestId('fleet-approval-outcome-delivery')).toHaveAttribute('data-delivery', 'delivered', { timeout: 10_000 });

    // The job completes; its page lists the ask as approved and the timeline shows it was requested.
    await finish(lease, feature, 21);
    await page.goto(`/${SLUG}/fleet/jobs/${jobId}`);
    await waitForHydration(page);
    await expect(page.getByTestId(`fleet-job-approval-${approval.id}`)).toHaveAttribute('data-status', 'approved');
    await expect(page.getByTestId('fleet-job-approval-callout')).toHaveCount(0);
    await expect(page.getByTestId('fleet-job-timeline')).toContainText(`Approval requested: ${ask.command}`);
  });

  test('(3) an unanswered ask times out: buttons disappear at 0, the row expires, no answer reaches the runner', async ({ page }) => {
    test.setTimeout(150_000);
    const feature = `bash-expire-${suffix}`;
    const { jobId, lease } = await startEscalateJob(feature, 30);
    // expiresAt = min(nax deadline, requestedAt + 30 s): the 20 s deadline wins.
    const ask = bashAsk({ featureName: feature, deadlineAt: new Date(Date.now() + 20_000).toISOString() });
    await runner.report(lease, [{ type: 'approval_request', payload: ask }]);
    await expect.poll(async () => (await jobApprovals(token, SLUG, jobId)).length, { timeout: 10_000, ...POLL }).toBe(1);
    const [approval] = await jobApprovals(token, SLUG, jobId);

    await webLogin(page);
    await page.goto(`/${SLUG}/fleet/approvals?id=${approval.id}`);
    await waitForHydration(page);
    const row = page.getByTestId(`fleet-approval-row-${approval.id}`);
    await expect(row.getByTestId('fleet-approval-bash-deny')).toBeVisible();
    // At 0 the panel stops offering a decision before the server sweep runs (D292).
    await expect(row.getByTestId('fleet-approval-bash-deny')).toHaveCount(0, { timeout: 25_000 });
    await expect(row.getByTestId('fleet-approval-bash-countdown')).toContainText('timed out');

    // The 15 s sweeper marks it expired; the reloaded row reads Expired, Timed out.
    await expect.poll(async () => (await jobApprovals(token, SLUG, jobId))[0]?.status, { timeout: 45_000, ...POLL }).toBe('expired');
    await page.reload();
    await waitForHydration(page);
    await expect(row).toHaveAttribute('data-status', 'expired');
    await expect(row.getByTestId('fleet-approval-outcome-decision')).toContainText('Timed out');
    expect((await runner.commandsFor(jobId)).filter((c) => c.type === 'APPROVAL_ANSWER')).toEqual([]);

    await finish(lease, feature, 22);
  });
});
```

- [ ] **Step 3: Run the E2E specs**

Run: `cd apps/web && bun run test:e2e -- tests/e2e/fleet-bash-approvals.e2e.spec.ts tests/e2e/fleet-approvals.e2e.spec.ts tests/e2e/fleet-dispatch.e2e.spec.ts tests/e2e/fleet-schedules.e2e.spec.ts`
Expected: all PASS. (The 1b approvals spec still enrolls a v1 runner; the dispatch and schedules specs exercise the
changed forms with raw defaults.)

If (2) fails at `toHaveText(ask.command)` because the row is not expanded, check that `?id=` survived the `Review` link
(the callout href must be `inboxPath(...)` with the id). If (3) fails at the sweep poll, confirm the e2e API runs with
sweeps on: `FLEET_SWEEP_ENABLED` is unset there and `NODE_ENV` is not `test`, so `sweepEnabled` defaults to true
(`apps/api/src/config/fleet.config.ts`).

- [ ] **Step 4: Commit**

```bash
git add apps/web/tests/e2e
git commit -m "test(web): e2e bash ask allowed and expired on a relay scripted runner (S1.5 2b, D305)"
```

---

### Task 12: Docs and the full gate run

**Files:**
- Modify: `docs/deployment/runner.md`, `docs/superpowers/specs/2026-10-02-fleet-s1-5-approvals-design.md`

- [ ] **Step 1: Operator notes**

In `docs/deployment/runner.md`, section "Bash approvals (S1.5)", append:

```markdown
- Choose the mode per job: the web dispatch form and schedule dialog have a "Shell command approvals" select (RUN only)
  and an ask timeout in minutes; the CLI takes `--bash-mode gated|escalate` and `--approval-timeout <seconds>` on
  `koda fleet dispatch`, `koda fleet schedule add` and `schedule edit`.
- Answer asks in the project's approvals inbox (`/<project>/fleet/approvals`) or with
  `koda fleet approval decide <id> allow|allow_for_job|deny`. Project developers and admins may answer; the job page
  shows "Waiting for approval" while an ask is open, and the inbox shows whether the runner delivered the answer.
- An answer that reaches the runner after nax's deadline is not sent (`ask_expired`): nax has already denied it.
```

In the CLI examples block (the one with `koda fleet dispatch --repo acme/app ...`), add:

```bash
koda fleet dispatch --repo acme/app --feature login --max-cost 5 --bash-mode escalate --approval-timeout 900
```

- [ ] **Step 2: Spec plan notes**

In `docs/superpowers/specs/2026-10-02-fleet-s1-5-approvals-design.md` §8, after the 2a plan notes bullet, add:

```markdown
- 2b plan notes (`docs/superpowers/plans/2026-10-03-fleet-s1-5-slice-2b-bash-approvals-web.md`, D288-D306): no API
  change; bash asks are decided by DEVELOPER+ in the inbox only (the job page links there); a cut or unreadable ask is
  deny-only and the panel hides its buttons when the countdown reaches 0; the delivery line re-fetches the open row on
  each reload because acks have no live event; web timeouts are minutes with 2 decimals (exact round trip of stored
  seconds), the CLI takes seconds; a raw schedule PATCH omits the timeout; the runner refuses answers past nax's
  deadline (`ask_expired`).
```

- [ ] **Step 3: Full gates**

Run each; every one must pass before the PR (report any failure with its output; do not skip):

```bash
cd apps/web && bun run lint && bun run type-check && bun run test
cd ../cli && bun run lint && bun run type-check && bun run test
cd ../runner && bun run lint && bun run type-check && bun run test
cd ../.. && git diff --stat main -- apps/api openapi.json apps/cli/src/generated
```

Expected: all green; the last command prints nothing (D288).

- [ ] **Step 4: Commit**

```bash
git add docs/deployment/runner.md docs/superpowers/specs/2026-10-02-fleet-s1-5-approvals-design.md
git commit -m "docs(fleet): S1.5 2b operator notes and plan notes"
```

---

### Task 13: Live check (human-run, billed — approval at launch)

Not for a subagent. Run only after Tasks 1-12 are merged-ready and the user approves the launch (D306).

**Prerequisites:** local koda API + web from this branch with a database; a GitHub App configured and installed on a
throwaway test repo registered as a fleet repo (runner git is brokered, R5) — if this is not available, report the live
check as **blocked** in the PR and stop; nax >= 0.83.1 on this machine with a working provider credential
(`nax auth list`); the test repo's `.nax/config.json` has a `Bash(...)` allow rule for the execution stage (for example
`Bash(bun test:*)`) so that stage gets the Bash tool, and a tiny feature whose story makes the agent run two commands
outside that grant (for example `ls -la /tmp` and `cat /etc/hosts`).

- [ ] **Step 1:** Enroll one local runner against the local API (`koda-runner enroll` with an admin token) and start it;
  `koda fleet runner list` shows it online with the relay capability.
- [ ] **Step 2 (billed, approval at launch):** `koda fleet dispatch --repo <owner/name> --feature <feature> --max-cost 1
  --bash-mode escalate --approval-timeout 900 --pin <runner>`.
- [ ] **Step 3:** When the first ask appears in the inbox, **Allow once**; when the second appears, **Deny**. Both rows
  show "Delivered to nax".
- [ ] **Step 4:** After the job ends, compare the job page's Approvals section with
  `<job outputDir>/approval-audit/<runId>.jsonl` on the runner: two entries, decisions allow and deny, `decidedBy`
  koda, same commands.
- [ ] **Step 5:** Record the outcome (job id, cost, both decisions, audit lines, anything odd) in the PR body under
  "Live check".
