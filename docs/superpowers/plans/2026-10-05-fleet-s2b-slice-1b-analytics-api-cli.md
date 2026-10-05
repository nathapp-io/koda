# Fleet S2b Slice 1b — Analytics Query API and CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Project members can ask koda where fleet money went and what it bought: spend over a window grouped by
model, stage, role, repo, runner, feature or story; run quality (first-pass rate, attempts, review outcomes, finish
outcomes, escalation reasons); the most expensive stories and jobs; and a per-job cost and quality breakdown. Global
admins get the same spend across projects plus delete-on-demand. All of it is available through the CLI.

**Architecture:** A new read-side module `src/fleet/analytics/`, separate from the ingest (write-side) module that
slice 1a shipped. A repository runs SQL `GROUP BY` queries over the slice 1a tables (`FleetCostEvent`,
`FleetStoryResult`, `FleetReviewResult`, `FleetBundleIngest`) and `FleetJob`, and returns unrounded `Prisma.Decimal`
money. Pure functions resolve the window, build the bucket list, fold series beyond the top 12 into `other`, map the
quality rows, and round money to 4 places only at the end. A service puts these together; two thin controllers expose
the project routes (`projects/:slug/fleet/...`, membership guard) and the admin routes (`fleet/analytics`,
`RequiredPermission('ADMIN')`). The CLI adds `koda fleet analytics ...`, `koda fleet job analytics` and
`koda fleet ingest ...` on the regenerated OpenAPI client.

**Tech Stack:** NestJS 11 + Fastify + Prisma 6 (PostgreSQL 16) + Jest + supertest; CLI: Commander 12 +
`@hey-api/openapi-ts` client + Jest.

**Spec:** `docs/superpowers/specs/2026-10-04-fleet-s2b-d-analytics-design.md` §4 (all of it), §6 (API + CLI rows),
§7 slice 1b. Rulings A3, A4, A7. Builds on slice 1a (PR #210, decisions D365-D375).

## Global Constraints

- New API code lives under `apps/api/src/fleet/analytics/`; unit specs next to the source (`*.spec.ts`), integration
  specs under `apps/api/test/integration/fleet/` (`*.integration.spec.ts`).
- Window: `from`, `to` (ISO 8601, UTC: a date, or an instant ending in `Z`; an offset-less datetime would parse in
  the server's local zone, so the DTOs reject it), half-open `[from, to)`; default `to` = now, `from` = `to` minus 30 days; a
  window longer than 366 days -> 400; `from >= to` -> 400.
- `bucket`: `day | week | month` (UTC; weeks start Monday, the same as Postgres `date_trunc('week', ...)`). Default
  from the window length: `<= 31` days day, `<= 182` days week, else month.
- `groupBy` (project): `model | stage | role | repo | runner | feature | story`, default `model`; the admin route
  also accepts `project`. `sort` (stories): `cost | attempts`, default `cost`; (jobs): `cost`. `limit` 1..50,
  default 20. Anything else -> 400.
- **Money**: decimal strings with exactly 4 places, rounded half-up (`Prisma.Decimal.ROUND_HALF_UP`) from the
  unrounded SQL sum (A7). Never round and then sum. Token counts are integers.
- `cacheShare` = cacheRead / (input + cacheRead); rates and averages are numbers rounded to 4 places; all of them
  are `null` when the denominator is 0.
- Time attribution: cost events by `at`; story results by `completedAt`; reviews by `at`; job outcomes by the job's
  `finishedAt`.
- Spend series beyond the top 12 keys by cost fold into one `key: "other"` series. Escalation reasons: top 10,
  normalised to their first non-empty line, at most 200 characters.
- Auth: user principals only (agent keys -> 403); project routes need project membership, any role
  (`ProjectMembershipGuard`); admin routes are `fleet/analytics/...` + `@RequiredPermission('ADMIN')` (D370).
- `apps/api` compiles with `strictNullChecks: false`: compare discriminants with `===`; do not rely on null narrowing.
- Raw SQL: only `Prisma.sql` with bound parameters. A column or `date_trunc` unit comes from a fixed map keyed by a
  validated enum, never from request text.
- API tests: `cd apps/api && bun run test:scoped <paths>`; integration specs need `bun run test:db:up` first and run
  with `KODA_DB_TESTS=1` (test:scoped sets it for `test/integration`). Never bare `bun test` at the repo root.
- Integration files that log in over HTTP hit the 5/min login throttle; a whole file failing in under a millisecond
  with only a `loginToken` frame is the throttle: wait a minute and rerun that file alone.
- CLI tests: `cd apps/cli && bun run test -- <paths>`.
- `bun run generate` (repo root) needs `apps/api/.env`; commit `openapi.json` and the regenerated CLI client.
- No emojis in source; no `console.log` in `apps/api/src` (the CLI prints with `console.log`, as every command
  does); build new objects, never mutate inputs.
- Every snippet names real files and helpers. If a name in a snippet does not exist in the code, that is a plan
  defect: stop and report it.

## Decisions

Numbered from D376 (slice 1a ended at D375).

| # | Decision | Why |
|:--|:--|:--|
| D376 | Analytics is its own module, `src/fleet/analytics/` (`AnalyticsModule`, imported by `FleetModule`), not part of `IngestModule`. | The ingest module writes; this one only reads. They share tables, not code paths. |
| D377 | **Spec addition (§4.2):** each spend series is `{key, label, folded, costUsd, tokens, points}`. `label` is `owner/name` for repo, the runner name, the project slug, else the key. Null dimensions (role, runner, story) use the key `(none)`. The fold is `{key: "other", label: "other", folded: true}`, so a real key named `other` stays distinct. Series totals are computed server-side. | The web and the CLI need names and per-series totals, and must not sum rounded points (A7). |
| D378 | `points` cover every bucket overlapping `[from, to)`, zero-filled, ascending; `t` is the bucket start in UTC (ISO). | Charts need aligned series; a gap would read as missing data. |
| D379 | `tokens` = input + output + cacheRead + cacheWrite. `totals.jobs` = distinct jobs with a cost event in the window. | One token measure everywhere; job count follows the money's time attribution. |
| D380 | Rates (`firstPassRate`, `passRate`, `cacheShare`, `firstPassSeries[].rate`) and `avgAttempts` are numbers rounded to 4 places, `null` with a zero denominator. | A7 covers money only. A rate needs no string precision, and `null` is honest when there is no data. |
| D381 | `finishOutcomes` counts jobs with a non-null `finishResult`: `opened`; `promoted` <- `promoted`, `already-ready`; `escalated`; `skipped` <- `skipped`, `nothing-to-finish`; anything else -> `other`. The mapping uses a `Map` (untrusted strings such as `constructor` cannot hit the prototype). | nax `FinishResult.status` is `opened \| promoted \| already-ready \| escalated \| nothing-to-finish` (`packages/nax/src/execution/status-file.ts:60`); koda also stores `skipped`. |
| D382 | **Spec addition (§4.2):** the stories and jobs routes answer `{window, rows}`; quality also returns `window` and `bucket`; story rows carry `leaseEpoch`. A job row's `costUsd` = `costSpentUsd + costCarriedUsd` (what budgets count); `ledgerCostUsd` = the sum of the job's `done`/`partial` ingest rows' `ledgerCostUsd`, `null` when there are none; `driftUsd` = ledger - cost, `null` with no ledger. | The window travels with the rows, as for spend. Drift compares the same span (all attempts) on both sides. |
| D383 | Job analytics also returns `jobId`, and `ingest` carries its `leaseEpoch`. Cost slices, stories and reviews span **all attempts** (story and review rows carry `leaseEpoch`); `ingest`, `liveCostUsd`, `ledgerCostUsd` come from the **latest-attempt** ingest row; `corrected` = `stateReason === ESCALATED_FROM_AUDIT`; stories and reviews are capped at 500 rows each. | The job page shows the job's total money; the ingest badge and live/ledger note describe the attempt the job row describes (D367). |
| D384 | **Spec detail (§4.3 delete):** `projectId` is optional; omitted = all projects, `confirm` must be `ALL`; given = `confirm` must be that project's slug, unknown project -> 404. Story rows with a null `completedAt` match through their job's `finishedAt`. Every ingest row of an affected job gets `files.deleted = "<before ISO>"` (the files map is string-valued). Activity: `analytics.deleted`, `entityType: 'analytics'` (new), `entityId: projectId ?? 'all'`, payload `{before, costEvents, stories, reviews, ingestRowsMarked}`. A later admin re-run of that job re-creates its rows while the bundle is unexpired. | Spec says "by `at`/`completedAt` < `before`"; an incomplete story would otherwise never be deletable. A string marker keeps `IngestRowDto.files` honest. |
| D385 | Cross-field query errors raise `ValidationAppException({reason}, 'fleet.analyticsQuery')` (400); a wrong delete confirmation raises `ValidationAppException({expected}, 'fleet.analyticsDelete')` (400). Single-field errors stay with the class-validator DTOs (400 from the global pipe). | Matches `fleet.logQuery` and friends; the translation guard covers the new keys. |
| D386 | **Spec addition (§4.4):** `koda fleet analytics spend --all-projects` switches to the admin route (and allows `--group-by project`); the other analytics commands are project-only. `jobs` has a single sort value (`cost`), so the CLI offers `--sort` on `stories` only. No CLI command for delete: the destructive admin action stays API-only until the slice 2 admin page. `ingest status` uses a local `IngestRow` interface: paged routes are untyped in OpenAPI (house style, e.g. `FleetPage<FleetJobDto>`). | Spec §4.4 lists no delete command; members never need cross-project spend. |
| D387 | No analytics-specific throttle; the global default (100/min per client, `app.module.ts`) applies. The escalation-reason read returns every distinct raw reason in the window (merged by first line in JS); accepted as bounded by the 366-day window. | Each query is an indexed `GROUP BY` bounded by the 366-day window; the logs throttle exists for byte scans. |

## Review Focus

1. **A project with no fleet data yet** (or a window before any run): every route answers 200 with zero money
   strings (`"0.0000"`), `null` rates, empty series and zero-filled `firstPassSeries`, not a 500 or `NaN`. Pinned in
   Task 4 (service) and Task 5 (API).
2. **Thousands of sub-cent calls**: three calls of $0.00004 must total `"0.0001"`, never `"0.0000"` from rounding
   each first; the same holds inside a series and the folded `other`. Pinned in Tasks 1, 2 and 5.
3. **Events on either side of a week boundary** (Sunday 23:59:59 UTC vs Monday 00:00 UTC): the SQL bucket and the
   zero-fill bucket list must agree, or points are dropped. Pinned in Task 2 (repository vs `bucketStart`).
4. **The wrong person asking**: a VIEWER reads; an outsider, an agent key or a non-admin on admin routes gets 403; a
   job id from another project gets 404 through this project's slug. Pinned in Tasks 5 and 6.
5. **An admin mistyping the delete confirmation**: 400, nothing deleted; a project-scoped delete never touches
   another project's rows; ingest rows survive, marked. Pinned in Tasks 3 and 6.

---

## File Structure

Create (API):

- `apps/api/src/fleet/analytics/domain/analytics.domain.ts` — enums, limits, repository row types and interfaces.
- `apps/api/src/fleet/analytics/analytics.types.ts` — the response shapes (views) every layer agrees on.
- `apps/api/src/fleet/analytics/analytics-window.ts` — window, buckets, money and rate helpers (pure).
- `apps/api/src/fleet/analytics/analytics-fold.ts` — spend series fold (pure).
- `apps/api/src/fleet/analytics/analytics-quality.ts` — quality row mapping (pure).
- `apps/api/src/fleet/analytics/prisma-analytics.repository.ts` — SQL reads and the delete.
- `apps/api/src/fleet/analytics/analytics.service.ts`
- `apps/api/src/fleet/analytics/dto/analytics-query.dto.ts`, `dto/analytics-response.dto.ts`
- `apps/api/src/fleet/analytics/project-fleet-analytics.controller.ts`, `fleet-analytics.controller.ts`
- `apps/api/src/fleet/analytics/analytics.module.ts`
- Unit specs: `analytics-window.spec.ts`, `analytics-fold.spec.ts`, `analytics-quality.spec.ts`,
  `analytics.service.spec.ts`; `apps/api/test/unit/i18n/fleet-analytics-translation-keys.spec.ts`.
- Integration: `apps/api/test/helpers/fleet-analytics-fixtures.ts`;
  `test/integration/fleet/fleet-analytics-repository.integration.spec.ts`,
  `fleet-analytics-delete.integration.spec.ts`, `fleet-analytics-api.integration.spec.ts`,
  `fleet-analytics-admin-api.integration.spec.ts`.

Create (CLI):

- `apps/cli/src/commands/fleet-analytics.ts` (+ `fleet-analytics.spec.ts`)
- `apps/cli/src/commands/fleet-ingest.ts` (+ `fleet-ingest.spec.ts`)

Modify:

- `apps/api/src/i18n/en/fleet.json`, `apps/api/src/i18n/zh/fleet.json` — two keys (D385).
- `apps/api/src/fleet/activity/domain/fleet-activity.domain.ts` — `'analytics'` entity type (D384).
- `apps/api/src/fleet/fleet.module.ts`, `fleet.module.spec.ts` — import `AnalyticsModule`.
- `apps/api/src/fleet/fleet-openapi.contract.spec.ts` — analytics contract.
- `apps/cli/src/commands/fleet.ts`, `apps/cli/src/commands/fleet-job.ts` — register the new commands.
- `openapi.json`, `apps/cli/src/generated/*` — via `bun run generate`.
- `docs/superpowers/specs/2026-10-04-fleet-s2b-d-analytics-design.md` — D377, D382, D384, D386.
- `.nax/mono/apps/api/context.md`, `.nax/mono/apps/cli/context.md` (+ `nax generate`).

---

### Task 1: Window, money and fold helpers

**Files:**
- Create: `apps/api/src/fleet/analytics/domain/analytics.domain.ts`
- Create: `apps/api/src/fleet/analytics/analytics.types.ts`
- Create: `apps/api/src/fleet/analytics/analytics-window.ts`, `apps/api/src/fleet/analytics/analytics-fold.ts`
- Modify: `apps/api/src/i18n/en/fleet.json`, `apps/api/src/i18n/zh/fleet.json`
- Test: `apps/api/src/fleet/analytics/analytics-window.spec.ts`, `apps/api/src/fleet/analytics/analytics-fold.spec.ts`,
  `apps/api/test/unit/i18n/fleet-analytics-translation-keys.spec.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: types `Bucket`, `GroupBy`, `ProjectGroupBy`, `StorySort`, `JobSort`, `JobSliceBy`, `AnalyticsWindow`,
  `SpendCell`; constants `BUCKETS`, `PROJECT_GROUPS`, `ADMIN_GROUPS`, `STORY_SORTS`, `JOB_SORTS`, `ANALYTICS_LIMITS`,
  `NONE_KEY`, `OTHER_KEY`; every `*View` / `*Input` type in `analytics.types.ts`;
  `resolveWindow(q, now): AnalyticsWindow`, `defaultBucket(spanMs): Bucket`, `bucketStart(at, bucket): Date`,
  `bucketStarts(w): Date[]`, `usd4(v): string`, `usd4OrNull(v): string | null`, `rate4(part, whole): number | null`,
  `normaliseReason(raw): string`, `invalidAnalytics(reason): ValidationAppException`;
  `foldSeries(cells, starts, labels, keep?): SpendSeriesView[]`.

- [ ] **Step 1: Write the domain and view types**

`apps/api/src/fleet/analytics/domain/analytics.domain.ts`:

```ts
import type { Prisma } from '@prisma/client';

export type Bucket = 'day' | 'week' | 'month';
export const BUCKETS: readonly Bucket[] = ['day', 'week', 'month'];

export type ProjectGroupBy = 'model' | 'stage' | 'role' | 'repo' | 'runner' | 'feature' | 'story';
export const PROJECT_GROUPS: readonly ProjectGroupBy[] = ['model', 'stage', 'role', 'repo', 'runner', 'feature', 'story'];
export type GroupBy = ProjectGroupBy | 'project';
export const ADMIN_GROUPS: readonly GroupBy[] = [...PROJECT_GROUPS, 'project'];

export type StorySort = 'cost' | 'attempts';
export const STORY_SORTS: readonly StorySort[] = ['cost', 'attempts'];
export type JobSort = 'cost';
export const JOB_SORTS: readonly JobSort[] = ['cost'];
export type JobSliceBy = 'stage' | 'role' | 'model';

/** Spec §4.1-4.2 and D383. */
export const ANALYTICS_LIMITS = {
  defaultWindowDays: 30,
  maxWindowDays: 366,
  dayBucketMaxDays: 31,
  weekBucketMaxDays: 182,
  seriesKeep: 12,
  listDefault: 20,
  listMax: 50,
  topReasons: 10,
  reasonText: 200,
  jobDetailRows: 500,
} as const;

/** D377: the key of a null dimension (role, runner, story). */
export const NONE_KEY = '(none)';
/** D377: the key of the folded series. */
export const OTHER_KEY = 'other';

/** Half-open [from, to) (D378). */
export interface AnalyticsWindow {
  from: Date;
  to: Date;
  bucket: Bucket;
}

/** One (key, bucket) spend cell; money stays unrounded until the response (A7). */
export interface SpendCell {
  key: string;
  t: Date;
  costUsd: Prisma.Decimal;
  tokens: number;
}
```

`apps/api/src/fleet/analytics/analytics.types.ts`:

```ts
import type { Bucket, GroupBy, StorySort } from './domain/analytics.domain';

/** Inputs after DTO validation (spec §4.1). */
export interface WindowInput {
  from?: string;
  to?: string;
  bucket?: Bucket;
}
export interface SpendInput extends WindowInput {
  groupBy?: GroupBy;
}
export interface ListInput {
  from?: string;
  to?: string;
  limit?: number;
}
export interface StoriesInput extends ListInput {
  sort?: StorySort;
}
export interface DeleteInput {
  before: string;
  projectId?: string;
  confirm: string;
}

/** Response shapes (spec §4.2-4.3 with D377-D384). Money is a 4-place string (A7). */
export interface WindowView {
  from: string;
  to: string;
}
export interface SpendPointView {
  t: string;
  costUsd: string;
  tokens: number;
}
export interface SpendSeriesView {
  key: string;
  label: string;
  folded: boolean;
  costUsd: string;
  tokens: number;
  points: SpendPointView[];
}
export interface SpendTotalsView {
  costUsd: string;
  tokens: number;
  cacheShare: number | null;
  jobs: number;
}
export interface SpendView {
  window: WindowView;
  bucket: Bucket;
  groupBy: GroupBy;
  totals: SpendTotalsView;
  series: SpendSeriesView[];
}
export interface ReviewerView {
  reviewer: string;
  runs: number;
  passRate: number | null;
  findingsBySeverity: Record<string, number>;
}
export interface FinishOutcomesView {
  opened: number;
  promoted: number;
  escalated: number;
  skipped: number;
  other: number;
}
export interface ReasonView {
  reason: string;
  count: number;
}
export interface FirstPassPointView {
  t: string;
  rate: number | null;
}
export interface QualityView {
  window: WindowView;
  bucket: Bucket;
  stories: number;
  firstPassRate: number | null;
  avgAttempts: number | null;
  reviewByReviewer: ReviewerView[];
  finishOutcomes: FinishOutcomesView;
  topEscalationReasons: ReasonView[];
  firstPassSeries: FirstPassPointView[];
}
export interface StoryRowView {
  jobId: string;
  leaseEpoch: number;
  featureName: string;
  storyId: string;
  attempts: number;
  firstPassSuccess: boolean;
  success: boolean;
  costUsd: string;
  completedAt: string | null;
}
export interface StoriesView {
  window: WindowView;
  rows: StoryRowView[];
}
export interface JobRowView {
  jobId: string;
  command: string;
  featureName: string;
  state: string;
  costUsd: string;
  ledgerCostUsd: string | null;
  driftUsd: string | null;
  finishedAt: string | null;
}
export interface JobsView {
  window: WindowView;
  rows: JobRowView[];
}
export interface CostSliceView {
  key: string;
  costUsd: string;
  tokens: number;
}
export interface JobIngestView {
  leaseEpoch: number;
  status: string;
  files: Record<string, string>;
  ingestedAt: string | null;
  error: string | null;
}
export interface JobStoryView {
  leaseEpoch: number;
  featureName: string;
  storyId: string;
  attempts: number;
  firstPassSuccess: boolean;
  success: boolean;
  costUsd: string;
  durationMs: number | null;
  completedAt: string | null;
}
export interface JobReviewView {
  leaseEpoch: number;
  storyId: string | null;
  reviewer: string;
  passed: boolean;
  failOpen: boolean;
  findingCount: number;
  findingsBySeverity: Record<string, number>;
  advisoryCount: number;
  at: string;
}
export interface JobAnalyticsView {
  jobId: string;
  ingest: JobIngestView | null;
  byStage: CostSliceView[];
  byRole: CostSliceView[];
  byModel: CostSliceView[];
  stories: JobStoryView[];
  reviews: JobReviewView[];
  liveCostUsd: string | null;
  ledgerCostUsd: string | null;
  corrected: boolean;
}
export interface DeletedView {
  projectId: string | null;
  before: string;
  costEvents: number;
  stories: number;
  reviews: number;
  ingestRowsMarked: number;
}
```

- [ ] **Step 2: Write the failing helper tests**

`apps/api/src/fleet/analytics/analytics-window.spec.ts`:

```ts
import { ValidationAppException } from '@nathapp/nestjs-common';
import { Prisma } from '@prisma/client';
import { bucketStart, bucketStarts, defaultBucket, normaliseReason, rate4, resolveWindow, usd4, usd4OrNull } from './analytics-window';

const DAY = 86_400_000;
const now = new Date('2026-10-05T12:00:00.000Z');

describe('resolveWindow', () => {
  it('defaults to the 30 days ending now, bucketed by day', () => {
    expect(resolveWindow({}, now)).toEqual({ from: new Date(now.getTime() - 30 * DAY), to: now, bucket: 'day' });
  });

  it('keeps an explicit window and bucket', () => {
    expect(resolveWindow({ from: '2026-01-01', to: '2026-10-01', bucket: 'day' }, now)).toEqual({
      from: new Date('2026-01-01T00:00:00.000Z'), to: new Date('2026-10-01T00:00:00.000Z'), bucket: 'day',
    });
  });

  it('defaults the bucket from the window length', () => {
    expect(defaultBucket(31 * DAY)).toBe('day');
    expect(defaultBucket(31 * DAY + 1)).toBe('week');
    expect(defaultBucket(182 * DAY)).toBe('week');
    expect(defaultBucket(182 * DAY + 1)).toBe('month');
  });

  it('rejects an empty or reversed window and one longer than 366 days', () => {
    expect(() => resolveWindow({ from: '2026-10-01', to: '2026-10-01' }, now)).toThrow(ValidationAppException);
    expect(() => resolveWindow({ from: '2026-10-02', to: '2026-10-01' }, now)).toThrow(ValidationAppException);
    expect(() => resolveWindow({ from: '2025-01-01', to: '2026-01-03' }, now)).toThrow(ValidationAppException);
    expect(resolveWindow({ from: '2025-01-01', to: '2026-01-02' }, now).bucket).toBe('month'); // exactly 366 days
  });
});

describe('buckets', () => {
  it('truncates in UTC and starts weeks on Monday', () => {
    const sunday = new Date('2026-10-04T23:59:59.999Z');
    expect(bucketStart(sunday, 'week').toISOString()).toBe('2026-09-28T00:00:00.000Z');
    expect(bucketStart(new Date('2026-10-05T00:00:00.000Z'), 'week').toISOString()).toBe('2026-10-05T00:00:00.000Z');
    expect(bucketStart(sunday, 'day').toISOString()).toBe('2026-10-04T00:00:00.000Z');
    expect(bucketStart(sunday, 'month').toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });

  it('lists every bucket that overlaps the half-open window', () => {
    const days = bucketStarts({ from: new Date('2026-09-30T12:00:00Z'), to: new Date('2026-10-02T00:00:00Z'), bucket: 'day' });
    expect(days.map((d) => d.toISOString())).toEqual(['2026-09-30T00:00:00.000Z', '2026-10-01T00:00:00.000Z']);
    const months = bucketStarts({ from: new Date('2025-12-15T00:00:00Z'), to: new Date('2026-02-01T00:00:00Z'), bucket: 'month' });
    expect(months.map((d) => d.toISOString())).toEqual(['2025-12-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z']);
  });
});

describe('money, rates and reasons', () => {
  it('rounds money half-up to exactly four places', () => {
    expect(usd4(new Prisma.Decimal('0.00005'))).toBe('0.0001');
    expect(usd4(new Prisma.Decimal('0.00004999'))).toBe('0.0000');
    expect(usd4('12.3')).toBe('12.3000');
    expect(usd4(null)).toBe('0.0000');
    expect(usd4OrNull(null)).toBeNull();
  });

  it('rounds rates to four places and returns null without a denominator', () => {
    expect(rate4(1, 3)).toBe(0.3333);
    expect(rate4(2, 3)).toBe(0.6667);
    expect(rate4(0, 0)).toBeNull();
  });

  it('normalises an escalation reason to its first non-empty line, at most 200 characters', () => {
    expect(normaliseReason('\n  quality review omitted ## WALK  \nmore detail')).toBe('quality review omitted ## WALK');
    expect(normaliseReason('x'.repeat(300))).toHaveLength(200);
    expect(normaliseReason('   ')).toBe('');
  });
});
```

`apps/api/src/fleet/analytics/analytics-fold.spec.ts`:

```ts
import { Prisma } from '@prisma/client';
import { foldSeries } from './analytics-fold';
import type { SpendCell } from './domain/analytics.domain';

const cell = (key: string, t: string, cost: string, tokens = 1): SpendCell => ({ key, t: new Date(t), costUsd: new Prisma.Decimal(cost), tokens });
const starts = [new Date('2026-10-01T00:00:00Z'), new Date('2026-10-02T00:00:00Z')];

describe('foldSeries', () => {
  it('zero-fills every bucket and sums before rounding', () => {
    const cells = [1, 2, 3].map(() => cell('m', '2026-10-01T00:00:00Z', '0.00004'));
    expect(foldSeries(cells, starts, new Map())).toEqual([{
      key: 'm', label: 'm', folded: false, costUsd: '0.0001', tokens: 3,
      points: [
        { t: '2026-10-01T00:00:00.000Z', costUsd: '0.0001', tokens: 3 },
        { t: '2026-10-02T00:00:00.000Z', costUsd: '0.0000', tokens: 0 },
      ],
    }]);
  });

  it('keeps the top 12 keys by cost, labelled, and folds the rest into other', () => {
    const cells = Array.from({ length: 14 }, (_, i) => cell(`k${String(i).padStart(2, '0')}`, '2026-10-02T00:00:00Z', String(14 - i)));
    const series = foldSeries(cells, starts, new Map([['k00', 'Label zero']]));
    expect(series).toHaveLength(13);
    expect(series[0]).toMatchObject({ key: 'k00', label: 'Label zero', folded: false, costUsd: '14.0000' });
    expect(series[12]).toMatchObject({ key: 'other', label: 'other', folded: true, costUsd: '3.0000', tokens: 2 });
  });

  it('keeps a real key named other distinct from the fold', () => {
    const cells = [cell('other', '2026-10-01T00:00:00Z', '1')];
    expect(foldSeries(cells, starts, new Map(), 1)).toEqual([expect.objectContaining({ key: 'other', folded: false })]);
  });

  it('breaks cost ties by key and returns no series without cells', () => {
    const cells = [cell('b', '2026-10-01T00:00:00Z', '1'), cell('a', '2026-10-01T00:00:00Z', '1')];
    expect(foldSeries(cells, starts, new Map()).map((s) => s.key)).toEqual(['a', 'b']);
    expect(foldSeries([], starts, new Map())).toEqual([]);
  });
});
```

`apps/api/test/unit/i18n/fleet-analytics-translation-keys.spec.ts`:

```ts
/**
 * Fleet S2b slice 1b — analytics error messages exist in en and zh with the same placeholders (D385).
 * The key is `<prefix>.<code>`: ValidationAppException uses -2.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

type Tree = Record<string, Record<string, string>>;
const load = (lang: string): Tree => JSON.parse(readFileSync(join(__dirname, '../../../src/i18n', lang, 'fleet.json'), 'utf8')) as Tree;
const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

const KEYS: Array<[string, string, string[]]> = [
  ['analyticsQuery', '-2', ['reason']],
  ['analyticsDelete', '-2', ['expected']],
];

describe('fleet analytics translation keys', () => {
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

- [ ] **Step 3: Run them to verify they fail**

Run: `cd apps/api && bun run test:scoped src/fleet/analytics/analytics-window.spec.ts src/fleet/analytics/analytics-fold.spec.ts test/unit/i18n/fleet-analytics-translation-keys.spec.ts`
Expected: FAIL — `Cannot find module './analytics-window'` / `'./analytics-fold'`; the translation spec fails on
`expect(typeof enText).toBe('string')` (Expected `"string"`, Received `"undefined"`).

- [ ] **Step 4: Implement the helpers**

`apps/api/src/fleet/analytics/analytics-window.ts`:

```ts
import { ValidationAppException } from '@nathapp/nestjs-common';
import { Prisma } from '@prisma/client';
import { ANALYTICS_LIMITS, AnalyticsWindow, Bucket } from './domain/analytics.domain';

const DAY_MS = 86_400_000;

/** D385: cross-field query errors; single fields are validated by the DTOs. */
export function invalidAnalytics(reason: string): ValidationAppException {
  return new ValidationAppException({ reason }, 'fleet.analyticsQuery');
}

/** Spec §4.1: <= 31 days day, <= 182 days week, else month. */
export function defaultBucket(spanMs: number): Bucket {
  if (spanMs <= ANALYTICS_LIMITS.dayBucketMaxDays * DAY_MS) return 'day';
  if (spanMs <= ANALYTICS_LIMITS.weekBucketMaxDays * DAY_MS) return 'week';
  return 'month';
}

/** Spec §4.1, D378: default the 30 days ending now; half-open [from, to); at most 366 days. */
export function resolveWindow(q: { from?: string; to?: string; bucket?: Bucket }, now: Date): AnalyticsWindow {
  const to = q.to ? new Date(q.to) : now;
  const from = q.from ? new Date(q.from) : new Date(to.getTime() - ANALYTICS_LIMITS.defaultWindowDays * DAY_MS);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw invalidAnalytics('from and to must be ISO 8601 instants');
  const span = to.getTime() - from.getTime();
  if (span <= 0) throw invalidAnalytics('from must be before to');
  if (span > ANALYTICS_LIMITS.maxWindowDays * DAY_MS) throw invalidAnalytics(`the window is longer than ${ANALYTICS_LIMITS.maxWindowDays} days`);
  return { from, to, bucket: q.bucket ?? defaultBucket(span) };
}

/** UTC start of the bucket holding `at`; weeks start Monday, as Postgres date_trunc. */
export function bucketStart(at: Date, bucket: Bucket): Date {
  const y = at.getUTCFullYear();
  const m = at.getUTCMonth();
  const d = at.getUTCDate();
  if (bucket === 'month') return new Date(Date.UTC(y, m, 1));
  if (bucket === 'day') return new Date(Date.UTC(y, m, d));
  const sinceMonday = (at.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(y, m, d - sinceMonday));
}

function nextBucket(t: Date, bucket: Bucket): Date {
  if (bucket === 'month') return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 1));
  return new Date(t.getTime() + (bucket === 'week' ? 7 : 1) * DAY_MS);
}

/** D378: every bucket start overlapping [from, to), ascending. */
export function bucketStarts(w: AnalyticsWindow): Date[] {
  const starts: Date[] = [];
  for (let t = bucketStart(w.from, w.bucket); t.getTime() < w.to.getTime(); t = nextBucket(t, w.bucket)) starts.push(t);
  return starts;
}

type Money = Prisma.Decimal | string | number;

/** A7: four places, half-up, applied once to an unrounded value. */
export const usd4 = (v: Money | null): string =>
  new Prisma.Decimal(v ?? 0).toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP).toFixed(4);

export const usd4OrNull = (v: Money | null): string | null => (v === null ? null : usd4(v));

/** D380: a four-place ratio, null when there is nothing to divide by. */
export const rate4 = (part: number, whole: number): number | null =>
  whole === 0 ? null : Math.round((part / whole) * 10_000) / 10_000;

/** Spec §4.2: the first non-empty line, trimmed, at most 200 characters. */
export function normaliseReason(raw: string): string {
  const line = raw.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  return line.slice(0, ANALYTICS_LIMITS.reasonText);
}
```

`apps/api/src/fleet/analytics/analytics-fold.ts`:

```ts
import { Prisma } from '@prisma/client';
import { usd4 } from './analytics-window';
import type { SpendSeriesView } from './analytics.types';
import { ANALYTICS_LIMITS, OTHER_KEY, SpendCell } from './domain/analytics.domain';

const ZERO = new Prisma.Decimal(0);
const byKey = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function rankedKeys(cells: readonly SpendCell[]): string[] {
  const totals = new Map<string, Prisma.Decimal>();
  for (const c of cells) totals.set(c.key, (totals.get(c.key) ?? ZERO).add(c.costUsd));
  return [...totals]
    .sort(([ka, a], [kb, b]) => b.cmp(a) || byKey(ka, kb))
    .map(([key]) => key);
}

function toSeries(key: string, label: string, folded: boolean, cells: readonly SpendCell[], starts: readonly Date[]): SpendSeriesView {
  const byT = new Map<number, { cost: Prisma.Decimal; tokens: number }>();
  for (const c of cells) {
    const prev = byT.get(c.t.getTime()) ?? { cost: ZERO, tokens: 0 };
    byT.set(c.t.getTime(), { cost: prev.cost.add(c.costUsd), tokens: prev.tokens + c.tokens });
  }
  const points = starts.map((t) => {
    const v = byT.get(t.getTime());
    return { t: t.toISOString(), costUsd: usd4(v ? v.cost : ZERO), tokens: v ? v.tokens : 0 };
  });
  const cost = cells.reduce((sum, c) => sum.add(c.costUsd), ZERO);
  const tokens = cells.reduce((sum, c) => sum + c.tokens, 0);
  return { key, label, folded, costUsd: usd4(cost), tokens, points };
}

/** Spec §4.2, D377-D378: the top `keep` keys by cost, the rest folded into one `other` series; sums before rounding. */
export function foldSeries(
  cells: readonly SpendCell[], starts: readonly Date[], labels: ReadonlyMap<string, string>, keep: number = ANALYTICS_LIMITS.seriesKeep,
): SpendSeriesView[] {
  const kept = rankedKeys(cells).slice(0, keep);
  const keptSet = new Set(kept);
  const series = kept.map((key) => toSeries(key, labels.get(key) ?? key, false, cells.filter((c) => c.key === key), starts));
  const rest = cells.filter((c) => !keptSet.has(c.key));
  return rest.length === 0 ? series : [...series, toSeries(OTHER_KEY, OTHER_KEY, true, rest, starts)];
}
```

In `apps/api/src/i18n/en/fleet.json`, replace the last line pair:

```json
  "logExpired": { "410": "This log was deleted after the retention window" }
}
```

with:

```json
  "logExpired": { "410": "This log was deleted after the retention window" },
  "analyticsQuery": { "-2": "Invalid analytics request: {reason}" },
  "analyticsDelete": { "-2": "Type {expected} to confirm the deletion" }
}
```

In `apps/api/src/i18n/zh/fleet.json`, replace:

```json
  "logExpired": { "410": "该日志已超过保留期限并被删除" }
}
```

with:

```json
  "logExpired": { "410": "该日志已超过保留期限并被删除" },
  "analyticsQuery": { "-2": "无效的分析请求：{reason}" },
  "analyticsDelete": { "-2": "请输入 {expected} 以确认删除" }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/api && bun run test:scoped src/fleet/analytics/analytics-window.spec.ts src/fleet/analytics/analytics-fold.spec.ts test/unit/i18n/fleet-analytics-translation-keys.spec.ts`
Expected: PASS (3 suites).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/fleet/analytics apps/api/src/i18n/en/fleet.json apps/api/src/i18n/zh/fleet.json apps/api/test/unit/i18n/fleet-analytics-translation-keys.spec.ts
git commit -m "feat(fleet): S2b analytics window, money and series fold helpers (D377-D380, D385)"
```

---

### Task 2: Analytics read repository

**Files:**
- Modify: `apps/api/src/fleet/analytics/domain/analytics.domain.ts` (row types + `IAnalyticsReadRepository`)
- Create: `apps/api/src/fleet/analytics/prisma-analytics.repository.ts`
- Create: `apps/api/test/helpers/fleet-analytics-fixtures.ts`
- Test: `apps/api/test/integration/fleet/fleet-analytics-repository.integration.spec.ts`

**Interfaces:**
- Consumes: `AnalyticsWindow`, `Bucket`, `GroupBy`, `JobSliceBy`, `StorySort`, `SpendCell`, `NONE_KEY` (Task 1);
  `bucketStart` (Task 1, test only).
- Produces: `ANALYTICS_REPOSITORY` symbol; `IAnalyticsReadRepository` with
  `spendCells(scope, w, groupBy): Promise<SpendCell[]>`, `spendTotals(scope, from, to): Promise<SpendTotalsRow>`,
  `labels(groupBy, keys): Promise<ReadonlyMap<string, string>>`, `storyStats(projectId, from, to)`,
  `firstPassCells(projectId, w)`, `reviewers(projectId, from, to)`, `reviewerSeverities(projectId, from, to)`,
  `finishResults(projectId, from, to)`, `escalationReasons(projectId, from, to)`,
  `topStories(projectId, from, to, sort, limit)`, `topJobs(projectId, from, to, limit)`, `jobSlices(jobId, by)`,
  `latestIngest(jobId)`, `jobStories(jobId, limit)`, `jobReviews(jobId, limit)`; row types `AnalyticsScope`,
  `SpendTotalsRow`, `StoryStatsRow`, `FirstPassCell`, `ReviewerRow`, `ReviewerSeverityRow`, `CountRow`,
  `StoryListRow`, `JobListRow`, `CostSliceRow`, `JobIngestRow`, `JobStoryRow`, `JobReviewRow`;
  class `PrismaAnalyticsRepository`. Test fixtures `insertAnalyticsJob`, `insertCostEvent`, `insertStoryResult`,
  `insertReviewResult`, `insertIngestRow`.

- [ ] **Step 1: Add the row types and the read interface to the domain**

Append to `apps/api/src/fleet/analytics/domain/analytics.domain.ts`:

```ts
export const ANALYTICS_REPOSITORY = Symbol('ANALYTICS_REPOSITORY');

/** `projectId: null` = every project (global admin). */
export interface AnalyticsScope {
  projectId: string | null;
}

export interface SpendTotalsRow {
  costUsd: Prisma.Decimal;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  jobs: number;
}

export interface StoryStatsRow {
  stories: number;
  firstPass: number;
  attempts: number;
}

export interface FirstPassCell {
  t: Date;
  stories: number;
  firstPass: number;
}

export interface ReviewerRow {
  reviewer: string;
  runs: number;
  passed: number;
}

export interface ReviewerSeverityRow {
  reviewer: string;
  severity: string;
  count: number;
}

/** A grouped count of one text column (finish result, escalation reason). */
export interface CountRow {
  value: string;
  count: number;
}

export interface StoryListRow {
  jobId: string;
  leaseEpoch: number;
  featureName: string;
  storyId: string;
  attempts: number;
  firstPassSuccess: boolean;
  success: boolean;
  costUsd: Prisma.Decimal;
  completedAt: Date | null;
}

export interface JobListRow {
  jobId: string;
  command: string;
  featureName: string;
  state: string;
  /** costSpentUsd + costCarriedUsd (D382). */
  costUsd: Prisma.Decimal;
  /** Sum over the job's done/partial ingest rows; null when none (D382). */
  ledgerCostUsd: Prisma.Decimal | null;
  finishedAt: Date | null;
}

export interface CostSliceRow {
  key: string;
  costUsd: Prisma.Decimal;
  tokens: number;
}

export interface JobIngestRow {
  leaseEpoch: number;
  status: string;
  files: Record<string, string>;
  ingestedAt: Date | null;
  error: string | null;
  liveCostUsd: Prisma.Decimal | null;
  ledgerCostUsd: Prisma.Decimal | null;
}

export interface JobStoryRow {
  leaseEpoch: number;
  featureName: string;
  storyId: string;
  attempts: number;
  firstPassSuccess: boolean;
  success: boolean;
  costUsd: Prisma.Decimal;
  durationMs: number | null;
  completedAt: Date | null;
}

export interface JobReviewRow {
  leaseEpoch: number;
  storyId: string | null;
  reviewer: string;
  passed: boolean;
  failOpen: boolean;
  findingCount: number;
  findingsBySeverity: Record<string, number>;
  advisoryCount: number;
  at: Date;
}

/** Spec §4.1-4.2: SQL GROUP BY over indexed columns; money unrounded. */
export interface IAnalyticsReadRepository {
  spendCells(scope: AnalyticsScope, w: AnalyticsWindow, groupBy: GroupBy): Promise<SpendCell[]>;
  spendTotals(scope: AnalyticsScope, from: Date, to: Date): Promise<SpendTotalsRow>;
  /** D377: display names for repo, runner and project keys; other dimensions get an empty map. */
  labels(groupBy: GroupBy, keys: readonly string[]): Promise<ReadonlyMap<string, string>>;
  storyStats(projectId: string, from: Date, to: Date): Promise<StoryStatsRow>;
  firstPassCells(projectId: string, w: AnalyticsWindow): Promise<FirstPassCell[]>;
  reviewers(projectId: string, from: Date, to: Date): Promise<ReviewerRow[]>;
  reviewerSeverities(projectId: string, from: Date, to: Date): Promise<ReviewerSeverityRow[]>;
  finishResults(projectId: string, from: Date, to: Date): Promise<CountRow[]>;
  escalationReasons(projectId: string, from: Date, to: Date): Promise<CountRow[]>;
  topStories(projectId: string, from: Date, to: Date, sort: StorySort, limit: number): Promise<StoryListRow[]>;
  topJobs(projectId: string, from: Date, to: Date, limit: number): Promise<JobListRow[]>;
  /** All attempts of the job, cost descending (D383). */
  jobSlices(jobId: string, by: JobSliceBy): Promise<CostSliceRow[]>;
  /** The ingest row of the job's highest leaseEpoch (D383). */
  latestIngest(jobId: string): Promise<JobIngestRow | null>;
  jobStories(jobId: string, limit: number): Promise<JobStoryRow[]>;
  jobReviews(jobId: string, limit: number): Promise<JobReviewRow[]>;
}
```

- [ ] **Step 2: Write the fixtures and the failing integration test**

`apps/api/test/helpers/fleet-analytics-fixtures.ts`:

```ts
import { Prisma, PrismaClient } from '@prisma/client';

let seq = 0;

export interface AnalyticsOwner {
  projectId: string;
  repoId: string;
  requestedById: string;
}

/** A finished fleet job straight into PG (slice 1b analytics tests). */
export async function insertAnalyticsJob(prisma: PrismaClient, o: AnalyticsOwner, over: Partial<{
  command: string; feature: string; state: string; leaseEpoch: number; finishedAt: Date | null; costSpentUsd: string;
  costCarriedUsd: string; finishResult: string | null; escalationReason: string | null; stateReason: string | null;
}> = {}): Promise<string> {
  const job = await prisma.fleetJob.create({
    data: {
      projectId: o.projectId, repoId: o.repoId, ref: 'main', command: over.command ?? 'RUN', feature: over.feature ?? `feat-${++seq}`,
      profiles: [], selectorLabels: [], maxCostUsd: new Prisma.Decimal(5), requestedById: o.requestedById,
      state: over.state ?? 'COMPLETED', leaseEpoch: over.leaseEpoch ?? 1,
      finishedAt: over.finishedAt === undefined ? new Date('2026-10-02T12:00:00Z') : over.finishedAt,
      costSpentUsd: new Prisma.Decimal(over.costSpentUsd ?? '0'), costCarriedUsd: new Prisma.Decimal(over.costCarriedUsd ?? '0'),
      finishResult: over.finishResult ?? null, escalationReason: over.escalationReason ?? null, stateReason: over.stateReason ?? null,
    },
  });
  return job.id;
}

export interface RowOwner {
  jobId: string;
  projectId: string;
  repoId: string;
  leaseEpoch?: number;
}

export async function insertCostEvent(prisma: PrismaClient, o: RowOwner, over: Partial<{
  at: Date; model: string; stage: string; sessionRole: string | null; storyId: string | null; costUsd: string;
  inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number;
}> = {}): Promise<void> {
  await prisma.fleetCostEvent.create({
    data: {
      jobId: o.jobId, leaseEpoch: o.leaseEpoch ?? 1, projectId: o.projectId, repoId: o.repoId, runnerId: null, naxRunId: 'run-1',
      at: over.at ?? new Date('2026-10-02T10:00:00Z'), agentName: 'native', model: over.model ?? 'm1', stage: over.stage ?? 'run',
      sessionRole: over.sessionRole === undefined ? 'implementer' : over.sessionRole, featureName: 'f',
      storyId: over.storyId === undefined ? 'US-001' : over.storyId, callId: `call-${++seq}`,
      inputTokens: over.inputTokens ?? 100, outputTokens: over.outputTokens ?? 10,
      cacheReadTokens: over.cacheReadTokens ?? 0, cacheWriteTokens: over.cacheWriteTokens ?? 0,
      costUsd: new Prisma.Decimal(over.costUsd ?? '0.01'),
    },
  });
}

export async function insertStoryResult(prisma: PrismaClient, o: RowOwner, over: Partial<{
  storyId: string; attempts: number; success: boolean; firstPassSuccess: boolean; costUsd: string; completedAt: Date | null;
}> = {}): Promise<void> {
  await prisma.fleetStoryResult.create({
    data: {
      jobId: o.jobId, leaseEpoch: o.leaseEpoch ?? 1, projectId: o.projectId, repoId: o.repoId, featureName: 'f',
      storyId: over.storyId ?? `US-${++seq}`, attempts: over.attempts ?? 1, success: over.success ?? true,
      firstPassSuccess: over.firstPassSuccess ?? true, costUsd: new Prisma.Decimal(over.costUsd ?? '0.1'), durationMs: 1000,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      completedAt: over.completedAt === undefined ? new Date('2026-10-02T11:00:00Z') : over.completedAt,
    },
  });
}

export async function insertReviewResult(prisma: PrismaClient, o: RowOwner, over: Partial<{
  reviewer: string; passed: boolean; findingsBySeverity: Record<string, number>; at: Date;
}> = {}): Promise<void> {
  const findings = over.findingsBySeverity ?? {};
  await prisma.fleetReviewResult.create({
    data: {
      jobId: o.jobId, leaseEpoch: o.leaseEpoch ?? 1, projectId: o.projectId, storyId: 'US-001', reviewer: over.reviewer ?? 'semantic',
      recordId: `rec-${++seq}`, passed: over.passed ?? true, failOpen: false,
      findingCount: Object.values(findings).reduce((a, b) => a + b, 0), findingsBySeverity: findings, advisoryCount: 0,
      at: over.at ?? new Date('2026-10-02T11:30:00Z'),
    },
  });
}

/** A bundle artifact and its ingest row for one attempt. */
export async function insertIngestRow(prisma: PrismaClient, jobId: string, leaseEpoch: number, over: Partial<{
  status: string; liveCostUsd: string | null; ledgerCostUsd: string | null; files: Record<string, string>; error: string | null;
}> = {}): Promise<void> {
  const artifact = await prisma.fleetJobArtifact.create({
    data: { jobId, leaseEpoch, kind: 'bundle', storageKey: `jobs/${jobId}/${leaseEpoch}/b${++seq}.tar.gz`, sizeBytes: BigInt(1), sha256: 'a'.repeat(64) },
  });
  const money = (v: string | null | undefined) => (v === null || v === undefined ? null : new Prisma.Decimal(v));
  await prisma.fleetBundleIngest.create({
    data: {
      artifactId: artifact.id, jobId, leaseEpoch, parserVersion: 1, status: over.status ?? 'done', files: over.files ?? { cost: 'done:v8' },
      ingestedAt: new Date('2026-10-02T13:00:00Z'), liveCostUsd: money(over.liveCostUsd), ledgerCostUsd: money(over.ledgerCostUsd),
      error: over.error ?? null,
    },
  });
}
```

`apps/api/test/integration/fleet/fleet-analytics-repository.integration.spec.ts`:

```ts
/**
 * Fleet S2b slice 1b — analytics read repository (PG), spec §4.1-4.2.
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-analytics-repository.integration.spec.ts
 */
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { resetDb } from '../../helpers/reset-db';
import { seedFleetBase } from '../../helpers/fleet-fixtures';
import {
  insertAnalyticsJob, insertCostEvent, insertIngestRow, insertReviewResult, insertStoryResult,
} from '../../helpers/fleet-analytics-fixtures';
import { bucketStart } from '../../../src/fleet/analytics/analytics-window';
import { NONE_KEY } from '../../../src/fleet/analytics/domain/analytics.domain';
import { PrismaAnalyticsRepository } from '../../../src/fleet/analytics/prisma-analytics.repository';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('analytics read repository (PG)', () => {
  const prisma = new PrismaClient();
  const repo = new PrismaAnalyticsRepository({ client: prisma } as unknown as PrismaService<PrismaClient>);
  const w = { from: new Date('2026-09-28T00:00:00Z'), to: new Date('2026-10-12T00:00:00Z'), bucket: 'week' as const };
  const tok = { inputTokens: 100, outputTokens: 10, cacheReadTokens: 50, cacheWriteTokens: 5 };
  let a: Awaited<ReturnType<typeof seedFleetBase>>;
  let b: Awaited<ReturnType<typeof seedFleetBase>>;
  let job1: string;
  let job2: string;

  beforeAll(async () => {
    await resetDb();
    a = await seedFleetBase(prisma);
    b = await seedFleetBase(prisma);
    const ownerA = { projectId: a.projectId, repoId: a.repoId, requestedById: a.adminId };
    job1 = await insertAnalyticsJob(prisma, ownerA, {
      leaseEpoch: 2, costSpentUsd: '0.5', costCarriedUsd: '0.1', finishResult: 'escalated',
      escalationReason: 'quality review omitted\nWALK', state: 'ESCALATED',
    });
    job2 = await insertAnalyticsJob(prisma, ownerA, { command: 'PLAN', costSpentUsd: '0.2', finishResult: 'promoted', finishedAt: new Date('2026-10-03T00:00:00Z') });
    await insertAnalyticsJob(prisma, ownerA, { costSpentUsd: '9', finishedAt: new Date('2026-08-01T00:00:00Z') }); // outside the window
    await insertAnalyticsJob(prisma, ownerA, { finishResult: null, finishedAt: new Date('2026-10-04T00:00:00Z') });
    const row1 = { jobId: job1, projectId: a.projectId, repoId: a.repoId };
    await insertCostEvent(prisma, row1, { ...tok, at: new Date('2026-10-04T23:59:59Z'), model: 'm1', costUsd: '0.00004' }); // Sunday
    await insertCostEvent(prisma, row1, { ...tok, at: new Date('2026-10-04T23:00:00Z'), model: 'm1', costUsd: '0.00004' });
    await insertCostEvent(prisma, row1, { ...tok, at: new Date('2026-10-05T00:00:00Z'), model: 'm2', sessionRole: null, storyId: null, costUsd: '0.00004' }); // Monday
    await insertCostEvent(prisma, row1, { ...tok, at: new Date('2026-10-12T00:00:00Z'), model: 'm1', costUsd: '9' }); // at `to`: excluded
    const jobB = await insertAnalyticsJob(prisma, { projectId: b.projectId, repoId: b.repoId, requestedById: b.adminId });
    await insertCostEvent(prisma, { jobId: jobB, projectId: b.projectId, repoId: b.repoId }, { at: new Date('2026-10-03T00:00:00Z'), costUsd: '5' });
    await insertStoryResult(prisma, row1, { storyId: 'US-001', attempts: 1, firstPassSuccess: true, costUsd: '0.2', completedAt: new Date('2026-10-02T00:00:00Z') });
    await insertStoryResult(prisma, row1, { storyId: 'US-002', attempts: 3, firstPassSuccess: false, costUsd: '0.3', completedAt: new Date('2026-10-06T00:00:00Z') });
    await insertStoryResult(prisma, row1, { storyId: 'US-003', completedAt: null });
    await insertStoryResult(prisma, row1, { storyId: 'US-004', completedAt: new Date('2026-09-01T00:00:00Z') });
    await insertReviewResult(prisma, row1, { reviewer: 'semantic', passed: true, findingsBySeverity: { error: 1, warning: 2 } });
    await insertReviewResult(prisma, row1, { reviewer: 'semantic', passed: false, findingsBySeverity: { error: 1 } });
    await insertReviewResult(prisma, row1, { reviewer: 'adversarial', passed: true });
    await insertIngestRow(prisma, job1, 1, { status: 'done', ledgerCostUsd: '0.25' });
    await insertIngestRow(prisma, job1, 2, { status: 'partial', ledgerCostUsd: '0.4', liveCostUsd: '0.35', files: { cost: 'done:v8', review: 'skipped:v3' } });
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('groups spend by key and bucket, aligned with bucketStart across a week boundary', async () => {
    const cells = (await repo.spendCells({ projectId: a.projectId }, w, 'model')).sort((x, y) => (x.key < y.key ? -1 : 1));
    expect(cells.map((c) => ({ key: c.key, t: c.t.toISOString(), cost: c.costUsd.toFixed(8), tokens: c.tokens }))).toEqual([
      { key: 'm1', t: '2026-09-28T00:00:00.000Z', cost: '0.00008000', tokens: 330 },
      { key: 'm2', t: '2026-10-05T00:00:00.000Z', cost: '0.00004000', tokens: 165 },
    ]);
    expect(cells[0].t).toEqual(bucketStart(new Date('2026-10-04T23:59:59Z'), 'week'));
    expect(cells[1].t).toEqual(bucketStart(new Date('2026-10-05T00:00:00Z'), 'week'));
  });

  it('keys a null dimension as (none) and scopes to every project when projectId is null', async () => {
    const roles = await repo.spendCells({ projectId: a.projectId }, w, 'role');
    expect(roles.map((c) => c.key).sort()).toEqual([NONE_KEY, 'implementer']);
    const projects = await repo.spendCells({ projectId: null }, w, 'project');
    expect(new Set(projects.map((c) => c.key))).toEqual(new Set([a.projectId, b.projectId]));
  });

  it('totals unrounded money, tokens and distinct jobs; zero on an empty window', async () => {
    const t = await repo.spendTotals({ projectId: a.projectId }, w.from, w.to);
    expect({ ...t, costUsd: t.costUsd.toFixed(8) }).toEqual({
      costUsd: '0.00012000', inputTokens: 300, outputTokens: 30, cacheReadTokens: 150, cacheWriteTokens: 15, jobs: 1,
    });
    const empty = await repo.spendTotals({ projectId: a.projectId }, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-02T00:00:00Z'));
    expect({ ...empty, costUsd: empty.costUsd.toFixed(4) }).toEqual({
      costUsd: '0.0000', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, jobs: 0,
    });
  });

  it('labels repos and projects; other dimensions have no labels', async () => {
    expect((await repo.labels('repo', [a.repoId, NONE_KEY])).get(a.repoId)).toMatch(/^acme\/app\d+$/);
    expect((await repo.labels('project', [a.projectId])).get(a.projectId)).toBe(a.projectSlug);
    expect((await repo.labels('model', ['m1'])).size).toBe(0);
  });

  it('computes story stats and first-pass cells by completedAt', async () => {
    expect(await repo.storyStats(a.projectId, w.from, w.to)).toEqual({ stories: 2, firstPass: 1, attempts: 4 });
    const cells = await repo.firstPassCells(a.projectId, w);
    expect(cells.map((c) => ({ ...c, t: c.t.toISOString() }))).toEqual([
      { t: '2026-09-28T00:00:00.000Z', stories: 1, firstPass: 1 },
      { t: '2026-10-05T00:00:00.000Z', stories: 1, firstPass: 0 },
    ]);
  });

  it('aggregates reviews per reviewer and their findings by severity', async () => {
    expect(await repo.reviewers(a.projectId, w.from, w.to)).toEqual([
      { reviewer: 'adversarial', runs: 1, passed: 1 },
      { reviewer: 'semantic', runs: 2, passed: 1 },
    ]);
    expect(await repo.reviewerSeverities(a.projectId, w.from, w.to)).toEqual([
      { reviewer: 'semantic', severity: 'error', count: 2 },
      { reviewer: 'semantic', severity: 'warning', count: 2 },
    ]);
  });

  it('counts finish results and raw escalation reasons by finishedAt', async () => {
    expect(await repo.finishResults(a.projectId, w.from, w.to)).toEqual([
      { value: 'escalated', count: 1 },
      { value: 'promoted', count: 1 },
    ]);
    expect(await repo.escalationReasons(a.projectId, w.from, w.to)).toEqual([{ value: 'quality review omitted\nWALK', count: 1 }]);
  });

  it('lists the most expensive and the most looping stories', async () => {
    const byCost = await repo.topStories(a.projectId, w.from, w.to, 'cost', 10);
    expect(byCost.map((s) => [s.storyId, s.costUsd.toFixed(4)])).toEqual([['US-002', '0.3000'], ['US-001', '0.2000']]);
    expect((await repo.topStories(a.projectId, w.from, w.to, 'attempts', 1)).map((s) => s.storyId)).toEqual(['US-002']);
  });

  it('lists jobs by total cost with their summed ledger', async () => {
    const jobs = await repo.topJobs(a.projectId, w.from, w.to, 10);
    expect(jobs.map((j) => [j.jobId, j.costUsd.toFixed(4), j.ledgerCostUsd === null ? null : j.ledgerCostUsd.toFixed(4)])).toEqual([
      [job1, '0.6000', '0.6500'],
      [job2, '0.2000', null],
      [expect.any(String), '0.0000', null],
    ]);
  });

  it('breaks one job down across all attempts and reads its latest ingest row', async () => {
    const models = await repo.jobSlices(job1, 'model');
    expect(models.map((s) => [s.key, s.costUsd.toFixed(5), s.tokens])).toEqual([['m1', '9.00008', 495], ['m2', '0.00004', 165]]);
    expect((await repo.jobSlices(job1, 'role')).map((s) => s.key)).toEqual(['implementer', NONE_KEY]);
    const ingest = await repo.latestIngest(job1);
    expect(ingest).toMatchObject({ leaseEpoch: 2, status: 'partial', files: { cost: 'done:v8', review: 'skipped:v3' }, error: null });
    expect(ingest.ledgerCostUsd.toFixed(4)).toBe('0.4000');
    expect(ingest.liveCostUsd.toFixed(4)).toBe('0.3500');
    expect(await repo.latestIngest(job2)).toBeNull();
    expect((await repo.jobStories(job1, 500)).map((s) => s.storyId)).toEqual(['US-001', 'US-002', 'US-003', 'US-004']);
    expect((await repo.jobStories(job1, 2))).toHaveLength(2);
    expect((await repo.jobReviews(job1, 500)).map((r) => r.reviewer).sort()).toEqual(['adversarial', 'semantic', 'semantic']);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd apps/api && bun run test:db:up && bun run test:scoped test/integration/fleet/fleet-analytics-repository.integration.spec.ts`
Expected: FAIL — `Cannot find module '../../../src/fleet/analytics/prisma-analytics.repository'`.

- [ ] **Step 4: Implement the repository**

`apps/api/src/fleet/analytics/prisma-analytics.repository.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import {
  AnalyticsScope, AnalyticsWindow, Bucket, CostSliceRow, CountRow, FirstPassCell, GroupBy, IAnalyticsReadRepository, JobIngestRow,
  JobListRow, JobReviewRow, JobSliceBy, JobStoryRow, NONE_KEY, ReviewerRow, ReviewerSeverityRow, SpendCell, SpendTotalsRow,
  StoryListRow, StorySort, StoryStatsRow,
} from './domain/analytics.domain';

/** Fixed SQL fragments keyed by validated enums: request text never reaches the SQL. */
const GROUP_KEY: Record<GroupBy, Prisma.Sql> = {
  model: Prisma.sql`e."model"`,
  stage: Prisma.sql`e."stage"`,
  role: Prisma.sql`COALESCE(e."sessionRole", ${NONE_KEY})`,
  repo: Prisma.sql`e."repoId"`,
  runner: Prisma.sql`COALESCE(e."runnerId", ${NONE_KEY})`,
  feature: Prisma.sql`e."featureName"`,
  story: Prisma.sql`COALESCE(e."storyId", ${NONE_KEY})`,
  project: Prisma.sql`e."projectId"`,
};
const SLICE_KEY: Record<JobSliceBy, Prisma.Sql> = { stage: GROUP_KEY.stage, role: GROUP_KEY.role, model: GROUP_KEY.model };
const TRUNC: Record<Bucket, Prisma.Sql> = { day: Prisma.raw(`'day'`), week: Prisma.raw(`'week'`), month: Prisma.raw(`'month'`) };
/** D379: one token measure. */
const TOKENS = Prisma.sql`(e."inputTokens"::bigint + e."outputTokens" + e."cacheReadTokens" + e."cacheWriteTokens")`;
/** Severity counts are ints written by ingest; anything else counts 0 instead of failing the query. */
const SEVERITIES = Prisma.sql`jsonb_each_text(CASE WHEN jsonb_typeof(r."findingsBySeverity") = 'object' THEN r."findingsBySeverity" ELSE '{}'::jsonb END)`;

const num = (v: unknown): number => Number(v ?? 0);
const dec = (v: unknown): Prisma.Decimal => new Prisma.Decimal((v ?? 0) as Prisma.Decimal | string | number);
const decOrNull = (v: unknown): Prisma.Decimal | null => (v === null || v === undefined ? null : dec(v));
const inScope = (scope: AnalyticsScope): Prisma.Sql =>
  (scope.projectId === null ? Prisma.empty : Prisma.sql`AND e."projectId" = ${scope.projectId}`);

type Raw = Record<string, unknown>;

@Injectable()
export class PrismaAnalyticsRepository implements IAnalyticsReadRepository {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  /** Transaction-scoped inside txManager.run (nestjs-prisma ALS proxy). */
  private get db() {
    return this.prisma.client;
  }

  async spendCells(scope: AnalyticsScope, w: AnalyticsWindow, groupBy: GroupBy): Promise<SpendCell[]> {
    const rows = await this.db.$queryRaw<Raw[]>(Prisma.sql`
      SELECT ${GROUP_KEY[groupBy]} AS "key", date_trunc(${TRUNC[w.bucket]}, e."at") AS "t",
        SUM(e."costUsd") AS "cost", SUM(${TOKENS}) AS "tokens"
      FROM "FleetCostEvent" e
      WHERE e."at" >= ${w.from} AND e."at" < ${w.to} ${inScope(scope)}
      GROUP BY 1, 2`);
    return rows.map((r) => ({ key: r.key as string, t: r.t as Date, costUsd: dec(r.cost), tokens: num(r.tokens) }));
  }

  async spendTotals(scope: AnalyticsScope, from: Date, to: Date): Promise<SpendTotalsRow> {
    const [r] = await this.db.$queryRaw<Raw[]>(Prisma.sql`
      SELECT SUM(e."costUsd") AS "cost", SUM(e."inputTokens") AS "input", SUM(e."outputTokens") AS "output",
        SUM(e."cacheReadTokens") AS "cacheRead", SUM(e."cacheWriteTokens") AS "cacheWrite", COUNT(DISTINCT e."jobId") AS "jobs"
      FROM "FleetCostEvent" e
      WHERE e."at" >= ${from} AND e."at" < ${to} ${inScope(scope)}`);
    return {
      costUsd: dec(r.cost), inputTokens: num(r.input), outputTokens: num(r.output),
      cacheReadTokens: num(r.cacheRead), cacheWriteTokens: num(r.cacheWrite), jobs: num(r.jobs),
    };
  }

  async labels(groupBy: GroupBy, keys: readonly string[]): Promise<ReadonlyMap<string, string>> {
    const ids = keys.filter((k) => k !== NONE_KEY);
    if (ids.length === 0) return new Map<string, string>();
    if (groupBy === 'repo') {
      const rows = await this.db.fleetRepo.findMany({ where: { id: { in: ids } }, select: { id: true, owner: true, name: true } });
      return new Map(rows.map((r): [string, string] => [r.id, `${r.owner}/${r.name}`]));
    }
    if (groupBy === 'runner') {
      const rows = await this.db.runner.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
      return new Map(rows.map((r): [string, string] => [r.id, r.name]));
    }
    if (groupBy === 'project') {
      const rows = await this.db.project.findMany({ where: { id: { in: ids } }, select: { id: true, slug: true } });
      return new Map(rows.map((r): [string, string] => [r.id, r.slug]));
    }
    return new Map<string, string>();
  }

  async storyStats(projectId: string, from: Date, to: Date): Promise<StoryStatsRow> {
    const [r] = await this.db.$queryRaw<Raw[]>(Prisma.sql`
      SELECT COUNT(*) AS "stories", COUNT(*) FILTER (WHERE s."firstPassSuccess") AS "firstPass", SUM(s."attempts") AS "attempts"
      FROM "FleetStoryResult" s
      WHERE s."projectId" = ${projectId} AND s."completedAt" >= ${from} AND s."completedAt" < ${to}`);
    return { stories: num(r.stories), firstPass: num(r.firstPass), attempts: num(r.attempts) };
  }

  async firstPassCells(projectId: string, w: AnalyticsWindow): Promise<FirstPassCell[]> {
    const rows = await this.db.$queryRaw<Raw[]>(Prisma.sql`
      SELECT date_trunc(${TRUNC[w.bucket]}, s."completedAt") AS "t", COUNT(*) AS "stories",
        COUNT(*) FILTER (WHERE s."firstPassSuccess") AS "firstPass"
      FROM "FleetStoryResult" s
      WHERE s."projectId" = ${projectId} AND s."completedAt" >= ${w.from} AND s."completedAt" < ${w.to}
      GROUP BY 1 ORDER BY 1`);
    return rows.map((r) => ({ t: r.t as Date, stories: num(r.stories), firstPass: num(r.firstPass) }));
  }

  async reviewers(projectId: string, from: Date, to: Date): Promise<ReviewerRow[]> {
    const rows = await this.db.$queryRaw<Raw[]>(Prisma.sql`
      SELECT r."reviewer", COUNT(*) AS "runs", COUNT(*) FILTER (WHERE r."passed") AS "passed"
      FROM "FleetReviewResult" r
      WHERE r."projectId" = ${projectId} AND r."at" >= ${from} AND r."at" < ${to}
      GROUP BY 1 ORDER BY 1`);
    return rows.map((r) => ({ reviewer: r.reviewer as string, runs: num(r.runs), passed: num(r.passed) }));
  }

  async reviewerSeverities(projectId: string, from: Date, to: Date): Promise<ReviewerSeverityRow[]> {
    const rows = await this.db.$queryRaw<Raw[]>(Prisma.sql`
      SELECT r."reviewer", f.key AS "severity", SUM(CASE WHEN f.value ~ '^[0-9]{1,9}$' THEN f.value::int ELSE 0 END) AS "count"
      FROM "FleetReviewResult" r CROSS JOIN LATERAL ${SEVERITIES} f
      WHERE r."projectId" = ${projectId} AND r."at" >= ${from} AND r."at" < ${to}
      GROUP BY 1, 2 ORDER BY 1, 2`);
    return rows.map((r) => ({ reviewer: r.reviewer as string, severity: r.severity as string, count: num(r.count) }));
  }

  async finishResults(projectId: string, from: Date, to: Date): Promise<CountRow[]> {
    return this.countJobs(Prisma.sql`j."finishResult"`, projectId, from, to);
  }

  async escalationReasons(projectId: string, from: Date, to: Date): Promise<CountRow[]> {
    return this.countJobs(Prisma.sql`j."escalationReason"`, projectId, from, to);
  }

  /** Jobs grouped by one text column, attributed by finishedAt (spec §4.1). */
  private async countJobs(column: Prisma.Sql, projectId: string, from: Date, to: Date): Promise<CountRow[]> {
    const rows = await this.db.$queryRaw<Raw[]>(Prisma.sql`
      SELECT ${column} AS "value", COUNT(*) AS "count"
      FROM "FleetJob" j
      WHERE j."projectId" = ${projectId} AND j."finishedAt" >= ${from} AND j."finishedAt" < ${to} AND ${column} IS NOT NULL
      GROUP BY 1 ORDER BY 2 DESC, 1 ASC`);
    return rows.map((r) => ({ value: r.value as string, count: num(r.count) }));
  }

  async topStories(projectId: string, from: Date, to: Date, sort: StorySort, limit: number): Promise<StoryListRow[]> {
    const orderBy: Prisma.FleetStoryResultOrderByWithRelationInput[] = sort === 'attempts'
      ? [{ attempts: 'desc' }, { costUsd: 'desc' }, { id: 'asc' }]
      : [{ costUsd: 'desc' }, { id: 'asc' }];
    const rows = await this.db.fleetStoryResult.findMany({
      where: { projectId, completedAt: { gte: from, lt: to } }, orderBy, take: limit,
      select: {
        jobId: true, leaseEpoch: true, featureName: true, storyId: true, attempts: true, firstPassSuccess: true, success: true,
        costUsd: true, completedAt: true,
      },
    });
    return rows.map((r) => ({ ...r, costUsd: dec(r.costUsd) }));
  }

  async topJobs(projectId: string, from: Date, to: Date, limit: number): Promise<JobListRow[]> {
    const rows = await this.db.$queryRaw<Raw[]>(Prisma.sql`
      SELECT j."id" AS "jobId", j."command", j."feature" AS "featureName", j."state",
        (j."costSpentUsd" + j."costCarriedUsd") AS "cost", l."ledger", j."finishedAt"
      FROM "FleetJob" j
      LEFT JOIN LATERAL (
        SELECT SUM(i."ledgerCostUsd") AS "ledger" FROM "FleetBundleIngest" i
        WHERE i."jobId" = j."id" AND i."status" IN ('done', 'partial')
      ) l ON TRUE
      WHERE j."projectId" = ${projectId} AND j."finishedAt" >= ${from} AND j."finishedAt" < ${to}
      ORDER BY "cost" DESC, j."id" ASC
      LIMIT ${limit}`);
    return rows.map((r) => ({
      jobId: r.jobId as string, command: r.command as string, featureName: r.featureName as string, state: r.state as string,
      costUsd: dec(r.cost), ledgerCostUsd: decOrNull(r.ledger), finishedAt: r.finishedAt as Date | null,
    }));
  }

  async jobSlices(jobId: string, by: JobSliceBy): Promise<CostSliceRow[]> {
    const rows = await this.db.$queryRaw<Raw[]>(Prisma.sql`
      SELECT ${SLICE_KEY[by]} AS "key", SUM(e."costUsd") AS "cost", SUM(${TOKENS}) AS "tokens"
      FROM "FleetCostEvent" e
      WHERE e."jobId" = ${jobId}
      GROUP BY 1 ORDER BY "cost" DESC, "key" ASC`);
    return rows.map((r) => ({ key: r.key as string, costUsd: dec(r.cost), tokens: num(r.tokens) }));
  }

  async latestIngest(jobId: string): Promise<JobIngestRow | null> {
    const r = await this.db.fleetBundleIngest.findFirst({
      where: { jobId }, orderBy: [{ leaseEpoch: 'desc' }, { createdAt: 'desc' }],
      select: { leaseEpoch: true, status: true, files: true, ingestedAt: true, error: true, liveCostUsd: true, ledgerCostUsd: true },
    });
    if (!r) return null;
    return {
      leaseEpoch: r.leaseEpoch, status: r.status, files: (r.files ?? {}) as Record<string, string>, ingestedAt: r.ingestedAt, error: r.error,
      liveCostUsd: decOrNull(r.liveCostUsd), ledgerCostUsd: decOrNull(r.ledgerCostUsd),
    };
  }

  async jobStories(jobId: string, limit: number): Promise<JobStoryRow[]> {
    const rows = await this.db.fleetStoryResult.findMany({
      where: { jobId }, orderBy: [{ leaseEpoch: 'desc' }, { storyId: 'asc' }], take: limit,
      select: {
        leaseEpoch: true, featureName: true, storyId: true, attempts: true, firstPassSuccess: true, success: true, costUsd: true,
        durationMs: true, completedAt: true,
      },
    });
    return rows.map((r) => ({ ...r, costUsd: dec(r.costUsd) }));
  }

  async jobReviews(jobId: string, limit: number): Promise<JobReviewRow[]> {
    const rows = await this.db.fleetReviewResult.findMany({
      where: { jobId }, orderBy: [{ at: 'asc' }, { id: 'asc' }], take: limit,
      select: {
        leaseEpoch: true, storyId: true, reviewer: true, passed: true, failOpen: true, findingCount: true, findingsBySeverity: true,
        advisoryCount: true, at: true,
      },
    });
    return rows.map((r) => ({ ...r, findingsBySeverity: (r.findingsBySeverity ?? {}) as Record<string, number> }));
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/api && bun run test:scoped test/integration/fleet/fleet-analytics-repository.integration.spec.ts`
Expected: PASS (10 tests). If the week-boundary test fails, the SQL and `bucketStart` disagree: fix `bucketStart`,
never the expected values.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/fleet/analytics apps/api/test/helpers/fleet-analytics-fixtures.ts apps/api/test/integration/fleet/fleet-analytics-repository.integration.spec.ts
git commit -m "feat(fleet): S2b analytics read repository (spec §4.1-4.2)"
```

---

### Task 3: Delete-on-demand in the repository

**Files:**
- Modify: `apps/api/src/fleet/analytics/domain/analytics.domain.ts` (`IAnalyticsRepository`, delete types)
- Modify: `apps/api/src/fleet/analytics/prisma-analytics.repository.ts`
- Test: `apps/api/test/integration/fleet/fleet-analytics-delete.integration.spec.ts`

**Interfaces:**
- Consumes: `IAnalyticsReadRepository`, `PrismaAnalyticsRepository` (Task 2); fixtures (Task 2).
- Produces: `DeleteAnalyticsInput { projectId: string | null; before: Date; now: Date }`,
  `DeletedCounts { costEvents; stories; reviews; ingestRowsMarked }`,
  `IAnalyticsRepository extends IAnalyticsReadRepository` with `findProjectSlug(projectId): Promise<string | null>`
  and `deleteRows(input): Promise<DeletedCounts>`; `PrismaAnalyticsRepository implements IAnalyticsRepository`.

- [ ] **Step 1: Write the failing test**

`apps/api/test/integration/fleet/fleet-analytics-delete.integration.spec.ts`:

```ts
/**
 * Fleet S2b slice 1b — analytics delete-on-demand (PG), spec §4.3, D384.
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-analytics-delete.integration.spec.ts
 */
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { resetDb } from '../../helpers/reset-db';
import { seedFleetBase } from '../../helpers/fleet-fixtures';
import {
  insertAnalyticsJob, insertCostEvent, insertIngestRow, insertReviewResult, insertStoryResult,
} from '../../helpers/fleet-analytics-fixtures';
import { PrismaAnalyticsRepository } from '../../../src/fleet/analytics/prisma-analytics.repository';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('analytics delete-on-demand (PG)', () => {
  const prisma = new PrismaClient();
  const repo = new PrismaAnalyticsRepository({ client: prisma } as unknown as PrismaService<PrismaClient>);
  const cutoff = new Date('2026-10-05T00:00:00Z');
  const now = new Date('2026-10-06T00:00:00Z');
  let a: Awaited<ReturnType<typeof seedFleetBase>>;
  let b: Awaited<ReturnType<typeof seedFleetBase>>;
  let oldA: string;
  let newA: string;

  beforeAll(async () => {
    await resetDb();
    a = await seedFleetBase(prisma);
    b = await seedFleetBase(prisma);
    const ownerA = { projectId: a.projectId, repoId: a.repoId, requestedById: a.adminId };
    oldA = await insertAnalyticsJob(prisma, ownerA, { finishedAt: new Date('2026-10-02T00:00:00Z') });
    newA = await insertAnalyticsJob(prisma, ownerA, { finishedAt: new Date('2026-10-07T00:00:00Z') });
    const jobB = await insertAnalyticsJob(prisma, { projectId: b.projectId, repoId: b.repoId, requestedById: b.adminId }, { finishedAt: new Date('2026-10-02T00:00:00Z') });
    const rowOld = { jobId: oldA, projectId: a.projectId, repoId: a.repoId };
    const rowNew = { jobId: newA, projectId: a.projectId, repoId: a.repoId };
    const rowB = { jobId: jobB, projectId: b.projectId, repoId: b.repoId };
    await insertCostEvent(prisma, rowOld, { at: new Date('2026-10-01T00:00:00Z') });
    await insertCostEvent(prisma, rowNew, { at: new Date('2026-10-06T00:00:00Z') });
    await insertCostEvent(prisma, rowB, { at: new Date('2026-10-01T00:00:00Z') });
    await insertStoryResult(prisma, rowOld, { completedAt: new Date('2026-10-01T00:00:00Z') });
    await insertStoryResult(prisma, rowOld, { completedAt: null }); // matched through the job's finishedAt
    await insertStoryResult(prisma, rowNew, { completedAt: null });
    await insertReviewResult(prisma, rowOld, { at: new Date('2026-10-01T00:00:00Z') });
    await insertIngestRow(prisma, oldA, 1);
    await insertIngestRow(prisma, newA, 1);
    await insertIngestRow(prisma, jobB, 1);
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  // These tests share state and run in order: run the file whole, never with `-t`.
  it('finds a project slug, null for an unknown id', async () => {
    expect(await repo.findProjectSlug(a.projectId)).toBe(a.projectSlug);
    expect(await repo.findProjectSlug('nope')).toBeNull();
  });

  it('deletes one project before the cutoff and marks the affected ingest rows', async () => {
    expect(await repo.deleteRows({ projectId: a.projectId, before: cutoff, now })).toEqual({ costEvents: 1, stories: 2, reviews: 1, ingestRowsMarked: 1 });
    expect(await prisma.fleetCostEvent.count({ where: { projectId: a.projectId } })).toBe(1);
    expect(await prisma.fleetCostEvent.count({ where: { projectId: b.projectId } })).toBe(1);
    expect(await prisma.fleetStoryResult.count({ where: { jobId: newA } })).toBe(1);
    const marked = await prisma.fleetBundleIngest.findFirstOrThrow({ where: { jobId: oldA } });
    expect(marked.files).toEqual({ cost: 'done:v8', deleted: '2026-10-05T00:00:00.000Z' });
    expect((await prisma.fleetBundleIngest.findFirstOrThrow({ where: { jobId: newA } })).files).toEqual({ cost: 'done:v8' });
    expect(await prisma.fleetBundleIngest.count()).toBe(3);
  });

  it('deletes across every project when projectId is null', async () => {
    expect(await repo.deleteRows({ projectId: null, before: new Date('2026-10-08T00:00:00Z'), now })).toEqual({
      costEvents: 2, stories: 1, reviews: 0, ingestRowsMarked: 2,
    });
    expect(await prisma.fleetCostEvent.count()).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && bun run test:scoped test/integration/fleet/fleet-analytics-delete.integration.spec.ts`
Expected: FAIL — TypeScript: `Property 'findProjectSlug' does not exist on type 'PrismaAnalyticsRepository'`.

- [ ] **Step 3: Implement**

Append to `apps/api/src/fleet/analytics/domain/analytics.domain.ts`:

```ts
export interface DeleteAnalyticsInput {
  /** null = every project (D384). */
  projectId: string | null;
  before: Date;
  now: Date;
}

export interface DeletedCounts {
  costEvents: number;
  stories: number;
  reviews: number;
  ingestRowsMarked: number;
}

export interface IAnalyticsRepository extends IAnalyticsReadRepository {
  findProjectSlug(projectId: string): Promise<string | null>;
  /**
   * Spec §4.3, D384: marks the ingest rows of every job that loses rows, then deletes cost events and reviews by
   * `at`, stories by `completedAt` (or the job's `finishedAt` when null), all older than `before`. Call inside a
   * transaction.
   */
  deleteRows(input: DeleteAnalyticsInput): Promise<DeletedCounts>;
}
```

In `apps/api/src/fleet/analytics/prisma-analytics.repository.ts`, change the domain import to also bring
`DeleteAnalyticsInput`, `DeletedCounts` and `IAnalyticsRepository`, change the class line to
`export class PrismaAnalyticsRepository implements IAnalyticsRepository {`, and add these methods at the end of the
class:

```ts
  async findProjectSlug(projectId: string): Promise<string | null> {
    const project = await this.db.project.findUnique({ where: { id: projectId }, select: { slug: true } });
    return project ? project.slug : null;
  }

  async deleteRows({ projectId, before, now }: DeleteAnalyticsInput): Promise<DeletedCounts> {
    const scoped = (alias: 'c' | 's' | 'r'): Prisma.Sql =>
      (projectId === null ? Prisma.empty : Prisma.sql`AND ${Prisma.raw(alias)}."projectId" = ${projectId}`);
    const ingestRowsMarked = await this.db.$executeRaw(Prisma.sql`
      UPDATE "FleetBundleIngest"
      SET "files" = "files" || jsonb_build_object('deleted', ${before.toISOString()}::text), "updatedAt" = ${now}
      WHERE "jobId" IN (
        SELECT c."jobId" FROM "FleetCostEvent" c WHERE c."at" < ${before} ${scoped('c')}
        UNION SELECT s."jobId" FROM "FleetStoryResult" s JOIN "FleetJob" j ON j."id" = s."jobId"
          WHERE (s."completedAt" < ${before} OR (s."completedAt" IS NULL AND j."finishedAt" < ${before})) ${scoped('s')}
        UNION SELECT r."jobId" FROM "FleetReviewResult" r WHERE r."at" < ${before} ${scoped('r')}
      )`);
    const project = projectId === null ? {} : { projectId };
    const costEvents = await this.db.fleetCostEvent.deleteMany({ where: { ...project, at: { lt: before } } });
    const stories = await this.db.fleetStoryResult.deleteMany({
      where: { ...project, OR: [{ completedAt: { lt: before } }, { completedAt: null, job: { finishedAt: { lt: before } } }] },
    });
    const reviews = await this.db.fleetReviewResult.deleteMany({ where: { ...project, at: { lt: before } } });
    return { costEvents: costEvents.count, stories: stories.count, reviews: reviews.count, ingestRowsMarked };
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && bun run test:scoped test/integration/fleet/fleet-analytics-delete.integration.spec.ts test/integration/fleet/fleet-analytics-repository.integration.spec.ts`
Expected: PASS (both suites).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/fleet/analytics apps/api/test/integration/fleet/fleet-analytics-delete.integration.spec.ts
git commit -m "feat(fleet): S2b analytics delete-on-demand in the repository (D384)"
```

---

### Task 4: Analytics service and quality mapping

**Files:**
- Create: `apps/api/src/fleet/analytics/analytics-quality.ts`, `apps/api/src/fleet/analytics/analytics.service.ts`
- Modify: `apps/api/src/fleet/activity/domain/fleet-activity.domain.ts` (`'analytics'`)
- Test: `apps/api/src/fleet/analytics/analytics-quality.spec.ts`, `apps/api/src/fleet/analytics/analytics.service.spec.ts`

**Interfaces:**
- Consumes: Task 1 helpers and views; `IAnalyticsRepository`, `ANALYTICS_REPOSITORY`, row types (Tasks 2-3);
  `FLEET_JOB_REPOSITORY` / `IFleetJobRepository.findById` (`src/fleet/jobs/domain/fleet-job.domain.ts:183`);
  `FleetActivityService.record`; `TRANSACTION_MANAGER` / `ITransactionManager` (`@nathapp/nestjs-data`);
  `ESCALATED_FROM_AUDIT` (`src/fleet/ingest/ingest-corrections.ts`).
- Produces: `finishOutcomes(rows): FinishOutcomesView`, `topReasons(rows, limit?): ReasonView[]`,
  `reviewerViews(rows, severities): ReviewerView[]`, `firstPassSeries(cells, starts): FirstPassPointView[]`;
  `AnalyticsService` with `spend(projectId | null, q: SpendInput, now): Promise<SpendView>`,
  `quality(projectId, q: WindowInput, now): Promise<QualityView>`, `stories(projectId, q: StoriesInput, now): Promise<StoriesView>`,
  `jobs(projectId, q: ListInput, now): Promise<JobsView>`, `job(projectId, jobId): Promise<JobAnalyticsView>`,
  `deleteRows(actorId, q: DeleteInput, now): Promise<DeletedView>`.

- [ ] **Step 1: Write the failing tests**

`apps/api/src/fleet/analytics/analytics-quality.spec.ts`:

```ts
import { finishOutcomes, firstPassSeries, reviewerViews, topReasons } from './analytics-quality';

describe('quality mapping', () => {
  it('buckets finish results, with unknown and prototype-named values as other (D381)', () => {
    expect(finishOutcomes([
      { value: 'opened', count: 2 }, { value: 'promoted', count: 1 }, { value: 'already-ready', count: 1 },
      { value: 'escalated', count: 3 }, { value: 'skipped', count: 1 }, { value: 'nothing-to-finish', count: 1 },
      { value: 'constructor', count: 1 }, { value: 'weird', count: 2 },
    ])).toEqual({ opened: 2, promoted: 2, escalated: 3, skipped: 2, other: 3 });
    expect(finishOutcomes([])).toEqual({ opened: 0, promoted: 0, escalated: 0, skipped: 0, other: 0 });
  });

  it('merges escalation reasons by their first line, drops empty ones, sorts and limits', () => {
    expect(topReasons([
      { value: 'review omitted WALK\nfile a', count: 2 }, { value: 'review omitted WALK\nfile b', count: 1 },
      { value: 'tests failed', count: 3 }, { value: '  \n ', count: 5 }, { value: 'budget', count: 1 },
    ], 2)).toEqual([{ reason: 'review omitted WALK', count: 3 }, { reason: 'tests failed', count: 3 }]);
  });

  it('builds reviewer views with pass rates and their severity counts', () => {
    expect(reviewerViews(
      [{ reviewer: 'semantic', runs: 2, passed: 1 }, { reviewer: 'lint', runs: 1, passed: 1 }],
      [{ reviewer: 'semantic', severity: 'error', count: 2 }],
    )).toEqual([
      { reviewer: 'semantic', runs: 2, passRate: 0.5, findingsBySeverity: { error: 2 } },
      { reviewer: 'lint', runs: 1, passRate: 1, findingsBySeverity: {} },
    ]);
  });

  it('zero-fills the first-pass series with null rates', () => {
    const starts = [new Date('2026-10-01T00:00:00Z'), new Date('2026-10-02T00:00:00Z')];
    expect(firstPassSeries([{ t: new Date('2026-10-02T00:00:00Z'), stories: 3, firstPass: 2 }], starts)).toEqual([
      { t: '2026-10-01T00:00:00.000Z', rate: null },
      { t: '2026-10-02T00:00:00.000Z', rate: 0.6667 },
    ]);
  });
});
```

`apps/api/src/fleet/analytics/analytics.service.spec.ts`:

```ts
import { NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { Prisma } from '@prisma/client';
import { ESCALATED_FROM_AUDIT } from '../ingest/ingest-corrections';
import { AnalyticsService } from './analytics.service';
import type { IAnalyticsRepository } from './domain/analytics.domain';

const D = (v: string) => new Prisma.Decimal(v);
const now = new Date('2026-10-05T12:00:00.000Z');
const EMPTY_TOTALS = { costUsd: D('0'), inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, jobs: 0 };

function fakeRepo(over: Partial<Record<keyof IAnalyticsRepository, jest.Mock>> = {}): IAnalyticsRepository & Record<string, jest.Mock> {
  return {
    spendCells: jest.fn().mockResolvedValue([]),
    spendTotals: jest.fn().mockResolvedValue(EMPTY_TOTALS),
    labels: jest.fn().mockResolvedValue(new Map()),
    storyStats: jest.fn().mockResolvedValue({ stories: 0, firstPass: 0, attempts: 0 }),
    firstPassCells: jest.fn().mockResolvedValue([]),
    reviewers: jest.fn().mockResolvedValue([]),
    reviewerSeverities: jest.fn().mockResolvedValue([]),
    finishResults: jest.fn().mockResolvedValue([]),
    escalationReasons: jest.fn().mockResolvedValue([]),
    topStories: jest.fn().mockResolvedValue([]),
    topJobs: jest.fn().mockResolvedValue([]),
    jobSlices: jest.fn().mockResolvedValue([]),
    latestIngest: jest.fn().mockResolvedValue(null),
    jobStories: jest.fn().mockResolvedValue([]),
    jobReviews: jest.fn().mockResolvedValue([]),
    findProjectSlug: jest.fn().mockResolvedValue('web'),
    deleteRows: jest.fn().mockResolvedValue({ costEvents: 3, stories: 2, reviews: 1, ingestRowsMarked: 1 }),
    ...over,
  } as IAnalyticsRepository & Record<string, jest.Mock>;
}

describe('AnalyticsService', () => {
  const jobs = { findById: jest.fn() };
  const activity = { record: jest.fn() };
  const txManager = { run: jest.fn((fn: () => Promise<unknown>) => fn()) };
  const make = (repo: IAnalyticsRepository) => new AnalyticsService(repo, jobs as never, activity as never, txManager as never);

  afterEach(() => jest.clearAllMocks());

  it('answers an empty project with zero money, null rates and no series', async () => {
    const s = await make(fakeRepo()).spend('p1', {}, now);
    expect(s).toEqual({
      window: { from: '2026-09-05T12:00:00.000Z', to: '2026-10-05T12:00:00.000Z' }, bucket: 'day', groupBy: 'model',
      totals: { costUsd: '0.0000', tokens: 0, cacheShare: null, jobs: 0 }, series: [],
    });
  });

  it('passes the scope and group, labels the series and computes the cache share', async () => {
    const repo = fakeRepo({
      spendCells: jest.fn().mockResolvedValue([{ key: 'r1', t: new Date('2026-10-01T00:00:00Z'), costUsd: D('1.23456'), tokens: 9 }]),
      spendTotals: jest.fn().mockResolvedValue({ costUsd: D('1.23456'), inputTokens: 300, outputTokens: 30, cacheReadTokens: 150, cacheWriteTokens: 15, jobs: 2 }),
      labels: jest.fn().mockResolvedValue(new Map([['r1', 'acme/app']])),
    });
    const s = await make(repo).spend(null, { from: '2026-10-01', to: '2026-10-03', groupBy: 'repo' }, now);
    expect(repo.spendCells).toHaveBeenCalledWith({ projectId: null }, expect.objectContaining({ bucket: 'day' }), 'repo');
    expect(repo.labels).toHaveBeenCalledWith('repo', ['r1']);
    expect(s.totals).toEqual({ costUsd: '1.2346', tokens: 495, cacheShare: 0.3333, jobs: 2 });
    expect(s.series).toEqual([expect.objectContaining({ key: 'r1', label: 'acme/app', costUsd: '1.2346', points: expect.any(Array) })]);
    expect(s.series[0].points).toHaveLength(2);
  });

  it('rejects an invalid window before touching the repository', async () => {
    const repo = fakeRepo();
    await expect(make(repo).spend('p1', { from: '2026-10-03', to: '2026-10-01' }, now)).rejects.toBeInstanceOf(ValidationAppException);
    expect(repo.spendCells).not.toHaveBeenCalled();
  });

  it('answers quality with null rates and a zero-filled series when there is no data', async () => {
    const q = await make(fakeRepo()).quality('p1', {}, now);
    expect(q).toMatchObject({
      stories: 0, firstPassRate: null, avgAttempts: null, reviewByReviewer: [], topEscalationReasons: [],
      finishOutcomes: { opened: 0, promoted: 0, escalated: 0, skipped: 0, other: 0 },
    });
    expect(q.firstPassSeries).toHaveLength(31);
    expect(q.firstPassSeries.every((p) => p.rate === null)).toBe(true);
  });

  it('computes first-pass rate and average attempts', async () => {
    const q = await make(fakeRepo({ storyStats: jest.fn().mockResolvedValue({ stories: 4, firstPass: 3, attempts: 6 }) })).quality('p1', {}, now);
    expect(q.firstPassRate).toBe(0.75);
    expect(q.avgAttempts).toBe(1.5);
  });

  it('lists stories with the default limit and sort, and jobs with drift', async () => {
    const repo = fakeRepo({
      topStories: jest.fn().mockResolvedValue([{
        jobId: 'j1', leaseEpoch: 1, featureName: 'f', storyId: 'US-1', attempts: 2, firstPassSuccess: false, success: true,
        costUsd: D('0.30004'), completedAt: new Date('2026-10-02T00:00:00Z'),
      }]),
      topJobs: jest.fn().mockResolvedValue([
        { jobId: 'j1', command: 'RUN', featureName: 'f', state: 'COMPLETED', costUsd: D('0.6'), ledgerCostUsd: D('0.65'), finishedAt: new Date('2026-10-02T00:00:00Z') },
        { jobId: 'j2', command: 'PLAN', featureName: 'g', state: 'COMPLETED', costUsd: D('0.2'), ledgerCostUsd: null, finishedAt: null },
      ]),
    });
    const svc = make(repo);
    const stories = await svc.stories('p1', {}, now);
    expect(repo.topStories).toHaveBeenCalledWith('p1', expect.any(Date), now, 'cost', 20);
    expect(stories.rows[0]).toMatchObject({ storyId: 'US-1', costUsd: '0.3000', completedAt: '2026-10-02T00:00:00.000Z' });
    const jobsView = await svc.jobs('p1', { limit: 5 }, now);
    expect(repo.topJobs).toHaveBeenCalledWith('p1', expect.any(Date), now, 5);
    expect(jobsView.rows.map((r) => [r.costUsd, r.ledgerCostUsd, r.driftUsd, r.finishedAt])).toEqual([
      ['0.6000', '0.6500', '0.0500', '2026-10-02T00:00:00.000Z'],
      ['0.2000', null, null, null],
    ]);
  });

  it('breaks a job down, 404 outside the project', async () => {
    jobs.findById.mockResolvedValue({ id: 'j1', projectId: 'p1', stateReason: ESCALATED_FROM_AUDIT });
    const repo = fakeRepo({
      jobSlices: jest.fn().mockResolvedValue([{ key: 'm1', costUsd: D('0.00012'), tokens: 10 }]),
      latestIngest: jest.fn().mockResolvedValue({
        leaseEpoch: 2, status: 'done', files: { cost: 'done:v8' }, ingestedAt: new Date('2026-10-02T13:00:00Z'), error: null,
        liveCostUsd: D('0.4'), ledgerCostUsd: D('0.5'),
      }),
    });
    const view = await make(repo).job('p1', 'j1');
    expect(repo.jobSlices).toHaveBeenCalledWith('j1', 'stage');
    expect(repo.jobStories).toHaveBeenCalledWith('j1', 500);
    expect(view).toMatchObject({
      jobId: 'j1', corrected: true, liveCostUsd: '0.4000', ledgerCostUsd: '0.5000',
      ingest: { leaseEpoch: 2, status: 'done', files: { cost: 'done:v8' }, ingestedAt: '2026-10-02T13:00:00.000Z', error: null },
      byModel: [{ key: 'm1', costUsd: '0.0001', tokens: 10 }],
    });
    jobs.findById.mockResolvedValue({ id: 'j9', projectId: 'other', stateReason: null });
    await expect(make(fakeRepo()).job('p1', 'j9')).rejects.toBeInstanceOf(NotFoundAppException);
    jobs.findById.mockResolvedValue(null);
    await expect(make(fakeRepo()).job('p1', 'nope')).rejects.toBeInstanceOf(NotFoundAppException);
  });

  it('answers a job with no ingest yet with null ingest and costs', async () => {
    jobs.findById.mockResolvedValue({ id: 'j1', projectId: 'p1', stateReason: null });
    expect(await make(fakeRepo()).job('p1', 'j1')).toMatchObject({ ingest: null, liveCostUsd: null, ledgerCostUsd: null, corrected: false });
  });

  it('deletes only with the right confirmation and records the activity', async () => {
    const repo = fakeRepo();
    const svc = make(repo);
    await expect(svc.deleteRows('u1', { before: '2026-10-01T00:00:00Z', confirm: 'web' }, now)).rejects.toBeInstanceOf(ValidationAppException);
    await expect(svc.deleteRows('u1', { before: '2026-10-01T00:00:00Z', projectId: 'p1', confirm: 'ALL' }, now)).rejects.toBeInstanceOf(ValidationAppException);
    repo.findProjectSlug.mockResolvedValueOnce(null);
    await expect(svc.deleteRows('u1', { before: '2026-10-01T00:00:00Z', projectId: 'gone', confirm: 'gone' }, now)).rejects.toBeInstanceOf(NotFoundAppException);
    expect(repo.deleteRows).not.toHaveBeenCalled();

    const view = await svc.deleteRows('u1', { before: '2026-10-01T00:00:00Z', projectId: 'p1', confirm: 'web' }, now);
    expect(repo.deleteRows).toHaveBeenCalledWith({ projectId: 'p1', before: new Date('2026-10-01T00:00:00Z'), now });
    expect(view).toEqual({ projectId: 'p1', before: '2026-10-01T00:00:00.000Z', costEvents: 3, stories: 2, reviews: 1, ingestRowsMarked: 1 });
    expect(activity.record).toHaveBeenCalledWith(expect.objectContaining({
      actorType: 'USER', actorId: 'u1', action: 'analytics.deleted', entityType: 'analytics', entityId: 'p1', projectId: 'p1',
      payload: { before: '2026-10-01T00:00:00.000Z', costEvents: 3, stories: 2, reviews: 1, ingestRowsMarked: 1 },
    }));
    expect(txManager.run).toHaveBeenCalledTimes(1);

    await svc.deleteRows('u1', { before: '2026-10-01T00:00:00Z', confirm: 'ALL' }, now);
    expect(activity.record).toHaveBeenLastCalledWith(expect.objectContaining({ entityId: 'all', projectId: null }));
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/api && bun run test:scoped src/fleet/analytics/analytics-quality.spec.ts src/fleet/analytics/analytics.service.spec.ts`
Expected: FAIL — `Cannot find module './analytics-quality'` / `'./analytics.service'`.

- [ ] **Step 3: Implement**

`apps/api/src/fleet/analytics/analytics-quality.ts`:

```ts
import { normaliseReason, rate4 } from './analytics-window';
import type { FinishOutcomesView, FirstPassPointView, ReasonView, ReviewerView } from './analytics.types';
import { ANALYTICS_LIMITS, CountRow, FirstPassCell, ReviewerRow, ReviewerSeverityRow } from './domain/analytics.domain';

/** D381: nax finish statuses -> the spec's five outcome buckets. A Map: untrusted strings never reach a prototype. */
const FINISH_BUCKETS = new Map<string, keyof FinishOutcomesView>([
  ['opened', 'opened'], ['promoted', 'promoted'], ['already-ready', 'promoted'], ['escalated', 'escalated'],
  ['skipped', 'skipped'], ['nothing-to-finish', 'skipped'],
]);

export function finishOutcomes(rows: readonly CountRow[]): FinishOutcomesView {
  return rows.reduce<FinishOutcomesView>((acc, r) => {
    const bucket = FINISH_BUCKETS.get(r.value) ?? 'other';
    return { ...acc, [bucket]: acc[bucket] + r.count };
  }, { opened: 0, promoted: 0, escalated: 0, skipped: 0, other: 0 });
}

/** Spec §4.2: reasons merged by their normalised first line; the top `limit` by count, then text. */
export function topReasons(rows: readonly CountRow[], limit: number = ANALYTICS_LIMITS.topReasons): ReasonView[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const reason = normaliseReason(r.value);
    if (reason !== '') counts.set(reason, (counts.get(reason) ?? 0) + r.count);
  }
  return [...counts]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || (a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0))
    .slice(0, limit);
}

export function reviewerViews(rows: readonly ReviewerRow[], severities: readonly ReviewerSeverityRow[]): ReviewerView[] {
  return rows.map((r) => ({
    reviewer: r.reviewer,
    runs: r.runs,
    passRate: rate4(r.passed, r.runs),
    findingsBySeverity: Object.fromEntries(severities.filter((s) => s.reviewer === r.reviewer).map((s) => [s.severity, s.count])),
  }));
}

/** D378, D380: one point per bucket; null where no story completed. */
export function firstPassSeries(cells: readonly FirstPassCell[], starts: readonly Date[]): FirstPassPointView[] {
  const byT = new Map(cells.map((c): [number, FirstPassCell] => [c.t.getTime(), c]));
  return starts.map((t) => {
    const c = byT.get(t.getTime());
    return { t: t.toISOString(), rate: c ? rate4(c.firstPass, c.stories) : null };
  });
}
```

`apps/api/src/fleet/analytics/analytics.service.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common';
import { NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { FleetActivityService } from '../activity/fleet-activity.service';
import { ESCALATED_FROM_AUDIT } from '../ingest/ingest-corrections';
import { FLEET_JOB_REPOSITORY, IFleetJobRepository } from '../jobs/domain/fleet-job.domain';
import { foldSeries } from './analytics-fold';
import { finishOutcomes, firstPassSeries, reviewerViews, topReasons } from './analytics-quality';
import { bucketStarts, invalidAnalytics, rate4, resolveWindow, usd4, usd4OrNull } from './analytics-window';
import type {
  CostSliceView, DeleteInput, DeletedView, JobAnalyticsView, JobsView, ListInput, QualityView, SpendInput, SpendView, StoriesInput,
  StoriesView, WindowInput, WindowView,
} from './analytics.types';
import { ANALYTICS_LIMITS, ANALYTICS_REPOSITORY, AnalyticsWindow, CostSliceRow, IAnalyticsRepository } from './domain/analytics.domain';

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
const windowView = (w: AnalyticsWindow): WindowView => ({ from: w.from.toISOString(), to: w.to.toISOString() });
const slice = (s: CostSliceRow): CostSliceView => ({ key: s.key, costUsd: usd4(s.costUsd), tokens: s.tokens });

/** Fleet S2b (d) §4: cost and quality analytics over the slice 1a tables. Money is rounded only here (A7). */
@Injectable()
export class AnalyticsService {
  constructor(
    @Inject(ANALYTICS_REPOSITORY) private readonly repo: IAnalyticsRepository,
    @Inject(FLEET_JOB_REPOSITORY) private readonly jobRepo: Pick<IFleetJobRepository, 'findById'>,
    private readonly activity: FleetActivityService,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
  ) {}

  /** Spec §4.2 spend; `projectId: null` is the admin route across projects. */
  async spend(projectId: string | null, q: SpendInput, now: Date): Promise<SpendView> {
    const w = resolveWindow(q, now);
    const groupBy = q.groupBy ?? 'model';
    const scope = { projectId };
    const [cells, totals] = await Promise.all([this.repo.spendCells(scope, w, groupBy), this.repo.spendTotals(scope, w.from, w.to)]);
    const labels = await this.repo.labels(groupBy, [...new Set(cells.map((c) => c.key))]);
    return {
      window: windowView(w),
      bucket: w.bucket,
      groupBy,
      totals: {
        costUsd: usd4(totals.costUsd),
        tokens: totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheWriteTokens,
        cacheShare: rate4(totals.cacheReadTokens, totals.inputTokens + totals.cacheReadTokens),
        jobs: totals.jobs,
      },
      series: foldSeries(cells, bucketStarts(w), labels),
    };
  }

  async quality(projectId: string, q: WindowInput, now: Date): Promise<QualityView> {
    const w = resolveWindow(q, now);
    const [stats, cells, reviewers, severities, finishes, reasons] = await Promise.all([
      this.repo.storyStats(projectId, w.from, w.to),
      this.repo.firstPassCells(projectId, w),
      this.repo.reviewers(projectId, w.from, w.to),
      this.repo.reviewerSeverities(projectId, w.from, w.to),
      this.repo.finishResults(projectId, w.from, w.to),
      this.repo.escalationReasons(projectId, w.from, w.to),
    ]);
    return {
      window: windowView(w),
      bucket: w.bucket,
      stories: stats.stories,
      firstPassRate: rate4(stats.firstPass, stats.stories),
      avgAttempts: rate4(stats.attempts, stats.stories),
      reviewByReviewer: reviewerViews(reviewers, severities),
      finishOutcomes: finishOutcomes(finishes),
      topEscalationReasons: topReasons(reasons),
      firstPassSeries: firstPassSeries(cells, bucketStarts(w)),
    };
  }

  async stories(projectId: string, q: StoriesInput, now: Date): Promise<StoriesView> {
    const w = resolveWindow({ from: q.from, to: q.to }, now);
    const rows = await this.repo.topStories(projectId, w.from, w.to, q.sort ?? 'cost', q.limit ?? ANALYTICS_LIMITS.listDefault);
    return { window: windowView(w), rows: rows.map((r) => ({ ...r, costUsd: usd4(r.costUsd), completedAt: iso(r.completedAt) })) };
  }

  /** D382: cost = spent + carried; drift = ledger - cost. */
  async jobs(projectId: string, q: ListInput, now: Date): Promise<JobsView> {
    const w = resolveWindow({ from: q.from, to: q.to }, now);
    const rows = await this.repo.topJobs(projectId, w.from, w.to, q.limit ?? ANALYTICS_LIMITS.listDefault);
    return {
      window: windowView(w),
      rows: rows.map((r) => ({
        jobId: r.jobId, command: r.command, featureName: r.featureName, state: r.state,
        costUsd: usd4(r.costUsd), ledgerCostUsd: usd4OrNull(r.ledgerCostUsd),
        driftUsd: r.ledgerCostUsd === null ? null : usd4(r.ledgerCostUsd.sub(r.costUsd)),
        finishedAt: iso(r.finishedAt),
      })),
    };
  }

  /** Spec §4.2 job breakdown, D383. */
  async job(projectId: string, jobId: string): Promise<JobAnalyticsView> {
    const job = await this.jobRepo.findById(jobId);
    if (!job || job.projectId !== projectId) throw new NotFoundAppException({}, 'fleet.jobs');
    const max = ANALYTICS_LIMITS.jobDetailRows;
    const [ingest, byStage, byRole, byModel, stories, reviews] = await Promise.all([
      this.repo.latestIngest(job.id),
      this.repo.jobSlices(job.id, 'stage'),
      this.repo.jobSlices(job.id, 'role'),
      this.repo.jobSlices(job.id, 'model'),
      this.repo.jobStories(job.id, max),
      this.repo.jobReviews(job.id, max),
    ]);
    return {
      jobId: job.id,
      ingest: ingest
        ? { leaseEpoch: ingest.leaseEpoch, status: ingest.status, files: ingest.files, ingestedAt: iso(ingest.ingestedAt), error: ingest.error }
        : null,
      byStage: byStage.map(slice),
      byRole: byRole.map(slice),
      byModel: byModel.map(slice),
      stories: stories.map((s) => ({ ...s, costUsd: usd4(s.costUsd), completedAt: iso(s.completedAt) })),
      reviews: reviews.map((r) => ({ ...r, at: r.at.toISOString() })),
      liveCostUsd: ingest ? usd4OrNull(ingest.liveCostUsd) : null,
      ledgerCostUsd: ingest ? usd4OrNull(ingest.ledgerCostUsd) : null,
      corrected: job.stateReason === ESCALATED_FROM_AUDIT,
    };
  }

  /** Spec §4.3, D384: delete-on-demand (global admin). */
  async deleteRows(actorId: string, q: DeleteInput, now: Date): Promise<DeletedView> {
    const before = new Date(q.before);
    if (Number.isNaN(before.getTime())) throw invalidAnalytics('before must be an ISO 8601 instant');
    const projectId = q.projectId ?? null;
    const expected = projectId === null ? 'ALL' : await this.repo.findProjectSlug(projectId);
    if (expected === null) throw new NotFoundAppException({}, 'projects');
    if (q.confirm !== expected) throw new ValidationAppException({ expected }, 'fleet.analyticsDelete');
    const counts = await this.txManager.run(async () => {
      const deleted = await this.repo.deleteRows({ projectId, before, now });
      await this.activity.record({
        actorType: 'USER', actorId, action: 'analytics.deleted', entityType: 'analytics', entityId: projectId ?? 'all', projectId,
        responsibleUserId: actorId, payload: { before: before.toISOString(), ...deleted },
      });
      return deleted;
    });
    return { projectId, before: before.toISOString(), ...counts };
  }
}
```

In `apps/api/src/fleet/activity/domain/fleet-activity.domain.ts`, replace:

```ts
export type FleetEntityType = 'runner' | 'enrollment' | 'repo' | 'job' | 'budget' | 'schedule' | 'approval' | 'ingest';
```

with:

```ts
export type FleetEntityType = 'runner' | 'enrollment' | 'repo' | 'job' | 'budget' | 'schedule' | 'approval' | 'ingest' | 'analytics';
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && bun run test:scoped src/fleet/analytics`
Expected: PASS (window, fold, quality and service suites).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/fleet/analytics apps/api/src/fleet/activity/domain/fleet-activity.domain.ts
git commit -m "feat(fleet): S2b analytics service and quality mapping (D380-D384)"
```

---

### Task 5: Project analytics routes

**Files:**
- Create: `apps/api/src/fleet/analytics/dto/analytics-query.dto.ts`, `apps/api/src/fleet/analytics/dto/analytics-response.dto.ts`
- Create: `apps/api/src/fleet/analytics/project-fleet-analytics.controller.ts`, `apps/api/src/fleet/analytics/analytics.module.ts`
- Modify: `apps/api/src/fleet/fleet.module.ts`, `apps/api/src/fleet/fleet.module.spec.ts`
- Test: `apps/api/test/integration/fleet/fleet-analytics-api.integration.spec.ts`

**Interfaces:**
- Consumes: `AnalyticsService` (Task 4); `PrismaAnalyticsRepository`, `ANALYTICS_REPOSITORY` (Tasks 2-3); every view
  type (Task 1); `ProjectMembershipGuard`, `CurrentProject`, `ProjectContext`, `ProjectAccessModule`;
  `isUserPrincipal`; `parseQuery`; fixtures (Task 2); `seedFleetHttpWorld`, `seedFleetHttpAgent`.
- Produces: `GET /projects/:slug/fleet/analytics/spend|quality|stories|jobs`, `GET /projects/:slug/fleet/jobs/:id/analytics`;
  controller `ProjectFleetAnalyticsController` (methods `spend`, `quality`, `stories`, `jobs`, `job`); query DTOs
  `AnalyticsRangeQuery`, `AnalyticsBucketQuery`, `SpendQuery`, `AdminSpendQuery`, `StoriesQuery`, `JobsQuery`,
  `DeleteAnalyticsQuery`, `DeleteAnalyticsBody`; response DTOs `SpendAnalyticsDto`, `QualityAnalyticsDto`,
  `StoriesAnalyticsDto`, `JobsAnalyticsDto`, `JobAnalyticsDto`, `AnalyticsDeletedDto` (+ their nested DTOs);
  `AnalyticsModule`.

- [ ] **Step 1: Write the failing API test**

`apps/api/test/integration/fleet/fleet-analytics-api.integration.spec.ts`:

```ts
/**
 * Fleet S2b slice 1b — project analytics routes (PG), spec §4.1-4.2.
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-analytics-api.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { FleetHttpWorld, seedFleetHttpAgent, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import {
  insertAnalyticsJob, insertCostEvent, insertIngestRow, insertReviewResult, insertStoryResult,
} from '../../helpers/fleet-analytics-fixtures';
import { ESCALATED_FROM_AUDIT } from '../../../src/fleet/ingest/ingest-corrections';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

const BASE = '/api/projects/web/fleet';
const WINDOW = 'from=2026-09-28T00:00:00Z&to=2026-10-05T00:00:00Z';

describeIntegration('fleet analytics project API (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let agentKey: string;
  let jobId: string;
  let foreignJobId: string;
  const auth = (who: keyof FleetHttpWorld['tokens']) => ({ Authorization: `Bearer ${world.tokens[who]}` });
  const get = (path: string, who: keyof FleetHttpWorld['tokens'] = 'viewer') => request(server).get(`${BASE}/${path}`).set(auth(who));

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(server, prisma);
    agentKey = (await seedFleetHttpAgent(server, world.tokens.root)).apiKey;
    jobId = await insertAnalyticsJob(prisma, { projectId: world.projectId, repoId: world.repoId, requestedById: world.ids.dev }, {
      state: 'ESCALATED', stateReason: ESCALATED_FROM_AUDIT, costSpentUsd: '0.5', finishResult: 'escalated',
      escalationReason: 'review omitted WALK', finishedAt: new Date('2026-10-02T12:00:00Z'),
    });
    const row = { jobId, projectId: world.projectId, repoId: world.repoId };
    await insertCostEvent(prisma, row, { at: new Date('2026-10-01T10:00:00Z'), model: 'm1', costUsd: '0.00004' });
    await insertCostEvent(prisma, row, { at: new Date('2026-10-01T11:00:00Z'), model: 'm1', costUsd: '0.00004' });
    await insertCostEvent(prisma, row, { at: new Date('2026-10-02T10:00:00Z'), model: 'm2', stage: 'review', costUsd: '0.00004' });
    await insertStoryResult(prisma, row, { storyId: 'US-001', attempts: 2, firstPassSuccess: false, costUsd: '0.3', completedAt: new Date('2026-10-01T12:00:00Z') });
    await insertReviewResult(prisma, row, { reviewer: 'semantic', passed: false, findingsBySeverity: { error: 1 }, at: new Date('2026-10-01T12:30:00Z') });
    await insertIngestRow(prisma, jobId, 1, { status: 'done', liveCostUsd: '0.4', ledgerCostUsd: '0.5' });
    foreignJobId = await insertAnalyticsJob(prisma, { projectId: world.opsProjectId, repoId: world.foreignRepoId, requestedById: world.ids.root });
  });
  afterAll(async () => {
    await app.close();
  });

  it('lets any member read spend, money in four places summed before rounding', async () => {
    const s = data<{ bucket: string; totals: unknown; series: Array<{ key: string; costUsd: string; points: unknown[] }> }>(
      await get(`analytics/spend?${WINDOW}`).expect(200),
    );
    expect(s.bucket).toBe('day');
    expect(s.totals).toEqual({ costUsd: '0.0001', tokens: 330, cacheShare: 0, jobs: 1 });
    expect(s.series.map((x) => [x.key, x.costUsd])).toEqual([['m1', '0.0001'], ['m2', '0.0000']]);
    expect(s.series[0].points).toHaveLength(7);
  });

  it('refuses outsiders and agent keys', async () => {
    await get(`analytics/spend?${WINDOW}`, 'outsider').expect(403);
    await request(server).get(`${BASE}/analytics/spend`).set({ Authorization: `Bearer ${agentKey}` }).expect(403);
    await request(server).get(`${BASE}/jobs/${jobId}/analytics`).set({ Authorization: `Bearer ${agentKey}` }).expect(403);
  });

  it('validates the window, the enums and the limit', async () => {
    await get('analytics/spend?groupBy=project').expect(400);
    await get('analytics/spend?groupBy=bogus').expect(400);
    await get('analytics/spend?bucket=hour').expect(400);
    await get('analytics/spend?from=yesterday').expect(400);
    await get('analytics/spend?from=2026-10-01T00:00:00').expect(400); // no Z: would parse in the server's zone
    await get('analytics/spend?from=2026-10-05T00:00:00Z&to=2026-10-01T00:00:00Z').expect(400);
    await get('analytics/spend?from=2025-01-01T00:00:00Z&to=2026-01-03T00:00:00Z').expect(400);
    await get('analytics/stories?limit=51').expect(400);
    await get('analytics/stories?sort=duration').expect(400);
    await get('analytics/jobs?sort=attempts').expect(400);
  });

  it('answers an empty window with zeros, not an error', async () => {
    const s = data<{ totals: unknown; series: unknown[] }>(await get('analytics/spend?from=2020-01-01T00:00:00Z&to=2020-01-02T00:00:00Z').expect(200));
    expect(s).toMatchObject({ totals: { costUsd: '0.0000', tokens: 0, cacheShare: null, jobs: 0 }, series: [] });
    const q = data<{ firstPassRate: unknown; firstPassSeries: unknown[] }>(await get('analytics/quality?from=2020-01-01T00:00:00Z&to=2020-01-02T00:00:00Z').expect(200));
    expect(q).toMatchObject({ firstPassRate: null, firstPassSeries: [{ t: '2020-01-01T00:00:00.000Z', rate: null }] });
  });

  it('reports quality, the most expensive stories and the most expensive jobs', async () => {
    expect(data(await get(`analytics/quality?${WINDOW}`).expect(200))).toMatchObject({
      stories: 1, firstPassRate: 0, avgAttempts: 2,
      reviewByReviewer: [{ reviewer: 'semantic', runs: 1, passRate: 0, findingsBySeverity: { error: 1 } }],
      finishOutcomes: { opened: 0, promoted: 0, escalated: 1, skipped: 0, other: 0 },
      topEscalationReasons: [{ reason: 'review omitted WALK', count: 1 }],
    });
    expect(data<{ rows: unknown[] }>(await get(`analytics/stories?${WINDOW}&sort=attempts&limit=5`).expect(200)).rows).toEqual([
      expect.objectContaining({ jobId, storyId: 'US-001', attempts: 2, firstPassSuccess: false, costUsd: '0.3000' }),
    ]);
    expect(data<{ rows: unknown[] }>(await get(`analytics/jobs?${WINDOW}`).expect(200)).rows).toEqual([
      expect.objectContaining({ jobId, command: 'RUN', state: 'ESCALATED', costUsd: '0.5000', ledgerCostUsd: '0.5000', driftUsd: '0.0000' }),
    ]);
  });

  it('breaks one job down and shows its ingest and correction; 404 outside the project', async () => {
    expect(data(await get(`jobs/${jobId}/analytics`).expect(200))).toMatchObject({
      jobId, corrected: true, liveCostUsd: '0.4000', ledgerCostUsd: '0.5000',
      ingest: { leaseEpoch: 1, status: 'done', files: { cost: 'done:v8' }, error: null },
      byModel: [{ key: 'm1', costUsd: '0.0001', tokens: 220 }, { key: 'm2', costUsd: '0.0000', tokens: 110 }],
      byStage: [{ key: 'run', costUsd: '0.0001', tokens: 220 }, { key: 'review', costUsd: '0.0000', tokens: 110 }],
      stories: [expect.objectContaining({ storyId: 'US-001', leaseEpoch: 1 })],
      reviews: [expect.objectContaining({ reviewer: 'semantic', passed: false })],
    });
    await get(`jobs/${foreignJobId}/analytics`).expect(404);
    await get('jobs/nope/analytics').expect(404);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && bun run test:scoped test/integration/fleet/fleet-analytics-api.integration.spec.ts`
Expected: FAIL — 404 on `/api/projects/web/fleet/analytics/spend`.

- [ ] **Step 3: Write the DTOs**

`apps/api/src/fleet/analytics/dto/analytics-query.dto.ts`:

```ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsISO8601, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import {
  ADMIN_GROUPS, ANALYTICS_LIMITS, Bucket, BUCKETS, GroupBy, JOB_SORTS, JobSort, PROJECT_GROUPS, ProjectGroupBy, STORY_SORTS, StorySort,
} from '../domain/analytics.domain';

/**
 * A date (UTC midnight) or an instant ending in Z. An offset-less datetime would parse in the server's local zone,
 * and `+hh:mm` loses its `+` in a query string, so only these two forms are accepted.
 */
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}(T[0-9:.]+Z)?$/;
const UTC_MESSAGE = { message: 'use a date (YYYY-MM-DD) or a UTC instant ending in Z' };

/** Spec §4.1. Pass through `parseQuery` (the global pipe validates but does not transform). */
export class AnalyticsRangeQuery {
  @ApiPropertyOptional({ format: 'date-time', description: 'Window start, inclusive (UTC date or instant ending in Z); default `to` minus 30 days' })
  @IsOptional() @IsISO8601({ strict: true }) @Matches(UTC_INSTANT, UTC_MESSAGE) from?: string;

  @ApiPropertyOptional({ format: 'date-time', description: 'Window end, exclusive (UTC date or instant ending in Z); default now. At most 366 days after `from`' })
  @IsOptional() @IsISO8601({ strict: true }) @Matches(UTC_INSTANT, UTC_MESSAGE) to?: string;
}

export class AnalyticsBucketQuery extends AnalyticsRangeQuery {
  @ApiPropertyOptional({ enum: BUCKETS, description: 'Default from the window: <= 31 days day, <= 182 days week, else month' })
  @IsOptional() @IsIn([...BUCKETS]) bucket?: Bucket;
}

export class SpendQuery extends AnalyticsBucketQuery {
  @ApiPropertyOptional({ enum: PROJECT_GROUPS, default: 'model' })
  @IsOptional() @IsIn([...PROJECT_GROUPS]) groupBy?: ProjectGroupBy;
}

export class AdminSpendQuery extends AnalyticsBucketQuery {
  @ApiPropertyOptional({ enum: ADMIN_GROUPS, default: 'model' })
  @IsOptional() @IsIn([...ADMIN_GROUPS]) groupBy?: GroupBy;
}

export class StoriesQuery extends AnalyticsRangeQuery {
  @ApiPropertyOptional({ enum: STORY_SORTS, default: 'cost' })
  @IsOptional() @IsIn([...STORY_SORTS]) sort?: StorySort;

  @ApiPropertyOptional({ minimum: 1, maximum: ANALYTICS_LIMITS.listMax, default: ANALYTICS_LIMITS.listDefault })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(ANALYTICS_LIMITS.listMax) limit?: number;
}

export class JobsQuery extends AnalyticsRangeQuery {
  @ApiPropertyOptional({ enum: JOB_SORTS, default: 'cost' })
  @IsOptional() @IsIn([...JOB_SORTS]) sort?: JobSort;

  @ApiPropertyOptional({ minimum: 1, maximum: ANALYTICS_LIMITS.listMax, default: ANALYTICS_LIMITS.listDefault })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(ANALYTICS_LIMITS.listMax) limit?: number;
}

/** Spec §4.3, D384. */
export class DeleteAnalyticsQuery {
  @ApiProperty({ format: 'date-time', description: 'Delete rows dated before this instant (UTC date or instant ending in Z)' })
  @IsISO8601({ strict: true }) @Matches(UTC_INSTANT, UTC_MESSAGE) before: string;

  @ApiPropertyOptional({ description: 'Only this project; omit for every project' })
  @IsOptional() @IsString() @MaxLength(64) projectId?: string;
}

export class DeleteAnalyticsBody {
  @ApiProperty({ description: "The project's slug, or ALL when no projectId is given" })
  @IsString() @MaxLength(200) confirm: string;
}
```

`apps/api/src/fleet/analytics/dto/analytics-response.dto.ts`:

```ts
import { ApiProperty } from '@nestjs/swagger';
import type {
  CostSliceView, DeletedView, FinishOutcomesView, FirstPassPointView, JobAnalyticsView, JobIngestView, JobReviewView, JobRowView, JobsView,
  JobStoryView, QualityView, ReasonView, ReviewerView, SpendPointView, SpendSeriesView, SpendTotalsView, SpendView, StoriesView,
  StoryRowView, WindowView,
} from '../analytics.types';
import { ADMIN_GROUPS, Bucket, BUCKETS, GroupBy } from '../domain/analytics.domain';

const USD = { example: '0.1234', description: 'USD, exactly 4 places (A7)' };
const COUNTS = { type: 'object', additionalProperties: { type: 'integer' } } as const;

export class AnalyticsWindowDto implements WindowView {
  @ApiProperty({ format: 'date-time' }) from: string;
  @ApiProperty({ format: 'date-time' }) to: string;
}

export class SpendPointDto implements SpendPointView {
  @ApiProperty({ format: 'date-time', description: 'Bucket start (UTC)' }) t: string;
  @ApiProperty(USD) costUsd: string;
  @ApiProperty() tokens: number;
}

export class SpendSeriesDto implements SpendSeriesView {
  @ApiProperty({ description: 'Group key; `(none)` for an empty dimension; `other` when folded' }) key: string;
  @ApiProperty({ description: 'repo owner/name, runner name, project slug, else the key' }) label: string;
  @ApiProperty({ description: 'True only for the series that folds every key beyond the top 12' }) folded: boolean;
  @ApiProperty(USD) costUsd: string;
  @ApiProperty() tokens: number;
  @ApiProperty({ type: [SpendPointDto] }) points: SpendPointDto[];
}

export class SpendTotalsDto implements SpendTotalsView {
  @ApiProperty(USD) costUsd: string;
  @ApiProperty() tokens: number;
  @ApiProperty({ type: Number, nullable: true, description: 'cacheRead / (input + cacheRead), 4 places' }) cacheShare: number | null;
  @ApiProperty() jobs: number;
}

export class SpendAnalyticsDto implements SpendView {
  @ApiProperty({ type: AnalyticsWindowDto }) window: AnalyticsWindowDto;
  @ApiProperty({ enum: BUCKETS }) bucket: Bucket;
  @ApiProperty({ enum: ADMIN_GROUPS }) groupBy: GroupBy;
  @ApiProperty({ type: SpendTotalsDto }) totals: SpendTotalsDto;
  @ApiProperty({ type: [SpendSeriesDto] }) series: SpendSeriesDto[];
}

export class ReviewerQualityDto implements ReviewerView {
  @ApiProperty() reviewer: string;
  @ApiProperty() runs: number;
  @ApiProperty({ type: Number, nullable: true }) passRate: number | null;
  @ApiProperty(COUNTS) findingsBySeverity: Record<string, number>;
}

export class FinishOutcomesDto implements FinishOutcomesView {
  @ApiProperty() opened: number;
  @ApiProperty() promoted: number;
  @ApiProperty() escalated: number;
  @ApiProperty() skipped: number;
  @ApiProperty() other: number;
}

export class EscalationReasonDto implements ReasonView {
  @ApiProperty() reason: string;
  @ApiProperty() count: number;
}

export class FirstPassPointDto implements FirstPassPointView {
  @ApiProperty({ format: 'date-time' }) t: string;
  @ApiProperty({ type: Number, nullable: true }) rate: number | null;
}

export class QualityAnalyticsDto implements QualityView {
  @ApiProperty({ type: AnalyticsWindowDto }) window: AnalyticsWindowDto;
  @ApiProperty({ enum: BUCKETS }) bucket: Bucket;
  @ApiProperty() stories: number;
  @ApiProperty({ type: Number, nullable: true }) firstPassRate: number | null;
  @ApiProperty({ type: Number, nullable: true }) avgAttempts: number | null;
  @ApiProperty({ type: [ReviewerQualityDto] }) reviewByReviewer: ReviewerQualityDto[];
  @ApiProperty({ type: FinishOutcomesDto }) finishOutcomes: FinishOutcomesDto;
  @ApiProperty({ type: [EscalationReasonDto] }) topEscalationReasons: EscalationReasonDto[];
  @ApiProperty({ type: [FirstPassPointDto] }) firstPassSeries: FirstPassPointDto[];
}

export class StoryAnalyticsRowDto implements StoryRowView {
  @ApiProperty() jobId: string;
  @ApiProperty() leaseEpoch: number;
  @ApiProperty() featureName: string;
  @ApiProperty() storyId: string;
  @ApiProperty() attempts: number;
  @ApiProperty() firstPassSuccess: boolean;
  @ApiProperty() success: boolean;
  @ApiProperty(USD) costUsd: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) completedAt: string | null;
}

export class StoriesAnalyticsDto implements StoriesView {
  @ApiProperty({ type: AnalyticsWindowDto }) window: AnalyticsWindowDto;
  @ApiProperty({ type: [StoryAnalyticsRowDto] }) rows: StoryAnalyticsRowDto[];
}

export class JobAnalyticsRowDto implements JobRowView {
  @ApiProperty() jobId: string;
  @ApiProperty() command: string;
  @ApiProperty() featureName: string;
  @ApiProperty() state: string;
  @ApiProperty({ ...USD, description: 'costSpentUsd + costCarriedUsd' }) costUsd: string;
  @ApiProperty({ type: String, nullable: true, description: 'Sum of ingested cost ledgers; null before ingest' }) ledgerCostUsd: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'ledger - cost' }) driftUsd: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) finishedAt: string | null;
}

export class JobsAnalyticsDto implements JobsView {
  @ApiProperty({ type: AnalyticsWindowDto }) window: AnalyticsWindowDto;
  @ApiProperty({ type: [JobAnalyticsRowDto] }) rows: JobAnalyticsRowDto[];
}

export class CostSliceDto implements CostSliceView {
  @ApiProperty() key: string;
  @ApiProperty(USD) costUsd: string;
  @ApiProperty() tokens: number;
}

export class JobIngestSummaryDto implements JobIngestView {
  @ApiProperty() leaseEpoch: number;
  @ApiProperty({ enum: ['pending', 'running', 'done', 'partial', 'failed'] }) status: string;
  @ApiProperty({ type: 'object', additionalProperties: { type: 'string' } }) files: Record<string, string>;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) ingestedAt: string | null;
  @ApiProperty({ type: String, nullable: true }) error: string | null;
}

export class JobStoryResultDto implements JobStoryView {
  @ApiProperty() leaseEpoch: number;
  @ApiProperty() featureName: string;
  @ApiProperty() storyId: string;
  @ApiProperty() attempts: number;
  @ApiProperty() firstPassSuccess: boolean;
  @ApiProperty() success: boolean;
  @ApiProperty(USD) costUsd: string;
  @ApiProperty({ type: Number, nullable: true }) durationMs: number | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) completedAt: string | null;
}

export class JobReviewResultDto implements JobReviewView {
  @ApiProperty() leaseEpoch: number;
  @ApiProperty({ type: String, nullable: true }) storyId: string | null;
  @ApiProperty() reviewer: string;
  @ApiProperty() passed: boolean;
  @ApiProperty() failOpen: boolean;
  @ApiProperty() findingCount: number;
  @ApiProperty(COUNTS) findingsBySeverity: Record<string, number>;
  @ApiProperty() advisoryCount: number;
  @ApiProperty({ format: 'date-time' }) at: string;
}

export class JobAnalyticsDto implements JobAnalyticsView {
  @ApiProperty() jobId: string;
  @ApiProperty({ type: JobIngestSummaryDto, nullable: true, description: 'The latest attempt with an ingest row' }) ingest: JobIngestSummaryDto | null;
  @ApiProperty({ type: [CostSliceDto] }) byStage: CostSliceDto[];
  @ApiProperty({ type: [CostSliceDto] }) byRole: CostSliceDto[];
  @ApiProperty({ type: [CostSliceDto] }) byModel: CostSliceDto[];
  @ApiProperty({ type: [JobStoryResultDto] }) stories: JobStoryResultDto[];
  @ApiProperty({ type: [JobReviewResultDto] }) reviews: JobReviewResultDto[];
  @ApiProperty({ type: String, nullable: true }) liveCostUsd: string | null;
  @ApiProperty({ type: String, nullable: true }) ledgerCostUsd: string | null;
  @ApiProperty({ description: 'The state was corrected from finish-audit (spec §3.2)' }) corrected: boolean;
}

export class AnalyticsDeletedDto implements DeletedView {
  @ApiProperty({ type: String, nullable: true }) projectId: string | null;
  @ApiProperty({ format: 'date-time' }) before: string;
  @ApiProperty() costEvents: number;
  @ApiProperty() stories: number;
  @ApiProperty() reviews: number;
  @ApiProperty() ingestRowsMarked: number;
}
```

- [ ] **Step 4: Write the controller and the module**

`apps/api/src/fleet/analytics/project-fleet-analytics.controller.ts`:

```ts
import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '@nathapp/nestjs-auth';
import { ForbiddenAppException, JsonResponse } from '@nathapp/nestjs-common';
import { parseQuery } from '../../common/dto/koda-page.query';
import { isUserPrincipal, KodaPrincipal } from '../../auth/principal/koda-principal.types';
import { CurrentProject } from '../../projects/current-project.decorator';
import type { ProjectContext } from '../../projects/project-context';
import { ProjectMembershipGuard } from '../../projects/project-membership.guard';
import { AnalyticsService } from './analytics.service';
import { AnalyticsBucketQuery, JobsQuery, SpendQuery, StoriesQuery } from './dto/analytics-query.dto';
import { JobAnalyticsDto, JobsAnalyticsDto, QualityAnalyticsDto, SpendAnalyticsDto, StoriesAnalyticsDto } from './dto/analytics-response.dto';

/** Analytics are for people; agent keys get 403, like the jobs and logs controllers. */
function assertUser(principal: KodaPrincipal): void {
  if (!isUserPrincipal(principal)) throw new ForbiddenAppException({}, 'projects');
}

/** Fleet S2b (d) §4.2: any project member. */
@ApiTags('fleet')
@ApiBearerAuth()
@ApiParam({ name: 'slug', required: true, schema: { type: 'string' } })
@Controller('projects/:slug/fleet')
@UseGuards(ProjectMembershipGuard)
export class ProjectFleetAnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('analytics/spend')
  @ApiOperation({ summary: 'Fleet spend over a window, bucketed and grouped (project member, S2b §4.2)' })
  @ApiResponse({ status: 200, type: SpendAnalyticsDto })
  @ApiResponse({ status: 400, description: 'Invalid window, bucket or groupBy' })
  async spend(@Query() raw: SpendQuery, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    assertUser(principal);
    return JsonResponse.Ok(await this.analytics.spend(ctx.project.id, parseQuery(SpendQuery, raw), new Date()));
  }

  @Get('analytics/quality')
  @ApiOperation({ summary: 'Run quality over a window: first pass, attempts, reviews, finish outcomes (project member)' })
  @ApiResponse({ status: 200, type: QualityAnalyticsDto })
  @ApiResponse({ status: 400, description: 'Invalid window or bucket' })
  async quality(@Query() raw: AnalyticsBucketQuery, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    assertUser(principal);
    return JsonResponse.Ok(await this.analytics.quality(ctx.project.id, parseQuery(AnalyticsBucketQuery, raw), new Date()));
  }

  @Get('analytics/stories')
  @ApiOperation({ summary: 'The most expensive or most looping stories in a window (project member)' })
  @ApiResponse({ status: 200, type: StoriesAnalyticsDto })
  @ApiResponse({ status: 400, description: 'Invalid window, sort or limit' })
  async stories(@Query() raw: StoriesQuery, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    assertUser(principal);
    return JsonResponse.Ok(await this.analytics.stories(ctx.project.id, parseQuery(StoriesQuery, raw), new Date()));
  }

  @Get('analytics/jobs')
  @ApiOperation({ summary: 'The most expensive jobs finished in a window, with ledger drift (project member)' })
  @ApiResponse({ status: 200, type: JobsAnalyticsDto })
  @ApiResponse({ status: 400, description: 'Invalid window, sort or limit' })
  async jobs(@Query() raw: JobsQuery, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    assertUser(principal);
    return JsonResponse.Ok(await this.analytics.jobs(ctx.project.id, parseQuery(JobsQuery, raw), new Date()));
  }

  @Get('jobs/:id/analytics')
  @ApiOperation({ summary: "One job's cost and quality breakdown across its attempts (project member)" })
  @ApiResponse({ status: 200, type: JobAnalyticsDto })
  @ApiResponse({ status: 404, description: 'No such job in this project' })
  async job(@Param('id') id: string, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    assertUser(principal);
    return JsonResponse.Ok(await this.analytics.job(ctx.project.id, id));
  }
}
```

`apps/api/src/fleet/analytics/analytics.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { ProjectAccessModule } from '../../projects/project-access.module';
import { FleetActivityModule } from '../activity/fleet-activity.module';
import { FleetJobsModule } from '../jobs/fleet-jobs.module';
import { AnalyticsService } from './analytics.service';
import { ANALYTICS_REPOSITORY } from './domain/analytics.domain';
import { PrismaAnalyticsRepository } from './prisma-analytics.repository';
import { ProjectFleetAnalyticsController } from './project-fleet-analytics.controller';

/** Fleet S2b (d) §4 read side (D376); spec docs/superpowers/specs/2026-10-04-fleet-s2b-d-analytics-design.md. */
@Module({
  imports: [PrismaModule, ProjectAccessModule, FleetJobsModule, FleetActivityModule],
  controllers: [ProjectFleetAnalyticsController],
  providers: [
    PrismaAnalyticsRepository, { provide: ANALYTICS_REPOSITORY, useExisting: PrismaAnalyticsRepository },
    AnalyticsService,
  ],
})
export class AnalyticsModule {}
```

In `apps/api/src/fleet/fleet.module.ts`, add `import { AnalyticsModule } from './analytics/analytics.module';` and
append `AnalyticsModule` to the `imports` array after `IngestModule`.

In `apps/api/src/fleet/fleet.module.spec.ts`, add `import { AnalyticsService } from './analytics/analytics.service';`
and, inside `it('compiles with its providers resolvable', ...)`, the line
`expect(module.get(AnalyticsService)).toBeDefined();`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/api && bun run test:scoped src/fleet/fleet.module.spec.ts test/integration/fleet/fleet-analytics-api.integration.spec.ts`
Expected: PASS. A `400` where the test expects `200` usually means `parseQuery` stripped a field: check the DTO field
names against the query parameter names.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/fleet/analytics apps/api/src/fleet/fleet.module.ts apps/api/src/fleet/fleet.module.spec.ts apps/api/test/integration/fleet/fleet-analytics-api.integration.spec.ts
git commit -m "feat(fleet): S2b project analytics routes (spec §4.2, D376-D383)"
```

---

### Task 6: Admin analytics routes

**Files:**
- Create: `apps/api/src/fleet/analytics/fleet-analytics.controller.ts`
- Modify: `apps/api/src/fleet/analytics/analytics.module.ts`
- Test: `apps/api/test/integration/fleet/fleet-analytics-admin-api.integration.spec.ts`

**Interfaces:**
- Consumes: `AnalyticsService.spend(null, ...)`, `AnalyticsService.deleteRows` (Task 4); `AdminSpendQuery`,
  `DeleteAnalyticsQuery`, `DeleteAnalyticsBody`, `SpendAnalyticsDto`, `AnalyticsDeletedDto` (Task 5);
  `RequiredPermission`, `Principal`.
- Produces: `GET /fleet/analytics/spend` and `DELETE /fleet/analytics?projectId&before` (body `{confirm}`), both
  `@RequiredPermission('ADMIN')`; controller `FleetAnalyticsController` (methods `spend`, `remove`).

- [ ] **Step 1: Write the failing API test**

`apps/api/test/integration/fleet/fleet-analytics-admin-api.integration.spec.ts`:

```ts
/**
 * Fleet S2b slice 1b — admin analytics routes (PG), spec §4.3, D370, D384.
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-analytics-admin-api.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { FleetHttpWorld, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { insertAnalyticsJob, insertCostEvent, insertIngestRow } from '../../helpers/fleet-analytics-fixtures';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('fleet analytics admin API (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let webJob: string;
  const auth = (who: keyof FleetHttpWorld['tokens']) => ({ Authorization: `Bearer ${world.tokens[who]}` });
  const del = (query: string, confirm: unknown, who: keyof FleetHttpWorld['tokens'] = 'root') =>
    request(server).delete(`/api/fleet/analytics${query}`).set(auth(who)).send(confirm === undefined ? {} : { confirm });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(server, prisma);
    webJob = await insertAnalyticsJob(prisma, { projectId: world.projectId, repoId: world.repoId, requestedById: world.ids.dev });
    const opsJob = await insertAnalyticsJob(prisma, { projectId: world.opsProjectId, repoId: world.foreignRepoId, requestedById: world.ids.root });
    const web = { jobId: webJob, projectId: world.projectId, repoId: world.repoId };
    await insertCostEvent(prisma, web, { at: new Date('2026-10-01T00:00:00Z'), costUsd: '1.5' });
    await insertCostEvent(prisma, web, { at: new Date('2026-10-10T00:00:00Z'), costUsd: '0.5' });
    await insertCostEvent(prisma, { jobId: opsJob, projectId: world.opsProjectId, repoId: world.foreignRepoId }, { at: new Date('2026-10-01T00:00:00Z'), costUsd: '2.25' });
    await insertIngestRow(prisma, webJob, 1);
    await insertIngestRow(prisma, opsJob, 1);
  });
  afterAll(async () => {
    await app.close();
  });

  it('refuses non-admins', async () => {
    await request(server).get('/api/fleet/analytics/spend').set(auth('dev')).expect(403);
    await del('?before=2026-10-05T00:00:00Z', 'ALL', 'dev').expect(403);
  });

  it('groups spend across projects, labelled by slug', async () => {
    const s = data<{ totals: { costUsd: string; jobs: number }; series: Array<{ key: string; label: string; costUsd: string }> }>(
      await request(server).get('/api/fleet/analytics/spend?from=2026-09-28T00:00:00Z&to=2026-10-12T00:00:00Z&groupBy=project').set(auth('root')).expect(200),
    );
    expect(s.totals).toMatchObject({ costUsd: '4.2500', jobs: 2 });
    expect(s.series.map((x) => [x.key, x.label, x.costUsd])).toEqual([
      [world.opsProjectId, 'ops', '2.2500'],
      [world.projectId, 'web', '2.0000'],
    ]);
  });

  it('refuses a delete without before or with the wrong confirmation, deleting nothing', async () => {
    await del('', 'ALL').expect(400);
    await del('?before=2026-10-05T00:00:00Z', undefined).expect(400);
    await del('?before=2026-10-05T00:00:00Z', 'web').expect(400);
    await del('?before=2026-10-05T00:00:00', 'ALL').expect(400); // no Z
    await del(`?before=2026-10-05T00:00:00Z&projectId=${world.projectId}`, 'ALL').expect(400);
    await del('?before=2026-10-05T00:00:00Z&projectId=nope', 'nope').expect(404);
    expect(await prisma.fleetCostEvent.count()).toBe(3);
  });

  it('deletes one project before the cutoff, marks its ingest rows and records the activity', async () => {
    const res = data(await del(`?before=2026-10-05T00:00:00Z&projectId=${world.projectId}`, 'web').expect(200));
    expect(res).toEqual({ projectId: world.projectId, before: '2026-10-05T00:00:00.000Z', costEvents: 1, stories: 0, reviews: 0, ingestRowsMarked: 1 });
    expect(await prisma.fleetCostEvent.count({ where: { projectId: world.projectId } })).toBe(1);
    expect(await prisma.fleetCostEvent.count({ where: { projectId: world.opsProjectId } })).toBe(1);
    expect((await prisma.fleetBundleIngest.findFirstOrThrow({ where: { jobId: webJob } })).files).toMatchObject({ deleted: '2026-10-05T00:00:00.000Z' });
    const activity = await prisma.fleetActivity.findFirstOrThrow({ where: { action: 'analytics.deleted' } });
    expect(activity).toMatchObject({ entityType: 'analytics', entityId: world.projectId, actorId: world.ids.root });
  });

  it('deletes across projects with ALL', async () => {
    expect(data(await del('?before=2026-10-11T00:00:00Z', 'ALL').expect(200))).toMatchObject({ projectId: null, costEvents: 2 });
    expect(await prisma.fleetCostEvent.count()).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && bun run test:scoped test/integration/fleet/fleet-analytics-admin-api.integration.spec.ts`
Expected: FAIL — 404 on `/api/fleet/analytics/spend`.

- [ ] **Step 3: Implement the controller and register it**

`apps/api/src/fleet/analytics/fleet-analytics.controller.ts`:

```ts
import { Body, Controller, Delete, Get, HttpCode, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal, RequiredPermission } from '@nathapp/nestjs-auth';
import { JsonResponse } from '@nathapp/nestjs-common';
import { parseQuery } from '../../common/dto/koda-page.query';
import type { KodaPrincipal } from '../../auth/principal/koda-principal.types';
import { AnalyticsService } from './analytics.service';
import { AdminSpendQuery, DeleteAnalyticsBody, DeleteAnalyticsQuery } from './dto/analytics-query.dto';
import { AnalyticsDeletedDto, SpendAnalyticsDto } from './dto/analytics-response.dto';

/** Fleet S2b (d) §4.3, D370: global admin analytics. */
@ApiTags('fleet')
@ApiBearerAuth()
@Controller('fleet/analytics')
export class FleetAnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('spend')
  @RequiredPermission('ADMIN')
  @ApiOperation({ summary: 'Fleet spend across projects; groupBy also accepts project (global admin)' })
  @ApiResponse({ status: 200, type: SpendAnalyticsDto })
  @ApiResponse({ status: 400, description: 'Invalid window, bucket or groupBy' })
  async spend(@Query() raw: AdminSpendQuery) {
    return JsonResponse.Ok(await this.analytics.spend(null, parseQuery(AdminSpendQuery, raw), new Date()));
  }

  @Delete()
  @HttpCode(200)
  @RequiredPermission('ADMIN')
  @ApiOperation({ summary: 'Delete analytics rows dated before an instant; ingest rows are kept and marked (global admin, D384)' })
  @ApiResponse({ status: 200, type: AnalyticsDeletedDto })
  @ApiResponse({ status: 400, description: 'Missing before, or confirm is not the project slug / ALL' })
  @ApiResponse({ status: 404, description: 'No such project' })
  async remove(@Query() raw: DeleteAnalyticsQuery, @Body() body: DeleteAnalyticsBody, @Principal() principal: KodaPrincipal) {
    const q = parseQuery(DeleteAnalyticsQuery, raw);
    return JsonResponse.Ok(await this.analytics.deleteRows(principal.id, { ...q, confirm: body.confirm }, new Date()));
  }
}
```

In `apps/api/src/fleet/analytics/analytics.module.ts`, add
`import { FleetAnalyticsController } from './fleet-analytics.controller';` and change the controllers line to
`controllers: [ProjectFleetAnalyticsController, FleetAnalyticsController],`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && bun run test:scoped test/integration/fleet/fleet-analytics-admin-api.integration.spec.ts test/integration/fleet/fleet-analytics-api.integration.spec.ts`
Expected: PASS (both suites).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/fleet/analytics apps/api/test/integration/fleet/fleet-analytics-admin-api.integration.spec.ts
git commit -m "feat(fleet): S2b admin analytics spend and delete-on-demand routes (D384)"
```

---

### Task 7: OpenAPI contract and generated client

**Files:**
- Modify: `apps/api/src/fleet/fleet-openapi.contract.spec.ts`
- Modify (generated): `openapi.json`, `apps/cli/src/generated/*`

**Interfaces:**
- Consumes: the routes and DTOs of Tasks 5-6.
- Produces: generated CLI functions `projectFleetAnalyticsControllerSpend`, `projectFleetAnalyticsControllerQuality`,
  `projectFleetAnalyticsControllerStories`, `projectFleetAnalyticsControllerJobs`, `projectFleetAnalyticsControllerJob`,
  `fleetAnalyticsControllerSpend`, `fleetAnalyticsControllerRemove`, and types `SpendAnalyticsDto`,
  `QualityAnalyticsDto`, `StoriesAnalyticsDto`, `JobsAnalyticsDto`, `JobAnalyticsDto` (names derive from controller
  class + method; if `sdk.gen.ts` shows different names, Tasks 8-9 must use what it shows).

- [ ] **Step 1: Write the failing contract test**

Append inside the `describe('fleet OpenAPI contract', ...)` block of `apps/api/src/fleet/fleet-openapi.contract.spec.ts`:

```ts
  it('exposes the analytics routes and their response shapes (S2b §4, D377, D382, D383)', () => {
    for (const route of ['spend', 'quality', 'stories', 'jobs']) {
      expect(spec.paths[`/api/projects/{slug}/fleet/analytics/${route}`]?.['get']).toBeDefined();
    }
    expect(spec.paths['/api/projects/{slug}/fleet/jobs/{id}/analytics']?.['get']).toBeDefined();
    expect(spec.paths['/api/fleet/analytics/spend']?.['get']).toBeDefined();
    expect(spec.paths['/api/fleet/analytics']?.['delete']).toBeDefined();
    const props = (name: string) => Object.keys(spec.components.schemas[name]?.properties ?? {}).sort();
    expect(props('SpendAnalyticsDto')).toEqual(['bucket', 'groupBy', 'series', 'totals', 'window']);
    expect(props('SpendSeriesDto')).toEqual(['costUsd', 'folded', 'key', 'label', 'points', 'tokens']);
    expect(props('StoriesAnalyticsDto')).toEqual(['rows', 'window']);
    expect(props('JobAnalyticsRowDto')).toEqual(['command', 'costUsd', 'driftUsd', 'featureName', 'finishedAt', 'jobId', 'ledgerCostUsd', 'state']);
    expect(props('JobAnalyticsDto')).toEqual(['byModel', 'byRole', 'byStage', 'corrected', 'ingest', 'jobId', 'ledgerCostUsd', 'liveCostUsd', 'reviews', 'stories']);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && bun run test:scoped src/fleet/fleet-openapi.contract.spec.ts`
Expected: FAIL — `spec.paths['/api/projects/{slug}/fleet/analytics/spend']` is undefined.

- [ ] **Step 3: Regenerate the spec and the CLI client**

Run (repo root): `bun run generate`
Expected: `openapi.json` and `apps/cli/src/generated/{sdk,types}.gen.ts` change; `grep -c "projectFleetAnalyticsController" apps/cli/src/generated/sdk.gen.ts` prints at least 5.

- [ ] **Step 4: Run the contract test and the CLI type-check**

Run: `cd apps/api && bun run test:scoped src/fleet/fleet-openapi.contract.spec.ts && cd ../cli && bun run type-check`
Expected: PASS; type-check clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/fleet/fleet-openapi.contract.spec.ts openapi.json apps/cli/src/generated
git commit -m "chore(fleet): regenerate OpenAPI and CLI client for S2b analytics"
```

---

### Task 8: CLI analytics and job analytics

**Files:**
- Create: `apps/cli/src/commands/fleet-analytics.ts`
- Modify: `apps/cli/src/commands/fleet.ts`, `apps/cli/src/commands/fleet-job.ts`
- Test: `apps/cli/src/commands/fleet-analytics.spec.ts`, `apps/cli/src/commands/fleet.spec.ts`

**Interfaces:**
- Consumes: the generated functions and types of Task 7; `unwrap` (`src/utils/api.ts`), `withContext`
  (`src/utils/context.ts`), `handleApiError` (`src/utils/error.ts`), `table` (`src/utils/output.ts`),
  `parsePositiveInt` (`src/utils/parse-positive-int.ts`), `ADMIN_TOKEN_HINT`, `ago`, `handleFleetValidation`
  (`src/commands/fleet-shared.ts`).
- Produces: `registerFleetAnalytics(fleet: Command): void` (`koda fleet analytics spend|quality|stories|jobs`),
  `registerJobAnalytics(job: Command): void` (`koda fleet job analytics <jobId>`), `oneOf(values)` parser,
  `pct(rate)` formatter.

- [ ] **Step 1: Write the failing CLI test**

`apps/cli/src/commands/fleet-analytics.spec.ts`:

```ts
jest.mock('chalk', () => ({
  cyan: { bold: (s: string) => s }, gray: (s: string) => s, green: (s: string) => s, red: (s: string) => s, yellow: (s: string) => s,
}));
const mockStore = { get: jest.fn(() => ''), set: jest.fn() };
jest.mock('conf', () => jest.fn(() => mockStore));
jest.mock('../generated', () => ({
  projectFleetAnalyticsControllerSpend: jest.fn(),
  projectFleetAnalyticsControllerQuality: jest.fn(),
  projectFleetAnalyticsControllerStories: jest.fn(),
  projectFleetAnalyticsControllerJobs: jest.fn(),
  projectFleetAnalyticsControllerJob: jest.fn(),
  fleetAnalyticsControllerSpend: jest.fn(),
}));
jest.mock('../config', () => ({ resolveContext: jest.fn() }));

import { Command } from 'commander';
import { fleetCommand } from './fleet';
import { oneOf, pct } from './fleet-analytics';
import {
  fleetAnalyticsControllerSpend,
  projectFleetAnalyticsControllerJob,
  projectFleetAnalyticsControllerJobs,
  projectFleetAnalyticsControllerQuality,
  projectFleetAnalyticsControllerSpend,
  projectFleetAnalyticsControllerStories,
} from '../generated';
import { resolveContext } from '../config';

const CTX = { apiKey: 'jwt', apiUrl: 'https://koda.example.com', projectSlug: 'web' };
const ok = (data: unknown) => ({ ret: 0, data });
const WINDOW = { from: '2026-09-05T00:00:00.000Z', to: '2026-10-05T00:00:00.000Z' };
const spend = (over: Record<string, unknown> = {}) => ({
  window: WINDOW, bucket: 'day', groupBy: 'model',
  totals: { costUsd: '1.2346', tokens: 495, cacheShare: 0.3333, jobs: 2 },
  series: [{ key: 'm1', label: 'm1', folded: false, costUsd: '1.2346', tokens: 495, points: [] }],
  ...over,
});

describe('koda fleet analytics', () => {
  let program: Command;
  let exitSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;
  const out = () => logSpy.mock.calls.flat().join('\n');
  const run = (...args: string[]) => program.parseAsync(['node', 'koda', 'fleet', ...args]);

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

  it('parses enum options and formats rates', () => {
    expect(oneOf(['day', 'week'])('week')).toBe('week');
    expect(() => oneOf(['day', 'week'])('hour')).toThrow('expected one of day, week');
    expect(pct(0.3333)).toBe('33.3%');
    expect(pct(null)).toBe('-');
  });

  it('spend uses the project route and prints totals and groups', async () => {
    (projectFleetAnalyticsControllerSpend as jest.Mock).mockResolvedValue(ok(spend()));
    await run('analytics', 'spend', '--group-by', 'story', '--bucket', 'week', '--from', '2026-09-01T00:00:00Z');
    expect(projectFleetAnalyticsControllerSpend).toHaveBeenCalledWith({
      path: { slug: 'web' }, query: { from: '2026-09-01T00:00:00Z', bucket: 'week', groupBy: 'story' },
    });
    expect(out()).toContain('Total 1.2346 USD, 495 tokens, 2 jobs, cache share 33.3%');
    expect(out()).toContain('m1');
    expect(exitSpy).toHaveBeenLastCalledWith(0);
  });

  it('spend --all-projects uses the admin route and allows --group-by project', async () => {
    (fleetAnalyticsControllerSpend as jest.Mock).mockResolvedValue(ok(spend({
      groupBy: 'project', series: [{ key: 'p1', label: 'web', folded: false, costUsd: '1.0000', tokens: 1, points: [] }],
    })));
    await run('analytics', 'spend', '--all-projects', '--group-by', 'project');
    expect(fleetAnalyticsControllerSpend).toHaveBeenCalledWith({ query: { groupBy: 'project' } });
    expect(out()).toContain('web (p1)');
  });

  it('refuses --group-by project without --all-projects, and --all-projects with --project', async () => {
    await run('analytics', 'spend', '--group-by', 'project');
    expect(projectFleetAnalyticsControllerSpend).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(3);
    await run('analytics', 'spend', '--all-projects', '--project', 'web');
    expect(fleetAnalyticsControllerSpend).not.toHaveBeenCalled();
  });

  it('rejects an unknown bucket before calling the API', async () => {
    await expect(run('analytics', 'spend', '--bucket', 'hour')).rejects.toThrow();
    expect(projectFleetAnalyticsControllerSpend).not.toHaveBeenCalled();
  });

  it('says so when there is no spend, and prints JSON with --json', async () => {
    (projectFleetAnalyticsControllerSpend as jest.Mock).mockResolvedValue(ok(spend({ series: [] })));
    await run('analytics', 'spend');
    expect(out()).toContain('No spend in this window');
    logSpy.mockClear();
    await run('analytics', 'spend', '--json');
    expect(JSON.parse(out())).toMatchObject({ groupBy: 'model', series: [] });
  });

  it('quality prints rates, outcomes, reviewers and reasons', async () => {
    (projectFleetAnalyticsControllerQuality as jest.Mock).mockResolvedValue(ok({
      window: WINDOW, bucket: 'day', stories: 4, firstPassRate: 0.75, avgAttempts: 1.5,
      reviewByReviewer: [{ reviewer: 'semantic', runs: 2, passRate: 0.5, findingsBySeverity: { error: 2 } }],
      finishOutcomes: { opened: 1, promoted: 2, escalated: 1, skipped: 0, other: 0 },
      topEscalationReasons: [{ reason: 'review omitted WALK', count: 1 }], firstPassSeries: [],
    }));
    await run('analytics', 'quality', '--to', '2026-10-05T00:00:00Z');
    expect(projectFleetAnalyticsControllerQuality).toHaveBeenCalledWith({ path: { slug: 'web' }, query: { to: '2026-10-05T00:00:00Z' } });
    expect(out()).toContain('Stories 4, first pass 75.0%, average attempts 1.5');
    expect(out()).toContain('Finish: opened 1, promoted 2, escalated 1, skipped 0, other 0');
    expect(out()).toContain('error:2');
    expect(out()).toContain('review omitted WALK');
  });

  it('stories passes sort and limit; jobs prints ledger and drift', async () => {
    (projectFleetAnalyticsControllerStories as jest.Mock).mockResolvedValue(ok({ window: WINDOW, rows: [{
      jobId: 'j1', leaseEpoch: 1, featureName: 'f', storyId: 'US-1', attempts: 3, firstPassSuccess: false, success: true, costUsd: '0.3000', completedAt: null,
    }] }));
    await run('analytics', 'stories', '--sort', 'attempts', '--limit', '5');
    expect(projectFleetAnalyticsControllerStories).toHaveBeenCalledWith({ path: { slug: 'web' }, query: { sort: 'attempts', limit: 5 } });
    expect(out()).toContain('US-1');
    (projectFleetAnalyticsControllerJobs as jest.Mock).mockResolvedValue(ok({ window: WINDOW, rows: [{
      jobId: 'j1', command: 'RUN', featureName: 'f', state: 'COMPLETED', costUsd: '0.6000', ledgerCostUsd: '0.6500', driftUsd: '0.0500', finishedAt: null,
    }] }));
    await run('analytics', 'jobs');
    expect(projectFleetAnalyticsControllerJobs).toHaveBeenCalledWith({ path: { slug: 'web' }, query: {} });
    expect(out()).toContain('0.0500');
  });

  it('job analytics prints the ingest, the correction, live vs ledger and the breakdown', async () => {
    (projectFleetAnalyticsControllerJob as jest.Mock).mockResolvedValue(ok({
      jobId: 'j1', ingest: { leaseEpoch: 2, status: 'partial', files: { review: 'skipped:v3' }, ingestedAt: null, error: null },
      byStage: [{ key: 'run', costUsd: '0.4000', tokens: 10 }], byRole: [], byModel: [{ key: 'm1', costUsd: '0.4000', tokens: 10 }],
      stories: [{ leaseEpoch: 2, featureName: 'f', storyId: 'US-1', attempts: 1, firstPassSuccess: true, success: true, costUsd: '0.4000', durationMs: null, completedAt: null }],
      reviews: [{ leaseEpoch: 2, storyId: null, reviewer: 'semantic', passed: false, failOpen: false, findingCount: 1, findingsBySeverity: { error: 1 }, advisoryCount: 0, at: '2026-10-04T00:00:00.000Z' }],
      liveCostUsd: '0.3500', ledgerCostUsd: '0.4000', corrected: true,
    }));
    await run('job', 'analytics', 'j1');
    expect(projectFleetAnalyticsControllerJob).toHaveBeenCalledWith({ path: { slug: 'web', id: 'j1' } });
    expect(out()).toContain('Ingest partial (attempt 2)');
    expect(out()).toContain('review=skipped:v3');
    expect(out()).toContain('Outcome corrected from finish-audit');
    expect(out()).toContain('Live 0.3500 USD / ledger 0.4000 USD');
    expect(out()).toContain('run');
    expect(out()).toContain('US-1');
    expect(out()).toContain('semantic');
    expect(out()).toContain('error:1');
  });

  it('job analytics says when nothing is analysed yet', async () => {
    (projectFleetAnalyticsControllerJob as jest.Mock).mockResolvedValue(ok({
      jobId: 'j1', ingest: null, byStage: [], byRole: [], byModel: [], stories: [], reviews: [], liveCostUsd: null, ledgerCostUsd: null, corrected: false,
    }));
    await run('job', 'analytics', 'j1');
    expect(out()).toContain('Not analysed yet');
  });
});
```

In `apps/cli/src/commands/fleet.spec.ts`, rename the test to
`'registers the fleet group with runner, repo, dispatch, job, budget, schedule, approval and analytics'` and change
the expected list to `['analytics', 'approval', 'budget', 'dispatch', 'job', 'repo', 'runner', 'schedule']`.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/cli && bun run test -- src/commands/fleet-analytics.spec.ts src/commands/fleet.spec.ts`
Expected: FAIL — `Cannot find module './fleet-analytics'`; `fleet.spec.ts` is missing `analytics`.

- [ ] **Step 3: Implement the commands**

`apps/cli/src/commands/fleet-analytics.ts`:

```ts
import { Command, InvalidArgumentError } from 'commander';
import {
  fleetAnalyticsControllerSpend,
  projectFleetAnalyticsControllerJob,
  projectFleetAnalyticsControllerJobs,
  projectFleetAnalyticsControllerQuality,
  projectFleetAnalyticsControllerSpend,
  projectFleetAnalyticsControllerStories,
  type CostSliceDto,
  type JobAnalyticsDto,
  type JobsAnalyticsDto,
  type QualityAnalyticsDto,
  type SpendAnalyticsDto,
  type StoriesAnalyticsDto,
} from '../generated';
import { unwrap } from '../utils/api';
import { withContext } from '../utils/context';
import { handleApiError } from '../utils/error';
import { table } from '../utils/output';
import { parsePositiveInt } from '../utils/parse-positive-int';
import { ADMIN_TOKEN_HINT, ago, handleFleetValidation } from './fleet-shared';

const BUCKETS = ['day', 'week', 'month'] as const;
const PROJECT_GROUPS = ['model', 'stage', 'role', 'repo', 'runner', 'feature', 'story'] as const;
const ADMIN_GROUPS = [...PROJECT_GROUPS, 'project'] as const;
const STORY_SORTS = ['cost', 'attempts'] as const;

type Bucket = (typeof BUCKETS)[number];
type AdminGroup = (typeof ADMIN_GROUPS)[number];
type ProjectGroup = (typeof PROJECT_GROUPS)[number];
type StorySort = (typeof STORY_SORTS)[number];

/** Commander value parser for a fixed set of values. */
export function oneOf<T extends string>(values: readonly T[]): (value: string) => T {
  return (value: string) => {
    if (!(values as readonly string[]).includes(value)) throw new InvalidArgumentError(`expected one of ${values.join(', ')}`);
    return value as T;
  };
}

/** A 0..1 rate as a percentage with one decimal; '-' when there is no data (D380). */
export const pct = (rate: number | null | undefined): string => (rate === null || rate === undefined ? '-' : `${(rate * 100).toFixed(1)}%`);

const yesNo = (v: boolean): string => (v ? 'yes' : 'no');
const countsText = (m: Record<string, number>): string => Object.entries(m).map(([k, v]) => `${k}:${v}`).join(' ') || '-';
const filesText = (m: Record<string, string>): string => Object.entries(m).map(([k, v]) => `${k}=${v}`).join(' ') || '-';

interface WindowOptions { from?: string; to?: string; project?: string; json?: boolean }
interface SpendOptions extends WindowOptions { bucket?: Bucket; groupBy?: string; allProjects?: boolean }
interface ListOptions extends WindowOptions { limit?: number }
interface StoriesOptions extends ListOptions { sort?: StorySort }

const windowQuery = (o: WindowOptions): { from?: string; to?: string } => ({
  ...(o.from ? { from: o.from } : {}), ...(o.to ? { to: o.to } : {}),
});

function withWindowOptions(cmd: Command): Command {
  return cmd
    .option('--from <iso>', 'Window start, inclusive (UTC); default 30 days before --to')
    .option('--to <iso>', 'Window end, exclusive (UTC); default now')
    .option('--project <slug>', 'Project slug (uses config if not provided)')
    .option('--json', 'Output as JSON');
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function printSpend(s: SpendAnalyticsDto): void {
  console.log(`Spend ${s.window.from} .. ${s.window.to} by ${s.groupBy} (${s.bucket})`);
  console.log(`Total ${s.totals.costUsd} USD, ${s.totals.tokens} tokens, ${s.totals.jobs} jobs, cache share ${pct(s.totals.cacheShare)}`);
  if (s.series.length === 0) {
    console.log('No spend in this window');
    return;
  }
  table(['Group', 'Cost (USD)', 'Tokens'], s.series.map((x) => [x.label === x.key ? x.key : `${x.label} (${x.key})`, x.costUsd, String(x.tokens)]));
}

/** `groupBy` was checked against the allowed list in the action, so the narrowing casts are safe. */
async function fetchSpend(o: SpendOptions): Promise<SpendAnalyticsDto> {
  const base = { ...windowQuery(o), ...(o.bucket ? { bucket: o.bucket } : {}) };
  if (o.allProjects) {
    await withContext({}, { requireProject: false });
    const query = { ...base, ...(o.groupBy ? { groupBy: o.groupBy as AdminGroup } : {}) };
    return unwrap<SpendAnalyticsDto>(await fleetAnalyticsControllerSpend({ query }));
  }
  const { projectSlug: slug } = await withContext({ projectSlug: o.project });
  const query = { ...base, ...(o.groupBy ? { groupBy: o.groupBy as ProjectGroup } : {}) };
  return unwrap<SpendAnalyticsDto>(await projectFleetAnalyticsControllerSpend({ path: { slug }, query }));
}

function registerSpend(analytics: Command): void {
  withWindowOptions(analytics.command('spend'))
    .description('Fleet spend over a window, grouped by model, stage, role, repo, runner, feature or story')
    .option('--bucket <bucket>', 'day, week or month (default from the window length)', oneOf(BUCKETS))
    .option('--group-by <dimension>', `${PROJECT_GROUPS.join(', ')} (default model); project with --all-projects`)
    .option('--all-projects', 'Across every project (global admin)')
    .action(async (o: SpendOptions) => {
      const groups: readonly string[] = o.allProjects ? ADMIN_GROUPS : PROJECT_GROUPS;
      if (o.allProjects && o.project) return handleFleetValidation('--all-projects and --project cannot be combined');
      if (o.groupBy && !groups.includes(o.groupBy)) return handleFleetValidation(`Unknown --group-by "${o.groupBy}": ${groups.join(', ')}`);
      try {
        const s = await fetchSpend(o);
        if (o.json) printJson(s);
        else printSpend(s);
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, o.allProjects ? { forbiddenHint: ADMIN_TOKEN_HINT } : undefined);
      }
    });
}

function printQuality(q: QualityAnalyticsDto): void {
  console.log(`Quality ${q.window.from} .. ${q.window.to}`);
  console.log(`Stories ${q.stories}, first pass ${pct(q.firstPassRate)}, average attempts ${q.avgAttempts ?? '-'}`);
  const f = q.finishOutcomes;
  console.log(`Finish: opened ${f.opened}, promoted ${f.promoted}, escalated ${f.escalated}, skipped ${f.skipped}, other ${f.other}`);
  if (q.reviewByReviewer.length > 0) {
    table(['Reviewer', 'Runs', 'Pass rate', 'Findings'], q.reviewByReviewer.map((r) => [r.reviewer, String(r.runs), pct(r.passRate), countsText(r.findingsBySeverity)]));
  }
  if (q.topEscalationReasons.length > 0) {
    table(['Escalation reason', 'Count'], q.topEscalationReasons.map((r) => [r.reason, String(r.count)]));
  }
}

function registerQuality(analytics: Command): void {
  withWindowOptions(analytics.command('quality'))
    .description('Run quality over a window: first pass, attempts, reviews, finish outcomes, escalation reasons')
    .option('--bucket <bucket>', 'day, week or month (default from the window length)', oneOf(BUCKETS))
    .action(async (o: WindowOptions & { bucket?: Bucket }) => {
      try {
        const { projectSlug: slug } = await withContext({ projectSlug: o.project });
        const q = unwrap<QualityAnalyticsDto>(await projectFleetAnalyticsControllerQuality({
          path: { slug }, query: { ...windowQuery(o), ...(o.bucket ? { bucket: o.bucket } : {}) },
        }));
        if (o.json) printJson(q);
        else printQuality(q);
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err);
      }
    });
}

function registerStories(analytics: Command): void {
  withWindowOptions(analytics.command('stories'))
    .description('The most expensive (or most looping) stories completed in a window')
    .option('--sort <sort>', 'cost or attempts (default cost)', oneOf(STORY_SORTS))
    .option('--limit <n>', 'Rows, 1-50 (default 20)', parsePositiveInt)
    .action(async (o: StoriesOptions) => {
      try {
        const { projectSlug: slug } = await withContext({ projectSlug: o.project });
        const page = unwrap<StoriesAnalyticsDto>(await projectFleetAnalyticsControllerStories({
          path: { slug }, query: { ...windowQuery(o), ...(o.sort ? { sort: o.sort } : {}), ...(o.limit ? { limit: o.limit } : {}) },
        }));
        if (o.json) {
          printJson(page);
        } else {
          table(['Job', 'Feature', 'Story', 'Attempts', 'First pass', 'Success', 'Cost (USD)', 'Completed'], page.rows.map((r) => [
            r.jobId, r.featureName, r.storyId, String(r.attempts), yesNo(r.firstPassSuccess), yesNo(r.success), r.costUsd, ago(r.completedAt),
          ]));
        }
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err);
      }
    });
}

function registerJobs(analytics: Command): void {
  withWindowOptions(analytics.command('jobs'))
    .description('The most expensive jobs finished in a window, with cost-ledger drift')
    .option('--limit <n>', 'Rows, 1-50 (default 20)', parsePositiveInt)
    .action(async (o: ListOptions) => {
      try {
        const { projectSlug: slug } = await withContext({ projectSlug: o.project });
        const page = unwrap<JobsAnalyticsDto>(await projectFleetAnalyticsControllerJobs({
          path: { slug }, query: { ...windowQuery(o), ...(o.limit ? { limit: o.limit } : {}) },
        }));
        if (o.json) {
          printJson(page);
        } else {
          table(['Job', 'Cmd', 'Feature', 'State', 'Cost (USD)', 'Ledger', 'Drift', 'Finished'], page.rows.map((r) => [
            r.jobId, r.command, r.featureName, r.state, r.costUsd, r.ledgerCostUsd ?? '-', r.driftUsd ?? '-', ago(r.finishedAt),
          ]));
        }
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err);
      }
    });
}

export function registerFleetAnalytics(fleet: Command): void {
  const analytics = fleet.command('analytics');
  analytics.description('Fleet cost and run-quality analytics (S2b): spend, quality, stories, jobs');
  registerSpend(analytics);
  registerQuality(analytics);
  registerStories(analytics);
  registerJobs(analytics);
}

function printSlices(title: string, slices: CostSliceDto[]): void {
  if (slices.length > 0) table([title, 'Cost (USD)', 'Tokens'], slices.map((s) => [s.key, s.costUsd, String(s.tokens)]));
}

function printJobAnalytics(j: JobAnalyticsDto): void {
  if (j.ingest) {
    console.log(`Ingest ${j.ingest.status} (attempt ${j.ingest.leaseEpoch})${j.ingest.error ? `: ${j.ingest.error}` : ''}; files ${filesText(j.ingest.files)}`);
  } else {
    console.log('Not analysed yet: no bundle has been ingested for this job');
  }
  if (j.corrected) console.log('Outcome corrected from finish-audit');
  if (j.liveCostUsd && j.ledgerCostUsd && j.liveCostUsd !== j.ledgerCostUsd) console.log(`Live ${j.liveCostUsd} USD / ledger ${j.ledgerCostUsd} USD`);
  printSlices('Stage', j.byStage);
  printSlices('Role', j.byRole);
  printSlices('Model', j.byModel);
  if (j.stories.length > 0) {
    table(['Attempt', 'Story', 'Attempts', 'First pass', 'Success', 'Cost (USD)'], j.stories.map((s) => [
      String(s.leaseEpoch), s.storyId, String(s.attempts), yesNo(s.firstPassSuccess), yesNo(s.success), s.costUsd,
    ]));
  }
  if (j.reviews.length > 0) {
    table(['Attempt', 'Story', 'Reviewer', 'Passed', 'Findings'], j.reviews.map((r) => [
      String(r.leaseEpoch), r.storyId ?? '-', r.reviewer, yesNo(r.passed), countsText(r.findingsBySeverity),
    ]));
  }
}

/** `koda fleet job analytics <jobId>` (spec §4.4). */
export function registerJobAnalytics(job: Command): void {
  job
    .command('analytics <jobId>')
    .description("A job's cost by stage, role and model, its stories and reviews (from its ingested bundle)")
    .option('--project <slug>', 'Project slug (uses config if not provided)')
    .option('--json', 'Output as JSON')
    .action(async (jobId: string, o: { project?: string; json?: boolean }) => {
      try {
        const { projectSlug: slug } = await withContext({ projectSlug: o.project });
        const j = unwrap<JobAnalyticsDto>(await projectFleetAnalyticsControllerJob({ path: { slug, id: jobId } }));
        if (o.json) printJson(j);
        else printJobAnalytics(j);
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, { notFoundMessage: `Job not found: ${jobId}` });
      }
    });
}
```

In `apps/cli/src/commands/fleet.ts`, add `import { registerFleetAnalytics } from './fleet-analytics';`, call
`registerFleetAnalytics(fleet);` after `registerFleetSchedule(fleet);`, and extend the doc comment with
"analytics (S2b §4.4)".

In `apps/cli/src/commands/fleet-job.ts`, add `import { registerJobAnalytics } from './fleet-analytics';`, call
`registerJobAnalytics(job);` after `registerLogs(job);` in `registerFleetJob`, and change the description to
`'Fleet jobs: list, show, cancel, requeue, bundle, logs, analytics'`.

If `bun run type-check` reports that a generated query type does not accept a value (for example `groupBy`), read
the matching `*Data['query']` type in `apps/cli/src/generated/types.gen.ts` and narrow the value to it; do not cast
to `never` or `any`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/cli && bun run test -- src/commands/fleet-analytics.spec.ts src/commands/fleet-job.spec.ts src/commands/fleet.spec.ts && bun run type-check && bun run lint`
Expected: PASS; type-check and lint clean.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/commands/fleet-analytics.ts apps/cli/src/commands/fleet-analytics.spec.ts apps/cli/src/commands/fleet.ts apps/cli/src/commands/fleet.spec.ts apps/cli/src/commands/fleet-job.ts
git commit -m "feat(cli): koda fleet analytics and fleet job analytics (S2b §4.4, D386)"
```

---

### Task 9: CLI ingest commands

**Files:**
- Create: `apps/cli/src/commands/fleet-ingest.ts`
- Modify: `apps/cli/src/commands/fleet.ts`
- Test: `apps/cli/src/commands/fleet-ingest.spec.ts`, `apps/cli/src/commands/fleet.spec.ts`

**Interfaces:**
- Consumes: generated `fleetIngestControllerList`, `fleetIngestControllerBackfill`, `fleetIngestControllerRerunJob`,
  `fleetIngestControllerRerunOutdated`, type `IngestQueuedDto` (slice 1a); `FleetPage`, `ago`, `pageHint`,
  `ADMIN_TOKEN_HINT`, `handleFleetValidation` (`fleet-shared.ts`); `oneOf` (Task 8).
- Produces: `registerFleetIngest(fleet: Command): void` (`koda fleet ingest status|backfill|rerun`).

- [ ] **Step 1: Write the failing CLI test**

`apps/cli/src/commands/fleet-ingest.spec.ts`:

```ts
jest.mock('chalk', () => ({
  cyan: { bold: (s: string) => s }, gray: (s: string) => s, green: (s: string) => s, red: (s: string) => s, yellow: (s: string) => s,
}));
const mockStore = { get: jest.fn(() => ''), set: jest.fn() };
jest.mock('conf', () => jest.fn(() => mockStore));
jest.mock('../generated', () => ({
  fleetIngestControllerList: jest.fn(),
  fleetIngestControllerBackfill: jest.fn(),
  fleetIngestControllerRerunJob: jest.fn(),
  fleetIngestControllerRerunOutdated: jest.fn(),
}));
jest.mock('../config', () => ({ resolveContext: jest.fn() }));

import { Command } from 'commander';
import { fleetCommand } from './fleet';
import {
  fleetIngestControllerBackfill,
  fleetIngestControllerList,
  fleetIngestControllerRerunJob,
  fleetIngestControllerRerunOutdated,
} from '../generated';
import { resolveContext } from '../config';

const CTX = { apiKey: 'jwt', apiUrl: 'https://koda.example.com' };
const ok = (data: unknown) => ({ ret: 0, data });
const row = (over: Record<string, unknown> = {}) => ({
  id: 'i1', jobId: 'j1', leaseEpoch: 1, projectId: 'p1', status: 'failed', attempts: 5, parserVersion: 1,
  files: { cost: 'done:v8' }, error: 'bundle expired', ingestedAt: null, updatedAt: new Date().toISOString(), ...over,
});

describe('koda fleet ingest', () => {
  let program: Command;
  let exitSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;
  const out = () => logSpy.mock.calls.flat().join('\n');
  const run = (...args: string[]) => program.parseAsync(['node', 'koda', 'fleet', 'ingest', ...args]);

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

  it('status lists ingest rows with a status filter and paging', async () => {
    (fleetIngestControllerList as jest.Mock).mockResolvedValue(ok({ total: 1, current: 1, size: 20, hasNext: true, hasPrev: false, records: [row()] }));
    await run('status', '--status', 'failed');
    expect(fleetIngestControllerList).toHaveBeenCalledWith({ query: { current: 1, size: 20, status: 'failed' } });
    expect(out()).toContain('bundle expired');
    expect(out()).toContain('cost=done:v8');
    expect(out()).toContain('Next: --page 2');
    expect(exitSpy).toHaveBeenLastCalledWith(0);
  });

  it('status rejects an unknown status', async () => {
    await expect(run('status', '--status', 'bogus')).rejects.toThrow();
    expect(fleetIngestControllerList).not.toHaveBeenCalled();
  });

  it('backfill and rerun report how many bundles were queued', async () => {
    (fleetIngestControllerBackfill as jest.Mock).mockResolvedValue(ok({ queued: 3 }));
    await run('backfill');
    expect(out()).toContain('Queued 3 bundle(s) for ingest');
    (fleetIngestControllerRerunJob as jest.Mock).mockResolvedValue(ok({ queued: 1 }));
    await run('rerun', 'j1');
    expect(fleetIngestControllerRerunJob).toHaveBeenCalledWith({ path: { jobId: 'j1' } });
    (fleetIngestControllerRerunOutdated as jest.Mock).mockResolvedValue(ok({ queued: 0 }));
    await run('rerun', '--all');
    expect(fleetIngestControllerRerunOutdated).toHaveBeenCalled();
    expect(out()).toContain('Queued 0 bundle(s) for ingest');
  });

  it('rerun needs exactly one of a job id or --all', async () => {
    await run('rerun');
    await run('rerun', 'j1', '--all');
    expect(fleetIngestControllerRerunJob).not.toHaveBeenCalled();
    expect(fleetIngestControllerRerunOutdated).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(3);
  });
});
```

In `apps/cli/src/commands/fleet.spec.ts`, add `'ingest'` to the expected list (after `'dispatch'`) and to the test
name.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/cli && bun run test -- src/commands/fleet-ingest.spec.ts src/commands/fleet.spec.ts`
Expected: FAIL — `error: unknown command 'ingest'` (the `status` test rejects); `fleet.spec.ts` is missing `ingest`.

- [ ] **Step 3: Implement the commands**

`apps/cli/src/commands/fleet-ingest.ts`:

```ts
import { Command } from 'commander';
import {
  fleetIngestControllerBackfill,
  fleetIngestControllerList,
  fleetIngestControllerRerunJob,
  fleetIngestControllerRerunOutdated,
  type IngestQueuedDto,
} from '../generated';
import { unwrap } from '../utils/api';
import { withContext } from '../utils/context';
import { handleApiError } from '../utils/error';
import { table } from '../utils/output';
import { parsePositiveInt } from '../utils/parse-positive-int';
import { oneOf } from './fleet-analytics';
import { ADMIN_TOKEN_HINT, ago, type FleetPage, handleFleetValidation, pageHint } from './fleet-shared';

const STATUSES = ['pending', 'running', 'done', 'partial', 'failed'] as const;
type IngestStatus = (typeof STATUSES)[number];

/** D386: the paged route is untyped in OpenAPI, as every koda page; this mirrors the API's IngestRowDto. */
interface IngestRow {
  id: string;
  jobId: string;
  leaseEpoch: number;
  projectId: string;
  status: IngestStatus;
  attempts: number;
  parserVersion: number;
  files: Record<string, string>;
  error: string | null;
  ingestedAt: string | null;
  updatedAt: string;
}

const ADMIN = { forbiddenHint: ADMIN_TOKEN_HINT };
const filesText = (files: Record<string, string>): string => Object.entries(files).map(([k, v]) => `${k}=${v}`).join(' ') || '-';
const short = (text: string | null, max = 60): string => (!text ? '-' : text.length > max ? `${text.slice(0, max - 3)}...` : text);
const printQueued = (r: IngestQueuedDto): void => console.log(`Queued ${r.queued} bundle(s) for ingest`);

function registerStatus(ingest: Command): void {
  ingest
    .command('status')
    .description('Bundle ingest rows, most recently updated first (global admin)')
    .option('--status <status>', `One of ${STATUSES.join(', ')}`, oneOf(STATUSES))
    .option('--page <n>', 'Page number', parsePositiveInt, 1)
    .option('--size <n>', 'Page size (1-100)', parsePositiveInt, 20)
    .option('--json', 'Output as JSON')
    .action(async (o: { status?: IngestStatus; page: number; size: number; json?: boolean }) => {
      try {
        await withContext({}, { requireProject: false });
        const page = unwrap<FleetPage<IngestRow>>(await fleetIngestControllerList({
          query: { current: o.page, size: o.size, ...(o.status ? { status: o.status } : {}) },
        }));
        if (o.json) {
          console.log(JSON.stringify(page, null, 2));
        } else {
          table(['Job', 'Attempt', 'Project', 'Status', 'Tries', 'Files', 'Error', 'Updated'], page.records.map((r) => [
            r.jobId, String(r.leaseEpoch), r.projectId, r.status, String(r.attempts), filesText(r.files), short(r.error), ago(r.updatedAt),
          ]));
          const hint = pageHint(page);
          if (hint) console.log(hint);
        }
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, ADMIN);
      }
    });
}

function registerBackfill(ingest: Command): void {
  ingest
    .command('backfill')
    .description('Queue every stored bundle that has never been ingested (global admin)')
    .action(async () => {
      try {
        await withContext({}, { requireProject: false });
        printQueued(unwrap<IngestQueuedDto>(await fleetIngestControllerBackfill()));
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, ADMIN);
      }
    });
}

function registerRerun(ingest: Command): void {
  ingest
    .command('rerun [jobId]')
    .description("Re-ingest one job's bundles, or with --all every bundle parsed by an older parser (global admin)")
    .option('--all', 'Re-ingest bundles ingested by an older parser version')
    .action(async (jobId: string | undefined, o: { all?: boolean }) => {
      if (Boolean(jobId) === Boolean(o.all)) return handleFleetValidation('Give a job id or --all, not both');
      try {
        await withContext({}, { requireProject: false });
        const result = jobId
          ? await fleetIngestControllerRerunJob({ path: { jobId } })
          : await fleetIngestControllerRerunOutdated();
        printQueued(unwrap<IngestQueuedDto>(result));
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, { ...ADMIN, notFoundMessage: `Job not found: ${jobId}` });
      }
    });
}

/** `koda fleet ingest …` (spec §4.4, D370). */
export function registerFleetIngest(fleet: Command): void {
  const ingest = fleet.command('ingest');
  ingest.description('Bundle ingest health and re-runs (global admin)');
  registerStatus(ingest);
  registerBackfill(ingest);
  registerRerun(ingest);
}
```

In `apps/cli/src/commands/fleet.ts`, add `import { registerFleetIngest } from './fleet-ingest';` and call
`registerFleetIngest(fleet);` after `registerFleetAnalytics(fleet);`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/cli && bun run test -- src/commands/fleet-ingest.spec.ts src/commands/fleet-analytics.spec.ts src/commands/fleet.spec.ts && bun run type-check && bun run lint`
Expected: PASS; type-check and lint clean.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/commands/fleet-ingest.ts apps/cli/src/commands/fleet-ingest.spec.ts apps/cli/src/commands/fleet.ts apps/cli/src/commands/fleet.spec.ts
git commit -m "feat(cli): koda fleet ingest status, backfill and rerun (S2b §4.4)"
```

---

### Task 10: Docs, full verification, PR

**Files:**
- Modify: `docs/superpowers/specs/2026-10-04-fleet-s2b-d-analytics-design.md` (D377, D382-D384, D386)
- Modify: `docs/deployment/runner.md` (CLI cheat sheet)
- Modify: `.nax/mono/apps/api/context.md`, `.nax/mono/apps/cli/context.md`, then regenerate agent files

- [ ] **Step 1: Apply the spec additions**

In the spec:

- §4.2 spend bullet: after `series: [{key, points: [{t, costUsd, tokens}]}] }`, add "Each series also carries
  `label` (repo owner/name, runner name, project slug, else the key), `folded` and its own `costUsd`/`tokens`; null
  dimensions use the key `(none)`; points are zero-filled for every bucket (plan D377, D378)."
- §4.2 stories and jobs bullets: replace `-> rows` with `-> { window, rows }` (story rows also carry `leaseEpoch`),
  and add to the jobs bullet: "`costUsd` = spent + carried; `ledgerCostUsd` sums the job's done/partial ingest rows
  (null before ingest); `driftUsd` = ledger - cost (plan D382)."
- §4.2 quality bullet: append "The response also carries `window` and `bucket` (plan D382)."
- §4.2 job analytics bullet: append "Also `jobId`; `ingest` carries its `leaseEpoch`; slices, stories and reviews span
  every attempt, ingest and live/ledger describe the latest attempt (plan D383)."
- §4.3 delete bullet: change the code span `files.deleted = true` to `files.deleted = "<before ISO>"`, and
  append "`projectId` optional (omitted = every project, confirm `ALL`); stories with a null `completedAt` match
  through the job's `finishedAt` (plan D384)."
- §4.4: append "`analytics spend --all-projects` uses the admin route; `--sort` exists on `stories` only; there is no
  CLI delete (plan D386)."

- [ ] **Step 2: Document the modules in the agent context**

In `.nax/mono/apps/api/context.md`, insert after the `src/fleet/ingest/` bullet (it ends with the line
``untrusted: only allowlisted paths, capped sizes, typed field readers. Admin routes: `fleet/ingest`.``):

```markdown
- `src/fleet/analytics/` (S2b): read-only cost and quality analytics over the ingest tables. The repository returns
  unrounded `Prisma.Decimal` sums; money becomes a 4-place string only in `AnalyticsService` (`usd4`, A7), never
  summed after rounding. SQL fragments for `groupBy`/`bucket` come from fixed maps keyed by validated enums. Project
  routes `projects/:slug/fleet/analytics/*` and `jobs/:id/analytics` (any member, agents 403); admin routes
  `fleet/analytics/spend` and `DELETE fleet/analytics` (confirmation required, ingest rows kept and marked).
```

In `.nax/mono/apps/cli/context.md`, add as the last bullet of the "Entry points and key files:" list, right after
the `` `src/generated/`: generated API client, source controlled but not hand-edited`` line:

```markdown
- `apps/cli/src/commands/fleet-analytics.ts`, `fleet-ingest.ts`: `koda fleet analytics …`, `koda fleet job analytics`,
  `koda fleet ingest …`. Money arrives as 4-place strings from the API: print it as-is, never re-round or sum it.
```

In `docs/deployment/runner.md`, section "Operate from the CLI": add to the intro paragraph "Analytics commands need
project membership; `koda fleet ingest …` and `koda fleet analytics spend --all-projects` need the global-admin
token." and add these lines to the command block, after the `koda fleet schedule disable` line:

```bash
koda fleet analytics spend --group-by stage         # where the money goes; --bucket, --from/--to, --all-projects (admin)
koda fleet analytics quality                        # first pass, attempts, reviews, finish outcomes, escalation reasons
koda fleet analytics stories --sort attempts        # most looping stories; jobs = most expensive jobs with ledger drift
koda fleet job analytics <jobId>                    # cost by stage/role/model, stories, reviews, live vs ledger
koda fleet ingest status --status failed            # bundle ingest health (admin); backfill; rerun <jobId> | --all
```

Run (repo root): `nax generate` and then `nax generate --all-packages` (never one scope alone). Then `git status`
must show only the two context files, `docs/deployment/runner.md`, the spec, and generated agent files (`AGENTS.md`,
`CLAUDE.md`, `GEMINI.md`, `codex.md`, `.cursorrules`, `.windsurfrules`, `.aider.conf.yml`, at the root and under
`apps/*`). Never hand-edit a generated file.

- [ ] **Step 3: Full verification**

Run, from the repo root:

```bash
bun run lint -- --force
bun run type-check -- --force
cd apps/api && bun run test:unit && bun run test:db:up && bun run test:scoped test/integration/fleet
cd ../cli && bun run test
```

Expected: all green (`--force` bypasses the turbo cache, which can replay a stale green). Fix any failure before
continuing (login-throttle failures: rerun that file alone after a minute).

- [ ] **Step 4: Commit the docs**

```bash
git add docs/superpowers/specs/2026-10-04-fleet-s2b-d-analytics-design.md docs/deployment/runner.md .nax/mono/apps/api/context.md .nax/mono/apps/cli/context.md
git add -u -- AGENTS.md CLAUDE.md GEMINI.md codex.md .cursorrules .windsurfrules .aider.conf.yml 'apps/*/AGENTS.md' 'apps/*/CLAUDE.md' 'apps/*/GEMINI.md' 'apps/*/codex.md' 'apps/*/.cursorrules' 'apps/*/.windsurfrules' 'apps/*/.aider.conf.yml'
git status --short   # must be empty except files unrelated to this branch
git commit -m "docs(fleet): S2b analytics spec additions (D377, D382-D384, D386), runner CLI docs and agent context"
```

- [ ] **Step 5: Review before push (required)**

Run the `nax-toolkit:post-impl-review` skill with `--phase full` against this spec
(`docs/superpowers/specs/2026-10-04-fleet-s2b-d-analytics-design.md`, §4 and §6 slice 1b rows), then a code review
of `git diff main...HEAD` (`code-review` skill or the `code-reviewer` agent). Fix CRITICAL and HIGH findings, at
most 2 fix rounds; list anything left in the PR body. Then **stop and ask the user for approval** before pushing.

- [ ] **Step 6: Push and open the PR (after approval)**

```bash
git push -u origin feat/fleet-s2b-analytics-api
gh pr create --title "feat(fleet): S2b slice 1b — analytics query API and CLI (D376-D387)" --body "$(cat <<'EOF'
## Summary
- New read-side module `src/fleet/analytics/` over the slice 1a tables (spec §4).
- Project routes: spend (grouped, bucketed, top-12 fold), quality, most expensive stories and jobs, per-job breakdown.
- Admin routes: cross-project spend (`groupBy=project`) and confirmed delete-on-demand (ingest rows kept, marked).
- Money is a 4-place string rounded once from the unrounded SQL sum (A7).
- CLI: `koda fleet analytics spend|quality|stories|jobs`, `koda fleet job analytics`, `koda fleet ingest status|backfill|rerun`.

## Test plan
- [ ] Unit: window/bucket/money helpers, series fold, quality mapping, service
- [ ] Integration (PG): read repository (week boundary, scope, empty window), delete, project API (auth, validation, empty window), admin API
- [ ] OpenAPI contract + regenerated CLI client; CLI command specs
- [ ] After deploy to koda-wk: `koda fleet ingest backfill`, then `koda fleet analytics spend --group-by stage` and `koda fleet job analytics <substract job>` show the 2026-10-04 sandbox runs
EOF
)"
```

---

## Self-review notes

- Spec §4.1 (window, bucket, enums, money, cacheShare, attribution, no cache) -> Tasks 1, 2, 5. §4.2 spend -> Tasks
  1-2, 4-5; quality -> Tasks 2, 4-5; stories/jobs -> Tasks 2, 4-5; job breakdown -> Tasks 2, 4-5. §4.3 ingest routes
  shipped in 1a (D370); admin spend + delete -> Tasks 3, 4, 6. §4.4 CLI -> Tasks 8-9; regenerated client -> Task 7.
  §6 API + CLI test rows -> Tasks 5-9. §5 web is slice 2 by design.
- Review Focus: 1 -> Tasks 4, 5; 2 -> Tasks 1, 2, 5; 3 -> Task 2; 4 -> Tasks 5, 6; 5 -> Tasks 3, 6.
- Final review 2026-10-05 (three read-only reviewers: Tasks 1-4, 5-7, 8-10 + spec coverage): no BLOCKER; applied
  the review gate before push, `nax generate --all-packages`, UTC-only `from`/`to`/`before`, spec-edit and doc
  fixes, D382/D383/D386/D387 wording, and a CLI test that exercises the job stories/reviews tables.
- Generated CLI names in Tasks 8-9 follow the existing `<controllerClass><Method>` pattern (`fleetIngestControllerList`
  in slice 1a); Task 7 Step 3 is where a mismatch would show.
