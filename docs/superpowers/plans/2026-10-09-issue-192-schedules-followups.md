# Issue #192 Schedules Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the five deferred follow-ups from PR #191 tracked in GitHub issue #192 (schedules web polish + one API test-hook behavior).

**Architecture:** Four independent web fixes (stale-load guard, read-only line gating, history queued-at zone, i18n parity pin) and one API fix (test-hook refuses a disabled schedule with 409). No schema, no OpenAPI change: the test-hook controller is `@ApiExcludeController()`, so `openapi.json` stays untouched and no CLI regeneration is needed.

**Tech Stack:** NestJS 11 + `@nathapp/nestjs-common` (API); Nuxt 3 + Vue 3 + Jest (web); Jest (API unit specs).

**Spec:** GitHub issue #192 — `fix(web): S1b slice 3b follow-ups (schedules web polish)` (nathapp-io/koda#192). The five checklist items are the requirements; this plan numbers them item 1–5 in issue order.

## Global Constraints

- API user-facing strings go through `apps/api/src/i18n/{en,zh}/*.json`; web strings through `apps/web/i18n/locales/{en,zh}.json`. Both locales change in the same task.
- API unit specs are co-located `src/**/*.spec.ts`; web tests live under `apps/web/tests/`.
- Never edit `openapi.json` or `apps/cli/src/generated/` by hand (nothing here changes them).
- TypeScript strict; web ESLint import style: value import and `import type` as separate lines.
- Scoped test commands: API unit spec — from `apps/api`: `bun run test:scoped <path>`; web spec — from `apps/web`: `npx jest <path>`.
- Commit style: `fix(api): ...` / `fix(web): ...`.

## Review Focus

1. A detail-page poll GET that completes **after** a local enable/disable must not re-show the pre-mutation row — pinned by Task 2's deferred-get test in `useFleetSchedules.spec.ts`.
2. Read-only line truth: shown to a viewer and to a developer who owns no schedule; hidden from an owning developer and from an admin even when the list is empty — pinned by Task 3's three list-page tests.
3. A test-hook fire on a **disabled** schedule must answer 409 with a localized message, never a zero tally — pinned by Task 1's spec test.
4. `queuedAt` with a zone the runtime does not know must fall back to UTC, not throw — Task 4 routes through `formatInZone`, whose fallback is already pinned at `apps/web/tests/lib/fleet-schedules.spec.ts:190-193`; Task 4's component test pins that the history cell actually uses it.
5. The `fleet.jobs.detail.wipPush` locale subtree must match exactly the three keys `wipPushStatus` can produce (`pushed`, `none`, `failed`) — pinned by Task 5's ENUMS entry.

---

### Task 1: API — test-hook fire refuses a disabled schedule (item 3)

**Files:**
- Modify: `apps/api/src/fleet/schedules/fleet-test-hooks.controller.ts` (after the not-found check, ~line 31)
- Modify: `apps/api/src/fleet/schedules/fleet-test-hooks.controller.spec.ts`
- Modify: `apps/api/src/i18n/en/fleet.json`, `apps/api/src/i18n/zh/fleet.json`

**Interfaces:**
- Consumes: `ScheduleRecord.enabled: boolean` from `IScheduleRepository.findById` (`apps/api/src/fleet/schedules/domain/schedule.domain.ts:35`); `ConflictAppException(args, prefix)` from `../common/exceptions/conflict-app.exception` (HTTP 409).
- Produces: `POST fleet/test-hooks/schedules/:id/fire` now rejects with `ConflictAppException({}, 'fleet.scheduleDisabled')` when `schedule.enabled === false`. No other caller depends on the old zero-tally behavior (the E2E fixture only fires enabled schedules).

- [ ] **Step 1: Write the failing tests in `fleet-test-hooks.controller.spec.ts`.** Change `build` to `function build(hooksEnabled: boolean, found = true, scheduleEnabled = true)` — the repo mock becomes `{ findById: jest.fn(async () => (found ? { id: 's1', nextFireAt: DUE, enabled: scheduleEnabled } : null)) }` and the third constructor arg stays `{ testHooksEnabled: hooksEnabled }`. Add the import `import { ConflictAppException } from '../common/exceptions/conflict-app.exception';` and the test:

```ts
it('refuses a disabled schedule with 409 and runs no ticker round', async () => {
  const h = build(true, true, false);
  await expect(h.controller.fire('s1')).rejects.toBeInstanceOf(ConflictAppException);
  expect(h.ticker.tick).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the spec to verify the new test fails.** From `apps/api`: `bun run test:scoped src/fleet/schedules/fleet-test-hooks.controller.spec.ts`. Expected: the new test fails (fire resolves with the tally instead of rejecting); the three existing tests pass.
- [ ] **Step 3: Implement in `fleet-test-hooks.controller.ts`.** After `if (!schedule) throw new NotFoundAppException(...)` add `if (!schedule.enabled) throw new ConflictAppException({}, 'fleet.scheduleDisabled');` and import `ConflictAppException` from `../../common/exceptions/conflict-app.exception`. Add the i18n entries next to `scheduleOwnerNoAccess` in both files:
  - `apps/api/src/i18n/en/fleet.json`: `"scheduleDisabled": { "409": "This schedule is disabled; enable it before firing" },`
  - `apps/api/src/i18n/zh/fleet.json`: `"scheduleDisabled": { "409": "该计划已停用；启用后才能触发" },`
- [ ] **Step 4: Run the spec again.** From `apps/api`: `bun run test:scoped src/fleet/schedules/fleet-test-hooks.controller.spec.ts`. Expected: 4 passed.
- [ ] **Step 5: Commit.**

```bash
git add apps/api/src/fleet/schedules/fleet-test-hooks.controller.ts apps/api/src/fleet/schedules/fleet-test-hooks.controller.spec.ts apps/api/src/i18n/en/fleet.json apps/api/src/i18n/zh/fleet.json
git commit -m "fix(api): test-hook fire refuses a disabled schedule with 409 (#192 item 3)"
```

---

### Task 2: Web — stale-response guard on the schedule detail page (item 1)

**Files:**
- Modify: `apps/web/composables/useFleetSchedules.ts:29`
- Modify: `apps/web/tests/composables/useFleetSchedules.spec.ts`
- Modify: `apps/web/pages/[project]/fleet/schedules/[id].vue:62-77` (`loadSchedule`)
- Modify: `apps/web/tests/pages/fleet-schedule-detail.spec.ts`

**Interfaces:**
- Consumes: the module-level `mutationEpoch` already in `useFleetSchedules.ts:13` (bumped by `apply` and `remove`).
- Produces: `get(id: string): Promise<ScheduleDto | null>` — `null` means "stale: a mutation landed while this GET was in flight; keep what is on screen". The detail page is the only caller of `get`.

- [ ] **Step 1: Write the failing test in `useFleetSchedules.spec.ts`** (the file already has `deferred`, `withApi`, and the `row` factory):

```ts
test('a get that started before a mutation resolves null (D224)', async () => {
  const slow = deferred<ScheduleDto>()
  const get = jest.fn(() => slow.promise)
  withApi({ get, post: jest.fn(async () => row('a', 'alpha', { enabled: false })) })
  const { useFleetSchedules } = await import(composablePath)
  const s = useFleetSchedules('koda')
  const loading = s.get('a')
  await s.disable('a')
  slow.resolve(row('a', 'alpha', { enabled: true }))
  expect(await loading).toBeNull()
})
```

- [ ] **Step 2: Run it to verify it fails.** From `apps/web`: `npx jest tests/composables/useFleetSchedules.spec.ts`. Expected: the new test fails (it resolves the row); the existing tests pass.
- [ ] **Step 3: Implement `get` in `useFleetSchedules.ts`** — capture the epoch before the request, drop the answer when a mutation landed meanwhile (same reasoning as `load`, D224):

```ts
const get = async (id: string): Promise<ScheduleDto | null> => {
  const epoch = mutationEpoch
  const row = await $api.get<ScheduleDto>(scheduleItem(slug, id))
  return epoch === mutationEpoch ? row : null
}
```

- [ ] **Step 4: Run the composable spec.** From `apps/web`: `npx jest tests/composables/useFleetSchedules.spec.ts`. Expected: all tests pass.
- [ ] **Step 5: Update `loadSchedule` in `[id].vue`** — inside the `try`, replace the single assignment with:

```ts
const row = await api.get(scheduleId)
if (row === null) return
schedule.value = row
loadFailed.value = false
```

The `catch` and `finally` blocks stay exactly as they are (a stale load keeps the current row and never trips the error state).
- [ ] **Step 6: Add the pin to `fleet-schedule-detail.spec.ts`** (source-scan style, like its other tests):

```ts
test('a stale detail load (get resolved null) keeps the row on screen (D224)', () => {
  expect(detail).toContain('const row = await api.get(scheduleId)')
  expect(detail).toContain('if (row === null) return')
})
```

- [ ] **Step 7: Run the detail spec.** From `apps/web`: `npx jest tests/pages/fleet-schedule-detail.spec.ts`. Expected: all tests pass (the existing `reload`/catch regexes still match).
- [ ] **Step 8: Commit.**

```bash
git add apps/web/composables/useFleetSchedules.ts apps/web/tests/composables/useFleetSchedules.spec.ts "apps/web/pages/[project]/fleet/schedules/[id].vue" apps/web/tests/pages/fleet-schedule-detail.spec.ts
git commit -m "fix(web): drop stale schedule detail loads across mutations (#192 item 1)"
```

---

### Task 3: Web — read-only line hidden from owning developers (item 2)

**Files:**
- Modify: `apps/web/pages/[project]/fleet/schedules/index.vue` (line 9 import, line 114 `v-if`)
- Modify: `apps/web/tests/pages/fleet-schedules-list-page.spec.ts`

**Interfaces:**
- Consumes: `canChangeSchedule(s: Pick<ScheduleDto, 'createdById'>, viewer: ScheduleViewer): boolean` from `~/lib/fleet-schedules` (already the gate for row buttons in `FleetScheduleTable`).
- Produces: nothing other tasks use.

- [ ] **Step 1: Write the failing tests in `fleet-schedules-list-page.spec.ts`.** In the existing test `'a developer creates, and changes only their own schedule (Review Focus 2)'` (the developer owns row `a`), replace the line-96 assertion with `expect(m.app.text()).not.toContain('Only the schedule owner or a project administrator can change a schedule.')`. Add two tests:

```ts
test('a developer who owns no schedule sees the read-only line', async () => {
  const m = mountList([schedule('b', { createdById: 'someone-else' })], DEVELOPER)
  await m.settle()
  expect(m.app.text()).toContain('Only the schedule owner or a project administrator can change a schedule.')
  m.app.unmount()
})

test('an admin with no schedules sees no read-only line', async () => {
  const m = mountList([], ADMIN)
  await m.settle()
  expect(m.app.text()).not.toContain('Only the schedule owner or a project administrator can change a schedule.')
  m.app.unmount()
})
```

- [ ] **Step 2: Run to verify the changed/new assertions fail.** From `apps/web`: `npx jest tests/pages/fleet-schedules-list-page.spec.ts`. Expected: the developer-owns test and the admin-empty test fail; the viewer test still passes.
- [ ] **Step 3: Implement in `index.vue`.** Add the value import `import { canChangeSchedule } from '~/lib/fleet-schedules'` (keep the existing `import type { ScheduleViewer }` line separate). Change line 114's condition to:

```html
<p v-if="!viewer.canManage && !forbidden && !api.schedules.value.some((s) => canChangeSchedule(s, viewer))" class="text-sm text-muted-foreground" data-testid="fleet-schedule-readonly">{{ t('fleet.schedules.readOnly') }}</p>
```

(`viewer` is a computed ref; the template unwraps it. No i18n copy change — the line keeps `fleet.schedules.readOnly` in both locales.)
- [ ] **Step 4: Run the list spec.** From `apps/web`: `npx jest tests/pages/fleet-schedules-list-page.spec.ts`. Expected: all tests pass, including the untouched viewer and admin-with-rows tests.
- [ ] **Step 5: Commit.**

```bash
git add "apps/web/pages/[project]/fleet/schedules/index.vue" apps/web/tests/pages/fleet-schedules-list-page.spec.ts
git commit -m "fix(web): hide the schedules read-only line from members who can change one (#192 item 2)"
```

---

### Task 4: Web — history queued-at in the schedule's zone (item 5)

**Files:**
- Modify: `apps/web/components/fleet/ScheduleHistory.vue` (line 30 cell, props, import)
- Modify: `apps/web/pages/[project]/fleet/schedules/[id].vue:189`
- Modify: `apps/web/tests/pages/fleet-schedule-detail.spec.ts` (line 17 assertion + new test)

**Interfaces:**
- Consumes: `formatInZone(iso: string | null, timeZone: string, locale?: string): string` from `~/lib/fleet-schedules` (already used for next/last fire on the same page; unknown zone falls back to UTC).
- Produces: `ScheduleHistory` props become `{ slug: string; rows: HistoryRow[]; timezone: string }`. Run after Task 2 — both touch `[id].vue` and the detail spec.

- [ ] **Step 1: Write the failing tests in `fleet-schedule-detail.spec.ts`.** Change the line-17 assertion to `expect(detail).toContain('<FleetScheduleHistory :slug="slug" :rows="rows" :timezone="schedule.timezone" />')` and add:

```ts
test('history queued-at renders in the schedule zone (issue #192 item 5)', () => {
  const history = readFileSync(path.join(__dirname, '../..', 'components', 'fleet', 'ScheduleHistory.vue'), 'utf-8')
  expect(history).toContain('formatInZone(row.job.queuedAt, timezone)')
  expect(history).not.toContain('toLocaleString')
})
```

- [ ] **Step 2: Run to verify they fail.** From `apps/web`: `npx jest tests/pages/fleet-schedule-detail.spec.ts`. Expected: both assertions fail.
- [ ] **Step 3: Implement in `ScheduleHistory.vue`.** Widen props to `defineProps<{ slug: string; rows: HistoryRow[]; timezone: string }>()`; extend the existing import to `import { formatDelta, formatInZone } from '~/lib/fleet-schedules'`; replace the queued cell body with `{{ formatInZone(row.job.queuedAt, timezone) }}` (keep the cell's classes).
- [ ] **Step 4: Pass the zone from the detail page.** Change line 189 to `<FleetScheduleHistory :slug="slug" :rows="rows" :timezone="schedule.timezone" />`.
- [ ] **Step 5: Run the detail spec.** From `apps/web`: `npx jest tests/pages/fleet-schedule-detail.spec.ts`. Expected: all tests pass. (The E2E `fleet-schedules.e2e.spec.ts` asserts no queued-at cell content, so it needs no change.)
- [ ] **Step 6: Commit.**

```bash
git add apps/web/components/fleet/ScheduleHistory.vue "apps/web/pages/[project]/fleet/schedules/[id].vue" apps/web/tests/pages/fleet-schedule-detail.spec.ts
git commit -m "fix(web): schedule history queued-at follows the schedule zone (#192 item 5)"
```

---

### Task 5: Web — pin `fleet.jobs.detail.wipPush` in the i18n parity ENUMS (item 4)

**Files:**
- Modify: `apps/web/tests/i18n/fleet-locale-parity.spec.ts` (ENUMS table, after the `fleet.jobs.detail.pipeline.view` entry, ~line 75)

**Interfaces:**
- Consumes: the existing locale subtrees `fleet.jobs.detail.wipPush` in `apps/web/i18n/locales/en.json:1355-1359` and `zh.json:1355-1359` (keys `pushed`, `none`, `failed`), and `wipPushStatus` in `apps/web/lib/fleet-jobs.ts:81-85`, which can only ever produce those three keys.
- Produces: nothing other tasks use.

- [ ] **Step 1: Add the ENUMS entry** (this is a pin of existing behavior, so it is written to pass):

```ts
'fleet.jobs.detail.wipPush': ['pushed', 'none', 'failed'],
```

- [ ] **Step 2: Run the parity spec.** From `apps/web`: `npx jest tests/i18n/fleet-locale-parity.spec.ts`. Expected: all tests pass, including the new `'fleet.jobs.detail.wipPush covers exactly the API values'` case. If it fails, the locale subtrees drifted from the three keys — fix the JSON (both locales), not the ENUMS list.
- [ ] **Step 3: Full verification of the whole branch.** From the repo root: `bun run test`, then `bun run lint`, then `bun run type-check`. Expected: all green. Fix anything they surface within the owning task's scope.
- [ ] **Step 4: Commit.**

```bash
git add apps/web/tests/i18n/fleet-locale-parity.spec.ts
git commit -m "test(web): pin fleet.jobs.detail.wipPush keys in the locale parity ENUMS (#192 item 4)"
```

---

## Self-review notes

- Coverage: issue items 1–5 map to Tasks 2, 3, 1, 5, 4 respectively; nothing in the issue is unimplemented.
- Item 5 was a decision point ("decide whether queued-at should follow the schedule zone"): this plan decides **yes** — the history table sits under next/last fire rows already rendered in the schedule zone (D220), so `queuedAt` follows the schedule zone via `formatInZone`.
- `fleet-schedule-detail.spec.ts` is touched by Tasks 2 and 4; run them in that order.
