# Fleet S1b Slice 3b — Schedules Web Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Project members see their project's cron schedules on `/:project/fleet/schedules` and each schedule's
template, cumulative cost and run history on `/:project/fleet/schedules/:id`; project DEVELOPERs create schedules there,
and the owner or a project ADMIN edits, enables, disables and deletes them. A Playwright E2E proves the whole loop:
create in the web, fire, a scripted runner completes the job, the schedule shows disabled with `completed`.

**Architecture:** Same shape as slice 2b. A pure library (`lib/fleet-schedules.ts`: form schema and bodies, cron and
timezone checks, display in the schedule's zone, permissions, history rows with the stories-passed delta), a transport
composable (`useFleetSchedules(slug)`, list + mutation epoch), an actions composable (`useFleetScheduleActions`: enable,
disable, delete with toasts and stale reload), one create/edit dialog, one table, one history component, and two thin
pages. The run history reuses `useFleetJobs(slug).load({ scheduleId })` (3a D205). The only API change is a test-only,
env-gated, global-ADMIN hook that runs one ticker round at a schedule's `nextFireAt` (D213), excluded from OpenAPI.

**Tech Stack:** Nuxt 3 + Vue 3 `<script setup>`, shadcn-vue primitives, `vee-validate` + `zod`, `useApi` (`$api`),
`Intl.DateTimeFormat` (zone display, no new dependency), Jest with the `mountSfc` harness, Playwright with the scripted
runner, `vue-i18n` (en + zh); NestJS for the hook.

**Spec:** `docs/superpowers/specs/2026-10-01-fleet-s1b-budgets-schedules-design.md` §3.4 (Web bullets), §3.5 (3b web unit
and E2E), §4, §5 (slice 3b); backend contract from `docs/superpowers/plans/2026-10-02-fleet-s1b-slice-3a-schedules-backend.md`
(D190-D212) and the merged code in `apps/api/src/fleet/schedules/`. UI patterns from
`docs/superpowers/plans/2026-10-02-fleet-s1b-slice-2b-budgets-web.md` (D173-D189).

## Global Constraints

- Routes (3a): `GET|POST /projects/:slug/fleet/schedules`, `GET|PATCH|DELETE /projects/:slug/fleet/schedules/:id`,
  `POST .../:id/enable`, `POST .../:id/disable`. The list is a **plain array** (D202). Delete answers **204** and keeps
  the jobs (D194). Enable of a schedule whose owner lost access answers **409 `fleet.scheduleOwnerNoAccess`** (D211). An
  unknown id answers 404 `fleet.schedules`. A cron that fires closer than 15 minutes answers 400
  `fleet.scheduleCronTooFrequent`; other bad input answers 400 `fleet.scheduleInput` with a reason.
- `ScheduleDto`: `id, projectId, repoId, name, cron, timezone, feature, ref, profiles, maxCostUsd (decimal string),
  selectorLabels, pinnedRunnerId, enabled, nextFireAt (null while disabled), lastFiredAt, lastJobId, lastPassedCount,
  noProgressTicks, noProgressLimit, disabledReason (completed | finish_failed | no_progress | owner_lost_access |
  template_invalid | manual | null), totalCostUsd (decimal string), createdById, updatedById, createdAt, updatedAt`.
- Create body (`CreateScheduleDto`): `name` 1-80 non-blank; `repoId`; `feature` (nax feature name); `cron` five fields,
  length 9-100; `timezone` IANA (aliases canonicalised, fixed offsets such as `+08:00` refused); `ref?` (blank = repo
  default branch); `profiles?` max 8; `maxCostUsd` number > 0, max 4 decimals, max **10,000**; `selectorLabels?` max 16;
  `pinnedRunnerId?`; `noProgressLimit?` integer **1-20**, default **3**.
- Patch body (`UpdateScheduleDto`, D203): repo and feature are **fixed**; every other field optional; `ref` when sent is
  1-255 (cannot be blanked); `profiles: []` / `selectorLabels: []` clear; `pinnedRunnerId: null` unpins.
- Permissions (3a D202): any project member reads; create needs project DEVELOPER+; edit, enable, disable and delete need
  DEVELOPER+ **and** the owner (`createdById`) or a project ADMIN (a global ADMIN counts as project ADMIN). The server is
  the gate; the web hides controls and shows the server's translated message on any refusal.
- Job API (3a D205): `FleetJobDto` carries `scheduleId: string | null` and `coalescedCount: number`; `GET
  /projects/:slug/fleet/jobs?scheduleId=<id>` filters; jobs are ordered `queuedAt desc, id desc`.
- Web conventions (`.nax/rules/web.md`): API calls only through composables with `useApi()`; `useAppToast()` +
  `extractApiError()` for errors; forms use `vee-validate` + `zod` with i18n messages; no hardcoded UI strings; semantic
  Tailwind tokens only; no raw `$fetch`; selects are native (`FleetNativeSelect`, 4b D137).
- i18n: every key in both `apps/web/i18n/locales/en.json` and `zh.json`; no `|` or `@` in any `fleet.*` message (parity
  spec); dynamic keys are listed in the enum table of `tests/i18n/fleet-locale-parity.spec.ts`.
- `openapi.json` and the generated CLI client must not change: the hook is `@ApiExcludeController()`. `bun run generate`
  (repo root) is run once as a no-diff check.
- Web tests: `cd apps/web && bun run test -- <path>`. API unit: `cd apps/api && bun run test:scoped <path>`; API
  integration (Postgres up, `bun run test:db:up` in `apps/api`): `cd apps/api && KODA_DB_TESTS=1 bun run test:scoped
  <path>`. Never run bare `bun test` at the repo root. Lint `bun run lint` and types `bun run type-check` in each app.
- No emojis in source; no `console.log`; no `eslint-disable`; no hand edits under `*/generated/`; conventional commits;
  never push, never open a PR.
- New composables are imported **explicitly** (`import { useFleetSchedules } from '~/composables/useFleetSchedules'`)
  so the jest harness resolves them. A new `components/fleet/ScheduleTable.vue` is `FleetScheduleTable` in templates.

## Decisions

Numbered D213-D225 (slice 3a ended at D212).

| # | Decision | Why |
|:--|:--|:--|
| D213 | **Test-only fire hook** `POST /api/fleet/test-hooks/schedules/:id/fire` runs `ScheduleTicker.tick(schedule.nextFireAt)` and returns `{ firedAt, result: TickResult }`. Active only when `FLEET_TEST_HOOKS=true` **and** `NODE_ENV !== 'production'` (else 404 `fleet.schedules`); global ADMIN only (`@RequiredPermission('ADMIN')`); `@ApiExcludeController()` so `openapi.json` and the CLI client are unchanged. Playwright's API server sets `FLEET_TEST_HOOKS=true`. | Spec §3.5 asks for "a test-only hook or a short cron with the fake clock". A short cron is impossible (3a's 15-minute gap check refuses `* * * * *`), and a browser test has no fake clock: the ticker is a fixed 60 s `setInterval`. Ticking at the schedule's own `nextFireAt` exercises the real claim, coalesce and dispatch path, not a shortcut. |
| D214 | Rejected alternatives: Playwright writing `nextFireAt` into Postgres and waiting up to 60 s (slow, couples the E2E to the schema); a user-facing "Run now" button (not in the spec, and it would need its own outcome rules). | Recorded so a reviewer does not re-open them. |
| D215 | Pages: list `/:project/fleet/schedules`, detail `/:project/fleet/schedules/:id`. Create and edit share one dialog (`FleetScheduleEditDialog`), opened from the list (create, edit) and the detail page (edit). | Same as the budgets pages; a dialog keeps the list in view. |
| D216 | Navigation: a "Schedules" outline button in the jobs-list header for every member (before Budgets); no sidebar link (the prefix-active "Fleet jobs" link would double-highlight, D187). Breadcrumbs: Fleet jobs > Schedules, and Fleet jobs > Schedules > Schedule. The job page shows "Dispatched by a schedule" with a link when `scheduleId` is set, and the merged-fires count when `coalescedCount > 0`. | Members must reach the pages; a scheduled job must lead back to its schedule. |
| D217 | UI permissions: Create for `canWorkOnFleet(viewer)`; edit, enable, disable and delete for `canWork && (canManage \|\| userId === createdById)` (`canChangeSchedule`). Members without rights see one read-only line. | Mirrors 3a D202; the server stays authoritative. |
| D218 | Form: repo, placement mode and pinned runner are native selects; placement mode is a select (`auto \| labels \| pin`), not a RadioGroup (testable through `FleetNativeSelect`, `selectOption` in Playwright). `keepValuesOnUnmount: true` plus schema defaults (the D182 trap), and the body mappers read only the field of the chosen mode. Patch always sends every editable field, with `selectorLabels: []` and `pinnedRunnerId: null` when that mode is not chosen, so switching pin to auto really unpins. | An omitted field means "unchanged" on PATCH (D203). |
| D219 | Client validation mirrors the DTO and leaves the rest to the server: name 1-80 non-blank; cron is exactly five whitespace-separated fields (sent re-joined with single spaces; syntax and the 15-minute gap are the server's, its message is shown); timezone must be accepted by `Intl.DateTimeFormat` and not start with `+`/`-`; default is the browser's zone; a `<datalist>` offers `Intl.supportedValuesOf('timeZone')`. Create `ref` optional, edit `ref` required. `maxCostUsd` string, 4 decimals, > 0, <= 10,000 compared with `toUnits` (no floats). `noProgressLimit` 1-20, default 3. | Catch typos before the request without duplicating cron-parser. |
| D220 | Next fire and last fired are shown in the **schedule's** timezone (`Intl.DateTimeFormat(locale, { timeZone })`, zone name beside it); an unusable zone falls back to UTC; null shows `-`. | The cron is read in that zone; the viewer's local time would make "0 9 * * 1-5" look wrong. |
| D221 | History = `useFleetJobs(slug).load({ scheduleId, page })`, 20 per page, newest first. Each row: job link, state badge, stories `passed/total` with the delta to the nearest **older loaded** job that has progress; on the last page the oldest job's baseline is 0; otherwise the delta is unknown (`-`). Plus cost, `coalescedCount`, `wipPush`, and `stateReason` (a `budget:<id>` reason renders as "Stopped by a fleet budget", D188). | Spec §3.4 history columns; a delta across an unloaded page would be a guess. |
| D222 | Live: both pages reload on `fleet_job` notices (debounced 300 ms) and resync, plus a 60 s visible-tab poll. The detail page reloads the schedule and the current history page. | A tick that only moves `nextFireAt`, skips, or coalesces changes no job state, so it sends no notice; 60 s is the ticker cadence. |
| D223 | Delete asks `window.confirm` (jobs are kept); on the detail page a successful delete navigates to the list. Any refused action (enable 409 owner lost access, 404 stale, 403) toasts the server message and reloads. | No phantom rows, no silent no-op. |
| D224 | `useFleetSchedules` keeps a module-level mutation epoch like `useFleetBudgets`: a load that started before a successful mutation is dropped. | A slow poll must not put an old row back. |
| D225 | E2E: one spec, one test, after `fleet-dispatch` alphabetically. Create in the UI with a yearly cron (`0 3 1 1 *`, UTC, so the real ticker never fires it) pinned to a scripted runner, fire through the hook, complete the job with 2/2 stories, then assert on the detail page: history row COMPLETED with `2/2`, schedule status `completed`, cost so far `$0.90`. `beforeAll`/`afterAll` delete the project's schedules through the API. | Spec §3.5; cleanup survives a failed assertion and keeps later runs clean. |

## Review Focus

1. **Edit switches placement from pin to auto (or labels)**: the PATCH must carry `pinnedRunnerId: null` (and labels `[]`
   when not labels), not omit them, or the schedule stays pinned. (Task 2 `toSchedulePatchBody` pins the switch; the Task 5 dialog test pins a stored labels schedule sending
   `pinnedRunnerId: null`. A live switch inside the dialog cannot be driven through the inert `FormField` stub, so it
   is covered at the library level and by the patch-body contract.)
2. **A DEVELOPER who is not the owner, and a VIEWER**: the developer sees Create but no edit/enable/disable/delete on
   someone else's schedule; the viewer sees neither and gets the read-only line. (Task 2 `canChangeSchedule`, Tasks 6 and 7.)
3. **Disabled schedule with `nextFireAt: null` or `disabledReason: null`**: renders `-` and "Disabled", never
   "Invalid Date" or a raw key; a schedule stored in a zone the browser does not know still renders (UTC fallback).
   (Task 2 `formatInZone`/`scheduleStatusKey`, Task 6.)
4. **Stale view**: enabling a schedule whose owner lost access (409) or deleting one already deleted (404) shows the
   server message and reloads; a poll that started before a successful mutation does not restore the old row; on the
   detail page a schedule that is gone drops to the error state instead of keeping its controls. (Tasks 4 and 8.)
5. **History delta at a page boundary**: the oldest row of a non-last page shows `-`, not a delta against 0; a job
   without progress between two with progress is skipped as a baseline. (Task 2 `historyRows`, Task 8.)

---

## File Structure

| File | Responsibility |
|:--|:--|
| `apps/api/src/config/fleet.config.ts`, `env.validation.ts` (modify) | `testHooksEnabled` from `FLEET_TEST_HOOKS`, never in production. |
| `apps/api/src/fleet/schedules/fleet-test-hooks.controller.ts` (create) | The D213 fire hook. |
| `apps/api/src/fleet/schedules/schedules.module.ts` (modify) | Register the hook controller. |
| `apps/web/lib/fleet-types.ts` (modify) | `ScheduleDto`, create/patch bodies, disabled reasons; `FleetJobDto.scheduleId/coalescedCount`. |
| `apps/web/lib/fleet-budgets.ts` (modify) | Export `trimDecimal`. |
| `apps/web/lib/fleet-schedules.ts` (create) | Pure helpers: schema, initial values, bodies, cron/zone checks, `formatInZone`, `scheduleStatusKey`, `canChangeSchedule`, `historyRows`, `formatDelta`, `sortSchedules`, `placementText` inputs. |
| `apps/web/composables/useFleetJobs.ts` (modify) | `scheduleId` filter. |
| `apps/web/composables/useFleetSchedules.ts` (create) | Transport + list + mutation epoch. |
| `apps/web/composables/useFleetScheduleActions.ts` (create) | Enable/disable/delete with toasts and stale reload. |
| `apps/web/components/fleet/ScheduleEditDialog.vue` (create) | Create and edit form. |
| `apps/web/components/fleet/ScheduleTable.vue` (create) | Schedule rows with status and actions. |
| `apps/web/components/fleet/ScheduleHistory.vue` (create) | Run history table. |
| `apps/web/pages/[project]/fleet/schedules/index.vue` (create) | List page. |
| `apps/web/pages/[project]/fleet/schedules/[id].vue` (create) | Detail page. |
| `apps/web/pages/[project]/fleet/index.vue`, `jobs/[id].vue` (modify) | Schedules button; schedule link on a job. |
| `apps/web/layouts/default.vue` (modify) | Breadcrumbs. |
| `apps/web/i18n/locales/en.json`, `zh.json` (modify) | `fleet.schedules.*`, `fleet.jobs.schedules`, `fleet.jobs.detail.fromSchedule/openSchedule/coalesced`. |
| `apps/web/tests/helpers/mount-sfc.ts`, `fleet-harness.ts` (modify) | Real `FleetScheduleTable`/`FleetScheduleHistory`; stubs for `NuxtLink` and the schedule dialog. |
| `apps/web/playwright.config.ts` (modify) | `FLEET_TEST_HOOKS: 'true'` for the API server. |
| `apps/web/tests/e2e/fleet-schedules.e2e.spec.ts`, `fixtures/fleet-schedules-api.ts` (create); `fixtures/fleet-budgets-api.ts` (modify: export `call`) | Playwright flow. |
| `docs/deployment/runner.md`, the S1b spec §3.4 (modify) | Web notes, 3b plan notes. |

---
### Task 1: Test-only schedule fire hook (API)

**Files:**
- Modify: `apps/api/src/config/fleet.config.ts`, `apps/api/src/config/env.validation.ts`
- Modify: `apps/api/src/config/fleet.config.spec.ts`
- Modify: `apps/api/src/common/test-helpers/fleet-config.ts` (the complete `IFleetConfig` literal for unit specs)
- Create: `apps/api/src/fleet/schedules/fleet-test-hooks.controller.ts`
- Create: `apps/api/src/fleet/schedules/fleet-test-hooks.controller.spec.ts`
- Modify: `apps/api/src/fleet/schedules/schedules.module.ts`, `schedules.module.spec.ts`
- Modify: `apps/api/src/fleet/fleet-openapi.contract.spec.ts`
- Create: `apps/api/test/integration/fleet/fleet-test-hooks.integration.spec.ts`

**Interfaces:**
- Consumes: `ScheduleTicker.tick(now: Date): Promise<TickResult>` (`schedule-ticker.ts`), `IScheduleRepository.findById`
  via `SCHEDULE_REPOSITORY`, `FLEET_CFG`.
- Produces: `IFleetConfig.testHooksEnabled: boolean`; HTTP `POST /api/fleet/test-hooks/schedules/:id/fire` ->
  `{ ret: 0, data: { firedAt: string; result: TickResult } }` (Task 9 calls it).

- [ ] **Step 1: Write the failing config test**

Append to `apps/api/src/config/fleet.config.spec.ts`, inside `describe('fleet config', ...)`:

```ts
  it('enables the test hooks only for FLEET_TEST_HOOKS=true outside production (3b D213)', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.FLEET_TEST_HOOKS;
    expect(fleetConfig().testHooksEnabled).toBe(false);
    process.env.FLEET_TEST_HOOKS = 'TRUE';
    expect(fleetConfig().testHooksEnabled).toBe(true);
    process.env.FLEET_TEST_HOOKS = 'false';
    expect(fleetConfig().testHooksEnabled).toBe(false);
    process.env.NODE_ENV = 'production';
    process.env.FLEET_TEST_HOOKS = 'true';
    expect(fleetConfig().testHooksEnabled).toBe(false);
  });

  it('refuses boot on a FLEET_TEST_HOOKS that is not true or false', () => {
    expect(() => validate({ ...BASE, FLEET_TEST_HOOKS: 'yes' })).toThrow();
    expect(() => validate({ ...BASE, FLEET_TEST_HOOKS: 'true' })).not.toThrow();
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && bun run test:scoped src/config/fleet.config.spec.ts`
Expected: FAIL (`testHooksEnabled` is undefined; `'yes'` does not throw).

- [ ] **Step 3: Implement the flag**

In `apps/api/src/config/fleet.config.ts`, add to `IFleetConfig` after `gitlabTokenTtlSec`:

```ts
  /** Test-only HTTP hooks (S1b 3b D213): FLEET_TEST_HOOKS=true, and never under NODE_ENV=production. */
  testHooksEnabled: boolean;
```

Add to `FleetConfigSchema` after `FLEET_GITLAB_TOKEN_TTL_SEC`:

```ts
  @IsOptional() @IsString() FLEET_TEST_HOOKS: string;
```

Add to the object returned by `fleetConfig` after `gitlabTokenTtlSec`:

```ts
    testHooksEnabled: (process.env['FLEET_TEST_HOOKS'] ?? '').toLowerCase() === 'true' && process.env['NODE_ENV'] !== 'production',
```

In `apps/api/src/config/env.validation.ts`, add after the `FLEET_SWEEP_ENABLED` line:

```ts
  FLEET_TEST_HOOKS: Joi.string().pattern(/^(true|false)$/i).optional(),
```

In `apps/api/src/common/test-helpers/fleet-config.ts` (`testFleetConfig`, a complete `IFleetConfig`), add after
`gitlabTokenTtlSec: 3_600,`:

```ts
    testHooksEnabled: false,
```

Then confirm no other complete literal remains: `cd apps/api && grep -rn "gitlabTokenTtlSec:" src test | grep -v fleet.config.ts`
must list only `fleet-config.ts` (literals typed as `Pick<IFleetConfig, ...>` need nothing).

- [ ] **Step 4: Run it to verify it passes**

Run: `cd apps/api && bun run test:scoped src/config/fleet.config.spec.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing controller test**

Create `apps/api/src/fleet/schedules/fleet-test-hooks.controller.spec.ts`:

```ts
import { JsonResponse, NotFoundAppException } from '@nathapp/nestjs-common';
import { FleetTestHooksController } from './fleet-test-hooks.controller';

const DUE = new Date('2026-10-02T03:00:00.000Z');
const RESULT = { claimed: 1, dispatched: 1, coalesced: 0, skipped: 0, disabled: 0, failed: 0 };

function build(enabled: boolean, found = true) {
  const ticker = { tick: jest.fn(async () => RESULT) };
  const repo = { findById: jest.fn(async () => (found ? { id: 's1', nextFireAt: DUE } : null)) };
  const controller = new FleetTestHooksController(ticker as never, repo as never, { testHooksEnabled: enabled });
  return { ticker, repo, controller };
}

describe('FleetTestHooksController (3b D213)', () => {
  it('answers 404 and touches nothing while the hooks are off', async () => {
    const h = build(false);
    await expect(h.controller.fire('s1')).rejects.toBeInstanceOf(NotFoundAppException);
    expect(h.repo.findById).not.toHaveBeenCalled();
    expect(h.ticker.tick).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown schedule', async () => {
    const h = build(true, false);
    await expect(h.controller.fire('nope')).rejects.toBeInstanceOf(NotFoundAppException);
    expect(h.ticker.tick).not.toHaveBeenCalled();
  });

  it('runs one ticker round at the schedule\'s next fire and returns the tally', async () => {
    const h = build(true);
    const res = await h.controller.fire('s1');
    expect(h.repo.findById).toHaveBeenCalledWith('s1');
    expect(h.ticker.tick).toHaveBeenCalledWith(DUE);
    expect(res).toEqual(JsonResponse.Ok({ firedAt: DUE.toISOString(), result: RESULT }));
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `cd apps/api && bun run test:scoped src/fleet/schedules/fleet-test-hooks.controller.spec.ts`
Expected: FAIL (`Cannot find module './fleet-test-hooks.controller'`).

- [ ] **Step 7: Implement the controller and register it**

Create `apps/api/src/fleet/schedules/fleet-test-hooks.controller.ts`:

```ts
import { Controller, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { RequiredPermission } from '@nathapp/nestjs-auth';
import { JsonResponse, NotFoundAppException } from '@nathapp/nestjs-common';
import { FLEET_CFG, IFleetConfig } from '../../config/fleet.config';
import { IScheduleRepository, SCHEDULE_REPOSITORY } from './domain/schedule.domain';
import { ScheduleTicker } from './schedule-ticker';

/**
 * Test-only (S1b 3b D213): fires one schedule by running a ticker round at its `nextFireAt`, so the web E2E needs
 * neither the 60 s timer nor a per-minute cron (the 15-minute gap check refuses one). The claim, coalesce and dispatch
 * path is the real one. 404 unless FLEET_TEST_HOOKS=true outside production; global ADMIN; not in openapi.json.
 */
// No @ApiTags/@ApiOperation (.nax/rules/api-controllers.md): the controller is excluded from OpenAPI on purpose (D213).
@ApiExcludeController()
@Controller('fleet/test-hooks')
export class FleetTestHooksController {
  constructor(
    private readonly ticker: ScheduleTicker,
    @Inject(SCHEDULE_REPOSITORY) private readonly schedules: IScheduleRepository,
    @Inject(FLEET_CFG) private readonly fleetConfig: Pick<IFleetConfig, 'testHooksEnabled'>,
  ) {}

  @Post('schedules/:id/fire')
  @HttpCode(200)
  @RequiredPermission('ADMIN')
  async fire(@Param('id') id: string) {
    // Off looks the same as an unknown schedule: nothing about the hook is disclosed.
    if (!this.fleetConfig.testHooksEnabled) throw new NotFoundAppException({}, 'fleet.schedules');
    const schedule = await this.schedules.findById(id);
    if (!schedule) throw new NotFoundAppException({}, 'fleet.schedules');
    const at = schedule.nextFireAt;
    return JsonResponse.Ok({ firedAt: at.toISOString(), result: await this.ticker.tick(at) });
  }
}
```

In `apps/api/src/fleet/schedules/schedules.module.ts`, import it and change the `controllers` line:

```ts
import { FleetTestHooksController } from './fleet-test-hooks.controller';
```

```ts
  controllers: [ProjectFleetSchedulesController, FleetTestHooksController],
```

In `apps/api/src/fleet/schedules/schedules.module.spec.ts`, import `FleetTestHooksController` and add inside the `try`:

```ts
      expect(moduleRef.get(FleetTestHooksController)).toBeDefined();
```

- [ ] **Step 8: Run the unit tests to verify they pass**

Run: `cd apps/api && bun run test:scoped src/fleet/schedules/fleet-test-hooks.controller.spec.ts src/fleet/schedules/schedules.module.spec.ts`
Expected: PASS.

- [ ] **Step 9: Write the integration test and the OpenAPI guard**

Create `apps/api/test/integration/fleet/fleet-test-hooks.integration.spec.ts`:

```ts
/**
 * Fleet S1b slice 3b (plan D213): the test-only fire hook over HTTP, booted with FLEET_TEST_HOOKS=true (PG).
 * Run: cd apps/api && KODA_DB_TESTS=1 bun run test:scoped test/integration/fleet/fleet-test-hooks.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { FleetHttpWorld, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

jest.setTimeout(30_000);

interface Row { id: string; nextFireAt: string; lastJobId: string | null }

describeIntegration('fleet test hooks (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let n = 0;
  const as = (token: string) => ({ Authorization: `Bearer ${token}` });
  const BASE = '/api/projects/web/fleet/schedules';
  const fire = (id: string, token: string) => request(server).post(`/api/fleet/test-hooks/schedules/${id}/fire`).set(as(token));
  const create = async () => data<Row>(await request(server).post(BASE).set(as(world.tokens.dev)).send({
    name: 'hook', repoId: world.repoId, feature: `hook${++n}`, cron: '0 3 1 1 *', timezone: 'UTC', maxCostUsd: 5,
  }).expect(201));

  beforeAll(async () => {
    await resetDb();
    // Config factories read process.env during AppFactory.create (see bootHttpApp).
    const previous = process.env.FLEET_TEST_HOOKS;
    process.env.FLEET_TEST_HOOKS = 'true';
    try {
      app = await bootHttpApp({ registrationEnabled: false });
    } finally {
      if (previous === undefined) delete process.env.FLEET_TEST_HOOKS;
      else process.env.FLEET_TEST_HOOKS = previous;
    }
    server = app.getHttpServer();
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(server, prisma);
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await prisma.fleetJob.deleteMany();
    await prisma.jobSchedule.deleteMany();
  });

  it('a global admin fires a schedule that is not due yet: one RUN as the owner, linked as lastJobId, next fire moved on', async () => {
    const created = await create();
    const res = data<{ firedAt: string; result: { claimed: number; dispatched: number } }>(await fire(created.id, world.tokens.root).expect(200));
    expect(res.firedAt).toBe(created.nextFireAt);
    expect(res.result).toEqual(expect.objectContaining({ claimed: 1, dispatched: 1 }));

    const job = await prisma.fleetJob.findFirstOrThrow({ where: { scheduleId: created.id } });
    // `n` is the suffix create() just used.
    expect(job).toEqual(expect.objectContaining({ command: 'RUN', feature: `hook${n}`, requestedById: world.ids.dev }));
    const after = data<Row>(await request(server).get(`${BASE}/${created.id}`).set(as(world.tokens.dev)).expect(200));
    expect(after.lastJobId).toBe(job.id);
    expect(new Date(after.nextFireAt).getTime()).toBeGreaterThan(new Date(created.nextFireAt).getTime());
  });

  it('refuses a project developer, and answers 404 for an unknown schedule', async () => {
    const created = await create();
    await fire(created.id, world.tokens.dev).expect(403);
    await fire('no-such-schedule', world.tokens.root).expect(404);
    expect(await prisma.fleetJob.count()).toBe(0);
  });
});
```

Append to `apps/api/src/fleet/fleet-openapi.contract.spec.ts`, inside the `describe`:

```ts
  it('keeps the test-only hooks out of the contract (3b D213)', () => {
    expect(Object.keys(spec.paths).filter((path) => path.includes('test-hooks'))).toEqual([]);
  });
```

- [ ] **Step 10: Run them**

Run: `cd apps/api && bun run test:db:up && KODA_DB_TESTS=1 bun run test:scoped test/integration/fleet/fleet-test-hooks.integration.spec.ts`
Expected: PASS (2 tests).
Run: `cd apps/api && bun run test:scoped src/fleet/fleet-openapi.contract.spec.ts`
Expected: PASS.

- [ ] **Step 11: Check the contract is unchanged, lint, types**

Run (repo root): `bun run generate && git status --porcelain openapi.json apps/cli`
Expected: no output (the hook is excluded; nothing regenerated differs).
Run: `cd apps/api && bun run lint && bun run type-check`
Expected: clean.

- [ ] **Step 12: Commit**

```bash
git add apps/api/src/config apps/api/src/common/test-helpers/fleet-config.ts apps/api/src/fleet/schedules \
  apps/api/src/fleet/fleet-openapi.contract.spec.ts \
  apps/api/test/integration/fleet/fleet-test-hooks.integration.spec.ts
git commit -m "feat(fleet): test-only hook that fires a schedule at its next fire (S1b 3b D213)"
```

---

### Task 2: Wire types and the pure schedules library (web)

**Files:**
- Modify: `apps/web/lib/fleet-types.ts`, `apps/web/lib/fleet-budgets.ts` (export `trimDecimal`)
- Modify: `apps/web/composables/useFleetJobs.ts` (`scheduleId` filter)
- Create: `apps/web/lib/fleet-schedules.ts`
- Create: `apps/web/tests/lib/fleet-schedules.spec.ts`
- Modify: `apps/web/tests/composables/useFleetJobs.spec.ts`

**Interfaces:**
- Consumes: `toUnits`, `budgetStopPolicyId`, `TranslateNamed` from `~/lib/fleet-budgets`; `extractProgress`,
  `formatUsd`, `wipPushStatus`, `WipPushStatus` from `~/lib/fleet-jobs`; `FEATURE_RE`, `PROFILE_NAME_RE`,
  `RESERVED_PROFILE_PREFIX`, `MAX_PROFILES`, `MAX_SELECTOR_LABELS`, `MAX_COST_USD` from `~/lib/fleet-dispatch`;
  `LABEL_PATTERN` from `~/lib/fleet-validation`.
- Produces (later tasks import these exact names):
  - types `ScheduleDto`, `NewScheduleBody`, `SchedulePatchBody`, `ScheduleDisabledReason`, `SCHEDULE_DISABLED_REASONS`
    (`fleet-types.ts`); `FleetJobDto.scheduleId: string | null`, `FleetJobDto.coalescedCount: number`.
  - `FleetJobFilters.scheduleId?: string`.
  - from `fleet-schedules.ts`: `PLACEMENT_MODES`, `type PlacementMode`, `type ScheduleFormValues`,
    `type ScheduleFormMode = 'create' | 'edit'`, `DEFAULT_NO_PROGRESS_LIMIT = 3`, `isCronShape(s): boolean`,
    `normalizeCron(s): string`, `isAcceptedTimeZone(s): boolean`, `browserTimeZone(): string`,
    `timeZoneOptions(): string[]`, `parseMaxCost(s): number | null`, `parseNoProgressLimit(s): number | null`,
    `buildScheduleSchema(t, mode)`, `initialScheduleValues(schedule | null, timezone): ScheduleFormValues`,
    `toCreateScheduleBody(v): NewScheduleBody`, `toSchedulePatchBody(v): SchedulePatchBody`,
    `formatInZone(iso | null, timeZone, locale?): string`, `scheduleStatusKey(s): ScheduleStatusKey`,
    `type ScheduleViewer = { userId: string | null; canWork: boolean; canManage: boolean }`,
    `canChangeSchedule(s, viewer): boolean`, `sortSchedules(list): ScheduleDto[]`, `type HistoryRow`,
    `historyRows(jobs, oldestLoaded): HistoryRow[]`, `formatDelta(n | null): string`, `placementOf(s): PlacementMode`.

- [ ] **Step 1: Write the failing library tests**

Create `apps/web/tests/lib/fleet-schedules.spec.ts`:

```ts
import { describe, expect, test } from '@jest/globals'
import {
  buildScheduleSchema, canChangeSchedule, formatDelta, formatInZone, historyRows, initialScheduleValues, isAcceptedTimeZone,
  isCronShape, normalizeCron, parseMaxCost, parseNoProgressLimit, placementOf, scheduleStatusKey, sortSchedules,
  toCreateScheduleBody, toSchedulePatchBody,
} from '../../lib/fleet-schedules'
import type { ScheduleFormValues } from '../../lib/fleet-schedules'
import type { FleetJobDto, ScheduleDto } from '../../lib/fleet-types'

const t = (key: string): string => key

const schedule = (over: Partial<ScheduleDto> = {}): ScheduleDto => ({
  id: 's1', projectId: 'p1', repoId: 'r1', name: 'nightly', cron: '0 9 * * 1-5', timezone: 'Asia/Singapore', feature: 'login',
  ref: 'main', profiles: ['fast'], maxCostUsd: '5.0000', selectorLabels: [], pinnedRunnerId: 'run1', enabled: true,
  nextFireAt: '2026-10-05T01:00:00.000Z', lastFiredAt: null, lastJobId: null, lastPassedCount: 0, noProgressTicks: 0,
  noProgressLimit: 3, disabledReason: null, totalCostUsd: '0.0000', createdById: 'u1', updatedById: 'u1',
  createdAt: '2026-10-02T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z', ...over,
})

const job = (id: string, progress: unknown, over: Partial<FleetJobDto> = {}): FleetJobDto => ({
  id, projectId: 'p1', repoId: 'r1', ref: 'main', command: 'RUN', feature: 'login', planFrom: null, profiles: [],
  maxCostUsd: '5.0000', bashMode: 'raw', selectorLabels: [], pinnedRunnerId: null, runnerId: null, leaseEpoch: 1,
  state: 'FAILED', stateReason: null, requestedById: 'u1', queuedAt: '2026-10-02T00:00:00.000Z', assignedAt: null,
  startedAt: null, finishedAt: null, cancelRequestedAt: null, naxRunId: null, naxLogRunId: null, naxCostRunId: null,
  progress, currentStoryId: null, currentPhase: null, costSpentUsd: '0.5000', lastHeartbeatAt: null, finishResult: null,
  escalationReason: null, exitCode: null, resultBranch: null, resultSha: null, resultPrUrl: null, wipPush: null,
  stories: null, storiesTruncated: false, scheduleId: 's1', coalescedCount: 0, ...over,
})

const p = (passed: number, total = 5) => ({ total, passed, failed: 0, paused: 0, blocked: 0, pending: total - passed })

const form = (over: Partial<ScheduleFormValues> = {}): ScheduleFormValues => ({
  name: ' nightly ', repoId: 'r1', feature: ' login ', cron: ' 0  9 * * 1-5 ', timezone: ' UTC ', ref: '', profiles: [],
  maxCostUsd: '2.5', placement: 'auto', selectorLabels: [], pinnedRunnerId: '', noProgressLimit: '3', ...over,
})

describe('cron and timezone checks (D219)', () => {
  test.each([
    ['0 9 * * 1-5', true], [' 0  9 * *   1-5 ', true], ['* * * *', false], ['* * * * * *', false], ['', false],
  ])('isCronShape(%j) is %s', (cron, ok) => {
    expect(isCronShape(cron)).toBe(ok)
  })

  test('normalizeCron collapses whitespace', () => {
    expect(normalizeCron(' 0  9 *\t* 1-5 ')).toBe('0 9 * * 1-5')
  })

  test.each([
    ['Asia/Singapore', true], ['UTC', true], ['Not/AZone', false], ['', false], ['+08:00', false], ['-05:00', false],
  ])('isAcceptedTimeZone(%j) is %s', (zone, ok) => {
    expect(isAcceptedTimeZone(zone)).toBe(ok)
  })
})

describe('numbers (D219)', () => {
  test.each([
    ['2.5', 2.5], ['0.0001', 0.0001], ['10000', 10000], ['0', null], ['10000.0001', null], ['1.23456', null], ['abc', null], ['', null],
  ])('parseMaxCost(%j) is %s', (input, expected) => {
    expect(parseMaxCost(input)).toBe(expected)
  })

  test.each([['1', 1], ['20', 20], ['3', 3], ['0', null], ['21', null], ['2.5', null], ['', null]])(
    'parseNoProgressLimit(%j) is %s', (input, expected) => {
      expect(parseNoProgressLimit(input)).toBe(expected)
    },
  )
})

describe('form schema', () => {
  test('create needs a repo and a valid feature; edit does not look at them', () => {
    const create = buildScheduleSchema(t, 'create')
    const bad = create.safeParse(form({ repoId: '', feature: '../x' }))
    expect(bad.success).toBe(false)
    const paths = bad.success ? [] : bad.error.issues.map((i) => i.path.join('.'))
    expect(paths).toEqual(expect.arrayContaining(['repoId', 'feature']))
    expect(buildScheduleSchema(t, 'edit').safeParse(form({ repoId: '', feature: '', ref: 'main' })).success).toBe(true)
  })

  test('edit needs a ref; create does not', () => {
    expect(buildScheduleSchema(t, 'create').safeParse(form({ ref: '' })).success).toBe(true)
    const edit = buildScheduleSchema(t, 'edit').safeParse(form({ ref: ' ' }))
    expect(edit.success ? [] : edit.error.issues.map((i) => i.path.join('.'))).toEqual(['ref'])
  })

  test('pin mode needs a runner, labels mode needs a label', () => {
    const s = buildScheduleSchema(t, 'create')
    const pin = s.safeParse(form({ placement: 'pin', pinnedRunnerId: '' }))
    expect(pin.success ? [] : pin.error.issues.map((i) => i.path.join('.'))).toEqual(['pinnedRunnerId'])
    const labels = s.safeParse(form({ placement: 'labels', selectorLabels: [] }))
    expect(labels.success ? [] : labels.error.issues.map((i) => i.path.join('.'))).toEqual(['selectorLabels'])
  })

  test('fields under v-if may arrive undefined (vee-validate unsets an unmounted field) and still validate', () => {
    const values = { ...form(), selectorLabels: undefined, pinnedRunnerId: undefined, profiles: undefined }
    expect(buildScheduleSchema(t, 'create').safeParse(values).success).toBe(true)
  })

  test.each([
    ['name', { name: '   ' }], ['cron', { cron: '* * * *' }], ['timezone', { timezone: '+08:00' }],
    ['maxCostUsd', { maxCostUsd: '0' }], ['noProgressLimit', { noProgressLimit: '21' }],
    ['profiles', { profiles: ['koda-job-x'] }], ['selectorLabels', { placement: 'labels' as const, selectorLabels: ['UPPER'] }],
  ])('rejects a bad %s', (path, over) => {
    const r = buildScheduleSchema(t, 'create').safeParse(form(over))
    expect(r.success ? [] : r.error.issues.map((i) => i.path.join('.'))).toContain(path)
  })
})

describe('bodies (D218)', () => {
  test('create trims, normalises the cron, omits a blank ref and empty lists, sends numbers', () => {
    expect(toCreateScheduleBody(form())).toEqual({
      name: 'nightly', repoId: 'r1', feature: 'login', cron: '0 9 * * 1-5', timezone: 'UTC', maxCostUsd: 2.5, noProgressLimit: 3,
    })
  })

  test('create sends only the chosen placement field', () => {
    const both = { selectorLabels: ['gpu'], pinnedRunnerId: 'run1' }
    expect(toCreateScheduleBody(form({ ...both, placement: 'pin' }))).toEqual(expect.objectContaining({ pinnedRunnerId: 'run1' }))
    expect(toCreateScheduleBody(form({ ...both, placement: 'pin' }))).not.toHaveProperty('selectorLabels')
    expect(toCreateScheduleBody(form({ ...both, placement: 'labels' }))).toEqual(expect.objectContaining({ selectorLabels: ['gpu'] }))
    expect(toCreateScheduleBody(form({ ...both, placement: 'labels' }))).not.toHaveProperty('pinnedRunnerId')
    expect(toCreateScheduleBody(form({ ...both, placement: 'auto' }))).not.toHaveProperty('pinnedRunnerId')
  })

  test('patch sends every editable field and clears the placement it does not use (Review Focus 1)', () => {
    expect(toSchedulePatchBody(form({ ref: 'main', placement: 'auto', pinnedRunnerId: 'run1', selectorLabels: ['gpu'] }))).toEqual({
      name: 'nightly', cron: '0 9 * * 1-5', timezone: 'UTC', ref: 'main', profiles: [], maxCostUsd: 2.5, noProgressLimit: 3,
      selectorLabels: [], pinnedRunnerId: null,
    })
    expect(toSchedulePatchBody(form({ ref: 'main', placement: 'pin', pinnedRunnerId: 'run1' }))).toEqual(
      expect.objectContaining({ selectorLabels: [], pinnedRunnerId: 'run1' }),
    )
  })

  test('the patch body never carries repoId or feature (D203)', () => {
    const body = toSchedulePatchBody(form({ ref: 'main' }))
    expect(body).not.toHaveProperty('repoId')
    expect(body).not.toHaveProperty('feature')
  })

  test('initial values: create defaults, edit from the stored schedule', () => {
    expect(initialScheduleValues(null, 'Asia/Singapore')).toEqual({
      name: '', repoId: '', feature: '', cron: '', timezone: 'Asia/Singapore', ref: '', profiles: [], maxCostUsd: '5',
      placement: 'auto', selectorLabels: [], pinnedRunnerId: '', noProgressLimit: '3',
    })
    expect(initialScheduleValues(schedule(), 'UTC')).toEqual(expect.objectContaining({
      timezone: 'Asia/Singapore', maxCostUsd: '5', placement: 'pin', pinnedRunnerId: 'run1', noProgressLimit: '3', ref: 'main',
    }))
    expect(placementOf(schedule({ pinnedRunnerId: null, selectorLabels: ['gpu'] }))).toBe('labels')
    expect(placementOf(schedule({ pinnedRunnerId: null }))).toBe('auto')
  })
})

describe('display (D220, Review Focus 3)', () => {
  test('formatInZone shows the instant in the schedule zone', () => {
    expect(formatInZone('2026-10-05T01:00:00.000Z', 'Asia/Singapore', 'en-US')).toMatch(/Oct 5, 2026.*9:00/)
    expect(formatInZone('2026-10-05T01:00:00.000Z', 'UTC', 'en-US')).toMatch(/Oct 5, 2026.*1:00/)
  })

  test('formatInZone: null is "-", a zone the runtime does not know falls back to UTC, garbage is shown raw', () => {
    expect(formatInZone(null, 'UTC')).toBe('-')
    expect(formatInZone('2026-10-05T01:00:00.000Z', 'Not/AZone', 'en-US')).toMatch(/1:00/)
    expect(formatInZone('not a date', 'UTC')).toBe('not a date')
  })

  test('scheduleStatusKey: enabled, a stored reason, or manual for a null reason', () => {
    expect(scheduleStatusKey(schedule())).toBe('enabled')
    expect(scheduleStatusKey(schedule({ enabled: false, disabledReason: 'completed' }))).toBe('completed')
    expect(scheduleStatusKey(schedule({ enabled: false, disabledReason: null }))).toBe('manual')
  })

  test('sortSchedules: by name, then id; the input is not mutated', () => {
    const list = [schedule({ id: 'b', name: 'zeta' }), schedule({ id: 'c', name: 'alpha' }), schedule({ id: 'a', name: 'alpha' })]
    expect(sortSchedules(list).map((s) => s.id)).toEqual(['a', 'c', 'b'])
    expect(list.map((s) => s.id)).toEqual(['b', 'c', 'a'])
  })
})

describe('permissions (D217, Review Focus 2)', () => {
  const s = schedule({ createdById: 'owner' })
  test.each([
    ['the owner who can work', { userId: 'owner', canWork: true, canManage: false }, true],
    ['a project admin', { userId: 'admin', canWork: true, canManage: true }, true],
    ['another developer', { userId: 'dev2', canWork: true, canManage: false }, false],
    ['the owner, demoted to viewer', { userId: 'owner', canWork: false, canManage: false }, false],
    ['nobody signed in', { userId: null, canWork: false, canManage: false }, false],
  ])('%s -> %s', (_name, viewer, expected) => {
    expect(canChangeSchedule(s, viewer)).toBe(expected)
  })
})

describe('history rows (D221, Review Focus 5)', () => {
  test('delta to the nearest older job with progress; jobs without progress are skipped as a baseline', () => {
    const rows = historyRows([job('j3', p(4)), job('j2', null), job('j1', p(1))], true)
    expect(rows.map((r) => [r.job.id, r.passed, r.total, r.delta])).toEqual([
      ['j3', 4, 5, 3], ['j2', null, null, null], ['j1', 1, 5, 1],
    ])
  })

  test('the oldest row of a page that is not the last has no delta', () => {
    const rows = historyRows([job('j3', p(4)), job('j2', p(2))], false)
    expect(rows.map((r) => r.delta)).toEqual([2, null])
  })

  test('cost, push outcome and budget stop come through', () => {
    const [row] = historyRows([job('j1', p(1), { wipPush: 'failed:rejected', stateReason: 'budget:pol1', costSpentUsd: '0.4200' })], true)
    expect(row.cost).toBe('$0.42')
    expect(row.wipPush).toEqual({ key: 'failed', reason: 'rejected' })
    expect(row.budgetPolicyId).toBe('pol1')
  })

  test('formatDelta', () => {
    expect([formatDelta(2), formatDelta(0), formatDelta(-1), formatDelta(null)]).toEqual(['+2', '0', '-1', '-'])
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/web && bun run test -- tests/lib/fleet-schedules.spec.ts`
Expected: FAIL (`Cannot find module '../../lib/fleet-schedules'`).

- [ ] **Step 3: Add the wire types and the jobs filter**

In `apps/web/lib/fleet-types.ts`, add to `FleetJobDto` after `storiesTruncated: boolean`:

```ts
  /** S1b 3a D205: the schedule that dispatched the job, and fires merged into it while it was QUEUED. */
  scheduleId: string | null
  coalescedCount: number
```

Append at the end of `apps/web/lib/fleet-types.ts`:

```ts
/** S1b slice 3a wire types (apps/api/src/fleet/schedules/dto). Money is a decimal string. */
export const SCHEDULE_DISABLED_REASONS = ['completed', 'finish_failed', 'no_progress', 'owner_lost_access', 'template_invalid', 'manual'] as const
export type ScheduleDisabledReason = (typeof SCHEDULE_DISABLED_REASONS)[number]

export interface ScheduleDto {
  id: string
  projectId: string
  /** May name a repo deleted since; the schedule is then disabled (template_invalid). */
  repoId: string
  name: string
  cron: string
  timezone: string
  feature: string
  ref: string
  profiles: string[]
  maxCostUsd: string
  selectorLabels: string[]
  pinnedRunnerId: string | null
  enabled: boolean
  /** Null while disabled. */
  nextFireAt: string | null
  lastFiredAt: string | null
  lastJobId: string | null
  lastPassedCount: number
  noProgressTicks: number
  noProgressLimit: number
  disabledReason: ScheduleDisabledReason | null
  totalCostUsd: string
  createdById: string
  updatedById: string
  createdAt: string
  updatedAt: string
}

export interface NewScheduleBody {
  name: string
  repoId: string
  feature: string
  cron: string
  timezone: string
  ref?: string
  profiles?: string[]
  maxCostUsd: number
  selectorLabels?: string[]
  pinnedRunnerId?: string
  noProgressLimit: number
}

/** The repo and the feature are fixed after create (3a D203). */
export interface SchedulePatchBody {
  name: string
  cron: string
  timezone: string
  ref: string
  profiles: string[]
  maxCostUsd: number
  selectorLabels: string[]
  pinnedRunnerId: string | null
  noProgressLimit: number
}
```

In `apps/web/lib/fleet-budgets.ts`, change `function trimDecimal(` to `export function trimDecimal(`.

In `apps/web/composables/useFleetJobs.ts`, add `scheduleId?: string` to `FleetJobFilters` (after `requestedById`) and
`['scheduleId', filters.scheduleId],` to the `entries` array in `buildJobQuery` (after `requestedById`).

Add to `apps/web/tests/composables/useFleetJobs.spec.ts` (inside its top-level `describe`; `buildJobQuery` is exported):

```ts
  test('buildJobQuery passes the schedule filter (S1b 3a D205)', async () => {
    const { buildJobQuery } = await import(join(__dirname, '../..', 'composables', 'useFleetJobs.ts'))
    expect(buildJobQuery({ scheduleId: 's1', page: 2 })).toEqual({ scheduleId: 's1', size: '20', current: '2' })
  })
```

(If that spec does not import `join` from `path`, add `import { join } from 'path'`.)

- [ ] **Step 4: Implement the library**

Create `apps/web/lib/fleet-schedules.ts`:

```ts
import * as z from 'zod'
import { budgetStopPolicyId, toUnits, trimDecimal } from '~/lib/fleet-budgets'
import type { TranslateNamed } from '~/lib/fleet-budgets'
import {
  FEATURE_RE, MAX_COST_USD, MAX_PROFILES, MAX_SELECTOR_LABELS, PROFILE_NAME_RE, RESERVED_PROFILE_PREFIX,
} from '~/lib/fleet-dispatch'
import { extractProgress, formatUsd, wipPushStatus } from '~/lib/fleet-jobs'
import type { WipPushStatus } from '~/lib/fleet-jobs'
import { LABEL_PATTERN } from '~/lib/fleet-validation'
import type { FleetJobDto, NewScheduleBody, ScheduleDisabledReason, ScheduleDto, SchedulePatchBody } from '~/lib/fleet-types'

/** CreateScheduleDto limits (apps/api/src/fleet/schedules/dto). */
export const MAX_NAME_LENGTH = 80
export const MAX_REF_LENGTH = 255
export const MAX_NO_PROGRESS_LIMIT = 20
export const DEFAULT_NO_PROGRESS_LIMIT = 3
const DEFAULT_MAX_COST = '5'
const UNITS_PER_USD = 10_000

export const PLACEMENT_MODES = ['auto', 'labels', 'pin'] as const
export type PlacementMode = (typeof PLACEMENT_MODES)[number]
export type ScheduleFormMode = 'create' | 'edit'

/** Form values are strings and lists; numbers are parsed on submit (D219). */
export interface ScheduleFormValues {
  name: string
  repoId: string
  feature: string
  cron: string
  timezone: string
  ref: string
  profiles: string[]
  maxCostUsd: string
  placement: PlacementMode
  selectorLabels: string[]
  pinnedRunnerId: string
  noProgressLimit: string
}

const cronFields = (input: string): string[] => input.trim().split(/\s+/).filter((field) => field !== '')

/** Exactly five fields; syntax and the 15-minute gap are the server's (D219). */
export const isCronShape = (input: string): boolean => cronFields(input).length === 5

export const normalizeCron = (input: string): string => cronFields(input).join(' ')

/** An IANA zone the runtime knows; fixed offsets (`+08:00`) are refused, as the server does (3a D191). */
export function isAcceptedTimeZone(input: string): boolean {
  const zone = input.trim()
  if (zone === '' || /^[+-]/.test(zone)) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(0)
    return true
  }
  catch {
    return false
  }
}

export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  }
  catch {
    return 'UTC'
  }
}

/** Suggestions for the timezone input; empty where the runtime cannot list zones. */
export function timeZoneOptions(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] }
  try {
    return intl.supportedValuesOf?.('timeZone') ?? []
  }
  catch {
    return []
  }
}

const COST_RE = /^\d{1,5}(?:\.\d{1,4})?$/

/** Budget of each run: > 0, at most 4 decimals, at most MAX_COST_USD, compared in ten-thousandths (no floats). */
export function parseMaxCost(input: string): number | null {
  const trimmed = input.trim()
  if (!COST_RE.test(trimmed)) return null
  const units = toUnits(trimmed)
  if (units === null || units <= BigInt(0) || units > BigInt(MAX_COST_USD) * BigInt(UNITS_PER_USD)) return null
  return Number(trimmed)
}

export function parseNoProgressLimit(input: string): number | null {
  const trimmed = input.trim()
  if (!/^\d{1,2}$/.test(trimmed)) return null
  const value = Number(trimmed)
  return value >= 1 && value <= MAX_NO_PROGRESS_LIMIT ? value : null
}

const text = z.string().default('')
const list = z.array(z.string()).default([])

/** The create/edit form (D218, D219). Fields under v-if are tolerant of undefined (the D182 trap). */
export function buildScheduleSchema(t: TranslateNamed, mode: ScheduleFormMode) {
  return z.object({
    name: z.string().refine((v) => v.trim().length >= 1 && v.trim().length <= MAX_NAME_LENGTH, t('fleet.schedules.validation.name')),
    repoId: text,
    feature: text,
    cron: z.string().refine(isCronShape, t('fleet.schedules.validation.cron')),
    timezone: z.string().refine(isAcceptedTimeZone, t('fleet.schedules.validation.timezone')),
    ref: text.refine((v) => v.trim().length <= MAX_REF_LENGTH, t('fleet.schedules.validation.ref')),
    profiles: list
      .refine((l) => l.length <= MAX_PROFILES, t('fleet.schedules.validation.profiles'))
      .refine((l) => l.every((p) => PROFILE_NAME_RE.test(p) && !p.startsWith(RESERVED_PROFILE_PREFIX)), t('fleet.schedules.validation.profiles'))
      .refine((l) => new Set(l).size === l.length, t('fleet.schedules.validation.profiles')),
    maxCostUsd: z.string().refine((v) => parseMaxCost(v) !== null, t('fleet.schedules.validation.maxCost')),
    placement: z.enum(PLACEMENT_MODES),
    selectorLabels: list
      .refine((l) => l.length <= MAX_SELECTOR_LABELS, t('fleet.schedules.validation.labels'))
      .refine((l) => l.every((label) => LABEL_PATTERN.test(label)), t('fleet.schedules.validation.labels')),
    pinnedRunnerId: text,
    noProgressLimit: z.string().refine((v) => parseNoProgressLimit(v) !== null, t('fleet.schedules.validation.noProgressLimit')),
  }).superRefine((v, ctx) => {
    const issue = (path: string, key: string): void => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message: t(key) })
    }
    if (mode === 'create') {
      if (v.repoId.trim() === '') issue('repoId', 'fleet.schedules.validation.repoRequired')
      const feature = v.feature.trim()
      if (!FEATURE_RE.test(feature) || feature.includes('..')) issue('feature', 'fleet.schedules.validation.feature')
    }
    if (mode === 'edit' && v.ref.trim() === '') issue('ref', 'fleet.schedules.validation.refRequired')
    if (v.placement === 'pin' && v.pinnedRunnerId.trim() === '') issue('pinnedRunnerId', 'fleet.schedules.validation.pinRequired')
    if (v.placement === 'labels' && v.selectorLabels.length === 0) issue('selectorLabels', 'fleet.schedules.validation.labelsRequired')
  })
}

export const placementOf = (s: Pick<ScheduleDto, 'pinnedRunnerId' | 'selectorLabels'>): PlacementMode =>
  s.pinnedRunnerId ? 'pin' : s.selectorLabels.length > 0 ? 'labels' : 'auto'

export function initialScheduleValues(s: ScheduleDto | null, timezone: string): ScheduleFormValues {
  if (s === null) {
    return {
      name: '', repoId: '', feature: '', cron: '', timezone, ref: '', profiles: [], maxCostUsd: DEFAULT_MAX_COST,
      placement: 'auto', selectorLabels: [], pinnedRunnerId: '', noProgressLimit: String(DEFAULT_NO_PROGRESS_LIMIT),
    }
  }
  return {
    name: s.name, repoId: s.repoId, feature: s.feature, cron: s.cron, timezone: s.timezone, ref: s.ref,
    profiles: [...s.profiles], maxCostUsd: trimDecimal(s.maxCostUsd), placement: placementOf(s),
    selectorLabels: [...s.selectorLabels], pinnedRunnerId: s.pinnedRunnerId ?? '', noProgressLimit: String(s.noProgressLimit),
  }
}

function numbers(v: Pick<ScheduleFormValues, 'maxCostUsd' | 'noProgressLimit'>): { maxCostUsd: number; noProgressLimit: number } {
  const maxCostUsd = parseMaxCost(v.maxCostUsd)
  const noProgressLimit = parseNoProgressLimit(v.noProgressLimit)
  if (maxCostUsd === null || noProgressLimit === null) throw new Error('fleet-schedules: form values were not validated')
  return { maxCostUsd, noProgressLimit }
}

/** Only the field of the chosen placement mode travels (D218). */
export function toCreateScheduleBody(v: ScheduleFormValues): NewScheduleBody {
  const ref = v.ref.trim()
  const pin = v.pinnedRunnerId.trim()
  return {
    name: v.name.trim(),
    repoId: v.repoId,
    feature: v.feature.trim(),
    cron: normalizeCron(v.cron),
    timezone: v.timezone.trim(),
    ...(ref ? { ref } : {}),
    ...(v.profiles.length > 0 ? { profiles: [...v.profiles] } : {}),
    ...numbers(v),
    ...(v.placement === 'pin' && pin ? { pinnedRunnerId: pin } : {}),
    ...(v.placement === 'labels' && v.selectorLabels.length > 0 ? { selectorLabels: [...v.selectorLabels] } : {}),
  }
}

/** Every editable field, always: an omitted field means "unchanged" (3a D203), so a cleared placement is explicit. */
export function toSchedulePatchBody(v: ScheduleFormValues): SchedulePatchBody {
  return {
    name: v.name.trim(),
    cron: normalizeCron(v.cron),
    timezone: v.timezone.trim(),
    ref: v.ref.trim(),
    profiles: [...v.profiles],
    ...numbers(v),
    selectorLabels: v.placement === 'labels' ? [...v.selectorLabels] : [],
    pinnedRunnerId: v.placement === 'pin' ? v.pinnedRunnerId.trim() : null,
  }
}

const ZONE_FORMAT = { dateStyle: 'medium', timeStyle: 'short' } as const

/** An instant in the schedule's own zone (D220); UTC when the runtime does not know the zone. */
export function formatInZone(iso: string | null, timeZone: string, locale?: string): string {
  if (!iso) return '-'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  try {
    return new Intl.DateTimeFormat(locale, { ...ZONE_FORMAT, timeZone }).format(date)
  }
  catch {
    return new Intl.DateTimeFormat(locale, { ...ZONE_FORMAT, timeZone: 'UTC' }).format(date)
  }
}

export type ScheduleStatusKey = 'enabled' | ScheduleDisabledReason

/** `fleet.schedules.status.<key>`; a disabled schedule without a stored reason reads as manual. */
export const scheduleStatusKey = (s: Pick<ScheduleDto, 'enabled' | 'disabledReason'>): ScheduleStatusKey =>
  s.enabled ? 'enabled' : (s.disabledReason ?? 'manual')

export interface ScheduleViewer {
  userId: string | null
  /** Project ADMIN or DEVELOPER (canWorkOnFleet). */
  canWork: boolean
  /** Project ADMIN, or a global ADMIN (the members endpoint reports both as canManage). */
  canManage: boolean
}

/** Edit, enable, disable, delete (3a D202): DEVELOPER+ and the owner or a project ADMIN. */
export const canChangeSchedule = (s: Pick<ScheduleDto, 'createdById'>, viewer: ScheduleViewer): boolean =>
  viewer.canWork && (viewer.canManage || (viewer.userId !== null && viewer.userId === s.createdById))

export const sortSchedules = (schedules: readonly ScheduleDto[]): ScheduleDto[] =>
  [...schedules].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))

export interface HistoryRow {
  job: FleetJobDto
  passed: number | null
  total: number | null
  /** Newly passed stories against the previous run; null when unknown (D221). */
  delta: number | null
  cost: string
  wipPush: WipPushStatus | null
  budgetPolicyId: string | null
}

/**
 * `jobs` newest first, as the jobs API returns them. The baseline is the nearest older loaded job with progress; when
 * `oldestLoaded` (the last page) and there is none, the baseline is 0 (D221).
 */
export function historyRows(jobs: readonly FleetJobDto[], oldestLoaded: boolean): HistoryRow[] {
  const progress = jobs.map((job) => extractProgress(job.progress))
  return jobs.map((job, i) => {
    const own = progress[i]
    const older = progress.slice(i + 1).find((entry) => entry !== null) ?? null
    const baseline = older !== null ? older.passed : oldestLoaded ? 0 : null
    return {
      job,
      passed: own?.passed ?? null,
      total: own?.total ?? null,
      delta: own !== null && baseline !== null ? own.passed - baseline : null,
      cost: formatUsd(job.costSpentUsd),
      wipPush: wipPushStatus(job.wipPush),
      budgetPolicyId: budgetStopPolicyId(job.stateReason),
    }
  })
}

export function formatDelta(delta: number | null): string {
  if (delta === null) return '-'
  return delta > 0 ? `+${delta}` : String(delta)
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/web && bun run test -- tests/lib/fleet-schedules.spec.ts tests/composables/useFleetJobs.spec.ts`
Expected: PASS.

- [ ] **Step 6: Types and lint**

`apps/web/tsconfig.json` excludes `**/*.spec.ts`, so existing `FleetJobDto` fixtures in specs are not type-checked and
need no edit for the two new fields.
Run: `cd apps/web && bun run type-check && bun run lint && bun run test -- tests/lib tests/composables`
Expected: clean; PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/lib apps/web/composables/useFleetJobs.ts apps/web/tests
git commit -m "feat(web): schedule wire types and the pure schedules library (S1b 3b)"
```

---
### Task 3: Locale strings (en, zh) and parity

**Files:**
- Modify: `apps/web/i18n/locales/en.json`, `apps/web/i18n/locales/zh.json`
- Modify: `apps/web/tests/i18n/fleet-locale-parity.spec.ts`

**Interfaces:**
- Produces: every `fleet.schedules.*` key Tasks 5-7 render, `fleet.jobs.schedules`, `fleet.jobs.detail.fromSchedule`,
  `fleet.jobs.detail.openSchedule`, `fleet.jobs.detail.coalesced`. Dynamic families: `fleet.schedules.status.<key>`
  (`scheduleStatusKey`), `fleet.schedules.form.placementMode.<mode>` (`PLACEMENT_MODES`).

- [ ] **Step 1: Write the failing parity rows**

In `apps/web/tests/i18n/fleet-locale-parity.spec.ts`, add to `ENUMS`:

```ts
  'fleet.schedules.status': ['enabled', 'completed', 'finish_failed', 'no_progress', 'owner_lost_access', 'template_invalid', 'manual'],
  'fleet.schedules.form.placementMode': ['auto', 'labels', 'pin'],
```

and add a test inside the `describe`:

```ts
  test('the schedule keys the pages render exist (S1b 3b)', () => {
    for (const key of [
      'fleet.schedules.title', 'fleet.schedules.detailTitle', 'fleet.jobs.schedules', 'fleet.jobs.detail.fromSchedule',
      'fleet.jobs.detail.openSchedule', 'fleet.jobs.detail.coalesced', 'fleet.schedules.history.storiesValue',
    ]) {
      expect(String(at(en, key) ?? '').trim()).not.toBe('')
    }
  })
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/web && bun run test -- tests/i18n/fleet-locale-parity.spec.ts`
Expected: FAIL (`fleet.schedules.status` is undefined).

- [ ] **Step 3: Add the English strings**

In `apps/web/i18n/locales/en.json`, add `"schedules": "Schedules",` to `fleet.jobs` (after `"budgets"`), add to
`fleet.jobs.detail` (after `"budgetStopLink"`):

```json
        "fromSchedule": "Dispatched by a schedule",
        "openSchedule": "View schedule",
        "coalesced": "{count} later fires merged into this job"
```

and add this object as `fleet.schedules` (after `fleet.budgets`):

```json
    "schedules": {
      "title": "Schedules",
      "detailTitle": "Schedule",
      "subtitle": "Cron schedules that run one nax feature until it is done",
      "empty": "No schedules yet",
      "forbidden": "You do not have access to this project.",
      "readOnly": "Only the schedule owner or a project administrator can change a schedule.",
      "deleteConfirm": "Delete schedule {name}? The jobs it dispatched are kept.",
      "inZone": "{time} ({zone})",
      "cronIn": "{cron} in {zone}",
      "table": {
        "name": "Name",
        "target": "Repo and feature",
        "cron": "Cron",
        "nextFire": "Next fire",
        "status": "Status",
        "owner": "Owner"
      },
      "status": {
        "enabled": "Enabled",
        "completed": "Disabled: feature completed",
        "finish_failed": "Disabled: every story passed but finish failed",
        "no_progress": "Disabled: no progress",
        "owner_lost_access": "Disabled: owner lost access",
        "template_invalid": "Disabled: template no longer valid",
        "manual": "Disabled"
      },
      "actions": {
        "create": "New schedule",
        "edit": "Edit",
        "enable": "Enable",
        "disable": "Disable",
        "delete": "Delete"
      },
      "toast": {
        "created": "Schedule created",
        "updated": "Schedule saved",
        "enabled": "Schedule enabled",
        "disabled": "Schedule disabled",
        "deleted": "Schedule deleted"
      },
      "form": {
        "createTitle": "New schedule",
        "editTitle": "Edit schedule",
        "name": "Name",
        "repo": "Repo",
        "repoPlaceholder": "Choose a repo",
        "feature": "Feature",
        "fixedHint": "The repo and the feature are fixed after create.",
        "cron": "Cron",
        "cronHint": "Five fields: minute, hour, day of month, month, day of week. For example 0 9 * * 1-5. Fires at least 15 minutes apart.",
        "timezone": "Timezone",
        "timezoneHint": "The IANA zone the cron is read in, for example Asia/Singapore.",
        "ref": "Git ref",
        "refHintCreate": "Blank uses the repo default branch.",
        "refHintEdit": "The ref each run checks out.",
        "profiles": "Profile chain",
        "profilePlaceholder": "Add a profile",
        "maxCost": "Budget per run (USD)",
        "placement": "Placement",
        "placementMode": {
          "auto": "Any fitting runner",
          "labels": "Runners with labels",
          "pin": "One runner"
        },
        "labelPlaceholder": "Add a label",
        "pinPlaceholder": "Choose a runner",
        "noProgressLimit": "Runs without progress before it stops",
        "noProgressHint": "The schedule disables itself after this many runs in a row without a newly passed story (1 to 20).",
        "submit": "Save",
        "submitting": "Saving..."
      },
      "validation": {
        "name": "Use 1 to 80 characters",
        "repoRequired": "Choose a repo",
        "feature": "Letters, digits, dot, dash or underscore; it starts with a letter or digit",
        "cron": "A cron has exactly five fields",
        "timezone": "Use an IANA zone such as Asia/Singapore, not an offset",
        "ref": "At most 255 characters",
        "refRequired": "Enter a git ref",
        "profiles": "At most 8 distinct profile names; names starting with koda-job- are reserved",
        "labels": "At most 16 labels of lower-case letters, digits, dot, dash or underscore",
        "labelsRequired": "Add at least one label",
        "pinRequired": "Choose a runner",
        "maxCost": "More than 0 and at most 10000, with at most 4 decimals",
        "noProgressLimit": "A whole number from 1 to 20"
      },
      "detail": {
        "template": "Template",
        "repo": "Repo",
        "feature": "Feature",
        "ref": "Git ref",
        "profiles": "Profile chain",
        "maxCost": "Budget per run",
        "placement": "Placement",
        "placementLabels": "Runners with labels {labels}",
        "placementPin": "Runner {runner}",
        "cron": "Cron",
        "nextFire": "Next fire",
        "lastFired": "Last fired",
        "progress": "Progress",
        "progressValue": "{passed} stories passed. {ticks} of {limit} runs without progress.",
        "owner": "Owner",
        "unknownOwner": "Former member",
        "totalCost": "Cost so far",
        "status": "Status"
      },
      "history": {
        "title": "Runs",
        "empty": "No runs yet",
        "job": "Job",
        "state": "State",
        "stories": "Stories",
        "storiesValue": "{passed}/{total} ({delta})",
        "cost": "Cost",
        "coalesced": "Fires merged",
        "push": "Progress push",
        "reason": "Reason",
        "queued": "Queued",
        "previous": "Previous",
        "next": "Next",
        "budgetStop": "Stopped by a fleet budget"
      }
    }
```

- [ ] **Step 4: Add the Chinese strings (same keys)**

In `apps/web/i18n/locales/zh.json`, add `"schedules": "定时计划",` to `fleet.jobs`, add to `fleet.jobs.detail`:

```json
        "fromSchedule": "由定时计划派发",
        "openSchedule": "查看定时计划",
        "coalesced": "之后的 {count} 次触发已合并到此任务"
```

and `fleet.schedules`:

```json
    "schedules": {
      "title": "定时计划",
      "detailTitle": "定时计划",
      "subtitle": "按 cron 运行同一个 nax 功能直到完成的定时计划",
      "empty": "暂无定时计划",
      "forbidden": "你无权访问此项目。",
      "readOnly": "只有计划的创建者或项目管理员可以修改定时计划。",
      "deleteConfirm": "删除定时计划 {name}？它派发过的任务会保留。",
      "inZone": "{time}（{zone}）",
      "cronIn": "{cron}，时区 {zone}",
      "table": {
        "name": "名称",
        "target": "仓库与功能",
        "cron": "Cron",
        "nextFire": "下次触发",
        "status": "状态",
        "owner": "创建者"
      },
      "status": {
        "enabled": "已启用",
        "completed": "已停用：功能已完成",
        "finish_failed": "已停用：所有故事已通过但收尾失败",
        "no_progress": "已停用：没有进展",
        "owner_lost_access": "已停用：创建者已失去权限",
        "template_invalid": "已停用：模板已失效",
        "manual": "已停用"
      },
      "actions": {
        "create": "新建定时计划",
        "edit": "编辑",
        "enable": "启用",
        "disable": "停用",
        "delete": "删除"
      },
      "toast": {
        "created": "定时计划已创建",
        "updated": "定时计划已保存",
        "enabled": "定时计划已启用",
        "disabled": "定时计划已停用",
        "deleted": "定时计划已删除"
      },
      "form": {
        "createTitle": "新建定时计划",
        "editTitle": "编辑定时计划",
        "name": "名称",
        "repo": "仓库",
        "repoPlaceholder": "选择仓库",
        "feature": "功能",
        "fixedHint": "创建后仓库和功能不可更改。",
        "cron": "Cron",
        "cronHint": "五个字段：分、时、日、月、星期。例如 0 9 * * 1-5。两次触发至少间隔 15 分钟。",
        "timezone": "时区",
        "timezoneHint": "解读 cron 所用的 IANA 时区，例如 Asia/Singapore。",
        "ref": "Git 引用",
        "refHintCreate": "留空则使用仓库默认分支。",
        "refHintEdit": "每次运行检出的引用。",
        "profiles": "配置链",
        "profilePlaceholder": "添加配置",
        "maxCost": "每次运行预算（美元）",
        "placement": "调度方式",
        "placementMode": {
          "auto": "任意合适的执行器",
          "labels": "带指定标签的执行器",
          "pin": "指定一个执行器"
        },
        "labelPlaceholder": "添加标签",
        "pinPlaceholder": "选择执行器",
        "noProgressLimit": "无进展运行次数上限",
        "noProgressHint": "连续这么多次运行都没有新通过的故事时，计划会自动停用（1 到 20）。",
        "submit": "保存",
        "submitting": "保存中..."
      },
      "validation": {
        "name": "长度为 1 到 80 个字符",
        "repoRequired": "请选择仓库",
        "feature": "只能包含字母、数字、点、连字符或下划线，并以字母或数字开头",
        "cron": "cron 必须恰好有五个字段",
        "timezone": "请使用 IANA 时区，例如 Asia/Singapore，而不是时差",
        "ref": "最多 255 个字符",
        "refRequired": "请输入 Git 引用",
        "profiles": "最多 8 个不重复的配置名；以 koda-job- 开头的名称为保留名称",
        "labels": "最多 16 个标签，只能包含小写字母、数字、点、连字符或下划线",
        "labelsRequired": "请至少添加一个标签",
        "pinRequired": "请选择执行器",
        "maxCost": "大于 0 且不超过 10000，最多 4 位小数",
        "noProgressLimit": "1 到 20 之间的整数"
      },
      "detail": {
        "template": "模板",
        "repo": "仓库",
        "feature": "功能",
        "ref": "Git 引用",
        "profiles": "配置链",
        "maxCost": "每次运行预算",
        "placement": "调度方式",
        "placementLabels": "带标签 {labels} 的执行器",
        "placementPin": "执行器 {runner}",
        "cron": "Cron",
        "nextFire": "下次触发",
        "lastFired": "上次触发",
        "progress": "进展",
        "progressValue": "已通过 {passed} 个故事。连续无进展 {ticks} / {limit} 次。",
        "owner": "创建者",
        "unknownOwner": "已离开的成员",
        "totalCost": "累计费用",
        "status": "状态"
      },
      "history": {
        "title": "运行记录",
        "empty": "暂无运行",
        "job": "任务",
        "state": "状态",
        "stories": "故事",
        "storiesValue": "{passed}/{total}（{delta}）",
        "cost": "费用",
        "coalesced": "合并的触发",
        "push": "进度推送",
        "reason": "原因",
        "queued": "排队时间",
        "previous": "上一页",
        "next": "下一页",
        "budgetStop": "被舰队预算停止"
      }
    }
```

- [ ] **Step 5: Run the parity and used-keys specs**

Run: `cd apps/web && bun run test -- tests/i18n`
Expected: PASS (the parity spec, and the existing used-keys spec once later tasks use the keys; keys defined before use
are fine).

- [ ] **Step 6: Commit**

```bash
git add apps/web/i18n/locales apps/web/tests/i18n/fleet-locale-parity.spec.ts
git commit -m "feat(web): schedule strings in en and zh (S1b 3b)"
```

---

### Task 4: `useFleetSchedules` and `useFleetScheduleActions`

**Files:**
- Create: `apps/web/composables/useFleetSchedules.ts`, `apps/web/composables/useFleetScheduleActions.ts`
- Create: `apps/web/tests/composables/useFleetSchedules.spec.ts`, `apps/web/tests/composables/useFleetScheduleActions.spec.ts`

**Interfaces:**
- Consumes: `apiPath` (`~/lib/api-path`), `sortSchedules` (Task 2), `ScheduleDto`, `NewScheduleBody`,
  `SchedulePatchBody` (Task 2), `extractApiError` (`~/composables/useApi`).
- Produces:
  - `scheduleRoot(slug): string`, `scheduleItem(slug, id): string`
  - `useFleetSchedules(slug)` -> `{ schedules: Ref<ScheduleDto[]>, load(): Promise<void>, get(id): Promise<ScheduleDto>,
    apply(saved): void, create(body): Promise<ScheduleDto>, update(id, patch): Promise<ScheduleDto>,
    enable(id): Promise<ScheduleDto>, disable(id): Promise<ScheduleDto>, remove(id): Promise<void> }`
  - `type FleetSchedulesApi = ReturnType<typeof useFleetSchedules>`
  - `useFleetScheduleActions(api: FleetSchedulesApi, onStale: () => void)` -> `{ busy: Ref<boolean>,
    setEnabled(s, enabled): Promise<ScheduleDto | null>, remove(s): Promise<boolean> }`

- [ ] **Step 1: Write the failing tests**

Create `apps/web/tests/composables/useFleetSchedules.spec.ts`:

```ts
import { describe, test, expect, beforeEach, jest } from '@jest/globals'
import { join } from 'path'
import type { ScheduleDto } from '../../lib/fleet-types'

const composablePath = join(__dirname, '../..', 'composables', 'useFleetSchedules.ts')

const row = (id: string, name: string, over: Partial<ScheduleDto> = {}): ScheduleDto => ({
  id, projectId: 'p1', repoId: 'r1', name, cron: '0 9 * * 1-5', timezone: 'UTC', feature: 'login', ref: 'main', profiles: [],
  maxCostUsd: '5.0000', selectorLabels: [], pinnedRunnerId: null, enabled: true, nextFireAt: '2026-10-05T09:00:00.000Z',
  lastFiredAt: null, lastJobId: null, lastPassedCount: 0, noProgressTicks: 0, noProgressLimit: 3, disabledReason: null,
  totalCostUsd: '0.0000', createdById: 'u1', updatedById: 'u1', createdAt: '2026-10-02T00:00:00.000Z',
  updatedAt: '2026-10-02T00:00:00.000Z', ...over,
})

function withApi(api: Record<string, jest.Mock>): void {
  (globalThis as Record<string, unknown>).useApi = () => ({ $api: api })
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

describe('useFleetSchedules', () => {
  beforeEach(() => { (globalThis as Record<string, unknown>).useApi = undefined })

  test('paths encode the slug and the id', async () => {
    const { scheduleRoot, scheduleItem } = await import(composablePath)
    expect(scheduleRoot('a b')).toBe('/projects/a%20b/fleet/schedules')
    expect(scheduleItem('koda', 's/1')).toBe('/projects/koda/fleet/schedules/s%2F1')
  })

  test('load reads the plain array and sorts it by name', async () => {
    const get = jest.fn(async () => [row('b', 'zeta'), row('a', 'alpha')])
    withApi({ get })
    const { useFleetSchedules } = await import(composablePath)
    const s = useFleetSchedules('koda')
    await s.load()
    expect(get).toHaveBeenCalledWith('/projects/koda/fleet/schedules')
    expect(s.schedules.value.map((x: ScheduleDto) => x.id)).toEqual(['a', 'b'])
  })

  test('create, update, enable, disable call their routes and put the answer in the list', async () => {
    const post = jest.fn(async (path: string) => row(path.endsWith('/disable') ? 'a' : 'n', path.endsWith('/disable') ? 'alpha' : 'new', { enabled: !path.endsWith('/disable') }))
    const patch = jest.fn(async () => row('n', 'renamed'))
    withApi({ get: jest.fn(async () => []), post, patch, delete: jest.fn(async () => undefined) })
    const { useFleetSchedules } = await import(composablePath)
    const s = useFleetSchedules('koda')

    await s.create({ name: 'new', repoId: 'r1', feature: 'f', cron: '0 9 * * *', timezone: 'UTC', maxCostUsd: 1, noProgressLimit: 3 })
    expect(post).toHaveBeenLastCalledWith('/projects/koda/fleet/schedules', expect.objectContaining({ name: 'new' }))
    await s.update('n', { name: 'renamed' } as never)
    expect(patch).toHaveBeenLastCalledWith('/projects/koda/fleet/schedules/n', { name: 'renamed' })
    expect(s.schedules.value.map((x: ScheduleDto) => x.name)).toEqual(['renamed'])
    await s.enable('n')
    expect(post).toHaveBeenLastCalledWith('/projects/koda/fleet/schedules/n/enable')
    await s.disable('a')
    expect(post).toHaveBeenLastCalledWith('/projects/koda/fleet/schedules/a/disable')
    expect(s.schedules.value.map((x: ScheduleDto) => [x.id, x.enabled])).toEqual([['a', false], ['n', true]])
  })

  test('remove deletes and drops the row', async () => {
    const del = jest.fn(async () => undefined)
    withApi({ get: jest.fn(async () => [row('a', 'alpha'), row('b', 'beta')]), delete: del })
    const { useFleetSchedules } = await import(composablePath)
    const s = useFleetSchedules('koda')
    await s.load()
    await s.remove('a')
    expect(del).toHaveBeenCalledWith('/projects/koda/fleet/schedules/a')
    expect(s.schedules.value.map((x: ScheduleDto) => x.id)).toEqual(['b'])
  })

  test('a load that started before a mutation does not put the old row back (D224, Review Focus 4)', async () => {
    const slow = deferred<ScheduleDto[]>()
    const get = jest.fn(() => slow.promise)
    withApi({ get, post: jest.fn(async () => row('a', 'alpha', { enabled: false })) })
    const { useFleetSchedules } = await import(composablePath)
    const s = useFleetSchedules('koda')

    const loading = s.load()
    await s.disable('a')
    slow.resolve([row('a', 'alpha', { enabled: true })])
    await loading
    expect(s.schedules.value.map((x: ScheduleDto) => x.enabled)).toEqual([false])
  })
})
```

Create `apps/web/tests/composables/useFleetScheduleActions.spec.ts`:

```ts
import { describe, test, expect, afterEach, jest } from '@jest/globals'
import { join } from 'path'
import { ApiError } from '../../composables/useApi'
import { enI18n, toastRecorder } from '../helpers/fleet-harness'
import type { ScheduleDto } from '../../lib/fleet-types'

const composablePath = join(__dirname, '../..', 'composables', 'useFleetScheduleActions.ts')
const s = { id: 's1', name: 'nightly' } as ScheduleDto

function setup(confirmResult = true) {
  const toasts = toastRecorder()
  const g = globalThis as Record<string, unknown>
  g.useI18n = () => enI18n()
  g.useAppToast = () => toasts
  g.window = { confirm: jest.fn(() => confirmResult) }
  const api = {
    enable: jest.fn(async () => ({ ...s, enabled: true })),
    disable: jest.fn(async () => ({ ...s, enabled: false })),
    remove: jest.fn(async () => undefined),
  }
  const onStale = jest.fn()
  return { toasts, api, onStale }
}

afterEach(() => {
  for (const key of ['useI18n', 'useAppToast', 'window']) delete (globalThis as Record<string, unknown>)[key]
})

describe('useFleetScheduleActions', () => {
  test('enable and disable call the api and toast success', async () => {
    const { toasts, api, onStale } = setup()
    const { useFleetScheduleActions } = await import(composablePath)
    const actions = useFleetScheduleActions(api as never, onStale)
    expect(await actions.setEnabled(s, true)).toEqual(expect.objectContaining({ enabled: true }))
    expect(await actions.setEnabled(s, false)).toEqual(expect.objectContaining({ enabled: false }))
    expect(toasts.successes).toEqual(['Schedule enabled', 'Schedule disabled'])
    expect(onStale).not.toHaveBeenCalled()
    expect(actions.busy.value).toBe(false)
  })

  test('a refused enable (409 owner lost access) shows the server message and reloads (D223)', async () => {
    const { toasts, api, onStale } = setup()
    api.enable.mockImplementationOnce(async () => { throw new ApiError(409, 'The schedule owner can no longer dispatch') })
    const { useFleetScheduleActions } = await import(composablePath)
    const actions = useFleetScheduleActions(api as never, onStale)
    expect(await actions.setEnabled(s, true)).toBeNull()
    expect(toasts.errors).toEqual(['The schedule owner can no longer dispatch'])
    expect(onStale).toHaveBeenCalledTimes(1)
    expect(actions.busy.value).toBe(false)
  })

  test('delete asks first; a refusal of the dialog does nothing', async () => {
    const { api, onStale } = setup(false)
    const { useFleetScheduleActions } = await import(composablePath)
    const actions = useFleetScheduleActions(api as never, onStale)
    expect(await actions.remove(s)).toBe(false)
    expect(api.remove).not.toHaveBeenCalled()
  })

  test('delete confirmed: removes, toasts, answers true; a 404 toasts and reloads', async () => {
    const { toasts, api, onStale } = setup(true)
    const { useFleetScheduleActions } = await import(composablePath)
    const actions = useFleetScheduleActions(api as never, onStale)
    expect(await actions.remove(s)).toBe(true)
    expect(toasts.successes).toEqual(['Schedule deleted'])
    expect((globalThis as { window: { confirm: jest.Mock } }).window.confirm)
      .toHaveBeenCalledWith('Delete schedule nightly? The jobs it dispatched are kept.')

    api.remove.mockImplementationOnce(async () => { throw new ApiError(404, 'Schedule not found') })
    expect(await actions.remove(s)).toBe(false)
    expect(toasts.errors).toEqual(['Schedule not found'])
    expect(onStale).toHaveBeenCalledTimes(1)
  })
})
```

`extractApiError(new ApiError(code, message))` returns `message` (`ApiError.firstError` with no field errors). Do not
call `jest.resetModules()` in these specs: a second copy of `ApiError` breaks `instanceof` (see `useFleetBudgetPage.spec.ts`).

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/web && bun run test -- tests/composables/useFleetSchedules.spec.ts tests/composables/useFleetScheduleActions.spec.ts`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement the transport composable**

Create `apps/web/composables/useFleetSchedules.ts`:

```ts
import { ref } from 'vue'
import { apiPath } from '~/lib/api-path'
import { sortSchedules } from '~/lib/fleet-schedules'
import type { NewScheduleBody, ScheduleDto, SchedulePatchBody } from '~/lib/fleet-types'

export const scheduleRoot = (slug: string): string => apiPath`/projects/${slug}/fleet/schedules`
export const scheduleItem = (slug: string, id: string): string => apiPath`/projects/${slug}/fleet/schedules/${id}`

/**
 * Mutation epoch shared by every instance on the page (D224): a load that started before a successful mutation is
 * dropped, the next one brings fresh rows. Same reasoning as useFleetBudgets.
 */
let mutationEpoch = 0

/** The schedules of one project (S1b §3.4): a plain array, no paging (3a D202). */
export function useFleetSchedules(slug: string) {
  const { $api } = useApi()
  const schedules = ref<ScheduleDto[]>([])
  let latestLoadId = 0

  async function load(): Promise<void> {
    const loadId = ++latestLoadId
    const epoch = mutationEpoch
    const rows = await $api.get<ScheduleDto[]>(scheduleRoot(slug))
    if (loadId !== latestLoadId || epoch !== mutationEpoch) return
    schedules.value = sortSchedules(rows ?? [])
  }

  const get = (id: string): Promise<ScheduleDto> => $api.get<ScheduleDto>(scheduleItem(slug, id))

  /** Puts a saved row in the list (replacing the same id) and invalidates in-flight loads. */
  function apply(saved: ScheduleDto): void {
    mutationEpoch += 1
    schedules.value = sortSchedules([...schedules.value.filter((s) => s.id !== saved.id), saved])
  }

  async function applied(request: Promise<ScheduleDto>): Promise<ScheduleDto> {
    const saved = await request
    apply(saved)
    return saved
  }

  const create = (body: NewScheduleBody): Promise<ScheduleDto> => applied($api.post<ScheduleDto>(scheduleRoot(slug), { ...body }))
  const update = (id: string, patch: SchedulePatchBody): Promise<ScheduleDto> =>
    applied($api.patch<ScheduleDto>(scheduleItem(slug, id), { ...patch }))
  const enable = (id: string): Promise<ScheduleDto> => applied($api.post<ScheduleDto>(`${scheduleItem(slug, id)}/enable`))
  const disable = (id: string): Promise<ScheduleDto> => applied($api.post<ScheduleDto>(`${scheduleItem(slug, id)}/disable`))

  async function remove(id: string): Promise<void> {
    await $api.delete(scheduleItem(slug, id))
    mutationEpoch += 1
    schedules.value = schedules.value.filter((s) => s.id !== id)
  }

  return { schedules, load, get, apply, create, update, enable, disable, remove }
}

export type FleetSchedulesApi = ReturnType<typeof useFleetSchedules>
```

- [ ] **Step 4: Implement the actions composable**

Create `apps/web/composables/useFleetScheduleActions.ts`:

```ts
import { ref } from 'vue'
import { extractApiError } from '~/composables/useApi'
import type { FleetSchedulesApi } from '~/composables/useFleetSchedules'
import type { ScheduleDto } from '~/lib/fleet-types'

/**
 * Enable, disable and delete, shared by the list and the detail page (D223). A refusal (409 owner lost access, 404
 * stale, 403) shows the server's message and calls `onStale` so the page reloads; nothing is retried.
 */
export function useFleetScheduleActions(api: Pick<FleetSchedulesApi, 'enable' | 'disable' | 'remove'>, onStale: () => void) {
  const { t } = useI18n()
  const toast = useAppToast()
  const busy = ref(false)

  async function run<T>(action: () => Promise<T>, successKey: string): Promise<T | null> {
    busy.value = true
    try {
      const result = await action()
      toast.success(t(successKey))
      return result
    }
    catch (err: unknown) {
      toast.error(extractApiError(err))
      onStale()
      return null
    }
    finally {
      busy.value = false
    }
  }

  const setEnabled = (s: ScheduleDto, enabled: boolean): Promise<ScheduleDto | null> =>
    run(() => (enabled ? api.enable(s.id) : api.disable(s.id)), enabled ? 'fleet.schedules.toast.enabled' : 'fleet.schedules.toast.disabled')

  /** True when the schedule is gone. */
  async function remove(s: ScheduleDto): Promise<boolean> {
    if (!window.confirm(t('fleet.schedules.deleteConfirm', { name: s.name }))) return false
    const done = await run(async () => {
      await api.remove(s.id)
      return true
    }, 'fleet.schedules.toast.deleted')
    return done === true
  }

  return { busy, setEnabled, remove }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/web && bun run test -- tests/composables/useFleetSchedules.spec.ts tests/composables/useFleetScheduleActions.spec.ts`
Expected: PASS.

- [ ] **Step 6: Lint, types, commit**

Run: `cd apps/web && bun run lint && bun run type-check`

```bash
git add apps/web/composables/useFleetSchedules.ts apps/web/composables/useFleetScheduleActions.ts apps/web/tests/composables
git commit -m "feat(web): schedules transport and actions composables (S1b 3b)"
```

---
### Task 5: Create and edit dialog

**Files:**
- Create: `apps/web/components/fleet/ScheduleEditDialog.vue` (auto-imported as `FleetScheduleEditDialog`)
- Create: `apps/web/tests/components/fleet-schedule-edit-dialog.spec.ts`

**Interfaces:**
- Consumes: `useFleetSchedules(slug).create/update` (Task 4); `buildScheduleSchema`, `initialScheduleValues`,
  `toCreateScheduleBody`, `toSchedulePatchBody`, `browserTimeZone`, `timeZoneOptions`, `PLACEMENT_MODES` (Task 2);
  `FleetNativeSelect`; `FleetTokenListInput` (explicit import, as `pages/[project]/fleet/dispatch.vue` does).
- Produces: `<FleetScheduleEditDialog :open :slug :schedule :repo-options :runner-options :profile-suggestions
  :label-suggestions @update:open @saved(schedule) @failed />`. `schedule: null` creates. The schema mode is fixed at
  mount, so pages give the dialog `:key="editing?.id ?? 'new'"` (a create after an edit remounts it).

- [ ] **Step 1: Write the failing component test**

Create `apps/web/tests/components/fleet-schedule-edit-dialog.spec.ts`:

```ts
import { describe, test, expect, afterEach, jest } from '@jest/globals'
import * as Vue from 'vue'
import { ref, computed, watch, nextTick } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { uiStubs, enI18n, toastRecorder } from '../helpers/fleet-harness'
import * as apiModule from '../../composables/useApi'
import { ApiError } from '../../composables/useApi'
import type { ScheduleDto } from '../../lib/fleet-types'

const dialog = webFile('components', 'fleet', 'ScheduleEditDialog.vue')

const schedule = (over: Partial<ScheduleDto> = {}): ScheduleDto => ({
  id: 's1', projectId: 'p1', repoId: 'r1', name: 'nightly', cron: '0 9 * * 1-5', timezone: 'Asia/Singapore', feature: 'login',
  ref: 'main', profiles: ['fast'], maxCostUsd: '5.0000', selectorLabels: [], pinnedRunnerId: 'run1', enabled: true,
  nextFireAt: '2026-10-05T01:00:00.000Z', lastFiredAt: null, lastJobId: null, lastPassedCount: 0, noProgressTicks: 0,
  noProgressLimit: 3, disabledReason: null, totalCostUsd: '0.0000', createdById: 'u1', updatedById: 'u1',
  createdAt: '2026-10-02T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z', ...over,
})

interface Api { post: jest.Mock; patch: jest.Mock }

function harness(over: Partial<Api> = {}) {
  const api: Api = {
    post: jest.fn(async () => schedule({ id: 'new' })),
    patch: jest.fn(async () => schedule()),
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
    props: { slug: 'koda', repoOptions: [{ value: 'r1', label: 'acme/app' }], runnerOptions: [{ value: 'run1', label: 'mac-1' }], ...props },
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
const testids = (app: ReturnType<typeof mountDialog>): string[] =>
  [...app.find('[data-stub="fleet-select"]').map((n) => n.props.testid), ...app.find('[data-stub="input"]').map((n) => n.props['data-testid'])]
    .filter((id): id is string => typeof id === 'string')

afterEach(() => { delete (globalThis as Record<string, unknown>).useApi })

describe('FleetScheduleEditDialog (behaviour)', () => {
  test('edit of a pinned schedule patches every editable field, keeps the pin, then emits saved and closes', async () => {
    const { api, toasts, flush } = harness()
    const app = mountDialog({ open: true, schedule: schedule() }, api, toasts)
    await flush()

    await submit(app)
    await flush()

    expect(api.patch).toHaveBeenCalledWith('/projects/koda/fleet/schedules/s1', {
      name: 'nightly', cron: '0 9 * * 1-5', timezone: 'Asia/Singapore', ref: 'main', profiles: ['fast'], maxCostUsd: 5,
      noProgressLimit: 3, selectorLabels: [], pinnedRunnerId: 'run1',
    })
    expect(app.emitted('saved')).toHaveLength(1)
    expect(app.emitted('update:open').at(-1)).toEqual([false])
    expect(toasts.successes).toEqual(['Schedule saved'])
    app.unmount()
  })

  test('edit of a labels schedule sends pinnedRunnerId null (Review Focus 1)', async () => {
    const { api, toasts, flush } = harness()
    const app = mountDialog({ open: true, schedule: schedule({ pinnedRunnerId: null, selectorLabels: ['gpu'] }) }, api, toasts)
    await flush()
    await submit(app)
    await flush()
    expect(api.patch).toHaveBeenCalledWith('/projects/koda/fleet/schedules/s1', expect.objectContaining({ selectorLabels: ['gpu'], pinnedRunnerId: null }))
    app.unmount()
  })

  test('create shows repo and feature; edit shows the fixed hint instead (D203)', async () => {
    const { api, toasts, flush } = harness()
    const create = mountDialog({ open: true, schedule: null }, api, toasts)
    await flush()
    expect(testids(create)).toEqual(expect.arrayContaining(['fleet-schedule-repo', 'fleet-schedule-feature', 'fleet-schedule-placement']))
    expect(create.text()).not.toContain('The repo and the feature are fixed after create.')
    create.unmount()

    const edit = mountDialog({ open: true, schedule: schedule() }, api, toasts)
    await flush()
    expect(testids(edit)).not.toContain('fleet-schedule-repo')
    expect(testids(edit)).not.toContain('fleet-schedule-feature')
    expect(edit.text()).toContain('The repo and the feature are fixed after create.')
    edit.unmount()
  })

  test('the placement select offers the three modes, and the pin select is shown for a pinned schedule', async () => {
    const { api, toasts, flush } = harness()
    const app = mountDialog({ open: true, schedule: schedule() }, api, toasts)
    await flush()
    const placement = app.find('[data-stub="fleet-select"]').find((n) => n.props.testid === 'fleet-schedule-placement')
    expect(((placement?.props.options ?? []) as Array<{ value: string }>).map((o) => o.value)).toEqual(['auto', 'labels', 'pin'])
    expect(testids(app)).toContain('fleet-schedule-pin')
    app.unmount()
  })

  test('an empty create form does not post', async () => {
    const { api, toasts, flush } = harness()
    const app = mountDialog({ open: true, schedule: null }, api, toasts)
    await flush()
    await submit(app)
    await flush()
    expect(api.post).not.toHaveBeenCalled()
    app.unmount()
  })

  test('a refused save keeps the dialog open, shows the server message and emits failed', async () => {
    const { api, toasts, flush } = harness({
      patch: jest.fn(async () => { throw new ApiError(400, 'The schedule fires more often than every 15 minutes') }),
    })
    const app = mountDialog({ open: true, schedule: schedule() }, api, toasts)
    await flush()
    await submit(app)
    await flush()
    expect(toasts.errors).toEqual(['The schedule fires more often than every 15 minutes'])
    expect(app.emitted('failed')).toHaveLength(1)
    expect(app.emitted('update:open')).toEqual([])
    app.unmount()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/web && bun run test -- tests/components/fleet-schedule-edit-dialog.spec.ts`
Expected: FAIL (`ScheduleEditDialog.vue` does not exist).

- [ ] **Step 3: Implement the dialog**

Create `apps/web/components/fleet/ScheduleEditDialog.vue`:

```vue
<template>
  <Dialog :open="open" @update:open="$emit('update:open', $event)">
    <DialogContent class="max-h-[90vh] overflow-y-auto sm:max-w-[560px]">
      <DialogHeader>
        <DialogTitle>{{ schedule ? t('fleet.schedules.form.editTitle') : t('fleet.schedules.form.createTitle') }}</DialogTitle>
      </DialogHeader>

      <form class="space-y-4" data-testid="fleet-schedule-form" @submit="onSubmit">
        <FormField v-slot="{ componentField }" name="name">
          <FormItem>
            <FormLabel>{{ t('fleet.schedules.form.name') }}</FormLabel>
            <FormControl><Input v-bind="componentField" data-testid="fleet-schedule-name" /></FormControl>
            <FormMessage />
          </FormItem>
        </FormField>

        <template v-if="!schedule">
          <FormField v-slot="{ componentField }" name="repoId">
            <FormItem>
              <FormLabel>{{ t('fleet.schedules.form.repo') }}</FormLabel>
              <FormControl>
                <FleetNativeSelect v-bind="componentField" :options="repoOptions" :placeholder="t('fleet.schedules.form.repoPlaceholder')" testid="fleet-schedule-repo" />
              </FormControl>
              <FormMessage />
            </FormItem>
          </FormField>
          <FormField v-slot="{ componentField }" name="feature">
            <FormItem>
              <FormLabel>{{ t('fleet.schedules.form.feature') }}</FormLabel>
              <FormControl><Input v-bind="componentField" data-testid="fleet-schedule-feature" /></FormControl>
              <FormMessage />
            </FormItem>
          </FormField>
        </template>
        <p v-else class="text-sm text-muted-foreground" data-testid="fleet-schedule-fixed-hint">{{ t('fleet.schedules.form.fixedHint') }}</p>

        <div class="grid gap-4 sm:grid-cols-2">
          <FormField v-slot="{ componentField }" name="cron">
            <FormItem>
              <FormLabel>{{ t('fleet.schedules.form.cron') }}</FormLabel>
              <FormControl><Input v-bind="componentField" class="font-mono" data-testid="fleet-schedule-cron" /></FormControl>
              <FormMessage />
            </FormItem>
          </FormField>
          <FormField v-slot="{ componentField }" name="timezone">
            <FormItem>
              <FormLabel>{{ t('fleet.schedules.form.timezone') }}</FormLabel>
              <FormControl><Input v-bind="componentField" list="fleet-schedule-timezones" data-testid="fleet-schedule-timezone" /></FormControl>
              <FormMessage />
            </FormItem>
          </FormField>
        </div>
        <datalist id="fleet-schedule-timezones">
          <option v-for="zone in zones" :key="zone" :value="zone" />
        </datalist>
        <p class="text-xs text-muted-foreground">{{ t('fleet.schedules.form.cronHint') }} {{ t('fleet.schedules.form.timezoneHint') }}</p>

        <FormField v-slot="{ componentField }" name="ref">
          <FormItem>
            <FormLabel>{{ t('fleet.schedules.form.ref') }}</FormLabel>
            <FormControl><Input v-bind="componentField" data-testid="fleet-schedule-ref" /></FormControl>
            <p class="text-xs text-muted-foreground">{{ schedule ? t('fleet.schedules.form.refHintEdit') : t('fleet.schedules.form.refHintCreate') }}</p>
            <FormMessage />
          </FormItem>
        </FormField>

        <FormField name="profiles">
          <FormItem>
            <FormLabel>{{ t('fleet.schedules.form.profiles') }}</FormLabel>
            <FleetTokenListInput
              :model-value="formValues.profiles ?? []"
              :suggestions="profileSuggestions"
              :placeholder="t('fleet.schedules.form.profilePlaceholder')"
              test-id="fleet-schedule-profiles"
              @update:model-value="setFieldValue('profiles', $event)"
            />
            <FormMessage />
          </FormItem>
        </FormField>

        <div class="grid gap-4 sm:grid-cols-2">
          <FormField v-slot="{ componentField }" name="maxCostUsd">
            <FormItem>
              <FormLabel>{{ t('fleet.schedules.form.maxCost') }}</FormLabel>
              <FormControl><Input v-bind="componentField" inputmode="decimal" data-testid="fleet-schedule-max-cost" /></FormControl>
              <FormMessage />
            </FormItem>
          </FormField>
          <FormField v-slot="{ componentField }" name="noProgressLimit">
            <FormItem>
              <FormLabel>{{ t('fleet.schedules.form.noProgressLimit') }}</FormLabel>
              <FormControl><Input v-bind="componentField" inputmode="numeric" data-testid="fleet-schedule-no-progress-limit" /></FormControl>
              <FormMessage />
            </FormItem>
          </FormField>
        </div>
        <p class="text-xs text-muted-foreground">{{ t('fleet.schedules.form.noProgressHint') }}</p>

        <FormField v-slot="{ componentField }" name="placement">
          <FormItem>
            <FormLabel>{{ t('fleet.schedules.form.placement') }}</FormLabel>
            <FormControl>
              <FleetNativeSelect v-bind="componentField" :options="placementOptions" testid="fleet-schedule-placement" />
            </FormControl>
            <FormMessage />
          </FormItem>
        </FormField>

        <FormField v-if="formValues.placement === 'labels'" name="selectorLabels">
          <FormItem>
            <FleetTokenListInput
              :model-value="formValues.selectorLabels ?? []"
              :suggestions="labelSuggestions"
              :placeholder="t('fleet.schedules.form.labelPlaceholder')"
              test-id="fleet-schedule-labels"
              @update:model-value="setFieldValue('selectorLabels', $event)"
            />
            <FormMessage />
          </FormItem>
        </FormField>

        <FormField v-if="formValues.placement === 'pin'" v-slot="{ componentField }" name="pinnedRunnerId">
          <FormItem>
            <FormControl>
              <FleetNativeSelect v-bind="componentField" :options="runnerOptions" :placeholder="t('fleet.schedules.form.pinPlaceholder')" testid="fleet-schedule-pin" />
            </FormControl>
            <FormMessage />
          </FormItem>
        </FormField>

        <div class="flex justify-end gap-2">
          <Button type="button" variant="outline" @click="$emit('update:open', false)">{{ t('common.cancel') }}</Button>
          <Button type="submit" :disabled="isSubmitting" data-testid="fleet-schedule-submit">
            {{ isSubmitting ? t('fleet.schedules.form.submitting') : t('fleet.schedules.form.submit') }}
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
import { useFleetSchedules } from '~/composables/useFleetSchedules'
import {
  browserTimeZone, buildScheduleSchema, initialScheduleValues, PLACEMENT_MODES, timeZoneOptions, toCreateScheduleBody,
  toSchedulePatchBody,
} from '~/lib/fleet-schedules'
import type { ScheduleDto } from '~/lib/fleet-types'
import FleetTokenListInput from '~/components/fleet/FleetTokenListInput.vue'

const props = withDefaults(defineProps<{
  open: boolean
  slug: string
  /** null creates; a schedule edits it (repo and feature stay fixed, 3a D203). Pages key the dialog by it. */
  schedule: ScheduleDto | null
  repoOptions?: Array<{ value: string; label: string }>
  runnerOptions?: Array<{ value: string; label: string }>
  profileSuggestions?: string[]
  labelSuggestions?: string[]
}>(), { repoOptions: () => [], runnerOptions: () => [], profileSuggestions: () => [], labelSuggestions: () => [] })

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void
  (e: 'saved', schedule: ScheduleDto): void
  (e: 'failed'): void
}>()

const { t } = useI18n()
const toast = useAppToast()
const { create, update } = useFleetSchedules(props.slug)

const zones = timeZoneOptions()
const placementOptions = computed(() => PLACEMENT_MODES.map((mode) => ({ value: mode, label: t(`fleet.schedules.form.placementMode.${mode}`) })))
const initialValues = () => initialScheduleValues(props.schedule, browserTimeZone())

// D218: values under v-if stay put when their input unmounts; the body mappers read only the chosen placement.
const { handleSubmit, isSubmitting, resetForm, values: formValues, setFieldValue } = useForm({
  validationSchema: toTypedSchema(buildScheduleSchema(t, props.schedule ? 'edit' : 'create')),
  initialValues: initialValues(),
  keepValuesOnUnmount: true,
})

// Reopening shows the stored values again, not the last unsaved edit.
watch(() => props.open, (open) => {
  if (open) resetForm({ values: initialValues() })
})

const onSubmit = handleSubmit(async (values) => {
  try {
    const saved = props.schedule
      ? await update(props.schedule.id, toSchedulePatchBody(values))
      : await create(toCreateScheduleBody(values))
    toast.success(t(props.schedule ? 'fleet.schedules.toast.updated' : 'fleet.schedules.toast.created'))
    emit('saved', saved)
    emit('update:open', false)
  }
  catch (err: unknown) {
    // Stay open so the input is kept (D185 pattern); the page reloads in case its view is stale.
    toast.error(extractApiError(err))
    emit('failed')
  }
})
</script>
```

If `toTypedSchema` output does not type-check against `ScheduleFormValues` in the two mapper calls, convert explicitly
with a typed local (`const v: ScheduleFormValues = values`) and fix the schema, never with `as`.

- [ ] **Step 4: Run it to verify it passes**

Run: `cd apps/web && bun run test -- tests/components/fleet-schedule-edit-dialog.spec.ts`
Expected: PASS.

- [ ] **Step 5: Lint, types, commit**

Run: `cd apps/web && bun run lint && bun run type-check`

```bash
git add apps/web/components/fleet/ScheduleEditDialog.vue apps/web/tests/components/fleet-schedule-edit-dialog.spec.ts
git commit -m "feat(web): schedule create and edit dialog (S1b 3b)"
```

---

### Task 6: Schedule table and harness registration

**Files:**
- Create: `apps/web/components/fleet/ScheduleTable.vue` (auto-imported as `FleetScheduleTable`)
- Modify: `apps/web/tests/helpers/mount-sfc.ts` (`FleetComponentName`, `FLEET_COMPONENT_FILES`, `NUXT_AUTO_IMPORTS`)
- Modify: `apps/web/tests/helpers/fleet-harness.ts` (`NuxtLink` stub, `FleetScheduleEditDialog` stub)
- Create: `apps/web/tests/components/fleet-schedule-table.spec.ts`

**Interfaces:**
- Consumes: `formatInZone`, `scheduleStatusKey`, `canChangeSchedule`, `ScheduleViewer` (Task 2).
- Produces: `<FleetScheduleTable :schedules :slug :viewer :repo-name :owner-name :busy @edit(s) @toggle(s, enabled)
  @remove(s) />`. Row `data-testid="fleet-schedule-row-<id>"` with `data-enabled`; name link
  `data-testid="fleet-schedule-link"`; status badge `data-testid="fleet-schedule-status"` with `data-status` =
  `scheduleStatusKey`; buttons `fleet-schedule-enable|disable`, `fleet-schedule-edit`, `fleet-schedule-delete`.
  Harness names: `fleetComponents: ['FleetScheduleTable']`; stub tags `nuxt-link`, `fleet-schedule-edit-dialog`.

- [ ] **Step 1: Register the component and the stubs in the harness**

In `apps/web/tests/helpers/mount-sfc.ts`, extend the union and the map:

```ts
export type FleetComponentName =
  | 'FleetAge' | 'FleetRunnerCapabilityChips' | 'FleetRepoReachabilityBadge' | 'FleetNativeSelect' | 'FleetBudgetTable'
  | 'FleetScheduleTable' | 'FleetScheduleHistory'
```

```ts
  FleetScheduleTable: 'ScheduleTable.vue',
  FleetScheduleHistory: 'ScheduleHistory.vue',
```

(`ScheduleHistory.vue` is created in Task 8; nothing instantiates it before then.)

Still in `mount-sfc.ts`, add `'useAuth', 'useProjectMemberNames'` to `NUXT_AUTO_IMPORTS`. Only names on that list reach
a compiled module's scope; a name passed in `globals` but missing there is a ReferenceError at mount. The schedules
pages are the first harness-mounted pages that call these two.

```ts
const NUXT_AUTO_IMPORTS = [
  'useI18n', 'useAppToast', 'useApi', 'useRuntimeConfig', 'definePageMeta',
  'useVisiblePolling', 'useFleetRunners', 'useFleetRepos', 'useRoute',
  'useFleetDispatchOptions', 'useFleetJobs', 'useProjectViewerRole',
  'useAdminUsers', 'useProjectEvents', 'useAuth', 'useProjectMemberNames',
] as const
```

In `apps/web/tests/helpers/fleet-harness.ts`, add `['NuxtLink', 'nuxt-link'],` to the `uiStubs` list (after
`['PageHeader', 'page-header']`), and add to the `Object.assign(uiStubs, { ... })` block that holds the budget dialog
stubs:

```ts
  FleetScheduleEditDialog: {
    name: 'StubFleetScheduleEditDialog',
    props: ['open', 'schedule'],
    setup(props: { open?: boolean; schedule?: { id?: string } | null }, { attrs }: { attrs: Record<string, unknown> }) {
      return () =>
        h('x-stub-stub', { ...attrs, 'data-stub': 'fleet-schedule-edit-dialog', open: props.open === true, 'data-schedule': props.schedule?.id ?? '' })
    },
  },
```

Run: `cd apps/web && bun run test -- tests/pages tests/components`
Expected: PASS (the `NuxtLink` stub keeps slot text, so existing page specs are unaffected; if one asserted on an
unresolved `NuxtLink` element, update that assertion to `[data-stub="nuxt-link"]`).

- [ ] **Step 2: Write the failing table test**

Create `apps/web/tests/components/fleet-schedule-table.spec.ts`:

```ts
import { describe, test, expect } from '@jest/globals'
import * as Vue from 'vue'
import { ref, computed, watch, nextTick } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { uiStubs, enI18n } from '../helpers/fleet-harness'
import type { ScheduleDto } from '../../lib/fleet-types'
import type { ScheduleViewer } from '../../lib/fleet-schedules'

const table = webFile('components', 'fleet', 'ScheduleTable.vue')

const schedule = (id: string, over: Partial<ScheduleDto> = {}): ScheduleDto => ({
  id, projectId: 'p1', repoId: 'r1', name: `s-${id}`, cron: '0 9 * * 1-5', timezone: 'UTC', feature: 'login', ref: 'main',
  profiles: [], maxCostUsd: '5.0000', selectorLabels: [], pinnedRunnerId: null, enabled: true,
  nextFireAt: '2026-10-05T09:00:00.000Z', lastFiredAt: null, lastJobId: null, lastPassedCount: 0, noProgressTicks: 0,
  noProgressLimit: 3, disabledReason: null, totalCostUsd: '0.0000', createdById: 'owner', updatedById: 'owner',
  createdAt: '2026-10-02T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z', ...over,
})

function mountTable(schedules: ScheduleDto[], viewer: ScheduleViewer) {
  const app = mountSfc(table, {
    components: uiStubs,
    props: {
      schedules, slug: 'koda', viewer, busy: false,
      repoName: (id: string) => (id === 'r1' ? 'acme/app' : id),
      ownerName: (id: string) => (id === 'owner' ? 'Olive' : null),
    },
    globals: { ref, computed, watch, nextTick, onMounted: Vue.onMounted, useI18n: () => enI18n() },
  })
  const row = (id: string) => app.find('[data-stub="tr"]').find((r) => r.props['data-testid'] === `fleet-schedule-row-${id}`)
  const buttons = (id: string): string[] => {
    const r = row(id)
    return r ? app.find('[data-stub="button"]', r).map((b) => String(b.props['data-testid'])) : ['<missing>']
  }
  return { app, row, buttons }
}

const OWNER: ScheduleViewer = { userId: 'owner', canWork: true, canManage: false }
const OTHER_DEV: ScheduleViewer = { userId: 'dev2', canWork: true, canManage: false }
const ADMIN: ScheduleViewer = { userId: 'admin', canWork: true, canManage: true }
const VIEWER: ScheduleViewer = { userId: 'v', canWork: false, canManage: false }

describe('FleetScheduleTable', () => {
  test('owner and project admin get Disable, Edit, Delete; another developer and a viewer get nothing (Review Focus 2)', () => {
    for (const [viewer, expected] of [
      [OWNER, ['fleet-schedule-disable', 'fleet-schedule-edit', 'fleet-schedule-delete']],
      [ADMIN, ['fleet-schedule-disable', 'fleet-schedule-edit', 'fleet-schedule-delete']],
      [OTHER_DEV, []],
      [VIEWER, []],
    ] as const) {
      const m = mountTable([schedule('a')], viewer)
      expect(m.buttons('a')).toEqual(expected)
      m.app.unmount()
    }
  })

  test('a disabled schedule offers Enable, shows "-" for next fire and its reason (Review Focus 3)', () => {
    const m = mountTable([schedule('a', { enabled: false, nextFireAt: null, disabledReason: null })], OWNER)
    expect(m.buttons('a')[0]).toBe('fleet-schedule-enable')
    expect(m.row('a')?.props['data-enabled']).toBe('false')
    const status = m.app.find('[data-stub="badge"]').find((b) => b.props['data-testid'] === 'fleet-schedule-status')
    expect(status?.props['data-status']).toBe('manual')
    expect(m.app.textOf(status!).trim()).toBe('Disabled')
    const nextFire = m.app.find('[data-stub="td"]').find((c) => c.props['data-testid'] === 'fleet-schedule-next-fire')
    expect(m.app.textOf(nextFire!).trim()).toBe('-')
    m.app.unmount()
  })

  test('names the repo, the owner, a former owner, and links the name to the detail page', () => {
    const m = mountTable([schedule('a'), schedule('b', { createdById: 'gone', repoId: 'r-gone' })], ADMIN)
    const text = m.app.text()
    expect(text).toContain('acme/app')
    expect(text).toContain('Olive')
    expect(text).toContain('Former member')
    expect(text).toContain('r-gone')
    const link = m.app.find('[data-stub="nuxt-link"]').find((l) => l.props['data-testid'] === 'fleet-schedule-link')
    expect(link?.props.to).toBe('/koda/fleet/schedules/a')
    m.app.unmount()
  })

  test('buttons emit toggle with the target state, edit and remove with the row', () => {
    const m = mountTable([schedule('a')], OWNER)
    const r = m.row('a')!
    const click = (testid: string): void => {
      const b = m.app.find('[data-stub="button"]', r).find((x) => x.props['data-testid'] === testid)
      ;(b?.props.onClick as () => void)()
    }
    click('fleet-schedule-disable')
    click('fleet-schedule-edit')
    click('fleet-schedule-delete')
    expect(m.app.emitted('toggle')[0]?.[1]).toBe(false)
    expect((m.app.emitted('edit')[0]?.[0] as ScheduleDto).id).toBe('a')
    expect((m.app.emitted('remove')[0]?.[0] as ScheduleDto).id).toBe('a')
    m.app.unmount()
  })
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd apps/web && bun run test -- tests/components/fleet-schedule-table.spec.ts`
Expected: FAIL (`ScheduleTable.vue` does not exist).

- [ ] **Step 4: Implement the table**

Create `apps/web/components/fleet/ScheduleTable.vue`:

```vue
<template>
  <div class="overflow-x-auto" data-testid="fleet-schedules-table">
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{{ t('fleet.schedules.table.name') }}</TableHead>
          <TableHead>{{ t('fleet.schedules.table.target') }}</TableHead>
          <TableHead>{{ t('fleet.schedules.table.cron') }}</TableHead>
          <TableHead>{{ t('fleet.schedules.table.nextFire') }}</TableHead>
          <TableHead>{{ t('fleet.schedules.table.status') }}</TableHead>
          <TableHead>{{ t('fleet.schedules.table.owner') }}</TableHead>
          <TableHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow
          v-for="s in schedules"
          :key="s.id"
          :data-testid="`fleet-schedule-row-${s.id}`"
          :data-enabled="String(s.enabled)"
        >
          <TableCell>
            <NuxtLink :to="`/${slug}/fleet/schedules/${s.id}`" class="font-medium text-primary underline-offset-4 hover:underline" data-testid="fleet-schedule-link">{{ s.name }}</NuxtLink>
          </TableCell>
          <TableCell>
            <div>{{ repoName(s.repoId) }}</div>
            <div class="break-all text-xs text-muted-foreground">{{ s.feature }}</div>
          </TableCell>
          <TableCell>
            <div class="font-mono text-xs">{{ s.cron }}</div>
            <div class="text-xs text-muted-foreground">{{ s.timezone }}</div>
          </TableCell>
          <TableCell data-testid="fleet-schedule-next-fire">{{ formatInZone(s.nextFireAt, s.timezone) }}</TableCell>
          <TableCell>
            <Badge :variant="s.enabled ? 'default' : 'outline'" data-testid="fleet-schedule-status" :data-status="scheduleStatusKey(s)">
              {{ t(`fleet.schedules.status.${scheduleStatusKey(s)}`) }}
            </Badge>
          </TableCell>
          <TableCell>{{ ownerName(s.createdById) ?? t('fleet.schedules.detail.unknownOwner') }}</TableCell>
          <TableCell class="space-x-1 whitespace-nowrap text-right">
            <template v-if="canChangeSchedule(s, viewer)">
              <Button
                size="sm"
                variant="outline"
                :disabled="busy"
                :data-testid="s.enabled ? 'fleet-schedule-disable' : 'fleet-schedule-enable'"
                @click="$emit('toggle', s, !s.enabled)"
              >
                {{ s.enabled ? t('fleet.schedules.actions.disable') : t('fleet.schedules.actions.enable') }}
              </Button>
              <Button size="sm" variant="outline" :disabled="busy" data-testid="fleet-schedule-edit" @click="$emit('edit', s)">{{ t('fleet.schedules.actions.edit') }}</Button>
              <Button size="sm" variant="destructive" :disabled="busy" data-testid="fleet-schedule-delete" @click="$emit('remove', s)">{{ t('fleet.schedules.actions.delete') }}</Button>
            </template>
          </TableCell>
        </TableRow>
      </TableBody>
    </Table>
  </div>
</template>

<script setup lang="ts">
import { canChangeSchedule, formatInZone, scheduleStatusKey } from '~/lib/fleet-schedules'
import type { ScheduleViewer } from '~/lib/fleet-schedules'
import type { ScheduleDto } from '~/lib/fleet-types'

defineProps<{
  schedules: ScheduleDto[]
  slug: string
  viewer: ScheduleViewer
  repoName: (id: string) => string
  /** null for a former member. */
  ownerName: (id: string) => string | null
  busy: boolean
}>()

defineEmits<{
  (e: 'edit', schedule: ScheduleDto): void
  (e: 'toggle', schedule: ScheduleDto, enabled: boolean): void
  (e: 'remove', schedule: ScheduleDto): void
}>()

const { t } = useI18n()
</script>
```

- [ ] **Step 5: Run it to verify it passes**

Run: `cd apps/web && bun run test -- tests/components/fleet-schedule-table.spec.ts`
Expected: PASS.

- [ ] **Step 6: Lint, types, commit**

Run: `cd apps/web && bun run lint && bun run type-check`

```bash
git add apps/web/components/fleet/ScheduleTable.vue apps/web/tests/helpers apps/web/tests/components/fleet-schedule-table.spec.ts
git commit -m "feat(web): schedule table with owner-or-admin actions (S1b 3b)"
```

---
### Task 7: Schedules list page, navigation and breadcrumbs

**Files:**
- Create: `apps/web/pages/[project]/fleet/schedules/index.vue`
- Modify: `apps/web/pages/[project]/fleet/index.vue` (Schedules button)
- Modify: `apps/web/layouts/default.vue` (breadcrumbs)
- Create: `apps/web/tests/pages/fleet-schedules-list-page.spec.ts`
- Modify: `apps/web/tests/pages/fleet-jobs-list.spec.ts`, `apps/web/tests/layouts/fleet-jobs-nav.spec.ts`

**Interfaces:**
- Consumes: `useFleetSchedules`, `useFleetScheduleActions` (Task 4), `FleetScheduleTable` (Task 6),
  `FleetScheduleEditDialog` (Task 5), `isForbidden` (`~/composables/useFleetBudgetPage`), `canWorkOnFleet`,
  `createDebouncer`, auto-imported `useAuth`, `useProjectViewerRole`, `useFleetDispatchOptions`,
  `useProjectMemberNames`, `useProjectEvents`, `useVisiblePolling`.
- Produces: route `/:project/fleet/schedules`; testids `fleet-schedule-create`, `fleet-schedule-readonly`,
  `fleet-schedule-forbidden`; jobs-list button `fleet-schedules-link` (Task 9 E2E uses `fleet-schedule-create` and
  the row/link testids of Task 6).

- [ ] **Step 1: Write the failing page test**

Create `apps/web/tests/pages/fleet-schedules-list-page.spec.ts`:

```ts
import { describe, test, expect, afterEach, jest } from '@jest/globals'
import * as Vue from 'vue'
import { ref, computed, watch, nextTick } from 'vue'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { uiStubs, enI18n, toastRecorder } from '../helpers/fleet-harness'
import * as apiModule from '../../composables/useApi'
import { ApiError } from '../../composables/useApi'
import type { ScheduleDto } from '../../lib/fleet-types'

const pageFile = webFile('pages', '[project]', 'fleet', 'schedules', 'index.vue')
const source = readFileSync(path.join(__dirname, '../..', 'pages', '[project]', 'fleet', 'schedules', 'index.vue'), 'utf-8')

const schedule = (id: string, over: Partial<ScheduleDto> = {}): ScheduleDto => ({
  id, projectId: 'p1', repoId: 'r1', name: `s-${id}`, cron: '0 9 * * 1-5', timezone: 'UTC', feature: 'login', ref: 'main',
  profiles: [], maxCostUsd: '5.0000', selectorLabels: [], pinnedRunnerId: null, enabled: true,
  nextFireAt: '2026-10-05T09:00:00.000Z', lastFiredAt: null, lastJobId: null, lastPassedCount: 0, noProgressTicks: 0,
  noProgressLimit: 3, disabledReason: null, totalCostUsd: '0.0000', createdById: 'owner', updatedById: 'owner',
  createdAt: '2026-10-02T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z', ...over,
})

const ROWS = [schedule('a'), schedule('b', { createdById: 'someone-else' })]
type Role = { canManage: boolean; viewerRole: string | null }
const DEVELOPER: Role = { canManage: false, viewerRole: 'DEVELOPER' }
const VIEWER: Role = { canManage: false, viewerRole: 'VIEWER' }
const ADMIN: Role = { canManage: true, viewerRole: 'ADMIN' }

function mountList(rows: ScheduleDto[], role: Role, get?: jest.Mock) {
  const api = {
    get: get ?? jest.fn(async () => rows),
    post: jest.fn(async (p: string) => schedule('a', { enabled: !p.endsWith('/disable') })),
    patch: jest.fn(),
    delete: jest.fn(async () => undefined),
  }
  const toasts = toastRecorder()
  let task: () => Promise<void> = async () => undefined
  const polling = { start: jest.fn(), stop: jest.fn(), runNow: async (): Promise<void> => { await task() }, isActive: () => true }
  globalThis.window = { confirm: () => true } as never
  ;(globalThis as Record<string, unknown>).useApi = () => ({ $api: api })

  const app = mountSfc(pageFile, {
    components: uiStubs,
    fleetComponents: ['FleetScheduleTable'],
    alias: { '~/composables/useApi': apiModule },
    globals: {
      ref, computed, watch, nextTick,
      onMounted: Vue.onMounted,
      onBeforeUnmount: Vue.onBeforeUnmount,
      useI18n: () => enI18n(),
      useAppToast: () => toasts,
      useApi: () => ({ $api: api }),
      useRoute: () => ({ params: { project: 'koda' } }),
      useAuth: () => ({ user: ref({ id: 'owner' }) }),
      useProjectViewerRole: () => ({ data: ref(role) }),
      useFleetDispatchOptions: () => ({
        repos: ref([{ id: 'r1', owner: 'acme', name: 'app' }]), runners: ref([]),
        repoName: (id: string) => (id === 'r1' ? 'acme/app' : id), runnerName: (id: string | null) => id,
        profileOptions: ref([]), labelOptions: ref([]), load: async () => undefined,
      }),
      useProjectMemberNames: () => ({ load: async () => undefined, nameOf: (id: string) => (id === 'owner' ? 'Olive' : null) }),
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
  const row = (id: string) => app.find('[data-stub="tr"]').find((r) => r.props['data-testid'] === `fleet-schedule-row-${id}`)
  const rowButtons = (id: string): string[] => {
    const r = row(id)
    return r ? app.find('[data-stub="button"]', r).map((b) => String(b.props['data-testid'])) : ['<missing>']
  }
  const hasTestid = (testid: string): boolean => app.find('[data-stub="button"]').some((b) => b.props['data-testid'] === testid)
  return { app, api, toasts, polling, settle, row, rowButtons, hasTestid }
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).window
  delete (globalThis as Record<string, unknown>).useApi
})

describe('Schedules list page (behaviour)', () => {
  test('a developer creates, and changes only their own schedule (Review Focus 2)', async () => {
    const m = mountList(ROWS, DEVELOPER)
    await m.settle()
    expect(m.hasTestid('fleet-schedule-create')).toBe(true)
    expect(m.rowButtons('a')).toEqual(['fleet-schedule-disable', 'fleet-schedule-edit', 'fleet-schedule-delete'])
    expect(m.rowButtons('b')).toEqual([])
    expect(m.app.text()).toContain('Only the schedule owner or a project administrator can change a schedule.')
    m.app.unmount()
  })

  test('a viewer reads only: no create, no row action, no dialog', async () => {
    const m = mountList(ROWS, VIEWER)
    await m.settle()
    expect(m.hasTestid('fleet-schedule-create')).toBe(false)
    expect(m.rowButtons('a')).toEqual([])
    expect(m.app.find('[data-stub="fleet-schedule-edit-dialog"]')).toHaveLength(0)
    expect(m.app.text()).toContain('Only the schedule owner or a project administrator can change a schedule.')
    m.app.unmount()
  })

  test('a project admin changes every schedule and sees no read-only line', async () => {
    const m = mountList(ROWS, ADMIN)
    await m.settle()
    expect(m.rowButtons('b')).toEqual(['fleet-schedule-disable', 'fleet-schedule-edit', 'fleet-schedule-delete'])
    expect(m.app.text()).not.toContain('Only the schedule owner or a project administrator can change a schedule.')
    m.app.unmount()
  })

  test('Disable posts to the disable route, updates the row and toasts', async () => {
    const m = mountList(ROWS, DEVELOPER)
    await m.settle()
    const disable = m.app.find('[data-stub="button"]', m.row('a')).find((b) => b.props['data-testid'] === 'fleet-schedule-disable')
    await (disable?.props.onClick as () => Promise<void>)()
    await m.settle()
    expect(m.api.post).toHaveBeenCalledWith('/projects/koda/fleet/schedules/a/disable')
    expect(m.row('a')?.props['data-enabled']).toBe('false')
    expect(m.toasts.successes).toEqual(['Schedule disabled'])
    m.app.unmount()
  })

  test('Edit opens the dialog on that schedule; Create opens it empty', async () => {
    const m = mountList(ROWS, DEVELOPER)
    await m.settle()
    const edit = m.app.find('[data-stub="button"]', m.row('a')).find((b) => b.props['data-testid'] === 'fleet-schedule-edit')
    ;(edit?.props.onClick as () => void)()
    await m.settle()
    const dialog = m.app.one('[data-stub="fleet-schedule-edit-dialog"]')
    expect(dialog?.props.open).toBe(true)
    expect(dialog?.props['data-schedule']).toBe('a')
    m.app.unmount()
  })

  test('a 403 shows the forbidden line, no table, and stops polling', async () => {
    const m = mountList(ROWS, VIEWER, jest.fn(async () => { throw new ApiError(40003, 'forbidden') }))
    await m.settle()
    expect(m.app.text()).toContain('You do not have access to this project.')
    expect(m.app.find('[data-stub="tr"]')).toHaveLength(0)
    expect(m.polling.stop).toHaveBeenCalled()
    m.app.unmount()
  })

  test('no schedules shows the empty state', async () => {
    const m = mountList([], DEVELOPER)
    await m.settle()
    expect(m.app.one('[data-stub="empty-state"]')?.props.message).toBe('No schedules yet')
    m.app.unmount()
  })

  test('live: fleet_job notices and resync reload, debounced; the poll runs every 60 s (D222)', () => {
    expect(source).toContain('const POLL_MS = 60_000')
    expect(source).toContain('onFleetJob: () => liveReload.trigger()')
    expect(source).toContain('onResync: () => liveReload.trigger()')
    expect(source).toContain(':key="editing?.id ?? \'new\'"')
  })
})
```

Append to `apps/web/tests/pages/fleet-jobs-list.spec.ts` (inside its `describe`):

```ts
  test('every member gets a Schedules button before Budgets (3b D216)', () => {
    expect(list).toMatch(/<Button variant="outline" data-testid="fleet-schedules-link" @click="navigateTo\(`\/\$\{slug\}\/fleet\/schedules`\)">/)
    expect(list.indexOf('fleet-schedules-link')).toBeLessThan(list.indexOf('fleet-budgets-link'))
  })
```

Append to `apps/web/tests/layouts/fleet-jobs-nav.spec.ts` (inside its `describe`):

```ts
  test('breadcrumbs cover the schedules list and a schedule, under Fleet jobs (3b D216)', () => {
    expect(layout).toContain('if (path === `/${project}/fleet/schedules`) {')
    expect(layout).toContain('if (path.startsWith(`/${project}/fleet/schedules/`)) {')
    expect(layout).toContain("t('fleet.schedules.title')")
    expect(layout).toContain("t('fleet.schedules.detailTitle')")
    // The schedule branches must come before the generic /fleet/ branch.
    expect(layout.indexOf('/fleet/schedules/`)')).toBeLessThan(layout.indexOf('if (path.startsWith(`/${project}/fleet/`)) {'))
  })
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/web && bun run test -- tests/pages/fleet-schedules-list-page.spec.ts tests/pages/fleet-jobs-list.spec.ts tests/layouts/fleet-jobs-nav.spec.ts`
Expected: FAIL (page file missing; button and breadcrumb branches missing).

- [ ] **Step 3: Implement the list page**

Create `apps/web/pages/[project]/fleet/schedules/index.vue`:

```vue
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { extractApiError } from '~/composables/useApi'
import { isForbidden } from '~/composables/useFleetBudgetPage'
import { useFleetScheduleActions } from '~/composables/useFleetScheduleActions'
import { useFleetSchedules } from '~/composables/useFleetSchedules'
import { createDebouncer } from '~/lib/debounce'
import { canWorkOnFleet } from '~/lib/fleet-jobs'
import type { ScheduleViewer } from '~/lib/fleet-schedules'
import type { ScheduleDto } from '~/lib/fleet-types'

definePageMeta({ layout: 'default' })

/** D222: a tick that only moves nextFireAt, skips or coalesces sends no fleet_job notice; 60 s is the ticker cadence. */
const POLL_MS = 60_000

const route = useRoute()
const slug = route.params.project as string
const { t } = useI18n()
const toast = useAppToast()
const auth = useAuth()
const { data: viewerRole } = useProjectViewerRole(slug)
const options = useFleetDispatchOptions(slug)
const people = useProjectMemberNames(slug)
const api = useFleetSchedules(slug)

// D217: the server is the gate; this only decides which controls to draw.
const viewer = computed<ScheduleViewer>(() => ({
  userId: auth.user.value?.id ?? null,
  canWork: canWorkOnFleet(viewerRole.value),
  canManage: viewerRole.value.canManage,
}))

const loaded = ref(false)
const pending = ref(true)
const loadFailed = ref(false)
const stale = ref(false)
const forbidden = ref(false)
const editOpen = ref(false)
const editing = ref<ScheduleDto | null>(null)

/** The first load reports; a failed poll keeps the last rows and marks them stale. */
async function refresh(): Promise<void> {
  try {
    await api.load()
    loaded.value = true
    loadFailed.value = false
    stale.value = false
  }
  catch (err: unknown) {
    if (isForbidden(err)) forbidden.value = true
    else if (loaded.value) stale.value = true
    else {
      loadFailed.value = true
      toast.error(extractApiError(err))
    }
  }
  finally {
    pending.value = false
  }
}

const actions = useFleetScheduleActions(api, () => { void refresh() })

async function poll(): Promise<void> {
  await refresh()
  if (forbidden.value) polling.stop()
}

// Declared after poll, which it runs; poll only reaches `polling` when it is called.
const polling = useVisiblePolling(poll, POLL_MS)
const liveReload = createDebouncer(() => { void refresh() }, 300)

onMounted(() => {
  void polling.runNow()
  polling.start()
  // Names are cosmetic: a failure leaves ids on screen.
  void options.load().catch(() => undefined)
  void people.load().catch(() => undefined)
})
onBeforeUnmount(() => {
  polling.stop()
  liveReload.cancel()
})
useProjectEvents(slug, {
  onFleetJob: () => liveReload.trigger(),
  onResync: () => liveReload.trigger(),
})

function openCreate(): void {
  editing.value = null
  editOpen.value = true
}

function openEdit(schedule: ScheduleDto): void {
  editing.value = schedule
  editOpen.value = true
}

const repoOptions = computed(() => options.repos.value.map((r) => ({ value: r.id, label: `${r.owner}/${r.name}` })))
const runnerOptions = computed(() => options.runners.value.map((r) => ({ value: r.id, label: r.name })))
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('fleet.schedules.title')" :subtitle="t('fleet.schedules.subtitle')">
      <template #actions>
        <Button v-if="viewer.canWork && !forbidden" data-testid="fleet-schedule-create" @click="openCreate()">
          {{ t('fleet.schedules.actions.create') }}
        </Button>
      </template>
    </PageHeader>

    <p v-if="!viewer.canManage && !forbidden" class="text-sm text-muted-foreground" data-testid="fleet-schedule-readonly">{{ t('fleet.schedules.readOnly') }}</p>
    <p v-if="forbidden" class="text-sm text-muted-foreground" data-testid="fleet-schedule-forbidden">{{ t('fleet.schedules.forbidden') }}</p>
    <p v-if="stale" class="text-sm text-muted-foreground">{{ t('fleet.common.stale') }}</p>

    <LoadingState v-if="pending" />
    <ErrorState v-else-if="loadFailed" @retry="refresh()" />
    <template v-else-if="!forbidden">
      <EmptyState v-if="api.schedules.value.length === 0" :message="t('fleet.schedules.empty')" />
      <FleetScheduleTable
        v-else
        :schedules="api.schedules.value"
        :slug="slug"
        :viewer="viewer"
        :repo-name="options.repoName"
        :owner-name="people.nameOf"
        :busy="actions.busy.value"
        @edit="openEdit"
        @toggle="(schedule, enabled) => actions.setEnabled(schedule, enabled)"
        @remove="(schedule) => actions.remove(schedule)"
      />
    </template>

    <FleetScheduleEditDialog
      v-if="viewer.canWork"
      :key="editing?.id ?? 'new'"
      v-model:open="editOpen"
      :slug="slug"
      :schedule="editing"
      :repo-options="repoOptions"
      :runner-options="runnerOptions"
      :profile-suggestions="options.profileOptions.value"
      :label-suggestions="options.labelOptions.value"
      @saved="api.apply"
      @failed="refresh()"
    />
  </div>
</template>
```

- [ ] **Step 4: Add the Schedules button and the breadcrumbs**

In `apps/web/pages/[project]/fleet/index.vue`, inside `<template #actions>`, before the `fleet-budgets-link` button:

```vue
        <Button variant="outline" data-testid="fleet-schedules-link" @click="navigateTo(`/${slug}/fleet/schedules`)">
          {{ t('fleet.jobs.schedules') }}
        </Button>
```

In `apps/web/layouts/default.vue`, inside `breadcrumbItems`, directly before
`if (path.startsWith(\`/${project}/fleet/\`)) {`:

```ts
  const fleetJobs = { label: t('nav.fleetJobs'), to: `/${project}/fleet` }
  if (path === `/${project}/fleet/schedules`) {
    return [{ label: 'Koda', to: '/' }, projectBase, fleetJobs, { label: t('fleet.schedules.title') }]
  }
  if (path.startsWith(`/${project}/fleet/schedules/`)) {
    const schedules = { label: t('fleet.schedules.title'), to: `/${project}/fleet/schedules` }
    return [{ label: 'Koda', to: '/' }, projectBase, fleetJobs, schedules, { label: t('fleet.schedules.detailTitle') }]
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/web && bun run test -- tests/pages/fleet-schedules-list-page.spec.ts tests/pages/fleet-jobs-list.spec.ts tests/layouts`
Expected: PASS.

- [ ] **Step 6: Lint, types, commit**

Run: `cd apps/web && bun run lint && bun run type-check`

```bash
git add "apps/web/pages/[project]/fleet/schedules/index.vue" "apps/web/pages/[project]/fleet/index.vue" apps/web/layouts/default.vue \
  apps/web/tests/pages apps/web/tests/layouts
git commit -m "feat(web): project schedules page, Schedules button and breadcrumbs (S1b 3b)"
```

---
### Task 8: Run history, the schedule detail page, and the schedule link on a job

**Files:**
- Create: `apps/web/components/fleet/ScheduleHistory.vue` (auto-imported as `FleetScheduleHistory`)
- Create: `apps/web/pages/[project]/fleet/schedules/[id].vue`
- Modify: `apps/web/pages/[project]/fleet/jobs/[id].vue`
- Create: `apps/web/tests/components/fleet-schedule-history.spec.ts`, `apps/web/tests/pages/fleet-schedule-detail.spec.ts`
- Modify: `apps/web/tests/pages/fleet-job-detail.spec.ts`

**Interfaces:**
- Consumes: `historyRows`, `formatDelta`, `HistoryRow`, `formatInZone`, `scheduleStatusKey`, `canChangeSchedule`,
  `placementOf` (Task 2); `useFleetSchedules`, `useFleetScheduleActions` (Task 4); `useFleetJobs(slug).load({ scheduleId,
  page })` with `jobs`, `hasNext`, `page` (Task 2 filter); `FleetScheduleEditDialog` (Task 5); `FleetJobStateBadge`
  (explicit import); `formatUsd`, `canWorkOnFleet` (`~/lib/fleet-jobs`).
- Produces: route `/:project/fleet/schedules/:id`; testids used by Task 9: `fleet-schedule-status` (badge with
  `data-status`), `fleet-schedule-total-cost`, `fleet-schedule-history-empty`, `fleet-schedule-run-<jobId>` rows each
  with `fleet-job-state` (badge) and `fleet-schedule-run-stories`; job page `fleet-job-schedule-link`.

- [ ] **Step 1: Write the failing history component test**

Create `apps/web/tests/components/fleet-schedule-history.spec.ts`:

```ts
import { describe, test, expect } from '@jest/globals'
import * as Vue from 'vue'
import { ref, computed, watch, nextTick } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { uiStubs, enI18n } from '../helpers/fleet-harness'
import { historyRows } from '../../lib/fleet-schedules'
import type { FleetJobDto } from '../../lib/fleet-types'

const history = webFile('components', 'fleet', 'ScheduleHistory.vue')

const job = (id: string, over: Partial<FleetJobDto> = {}): FleetJobDto => ({
  id, projectId: 'p1', repoId: 'r1', ref: 'main', command: 'RUN', feature: 'login', planFrom: null, profiles: [],
  maxCostUsd: '5.0000', bashMode: 'raw', selectorLabels: [], pinnedRunnerId: null, runnerId: null, leaseEpoch: 1,
  state: 'COMPLETED', stateReason: null, requestedById: 'u1', queuedAt: '2026-10-02T00:00:00.000Z', assignedAt: null,
  startedAt: null, finishedAt: null, cancelRequestedAt: null, naxRunId: null, naxLogRunId: null, naxCostRunId: null,
  progress: { total: 2, passed: 2, failed: 0, paused: 0, blocked: 0, pending: 0 }, currentStoryId: null, currentPhase: null,
  costSpentUsd: '0.9000', lastHeartbeatAt: null, finishResult: null, escalationReason: null, exitCode: null,
  resultBranch: null, resultSha: null, resultPrUrl: null, wipPush: null, stories: null, storiesTruncated: false,
  scheduleId: 's1', coalescedCount: 0, ...over,
})

function mountHistory(jobs: FleetJobDto[], oldestLoaded = true) {
  return mountSfc(history, {
    components: uiStubs,
    props: { slug: 'koda', rows: historyRows(jobs, oldestLoaded) },
    globals: { ref, computed, watch, nextTick, onMounted: Vue.onMounted, useI18n: () => enI18n() },
  })
}

const cell = (app: ReturnType<typeof mountHistory>, rowId: string, testid: string): string => {
  const row = app.find('[data-stub="tr"]').find((r) => r.props['data-testid'] === `fleet-schedule-run-${rowId}`)
  const found = row ? app.find('[data-stub="td"]', row).find((c) => c.props['data-testid'] === testid) : undefined
  return found ? app.textOf(found).trim() : '<missing>'
}

describe('FleetScheduleHistory', () => {
  test('no runs shows the empty line', () => {
    const app = mountHistory([])
    // The EmptyState stub keeps `message` as a prop (as on the budgets pages), so the copy is asserted there.
    expect(app.one('[data-stub="empty-state"]')?.props.message).toBe('No runs yet')
    expect(app.find('[data-stub="tr"]').filter((r) => String(r.props['data-testid']).startsWith('fleet-schedule-run-'))).toHaveLength(0)
    app.unmount()
  })

  test('a row: link to the job, state badge, stories with delta, cost, merged fires', () => {
    const app = mountHistory([job('j2', { coalescedCount: 2 }), job('j1', { progress: { total: 2, passed: 1, failed: 0, paused: 0, blocked: 0, pending: 1 }, state: 'FAILED' })])
    expect(cell(app, 'j2', 'fleet-schedule-run-stories')).toBe('2/2 (+1)')
    expect(cell(app, 'j1', 'fleet-schedule-run-stories')).toBe('1/2 (+1)')
    expect(cell(app, 'j2', 'fleet-schedule-run-cost')).toBe('$0.90')
    expect(cell(app, 'j2', 'fleet-schedule-run-coalesced')).toBe('2')
    const link = app.find('[data-stub="nuxt-link"]').find((l) => l.props.to === '/koda/fleet/jobs/j2')
    expect(link).toBeDefined()
    const states = app.find('[data-stub="badge"]').filter((b) => b.props['data-testid'] === 'fleet-job-state').map((b) => b.props['data-state'])
    expect(states).toEqual(['COMPLETED', 'FAILED'])
    app.unmount()
  })

  test('push outcome, budget stop and a raw reason are rendered; no progress shows "-"', () => {
    const app = mountHistory([
      job('j3', { progress: null, stateReason: 'checkout: branch diverged', wipPush: 'pushed' }),
      job('j2', { stateReason: 'budget:pol1', wipPush: 'failed:rejected' }),
    ], false)
    expect(cell(app, 'j3', 'fleet-schedule-run-stories')).toBe('-')
    expect(cell(app, 'j3', 'fleet-schedule-run-push')).toBe('Progress pushed to the branch')
    expect(cell(app, 'j3', 'fleet-schedule-run-reason')).toBe('checkout: branch diverged')
    expect(cell(app, 'j2', 'fleet-schedule-run-push')).toBe('Progress push failed: rejected')
    expect(cell(app, 'j2', 'fleet-schedule-run-reason')).toBe('Stopped by a fleet budget')
    // Oldest loaded row of a page that is not the last: no delta (Review Focus 5).
    expect(cell(app, 'j2', 'fleet-schedule-run-stories')).toBe('2/2 (-)')
    app.unmount()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/web && bun run test -- tests/components/fleet-schedule-history.spec.ts`
Expected: FAIL (`ScheduleHistory.vue` does not exist).

- [ ] **Step 3: Implement the history component**

Create `apps/web/components/fleet/ScheduleHistory.vue`:

```vue
<template>
  <div v-if="rows.length === 0" data-testid="fleet-schedule-history-empty">
    <EmptyState :message="t('fleet.schedules.history.empty')" />
  </div>
  <div v-else class="overflow-x-auto">
    <Table data-testid="fleet-schedule-history">
      <TableHeader>
        <TableRow>
          <TableHead>{{ t('fleet.schedules.history.job') }}</TableHead>
          <TableHead>{{ t('fleet.schedules.history.state') }}</TableHead>
          <TableHead>{{ t('fleet.schedules.history.stories') }}</TableHead>
          <TableHead>{{ t('fleet.schedules.history.cost') }}</TableHead>
          <TableHead>{{ t('fleet.schedules.history.coalesced') }}</TableHead>
          <TableHead>{{ t('fleet.schedules.history.push') }}</TableHead>
          <TableHead>{{ t('fleet.schedules.history.reason') }}</TableHead>
          <TableHead>{{ t('fleet.schedules.history.queued') }}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow v-for="row in rows" :key="row.job.id" :data-testid="`fleet-schedule-run-${row.job.id}`">
          <TableCell>
            <NuxtLink :to="`/${slug}/fleet/jobs/${row.job.id}`" class="font-mono text-xs text-primary underline-offset-4 hover:underline">{{ row.job.id.slice(0, 8) }}</NuxtLink>
          </TableCell>
          <TableCell><FleetJobStateBadge :state="row.job.state" /></TableCell>
          <TableCell data-testid="fleet-schedule-run-stories">{{ storiesText(row) }}</TableCell>
          <TableCell data-testid="fleet-schedule-run-cost">{{ row.cost }}</TableCell>
          <TableCell data-testid="fleet-schedule-run-coalesced">{{ row.job.coalescedCount }}</TableCell>
          <TableCell data-testid="fleet-schedule-run-push" class="text-xs">{{ pushText(row) }}</TableCell>
          <TableCell data-testid="fleet-schedule-run-reason" class="max-w-[16rem] break-words text-xs" :title="row.job.stateReason ?? ''">{{ reasonText(row) }}</TableCell>
          <TableCell class="whitespace-nowrap text-xs">{{ new Date(row.job.queuedAt).toLocaleString() }}</TableCell>
        </TableRow>
      </TableBody>
    </Table>
  </div>
</template>

<script setup lang="ts">
import { formatDelta } from '~/lib/fleet-schedules'
import type { HistoryRow } from '~/lib/fleet-schedules'
import FleetJobStateBadge from '~/components/fleet/FleetJobStateBadge.vue'

defineProps<{ slug: string; rows: HistoryRow[] }>()

const { t } = useI18n()

/** D221: passed/total with the delta to the previous run; "-" without progress. */
function storiesText(row: HistoryRow): string {
  if (row.passed === null || row.total === null) return '-'
  return t('fleet.schedules.history.storiesValue', { passed: row.passed, total: row.total, delta: formatDelta(row.delta) })
}

function pushText(row: HistoryRow): string {
  if (row.wipPush === null) return '-'
  return row.wipPush.key === 'failed'
    ? t('fleet.jobs.detail.wipPush.failed', { reason: row.wipPush.reason })
    : t(`fleet.jobs.detail.wipPush.${row.wipPush.key}`)
}

/** A budget stop reads as one (D188); any other reason is shown as stored. */
function reasonText(row: HistoryRow): string {
  if (row.budgetPolicyId !== null) return t('fleet.schedules.history.budgetStop')
  return row.job.stateReason ?? '-'
}
</script>
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd apps/web && bun run test -- tests/components/fleet-schedule-history.spec.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing detail-page and job-page tests**

The detail page is wiring over components and composables already tested; its test pins the wiring from the source,
the way `tests/pages/fleet-job-detail.spec.ts` does, and the E2E (Task 9) drives it for real. Create
`apps/web/tests/pages/fleet-schedule-detail.spec.ts`:

```ts
import { describe, expect, test } from '@jest/globals'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const detail = readFileSync(path.join(__dirname, '../..', 'pages', '[project]', 'fleet', 'schedules', '[id].vue'), 'utf-8')

const liveHandlers = (source: string): string => {
  const start = source.indexOf('useProjectEvents(')
  expect(start).toBeGreaterThan(-1)
  return source.slice(start, source.indexOf('\n})', start))
}

describe('schedule detail page', () => {
  test('history comes from the jobs API filtered by this schedule, paged, newest first (D221)', () => {
    expect(detail).toContain('jobsApi.load({ scheduleId, page: historyPage.value })')
    expect(detail).toContain('historyRows(jobsApi.jobs.value, !jobsApi.hasNext.value)')
    expect(detail).toContain('<FleetScheduleHistory :slug="slug" :rows="rows" />')
  })

  test('live: any fleet_job notice and resync reload schedule and history, debounced; 60 s poll (D222)', () => {
    const handlers = liveHandlers(detail)
    expect(handlers).toContain('onFleetJob: () => liveReload.trigger()')
    expect(handlers).toContain('onResync: () => liveReload.trigger()')
    expect(detail).toContain('const POLL_MS = 60_000')
    expect(detail).toMatch(/async function reload\(\): Promise<void> \{\s*await Promise\.all\(\[loadSchedule\(true\), loadHistory\(\)\]\)/)
    expect(detail).toMatch(/onBeforeUnmount\(\(\) => \{\s*polling\.stop\(\)\s*liveReload\.cancel\(\)/)
  })

  test('controls only for the owner or a project admin; delete goes back to the list (D217, D223)', () => {
    expect(detail).toContain('canChangeSchedule(schedule.value, viewer.value)')
    expect(detail).toContain('<template v-if="canChange">')
    expect(detail).toContain('if (await actions.remove(current)) await navigateTo(`/${slug}/fleet/schedules`)')
  })

  test('a schedule that is gone drops the page to the error state even on a silent reload (Review Focus 4)', () => {
    expect(detail).toContain('const isNotFound = (err: unknown): boolean => err instanceof ApiError && (err.code === 40004 || err.code === 404)')
    expect(detail).toMatch(/if \(!silent \|\| isNotFound\(err\)\) \{\s*schedule\.value = null\s*loadFailed\.value = true/)
    expect(detail).toContain('const actions = useFleetScheduleActions(api, () => { void reload() })')
  })

  test('polling starts synchronously in onMounted, so leaving during the first load cannot leak it', () => {
    expect(detail).toMatch(/onMounted\(\(\) => \{[\s\S]*?polling\.start\(\)\s*void loadSchedule\(false\)/)
  })

  test('status, next fire in the schedule zone, and the cost so far are rendered with test ids', () => {
    expect(detail).toContain('data-testid="fleet-schedule-status"')
    expect(detail).toContain(':data-status="scheduleStatusKey(schedule)"')
    expect(detail).toContain('formatInZone(schedule.nextFireAt, schedule.timezone)')
    expect(detail).toContain('data-testid="fleet-schedule-total-cost"')
  })
})
```

Append to `apps/web/tests/pages/fleet-job-detail.spec.ts` (inside its `describe`):

```ts
  test('a scheduled job links back to its schedule and shows merged fires (3b D216)', () => {
    expect(detail).toContain('<span v-if="job.scheduleId"')
    expect(detail).toContain(':to="`/${slug}/fleet/schedules/${job.scheduleId}`"')
    expect(detail).toContain('data-testid="fleet-job-schedule-link"')
    expect(detail).toContain("t('fleet.jobs.detail.coalesced', { count: job.coalescedCount })")
  })
```

- [ ] **Step 6: Run them to verify they fail**

Run: `cd apps/web && bun run test -- tests/pages/fleet-schedule-detail.spec.ts tests/pages/fleet-job-detail.spec.ts`
Expected: FAIL (page missing; job page has no schedule link).

- [ ] **Step 7: Implement the detail page**

Create `apps/web/pages/[project]/fleet/schedules/[id].vue`:

```vue
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { ApiError, extractApiError } from '~/composables/useApi'
import { useFleetScheduleActions } from '~/composables/useFleetScheduleActions'
import { useFleetSchedules } from '~/composables/useFleetSchedules'
import { createDebouncer } from '~/lib/debounce'
import { canWorkOnFleet, formatUsd } from '~/lib/fleet-jobs'
import { canChangeSchedule, formatInZone, historyRows, placementOf, scheduleStatusKey } from '~/lib/fleet-schedules'
import type { ScheduleViewer } from '~/lib/fleet-schedules'
import type { ScheduleDto } from '~/lib/fleet-types'

definePageMeta({ layout: 'default' })

/** D222: ticks that change no job state send no notice; 60 s is the ticker cadence. */
const POLL_MS = 60_000

const route = useRoute()
const slug = route.params.project as string
const scheduleId = route.params.id as string
const { t } = useI18n()
const toast = useAppToast()
const auth = useAuth()
const { data: viewerRole } = useProjectViewerRole(slug)
const options = useFleetDispatchOptions(slug)
const people = useProjectMemberNames(slug)
const api = useFleetSchedules(slug)
const jobsApi = useFleetJobs(slug)

const schedule = ref<ScheduleDto | null>(null)
const pending = ref(true)
const loadFailed = ref(false)
const historyPage = ref(1)
const historyFailed = ref(false)
const editOpen = ref(false)

const viewer = computed<ScheduleViewer>(() => ({
  userId: auth.user.value?.id ?? null,
  canWork: canWorkOnFleet(viewerRole.value),
  canManage: viewerRole.value.canManage,
}))
const canChange = computed(() => schedule.value !== null && canChangeSchedule(schedule.value, viewer.value))
const rows = computed(() => historyRows(jobsApi.jobs.value, !jobsApi.hasNext.value))

const placementText = computed((): string => {
  const s = schedule.value
  if (s === null) return '-'
  switch (placementOf(s)) {
    case 'pin': return t('fleet.schedules.detail.placementPin', { runner: options.runnerName(s.pinnedRunnerId) ?? '-' })
    case 'labels': return t('fleet.schedules.detail.placementLabels', { labels: s.selectorLabels.join(', ') })
    default: return t('fleet.schedules.form.placementMode.auto')
  }
})

/** ApiError.code is the envelope `ret`: a 404 arrives as ret 40004 (same convention as isForbidden). */
const isNotFound = (err: unknown): boolean => err instanceof ApiError && (err.code === 40004 || err.code === 404)

/**
 * `silent`: a live reload keeps the page on a transient failure, but a schedule that is gone (deleted elsewhere, or a
 * refused action found it missing) drops its controls and shows the error state (Review Focus 4). The first load reports.
 */
async function loadSchedule(silent: boolean): Promise<void> {
  try {
    schedule.value = await api.get(scheduleId)
    loadFailed.value = false
  }
  catch (err: unknown) {
    if (!silent || isNotFound(err)) {
      schedule.value = null
      loadFailed.value = true
      if (!silent) toast.error(extractApiError(err))
    }
  }
  finally {
    pending.value = false
  }
}

async function loadHistory(): Promise<void> {
  try {
    await jobsApi.load({ scheduleId, page: historyPage.value })
    historyFailed.value = false
  }
  catch {
    historyFailed.value = jobsApi.jobs.value.length === 0
  }
}

async function reload(): Promise<void> {
  await Promise.all([loadSchedule(true), loadHistory()])
}

function goTo(page: number): void {
  historyPage.value = page
  void loadHistory()
}

const actions = useFleetScheduleActions(api, () => { void reload() })

async function toggle(): Promise<void> {
  const current = schedule.value
  if (current === null) return
  const saved = await actions.setEnabled(current, !current.enabled)
  if (saved) schedule.value = saved
}

async function remove(): Promise<void> {
  const current = schedule.value
  if (current === null) return
  if (await actions.remove(current)) await navigateTo(`/${slug}/fleet/schedules`)
}

const polling = useVisiblePolling(reload, POLL_MS)
const liveReload = createDebouncer(() => { void reload() }, 300)

onMounted(() => {
  // Started before any await: if the user leaves during the first load, onBeforeUnmount still stops it.
  polling.start()
  void loadSchedule(false)
  void loadHistory()
  // Names are cosmetic: a failure leaves ids on screen.
  void options.load().catch(() => undefined)
  void people.load().catch(() => undefined)
})
onBeforeUnmount(() => {
  polling.stop()
  liveReload.cancel()
})
useProjectEvents(slug, {
  onFleetJob: () => liveReload.trigger(),
  onResync: () => liveReload.trigger(),
})

const repoOptions = computed(() => options.repos.value.map((r) => ({ value: r.id, label: `${r.owner}/${r.name}` })))
const runnerOptions = computed(() => options.runners.value.map((r) => ({ value: r.id, label: r.name })))
</script>

<template>
  <div class="space-y-6">
    <LoadingState v-if="pending" />
    <ErrorState v-else-if="loadFailed || !schedule" @retry="loadSchedule(false)" />
    <template v-else>
      <PageHeader :title="schedule.name" :subtitle="t('fleet.schedules.cronIn', { cron: schedule.cron, zone: schedule.timezone })">
        <template #actions>
          <template v-if="canChange">
            <Button
              variant="outline"
              :disabled="actions.busy.value"
              :data-testid="schedule.enabled ? 'fleet-schedule-disable' : 'fleet-schedule-enable'"
              @click="toggle()"
            >
              {{ schedule.enabled ? t('fleet.schedules.actions.disable') : t('fleet.schedules.actions.enable') }}
            </Button>
            <Button variant="outline" data-testid="fleet-schedule-edit" @click="editOpen = true">{{ t('fleet.schedules.actions.edit') }}</Button>
            <Button variant="destructive" :disabled="actions.busy.value" data-testid="fleet-schedule-delete" @click="remove()">{{ t('fleet.schedules.actions.delete') }}</Button>
          </template>
        </template>
      </PageHeader>

      <div class="flex flex-wrap items-center gap-3">
        <Badge :variant="schedule.enabled ? 'default' : 'outline'" data-testid="fleet-schedule-status" :data-status="scheduleStatusKey(schedule)">
          {{ t(`fleet.schedules.status.${scheduleStatusKey(schedule)}`) }}
        </Badge>
      </div>

      <section class="space-y-2">
        <h2 class="text-sm font-medium">{{ t('fleet.schedules.detail.template') }}</h2>
        <dl class="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
          <div><dt class="text-muted-foreground">{{ t('fleet.schedules.detail.repo') }}</dt><dd>{{ options.repoName(schedule.repoId) }}</dd></div>
          <div><dt class="text-muted-foreground">{{ t('fleet.schedules.detail.feature') }}</dt><dd class="break-all">{{ schedule.feature }}</dd></div>
          <div><dt class="text-muted-foreground">{{ t('fleet.schedules.detail.ref') }}</dt><dd class="break-all">{{ schedule.ref }}</dd></div>
          <div><dt class="text-muted-foreground">{{ t('fleet.schedules.detail.profiles') }}</dt><dd>{{ schedule.profiles.length > 0 ? schedule.profiles.join(' > ') : '-' }}</dd></div>
          <div><dt class="text-muted-foreground">{{ t('fleet.schedules.detail.maxCost') }}</dt><dd>{{ formatUsd(schedule.maxCostUsd) }}</dd></div>
          <div><dt class="text-muted-foreground">{{ t('fleet.schedules.detail.placement') }}</dt><dd>{{ placementText }}</dd></div>
          <div><dt class="text-muted-foreground">{{ t('fleet.schedules.detail.cron') }}</dt><dd class="font-mono">{{ schedule.cron }}</dd></div>
          <div><dt class="text-muted-foreground">{{ t('fleet.schedules.detail.nextFire') }}</dt><dd data-testid="fleet-schedule-next-fire">{{ schedule.nextFireAt ? t('fleet.schedules.inZone', { time: formatInZone(schedule.nextFireAt, schedule.timezone), zone: schedule.timezone }) : '-' }}</dd></div>
          <div><dt class="text-muted-foreground">{{ t('fleet.schedules.detail.lastFired') }}</dt><dd>{{ schedule.lastFiredAt ? t('fleet.schedules.inZone', { time: formatInZone(schedule.lastFiredAt, schedule.timezone), zone: schedule.timezone }) : '-' }}</dd></div>
          <div><dt class="text-muted-foreground">{{ t('fleet.schedules.detail.progress') }}</dt><dd>{{ t('fleet.schedules.detail.progressValue', { passed: schedule.lastPassedCount, ticks: schedule.noProgressTicks, limit: schedule.noProgressLimit }) }}</dd></div>
          <div><dt class="text-muted-foreground">{{ t('fleet.schedules.detail.owner') }}</dt><dd>{{ people.nameOf(schedule.createdById) ?? t('fleet.schedules.detail.unknownOwner') }}</dd></div>
          <div><dt class="text-muted-foreground">{{ t('fleet.schedules.detail.totalCost') }}</dt><dd data-testid="fleet-schedule-total-cost">{{ formatUsd(schedule.totalCostUsd) }}</dd></div>
        </dl>
      </section>

      <section class="space-y-2">
        <h2 class="text-sm font-medium">{{ t('fleet.schedules.history.title') }}</h2>
        <ErrorState v-if="historyFailed" @retry="loadHistory()" />
        <template v-else>
          <FleetScheduleHistory :slug="slug" :rows="rows" />
          <div v-if="historyPage > 1 || jobsApi.hasNext.value" class="flex justify-end gap-2">
            <Button variant="outline" size="sm" :disabled="historyPage <= 1" @click="goTo(historyPage - 1)">{{ t('fleet.schedules.history.previous') }}</Button>
            <Button variant="outline" size="sm" :disabled="!jobsApi.hasNext.value" @click="goTo(historyPage + 1)">{{ t('fleet.schedules.history.next') }}</Button>
          </div>
        </template>
      </section>

      <FleetScheduleEditDialog
        v-if="canChange"
        v-model:open="editOpen"
        :slug="slug"
        :schedule="schedule"
        :repo-options="repoOptions"
        :runner-options="runnerOptions"
        :profile-suggestions="options.profileOptions.value"
        :label-suggestions="options.labelOptions.value"
        @saved="(saved) => { schedule = saved }"
        @failed="reload()"
      />
    </template>
  </div>
</template>
```

- [ ] **Step 8: Add the schedule link to the job page**

In `apps/web/pages/[project]/fleet/jobs/[id].vue`, inside the `<div class="flex flex-wrap items-center gap-3">` that
holds the state badge, after the `fleet-job-cancel-pending` span:

```vue
        <span v-if="job.scheduleId" class="text-sm text-muted-foreground" data-testid="fleet-job-schedule">
          {{ t('fleet.jobs.detail.fromSchedule') }}
          <NuxtLink :to="`/${slug}/fleet/schedules/${job.scheduleId}`" class="text-primary underline-offset-4 hover:underline" data-testid="fleet-job-schedule-link">{{ t('fleet.jobs.detail.openSchedule') }}</NuxtLink>
        </span>
        <span v-if="job.coalescedCount > 0" class="text-sm text-muted-foreground" data-testid="fleet-job-coalesced">
          {{ t('fleet.jobs.detail.coalesced', { count: job.coalescedCount }) }}
        </span>
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `cd apps/web && bun run test -- tests/components/fleet-schedule-history.spec.ts tests/pages/fleet-schedule-detail.spec.ts tests/pages/fleet-job-detail.spec.ts`
Expected: PASS.

- [ ] **Step 10: Whole web suite, lint, types, commit**

Run: `cd apps/web && bun run test && bun run lint && bun run type-check`
Expected: all green (the used-keys i18n spec now sees every new key in use).

```bash
git add apps/web/components/fleet/ScheduleHistory.vue "apps/web/pages/[project]/fleet/schedules/[id].vue" \
  "apps/web/pages/[project]/fleet/jobs/[id].vue" apps/web/tests
git commit -m "feat(web): schedule detail page with run history; jobs link back to their schedule (S1b 3b)"
```

---

### Task 9: Playwright E2E and docs

**Files:**
- Modify: `apps/web/playwright.config.ts` (API env `FLEET_TEST_HOOKS: 'true'`)
- Modify: `apps/web/tests/e2e/fixtures/fleet-budgets-api.ts` (export `call`)
- Create: `apps/web/tests/e2e/fixtures/fleet-schedules-api.ts`
- Create: `apps/web/tests/e2e/fleet-schedules.e2e.spec.ts`
- Modify: `docs/deployment/runner.md`, `docs/superpowers/specs/2026-10-01-fleet-s1b-budgets-schedules-design.md` (§3.4)

**Interfaces:**
- Consumes: the Task 1 hook; `ScriptedRunner` (`fixtures/scripted-runner.ts`); `login`, `E2E_ADMIN`
  (`fixtures/api-client.ts`); `waitForHydration`, `webLogin` (`fixtures/page-helpers.ts`); testids from Tasks 5-8.
- Produces: `listSchedules`, `deleteSchedules`, `getSchedule`, `fireSchedule` fixtures.

- [ ] **Step 1: Turn the hook on for the E2E API and add the fixtures**

In `apps/web/playwright.config.ts`, in the API `webServer.env` after `FLEET_ARTIFACT_DIR`:

```ts
        // S1b 3b D213: the schedules e2e fires a schedule through the test-only hook (never on in production).
        FLEET_TEST_HOOKS: 'true',
```

In `apps/web/tests/e2e/fixtures/fleet-budgets-api.ts`, change `async function call<T>(` to `export async function call<T>(`.

Create `apps/web/tests/e2e/fixtures/fleet-schedules-api.ts`:

```ts
/**
 * Fleet S1b slice 3b: the API calls the schedules e2e makes outside the browser (cleanup, reading the dispatched job,
 * firing through the test-only hook, plan D213).
 */
import { call } from './fleet-budgets-api';

export interface ScheduleRow {
  id: string;
  name: string;
  enabled: boolean;
  disabledReason: string | null;
  lastJobId: string | null;
  nextFireAt: string | null;
}

export const listSchedules = (token: string, slug: string): Promise<ScheduleRow[]> =>
  call<ScheduleRow[]>('GET', `/projects/${slug}/fleet/schedules`, token);

export const getSchedule = (token: string, slug: string, id: string): Promise<ScheduleRow> =>
  call<ScheduleRow>('GET', `/projects/${slug}/fleet/schedules/${id}`, token);

/** Deletes every schedule of the project; their jobs are kept (3a D194). */
export async function deleteSchedules(token: string, slug: string): Promise<void> {
  for (const row of await listSchedules(token, slug)) {
    await call<void>('DELETE', `/projects/${slug}/fleet/schedules/${row.id}`, token);
  }
}

/** Runs one ticker round at the schedule's next fire (global admin token). */
export const fireSchedule = (token: string, id: string): Promise<{ firedAt: string; result: { dispatched: number } }> =>
  // `call` always sends Content-Type: application/json; fastify refuses an empty JSON body (FST_ERR_CTP_EMPTY_JSON_BODY).
  call('POST', `/fleet/test-hooks/schedules/${id}/fire`, token, {});
```

- [ ] **Step 2: Write the E2E spec**

Create `apps/web/tests/e2e/fleet-schedules.e2e.spec.ts`:

```ts
import { test, expect } from '@playwright/test';
import { login, E2E_ADMIN } from './fixtures/api-client';
import { deleteSchedules, fireSchedule, getSchedule } from './fixtures/fleet-schedules-api';
import { waitForHydration, webLogin } from './fixtures/page-helpers';
import { ScriptedRunner, type Lease } from './fixtures/scripted-runner';

/**
 * Fleet S1b slice 3b (spec §3.5, plan D225): a schedule created in the web fires (through the test-only hook, D213),
 * a scripted runner completes its job with every story passed, and the schedule shows itself disabled with
 * `completed`. Project `fleet-e2e` and repo acme/e2e-app come from prisma/seed-e2e.ts.
 */
const SLUG = 'fleet-e2e';

test.describe('Fleet schedules (scripted runner)', () => {
  let token = '';
  let runner: ScriptedRunner;
  const suffix = Date.now().toString().slice(-6);
  const feature = `sch-${suffix}`;

  test.beforeAll(async () => {
    token = (await login(E2E_ADMIN.email, E2E_ADMIN.password)).token;
    runner = await ScriptedRunner.enroll(token, `e2e-schedule-runner-${suffix}`);
    await deleteSchedules(token, SLUG);
  });

  // A schedule left enabled would keep a template around for later runs of the suite.
  test.afterAll(async () => {
    if (!token) return;
    await deleteSchedules(token, SLUG);
  });

  test('create in the web, fire, the run completes, the schedule disables itself as completed', async ({ page }) => {
    test.setTimeout(120_000);
    await webLogin(page);

    // 1. Create: a yearly cron in UTC, so the real 60 s ticker never fires it on its own (D225).
    await page.goto(`/${SLUG}/fleet/schedules`);
    await waitForHydration(page);
    await page.getByTestId('fleet-schedule-create').click();
    await page.getByTestId('fleet-schedule-name').fill(`nightly ${suffix}`);
    await page.getByTestId('fleet-schedule-repo').selectOption({ label: 'acme/e2e-app' });
    await page.getByTestId('fleet-schedule-feature').fill(feature);
    await page.getByTestId('fleet-schedule-cron').fill('0 3 1 1 *');
    await page.getByTestId('fleet-schedule-timezone').fill('UTC');
    await page.getByTestId('fleet-schedule-max-cost').fill('3');
    await page.getByTestId('fleet-schedule-placement').selectOption('pin');
    await page.getByTestId('fleet-schedule-pin').selectOption(runner.id);
    await page.getByTestId('fleet-schedule-submit').click();

    const row = page.locator('[data-testid^="fleet-schedule-row-"]').filter({ hasText: feature });
    await expect(row).toHaveCount(1);
    await expect(row.getByTestId('fleet-schedule-status')).toHaveAttribute('data-status', 'enabled');
    const scheduleId = ((await row.getAttribute('data-testid')) ?? '').replace('fleet-schedule-row-', '');
    expect(scheduleId).not.toBe('');

    // 2. Open the schedule and wait for its live stream before anything happens.
    const streamOpen = page.waitForResponse(
      (res) => res.url().includes(`/api/projects/${SLUG}/events`) && res.status() === 200,
      { timeout: 10_000 },
    );
    await row.getByTestId('fleet-schedule-link').click();
    await page.waitForURL(new RegExp(`/${SLUG}/fleet/schedules/${scheduleId}$`));
    await streamOpen;
    await waitForHydration(page);
    await expect(page.getByTestId('fleet-schedule-history-empty')).toBeVisible();

    // 3. Fire it: one RUN pinned to the scripted runner.
    await runner.heartbeat();
    const fired = await fireSchedule(token, scheduleId);
    expect(fired.result.dispatched).toBe(1);
    const jobId = (await getSchedule(token, SLUG, scheduleId)).lastJobId ?? '';
    expect(jobId).not.toBe('');

    // 4. The runner works the job; the history row follows it live.
    const lease: Lease = await runner.acceptAssign(jobId);
    await runner.report(lease, [
      { type: 'state', payload: { to: 'RUNNING' } },
      {
        type: 'snapshot',
        payload: {
          naxRunId: `run-${suffix}`, currentStoryId: 'US-001', currentPhase: 'implement',
          progress: { total: 2, passed: 1, failed: 0, paused: 0, blocked: 0, pending: 1 },
          costSpentUsd: '0.4200', heartbeatAt: new Date().toISOString(),
        },
      },
    ]);
    const run = page.getByTestId(`fleet-schedule-run-${jobId}`);
    await expect(run.getByTestId('fleet-job-state')).toHaveAttribute('data-state', 'RUNNING', { timeout: 10_000 });

    // 5. Every story passes and nax's finish opens a PR: COMPLETED.
    await runner.report(lease, [{ type: 'state', payload: { to: 'UPLOADING' } }]);
    await runner.uploadBundle(lease, `bundle of ${jobId}`);
    await runner.report(lease, [
      {
        type: 'snapshot',
        payload: {
          progress: { total: 2, passed: 2, failed: 0, paused: 0, blocked: 0, pending: 0 },
          finishResult: 'opened', resultBranch: `feat/${feature}`,
          resultPrUrl: 'https://github.com/acme/e2e-app/pull/11', costSpentUsd: '0.9000',
        },
      },
      { type: 'state', payload: { to: 'COMPLETED', exitCode: 0 } },
    ]);

    // 6. The detail page shows the finished run and the schedule disabled as completed (S1b §3.3 rule 1).
    await expect(run.getByTestId('fleet-job-state')).toHaveAttribute('data-state', 'COMPLETED', { timeout: 10_000 });
    await expect(run.getByTestId('fleet-schedule-run-stories')).toContainText('2/2');
    await expect(page.getByTestId('fleet-schedule-status')).toHaveAttribute('data-status', 'completed', { timeout: 10_000 });
    await expect(page.getByTestId('fleet-schedule-total-cost')).toHaveText('$0.90');
    expect((await getSchedule(token, SLUG, scheduleId)).disabledReason).toBe('completed');

    // 7. The job page links back to the schedule.
    await page.goto(`/${SLUG}/fleet/jobs/${jobId}`);
    await waitForHydration(page);
    await expect(page.getByTestId('fleet-job-schedule-link')).toHaveAttribute('href', `/${SLUG}/fleet/schedules/${scheduleId}`);
  });
});
```

- [ ] **Step 3: Run the E2E**

Start Postgres for e2e (`cd apps/api && bun run test:db:up`), then:

Run: `cd apps/web && bunx playwright test tests/e2e/fleet-schedules.e2e.spec.ts tests/e2e/fleet-dispatch.e2e.spec.ts tests/e2e/fleet-budgets.e2e.spec.ts`
Expected: 4 passed (schedules x1, dispatch x1, budgets x2). (`event-payloads.ts` accepts `progress` and
`finishResult` in one snapshot.)

- [ ] **Step 4: Docs**

In `docs/deployment/runner.md`, after the paragraph that starts "Budgets are also managed on the web", add:

```markdown
Schedules are also managed on the web: `/<project>/fleet/schedules` lists a project's schedules with their next fire in
the schedule's timezone and the reason a disabled one stopped; a schedule's page shows its template, the cost so far and
every run it dispatched (stories passed against the previous run, cost, merged fires, progress push, stop reason).
Project DEVELOPERs create schedules; the owner or a project ADMIN edits, enables, disables and deletes them. A job
dispatched by a schedule links back to it.

`FLEET_TEST_HOOKS=true` exposes a test-only route that fires a schedule at once; it is ignored when `NODE_ENV` is
`production`. Leave it unset outside the Playwright suite.
```

In `docs/superpowers/specs/2026-10-01-fleet-s1b-budgets-schedules-design.md`, at the end of §3.4, after the bullet that
starts "- Enable refuses an owner" and its continuation line ending "the schedule list is a plain array.", add:

```markdown
- 3b plan notes (`2026-10-02-fleet-s1b-slice-3b-schedules-web.md`): the E2E fires a schedule through a test-only,
  env-gated, global-ADMIN route `POST /api/fleet/test-hooks/schedules/:id/fire` that runs one ticker round at the
  schedule's `nextFireAt` and is excluded from OpenAPI (D213); a short cron is impossible under the 15-minute rule. The
  web shows next and last fire in the schedule's zone (D220), the stories delta only against a loaded older run (D221),
  and polls every 60 s besides `fleet_job` notices (D222). A job page links to its schedule (D216).
```

- [ ] **Step 5: Final checks and commit**

Run: `cd apps/web && bun run test && bun run lint && bun run type-check`
Run: `cd apps/api && bun run test:scoped src/fleet src/config && bun run lint && bun run type-check`
Run (repo root): `bun run generate && git status --porcelain openapi.json apps/cli` — expect no output.
Run: `git diff main...HEAD --stat` — only `apps/web`, the files of Task 1 under `apps/api`, and `docs` change.

```bash
git add apps/web/playwright.config.ts apps/web/tests/e2e docs/deployment/runner.md docs/superpowers/specs/2026-10-01-fleet-s1b-budgets-schedules-design.md
git commit -m "test(web): schedules e2e through the test-only fire hook; docs (S1b 3b)"
```
