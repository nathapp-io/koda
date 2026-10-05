# Fleet S2b (c) Slice 1 — Dashboard API + CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the fleet dashboard snapshot (`GET /fleet/dashboard` for global admins, `GET /projects/:slug/fleet/dashboard` for project members) with its four attention rules, and the `koda fleet status` CLI command.

**Architecture:** A new read-only `src/fleet/dashboard/` NestJS module. It reads runners, jobs, approvals and budget pauses with plain non-locking Prisma queries and builds one self-consistent snapshot per request. The attention rules are pure functions. The "queued but not placed" rule reuses the dispatch placement rules through a newly extracted `evaluateRunners`, so dispatch and dashboard cannot drift. The CLI command is a thin client over the generated OpenAPI client.

**Tech Stack:** NestJS 11 + Fastify, Prisma on PostgreSQL 16, Jest (unit + PG integration via `bun run test:scoped`), Commander.js 12, `@hey-api` generated CLI client.

**Spec:** `docs/superpowers/specs/2026-10-05-fleet-s2b-c-dashboard-design.md` (§1-§3, §5, §6 slice 1). Slice 2 (web + E2E) is a separate plan.

## Global Constraints

- No change to the runner, the runner protocol, the sync path or the database schema (spec success criterion 6). No Prisma migration.
- No new Prisma enums; states are the string constants in `apps/api/src/common/enums.ts`.
- The API returns **no prose** for attention items: structured fields only (repo i18n rule; spec §2).
- Money in DTOs is a decimal string from the Prisma `Decimal` via `.toString()` (same as `toJob` in `prisma-fleet-job.repository.ts`); never a `Decimal` or a float.
- Project scope never reveals another project's job ids, features, repos or slugs, nor any credential provider name, `expiresAt` or nax/daemon version (spec §1.5).
- Agent principals get 403 on the project route (`assertUser`, like `project-fleet-analytics.controller.ts`).
- Caps: active jobs 200 (`activeTruncated`), recent jobs 20 within 24 h (`recentTruncated`), dry-run window = the globally oldest 50 QUEUED jobs (`QUEUED_SCAN_LIMIT`), reasons per item 20 (`reasonsTotal`).
- New config keys and defaults: `FLEET_JOB_SILENT_SEC` 180, `FLEET_JOB_SILENT_ERROR_SEC` 600, `FLEET_JOB_START_SEC` 300, `FLEET_JOB_QUEUED_WARN_SEC` 60, each bounded in `env.validation.ts` like the other numeric `FLEET_*` keys. No cross-field validation; the silent rule reads the error threshold as `max(error, silent)` (an inverted pair goes straight to error).
- OAuth `stored.expires` / `expired` never raise anything (placement ignores access-token expiry).
- Never edit `apps/cli/src/generated/**` or generated `AGENTS.md`/`CLAUDE.md` by hand; regenerate (`bun run generate`, `nax generate`).
- No emojis in code, comments or docs. Immutable style (no in-place mutation of inputs; local accumulators inside a function are fine where the surrounding code does the same).
- Never switch branches during execution; work on `feat/fleet-s2b-dashboard`.
- Integration specs need the test Postgres: `cd apps/api && bun run test:db:up` once. Never run two DB-mode jest runs at the same time (each force-resets the test DB).

## Review Focus

- **A job whose runner is offline**: expect exactly one item (the runner's `runner_unhealthy` with `jobsHeld`), never an extra `job_silent` per job. Pinned in Task 2 (`job_silent` skips offline runners) and Task 4 (`buildAttention` end-to-end).
- **A long but healthy RUNNING phase**: nax heartbeats every 60 s, so a job whose last heartbeat is 170 s old must raise nothing. Pinned in Task 2 (179 s gives no item).
- **A pinned QUEUED job**: only the pinned runner may appear in its reasons, and a fitting non-pinned runner must not hide the item. Pinned in Task 3.
- **Project-scope leak through attention**: another project's queued job, feature name or credential provider must not appear anywhere in the project JSON, including `reasons` and runner `conditions`. Pinned in Task 4 (`forProjectScope`) and Task 7 (HTTP JSON string search).
- **A runner with a corrupt capabilities blob**: the snapshot still answers 200, the runner shows `naxVersion: null`, and it is never a dry-run candidate. Pinned in Task 6 (`readCapabilities`) and Task 3 (unreadable runner excluded).

## Decisions (D402-D414)

| # | Decision |
|---|---|
| D402 | The dashboard module owns its read repository (`PrismaDashboardRepository`); it does not add methods to the jobs or approvals repositories. Only `placement-rules.ts` is shared. |
| D403 | `job_silent` and `job_waiting_approval` run over the fetched active list (at most 200). With `activeTruncated`, jobs past the cap get no job item; acceptable at home-fleet scale. |
| D404 | `FLEET_JOB_SILENT_SEC` default 180 (nax heartbeat every 60 s, `nax/packages/nax/src/execution/crash-heartbeat.ts`). |
| D405 | Credential condition `why: 'missing'` when a provider in the runner's own profiles has no credential row at all (mirrors `provider_missing`). An `api-key` credential already reported as missing/unavailable is not reported again as expired. |
| D406 | No `pinned_missing` verdict: `FleetJob.pinnedRunner` is `onDelete: SetNull`. A pinned runner with unreadable capabilities leaves zero candidates, so the verdict is `no_runners`. |
| D407 | The dry-run window is read exactly like `findQueuedIds` (all projects, oldest first, 50). Items for jobs of soft-deleted projects are dropped. |
| D408 | Verdicts: job scope paused gives `budget_paused`; every candidate `budget_paused` gives `runners_paused`. For `fits_not_placed`, `reasons` lists only the misfit runners. |
| D409 | The CLI uses `--all-projects` for the admin route, like `koda fleet analytics spend`; default is the project route. |
| D410 | `AttentionItemDto` is flat (optional per-kind fields); nested `AttentionReasonDto` / `RunnerConditionDto` are referenced by `type` and listed in `@ApiExtraModels`. |
| D411 | Snapshot reads run with `Promise.all` and no transaction; `generatedAt` is the `now` the controller passes, taken before the reads. |
| D412 | nax version compare uses the numeric core `major.minor.patch` (regex `^v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]*)?$`); a prerelease suffix is ignored; unparsable is unknown. No `semver` dependency. |
| D413 | `toLoads`, `toPlacementJob` and `QUEUED_SCAN_LIMIT` move from `placement.service.ts` to `placement-rules.ts` (pure module); the two importers of `toPlacementJob` are updated. |
| D414 | `latest` for `stale_nax` = the highest core version among **enabled, online** runners with readable capabilities. |

## File Structure

| File | Responsibility |
|---|---|
| `apps/api/src/fleet/jobs/placement-rules.ts` (modify) | gains `QUEUED_SCAN_LIMIT`, `toLoads`, `toPlacementJob`, `evaluateRunners` |
| `apps/api/src/fleet/jobs/placement.service.ts` (modify) | `placeJob` calls `evaluateRunners`; local helpers removed |
| `apps/api/src/fleet/jobs/fleet-jobs.service.ts`, `apps/api/src/fleet/schedules/schedules.service.ts` (modify) | import `toPlacementJob` from `placement-rules` |
| `apps/api/src/fleet/dashboard/dashboard.types.ts` | row types, scope, thresholds, attention item types and enums, limits |
| `apps/api/src/fleet/dashboard/nax-version.ts` | core version parse / compare |
| `apps/api/src/fleet/dashboard/attention-jobs.ts` | `job_silent`, `job_waiting_approval`, `jobItem` helper |
| `apps/api/src/fleet/dashboard/attention-unplaceable.ts` | `job_unplaceable` dry-run |
| `apps/api/src/fleet/dashboard/attention-runners.ts` | `runner_unhealthy` |
| `apps/api/src/fleet/dashboard/attention-rules.ts` | `buildAttention`: combine, scope filter, project collapse, sort |
| `apps/api/src/fleet/dashboard/dashboard-view.ts` | `readCapabilities`, `buildDashboardView` (pure snapshot assembly) |
| `apps/api/src/fleet/dashboard/domain/dashboard.domain.ts` | repository interface + token |
| `apps/api/src/fleet/dashboard/prisma-dashboard.repository.ts` | the seven reads |
| `apps/api/src/fleet/dashboard/dashboard.service.ts` | `FleetDashboardService.snapshot` |
| `apps/api/src/fleet/dashboard/dto/fleet-dashboard.dto.ts` | Swagger DTO classes |
| `apps/api/src/fleet/dashboard/fleet-dashboard.controller.ts`, `project-fleet-dashboard.controller.ts` | routes |
| `apps/api/src/fleet/dashboard/dashboard.module.ts` | module wiring |
| `apps/api/src/common/test-helpers/fleet-dashboard.ts` | unit fixtures (rows, caps, thresholds, clock) |
| `apps/api/src/config/fleet.config.ts` (+ spec), `apps/api/src/common/test-helpers/fleet-config.ts` | four config keys |
| `apps/api/test/integration/fleet/fleet-dashboard-repository.integration.spec.ts` | repository reads (PG) |
| `apps/api/test/integration/fleet/fleet-dashboard-api.integration.spec.ts` | both routes, scopes, leak, bounds, placement parity (PG) |
| `apps/cli/src/commands/fleet-status.ts` (+ spec), `apps/cli/src/commands/fleet.ts` (modify) | `koda fleet status` |
| `openapi.json`, `apps/cli/src/generated/**` | regenerated |
| `.nax/mono/apps/api/context.md`, `.nax/mono/apps/cli/context.md` (+ generated agent files) | guidance pointers |

---

### Task 1: Extract `evaluateRunners` and the placement helpers

**Files:**
- Modify: `apps/api/src/fleet/jobs/placement-rules.ts`
- Modify: `apps/api/src/fleet/jobs/placement.service.ts`
- Modify: `apps/api/src/fleet/jobs/fleet-jobs.service.ts:21`
- Modify: `apps/api/src/fleet/schedules/schedules.service.ts:10`
- Test: `apps/api/src/fleet/jobs/placement-rules.spec.ts`

**Interfaces:**
- Consumes: existing `firstMisfit`, `EMPTY_LOAD`, `PlacementJob`, `PlacementRunner`, `RunnerLoad`, `MisfitReason` in `placement-rules.ts`.
- Produces (all exported from `placement-rules.ts`):
  - `QUEUED_SCAN_LIMIT = 50`
  - `toLoads(refs: readonly { runnerId: string; repoId: string }[]): ReadonlyMap<string, RunnerLoad>`
  - `toPlacementJob(job: Pick<FleetJobRecord, 'repoId' | 'profiles' | 'selectorLabels' | 'pinnedRunnerId' | 'bashMode'>, repo: Pick<FleetRepoRef, 'provider'>): PlacementJob`
  - `interface RunnerVerdict<R extends PlacementRunner> { runner: R; load: RunnerLoad; reason: MisfitReason | null }`
  - `evaluateRunners<R extends PlacementRunner>(job: PlacementJob, runners: readonly R[], loads: ReadonlyMap<string, RunnerLoad>, runnerPaused: (runnerId: string) => boolean, now: Date, offlineSec: number): Array<RunnerVerdict<R>>`

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/fleet/jobs/placement-rules.spec.ts` (keep every existing test). Change its first import line to:

```ts
import type { RunnerCapabilities } from '../common/protocol';
import {
  EMPTY_LOAD, evaluateRunners, firstMisfit, orderCandidates, PERMANENT_MISFITS, PlacementJob, PlacementRunner, QUEUED_SCAN_LIMIT,
  toLoads, toPlacementJob,
} from './placement-rules';
```

and append:

```ts
describe('evaluateRunners (S2b (c) §2.3)', () => {
  it('returns one verdict per runner, applying each runner pause and load', () => {
    const loads = new Map([['r2', { active: 1, repoIds: new Set(['other-repo']) }]]);
    const out = evaluateRunners(job(), [runner({ id: 'r1' }), runner({ id: 'r2' }), runner({ id: 'r3' })], loads, (id) => id === 'r3', NOW, 90);
    expect(out.map((v) => [v.runner.id, v.reason])).toEqual([['r1', null], ['r2', 'capacity'], ['r3', 'budget_paused']]);
    expect(out[2].runner.budgetPaused).toBe(true);
    expect(out[0].runner.budgetPaused).toBe(false);
    expect(out[0].load).toBe(EMPTY_LOAD);
  });

  it("keeps the caller's runner type (placeJob needs bootId back)", () => {
    const [v] = evaluateRunners(job(), [{ ...runner(), bootId: 'boot-9' }], new Map(), () => false, NOW, 90);
    expect(v.runner.bootId).toBe('boot-9');
  });

  it('agrees with firstMisfit for a pinned job: labels are ignored', () => {
    const pinned = job({ pinnedRunnerId: 'r1', selectorLabels: ['nope'] });
    const [v] = evaluateRunners(pinned, [runner()], new Map(), () => false, NOW, 90);
    expect(v.reason).toBe(misfit(pinned, runner()));
  });
});

describe('placement helpers moved from PlacementService (D413)', () => {
  it('toLoads counts held jobs and their repos per runner', () => {
    const loads = toLoads([{ runnerId: 'r1', repoId: 'a' }, { runnerId: 'r1', repoId: 'b' }, { runnerId: 'r2', repoId: 'a' }]);
    expect(loads.get('r1')).toEqual({ active: 2, repoIds: new Set(['a', 'b']) });
    expect(loads.get('r2')).toEqual({ active: 1, repoIds: new Set(['a']) });
    expect(loads.get('r3')).toBeUndefined();
  });

  it('toPlacementJob copies the placement fields and the repo provider', () => {
    expect(toPlacementJob({ repoId: 'x', profiles: ['p'], selectorLabels: ['l'], pinnedRunnerId: null, bashMode: 'gated' }, { provider: 'gitlab' }))
      .toEqual({ repoId: 'x', provider: 'gitlab', profiles: ['p'], selectorLabels: ['l'], pinnedRunnerId: null, bashMode: 'gated' });
  });

  it('keeps the placement scan window at 50', () => {
    expect(QUEUED_SCAN_LIMIT).toBe(50);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/api && bunx jest src/fleet/jobs/placement-rules.spec.ts`
Expected: FAIL. TypeScript reports that `evaluateRunners`, `QUEUED_SCAN_LIMIT`, `toLoads` and `toPlacementJob` are not exported from `./placement-rules`.

- [ ] **Step 3: Move the helpers and add `evaluateRunners`**

In `apps/api/src/fleet/jobs/placement-rules.ts`, change the first import line to:

```ts
import type { RunnerCapabilities, BashMode } from '../common/protocol';
import { isRunnerOnline } from '../common/runner-online';
import type { FleetJobRecord, FleetRepoRef } from './domain/fleet-job.domain';
```

Append at the end of the file:

```ts
/** Oldest-first scan window per fill (moved from placement.service.ts, D413). The dashboard dry-run reads the same window (S2b (c) §2.3). */
export const QUEUED_SCAN_LIMIT = 50;

/** Runner-held job refs -> per-runner load (moved from placement.service.ts, D413). */
export const toLoads = (refs: readonly { runnerId: string; repoId: string }[]): ReadonlyMap<string, RunnerLoad> =>
  refs.reduce((acc, { runnerId, repoId }) => {
    const prev = acc.get(runnerId) ?? EMPTY_LOAD;
    return new Map([...acc, [runnerId, { active: prev.active + 1, repoIds: new Set([...prev.repoIds, repoId]) }]]);
  }, new Map<string, RunnerLoad>());

export const toPlacementJob = (
  job: Pick<FleetJobRecord, 'repoId' | 'profiles' | 'selectorLabels' | 'pinnedRunnerId' | 'bashMode'>,
  repo: Pick<FleetRepoRef, 'provider'>,
): PlacementJob => ({
  repoId: job.repoId, provider: repo.provider, profiles: job.profiles, selectorLabels: job.selectorLabels, pinnedRunnerId: job.pinnedRunnerId, bashMode: job.bashMode,
});

export interface RunnerVerdict<R extends PlacementRunner = PlacementRunner> {
  runner: R;
  load: RunnerLoad;
  reason: MisfitReason | null;
}

/**
 * Spec §4 steps 1-3 for every candidate, with the runner's own budget pause applied. Shared by
 * PlacementService.placeJob and the dashboard dry-run (S2b (c) §2.3) so the two cannot drift.
 */
export function evaluateRunners<R extends PlacementRunner>(
  job: PlacementJob,
  runners: readonly R[],
  loads: ReadonlyMap<string, RunnerLoad>,
  runnerPaused: (runnerId: string) => boolean,
  now: Date,
  offlineSec: number,
): Array<RunnerVerdict<R>> {
  return runners.map((row) => {
    const runner = { ...row, budgetPaused: runnerPaused(row.id) };
    const load = loads.get(row.id) ?? EMPTY_LOAD;
    return { runner, load, reason: firstMisfit(job, runner, load, now, offlineSec) };
  });
}
```

(`domain/fleet-job.domain.ts` already does `import type { PlacementRunner } from '../placement-rules'`. Both directions are `import type`, so there is no runtime cycle.)

- [ ] **Step 4: Rewire `PlacementService`**

In `apps/api/src/fleet/jobs/placement.service.ts`:

1. Replace the `./placement-rules` import line with:

```ts
import { EMPTY_LOAD, evaluateRunners, firstMisfit, MisfitReason, orderCandidates, PlacementJob, QUEUED_SCAN_LIMIT, toLoads, toPlacementJob } from './placement-rules';
```

2. In the `./domain/fleet-job.domain` import, drop `ActiveJobRef` (no longer used):

```ts
import {
  FLEET_JOB_REPOSITORY, FleetJobRecord, FleetRepoRef, IFleetJobRepository, PlacementRunnerRow,
} from './domain/fleet-job.domain';
```

3. Delete the local `const QUEUED_SCAN_LIMIT = 50;` and its comment, the local `const toLoads = ...` block, and the local `export const toPlacementJob = ...` block.

4. In `placeJob`, replace

```ts
      const evaluated = runners.map((row) => {
        const runner = { ...row, budgetPaused: pauses.runnerPaused(row.id) };
        const load = loads.get(runner.id) ?? EMPTY_LOAD;
        return { runner, load, reason: firstMisfit(placementJob, runner, load, now, this.fleetConfig.runnerOfflineSec) };
      });
```

with

```ts
      const evaluated = evaluateRunners(placementJob, runners, loads, (id) => pauses.runnerPaused(id), now, this.fleetConfig.runnerOfflineSec);
```

`EMPTY_LOAD`, `firstMisfit` and `PlacementJob` stay imported: `evaluatePinned` (its `job: PlacementJob` parameter) and `fillRunner` still use them. `RunnerLoad` is dropped (only the removed `toLoads` used it).

- [ ] **Step 5: Update the two `toPlacementJob` importers**

Both files already import `PERMANENT_MISFITS` from `placement-rules` on the line above; merge into that import (no second import of the same module).

`apps/api/src/fleet/jobs/fleet-jobs.service.ts:20-21`: replace

```ts
import { PERMANENT_MISFITS } from './placement-rules';
import { PlacementService, toPlacementJob } from './placement.service';
```

with

```ts
import { PERMANENT_MISFITS, toPlacementJob } from './placement-rules';
import { PlacementService } from './placement.service';
```

`apps/api/src/fleet/schedules/schedules.service.ts:9-10`: replace

```ts
import { PERMANENT_MISFITS } from '../jobs/placement-rules';
import { PlacementService, toPlacementJob } from '../jobs/placement.service';
```

with

```ts
import { PERMANENT_MISFITS, toPlacementJob } from '../jobs/placement-rules';
import { PlacementService } from '../jobs/placement.service';
```

(Verify the exact current lines first with `grep -n "placement" <file>`; keep any other names already on those lines.)

- [ ] **Step 6: Run unit tests, type-check and lint**

Run: `cd apps/api && bunx jest src/fleet/jobs src/fleet/schedules && bun run type-check && bunx eslint src/fleet/jobs src/fleet/schedules --max-warnings=0`
Expected: all PASS. No unused imports (ESLint `--max-warnings=0`).

- [ ] **Step 7: Run the placement integration specs (behaviour unchanged)**

Run: `cd apps/api && bun run test:db:up && bun run test:scoped test/integration/fleet/fleet-budget-placement.integration.spec.ts test/integration/fleet/fleet-jobs.integration.spec.ts`
Expected: PASS (same counts as on main).

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/fleet/jobs/placement-rules.ts apps/api/src/fleet/jobs/placement-rules.spec.ts apps/api/src/fleet/jobs/placement.service.ts apps/api/src/fleet/jobs/fleet-jobs.service.ts apps/api/src/fleet/schedules/schedules.service.ts
git commit -m "refactor(fleet): extract evaluateRunners and placement helpers into placement-rules (D413)"
```

---

### Task 2: Dashboard types, nax version compare and the job rules

**Files:**
- Create: `apps/api/src/fleet/dashboard/dashboard.types.ts`
- Create: `apps/api/src/fleet/dashboard/nax-version.ts`
- Create: `apps/api/src/fleet/dashboard/attention-jobs.ts`
- Create: `apps/api/src/common/test-helpers/fleet-dashboard.ts`
- Test: `apps/api/src/fleet/dashboard/nax-version.spec.ts`
- Test: `apps/api/src/fleet/dashboard/attention-jobs.spec.ts`

**Interfaces:**
- Consumes: `isRunnerOnline` (`fleet/common/runner-online.ts`), `FleetJobState`/`FleetJobKind` (`common/enums.ts`), `FleetJobStory` (`jobs/domain/fleet-job.domain.ts`), `MisfitReason` (`jobs/placement-rules.ts`).
- Produces:
  - `dashboard.types.ts`: `DashboardScope`, `AttentionThresholds`, `DashboardRunnerRow`, `DashboardJobRow`, `DashboardRecentRow`, `PendingSummary`, `ATTENTION_KINDS`/`AttentionKind`, `SEVERITIES`/`Severity`, `UNPLACEABLE_VERDICTS`/`UnplaceableVerdict`, `CONDITION_TYPES`/`ConditionType`, `CREDENTIAL_WHY`/`CredentialWhy`, `MISFIT_REASONS`, `AttentionReason`, `RunnerCondition`, `AttentionItem`, `DASHBOARD_LIMITS`, `secondsSince(now, at)`
  - `nax-version.ts`: `type CoreVersion`, `parseCoreVersion(v)`, `compareCore(a, b)`, `formatCore(v)`
  - `attention-jobs.ts`: `jobItem(kind, job, severity, since, extra)`, `jobSilentItems(jobs, runnersById, now, t)`, `jobApprovalItems(jobs, pending, now)`
  - test helper: `DASH_NOW`, `secAgo(sec)`, `DASH_THRESHOLDS`, `dashCaps(over)`, `dashRunner(over)`, `dashJob(over)`

- [ ] **Step 1: Create the shared types (no behaviour, needed by the tests)**

Create `apps/api/src/fleet/dashboard/dashboard.types.ts`:

```ts
import type { FleetJobKind, FleetJobState } from '../../common/enums';
import type { BashMode, RunnerCapabilities } from '../common/protocol';
import type { FleetJobStory } from '../jobs/domain/fleet-job.domain';
import type { MisfitReason } from '../jobs/placement-rules';

/** S2b (c) spec §1.1. */
export type DashboardScope = { kind: 'global' } | { kind: 'project'; projectId: string };

/** Spec §2 thresholds, all in seconds (from IFleetConfig). */
export interface AttentionThresholds {
  runnerOfflineSec: number;
  jobSilentSec: number;
  jobSilentErrorSec: number;
  jobStartSec: number;
  jobQueuedWarnSec: number;
}

/** Spec §1.2 caps and windows. */
export const DASHBOARD_LIMITS = {
  activeJobs: 200,
  recentJobs: 20,
  recentWindowMs: 24 * 60 * 60 * 1000,
  reasonsShown: 20,
} as const;

/** A runner as the dashboard reads it; `capabilities` is null when the stored blob does not parse (spec §1.4). */
export interface DashboardRunnerRow {
  id: string;
  name: string;
  os: string;
  arch: string;
  labels: string[];
  enabled: boolean;
  lastSeenAt: Date;
  capacity: number;
  daemonVersion: string;
  capabilities: RunnerCapabilities | null;
}

/** An active (or dry-run QUEUED) job with what the rules and the DTO need. */
export interface DashboardJobRow {
  id: string;
  projectId: string;
  projectSlug: string;
  projectDeleted: boolean;
  repoId: string;
  repoOwner: string;
  repoName: string;
  provider: 'github' | 'gitlab';
  feature: string;
  command: FleetJobKind;
  state: FleetJobState;
  runnerId: string | null;
  currentStoryId: string | null;
  currentPhase: string | null;
  stories: FleetJobStory[] | null;
  storiesTruncated: boolean;
  /** Decimal as string. */
  costSpentUsd: string;
  /** Decimal as string. */
  maxCostUsd: string;
  queuedAt: Date;
  assignedAt: Date | null;
  startedAt: Date | null;
  lastHeartbeatAt: Date | null;
  profiles: string[];
  selectorLabels: string[];
  pinnedRunnerId: string | null;
  bashMode: BashMode;
}

/** A terminal job finished inside the recent window (spec §1.2). */
export interface DashboardRecentRow {
  id: string;
  projectSlug: string;
  repoOwner: string;
  repoName: string;
  feature: string;
  command: FleetJobKind;
  state: FleetJobState;
  stateReason: string | null;
  runnerName: string | null;
  /** Decimal as string. */
  costSpentUsd: string;
  startedAt: Date | null;
  finishedAt: Date;
  resultPrUrl: string | null;
}

export interface PendingSummary {
  jobId: string;
  count: number;
  oldestRequestedAt: Date;
}

export const ATTENTION_KINDS = ['job_silent', 'job_waiting_approval', 'job_unplaceable', 'runner_unhealthy'] as const;
export type AttentionKind = (typeof ATTENTION_KINDS)[number];
export const SEVERITIES = ['error', 'warning'] as const;
export type Severity = (typeof SEVERITIES)[number];
export const UNPLACEABLE_VERDICTS = ['never', 'budget_paused', 'runners_paused', 'waiting_capacity', 'no_fit', 'no_runners', 'fits_not_placed'] as const;
export type UnplaceableVerdict = (typeof UNPLACEABLE_VERDICTS)[number];
export const CONDITION_TYPES = ['offline', 'credential', 'stale_nax', 'configuration'] as const;
export type ConditionType = (typeof CONDITION_TYPES)[number];
export const CREDENTIAL_WHY = ['missing', 'unavailable', 'expired'] as const;
export type CredentialWhy = (typeof CREDENTIAL_WHY)[number];
/** Every MisfitReason, for the DTO enum (same list as PlacementMisfitDto). */
export const MISFIT_REASONS: readonly MisfitReason[] = [
  'disabled', 'offline', 'budget_paused', 'labels', 'executor', 'protocol', 'provider_missing', 'provider_unavailable', 'sandbox', 'tools',
  'approvals_relay', 'busy_repo', 'capacity',
];

export interface AttentionReason {
  runnerName: string;
  reason: MisfitReason;
}

export interface RunnerCondition {
  type: ConditionType;
  jobsHeld?: number;
  providerId?: string;
  why?: CredentialWhy;
  version?: string;
  latest?: string;
}

/** Spec §2: one flat shape; the per-kind fields are optional. No prose (repo i18n rule). */
export interface AttentionItem {
  key: string;
  kind: AttentionKind;
  severity: Severity;
  subjectType: 'job' | 'runner';
  subjectId: string;
  subjectName: string;
  projectSlug: string | null;
  since: string | null;
  stage?: 'starting' | 'running';
  silentSec?: number;
  runnerName?: string | null;
  pending?: number;
  oldestSec?: number;
  verdict?: UnplaceableVerdict;
  reasons?: AttentionReason[];
  reasonsTotal?: number;
  conditions?: RunnerCondition[];
}

/** Whole seconds from `at` to `now`, never negative. */
export const secondsSince = (now: Date, at: Date): number => Math.max(0, Math.floor((now.getTime() - at.getTime()) / 1000));
```

Create `apps/api/src/common/test-helpers/fleet-dashboard.ts`:

```ts
import type { RunnerCapabilities } from '../../fleet/common/protocol';
import type { AttentionThresholds, DashboardJobRow, DashboardRunnerRow } from '../../fleet/dashboard/dashboard.types';

/** Fixed clock for dashboard unit specs. */
export const DASH_NOW = new Date('2026-10-05T12:00:00.000Z');
export const secAgo = (sec: number): Date => new Date(DASH_NOW.getTime() - sec * 1000);

/** The spec §2 defaults. */
export const DASH_THRESHOLDS: AttentionThresholds = {
  runnerOfflineSec: 90, jobSilentSec: 180, jobSilentErrorSec: 600, jobStartSec: 300, jobQueuedWarnSec: 60,
};

export const dashCaps = (over: Partial<RunnerCapabilities> = {}): RunnerCapabilities => ({
  nax: { version: '0.83.3', protocols: ['native'] },
  sandbox: { available: true, probedAt: DASH_NOW.toISOString() },
  profiles: { fast: { protocol: 'native', providers: ['deepseek'], sandbox: false } },
  credentials: [{ providerId: 'deepseek', available: true, stored: { kind: 'api-key', expired: false }, ambient: false }],
  tools: { git: true, gh: true, glab: true },
  executors: ['host'],
  approvals: { relay: true },
  ...over,
});

export const dashRunner = (over: Partial<DashboardRunnerRow> = {}): DashboardRunnerRow => ({
  id: 'r1', name: 'wk-mac', os: 'darwin', arch: 'arm64', labels: ['mac'], enabled: true, lastSeenAt: secAgo(10), capacity: 1,
  daemonVersion: '0.4.0', capabilities: dashCaps(), ...over,
});

export const dashJob = (over: Partial<DashboardJobRow> = {}): DashboardJobRow => ({
  id: 'j1', projectId: 'p1', projectSlug: 'web', projectDeleted: false, repoId: 'repo1', repoOwner: 'acme', repoName: 'app', provider: 'github',
  feature: 'add-auth', command: 'RUN', state: 'RUNNING', runnerId: 'r1', currentStoryId: 'US-001', currentPhase: 'implement',
  stories: null, storiesTruncated: false, costSpentUsd: '0.42', maxCostUsd: '2', queuedAt: secAgo(900), assignedAt: secAgo(890),
  startedAt: secAgo(880), lastHeartbeatAt: secAgo(30), profiles: ['fast'], selectorLabels: [], pinnedRunnerId: null, bashMode: 'raw', ...over,
});
```

- [ ] **Step 2: Write the failing tests**

Create `apps/api/src/fleet/dashboard/nax-version.spec.ts`:

```ts
import { compareCore, formatCore, parseCoreVersion } from './nax-version';

describe('nax core version (S2b (c) §2.4, D412)', () => {
  it.each([
    ['0.83.3', [0, 83, 3]],
    ['0.83.3-canary.2', [0, 83, 3]],
    ['v1.2.3', [1, 2, 3]],
    [' 1.0.0+build.7 ', [1, 0, 0]],
  ])('parses %s', (raw, core) => {
    expect(parseCoreVersion(raw)).toEqual(core);
  });

  it.each([[''], ['abc'], ['1.2'], ['1.2.x'], [null], [undefined]])('treats %p as unknown', (raw) => {
    expect(parseCoreVersion(raw)).toBeNull();
  });

  it('compares numerically, not as strings', () => {
    expect(compareCore([0, 83, 10], [0, 83, 9])).toBeGreaterThan(0);
    expect(compareCore([0, 9, 0], [0, 10, 0])).toBeLessThan(0);
    expect(compareCore([1, 0, 0], [1, 0, 0])).toBe(0);
    expect(formatCore([0, 83, 10])).toBe('0.83.10');
  });
});
```

Create `apps/api/src/fleet/dashboard/attention-jobs.spec.ts`:

```ts
import { DASH_NOW, DASH_THRESHOLDS, dashJob, dashRunner, secAgo } from '../../common/test-helpers/fleet-dashboard';
import { jobApprovalItems, jobSilentItems } from './attention-jobs';
import type { DashboardRunnerRow } from './dashboard.types';

const runners = (...rows: DashboardRunnerRow[]) => new Map(rows.map((r) => [r.id, r] as const));
const ONLINE = runners(dashRunner());

describe('job_silent (S2b (c) §2.1)', () => {
  it('stays quiet while a RUNNING heartbeat is within FLEET_JOB_SILENT_SEC (nax beats every 60 s)', () => {
    expect(jobSilentItems([dashJob({ lastHeartbeatAt: secAgo(179) })], ONLINE, DASH_NOW, DASH_THRESHOLDS)).toEqual([]);
  });

  it('warns past the silent threshold with the stage, the age and the runner', () => {
    expect(jobSilentItems([dashJob({ lastHeartbeatAt: secAgo(181) })], ONLINE, DASH_NOW, DASH_THRESHOLDS)).toEqual([{
      key: 'job_silent:j1', kind: 'job_silent', severity: 'warning', subjectType: 'job', subjectId: 'j1', subjectName: 'add-auth',
      projectSlug: 'web', since: secAgo(181).toISOString(), stage: 'running', silentSec: 181, runnerName: 'wk-mac',
    }]);
  });

  it('turns into an error past FLEET_JOB_SILENT_ERROR_SEC', () => {
    const [item] = jobSilentItems([dashJob({ lastHeartbeatAt: secAgo(601) })], ONLINE, DASH_NOW, DASH_THRESHOLDS);
    expect(item.severity).toBe('error');
  });

  it('reads the error threshold as max(error, silent): an inverted config goes straight to error', () => {
    const t = { ...DASH_THRESHOLDS, jobSilentSec: 180, jobSilentErrorSec: 60 };
    expect(jobSilentItems([dashJob({ lastHeartbeatAt: secAgo(179) })], ONLINE, DASH_NOW, t)).toEqual([]);
    const [item] = jobSilentItems([dashJob({ lastHeartbeatAt: secAgo(181) })], ONLINE, DASH_NOW, t);
    expect(item.severity).toBe('error');
  });

  it('measures from startedAt before the first heartbeat', () => {
    const [item] = jobSilentItems([dashJob({ lastHeartbeatAt: null, startedAt: secAgo(200) })], ONLINE, DASH_NOW, DASH_THRESHOLDS);
    expect(item).toMatchObject({ silentSec: 200, since: secAgo(200).toISOString() });
  });

  it('flags an ASSIGNED job that has not started after FLEET_JOB_START_SEC', () => {
    const job = dashJob({ state: 'ASSIGNED', assignedAt: secAgo(301), startedAt: null, lastHeartbeatAt: null });
    expect(jobSilentItems([job], ONLINE, DASH_NOW, DASH_THRESHOLDS)).toEqual([
      expect.objectContaining({ severity: 'warning', stage: 'starting', silentSec: 301, since: secAgo(301).toISOString() }),
    ]);
    expect(jobSilentItems([{ ...job, assignedAt: secAgo(299) }], ONLINE, DASH_NOW, DASH_THRESHOLDS)).toEqual([]);
  });

  it('never flags UPLOADING or QUEUED jobs', () => {
    const old = secAgo(5000);
    expect(jobSilentItems([dashJob({ state: 'UPLOADING', lastHeartbeatAt: old }), dashJob({ id: 'j2', state: 'QUEUED', runnerId: null })], ONLINE, DASH_NOW, DASH_THRESHOLDS)).toEqual([]);
  });

  it('leaves jobs of an offline or missing runner to the runner item (no double reporting)', () => {
    const silent = dashJob({ lastHeartbeatAt: secAgo(5000) });
    expect(jobSilentItems([silent], runners(dashRunner({ lastSeenAt: secAgo(91) })), DASH_NOW, DASH_THRESHOLDS)).toEqual([]);
    expect(jobSilentItems([silent], runners(), DASH_NOW, DASH_THRESHOLDS)).toEqual([]);
  });
});

describe('job_waiting_approval (S2b (c) §2.2)', () => {
  it('raises an error with the count and the oldest ask age', () => {
    const pending = new Map([['j1', { jobId: 'j1', count: 2, oldestRequestedAt: secAgo(190) }]]);
    expect(jobApprovalItems([dashJob(), dashJob({ id: 'j2' })], pending, DASH_NOW)).toEqual([{
      key: 'job_waiting_approval:j1', kind: 'job_waiting_approval', severity: 'error', subjectType: 'job', subjectId: 'j1',
      subjectName: 'add-auth', projectSlug: 'web', since: secAgo(190).toISOString(), pending: 2, oldestSec: 190,
    }]);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd apps/api && bunx jest src/fleet/dashboard`
Expected: FAIL with `Cannot find module './nax-version'` and `Cannot find module './attention-jobs'`.

- [ ] **Step 4: Implement `nax-version.ts` and `attention-jobs.ts`**

Create `apps/api/src/fleet/dashboard/nax-version.ts`:

```ts
const CORE = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]*)?$/;

export type CoreVersion = readonly [number, number, number];

/** major.minor.patch of a nax version; a prerelease or build suffix is ignored; null when unparsable (spec §2.4, D412). */
export function parseCoreVersion(version: string | null | undefined): CoreVersion | null {
  if (!version) return null;
  const m = CORE.exec(version.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function compareCore(a: CoreVersion, b: CoreVersion): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

export const formatCore = (v: CoreVersion): string => v.join('.');
```

Create `apps/api/src/fleet/dashboard/attention-jobs.ts`:

```ts
import { FleetJobState } from '../../common/enums';
import { isRunnerOnline } from '../common/runner-online';
import {
  AttentionItem, AttentionKind, AttentionThresholds, DashboardJobRow, DashboardRunnerRow, PendingSummary, secondsSince, Severity,
} from './dashboard.types';

/** A job-subject attention item. */
export function jobItem(kind: AttentionKind, job: DashboardJobRow, severity: Severity, since: Date, extra: Partial<AttentionItem>): AttentionItem {
  return {
    key: `${kind}:${job.id}`, kind, severity, subjectType: 'job', subjectId: job.id, subjectName: job.feature,
    projectSlug: job.projectSlug, since: since.toISOString(), ...extra,
  };
}

/**
 * Spec §2.1. Only jobs on an existing, online runner: an offline runner's jobs are reported once, on its
 * runner_unhealthy item (jobsHeld). UPLOADING is never evaluated (nax has exited).
 */
export function jobSilentItems(
  jobs: readonly DashboardJobRow[],
  runnersById: ReadonlyMap<string, DashboardRunnerRow>,
  now: Date,
  t: AttentionThresholds,
): AttentionItem[] {
  const errorSec = Math.max(t.jobSilentErrorSec, t.jobSilentSec);
  return jobs.flatMap((job): AttentionItem[] => {
    const runner = job.runnerId ? runnersById.get(job.runnerId) : undefined;
    if (!runner || !isRunnerOnline(runner.lastSeenAt, now, t.runnerOfflineSec)) return [];
    if (job.state === FleetJobState.RUNNING) {
      const from = job.lastHeartbeatAt ?? job.startedAt ?? job.assignedAt;
      if (!from) return [];
      const age = secondsSince(now, from);
      if (age <= t.jobSilentSec) return [];
      return [jobItem('job_silent', job, age > errorSec ? 'error' : 'warning', from, { stage: 'running', silentSec: age, runnerName: runner.name })];
    }
    if (job.state === FleetJobState.ASSIGNED && job.assignedAt) {
      const age = secondsSince(now, job.assignedAt);
      if (age <= t.jobStartSec) return [];
      return [jobItem('job_silent', job, 'warning', job.assignedAt, { stage: 'starting', silentSec: age, runnerName: runner.name })];
    }
    return [];
  });
}

/** Spec §2.2: always an error (a missed ask auto-denies at its timeout). */
export function jobApprovalItems(jobs: readonly DashboardJobRow[], pending: ReadonlyMap<string, PendingSummary>, now: Date): AttentionItem[] {
  return jobs.flatMap((job): AttentionItem[] => {
    const p = pending.get(job.id);
    if (!p || p.count === 0) return [];
    return [jobItem('job_waiting_approval', job, 'error', p.oldestRequestedAt, { pending: p.count, oldestSec: secondsSince(now, p.oldestRequestedAt) })];
  });
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/api && bunx jest src/fleet/dashboard && bunx eslint src/fleet/dashboard src/common/test-helpers/fleet-dashboard.ts --max-warnings=0`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/fleet/dashboard apps/api/src/common/test-helpers/fleet-dashboard.ts
git commit -m "feat(fleet): dashboard types, nax version compare and job attention rules (S2b (c) §2.1-§2.2)"
```

---

### Task 3: `job_unplaceable` dry-run rule

**Files:**
- Create: `apps/api/src/fleet/dashboard/attention-unplaceable.ts`
- Test: `apps/api/src/fleet/dashboard/attention-unplaceable.spec.ts`

**Interfaces:**
- Consumes: `evaluateRunners`, `toPlacementJob`, `PERMANENT_MISFITS`, `MisfitReason`, `PlacementRunner`, `RunnerLoad` (Task 1); `jobGateKeys` (`budgets/budget-rules.ts`); `jobItem` (Task 2); types from `dashboard.types.ts`.
- Produces:
  - `interface DryRunPauses { runnerPaused(runnerId: string): boolean; match(keys: readonly string[]): unknown }` (satisfied by `PauseSnapshot`)
  - `interface DryRunInput { queued: readonly DashboardJobRow[]; runners: readonly DashboardRunnerRow[]; loads: ReadonlyMap<string, RunnerLoad>; pauses: DryRunPauses }`
  - `interface ScopedItem { projectId: string; item: AttentionItem }`
  - `interface DryRunResult { items: ScopedItem[]; providerBlockedRunnerIds: ReadonlySet<string> }`
  - `jobUnplaceableItems(input: DryRunInput, now: Date, t: AttentionThresholds): DryRunResult`

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/fleet/dashboard/attention-unplaceable.spec.ts`:

```ts
import { DASH_NOW, DASH_THRESHOLDS, dashCaps, dashJob, dashRunner, secAgo } from '../../common/test-helpers/fleet-dashboard';
import type { RunnerLoad } from '../jobs/placement-rules';
import { DryRunInput, jobUnplaceableItems } from './attention-unplaceable';

const QUEUED = dashJob({ state: 'QUEUED', runnerId: null, assignedAt: null, startedAt: null, lastHeartbeatAt: null, queuedAt: secAgo(120) });
const NO_PAUSE = { runnerPaused: () => false, match: () => null };
const input = (over: Partial<DryRunInput> = {}): DryRunInput => ({
  queued: [QUEUED], runners: [dashRunner()], loads: new Map<string, RunnerLoad>(), pauses: NO_PAUSE, ...over,
});
const run = (over: Partial<DryRunInput> = {}) => jobUnplaceableItems(input(over), DASH_NOW, DASH_THRESHOLDS);
const only = (over: Partial<DryRunInput> = {}) => {
  const { items } = run(over);
  expect(items).toHaveLength(1);
  return items[0];
};

describe('job_unplaceable (S2b (c) §2.3)', () => {
  it('ignores a job younger than FLEET_JOB_QUEUED_WARN_SEC and a job of a soft-deleted project', () => {
    expect(run({ queued: [{ ...QUEUED, queuedAt: secAgo(59) }] }).items).toEqual([]);
    expect(run({ queued: [{ ...QUEUED, projectDeleted: true }], runners: [] }).items).toEqual([]);
  });

  it('reports fits_not_placed when a runner fits (placement is not reaching the job)', () => {
    expect(only()).toEqual({
      projectId: 'p1',
      item: {
        key: 'job_unplaceable:j1', kind: 'job_unplaceable', severity: 'warning', subjectType: 'job', subjectId: 'j1', subjectName: 'add-auth',
        projectSlug: 'web', since: secAgo(120).toISOString(), verdict: 'fits_not_placed', reasons: [], reasonsTotal: 0,
      },
    });
  });

  it('reports budget_paused when the job scope itself is paused (placement will cancel it)', () => {
    const pauses = { runnerPaused: () => false, match: (keys: readonly string[]) => (keys.includes('project:p1') ? { id: 'b1' } : null) };
    expect(only({ pauses }).item).toMatchObject({ verdict: 'budget_paused', severity: 'warning', reasons: [], reasonsTotal: 0 });
  });

  it('reports no_runners (error) with no readable candidate', () => {
    expect(only({ runners: [] }).item).toMatchObject({ verdict: 'no_runners', severity: 'error' });
    expect(only({ runners: [dashRunner({ capabilities: null })] }).item).toMatchObject({ verdict: 'no_runners', severity: 'error' });
  });

  it('reports never (error) when every misfit is permanent', () => {
    expect(only({ runners: [dashRunner({ enabled: false })] }).item).toMatchObject({
      verdict: 'never', severity: 'error', reasons: [{ runnerName: 'wk-mac', reason: 'disabled' }], reasonsTotal: 1,
    });
  });

  it('reports waiting_capacity (warning) when every runner is busy', () => {
    const loads = new Map([['r1', { active: 1, repoIds: new Set(['other']) }]]);
    expect(only({ loads }).item).toMatchObject({ verdict: 'waiting_capacity', severity: 'warning', reasons: [{ runnerName: 'wk-mac', reason: 'capacity' }] });
  });

  it('reports runners_paused when every runner is budget-paused', () => {
    expect(only({ pauses: { runnerPaused: () => true, match: () => null } }).item).toMatchObject({ verdict: 'runners_paused', severity: 'warning' });
  });

  it('reports no_fit for any other mix, reasons sorted by runner name', () => {
    const runners = [dashRunner({ id: 'r2', name: 'zz-box', lastSeenAt: secAgo(500) }), dashRunner({ id: 'r1', name: 'aa-box', labels: ['mac'] })];
    const item = only({ runners, queued: [{ ...QUEUED, selectorLabels: ['gpu'] }] }).item;
    expect(item).toMatchObject({ verdict: 'no_fit', severity: 'warning', reasonsTotal: 2 });
    expect(item.reasons).toEqual([{ runnerName: 'aa-box', reason: 'labels' }, { runnerName: 'zz-box', reason: 'offline' }]);
  });

  it('evaluates only the pinned runner for a pinned job', () => {
    const runners = [dashRunner({ id: 'r1', name: 'free', capacity: 4 }), dashRunner({ id: 'r2', name: 'pinned', lastSeenAt: secAgo(500) })];
    const item = only({ runners, queued: [{ ...QUEUED, pinnedRunnerId: 'r2' }] }).item;
    expect(item).toMatchObject({ verdict: 'no_fit', reasons: [{ runnerName: 'pinned', reason: 'offline' }], reasonsTotal: 1 });
  });

  it('caps reasons at 20 and reports the total', () => {
    const runners = Array.from({ length: 25 }, (_, i) => dashRunner({ id: `r${i}`, name: `box-${String(i).padStart(2, '0')}`, enabled: false }));
    const item = only({ runners }).item;
    expect(item.reasons).toHaveLength(20);
    expect(item.reasonsTotal).toBe(25);
    expect(item.reasons?.[0].runnerName).toBe('box-00');
  });

  it('collects runners that block an unplaced job on a provider credential', () => {
    const broken = dashCaps({ credentials: [{ providerId: 'deepseek', available: false, stored: null, ambient: false }] });
    const { providerBlockedRunnerIds } = run({ runners: [dashRunner({ capabilities: broken })] });
    expect([...providerBlockedRunnerIds]).toEqual(['r1']);
    expect([...run().providerBlockedRunnerIds]).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/api && bunx jest src/fleet/dashboard/attention-unplaceable.spec.ts`
Expected: FAIL with `Cannot find module './attention-unplaceable'`.

- [ ] **Step 3: Implement the rule**

Create `apps/api/src/fleet/dashboard/attention-unplaceable.ts`:

```ts
import { jobGateKeys } from '../budgets/budget-rules';
import {
  evaluateRunners, MisfitReason, PERMANENT_MISFITS, PlacementRunner, RunnerLoad, toPlacementJob,
} from '../jobs/placement-rules';
import { jobItem } from './attention-jobs';
import {
  AttentionItem, AttentionReason, AttentionThresholds, DASHBOARD_LIMITS, DashboardJobRow, DashboardRunnerRow, secondsSince, Severity,
  UnplaceableVerdict,
} from './dashboard.types';

/** The parts of PauseSnapshot the dry-run needs. */
export interface DryRunPauses {
  runnerPaused(runnerId: string): boolean;
  match(keys: readonly string[]): unknown;
}

export interface DryRunInput {
  /** The globally oldest QUEUED jobs: the window fillRunner scans (D407). */
  queued: readonly DashboardJobRow[];
  runners: readonly DashboardRunnerRow[];
  /** Runner-held loads across all projects. */
  loads: ReadonlyMap<string, RunnerLoad>;
  pauses: DryRunPauses;
}

export interface ScopedItem {
  projectId: string;
  item: AttentionItem;
}

export interface DryRunResult {
  items: ScopedItem[];
  /** Runners whose provider_missing / provider_unavailable misfit holds back an unplaced job (spec §2.4 escalation). */
  providerBlockedRunnerIds: ReadonlySet<string>;
}

const PROVIDER_REASONS: ReadonlySet<MisfitReason> = new Set<MisfitReason>(['provider_missing', 'provider_unavailable']);
const WAITING_REASONS: ReadonlySet<MisfitReason> = new Set<MisfitReason>(['capacity', 'busy_repo']);

/** Runners with unreadable capabilities are never candidates (spec §1.4). */
const toCandidate = (r: DashboardRunnerRow): PlacementRunner | null =>
  r.capabilities === null
    ? null
    : { id: r.id, name: r.name, enabled: r.enabled, lastSeenAt: r.lastSeenAt, labels: r.labels, capacity: r.capacity, capabilities: r.capabilities };

function classify(reasons: readonly MisfitReason[]): { verdict: UnplaceableVerdict; severity: Severity } {
  if (reasons.every((r) => PERMANENT_MISFITS.has(r))) return { verdict: 'never', severity: 'error' };
  if (reasons.every((r) => WAITING_REASONS.has(r))) return { verdict: 'waiting_capacity', severity: 'warning' };
  if (reasons.every((r) => r === 'budget_paused')) return { verdict: 'runners_paused', severity: 'warning' };
  return { verdict: 'no_fit', severity: 'warning' };
}

/**
 * Spec §2.3. Evaluated in the global context; the caller filters `items` to its scope. Same inputs as
 * PlacementService.placeJob, but no locks and no assignment.
 */
export function jobUnplaceableItems(input: DryRunInput, now: Date, t: AttentionThresholds): DryRunResult {
  const candidates = input.runners.map(toCandidate).filter((r): r is PlacementRunner => r !== null);
  const blocked = new Set<string>();
  const items = input.queued.flatMap((job): ScopedItem[] => {
    if (job.projectDeleted || secondsSince(now, job.queuedAt) <= t.jobQueuedWarnSec) return [];
    const emit = (verdict: UnplaceableVerdict, severity: Severity, reasons: AttentionReason[], reasonsTotal: number): ScopedItem[] => [{
      projectId: job.projectId,
      item: jobItem('job_unplaceable', job, severity, job.queuedAt, { verdict, reasons: reasons.slice(0, DASHBOARD_LIMITS.reasonsShown), reasonsTotal }),
    }];
    if (input.pauses.match(jobGateKeys(job))) return emit('budget_paused', 'warning', [], 0);
    const pool = job.pinnedRunnerId ? candidates.filter((r) => r.id === job.pinnedRunnerId) : candidates;
    if (pool.length === 0) return emit('no_runners', 'error', [], 0);
    const verdicts = evaluateRunners(toPlacementJob(job, job), pool, input.loads, (id) => input.pauses.runnerPaused(id), now, t.runnerOfflineSec);
    const misfits = verdicts
      .flatMap((v) => (v.reason === null ? [] : [{ runnerId: v.runner.id, runnerName: v.runner.name, reason: v.reason }]))
      .sort((a, b) => a.runnerName.localeCompare(b.runnerName) || a.runnerId.localeCompare(b.runnerId));
    const reasons = misfits.map(({ runnerName, reason }) => ({ runnerName, reason }));
    if (misfits.length < verdicts.length) return emit('fits_not_placed', 'warning', reasons, reasons.length);
    misfits.filter((m) => PROVIDER_REASONS.has(m.reason)).forEach((m) => blocked.add(m.runnerId));
    const { verdict, severity } = classify(misfits.map((m) => m.reason));
    return emit(verdict, severity, reasons, reasons.length);
  });
  return { items, providerBlockedRunnerIds: blocked };
}
```

Note: the `fits_not_placed` test expects `reasons: []` because the only runner fits; with a mix it lists only the misfit runners (D408).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && bunx jest src/fleet/dashboard && bunx eslint src/fleet/dashboard --max-warnings=0`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/fleet/dashboard/attention-unplaceable.ts apps/api/src/fleet/dashboard/attention-unplaceable.spec.ts
git commit -m "feat(fleet): job_unplaceable dry-run over the placement rules (S2b (c) §2.3)"
```

---
### Task 4: `runner_unhealthy` and `buildAttention`

**Files:**
- Create: `apps/api/src/fleet/dashboard/attention-runners.ts`
- Create: `apps/api/src/fleet/dashboard/attention-rules.ts`
- Test: `apps/api/src/fleet/dashboard/attention-runners.spec.ts`
- Test: `apps/api/src/fleet/dashboard/attention-rules.spec.ts`

**Interfaces:**
- Consumes: `parseCoreVersion`, `compareCore`, `formatCore`, `CoreVersion` (Task 2); `jobSilentItems`, `jobApprovalItems` (Task 2); `jobUnplaceableItems`, `DryRunInput` (Task 3); `isRunnerOnline`.
- Produces:
  - `attention-runners.ts`: `latestOnlineCore(runners, now, offlineSec): CoreVersion | null`, `runnerUnhealthyItems(runners, heldByRunner, providerBlocked, now, t): AttentionItem[]`
  - `attention-rules.ts`: `interface AttentionInput { scope; runners; heldByRunner; activeJobs; pending; dryRun: Omit<DryRunInput, 'runners'> }`, `sortAttention(items)`, `forProjectScope(item)`, `buildAttention(input, now, t): AttentionItem[]`

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/fleet/dashboard/attention-runners.spec.ts`:

```ts
import { DASH_NOW, DASH_THRESHOLDS, dashCaps, dashRunner, secAgo } from '../../common/test-helpers/fleet-dashboard';
import { latestOnlineCore, runnerUnhealthyItems } from './attention-runners';
import type { DashboardRunnerRow } from './dashboard.types';

const run = (runners: DashboardRunnerRow[], held = new Map<string, number>(), blocked = new Set<string>()) =>
  runnerUnhealthyItems(runners, held, blocked, DASH_NOW, DASH_THRESHOLDS);
const nax = (version: string) => dashCaps({ nax: { version, protocols: ['native'] } });

describe('runner_unhealthy (S2b (c) §2.4)', () => {
  it('raises nothing for a healthy runner or a disabled one', () => {
    expect(run([dashRunner(), dashRunner({ id: 'r2', enabled: false, lastSeenAt: secAgo(5000) })])).toEqual([]);
  });

  it('warns on an offline runner and errors when it still holds jobs', () => {
    const offline = dashRunner({ lastSeenAt: secAgo(91) });
    expect(run([offline])).toEqual([{
      key: 'runner_unhealthy:r1', kind: 'runner_unhealthy', severity: 'warning', subjectType: 'runner', subjectId: 'r1', subjectName: 'wk-mac',
      projectSlug: null, since: secAgo(91).toISOString(), conditions: [{ type: 'offline', jobsHeld: 0 }],
    }]);
    expect(run([offline], new Map([['r1', 2]]))[0]).toMatchObject({ severity: 'error', conditions: [{ type: 'offline', jobsHeld: 2 }] });
  });

  it('reports missing and unavailable providers of its own profiles only', () => {
    const caps = dashCaps({
      profiles: { fast: { protocol: 'native', providers: ['deepseek', 'anthropic'], sandbox: false } },
      credentials: [
        { providerId: 'deepseek', available: false, stored: null, ambient: false },
        { providerId: 'openai', available: false, stored: null, ambient: false },
      ],
    });
    expect(run([dashRunner({ capabilities: caps })])[0]).toMatchObject({
      severity: 'warning', since: null,
      conditions: [{ type: 'credential', providerId: 'anthropic', why: 'missing' }, { type: 'credential', providerId: 'deepseek', why: 'unavailable' }],
    });
  });

  it('flags an expired api-key but never OAuth expiry', () => {
    const caps = dashCaps({
      profiles: {},
      credentials: [
        { providerId: 'k', available: true, stored: { kind: 'api-key', expired: true }, ambient: false },
        { providerId: 'o', available: true, stored: { kind: 'oauth', expires: '2026-01-01T00:00:00Z', expired: true }, ambient: false },
      ],
    });
    expect(run([dashRunner({ capabilities: caps })])[0].conditions).toEqual([{ type: 'credential', providerId: 'k', why: 'expired' }]);
  });

  it('raises nothing for a runner with no profiles and an unavailable credential', () => {
    const caps = dashCaps({ profiles: {}, credentials: [{ providerId: 'x', available: false, stored: null, ambient: false }] });
    expect(run([dashRunner({ capabilities: caps })])).toEqual([]);
  });

  it('escalates a credential problem to error when it blocks an unplaced job', () => {
    const caps = dashCaps({ credentials: [{ providerId: 'deepseek', available: false, stored: null, ambient: false }] });
    expect(run([dashRunner({ capabilities: caps })], new Map(), new Set(['r1']))[0].severity).toBe('error');
  });

  it('warns on a stale nax core version against the newest online runner', () => {
    const items = run([dashRunner({ id: 'a', name: 'a', capabilities: nax('0.83.10') }), dashRunner({ id: 'b', name: 'b', capabilities: nax('0.83.9') })]);
    expect(items).toEqual([expect.objectContaining({ subjectId: 'b', severity: 'warning', conditions: [{ type: 'stale_nax', version: '0.83.9', latest: '0.83.10' }] })]);
  });

  it('does not call a canary of the same core stale, ignores unparsable versions and offline runners for latest', () => {
    expect(run([dashRunner({ id: 'a', capabilities: nax('0.83.3') }), dashRunner({ id: 'b', capabilities: nax('0.83.3-canary.2') })])).toEqual([]);
    expect(run([dashRunner({ id: 'a', capabilities: nax('garbage') }), dashRunner({ id: 'b', capabilities: nax('0.1.0') })])).toEqual([]);
    expect(latestOnlineCore([dashRunner({ capabilities: nax('9.9.9'), lastSeenAt: secAgo(500) }), dashRunner({ id: 'b', capabilities: nax('0.1.0') })], DASH_NOW, 90))
      .toEqual([0, 1, 0]);
  });

  it('gives a runner with unreadable capabilities only the offline condition', () => {
    expect(run([dashRunner({ capabilities: null })])).toEqual([]);
    expect(run([dashRunner({ capabilities: null, lastSeenAt: secAgo(91) })])[0].conditions).toEqual([{ type: 'offline', jobsHeld: 0 }]);
  });
});
```

Create `apps/api/src/fleet/dashboard/attention-rules.spec.ts`:

```ts
import { DASH_NOW, DASH_THRESHOLDS, dashCaps, dashJob, dashRunner, secAgo } from '../../common/test-helpers/fleet-dashboard';
import { AttentionInput, buildAttention, forProjectScope, sortAttention } from './attention-rules';
import type { AttentionItem } from './dashboard.types';

const NO_PAUSE = { runnerPaused: () => false, match: () => null };
const broken = dashCaps({ nax: { version: '0.82.0', protocols: ['native'] }, credentials: [{ providerId: 'deepseek', available: false, stored: null, ambient: false }] });

/** web job j1 RUNNING on an offline runner r2 (silent), ops QUEUED job j9 with no fitting runner, r3 newer nax. */
const input = (scope: AttentionInput['scope']): AttentionInput => ({
  scope,
  runners: [
    dashRunner({ id: 'r2', name: 'old-box', lastSeenAt: secAgo(500), capabilities: broken }),
    dashRunner({ id: 'r3', name: 'new-box', labels: ['linux'] }),
  ],
  heldByRunner: new Map([['r2', 1]]),
  activeJobs: scope.kind === 'global'
    ? [dashJob({ runnerId: 'r2', lastHeartbeatAt: secAgo(900) })]
    : [dashJob({ runnerId: 'r2', lastHeartbeatAt: secAgo(900) })].filter((j) => j.projectId === scope.projectId),
  pending: new Map(),
  dryRun: {
    queued: [dashJob({ id: 'j9', projectId: 'p2', projectSlug: 'ops', feature: 'secret-feature', state: 'QUEUED', runnerId: null, queuedAt: secAgo(300), selectorLabels: ['gpu'] })],
    loads: new Map([['r2', { active: 1, repoIds: new Set(['repo1']) }]]),
    pauses: NO_PAUSE,
  },
});

describe('buildAttention (S2b (c) §2)', () => {
  it('global scope: one runner item for the offline runner (no job_silent), the foreign queued job, full conditions', () => {
    const items = buildAttention(input({ kind: 'global' }), DASH_NOW, DASH_THRESHOLDS);
    expect(items.map((i) => i.key)).toEqual(['runner_unhealthy:r2', 'job_unplaceable:j9']);
    expect(items[0]).toMatchObject({ severity: 'error' });
    expect(items[0].conditions).toEqual([
      { type: 'offline', jobsHeld: 1 },
      { type: 'credential', providerId: 'deepseek', why: 'unavailable' },
      { type: 'stale_nax', version: '0.82.0', latest: '0.83.3' },
    ]);
  });

  it('project scope: drops other projects\' queued jobs and collapses runner detail to configuration', () => {
    const items = buildAttention(input({ kind: 'project', projectId: 'p1' }), DASH_NOW, DASH_THRESHOLDS);
    expect(items.map((i) => i.key)).toEqual(['runner_unhealthy:r2']);
    expect(items[0].conditions).toEqual([{ type: 'offline', jobsHeld: 1 }, { type: 'configuration' }]);
    const json = JSON.stringify(items);
    for (const leak of ['secret-feature', 'j9', 'ops', 'deepseek', '0.82.0', '0.83.3']) expect(json).not.toContain(leak);
  });
});

describe('forProjectScope', () => {
  const runnerItem = (conditions: AttentionItem['conditions'], severity: AttentionItem['severity'] = 'error'): AttentionItem => ({
    key: 'runner_unhealthy:r1', kind: 'runner_unhealthy', severity, subjectType: 'runner', subjectId: 'r1', subjectName: 'wk-mac',
    projectSlug: null, since: null, conditions,
  });

  it('keeps an error only for an offline runner holding jobs', () => {
    expect(forProjectScope(runnerItem([{ type: 'credential', providerId: 'x', why: 'missing' }]))).toMatchObject({
      severity: 'warning', conditions: [{ type: 'configuration' }],
    });
    expect(forProjectScope(runnerItem([{ type: 'offline', jobsHeld: 1 }])).severity).toBe('error');
  });

  it('leaves job items untouched', () => {
    const job: AttentionItem = { ...runnerItem(undefined), key: 'job_silent:j1', kind: 'job_silent', subjectType: 'job' };
    expect(forProjectScope(job)).toBe(job);
  });
});

describe('sortAttention', () => {
  it('orders errors first, then oldest since (unknown last), then key', () => {
    const item = (key: string, severity: AttentionItem['severity'], since: string | null): AttentionItem => ({
      key, kind: 'job_silent', severity, subjectType: 'job', subjectId: key, subjectName: key, projectSlug: 'web', since,
    });
    const sorted = sortAttention([
      item('w-new', 'warning', '2026-10-05T11:00:00.000Z'), item('e-null', 'error', null), item('e-old', 'error', '2026-10-05T10:00:00.000Z'),
      item('w-old-b', 'warning', '2026-10-05T09:00:00.000Z'), item('w-old-a', 'warning', '2026-10-05T09:00:00.000Z'),
    ]);
    expect(sorted.map((i) => i.key)).toEqual(['e-old', 'e-null', 'w-old-a', 'w-old-b', 'w-new']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/api && bunx jest src/fleet/dashboard/attention-runners.spec.ts src/fleet/dashboard/attention-rules.spec.ts`
Expected: FAIL with `Cannot find module './attention-runners'` / `'./attention-rules'`.

- [ ] **Step 3: Implement `attention-runners.ts`**

```ts
import type { RunnerCapabilities } from '../common/protocol';
import { isRunnerOnline } from '../common/runner-online';
import { AttentionItem, AttentionThresholds, DashboardRunnerRow, RunnerCondition, Severity } from './dashboard.types';
import { compareCore, CoreVersion, formatCore, parseCoreVersion } from './nax-version';

/** D414: the newest core version among enabled, online runners with readable, parsable versions. */
export function latestOnlineCore(runners: readonly DashboardRunnerRow[], now: Date, offlineSec: number): CoreVersion | null {
  return runners
    .filter((r) => r.enabled && isRunnerOnline(r.lastSeenAt, now, offlineSec))
    .map((r) => parseCoreVersion(r.capabilities?.nax.version))
    .filter((v): v is CoreVersion => v !== null)
    .reduce<CoreVersion | null>((best, v) => (best === null || compareCore(v, best) > 0 ? v : best), null);
}

/**
 * Spec §2.4, D405: providers named by the runner's own profiles that have no credential (missing) or
 * an unavailable one; then api-key credentials that expired. OAuth expiry is ignored (placement does).
 */
function credentialConditions(caps: RunnerCapabilities): RunnerCondition[] {
  const needed = [...new Set(Object.values(caps.profiles).flatMap((p) => p.providers))].sort();
  const fromProfiles = needed.flatMap((providerId): RunnerCondition[] => {
    const credential = caps.credentials.find((c) => c.providerId === providerId);
    if (!credential) return [{ type: 'credential', providerId, why: 'missing' }];
    return credential.available ? [] : [{ type: 'credential', providerId, why: 'unavailable' }];
  });
  const reported = new Set(fromProfiles.map((c) => c.providerId));
  const expired = caps.credentials
    .filter((c) => c.stored?.kind === 'api-key' && c.stored.expired && !reported.has(c.providerId))
    .map((c): RunnerCondition => ({ type: 'credential', providerId: c.providerId, why: 'expired' }));
  return [...fromProfiles, ...expired];
}

function staleCondition(caps: RunnerCapabilities, latest: CoreVersion | null): RunnerCondition | null {
  const core = parseCoreVersion(caps.nax.version);
  if (!core || !latest || compareCore(core, latest) >= 0) return null;
  return { type: 'stale_nax', version: caps.nax.version, latest: formatCore(latest) };
}

/** Spec §2.4: one item per enabled runner with at least one condition; full (admin) detail. */
export function runnerUnhealthyItems(
  runners: readonly DashboardRunnerRow[],
  heldByRunner: ReadonlyMap<string, number>,
  providerBlocked: ReadonlySet<string>,
  now: Date,
  t: AttentionThresholds,
): AttentionItem[] {
  const latest = latestOnlineCore(runners, now, t.runnerOfflineSec);
  return runners.flatMap((r): AttentionItem[] => {
    if (!r.enabled) return [];
    const online = isRunnerOnline(r.lastSeenAt, now, t.runnerOfflineSec);
    const jobsHeld = heldByRunner.get(r.id) ?? 0;
    const offline: RunnerCondition[] = online ? [] : [{ type: 'offline', jobsHeld }];
    const credentials = r.capabilities ? credentialConditions(r.capabilities) : [];
    const stale = r.capabilities ? staleCondition(r.capabilities, latest) : null;
    const conditions = [...offline, ...credentials, ...(stale ? [stale] : [])];
    if (conditions.length === 0) return [];
    const error = (!online && jobsHeld > 0) || (credentials.length > 0 && providerBlocked.has(r.id));
    const severity: Severity = error ? 'error' : 'warning';
    return [{
      key: `runner_unhealthy:${r.id}`, kind: 'runner_unhealthy', severity, subjectType: 'runner', subjectId: r.id, subjectName: r.name,
      projectSlug: null, since: online ? null : r.lastSeenAt.toISOString(), conditions,
    }];
  });
}
```

- [ ] **Step 4: Implement `attention-rules.ts`**

```ts
import { jobApprovalItems, jobSilentItems } from './attention-jobs';
import { runnerUnhealthyItems } from './attention-runners';
import { DryRunInput, jobUnplaceableItems } from './attention-unplaceable';
import {
  AttentionItem, AttentionThresholds, DashboardJobRow, DashboardRunnerRow, DashboardScope, PendingSummary, RunnerCondition, Severity,
} from './dashboard.types';

export interface AttentionInput {
  scope: DashboardScope;
  /** Every runner (both scopes). */
  runners: readonly DashboardRunnerRow[];
  /** Runner-held job count per runner, across all projects. */
  heldByRunner: ReadonlyMap<string, number>;
  /** Active jobs in scope (the fetched list, at most 200; D403). */
  activeJobs: readonly DashboardJobRow[];
  pending: ReadonlyMap<string, PendingSummary>;
  /** Global dry-run inputs (the window is not scoped; items are filtered after). */
  dryRun: Omit<DryRunInput, 'runners'>;
}

const RANK: Record<Severity, number> = { error: 0, warning: 1 };

const compareSince = (a: string | null, b: string | null): number => {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a.localeCompare(b);
};

/** Spec §1.2: errors first, then oldest `since` (unknown last), then `key`. */
export function sortAttention(items: readonly AttentionItem[]): AttentionItem[] {
  return [...items].sort((a, b) => RANK[a.severity] - RANK[b.severity] || compareSince(a.since, b.since) || a.key.localeCompare(b.key));
}

/**
 * Spec §2.4 / §1.5 (B5): in project scope a runner item keeps only `offline`; credential and stale_nax
 * collapse into one `configuration`; the credential error escalation is admin-only.
 */
export function forProjectScope(item: AttentionItem): AttentionItem {
  if (item.kind !== 'runner_unhealthy' || !item.conditions) return item;
  const offline = item.conditions.filter((c) => c.type === 'offline');
  const configuration: RunnerCondition[] = item.conditions.some((c) => c.type !== 'offline') ? [{ type: 'configuration' }] : [];
  const severity: Severity = offline.some((c) => (c.jobsHeld ?? 0) > 0) ? 'error' : 'warning';
  return { ...item, severity, conditions: [...offline, ...configuration] };
}

export function buildAttention(input: AttentionInput, now: Date, t: AttentionThresholds): AttentionItem[] {
  const runnersById = new Map(input.runners.map((r) => [r.id, r] as const));
  const dry = jobUnplaceableItems({ ...input.dryRun, runners: input.runners }, now, t);
  const projectId = input.scope.kind === 'project' ? input.scope.projectId : null;
  const unplaceable = dry.items.filter((s) => projectId === null || s.projectId === projectId).map((s) => s.item);
  const runnerItems = runnerUnhealthyItems(input.runners, input.heldByRunner, dry.providerBlockedRunnerIds, now, t);
  return sortAttention([
    ...jobSilentItems(input.activeJobs, runnersById, now, t),
    ...jobApprovalItems(input.activeJobs, input.pending, now),
    ...unplaceable,
    ...(projectId === null ? runnerItems : runnerItems.map(forProjectScope)),
  ]);
}
```

Why the global test expects `runner_unhealthy:r2` to be `error`: the offline runner holds one job (`jobsHeld: 1`). Why there is no `job_silent:j1`: its runner is offline (Task 2 rule). Why `j9` is `no_fit`: `old-box` is offline and `new-box` lacks the `gpu` label.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/api && bunx jest src/fleet/dashboard && bunx eslint src/fleet/dashboard --max-warnings=0`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/fleet/dashboard/attention-runners.ts apps/api/src/fleet/dashboard/attention-runners.spec.ts apps/api/src/fleet/dashboard/attention-rules.ts apps/api/src/fleet/dashboard/attention-rules.spec.ts
git commit -m "feat(fleet): runner_unhealthy and attention assembly with project-scope collapse (S2b (c) §2.4, §1.5)"
```

---

### Task 5: Dashboard repository (seven reads)

**Files:**
- Create: `apps/api/src/fleet/dashboard/domain/dashboard.domain.ts`
- Create: `apps/api/src/fleet/dashboard/prisma-dashboard.repository.ts`
- Test: `apps/api/test/integration/fleet/fleet-dashboard-repository.integration.spec.ts`

**Interfaces:**
- Consumes: `ACTIVE_STATES`, `RUNNER_HELD_STATES`, `TERMINAL_STATES` (`jobs/job-state.ts`); row types (Task 2).
- Produces:
  - `DASHBOARD_REPOSITORY` symbol
  - `interface RawRunnerRow extends Omit<DashboardRunnerRow, 'capabilities'> { capabilities: unknown }`
  - `interface IDashboardRepository` with `findRunners(): Promise<RawRunnerRow[]>`, `findHeldRefs(): Promise<Array<{ runnerId: string; repoId: string }>>`, `findActiveJobs(scope, limit): Promise<DashboardJobRow[]>`, `findQueuedWindow(limit): Promise<DashboardJobRow[]>`, `findRecentJobs(scope, finishedSince: Date, limit): Promise<DashboardRecentRow[]>`, `countActiveByState(scope): Promise<Map<string, number>>`, `pendingSummaryByJob(jobIds): Promise<PendingSummary[]>`
  - `PrismaDashboardRepository` (injectable)

- [ ] **Step 1: Write the domain interface**

Create `apps/api/src/fleet/dashboard/domain/dashboard.domain.ts`:

```ts
import type { DashboardJobRow, DashboardRecentRow, DashboardRunnerRow, DashboardScope, PendingSummary } from '../dashboard.types';

export const DASHBOARD_REPOSITORY = Symbol('DASHBOARD_REPOSITORY');

/** A runner row before its capabilities are re-validated (spec §1.4). */
export interface RawRunnerRow extends Omit<DashboardRunnerRow, 'capabilities'> {
  capabilities: unknown;
}

/** S2b (c) spec §1.3: plain, non-locking reads. Scoped reads skip soft-deleted projects. */
export interface IDashboardRepository {
  /** Every runner, ordered by name then id. */
  findRunners(): Promise<RawRunnerRow[]>;
  /** Every runner-held job (ASSIGNED, RUNNING, UPLOADING) across all projects. */
  findHeldRefs(): Promise<Array<{ runnerId: string; repoId: string }>>;
  /** Active jobs in scope, oldest queuedAt first then id; at most `limit`. */
  findActiveJobs(scope: DashboardScope, limit: number): Promise<DashboardJobRow[]>;
  /** The globally oldest QUEUED jobs (any project, soft-deleted included): the window fillRunner scans (D407). */
  findQueuedWindow(limit: number): Promise<DashboardJobRow[]>;
  /** Terminal jobs in scope with finishedAt >= finishedSince, newest first then id; at most `limit`. */
  findRecentJobs(scope: DashboardScope, finishedSince: Date, limit: number): Promise<DashboardRecentRow[]>;
  /** Count per active state in scope. States with no job are absent. */
  countActiveByState(scope: DashboardScope): Promise<Map<string, number>>;
  /** Pending approvals per job (status pending, jobId set). Jobs with none are absent. */
  pendingSummaryByJob(jobIds: readonly string[]): Promise<PendingSummary[]>;
}
```

- [ ] **Step 2: Write the failing integration test**

Create `apps/api/test/integration/fleet/fleet-dashboard-repository.integration.spec.ts`:

```ts
/**
 * Fleet S2b (c) slice 1 — dashboard repository reads (PG), spec §1.3.
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-dashboard-repository.integration.spec.ts
 */
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { insertRunner, seedFleetBase } from '../../helpers/fleet-fixtures';
import { PrismaDashboardRepository } from '../../../src/fleet/dashboard/prisma-dashboard.repository';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('fleet dashboard repository (PG)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let repo: PrismaDashboardRepository;
  let web: Awaited<ReturnType<typeof seedFleetBase>>;
  let ops: Awaited<ReturnType<typeof seedFleetBase>>;
  let gone: Awaited<ReturnType<typeof seedFleetBase>>;
  let runnerId: string;
  let n = 0;
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

  const job = (base: { projectId: string; repoId: string; adminId: string }, over: Partial<Prisma.FleetJobUncheckedCreateInput> = {}) =>
    prisma.fleetJob.create({
      data: {
        projectId: base.projectId, repoId: base.repoId, ref: 'main', command: 'RUN', feature: `f${++n}`, profiles: ['fast'],
        maxCostUsd: new Prisma.Decimal('2.5'), selectorLabels: [], requestedById: base.adminId, ...over,
      },
    });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    repo = app.get(PrismaDashboardRepository);
    web = await seedFleetBase(prisma);
    ops = await seedFleetBase(prisma);
    gone = await seedFleetBase(prisma);
    await prisma.project.update({ where: { id: gone.projectId }, data: { deletedAt: new Date() } });
    runnerId = (await insertRunner(prisma, { name: 'b-runner' })).id;
    await insertRunner(prisma, { name: 'a-runner' });
  });
  afterAll(async () => {
    await app.close();
  });

  it('lists runners by name with their raw capabilities', async () => {
    const runners = await repo.findRunners();
    expect(runners.map((r) => r.name)).toEqual(['a-runner', 'b-runner']);
    expect(runners[0]).toEqual(expect.objectContaining({ os: 'linux', arch: 'x64', capacity: 1, daemonVersion: '0.1.0', enabled: true }));
    expect((runners[0].capabilities as { nax: { version: string } }).nax.version).toBe('0.83.0');
  });

  it('reads active jobs per scope, skipping soft-deleted projects, with repo and project fields', async () => {
    const running = await job(web, { state: 'RUNNING', runnerId, queuedAt: minutesAgo(30), costSpentUsd: new Prisma.Decimal('0.125'), stories: [{ id: 'US-1', title: 't', status: 'passed', attempts: 1, dependsOn: [] }] as unknown as Prisma.InputJsonValue });
    const queued = await job(ops, { queuedAt: minutesAgo(20) });
    await job(gone, { queuedAt: minutesAgo(40) });
    const all = await repo.findActiveJobs({ kind: 'global' }, 10);
    expect(all.map((j) => j.id)).toEqual([running.id, queued.id]);
    expect(all[0]).toEqual(expect.objectContaining({
      projectSlug: web.projectSlug, projectDeleted: false, repoOwner: 'acme', provider: 'github', state: 'RUNNING', runnerId,
      costSpentUsd: '0.125', maxCostUsd: '2.5', stories: [expect.objectContaining({ id: 'US-1', status: 'passed' })],
    }));
    expect((await repo.findActiveJobs({ kind: 'project', projectId: ops.projectId }, 10)).map((j) => j.id)).toEqual([queued.id]);
    expect(await repo.findActiveJobs({ kind: 'global' }, 1)).toHaveLength(1);
  });

  it('reads the global queued window including soft-deleted projects, flagged', async () => {
    const window = await repo.findQueuedWindow(50);
    expect(window.map((j) => j.projectDeleted)).toEqual([true, false]);
  });

  it('counts active states per scope and lists held refs across projects', async () => {
    expect(Object.fromEntries(await repo.countActiveByState({ kind: 'global' }))).toEqual({ RUNNING: 1, QUEUED: 1 });
    expect(Object.fromEntries(await repo.countActiveByState({ kind: 'project', projectId: web.projectId }))).toEqual({ RUNNING: 1 });
    expect(await repo.findHeldRefs()).toEqual([{ runnerId, repoId: web.repoId }]);
  });

  it('reads recent terminal jobs inside the window, newest first, with the runner name', async () => {
    const newer = await job(web, { state: 'COMPLETED', runnerId, finishedAt: minutesAgo(5), resultPrUrl: 'https://x/pr/1' });
    const older = await job(web, { state: 'FAILED', stateReason: 'boom', finishedAt: minutesAgo(50) });
    await job(web, { state: 'COMPLETED', finishedAt: minutesAgo(60 * 25) });
    const recent = await repo.findRecentJobs({ kind: 'project', projectId: web.projectId }, minutesAgo(60 * 24), 10);
    expect(recent.map((r) => r.id)).toEqual([newer.id, older.id]);
    expect(recent[0]).toEqual(expect.objectContaining({ runnerName: 'b-runner', resultPrUrl: 'https://x/pr/1', repoName: expect.any(String) }));
    expect(recent[1]).toEqual(expect.objectContaining({ runnerName: null, stateReason: 'boom' }));
  });

  it('summarises pending approvals per job: count and oldest ask', async () => {
    const target = await job(web, { feature: 'asks', state: 'RUNNING', runnerId });
    const ask = (requestedAt: Date, status = 'pending') => prisma.fleetApproval.create({
      data: { type: 'nax_bash_escalate', status, projectId: web.projectId, jobId: target.id, payload: {}, requestedAt },
    });
    await ask(minutesAgo(3));
    await ask(minutesAgo(1));
    await ask(minutesAgo(9), 'approved');
    expect(await repo.pendingSummaryByJob([target.id, 'nope'])).toEqual([{ jobId: target.id, count: 2, oldestRequestedAt: expect.any(Date) }]);
    const [summary] = await repo.pendingSummaryByJob([target.id]);
    expect(Math.round((Date.now() - summary.oldestRequestedAt.getTime()) / 60_000)).toBe(3);
    expect(await repo.pendingSummaryByJob([])).toEqual([]);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd apps/api && bun run test:scoped test/integration/fleet/fleet-dashboard-repository.integration.spec.ts`
Expected: FAIL with `Cannot find module '../../../src/fleet/dashboard/prisma-dashboard.repository'`.

- [ ] **Step 4: Implement the repository**

Create `apps/api/src/fleet/dashboard/prisma-dashboard.repository.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { FleetJobKind, FleetJobState } from '../../common/enums';
import type { BashMode } from '../common/protocol';
import type { FleetJobStory } from '../jobs/domain/fleet-job.domain';
import { ACTIVE_STATES, RUNNER_HELD_STATES, TERMINAL_STATES } from '../jobs/job-state';
import type { DashboardJobRow, DashboardRecentRow, DashboardScope, PendingSummary } from './dashboard.types';
import type { IDashboardRepository, RawRunnerRow } from './domain/dashboard.domain';

const JOB_SELECT = {
  id: true, projectId: true, repoId: true, feature: true, command: true, state: true, runnerId: true, currentStoryId: true, currentPhase: true,
  stories: true, storiesTruncated: true, costSpentUsd: true, maxCostUsd: true, queuedAt: true, assignedAt: true, startedAt: true,
  lastHeartbeatAt: true, profiles: true, selectorLabels: true, pinnedRunnerId: true, bashMode: true,
  project: { select: { slug: true, deletedAt: true } },
  repo: { select: { owner: true, name: true, provider: true } },
} satisfies Prisma.FleetJobSelect;

const RECENT_SELECT = {
  id: true, feature: true, command: true, state: true, stateReason: true, costSpentUsd: true, startedAt: true, finishedAt: true, resultPrUrl: true,
  project: { select: { slug: true } },
  repo: { select: { owner: true, name: true } },
  runner: { select: { name: true } },
} satisfies Prisma.FleetJobSelect;

type JobSelected = Prisma.FleetJobGetPayload<{ select: typeof JOB_SELECT }>;
type RecentSelected = Prisma.FleetJobGetPayload<{ select: typeof RECENT_SELECT }>;

const toJobRow = (r: JobSelected): DashboardJobRow => ({
  id: r.id, projectId: r.projectId, projectSlug: r.project.slug, projectDeleted: r.project.deletedAt !== null,
  repoId: r.repoId, repoOwner: r.repo.owner, repoName: r.repo.name, provider: r.repo.provider as DashboardJobRow['provider'],
  feature: r.feature, command: r.command as FleetJobKind, state: r.state as FleetJobState, runnerId: r.runnerId,
  currentStoryId: r.currentStoryId, currentPhase: r.currentPhase, stories: r.stories as unknown as FleetJobStory[] | null,
  storiesTruncated: r.storiesTruncated, costSpentUsd: r.costSpentUsd.toString(), maxCostUsd: r.maxCostUsd.toString(),
  queuedAt: r.queuedAt, assignedAt: r.assignedAt, startedAt: r.startedAt, lastHeartbeatAt: r.lastHeartbeatAt,
  profiles: r.profiles, selectorLabels: r.selectorLabels, pinnedRunnerId: r.pinnedRunnerId, bashMode: r.bashMode as BashMode,
});

const toRecentRow = (r: RecentSelected): DashboardRecentRow => ({
  id: r.id, projectSlug: r.project.slug, repoOwner: r.repo.owner, repoName: r.repo.name, feature: r.feature,
  command: r.command as FleetJobKind, state: r.state as FleetJobState, stateReason: r.stateReason, runnerName: r.runner?.name ?? null,
  costSpentUsd: r.costSpentUsd.toString(), startedAt: r.startedAt, finishedAt: r.finishedAt as Date, resultPrUrl: r.resultPrUrl,
});

/** Scoped reads never show a soft-deleted project (spec §1.1). */
const scopeWhere = (scope: DashboardScope): Prisma.FleetJobWhereInput => ({
  project: { deletedAt: null },
  ...(scope.kind === 'project' ? { projectId: scope.projectId } : {}),
});

/** S2b (c) spec §1.3 (D402): the dashboard's own non-locking reads. */
@Injectable()
export class PrismaDashboardRepository implements IDashboardRepository {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  private get db() {
    return this.prisma.client;
  }

  async findRunners(): Promise<RawRunnerRow[]> {
    return this.db.runner.findMany({
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      select: { id: true, name: true, os: true, arch: true, labels: true, enabled: true, lastSeenAt: true, capacity: true, daemonVersion: true, capabilities: true },
    });
  }

  async findHeldRefs(): Promise<Array<{ runnerId: string; repoId: string }>> {
    const rows = await this.db.fleetJob.findMany({
      where: { state: { in: [...RUNNER_HELD_STATES] }, runnerId: { not: null } },
      orderBy: { id: 'asc' },
      select: { runnerId: true, repoId: true },
    });
    return rows.map((r) => ({ runnerId: r.runnerId as string, repoId: r.repoId }));
  }

  async findActiveJobs(scope: DashboardScope, limit: number): Promise<DashboardJobRow[]> {
    const rows = await this.db.fleetJob.findMany({
      where: { state: { in: [...ACTIVE_STATES] }, ...scopeWhere(scope) },
      orderBy: [{ queuedAt: 'asc' }, { id: 'asc' }], take: limit, select: JOB_SELECT,
    });
    return rows.map(toJobRow);
  }

  async findQueuedWindow(limit: number): Promise<DashboardJobRow[]> {
    const rows = await this.db.fleetJob.findMany({
      where: { state: FleetJobState.QUEUED },
      orderBy: [{ queuedAt: 'asc' }, { id: 'asc' }], take: limit, select: JOB_SELECT,
    });
    return rows.map(toJobRow);
  }

  async findRecentJobs(scope: DashboardScope, finishedSince: Date, limit: number): Promise<DashboardRecentRow[]> {
    const rows = await this.db.fleetJob.findMany({
      where: { state: { in: [...TERMINAL_STATES] }, finishedAt: { gte: finishedSince }, ...scopeWhere(scope) },
      orderBy: [{ finishedAt: 'desc' }, { id: 'asc' }], take: limit, select: RECENT_SELECT,
    });
    return rows.map(toRecentRow);
  }

  async countActiveByState(scope: DashboardScope): Promise<Map<string, number>> {
    const groups = await this.db.fleetJob.groupBy({
      by: ['state'], where: { state: { in: [...ACTIVE_STATES] }, ...scopeWhere(scope) }, _count: { _all: true },
    });
    return new Map(groups.map((g) => [g.state, g._count._all]));
  }

  async pendingSummaryByJob(jobIds: readonly string[]): Promise<PendingSummary[]> {
    if (jobIds.length === 0) return [];
    const groups = await this.db.fleetApproval.groupBy({
      by: ['jobId'], where: { status: 'pending', jobId: { in: [...jobIds] } }, _count: { _all: true }, _min: { requestedAt: true },
    });
    return groups.flatMap((g) => (g.jobId !== null && g._min.requestedAt !== null
      ? [{ jobId: g.jobId, count: g._count._all, oldestRequestedAt: g._min.requestedAt }]
      : []));
  }
}
```

The test resolves `PrismaDashboardRepository` from the booted app, so it must be a provider. Add the module now (controllers come in Task 7). Create `apps/api/src/fleet/dashboard/dashboard.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { DASHBOARD_REPOSITORY } from './domain/dashboard.domain';
import { PrismaDashboardRepository } from './prisma-dashboard.repository';

/** Fleet S2b (c) dashboard (spec docs/superpowers/specs/2026-10-05-fleet-s2b-c-dashboard-design.md). */
@Module({
  imports: [PrismaModule],
  providers: [PrismaDashboardRepository, { provide: DASHBOARD_REPOSITORY, useExisting: PrismaDashboardRepository }],
})
export class DashboardModule {}
```

In `apps/api/src/fleet/fleet.module.ts` add `import { DashboardModule } from './dashboard/dashboard.module';` and append `DashboardModule` to the `imports` array (after `AnalyticsModule`).

If `groupBy` with the relation filter in `scopeWhere` fails to type-check (`Prisma.FleetJobWhereInput` relation filters are accepted by `groupBy` in Prisma 5+), check the Prisma version (`grep '"prisma"' apps/api/package.json`) and keep the relation filter. Do not drop the soft-delete filter.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/api && bun run test:scoped test/integration/fleet/fleet-dashboard-repository.integration.spec.ts && bun run type-check && bunx eslint src/fleet/dashboard src/fleet/fleet.module.ts test/integration/fleet/fleet-dashboard-repository.integration.spec.ts --max-warnings=0`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/fleet/dashboard/domain apps/api/src/fleet/dashboard/prisma-dashboard.repository.ts apps/api/src/fleet/dashboard/dashboard.module.ts apps/api/src/fleet/fleet.module.ts apps/api/test/integration/fleet/fleet-dashboard-repository.integration.spec.ts
git commit -m "feat(fleet): dashboard repository reads (S2b (c) §1.3)"
```

---

### Task 6: Config keys, snapshot view and `FleetDashboardService`

**Files:**
- Modify: `apps/api/src/config/fleet.config.ts`
- Modify: `apps/api/src/config/fleet.config.spec.ts`
- Modify: `apps/api/src/config/env.validation.ts`
- Modify: `apps/api/src/common/test-helpers/fleet-config.ts`
- Create: `apps/api/src/fleet/dashboard/dashboard-view.ts`
- Create: `apps/api/src/fleet/dashboard/dashboard.service.ts`
- Modify: `apps/api/src/fleet/dashboard/dashboard.module.ts`
- Test: `apps/api/src/fleet/dashboard/dashboard-view.spec.ts`
- Test: `apps/api/src/fleet/dashboard/dashboard.service.spec.ts`

**Interfaces:**
- Consumes: `IDashboardRepository`, `DASHBOARD_REPOSITORY` (Task 5); `buildAttention` (Task 4); `toLoads`, `QUEUED_SCAN_LIMIT` (Task 1); `BudgetGate` (`budgets/budget-gate.ts`, from `BudgetStoreModule`); `parseCapabilitiesCore`, `CapabilityValidationError` (`fleet/common/capabilities-core.ts`).
- Produces:
  - `IFleetConfig` gains `jobSilentSec`, `jobSilentErrorSec`, `jobStartSec`, `jobQueuedWarnSec` (numbers)
  - `dashboard-view.ts`: `readCapabilities(raw: unknown): RunnerCapabilities | null`; view interfaces `DashboardCredentialView`, `DashboardRunnerView`, `DashboardActiveJobView`, `DashboardRecentJobView`, `DashboardCountsView`, `DashboardView`; `buildDashboardView(input: ViewInput): DashboardView`
  - `FleetDashboardService.snapshot(scope: DashboardScope, now: Date): Promise<DashboardView>`

- [ ] **Step 1: Write the failing config tests**

Append to `apps/api/src/config/fleet.config.spec.ts` inside `describe('fleet config', ...)`:

```ts
  it('defaults the dashboard thresholds (S2b (c) §2, D404) and reads overrides', () => {
    delete process.env.FLEET_JOB_SILENT_SEC;
    delete process.env.FLEET_JOB_SILENT_ERROR_SEC;
    delete process.env.FLEET_JOB_START_SEC;
    delete process.env.FLEET_JOB_QUEUED_WARN_SEC;
    expect(fleetConfig()).toEqual(expect.objectContaining({ jobSilentSec: 180, jobSilentErrorSec: 600, jobStartSec: 300, jobQueuedWarnSec: 60 }));
    process.env.FLEET_JOB_SILENT_SEC = '240';
    expect(fleetConfig().jobSilentSec).toBe(240);
  });

  it.each([
    ['FLEET_JOB_SILENT_SEC', 'abc'],
    ['FLEET_JOB_SILENT_ERROR_SEC', '5'],
    ['FLEET_JOB_START_SEC', '-1'],
    ['FLEET_JOB_QUEUED_WARN_SEC', '1.5'],
  ])('refuses boot on a bad dashboard threshold %s', (key, value) => {
    expect(() => validate({ ...BASE, [key]: value })).toThrow();
  });
```

- [ ] **Step 2: Write the failing view and service tests**

Create `apps/api/src/fleet/dashboard/dashboard-view.spec.ts`:

```ts
import { DASH_NOW, dashCaps, dashJob, dashRunner, secAgo } from '../../common/test-helpers/fleet-dashboard';
import { buildDashboardView, readCapabilities, ViewInput } from './dashboard-view';
import type { DashboardRecentRow } from './dashboard.types';

const recent = (over: Partial<DashboardRecentRow> = {}): DashboardRecentRow => ({
  id: 'd1', projectSlug: 'web', repoOwner: 'acme', repoName: 'app', feature: 'done', command: 'RUN', state: 'COMPLETED', stateReason: null,
  runnerName: 'wk-mac', costSpentUsd: '0.1', startedAt: secAgo(4000), finishedAt: secAgo(3600), resultPrUrl: null, ...over,
});

const input = (over: Partial<ViewInput> = {}): ViewInput => ({
  scope: { kind: 'global' }, now: DASH_NOW, offlineSec: 90,
  runners: [dashRunner(), dashRunner({ id: 'r2', name: 'old-box', lastSeenAt: secAgo(500), capabilities: null })],
  heldByRunner: new Map([['r1', 1]]),
  active: [dashJob({ stories: [
    { id: 'US-1', title: 'a', status: 'passed', attempts: 1, dependsOn: [] },
    { id: 'US-2', title: 'b', status: 'in-progress', attempts: 1, dependsOn: [] },
  ] })],
  recent: [recent()], counts: new Map([['RUNNING', 1], ['QUEUED', 3], ['ASSIGNED', 1]]),
  pending: new Map([['j1', { jobId: 'j1', count: 2, oldestRequestedAt: secAgo(60) }]]), attention: [],
  ...over,
});

describe('readCapabilities (spec §1.4)', () => {
  it('returns a clean copy of a valid blob and null for a corrupt one', () => {
    expect(readCapabilities(dashCaps())?.nax.version).toBe('0.83.3');
    expect(readCapabilities({ nax: 'nope' })).toBeNull();
    expect(readCapabilities(null)).toBeNull();
  });
});

describe('buildDashboardView (spec §1.2)', () => {
  it('builds counts over the full scope and the admin runner digest', () => {
    const v = buildDashboardView(input());
    expect(v.generatedAt).toBe(DASH_NOW.toISOString());
    expect(v.counts).toEqual({ runnersOnline: 1, runnersTotal: 2, queued: 3, running: 2, attention: 0 });
    expect(v.runners[0]).toEqual({
      id: 'r1', name: 'wk-mac', os: 'darwin', arch: 'arm64', labels: ['mac'], enabled: true, online: true, lastSeenAt: secAgo(10).toISOString(),
      capacity: 1, activeJobs: 1, naxVersion: '0.83.3', daemonVersion: '0.4.0',
      credentials: [{ providerId: 'deepseek', available: true, kind: 'api-key', expiresAt: null, expired: false }],
    });
    expect(v.runners[1]).toEqual(expect.objectContaining({ online: false, activeJobs: 0, naxVersion: null, credentials: [] }));
  });

  it('hides versions and credentials in project scope (B5)', () => {
    const v = buildDashboardView(input({ scope: { kind: 'project', projectId: 'p1' } }));
    expect(v.runners[0]).toEqual(expect.objectContaining({ naxVersion: null, daemonVersion: null, credentials: [] }));
  });

  it('maps active jobs with stories progress, runner name and pending approvals', () => {
    expect(buildDashboardView(input()).activeJobs[0]).toEqual({
      id: 'j1', projectSlug: 'web', repo: 'acme/app', feature: 'add-auth', command: 'RUN', state: 'RUNNING', runnerId: 'r1', runnerName: 'wk-mac',
      currentStoryId: 'US-001', currentPhase: 'implement', storiesDone: 1, storiesTotal: 2, costSpentUsd: '0.42', maxCostUsd: '2',
      queuedAt: secAgo(900).toISOString(), startedAt: secAgo(880).toISOString(), lastHeartbeatAt: secAgo(30).toISOString(), pendingApprovals: 2,
    });
  });

  it('nulls stories progress when stories are absent or truncated, and the runner name for an unknown runner', () => {
    const v = buildDashboardView(input({ active: [dashJob({ storiesTruncated: true, stories: [] }), dashJob({ id: 'j2', runnerId: 'gone' })] }));
    expect(v.activeJobs.map((j) => [j.storiesDone, j.storiesTotal, j.runnerName])).toEqual([[null, null, 'wk-mac'], [null, null, null]]);
  });

  it('caps the lists and flags truncation', () => {
    const active = Array.from({ length: 201 }, (_, i) => dashJob({ id: `j${i}` }));
    const recentRows = Array.from({ length: 21 }, (_, i) => recent({ id: `d${i}` }));
    const v = buildDashboardView(input({ active, recent: recentRows }));
    expect([v.activeJobs.length, v.activeTruncated, v.recentJobs.length, v.recentTruncated]).toEqual([200, true, 20, true]);
    expect(buildDashboardView(input()).activeTruncated).toBe(false);
  });

  it('maps recent jobs', () => {
    expect(buildDashboardView(input()).recentJobs[0]).toEqual({
      id: 'd1', projectSlug: 'web', repo: 'acme/app', feature: 'done', command: 'RUN', state: 'COMPLETED', stateReason: null, runnerName: 'wk-mac',
      costSpentUsd: '0.1', startedAt: secAgo(4000).toISOString(), finishedAt: secAgo(3600).toISOString(), resultPrUrl: null,
    });
  });
});
```

Create `apps/api/src/fleet/dashboard/dashboard.service.spec.ts`:

```ts
import { testFleetConfig } from '../../common/test-helpers/fleet-config';
import { DASH_NOW, dashCaps, dashJob, secAgo } from '../../common/test-helpers/fleet-dashboard';
import { PauseSnapshot } from '../budgets/budget-rules';
import type { BudgetGate } from '../budgets/budget-gate';
import { FleetDashboardService } from './dashboard.service';
import type { IDashboardRepository, RawRunnerRow } from './domain/dashboard.domain';

const rawRunner = (over: Partial<RawRunnerRow> = {}): RawRunnerRow => ({
  id: 'r1', name: 'wk-mac', os: 'darwin', arch: 'arm64', labels: ['mac'], enabled: true, lastSeenAt: secAgo(10), capacity: 1,
  daemonVersion: '0.4.0', capabilities: dashCaps(), ...over,
});

function fakeRepo(over: Partial<IDashboardRepository> = {}): jest.Mocked<IDashboardRepository> {
  return {
    findRunners: jest.fn().mockResolvedValue([rawRunner(), rawRunner({ id: 'r2', name: 'corrupt', capabilities: { broken: true } })]),
    findHeldRefs: jest.fn().mockResolvedValue([{ runnerId: 'r1', repoId: 'repo1' }]),
    findActiveJobs: jest.fn().mockResolvedValue([dashJob({ lastHeartbeatAt: secAgo(700) })]),
    findQueuedWindow: jest.fn().mockResolvedValue([]),
    findRecentJobs: jest.fn().mockResolvedValue([]),
    countActiveByState: jest.fn().mockResolvedValue(new Map([['RUNNING', 1]])),
    pendingSummaryByJob: jest.fn().mockResolvedValue([]),
    ...over,
  } as jest.Mocked<IDashboardRepository>;
}

const budgets = { snapshot: jest.fn().mockResolvedValue(PauseSnapshot.of([], DASH_NOW)) } as unknown as BudgetGate;

describe('FleetDashboardService (S2b (c) §1)', () => {
  it('reads with the caps and windows of the spec and tolerates a corrupt runner', async () => {
    const repo = fakeRepo();
    const service = new FleetDashboardService(repo, budgets, testFleetConfig());
    const v = await service.snapshot({ kind: 'project', projectId: 'p1' }, DASH_NOW);
    expect(repo.findActiveJobs).toHaveBeenCalledWith({ kind: 'project', projectId: 'p1' }, 201);
    expect(repo.findQueuedWindow).toHaveBeenCalledWith(50);
    expect(repo.findRecentJobs).toHaveBeenCalledWith({ kind: 'project', projectId: 'p1' }, new Date(DASH_NOW.getTime() - 86_400_000), 21);
    expect(repo.pendingSummaryByJob).toHaveBeenCalledWith(['j1']);
    expect(v.attention.map((a) => [a.kind, a.severity])).toEqual([['job_silent', 'error']]);
    // Global scope shows versions, so a wrong readCapabilities would show here (project scope nulls them anyway).
    const g = await new FleetDashboardService(fakeRepo(), budgets, testFleetConfig()).snapshot({ kind: 'global' }, DASH_NOW);
    expect(g.runners.find((r) => r.id === 'r2')).toEqual(expect.objectContaining({ naxVersion: null, credentials: [], online: true }));
    expect(g.runners.find((r) => r.id === 'r1')?.naxVersion).toBe('0.83.3');
  });

  it('asks pending approvals only for the listed (capped) jobs', async () => {
    const many = Array.from({ length: 201 }, (_, i) => dashJob({ id: `j${i}` }));
    const repo = fakeRepo({ findActiveJobs: jest.fn().mockResolvedValue(many) });
    await new FleetDashboardService(repo, budgets, testFleetConfig()).snapshot({ kind: 'global' }, DASH_NOW);
    expect(repo.pendingSummaryByJob.mock.calls[0][0]).toHaveLength(200);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd apps/api && bunx jest src/config/fleet.config.spec.ts src/fleet/dashboard/dashboard-view.spec.ts src/fleet/dashboard/dashboard.service.spec.ts`
Expected: FAIL. The config test fails because `jobSilentSec` is undefined, and the other two fail on missing modules.

- [ ] **Step 4: Add the config keys**

In `apps/api/src/config/fleet.config.ts`:

1. In `IFleetConfig`, after `testHooksEnabled: boolean;`, add:

```ts
  /** S2b (c) §2.1: RUNNING job heartbeat age (s) before a dashboard warning; nax beats every 60 s (D404). */
  jobSilentSec: number;
  /** S2b (c) §2.1: heartbeat age (s) before the warning becomes an error; read as max(this, jobSilentSec). */
  jobSilentErrorSec: number;
  /** S2b (c) §2.1: ASSIGNED job age (s) before a "not started" warning. */
  jobStartSec: number;
  /** S2b (c) §2.3: QUEUED job age (s) before the dashboard dry-run reports it. */
  jobQueuedWarnSec: number;
```

2. In `FleetConfigSchema`, after `FLEET_TEST_HOOKS`, add:

```ts
  @IsOptional() @IsString() FLEET_JOB_SILENT_SEC: string;
  @IsOptional() @IsString() FLEET_JOB_SILENT_ERROR_SEC: string;
  @IsOptional() @IsString() FLEET_JOB_START_SEC: string;
  @IsOptional() @IsString() FLEET_JOB_QUEUED_WARN_SEC: string;
```

3. In the `registerAs` factory's returned object, after `testHooksEnabled: ...`, add:

```ts
    jobSilentSec: int('FLEET_JOB_SILENT_SEC', 180),
    jobSilentErrorSec: int('FLEET_JOB_SILENT_ERROR_SEC', 600),
    jobStartSec: int('FLEET_JOB_START_SEC', 300),
    jobQueuedWarnSec: int('FLEET_JOB_QUEUED_WARN_SEC', 60),
```

In `apps/api/src/config/env.validation.ts`, after the `FLEET_GITLAB_TOKEN_TTL_SEC` entry (boot-time bounds like every other numeric `FLEET_*` key, so a typo cannot silently turn the rules off with `NaN`), add:

```ts
  FLEET_JOB_SILENT_SEC: Joi.number().integer().min(30).max(86_400).optional(),
  FLEET_JOB_SILENT_ERROR_SEC: Joi.number().integer().min(30).max(86_400).optional(),
  FLEET_JOB_START_SEC: Joi.number().integer().min(30).max(86_400).optional(),
  FLEET_JOB_QUEUED_WARN_SEC: Joi.number().integer().min(10).max(86_400).optional(),
```

In `apps/api/src/common/test-helpers/fleet-config.ts`, after `testHooksEnabled: false,` add:

```ts
    jobSilentSec: 180,
    jobSilentErrorSec: 600,
    jobStartSec: 300,
    jobQueuedWarnSec: 60,
```

Then find every other complete `IFleetConfig` literal so type-check stays green: `grep -rln "testHooksEnabled" apps/api/src apps/api/test`. Add the same four fields to any literal that is not built from `testFleetConfig()`.

- [ ] **Step 5: Implement `dashboard-view.ts`**

```ts
import type { RunnerCapabilities } from '../common/protocol';
import { CapabilityValidationError, parseCapabilitiesCore } from '../common/capabilities-core';
import { isRunnerOnline } from '../common/runner-online';
import { FleetJobState } from '../../common/enums';
import {
  AttentionItem, DASHBOARD_LIMITS, DashboardJobRow, DashboardRecentRow, DashboardRunnerRow, DashboardScope, PendingSummary,
} from './dashboard.types';

export interface DashboardCredentialView {
  providerId: string;
  available: boolean;
  kind: 'api-key' | 'oauth' | null;
  expiresAt: string | null;
  expired: boolean;
}

export interface DashboardRunnerView {
  id: string;
  name: string;
  os: string;
  arch: string;
  labels: string[];
  enabled: boolean;
  online: boolean;
  lastSeenAt: string;
  capacity: number;
  activeJobs: number;
  naxVersion: string | null;
  daemonVersion: string | null;
  credentials: DashboardCredentialView[];
}

export interface DashboardActiveJobView {
  id: string;
  projectSlug: string;
  repo: string;
  feature: string;
  command: string;
  state: string;
  runnerId: string | null;
  runnerName: string | null;
  currentStoryId: string | null;
  currentPhase: string | null;
  storiesDone: number | null;
  storiesTotal: number | null;
  costSpentUsd: string;
  maxCostUsd: string;
  queuedAt: string;
  startedAt: string | null;
  lastHeartbeatAt: string | null;
  pendingApprovals: number;
}

export interface DashboardRecentJobView {
  id: string;
  projectSlug: string;
  repo: string;
  feature: string;
  command: string;
  state: string;
  stateReason: string | null;
  runnerName: string | null;
  costSpentUsd: string;
  startedAt: string | null;
  finishedAt: string;
  resultPrUrl: string | null;
}

export interface DashboardCountsView {
  runnersOnline: number;
  runnersTotal: number;
  queued: number;
  running: number;
  attention: number;
}

export interface DashboardView {
  generatedAt: string;
  counts: DashboardCountsView;
  runners: DashboardRunnerView[];
  activeJobs: DashboardActiveJobView[];
  activeTruncated: boolean;
  recentJobs: DashboardRecentJobView[];
  recentTruncated: boolean;
  attention: AttentionItem[];
}

export interface ViewInput {
  scope: DashboardScope;
  now: Date;
  offlineSec: number;
  runners: readonly DashboardRunnerRow[];
  heldByRunner: ReadonlyMap<string, number>;
  /** As read: up to DASHBOARD_LIMITS.activeJobs + 1 (the extra row only sets activeTruncated). */
  active: readonly DashboardJobRow[];
  /** As read: up to DASHBOARD_LIMITS.recentJobs + 1. */
  recent: readonly DashboardRecentRow[];
  counts: ReadonlyMap<string, number>;
  pending: ReadonlyMap<string, PendingSummary>;
  attention: AttentionItem[];
}

/** Spec §1.4: re-validates a stored blob; a corrupt one degrades to null instead of failing the snapshot. */
export function readCapabilities(raw: unknown): RunnerCapabilities | null {
  try {
    return parseCapabilitiesCore(raw);
  } catch (error) {
    if (error instanceof CapabilityValidationError) return null;
    throw error;
  }
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

function runnerView(r: DashboardRunnerRow, input: ViewInput): DashboardRunnerView {
  const admin = input.scope.kind === 'global';
  return {
    id: r.id, name: r.name, os: r.os, arch: r.arch, labels: r.labels, enabled: r.enabled,
    online: isRunnerOnline(r.lastSeenAt, input.now, input.offlineSec), lastSeenAt: r.lastSeenAt.toISOString(), capacity: r.capacity,
    activeJobs: input.heldByRunner.get(r.id) ?? 0,
    naxVersion: admin ? (r.capabilities?.nax.version ?? null) : null,
    daemonVersion: admin ? r.daemonVersion : null,
    credentials: admin && r.capabilities
      ? r.capabilities.credentials.map((c) => ({
        providerId: c.providerId, available: c.available, kind: c.stored?.kind ?? null, expiresAt: c.stored?.expires ?? null, expired: c.stored?.expired ?? false,
      }))
      : [],
  };
}

function activeView(j: DashboardJobRow, input: ViewInput, names: ReadonlyMap<string, string>): DashboardActiveJobView {
  const stories = j.stories && !j.storiesTruncated ? j.stories : null;
  return {
    id: j.id, projectSlug: j.projectSlug, repo: `${j.repoOwner}/${j.repoName}`, feature: j.feature, command: j.command, state: j.state,
    runnerId: j.runnerId, runnerName: j.runnerId ? (names.get(j.runnerId) ?? null) : null,
    currentStoryId: j.currentStoryId, currentPhase: j.currentPhase,
    storiesDone: stories ? stories.filter((s) => s.status === 'passed').length : null, storiesTotal: stories ? stories.length : null,
    costSpentUsd: j.costSpentUsd, maxCostUsd: j.maxCostUsd, queuedAt: j.queuedAt.toISOString(), startedAt: iso(j.startedAt),
    lastHeartbeatAt: iso(j.lastHeartbeatAt), pendingApprovals: input.pending.get(j.id)?.count ?? 0,
  };
}

const recentView = (r: DashboardRecentRow): DashboardRecentJobView => ({
  id: r.id, projectSlug: r.projectSlug, repo: `${r.repoOwner}/${r.repoName}`, feature: r.feature, command: r.command, state: r.state,
  stateReason: r.stateReason, runnerName: r.runnerName, costSpentUsd: r.costSpentUsd, startedAt: iso(r.startedAt),
  finishedAt: r.finishedAt.toISOString(), resultPrUrl: r.resultPrUrl,
});

/** Spec §1.2: one consistent snapshot; counts come from the full-scope grouped counts, never the capped lists. */
export function buildDashboardView(input: ViewInput): DashboardView {
  const names = new Map(input.runners.map((r) => [r.id, r.name] as const));
  const runners = input.runners.map((r) => runnerView(r, input));
  const count = (state: string): number => input.counts.get(state) ?? 0;
  return {
    generatedAt: input.now.toISOString(),
    counts: {
      runnersOnline: runners.filter((r) => r.online).length, runnersTotal: runners.length, queued: count(FleetJobState.QUEUED),
      running: count(FleetJobState.ASSIGNED) + count(FleetJobState.RUNNING) + count(FleetJobState.UPLOADING), attention: input.attention.length,
    },
    runners,
    activeJobs: input.active.slice(0, DASHBOARD_LIMITS.activeJobs).map((j) => activeView(j, input, names)),
    activeTruncated: input.active.length > DASHBOARD_LIMITS.activeJobs,
    recentJobs: input.recent.slice(0, DASHBOARD_LIMITS.recentJobs).map(recentView),
    recentTruncated: input.recent.length > DASHBOARD_LIMITS.recentJobs,
    attention: input.attention,
  };
}
```

Check that `parseCapabilitiesCore` is exported from `capabilities-core.ts` (`grep -n "export function parseCapabilitiesCore" apps/api/src/fleet/common/capabilities-core.ts`). It is what `capabilities.ts` wraps.

- [ ] **Step 6: Implement the service and register it**

Create `apps/api/src/fleet/dashboard/dashboard.service.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common';
import { FLEET_CFG, IFleetConfig } from '../../config/fleet.config';
import { BudgetGate } from '../budgets/budget-gate';
import { QUEUED_SCAN_LIMIT, toLoads } from '../jobs/placement-rules';
import { buildAttention } from './attention-rules';
import { buildDashboardView, DashboardView, readCapabilities } from './dashboard-view';
import { AttentionThresholds, DASHBOARD_LIMITS, DashboardRunnerRow, DashboardScope } from './dashboard.types';
import { DASHBOARD_REPOSITORY, IDashboardRepository } from './domain/dashboard.domain';

type DashboardConfig = Pick<IFleetConfig, 'runnerOfflineSec' | 'jobSilentSec' | 'jobSilentErrorSec' | 'jobStartSec' | 'jobQueuedWarnSec'>;

/** S2b (c) spec §1: one snapshot per request; reads in parallel, no transaction (D411). */
@Injectable()
export class FleetDashboardService {
  constructor(
    @Inject(DASHBOARD_REPOSITORY) private readonly repo: IDashboardRepository,
    private readonly budgets: BudgetGate,
    @Inject(FLEET_CFG) private readonly cfg: DashboardConfig,
  ) {}

  async snapshot(scope: DashboardScope, now: Date): Promise<DashboardView> {
    const [rawRunners, held, active, queued, recent, counts, pauses] = await Promise.all([
      this.repo.findRunners(),
      this.repo.findHeldRefs(),
      this.repo.findActiveJobs(scope, DASHBOARD_LIMITS.activeJobs + 1),
      this.repo.findQueuedWindow(QUEUED_SCAN_LIMIT),
      this.repo.findRecentJobs(scope, new Date(now.getTime() - DASHBOARD_LIMITS.recentWindowMs), DASHBOARD_LIMITS.recentJobs + 1),
      this.repo.countActiveByState(scope),
      this.budgets.snapshot(now),
    ]);
    const listed = active.slice(0, DASHBOARD_LIMITS.activeJobs);
    const pending = new Map((await this.repo.pendingSummaryByJob(listed.map((j) => j.id))).map((p) => [p.jobId, p] as const));
    const runners: DashboardRunnerRow[] = rawRunners.map((r) => ({ ...r, capabilities: readCapabilities(r.capabilities) }));
    const loads = toLoads(held);
    const heldByRunner = new Map([...loads].map(([id, load]) => [id, load.active] as const));
    const thresholds: AttentionThresholds = {
      runnerOfflineSec: this.cfg.runnerOfflineSec, jobSilentSec: this.cfg.jobSilentSec, jobSilentErrorSec: this.cfg.jobSilentErrorSec,
      jobStartSec: this.cfg.jobStartSec, jobQueuedWarnSec: this.cfg.jobQueuedWarnSec,
    };
    const attention = buildAttention({ scope, runners, heldByRunner, activeJobs: listed, pending, dryRun: { queued, loads, pauses } }, now, thresholds);
    return buildDashboardView({ scope, now, offlineSec: this.cfg.runnerOfflineSec, runners, heldByRunner, active, recent, counts, pending, attention });
  }
}
```

Replace `apps/api/src/fleet/dashboard/dashboard.module.ts` with:

```ts
import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { BudgetStoreModule } from '../budgets/budget-store.module';
import { FleetDashboardService } from './dashboard.service';
import { DASHBOARD_REPOSITORY } from './domain/dashboard.domain';
import { PrismaDashboardRepository } from './prisma-dashboard.repository';

/** Fleet S2b (c) dashboard (spec docs/superpowers/specs/2026-10-05-fleet-s2b-c-dashboard-design.md). */
@Module({
  imports: [PrismaModule, BudgetStoreModule],
  providers: [PrismaDashboardRepository, { provide: DASHBOARD_REPOSITORY, useExisting: PrismaDashboardRepository }, FleetDashboardService],
})
export class DashboardModule {}
```

In `apps/api/src/fleet/fleet.module.spec.ts`, add `import { FleetDashboardService } from './dashboard/dashboard.service';` and the line `expect(module.get(FleetDashboardService)).toBeDefined();` at the end of the `compiles with its providers resolvable` test.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd apps/api && bunx jest src/config/fleet.config.spec.ts src/fleet/dashboard src/fleet/fleet.module.spec.ts && bun run type-check && bunx eslint src/config src/common/test-helpers src/fleet/dashboard src/fleet/fleet.module.spec.ts --max-warnings=0`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/config/fleet.config.ts apps/api/src/config/fleet.config.spec.ts apps/api/src/config/env.validation.ts apps/api/src/common/test-helpers/fleet-config.ts apps/api/src/fleet/dashboard apps/api/src/fleet/fleet.module.spec.ts
git commit -m "feat(fleet): dashboard snapshot view and service with threshold config (S2b (c) §1.2, §2)"
```

If Step 4's grep found other `IFleetConfig` literals, add them to `git add`.

---
### Task 7: DTOs, both routes, HTTP integration test, contract and regenerate

**Files:**
- Create: `apps/api/src/fleet/dashboard/dto/fleet-dashboard.dto.ts`
- Create: `apps/api/src/fleet/dashboard/fleet-dashboard.controller.ts`
- Create: `apps/api/src/fleet/dashboard/project-fleet-dashboard.controller.ts`
- Modify: `apps/api/src/fleet/dashboard/dashboard.module.ts`
- Modify: `apps/api/src/fleet/fleet-openapi.contract.spec.ts`
- Regenerate: `openapi.json`, `apps/cli/src/generated/**`
- Test: `apps/api/test/integration/fleet/fleet-dashboard-api.integration.spec.ts`

**Interfaces:**
- Consumes: `FleetDashboardService.snapshot` (Task 6); the view interfaces in `dashboard-view.ts`; the enum constants in `dashboard.types.ts`.
- Produces:
  - DTO classes (OpenAPI schema names the CLI imports): `FleetDashboardDto`, `DashboardCountsDto`, `DashboardRunnerDto`, `DashboardCredentialDto`, `DashboardActiveJobDto`, `DashboardRecentJobDto`, `AttentionItemDto`, `AttentionReasonDto`, `RunnerConditionDto`
  - Routes `GET /api/fleet/dashboard` (operation `FleetDashboardController.get`, generated `fleetDashboardControllerGet`) and `GET /api/projects/{slug}/fleet/dashboard` (`ProjectFleetDashboardController.get`, generated `projectFleetDashboardControllerGet`)

- [ ] **Step 1: Write the failing HTTP integration test**

Create `apps/api/test/integration/fleet/fleet-dashboard-api.integration.spec.ts`:

```ts
/**
 * Fleet S2b (c) slice 1 — dashboard routes (PG): both scopes, the scope boundary, bounds, placement parity.
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-dashboard-api.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { FLEET_CAPS, FleetHttpWorld, insertRunner, seedFleetHttpAgent, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { PlacementService } from '../../../src/fleet/jobs/placement.service';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

interface Item { key: string; kind: string; severity: string; subjectId: string; verdict?: string; reasons?: Array<{ runnerName: string; reason: string }>; conditions?: Array<Record<string, unknown>> }
interface Snapshot {
  counts: { runnersOnline: number; runnersTotal: number; queued: number; running: number; attention: number };
  runners: Array<{ name: string; naxVersion: string | null; daemonVersion: string | null; credentials: unknown[]; activeJobs: number; online: boolean }>;
  activeJobs: Array<{ id: string; pendingApprovals: number }>;
  activeTruncated: boolean;
  recentJobs: Array<{ id: string }>;
  recentTruncated: boolean;
  attention: Item[];
}

describeIntegration('fleet dashboard API (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let agentKey: string;
  const ids: Record<string, string> = {};
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);
  const auth = (who: keyof FleetHttpWorld['tokens']) => ({ Authorization: `Bearer ${world.tokens[who]}` });
  const admin = async () => data<Snapshot>(await request(server).get('/api/fleet/dashboard').set(auth('root')).expect(200));
  const project = async (who: keyof FleetHttpWorld['tokens'] = 'viewer') =>
    request(server).get('/api/projects/web/fleet/dashboard').set(auth(who)).expect(200);
  const item = (s: Snapshot, key: string) => s.attention.find((a) => a.key === key);

  const job = (o: { projectId: string; repoId: string }, over: Partial<Prisma.FleetJobUncheckedCreateInput>) => prisma.fleetJob.create({
    data: {
      projectId: o.projectId, repoId: o.repoId, ref: 'main', command: 'RUN', profiles: ['fast'], maxCostUsd: new Prisma.Decimal(2),
      selectorLabels: [], requestedById: world.ids.root, feature: 'x', ...over,
    },
  });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(server, prisma);
    agentKey = (await seedFleetHttpAgent(server, world.tokens.root)).apiKey;
    const web = { projectId: world.projectId, repoId: world.repoId };
    const ops = { projectId: world.opsProjectId, repoId: world.foreignRepoId };

    ids.wkMac = (await insertRunner(prisma, { name: 'wk-mac', labels: ['linux'] })).id;
    ids.oldBox = (await insertRunner(prisma, {
      name: 'old-box', lastSeenAt: minutesAgo(10),
      capabilities: { ...FLEET_CAPS, nax: { version: '0.82.0', protocols: ['native'] }, credentials: [{ providerId: 'deepseek', available: false, stored: null, ambient: false }] },
    })).id;

    ids.silent = (await job(web, {
      feature: 'silent-run', state: 'RUNNING', runnerId: ids.wkMac, runnerBootId: 'boot-1', leaseEpoch: 1,
      queuedAt: minutesAgo(20), assignedAt: minutesAgo(19), startedAt: minutesAgo(18), lastHeartbeatAt: minutesAgo(12),
    })).id;
    ids.secret = (await job(ops, {
      feature: 'secret-feature', state: 'RUNNING', runnerId: ids.oldBox, runnerBootId: 'boot-1', leaseEpoch: 1,
      queuedAt: minutesAgo(17), assignedAt: minutesAgo(16), startedAt: minutesAgo(15), lastHeartbeatAt: minutesAgo(12),
    })).id;
    ids.needsGpu = (await job(web, { feature: 'needs-gpu', selectorLabels: ['gpu'], queuedAt: minutesAgo(5) })).id;
    ids.opsQueued = (await job(ops, { feature: 'ops-queued', selectorLabels: ['gpu'], queuedAt: minutesAgo(4) })).id;
    ids.doneRecent = (await job(web, { feature: 'done-recent', state: 'COMPLETED', finishedAt: minutesAgo(60) })).id;
    await job(web, { feature: 'done-old', state: 'COMPLETED', finishedAt: minutesAgo(60 * 25) });
    await prisma.fleetApproval.create({
      data: { type: 'nax_bash_escalate', projectId: world.projectId, jobId: ids.silent, payload: {}, requestedAt: minutesAgo(3) },
    });

    const gone = await prisma.project.create({ data: { name: 'gone', slug: 'gone', key: 'GONE', deletedAt: new Date() } });
    const goneRepo = await prisma.fleetRepo.create({
      data: { projectId: gone.id, provider: 'github', owner: 'acme', name: 'gone', defaultBranch: 'main', githubInstallationId: BigInt(77), createdById: world.ids.root },
    });
    ids.ghost = (await job({ projectId: gone.id, repoId: goneRepo.id }, { feature: 'ghost-job', queuedAt: minutesAgo(30) })).id;
  });
  afterAll(async () => {
    await app.close();
  });

  it('refuses non-admins on the admin route, outsiders and agent keys on the project route', async () => {
    await request(server).get('/api/fleet/dashboard').set(auth('dev')).expect(403);
    await request(server).get('/api/projects/web/fleet/dashboard').set(auth('outsider')).expect(403);
    await request(server).get('/api/projects/web/fleet/dashboard').set({ Authorization: `Bearer ${agentKey}` }).expect(403);
    await request(server).get('/api/projects/nope/fleet/dashboard').set(auth('root')).expect(404);
  });

  it('admin scope: counts, lists and digest across projects, soft-deleted project left out', async () => {
    const s = await admin();
    expect(s.counts).toEqual({ runnersOnline: 1, runnersTotal: 2, queued: 2, running: 2, attention: s.attention.length });
    expect(s.activeJobs.map((j) => j.id)).toEqual([ids.silent, ids.secret, ids.needsGpu, ids.opsQueued]);
    expect(s.activeJobs[0].pendingApprovals).toBe(1);
    expect(s.recentJobs.map((j) => j.id)).toEqual([ids.doneRecent]);
    expect([s.activeTruncated, s.recentTruncated]).toEqual([false, false]);
    expect(s.runners.map((r) => [r.name, r.naxVersion, r.activeJobs, r.online])).toEqual([['old-box', '0.82.0', 1, false], ['wk-mac', '0.83.0', 1, true]]);
    expect(s.runners[1].credentials).toEqual([{ providerId: 'deepseek', available: true, kind: 'api-key', expiresAt: null, expired: false }]);
    expect(JSON.stringify(s)).not.toContain(ids.ghost);
  });

  it('admin scope: the four signals, errors first', async () => {
    const s = await admin();
    expect(item(s, `job_waiting_approval:${ids.silent}`)).toMatchObject({ severity: 'error' });
    expect(item(s, `job_silent:${ids.silent}`)).toMatchObject({ severity: 'error', kind: 'job_silent' });
    expect(item(s, `job_silent:${ids.secret}`)).toBeUndefined();
    expect(item(s, `runner_unhealthy:${ids.oldBox}`)).toMatchObject({
      severity: 'error',
      conditions: [{ type: 'offline', jobsHeld: 1 }, { type: 'credential', providerId: 'deepseek', why: 'unavailable' }, { type: 'stale_nax', version: '0.82.0', latest: '0.83.0' }],
    });
    expect(item(s, `job_unplaceable:${ids.needsGpu}`)).toMatchObject({
      severity: 'warning', verdict: 'no_fit', reasons: [{ runnerName: 'old-box', reason: 'offline' }, { runnerName: 'wk-mac', reason: 'labels' }],
    });
    expect(item(s, `job_unplaceable:${ids.opsQueued}`)).toMatchObject({ verdict: 'no_fit' });
    const severities = s.attention.map((a) => a.severity);
    expect(severities).toEqual([...severities].sort((a, b) => (a === b ? 0 : a === 'error' ? -1 : 1)));
  });

  it('the dry-run agrees with placeJob on the same job (spec §2.3)', async () => {
    const outcome = await app.get(PlacementService).placeJob(ids.needsGpu);
    expect(outcome.assigned).toBe(false);
    const fromPlacement = outcome.misfits.map((m) => `${m.name}:${m.reason}`).sort();
    const fromDashboard = (item(await admin(), `job_unplaceable:${ids.needsGpu}`)?.reasons ?? []).map((r) => `${r.runnerName}:${r.reason}`).sort();
    expect(fromDashboard).toEqual(fromPlacement);
  });

  it('project scope: own jobs only, runner detail collapsed, nothing of another project leaks', async () => {
    const res = await project();
    const s = data<Snapshot>(res);
    expect(s.activeJobs.map((j) => j.id)).toEqual([ids.silent, ids.needsGpu]);
    expect(s.counts).toEqual(expect.objectContaining({ queued: 1, running: 1, runnersTotal: 2 }));
    expect(s.runners.every((r) => r.naxVersion === null && r.daemonVersion === null && r.credentials.length === 0)).toBe(true);
    expect(s.runners.map((r) => r.activeJobs)).toEqual([1, 1]);
    expect(item(s, `runner_unhealthy:${ids.oldBox}`)).toMatchObject({ severity: 'error', conditions: [{ type: 'offline', jobsHeld: 1 }, { type: 'configuration' }] });
    const json = JSON.stringify(res.body);
    expect(item(s, `job_unplaceable:${ids.needsGpu}`)).toBeDefined();
    for (const leak of [ids.secret, 'secret-feature', ids.opsQueued, 'ops-queued', world.opsProjectId, 'acme/ops', '"projectSlug":"ops"', 'deepseek', '0.82.0', '0.83.0', ids.ghost]) {
      expect(json).not.toContain(leak);
    }
  });

  it('caps the lists and flags truncation while counts stay over the full scope', async () => {
    await prisma.fleetJob.createMany({
      data: Array.from({ length: 205 }, (_, i) => ({
        projectId: world.opsProjectId, repoId: world.foreignRepoId, ref: 'main', command: 'RUN', feature: `bulk-${i}`, profiles: [],
        maxCostUsd: new Prisma.Decimal(1), selectorLabels: [], requestedById: world.ids.root,
      })),
    });
    await prisma.fleetJob.createMany({
      data: Array.from({ length: 21 }, (_, i) => ({
        projectId: world.projectId, repoId: world.repoId, ref: 'main', command: 'RUN', feature: `fin-${i}`, profiles: [],
        maxCostUsd: new Prisma.Decimal(1), selectorLabels: [], requestedById: world.ids.root, state: 'COMPLETED', finishedAt: minutesAgo(120),
      })),
    });
    const s = await admin();
    expect([s.activeJobs.length, s.activeTruncated, s.recentJobs.length, s.recentTruncated]).toEqual([200, true, 20, true]);
    expect(s.counts.queued).toBe(207);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/api && bun run test:scoped test/integration/fleet/fleet-dashboard-api.integration.spec.ts`
Expected: FAIL. The routes answer 404 (no controllers yet), so the first test's `expect(403)` fails.

- [ ] **Step 3: Write the DTOs**

Create `apps/api/src/fleet/dashboard/dto/fleet-dashboard.dto.ts`:

```ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { MisfitReason } from '../../jobs/placement-rules';
import type {
  DashboardActiveJobView, DashboardCountsView, DashboardCredentialView, DashboardRecentJobView, DashboardRunnerView, DashboardView,
} from '../dashboard-view';
import {
  ATTENTION_KINDS, AttentionItem, AttentionKind, AttentionReason, CONDITION_TYPES, ConditionType, CREDENTIAL_WHY, CredentialWhy, MISFIT_REASONS,
  RunnerCondition, SEVERITIES, Severity, UNPLACEABLE_VERDICTS, UnplaceableVerdict,
} from '../dashboard.types';

const USD = { example: '0.42', description: 'Decimal as string' };
const DATE = { format: 'date-time' } as const;
const NULLABLE_DATE = { type: String, format: 'date-time', nullable: true } as const;
const NULLABLE_STRING = { type: String, nullable: true } as const;

export class DashboardCountsDto implements DashboardCountsView {
  @ApiProperty() runnersOnline: number;
  @ApiProperty() runnersTotal: number;
  @ApiProperty({ description: 'QUEUED jobs in scope (not capped)' }) queued: number;
  @ApiProperty({ description: 'ASSIGNED + RUNNING + UPLOADING jobs in scope (not capped)' }) running: number;
  @ApiProperty() attention: number;
}

export class DashboardCredentialDto implements DashboardCredentialView {
  @ApiProperty() providerId: string;
  @ApiProperty({ description: "nax's verdict (ignores OAuth access-token expiry)" }) available: boolean;
  @ApiProperty({ type: String, enum: ['api-key', 'oauth'], nullable: true }) kind: 'api-key' | 'oauth' | null;
  @ApiProperty(NULLABLE_DATE) expiresAt: string | null;
  @ApiProperty() expired: boolean;
}

export class DashboardRunnerDto implements DashboardRunnerView {
  @ApiProperty() id: string;
  @ApiProperty() name: string;
  @ApiProperty({ enum: ['darwin', 'linux'] }) os: string;
  @ApiProperty({ enum: ['arm64', 'x64'] }) arch: string;
  @ApiProperty({ type: [String] }) labels: string[];
  @ApiProperty() enabled: boolean;
  @ApiProperty({ description: 'Synced within FLEET_RUNNER_OFFLINE_SEC' }) online: boolean;
  @ApiProperty(DATE) lastSeenAt: string;
  @ApiProperty() capacity: number;
  @ApiProperty({ description: 'Runner-held jobs of every project' }) activeJobs: number;
  @ApiProperty({ ...NULLABLE_STRING, description: 'Global admin scope only; null in project scope or when capabilities are unreadable' }) naxVersion: string | null;
  @ApiProperty({ ...NULLABLE_STRING, description: 'Global admin scope only' }) daemonVersion: string | null;
  @ApiProperty({ type: [DashboardCredentialDto], description: 'Global admin scope only; empty in project scope' }) credentials: DashboardCredentialDto[];
}

export class DashboardActiveJobDto implements DashboardActiveJobView {
  @ApiProperty() id: string;
  @ApiProperty() projectSlug: string;
  @ApiProperty({ example: 'acme/app' }) repo: string;
  @ApiProperty() feature: string;
  @ApiProperty({ enum: ['RUN', 'PLAN'] }) command: string;
  @ApiProperty({ enum: ['QUEUED', 'ASSIGNED', 'RUNNING', 'UPLOADING'] }) state: string;
  @ApiProperty(NULLABLE_STRING) runnerId: string | null;
  @ApiProperty(NULLABLE_STRING) runnerName: string | null;
  @ApiProperty(NULLABLE_STRING) currentStoryId: string | null;
  @ApiProperty(NULLABLE_STRING) currentPhase: string | null;
  @ApiProperty({ type: Number, nullable: true, description: 'Stories with status passed; null when unknown or truncated' }) storiesDone: number | null;
  @ApiProperty({ type: Number, nullable: true }) storiesTotal: number | null;
  @ApiProperty(USD) costSpentUsd: string;
  @ApiProperty(USD) maxCostUsd: string;
  @ApiProperty(DATE) queuedAt: string;
  @ApiProperty(NULLABLE_DATE) startedAt: string | null;
  @ApiProperty(NULLABLE_DATE) lastHeartbeatAt: string | null;
  @ApiProperty() pendingApprovals: number;
}

export class DashboardRecentJobDto implements DashboardRecentJobView {
  @ApiProperty() id: string;
  @ApiProperty() projectSlug: string;
  @ApiProperty({ example: 'acme/app' }) repo: string;
  @ApiProperty() feature: string;
  @ApiProperty({ enum: ['RUN', 'PLAN'] }) command: string;
  @ApiProperty({ enum: ['COMPLETED', 'FAILED', 'ESCALATED', 'CRASHED', 'CANCELLED'] }) state: string;
  @ApiProperty(NULLABLE_STRING) stateReason: string | null;
  @ApiProperty(NULLABLE_STRING) runnerName: string | null;
  @ApiProperty(USD) costSpentUsd: string;
  @ApiProperty(NULLABLE_DATE) startedAt: string | null;
  @ApiProperty(DATE) finishedAt: string;
  @ApiProperty(NULLABLE_STRING) resultPrUrl: string | null;
}

export class AttentionReasonDto implements AttentionReason {
  @ApiProperty() runnerName: string;
  @ApiProperty({ enum: MISFIT_REASONS }) reason: MisfitReason;
}

export class RunnerConditionDto implements RunnerCondition {
  @ApiProperty({ enum: CONDITION_TYPES, description: 'Project scope sees only offline and configuration' }) type: ConditionType;
  @ApiPropertyOptional({ description: 'offline: runner-held jobs of every project' }) jobsHeld?: number;
  @ApiPropertyOptional({ description: 'credential (global admin scope only)' }) providerId?: string;
  @ApiPropertyOptional({ enum: CREDENTIAL_WHY }) why?: CredentialWhy;
  @ApiPropertyOptional({ description: 'stale_nax: this runner (global admin scope only)' }) version?: string;
  @ApiPropertyOptional({ description: 'stale_nax: newest online core version (global admin scope only)' }) latest?: string;
}

/** Spec §2: flat; fields beyond `since` belong to one kind each. Clients word it; the API sends no prose. */
export class AttentionItemDto implements AttentionItem {
  @ApiProperty({ description: '`${kind}:${subjectId}`, stable across polls' }) key: string;
  @ApiProperty({ enum: ATTENTION_KINDS }) kind: AttentionKind;
  @ApiProperty({ enum: SEVERITIES }) severity: Severity;
  @ApiProperty({ enum: ['job', 'runner'] }) subjectType: 'job' | 'runner';
  @ApiProperty() subjectId: string;
  @ApiProperty({ description: 'Job feature or runner name' }) subjectName: string;
  @ApiProperty({ ...NULLABLE_STRING, description: 'null for runner items' }) projectSlug: string | null;
  @ApiProperty({ ...NULLABLE_DATE, description: 'When the condition started; null when unknown' }) since: string | null;
  @ApiPropertyOptional({ enum: ['starting', 'running'] }) stage?: 'starting' | 'running';
  @ApiPropertyOptional() silentSec?: number;
  @ApiPropertyOptional(NULLABLE_STRING) runnerName?: string | null;
  @ApiPropertyOptional() pending?: number;
  @ApiPropertyOptional() oldestSec?: number;
  @ApiPropertyOptional({ enum: UNPLACEABLE_VERDICTS }) verdict?: UnplaceableVerdict;
  @ApiPropertyOptional({ type: [AttentionReasonDto], description: 'At most 20, by runner name' }) reasons?: AttentionReasonDto[];
  @ApiPropertyOptional() reasonsTotal?: number;
  @ApiPropertyOptional({ type: [RunnerConditionDto] }) conditions?: RunnerConditionDto[];
}

export class FleetDashboardDto implements DashboardView {
  @ApiProperty({ ...DATE, description: 'Server time every age is measured against' }) generatedAt: string;
  @ApiProperty({ type: DashboardCountsDto }) counts: DashboardCountsDto;
  @ApiProperty({ type: [DashboardRunnerDto] }) runners: DashboardRunnerDto[];
  @ApiProperty({ type: [DashboardActiveJobDto], description: 'Oldest first, at most 200' }) activeJobs: DashboardActiveJobDto[];
  @ApiProperty() activeTruncated: boolean;
  @ApiProperty({ type: [DashboardRecentJobDto], description: 'Finished in the last 24 h, newest first, at most 20' }) recentJobs: DashboardRecentJobDto[];
  @ApiProperty() recentTruncated: boolean;
  @ApiProperty({ type: [AttentionItemDto], description: 'Errors first, then oldest since' }) attention: AttentionItemDto[];
}
```

If ESLint or `tsc` complains about uninitialised class fields, follow `analytics/dto/analytics-response.dto.ts` exactly. It uses the same bare-field style, so it should not.

- [ ] **Step 4: Write the controllers and register them**

Create `apps/api/src/fleet/dashboard/fleet-dashboard.controller.ts`:

```ts
import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiExtraModels, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { RequiredPermission } from '@nathapp/nestjs-auth';
import { JsonResponse } from '@nathapp/nestjs-common';
import { FleetDashboardService } from './dashboard.service';
import { AttentionReasonDto, FleetDashboardDto, RunnerConditionDto } from './dto/fleet-dashboard.dto';

/** Fleet S2b (c) §1.1: fleet health across every project (global admin). */
@ApiTags('fleet')
@ApiBearerAuth()
@ApiExtraModels(AttentionReasonDto, RunnerConditionDto)
@Controller('fleet/dashboard')
export class FleetDashboardController {
  constructor(private readonly dashboard: FleetDashboardService) {}

  @Get()
  @RequiredPermission('ADMIN')
  @ApiOperation({ summary: 'Fleet health across every project: runners, active and recent jobs, attention items (global admin)' })
  @ApiResponse({ status: 200, type: FleetDashboardDto })
  async get() {
    return JsonResponse.Ok(await this.dashboard.snapshot({ kind: 'global' }, new Date()));
  }
}
```

Create `apps/api/src/fleet/dashboard/project-fleet-dashboard.controller.ts`:

```ts
import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiExtraModels, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '@nathapp/nestjs-auth';
import { ForbiddenAppException, JsonResponse } from '@nathapp/nestjs-common';
import { isUserPrincipal, KodaPrincipal } from '../../auth/principal/koda-principal.types';
import { CurrentProject } from '../../projects/current-project.decorator';
import type { ProjectContext } from '../../projects/project-context';
import { ProjectMembershipGuard } from '../../projects/project-membership.guard';
import { FleetDashboardService } from './dashboard.service';
import { AttentionReasonDto, FleetDashboardDto, RunnerConditionDto } from './dto/fleet-dashboard.dto';

/** The dashboard is for people; agent keys get 403, like the analytics and jobs controllers. */
function assertUser(principal: KodaPrincipal): void {
  if (!isUserPrincipal(principal)) throw new ForbiddenAppException({}, 'projects');
}

/** Fleet S2b (c) §1.1, §1.5: the project's jobs, every runner without credential or version detail (project member). */
@ApiTags('fleet')
@ApiBearerAuth()
@ApiExtraModels(AttentionReasonDto, RunnerConditionDto)
@ApiParam({ name: 'slug', required: true, schema: { type: 'string' } })
@Controller('projects/:slug/fleet/dashboard')
@UseGuards(ProjectMembershipGuard)
export class ProjectFleetDashboardController {
  constructor(private readonly dashboard: FleetDashboardService) {}

  @Get()
  @ApiOperation({ summary: "The project's fleet health: its jobs, runner health, attention items (project member)" })
  @ApiResponse({ status: 200, type: FleetDashboardDto })
  async get(@CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    assertUser(principal);
    return JsonResponse.Ok(await this.dashboard.snapshot({ kind: 'project', projectId: ctx.project.id }, new Date()));
  }
}
```

Replace `apps/api/src/fleet/dashboard/dashboard.module.ts` with:

```ts
import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { ProjectAccessModule } from '../../projects/project-access.module';
import { BudgetStoreModule } from '../budgets/budget-store.module';
import { FleetDashboardService } from './dashboard.service';
import { DASHBOARD_REPOSITORY } from './domain/dashboard.domain';
import { FleetDashboardController } from './fleet-dashboard.controller';
import { PrismaDashboardRepository } from './prisma-dashboard.repository';
import { ProjectFleetDashboardController } from './project-fleet-dashboard.controller';

/** Fleet S2b (c) dashboard (spec docs/superpowers/specs/2026-10-05-fleet-s2b-c-dashboard-design.md). */
@Module({
  imports: [PrismaModule, ProjectAccessModule, BudgetStoreModule],
  controllers: [ProjectFleetDashboardController, FleetDashboardController],
  providers: [PrismaDashboardRepository, { provide: DASHBOARD_REPOSITORY, useExisting: PrismaDashboardRepository }, FleetDashboardService],
})
export class DashboardModule {}
```

- [ ] **Step 5: Run the integration test to verify it passes**

Run: `cd apps/api && bun run test:scoped test/integration/fleet/fleet-dashboard-api.integration.spec.ts`
Expected: PASS (6 tests). `wk-mac`'s `lastSeenAt` is seed time and the online threshold is 90 s; the file runs well inside that, so a timeout-slow run flipping it offline would show as several failures at once (rerun before debugging).

If the `runner_unhealthy:old-box` conditions miss `stale_nax`: `latest` is the newest version among online runners, which is `wk-mac` at `0.83.0` (`FLEET_CAPS`), so `old-box` at `0.82.0` is stale. Check `insertRunner` passed the override capabilities.

- [ ] **Step 6: Regenerate the contract and the CLI client, then add the contract test**

Run from the repo root: `bun run generate`
Expected: `openapi.json` gains `/api/fleet/dashboard` and `/api/projects/{slug}/fleet/dashboard`, and `apps/cli/src/generated/sdk.gen.ts` gains `fleetDashboardControllerGet` and `projectFleetDashboardControllerGet`. Check with `grep -c "DashboardControllerGet" apps/cli/src/generated/sdk.gen.ts` (expect at least 2). Also check `grep -n -A1 "kind" apps/cli/src/generated/types.gen.ts | grep -n "api-key"`: `DashboardCredentialDto.kind` should come out as `'api-key' | 'oauth' | null`; if `| null` is missing, keep `type: String` and say so in the PR body (slice 2's web reads it).

Append to `apps/api/src/fleet/fleet-openapi.contract.spec.ts`, inside `describe('fleet OpenAPI contract', ...)`:

```ts
  it('exposes the dashboard routes and schemas (S2b (c) §1-§2)', () => {
    expect(spec.paths['/api/fleet/dashboard']?.['get']).toBeDefined();
    expect(spec.paths['/api/projects/{slug}/fleet/dashboard']?.['get']).toBeDefined();
    expect(Object.keys(spec.components.schemas['FleetDashboardDto']?.properties ?? {}).sort())
      .toEqual(['activeJobs', 'activeTruncated', 'attention', 'counts', 'generatedAt', 'recentJobs', 'recentTruncated', 'runners']);
    expect(Object.keys(spec.components.schemas['AttentionItemDto']?.properties ?? {}))
      .toEqual(expect.arrayContaining(['key', 'kind', 'severity', 'subjectType', 'since', 'stage', 'verdict', 'reasons', 'reasonsTotal', 'conditions']));
    expect(JSON.stringify(spec.components.schemas['AttentionItemDto'])).toContain('fits_not_placed');
    expect(Object.keys(spec.components.schemas['RunnerConditionDto']?.properties ?? {}))
      .toEqual(expect.arrayContaining(['type', 'jobsHeld', 'providerId', 'why', 'version', 'latest']));
    expect(spec.components.schemas['AttentionReasonDto']).toBeDefined();
  });
```

- [ ] **Step 7: Run unit tests, type-check and lint**

Run: `cd apps/api && bunx jest src/fleet && bun run type-check && bunx eslint src/fleet/dashboard test/integration/fleet/fleet-dashboard-api.integration.spec.ts --max-warnings=0 && cd ../cli && bun run type-check`
Expected: PASS. CLI type-check is green, so the regenerated client compiles.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/fleet/dashboard apps/api/src/fleet/fleet-openapi.contract.spec.ts apps/api/test/integration/fleet/fleet-dashboard-api.integration.spec.ts openapi.json apps/cli/src/generated
git commit -m "feat(fleet): dashboard routes for global admins and project members (S2b (c) §1.1)"
```

---

### Task 8: `koda fleet status`

**Files:**
- Create: `apps/cli/src/commands/fleet-status.ts`
- Modify: `apps/cli/src/commands/fleet.ts`
- Test: `apps/cli/src/commands/fleet-status.spec.ts`

**Interfaces:**
- Consumes: generated `fleetDashboardControllerGet`, `projectFleetDashboardControllerGet`, types `FleetDashboardDto`, `AttentionItemDto`, `RunnerConditionDto` (Task 7); `unwrap` (`utils/api`), `withContext` (`utils/context`), `handleApiError` (`utils/error`), `table` (`utils/output`), `ADMIN_TOKEN_HINT`, `ago`, `handleFleetValidation` (`fleet-shared.ts`), `escapeControls` (`fleet-job-logs.ts`).
- Produces: `registerFleetStatus(fleet: Command): void`, `describeAttention(a: AttentionItemDto): string`, `secText(sec?: number): string`, `printStatus(d: FleetDashboardDto, now?: Date): void`

- [ ] **Step 1: Write the failing tests**

Create `apps/cli/src/commands/fleet-status.spec.ts`:

```ts
jest.mock('chalk', () => ({
  cyan: { bold: (s: string) => s }, gray: (s: string) => s, green: (s: string) => s, red: (s: string) => s, yellow: (s: string) => s,
}));
const mockStore = { get: jest.fn(() => ''), set: jest.fn() };
jest.mock('conf', () => jest.fn(() => mockStore));
jest.mock('../generated', () => ({
  fleetDashboardControllerGet: jest.fn(),
  projectFleetDashboardControllerGet: jest.fn(),
}));
jest.mock('../config', () => ({ resolveContext: jest.fn() }));

import { Command } from 'commander';
import { fleetCommand } from './fleet';
import { describeAttention, secText } from './fleet-status';
import { fleetDashboardControllerGet, projectFleetDashboardControllerGet, type AttentionItemDto } from '../generated';
import { resolveContext } from '../config';

const CTX = { apiKey: 'jwt', apiUrl: 'https://koda.example.com', projectSlug: 'web' };
const ok = (data: unknown) => ({ ret: 0, data });
const item = (over: Partial<AttentionItemDto>): AttentionItemDto => ({
  key: 'job_silent:j1', kind: 'job_silent', severity: 'error', subjectType: 'job', subjectId: 'j1', subjectName: 'add-auth',
  projectSlug: 'web', since: new Date(Date.now() - 200_000).toISOString(), ...over,
} as AttentionItemDto);
const snapshot = (attention: AttentionItemDto[] = []) => ({
  generatedAt: new Date().toISOString(),
  counts: { runnersOnline: 2, runnersTotal: 3, queued: 1, running: 2, attention: attention.length },
  runners: [], activeJobs: [], activeTruncated: false, recentJobs: [], recentTruncated: false, attention,
});

describe('koda fleet status', () => {
  let program: Command;
  let exitSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;
  const out = () => logSpy.mock.calls.flat().join('\n');
  const run = (...args: string[]) => program.parseAsync(['node', 'koda', 'fleet', 'status', ...args]);

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
    fleetCommand(program);
    (resolveContext as jest.Mock).mockResolvedValue(CTX);
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => jest.clearAllMocks());

  it('uses the project route by default and prints the counts and All clear', async () => {
    (projectFleetDashboardControllerGet as jest.Mock).mockResolvedValue(ok(snapshot()));
    await run();
    expect(projectFleetDashboardControllerGet).toHaveBeenCalledWith({ path: { slug: 'web' } });
    expect(out()).toContain('runners 2/3 online · queued 1 · running 2 · attention 0');
    expect(out()).toContain('All clear');
    expect(exitSpy).toHaveBeenLastCalledWith(0);
  });

  it('uses the admin route with --all-projects and lists attention items', async () => {
    (fleetDashboardControllerGet as jest.Mock).mockResolvedValue(ok(snapshot([item({ stage: 'running', silentSec: 200, runnerName: 'wk-mac' })])));
    await run('--all-projects');
    expect(fleetDashboardControllerGet).toHaveBeenCalled();
    expect(projectFleetDashboardControllerGet).not.toHaveBeenCalled();
    expect(out()).toContain('No heartbeat for 3m 20s on wk-mac');
    expect(out()).toContain('add-auth');
  });

  it('refuses --all-projects with --project before calling the API', async () => {
    await run('--all-projects', '--project', 'web');
    expect(fleetDashboardControllerGet).not.toHaveBeenCalled();
    expect(projectFleetDashboardControllerGet).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(3);
  });

  it('prints the admin-token hint and exits 2 when --all-projects is refused', async () => {
    (fleetDashboardControllerGet as jest.Mock).mockRejectedValue({ statusCode: 403, message: 'Forbidden' });
    await run('--all-projects');
    expect(exitSpy).toHaveBeenCalledWith(2);
    expect((console.error as jest.Mock).mock.calls.flat().join('\n')).toContain('global-admin');
  });

  it('prints the DTO unchanged with --json', async () => {
    (projectFleetDashboardControllerGet as jest.Mock).mockResolvedValue(ok(snapshot()));
    await run('--json');
    expect(JSON.parse(out())).toMatchObject({ counts: { runnersTotal: 3 }, attention: [] });
  });

  it('escapes control characters in names coming from the API', async () => {
    (projectFleetDashboardControllerGet as jest.Mock).mockResolvedValue(ok(snapshot([item({ subjectName: 'evil\u001b[2J', stage: 'running', silentSec: 5, runnerName: 'r\u0007' })])));
    await run();
    expect(out()).not.toContain('\u001b');
    expect(out()).not.toContain('\u0007');
    expect(out()).toContain('evil\\x1b[2J');
  });
});

describe('describeAttention', () => {
  it.each([
    [item({ stage: 'starting', silentSec: 360, runnerName: 'wk-mac' }), 'Assigned to wk-mac 6m 0s ago, not started'],
    [item({ kind: 'job_waiting_approval', pending: 2, oldestSec: 190 }), '2 approval(s) pending, oldest 3m 10s'],
    [item({ kind: 'job_unplaceable', verdict: 'no_fit', reasons: [{ runnerName: 'a', reason: 'offline' }], reasonsTotal: 3 }), 'No runner fits: a offline (+2 more)'],
    [item({ kind: 'job_unplaceable', verdict: 'never', reasons: [{ runnerName: 'a', reason: 'disabled' }], reasonsTotal: 1 }), 'No runner can ever run this: a disabled'],
    [item({ kind: 'job_unplaceable', verdict: 'budget_paused' }), 'Budget paused; this job will be cancelled'],
    [item({ kind: 'job_unplaceable', verdict: 'runners_paused' }), 'Every runner is budget-paused'],
    [item({ kind: 'job_unplaceable', verdict: 'waiting_capacity' }), 'Waiting for a free runner'],
    [item({ kind: 'job_unplaceable', verdict: 'no_runners' }), 'No runner can take this job'],
    [item({ kind: 'job_unplaceable', verdict: 'fits_not_placed' }), 'A runner fits but the job has not been placed'],
    [item({ kind: 'runner_unhealthy', subjectType: 'runner', conditions: [
      { type: 'offline', jobsHeld: 1 }, { type: 'credential', providerId: 'deepseek', why: 'unavailable' }, { type: 'stale_nax', version: '0.82.0', latest: '0.83.0' },
    ] }), 'offline, holding 1 job(s); credential deepseek unavailable; nax 0.82.0 behind 0.83.0'],
    [item({ kind: 'runner_unhealthy', subjectType: 'runner', conditions: [{ type: 'offline', jobsHeld: 0 }, { type: 'configuration' }] }), 'offline; configuration problem'],
  ])('words %#', (a, text) => {
    expect(describeAttention(a)).toBe(text);
  });

  it('formats durations', () => {
    expect([secText(42), secText(190), secText(7260), secText(undefined)]).toEqual(['42s', '3m 10s', '2h 1m', '0s']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/cli && bunx jest src/commands/fleet-status.spec.ts`
Expected: FAIL with `Cannot find module './fleet-status'`.

- [ ] **Step 3: Implement the command**

Create `apps/cli/src/commands/fleet-status.ts`:

```ts
import { Command } from 'commander';
import {
  fleetDashboardControllerGet,
  projectFleetDashboardControllerGet,
  type AttentionItemDto,
  type FleetDashboardDto,
  type RunnerConditionDto,
} from '../generated';
import { unwrap } from '../utils/api';
import { withContext } from '../utils/context';
import { handleApiError } from '../utils/error';
import { table } from '../utils/output';
import { escapeControls } from './fleet-job-logs';
import { ADMIN_TOKEN_HINT, ago, handleFleetValidation } from './fleet-shared';

interface StatusOptions { project?: string; allProjects?: boolean; json?: boolean }

/** 42s, 3m 10s, 2h 1m. */
export function secText(sec = 0): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

function unplaceableText(a: AttentionItemDto): string {
  const shown = a.reasons ?? [];
  const reasons = shown.map((r) => `${r.runnerName} ${r.reason}`).join(', ');
  const more = (a.reasonsTotal ?? 0) > shown.length ? ` (+${(a.reasonsTotal ?? 0) - shown.length} more)` : '';
  switch (a.verdict) {
    case 'never': return `No runner can ever run this: ${reasons}${more}`;
    case 'budget_paused': return 'Budget paused; this job will be cancelled';
    case 'runners_paused': return 'Every runner is budget-paused';
    case 'waiting_capacity': return 'Waiting for a free runner';
    case 'no_runners': return 'No runner can take this job';
    case 'fits_not_placed': return 'A runner fits but the job has not been placed';
    default: return `No runner fits: ${reasons}${more}`;
  }
}

function conditionText(c: RunnerConditionDto): string {
  switch (c.type) {
    case 'offline': return c.jobsHeld ? `offline, holding ${c.jobsHeld} job(s)` : 'offline';
    case 'credential': return `credential ${c.providerId ?? '?'} ${c.why ?? ''}`.trim();
    case 'stale_nax': return `nax ${c.version ?? '?'} behind ${c.latest ?? '?'}`;
    default: return 'configuration problem';
  }
}

/** English wording of an attention item, built from its structured fields (the API sends no prose, spec §2). */
export function describeAttention(a: AttentionItemDto): string {
  switch (a.kind) {
    case 'job_silent':
      return a.stage === 'starting'
        ? `Assigned to ${a.runnerName ?? '?'} ${secText(a.silentSec)} ago, not started`
        : `No heartbeat for ${secText(a.silentSec)} on ${a.runnerName ?? '?'}`;
    case 'job_waiting_approval': return `${a.pending ?? 0} approval(s) pending, oldest ${secText(a.oldestSec)}`;
    case 'job_unplaceable': return unplaceableText(a);
    default: return (a.conditions ?? []).map(conditionText).join('; ');
  }
}

export function printStatus(d: FleetDashboardDto, now: Date = new Date()): void {
  const c = d.counts;
  console.log(`runners ${c.runnersOnline}/${c.runnersTotal} online · queued ${c.queued} · running ${c.running} · attention ${c.attention}`);
  if (d.attention.length === 0) {
    console.log('All clear');
    return;
  }
  table(['Severity', 'Since', 'Subject', 'Project', 'Attention'], d.attention.map((a) => [
    a.severity, ago(a.since, now), escapeControls(a.subjectName), a.projectSlug ?? '-', escapeControls(describeAttention(a)),
  ]));
}

async function fetchDashboard(o: StatusOptions): Promise<FleetDashboardDto> {
  if (o.allProjects) {
    await withContext({}, { requireProject: false });
    return unwrap<FleetDashboardDto>(await fleetDashboardControllerGet());
  }
  const { projectSlug: slug } = await withContext({ projectSlug: o.project });
  return unwrap<FleetDashboardDto>(await projectFleetDashboardControllerGet({ path: { slug } }));
}

/** `koda fleet status` (S2b (c) §3, D409). */
export function registerFleetStatus(fleet: Command): void {
  fleet
    .command('status')
    .description('Fleet health: runner and job counts and what needs attention')
    .option('--project <slug>', 'Project slug (uses config if not provided)')
    .option('--all-projects', 'Across every project (global admin)')
    .option('--json', 'Output as JSON')
    .action(async (o: StatusOptions) => {
      if (o.allProjects && o.project) return handleFleetValidation('--all-projects and --project cannot be combined');
      try {
        const d = await fetchDashboard(o);
        if (o.json) console.log(JSON.stringify(d, null, 2));
        else printStatus(d);
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, o.allProjects ? { forbiddenHint: ADMIN_TOKEN_HINT } : undefined);
      }
    });
}
```

In `apps/cli/src/commands/fleet.ts` add `import { registerFleetStatus } from './fleet-status';`, call `registerFleetStatus(fleet);` after `registerFleetIngest(fleet);`, and extend the doc comment's list with `, status (S2b (c) §3)`.

If the generated `fleetDashboardControllerGet` requires an options argument (check its signature in `sdk.gen.ts`), call it as `fleetDashboardControllerGet({})`, and change the test's `toHaveBeenCalled()` accordingly. If the generated `AttentionItemDto.kind` union or the optional fields come out typed differently (for example `runnerName?: string | null`), adapt only the type annotations, not the wording.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/cli && bunx jest src/commands/fleet-status.spec.ts && bun run test && bun run type-check && bun run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/commands/fleet-status.ts apps/cli/src/commands/fleet-status.spec.ts apps/cli/src/commands/fleet.ts
git commit -m "feat(cli): koda fleet status (S2b (c) §3)"
```

---

### Task 9: Agent guidance, full verification and handoff

**Files:**
- Modify: `.nax/mono/apps/api/context.md` (fleet section, after the `src/fleet/analytics/` bullet)
- Modify: `.nax/mono/apps/cli/context.md:34-35` (fleet commands bullet)
- Regenerate: the generated agent files (`nax generate`)

- [ ] **Step 1: Add the guidance**

In `.nax/mono/apps/api/context.md`, after the `src/fleet/analytics/` bullet (it starts at line 221 and ends at line 227, `  page notice.`), add a new top-level bullet (not indented, not inside the analytics bullet):

```markdown
- `src/fleet/dashboard/` (S2b (c)): read-only fleet health snapshot for `GET /fleet/dashboard` (global admin) and
  `GET /projects/:slug/fleet/dashboard` (member, agents 403). Attention rules are pure functions in `attention-*.ts`;
  the "queued but not placed" dry-run calls `evaluateRunners` from `jobs/placement-rules.ts`, never a copy of the
  placement logic. The API sends structured attention fields, no prose (clients word them). Project scope must not
  carry another project's job ids, features, repos or slugs, nor any credential provider, expiry or version.
```

In `.nax/mono/apps/cli/context.md`, extend the fleet bullet at lines 34-35 so it reads:

```markdown
- `apps/cli/src/commands/fleet-analytics.ts`, `fleet-ingest.ts`, `fleet-status.ts`: `koda fleet analytics …`, `koda fleet job analytics`,
  `koda fleet ingest …`, `koda fleet status`. Money arrives as 4-place strings from the API: print it as-is, never re-round or sum it.
  `fleet status` words attention items from their structured fields (`describeAttention`); the API sends no prose.
```

- [ ] **Step 2: Regenerate every agent file**

Run from the repo root: `nax generate && nax generate --all-packages`
Expected: `CLAUDE.md`/`AGENTS.md`/`GEMINI.md`/`codex.md` under `apps/api` and `apps/cli` change; root files unchanged or metadata-only. Never hand-edit them and never regenerate a single `--package` only.

- [ ] **Step 3: Full verification**

Run from the repo root:

```bash
bun run lint
bun run type-check
bun run test
cd apps/api && bun run test:scoped test/integration/fleet/fleet-dashboard-repository.integration.spec.ts test/integration/fleet/fleet-dashboard-api.integration.spec.ts test/integration/fleet/fleet-budget-placement.integration.spec.ts test/integration/fleet/fleet-jobs.integration.spec.ts test/integration/fleet/fleet-schedules-api.integration.spec.ts
```

Expected: everything PASS. `bun run test` covers the API unit specs (including the OpenAPI contract and `FleetModule` wiring) and the CLI specs. Record the counts for the PR body. Do not mark this done on a red run; fix and re-run.

- [ ] **Step 4: Commit**

```bash
git add .nax/mono/apps/api/context.md .nax/mono/apps/cli/context.md apps/api/CLAUDE.md apps/api/AGENTS.md apps/api/GEMINI.md apps/api/codex.md apps/cli/CLAUDE.md apps/cli/AGENTS.md apps/cli/GEMINI.md apps/cli/codex.md
git commit -m "docs: dashboard guidance for api and cli agents (S2b (c))"
```

Adjust the `git add` list to the files `git status` shows as changed by `nax generate`.

- [ ] **Step 5: Whole-branch review, then hand off (no push without approval)**

Request a whole-branch code review of `main..feat/fleet-s2b-dashboard` against the spec (superpowers:requesting-code-review). Fix Critical and Important findings, at most 2 fix rounds. Then report to the user: test counts, deferred minors, and the proposed PR title `feat(fleet): S2b (c) slice 1 — dashboard snapshot API and fleet status CLI (D402-D414)`. **Do not push or open the PR until the user approves.** After merge, slice 2 (web + E2E) gets its own plan from main.
