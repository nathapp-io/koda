# Fleet S1b Slice 3a — Schedules Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A project DEVELOPER can define a cron schedule that drives one nax feature to done across many unattended
RUNs. A tick never creates a second QUEUED job, honours budgets, and the schedule disables itself when the feature
completes, when its finish fails with every story passed, after N ticks without progress, or when its template or
owner is no longer valid. API and CLI only; the web pages and E2E are slice 3b.

**Architecture:** Two schema changes in one migration: a `JobSchedule` table and three `FleetJob` columns
(`scheduleId`, `coalescedCount`, `scheduleCountedAt`). A pure `cron-schedule.ts` wraps `cron-parser` (five-field
check, timezone check, 15-minute gap check, next-fire). A pure `schedule-progress-rules.ts` judges an ended job. A
small `ScheduleStoreModule` (repository + `ScheduleProgressService`) is imported by `FleetJobsModule`, so
`JobTransitionsService.apply` can count a scheduled job's end in the same transaction without a DI cycle. A
`SchedulesModule` holds the `ScheduleTicker` (60 s, compare-and-set claim, dispatch through
`FleetJobsService.dispatch`), the management service and the project-scoped controller. `FleetJobsService.dispatch`
gains an optional `scheduleId`; the job DTO and list gain `scheduleId` and `coalescedCount` for the 3b history.

**Tech Stack:** NestJS + Prisma 6 (PostgreSQL) + Jest (API), `cron-parser` 5 (new dependency of `apps/api`),
commander 12 + Jest (CLI).

**Spec:** `docs/superpowers/specs/2026-10-01-fleet-s1b-budgets-schedules-design.md` §3.1-§3.4 (the 3a parts), §3.5
(3a tests), §4 (error codes, i18n, webhooks, activity, migrations, OpenAPI). Ruling B4 (RUN only, one fixed
feature). Depends on slice 1a (merged: `wipPush`) and 2a (merged as PR #188: `BudgetGate`, `fleet.budgetPaused`).

## Global Constraints

- The schedule command is always `RUN`, for one fixed feature (B4). The template is explicit columns, validated by
  the dispatch rules (`apps/api/src/fleet/jobs/dispatch-input.ts` `normalizeDispatch`).
- `cron` is five-field; `timezone` is accepted by `Intl.DateTimeFormat`; the next 100 fires from now are walked and
  any two consecutive fires less than **15 minutes** apart are refused with 400 `fleet.scheduleCronTooFrequent`.
- Ticker: `ScheduleTicker` in `apps/api/src/fleet/schedules/`, on the `FleetSweeper` pattern (`setInterval` in
  `onModuleInit`, gated by `fleetConfig.sweepEnabled`, `unref()`), every **60 s**, exposing `tick(now)` for tests.
- Claim by compare-and-set: `UPDATE ... SET nextFireAt = <next fire after now>, lastFiredAt = now WHERE id = ? AND
  nextFireAt = <loaded value>`; zero rows means another tick has it. Missed fires while the API was down collapse
  into one fire.
- Fire table, in this order: the schedule has a `QUEUED` job -> `coalescedCount + 1` on it, atomically, no new job;
  it has an `ASSIGNED`, `RUNNING` or `UPLOADING` job -> skip, `schedule.tick_skipped` activity; the owner
  (`createdById`) is disabled, or has no DEVELOPER-or-higher role on the project and is not a global ADMIN ->
  disable with `owner_lost_access`; otherwise dispatch with `actorId = createdById` and `scheduleId`.
- Dispatch outcomes: 201 -> record `lastJobId`; 409 `fleet.budgetPaused` -> skip, stays enabled; 409 active
  `(repoId, feature)` (a manual job holds the feature) -> skip, never coalesces into a manual job; 404 repo, 404
  pinned runner, 422 `FleetDispatchException`, 400 validation -> disable with `template_invalid`; any other error ->
  log, skip, stays enabled.
- Auto-disable hooks `JobTransitionsService.apply` through `ScheduleProgressService`, in the same transaction. It
  applies when a job with `scheduleId` reaches a terminal state and `scheduleCountedAt` is null, and then sets
  `scheduleCountedAt`. Rules, in order: (1) `COMPLETED` -> disable `completed`; (2) `CANCELLED` -> no change to
  either counter; (3) `progress` null or without a numeric `passed` -> no progress; (4) `progress.passed` equals
  `progress.total` (> 0) and the state is not `COMPLETED` -> disable `finish_failed`; (5) `progress.passed >
  lastPassedCount` -> `noProgressTicks = 0`, `lastPassedCount = progress.passed` (any terminal state); (6)
  otherwise no progress. No progress -> `noProgressTicks + 1`; at `noProgressLimit` (default 3) disable
  `no_progress`.
- Re-enabling resets `noProgressTicks` and `disabledReason`, recomputes `nextFireAt` from now, and keeps
  `lastPassedCount`.
- Permissions: create needs project DEVELOPER or higher (as dispatch); edit, enable, disable and delete need the
  owner or a project ADMIN; any project member reads.
- `disabledReason`: `completed | finish_failed | no_progress | owner_lost_access | template_invalid | manual`.
- Webhook `fleet.schedule.disabled` is sent with `WebhookDispatcherService.dispatch(projectId, event, payload)`
  inside the triggering transaction on every auto-disable; the schedule module graph imports `WebhookModule`.
- `FleetActivity.entityType` `schedule`; every schedule mutation, auto-disable and skipped tick writes a row with
  `projectId` set. `FleetActivityService.record` **throws** when a payload key matches
  `/token|secret|key|password|credential/i`; never put a `*Key` field in a payload.
- One migration. The partial unique index `FleetJob (scheduleId) WHERE state = 'QUEUED'` is raw SQL in the migration
  and is added verbatim to `PARTIAL_UNIQUE_INDEXES` in `apps/api/test/helpers/partial-indexes.ts`.
- Error codes: `fleet.scheduleCronTooFrequent` (400, code `-2`), plus `fleet.scheduleInput` (400, `-2`) and
  `fleet.schedules` (404). Every key in both `apps/api/src/i18n/en/fleet.json` and `.../zh/fleet.json`.
- Single API instance: the ticker is in-process with no distributed lock. The compare-and-set claim is what keeps
  two overlapping ticks (or an accidental second instance) from firing twice.
- `txManager.run` joins an outer transaction when one is open (ALS); a unique violation inside a Prisma interactive
  transaction aborts it, so the ticker calls `dispatch` with no transaction open, and idempotent inserts use raw
  `INSERT ... ON CONFLICT DO NOTHING`.
- Money is `Decimal(12,4)` in the database and a decimal **string** in records and DTO responses.
- Live events and runner wake-ups collected inside a transaction are published only after it commits (3a adds none).
- API tests: `cd apps/api && bun run test:scoped <paths>` (paths relative to `apps/api`; unit specs need no DB;
  integration specs need `bun run test:db:up` and `test:scoped` sets `KODA_DB_TESTS=1` itself). **Never**
  `bun run test:unit -- <path>`: its `--testPathIgnorePatterns` swallows the path and runs the whole suite. CLI:
  `cd apps/cli && bun run test -- <path>`. Never run bare `bun test`.
- Time math is tested with a fixed `now` passed to `tick(now)` / `nextFireAfter` (no real timers) and once more
  under a non-UTC process zone: `TZ=Asia/Singapore bun run test:scoped <path>` (jest sandboxes `process.env.TZ`, so
  set it on the command line, not inside the spec).
- `apps/api/tsconfig.json` excludes specs, so `bun run type-check` cannot see a stale record literal in a spec; the
  fleet specs compiling under ts-jest is what catches one. Always run `bun run test:scoped src/fleet`.
- `bun run generate` (repo root) needs `apps/api/.env` (Task 0 creates it) and rebuilds `apps/api/dist`.
  `apps/cli/src/generated` is gitignored; commit only `openapi.json`. `openapi.json` must be stable after a second
  `bun run generate`.
- `AppException` bodies are `{ ret, message }` only; arguments reach clients through the translated message. The CLI
  maps a 400 (`ret: -2`) to exit code 3.
- No emojis in source; no `console.log` in API source (the CLI prints with `console.log` by design); no
  `eslint-disable`; no mutation of arguments.
- Required CI is `changes` + 9 jobs (`lint`, `type-check`, `web build`, `policy-gates`, `test`, `integration`,
  `e2e`, `evaluate`, `smoke`). Task 11 runs the local equivalents.
- Never push, never open a PR (repo rule); the human reviews and pushes.

## Decisions

Numbering continues the S1b register (slice 2a ends at D172; slice 2b uses D173-D189).

| # | Decision | Why |
|:--|:--|:--|
| D190 | Cron parsing uses `cron-parser` `^5.10.1`, added as a direct dependency of `apps/api` and wrapped in one file (`cron-schedule.ts`). The `cron` package already in the tree (via `@nestjs/schedule`) is not used. | The spec names `cron-parser`. It is a pure function of (expression, zone, instant) with no timers, and it follows Vixie semantics (day-of-month OR day-of-week), checked against `cron` 4.4.0 with the same results. `cron` is a timer scheduler we would only borrow `CronTime` from, as an undeclared transitive dependency. The new dependency adds one package (`luxon` is already installed). |
| D191 | `cron-parser` pads missing fields, accepts six fields (seconds), `@daily` and `?`. `normalizeCron` therefore requires exactly five whitespace-separated fields and rewrites them single-spaced. The zone is canonicalised through `Intl.DateTimeFormat(...).resolvedOptions().timeZone` (`asia/singapore` is stored as `Asia/Singapore`) and then proven by computing one fire. The 15-minute check walks the next 100 fires from the moment of create or edit, as the spec says; it is an approximation (a short gap that first appears after the 100th fire is not seen). | Without the field check `* * * *` and `* * * * * *` would both be accepted and mean something the user did not type. The zone proof catches zones `Intl` accepts and luxon does not. |
| D192 | Modules: `ScheduleStoreModule` (repository + `ScheduleProgressService`) is imported by `FleetJobsModule`; `SchedulesModule` (ticker, management service, controller) imports `FleetJobsModule`, `ScheduleStoreModule`, `FleetActivityModule`; `FleetModule` imports `SchedulesModule`. | `JobTransitionsService` (in `FleetJobsModule`) must call `ScheduleProgressService`, and the ticker needs `FleetJobsService`: one module would be a cycle (same split as 2a D160). `ScheduleProgressService` imports nothing from `jobs/job-transitions.service` (it defines its own `'system'` actor id) so there is no ESM import cycle either. |
| D193 | `JobSchedule.repoId` and `JobSchedule.pinnedRunnerId` have **no foreign key**. `JobSchedule.projectId` cascades with its project and `createdById` references `User`. `FleetJob.scheduleId` references `JobSchedule` with `ON DELETE SET NULL`. | The spec disables a schedule "on a deleted repo" (`template_invalid`); an FK to `FleetRepo` would delete the schedule with the repo and nobody would see why it stopped. Deleting a schedule must keep its jobs and their history. |
| D194 | `PrismaScheduleRepository.delete` first detaches the schedule's jobs (`scheduleId = null`), then deletes the row. | Lock order is job row, then schedule row, everywhere (`apply` holds the job lock and then locks the schedule). The FK's own `SET NULL` would lock job rows after the schedule row and could deadlock with a concurrent terminal transition. |
| D195 | A `CANCELLED` job does **not** set `scheduleCountedAt`. | The spec says a cancelled end changes neither counter and "it then sets `scheduleCountedAt`" only for counted ends. If a cancelled job set it, a user requeue of that job that later FAILED would never be counted. |
| D196 | "Counted once" is a compare-and-set: `UPDATE FleetJob SET scheduleCountedAt = now WHERE id = ? AND scheduleCountedAt IS NULL` (`claimCounted`), taken before the schedule row is locked. | Exactly-once holds even if two paths ever end the same job, without relying on the schedule lock. |
| D197 | A schedule that is already disabled (manual, or by an earlier auto-disable) keeps its `disabledReason`. A late result for it only applies the "progress" verdict (reset `noProgressTicks`, raise `lastPassedCount`); every other verdict is ignored. | A job that was running when a human disabled the schedule must not rewrite `manual` into `completed`, and no webhook fires for a schedule that is already off. |
| D198 | The ticker claims in its own statement, commits it, and only then calls `FleetJobsService.dispatch` with **no transaction open**. A crash between the claim and the dispatch loses that one fire; the next cron fire runs as usual. `tick` is guarded against re-entry (a tick still running when the 60 s timer fires is skipped). | A 409 from the `(repoId, feature)` index aborts a Prisma interactive transaction and `dispatch` handles it with its own transaction. Losing one fire on a crash is the same trade the spec makes for "missed fires collapse into one". |
| D199 | Dispatch errors map by exception class, most specific first: `BudgetPausedException` -> skip `budget_paused`; any other `ConflictAppException` -> skip `active_job_elsewhere`; `NotFoundAppException`, `FleetDispatchException`, `ValidationAppException` -> disable `template_invalid`; anything else -> log, skip `error`. | Matches the spec's outcome table. `BudgetPausedException` extends `ConflictAppException` (2a), so the order is the contract. |
| D200 | Coalescing is one atomic statement, `UPDATE "FleetJob" SET "coalescedCount" = "coalescedCount" + 1 WHERE "scheduleId" = ? AND "state" = 'QUEUED' RETURNING "id"`. Zero rows (the job left QUEUED since we looked) re-reads the schedule's active job; at most 3 rounds, then the tick is recorded as skipped (`busy`). | The job can be assigned between the read and the increment; the guard in the `WHERE` makes the increment itself the check. |
| D201 | Owner access is the repository's own read (`findOwnerAccess`: user exists, `disabled`, global role, project role), not `ProjectAccessService`. The owner may dispatch when the user exists, is not disabled, and is a global ADMIN or has project role ADMIN or DEVELOPER (the roles that hold CASL `CREATE FleetJob`). | `ProjectAccessService.resolveMembership` throws 403 for a non-member and never looks at `User.disabled`. |
| D202 | Controller permissions: `POST` uses `@ProjectPermission([CREATE, 'FleetJob'])` (DEVELOPER+); `PATCH`, `DELETE`, `enable`, `disable` use `[UPDATE, 'FleetJob']` (DEVELOPER+) **and** owner-or-project-ADMIN (`ctx.role === 'ADMIN'`, which a global ADMIN resolves to). Reads need a user principal that is a project member. Agent principals are refused everywhere. | The spec names owner or project ADMIN; also requiring DEVELOPER+ means a demoted VIEWER-owner cannot edit a schedule that the ticker is about to disable for lost access. A project ADMIN can still delete it. |
| D203 | A schedule's repo and feature are fixed after create (`PATCH` changes name, cron, timezone, ref, profiles, maxCostUsd, selectorLabels, pinnedRunnerId, noProgressLimit). A cron or timezone change on an enabled schedule recomputes `nextFireAt` from now. Editing never enables a disabled schedule. | `lastPassedCount` counts stories of one feature on one repo; changing either means a new schedule. |
| D204 | `ref` is stored resolved: an omitted `ref` becomes the repo's default branch at create time. | The spec lists `ref` as a required column; a nax feature continues from `origin/<branch>`, and the base ref is part of the template the user saw. |
| D205 | Additive job API for the 3b tick history: `FleetJobDto` gains `scheduleId` and `coalescedCount`; `GET /projects/:slug/fleet/jobs` gains a `scheduleId` filter; `ScheduleDto` carries `totalCostUsd` (sum of `costSpentUsd + costCarriedUsd` over the schedule's jobs, decimal string). | Spec §3.4 (3b) needs each tick's job with state, cost, `coalescedCount`, `wipPush` and `stateReason`; reusing the job list avoids a second history endpoint. |
| D206 | Activity actions, all `entityType: 'schedule'`: `schedule.created`, `.updated`, `.deleted`, `.enabled`, `.disabled` (manual), `.auto_disabled` (payload `reason`), `.tick_dispatched`, `.tick_coalesced`, `.tick_skipped` (payload `reason`). Automatic rows use `actorType: 'SYSTEM'`, `actorId: 'system'`, `responsibleUserId` = the schedule owner. The `fleet.schedule.disabled` webhook is sent for auto-disables only. | The spec asks for a row on every mutation, auto-disable and skipped tick; coalesce and dispatch rows make the history readable. A manual disable is the user's own action, so it sends no webhook. |
| D207 | `findDue` returns at most 100 enabled schedules per tick, oldest due first, and skips schedules of soft-deleted projects (`Project.deletedAt` set). | A deleted project must stop dispatching; the cap bounds a tick after a long outage (the rest wait one more minute). |
| D208 | A stored `cron` that no longer parses when the ticker computes the next fire disables the schedule with `template_invalid` instead of failing every minute. | A library upgrade must not turn into a per-minute error loop. |
| D209 | CLI: `koda fleet schedule` with `add`, `edit`, `list`, `show`, `rm`, `enable` and `disable`. The stall limit option is `--stall-after <ticks>` (commander reads `--no-progress-limit` as the negation of `--progress-limit`). `--timezone` defaults to the machine's zone (printed back). `edit` has `--unpin`, `--clear-profiles`, `--clear-labels`. `show` prints the last 10 jobs through the job list filter. Lists are plain arrays, not pages. | Each choice avoids a silent surprise: the negation trap, a UTC default for a cron the user wrote in local time, and no way to remove a list. A project holds few schedules (same reasoning as 2a D163). |
| D210 | Fleet endpoint lifecycle coverage lives in `test/integration/fleet/` (as S1 and 2a), not in `test/e2e/api-endpoint/endpoint.e2e.spec.ts`. | `.nax/rules/api-testing.md` asks for the e2e file; no fleet slice has used it and the fleet suites boot the full app with the fleet world fixtures. Recorded so a reviewer does not "fix" it. |
| D211 | Enabling a schedule whose owner has lost access is allowed; the next tick disables it again with `owner_lost_access` and writes the activity row. | Enabling is the owner-or-admin's right; the access rule belongs to dispatch time. The loop is bounded to one tick and visible. |
| D212 | This worktree runs DB-mode tests against its own database `koda_slice3a_test` (and `koda_slice3a_shadow` for `prisma migrate diff`) because slice 2b runs against `koda_test` at the same time and every DB-mode Jest run does `prisma db push --force-reset`. `.env.test` is tracked, so the edit is `skip-worktree` and is reverted in Task 11. | `.env.test` overrides an exported `DATABASE_URL`; editing the tracked file without `skip-worktree` would ship the change. |

## Review Focus

1. A cron in a non-UTC zone across a daylight-saving change (`30 2 * * *` in `America/New_York`): it fires once on
   the spring-forward day, shifted to 03:30, and once on the fall-back day; and the same results under a process
   zone of `Asia/Singapore`. (Task 2 "nextFireAfter" cases.)
2. The API was down for days, or two ticks overlap: many missed fires become exactly one job and `nextFireAt`
   lands in the future; two concurrent ticks create one job; a tick that is still running is not re-entered. (Task
   7 "collapses fires missed while the API was down", "two concurrent ticks create exactly one job", "does not
   re-enter".)
3. A job that ends with garbled progress (`null`, a string, a negative or fractional `passed`, `total: 0`): it
   counts as no progress and never throws inside the runner-sync transaction. (Task 3 verdict table, Task 5
   "garbled progress".)
4. The owner is removed or disabled, the repo is deleted, the pinned runner is gone, or the project is soft-deleted:
   the schedule is disabled once with the right reason and one activity row, or is not ticked at all; it does not
   error every minute. (Task 7 "owner %s: disabled once ...", "a deleted repo disables", "a pinned runner that is
   gone", "a soft-deleted project is not ticked at all".)
5. A schedule is deleted or manually disabled while its job is in flight: the job still ends normally, the
   transition does not throw, and a manually disabled schedule keeps `manual` instead of being rewritten by a late
   `COMPLETED`. (Task 5 "a manually disabled schedule keeps its reason", "a job whose schedule was deleted just
   ends".)

---

## File Structure

New, under `apps/api/src/fleet/schedules/`:

| File | Responsibility |
|:--|:--|
| `cron-schedule.ts` | The only importer of `cron-parser`: five-field check, zone canonicalisation, 15-minute gap check, `nextFireAfter` |
| `domain/schedule.domain.ts` | `ScheduleRecord`, `NewSchedule`, `SchedulePatch`, `IScheduleRepository`, reasons |
| `schedule-template.ts` | `toDispatchDto`: the template as a RUN dispatch |
| `schedule-progress-rules.ts` | Pure verdict for an ended job (§3.3 rules 1-6) |
| `schedule-payloads.ts` | Activity and webhook payload builders; the `'system'` actor id |
| `prisma-schedule.repository.ts` | PG access: CAS claim, atomic coalesce, counted claim, owner access, cost sums |
| `schedule-store.module.ts` | Repository + `ScheduleProgressService`, importable by `FleetJobsModule` |
| `schedule-progress.service.ts` | Applies the verdict to the schedule; auto-disable (activity + webhook) |
| `schedule-ticker.ts` | The 60 s ticker: claim, coalesce, skip, dispatch, outcome table |
| `schedules.service.ts` | Management: list, get, create, update, delete, enable, disable |
| `dto/create-schedule.dto.ts`, `dto/update-schedule.dto.ts`, `dto/schedule.dto.ts` | Request and response DTOs |
| `project-fleet-schedules.controller.ts` | `/projects/:slug/fleet/schedules` routes |
| `schedules.module.ts` | Wires the above |

Modified: `apps/api/prisma/schema.prisma`, `apps/api/test/helpers/partial-indexes.ts`, `apps/api/package.json` and
`bun.lock` (dependency), `src/fleet/jobs/domain/fleet-job.domain.ts`, `.../prisma-fleet-job.repository.ts`,
`.../job-transitions.service.ts`, `.../fleet-jobs.service.ts`, `.../fleet-jobs.module.ts`,
`.../dto/fleet-job.dto.ts`, `.../dto/list-fleet-jobs.query.ts`, `.../fleet-jobs.controller.ts`,
`src/fleet/activity/domain/fleet-activity.domain.ts`, `.../dto/list-fleet-activity.query.ts`,
`src/fleet/fleet.module.ts`, `src/i18n/{en,zh}/fleet.json`, `src/fleet/fleet-openapi.contract.spec.ts`,
`openapi.json`, `apps/cli/src/commands/fleet.ts`, `fleet-shared.ts`; new `apps/cli/src/commands/fleet-schedule.ts`;
docs: the spec notes, `.nax/mono/apps/api/context.md`, `docs/deployment/runner.md`.

---

### Task 0: Worktree, dependencies, `.env` and an isolated test database

**Files:**
- Local only: `apps/api/.env` (gitignored), `apps/api/.env.test` (tracked; `skip-worktree`, never committed)

The plan file itself is already committed on this branch by its author; this task changes nothing that is committed.

**Interfaces:** none (setup only; later tasks assume `node_modules`, `apps/api/.env`, and the private `koda_slice3a_test` database exist).

- [ ] **Step 1: Confirm the worktree and branch**

Run:
```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/koda/repos/koda-slice3a
git branch --show-current && git log --oneline -2
```
Expected: `feat/fleet-s1b-slice3a-schedules-backend`, with the plan commit on top of `e94aa04c`. Do not touch `../koda` (slice 2b is writing there).

- [ ] **Step 2: Install dependencies**

Run: `bun install --frozen-lockfile`
Expected: completes; `node_modules` exists at the repo root.

- [ ] **Step 3: Create `apps/api/.env`**

`bun run generate` boots the app module and needs the config keys (the file is gitignored):

```bash
cd apps/api
cp .env.example .env
sed -i '' 's#your-jwt-secret-here#local-jwt-secret#; s#your-jwt-refresh-secret-here#local-jwt-refresh-secret#; s#your-api-key-secret-here#local-api-key-secret#' .env
git status --short .env
```
Expected: `git status` prints nothing (ignored).

- [ ] **Step 4: Point DB-mode tests at this worktree's own database**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/koda/repos/koda-slice3a/apps/api
sed -i '' 's#localhost:5433/koda_test#localhost:5433/koda_slice3a_test#' .env.test
git update-index --skip-worktree .env.test
grep DATABASE_URL .env.test
git status --short .env.test
```
Expected: `DATABASE_URL="postgresql://koda:koda@localhost:5433/koda_slice3a_test"` and an empty `git status`. The guard in `test/helpers/test-database-url.ts` accepts any local `*_test` name. Task 11 undoes both commands.

- [ ] **Step 5: Start the test Postgres and create the two databases**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/koda/repos/koda-slice3a/apps/api
bun run test:db:up
for db in koda_slice3a_test koda_slice3a_shadow; do
  docker compose -f ../../docker-compose.test.yml exec -T postgres-test createdb -U koda "$db" || true
done
```
`createdb` fails harmlessly when the database exists. The container keeps its data in `tmpfs`: after a container restart rerun this step. Never create or reset `koda_test`.

- [ ] **Step 6: Baseline**

Run:
```bash
bun run db:generate
bun run test:scoped src/fleet test/integration/fleet/fleet-budgets-schema.integration.spec.ts
```
Expected: PASS (the fleet unit suites plus the 2a schema spec against `koda_slice3a_test`).

---

### Task 1: Schema, migration and the new `FleetJob` fields

**Files:**
- Modify: `apps/api/prisma/schema.prisma` (`User`, `Project`, `FleetJob`; new `JobSchedule`)
- Create: `apps/api/prisma/migrations/20261002140000_fleet_schedules/migration.sql`
- Modify: `apps/api/test/helpers/partial-indexes.ts`
- Modify: `apps/api/src/fleet/jobs/domain/fleet-job.domain.ts` (`FleetJobRecord`, `NewFleetJob`)
- Modify: `apps/api/src/fleet/jobs/job-transitions.service.spec.ts`, `apps/api/src/fleet/jobs/dto/fleet-job.dto.spec.ts` (record literals)
- Modify: `apps/api/src/fleet/activity/domain/fleet-activity.domain.ts`, `apps/api/src/fleet/activity/dto/list-fleet-activity.query.ts`
- Test: `apps/api/test/integration/fleet/fleet-schedules-schema.integration.spec.ts`

**Interfaces:**
- Produces: Prisma model `JobSchedule` (client `prisma.jobSchedule`); `FleetJobRecord.scheduleId: string | null`,
  `.coalescedCount: number`, `.scheduleCountedAt: Date | null`; `NewFleetJob.scheduleId?: string | null`;
  `FleetEntityType` includes `'schedule'`; `PARTIAL_UNIQUE_INDEXES` gains the `FleetJob_schedule_queued_key`
  statement.

- [ ] **Step 1: Write the failing schema test**

Create `apps/api/test/integration/fleet/fleet-schedules-schema.integration.spec.ts`:

```ts
/**
 * Fleet S1b slice 3a — JobSchedule and the FleetJob schedule link (PG).
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-schedules-schema.integration.spec.ts
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { seedFleetBase } from '../../helpers/fleet-fixtures';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('fleet schedules schema (PG)', () => {
  const prisma = new PrismaClient();
  let base: Awaited<ReturnType<typeof seedFleetBase>>;
  let n = 0;

  const schedule = (over: Partial<Prisma.JobScheduleUncheckedCreateInput> = {}) => prisma.jobSchedule.create({
    data: {
      projectId: base.projectId, repoId: base.repoId, name: `s${++n}`, cron: '0 * * * *', timezone: 'UTC', feature: `f${n}`,
      ref: 'main', profiles: [], maxCostUsd: new Prisma.Decimal(5), selectorLabels: [],
      nextFireAt: new Date('2026-10-02T04:00:00.000Z'), createdById: base.adminId, updatedById: base.adminId, ...over,
    },
  });
  const job = (over: Partial<Prisma.FleetJobUncheckedCreateInput> = {}) => prisma.fleetJob.create({
    data: {
      projectId: base.projectId, repoId: base.repoId, ref: 'main', command: 'RUN', feature: `jf${++n}`, profiles: [],
      maxCostUsd: new Prisma.Decimal(5), selectorLabels: [], requestedById: base.adminId, ...over,
    },
  });

  beforeAll(async () => {
    await resetDb();
    base = await seedFleetBase(prisma);
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('defaults to enabled with zeroed counters and a stall limit of 3', async () => {
    const s = await schedule();
    expect(s).toEqual(expect.objectContaining({
      enabled: true, lastPassedCount: 0, noProgressTicks: 0, noProgressLimit: 3, disabledReason: null, lastFiredAt: null, lastJobId: null,
    }));
  });

  it('gives a job no schedule, no coalesced ticks and no counted-at by default', async () => {
    const j = await job();
    expect(j).toEqual(expect.objectContaining({ scheduleId: null, coalescedCount: 0, scheduleCountedAt: null }));
  });

  it('allows one QUEUED job per schedule, any number of other states and any number of unscheduled QUEUED jobs', async () => {
    const s = await schedule();
    await job({ scheduleId: s.id, state: 'QUEUED' });
    await expect(job({ scheduleId: s.id, state: 'QUEUED' })).rejects.toMatchObject({ code: 'P2002' });
    await expect(job({ scheduleId: s.id, state: 'FAILED' })).resolves.toBeDefined();
    await expect(job({ scheduleId: s.id, state: 'RUNNING' })).resolves.toBeDefined();
    await job({ state: 'QUEUED' });
    await expect(job({ state: 'QUEUED' })).resolves.toBeDefined();
  });

  it('keeps a schedule\'s jobs, detached, when the schedule is deleted (plan D193)', async () => {
    const s = await schedule();
    const j = await job({ scheduleId: s.id, state: 'FAILED' });
    await prisma.jobSchedule.delete({ where: { id: s.id } });
    expect((await prisma.fleetJob.findUniqueOrThrow({ where: { id: j.id } })).scheduleId).toBeNull();
  });

  it('survives the deletion of its repo, and may name a runner that does not exist (plan D193)', async () => {
    const repo = await prisma.fleetRepo.create({
      data: { projectId: base.projectId, provider: 'github', owner: 'acme', name: 'gone', defaultBranch: 'main', githubInstallationId: BigInt(77), createdById: base.adminId },
    });
    const s = await schedule({ repoId: repo.id, pinnedRunnerId: 'no-such-runner' });
    await prisma.fleetRepo.delete({ where: { id: repo.id } });
    expect(await prisma.jobSchedule.count({ where: { id: s.id } })).toBe(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && bun run test:scoped test/integration/fleet/fleet-schedules-schema.integration.spec.ts`
Expected: FAIL at compile time (`Property 'jobSchedule' does not exist on type 'PrismaClient'`).

- [ ] **Step 3: Edit the Prisma schema**

In `apps/api/prisma/schema.prisma`:

In `model User`, after the line `fleetJobs          FleetJob[]      @relation("FleetJobRequestedBy")` add:

```prisma
  jobSchedules       JobSchedule[]   @relation("JobScheduleCreatedBy")
```

In `model Project`, after the line `fleetJobs          FleetJob[]` add:

```prisma
  jobSchedules       JobSchedule[]
```

In `model FleetJob`, after the `cancelReason` line add:

```prisma
  scheduleId        String? // S1b §3.1: the schedule that dispatched this job
  coalescedCount    Int       @default(0) // S1b §3.2: ticks absorbed while this job sat QUEUED
  scheduleCountedAt DateTime? // S1b §3.3: set once, when the job's end was counted against its schedule
```

In `model FleetJob`'s relation block, after `requestedBy  User               @relation("FleetJobRequestedBy", fields: [requestedById], references: [id])` add:

```prisma
  schedule     JobSchedule?       @relation(fields: [scheduleId], references: [id], onDelete: SetNull)
```

and after `@@index([runnerId, firstStartedAt])` add:

```prisma
  @@index([scheduleId, queuedAt])
```

Append after `model BudgetIncident { ... }`:

```prisma
/// S1b §3.1 C4 schedule: drives one feature to done with RUNs. repoId and pinnedRunnerId have no foreign key
/// on purpose (plan D193): a deleted repo or runner disables the schedule instead of deleting it.
/// The partial unique index FleetJob (scheduleId) WHERE state = 'QUEUED' is raw SQL in the migration.
model JobSchedule {
  id              String    @id @default(cuid())
  projectId       String
  repoId          String
  name            String
  cron            String // five fields
  timezone        String // IANA
  feature         String
  ref             String
  profiles        String[]
  maxCostUsd      Decimal   @db.Decimal(12, 4)
  selectorLabels  String[]
  pinnedRunnerId  String?
  enabled         Boolean   @default(true)
  nextFireAt      DateTime
  lastFiredAt     DateTime?
  lastJobId       String?
  lastPassedCount Int       @default(0)
  noProgressTicks Int       @default(0)
  noProgressLimit Int       @default(3)
  disabledReason  String? // completed | finish_failed | no_progress | owner_lost_access | template_invalid | manual
  createdById     String
  updatedById     String
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt

  project   Project    @relation(fields: [projectId], references: [id], onDelete: Cascade)
  createdBy User       @relation("JobScheduleCreatedBy", fields: [createdById], references: [id])
  jobs      FleetJob[]

  @@index([enabled, nextFireAt])
  @@index([projectId])
}
```

The `FleetActivity.entityType` comment already reads `runner | enrollment | repo | job | budget | schedule` (2a added
it); leave it.

- [ ] **Step 4: Write the migration**

Create `apps/api/prisma/migrations/20261002140000_fleet_schedules/migration.sql`:

```sql
-- S1b slice 3a: job schedules, and the schedule link on FleetJob.
-- AlterTable
ALTER TABLE "FleetJob" ADD COLUMN     "coalescedCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "scheduleCountedAt" TIMESTAMP(3),
ADD COLUMN     "scheduleId" TEXT;

-- CreateTable
CREATE TABLE "JobSchedule" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "repoId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "cron" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "profiles" TEXT[],
    "maxCostUsd" DECIMAL(12,4) NOT NULL,
    "selectorLabels" TEXT[],
    "pinnedRunnerId" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "nextFireAt" TIMESTAMP(3) NOT NULL,
    "lastFiredAt" TIMESTAMP(3),
    "lastJobId" TEXT,
    "lastPassedCount" INTEGER NOT NULL DEFAULT 0,
    "noProgressTicks" INTEGER NOT NULL DEFAULT 0,
    "noProgressLimit" INTEGER NOT NULL DEFAULT 3,
    "disabledReason" TEXT,
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "JobSchedule_enabled_nextFireAt_idx" ON "JobSchedule"("enabled", "nextFireAt");

-- CreateIndex
CREATE INDEX "JobSchedule_projectId_idx" ON "JobSchedule"("projectId");

-- CreateIndex
CREATE INDEX "FleetJob_scheduleId_queuedAt_idx" ON "FleetJob"("scheduleId", "queuedAt");

-- AddForeignKey
ALTER TABLE "FleetJob" ADD CONSTRAINT "FleetJob_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "JobSchedule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobSchedule" ADD CONSTRAINT "JobSchedule_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobSchedule" ADD CONSTRAINT "JobSchedule_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- S1b §3.1: at most one QUEUED job per schedule (the coalescing invariant); prisma db push cannot express this.
CREATE UNIQUE INDEX IF NOT EXISTS "FleetJob_schedule_queued_key" ON "FleetJob" ("scheduleId") WHERE "state" = 'QUEUED';
```

- [ ] **Step 5: Add the partial index to the test replay list, regenerate the client, run the schema test**

In `apps/api/test/helpers/partial-indexes.ts`, add as the last array element:

```ts
  `CREATE UNIQUE INDEX IF NOT EXISTS "FleetJob_schedule_queued_key" ON "FleetJob" ("scheduleId") WHERE "state" = 'QUEUED'`,
```

Run:
```bash
cd apps/api
bun run db:generate
bun run test:scoped test/integration/fleet/fleet-schedules-schema.integration.spec.ts test/unit/fleet/partial-indexes.spec.ts
```
Expected: PASS (5 schema cases; the partial-index spec now has three statements and proves the migration ships each verbatim).

- [ ] **Step 6: Prove the migration matches the schema (`prisma db push` hides drift)**

Run:
```bash
cd apps/api
bunx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma \
  --shadow-database-url postgresql://koda:koda@localhost:5433/koda_slice3a_shadow --exit-code
```
Expected: `No difference detected.` and exit code 0. If it prints a diff, fix `migration.sql` (not the schema).
(The partial unique index is invisible to the diff: Prisma does not model it. The `partial-indexes.spec.ts` run in
Step 5 is what pins it.)

- [ ] **Step 7: Carry the new columns in the job record**

In `apps/api/src/fleet/jobs/domain/fleet-job.domain.ts`, in `FleetJobRecord` after `cancelReason: string | null;` add:

```ts
  /** The schedule that dispatched the job (S1b §3.1); null for a manual job or after the schedule was deleted. */
  scheduleId: string | null;
  /** Ticks absorbed while this job sat QUEUED (S1b §3.2). */
  coalescedCount: number;
  /** Set once when this job's end was counted against its schedule (S1b §3.3, plan D195/D196). */
  scheduleCountedAt: Date | null;
```

In `NewFleetJob` after `requestedById: string;` add:

```ts
  scheduleId?: string | null;
```

`toJob` in `prisma-fleet-job.repository.ts` spreads the row (`...r`), so the three fields flow through without a
change; `createJob` spreads `data`, so `scheduleId` reaches the insert. Do **not** add the new fields to `Mutable`:
`coalescedCount` and `scheduleCountedAt` are written by dedicated schedule-repository statements (Task 4).

- [ ] **Step 8: Update the record literals and the entity-type lists**

In every `FleetJobRecord` literal in `apps/api/src/fleet/jobs/job-transitions.service.spec.ts` (the `job()` factory)
and `apps/api/src/fleet/jobs/dto/fleet-job.dto.spec.ts` (the two records), add
`scheduleId: null, coalescedCount: 0, scheduleCountedAt: null,` right after the `cancelReason: null,` entry. Find any
other literal with `grep -rn "storiesTruncated:" apps/api/src apps/api/test`.

In `apps/api/src/fleet/activity/domain/fleet-activity.domain.ts` change the union to
`'runner' | 'enrollment' | 'repo' | 'job' | 'budget' | 'schedule'`. In
`apps/api/src/fleet/activity/dto/list-fleet-activity.query.ts` add `'schedule'` to both the `enum:` list and the
`@IsIn([...])` list (otherwise `GET /fleet/activity?entityType=schedule` answers 400).

- [ ] **Step 9: Type-check and run the fleet unit specs**

Run: `cd apps/api && bun run type-check && bun run test:scoped src/fleet`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add apps/api/prisma apps/api/test/helpers/partial-indexes.ts apps/api/src/fleet \
  apps/api/test/integration/fleet/fleet-schedules-schema.integration.spec.ts
git commit -m "feat(fleet): job schedule table and the FleetJob schedule link"
```

---

### Task 2: Cron wrapper — five fields, zones, the 15-minute gap, next fire

**Files:**
- Modify: `apps/api/package.json`, `bun.lock` (dependency `cron-parser`)
- Create: `apps/api/src/fleet/schedules/cron-schedule.ts`
- Test: `apps/api/src/fleet/schedules/cron-schedule.spec.ts`

**Interfaces:**
- Produces (`cron-schedule.ts`):
  `MIN_FIRE_GAP_MS = 900_000`, `GAP_CHECK_FIRES = 100`;
  `class CronInputError extends Error { readonly failure: 'syntax' | 'timezone' | 'too_frequent' }`;
  `normalizeCron(expression: string): string`;
  `canonicalTimezone(timezone: string): string`;
  `nextFireAfter(cron: string, timezone: string, after: Date): Date` (strictly after `after`);
  `assertCronAllowed(cron: string, timezone: string, now: Date): { cron: string; timezone: string }`.

- [ ] **Step 1: Add the dependency**

Run:
```bash
cd apps/api && bun add cron-parser@^5.10.1
cd ../.. && git status --short apps/api/package.json bun.lock
```
Expected: `apps/api/package.json` gains `"cron-parser": "^5.10.1"` under `dependencies`; `bun.lock` changes. Commit both
(CI runs `bun install --frozen-lockfile`).

- [ ] **Step 2: Write the failing spec**

Create `apps/api/src/fleet/schedules/cron-schedule.spec.ts`:

```ts
import { assertCronAllowed, canonicalTimezone, CronInputError, nextFireAfter, normalizeCron } from './cron-schedule';

const at = (iso: string): Date => new Date(iso);
const failure = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof CronInputError ? error.failure : 'other';
  }
};
/** The next `count` fires after `from`, each computed from the previous one (what the ticker does). */
const fires = (cron: string, timezone: string, from: string, count: number): string[] => {
  const out: string[] = [];
  let cursor = at(from);
  for (let i = 0; i < count; i += 1) {
    cursor = nextFireAfter(cron, timezone, cursor);
    out.push(cursor.toISOString());
  }
  return out;
};

describe('normalizeCron', () => {
  it('collapses whitespace and keeps five fields', () => {
    expect(normalizeCron('  0   9 * *  1-5 ')).toBe('0 9 * * 1-5');
  });

  it.each(['* * * *', '* * * * * *', '@daily', '', '   '])('rejects %p (not exactly five fields)', (expression) => {
    expect(failure(() => normalizeCron(expression))).toBe('syntax');
  });
});

describe('canonicalTimezone', () => {
  it('canonicalises the case of an IANA name', () => {
    expect(canonicalTimezone('asia/singapore')).toBe('Asia/Singapore');
    expect(canonicalTimezone('UTC')).toBe('UTC');
  });

  it.each(['', 'Mars/Base', 'Not a zone'])('rejects %p', (zone) => {
    expect(failure(() => canonicalTimezone(zone))).toBe('timezone');
  });
});

describe('nextFireAfter', () => {
  it('is strictly after the given instant', () => {
    expect(nextFireAfter('0 9 * * *', 'Asia/Singapore', at('2026-10-02T01:00:00.000Z')).toISOString()).toBe('2026-10-03T01:00:00.000Z');
    expect(nextFireAfter('0 9 * * *', 'Asia/Singapore', at('2026-10-02T00:59:59.999Z')).toISOString()).toBe('2026-10-02T01:00:00.000Z');
  });

  it('reads the cron in its own zone, whatever zone the process runs in', () => {
    expect(nextFireAfter('30 8 * * *', 'Asia/Singapore', at('2026-10-02T00:00:00.000Z')).toISOString()).toBe('2026-10-02T00:30:00.000Z');
    expect(nextFireAfter('30 8 * * *', 'UTC', at('2026-10-02T00:00:00.000Z')).toISOString()).toBe('2026-10-02T08:30:00.000Z');
  });

  it('fires a nonexistent local time once, shifted past the gap (spring forward, New York)', () => {
    expect(fires('30 2 * * *', 'America/New_York', '2026-03-07T12:00:00.000Z', 3)).toEqual([
      '2026-03-08T07:30:00.000Z', // 03:30 EDT: 02:30 does not exist on 8 March
      '2026-03-09T06:30:00.000Z', // 02:30 EDT
      '2026-03-10T06:30:00.000Z',
    ]);
  });

  it('fires an ambiguous local time once (fall back, New York)', () => {
    expect(fires('30 1 * * *', 'America/New_York', '2026-10-30T12:00:00.000Z', 3)).toEqual([
      '2026-10-31T05:30:00.000Z',
      '2026-11-01T05:30:00.000Z', // 01:30 EDT, the first of the two 01:30s on 1 November
      '2026-11-02T06:30:00.000Z', // 01:30 EST
    ]);
  });

  it('ORs day-of-month with day-of-week, as Vixie cron does', () => {
    expect(fires('0 9 13 * 5', 'UTC', '2026-10-02T00:00:00.000Z', 4)).toEqual([
      '2026-10-02T09:00:00.000Z',
      '2026-10-09T09:00:00.000Z',
      '2026-10-13T09:00:00.000Z',
      '2026-10-16T09:00:00.000Z',
    ]);
  });
});

describe('assertCronAllowed', () => {
  const NOW = at('2026-10-02T03:00:30.000Z');

  it.each(['*/15 * * * *', '0 * * * *', '0 9 * * 1-5', '30 8 1 * *'])('accepts %p', (expression) => {
    expect(assertCronAllowed(expression, 'UTC', NOW)).toEqual({ cron: expression, timezone: 'UTC' });
  });

  it('returns the normalised expression and the canonical zone', () => {
    expect(assertCronAllowed(' 0  9 * * * ', 'asia/singapore', NOW)).toEqual({ cron: '0 9 * * *', timezone: 'Asia/Singapore' });
  });

  it.each(['* * * * *', '*/10 * * * *', '0,10 * * * *', '0,5 0 1 * *'])('refuses %p: two fires closer than 15 minutes', (expression) => {
    expect(failure(() => assertCronAllowed(expression, 'UTC', NOW))).toBe('too_frequent');
  });

  it.each(['61 * * * *', '0 0 30 2 *', 'abc * * * *', '* * * *'])('refuses %p as a syntax error', (expression) => {
    expect(failure(() => assertCronAllowed(expression, 'UTC', NOW))).toBe('syntax');
  });

  it('refuses an unknown zone', () => {
    expect(failure(() => assertCronAllowed('0 * * * *', 'Mars/Base', NOW))).toBe('timezone');
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd apps/api && bun run test:scoped src/fleet/schedules/cron-schedule.spec.ts`
Expected: FAIL (`Cannot find module './cron-schedule'`).

- [ ] **Step 4: Write the implementation**

Create `apps/api/src/fleet/schedules/cron-schedule.ts`:

```ts
import { CronExpressionParser } from 'cron-parser';

/** S1b §3.1: no two consecutive fires closer than this. */
export const MIN_FIRE_GAP_MS = 15 * 60 * 1000;
/** S1b §3.1: how many upcoming fires the gap check walks (plan D191: an approximation). */
export const GAP_CHECK_FIRES = 100;

export type CronFailure = 'syntax' | 'timezone' | 'too_frequent';

/** A cron or zone the schedule may not use. The caller maps `failure` to a 400 (plan D191). */
export class CronInputError extends Error {
  constructor(readonly failure: CronFailure, message: string) {
    super(message);
    this.name = 'CronInputError';
  }
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** cron-parser pads missing fields and accepts six fields and aliases; a schedule cron is exactly five fields. */
export function normalizeCron(expression: string): string {
  const fields = expression.trim().split(/\s+/).filter((field) => field !== '');
  if (fields.length !== 5) throw new CronInputError('syntax', 'a schedule cron has exactly five fields: minute hour day month weekday');
  return fields.join(' ');
}

/** The canonical IANA name of a zone the runtime and cron-parser both know. */
export function canonicalTimezone(timezone: string): string {
  let canonical: string;
  try {
    canonical = new Intl.DateTimeFormat('en-US', { timeZone: timezone }).resolvedOptions().timeZone;
  } catch {
    throw new CronInputError('timezone', `unknown timezone ${JSON.stringify(timezone)}`);
  }
  try {
    CronExpressionParser.parse('0 0 * * *', { currentDate: new Date(0), tz: canonical }).next();
  } catch {
    throw new CronInputError('timezone', `unsupported timezone ${JSON.stringify(timezone)}`);
  }
  return canonical;
}

/** The first fire strictly after `after`, with the cron read in `timezone`. */
export function nextFireAfter(cron: string, timezone: string, after: Date): Date {
  return CronExpressionParser.parse(cron, { currentDate: after, tz: timezone }).next().toDate();
}

/** Validates a cron + zone for create and edit (S1b §3.1) and returns the values to store. */
export function assertCronAllowed(cron: string, timezone: string, now: Date): { cron: string; timezone: string } {
  const normalized = normalizeCron(cron);
  const zone = canonicalTimezone(timezone);
  let iterator: ReturnType<typeof CronExpressionParser.parse>;
  try {
    iterator = CronExpressionParser.parse(normalized, { currentDate: now, tz: zone });
  } catch (error) {
    throw new CronInputError('syntax', messageOf(error));
  }
  let previous: number | null = null;
  for (let i = 0; i < GAP_CHECK_FIRES; i += 1) {
    let at: number;
    try {
      at = iterator.next().toDate().getTime();
    } catch (error) {
      throw new CronInputError('syntax', messageOf(error));
    }
    if (previous !== null && at - previous < MIN_FIRE_GAP_MS) {
      throw new CronInputError('too_frequent', `two fires are less than ${MIN_FIRE_GAP_MS / 60_000} minutes apart`);
    }
    previous = at;
  }
  return { cron: normalized, timezone: zone };
}
```

- [ ] **Step 5: Run the spec in UTC and again under a non-UTC process zone**

Run:
```bash
cd apps/api
bun run test:scoped src/fleet/schedules/cron-schedule.spec.ts
TZ=Asia/Singapore bun run test:scoped src/fleet/schedules/cron-schedule.spec.ts
TZ=America/Los_Angeles bun run test:scoped src/fleet/schedules/cron-schedule.spec.ts
```
Expected: PASS all three (same results: the cron is read in its own zone, not the process zone).

- [ ] **Step 6: Commit**

```bash
git add apps/api/package.json bun.lock apps/api/src/fleet/schedules/cron-schedule.ts apps/api/src/fleet/schedules/cron-schedule.spec.ts
git commit -m "feat(fleet): cron wrapper for schedules (five fields, zones, 15-minute gap)"
```

---

### Task 3: Domain types, template, payloads and the progress verdict

**Files:**
- Create: `apps/api/src/fleet/schedules/domain/schedule.domain.ts`
- Create: `apps/api/src/fleet/schedules/schedule-template.ts`
- Create: `apps/api/src/fleet/schedules/schedule-progress-rules.ts`
- Create: `apps/api/src/fleet/schedules/schedule-payloads.ts`
- Test: `apps/api/src/fleet/schedules/schedule-progress-rules.spec.ts`, `apps/api/src/fleet/schedules/schedule-template.spec.ts`

**Interfaces:**
- Produces (`schedule.domain.ts`): `SCHEDULE_REPOSITORY` (symbol); `SCHEDULE_DISABLED_REASONS`;
  `ScheduleDisabledReason`; `AutoDisableReason = Exclude<ScheduleDisabledReason, 'manual'>`; `ScheduleRecord`;
  `NewSchedule`; `SchedulePatch`; `OwnerAccess`; `ScheduleActiveJob`; `IScheduleRepository` (full method list
  below, implemented in Task 4).
- Produces (`schedule-progress-rules.ts`): `ProgressVerdict`; `readProgress(progress: unknown): { passed: number | null; total: number | null }`;
  `judgeEndedJob(job: { state: string; progress: unknown }, lastPassedCount: number): ProgressVerdict`.
- Produces (`schedule-template.ts`): `ScheduleTemplate`; `toDispatchDto(t: ScheduleTemplate): DispatchFleetJobDto`.
- Produces (`schedule-payloads.ts`): `SYSTEM_ACTOR_ID = 'system'`; `schedulePayload(s, extra?)`;
  `scheduleWebhookPayload(s, reason)`.

- [ ] **Step 1: Write the failing verdict spec**

Create `apps/api/src/fleet/schedules/schedule-progress-rules.spec.ts`:

```ts
import { judgeEndedJob, ProgressVerdict, readProgress } from './schedule-progress-rules';

type Row = [string, string, unknown, number, ProgressVerdict];

const ROWS: Row[] = [
  // [name, state, progress, lastPassedCount, verdict]
  ['rule 1: COMPLETED disables, whatever the progress', 'COMPLETED', { passed: 3, total: 3 }, 0, { kind: 'disable', reason: 'completed' }],
  ['rule 1: COMPLETED with no progress at all', 'COMPLETED', null, 0, { kind: 'disable', reason: 'completed' }],
  ['rule 2: CANCELLED is ignored', 'CANCELLED', { passed: 5, total: 5 }, 0, { kind: 'ignore' }],
  ['rule 3: null progress is no progress', 'FAILED', null, 2, { kind: 'no_progress' }],
  ['rule 3: a string is no progress', 'FAILED', 'garbage', 2, { kind: 'no_progress' }],
  ['rule 3: an array is no progress', 'FAILED', [3, 3], 2, { kind: 'no_progress' }],
  ['rule 3: a non-numeric passed', 'FAILED', { passed: '2', total: 3 }, 0, { kind: 'no_progress' }],
  ['rule 3: a negative passed', 'FAILED', { passed: -1, total: 3 }, 0, { kind: 'no_progress' }],
  ['rule 3: a fractional passed', 'FAILED', { passed: 1.5, total: 3 }, 0, { kind: 'no_progress' }],
  ['rule 3: NaN passed', 'FAILED', { passed: Number.NaN, total: 3 }, 0, { kind: 'no_progress' }],
  ['rule 4: every story passed but the run FAILED', 'FAILED', { passed: 3, total: 3 }, 0, { kind: 'disable', reason: 'finish_failed' }],
  ['rule 4: every story passed, ESCALATED', 'ESCALATED', { passed: 3, total: 3 }, 0, { kind: 'disable', reason: 'finish_failed' }],
  ['rule 4: every story passed, CRASHED', 'CRASHED', { passed: 3, total: 3 }, 3, { kind: 'disable', reason: 'finish_failed' }],
  ['rule 4 needs total > 0: 0 of 0 is no progress', 'FAILED', { passed: 0, total: 0 }, 0, { kind: 'no_progress' }],
  ['rule 4 needs a numeric total: passed alone can be progress', 'FAILED', { passed: 2 }, 0, { kind: 'progress', passed: 2 }],
  ['rule 5: more passed than before is progress', 'FAILED', { passed: 2, total: 5 }, 1, { kind: 'progress', passed: 2 }],
  ['rule 5 holds for CRASHED too', 'CRASHED', { passed: 2, total: 5 }, 1, { kind: 'progress', passed: 2 }],
  ['rule 5 holds for ESCALATED too', 'ESCALATED', { passed: 4, total: 5 }, 1, { kind: 'progress', passed: 4 }],
  ['rule 6: the same count is no progress', 'FAILED', { passed: 2, total: 5 }, 2, { kind: 'no_progress' }],
  ['rule 6: a lower count is no progress', 'FAILED', { passed: 1, total: 5 }, 2, { kind: 'no_progress' }],
];

describe('judgeEndedJob (S1b §3.3 rules 1-6, in order)', () => {
  it.each(ROWS)('%s', (_name, state, progress, last, verdict) => {
    expect(judgeEndedJob({ state, progress }, last)).toEqual(verdict);
  });
});

describe('readProgress', () => {
  it('reads integer counts and nothing else', () => {
    expect(readProgress({ passed: 2, total: 5, failed: 1 })).toEqual({ passed: 2, total: 5 });
    expect(readProgress({ passed: 2.5, total: '5' })).toEqual({ passed: null, total: null });
    expect(readProgress(undefined)).toEqual({ passed: null, total: null });
  });
});
```

- [ ] **Step 2: Write the failing template spec**

Create `apps/api/src/fleet/schedules/schedule-template.spec.ts`:

```ts
import { normalizeDispatch } from '../jobs/dispatch-input';
import { toDispatchDto } from './schedule-template';

describe('toDispatchDto', () => {
  it('is always a RUN of the fixed feature, and passes the dispatch rules', () => {
    const dto = toDispatchDto({
      repoId: 'r1', feature: 'login', ref: 'main', profiles: ['fast'], maxCostUsd: '5.5000', selectorLabels: ['linux'], pinnedRunnerId: null,
    });
    expect(dto).toEqual({ repoId: 'r1', command: 'RUN', feature: 'login', ref: 'main', profiles: ['fast'], maxCostUsd: 5.5, selectorLabels: ['linux'] });
    expect(normalizeDispatch(dto, 'trunk')).toEqual(expect.objectContaining({ command: 'RUN', ref: 'main', maxCostUsd: '5.5', pinnedRunnerId: null }));
  });

  it('carries the pinned runner when there is one, and copies the arrays', () => {
    const profiles = ['fast'];
    const dto = toDispatchDto({ repoId: 'r1', feature: 'f', ref: 'main', profiles, maxCostUsd: '1', selectorLabels: [], pinnedRunnerId: 'run-1' });
    expect(dto.pinnedRunnerId).toBe('run-1');
    expect(dto.profiles).not.toBe(profiles);
  });
});
```

- [ ] **Step 3: Run both to verify they fail**

Run: `cd apps/api && bun run test:scoped src/fleet/schedules/schedule-progress-rules.spec.ts src/fleet/schedules/schedule-template.spec.ts`
Expected: FAIL (modules not found).

- [ ] **Step 4: Write the domain**

Create `apps/api/src/fleet/schedules/domain/schedule.domain.ts`:

```ts
import type { FleetJobState } from '../../../common/enums';

export const SCHEDULE_REPOSITORY = Symbol('SCHEDULE_REPOSITORY');

export const SCHEDULE_DISABLED_REASONS = [
  'completed', 'finish_failed', 'no_progress', 'owner_lost_access', 'template_invalid', 'manual',
] as const;
export type ScheduleDisabledReason = (typeof SCHEDULE_DISABLED_REASONS)[number];
/** The reasons the system sets; `manual` is a user's own disable. */
export type AutoDisableReason = Exclude<ScheduleDisabledReason, 'manual'>;

export const DEFAULT_NO_PROGRESS_LIMIT = 3;

export interface ScheduleRecord {
  id: string;
  projectId: string;
  /** No foreign key (plan D193): may name a repo that no longer exists. */
  repoId: string;
  name: string;
  cron: string;
  timezone: string;
  feature: string;
  ref: string;
  profiles: string[];
  /** Decimal as string. */
  maxCostUsd: string;
  selectorLabels: string[];
  /** No foreign key (plan D193). */
  pinnedRunnerId: string | null;
  enabled: boolean;
  nextFireAt: Date;
  lastFiredAt: Date | null;
  lastJobId: string | null;
  lastPassedCount: number;
  noProgressTicks: number;
  noProgressLimit: number;
  disabledReason: ScheduleDisabledReason | null;
  createdById: string;
  updatedById: string;
  createdAt: Date;
  updatedAt: Date;
}

export type NewSchedule = Pick<
  ScheduleRecord,
  'projectId' | 'repoId' | 'name' | 'cron' | 'timezone' | 'feature' | 'ref' | 'profiles' | 'maxCostUsd' | 'selectorLabels'
  | 'pinnedRunnerId' | 'noProgressLimit' | 'nextFireAt' | 'createdById'
>;

export type SchedulePatch = Partial<Pick<
  ScheduleRecord,
  'name' | 'cron' | 'timezone' | 'ref' | 'profiles' | 'maxCostUsd' | 'selectorLabels' | 'pinnedRunnerId' | 'enabled'
  | 'nextFireAt' | 'lastFiredAt' | 'lastJobId' | 'lastPassedCount' | 'noProgressTicks' | 'noProgressLimit'
  | 'disabledReason' | 'updatedById'
>>;

/** What the ticker needs to decide whether the owner may still dispatch (S1b §3.2, plan D201). */
export interface OwnerAccess {
  exists: boolean;
  disabled: boolean;
  /** `User.role`: MEMBER | ADMIN (empty when the user is gone). */
  globalRole: string;
  /** `ProjectMember.role` in the schedule's project, or null. */
  projectRole: string | null;
}

export interface ScheduleActiveJob {
  id: string;
  state: FleetJobState;
}

export interface IScheduleRepository {
  findById(id: string): Promise<ScheduleRecord | null>;
  /** SELECT … FOR UPDATE (inside txManager.run). */
  lockById(id: string): Promise<ScheduleRecord | null>;
  /** Oldest first. */
  findByProject(projectId: string): Promise<ScheduleRecord[]>;
  /** Enabled schedules with nextFireAt <= now, oldest due first, skipping soft-deleted projects (plan D207). */
  findDue(now: Date, limit: number): Promise<ScheduleRecord[]>;
  create(data: NewSchedule): Promise<ScheduleRecord>;
  update(id: string, patch: SchedulePatch): Promise<ScheduleRecord>;
  /** Detaches the schedule's jobs first (plan D194), then deletes the row. */
  delete(id: string): Promise<void>;
  /** Compare-and-set (S1b §3.2 step 2): true when this call moved nextFireAt off `expectedNextFireAt`. */
  claimFire(id: string, expectedNextFireAt: Date, nextFireAt: Date, now: Date): Promise<boolean>;
  /** The schedule's newest job in an active state, if any. */
  findActiveJob(scheduleId: string): Promise<ScheduleActiveJob | null>;
  /** Plan D200: one atomic UPDATE; the id of the QUEUED job that absorbed the tick, or null. */
  coalesceIntoQueued(scheduleId: string): Promise<string | null>;
  /** Plan D196: sets scheduleCountedAt when still null; true when this call claimed it. */
  claimCounted(jobId: string, now: Date): Promise<boolean>;
  findOwnerAccess(projectId: string, userId: string): Promise<OwnerAccess>;
  /** Sum of costSpentUsd + costCarriedUsd over each schedule's jobs, as 4-decimal strings; absent = no jobs. */
  sumCostBySchedule(ids: readonly string[]): Promise<ReadonlyMap<string, string>>;
}
```

- [ ] **Step 5: Write the template, the verdict and the payloads**

Create `apps/api/src/fleet/schedules/schedule-template.ts`:

```ts
import type { DispatchFleetJobDto } from '../jobs/dto/dispatch-fleet-job.dto';
import type { ScheduleRecord } from './domain/schedule.domain';

export type ScheduleTemplate = Pick<
  ScheduleRecord,
  'repoId' | 'feature' | 'ref' | 'profiles' | 'maxCostUsd' | 'selectorLabels' | 'pinnedRunnerId'
>;

/** S1b §3.1, B4: the template as a RUN dispatch. The same dispatch rules validate it (create) and run it (tick). */
export function toDispatchDto(template: ScheduleTemplate): DispatchFleetJobDto {
  return {
    repoId: template.repoId,
    command: 'RUN',
    feature: template.feature,
    ref: template.ref,
    profiles: [...template.profiles],
    maxCostUsd: Number(template.maxCostUsd),
    selectorLabels: [...template.selectorLabels],
    ...(template.pinnedRunnerId ? { pinnedRunnerId: template.pinnedRunnerId } : {}),
  };
}
```

Create `apps/api/src/fleet/schedules/schedule-progress-rules.ts`:

```ts
import type { AutoDisableReason } from './domain/schedule.domain';

export type ProgressVerdict =
  | { kind: 'ignore' }
  | { kind: 'disable'; reason: Extract<AutoDisableReason, 'completed' | 'finish_failed'> }
  | { kind: 'progress'; passed: number }
  | { kind: 'no_progress' };

/** A count the runner reported: a non-negative integer, or null. Anything else is treated as absent. */
const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;

/** nax's `status.progress` is cumulative over the PRD (S1b spec, "Why a RUN schedule works"). */
export function readProgress(progress: unknown): { passed: number | null; total: number | null } {
  if (typeof progress !== 'object' || progress === null || Array.isArray(progress)) return { passed: null, total: null };
  const p = progress as Record<string, unknown>;
  return { passed: count(p['passed']), total: count(p['total']) };
}

/**
 * S1b §3.3 rules 1-6, in order, for a scheduled job that reached a terminal state. Pure: the caller applies the
 * verdict to the schedule row.
 */
export function judgeEndedJob(job: { state: string; progress: unknown }, lastPassedCount: number): ProgressVerdict {
  if (job.state === 'COMPLETED') return { kind: 'disable', reason: 'completed' };
  if (job.state === 'CANCELLED') return { kind: 'ignore' };
  const { passed, total } = readProgress(job.progress);
  if (passed === null) return { kind: 'no_progress' };
  if (total !== null && total > 0 && passed === total) return { kind: 'disable', reason: 'finish_failed' };
  return passed > lastPassedCount ? { kind: 'progress', passed } : { kind: 'no_progress' };
}
```

Create `apps/api/src/fleet/schedules/schedule-payloads.ts`:

```ts
import type { ScheduleDisabledReason, ScheduleRecord } from './domain/schedule.domain';

/** The activity actor id of an automatic action (the same value as `SYSTEM_ACTOR.id` in the jobs module). */
export const SYSTEM_ACTOR_ID = 'system';

/**
 * FleetActivity payload of a schedule row. `FleetActivityService.record` throws on a key matching
 * /token|secret|key|password|credential/i, so none of these names may contain one.
 */
export function schedulePayload(s: ScheduleRecord, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: s.name, repoId: s.repoId, feature: s.feature, cron: s.cron, timezone: s.timezone, ...extra };
}

/** Body of the fleet.schedule.disabled webhook (S1b §4). */
export function scheduleWebhookPayload(s: ScheduleRecord, reason: ScheduleDisabledReason): Record<string, unknown> {
  return {
    scheduleId: s.id, projectId: s.projectId, name: s.name, repoId: s.repoId, feature: s.feature, reason,
    noProgressTicks: s.noProgressTicks, noProgressLimit: s.noProgressLimit, lastPassedCount: s.lastPassedCount, lastJobId: s.lastJobId,
  };
}
```

- [ ] **Step 6: Run the specs**

Run: `cd apps/api && bun run test:scoped src/fleet/schedules && bun run type-check`
Expected: PASS (cron, verdict and template specs).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/fleet/schedules
git commit -m "feat(fleet): schedule domain, template and the ended-job verdict"
```

---

### Task 4: Schedule repository and `ScheduleStoreModule`

**Files:**
- Create: `apps/api/src/fleet/schedules/prisma-schedule.repository.ts`
- Create: `apps/api/src/fleet/schedules/schedule-store.module.ts`
- Modify: `apps/api/src/fleet/jobs/fleet-jobs.module.ts` (import the store module)
- Test: `apps/api/test/integration/fleet/fleet-schedule-repository.integration.spec.ts`

**Interfaces:**
- Consumes: `IScheduleRepository`, `SCHEDULE_REPOSITORY`, `ScheduleRecord`, `NewSchedule`, `SchedulePatch`,
  `OwnerAccess`, `ScheduleActiveJob` (Task 3); `ACTIVE_STATES` from `jobs/job-state`.
- Produces: `PrismaScheduleRepository implements IScheduleRepository`; `ScheduleStoreModule` exporting
  `SCHEDULE_REPOSITORY` (Task 5 adds `ScheduleProgressService` to it).

- [ ] **Step 1: Write the failing repository spec**

Create `apps/api/test/integration/fleet/fleet-schedule-repository.integration.spec.ts`:

```ts
/**
 * Fleet S1b slice 3a — PrismaScheduleRepository on PG: CAS claim, atomic coalesce, counted claim, owner access.
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-schedule-repository.integration.spec.ts
 */
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { seedFleetBase } from '../../helpers/fleet-fixtures';
import type { NewSchedule } from '../../../src/fleet/schedules/domain/schedule.domain';
import { PrismaScheduleRepository } from '../../../src/fleet/schedules/prisma-schedule.repository';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

jest.setTimeout(20_000);

describeIntegration('schedule repository (PG)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let repo: PrismaScheduleRepository;
  let base: Awaited<ReturnType<typeof seedFleetBase>>;
  let n = 0;
  const NOW = new Date('2026-10-02T03:00:30.000Z');
  const DUE = new Date('2026-10-02T03:00:00.000Z');

  const make = (over: Partial<NewSchedule> = {}) => repo.create({
    projectId: base.projectId, repoId: base.repoId, name: `s${++n}`, cron: '0 * * * *', timezone: 'UTC', feature: `rf${n}`,
    ref: 'main', profiles: [], maxCostUsd: '5', selectorLabels: [], pinnedRunnerId: null, noProgressLimit: 3,
    nextFireAt: DUE, createdById: base.adminId, ...over,
  });
  const job = (scheduleId: string | null, over: Partial<Prisma.FleetJobUncheckedCreateInput> = {}) => prisma.fleetJob.create({
    data: {
      projectId: base.projectId, repoId: base.repoId, ref: 'main', command: 'RUN', feature: `rj${++n}`, profiles: [],
      maxCostUsd: new Prisma.Decimal(5), selectorLabels: [], requestedById: base.adminId, scheduleId, ...over,
    },
  });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    repo = app.get(PrismaScheduleRepository);
    base = await seedFleetBase(prisma);
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await prisma.fleetJob.deleteMany();
    await prisma.jobSchedule.deleteMany();
  });

  it('round-trips a schedule with the decimal as a string and the creator as updater', async () => {
    const s = await make({ maxCostUsd: '5.5' });
    expect(await repo.findById(s.id)).toEqual(expect.objectContaining({
      id: s.id, maxCostUsd: '5.5', updatedById: base.adminId, enabled: true, disabledReason: null, nextFireAt: DUE,
    }));
    expect(await repo.findById('nope')).toBeNull();
  });

  it('findDue: enabled and due only, oldest first, capped, and never a soft-deleted project (plan D207)', async () => {
    const late = await make({ nextFireAt: new Date('2026-10-02T03:00:10.000Z') });
    const early = await make({ nextFireAt: new Date('2026-10-02T02:00:00.000Z') });
    await make({ nextFireAt: new Date('2026-10-02T09:00:00.000Z') });
    const off = await make({ nextFireAt: DUE });
    await repo.update(off.id, { enabled: false, disabledReason: 'manual' });
    const gone = await prisma.project.create({ data: { name: 'gone', slug: 'gone-p', key: 'GONEP', deletedAt: new Date() } });
    await make({ projectId: gone.id, nextFireAt: DUE });

    expect((await repo.findDue(NOW, 10)).map((s) => s.id)).toEqual([early.id, late.id]);
    expect((await repo.findDue(NOW, 1)).map((s) => s.id)).toEqual([early.id]);
  });

  it('claimFire moves nextFireAt once: a second claim of the same value, or of a disabled schedule, loses', async () => {
    const s = await make();
    const next = new Date('2026-10-02T04:00:00.000Z');
    expect(await repo.claimFire(s.id, DUE, next, NOW)).toBe(true);
    expect(await repo.claimFire(s.id, DUE, next, NOW)).toBe(false);
    expect(await repo.findById(s.id)).toEqual(expect.objectContaining({ nextFireAt: next, lastFiredAt: NOW }));
    await repo.update(s.id, { enabled: false, disabledReason: 'manual' });
    expect(await repo.claimFire(s.id, next, new Date('2026-10-02T05:00:00.000Z'), NOW)).toBe(false);
  });

  it('claimFire under two concurrent callers has exactly one winner', async () => {
    const s = await make();
    const next = new Date('2026-10-02T04:00:00.000Z');
    const wins = await Promise.all([repo.claimFire(s.id, DUE, next, NOW), repo.claimFire(s.id, DUE, next, NOW)]);
    expect(wins.filter(Boolean)).toHaveLength(1);
  });

  it('findActiveJob returns the newest active job and ignores finished ones', async () => {
    const s = await make();
    expect(await repo.findActiveJob(s.id)).toBeNull();
    await job(s.id, { state: 'FAILED' });
    expect(await repo.findActiveJob(s.id)).toBeNull();
    const running = await job(s.id, { state: 'RUNNING' });
    expect(await repo.findActiveJob(s.id)).toEqual({ id: running.id, state: 'RUNNING' });
  });

  it('coalesceIntoQueued adds one to the QUEUED job atomically and does nothing for any other state (plan D200)', async () => {
    const s = await make();
    const queued = await job(s.id, { state: 'QUEUED' });
    expect(await repo.coalesceIntoQueued(s.id)).toBe(queued.id);
    expect(await repo.coalesceIntoQueued(s.id)).toBe(queued.id);
    expect((await prisma.fleetJob.findUniqueOrThrow({ where: { id: queued.id } })).coalescedCount).toBe(2);
    await prisma.fleetJob.update({ where: { id: queued.id }, data: { state: 'ASSIGNED' } });
    expect(await repo.coalesceIntoQueued(s.id)).toBeNull();
    expect((await prisma.fleetJob.findUniqueOrThrow({ where: { id: queued.id } })).coalescedCount).toBe(2);
  });

  it('claimCounted succeeds once per job (plan D196)', async () => {
    const s = await make();
    const j = await job(s.id, { state: 'FAILED' });
    const wins = await Promise.all([repo.claimCounted(j.id, NOW), repo.claimCounted(j.id, NOW)]);
    expect(wins.filter(Boolean)).toHaveLength(1);
    expect((await prisma.fleetJob.findUniqueOrThrow({ where: { id: j.id } })).scheduleCountedAt).toEqual(NOW);
    expect(await repo.claimCounted(j.id, NOW)).toBe(false);
  });

  it('findOwnerAccess reports a missing user, a disabled user, and the project role', async () => {
    expect(await repo.findOwnerAccess(base.projectId, 'no-such-user')).toEqual({ exists: false, disabled: false, globalRole: '', projectRole: null });
    const off = await prisma.user.create({ data: { email: 'off@koda.test', passwordHash: 'x', role: 'MEMBER', disabled: true } });
    expect(await repo.findOwnerAccess(base.projectId, off.id)).toEqual({ exists: true, disabled: true, globalRole: 'MEMBER', projectRole: null });
    const dev = await prisma.user.create({ data: { email: 'dev-access@koda.test', passwordHash: 'x', role: 'MEMBER' } });
    await prisma.projectMember.create({ data: { projectId: base.projectId, userId: dev.id, role: 'DEVELOPER' } });
    expect(await repo.findOwnerAccess(base.projectId, dev.id)).toEqual({ exists: true, disabled: false, globalRole: 'MEMBER', projectRole: 'DEVELOPER' });
    expect(await repo.findOwnerAccess(base.projectId, base.adminId)).toEqual({ exists: true, disabled: false, globalRole: 'ADMIN', projectRole: null });
  });

  it('delete detaches the schedule\'s jobs and keeps them (plan D194)', async () => {
    const s = await make();
    const j = await job(s.id, { state: 'FAILED' });
    await repo.delete(s.id);
    expect(await repo.findById(s.id)).toBeNull();
    expect((await prisma.fleetJob.findUniqueOrThrow({ where: { id: j.id } })).scheduleId).toBeNull();
  });

  it('sumCostBySchedule adds spent and carried cost per schedule; a schedule with no jobs is absent', async () => {
    const a = await make();
    const b = await make();
    await job(a.id, { state: 'FAILED', costSpentUsd: new Prisma.Decimal('1.25'), costCarriedUsd: new Prisma.Decimal('0.5') });
    await job(a.id, { state: 'COMPLETED', costSpentUsd: new Prisma.Decimal('2') });
    expect(await repo.sumCostBySchedule([a.id, b.id])).toEqual(new Map([[a.id, '3.7500']]));
    expect(await repo.sumCostBySchedule([])).toEqual(new Map());
  });

  it('lockById returns the record inside a transaction and null for an unknown id', async () => {
    const s = await make();
    expect((await repo.lockById(s.id))?.id).toBe(s.id);
    expect(await repo.lockById('nope')).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && bun run test:scoped test/integration/fleet/fleet-schedule-repository.integration.spec.ts`
Expected: FAIL at compile time (`Cannot find module '.../prisma-schedule.repository'`).

- [ ] **Step 3: Write the repository**

Create `apps/api/src/fleet/schedules/prisma-schedule.repository.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { JobSchedule as ScheduleRow, Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { FleetJobState } from '../../common/enums';
import { ACTIVE_STATES } from '../jobs/job-state';
import {
  IScheduleRepository, NewSchedule, OwnerAccess, ScheduleActiveJob, ScheduleDisabledReason, SchedulePatch, ScheduleRecord,
} from './domain/schedule.domain';

const toSchedule = (r: ScheduleRow): ScheduleRecord => ({
  ...r,
  maxCostUsd: r.maxCostUsd.toString(),
  disabledReason: r.disabledReason as ScheduleDisabledReason | null,
});

@Injectable()
export class PrismaScheduleRepository implements IScheduleRepository {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  /** Transaction-scoped inside txManager.run (nestjs-prisma ALS proxy). */
  private get db() {
    return this.prisma.client;
  }

  async findById(id: string): Promise<ScheduleRecord | null> {
    const r = await this.db.jobSchedule.findUnique({ where: { id } });
    return r ? toSchedule(r) : null;
  }

  async lockById(id: string): Promise<ScheduleRecord | null> {
    const rows = await this.db.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "JobSchedule" WHERE "id" = ${id} FOR UPDATE`;
    return rows.length === 0 ? null : this.findById(id);
  }

  async findByProject(projectId: string): Promise<ScheduleRecord[]> {
    const rows = await this.db.jobSchedule.findMany({ where: { projectId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    return rows.map(toSchedule);
  }

  async findDue(now: Date, limit: number): Promise<ScheduleRecord[]> {
    const rows = await this.db.jobSchedule.findMany({
      where: { enabled: true, nextFireAt: { lte: now }, project: { deletedAt: null } },
      orderBy: [{ nextFireAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
    return rows.map(toSchedule);
  }

  async create(data: NewSchedule): Promise<ScheduleRecord> {
    const row = await this.db.jobSchedule.create({
      data: { ...data, maxCostUsd: new Prisma.Decimal(data.maxCostUsd), updatedById: data.createdById },
    });
    return toSchedule(row);
  }

  async update(id: string, patch: SchedulePatch): Promise<ScheduleRecord> {
    const { maxCostUsd, ...rest } = patch;
    const data: Prisma.JobScheduleUpdateInput = {
      ...rest,
      ...(maxCostUsd !== undefined ? { maxCostUsd: new Prisma.Decimal(maxCostUsd) } : {}),
    };
    return toSchedule(await this.db.jobSchedule.update({ where: { id }, data }));
  }

  async delete(id: string): Promise<void> {
    // Plan D194: lock order is job row, then schedule row. Detaching first keeps the FK's SET NULL from doing it the other way round.
    await this.db.fleetJob.updateMany({ where: { scheduleId: id }, data: { scheduleId: null } });
    await this.db.jobSchedule.delete({ where: { id } });
  }

  async claimFire(id: string, expectedNextFireAt: Date, nextFireAt: Date, now: Date): Promise<boolean> {
    const claimed = await this.db.jobSchedule.updateMany({
      where: { id, enabled: true, nextFireAt: expectedNextFireAt },
      data: { nextFireAt, lastFiredAt: now },
    });
    return claimed.count === 1;
  }

  async findActiveJob(scheduleId: string): Promise<ScheduleActiveJob | null> {
    const row = await this.db.fleetJob.findFirst({
      where: { scheduleId, state: { in: [...ACTIVE_STATES] } },
      orderBy: [{ queuedAt: 'desc' }, { id: 'desc' }],
      select: { id: true, state: true },
    });
    return row ? { id: row.id, state: row.state as FleetJobState } : null;
  }

  async coalesceIntoQueued(scheduleId: string): Promise<string | null> {
    const rows = await this.db.$queryRaw<Array<{ id: string }>>`
      UPDATE "FleetJob" SET "coalescedCount" = "coalescedCount" + 1
       WHERE "scheduleId" = ${scheduleId} AND "state" = 'QUEUED'
   RETURNING "id"`;
    return rows[0]?.id ?? null;
  }

  async claimCounted(jobId: string, now: Date): Promise<boolean> {
    const claimed = await this.db.fleetJob.updateMany({ where: { id: jobId, scheduleCountedAt: null }, data: { scheduleCountedAt: now } });
    return claimed.count === 1;
  }

  async findOwnerAccess(projectId: string, userId: string): Promise<OwnerAccess> {
    const user = await this.db.user.findUnique({ where: { id: userId }, select: { disabled: true, role: true } });
    if (!user) return { exists: false, disabled: false, globalRole: '', projectRole: null };
    const member = await this.db.projectMember.findUnique({ where: { projectId_userId: { projectId, userId } }, select: { role: true } });
    return { exists: true, disabled: user.disabled, globalRole: user.role, projectRole: member?.role ?? null };
  }

  async sumCostBySchedule(ids: readonly string[]): Promise<ReadonlyMap<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await this.db.fleetJob.groupBy({
      by: ['scheduleId'],
      where: { scheduleId: { in: [...ids] } },
      _sum: { costSpentUsd: true, costCarriedUsd: true },
    });
    return new Map(rows.flatMap((r): Array<[string, string]> =>
      r.scheduleId ? [[r.scheduleId, new Prisma.Decimal(r._sum.costSpentUsd ?? 0).add(r._sum.costCarriedUsd ?? 0).toFixed(4)]] : []));
  }
}
```

- [ ] **Step 4: Write the store module and import it into the jobs module**

Create `apps/api/src/fleet/schedules/schedule-store.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { SCHEDULE_REPOSITORY } from './domain/schedule.domain';
import { PrismaScheduleRepository } from './prisma-schedule.repository';

/** Plan D192: schedule storage, importable by the jobs module without a cycle (Task 5 adds ScheduleProgressService). */
@Module({
  imports: [PrismaModule],
  providers: [PrismaScheduleRepository, { provide: SCHEDULE_REPOSITORY, useExisting: PrismaScheduleRepository }],
  exports: [SCHEDULE_REPOSITORY, PrismaScheduleRepository],
})
export class ScheduleStoreModule {}
```

In `apps/api/src/fleet/jobs/fleet-jobs.module.ts` add
`import { ScheduleStoreModule } from '../schedules/schedule-store.module';` and append `ScheduleStoreModule` to the
`imports` array (after `BudgetStoreModule`).

- [ ] **Step 5: Run the repository spec and the module guard**

Run: `cd apps/api && bun run test:scoped test/integration/fleet/fleet-schedule-repository.integration.spec.ts src/fleet/jobs/fleet-jobs.module.spec.ts`
Expected: PASS (11 repository cases; the jobs module still compiles).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/fleet/schedules apps/api/src/fleet/jobs/fleet-jobs.module.ts apps/api/test/integration/fleet/fleet-schedule-repository.integration.spec.ts
git commit -m "feat(fleet): schedule repository with CAS claim, atomic coalesce and counted claim"
```

---

### Task 5: `ScheduleProgressService` and the auto-disable hook

**Files:**
- Create: `apps/api/src/fleet/schedules/schedule-progress.service.ts`
- Modify: `apps/api/src/fleet/schedules/schedule-store.module.ts`
- Modify: `apps/api/src/fleet/jobs/job-transitions.service.ts`
- Modify: `apps/api/src/fleet/jobs/job-transitions.service.spec.ts`
- Test: `apps/api/src/fleet/schedules/schedule-progress.service.spec.ts`
- Test: `apps/api/test/integration/fleet/fleet-schedule-progress.integration.spec.ts`

**Interfaces:**
- Consumes: `IScheduleRepository` (`lockById`, `claimCounted`, `update`), `judgeEndedJob` (Task 3), `FleetActivityService`,
  `WebhookDispatcherService`, `FleetJobRecord`.
- Produces: `ScheduleProgressService` with
  `onJobEnded(job: FleetJobRecord, now: Date): Promise<void>` (call inside `txManager.run`; counts the end once and
  applies the verdict) and
  `disable(scheduleId: string, reason: AutoDisableReason, detail?: { jobId?: string }): Promise<boolean>` (call
  inside `txManager.run`; false when the schedule is gone or already disabled). `JobTransitionsService.apply` calls
  `onJobEnded` for every terminal transition of a job with a `scheduleId`.

- [ ] **Step 1: Write the failing service spec**

Create `apps/api/src/fleet/schedules/schedule-progress.service.spec.ts`:

```ts
import type { FleetJobRecord } from '../jobs/domain/fleet-job.domain';
import type { ScheduleRecord } from './domain/schedule.domain';
import { ScheduleProgressService } from './schedule-progress.service';

const NOW = new Date('2026-10-02T03:00:30.000Z');
const schedule = (over: Partial<ScheduleRecord> = {}): ScheduleRecord => ({
  id: 's1', projectId: 'p1', repoId: 'r1', name: 'nightly', cron: '0 * * * *', timezone: 'UTC', feature: 'f', ref: 'main', profiles: [],
  maxCostUsd: '5', selectorLabels: [], pinnedRunnerId: null, enabled: true, nextFireAt: NOW, lastFiredAt: null, lastJobId: 'j1',
  lastPassedCount: 0, noProgressTicks: 0, noProgressLimit: 3, disabledReason: null, createdById: 'u1', updatedById: 'u1',
  createdAt: NOW, updatedAt: NOW, ...over,
});
const job = (over: Partial<FleetJobRecord> = {}): FleetJobRecord =>
  ({ id: 'j1', projectId: 'p1', state: 'FAILED', scheduleId: 's1', scheduleCountedAt: null, progress: null, ...over }) as FleetJobRecord;

function harness(current: ScheduleRecord | null = schedule(), claimed = true) {
  const repo = {
    claimCounted: jest.fn(async () => claimed),
    lockById: jest.fn(async () => current),
    update: jest.fn(async (_id: string, patch: Partial<ScheduleRecord>) => ({ ...(current as ScheduleRecord), ...patch })),
  };
  const activity = { record: jest.fn(async () => undefined) };
  const webhooks = { dispatch: jest.fn(async () => undefined) };
  return { repo, activity, webhooks, svc: new ScheduleProgressService(repo as never, activity as never, webhooks as never) };
}

describe('ScheduleProgressService.onJobEnded', () => {
  it.each([
    ['a job with no schedule', job({ scheduleId: null })],
    ['a job already counted', job({ scheduleCountedAt: NOW })],
    ['a CANCELLED job (plan D195: not marked counted either)', job({ state: 'CANCELLED' })],
  ])('does nothing for %s', async (_name, ended) => {
    const h = harness();
    await h.svc.onJobEnded(ended, NOW);
    expect(h.repo.claimCounted).not.toHaveBeenCalled();
    expect(h.repo.update).not.toHaveBeenCalled();
  });

  it('does nothing when another path already claimed the count (plan D196)', async () => {
    const h = harness(schedule(), false);
    await h.svc.onJobEnded(job(), NOW);
    expect(h.repo.lockById).not.toHaveBeenCalled();
    expect(h.repo.update).not.toHaveBeenCalled();
  });

  it('COMPLETED disables with completed: activity row and webhook in the same call', async () => {
    const h = harness();
    await h.svc.onJobEnded(job({ state: 'COMPLETED', progress: { passed: 3, total: 3 } }), NOW);
    expect(h.repo.update).toHaveBeenCalledWith('s1', { enabled: false, disabledReason: 'completed' });
    expect(h.activity.record).toHaveBeenCalledWith(expect.objectContaining({
      actorType: 'SYSTEM', actorId: 'system', action: 'schedule.auto_disabled', entityType: 'schedule', entityId: 's1',
      jobId: 'j1', projectId: 'p1', responsibleUserId: 'u1', payload: expect.objectContaining({ reason: 'completed', feature: 'f' }),
    }));
    expect(h.webhooks.dispatch).toHaveBeenCalledWith('p1', 'fleet.schedule.disabled', expect.objectContaining({ scheduleId: 's1', reason: 'completed' }));
  });

  it('FAILED with every story passed disables with finish_failed', async () => {
    const h = harness();
    await h.svc.onJobEnded(job({ progress: { passed: 4, total: 4 } }), NOW);
    expect(h.repo.update).toHaveBeenCalledWith('s1', { enabled: false, disabledReason: 'finish_failed' });
  });

  it('progress resets the counter and raises lastPassedCount; nothing is disabled', async () => {
    const h = harness(schedule({ noProgressTicks: 2, lastPassedCount: 1 }));
    await h.svc.onJobEnded(job({ progress: { passed: 2, total: 5 } }), NOW);
    expect(h.repo.update).toHaveBeenCalledWith('s1', { noProgressTicks: 0, lastPassedCount: 2 });
    expect(h.webhooks.dispatch).not.toHaveBeenCalled();
  });

  it('no progress below the limit only counts', async () => {
    const h = harness(schedule({ noProgressTicks: 1 }));
    await h.svc.onJobEnded(job({ progress: null }), NOW);
    expect(h.repo.update).toHaveBeenCalledWith('s1', { noProgressTicks: 2 });
    expect(h.activity.record).not.toHaveBeenCalled();
  });

  it('the no-progress tick that reaches the limit disables with no_progress in one update', async () => {
    const h = harness(schedule({ noProgressTicks: 2, noProgressLimit: 3 }));
    await h.svc.onJobEnded(job({ progress: 'garbage' }), NOW);
    expect(h.repo.update).toHaveBeenCalledTimes(1);
    expect(h.repo.update).toHaveBeenCalledWith('s1', { noProgressTicks: 3, enabled: false, disabledReason: 'no_progress' });
    expect(h.webhooks.dispatch).toHaveBeenCalledWith('p1', 'fleet.schedule.disabled', expect.objectContaining({ reason: 'no_progress' }));
  });

  it('a disabled schedule keeps its reason: only progress is applied (plan D197)', async () => {
    const off = schedule({ enabled: false, disabledReason: 'manual', noProgressTicks: 1 });
    const completed = harness(off);
    await completed.svc.onJobEnded(job({ state: 'COMPLETED' }), NOW);
    expect(completed.repo.update).not.toHaveBeenCalled();
    expect(completed.webhooks.dispatch).not.toHaveBeenCalled();
    const stalled = harness(off);
    await stalled.svc.onJobEnded(job({ progress: null }), NOW);
    expect(stalled.repo.update).not.toHaveBeenCalled();
    const moved = harness(off);
    await moved.svc.onJobEnded(job({ progress: { passed: 2, total: 5 } }), NOW);
    expect(moved.repo.update).toHaveBeenCalledWith('s1', { noProgressTicks: 0, lastPassedCount: 2 });
  });

  it('a schedule that no longer exists is not an error', async () => {
    const h = harness(null);
    await expect(h.svc.onJobEnded(job(), NOW)).resolves.toBeUndefined();
  });
});

describe('ScheduleProgressService.disable', () => {
  it('disables an enabled schedule once and reports true', async () => {
    const h = harness();
    expect(await h.svc.disable('s1', 'owner_lost_access')).toBe(true);
    expect(h.repo.update).toHaveBeenCalledWith('s1', { enabled: false, disabledReason: 'owner_lost_access' });
    expect(h.webhooks.dispatch).toHaveBeenCalledTimes(1);
  });

  it('reports false and writes nothing for a schedule that is gone or already disabled', async () => {
    const gone = harness(null);
    expect(await gone.svc.disable('s1', 'template_invalid')).toBe(false);
    const off = harness(schedule({ enabled: false, disabledReason: 'manual' }));
    expect(await off.svc.disable('s1', 'template_invalid')).toBe(false);
    expect(off.repo.update).not.toHaveBeenCalled();
    expect(off.webhooks.dispatch).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && bun run test:scoped src/fleet/schedules/schedule-progress.service.spec.ts`
Expected: FAIL (`Cannot find module './schedule-progress.service'`).

- [ ] **Step 3: Write the service**

Create `apps/api/src/fleet/schedules/schedule-progress.service.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common';
import { WebhookDispatcherService } from '../../webhook/webhook-dispatcher.service';
import { FleetActivityService } from '../activity/fleet-activity.service';
import type { FleetJobRecord } from '../jobs/domain/fleet-job.domain';
import { AutoDisableReason, IScheduleRepository, SCHEDULE_REPOSITORY, SchedulePatch, ScheduleRecord } from './domain/schedule.domain';
import { judgeEndedJob } from './schedule-progress-rules';
import { SYSTEM_ACTOR_ID, schedulePayload, scheduleWebhookPayload } from './schedule-payloads';

/**
 * S1b §3.3. Counts the end of a scheduled job against its schedule and auto-disables it. It depends only on
 * repositories, the activity log and the webhook dispatcher, never on FleetJobsService (plan D192: no DI cycle).
 * Call inside the transaction that ended the job: the activity row and the webhook outbox row commit with it.
 */
@Injectable()
export class ScheduleProgressService {
  constructor(
    @Inject(SCHEDULE_REPOSITORY) private readonly repo: IScheduleRepository,
    private readonly activity: FleetActivityService,
    private readonly webhooks: WebhookDispatcherService,
  ) {}

  /** `job` is the record after the terminal transition. */
  async onJobEnded(job: FleetJobRecord, now: Date): Promise<void> {
    if (!job.scheduleId || job.scheduleCountedAt || job.state === 'CANCELLED') return;
    if (!(await this.repo.claimCounted(job.id, now))) return;
    const schedule = await this.repo.lockById(job.scheduleId);
    if (!schedule) return;
    const verdict = judgeEndedJob(job, schedule.lastPassedCount);
    if (verdict.kind === 'progress') {
      await this.repo.update(schedule.id, { noProgressTicks: 0, lastPassedCount: verdict.passed });
      return;
    }
    // Plan D197: a schedule that is already off keeps its reason; only progress is recorded.
    if (!schedule.enabled || verdict.kind === 'ignore') return;
    if (verdict.kind === 'disable') {
      await this.disableLocked(schedule, verdict.reason, { jobId: job.id });
      return;
    }
    const ticks = schedule.noProgressTicks + 1;
    if (ticks >= schedule.noProgressLimit) await this.disableLocked(schedule, 'no_progress', { jobId: job.id }, { noProgressTicks: ticks });
    else await this.repo.update(schedule.id, { noProgressTicks: ticks });
  }

  /** Auto-disable outside a job end (the ticker: owner lost access, template invalid). False when nothing changed. */
  async disable(scheduleId: string, reason: AutoDisableReason, detail: { jobId?: string } = {}): Promise<boolean> {
    const schedule = await this.repo.lockById(scheduleId);
    if (!schedule || !schedule.enabled) return false;
    await this.disableLocked(schedule, reason, detail);
    return true;
  }

  private async disableLocked(schedule: ScheduleRecord, reason: AutoDisableReason, detail: { jobId?: string }, counters: SchedulePatch = {}): Promise<void> {
    const after = await this.repo.update(schedule.id, { ...counters, enabled: false, disabledReason: reason });
    await this.activity.record({
      actorType: 'SYSTEM', actorId: SYSTEM_ACTOR_ID, action: 'schedule.auto_disabled', entityType: 'schedule', entityId: schedule.id,
      jobId: detail.jobId ?? null, projectId: schedule.projectId, responsibleUserId: schedule.createdById,
      payload: schedulePayload(after, { reason }),
    });
    await this.webhooks.dispatch(schedule.projectId, 'fleet.schedule.disabled', scheduleWebhookPayload(after, reason));
  }
}
```

In `apps/api/src/fleet/schedules/schedule-store.module.ts` replace the module with:

```ts
import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { WebhookModule } from '../../webhook/webhook.module';
import { FleetActivityModule } from '../activity/fleet-activity.module';
import { SCHEDULE_REPOSITORY } from './domain/schedule.domain';
import { PrismaScheduleRepository } from './prisma-schedule.repository';
import { ScheduleProgressService } from './schedule-progress.service';

/** Plan D192: schedule storage and progress counting, importable by the jobs module without a cycle. */
@Module({
  imports: [PrismaModule, FleetActivityModule, WebhookModule],
  providers: [PrismaScheduleRepository, { provide: SCHEDULE_REPOSITORY, useExisting: PrismaScheduleRepository }, ScheduleProgressService],
  exports: [SCHEDULE_REPOSITORY, PrismaScheduleRepository, ScheduleProgressService],
})
export class ScheduleStoreModule {}
```

- [ ] **Step 4: Run the service spec**

Run: `cd apps/api && bun run test:scoped src/fleet/schedules/schedule-progress.service.spec.ts`
Expected: PASS (13 cases).

- [ ] **Step 5: Write the failing hook tests**

In `apps/api/src/fleet/jobs/job-transitions.service.spec.ts`, replace the line
`const svc = new JobTransitionsService(repo as never, activity as never, live as never);` with:

```ts
  const schedules = { onJobEnded: jest.fn(async () => undefined) };
  const svc = new JobTransitionsService(repo as never, activity as never, live as never, schedules as never);
```

and add these cases inside the `describe` (before its closing `});`):

```ts
  it('counts the end of a scheduled job against its schedule, in the same call (S1b §3.3)', async () => {
    const scheduledRepo = { ...repo, update: jest.fn(async () => job({ state: 'FAILED', scheduleId: 's1' })) };
    const scheduledSvc = new JobTransitionsService(scheduledRepo as never, activity as never, live as never, schedules as never);
    await scheduledSvc.apply({ job: job({ state: 'UPLOADING', scheduleId: 's1' }), to: 'FAILED', by: 'runner', now: NOW, actor: { type: 'RUNNER', id: 'run-1' } });
    expect(schedules.onJobEnded).toHaveBeenCalledWith(expect.objectContaining({ id: 'j1', state: 'FAILED', scheduleId: 's1' }), NOW);
  });

  it('does not touch the schedule for a non-terminal transition or an unscheduled job', async () => {
    const running = { ...repo, update: jest.fn(async () => job({ state: 'RUNNING', scheduleId: 's1' })) };
    await new JobTransitionsService(running as never, activity as never, live as never, schedules as never)
      .apply({ job: job({ scheduleId: 's1' }), to: 'RUNNING', by: 'runner', now: NOW, actor: { type: 'RUNNER', id: 'run-1' } });
    await svc.apply({ job: job({ state: 'UPLOADING' }), to: 'FAILED', by: 'runner', now: NOW, actor: { type: 'RUNNER', id: 'run-1' } });
    expect(schedules.onJobEnded).not.toHaveBeenCalled();
  });
```

(`afterEach(() => jest.clearAllMocks())` in that file already clears the call counts between cases.)

- [ ] **Step 6: Run to verify the hook tests fail**

Run: `cd apps/api && bun run test:scoped src/fleet/jobs/job-transitions.service.spec.ts`
Expected: FAIL (`schedules.onJobEnded` never called).

- [ ] **Step 7: Add the hook**

In `apps/api/src/fleet/jobs/job-transitions.service.ts`:

Add the import `import { ScheduleProgressService } from '../schedules/schedule-progress.service';`.

Add a fourth constructor parameter:

```ts
    private readonly schedules: ScheduleProgressService,
```

and in `apply`, replace

```ts
    const live = await this.record({ before: job, after, by, now, actor: input.actor, reason: input.reason });
    return { job: after, live };
```

with

```ts
    const live = await this.record({ before: job, after, by, now, actor: input.actor, reason: input.reason });
    // S1b §3.3: a scheduled job's end moves its schedule's counters in this same transaction.
    if (terminal && after.scheduleId) await this.schedules.onJobEnded(after, now);
    return { job: after, live };
```

`FleetJobsModule` already imports `ScheduleStoreModule` (Task 4), which now exports `ScheduleProgressService`.

- [ ] **Step 8: Run the unit specs and the module guards**

Run: `cd apps/api && bun run test:scoped src/fleet`
Expected: PASS (the jobs module and fleet module specs prove the DI graph has no cycle).

- [ ] **Step 9: Write the integration spec**

Create `apps/api/test/integration/fleet/fleet-schedule-progress.integration.spec.ts`:

```ts
/**
 * Fleet S1b slice 3a — auto-disable through the real transition path (PG): every §3.3 rule, counted once.
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-schedule-progress.integration.spec.ts
 */
import { NathApplication } from '@nathapp/nestjs-app';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '@prisma/client';
import type { FleetJobState } from '../../../src/common/enums';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { FleetHttpWorld, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { FLEET_JOB_REPOSITORY, IFleetJobRepository } from '../../../src/fleet/jobs/domain/fleet-job.domain';
import { FleetJobsService } from '../../../src/fleet/jobs/fleet-jobs.service';
import { JobTransitionsService } from '../../../src/fleet/jobs/job-transitions.service';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

jest.setTimeout(30_000);

describeIntegration('schedule auto-disable (PG)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let transitions: JobTransitionsService;
  let jobsRepo: IFleetJobRepository;
  let jobs: FleetJobsService;
  let tx: ITransactionManager;
  let n = 0;
  const NOW = new Date('2026-10-02T03:00:30.000Z');

  const schedule = (over: Partial<Prisma.JobScheduleUncheckedCreateInput> = {}) => prisma.jobSchedule.create({
    data: {
      projectId: world.projectId, repoId: world.repoId, name: `p${++n}`, cron: '0 * * * *', timezone: 'UTC', feature: `sf${n}`, ref: 'trunk',
      profiles: [], maxCostUsd: new Prisma.Decimal(5), selectorLabels: [], nextFireAt: NOW, createdById: world.ids.dev, updatedById: world.ids.dev, ...over,
    },
  });
  /** A scheduled job in UPLOADING (the state the runner ends it from), with the progress nax reported. */
  const uploading = (scheduleId: string | null, progress: Prisma.InputJsonValue | null, feature = `jf${++n}`) => prisma.fleetJob.create({
    data: {
      projectId: world.projectId, repoId: world.repoId, ref: 'trunk', command: 'RUN', feature, profiles: [], maxCostUsd: new Prisma.Decimal(5),
      selectorLabels: [], requestedById: world.ids.dev, scheduleId, state: 'UPLOADING', ...(progress === null ? {} : { progress }),
    },
  });
  const end = (jobId: string, to: FleetJobState) => tx.run(async () => {
    const job = await jobsRepo.lockById(jobId);
    if (!job) throw new Error(`no job ${jobId}`);
    return transitions.apply({ job, to, by: 'runner', now: NOW, actor: { type: 'RUNNER', id: 'r1' } });
  });
  const reload = (id: string) => prisma.jobSchedule.findUniqueOrThrow({ where: { id } });
  const hooks = () => prisma.outboxEvent.count({ where: { type: 'webhook_delivery', payload: { contains: '"event":"fleet.schedule.disabled"' } } });
  const autoDisabledRows = (id: string) => prisma.fleetActivity.count({ where: { entityType: 'schedule', entityId: id, action: 'schedule.auto_disabled' } });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(app.getHttpServer(), prisma);
    transitions = app.get(JobTransitionsService);
    jobsRepo = app.get<IFleetJobRepository>(FLEET_JOB_REPOSITORY);
    jobs = app.get(FleetJobsService);
    tx = app.get<ITransactionManager>(TRANSACTION_MANAGER);
    await prisma.webhook.create({
      data: { projectId: world.projectId, url: 'https://hooks.example.com/koda', secret: 's'.repeat(32), events: JSON.stringify(['fleet.schedule.disabled']) },
    });
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await prisma.fleetCommand.deleteMany();
    await prisma.fleetJob.deleteMany();
    await prisma.jobSchedule.deleteMany();
    await prisma.outboxEvent.deleteMany();
    await prisma.fleetActivity.deleteMany();
  });

  it('COMPLETED disables with completed, with one activity row and one webhook', async () => {
    const s = await schedule();
    const j = await uploading(s.id, { passed: 3, total: 3 });
    await end(j.id, 'COMPLETED');
    expect(await reload(s.id)).toEqual(expect.objectContaining({ enabled: false, disabledReason: 'completed' }));
    expect(await autoDisabledRows(s.id)).toBe(1);
    expect(await hooks()).toBe(1);
    expect((await prisma.fleetJob.findUniqueOrThrow({ where: { id: j.id } })).scheduleCountedAt).toEqual(NOW);
  });

  it('every story passed but the finish failed disables with finish_failed', async () => {
    const s = await schedule();
    await end((await uploading(s.id, { passed: 2, total: 2 })).id, 'FAILED');
    expect(await reload(s.id)).toEqual(expect.objectContaining({ enabled: false, disabledReason: 'finish_failed' }));
  });

  it('counts no-progress ends and disables at noProgressLimit', async () => {
    const s = await schedule({ noProgressLimit: 2 });
    await end((await uploading(s.id, { passed: 0, total: 4 })).id, 'FAILED');
    expect(await reload(s.id)).toEqual(expect.objectContaining({ enabled: true, noProgressTicks: 1 }));
    await end((await uploading(s.id, { passed: 0, total: 4 })).id, 'FAILED');
    expect(await reload(s.id)).toEqual(expect.objectContaining({ enabled: false, disabledReason: 'no_progress', noProgressTicks: 2 }));
    expect(await hooks()).toBe(1);
  });

  it('progress resets the counter and raises lastPassedCount; the same count again is no progress', async () => {
    const s = await schedule({ noProgressTicks: 2, noProgressLimit: 5 });
    await end((await uploading(s.id, { passed: 2, total: 6 })).id, 'FAILED');
    expect(await reload(s.id)).toEqual(expect.objectContaining({ noProgressTicks: 0, lastPassedCount: 2, enabled: true }));
    await end((await uploading(s.id, { passed: 2, total: 6 })).id, 'FAILED');
    expect(await reload(s.id)).toEqual(expect.objectContaining({ noProgressTicks: 1, lastPassedCount: 2 }));
    await end((await uploading(s.id, { passed: 3, total: 6 })).id, 'FAILED');
    expect(await reload(s.id)).toEqual(expect.objectContaining({ noProgressTicks: 0, lastPassedCount: 3 }));
  });

  it.each([
    ['null progress', null],
    ['a string', 'garbage'],
    ['a negative passed', { passed: -1, total: 3 }],
    ['a fractional passed', { passed: 1.5, total: 3 }],
    ['total 0', { passed: 0, total: 0 }],
  ])('garbled progress (%s) counts as no progress and does not throw', async (_name, progress) => {
    const s = await schedule();
    await expect(end((await uploading(s.id, progress as Prisma.InputJsonValue | null)).id, 'FAILED')).resolves.toBeDefined();
    expect(await reload(s.id)).toEqual(expect.objectContaining({ enabled: true, noProgressTicks: 1, lastPassedCount: 0 }));
  });

  it('CANCELLED changes neither counter and is not marked counted (plan D195)', async () => {
    const s = await schedule({ noProgressTicks: 1 });
    const j = await uploading(s.id, { passed: 0, total: 3 });
    await end(j.id, 'CANCELLED');
    expect(await reload(s.id)).toEqual(expect.objectContaining({ enabled: true, noProgressTicks: 1 }));
    expect((await prisma.fleetJob.findUniqueOrThrow({ where: { id: j.id } })).scheduleCountedAt).toBeNull();
  });

  it('a requeued scheduled job that ends again is counted once (plan D196)', async () => {
    const s = await schedule({ noProgressLimit: 5 });
    const j = await uploading(s.id, { passed: 0, total: 3 });
    await end(j.id, 'FAILED');
    expect((await reload(s.id)).noProgressTicks).toBe(1);
    await jobs.requeue(world.ids.dev, world.projectId, j.id);
    await prisma.fleetJob.update({ where: { id: j.id }, data: { state: 'UPLOADING' } });
    await end(j.id, 'FAILED');
    expect((await reload(s.id)).noProgressTicks).toBe(1);
  });

  it('a manually disabled schedule keeps its reason when its job later completes, and sends no webhook (plan D197)', async () => {
    const s = await schedule({ enabled: false, disabledReason: 'manual' });
    await end((await uploading(s.id, { passed: 3, total: 3 })).id, 'COMPLETED');
    expect(await reload(s.id)).toEqual(expect.objectContaining({ enabled: false, disabledReason: 'manual' }));
    expect(await hooks()).toBe(0);
    expect(await autoDisabledRows(s.id)).toBe(0);
  });

  it('a job whose schedule was deleted just ends', async () => {
    const s = await schedule();
    const j = await uploading(s.id, { passed: 1, total: 3 });
    await prisma.jobSchedule.delete({ where: { id: s.id } });
    await expect(end(j.id, 'FAILED')).resolves.toBeDefined();
    expect((await prisma.fleetJob.findUniqueOrThrow({ where: { id: j.id } })).state).toBe('FAILED');
  });

  it('an unscheduled job is untouched', async () => {
    const s = await schedule();
    const j = await uploading(null, { passed: 3, total: 3 });
    await end(j.id, 'COMPLETED');
    expect(await reload(s.id)).toEqual(expect.objectContaining({ enabled: true, noProgressTicks: 0 }));
  });
});
```

- [ ] **Step 10: Run the integration spec**

Run: `cd apps/api && bun run test:scoped test/integration/fleet/fleet-schedule-progress.integration.spec.ts`
Expected: PASS (14 cases). If a whole file fails in under a millisecond with only a `loginToken` frame in the stack,
it is the known local login-throttle cascade (5/min), not this slice: wait a minute and rerun that file alone.

- [ ] **Step 11: Commit**

```bash
git add apps/api/src/fleet apps/api/test/integration/fleet/fleet-schedule-progress.integration.spec.ts
git commit -m "feat(fleet): auto-disable schedules from the job transition path"
```

---

### Task 6: Dispatch carries the schedule; the job API shows it

**Files:**
- Modify: `apps/api/src/fleet/jobs/fleet-jobs.service.ts` (`dispatch`)
- Modify: `apps/api/src/fleet/jobs/domain/fleet-job.domain.ts` (`FleetJobFilters`)
- Modify: `apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts` (`findPage`)
- Modify: `apps/api/src/fleet/jobs/dto/fleet-job.dto.ts`, `apps/api/src/fleet/jobs/dto/fleet-job.dto.spec.ts`
- Modify: `apps/api/src/fleet/jobs/dto/list-fleet-jobs.query.ts`, `apps/api/src/fleet/jobs/fleet-jobs.controller.ts`
- Test: `apps/api/test/integration/fleet/fleet-jobs-schedule-link.integration.spec.ts`

**Interfaces:**
- Consumes: `FleetJobRecord.scheduleId`, `.coalescedCount` (Task 1); `toDispatchDto` (Task 3).
- Produces: `FleetJobsService.dispatch(actorId: string, projectId: string, dto: DispatchFleetJobDto, opts?: { scheduleId?: string }): Promise<DispatchResultDto>`;
  `FleetJobFilters.scheduleId?: string`; `FleetJobDto.scheduleId: string | null`, `.coalescedCount: number`;
  `GET /projects/:slug/fleet/jobs?scheduleId=`.

- [ ] **Step 1: Write the failing integration spec**

Create `apps/api/test/integration/fleet/fleet-jobs-schedule-link.integration.spec.ts`:

```ts
/**
 * Fleet S1b slice 3a — dispatch with a scheduleId, and the job list filter (PG).
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-jobs-schedule-link.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { FleetHttpWorld, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { FleetJobsService } from '../../../src/fleet/jobs/fleet-jobs.service';
import { toDispatchDto } from '../../../src/fleet/schedules/schedule-template';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

jest.setTimeout(30_000);

interface JobRow { id: string; scheduleId: string | null; coalescedCount: number }

describeIntegration('fleet jobs schedule link (PG)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  const template = (feature: string) => toDispatchDto({
    repoId: world.repoId, feature, ref: 'trunk', profiles: [], maxCostUsd: '5', selectorLabels: [], pinnedRunnerId: null,
  });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(app.getHttpServer(), prisma);
  });
  afterAll(async () => {
    await app.close();
  });

  it('links the job to the schedule, notes it in the dispatch activity, and the list filters on it', async () => {
    const schedule = await prisma.jobSchedule.create({
      data: {
        projectId: world.projectId, repoId: world.repoId, name: 'link', cron: '0 * * * *', timezone: 'UTC', feature: 'linked', ref: 'trunk',
        profiles: [], maxCostUsd: new Prisma.Decimal(5), selectorLabels: [], nextFireAt: new Date(), createdById: world.ids.dev, updatedById: world.ids.dev,
      },
    });
    const jobs = app.get(FleetJobsService);
    const scheduled = await jobs.dispatch(world.ids.dev, world.projectId, template('linked'), { scheduleId: schedule.id });
    const manual = await jobs.dispatch(world.ids.dev, world.projectId, template('manual'));

    expect(scheduled.job).toEqual(expect.objectContaining({ scheduleId: schedule.id, coalescedCount: 0 }));
    expect(manual.job.scheduleId).toBeNull();
    const row = await prisma.fleetActivity.findFirstOrThrow({ where: { action: 'job.dispatched', jobId: scheduled.job.id } });
    expect(row.payload).toEqual(expect.objectContaining({ scheduleId: schedule.id, feature: 'linked' }));

    const server = app.getHttpServer();
    const auth = { Authorization: `Bearer ${world.tokens.dev}` };
    const page = data<{ records: JobRow[] }>(await request(server).get(`/api/projects/web/fleet/jobs?scheduleId=${schedule.id}`).set(auth).expect(200));
    expect(page.records.map((r) => r.id)).toEqual([scheduled.job.id]);
    expect(page.records[0]).toEqual(expect.objectContaining({ scheduleId: schedule.id, coalescedCount: 0 }));
    const none = data<{ records: JobRow[] }>(await request(server).get('/api/projects/web/fleet/jobs?scheduleId=nope').set(auth).expect(200));
    expect(none.records).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && bun run test:scoped test/integration/fleet/fleet-jobs-schedule-link.integration.spec.ts`
Expected: FAIL at compile time (`dispatch` takes 3 arguments; `scheduleId` is not on `FleetJobDto`).

- [ ] **Step 3: Pass the schedule through `dispatch`**

In `apps/api/src/fleet/jobs/fleet-jobs.service.ts`, replace the `dispatch` signature line

```ts
  async dispatch(actorId: string, projectId: string, dto: DispatchFleetJobDto): Promise<DispatchResultDto> {
```

with

```ts
  async dispatch(actorId: string, projectId: string, dto: DispatchFleetJobDto, opts: { scheduleId?: string } = {}): Promise<DispatchResultDto> {
```

Inside it, replace

```ts
        const created = await this.repo.createJob({ ...input, projectId, requestedById: actorId });
```

with

```ts
        const created = await this.repo.createJob({
          ...input, projectId, requestedById: actorId, ...(opts.scheduleId ? { scheduleId: opts.scheduleId } : {}),
        });
```

and replace the line

```ts
          projectId, responsibleUserId: actorId, payload: { repoId: repo.id, feature: created.feature, command: created.command, ref: created.ref },
```

with

```ts
          projectId, responsibleUserId: actorId,
          payload: { repoId: repo.id, feature: created.feature, command: created.command, ref: created.ref, ...(opts.scheduleId ? { scheduleId: opts.scheduleId } : {}) },
```

- [ ] **Step 4: Add the filter**

In `fleet-job.domain.ts`, `FleetJobFilters` gains `scheduleId?: string;` (after `feature?: string;`).

In `prisma-fleet-job.repository.ts` `findPage`, add to the `where` object after the `feature` line:

```ts
      ...(f.scheduleId ? { scheduleId: f.scheduleId } : {}),
```

In `list-fleet-jobs.query.ts` add (and extend nothing else):

```ts
  @ApiPropertyOptional({ description: 'Only jobs dispatched by this schedule (S1b §3.4)' }) @IsOptional() @IsString() @MaxLength(64) scheduleId?: string;
```

In `fleet-jobs.controller.ts` `list`, destructure and pass `scheduleId`:

```ts
    const { current, size, state, repoId, runnerId, requestedById, feature, scheduleId } = parseQuery(ListFleetJobsQuery, rawQuery);
    return JsonResponse.Ok(toPageResult(await this.jobs.list({ projectId: ctx.project.id, state, repoId, runnerId, requestedById, feature, scheduleId }, { current, size })));
```

- [ ] **Step 5: Add the DTO fields**

In `fleet-job.dto.ts`, in `FleetJobDto` after the `storiesTruncated` property add:

```ts
  @ApiPropertyOptional({ type: String, nullable: true, description: 'The schedule that dispatched the job (S1b §3.1)' }) declare scheduleId: string | null;
  @ApiProperty({ description: 'Schedule ticks absorbed into this job while it sat queued (S1b §3.2)' }) declare coalescedCount: number;
```

and in `from`, after `stories: r.stories, storiesTruncated: r.storiesTruncated,` add
`scheduleId: r.scheduleId, coalescedCount: r.coalescedCount,`.

In `fleet-job.dto.spec.ts`, first test: change that record's `scheduleId: null, coalescedCount: 0` (added in Task 1)
to `scheduleId: 's1', coalescedCount: 2`, add
`expect(json).toEqual(expect.objectContaining({ scheduleId: 's1', coalescedCount: 2 }));` after the `wipPush`
assertion, and add `'scheduleCountedAt'` to the `for (const hidden of [...])` list.

- [ ] **Step 6: Run the specs**

Run: `cd apps/api && bun run type-check && bun run test:scoped src/fleet test/integration/fleet/fleet-jobs-schedule-link.integration.spec.ts test/integration/fleet/fleet-jobs.integration.spec.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/fleet apps/api/test/integration/fleet/fleet-jobs-schedule-link.integration.spec.ts
git commit -m "feat(fleet): dispatch carries a schedule id; job DTO and list expose it"
```

---

### Task 7: `ScheduleTicker`

**Files:**
- Create: `apps/api/src/fleet/schedules/schedule-access.ts`
- Create: `apps/api/src/fleet/schedules/schedule-ticker.ts`
- Test: `apps/api/src/fleet/schedules/schedule-ticker.spec.ts`
- Test: `apps/api/test/integration/fleet/fleet-schedule-ticker.integration.spec.ts`

**Interfaces:**
- Consumes: `IScheduleRepository` (`findDue`, `claimFire`, `findActiveJob`, `coalesceIntoQueued`, `findOwnerAccess`,
  `update`), `ScheduleProgressService.disable`, `FleetJobsService.dispatch` (Task 6), `nextFireAfter` (Task 2),
  `toDispatchDto` (Task 3), `BudgetPausedException`, `FleetDispatchException`, `ConflictAppException`.
- Produces: `mayDispatch(access: OwnerAccess): boolean`;
  `ScheduleTicker` with `tick(now?: Date): Promise<TickResult>`, `runOnce(now?: Date): Promise<TickResult | null>`
  (null when a tick is still running), `onModuleInit`, `onModuleDestroy`;
  `TickResult = { claimed, dispatched, coalesced, skipped, disabled, failed: number }`.
  Not yet registered in a module (Task 8 does).

- [ ] **Step 1: Write the failing unit spec**

Create `apps/api/src/fleet/schedules/schedule-ticker.spec.ts`:

```ts
import { NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import { BudgetPausedException } from '../budgets/budget.exceptions';
import { FleetDispatchException } from '../jobs/fleet-dispatch.exception';
import type { OwnerAccess, ScheduleActiveJob, ScheduleRecord } from './domain/schedule.domain';
import { mayDispatch } from './schedule-access';
import { ScheduleTicker } from './schedule-ticker';

const NOW = new Date('2026-10-02T03:00:30.000Z');
const DUE = new Date('2026-10-02T03:00:00.000Z');
const NEXT = new Date('2026-10-02T04:00:00.000Z');
const OWNER_OK: OwnerAccess = { exists: true, disabled: false, globalRole: 'MEMBER', projectRole: 'DEVELOPER' };

const schedule = (over: Partial<ScheduleRecord> = {}): ScheduleRecord => ({
  id: 's1', projectId: 'p1', repoId: 'r1', name: 'nightly', cron: '0 * * * *', timezone: 'UTC', feature: 'login', ref: 'main', profiles: ['fast'],
  maxCostUsd: '5', selectorLabels: [], pinnedRunnerId: null, enabled: true, nextFireAt: DUE, lastFiredAt: null, lastJobId: null,
  lastPassedCount: 0, noProgressTicks: 0, noProgressLimit: 3, disabledReason: null, createdById: 'u1', updatedById: 'u1',
  createdAt: NOW, updatedAt: NOW, ...over,
});

function build(due: ScheduleRecord[] = [schedule()]) {
  const repo = {
    findDue: jest.fn(async () => due),
    claimFire: jest.fn(async () => true),
    findActiveJob: jest.fn(async (): Promise<ScheduleActiveJob | null> => null),
    coalesceIntoQueued: jest.fn(async (): Promise<string | null> => null),
    findOwnerAccess: jest.fn(async () => OWNER_OK),
    update: jest.fn(async () => schedule()),
  };
  const jobs = { dispatch: jest.fn(async () => ({ job: { id: 'job-1' } })) };
  const progress = { disable: jest.fn(async () => true) };
  const activity = { record: jest.fn(async () => undefined) };
  const txManager = { run: jest.fn(async <T>(fn: () => Promise<T>) => fn()) };
  const ticker = new ScheduleTicker(repo as never, jobs as never, progress as never, activity as never, txManager as never, { sweepEnabled: false });
  const actions = () => activity.record.mock.calls.map((c) => (c as unknown as [{ action: string; payload: Record<string, unknown> }])[0]);
  return { repo, jobs, progress, activity, ticker, actions };
}

describe('ScheduleTicker.tick', () => {
  it('dispatches a due schedule as its owner with the schedule id, then records lastJobId and an activity row', async () => {
    const h = build();
    expect(await h.ticker.tick(NOW)).toEqual({ claimed: 1, dispatched: 1, coalesced: 0, skipped: 0, disabled: 0, failed: 0 });
    expect(h.repo.claimFire).toHaveBeenCalledWith('s1', DUE, NEXT, NOW);
    expect(h.jobs.dispatch).toHaveBeenCalledWith(
      'u1', 'p1', { repoId: 'r1', command: 'RUN', feature: 'login', ref: 'main', profiles: ['fast'], maxCostUsd: 5, selectorLabels: [] }, { scheduleId: 's1' },
    );
    expect(h.repo.update).toHaveBeenCalledWith('s1', { lastJobId: 'job-1' });
    expect(h.actions().map((a) => a.action)).toEqual(['schedule.tick_dispatched']);
  });

  it('collapses missed fires: one claim straight to the next fire after now, one dispatch', async () => {
    const h = build([schedule({ nextFireAt: new Date('2026-09-29T03:00:00.000Z') })]);
    await h.ticker.tick(NOW);
    expect(h.repo.claimFire).toHaveBeenCalledTimes(1);
    expect(h.repo.claimFire).toHaveBeenCalledWith('s1', new Date('2026-09-29T03:00:00.000Z'), NEXT, NOW);
    expect(h.jobs.dispatch).toHaveBeenCalledTimes(1);
  });

  it('does nothing when another tick won the claim', async () => {
    const h = build();
    h.repo.claimFire.mockResolvedValue(false);
    expect(await h.ticker.tick(NOW)).toEqual({ claimed: 0, dispatched: 0, coalesced: 0, skipped: 0, disabled: 0, failed: 0 });
    expect(h.jobs.dispatch).not.toHaveBeenCalled();
    expect(h.activity.record).not.toHaveBeenCalled();
  });

  it('coalesces into the schedule\'s QUEUED job and creates no job', async () => {
    const h = build();
    h.repo.findActiveJob.mockResolvedValue({ id: 'j9', state: 'QUEUED' });
    h.repo.coalesceIntoQueued.mockResolvedValue('j9');
    expect((await h.ticker.tick(NOW)).coalesced).toBe(1);
    expect(h.jobs.dispatch).not.toHaveBeenCalled();
    expect(h.actions()).toEqual([expect.objectContaining({ action: 'schedule.tick_coalesced' })]);
  });

  it('decides again when the QUEUED job left QUEUED between the read and the increment (plan D200)', async () => {
    const h = build();
    h.repo.findActiveJob.mockResolvedValueOnce({ id: 'j9', state: 'QUEUED' }).mockResolvedValueOnce(null);
    h.repo.coalesceIntoQueued.mockResolvedValueOnce(null);
    expect((await h.ticker.tick(NOW)).dispatched).toBe(1);
  });

  it('gives up after three rounds of that and records a skip', async () => {
    const h = build();
    h.repo.findActiveJob.mockResolvedValue({ id: 'j9', state: 'QUEUED' });
    expect((await h.ticker.tick(NOW)).skipped).toBe(1);
    expect(h.repo.coalesceIntoQueued).toHaveBeenCalledTimes(3);
    expect(h.actions()[0].payload).toEqual(expect.objectContaining({ reason: 'busy' }));
  });

  it.each(['ASSIGNED', 'RUNNING', 'UPLOADING'] as const)('skips while the schedule has a %s job', async (state) => {
    const h = build();
    h.repo.findActiveJob.mockResolvedValue({ id: 'j7', state });
    expect((await h.ticker.tick(NOW)).skipped).toBe(1);
    expect(h.jobs.dispatch).not.toHaveBeenCalled();
    expect(h.actions()).toEqual([expect.objectContaining({ action: 'schedule.tick_skipped', payload: expect.objectContaining({ reason: 'job_active', state }) })]);
  });

  it.each<[string, OwnerAccess]>([
    ['a user that no longer exists', { exists: false, disabled: false, globalRole: '', projectRole: null }],
    ['a disabled user', { ...OWNER_OK, disabled: true }],
    ['a user removed from the project', { ...OWNER_OK, projectRole: null }],
    ['a user demoted to VIEWER', { ...OWNER_OK, projectRole: 'VIEWER' }],
    ['a legacy AGENT member', { ...OWNER_OK, projectRole: 'AGENT' }],
  ])('disables with owner_lost_access for %s', async (_name, access) => {
    const h = build();
    h.repo.findOwnerAccess.mockResolvedValue(access);
    expect((await h.ticker.tick(NOW)).disabled).toBe(1);
    expect(h.progress.disable).toHaveBeenCalledWith('s1', 'owner_lost_access');
    expect(h.jobs.dispatch).not.toHaveBeenCalled();
  });

  it.each<[string, OwnerAccess]>([
    ['a project DEVELOPER', OWNER_OK],
    ['a project ADMIN', { ...OWNER_OK, projectRole: 'ADMIN' }],
    ['a global ADMIN with no project role', { ...OWNER_OK, globalRole: 'ADMIN', projectRole: null }],
  ])('dispatches for %s', async (_name, access) => {
    expect(mayDispatch(access)).toBe(true);
  });

  const budgetPolicy = { id: 'b1', scopeType: 'global' as const, scopeId: null, scopeKey: 'global' };
  it.each<[string, () => Error, 'skipped' | 'disabled']>([
    ['409 budget paused', () => new BudgetPausedException(budgetPolicy), 'skipped'],
    ['409 active job of the feature (a manual job)', () => new ConflictAppException({ activeJobId: 'm1' }, 'fleet.jobs'), 'skipped'],
    ['404 repo', () => new NotFoundAppException({}, 'fleet.repos'), 'disabled'],
    ['404 pinned runner', () => new NotFoundAppException({}, 'fleet.runners'), 'disabled'],
    ['422 pinned runner can never run it', () => new FleetDispatchException('labels'), 'disabled'],
    ['400 validation', () => new ValidationAppException({ reason: 'ref' }, 'fleet.dispatchInput'), 'disabled'],
    ['any other error', () => new Error('db down'), 'skipped'],
  ])('dispatch outcome: %s', async (_name, error, outcome) => {
    const h = build();
    h.jobs.dispatch.mockRejectedValue(error());
    const result = await h.ticker.tick(NOW);
    expect(result[outcome]).toBe(1);
    if (outcome === 'disabled') expect(h.progress.disable).toHaveBeenCalledWith('s1', 'template_invalid');
    else expect(h.progress.disable).not.toHaveBeenCalled();
    expect(h.repo.update).not.toHaveBeenCalled();
  });

  it('records why a budget skip and a manual-job skip happened', async () => {
    const budget = build();
    budget.jobs.dispatch.mockRejectedValue(new BudgetPausedException(budgetPolicy));
    await budget.ticker.tick(NOW);
    expect(budget.actions()[0].payload).toEqual(expect.objectContaining({ reason: 'budget_paused' }));
    const manual = build();
    manual.jobs.dispatch.mockRejectedValue(new ConflictAppException({ activeJobId: 'm1' }, 'fleet.jobs'));
    await manual.ticker.tick(NOW);
    expect(manual.actions()[0].payload).toEqual(expect.objectContaining({ reason: 'active_job_elsewhere' }));
  });

  it('disables a schedule whose stored cron no longer parses instead of failing every minute (plan D208)', async () => {
    const h = build([schedule({ cron: 'not a cron' })]);
    expect((await h.ticker.tick(NOW)).disabled).toBe(1);
    expect(h.repo.claimFire).not.toHaveBeenCalled();
    expect(h.progress.disable).toHaveBeenCalledWith('s1', 'template_invalid');
  });

  it('keeps going after one schedule fails', async () => {
    const h = build([schedule({ id: 'a' }), schedule({ id: 'b' })]);
    h.repo.claimFire.mockRejectedValueOnce(new Error('boom'));
    expect(await h.ticker.tick(NOW)).toEqual(expect.objectContaining({ failed: 1, dispatched: 1 }));
    expect(h.jobs.dispatch).toHaveBeenCalledTimes(1);
  });
});

describe('ScheduleTicker timer', () => {
  it('does not re-enter: a tick still running makes the next round a no-op', async () => {
    const h = build();
    let finish: (rows: ScheduleRecord[]) => void = () => undefined;
    h.repo.findDue.mockImplementationOnce(() => new Promise<ScheduleRecord[]>((resolve) => { finish = resolve; }));
    const first = h.ticker.runOnce(NOW);
    expect(await h.ticker.runOnce(NOW)).toBeNull();
    finish([]);
    expect(await first).toEqual({ claimed: 0, dispatched: 0, coalesced: 0, skipped: 0, disabled: 0, failed: 0 });
    expect(await h.ticker.runOnce(NOW)).not.toBeNull();
  });

  it('starts no timer when the sweep is disabled', () => {
    const spy = jest.spyOn(global, 'setInterval');
    build().ticker.onModuleInit();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && bun run test:scoped src/fleet/schedules/schedule-ticker.spec.ts`
Expected: FAIL (`Cannot find module './schedule-access'`).

- [ ] **Step 3: Write the owner-access rule**

Create `apps/api/src/fleet/schedules/schedule-access.ts`:

```ts
import type { OwnerAccess } from './domain/schedule.domain';

/**
 * S1b §3.2, plan D201: the owner may still dispatch when the user exists, is not disabled, and is a global ADMIN
 * or holds project role ADMIN or DEVELOPER (the roles that hold CASL CREATE on FleetJob).
 */
export function mayDispatch(access: OwnerAccess): boolean {
  if (!access.exists || access.disabled) return false;
  return access.globalRole === 'ADMIN' || access.projectRole === 'ADMIN' || access.projectRole === 'DEVELOPER';
}
```

- [ ] **Step 4: Write the ticker**

Create `apps/api/src/fleet/schedules/schedule-ticker.ts`:

```ts
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import { FLEET_CFG, IFleetConfig } from '../../config/fleet.config';
import { FleetActivityService } from '../activity/fleet-activity.service';
import { BudgetPausedException } from '../budgets/budget.exceptions';
import { FleetDispatchException } from '../jobs/fleet-dispatch.exception';
import { FleetJobsService } from '../jobs/fleet-jobs.service';
import { nextFireAfter } from './cron-schedule';
import { AutoDisableReason, IScheduleRepository, SCHEDULE_REPOSITORY, ScheduleRecord } from './domain/schedule.domain';
import { mayDispatch } from './schedule-access';
import { SYSTEM_ACTOR_ID, schedulePayload } from './schedule-payloads';
import { ScheduleProgressService } from './schedule-progress.service';
import { toDispatchDto } from './schedule-template';

const TICK_INTERVAL_MS = 60_000;
/** Plan D207: a tick handles at most this many due schedules; the rest wait one more minute. */
const MAX_DUE_PER_TICK = 100;
/** Plan D200: rounds of "read the active job, try to coalesce" before giving up. */
const MAX_COALESCE_ROUNDS = 3;

export interface TickResult {
  /** Schedules this tick claimed and acted on: dispatched + coalesced + skipped + disabled. */
  claimed: number;
  dispatched: number;
  coalesced: number;
  skipped: number;
  disabled: number;
  failed: number;
}

type Outcome = 'lost' | 'dispatched' | 'coalesced' | 'skipped' | 'disabled' | 'failed';

const tally = (outcomes: readonly Outcome[]): TickResult => {
  const n = (o: Outcome): number => outcomes.filter((x) => x === o).length;
  const [dispatched, coalesced, skipped, disabled] = [n('dispatched'), n('coalesced'), n('skipped'), n('disabled')];
  return { claimed: dispatched + coalesced + skipped + disabled, dispatched, coalesced, skipped, disabled, failed: n('failed') };
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * S1b §3.2. Every 60 s: load the due schedules, claim each by compare-and-set on `nextFireAt`, then coalesce into
 * its QUEUED job, skip while it runs, or dispatch RUN as the owner. In process: the API is single-instance and
 * there is no distributed lock; the claim is what keeps two overlapping ticks from firing twice (plan D198).
 */
@Injectable()
export class ScheduleTicker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ScheduleTicker.name);
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(
    @Inject(SCHEDULE_REPOSITORY) private readonly repo: IScheduleRepository,
    private readonly jobs: FleetJobsService,
    private readonly progress: ScheduleProgressService,
    private readonly activity: FleetActivityService,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
    @Inject(FLEET_CFG) private readonly fleetConfig: Pick<IFleetConfig, 'sweepEnabled'>,
  ) {}

  onModuleInit(): void {
    if (!this.fleetConfig.sweepEnabled) return;
    this.timer = setInterval(() => {
      this.runOnce().catch((error: unknown) => this.logger.error(`Schedule tick failed: ${messageOf(error)}`));
    }, TICK_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One timer round; null when the previous round is still running (plan D198). */
  async runOnce(now = new Date()): Promise<TickResult | null> {
    if (this.ticking) return null;
    this.ticking = true;
    try {
      return await this.tick(now);
    } finally {
      this.ticking = false;
    }
  }

  async tick(now = new Date()): Promise<TickResult> {
    const outcomes: Outcome[] = [];
    for (const due of await this.repo.findDue(now, MAX_DUE_PER_TICK)) outcomes.push(await this.fireDue(due, now));
    return tally(outcomes);
  }

  /** One failing schedule is logged and skipped; the rest still run. */
  private async fireDue(due: ScheduleRecord, now: Date): Promise<Outcome> {
    try {
      let next: Date;
      try {
        next = nextFireAfter(due.cron, due.timezone, now);
      } catch (error) {
        await this.disable(due, 'template_invalid', `cron does not parse: ${messageOf(error)}`);
        return 'disabled';
      }
      if (!(await this.repo.claimFire(due.id, due.nextFireAt, next, now))) return 'lost';
      return await this.fire(due);
    } catch (error) {
      this.logger.error(`Schedule ${due.id} failed: ${messageOf(error)}`);
      return 'failed';
    }
  }

  private async fire(s: ScheduleRecord): Promise<Outcome> {
    for (let round = 0; round < MAX_COALESCE_ROUNDS; round += 1) {
      const active = await this.repo.findActiveJob(s.id);
      if (!active) return this.dispatchFresh(s);
      if (active.state !== 'QUEUED') {
        await this.record(s, 'schedule.tick_skipped', { reason: 'job_active', jobId: active.id, state: active.state });
        return 'skipped';
      }
      const absorbed = await this.repo.coalesceIntoQueued(s.id);
      if (absorbed) {
        await this.record(s, 'schedule.tick_coalesced', { jobId: absorbed });
        return 'coalesced';
      }
    }
    await this.record(s, 'schedule.tick_skipped', { reason: 'busy' });
    return 'skipped';
  }

  private async dispatchFresh(s: ScheduleRecord): Promise<Outcome> {
    if (!mayDispatch(await this.repo.findOwnerAccess(s.projectId, s.createdById))) {
      await this.disable(s, 'owner_lost_access');
      return 'disabled';
    }
    let jobId: string;
    try {
      // No transaction is open here (plan D198): a 409 from the (repoId, feature) index must not poison one.
      jobId = (await this.jobs.dispatch(s.createdById, s.projectId, toDispatchDto(s), { scheduleId: s.id })).job.id;
    } catch (error) {
      return this.onDispatchError(s, error);
    }
    await this.txManager.run(async () => {
      await this.repo.update(s.id, { lastJobId: jobId });
      await this.record(s, 'schedule.tick_dispatched', { jobId });
    });
    return 'dispatched';
  }

  /** Plan D199: most specific first; BudgetPausedException is a ConflictAppException. */
  private async onDispatchError(s: ScheduleRecord, error: unknown): Promise<Outcome> {
    if (error instanceof BudgetPausedException) {
      await this.record(s, 'schedule.tick_skipped', { reason: 'budget_paused' });
      return 'skipped';
    }
    if (error instanceof ConflictAppException) {
      await this.record(s, 'schedule.tick_skipped', { reason: 'active_job_elsewhere' });
      return 'skipped';
    }
    if (error instanceof NotFoundAppException || error instanceof FleetDispatchException || error instanceof ValidationAppException) {
      await this.disable(s, 'template_invalid', error.constructor.name);
      return 'disabled';
    }
    this.logger.error(`Schedule ${s.id} dispatch failed: ${messageOf(error)}`);
    await this.record(s, 'schedule.tick_skipped', { reason: 'error' });
    return 'skipped';
  }

  private async disable(s: ScheduleRecord, reason: AutoDisableReason, detail?: string): Promise<void> {
    await this.txManager.run(() => this.progress.disable(s.id, reason));
    if (detail) this.logger.warn(`Schedule ${s.id} disabled (${reason}): ${detail}`);
  }

  private record(s: ScheduleRecord, action: string, extra: Record<string, unknown>): Promise<void> {
    return this.activity.record({
      actorType: 'SYSTEM', actorId: SYSTEM_ACTOR_ID, action, entityType: 'schedule', entityId: s.id,
      jobId: typeof extra['jobId'] === 'string' ? extra['jobId'] : null, projectId: s.projectId, responsibleUserId: s.createdById,
      payload: schedulePayload(s, extra),
    });
  }
}
```

- [ ] **Step 5: Run the unit spec**

Run: `cd apps/api && bun run test:scoped src/fleet/schedules/schedule-ticker.spec.ts`
Expected: PASS (all cases).

- [ ] **Step 6: Write the integration spec**

Create `apps/api/test/integration/fleet/fleet-schedule-ticker.integration.spec.ts`:

```ts
/**
 * Fleet S1b slice 3a — ScheduleTicker on PG with a fixed clock: the claim, coalescing, skips and the disable paths.
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-schedule-ticker.integration.spec.ts
 */
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { FleetHttpWorld, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { ScheduleTicker } from '../../../src/fleet/schedules/schedule-ticker';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

jest.setTimeout(30_000);

describeIntegration('schedule ticker (PG)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let ticker: ScheduleTicker;
  let n = 0;
  const NOW = new Date('2026-10-02T03:00:30.000Z');
  const DUE = new Date('2026-10-02T03:00:00.000Z');
  const NEXT = new Date('2026-10-02T04:00:00.000Z');

  const schedule = (over: Partial<Prisma.JobScheduleUncheckedCreateInput> = {}) => prisma.jobSchedule.create({
    data: {
      projectId: world.projectId, repoId: world.repoId, name: `t${++n}`, cron: '0 * * * *', timezone: 'UTC', feature: `tf${n}`, ref: 'trunk',
      profiles: [], maxCostUsd: new Prisma.Decimal(5), selectorLabels: [], nextFireAt: DUE, createdById: world.ids.dev, updatedById: world.ids.dev, ...over,
    },
  });
  /** A fresh owner with the given project role (null = not a member). */
  const owner = async (role: string | null, over: Partial<Prisma.UserUncheckedCreateInput> = {}): Promise<string> => {
    const user = await prisma.user.create({ data: { email: `owner${++n}@koda.test`, passwordHash: 'x', role: 'MEMBER', ...over } });
    if (role) await prisma.projectMember.create({ data: { projectId: world.projectId, userId: user.id, role } });
    return user.id;
  };
  const reload = (id: string) => prisma.jobSchedule.findUniqueOrThrow({ where: { id } });
  const jobsOf = (scheduleId: string) => prisma.fleetJob.findMany({ where: { scheduleId } });
  const skipReasons = async (id: string) => (await prisma.fleetActivity.findMany({ where: { entityId: id, action: 'schedule.tick_skipped' } }))
    .map((r) => (r.payload as { reason: string }).reason);
  const hooks = () => prisma.outboxEvent.count({ where: { type: 'webhook_delivery', payload: { contains: '"event":"fleet.schedule.disabled"' } } });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(app.getHttpServer(), prisma);
    ticker = app.get(ScheduleTicker);
    await prisma.webhook.create({
      data: { projectId: world.projectId, url: 'https://hooks.example.com/koda', secret: 's'.repeat(32), events: JSON.stringify(['fleet.schedule.disabled']) },
    });
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await prisma.budgetPolicy.deleteMany();
    await prisma.fleetCommand.deleteMany();
    await prisma.fleetJob.deleteMany();
    await prisma.jobSchedule.deleteMany();
    await prisma.outboxEvent.deleteMany();
    await prisma.fleetActivity.deleteMany();
  });

  it('dispatches a due schedule once: a QUEUED RUN linked to it, lastJobId set, nextFireAt moved to the next fire', async () => {
    const s = await schedule();
    expect(await ticker.tick(NOW)).toEqual(expect.objectContaining({ claimed: 1, dispatched: 1 }));
    const [job] = await jobsOf(s.id);
    expect(job).toEqual(expect.objectContaining({ command: 'RUN', feature: s.feature, ref: 'trunk', state: 'QUEUED', requestedById: world.ids.dev }));
    expect(await reload(s.id)).toEqual(expect.objectContaining({ lastJobId: job.id, nextFireAt: NEXT, lastFiredAt: NOW, enabled: true }));
    expect(await ticker.tick(NOW)).toEqual(expect.objectContaining({ claimed: 0 }));
  });

  it('two concurrent ticks create exactly one job', async () => {
    const s = await schedule();
    const [a, b] = await Promise.all([ticker.tick(NOW), ticker.tick(NOW)]);
    expect(a.claimed + b.claimed).toBe(1);
    expect(await jobsOf(s.id)).toHaveLength(1);
  });

  it('collapses fires missed while the API was down into one job and a future nextFireAt', async () => {
    const s = await schedule({ nextFireAt: new Date('2026-09-29T03:00:00.000Z') });
    await ticker.tick(NOW);
    expect(await jobsOf(s.id)).toHaveLength(1);
    expect((await reload(s.id)).nextFireAt).toEqual(NEXT);
  });

  it('coalesces the next tick into the still-QUEUED job', async () => {
    const s = await schedule();
    await ticker.tick(NOW);
    await prisma.jobSchedule.update({ where: { id: s.id }, data: { nextFireAt: NEXT } });
    expect(await ticker.tick(new Date('2026-10-02T04:00:30.000Z'))).toEqual(expect.objectContaining({ coalesced: 1, dispatched: 0 }));
    const jobs = await jobsOf(s.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toEqual(expect.objectContaining({ state: 'QUEUED', coalescedCount: 1 }));
    expect(await prisma.fleetActivity.count({ where: { entityId: s.id, action: 'schedule.tick_coalesced' } })).toBe(1);
  });

  it('skips while the schedule\'s job is RUNNING, and stays enabled', async () => {
    const s = await schedule();
    await ticker.tick(NOW);
    await prisma.fleetJob.updateMany({ where: { scheduleId: s.id }, data: { state: 'RUNNING' } });
    await prisma.jobSchedule.update({ where: { id: s.id }, data: { nextFireAt: NEXT } });
    expect(await ticker.tick(new Date('2026-10-02T04:00:30.000Z'))).toEqual(expect.objectContaining({ skipped: 1 }));
    expect(await jobsOf(s.id)).toHaveLength(1);
    expect(await skipReasons(s.id)).toEqual(['job_active']);
    expect((await reload(s.id)).enabled).toBe(true);
  });

  it('a paused budget skips the tick without disabling', async () => {
    const s = await schedule();
    await prisma.budgetPolicy.create({
      data: {
        scopeType: 'global', scopeKey: 'global', windowKind: 'lifetime', amountUsd: new Prisma.Decimal(1), pausedAt: NOW,
        pausedWindowStart: new Date(0), createdById: world.ids.root, updatedById: world.ids.root,
      },
    });
    expect(await ticker.tick(NOW)).toEqual(expect.objectContaining({ skipped: 1 }));
    expect(await jobsOf(s.id)).toHaveLength(0);
    expect(await skipReasons(s.id)).toEqual(['budget_paused']);
    expect(await reload(s.id)).toEqual(expect.objectContaining({ enabled: true, nextFireAt: NEXT }));
  });

  it('never coalesces into a manual job of the same feature: skips and stays enabled', async () => {
    const s = await schedule({ feature: 'shared' });
    await prisma.fleetJob.create({
      data: {
        projectId: world.projectId, repoId: world.repoId, ref: 'trunk', command: 'RUN', feature: 'shared', profiles: [],
        maxCostUsd: new Prisma.Decimal(5), selectorLabels: [], requestedById: world.ids.dev, state: 'QUEUED',
      },
    });
    expect(await ticker.tick(NOW)).toEqual(expect.objectContaining({ skipped: 1, dispatched: 0 }));
    expect(await jobsOf(s.id)).toHaveLength(0);
    expect(await skipReasons(s.id)).toEqual(['active_job_elsewhere']);
    expect((await reload(s.id)).enabled).toBe(true);
  });

  it.each([
    ['removed from the project', () => owner(null)],
    ['demoted to VIEWER', () => owner('VIEWER')],
    ['disabled', () => owner('DEVELOPER', { disabled: true })],
  ])('owner %s: disabled once with owner_lost_access, one activity row and one webhook, and not ticked again', async (_name, makeOwner) => {
    const s = await schedule({ createdById: await makeOwner(), updatedById: world.ids.root });
    expect(await ticker.tick(NOW)).toEqual(expect.objectContaining({ disabled: 1, dispatched: 0 }));
    expect(await reload(s.id)).toEqual(expect.objectContaining({ enabled: false, disabledReason: 'owner_lost_access' }));
    expect(await prisma.fleetActivity.count({ where: { entityId: s.id, action: 'schedule.auto_disabled' } })).toBe(1);
    expect(await hooks()).toBe(1);
    expect(await jobsOf(s.id)).toHaveLength(0);
    expect(await ticker.tick(new Date('2026-10-02T05:00:30.000Z'))).toEqual(expect.objectContaining({ claimed: 0 }));
  });

  it('a global ADMIN owner with no project membership may dispatch', async () => {
    const s = await schedule({ createdById: world.ids.root });
    expect(await ticker.tick(NOW)).toEqual(expect.objectContaining({ dispatched: 1 }));
    expect(await jobsOf(s.id)).toHaveLength(1);
  });

  it('a deleted repo disables with template_invalid', async () => {
    const repo = await prisma.fleetRepo.create({
      data: { projectId: world.projectId, provider: 'github', owner: 'acme', name: 'doomed', defaultBranch: 'main', githubInstallationId: BigInt(77), createdById: world.ids.root },
    });
    const s = await schedule({ repoId: repo.id });
    await prisma.fleetRepo.delete({ where: { id: repo.id } });
    expect(await ticker.tick(NOW)).toEqual(expect.objectContaining({ disabled: 1 }));
    expect(await reload(s.id)).toEqual(expect.objectContaining({ enabled: false, disabledReason: 'template_invalid' }));
    expect(await hooks()).toBe(1);
  });

  it('a pinned runner that is gone disables with template_invalid', async () => {
    const s = await schedule({ pinnedRunnerId: 'runner-that-was-deleted' });
    expect(await ticker.tick(NOW)).toEqual(expect.objectContaining({ disabled: 1 }));
    expect(await reload(s.id)).toEqual(expect.objectContaining({ enabled: false, disabledReason: 'template_invalid' }));
  });

  it('a soft-deleted project is not ticked at all', async () => {
    const s = await schedule({ projectId: world.opsProjectId, repoId: world.foreignRepoId, createdById: world.ids.root });
    await prisma.project.update({ where: { id: world.opsProjectId }, data: { deletedAt: new Date() } });
    try {
      expect(await ticker.tick(NOW)).toEqual(expect.objectContaining({ claimed: 0 }));
      expect(await reload(s.id)).toEqual(expect.objectContaining({ enabled: true, nextFireAt: DUE }));
      expect(await jobsOf(s.id)).toHaveLength(0);
    } finally {
      await prisma.project.update({ where: { id: world.opsProjectId }, data: { deletedAt: null } });
    }
  });

  it('fires a Singapore-zone cron at its local time, whatever the process zone', async () => {
    const s = await schedule({ cron: '30 8 * * *', timezone: 'Asia/Singapore', nextFireAt: new Date('2026-10-02T00:30:00.000Z') });
    await ticker.tick(new Date('2026-10-02T00:30:10.000Z'));
    expect(await jobsOf(s.id)).toHaveLength(1);
    expect((await reload(s.id)).nextFireAt).toEqual(new Date('2026-10-03T00:30:00.000Z'));
  });
});
```

- [ ] **Step 7: Register the ticker so the integration spec can resolve it**

The ticker is not in a module yet; Task 8 creates `SchedulesModule`. To keep this task self-contained, create a
minimal `apps/api/src/fleet/schedules/schedules.module.ts` now (Task 8 extends it):

```ts
import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { FleetActivityModule } from '../activity/fleet-activity.module';
import { FleetJobsModule } from '../jobs/fleet-jobs.module';
import { ScheduleStoreModule } from './schedule-store.module';
import { ScheduleTicker } from './schedule-ticker';

/** S1b §3 C4 schedules (plan D192): the ticker; Task 8 adds the management routes. */
@Module({
  imports: [PrismaModule, ScheduleStoreModule, FleetJobsModule, FleetActivityModule],
  providers: [ScheduleTicker],
  exports: [ScheduleTicker],
})
export class SchedulesModule {}
```

and in `apps/api/src/fleet/fleet.module.ts` import it: add
`import { SchedulesModule } from './schedules/schedules.module';` and `SchedulesModule` to the `imports` array
(after `BudgetsModule`).

- [ ] **Step 8: Run the integration spec and the module guards**

Run: `cd apps/api && bun run test:scoped test/integration/fleet/fleet-schedule-ticker.integration.spec.ts src/fleet/fleet.module.spec.ts`
Expected: PASS (15 ticker cases; the fleet module compiles with the ticker wired).

Then once under a non-UTC process zone: `TZ=Asia/Singapore bun run test:scoped test/integration/fleet/fleet-schedule-ticker.integration.spec.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/fleet apps/api/test/integration/fleet/fleet-schedule-ticker.integration.spec.ts
git commit -m "feat(fleet): schedule ticker with CAS claim, coalescing and the dispatch outcome table"
```

---

### Task 8: Management — DTOs, `SchedulesService`, the controller, i18n

**Files:**
- Create: `apps/api/src/fleet/schedules/dto/create-schedule.dto.ts`, `dto/update-schedule.dto.ts`, `dto/schedule.dto.ts`
- Create: `apps/api/src/fleet/schedules/schedules.service.ts`
- Create: `apps/api/src/fleet/schedules/project-fleet-schedules.controller.ts`
- Modify: `apps/api/src/fleet/schedules/schedules.module.ts`
- Modify: `apps/api/src/i18n/en/fleet.json`, `apps/api/src/i18n/zh/fleet.json`
- Test: `apps/api/src/fleet/schedules/schedules.service.spec.ts`, `apps/api/src/fleet/schedules/schedules.module.spec.ts`,
  `apps/api/test/unit/i18n/fleet-schedule-translation-keys.spec.ts`,
  `apps/api/test/integration/fleet/fleet-schedules-api.integration.spec.ts`

**Interfaces:**
- Consumes: `IScheduleRepository`, `ScheduleRecord` (Task 3); `assertCronAllowed`, `nextFireAfter`, `CronInputError`,
  `MIN_FIRE_GAP_MS` (Task 2); `normalizeDispatch`, `toPlacementJob`, `PlacementService.evaluatePinned`,
  `PERMANENT_MISFITS`, `FleetDispatchException`, `IFleetJobRepository.findRepo`.
- Produces: `SchedulesService` with
  `list(projectId): Promise<ScheduleDto[]>`,
  `get(projectId, id): Promise<ScheduleDto>`,
  `create(actorId, projectId, dto: CreateScheduleDto, now?): Promise<ScheduleDto>`,
  `update(actorId, projectId, id, dto: UpdateScheduleDto, canAdminister: boolean, now?): Promise<ScheduleDto>`,
  `remove(actorId, projectId, id, canAdminister): Promise<void>`,
  `enable(actorId, projectId, id, canAdminister, now?): Promise<ScheduleDto>`,
  `disable(actorId, projectId, id, canAdminister): Promise<ScheduleDto>`.
  Routes `/projects/:slug/fleet/schedules` (see the controller). DTO classes `CreateScheduleDto`,
  `UpdateScheduleDto`, `ScheduleDto` (the CLI's generated types).

- [ ] **Step 1: Write the failing translation spec**

Create `apps/api/test/unit/i18n/fleet-schedule-translation-keys.spec.ts`:

```ts
/**
 * S1b slice 3a — schedule error messages exist in en and zh with the same placeholders.
 * The key is `<prefix>.<code>`: NotFoundAppException uses 404, ValidationAppException -2.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

type Tree = Record<string, Record<string, string>>;
const load = (lang: string): Tree => JSON.parse(readFileSync(join(__dirname, '../../../src/i18n', lang, 'fleet.json'), 'utf8')) as Tree;
const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

const KEYS: Array<[string, string, string[]]> = [
  ['schedules', '404', []],
  ['scheduleInput', '-2', ['reason']],
  ['scheduleCronTooFrequent', '-2', ['minutes']],
];

describe('fleet schedule translation keys', () => {
  const en = load('en');
  const zh = load('zh');

  it.each(KEYS)('fleet.%s.%s exists in en and zh with the same placeholders', (group, code, expected) => {
    const enText = en[group]?.[code];
    const zhText = zh[group]?.[code];
    expect(typeof enText).toBe('string');
    expect(typeof zhText).toBe('string');
    expect(placeholders(enText)).toEqual(expected);
    expect(placeholders(zhText)).toEqual(expected);
  });
});
```

- [ ] **Step 2: Run it to verify it fails, then add the translations**

Run: `cd apps/api && bun run test:scoped test/unit/i18n/fleet-schedule-translation-keys.spec.ts`
Expected: FAIL (`expect(typeof enText).toBe('string')`, received `undefined`).

In `apps/api/src/i18n/en/fleet.json` replace the last entry

```json
  "budgetNotPaused": { "409": "This budget policy is not paused" }
```

with

```json
  "budgetNotPaused": { "409": "This budget policy is not paused" },
  "schedules": { "404": "Schedule not found" },
  "scheduleInput": { "-2": "Invalid schedule: {reason}" },
  "scheduleCronTooFrequent": { "-2": "The schedule fires more often than every {minutes} minutes" }
```

and in `apps/api/src/i18n/zh/fleet.json` replace

```json
  "budgetNotPaused": { "409": "该预算策略未处于暂停状态" }
```

with

```json
  "budgetNotPaused": { "409": "该预算策略未处于暂停状态" },
  "schedules": { "404": "未找到计划" },
  "scheduleInput": { "-2": "无效的计划：{reason}" },
  "scheduleCronTooFrequent": { "-2": "计划的触发间隔不得少于 {minutes} 分钟" }
```

Run the spec again. Expected: PASS (3 cases).

- [ ] **Step 3: Write the failing service spec**

Create `apps/api/src/fleet/schedules/schedules.service.spec.ts`:

```ts
import { ForbiddenAppException, NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { FleetDispatchException } from '../jobs/fleet-dispatch.exception';
import type { ScheduleRecord } from './domain/schedule.domain';
import { SchedulesService } from './schedules.service';

const NOW = new Date('2026-10-02T03:00:30.000Z');
const schedule = (over: Partial<ScheduleRecord> = {}): ScheduleRecord => ({
  id: 's1', projectId: 'p1', repoId: 'r1', name: 'nightly', cron: '0 9 * * *', timezone: 'UTC', feature: 'login', ref: 'main', profiles: [],
  maxCostUsd: '5', selectorLabels: [], pinnedRunnerId: null, enabled: true, nextFireAt: new Date('2026-10-02T09:00:00.000Z'), lastFiredAt: null,
  lastJobId: null, lastPassedCount: 4, noProgressTicks: 2, noProgressLimit: 3, disabledReason: null, createdById: 'owner', updatedById: 'owner',
  createdAt: NOW, updatedAt: NOW, ...over,
});
const REPO = { id: 'r1', projectId: 'p1', provider: 'github' as const, owner: 'acme', name: 'app', defaultBranch: 'trunk', githubInstallationId: null };

function build(current: ScheduleRecord | null = schedule()) {
  const repo = {
    findByProject: jest.fn(async () => (current ? [current] : [])),
    findById: jest.fn(async () => current),
    lockById: jest.fn(async () => current),
    create: jest.fn(async (data: Record<string, unknown>) => ({ ...schedule(), ...data, id: 'new' }) as ScheduleRecord),
    update: jest.fn(async (_id: string, patch: Partial<ScheduleRecord>) => ({ ...(current as ScheduleRecord), ...patch })),
    delete: jest.fn(async () => undefined),
    sumCostBySchedule: jest.fn(async () => new Map<string, string>()),
  };
  const jobsRepo = { findRepo: jest.fn(async () => REPO as typeof REPO | null) };
  const placement = { evaluatePinned: jest.fn(async (): Promise<string | null> => null) };
  const activity = { record: jest.fn(async () => undefined) };
  const txManager = { run: jest.fn(async <T>(fn: () => Promise<T>) => fn()) };
  const svc = new SchedulesService(repo as never, jobsRepo as never, placement as never, activity as never, txManager as never);
  return { repo, jobsRepo, placement, activity, svc };
}
const input = (over: Record<string, unknown> = {}) => ({
  name: ' nightly ', repoId: 'r1', feature: 'login', cron: ' 0  9 * * * ', timezone: 'asia/singapore', maxCostUsd: 5, ...over,
}) as never;

describe('SchedulesService.create', () => {
  it('stores the normalised template: trimmed name, canonical zone, repo default branch as ref, next fire from now', async () => {
    const h = build();
    await h.svc.create('u9', 'p1', input(), NOW);
    expect(h.repo.create).toHaveBeenCalledWith({
      projectId: 'p1', repoId: 'r1', name: 'nightly', cron: '0 9 * * *', timezone: 'Asia/Singapore', feature: 'login', ref: 'trunk', profiles: [],
      maxCostUsd: '5', selectorLabels: [], pinnedRunnerId: null, noProgressLimit: 3, nextFireAt: new Date('2026-10-03T01:00:00.000Z'), createdById: 'u9',
    });
    expect(h.activity.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'schedule.created', entityType: 'schedule', actorType: 'USER', actorId: 'u9', projectId: 'p1' }));
  });

  it.each([
    ['a cron with four fields', { cron: '* * * *' }],
    ['a cron firing every ten minutes', { cron: '*/10 * * * *' }],
    ['an unknown timezone', { timezone: 'Mars/Base' }],
    ['a feature that is not a single path segment', { feature: '../etc' }],
    ['a reserved profile', { profiles: ['koda-job-x'] }],
  ])('refuses %s with a validation error and stores nothing', async (_name, over) => {
    const h = build();
    await expect(h.svc.create('u9', 'p1', input(over), NOW)).rejects.toBeInstanceOf(ValidationAppException);
    expect(h.repo.create).not.toHaveBeenCalled();
  });

  it('refuses a repo that is not in this project (404)', async () => {
    const h = build();
    h.jobsRepo.findRepo.mockResolvedValue({ ...REPO, projectId: 'other' });
    await expect(h.svc.create('u9', 'p1', input(), NOW)).rejects.toBeInstanceOf(NotFoundAppException);
    h.jobsRepo.findRepo.mockResolvedValue(null);
    await expect(h.svc.create('u9', 'p1', input(), NOW)).rejects.toBeInstanceOf(NotFoundAppException);
  });

  it('refuses an unknown pinned runner (404) and one that can never run the job (422)', async () => {
    const h = build();
    h.placement.evaluatePinned.mockResolvedValue('not_found');
    await expect(h.svc.create('u9', 'p1', input({ pinnedRunnerId: 'ghost' }), NOW)).rejects.toBeInstanceOf(NotFoundAppException);
    h.placement.evaluatePinned.mockResolvedValue('tools');
    await expect(h.svc.create('u9', 'p1', input({ pinnedRunnerId: 'run-1' }), NOW)).rejects.toBeInstanceOf(FleetDispatchException);
    h.placement.evaluatePinned.mockResolvedValue('capacity');
    await expect(h.svc.create('u9', 'p1', input({ pinnedRunnerId: 'run-1' }), NOW)).resolves.toBeDefined();
  });
});

describe('SchedulesService.update', () => {
  it('lets the owner change the template; a cron change recomputes nextFireAt from now on an enabled schedule', async () => {
    const h = build();
    await h.svc.update('owner', 'p1', 's1', { cron: '0 6 * * *' } as never, false, NOW);
    expect(h.repo.update).toHaveBeenCalledWith('s1', expect.objectContaining({ cron: '0 6 * * *', nextFireAt: new Date('2026-10-02T06:00:00.000Z'), updatedById: 'owner' }));
  });

  it('does not move nextFireAt of a disabled schedule, or when only the name changes, and never enables it', async () => {
    const off = build(schedule({ enabled: false, disabledReason: 'manual' }));
    await off.svc.update('owner', 'p1', 's1', { cron: '0 6 * * *' } as never, false, NOW);
    expect(off.repo.update.mock.calls[0][1]).not.toHaveProperty('nextFireAt');
    expect(off.repo.update.mock.calls[0][1]).not.toHaveProperty('enabled');
    const renamed = build();
    await renamed.svc.update('owner', 'p1', 's1', { name: ' new ' } as never, false, NOW);
    expect(renamed.repo.update.mock.calls[0][1]).toEqual(expect.objectContaining({ name: 'new' }));
    expect(renamed.repo.update.mock.calls[0][1]).not.toHaveProperty('nextFireAt');
  });

  it('pinnedRunnerId null unpins; omitted keeps the pin', async () => {
    const pinned = build(schedule({ pinnedRunnerId: 'run-1' }));
    await pinned.svc.update('owner', 'p1', 's1', { pinnedRunnerId: null } as never, false, NOW);
    expect(pinned.repo.update.mock.calls[0][1]).toEqual(expect.objectContaining({ pinnedRunnerId: null }));
    const kept = build(schedule({ pinnedRunnerId: 'run-1' }));
    await kept.svc.update('owner', 'p1', 's1', { name: 'x' } as never, false, NOW);
    expect(kept.repo.update.mock.calls[0][1]).toEqual(expect.objectContaining({ pinnedRunnerId: 'run-1' }));
  });

  it('refuses another developer, allows a project admin, and 404s another project\'s schedule', async () => {
    const h = build();
    await expect(h.svc.update('someone-else', 'p1', 's1', { name: 'x' } as never, false, NOW)).rejects.toBeInstanceOf(ForbiddenAppException);
    await expect(h.svc.update('someone-else', 'p1', 's1', { name: 'x' } as never, true, NOW)).resolves.toBeDefined();
    await expect(h.svc.update('owner', 'other-project', 's1', { name: 'x' } as never, true, NOW)).rejects.toBeInstanceOf(NotFoundAppException);
    const gone = build(null);
    await expect(gone.svc.update('owner', 'p1', 's1', { name: 'x' } as never, true, NOW)).rejects.toBeInstanceOf(NotFoundAppException);
  });
});

describe('SchedulesService.enable and disable', () => {
  it('enable resets the stall counter and the reason, recomputes nextFireAt from now, and keeps lastPassedCount', async () => {
    const h = build(schedule({ enabled: false, disabledReason: 'no_progress', noProgressTicks: 3 }));
    const dto = await h.svc.enable('owner', 'p1', 's1', false, NOW);
    expect(h.repo.update).toHaveBeenCalledWith('s1', { enabled: true, disabledReason: null, noProgressTicks: 0, nextFireAt: new Date('2026-10-02T09:00:00.000Z'), updatedById: 'owner' });
    expect(dto.lastPassedCount).toBe(4);
    expect(h.activity.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'schedule.enabled' }));
  });

  it('enable on an enabled schedule changes nothing', async () => {
    const h = build();
    await h.svc.enable('owner', 'p1', 's1', false, NOW);
    expect(h.repo.update).not.toHaveBeenCalled();
    expect(h.activity.record).not.toHaveBeenCalled();
  });

  it('disable records a manual reason and a user activity row, and is idempotent', async () => {
    const h = build();
    const dto = await h.svc.disable('owner', 'p1', 's1', false);
    expect(h.repo.update).toHaveBeenCalledWith('s1', { enabled: false, disabledReason: 'manual', updatedById: 'owner' });
    expect(dto).toEqual(expect.objectContaining({ enabled: false, disabledReason: 'manual', nextFireAt: null }));
    expect(h.activity.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'schedule.disabled', actorType: 'USER' }));
    const off = build(schedule({ enabled: false, disabledReason: 'completed' }));
    await off.svc.disable('owner', 'p1', 's1', false);
    expect(off.repo.update).not.toHaveBeenCalled();
  });

  it('refuses a developer who is not the owner', async () => {
    const h = build();
    await expect(h.svc.disable('other', 'p1', 's1', false)).rejects.toBeInstanceOf(ForbiddenAppException);
    await expect(h.svc.enable('other', 'p1', 's1', false, NOW)).rejects.toBeInstanceOf(ForbiddenAppException);
  });
});

describe('SchedulesService.remove, list and get', () => {
  it('remove deletes under the lock and records a row; a stranger is refused', async () => {
    const h = build();
    await h.svc.remove('owner', 'p1', 's1', false);
    expect(h.repo.delete).toHaveBeenCalledWith('s1');
    expect(h.activity.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'schedule.deleted' }));
    await expect(h.svc.remove('other', 'p1', 's1', false)).rejects.toBeInstanceOf(ForbiddenAppException);
  });

  it('list and get carry the schedule\'s total cost; nextFireAt is null while disabled', async () => {
    const h = build(schedule({ enabled: false, disabledReason: 'manual' }));
    h.repo.sumCostBySchedule.mockResolvedValue(new Map([['s1', '3.7500']]));
    expect(await h.svc.list('p1')).toEqual([expect.objectContaining({ id: 's1', totalCostUsd: '3.7500', nextFireAt: null })]);
    expect(await h.svc.get('p1', 's1')).toEqual(expect.objectContaining({ totalCostUsd: '3.7500' }));
    await expect(h.svc.get('other-project', 's1')).rejects.toBeInstanceOf(NotFoundAppException);
  });

  it('a schedule with no jobs reports 0.0000', async () => {
    expect((await build().svc.get('p1', 's1')).totalCostUsd).toBe('0.0000');
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `cd apps/api && bun run test:scoped src/fleet/schedules/schedules.service.spec.ts`
Expected: FAIL (`Cannot find module './schedules.service'`).

- [ ] **Step 5: Write the DTOs**

Create `apps/api/src/fleet/schedules/dto/create-schedule.dto.ts`:

```ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsInt, IsNumber, IsOptional, IsString, Length, Matches, Max, MaxLength, Min } from 'class-validator';
import { LABEL_PATTERN } from '../../runners/dto/create-enrollment.dto';

export const MAX_NO_PROGRESS_LIMIT = 20;

export class CreateScheduleDto {
  @ApiProperty({ description: 'Display name' }) @IsString() @Length(1, 80) @Matches(/\S/) declare name: string;
  @ApiProperty({ description: 'Fleet repo id of this project' }) @IsString() @Length(1, 64) declare repoId: string;
  @ApiProperty({ description: 'nax feature name; fixed after create' }) @IsString() @MaxLength(128) declare feature: string;
  @ApiProperty({ description: 'Five-field cron, for example "0 9 * * 1-5"; consecutive fires at least 15 minutes apart' })
  @IsString() @Length(9, 100) declare cron: string;
  @ApiProperty({ description: 'IANA timezone the cron is read in, for example Asia/Singapore' }) @IsString() @Length(1, 64) declare timezone: string;
  @ApiPropertyOptional({ description: 'Git ref to check out detached; defaults to the repo default branch at create time' })
  @IsOptional() @IsString() @MaxLength(255) ref?: string;
  @ApiPropertyOptional({ type: [String], description: 'nax profile chain, later wins' })
  @IsOptional() @IsArray() @ArrayMaxSize(8) @IsString({ each: true }) @MaxLength(64, { each: true }) profiles?: string[];
  @ApiProperty({ description: 'Budget of each run in USD, > 0, at most 4 decimals' })
  @IsNumber({ maxDecimalPlaces: 4, allowNaN: false, allowInfinity: false }) @Min(0.0001) @Max(10_000) declare maxCostUsd: number;
  @ApiPropertyOptional({ type: [String] })
  @IsOptional() @IsArray() @ArrayMaxSize(16) @Matches(LABEL_PATTERN, { each: true }) selectorLabels?: string[];
  @ApiPropertyOptional({ description: 'Run on this runner only' }) @IsOptional() @IsString() @Length(1, 64) pinnedRunnerId?: string;
  @ApiPropertyOptional({ description: 'Disable after this many runs in a row without a newly passed story (1-20); default 3' })
  @IsOptional() @IsInt() @Min(1) @Max(MAX_NO_PROGRESS_LIMIT) noProgressLimit?: number;
}
```

Create `apps/api/src/fleet/schedules/dto/update-schedule.dto.ts`:

```ts
import { ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsInt, IsNumber, IsString, Length, Matches, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import { whenProvided, whenSet } from '../../budgets/dto/create-budget-policy.dto';
import { LABEL_PATTERN } from '../../runners/dto/create-enrollment.dto';
import { MAX_NO_PROGRESS_LIMIT } from './create-schedule.dto';

/** Plan D203: the repo and the feature are fixed. An omitted field is unchanged; `pinnedRunnerId: null` unpins. */
export class UpdateScheduleDto {
  @ApiPropertyOptional() @ValidateIf(whenProvided) @IsString() @Length(1, 80) @Matches(/\S/) name?: string;
  @ApiPropertyOptional({ description: 'Five-field cron' }) @ValidateIf(whenProvided) @IsString() @Length(9, 100) cron?: string;
  @ApiPropertyOptional({ description: 'IANA timezone' }) @ValidateIf(whenProvided) @IsString() @Length(1, 64) timezone?: string;
  @ApiPropertyOptional() @ValidateIf(whenProvided) @IsString() @Length(1, 255) ref?: string;
  @ApiPropertyOptional({ type: [String], description: 'Replaces the profile chain; [] clears it' })
  @ValidateIf(whenProvided) @IsArray() @ArrayMaxSize(8) @IsString({ each: true }) @MaxLength(64, { each: true }) profiles?: string[];
  @ApiPropertyOptional({ description: 'USD, > 0, at most 4 decimals' })
  @ValidateIf(whenProvided) @IsNumber({ maxDecimalPlaces: 4, allowNaN: false, allowInfinity: false }) @Min(0.0001) @Max(10_000) maxCostUsd?: number;
  @ApiPropertyOptional({ type: [String], description: 'Replaces the selector labels; [] clears them' })
  @ValidateIf(whenProvided) @IsArray() @ArrayMaxSize(16) @Matches(LABEL_PATTERN, { each: true }) selectorLabels?: string[];
  @ApiPropertyOptional({ type: String, nullable: true, description: 'null unpins' })
  @ValidateIf(whenSet) @IsString() @Length(1, 64) pinnedRunnerId?: string | null;
  @ApiPropertyOptional({ description: '1-20' }) @ValidateIf(whenProvided) @IsInt() @Min(1) @Max(MAX_NO_PROGRESS_LIMIT) noProgressLimit?: number;
}
```

Create `apps/api/src/fleet/schedules/dto/schedule.dto.ts`:

```ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SCHEDULE_DISABLED_REASONS, ScheduleDisabledReason, ScheduleRecord } from '../domain/schedule.domain';

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/** One schedule (S1b §3.1, §3.4). */
export class ScheduleDto {
  @ApiProperty() declare id: string;
  @ApiProperty() declare projectId: string;
  @ApiProperty({ description: 'May name a repo that has since been deleted; the schedule is then disabled (template_invalid)' }) declare repoId: string;
  @ApiProperty() declare name: string;
  @ApiProperty({ description: 'Five-field cron' }) declare cron: string;
  @ApiProperty({ description: 'IANA timezone the cron is read in' }) declare timezone: string;
  @ApiProperty() declare feature: string;
  @ApiProperty() declare ref: string;
  @ApiProperty({ type: [String] }) declare profiles: string[];
  @ApiProperty({ type: String, description: 'Decimal as string' }) declare maxCostUsd: string;
  @ApiProperty({ type: [String] }) declare selectorLabels: string[];
  @ApiPropertyOptional({ type: String, nullable: true }) declare pinnedRunnerId: string | null;
  @ApiProperty() declare enabled: boolean;
  @ApiPropertyOptional({ type: String, nullable: true, description: 'Next fire; null while disabled' }) declare nextFireAt: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) declare lastFiredAt: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) declare lastJobId: string | null;
  @ApiProperty({ description: 'Stories passed at the last run that made progress' }) declare lastPassedCount: number;
  @ApiProperty({ description: 'Runs in a row without a newly passed story' }) declare noProgressTicks: number;
  @ApiProperty({ description: 'The schedule disables itself at this many' }) declare noProgressLimit: number;
  @ApiPropertyOptional({ enum: SCHEDULE_DISABLED_REASONS, nullable: true }) declare disabledReason: ScheduleDisabledReason | null;
  @ApiProperty({ type: String, description: 'Cost of every job this schedule dispatched, decimal as string' }) declare totalCostUsd: string;
  @ApiProperty() declare createdById: string;
  @ApiProperty() declare updatedById: string;
  @ApiProperty() declare createdAt: string;
  @ApiProperty() declare updatedAt: string;

  static from(s: ScheduleRecord, totalCostUsd: string): ScheduleDto {
    return Object.assign(new ScheduleDto(), {
      id: s.id, projectId: s.projectId, repoId: s.repoId, name: s.name, cron: s.cron, timezone: s.timezone, feature: s.feature, ref: s.ref,
      profiles: s.profiles, maxCostUsd: s.maxCostUsd, selectorLabels: s.selectorLabels, pinnedRunnerId: s.pinnedRunnerId, enabled: s.enabled,
      nextFireAt: s.enabled ? s.nextFireAt.toISOString() : null, lastFiredAt: iso(s.lastFiredAt), lastJobId: s.lastJobId,
      lastPassedCount: s.lastPassedCount, noProgressTicks: s.noProgressTicks, noProgressLimit: s.noProgressLimit,
      disabledReason: s.disabledReason, totalCostUsd, createdById: s.createdById, updatedById: s.updatedById,
      createdAt: s.createdAt.toISOString(), updatedAt: s.updatedAt.toISOString(),
    });
  }
}
```

- [ ] **Step 6: Write the service**

Create `apps/api/src/fleet/schedules/schedules.service.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common';
import { ForbiddenAppException, NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { FleetActivityService } from '../activity/fleet-activity.service';
import { normalizeDispatch } from '../jobs/dispatch-input';
import { FleetDispatchException } from '../jobs/fleet-dispatch.exception';
import { PERMANENT_MISFITS } from '../jobs/placement-rules';
import { PlacementService, toPlacementJob } from '../jobs/placement.service';
import { FLEET_JOB_REPOSITORY, IFleetJobRepository } from '../jobs/domain/fleet-job.domain';
import { assertCronAllowed, CronInputError, MIN_FIRE_GAP_MS, nextFireAfter } from './cron-schedule';
import { DEFAULT_NO_PROGRESS_LIMIT, IScheduleRepository, SCHEDULE_REPOSITORY, ScheduleRecord } from './domain/schedule.domain';
import type { CreateScheduleDto } from './dto/create-schedule.dto';
import { ScheduleDto } from './dto/schedule.dto';
import type { UpdateScheduleDto } from './dto/update-schedule.dto';
import { schedulePayload } from './schedule-payloads';

const ZERO_USD = '0.0000';

/** The template fields a create or an edit must validate together. */
interface TemplateInput {
  repoId: string;
  feature: string;
  cron: string;
  timezone: string;
  ref?: string;
  profiles?: string[];
  maxCostUsd: number;
  selectorLabels?: string[];
  pinnedRunnerId?: string | null;
}

interface CheckedTemplate {
  repoId: string;
  feature: string;
  cron: string;
  timezone: string;
  ref: string;
  profiles: string[];
  maxCostUsd: string;
  selectorLabels: string[];
  pinnedRunnerId: string | null;
}

/** Plan D191: a cron or zone refusal is a 400; too frequent has its own code. */
function cronProblem(error: unknown): Error {
  if (!(error instanceof CronInputError)) return error instanceof Error ? error : new Error(String(error));
  if (error.failure === 'too_frequent') return new ValidationAppException({ minutes: MIN_FIRE_GAP_MS / 60_000 }, 'fleet.scheduleCronTooFrequent');
  return new ValidationAppException({ reason: error.message }, 'fleet.scheduleInput');
}

/**
 * S1b §3.4: schedule management. Who may call is the controller's job (create: DEVELOPER+; mutations: DEVELOPER+
 * through CASL); `canAdminister` (project ADMIN, which a global ADMIN resolves to) is the other half of "owner or
 * project ADMIN" and is checked here under the row lock (plan D202).
 */
@Injectable()
export class SchedulesService {
  constructor(
    @Inject(SCHEDULE_REPOSITORY) private readonly repo: IScheduleRepository,
    @Inject(FLEET_JOB_REPOSITORY) private readonly jobsRepo: Pick<IFleetJobRepository, 'findRepo'>,
    private readonly placement: PlacementService,
    private readonly activity: FleetActivityService,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
  ) {}

  async list(projectId: string): Promise<ScheduleDto[]> {
    const rows = await this.repo.findByProject(projectId);
    const costs = await this.repo.sumCostBySchedule(rows.map((r) => r.id));
    return rows.map((r) => ScheduleDto.from(r, costs.get(r.id) ?? ZERO_USD));
  }

  async get(projectId: string, id: string): Promise<ScheduleDto> {
    const schedule = await this.repo.findById(id);
    if (!schedule || schedule.projectId !== projectId) throw new NotFoundAppException({}, 'fleet.schedules');
    return this.toDto(schedule);
  }

  async create(actorId: string, projectId: string, dto: CreateScheduleDto, now = new Date()): Promise<ScheduleDto> {
    const t = await this.checkTemplate(projectId, dto, now);
    const created = await this.txManager.run(async () => {
      const schedule = await this.repo.create({
        projectId, repoId: t.repoId, name: dto.name.trim(), cron: t.cron, timezone: t.timezone, feature: t.feature, ref: t.ref,
        profiles: t.profiles, maxCostUsd: t.maxCostUsd, selectorLabels: t.selectorLabels, pinnedRunnerId: t.pinnedRunnerId,
        noProgressLimit: dto.noProgressLimit ?? DEFAULT_NO_PROGRESS_LIMIT, nextFireAt: nextFireAfter(t.cron, t.timezone, now), createdById: actorId,
      });
      await this.record(actorId, 'schedule.created', schedule);
      return schedule;
    });
    return this.toDto(created);
  }

  async update(actorId: string, projectId: string, id: string, dto: UpdateScheduleDto, canAdminister: boolean, now = new Date()): Promise<ScheduleDto> {
    const updated = await this.txManager.run(async () => {
      const current = await this.lockManaged(projectId, id, actorId, canAdminister);
      // The whole template is re-validated, not only the changed fields: a schedule that cannot dispatch is refused
      // here instead of being disabled by the next tick.
      const t = await this.checkTemplate(projectId, {
        repoId: current.repoId, feature: current.feature, cron: dto.cron ?? current.cron, timezone: dto.timezone ?? current.timezone,
        ref: dto.ref ?? current.ref, profiles: dto.profiles ?? current.profiles, maxCostUsd: dto.maxCostUsd ?? Number(current.maxCostUsd),
        selectorLabels: dto.selectorLabels ?? current.selectorLabels,
        pinnedRunnerId: dto.pinnedRunnerId === undefined ? current.pinnedRunnerId : dto.pinnedRunnerId,
      }, now);
      const moved = (dto.cron !== undefined || dto.timezone !== undefined) && current.enabled;
      const after = await this.repo.update(id, {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        cron: t.cron, timezone: t.timezone, ref: t.ref, profiles: t.profiles, maxCostUsd: t.maxCostUsd,
        selectorLabels: t.selectorLabels, pinnedRunnerId: t.pinnedRunnerId,
        ...(dto.noProgressLimit !== undefined ? { noProgressLimit: dto.noProgressLimit } : {}),
        ...(moved ? { nextFireAt: nextFireAfter(t.cron, t.timezone, now) } : {}),
        updatedById: actorId,
      });
      await this.record(actorId, 'schedule.updated', after);
      return after;
    });
    return this.toDto(updated);
  }

  async remove(actorId: string, projectId: string, id: string, canAdminister: boolean): Promise<void> {
    await this.txManager.run(async () => {
      const current = await this.lockManaged(projectId, id, actorId, canAdminister);
      await this.repo.delete(id);
      await this.record(actorId, 'schedule.deleted', current);
    });
  }

  /** S1b §3.3: re-enabling resets the stall counter and the reason, recomputes nextFireAt from now, keeps lastPassedCount. */
  async enable(actorId: string, projectId: string, id: string, canAdminister: boolean, now = new Date()): Promise<ScheduleDto> {
    const result = await this.txManager.run(async () => {
      const current = await this.lockManaged(projectId, id, actorId, canAdminister);
      if (current.enabled) return current;
      const after = await this.repo.update(id, {
        enabled: true, disabledReason: null, noProgressTicks: 0, nextFireAt: nextFireAfter(current.cron, current.timezone, now), updatedById: actorId,
      });
      await this.record(actorId, 'schedule.enabled', after, { previousReason: current.disabledReason });
      return after;
    });
    return this.toDto(result);
  }

  async disable(actorId: string, projectId: string, id: string, canAdminister: boolean): Promise<ScheduleDto> {
    const result = await this.txManager.run(async () => {
      const current = await this.lockManaged(projectId, id, actorId, canAdminister);
      if (!current.enabled) return current;
      const after = await this.repo.update(id, { enabled: false, disabledReason: 'manual', updatedById: actorId });
      await this.record(actorId, 'schedule.disabled', after, { reason: 'manual' });
      return after;
    });
    return this.toDto(result);
  }

  /** S1b §3.1: the cron rules, the dispatch rules and the repo and runner checks, in the order dispatch applies them. */
  private async checkTemplate(projectId: string, input: TemplateInput, now: Date): Promise<CheckedTemplate> {
    let zoned: { cron: string; timezone: string };
    try {
      zoned = assertCronAllowed(input.cron, input.timezone, now);
    } catch (error) {
      throw cronProblem(error);
    }
    const repo = await this.jobsRepo.findRepo(input.repoId);
    if (!repo || repo.projectId !== projectId) throw new NotFoundAppException({}, 'fleet.repos');
    const normalized = normalizeDispatch({
      repoId: input.repoId, command: 'RUN', feature: input.feature, maxCostUsd: input.maxCostUsd,
      ...(input.ref !== undefined ? { ref: input.ref } : {}),
      ...(input.profiles !== undefined ? { profiles: input.profiles } : {}),
      ...(input.selectorLabels !== undefined ? { selectorLabels: input.selectorLabels } : {}),
      ...(input.pinnedRunnerId ? { pinnedRunnerId: input.pinnedRunnerId } : {}),
    }, repo.defaultBranch);
    if (normalized.pinnedRunnerId) {
      const verdict = await this.placement.evaluatePinned(normalized.pinnedRunnerId, toPlacementJob(normalized, repo));
      if (verdict === 'not_found') throw new NotFoundAppException({}, 'fleet.runners');
      if (verdict !== null && PERMANENT_MISFITS.has(verdict)) throw new FleetDispatchException(verdict);
    }
    return {
      repoId: input.repoId, feature: normalized.feature, cron: zoned.cron, timezone: zoned.timezone, ref: normalized.ref,
      profiles: normalized.profiles, maxCostUsd: normalized.maxCostUsd, selectorLabels: normalized.selectorLabels, pinnedRunnerId: normalized.pinnedRunnerId,
    };
  }

  /** Under the row lock: 404 for another project's schedule, 403 unless the owner or a project ADMIN. */
  private async lockManaged(projectId: string, id: string, actorId: string, canAdminister: boolean): Promise<ScheduleRecord> {
    const schedule = await this.repo.lockById(id);
    if (!schedule || schedule.projectId !== projectId) throw new NotFoundAppException({}, 'fleet.schedules');
    if (!canAdminister && schedule.createdById !== actorId) throw new ForbiddenAppException({}, 'projects');
    return schedule;
  }

  private async toDto(schedule: ScheduleRecord): Promise<ScheduleDto> {
    const costs = await this.repo.sumCostBySchedule([schedule.id]);
    return ScheduleDto.from(schedule, costs.get(schedule.id) ?? ZERO_USD);
  }

  private record(actorId: string, action: string, schedule: ScheduleRecord, extra: Record<string, unknown> = {}): Promise<void> {
    return this.activity.record({
      actorType: 'USER', actorId, action, entityType: 'schedule', entityId: schedule.id, projectId: schedule.projectId,
      responsibleUserId: actorId, payload: schedulePayload(schedule, extra),
    });
  }
}
```

- [ ] **Step 7: Run the service spec**

Run: `cd apps/api && bun run test:scoped src/fleet/schedules/schedules.service.spec.ts`
Expected: PASS (all cases).

- [ ] **Step 8: Write the controller and finish the module**

Create `apps/api/src/fleet/schedules/project-fleet-schedules.controller.ts`:

```ts
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CaslPermissionAction, Principal } from '@nathapp/nestjs-auth';
import { ForbiddenAppException, JsonResponse } from '@nathapp/nestjs-common';
import type { KodaPrincipal } from '../../auth/principal/koda-principal.types';
import { isUserPrincipal } from '../../auth/principal/koda-principal.types';
import { CurrentProject } from '../../projects/current-project.decorator';
import type { ProjectContext } from '../../projects/project-context';
import { ProjectMembershipGuard } from '../../projects/project-membership.guard';
import { ProjectPermission } from '../../projects/project-permission.decorator';
import { CreateScheduleDto } from './dto/create-schedule.dto';
import { ScheduleDto } from './dto/schedule.dto';
import { UpdateScheduleDto } from './dto/update-schedule.dto';
import { SchedulesService } from './schedules.service';

/** Project ADMIN, which a global ADMIN resolves to (`ProjectContext.role`). The other half of "owner or project ADMIN". */
const canAdminister = (ctx: ProjectContext): boolean => ctx.role === 'ADMIN';

function requireUser(principal: KodaPrincipal): void {
  if (!isUserPrincipal(principal)) throw new ForbiddenAppException({}, 'projects');
}

/**
 * S1b §3.4 project routes (plan D202): any project member reads; create needs DEVELOPER+; edit, enable, disable and
 * delete need DEVELOPER+ and the schedule's owner or a project ADMIN.
 */
@ApiTags('fleet')
@ApiBearerAuth()
@ApiParam({ name: 'slug', required: true, schema: { type: 'string' } })
@Controller('projects/:slug/fleet/schedules')
@UseGuards(ProjectMembershipGuard)
export class ProjectFleetSchedulesController {
  constructor(private readonly schedules: SchedulesService) {}

  @Get()
  @ApiOperation({ summary: 'List the project\'s schedules (project member)' })
  @ApiResponse({ status: 200, type: [ScheduleDto] })
  async list(@CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    requireUser(principal);
    return JsonResponse.Ok(await this.schedules.list(ctx.project.id));
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a schedule (project member)' })
  @ApiResponse({ status: 200, type: ScheduleDto })
  @ApiResponse({ status: 404, description: 'Schedule not found in this project' })
  async get(@Param('id') id: string, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    requireUser(principal);
    return JsonResponse.Ok(await this.schedules.get(ctx.project.id, id));
  }

  @Post()
  @HttpCode(201)
  @ProjectPermission([CaslPermissionAction.CREATE, 'FleetJob'])
  @ApiOperation({ summary: 'Create a schedule that runs one feature on a cron (project DEVELOPER+)' })
  @ApiResponse({ status: 201, type: ScheduleDto })
  @ApiResponse({ status: 400, description: 'Invalid template, cron or timezone, or fleet.scheduleCronTooFrequent (fires closer than 15 minutes)' })
  @ApiResponse({ status: 404, description: 'Repo not in this project, or pinned runner unknown' })
  @ApiResponse({ status: 422, description: 'Pinned runner can never run this job' })
  async create(@Body() dto: CreateScheduleDto, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    return JsonResponse.Ok(await this.schedules.create(principal.id, ctx.project.id, dto));
  }

  @Patch(':id')
  @ProjectPermission([CaslPermissionAction.UPDATE, 'FleetJob'])
  @ApiOperation({ summary: 'Change a schedule (owner or project ADMIN)' })
  @ApiResponse({ status: 200, type: ScheduleDto })
  @ApiResponse({ status: 403, description: 'Not the owner and not a project ADMIN' })
  async update(@Param('id') id: string, @Body() dto: UpdateScheduleDto, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    return JsonResponse.Ok(await this.schedules.update(principal.id, ctx.project.id, id, dto, canAdminister(ctx)));
  }

  @Delete(':id')
  @HttpCode(204)
  @ProjectPermission([CaslPermissionAction.UPDATE, 'FleetJob'])
  @ApiOperation({ summary: 'Delete a schedule; its jobs are kept (owner or project ADMIN)' })
  async remove(@Param('id') id: string, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal): Promise<void> {
    await this.schedules.remove(principal.id, ctx.project.id, id, canAdminister(ctx));
  }

  @Post(':id/enable')
  @HttpCode(200)
  @ProjectPermission([CaslPermissionAction.UPDATE, 'FleetJob'])
  @ApiOperation({ summary: 'Enable a schedule: resets the stall counter and recomputes the next fire (owner or project ADMIN)' })
  @ApiResponse({ status: 200, type: ScheduleDto })
  async enable(@Param('id') id: string, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    return JsonResponse.Ok(await this.schedules.enable(principal.id, ctx.project.id, id, canAdminister(ctx)));
  }

  @Post(':id/disable')
  @HttpCode(200)
  @ProjectPermission([CaslPermissionAction.UPDATE, 'FleetJob'])
  @ApiOperation({ summary: 'Disable a schedule (owner or project ADMIN)' })
  @ApiResponse({ status: 200, type: ScheduleDto })
  async disable(@Param('id') id: string, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    return JsonResponse.Ok(await this.schedules.disable(principal.id, ctx.project.id, id, canAdminister(ctx)));
  }
}
```

Replace `apps/api/src/fleet/schedules/schedules.module.ts` with:

```ts
import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { ProjectAccessModule } from '../../projects/project-access.module';
import { FleetActivityModule } from '../activity/fleet-activity.module';
import { FleetJobsModule } from '../jobs/fleet-jobs.module';
import { ProjectFleetSchedulesController } from './project-fleet-schedules.controller';
import { ScheduleStoreModule } from './schedule-store.module';
import { ScheduleTicker } from './schedule-ticker';
import { SchedulesService } from './schedules.service';

/** S1b §3 C4 schedules (plan D192): ticker, management service and the project routes. */
@Module({
  imports: [PrismaModule, ProjectAccessModule, ScheduleStoreModule, FleetJobsModule, FleetActivityModule],
  controllers: [ProjectFleetSchedulesController],
  providers: [SchedulesService, ScheduleTicker],
  exports: [ScheduleTicker],
})
export class SchedulesModule {}
```

- [ ] **Step 9: Write the module guard and run the unit suites**

Create `apps/api/src/fleet/schedules/schedules.module.spec.ts`:

```ts
import { Test } from '@nestjs/testing';
import { GlobalStubsModule } from '../../common/test-helpers/global-stubs.module';
import { ProjectFleetSchedulesController } from './project-fleet-schedules.controller';
import { ScheduleProgressService } from './schedule-progress.service';
import { ScheduleTicker } from './schedule-ticker';
import { SchedulesModule } from './schedules.module';
import { SchedulesService } from './schedules.service';

/** DI guard, as budgets.module.spec.ts: a missing provider or an import cycle fails `bun run test`. */
describe('SchedulesModule', () => {
  it('compiles and resolves the ticker, the service, the progress service and the controller', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [GlobalStubsModule, SchedulesModule] }).compile();
    try {
      expect(moduleRef.get(ScheduleTicker)).toBeDefined();
      expect(moduleRef.get(SchedulesService)).toBeDefined();
      expect(moduleRef.get(ScheduleProgressService, { strict: false })).toBeDefined();
      expect(moduleRef.get(ProjectFleetSchedulesController)).toBeDefined();
    } finally {
      await moduleRef.close();
    }
  });
});
```

Run: `cd apps/api && bun run type-check && bun run test:scoped src/fleet`
Expected: PASS.

- [ ] **Step 10: Write the HTTP integration spec**

Create `apps/api/test/integration/fleet/fleet-schedules-api.integration.spec.ts`:

```ts
/**
 * Fleet S1b slice 3a — schedule management over HTTP: permissions, validation, enable/disable, delete (PG).
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-schedules-api.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, TEST_PASSWORD } from '../../helpers/http-app';
import { FleetHttpWorld, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

jest.setTimeout(30_000);

interface Row {
  id: string; name: string; cron: string; timezone: string; feature: string; ref: string; enabled: boolean; nextFireAt: string | null;
  disabledReason: string | null; lastPassedCount: number; noProgressTicks: number; noProgressLimit: number; totalCostUsd: string;
  createdById: string; pinnedRunnerId: string | null; profiles: string[];
}

describeIntegration('fleet schedules API (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let dev2: string;
  let n = 0;
  const as = (token: string) => ({ Authorization: `Bearer ${token}` });
  const tok = (who: keyof FleetHttpWorld['tokens']) => as(world.tokens[who]);
  const BASE = '/api/projects/web/fleet/schedules';
  const payload = (over: Record<string, unknown> = {}) => ({
    name: 'nightly', repoId: world.repoId, feature: `api${++n}`, cron: '0 9 * * 1-5', timezone: 'asia/singapore', maxCostUsd: 5, ...over,
  });
  const create = async (who: keyof FleetHttpWorld['tokens'] = 'dev', over: Record<string, unknown> = {}) =>
    data<Row>(await request(server).post(BASE).set(tok(who)).send(payload(over)).expect(201));

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(server, prisma);
    // A second DEVELOPER of web (fourth login: within the 5/min throttle). The root global admin stands in for a project ADMIN.
    await request(server).post('/api/admin/users').set(tok('root')).send({ email: 'dev2@koda.test', name: 'dev2', password: TEST_PASSWORD, role: 'MEMBER' }).expect(201);
    await request(server).post('/api/projects/web/members').set(tok('root')).send({ email: 'dev2@koda.test', role: 'DEVELOPER' }).expect(201);
    dev2 = await loginToken(server, 'dev2@koda.test');
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await prisma.fleetJob.deleteMany();
    await prisma.jobSchedule.deleteMany();
    await prisma.fleetActivity.deleteMany();
  });

  it('a developer creates a schedule: normalised template, repo default branch, next fire in the future, owner recorded', async () => {
    const row = await create();
    expect(row).toEqual(expect.objectContaining({
      name: 'nightly', cron: '0 9 * * 1-5', timezone: 'Asia/Singapore', ref: 'trunk', enabled: true, disabledReason: null,
      noProgressLimit: 3, noProgressTicks: 0, lastPassedCount: 0, totalCostUsd: '0.0000', createdById: world.ids.dev, pinnedRunnerId: null, profiles: [],
    }));
    expect(new Date(row.nextFireAt as string).getTime()).toBeGreaterThan(Date.now());
    expect(await prisma.fleetActivity.count({ where: { entityType: 'schedule', entityId: row.id, action: 'schedule.created', projectId: world.projectId } })).toBe(1);
  });

  it('a viewer reads but cannot create; an outsider cannot read', async () => {
    const row = await create();
    await request(server).post(BASE).set(tok('viewer')).send(payload()).expect(403);
    expect(data<Row[]>(await request(server).get(BASE).set(tok('viewer')).expect(200)).map((r) => r.id)).toEqual([row.id]);
    expect(data<Row>(await request(server).get(`${BASE}/${row.id}`).set(tok('viewer')).expect(200)).id).toBe(row.id);
    await request(server).get(BASE).set(tok('outsider')).expect(403);
  });

  it.each([
    ['a cron with four fields', { cron: '* * * *' }],
    ['a cron with six fields', { cron: '* * * * * *' }],
    ['an unknown timezone', { timezone: 'Mars/Base' }],
    ['a feature that is not a single path segment', { feature: '../etc' }],
    ['a reserved profile', { profiles: ['koda-job-x'] }],
    ['a zero budget', { maxCostUsd: 0 }],
    ['a stall limit of zero', { noProgressLimit: 0 }],
    ['a blank name', { name: '   ' }],
  ])('refuses %s with 400', async (_name, over) => {
    await request(server).post(BASE).set(tok('dev')).send(payload(over)).expect(400);
  });

  it('refuses a cron that fires more often than every 15 minutes, saying so', async () => {
    const res = await request(server).post(BASE).set(tok('dev')).send(payload({ cron: '*/10 * * * *' })).expect(400);
    expect(res.body.message).toContain('15 minutes');
    expect(await prisma.jobSchedule.count()).toBe(0);
  });

  it('answers 404 for a repo of another project and for an unknown pinned runner', async () => {
    await request(server).post(BASE).set(tok('dev')).send(payload({ repoId: world.foreignRepoId })).expect(404);
    await request(server).post(BASE).set(tok('dev')).send(payload({ pinnedRunnerId: 'ghost' })).expect(404);
  });

  it('the owner edits; a cron change moves nextFireAt; another developer is refused; a project ADMIN may', async () => {
    const row = await create();
    const edited = data<Row>(await request(server).patch(`${BASE}/${row.id}`).set(tok('dev')).send({ cron: '0 6 * * *', timezone: 'UTC', name: 'morning' }).expect(200));
    expect(edited).toEqual(expect.objectContaining({ cron: '0 6 * * *', timezone: 'UTC', name: 'morning', feature: row.feature }));
    expect(new Date(edited.nextFireAt as string).getUTCHours()).toBe(6);
    await request(server).patch(`${BASE}/${row.id}`).set(as(dev2)).send({ name: 'hijack' }).expect(403);
    const byAdmin = data<Row>(await request(server).patch(`${BASE}/${row.id}`).set(tok('root')).send({ noProgressLimit: 5 }).expect(200));
    expect(byAdmin.noProgressLimit).toBe(5);
    await request(server).patch(`${BASE}/${row.id}`).set(tok('viewer')).send({ name: 'x' }).expect(403);
  });

  it('disable records a manual reason and clears nextFireAt; enable resets the stall counter, keeps lastPassedCount, and sets nextFireAt', async () => {
    const row = await create();
    await prisma.jobSchedule.update({ where: { id: row.id }, data: { noProgressTicks: 2, lastPassedCount: 4 } });
    await request(server).post(`${BASE}/${row.id}/disable`).set(as(dev2)).expect(403);
    const off = data<Row>(await request(server).post(`${BASE}/${row.id}/disable`).set(tok('dev')).expect(200));
    expect(off).toEqual(expect.objectContaining({ enabled: false, disabledReason: 'manual', nextFireAt: null }));
    expect(await prisma.fleetActivity.count({ where: { entityId: row.id, action: 'schedule.disabled' } })).toBe(1);
    await request(server).post(`${BASE}/${row.id}/enable`).set(as(dev2)).expect(403);
    const on = data<Row>(await request(server).post(`${BASE}/${row.id}/enable`).set(tok('root')).expect(200));
    expect(on).toEqual(expect.objectContaining({ enabled: true, disabledReason: null, noProgressTicks: 0, lastPassedCount: 4 }));
    expect(new Date(on.nextFireAt as string).getTime()).toBeGreaterThan(Date.now());
  });

  it('delete is refused for a stranger and keeps the schedule\'s jobs, detached', async () => {
    const row = await create();
    const job = await prisma.fleetJob.create({
      data: {
        projectId: world.projectId, repoId: world.repoId, ref: 'trunk', command: 'RUN', feature: row.feature, profiles: [], maxCostUsd: new Prisma.Decimal(5),
        selectorLabels: [], requestedById: world.ids.dev, scheduleId: row.id, state: 'FAILED',
      },
    });
    await request(server).delete(`${BASE}/${row.id}`).set(as(dev2)).expect(403);
    await request(server).delete(`${BASE}/${row.id}`).set(tok('dev')).expect(204);
    await request(server).get(`${BASE}/${row.id}`).set(tok('dev')).expect(404);
    expect((await prisma.fleetJob.findUniqueOrThrow({ where: { id: job.id } })).scheduleId).toBeNull();
    expect(await prisma.fleetActivity.count({ where: { entityId: row.id, action: 'schedule.deleted' } })).toBe(1);
  });

  it('totalCostUsd adds the cost of the schedule\'s jobs', async () => {
    const row = await create();
    await prisma.fleetJob.create({
      data: {
        projectId: world.projectId, repoId: world.repoId, ref: 'trunk', command: 'RUN', feature: row.feature, profiles: [], maxCostUsd: new Prisma.Decimal(5),
        selectorLabels: [], requestedById: world.ids.dev, scheduleId: row.id, state: 'FAILED', costSpentUsd: new Prisma.Decimal('1.5'), costCarriedUsd: new Prisma.Decimal('0.25'),
      },
    });
    expect(data<Row[]>(await request(server).get(BASE).set(tok('dev')).expect(200))[0].totalCostUsd).toBe('1.7500');
  });

  it('another project cannot see or touch the schedule (404)', async () => {
    const row = await create();
    await request(server).get(`/api/projects/ops/fleet/schedules/${row.id}`).set(tok('root')).expect(404);
    await request(server).post(`/api/projects/ops/fleet/schedules/${row.id}/disable`).set(tok('root')).expect(404);
  });

  it('schedule rows are readable through fleet/activity by entity type', async () => {
    const row = await create();
    const page = data<{ records: Array<{ entityId: string; action: string }> }>(
      await request(server).get('/api/fleet/activity?entityType=schedule').set(tok('root')).expect(200),
    );
    expect(page.records).toEqual(expect.arrayContaining([expect.objectContaining({ entityId: row.id, action: 'schedule.created' })]));
  });
});
```

- [ ] **Step 11: Run the HTTP spec**

Run: `cd apps/api && bun run test:scoped test/integration/fleet/fleet-schedules-api.integration.spec.ts`
Expected: PASS (18 cases). If a whole file fails in under a millisecond with only a `loginToken` frame in the stack,
it is the known local login throttle: wait a minute and rerun that file alone.

- [ ] **Step 12: Lint and commit**

Run: `cd apps/api && bun run lint`
Expected: PASS with no warnings. Fix any unused import (for example `MaxLength` in the update DTO) before
committing.

```bash
git add apps/api/src apps/api/test
git commit -m "feat(fleet): schedule management API with owner-or-admin rules"
```

---

### Task 9: OpenAPI contract and the generated CLI client

**Files:**
- Modify: `apps/api/src/fleet/fleet-openapi.contract.spec.ts`
- Modify: `openapi.json` (generated)

**Interfaces:**
- Produces: `openapi.json` with `/api/projects/{slug}/fleet/schedules` (+ `/{id}`, `/{id}/enable`, `/{id}/disable`),
  schemas `ScheduleDto`, `CreateScheduleDto`, `UpdateScheduleDto`, the `scheduleId` query parameter on the job list,
  and `scheduleId` / `coalescedCount` on `FleetJobDto`. The CLI client gets
  `projectFleetSchedulesController{List,Get,Create,Update,Remove,Enable,Disable}`.

- [ ] **Step 1: Write the failing contract test**

In `apps/api/src/fleet/fleet-openapi.contract.spec.ts`, add this case as the last `it` in the `describe`:

```ts
  it('exposes the schedule routes, the job schedule filter and the job schedule fields (S1b §3.4)', () => {
    const base = '/api/projects/{slug}/fleet/schedules';
    expect(spec.paths[base]?.['get']).toBeDefined();
    expect(spec.paths[base]?.['post']).toBeDefined();
    expect(spec.paths[`${base}/{id}`]?.['get']).toBeDefined();
    expect(spec.paths[`${base}/{id}`]?.['patch']).toBeDefined();
    expect(spec.paths[`${base}/{id}`]?.['delete']).toBeDefined();
    expect(spec.paths[`${base}/{id}/enable`]?.['post']).toBeDefined();
    expect(spec.paths[`${base}/{id}/disable`]?.['post']).toBeDefined();
    expect(Object.keys(spec.components.schemas['ScheduleDto']?.properties ?? {}))
      .toEqual(expect.arrayContaining(['cron', 'timezone', 'feature', 'enabled', 'nextFireAt', 'disabledReason', 'noProgressTicks', 'lastPassedCount', 'totalCostUsd']));
    expect(Object.keys(spec.components.schemas['FleetJobDto']?.properties ?? {})).toEqual(expect.arrayContaining(['scheduleId', 'coalescedCount']));
    const listParams = spec.paths['/api/projects/{slug}/fleet/jobs']?.['get']?.parameters ?? [];
    expect(listParams.map((p) => p.name)).toContain('scheduleId');
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && bun run test:scoped src/fleet/fleet-openapi.contract.spec.ts`
Expected: FAIL (the committed `openapi.json` has no schedule routes yet).

- [ ] **Step 3: Regenerate the contract and the client**

Run from the repo root (needs `apps/api/.env` from Task 0):

```bash
bun run generate
git status --short openapi.json
grep -c "projectFleetSchedulesControllerCreate" apps/cli/src/generated/sdk.gen.ts
```
Expected: `openapi.json` modified; the grep prints a count of at least 1 (if the generated file has another name,
`grep -rl projectFleetSchedulesControllerCreate apps/cli/src/generated`). If `api:export-spec` exits 1 with no
message, `apps/api/.env` is missing.

- [ ] **Step 4: Prove the contract is stable**

```bash
git add openapi.json
bun run generate
git diff --exit-code openapi.json
```
Expected: exit code 0 (a second generate changes nothing).

- [ ] **Step 5: Run the contract spec and commit**

Run: `cd apps/api && bun run test:scoped src/fleet/fleet-openapi.contract.spec.ts`
Expected: PASS.

```bash
git add openapi.json apps/api/src/fleet/fleet-openapi.contract.spec.ts
git commit -m "feat(fleet): openapi contract for schedules"
```

---

### Task 10: `koda fleet schedule`

**Files:**
- Create: `apps/cli/src/commands/fleet-schedule.ts`
- Modify: `apps/cli/src/commands/fleet.ts`, `apps/cli/src/commands/fleet-shared.ts`
- Test: `apps/cli/src/commands/fleet-schedule.spec.ts`

**Interfaces:**
- Consumes: generated `projectFleetSchedulesController{List,Get,Create,Update,Remove,Enable,Disable}`,
  `fleetJobsControllerList`, types `ScheduleDto`, `CreateScheduleDto`, `UpdateScheduleDto`, `FleetJobDto`;
  `resolveRepo`, `resolveRunner`, `handleFleetValidation`, `FleetPage` from `fleet-shared`; `parseUsd`.
- Produces: `registerFleetSchedule(fleet: Command): void`; exported helpers `parseStallAfter(value): number`,
  `localTimezone(): string`, `scheduleState(s: ScheduleDto): string`, `passedOf(job: FleetJobDto): string`;
  `fleet-shared` gains `repoNamesOrEmpty(slug): Promise<ReadonlyMap<string, string>>`.

- [ ] **Step 1: Write the failing spec**

Create `apps/cli/src/commands/fleet-schedule.spec.ts`:

```ts
jest.mock('chalk', () => ({
  cyan: { bold: (s: string) => s }, gray: (s: string) => s, green: (s: string) => s, red: (s: string) => s, yellow: (s: string) => s,
}));
const mockStore = { get: jest.fn(() => ''), set: jest.fn() };
jest.mock('conf', () => jest.fn(() => mockStore));
jest.mock('../generated', () => ({
  projectFleetSchedulesControllerList: jest.fn(),
  projectFleetSchedulesControllerGet: jest.fn(),
  projectFleetSchedulesControllerCreate: jest.fn(),
  projectFleetSchedulesControllerUpdate: jest.fn(),
  projectFleetSchedulesControllerRemove: jest.fn(),
  projectFleetSchedulesControllerEnable: jest.fn(),
  projectFleetSchedulesControllerDisable: jest.fn(),
  fleetJobsControllerList: jest.fn(),
  projectFleetReposControllerList: jest.fn(),
  projectFleetRunnersControllerList: jest.fn(),
}));
jest.mock('../config', () => ({ resolveContext: jest.fn() }));

import { Command } from 'commander';
import { fleetCommand } from './fleet';
import { localTimezone, parseStallAfter, passedOf, scheduleState } from './fleet-schedule';
import {
  fleetJobsControllerList,
  projectFleetReposControllerList,
  projectFleetRunnersControllerList,
  projectFleetSchedulesControllerCreate,
  projectFleetSchedulesControllerDisable,
  projectFleetSchedulesControllerEnable,
  projectFleetSchedulesControllerGet,
  projectFleetSchedulesControllerList,
  projectFleetSchedulesControllerRemove,
  projectFleetSchedulesControllerUpdate,
} from '../generated';
import { resolveContext } from '../config';

const CTX = { apiKey: 'key', apiUrl: 'https://koda.example.com', projectSlug: 'web' };
const row = (over: Record<string, unknown> = {}) => ({
  id: 's1', projectId: 'p', repoId: 'fr1', name: 'nightly', cron: '0 9 * * 1-5', timezone: 'Asia/Singapore', feature: 'login', ref: 'main',
  profiles: [], maxCostUsd: '5', selectorLabels: [], pinnedRunnerId: null, enabled: true, nextFireAt: '2026-10-03T01:00:00.000Z',
  lastFiredAt: null, lastJobId: null, lastPassedCount: 0, noProgressTicks: 0, noProgressLimit: 3, disabledReason: null, totalCostUsd: '0.0000',
  createdById: 'u', updatedById: 'u', createdAt: '', updatedAt: '', ...over,
});
const ok = (data: unknown) => ({ ret: 0, data });
const REPOS = ok({ total: 1, current: 1, size: 100, hasNext: false, records: [{ id: 'fr1', projectId: 'p', provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'main' }] });
const RUNNERS = ok({ total: 1, current: 1, size: 100, hasNext: false, records: [{ id: 'run-1', name: 'box-1', online: true }] });

describe('koda fleet schedule', () => {
  let program: Command;
  let exitSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;
  const run = (...args: string[]) => program.parseAsync(['node', 'koda', 'fleet', 'schedule', ...args]);
  const out = () => logSpy.mock.calls.flat().join('\n');

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    fleetCommand(program);
    (resolveContext as jest.Mock).mockResolvedValue(CTX);
    (projectFleetReposControllerList as jest.Mock).mockResolvedValue(REPOS);
    (projectFleetRunnersControllerList as jest.Mock).mockResolvedValue(RUNNERS);
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => jest.clearAllMocks());

  it('parses the stall limit and labels the state', () => {
    expect(parseStallAfter('5')).toBe(5);
    expect(() => parseStallAfter('0')).toThrow();
    expect(() => parseStallAfter('21')).toThrow();
    expect(() => parseStallAfter('x')).toThrow();
    expect(scheduleState(row() as never)).toBe('enabled');
    expect(scheduleState(row({ enabled: false, disabledReason: 'no_progress' }) as never)).toBe('disabled (no_progress)');
    expect(passedOf({ progress: { passed: 2, total: 5 } } as never)).toBe('2/5');
    expect(passedOf({ progress: null } as never)).toBe('-');
    expect(localTimezone().length).toBeGreaterThan(0);
  });

  it('list prints repo names and the disabled reason; --json prints the rows', async () => {
    (projectFleetSchedulesControllerList as jest.Mock).mockResolvedValue(ok([row(), row({ id: 's2', enabled: false, disabledReason: 'completed', nextFireAt: null })]));
    await run('list');
    expect(projectFleetSchedulesControllerList).toHaveBeenCalledWith({ path: { slug: 'web' } });
    expect(out()).toContain('acme/app');
    expect(out()).toContain('disabled (completed)');
    logSpy.mockClear();
    await run('list', '--json');
    expect(JSON.parse(out())).toHaveLength(2);
    expect(exitSpy).toHaveBeenLastCalledWith(0);
  });

  it('add resolves the repo, sends only what was given, and the machine zone when --timezone is omitted', async () => {
    (projectFleetSchedulesControllerCreate as jest.Mock).mockResolvedValue(ok(row()));
    await run('add', '--repo', 'acme/app', '--feature', 'login', '--cron', '0 9 * * 1-5', '--max-cost', '5');
    expect(projectFleetSchedulesControllerCreate).toHaveBeenCalledWith({
      path: { slug: 'web' },
      body: { name: 'login', repoId: 'fr1', feature: 'login', cron: '0 9 * * 1-5', timezone: localTimezone(), maxCostUsd: 5 },
    });
    expect(out()).toContain('s1');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('add passes name, zone, ref, profiles, labels and the stall limit; --pin resolves a runner name', async () => {
    (projectFleetSchedulesControllerCreate as jest.Mock).mockResolvedValue(ok(row()));
    await run(
      'add', '--repo', 'fr1', '--feature', 'login', '--cron', '0 9 * * *', '--max-cost', '2.5', '--name', 'morning', '--timezone', 'UTC', '--ref', 'dev',
      '--profile', 'fast', '--profile', 'slow', '--pin', 'box-1', '--stall-after', '5',
    );
    expect(projectFleetSchedulesControllerCreate).toHaveBeenCalledWith({
      path: { slug: 'web' },
      body: {
        name: 'morning', repoId: 'fr1', feature: 'login', cron: '0 9 * * *', timezone: 'UTC', maxCostUsd: 2.5, ref: 'dev', profiles: ['fast', 'slow'],
        pinnedRunnerId: 'run-1', noProgressLimit: 5,
      },
    });
  });

  it('add refuses --pin with --label, an unknown repo and an unknown runner before any create (exit 3)', async () => {
    await run('add', '--repo', 'acme/app', '--feature', 'f', '--cron', '0 9 * * *', '--max-cost', '1', '--pin', 'box-1', '--label', 'linux');
    await run('add', '--repo', 'nope/none', '--feature', 'f', '--cron', '0 9 * * *', '--max-cost', '1');
    await run('add', '--repo', 'acme/app', '--feature', 'f', '--cron', '0 9 * * *', '--max-cost', '1', '--pin', 'ghost');
    expect(projectFleetSchedulesControllerCreate).not.toHaveBeenCalled();
    expect(exitSpy.mock.calls.filter((c) => c[0] === 3)).toHaveLength(3);
  });

  it('add maps an API 400 (cron too frequent) to exit 3', async () => {
    (projectFleetSchedulesControllerCreate as jest.Mock).mockRejectedValue({ ret: -2, status: 400, message: 'The schedule fires more often than every 15 minutes' });
    await run('add', '--repo', 'acme/app', '--feature', 'f', '--cron', '*/10 * * * *', '--max-cost', '1');
    expect(exitSpy).toHaveBeenCalledWith(3);
  });

  it('edit sends only the changed fields; --unpin sends null; --clear-labels sends []', async () => {
    (projectFleetSchedulesControllerUpdate as jest.Mock).mockResolvedValue(ok(row()));
    await run('edit', 's1', '--cron', '0 6 * * *', '--max-cost', '3');
    expect(projectFleetSchedulesControllerUpdate).toHaveBeenLastCalledWith({ path: { slug: 'web', id: 's1' }, body: { cron: '0 6 * * *', maxCostUsd: 3 } });
    await run('edit', 's1', '--unpin', '--clear-labels', '--clear-profiles');
    expect(projectFleetSchedulesControllerUpdate).toHaveBeenLastCalledWith({ path: { slug: 'web', id: 's1' }, body: { pinnedRunnerId: null, selectorLabels: [], profiles: [] } });
    await run('edit', 's1', '--profile', 'fast', '--pin', 'box-1', '--stall-after', '4');
    expect(projectFleetSchedulesControllerUpdate).toHaveBeenLastCalledWith({
      path: { slug: 'web', id: 's1' }, body: { profiles: ['fast'], pinnedRunnerId: 'run-1', noProgressLimit: 4 },
    });
  });

  it('edit with nothing to change, or --pin with --unpin, is a validation error', async () => {
    await run('edit', 's1');
    await run('edit', 's1', '--pin', 'box-1', '--unpin');
    expect(projectFleetSchedulesControllerUpdate).not.toHaveBeenCalled();
    expect(exitSpy.mock.calls.filter((c) => c[0] === 3)).toHaveLength(2);
  });

  it('show prints the schedule and its last jobs through the job list filter', async () => {
    (projectFleetSchedulesControllerGet as jest.Mock).mockResolvedValue(ok(row({ lastPassedCount: 3 })));
    (fleetJobsControllerList as jest.Mock).mockResolvedValue(ok({
      total: 1, current: 1, size: 10, hasNext: false,
      records: [{ id: 'j1', state: 'FAILED', progress: { passed: 3, total: 5 }, costSpentUsd: '1.2000', coalescedCount: 2, wipPush: 'pushed', stateReason: null }],
    }));
    await run('show', 's1');
    expect(projectFleetSchedulesControllerGet).toHaveBeenCalledWith({ path: { slug: 'web', id: 's1' } });
    expect(fleetJobsControllerList).toHaveBeenCalledWith({ path: { slug: 'web' }, query: { scheduleId: 's1', size: 10 } });
    expect(out()).toContain('3/5');
    expect(out()).toContain('pushed');
    expect(exitSpy).toHaveBeenLastCalledWith(0);
  });

  it('enable and disable call their routes; rm needs --force', async () => {
    (projectFleetSchedulesControllerEnable as jest.Mock).mockResolvedValue(ok(row()));
    (projectFleetSchedulesControllerDisable as jest.Mock).mockResolvedValue(ok(row({ enabled: false, disabledReason: 'manual', nextFireAt: null })));
    await run('enable', 's1');
    expect(projectFleetSchedulesControllerEnable).toHaveBeenCalledWith({ path: { slug: 'web', id: 's1' } });
    await run('disable', 's1');
    expect(projectFleetSchedulesControllerDisable).toHaveBeenCalledWith({ path: { slug: 'web', id: 's1' } });
    await run('rm', 's1');
    expect(projectFleetSchedulesControllerRemove).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
    (projectFleetSchedulesControllerRemove as jest.Mock).mockResolvedValue(undefined);
    await run('rm', 's1', '--force');
    expect(projectFleetSchedulesControllerRemove).toHaveBeenCalledWith({ path: { slug: 'web', id: 's1' } });
  });

  it('a 403 from edit (not the owner) exits 2, the CLI\'s auth-error code', async () => {
    (projectFleetSchedulesControllerUpdate as jest.Mock).mockRejectedValue({ statusCode: 403, message: 'Forbidden' });
    await run('edit', 's1', '--cron', '0 6 * * *');
    expect(exitSpy).toHaveBeenCalledWith(2);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/cli && bun run test -- src/commands/fleet-schedule.spec.ts`
Expected: FAIL (`Cannot find module './fleet-schedule'`). If the generated client lacks the schedule functions,
Task 9 Step 3 did not run: `cd /Users/williamkhoo/workspace/subrina-coder/projects/koda/repos/koda-slice3a && bun run generate:cli`.

- [ ] **Step 3: Add the repo-name lookup to `fleet-shared.ts`**

In `apps/cli/src/commands/fleet-shared.ts`, after `runnerNamesOrEmpty` add:

```ts
/** `owner/name` by repo id, for tables; an empty map when the lookup fails, so the table still prints ids. */
export async function repoNamesOrEmpty(slug: string): Promise<ReadonlyMap<string, string>> {
  try {
    return new Map((await projectRepos(slug)).map((r): [string, string] => [r.id, `${r.owner}/${r.name}`]));
  } catch {
    return new Map();
  }
}
```

- [ ] **Step 4: Write the command**

Create `apps/cli/src/commands/fleet-schedule.ts`:

```ts
import { Command, InvalidArgumentError } from 'commander';
import {
  fleetJobsControllerList,
  projectFleetSchedulesControllerCreate,
  projectFleetSchedulesControllerDisable,
  projectFleetSchedulesControllerEnable,
  projectFleetSchedulesControllerGet,
  projectFleetSchedulesControllerList,
  projectFleetSchedulesControllerRemove,
  projectFleetSchedulesControllerUpdate,
  type CreateScheduleDto,
  type FleetJobDto,
  type ScheduleDto,
  type UpdateScheduleDto,
} from '../generated';
import { unwrap } from '../utils/api';
import { withContext } from '../utils/context';
import { handleApiError } from '../utils/error';
import { requireForce } from '../utils/force';
import { table } from '../utils/output';
import { parseUsd } from '../utils/parse-usd';
import { type FleetPage, handleFleetValidation, repoNamesOrEmpty, resolveRepo, resolveRunner } from './fleet-shared';

const collect = (value: string, previous: string[]): string[] => [...previous, value];

/** 1-20: the stall limit (commander reads `--no-progress-limit` as a negation, so the option is `--stall-after`; plan D209). */
export function parseStallAfter(value: string): number {
  if (!/^\d{1,2}$/.test(value) || Number(value) < 1 || Number(value) > 20) throw new InvalidArgumentError('expected a whole number from 1 to 20');
  return Number(value);
}

/** The machine's IANA zone: the zone a user means by "9am" (plan D209). It is printed back by `add`. */
export function localTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

export function scheduleState(s: ScheduleDto): string {
  return s.enabled ? 'enabled' : `disabled (${s.disabledReason ?? 'unknown'})`;
}

/** `passed/total` of a job's nax progress, or `-`. */
export function passedOf(job: FleetJobDto): string {
  const p = job.progress as unknown as Record<string, unknown> | null;
  if (!p || typeof p['passed'] !== 'number') return '-';
  return `${p['passed']}/${typeof p['total'] === 'number' ? p['total'] : '?'}`;
}

function printSchedule(verb: string, s: ScheduleDto): void {
  console.log(`${verb} schedule ${s.id}: ${s.name}, ${s.feature} on ${s.cron} (${s.timezone}), ${scheduleState(s)}`);
  if (s.enabled && s.nextFireAt) console.log(`Next fire ${s.nextFireAt}`);
}

function registerList(schedule: Command): void {
  schedule
    .command('list')
    .description("List the project's schedules")
    .option('--project <slug>', 'Project slug (uses config if not provided)')
    .option('--json', 'Output as JSON')
    .action(async (options: { project?: string; json?: boolean }) => {
      try {
        const ctx = await withContext({ projectSlug: options.project });
        const rows = unwrap<ScheduleDto[]>(await projectFleetSchedulesControllerList({ path: { slug: ctx.projectSlug } }));
        if (options.json) {
          console.log(JSON.stringify(rows, null, 2));
        } else {
          const repos = await repoNamesOrEmpty(ctx.projectSlug);
          table(['ID', 'Name', 'Repo', 'Feature', 'Cron', 'Next fire / state', 'Last job'], rows.map((s) => [
            s.id, s.name, repos.get(s.repoId) ?? s.repoId, s.feature, `${s.cron} (${s.timezone})`,
            s.enabled ? (s.nextFireAt ?? '-') : scheduleState(s), s.lastJobId ?? '-',
          ]));
        }
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err);
      }
    });
}

function registerShow(schedule: Command): void {
  schedule
    .command('show <scheduleId>')
    .description("Show a schedule and the last 10 jobs it dispatched (passed stories, cost, coalesced ticks, WIP push, reason)")
    .option('--project <slug>', 'Project slug (uses config if not provided)')
    .option('--json', 'Output as JSON')
    .action(async (scheduleId: string, options: { project?: string; json?: boolean }) => {
      try {
        const ctx = await withContext({ projectSlug: options.project });
        const slug = ctx.projectSlug;
        const found = unwrap<ScheduleDto>(await projectFleetSchedulesControllerGet({ path: { slug, id: scheduleId } }));
        const page = unwrap<FleetPage<FleetJobDto>>(await fleetJobsControllerList({ path: { slug }, query: { scheduleId, size: 10 } }));
        if (options.json) {
          console.log(JSON.stringify({ schedule: found, jobs: page.records }, null, 2));
        } else {
          printSchedule('Schedule', found);
          console.log(`Template: ${found.maxCostUsd} USD per run, ref ${found.ref}, stalls after ${found.noProgressLimit} runs without progress (${found.noProgressTicks} so far)`);
          console.log(`Stories passed so far: ${found.lastPassedCount}; total cost $${found.totalCostUsd}`);
          table(['Job', 'State', 'Passed', 'Cost', 'Coalesced', 'WIP push', 'Reason'], page.records.map((j) => [
            j.id, j.state, passedOf(j), `$${j.costSpentUsd}`, String(j.coalescedCount), j.wipPush ?? '-', j.stateReason ?? '-',
          ]));
        }
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, { notFoundMessage: `Schedule not found: ${scheduleId}` });
      }
    });
}

interface AddOptions {
  repo: string; feature: string; cron: string; maxCost: number; name?: string; timezone?: string; ref?: string;
  profile: string[]; label: string[]; pin?: string; stallAfter?: number; project?: string; json?: boolean;
}

function registerAdd(schedule: Command): void {
  schedule
    .command('add')
    .description('Create a schedule that runs one feature on a cron until it is done (project DEVELOPER+)')
    .requiredOption('--repo <repo>', 'Repo id or owner/name (koda fleet repo list)')
    .requiredOption('--feature <name>', 'nax feature name')
    .requiredOption('--cron <expr>', 'Five-field cron, quoted: "0 9 * * 1-5" (fires at least 15 minutes apart)')
    .requiredOption('--max-cost <usd>', 'Budget of each run in USD, at most 4 decimals', parseUsd)
    .option('--name <name>', 'Display name (default: the feature)')
    .option('--timezone <iana>', 'Timezone the cron is read in (default: this machine\'s zone)')
    .option('--ref <ref>', 'Git ref to check out (default: the repo default branch)')
    .option('--profile <name>', 'nax profile, repeatable; later wins', collect, [] as string[])
    .option('--label <label>', 'Only runners with this label, repeatable', collect, [] as string[])
    .option('--pin <runner>', 'Run on this runner (id or name); excludes --label')
    .option('--stall-after <ticks>', 'Disable after this many runs in a row without a newly passed story (1-20, default 3)', parseStallAfter)
    .option('--project <slug>', 'Project slug (uses config if not provided)')
    .option('--json', 'Output as JSON')
    .action(async (o: AddOptions) => {
      try {
        const ctx = await withContext({ projectSlug: o.project });
        const slug = ctx.projectSlug;
        if (o.pin && o.label.length > 0) return handleFleetValidation('Use --label or --pin, not both: a pinned job ignores labels');
        const repo = await resolveRepo(slug, o.repo);
        if (!repo) return handleFleetValidation(`Unknown repo "${o.repo}" in project ${slug}: koda fleet repo list`);
        const pinned = o.pin ? await resolveRunner(slug, o.pin) : null;
        if (o.pin && !pinned) return handleFleetValidation(`Unknown runner "${o.pin}"`);
        const body: CreateScheduleDto = {
          name: o.name ?? o.feature, repoId: repo.id, feature: o.feature, cron: o.cron, timezone: o.timezone ?? localTimezone(), maxCostUsd: o.maxCost,
          ...(o.ref ? { ref: o.ref } : {}),
          ...(o.profile.length > 0 ? { profiles: o.profile } : {}),
          ...(o.label.length > 0 ? { selectorLabels: o.label } : {}),
          ...(pinned ? { pinnedRunnerId: pinned.id } : {}),
          ...(o.stallAfter !== undefined ? { noProgressLimit: o.stallAfter } : {}),
        };
        const created = unwrap<ScheduleDto>(await projectFleetSchedulesControllerCreate({ path: { slug }, body }));
        if (o.json) console.log(JSON.stringify(created, null, 2));
        else printSchedule('Created', created);
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err);
      }
    });
}

interface EditOptions {
  name?: string; cron?: string; timezone?: string; maxCost?: number; ref?: string; profile: string[]; label: string[]; pin?: string;
  unpin?: boolean; clearProfiles?: boolean; clearLabels?: boolean; stallAfter?: number; project?: string; json?: boolean;
}

/** Only the fields the user gave; `pinned` is the resolved runner id, null to unpin, undefined to leave alone. */
function editBody(o: EditOptions, pinned: string | null | undefined): UpdateScheduleDto {
  return {
    ...(o.name !== undefined ? { name: o.name } : {}),
    ...(o.cron !== undefined ? { cron: o.cron } : {}),
    ...(o.timezone !== undefined ? { timezone: o.timezone } : {}),
    ...(o.maxCost !== undefined ? { maxCostUsd: o.maxCost } : {}),
    ...(o.ref !== undefined ? { ref: o.ref } : {}),
    ...(o.clearProfiles ? { profiles: [] } : o.profile.length > 0 ? { profiles: o.profile } : {}),
    ...(o.clearLabels ? { selectorLabels: [] } : o.label.length > 0 ? { selectorLabels: o.label } : {}),
    ...(pinned !== undefined ? { pinnedRunnerId: pinned } : {}),
    ...(o.stallAfter !== undefined ? { noProgressLimit: o.stallAfter } : {}),
  };
}

function registerEdit(schedule: Command): void {
  schedule
    .command('edit <scheduleId>')
    .description('Change a schedule (the owner or a project ADMIN); the repo and the feature are fixed')
    .option('--name <name>', 'Display name')
    .option('--cron <expr>', 'Five-field cron, quoted')
    .option('--timezone <iana>', 'Timezone the cron is read in')
    .option('--max-cost <usd>', 'Budget of each run in USD', parseUsd)
    .option('--ref <ref>', 'Git ref to check out')
    .option('--profile <name>', 'Replace the profile chain; repeatable', collect, [] as string[])
    .option('--clear-profiles', 'Remove every profile')
    .option('--label <label>', 'Replace the selector labels; repeatable', collect, [] as string[])
    .option('--clear-labels', 'Remove every selector label')
    .option('--pin <runner>', 'Run on this runner (id or name)')
    .option('--unpin', 'Stop pinning to a runner')
    .option('--stall-after <ticks>', 'Disable after this many runs without a newly passed story (1-20)', parseStallAfter)
    .option('--project <slug>', 'Project slug (uses config if not provided)')
    .option('--json', 'Output as JSON')
    .action(async (scheduleId: string, o: EditOptions) => {
      try {
        const ctx = await withContext({ projectSlug: o.project });
        const slug = ctx.projectSlug;
        if (o.pin && o.unpin) return handleFleetValidation('Use --pin or --unpin, not both');
        let pinned: string | null | undefined = o.unpin ? null : undefined;
        if (o.pin) {
          const runner = await resolveRunner(slug, o.pin);
          if (!runner) return handleFleetValidation(`Unknown runner "${o.pin}"`);
          pinned = runner.id;
        }
        const body = editBody(o, pinned);
        if (Object.keys(body).length === 0) return handleFleetValidation('Nothing to change: give at least one option');
        const updated = unwrap<ScheduleDto>(await projectFleetSchedulesControllerUpdate({ path: { slug, id: scheduleId }, body }));
        if (o.json) console.log(JSON.stringify(updated, null, 2));
        else printSchedule('Updated', updated);
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, { notFoundMessage: `Schedule not found: ${scheduleId}` });
      }
    });
}

function registerToggle(schedule: Command, verb: 'enable' | 'disable'): void {
  schedule
    .command(`${verb} <scheduleId>`)
    .description(verb === 'enable'
      ? 'Enable a schedule: resets the stall counter and computes the next fire from now (the owner or a project ADMIN)'
      : 'Disable a schedule (the owner or a project ADMIN)')
    .option('--project <slug>', 'Project slug (uses config if not provided)')
    .option('--json', 'Output as JSON')
    .action(async (scheduleId: string, options: { project?: string; json?: boolean }) => {
      try {
        const ctx = await withContext({ projectSlug: options.project });
        const path = { slug: ctx.projectSlug, id: scheduleId };
        const result = unwrap<ScheduleDto>(verb === 'enable'
          ? await projectFleetSchedulesControllerEnable({ path })
          : await projectFleetSchedulesControllerDisable({ path }));
        if (options.json) console.log(JSON.stringify(result, null, 2));
        else printSchedule(verb === 'enable' ? 'Enabled' : 'Disabled', result);
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, { notFoundMessage: `Schedule not found: ${scheduleId}` });
      }
    });
}

function registerRemove(schedule: Command): void {
  schedule
    .command('rm <scheduleId>')
    .description("Delete a schedule; the jobs it dispatched are kept (the owner or a project ADMIN)")
    .option('--project <slug>', 'Project slug (uses config if not provided)')
    .option('--force', 'Confirm the deletion')
    .action(async (scheduleId: string, options: { project?: string; force?: boolean }) => {
      if (!requireForce(options.force)) return;
      try {
        const ctx = await withContext({ projectSlug: options.project });
        await projectFleetSchedulesControllerRemove({ path: { slug: ctx.projectSlug, id: scheduleId } });
        console.log(`Removed schedule ${scheduleId}`);
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, { notFoundMessage: `Schedule not found: ${scheduleId}` });
      }
    });
}

/** `koda fleet schedule …`: C4 cron schedules that drive one feature to done (S1b §3.4, plan D209). */
export function registerFleetSchedule(fleet: Command): void {
  const schedule = fleet.command('schedule');
  schedule.description('Fleet schedules: run one feature on a cron until it is done');
  registerList(schedule);
  registerShow(schedule);
  registerAdd(schedule);
  registerEdit(schedule);
  registerToggle(schedule, 'enable');
  registerToggle(schedule, 'disable');
  registerRemove(schedule);
}
```

In `apps/cli/src/commands/fleet.ts` add `import { registerFleetSchedule } from './fleet-schedule';` (after the
`fleet-runner` import), call `registerFleetSchedule(fleet);` after `registerFleetBudget(fleet);`, and change the doc
comment to
`/** \`koda fleet …\`: runners, repos, dispatch, jobs (fleet S1 spec §11), budgets (S1b §2.4) and schedules (S1b §3.4). */`.

- [ ] **Step 5: Run the CLI suites**

Run: `cd apps/cli && bun run test -- src/commands/fleet-schedule.spec.ts src/commands/fleet.spec.ts src/commands/fleet-shared.spec.ts && bun run lint && bun run build`
Expected: PASS (all schedule cases; `fleet.spec.ts` still passes; lint and tsc clean).

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/commands
git commit -m "feat(cli): koda fleet schedule list|show|add|edit|rm|enable|disable"
```

---

### Task 11: Whole-slice verification, docs and restoring `.env.test`

**Files:**
- Modify: `docs/superpowers/specs/2026-10-01-fleet-s1b-budgets-schedules-design.md` (§3.3, §3.4 notes)
- Modify: `.nax/mono/apps/api/context.md` (Fleet section), then regenerate the agent files
- Modify: `docs/deployment/runner.md` (CLI list)

- [ ] **Step 1: Spec notes**

In the spec §3.3, replace the rule line
`2. `CANCELLED` (by a user or a budget) → no change to either counter.` with:

```markdown
2. `CANCELLED` (by a user or a budget) → no change to either counter, and the job is **not** marked counted (3a
   plan D195): a user requeue of it that later ends is counted then.
```

In §3.4, after the "Web (3b)" bullet list, add:

```markdown
- Additive job API for the 3b history (3a plan D205): `FleetJobDto` carries `scheduleId` and `coalescedCount`,
  `GET /projects/:slug/fleet/jobs` takes a `scheduleId` filter, and `ScheduleDto` carries `totalCostUsd`.
- Edit and permission details (3a plan D202, D203): the repo and the feature are fixed after create; edit, enable,
  disable and delete need project DEVELOPER+ and the owner or a project ADMIN; the schedule list is a plain array.
```

- [ ] **Step 2: API agent context and the runner doc**

In `.nax/mono/apps/api/context.md`, Fleet section, after the "Budgets (`src/fleet/budgets/`, ...)" line add:

```markdown
- Schedules (`src/fleet/schedules/`, S1b spec §3): `cron-schedule.ts` is the only importer of `cron-parser` (five fields, zone proof, 15-minute gap). The ticker claims a due schedule by compare-and-set on `nextFireAt`, then calls `FleetJobsService.dispatch` with no transaction open; a unique violation inside a transaction would abort it. A scheduled job's end is counted in `JobTransitionsService.apply` through `ScheduleProgressService` (same transaction, counted once through `scheduleCountedAt`). `JobSchedule.repoId` and `pinnedRunnerId` have no foreign key on purpose: a deleted repo or runner disables the schedule (`template_invalid`) instead of deleting it.
```

In `docs/deployment/runner.md`, in the `koda fleet` command block, after the
`koda fleet budget resume <policyId> --amount 80 --project web` line add:

```bash
koda fleet schedule add --repo acme/app --feature login --cron "0 9 * * 1-5" --timezone Asia/Singapore --max-cost 5
koda fleet schedule list                            # next fire, or disabled (completed / no_progress / ...)
koda fleet schedule show <scheduleId>               # the template and the last 10 jobs it dispatched
koda fleet schedule disable <scheduleId>
```

and, in the prose below that block, add one sentence: "A schedule dispatches one RUN of its feature at each fire,
continues it on whichever runner is free, and disables itself when the feature completes, when its finish fails
with every story passed, or after three runs in a row without a newly passed story."

From the repo root regenerate the agent files (local, not a billed run): `nax generate && nax generate --all-packages`.
Include every regenerated file in the commit. Never edit generated `AGENTS.md` / `CLAUDE.md` by hand.

- [ ] **Step 3: Repo-wide checks**

From the repo root:

Run: `bun run type-check && bun run lint && bun run test`
Expected: all workspaces pass.

Run: `bun run generate && git status --short openapi.json`
Expected: no changes (Task 9 committed the contract).

Run every integration suite this slice added or touched:

```bash
cd apps/api && bun run test:scoped \
  test/integration/fleet/fleet-schedules-schema.integration.spec.ts \
  test/integration/fleet/fleet-schedule-repository.integration.spec.ts \
  test/integration/fleet/fleet-schedule-progress.integration.spec.ts \
  test/integration/fleet/fleet-jobs-schedule-link.integration.spec.ts \
  test/integration/fleet/fleet-schedule-ticker.integration.spec.ts \
  test/integration/fleet/fleet-schedules-api.integration.spec.ts \
  test/integration/fleet/fleet-jobs.integration.spec.ts \
  test/integration/fleet/fleet-job-cancel-requeue.integration.spec.ts \
  test/integration/fleet/placement.integration.spec.ts \
  test/integration/fleet/fleet-budget-enforcement.integration.spec.ts \
  test/integration/fleet/fleet-budget-cancel.integration.spec.ts \
  test/integration/fleet/runner-sync.integration.spec.ts \
  test/integration/fleet/runner-sync-lifecycle.integration.spec.ts \
  test/integration/fleet/fleet-sweep.integration.spec.ts \
  test/integration/fleet/fleet-admin-guards.integration.spec.ts
```

Expected: PASS. Then the whole fleet integration directory once: `bun run test:scoped test/integration/fleet`, and the
two time-sensitive suites under a non-UTC zone:
`TZ=Asia/Singapore bun run test:scoped src/fleet/schedules test/integration/fleet/fleet-schedule-ticker.integration.spec.ts`.

This slice touches no runner code and no protocol package, so the runner integration harness (which runs the API
`dist`) needs no rebuild; if `git diff main --stat -- apps/runner packages` is not empty, something unexpected
changed: stop and look.

- [ ] **Step 4: Restore `.env.test` and drop the private databases**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/koda/repos/koda-slice3a/apps/api
git update-index --no-skip-worktree .env.test
git checkout -- .env.test
git status --short .env.test
grep DATABASE_URL .env.test
for db in koda_slice3a_test koda_slice3a_shadow; do
  docker compose -f ../../docker-compose.test.yml exec -T postgres-test dropdb -U koda --if-exists "$db"
done
```
Expected: `git status` prints nothing and `DATABASE_URL` is the committed `.../koda_test`. Never drop `koda_test`.

- [ ] **Step 5: Commit**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/koda/repos/koda-slice3a
git add docs/superpowers/specs/2026-10-01-fleet-s1b-budgets-schedules-design.md .nax/mono/apps/api/context.md docs/deployment/runner.md
git add -u   # the agent files nax generate rewrote
git status --short
git commit -m "docs(fleet): S1b spec notes and api context for schedules"
```
Expected: `git status` shows nothing else staged or modified (in particular not `apps/api/.env.test`).

- [ ] **Step 6: PR notes to carry (do not push; the human pushes)**

The PR body must state: the new dependency `cron-parser` (D190) and the five-field and zone handling (D191); the
spec narrowings D194 (detach before delete), D195 (CANCELLED is not marked counted), D197 (a disabled schedule keeps
its reason), D199 (dispatch error mapping), D201-D203 (owner access, permissions, fixed repo and feature), D205 (the
additive job API fields and `scheduleId` filter); the known limits D191 (the 15-minute check is a 100-fire sample)
and D198 (a crash between claim and dispatch loses that one fire; single-instance assumption, no distributed lock);
D210 (endpoint coverage lives in `test/integration/fleet`); and that slice 3b (web and E2E) builds on it.

---

## Spec coverage

| Spec | Where |
|:--|:--|
| §3.1 model, partial unique index, template validated by the dispatch rules, `cron-parser`, 15-minute rule | Task 1 (schema, migration, `PARTIAL_UNIQUE_INDEXES`), Task 2 (cron), Task 8 (`checkTemplate`) |
| §3.2 ticker: due load, CAS claim, missed-fire collapse, fire table, dispatch outcome table, `scheduleId` on `dispatch` | Task 6 (dispatch), Task 7 (ticker, unit and PG) |
| §3.3 auto-disable rules 1-6, counted once, activity + webhook, re-enable | Task 3 (verdict), Task 5 (service, hook, PG), Task 8 (`enable`) |
| §3.4 permissions, API, CLI | Task 8 (routes, owner-or-admin), Task 10 (CLI) |
| §4 error codes, i18n, webhooks, activity, one migration, OpenAPI and CLI client | Task 8 (i18n, activity), Task 5 (webhook), Task 1 (migration, entity type), Task 9 (contract) |
| §3.5 3a unit and integration tests | Tasks 2, 3, 5, 7, 8 (the cases named there are each a numbered test in those tasks) |
| §5 depends on 1a and 2a | Dispatch goes through `FleetJobsService.dispatch` (2a `BudgetGate`, `fleet.budgetPaused`); `wipPush` is read by 3b from the job DTO |
| Out of scope | Slice 3b (web, Playwright E2E) |
