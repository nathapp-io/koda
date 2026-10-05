# Fleet S2b Slice 2 — Analytics Web Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A project member opens `/<project>/fleet/analytics` and sees where fleet money went and what it bought
over a chosen window; a global admin sees the same spend across projects plus the bundle ingest health table with
re-run and backfill; every job page gets a "Cost & quality" section once its bundle is ingested. An E2E proves the
whole path from a scripted runner's bundle to the pages.

**Architecture:** Three small API additions first (spend `top`, median cost per job, project ingest counts), then
the web. Pure modules in `apps/web/lib/` own every decision a test can pin (window URL state, money and rate text,
chart rows and colors, HTML escaping); thin composables own the API calls and per-panel load state; presentational
components in `components/fleet/analytics/` render plain HTML (bar lists, tables, tiles, panels); only the two
time-series charts use `@unovis/vue`, as client-only components (`*.client.vue`). Pages wire panels together so one
failing query never blanks the page.

**Tech Stack:** API: NestJS 11 + Prisma 6 (PostgreSQL 16) + Jest. Web: Nuxt 3.21 + `shadcn-nuxt` 0.10 (`radix-vue`)
+ Tailwind 3 + `@unovis/vue`/`@unovis/ts` 1.7.1 (new) + Jest 29 (node environment, `mountSfc`) + Playwright.

**Spec:** `docs/superpowers/specs/2026-10-04-fleet-s2b-d-analytics-design.md` §5 (all of it), §6 web and E2E rows,
§7 slice 2. Rulings A3, A7. Builds on slice 1a (#210, D365-D375) and slice 1b (#213, D376-D387).

## Global Constraints

- Web tests: Jest 29, `testEnvironment: node`, no DOM. Components mount through `tests/helpers/mount-sfc.ts`
  (`mountSfc`), pure modules are imported through `~/`. Specs live in `apps/web/tests/{lib,composables,components,pages,i18n,layouts}/*.spec.ts`
  and import from `@jest/globals`. Run: `cd apps/web && bun run test -- <paths>`.
- `mountSfc` injects only the names in `NUXT_AUTO_IMPORTS` (`mount-sfc.ts:113-118`); a page that uses another
  auto-import must import it explicitly from `~/composables/...`. Components are never auto-imported in tests:
  pass them through `components:` (stubs) or `fleetComponents:` (real files listed in `FLEET_COMPONENT_FILES`).
- Tailwind scans only `components/`, `layouts/`, `pages/`, `plugins/`, `app.vue`: class names live in `.vue` files,
  never in `lib/` or `composables/`.
- API paths with a variable go through the `apiPath` tagged template (`lib/api-path.ts`); query values go in
  `{ query }` as strings. `tests/lib/api-path-guard.spec.ts` fails an untagged template path.
- **Money (A7):** the API sends 4-place strings. The web shows them unchanged with a `$` prefix and never sums,
  rounds or re-formats money. `Number(...)` of a money string is allowed only for chart geometry and bar widths.
- i18n: every key in both `apps/web/i18n/locales/en.json` and `zh.json`. No `|` or `@` anywhere under `fleet` or
  `nav` (`tests/i18n/fleet-locale-parity.spec.ts`). A subtree rendered through dynamic keys is pinned in that spec's
  `ENUMS` map with its exact key set.
- Charts: at most 8 colors (the dataviz reference palette's 8 categorical slots, fixed order, never cycled); "other"
  has its own neutral color; a legend whenever there are 2 or more series; every chart has an `aria-label` summary
  and a data table; dark mode uses its own values from the same palette.
- No polling on the analytics pages: fetch on load, on window or group change, and when the tab becomes visible.
- Access: the project page is for any project member; the admin page for global ADMIN (a 403 shows
  `fleet.common.adminOnly`, as the budgets admin page does).
- API code: `apps/api` compiles with `strictNullChecks: false` (compare with `===`); raw SQL only through
  `Prisma.sql` with bound parameters; money stays `Prisma.Decimal` until `usd4` in the service.
- API tests: `cd apps/api && bun run test:scoped <paths>`; integration specs need `bun run test:db:up` first. Never
  bare `bun test` at the repo root. A whole integration file failing in under a millisecond with only a
  `loginToken` frame is the login throttle: wait a minute and rerun that file alone.
- E2E resets the `koda_e2e` database (`prisma migrate reset`). Prisma refuses that from an AI agent without the
  user's consent: **ask the user first**, then run with `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION="<their exact consent message>"`.
- No emojis; no `console.log` in `apps/api/src` or `apps/web` sources; build new objects, never mutate inputs.
- Web lint runs with `--max-warnings=0`.
- Every snippet names real files and helpers. If a name in a snippet does not exist in the code, that is a plan
  defect: stop and report it. Do not switch branches; work on `feat/fleet-s2b-analytics-web`.

## Decisions

Numbered from D388 (slice 1b ended at D387).

| # | Decision | Why |
|:--|:--|:--|
| D388 | **Spec addition (§4.2):** three API additions ship in this slice. (a) `top` (1..12, default 12) on both spend routes: how many series to keep before the `other` fold. (b) `totals.medianJobCostUsd`: the median of per-job unrounded spend in the window (mean of the middle two for an even count), 4 places, `null` with no jobs. (c) `GET /projects/:slug/fleet/analytics/ingest?from&to` -> `{window, pending, failed}`: ingest rows of the project's jobs finished in the window, `pending` = status `pending` or `running`, `failed` = `failed`. | §5.2 asks for a median tile and an ingest notice that no slice 1b route can answer for a member; an 8-color palette needs at most 7 named series plus `other`, and folding in the browser would sum rounded strings (A7). |
| D389 | **Spec correction (§5.1):** charts use `@unovis/vue` + `@unovis/ts` directly in two thin wrappers (`SpendAreaChart.client.vue`, `RateLineChart.client.vue`), not shadcn-vue's generated chart components. Bar lists, tiles and tables are plain HTML. | The repo is on `shadcn-nuxt` 0.10 / `radix-vue` with no `components.json`; the current shadcn-vue chart registry targets `reka-ui`. The spec's intent (unovis, themed from the CSS tokens) holds. Plain HTML bars are testable under Jest's node environment and need no client-only guard. |
| D390 | Palette: the dataviz reference palette's 8 categorical hues as `--chart-1`..`--chart-8` under `:root` and `.dark` (dark steps from the same palette), plus `--chart-other` (`#898781`, both modes). The spend chart asks for `top=7`, so it shows at most 7 named series plus `other`. Slots follow the entity, not the rank: `assignSlots` keeps a surviving key's slot across refetches for the page's lifetime. Single-measure bars use `--chart-1`. | Fixed order, never cycled; "color follows the entity, never its rank". |
| D391 | Money text is `usd(s) = "$" + s` for the API's 4-place strings, `"-"` for `null`. Rates show as percentages with one decimal (`pct`), `"-"` for `null`. Token counts use `en-US` grouping. | A7: money is rounded once, by the server. |
| D392 | Window state lives in the URL: `?range=7|30|90` (default 30), or `?from=YYYY-MM-DD&to=YYYY-MM-DD` (custom; `to` is inclusive in the UI and sent as the next day, exclusive); `?group=` holds the spend grouping. A malformed value falls back to the default silently; a custom range with `from` after `to` or longer than 366 days shows an inline message and fetches nothing. The web never sends `bucket` (the server's default applies). | Shareable links; a hand-edited URL never turns into a 400 toast. |
| D393 | Summary tiles: total spend (`totals.costUsd`), jobs (`totals.jobs`), median cost per job (`totals.medianJobCostUsd`), first-pass rate (`quality.firstPassRate`), finish escalations (`quality.finishOutcomes.escalated`). Each tile shows `-` while its source panel is not ready. | Every tile is one API value; nothing is computed in the browser. "Escalations" is the finish outcome count, the only exact count the API has. |
| D394 | "Where it goes" = two more spend calls (`groupBy=stage`, `groupBy=role`, default `top`) shown as bar lists of the series totals, `other` last. | Spec §5.2 lists stage and role; the spend route already returns server-summed series totals. |
| D395 | **Spec correction (§5.3):** the admin page shows cross-project spend only (tiles: spend, jobs, median, cache share; spend over time with `groupBy` defaulting to `project`; where it goes by stage and role) and the ingest health table (status filter, paging, Re-run per row, Backfill, Re-run all with a confirm). Quality and the top tables stay project-only. Delete-on-demand stays API-only (D386 carried; §5.3 lists no delete). | §4.3 ships no admin quality, stories or jobs route. |
| D396 | Job page section: `FleetJobAnalytics` (`components/fleet/JobAnalytics.vue`) renders only once the job analytics response has an `ingest` row. The page passes `reloadKey`, bumped in `reloadSilently` (which every `fleet_job` event for this job reaches; ingest completion publishes one, slice 1a). A failed fetch keeps what is shown, adds an inline message with retry, and never toasts. A small Refresh button runs the same reload. | Spec §5.4 "refreshes on the job's live event"; a live reload must never toast-spam. |
| D397 | Ingest table rows show the job id and project id as text (the ingest list has no slug, D370), the status badge, attempts, error and updated time. No link to the job. | No API change for a link; admins can paste the id into `koda fleet job analytics`. |
| D398 | Crosshair tooltips are built by `crosshairHtml` in `lib/fleet-analytics-chart.ts`, which escapes every label and value: unovis inserts the template as HTML, and group keys (model, feature, story names) come from uploaded bundles. | Untrusted text must never reach `innerHTML` unescaped. |
| D399 | Navigation: one key `nav.fleetAnalytics`. A project link to `/<project>/fleet/analytics` (all members, `BarChart3` icon) after Fleet jobs, an admin link to `/admin/fleet/analytics`, and a breadcrumb leaf `fleet.analytics.title`. | Matches the existing fleet links (`layouts/default.vue`). |
| D400 | E2E: one spec, `apps/web/tests/e2e/fleet-analytics.e2e.spec.ts`. A scripted runner uploads a tar bundle (cost ledger, metrics, review audit, finish escalated) while RUNNING, reports COMPLETED, and the test kicks ingest with `POST /fleet/ingest/jobs/:id/rerun` (otherwise the 30 s sweeper picks it up). Assertions use the job's unique feature name, so retries and other specs cannot change them. | Deterministic, and independent of other specs' data. |
| D401 | The ingest notice on the project page counts the same window as the page; admins get a link to `/admin/fleet/analytics`. | Spec §5.2. |

## Review Focus

1. **A model, feature or story name containing HTML** (`<img src=x onerror=alert(1)>`) uploaded in a bundle: the
   chart tooltip, legend and tables show it as text. Pinned in Task 4 (`crosshairHtml` escapes) and Task 6 (legend
   renders through text interpolation, never `v-html`).
2. **A project with no fleet runs, or a window before any**: tiles show `$0.0000` and `-`, every panel shows its
   empty text, no chart is mounted with zero series, no error toast. Pinned in Task 9 (page) and Task 4
   (`areaRows([])`).
3. **One query failing** (quality answers 500 while spend works): spend, tables and tiles from spend still render;
   only the quality panel and its tiles show the error with a Retry that refetches that panel alone. Pinned in
   Task 9.
4. **A hand-edited URL** (`?range=abc`, `?from=2026-13-40`, `from` after `to`, a two-year custom range,
   `?group=bogus`, `?group=project` on the project page): the page falls back or shows the inline message and never
   sends a request the API rejects. Pinned in Task 3 (`parseRange`, `rangeWindow`, `parseGroup`) and Task 9.
5. **A live reload while ingest is still running or the fetch fails**: the job page section stays as it was (or
   stays hidden), shows an inline retry at most, never toasts, and appears as soon as an ingest row exists. Pinned
   in Task 10.

---

## File Structure

Create (API): none (all changes extend slice 1b files).

Modify (API):

- `apps/api/src/fleet/analytics/domain/analytics.domain.ts` — `jobCostSums`, `ingestHealth`, `IngestHealthRow`.
- `apps/api/src/fleet/analytics/analytics.types.ts` — `SpendInput.top`, `SpendTotalsView.medianJobCostUsd`, `IngestHealthView`.
- `apps/api/src/fleet/analytics/analytics-window.ts` (+ spec) — `medianMoney`.
- `apps/api/src/fleet/analytics/prisma-analytics.repository.ts` — the two reads.
- `apps/api/src/fleet/analytics/analytics.service.ts` (+ spec) — `top`, median, `ingestHealth`.
- `apps/api/src/fleet/analytics/dto/analytics-query.dto.ts`, `dto/analytics-response.dto.ts`.
- `apps/api/src/fleet/analytics/project-fleet-analytics.controller.ts` — `GET analytics/ingest`.
- `apps/api/src/fleet/fleet-openapi.contract.spec.ts`; `openapi.json`, `apps/cli/src/generated/*` (regenerated).
- `apps/api/test/integration/fleet/fleet-analytics-repository.integration.spec.ts`, `fleet-analytics-api.integration.spec.ts`.

Create (web):

- `apps/web/lib/fleet-analytics-types.ts` — wire types (hand-written, the web has no generated client).
- `apps/web/lib/fleet-analytics-format.ts` — `usd`, `pct`, `tokenText`, `bucketLabel`, `axisUsd`.
- `apps/web/lib/fleet-analytics-range.ts` — URL window and group state.
- `apps/web/lib/fleet-analytics-chart.ts` — slots, chart rows, bar rows, tables, escaping, tooltip HTML.
- `apps/web/composables/useFleetAnalytics.ts` — project and admin API calls.
- `apps/web/composables/useAnalyticsPanel.ts` — per-panel load state.
- `apps/web/composables/useRefetchOnVisible.ts` — refetch when the tab becomes visible.
- `apps/web/components/fleet/analytics/`: `Panel.vue`, `BarList.vue`, `SeriesLegend.vue`, `ChartDataTable.vue`,
  `SummaryTiles.vue`, `RangePicker.vue`, `StoryTable.vue`, `JobTable.vue`, `IngestNotice.vue`, `IngestTable.vue`,
  `SpendAreaChart.client.vue`, `RateLineChart.client.vue`.
- `apps/web/components/fleet/JobAnalytics.vue` — the job page section.
- `apps/web/pages/[project]/fleet/analytics.vue`, `apps/web/pages/admin/fleet/analytics.vue`.
- Tests: `tests/lib/fleet-analytics-{format,range,chart,tokens}.spec.ts`, `tests/composables/useAnalyticsPanel.spec.ts`,
  `tests/composables/useFleetAnalytics.spec.ts`, `tests/composables/useRefetchOnVisible.spec.ts`,
  `tests/components/fleet-analytics-components.spec.ts`, `tests/components/fleet-analytics-tables.spec.ts`,
  `tests/components/fleet-analytics-charts.spec.ts`, `tests/components/fleet-job-analytics.spec.ts`,
  `tests/components/fleet-ingest-table.spec.ts`, `tests/pages/fleet-analytics-page.spec.ts`,
  `tests/pages/admin-fleet-analytics.spec.ts`, `tests/e2e/fleet-analytics.e2e.spec.ts`.

Modify (web):

- `apps/web/package.json` (+ root `bun.lock`) — `@unovis/vue`, `@unovis/ts`.
- `apps/web/assets/css/globals.css` — chart and unovis tokens.
- `apps/web/i18n/locales/en.json`, `zh.json` — `nav.fleetAnalytics`, `fleet.analytics.*`.
- `apps/web/tests/i18n/fleet-locale-parity.spec.ts` — `ENUMS` pins.
- `apps/web/tests/helpers/mount-sfc.ts` — `FLEET_COMPONENT_FILES` entries.
- `apps/web/tests/helpers/fleet-harness.ts` — stubs for the new component names.
- `apps/web/layouts/default.vue` (+ `tests/layouts/default-fleet-nav.spec.ts`, `tests/layouts/fleet-jobs-nav.spec.ts`).
- `apps/web/pages/[project]/fleet/jobs/[id]/index.vue` (+ `tests/pages/fleet-job-detail.spec.ts`).

Modify (docs): the spec (D388, D389, D395), `.nax/mono/apps/web/context.md`, `.nax/mono/apps/api/context.md`
(+ `nax generate`).

---

### Task 1: Spend `top` and the median cost per job (API)

**Files:**
- Modify: `apps/api/src/fleet/analytics/domain/analytics.domain.ts`
- Modify: `apps/api/src/fleet/analytics/analytics.types.ts`
- Modify: `apps/api/src/fleet/analytics/analytics-window.ts`, `analytics-window.spec.ts`
- Modify: `apps/api/src/fleet/analytics/prisma-analytics.repository.ts`
- Modify: `apps/api/src/fleet/analytics/analytics.service.ts`, `analytics.service.spec.ts`
- Modify: `apps/api/src/fleet/analytics/dto/analytics-query.dto.ts`, `dto/analytics-response.dto.ts`
- Test: `apps/api/test/integration/fleet/fleet-analytics-repository.integration.spec.ts`, `fleet-analytics-api.integration.spec.ts`

**Interfaces:**
- Consumes: slice 1b `foldSeries(cells, starts, labels, keep)`, `usd4OrNull`, `inScope`, `dec`.
- Produces: `medianMoney(values: readonly Prisma.Decimal[]): Prisma.Decimal | null`;
  `IAnalyticsReadRepository.jobCostSums(scope: AnalyticsScope, from: Date, to: Date): Promise<Prisma.Decimal[]>`;
  `SpendInput.top?: number`; `SpendTotalsView.medianJobCostUsd: string | null`; query param `top` on
  `GET /projects/:slug/fleet/analytics/spend` and `GET /fleet/analytics/spend`.

- [ ] **Step 1: Write the failing unit tests**

In `apps/api/src/fleet/analytics/analytics-window.spec.ts`, change the import line to also import `medianMoney`:

```ts
import { bucketStart, bucketStarts, defaultBucket, medianMoney, normaliseReason, rate4, resolveWindow, usd4, usd4OrNull } from './analytics-window';
```

and append:

```ts
describe('medianMoney', () => {
  const D = (v: string) => new Prisma.Decimal(v);

  it('is null without values', () => {
    expect(medianMoney([])).toBeNull();
  });

  it('takes the middle value of an odd count, whatever the input order', () => {
    expect(medianMoney([D('3'), D('0.00001'), D('2')])?.toFixed(8)).toBe('2.00000000');
  });

  it('averages the middle two of an even count without rounding', () => {
    expect(medianMoney([D('0.00001'), D('0.00002')])?.toFixed(8)).toBe('0.00001500');
  });

  it('does not reorder its input', () => {
    const input = [D('2'), D('1')];
    medianMoney(input);
    expect(input.map((d) => d.toFixed(0))).toEqual(['2', '1']);
  });
});
```

In `apps/api/src/fleet/analytics/analytics.service.spec.ts`:

1. In `fakeRepo`, add after the `spendTotals` line:

```ts
    jobCostSums: jest.fn().mockResolvedValue([]),
```

2. In the test `answers an empty project with zero money, null rates and no series`, change the `totals` expectation
   to:

```ts
      totals: { costUsd: '0.0000', tokens: 0, cacheShare: null, jobs: 0, medianJobCostUsd: null }, series: [],
```

3. In the test `passes the scope and group, labels the series and computes the cache share`, change the totals
   expectation to:

```ts
    expect(s.totals).toEqual({ costUsd: '1.2346', tokens: 495, cacheShare: 0.3333, jobs: 2, medianJobCostUsd: null });
```

4. Append inside the `describe('AnalyticsService', ...)` block:

```ts
  it('reports the median per-job spend rounded once, and folds after `top` series (D388)', async () => {
    const t = new Date('2026-10-01T00:00:00Z');
    const repo = fakeRepo({
      spendCells: jest.fn().mockResolvedValue([
        { key: 'a', t, costUsd: D('3'), tokens: 1 },
        { key: 'b', t, costUsd: D('2'), tokens: 1 },
        { key: 'c', t, costUsd: D('1'), tokens: 1 },
      ]),
      jobCostSums: jest.fn().mockResolvedValue([D('0.00001'), D('0.00002')]),
    });
    const s = await make(repo).spend('p1', { from: '2026-10-01', to: '2026-10-02', top: 2 }, now);
    expect(repo.jobCostSums).toHaveBeenCalledWith({ projectId: 'p1' }, new Date('2026-10-01T00:00:00Z'), new Date('2026-10-02T00:00:00Z'));
    expect(s.totals.medianJobCostUsd).toBe('0.0000');
    expect(s.series.map((x) => [x.key, x.folded, x.costUsd])).toEqual([['a', false, '3.0000'], ['b', false, '2.0000'], ['other', true, '1.0000']]);
  });

  it('keeps 12 series when top is absent', async () => {
    const t = new Date('2026-10-01T00:00:00Z');
    const cells = Array.from({ length: 13 }, (_, i) => ({ key: `k${String(i).padStart(2, '0')}`, t, costUsd: D(String(13 - i)), tokens: 1 }));
    const s = await make(fakeRepo({ spendCells: jest.fn().mockResolvedValue(cells) })).spend('p1', { from: '2026-10-01', to: '2026-10-02' }, now);
    expect(s.series).toHaveLength(13);
    expect(s.series[12]).toMatchObject({ key: 'other', folded: true });
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/api && bun run test:scoped src/fleet/analytics/analytics-window.spec.ts src/fleet/analytics/analytics.service.spec.ts`
Expected: FAIL (`medianMoney` is not exported; `medianJobCostUsd` missing; `top` ignored).

- [ ] **Step 3: Implement the domain, helper, repository and service changes**

In `apps/api/src/fleet/analytics/domain/analytics.domain.ts`, add to `IAnalyticsReadRepository` right after the
`spendTotals(...)` line:

```ts
  /** D388: one unrounded spend sum per job with a cost event in the window (the median's input). */
  jobCostSums(scope: AnalyticsScope, from: Date, to: Date): Promise<Prisma.Decimal[]>;
```

In `apps/api/src/fleet/analytics/analytics.types.ts`:

- in `interface SpendInput extends WindowInput`, add `top?: number;` after `groupBy?: GroupBy;`
- in `interface SpendTotalsView`, add after `jobs: number;`:

```ts
  /** D388: median per-job spend in the window, 4 places; null with no jobs. */
  medianJobCostUsd: string | null;
```

In `apps/api/src/fleet/analytics/analytics-window.ts`, add after `usd4OrNull`:

```ts
/** D388: the median of unrounded values (the mean of the middle two for an even count); null with none. */
export function medianMoney(values: readonly Prisma.Decimal[]): Prisma.Decimal | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a.cmp(b));
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : sorted[mid - 1].add(sorted[mid]).div(2);
}
```

In `apps/api/src/fleet/analytics/prisma-analytics.repository.ts`, add after `spendTotals(...)`:

```ts
  async jobCostSums(scope: AnalyticsScope, from: Date, to: Date): Promise<Prisma.Decimal[]> {
    const rows = await this.db.$queryRaw<Raw[]>(Prisma.sql`
      SELECT SUM(e."costUsd") AS "cost"
      FROM "FleetCostEvent" e
      WHERE e."at" >= ${from} AND e."at" < ${to} ${inScope(scope)}
      GROUP BY e."jobId"`);
    return rows.map((r) => dec(r.cost));
  }
```

In `apps/api/src/fleet/analytics/analytics.service.ts`:

- change the window import to
  `import { bucketStarts, invalidAnalytics, medianMoney, rate4, resolveWindow, usd4, usd4OrNull } from './analytics-window';`
- in `spend(...)`, replace the `const [cells, totals] = await Promise.all([...]);` line with:

```ts
    const [cells, totals, jobSums] = await Promise.all([
      this.repo.spendCells(scope, w, groupBy),
      this.repo.spendTotals(scope, w.from, w.to),
      this.repo.jobCostSums(scope, w.from, w.to),
    ]);
```

- in the returned `totals`, add after `jobs: totals.jobs,`:

```ts
        medianJobCostUsd: usd4OrNull(medianMoney(jobSums)),
```

- replace `series: foldSeries(cells, bucketStarts(w), labels),` with
  `series: foldSeries(cells, bucketStarts(w), labels, q.top ?? ANALYTICS_LIMITS.seriesKeep),`

- [ ] **Step 4: Add `top` to the spend DTOs and the median to the response DTO**

In `apps/api/src/fleet/analytics/dto/analytics-query.dto.ts`, replace the two classes `SpendQuery` and
`AdminSpendQuery` with:

```ts
/** D388: series kept before the rest fold into `other` (the web asks for 7: an 8-color palette). */
export class SpendRangeQuery extends AnalyticsBucketQuery {
  @ApiPropertyOptional({ minimum: 1, maximum: ANALYTICS_LIMITS.seriesKeep, default: ANALYTICS_LIMITS.seriesKeep })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(ANALYTICS_LIMITS.seriesKeep) top?: number;
}

export class SpendQuery extends SpendRangeQuery {
  @ApiPropertyOptional({ enum: PROJECT_GROUPS, default: 'model' })
  @IsOptional() @IsIn([...PROJECT_GROUPS]) groupBy?: ProjectGroupBy;
}

export class AdminSpendQuery extends SpendRangeQuery {
  @ApiPropertyOptional({ enum: ADMIN_GROUPS, default: 'model' })
  @IsOptional() @IsIn([...ADMIN_GROUPS]) groupBy?: GroupBy;
}
```

In `apps/api/src/fleet/analytics/dto/analytics-response.dto.ts`, in `class SpendTotalsDto`, add after the `jobs`
line:

```ts
  @ApiProperty({ type: String, nullable: true, example: '0.1234', description: 'Median per-job spend in the window, 4 places; null with no jobs (D388)' })
  medianJobCostUsd: string | null;
```

and change the `SpendSeriesDto.folded` description to
`'True only for the series that folds every key beyond the top `top` (default 12)'`.

- [ ] **Step 5: Run the unit tests to verify they pass**

Run: `cd apps/api && bun run test:scoped src/fleet/analytics`
Expected: PASS.

- [ ] **Step 6: Write the failing integration tests**

Append inside `describeIntegration('analytics read repository (PG)', ...)` in
`apps/api/test/integration/fleet/fleet-analytics-repository.integration.spec.ts` (after the last `it`):

```ts
  it('sums spend per job for the median, scoped like the totals (D388)', async () => {
    const own = await repo.jobCostSums({ projectId: a.projectId }, w.from, w.to);
    expect(own.map((d) => d.toFixed(8))).toEqual(['0.00012000']);
    const all = (await repo.jobCostSums({ projectId: null }, w.from, w.to)).map((d) => d.toFixed(2)).sort();
    expect(all).toEqual(['0.00', '5.00']);
    expect(await repo.jobCostSums({ projectId: a.projectId }, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-02T00:00:00Z'))).toEqual([]);
  });
```

In `apps/api/test/integration/fleet/fleet-analytics-api.integration.spec.ts`, in the test
`lets any member read spend, money in four places summed before rounding`, change the totals expectation to:

```ts
    expect(s.totals).toEqual({ costUsd: '0.0001', tokens: 330, cacheShare: 0, jobs: 1, medianJobCostUsd: '0.0001' });
```

and add, after that test:

```ts
  it('folds after `top` series and rejects a top outside 1..12 (D388)', async () => {
    const s = data<{ series: Array<{ key: string; folded: boolean; costUsd: string }> }>(await get(`analytics/spend?${WINDOW}&top=1`).expect(200));
    expect(s.series.map((x) => [x.key, x.folded])).toEqual([['m1', false], ['other', true]]);
    await get(`analytics/spend?${WINDOW}&top=0`).expect(400);
    await get(`analytics/spend?${WINDOW}&top=13`).expect(400);
  });
```

- [ ] **Step 7: Run the integration tests**

Run: `cd apps/api && bun run test:db:up && bun run test:scoped test/integration/fleet/fleet-analytics-repository.integration.spec.ts test/integration/fleet/fleet-analytics-api.integration.spec.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/fleet/analytics apps/api/test/integration/fleet/fleet-analytics-repository.integration.spec.ts apps/api/test/integration/fleet/fleet-analytics-api.integration.spec.ts
git commit -m "feat(fleet): spend top and median cost per job (S2b slice 2, D388)"
```

---

### Task 2: Project ingest counts route, OpenAPI and generated client (API)

**Files:**
- Modify: `apps/api/src/fleet/analytics/domain/analytics.domain.ts`
- Modify: `apps/api/src/fleet/analytics/analytics.types.ts`
- Modify: `apps/api/src/fleet/analytics/prisma-analytics.repository.ts`
- Modify: `apps/api/src/fleet/analytics/analytics.service.ts`, `analytics.service.spec.ts`
- Modify: `apps/api/src/fleet/analytics/dto/analytics-response.dto.ts`
- Modify: `apps/api/src/fleet/analytics/project-fleet-analytics.controller.ts`
- Modify: `apps/api/src/fleet/fleet-openapi.contract.spec.ts`
- Regenerate: `openapi.json`, `apps/cli/src/generated/*`
- Test: `apps/api/test/integration/fleet/fleet-analytics-repository.integration.spec.ts`, `fleet-analytics-api.integration.spec.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces: `GET /api/projects/:slug/fleet/analytics/ingest?from&to` -> `{ window: {from, to}, pending: number, failed: number }`
  (project member; agent keys 403); `AnalyticsService.ingestHealth(projectId, q: WindowInput, now)`;
  `IAnalyticsReadRepository.ingestHealth(projectId, from, to): Promise<IngestHealthRow>`.

- [ ] **Step 1: Write the failing unit test**

In `apps/api/src/fleet/analytics/analytics.service.spec.ts`, in `fakeRepo`, add after the `jobCostSums` line:

```ts
    ingestHealth: jest.fn().mockResolvedValue({ pending: 0, failed: 0 }),
```

and append inside the `describe` block:

```ts
  it('counts unfinished and failed ingests of jobs finished in the window (D388)', async () => {
    const repo = fakeRepo({ ingestHealth: jest.fn().mockResolvedValue({ pending: 2, failed: 1 }) });
    const r = await make(repo).ingestHealth('p1', { from: '2026-10-01', to: '2026-10-08' }, now);
    expect(repo.ingestHealth).toHaveBeenCalledWith('p1', new Date('2026-10-01T00:00:00Z'), new Date('2026-10-08T00:00:00Z'));
    expect(r).toEqual({ window: { from: '2026-10-01T00:00:00.000Z', to: '2026-10-08T00:00:00.000Z' }, pending: 2, failed: 1 });
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && bun run test:scoped src/fleet/analytics/analytics.service.spec.ts`
Expected: FAIL (`ingestHealth` is not a function).

- [ ] **Step 3: Implement**

In `apps/api/src/fleet/analytics/domain/analytics.domain.ts`, add before `/** Spec §4.1-4.2: SQL GROUP BY ...`:

```ts
/** D388: ingest rows by status group. */
export interface IngestHealthRow {
  /** pending + running */
  pending: number;
  failed: number;
}
```

and add to `IAnalyticsReadRepository`, after `jobReviews(...)`:

```ts
  /** D388: ingest rows of the project's jobs finished in [from, to). */
  ingestHealth(projectId: string, from: Date, to: Date): Promise<IngestHealthRow>;
```

In `apps/api/src/fleet/analytics/analytics.types.ts`, add after `interface JobsView`:

```ts
export interface IngestHealthView {
  window: WindowView;
  pending: number;
  failed: number;
}
```

In `apps/api/src/fleet/analytics/prisma-analytics.repository.ts`, add `IngestHealthRow` to the domain import list
(keep it alphabetical: after `IAnalyticsRepository`), and add after `jobReviews(...)`:

```ts
  async ingestHealth(projectId: string, from: Date, to: Date): Promise<IngestHealthRow> {
    const [r] = await this.db.$queryRaw<Raw[]>(Prisma.sql`
      SELECT COUNT(*) FILTER (WHERE i."status" IN ('pending', 'running')) AS "pending",
        COUNT(*) FILTER (WHERE i."status" = 'failed') AS "failed"
      FROM "FleetBundleIngest" i JOIN "FleetJob" j ON j."id" = i."jobId"
      WHERE j."projectId" = ${projectId} AND j."finishedAt" >= ${from} AND j."finishedAt" < ${to}`);
    return { pending: num(r.pending), failed: num(r.failed) };
  }
```

In `apps/api/src/fleet/analytics/analytics.service.ts`, add `IngestHealthView` to the `./analytics.types` type
import list, and add after `jobs(...)`:

```ts
  /** D388: the project page's "not yet analysed" notice. */
  async ingestHealth(projectId: string, q: WindowInput, now: Date): Promise<IngestHealthView> {
    const w = resolveWindow({ from: q.from, to: q.to }, now);
    const counts = await this.repo.ingestHealth(projectId, w.from, w.to);
    return { window: windowView(w), ...counts };
  }
```

In `apps/api/src/fleet/analytics/dto/analytics-response.dto.ts`, add `IngestHealthView` to the type import list and
add after `class JobsAnalyticsDto`:

```ts
export class IngestHealthDto implements IngestHealthView {
  @ApiProperty({ type: AnalyticsWindowDto }) window: AnalyticsWindowDto;
  @ApiProperty({ description: 'Ingest rows pending or running, of jobs finished in the window' }) pending: number;
  @ApiProperty({ description: 'Ingest rows that failed after their retries' }) failed: number;
}
```

In `apps/api/src/fleet/analytics/project-fleet-analytics.controller.ts`:

- import `AnalyticsRangeQuery` too:
  `import { AnalyticsBucketQuery, AnalyticsRangeQuery, JobsQuery, SpendQuery, StoriesQuery } from './dto/analytics-query.dto';`
- import `IngestHealthDto` too:
  `import { IngestHealthDto, JobAnalyticsDto, JobsAnalyticsDto, QualityAnalyticsDto, SpendAnalyticsDto, StoriesAnalyticsDto } from './dto/analytics-response.dto';`
- add after the `jobs(...)` handler:

```ts
  @Get('analytics/ingest')
  @ApiOperation({ summary: 'Ingest rows not yet analysed or failed, for jobs finished in a window (project member, D388)' })
  @ApiResponse({ status: 200, type: IngestHealthDto })
  @ApiResponse({ status: 400, description: 'Invalid window' })
  async ingest(@Query() raw: AnalyticsRangeQuery, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    assertUser(principal);
    return JsonResponse.Ok(await this.analytics.ingestHealth(ctx.project.id, parseQuery(AnalyticsRangeQuery, raw), new Date()));
  }
```

- [ ] **Step 4: Run the unit tests**

Run: `cd apps/api && bun run test:scoped src/fleet/analytics`
Expected: PASS.

- [ ] **Step 5: Write the failing integration tests**

Append in `fleet-analytics-repository.integration.spec.ts` (after the Task 1 test):

```ts
  it('counts pending and running as pending, failed apart, by the job finishedAt (D388)', async () => {
    const ownerA = { projectId: a.projectId, repoId: a.repoId, requestedById: a.adminId };
    const inWindow = await insertAnalyticsJob(prisma, ownerA, { finishedAt: new Date('2026-10-03T00:00:00Z') });
    await insertIngestRow(prisma, inWindow, 1, { status: 'pending' });
    await insertIngestRow(prisma, inWindow, 2, { status: 'running' });
    await insertIngestRow(prisma, inWindow, 3, { status: 'failed', error: 'corrupt gzip' });
    const before = await insertAnalyticsJob(prisma, ownerA, { finishedAt: new Date('2026-08-01T00:00:00Z') });
    await insertIngestRow(prisma, before, 1, { status: 'failed' });
    const other = await insertAnalyticsJob(prisma, { projectId: b.projectId, repoId: b.repoId, requestedById: b.adminId });
    await insertIngestRow(prisma, other, 1, { status: 'pending' });
    expect(await repo.ingestHealth(a.projectId, w.from, w.to)).toEqual({ pending: 2, failed: 1 });
  });
```

In `fleet-analytics-api.integration.spec.ts`, add after the Task 1 test:

```ts
  it('answers the ingest counts to members and refuses agent keys (D388)', async () => {
    const r = data<{ window: unknown; pending: number; failed: number }>(await get(`analytics/ingest?${WINDOW}`).expect(200));
    expect(r).toEqual({ window: { from: '2026-09-28T00:00:00.000Z', to: '2026-10-05T00:00:00.000Z' }, pending: 0, failed: 0 });
    await get(`analytics/ingest?${WINDOW}`, 'outsider').expect(403);
    await request(server).get(`${BASE}/analytics/ingest`).set({ Authorization: `Bearer ${agentKey}` }).expect(403);
    await get('analytics/ingest?from=2026-10-05T00:00:00Z&to=2026-10-01T00:00:00Z').expect(400);
  });
```

- [ ] **Step 6: Run the integration tests**

Run: `cd apps/api && bun run test:scoped test/integration/fleet/fleet-analytics-repository.integration.spec.ts test/integration/fleet/fleet-analytics-api.integration.spec.ts`
Expected: PASS.

- [ ] **Step 7: Extend the OpenAPI contract test, regenerate, and verify**

In `apps/api/src/fleet/fleet-openapi.contract.spec.ts`, in the test
`exposes the analytics routes and their response shapes (S2b §4, D377, D382, D383)`:

- change the route loop to `for (const route of ['spend', 'quality', 'stories', 'jobs', 'ingest']) {`
- add at the end of the test:

```ts
    expect(props('SpendTotalsDto')).toEqual(['cacheShare', 'costUsd', 'jobs', 'medianJobCostUsd', 'tokens']);
    expect(props('IngestHealthDto')).toEqual(['failed', 'pending', 'window']);
    const spendParams = (path: string) => (spec.paths[path]?.['get']?.parameters ?? []).map((p) => p.name);
    expect(spendParams('/api/projects/{slug}/fleet/analytics/spend')).toContain('top');
    expect(spendParams('/api/fleet/analytics/spend')).toContain('top');
```

Run (repo root; needs `apps/api/.env`): `bun run generate`
Then: `cd apps/api && bun run test:scoped src/fleet/fleet-openapi.contract.spec.ts` — Expected: PASS.
Then: `cd apps/cli && bun run test -- src/commands/fleet-analytics.spec.ts src/commands/fleet-ingest.spec.ts` — Expected: PASS
(the CLI does not use the new fields; the regenerated types must still compile).

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/fleet apps/api/test/integration/fleet openapi.json apps/cli/src/generated
git commit -m "feat(fleet): project ingest counts route and regenerated client (S2b slice 2, D388)"
```

---
### Task 3: Web foundation — chart dependency, tokens, wire types, money and window state

**Files:**
- Modify: `apps/web/package.json`, root `bun.lock`
- Modify: `apps/web/assets/css/globals.css`
- Create: `apps/web/lib/fleet-analytics-types.ts`
- Create: `apps/web/lib/fleet-analytics-format.ts`
- Create: `apps/web/lib/fleet-analytics-range.ts`
- Test: `apps/web/tests/lib/fleet-analytics-format.spec.ts`, `apps/web/tests/lib/fleet-analytics-range.spec.ts`, `apps/web/tests/lib/fleet-analytics-tokens.spec.ts`

**Interfaces:**
- Consumes: the API shapes of slice 1b plus Task 1-2 (`medianJobCostUsd`, `top`, `IngestHealthDto`).
- Produces (later tasks import these exact names):
  - `lib/fleet-analytics-types.ts`: `AnalyticsBucket`, `ProjectGroupBy`, `AdminGroupBy`, `PROJECT_GROUPS`,
    `ADMIN_GROUPS`, `AnalyticsWindowDto`, `SpendPointDto`, `SpendSeriesDto`, `SpendTotalsDto`, `SpendAnalyticsDto`,
    `ReviewerQualityDto`, `FinishOutcome`, `FINISH_OUTCOMES`, `FinishOutcomesDto`, `QualityAnalyticsDto`,
    `StoryAnalyticsRowDto`, `StoriesAnalyticsDto`, `JobAnalyticsRowDto`, `JobsAnalyticsDto`, `IngestHealthDto`,
    `CostSliceDto`, `IngestStatus`, `INGEST_STATUSES`, `JobIngestDto`, `JobStoryDto`, `JobReviewDto`,
    `JobAnalyticsDto`, `IngestRowDto`, `IngestQueuedDto`.
  - `lib/fleet-analytics-format.ts`: `usd(s: string | null | undefined): string`, `pct(rate: number | null | undefined): string`,
    `tokenText(n: number): string`, `bucketLabel(t: string | number, bucket: AnalyticsBucket): string`, `axisUsd(v: number): string`,
    `ingestVariant(status: string): BadgeVariant`, `timeText(iso: string | null | undefined): string`,
    `skippedFiles(files: Readonly<Record<string, string>>): string`, `type BadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline'`.
  - `lib/fleet-analytics-range.ts`: `RangePreset`, `RangeState`, `DEFAULT_RANGE`, `RANGE_PRESETS`, `MAX_WINDOW_DAYS`,
    `RangeWindow`, `parseRange(query)`, `rangeWindow(state, now)`, `parseGroup(value, allowed, fallback)`,
    `routeQuery(state, group, defaultGroup)`.
  - CSS custom properties `--chart-1`..`--chart-8`, `--chart-other`, and the unovis `--vis-*` variables.

- [ ] **Step 1: Add the chart dependency**

Run (from `apps/web`): `bun add @unovis/vue@^1.7.1 @unovis/ts@^1.7.1`
Expected: both appear under `dependencies` in `apps/web/package.json`; root `bun.lock` changes. Nothing imports
them until Task 7.

- [ ] **Step 2: Write the failing tests**

Create `apps/web/tests/lib/fleet-analytics-format.spec.ts`:

```ts
import { describe, expect, it } from '@jest/globals'
import { axisUsd, bucketLabel, ingestVariant, pct, skippedFiles, timeText, tokenText, usd } from '~/lib/fleet-analytics-format'

describe('usd (A7, D391)', () => {
  it('prefixes the API string unchanged and dashes a missing value', () => {
    expect(usd('0.0044')).toBe('$0.0044')
    expect(usd('12.3400')).toBe('$12.3400')
    expect(usd(null)).toBe('-')
    expect(usd(undefined)).toBe('-')
    expect(usd('')).toBe('-')
  })
})

describe('pct', () => {
  it('shows a rate with one decimal and dashes null or non-finite', () => {
    expect(pct(0.4567)).toBe('45.7%')
    expect(pct(1)).toBe('100.0%')
    expect(pct(0)).toBe('0.0%')
    expect(pct(null)).toBe('-')
    expect(pct(Number.NaN)).toBe('-')
  })
})

describe('tokenText', () => {
  it('groups thousands', () => {
    expect(tokenText(1234567)).toBe('1,234,567')
    expect(tokenText(0)).toBe('0')
  })
})

describe('bucketLabel', () => {
  it('labels day and week buckets MM-DD and month buckets YYYY-MM, in UTC', () => {
    expect(bucketLabel('2026-10-05T00:00:00.000Z', 'day')).toBe('10-05')
    expect(bucketLabel(Date.parse('2026-09-28T00:00:00.000Z'), 'week')).toBe('09-28')
    expect(bucketLabel('2026-10-01T00:00:00.000Z', 'month')).toBe('2026-10')
  })
})

describe('axisUsd', () => {
  it('uses 2 places from a dollar up and 4 below', () => {
    expect(axisUsd(0)).toBe('$0')
    expect(axisUsd(2.5)).toBe('$2.50')
    expect(axisUsd(0.0044)).toBe('$0.0044')
  })
})

describe('ingest helpers', () => {
  it('maps ingest statuses to badge variants, unknown to outline', () => {
    expect(ingestVariant('done')).toBe('secondary')
    expect(ingestVariant('failed')).toBe('destructive')
    expect(ingestVariant('partial')).toBe('outline')
    expect(ingestVariant('constructor')).toBe('outline')
  })

  it('lists only the files that were not done or absent, never the delete marker', () => {
    expect(skippedFiles({ cost: 'done', metrics: 'absent', review: 'skipped:v3', finish: 'capped', deleted: '2026-10-01T00:00:00.000Z' }))
      .toBe('review (skipped:v3), finish (capped)')
    expect(skippedFiles({ cost: 'done' })).toBe('')
  })

  it('dashes a missing time', () => {
    expect(timeText(null)).toBe('-')
    expect(timeText(undefined)).toBe('-')
    expect(timeText('2026-10-05T12:00:00.000Z')).not.toBe('-')
  })
})
```

Create `apps/web/tests/lib/fleet-analytics-range.spec.ts`:

```ts
import { describe, expect, it } from '@jest/globals'
import { DEFAULT_RANGE, parseGroup, parseRange, rangeWindow, routeQuery } from '~/lib/fleet-analytics-range'
import { ADMIN_GROUPS, PROJECT_GROUPS } from '~/lib/fleet-analytics-types'

const now = new Date('2026-10-05T12:00:00.000Z')

describe('parseRange (D392)', () => {
  it('reads a preset, defaulting to 30 days', () => {
    expect(parseRange({})).toEqual(DEFAULT_RANGE)
    expect(parseRange({ range: '7' })).toEqual({ kind: 'preset', days: 7 })
    expect(parseRange({ range: ['90'] })).toEqual({ kind: 'preset', days: 90 })
  })

  it('falls back to the default for anything else', () => {
    expect(parseRange({ range: 'abc' })).toEqual(DEFAULT_RANGE)
    expect(parseRange({ range: '14' })).toEqual(DEFAULT_RANGE)
    expect(parseRange({ range: null })).toEqual(DEFAULT_RANGE)
  })

  it('reads a custom range only when both dates are real calendar dates', () => {
    expect(parseRange({ from: '2026-09-01', to: '2026-09-30' })).toEqual({ kind: 'custom', from: '2026-09-01', to: '2026-09-30' })
    expect(parseRange({ from: '2026-13-40', to: '2026-09-30' })).toEqual(DEFAULT_RANGE)
    expect(parseRange({ from: '2026-02-30', to: '2026-03-01' })).toEqual(DEFAULT_RANGE)
    expect(parseRange({ from: '2026-09-01', range: '7' })).toEqual({ kind: 'preset', days: 7 })
  })
})

describe('rangeWindow (D392)', () => {
  it('turns a preset into the N days ending now', () => {
    expect(rangeWindow({ kind: 'preset', days: 30 }, now)).toEqual({ ok: true, from: '2026-09-05T12:00:00.000Z', to: '2026-10-05T12:00:00.000Z' })
  })

  it('sends a custom end date as the next day, exclusive', () => {
    expect(rangeWindow({ kind: 'custom', from: '2026-09-01', to: '2026-09-30' }, now)).toEqual({ ok: true, from: '2026-09-01', to: '2026-10-01' })
    expect(rangeWindow({ kind: 'custom', from: '2026-09-30', to: '2026-09-30' }, now)).toEqual({ ok: true, from: '2026-09-30', to: '2026-10-01' })
  })

  it('refuses a reversed range and one longer than 366 days', () => {
    expect(rangeWindow({ kind: 'custom', from: '2026-10-02', to: '2026-10-01' }, now)).toEqual({ ok: false })
    expect(rangeWindow({ kind: 'custom', from: '2025-01-01', to: '2026-01-01' }, now).ok).toBe(true)
    expect(rangeWindow({ kind: 'custom', from: '2025-01-01', to: '2026-01-02' }, now)).toEqual({ ok: false })
  })
})

describe('parseGroup', () => {
  it('accepts only the allowed groups', () => {
    expect(parseGroup('stage', PROJECT_GROUPS, 'model')).toBe('stage')
    expect(parseGroup(['feature'], PROJECT_GROUPS, 'model')).toBe('feature')
    expect(parseGroup('project', PROJECT_GROUPS, 'model')).toBe('model')
    expect(parseGroup('project', ADMIN_GROUPS, 'project')).toBe('project')
    expect(parseGroup('bogus', PROJECT_GROUPS, 'model')).toBe('model')
    expect(parseGroup(undefined, PROJECT_GROUPS, 'model')).toBe('model')
  })
})

describe('routeQuery', () => {
  it('omits defaults so the plain URL stays plain', () => {
    expect(routeQuery(DEFAULT_RANGE, 'model', 'model')).toEqual({})
    expect(routeQuery({ kind: 'preset', days: 7 }, 'stage', 'model')).toEqual({ range: '7', group: 'stage' })
    expect(routeQuery({ kind: 'custom', from: '2026-09-01', to: '2026-09-30' }, 'model', 'model')).toEqual({ from: '2026-09-01', to: '2026-09-30' })
  })
})
```

Create `apps/web/tests/lib/fleet-analytics-tokens.spec.ts`:

```ts
import { describe, expect, it } from '@jest/globals'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const css = readFileSync(join(__dirname, '../..', 'assets', 'css', 'globals.css'), 'utf-8')
const darkAt = css.indexOf('.dark {')
const light = css.slice(0, darkAt)
const dark = css.slice(darkAt)

describe('chart tokens (D390)', () => {
  it('defines all 8 categorical slots and other in light and dark', () => {
    for (const name of ['1', '2', '3', '4', '5', '6', '7', '8', 'other']) {
      expect(light).toMatch(new RegExp(`--chart-${name}: #[0-9a-f]{6};`))
      expect(dark).toMatch(new RegExp(`--chart-${name}: #[0-9a-f]{6};`))
    }
  })

  it('uses the dataviz reference steps in their fixed order', () => {
    expect(light).toContain('--chart-1: #2a78d6;')
    expect(light).toContain('--chart-8: #e34948;')
    expect(dark).toContain('--chart-1: #3987e5;')
    expect(dark).toContain('--chart-7: #9085e9;')
  })

  it('themes unovis axes and tooltips from the app tokens', () => {
    expect(light).toContain('--vis-axis-tick-label-color: hsl(var(--muted-foreground));')
    expect(light).toContain('--vis-tooltip-background-color: hsl(var(--popover));')
  })
})
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cd apps/web && bun run test -- tests/lib/fleet-analytics-format.spec.ts tests/lib/fleet-analytics-range.spec.ts tests/lib/fleet-analytics-tokens.spec.ts`
Expected: FAIL (modules not found; tokens missing).

- [ ] **Step 4: Write the wire types**

Create `apps/web/lib/fleet-analytics-types.ts`:

```ts
/**
 * Fleet S2b analytics wire types (hand-written: the web has no generated client). Mirrors
 * apps/api/src/fleet/analytics/analytics.types.ts and the ingest DTOs. Money is a 4-place string (A7).
 */

export type AnalyticsBucket = 'day' | 'week' | 'month'
export type ProjectGroupBy = 'model' | 'stage' | 'role' | 'repo' | 'runner' | 'feature' | 'story'
export type AdminGroupBy = ProjectGroupBy | 'project'
export const PROJECT_GROUPS: readonly ProjectGroupBy[] = ['model', 'stage', 'role', 'repo', 'runner', 'feature', 'story']
export const ADMIN_GROUPS: readonly AdminGroupBy[] = [...PROJECT_GROUPS, 'project']

export interface AnalyticsWindowDto { from: string; to: string }

export interface SpendPointDto { t: string; costUsd: string; tokens: number }

export interface SpendSeriesDto {
  key: string
  label: string
  /** True only for the `other` fold (D377). */
  folded: boolean
  costUsd: string
  tokens: number
  points: SpendPointDto[]
}

export interface SpendTotalsDto {
  costUsd: string
  tokens: number
  cacheShare: number | null
  jobs: number
  medianJobCostUsd: string | null
}

export interface SpendAnalyticsDto {
  window: AnalyticsWindowDto
  bucket: AnalyticsBucket
  groupBy: AdminGroupBy
  totals: SpendTotalsDto
  series: SpendSeriesDto[]
}

export interface ReviewerQualityDto {
  reviewer: string
  runs: number
  passRate: number | null
  findingsBySeverity: Record<string, number>
}

export type FinishOutcome = 'opened' | 'promoted' | 'escalated' | 'skipped' | 'other'
export const FINISH_OUTCOMES: readonly FinishOutcome[] = ['opened', 'promoted', 'escalated', 'skipped', 'other']
export type FinishOutcomesDto = Record<FinishOutcome, number>

export interface QualityAnalyticsDto {
  window: AnalyticsWindowDto
  bucket: AnalyticsBucket
  stories: number
  firstPassRate: number | null
  avgAttempts: number | null
  reviewByReviewer: ReviewerQualityDto[]
  finishOutcomes: FinishOutcomesDto
  topEscalationReasons: Array<{ reason: string; count: number }>
  firstPassSeries: Array<{ t: string; rate: number | null }>
}

export interface StoryAnalyticsRowDto {
  jobId: string
  leaseEpoch: number
  featureName: string
  storyId: string
  attempts: number
  firstPassSuccess: boolean
  success: boolean
  costUsd: string
  completedAt: string | null
}

export interface StoriesAnalyticsDto { window: AnalyticsWindowDto; rows: StoryAnalyticsRowDto[] }

export interface JobAnalyticsRowDto {
  jobId: string
  command: string
  featureName: string
  state: string
  costUsd: string
  ledgerCostUsd: string | null
  driftUsd: string | null
  finishedAt: string | null
}

export interface JobsAnalyticsDto { window: AnalyticsWindowDto; rows: JobAnalyticsRowDto[] }

export interface IngestHealthDto { window: AnalyticsWindowDto; pending: number; failed: number }

export interface CostSliceDto { key: string; costUsd: string; tokens: number }

export type IngestStatus = 'pending' | 'running' | 'done' | 'partial' | 'failed'
export const INGEST_STATUSES: readonly IngestStatus[] = ['pending', 'running', 'done', 'partial', 'failed']

export interface JobIngestDto {
  leaseEpoch: number
  status: IngestStatus
  /** cost, metrics, review, finish -> done | absent | capped | partial | skipped:vN | invalid | oversized; plus `deleted`. */
  files: Record<string, string>
  ingestedAt: string | null
  error: string | null
}

export interface JobStoryDto {
  leaseEpoch: number
  featureName: string
  storyId: string
  attempts: number
  firstPassSuccess: boolean
  success: boolean
  costUsd: string
  durationMs: number | null
  completedAt: string | null
}

export interface JobReviewDto {
  leaseEpoch: number
  storyId: string | null
  reviewer: string
  passed: boolean
  failOpen: boolean
  findingCount: number
  findingsBySeverity: Record<string, number>
  advisoryCount: number
  at: string
}

export interface JobAnalyticsDto {
  jobId: string
  ingest: JobIngestDto | null
  byStage: CostSliceDto[]
  byRole: CostSliceDto[]
  byModel: CostSliceDto[]
  stories: JobStoryDto[]
  reviews: JobReviewDto[]
  liveCostUsd: string | null
  ledgerCostUsd: string | null
  /** The job was corrected COMPLETED -> ESCALATED from its finish-audit (S2b §3.2). */
  corrected: boolean
}

export interface IngestRowDto {
  id: string
  jobId: string
  leaseEpoch: number
  projectId: string
  status: IngestStatus
  attempts: number
  parserVersion: number
  files: Record<string, string>
  error: string | null
  ingestedAt: string | null
  updatedAt: string
}

export interface IngestQueuedDto { queued: number }
```

- [ ] **Step 5: Write the format and range modules**

Create `apps/web/lib/fleet-analytics-format.ts`:

```ts
import type { AnalyticsBucket } from '~/lib/fleet-analytics-types'

/** D391, A7: the API's 4-place money string, unchanged, with a dollar sign; `-` when missing. */
export function usd(s: string | null | undefined): string {
  return s === null || s === undefined || s === '' ? '-' : `$${s}`
}

/** A 0..1 rate as a percentage with one decimal; `-` when null or not a number. */
export function pct(rate: number | null | undefined): string {
  return rate === null || rate === undefined || !Number.isFinite(rate) ? '-' : `${(rate * 100).toFixed(1)}%`
}

const TOKENS = new Intl.NumberFormat('en-US')

export function tokenText(n: number): string {
  return TOKENS.format(n)
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** Locale-neutral bucket text in UTC: `MM-DD` for day and week buckets, `YYYY-MM` for months. */
export function bucketLabel(t: string | number, bucket: AnalyticsBucket): string {
  const d = new Date(t)
  return bucket === 'month'
    ? `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`
    : `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

/** Axis ticks only (geometry, never a shown total): 2 places from a dollar up, 4 below. */
export function axisUsd(v: number): string {
  if (v === 0) return '$0'
  return `$${v.toFixed(Math.abs(v) >= 1 ? 2 : 4)}`
}

export type BadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline'

const INGEST_VARIANTS = new Map<string, BadgeVariant>([
  ['done', 'secondary'], ['partial', 'outline'], ['failed', 'destructive'], ['pending', 'outline'], ['running', 'outline'],
])

/** Ingest status -> Badge variant (a Map: an untrusted status such as `constructor` cannot hit the prototype). */
export function ingestVariant(status: string): BadgeVariant {
  return INGEST_VARIANTS.get(status) ?? 'outline'
}

export function timeText(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString() : '-'
}

/** The bundle files ingest could not fully read (`deleted` is the delete-on-demand marker, D384). */
export function skippedFiles(files: Readonly<Record<string, string>>): string {
  return Object.entries(files)
    .filter(([name, outcome]) => name !== 'deleted' && outcome !== 'done' && outcome !== 'absent')
    .map(([name, outcome]) => `${name} (${outcome})`)
    .join(', ')
}
```

Create `apps/web/lib/fleet-analytics-range.ts`:

```ts
/** D392: the analytics window and grouping live in the URL; malformed values fall back silently. */

export type RangePreset = 7 | 30 | 90
export type RangeState = { kind: 'preset'; days: RangePreset } | { kind: 'custom'; from: string; to: string }
export type RangeWindow = { ok: true; from: string; to: string } | { ok: false }

export const RANGE_PRESETS: readonly RangePreset[] = [7, 30, 90]
export const DEFAULT_RANGE: RangeState = { kind: 'preset', days: 30 }
export const MAX_WINDOW_DAYS = 366

const DAY_MS = 86_400_000
const DATE = /^\d{4}-\d{2}-\d{2}$/

/** A vue-router query value: a string, null, or an array of them. */
function first(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0]
  return undefined
}

/** A real calendar date in YYYY-MM-DD (2026-02-30 is not). */
function isDate(s: string): boolean {
  if (!DATE.test(s)) return false
  const t = Date.parse(`${s}T00:00:00Z`)
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s
}

export function parseRange(query: Readonly<Record<string, unknown>>): RangeState {
  const from = first(query.from)
  const to = first(query.to)
  if (from !== undefined && to !== undefined && isDate(from) && isDate(to)) return { kind: 'custom', from, to }
  const days = Number(first(query.range))
  const preset = RANGE_PRESETS.find((p) => p === days)
  return preset === undefined ? DEFAULT_RANGE : { kind: 'preset', days: preset }
}

/** What the API gets: a preset is the N days ending now; a custom `to` is inclusive here, exclusive on the wire. */
export function rangeWindow(state: RangeState, now: Date): RangeWindow {
  if (state.kind === 'preset') {
    return { ok: true, from: new Date(now.getTime() - state.days * DAY_MS).toISOString(), to: now.toISOString() }
  }
  const from = Date.parse(`${state.from}T00:00:00Z`)
  const toExclusive = Date.parse(`${state.to}T00:00:00Z`) + DAY_MS
  const span = toExclusive - from
  if (!Number.isFinite(span) || span <= 0 || span > MAX_WINDOW_DAYS * DAY_MS) return { ok: false }
  return { ok: true, from: state.from, to: new Date(toExclusive).toISOString().slice(0, 10) }
}

export function parseGroup<G extends string>(value: unknown, allowed: readonly G[], fallback: G): G {
  const v = first(value)
  const match = allowed.find((g) => g === v)
  return match ?? fallback
}

/** The URL query for a state; defaults are omitted. */
export function routeQuery(state: RangeState, group: string, defaultGroup: string): Record<string, string> {
  const range: Record<string, string> = state.kind === 'custom'
    ? { from: state.from, to: state.to }
    : state.days === 30 ? {} : { range: String(state.days) }
  return group === defaultGroup ? range : { ...range, group }
}
```

- [ ] **Step 6: Add the chart tokens**

In `apps/web/assets/css/globals.css`, inside `@layer base`, add at the end of the `:root { ... }` block (after
`--radius: 0.5rem;`):

```css
    /* S2b D390: dataviz reference categorical palette (fixed order), light steps. */
    --chart-1: #2a78d6;
    --chart-2: #eb6834;
    --chart-3: #1baf7a;
    --chart-4: #eda100;
    --chart-5: #e87ba4;
    --chart-6: #008300;
    --chart-7: #4a3aa7;
    --chart-8: #e34948;
    --chart-other: #898781;
    /* unovis reads these; built on the app tokens so .dark follows. */
    --vis-font-family: inherit;
    --vis-axis-font-family: inherit;
    --vis-axis-tick-label-color: hsl(var(--muted-foreground));
    --vis-axis-label-color: hsl(var(--muted-foreground));
    --vis-axis-tick-color: hsl(var(--border));
    --vis-axis-domain-color: hsl(var(--border));
    --vis-axis-grid-color: hsl(var(--border));
    --vis-tooltip-background-color: hsl(var(--popover));
    --vis-tooltip-text-color: hsl(var(--popover-foreground));
    --vis-tooltip-border-color: hsl(var(--border));
    --vis-crosshair-line-stroke-color: hsl(var(--muted-foreground));
```

and at the end of the `.dark { ... }` block:

```css
    /* S2b D390: the same hues stepped for the dark surface. */
    --chart-1: #3987e5;
    --chart-2: #d95926;
    --chart-3: #199e70;
    --chart-4: #c98500;
    --chart-5: #d55181;
    --chart-6: #008300;
    --chart-7: #9085e9;
    --chart-8: #e66767;
    --chart-other: #898781;
```

(`.dark` sits on `<html>`, the same element as `:root`, so the `--vis-*` values recompute from the dark tokens.
Validated 2026-10-05 with the dataviz validator: light on `#ffffff` passes, three slots under 3:1 contrast, so
legends and data tables are required; dark on `#020817` passes every check.)

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd apps/web && bun run test -- tests/lib/fleet-analytics-format.spec.ts tests/lib/fleet-analytics-range.spec.ts tests/lib/fleet-analytics-tokens.spec.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/web/package.json bun.lock apps/web/assets/css/globals.css apps/web/lib/fleet-analytics-types.ts apps/web/lib/fleet-analytics-format.ts apps/web/lib/fleet-analytics-range.ts apps/web/tests/lib/fleet-analytics-format.spec.ts apps/web/tests/lib/fleet-analytics-range.spec.ts apps/web/tests/lib/fleet-analytics-tokens.spec.ts
git commit -m "feat(web): analytics wire types, money and window state, chart tokens (S2b slice 2, D389-D392)"
```

---

### Task 4: Chart model — slots, rows, bars, tables, escaping

**Files:**
- Create: `apps/web/lib/fleet-analytics-chart.ts`
- Test: `apps/web/tests/lib/fleet-analytics-chart.spec.ts`

**Interfaces:**
- Consumes: Task 3 types and `usd`, `pct`, `bucketLabel`.
- Produces:
  - `SLOT_COUNT = 8`, `OTHER_COLOR = 'var(--chart-other)'`, `slotColor(slot: number): string`
  - `assignSlots(prev: ReadonlyMap<string, number>, keys: readonly string[]): Map<string, number>`
  - `interface ChartSeries { key: string; label: string; folded: boolean; color: string; costUsd: string; tokens: number }`
  - `chartSeries(series: readonly SpendSeriesDto[], slots: ReadonlyMap<string, number>, otherLabel: string): ChartSeries[]`
  - `interface AreaRow { t: number; values: number[]; texts: string[] }`, `areaRows(series: readonly SpendSeriesDto[]): AreaRow[]`
  - `interface RateRow { t: number; rate: number | undefined; text: string }`, `rateRows(points: ReadonlyArray<{ t: string; rate: number | null }>): RateRow[]`
  - `interface BarRow { key: string; label: string; value: string; share: number }`
  - `costBars(items: ReadonlyArray<{ key: string; label?: string; costUsd: string; folded?: boolean }>, otherLabel: string): BarRow[]`
  - `countBars(items: ReadonlyArray<{ key: string; label: string; count: number }>): BarRow[]`
  - `rateBars(items: ReadonlyArray<{ key: string; label: string; rate: number | null; detail: string }>): BarRow[]`
  - `interface TableRow { key: string; label: string; cells: string[] }`
  - `spendTableRows(rows: readonly AreaRow[], bucket: AnalyticsBucket): TableRow[]`, `rateTableRows(rows: readonly RateRow[], bucket: AnalyticsBucket): TableRow[]`
  - `escapeHtml(s: string): string`
  - `crosshairHtml(row: AreaRow, series: readonly ChartSeries[], bucket: AnalyticsBucket): string`
  - `rateHtml(row: RateRow, bucket: AnalyticsBucket, label: string): string`

- [ ] **Step 1: Write the failing tests**

Create `apps/web/tests/lib/fleet-analytics-chart.spec.ts`:

```ts
import { describe, expect, it } from '@jest/globals'
import {
  areaRows, assignSlots, chartSeries, costBars, countBars, crosshairHtml, escapeHtml, rateBars, rateHtml, rateRows,
  rateTableRows, slotColor, spendTableRows, OTHER_COLOR,
} from '~/lib/fleet-analytics-chart'
import type { SpendSeriesDto } from '~/lib/fleet-analytics-types'

const T1 = '2026-10-01T00:00:00.000Z'
const T2 = '2026-10-02T00:00:00.000Z'
const series = (key: string, costs: [string, string], over: Partial<SpendSeriesDto> = {}): SpendSeriesDto => ({
  key, label: key, folded: false, costUsd: costs[0], tokens: 10,
  points: [{ t: T1, costUsd: costs[0], tokens: 5 }, { t: T2, costUsd: costs[1], tokens: 5 }], ...over,
})

describe('assignSlots (D390)', () => {
  it('gives new keys the lowest free slots in order', () => {
    expect([...assignSlots(new Map(), ['a', 'b', 'c'])]).toEqual([['a', 0], ['b', 1], ['c', 2]])
  })

  it('keeps a surviving key in its slot when the set changes, and frees the slots of keys that left', () => {
    const first = assignSlots(new Map(), ['a', 'b', 'c'])
    const next = assignSlots(first, ['c', 'd'])
    expect(next.get('c')).toBe(2)
    expect(next.get('d')).toBe(0)
    expect(next.has('a')).toBe(false)
  })

  it('never hands out more than 8 slots and does not mutate its input', () => {
    const prev = new Map([['a', 0]])
    const keys = Array.from({ length: 10 }, (_, i) => `k${i}`)
    const slots = assignSlots(prev, keys)
    expect(new Set(slots.values()).size).toBe(8)
    expect([...prev]).toEqual([['a', 0]])
  })
})

describe('chartSeries', () => {
  it('colors each series by its slot and the fold with the other color and label', () => {
    const slots = new Map([['m2', 3], ['m1', 0]])
    const out = chartSeries([series('m1', ['1.0000', '0']), series('m2', ['2', '0']), series('other', ['0.5000', '0'], { folded: true })], slots, 'Other')
    expect(out.map((s) => [s.key, s.label, s.color])).toEqual([['m1', 'm1', slotColor(0)], ['m2', 'm2', 'var(--chart-4)'], ['other', 'Other', OTHER_COLOR]])
  })
})

describe('areaRows and rateRows', () => {
  it('aligns every series on the bucket times, numbers for geometry and strings for text', () => {
    expect(areaRows([series('a', ['0.0044', '0.0000']), series('b', ['1.5000', '0.2500'])])).toEqual([
      { t: Date.parse(T1), values: [0.0044, 1.5], texts: ['0.0044', '1.5000'] },
      { t: Date.parse(T2), values: [0, 0.25], texts: ['0.0000', '0.2500'] },
    ])
  })

  it('returns no rows without series', () => {
    expect(areaRows([])).toEqual([])
  })

  it('keeps a null rate as a gap', () => {
    expect(rateRows([{ t: T1, rate: 0.5 }, { t: T2, rate: null }])).toEqual([
      { t: Date.parse(T1), rate: 0.5, text: '50.0%' },
      { t: Date.parse(T2), rate: undefined, text: '-' },
    ])
  })
})

describe('bars', () => {
  it('scales cost bars against the largest, labels the fold, keeps the money text unchanged', () => {
    expect(costBars([{ key: 'run', costUsd: '0.1200' }, { key: 'review', costUsd: '0.0300' }, { key: 'other', costUsd: '0.0000', folded: true }], 'Other')).toEqual([
      { key: 'run', label: 'run', value: '$0.1200', share: 1 },
      { key: 'review', label: 'review', value: '$0.0300', share: 0.25 },
      { key: 'other', label: 'Other', value: '$0.0000', share: 0 },
    ])
  })

  it('gives all-zero lists zero widths instead of NaN', () => {
    expect(countBars([{ key: 'opened', label: 'Opened', count: 0 }])).toEqual([{ key: 'opened', label: 'Opened', value: '0', share: 0 }])
  })

  it('uses the rate itself as the width for rate bars', () => {
    expect(rateBars([{ key: 'semantic', label: 'semantic', rate: 0.75, detail: '75.0% of 4' }, { key: 'x', label: 'x', rate: null, detail: '-' }])).toEqual([
      { key: 'semantic', label: 'semantic', value: '75.0% of 4', share: 0.75 },
      { key: 'x', label: 'x', value: '-', share: 0 },
    ])
  })
})

describe('tables', () => {
  it('lists one row per bucket with the money text of each series', () => {
    const rows = areaRows([series('a', ['0.0044', '0.0000'])])
    expect(spendTableRows(rows, 'day')).toEqual([
      { key: String(Date.parse(T1)), label: '10-01', cells: ['$0.0044'] },
      { key: String(Date.parse(T2)), label: '10-02', cells: ['$0.0000'] },
    ])
    expect(rateTableRows(rateRows([{ t: T1, rate: 0.5 }]), 'month')).toEqual([{ key: String(Date.parse(T1)), label: '2026-10', cells: ['50.0%'] }])
  })
})

describe('escaping (D398)', () => {
  it('escapes the five HTML-significant characters', () => {
    expect(escapeHtml(`<img src=x onerror="a('b')"> & co`)).toBe('&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt; &amp; co')
  })

  it('never puts a raw label into the crosshair or rate tooltip', () => {
    const hostile = series('<img src=x onerror=alert(1)>', ['1.0000', '0'])
    const cs = chartSeries([hostile], new Map([[hostile.key, 0]]), 'Other')
    const html = crosshairHtml(areaRows([hostile])[0], cs, 'day')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).toContain('$1.0000')
    expect(html).toContain('10-01')
    expect(rateHtml(rateRows([{ t: T1, rate: 0.5 }])[0], 'day', '<b>x</b>')).toContain('&lt;b&gt;x&lt;/b&gt;')
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/web && bun run test -- tests/lib/fleet-analytics-chart.spec.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

Create `apps/web/lib/fleet-analytics-chart.ts`:

```ts
import { bucketLabel, pct, usd } from '~/lib/fleet-analytics-format'
import type { AnalyticsBucket, SpendSeriesDto } from '~/lib/fleet-analytics-types'

/** D390: the dataviz reference palette has 8 categorical slots (`--chart-1`..`--chart-8`). */
export const SLOT_COUNT = 8
export const OTHER_COLOR = 'var(--chart-other)'

export function slotColor(slot: number): string {
  return `var(--chart-${slot + 1})`
}

/**
 * D390: color follows the entity. Keys still present keep their slot; keys that left free theirs; new keys take
 * the lowest free slot. More keys than slots leave the extra keys unassigned (the spend chart asks for top=7).
 */
export function assignSlots(prev: ReadonlyMap<string, number>, keys: readonly string[]): Map<string, number> {
  const present = new Set(keys)
  const kept = [...prev].filter(([key]) => present.has(key))
  const used = new Set(kept.map(([, slot]) => slot))
  const added: Array<[string, number]> = []
  for (const key of keys) {
    if (prev.has(key) || added.some(([k]) => k === key)) continue
    const free = Array.from({ length: SLOT_COUNT }, (_, i) => i).find((slot) => !used.has(slot))
    if (free === undefined) continue
    used.add(free)
    added.push([key, free])
  }
  return new Map([...kept, ...added])
}

export interface ChartSeries {
  key: string
  label: string
  folded: boolean
  color: string
  costUsd: string
  tokens: number
}

export function chartSeries(series: readonly SpendSeriesDto[], slots: ReadonlyMap<string, number>, otherLabel: string): ChartSeries[] {
  return series.map((s) => ({
    key: s.key,
    label: s.folded ? otherLabel : s.label,
    folded: s.folded,
    color: s.folded ? OTHER_COLOR : slotColor(slots.get(s.key) ?? SLOT_COUNT - 1),
    costUsd: s.costUsd,
    tokens: s.tokens,
  }))
}

/** One stacked-area row per bucket: numbers drive the geometry, the API strings are what text shows (A7). */
export interface AreaRow {
  t: number
  values: number[]
  texts: string[]
}

export function areaRows(series: readonly SpendSeriesDto[]): AreaRow[] {
  const first = series[0]
  if (!first) return []
  return first.points.map((p, i) => {
    const texts = series.map((s) => s.points[i]?.costUsd ?? '0.0000')
    return { t: Date.parse(p.t), values: texts.map((x) => Number(x)), texts }
  })
}

export interface RateRow {
  t: number
  /** undefined draws a gap */
  rate: number | undefined
  text: string
}

export function rateRows(points: ReadonlyArray<{ t: string; rate: number | null }>): RateRow[] {
  return points.map((p) => ({ t: Date.parse(p.t), rate: p.rate === null ? undefined : p.rate, text: pct(p.rate) }))
}

export interface BarRow {
  key: string
  label: string
  value: string
  /** 0..1 bar width */
  share: number
}

function relative(values: readonly number[]): number[] {
  const max = values.reduce((m, v) => (Number.isFinite(v) && v > m ? v : m), 0)
  return values.map((v) => (max > 0 && Number.isFinite(v) && v > 0 ? v / max : 0))
}

export function costBars(
  items: ReadonlyArray<{ key: string; label?: string; costUsd: string; folded?: boolean }>, otherLabel: string,
): BarRow[] {
  const shares = relative(items.map((i) => Number(i.costUsd)))
  return items.map((item, i) => ({
    key: item.key,
    label: item.folded ? otherLabel : (item.label ?? item.key),
    value: usd(item.costUsd),
    share: shares[i] ?? 0,
  }))
}

export function countBars(items: ReadonlyArray<{ key: string; label: string; count: number }>): BarRow[] {
  const shares = relative(items.map((i) => i.count))
  return items.map((item, i) => ({ key: item.key, label: item.label, value: String(item.count), share: shares[i] ?? 0 }))
}

export function rateBars(items: ReadonlyArray<{ key: string; label: string; rate: number | null; detail: string }>): BarRow[] {
  return items.map((item) => ({
    key: item.key,
    label: item.label,
    value: item.detail,
    share: item.rate !== null && Number.isFinite(item.rate) ? Math.min(Math.max(item.rate, 0), 1) : 0,
  }))
}

export interface TableRow {
  key: string
  label: string
  cells: string[]
}

export function spendTableRows(rows: readonly AreaRow[], bucket: AnalyticsBucket): TableRow[] {
  return rows.map((r) => ({ key: String(r.t), label: bucketLabel(r.t, bucket), cells: r.texts.map((x) => usd(x)) }))
}

export function rateTableRows(rows: readonly RateRow[], bucket: AnalyticsBucket): TableRow[] {
  return rows.map((r) => ({ key: String(r.t), label: bucketLabel(r.t, bucket), cells: [r.text] }))
}

const ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

/** D398: unovis inserts tooltip templates as HTML, and group keys come from uploaded bundles. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c)
}

/** Colors are our own `var(--chart-N)` strings, never user text. */
export function crosshairHtml(row: AreaRow, series: readonly ChartSeries[], bucket: AnalyticsBucket): string {
  const lines = series.map((s, i) =>
    `<div><span style="color:${s.color}">&#9632;</span> ${escapeHtml(s.label)}: ${escapeHtml(usd(row.texts[i]))}</div>`)
  return `<div><strong>${escapeHtml(bucketLabel(row.t, bucket))}</strong>${lines.join('')}</div>`
}

export function rateHtml(row: RateRow, bucket: AnalyticsBucket, label: string): string {
  return `<div><strong>${escapeHtml(bucketLabel(row.t, bucket))}</strong><div>${escapeHtml(label)}: ${escapeHtml(row.text)}</div></div>`
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/web && bun run test -- tests/lib/fleet-analytics-chart.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/fleet-analytics-chart.ts apps/web/tests/lib/fleet-analytics-chart.spec.ts
git commit -m "feat(web): analytics chart model with stable slots and escaped tooltips (S2b slice 2, D390, D398)"
```

---

### Task 5: Composables — API calls, panel state, refetch on visible

**Files:**
- Create: `apps/web/composables/useFleetAnalytics.ts`
- Create: `apps/web/composables/useAnalyticsPanel.ts`
- Create: `apps/web/composables/useRefetchOnVisible.ts`
- Test: `apps/web/tests/composables/useFleetAnalytics.spec.ts`, `useAnalyticsPanel.spec.ts`, `useRefetchOnVisible.spec.ts`

**Interfaces:**
- Consumes: `apiPath` (`lib/api-path.ts`), `useApi` (auto-import), `FleetPage` (`lib/fleet-types.ts`), Task 3 types,
  `PollingDeps`/`browserPollingDeps` (`composables/useVisiblePolling.ts`).
- Produces:
  - `interface WindowQuery { from: string; to: string }`
  - `useFleetAnalytics(slug)` -> `{ spend(w, groupBy, top?), quality(w), stories(w, sort, limit), jobs(w, limit), ingest(w), job(jobId) }`
    returning `Promise<SpendAnalyticsDto | QualityAnalyticsDto | StoriesAnalyticsDto | JobsAnalyticsDto | IngestHealthDto | JobAnalyticsDto>`
  - `useFleetAnalyticsAdmin()` -> `{ spend(w, groupBy, top?), ingestList(status, page), backfill(), rerun(jobId), rerunOutdated() }`
  - `ANALYTICS_TABLE_LIMIT = 10`, `INGEST_PAGE_SIZE = 20`, `SPEND_TOP = 7`
  - `type PanelStatus = 'idle' | 'loading' | 'ready' | 'empty' | 'error'`;
    `useAnalyticsPanel<T>(load: () => Promise<T>, isEmpty: (data: T) => boolean)` -> `{ status: Ref<PanelStatus>, data: Ref<T | null>, run(): Promise<void> }`
  - `watchVisible(fn: () => void, deps: Pick<PollingDeps, 'onVisible'>): () => void`; `useRefetchOnVisible(fn: () => void): void`

- [ ] **Step 1: Write the failing tests**

Create `apps/web/tests/composables/useFleetAnalytics.spec.ts`:

```ts
import { describe, expect, jest, test } from '@jest/globals'
import { join } from 'path'

const composablePath = join(__dirname, '../..', 'composables', 'useFleetAnalytics.ts')
const g = globalThis as Record<string, unknown>
const W = { from: '2026-09-05T12:00:00.000Z', to: '2026-10-05T12:00:00.000Z' }

describe('useFleetAnalytics (S2b §4.2, D388)', () => {
  test('project routes encode the slug and send string query values', async () => {
    const get = jest.fn(async () => ({}))
    g.useApi = () => ({ $api: { get } })
    const { useFleetAnalytics } = await import(composablePath)
    const api = useFleetAnalytics('my proj')

    await api.spend(W, 'stage', 7)
    await api.spend(W, 'role')
    await api.quality(W)
    await api.stories(W, 'attempts', 10)
    await api.jobs(W, 10)
    await api.ingest(W)
    await api.job('j/1')

    expect(get.mock.calls).toEqual([
      ['/projects/my%20proj/fleet/analytics/spend', { query: { ...W, groupBy: 'stage', top: '7' } }],
      ['/projects/my%20proj/fleet/analytics/spend', { query: { ...W, groupBy: 'role' } }],
      ['/projects/my%20proj/fleet/analytics/quality', { query: W }],
      ['/projects/my%20proj/fleet/analytics/stories', { query: { ...W, sort: 'attempts', limit: '10' } }],
      ['/projects/my%20proj/fleet/analytics/jobs', { query: { ...W, sort: 'cost', limit: '10' } }],
      ['/projects/my%20proj/fleet/analytics/ingest', { query: W }],
      ['/projects/my%20proj/fleet/jobs/j%2F1/analytics'],
    ])
  })

  test('admin routes: cross-project spend, the ingest list page and the re-ingest actions', async () => {
    const get = jest.fn(async () => ({}))
    const post = jest.fn(async () => ({ queued: 1 }))
    g.useApi = () => ({ $api: { get, post } })
    const { useFleetAnalyticsAdmin } = await import(composablePath)
    const api = useFleetAnalyticsAdmin()

    await api.spend(W, 'project', 7)
    await api.ingestList(undefined, 1)
    await api.ingestList('failed', 3)
    await api.backfill()
    await api.rerun('j/1')
    await api.rerunOutdated()

    expect(get.mock.calls).toEqual([
      ['/fleet/analytics/spend', { query: { ...W, groupBy: 'project', top: '7' } }],
      ['/fleet/ingest', { query: { size: '20' } }],
      ['/fleet/ingest', { query: { size: '20', status: 'failed', current: '3' } }],
    ])
    expect(post.mock.calls).toEqual([['/fleet/ingest/backfill'], ['/fleet/ingest/jobs/j%2F1/rerun'], ['/fleet/ingest/rerun-outdated']])
  })
})
```

Create `apps/web/tests/composables/useAnalyticsPanel.spec.ts`:

```ts
import { describe, expect, test } from '@jest/globals'
import { useAnalyticsPanel } from '~/composables/useAnalyticsPanel'

const deferred = <T>() => {
  let resolve: (v: T) => void = () => undefined
  let reject: (e: unknown) => void = () => undefined
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('useAnalyticsPanel (D393)', () => {
  test('goes loading -> ready, or empty when the data says so', async () => {
    let rows: number[] = [1]
    const panel = useAnalyticsPanel(async () => rows, (d) => d.length === 0)
    expect(panel.status.value).toBe('idle')
    const run = panel.run()
    expect(panel.status.value).toBe('loading')
    await run
    expect(panel.status.value).toBe('ready')
    expect(panel.data.value).toEqual([1])
    rows = []
    await panel.run()
    expect(panel.status.value).toBe('empty')
  })

  test('keeps the old data visible while a refetch loads', async () => {
    const next = deferred<number[]>()
    let calls = 0
    const panel = useAnalyticsPanel(async () => (calls++ === 0 ? [1] : next.promise), () => false)
    await panel.run()
    const again = panel.run()
    expect(panel.status.value).toBe('ready')
    expect(panel.data.value).toEqual([1])
    next.resolve([2])
    await again
    expect(panel.data.value).toEqual([2])
  })

  test('an error clears the data; a stale answer never overwrites a newer one', async () => {
    const slow = deferred<string>()
    const fast = deferred<string>()
    const queue = [slow.promise, fast.promise]
    const panel = useAnalyticsPanel(() => queue.shift() as Promise<string>, () => false)
    const first = panel.run()
    const second = panel.run()
    fast.resolve('new')
    await second
    slow.resolve('old')
    await first
    expect(panel.data.value).toBe('new')

    const failing = useAnalyticsPanel(async () => { throw new Error('500') }, () => false)
    await failing.run()
    expect(failing.status.value).toBe('error')
    expect(failing.data.value).toBeNull()
  })
})
```

Create `apps/web/tests/composables/useRefetchOnVisible.spec.ts`:

```ts
import { describe, expect, jest, test } from '@jest/globals'
import { watchVisible } from '~/composables/useRefetchOnVisible'

describe('watchVisible', () => {
  test('calls back each time the tab becomes visible until unsubscribed', () => {
    const hook: { visible?: () => void } = {}
    const off = jest.fn()
    const onVisible = jest.fn((fn: () => void) => { hook.visible = fn; return off })
    const fn = jest.fn()
    const stop = watchVisible(fn, { onVisible })
    hook.visible?.()
    hook.visible?.()
    expect(fn).toHaveBeenCalledTimes(2)
    stop()
    expect(off).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/web && bun run test -- tests/composables/useFleetAnalytics.spec.ts tests/composables/useAnalyticsPanel.spec.ts tests/composables/useRefetchOnVisible.spec.ts`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement**

Create `apps/web/composables/useFleetAnalytics.ts`:

```ts
import { apiPath } from '~/lib/api-path'
import type {
  IngestHealthDto, IngestQueuedDto, IngestRowDto, IngestStatus, JobAnalyticsDto, JobsAnalyticsDto, QualityAnalyticsDto,
  SpendAnalyticsDto, StoriesAnalyticsDto,
} from '~/lib/fleet-analytics-types'
import type { FleetPage } from '~/lib/fleet-types'

/** The window the API gets (see lib/fleet-analytics-range.ts rangeWindow). */
export interface WindowQuery {
  from: string
  to: string
}

/** D390: 7 named series plus `other` fill the 8-color palette. */
export const SPEND_TOP = 7
/** Rows per top table on the Analytics page. */
export const ANALYTICS_TABLE_LIMIT = 10
export const INGEST_PAGE_SIZE = 20

const topQuery = (top: number | undefined): Record<string, string> => (top === undefined ? {} : { top: String(top) })

/** Fleet S2b §4.2 project routes (any project member). */
export function useFleetAnalytics(slug: string) {
  const { $api } = useApi()
  return {
    spend: (w: WindowQuery, groupBy: string, top?: number) =>
      $api.get<SpendAnalyticsDto>(apiPath`/projects/${slug}/fleet/analytics/spend`, { query: { ...w, groupBy, ...topQuery(top) } }),
    quality: (w: WindowQuery) => $api.get<QualityAnalyticsDto>(apiPath`/projects/${slug}/fleet/analytics/quality`, { query: { ...w } }),
    stories: (w: WindowQuery, sort: 'cost' | 'attempts', limit: number) =>
      $api.get<StoriesAnalyticsDto>(apiPath`/projects/${slug}/fleet/analytics/stories`, { query: { ...w, sort, limit: String(limit) } }),
    jobs: (w: WindowQuery, limit: number) =>
      $api.get<JobsAnalyticsDto>(apiPath`/projects/${slug}/fleet/analytics/jobs`, { query: { ...w, sort: 'cost', limit: String(limit) } }),
    ingest: (w: WindowQuery) => $api.get<IngestHealthDto>(apiPath`/projects/${slug}/fleet/analytics/ingest`, { query: { ...w } }),
    job: (jobId: string) => $api.get<JobAnalyticsDto>(apiPath`/projects/${slug}/fleet/jobs/${jobId}/analytics`),
  }
}

/** Fleet S2b §4.3 admin routes (global ADMIN; anything else answers 403). */
export function useFleetAnalyticsAdmin() {
  const { $api } = useApi()
  return {
    spend: (w: WindowQuery, groupBy: string, top?: number) =>
      $api.get<SpendAnalyticsDto>('/fleet/analytics/spend', { query: { ...w, groupBy, ...topQuery(top) } }),
    ingestList: (status: IngestStatus | undefined, page: number) =>
      $api.get<FleetPage<IngestRowDto>>('/fleet/ingest', {
        query: { size: String(INGEST_PAGE_SIZE), ...(status ? { status } : {}), ...(page > 1 ? { current: String(page) } : {}) },
      }),
    backfill: () => $api.post<IngestQueuedDto>('/fleet/ingest/backfill'),
    rerun: (jobId: string) => $api.post<IngestQueuedDto>(apiPath`/fleet/ingest/jobs/${jobId}/rerun`),
    rerunOutdated: () => $api.post<IngestQueuedDto>('/fleet/ingest/rerun-outdated'),
  }
}
```

Note: `$api.post(path)` with no body is what the test expects (`[path]` only). If `useApi().$api.post`'s signature
requires a body argument at the type level, it does not: it defaults to `{}` (`composables/useApi.ts`).

Create `apps/web/composables/useAnalyticsPanel.ts`:

```ts
import { ref } from 'vue'
import type { Ref } from 'vue'

export type PanelStatus = 'idle' | 'loading' | 'ready' | 'empty' | 'error'

/**
 * D393: one analytics query's state. A refetch keeps the old data on screen (no flicker back to loading); an error
 * clears it; an answer older than the latest run is dropped. The panel reports, the page decides what to show.
 */
export function useAnalyticsPanel<T>(load: () => Promise<T>, isEmpty: (data: T) => boolean) {
  const status = ref<PanelStatus>('idle')
  const data = ref(null) as Ref<T | null>
  let latest = 0

  async function run(): Promise<void> {
    const id = ++latest
    if (data.value === null) status.value = 'loading'
    try {
      const next = await load()
      if (id !== latest) return
      data.value = next
      status.value = isEmpty(next) ? 'empty' : 'ready'
    } catch {
      if (id !== latest) return
      data.value = null
      status.value = 'error'
    }
  }

  return { status, data, run }
}
```

Create `apps/web/composables/useRefetchOnVisible.ts`:

```ts
import { onBeforeUnmount, onMounted } from 'vue'
import { browserPollingDeps } from '~/composables/useVisiblePolling'
import type { PollingDeps } from '~/composables/useVisiblePolling'

/** Calls `fn` whenever the tab becomes visible; returns the unsubscribe. */
export function watchVisible(fn: () => void, deps: Pick<PollingDeps, 'onVisible'>): () => void {
  return deps.onVisible(fn)
}

/** Spec §5.2: refetch on tab focus, no polling. Browser-only (subscribes on mount). */
export function useRefetchOnVisible(fn: () => void): void {
  let stop: (() => void) | null = null
  onMounted(() => {
    if (typeof document === 'undefined') return
    stop = watchVisible(fn, browserPollingDeps())
  })
  onBeforeUnmount(() => {
    stop?.()
    stop = null
  })
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/web && bun run test -- tests/composables/useFleetAnalytics.spec.ts tests/composables/useAnalyticsPanel.spec.ts tests/composables/useRefetchOnVisible.spec.ts tests/lib/api-path-guard.spec.ts`
Expected: PASS (the guard sees only tagged `apiPath` templates and static strings).

- [ ] **Step 5: Commit**

```bash
git add apps/web/composables/useFleetAnalytics.ts apps/web/composables/useAnalyticsPanel.ts apps/web/composables/useRefetchOnVisible.ts apps/web/tests/composables/useFleetAnalytics.spec.ts apps/web/tests/composables/useAnalyticsPanel.spec.ts apps/web/tests/composables/useRefetchOnVisible.spec.ts
git commit -m "feat(web): analytics API composables and per-panel state (S2b slice 2, D393)"
```

---
### Task 6: Locale keys and presentational components (panel, bars, legend, data table, tiles, range picker)

**Files:**
- Modify: `apps/web/i18n/locales/en.json`, `apps/web/i18n/locales/zh.json`
- Modify: `apps/web/tests/i18n/fleet-locale-parity.spec.ts`
- Modify: `apps/web/tests/helpers/mount-sfc.ts`
- Create: `apps/web/components/fleet/analytics/Panel.vue`, `BarList.vue`, `SeriesLegend.vue`, `ChartDataTable.vue`, `SummaryTiles.vue`, `RangePicker.vue`
- Test: `apps/web/tests/components/fleet-analytics-components.spec.ts`

**Interfaces:**
- Consumes: Task 3 (`usd`, `tokenText`, `RANGE_PRESETS`, `RangeState`), Task 4 (`BarRow`, `ChartSeries`, `TableRow`),
  Task 5 (`PanelStatus`).
- Produces (Nuxt names, auto-registered from `components/fleet/analytics/`):
  - `FleetAnalyticsPanel` props `{ title: string; status: PanelStatus; testid: string; emptyText?: string }`, emits `retry`, default slot shown when `ready`.
  - `FleetAnalyticsBarList` props `{ rows: readonly BarRow[]; testid: string; label: string }`.
  - `FleetAnalyticsSeriesLegend` props `{ series: readonly ChartSeries[]; testid: string }`.
  - `FleetAnalyticsChartDataTable` props `{ columns: readonly string[]; rows: readonly TableRow[]; caption: string; testid: string }`.
  - `FleetAnalyticsSummaryTiles` props `{ tiles: ReadonlyArray<{ id: string; label: string; value: string }> }`.
  - `FleetAnalyticsRangePicker` props `{ modelValue: RangeState; invalid?: boolean }`, emits `update:modelValue` with a `RangeState`.
  - `FleetComponentName` gains every `FleetAnalytics*` name used in tests (this task and Tasks 8 and 11 register them all now).
  - Locale keys under `fleet.analytics.*` and `nav.fleetAnalytics` (all the copy this slice uses).

- [ ] **Step 1: Add the locale keys**

In `apps/web/i18n/locales/en.json`, add `"fleetAnalytics": "Fleet analytics"` to `nav` right after
`"fleetApprovals"`, and add this as the last key of the `fleet` object:

```json
"analytics": {
  "title": "Fleet analytics",
  "subtitle": "Where fleet money goes and what it buys.",
  "subtitleAdmin": "Spend across every project, and bundle ingest health.",
  "other": "Other",
  "panelEmpty": "Nothing in this window.",
  "panelError": "Could not load this panel.",
  "empty": "No fleet spend in this window.",
  "range": {
    "label": "Window",
    "d7": "7 days",
    "d30": "30 days",
    "d90": "90 days",
    "custom": "Custom",
    "from": "From",
    "to": "To (inclusive)",
    "apply": "Apply",
    "invalid": "Pick a start date on or before the end date, at most 366 days apart."
  },
  "groupLabel": "Group by",
  "groupBy": {
    "model": "Model",
    "stage": "Stage",
    "role": "Session role",
    "repo": "Repo",
    "runner": "Runner",
    "feature": "Feature",
    "story": "Story",
    "project": "Project"
  },
  "tiles": {
    "spend": "Total spend",
    "jobs": "Jobs",
    "median": "Median cost per job",
    "firstPass": "First-pass rate",
    "escalations": "Finish escalations",
    "cacheShare": "Cache share"
  },
  "panels": {
    "spend": "Spend over time",
    "byStage": "Where it goes: by stage",
    "byRole": "Where it goes: by session role",
    "quality": "Quality",
    "firstPass": "First-pass rate",
    "reviewers": "Review pass rate by reviewer",
    "outcomes": "Finish outcomes",
    "reasons": "Top escalation reasons",
    "expensiveStories": "Most expensive stories",
    "loopingStories": "Most-looping stories",
    "expensiveJobs": "Most expensive jobs"
  },
  "chart": {
    "spendSummary": "Spend over time: {total} in total across {count} groups.",
    "rateSummary": "First-pass rate per bucket: {rate} over the window.",
    "showData": "Show data",
    "bucket": "Bucket",
    "rate": "First-pass rate"
  },
  "legend": {
    "group": "Group",
    "cost": "Cost",
    "tokens": "Tokens"
  },
  "outcome": {
    "opened": "Opened",
    "promoted": "Promoted",
    "escalated": "Escalated",
    "skipped": "Skipped",
    "other": "Other"
  },
  "reviewerDetail": "{rate} of {runs} runs",
  "reasonCount": "{count} jobs",
  "table": {
    "story": "Story",
    "feature": "Feature",
    "attempts": "Attempts",
    "firstPass": "First pass",
    "success": "Success",
    "cost": "Cost",
    "completed": "Completed",
    "job": "Job",
    "command": "Command",
    "state": "State",
    "ledger": "Ledger",
    "drift": "Drift",
    "finished": "Finished",
    "yes": "Yes",
    "no": "No"
  },
  "ingestNotice": "{pending} runs not yet analysed, {failed} failed.",
  "ingestNoticeLink": "Review ingest health",
  "ingestStatus": {
    "pending": "Pending",
    "running": "Running",
    "done": "Done",
    "partial": "Partial",
    "failed": "Failed"
  },
  "ingest": {
    "title": "Bundle ingest",
    "statusFilter": "Status",
    "all": "All statuses",
    "status": "Status",
    "job": "Job",
    "project": "Project",
    "attempts": "Attempts",
    "error": "Error",
    "updated": "Updated",
    "rerun": "Re-run",
    "backfill": "Backfill",
    "rerunOutdated": "Re-run all (parser upgrade)",
    "confirmRerunOutdated": "Re-ingest every bundle read by an older parser?",
    "queued": "Queued {n} bundles.",
    "empty": "No ingest rows.",
    "previous": "Previous",
    "next": "Next",
    "total": "{total} rows"
  },
  "job": {
    "title": "Cost & quality",
    "analysis": "Analysis",
    "files": "Skipped files: {files}",
    "corrected": "Outcome corrected from finish-audit.",
    "liveLedger": "Live {live} / ledger {ledger}",
    "byStage": "By stage",
    "byRole": "By session role",
    "byModel": "By model",
    "stories": "Stories",
    "reviews": "Reviews",
    "reviewer": "Reviewer",
    "passed": "Passed",
    "findings": "Findings",
    "noFindings": "None",
    "refresh": "Refresh",
    "loadFailed": "Could not load the cost breakdown."
  }
}
```

In `apps/web/i18n/locales/zh.json`, add `"fleetAnalytics": "集群分析"` to `nav` right after `"fleetApprovals"`,
and add this as the last key of the `fleet` object (same key set):

```json
"analytics": {
  "title": "集群分析",
  "subtitle": "集群费用的去向与产出。",
  "subtitleAdmin": "所有项目的花费，以及运行包导入状态。",
  "other": "其他",
  "panelEmpty": "此时间范围内没有数据。",
  "panelError": "无法加载此面板。",
  "empty": "此时间范围内没有集群花费。",
  "range": {
    "label": "时间范围",
    "d7": "7 天",
    "d30": "30 天",
    "d90": "90 天",
    "custom": "自定义",
    "from": "开始",
    "to": "结束（含）",
    "apply": "应用",
    "invalid": "开始日期须不晚于结束日期，且间隔不超过 366 天。"
  },
  "groupLabel": "分组",
  "groupBy": {
    "model": "模型",
    "stage": "阶段",
    "role": "会话角色",
    "repo": "仓库",
    "runner": "运行器",
    "feature": "功能",
    "story": "故事",
    "project": "项目"
  },
  "tiles": {
    "spend": "总花费",
    "jobs": "任务数",
    "median": "每个任务的花费中位数",
    "firstPass": "首次通过率",
    "escalations": "收尾升级",
    "cacheShare": "缓存占比"
  },
  "panels": {
    "spend": "花费趋势",
    "byStage": "花费去向：按阶段",
    "byRole": "花费去向：按会话角色",
    "quality": "质量",
    "firstPass": "首次通过率",
    "reviewers": "各评审者的通过率",
    "outcomes": "收尾结果",
    "reasons": "主要升级原因",
    "expensiveStories": "花费最高的故事",
    "loopingStories": "重试最多的故事",
    "expensiveJobs": "花费最高的任务"
  },
  "chart": {
    "spendSummary": "花费趋势：共 {total}，分 {count} 组。",
    "rateSummary": "各时段首次通过率：整个时间范围为 {rate}。",
    "showData": "显示数据",
    "bucket": "时段",
    "rate": "首次通过率"
  },
  "legend": {
    "group": "分组",
    "cost": "花费",
    "tokens": "Token 数"
  },
  "outcome": {
    "opened": "已创建",
    "promoted": "已转为就绪",
    "escalated": "已升级",
    "skipped": "已跳过",
    "other": "其他"
  },
  "reviewerDetail": "{runs} 次中 {rate}",
  "reasonCount": "{count} 个任务",
  "table": {
    "story": "故事",
    "feature": "功能",
    "attempts": "尝试次数",
    "firstPass": "首次通过",
    "success": "成功",
    "cost": "花费",
    "completed": "完成时间",
    "job": "任务",
    "command": "命令",
    "state": "状态",
    "ledger": "账本",
    "drift": "差额",
    "finished": "结束时间",
    "yes": "是",
    "no": "否"
  },
  "ingestNotice": "{pending} 次运行尚未分析，{failed} 次失败。",
  "ingestNoticeLink": "查看导入状态",
  "ingestStatus": {
    "pending": "等待中",
    "running": "进行中",
    "done": "完成",
    "partial": "部分完成",
    "failed": "失败"
  },
  "ingest": {
    "title": "运行包导入",
    "statusFilter": "状态",
    "all": "全部状态",
    "status": "状态",
    "job": "任务",
    "project": "项目",
    "attempts": "尝试次数",
    "error": "错误",
    "updated": "更新时间",
    "rerun": "重新导入",
    "backfill": "回填",
    "rerunOutdated": "全部重新导入（解析器升级）",
    "confirmRerunOutdated": "要重新导入所有由旧版解析器读取的运行包吗？",
    "queued": "已排队 {n} 个运行包。",
    "empty": "没有导入记录。",
    "previous": "上一页",
    "next": "下一页",
    "total": "共 {total} 条"
  },
  "job": {
    "title": "花费与质量",
    "analysis": "分析",
    "files": "跳过的文件：{files}",
    "corrected": "结果已根据 finish-audit 更正。",
    "liveLedger": "实时 {live} / 账本 {ledger}",
    "byStage": "按阶段",
    "byRole": "按会话角色",
    "byModel": "按模型",
    "stories": "故事",
    "reviews": "评审",
    "reviewer": "评审者",
    "passed": "通过",
    "findings": "发现",
    "noFindings": "无",
    "refresh": "刷新",
    "loadFailed": "无法加载花费明细。"
  }
}
```

In `apps/web/tests/i18n/fleet-locale-parity.spec.ts`, add to `ENUMS` after the `'fleet.bash.mode'` line:

```ts
  'fleet.analytics.groupBy': ['model', 'stage', 'role', 'repo', 'runner', 'feature', 'story', 'project'],
  'fleet.analytics.outcome': ['opened', 'promoted', 'escalated', 'skipped', 'other'],
  'fleet.analytics.ingestStatus': ['pending', 'running', 'done', 'partial', 'failed'],
```

Run: `cd apps/web && bun run test -- tests/i18n`
Expected: PASS (parity, no `|`/`@`, enum key sets).

- [ ] **Step 2: Register the analytics components for tests**

In `apps/web/tests/helpers/mount-sfc.ts`, extend the `FleetComponentName` union with a new last line:

```ts
  | 'FleetAnalyticsPanel' | 'FleetAnalyticsBarList' | 'FleetAnalyticsSeriesLegend' | 'FleetAnalyticsChartDataTable'
  | 'FleetAnalyticsSummaryTiles' | 'FleetAnalyticsRangePicker' | 'FleetAnalyticsStoryTable' | 'FleetAnalyticsJobTable'
  | 'FleetAnalyticsIngestNotice' | 'FleetAnalyticsIngestTable'
```

and add to `FLEET_COMPONENT_FILES` (after `FleetJobApprovals: 'JobApprovals.vue',`):

```ts
  FleetAnalyticsPanel: 'analytics/Panel.vue',
  FleetAnalyticsBarList: 'analytics/BarList.vue',
  FleetAnalyticsSeriesLegend: 'analytics/SeriesLegend.vue',
  FleetAnalyticsChartDataTable: 'analytics/ChartDataTable.vue',
  FleetAnalyticsSummaryTiles: 'analytics/SummaryTiles.vue',
  FleetAnalyticsRangePicker: 'analytics/RangePicker.vue',
  FleetAnalyticsStoryTable: 'analytics/StoryTable.vue',
  FleetAnalyticsJobTable: 'analytics/JobTable.vue',
  FleetAnalyticsIngestNotice: 'analytics/IngestNotice.vue',
  FleetAnalyticsIngestTable: 'analytics/IngestTable.vue',
```

(`webFile('components', 'fleet', 'analytics/Panel.vue')` resolves the subdirectory; the files of Tasks 8 and 11 are
only read when a test lists them.)

- [ ] **Step 3: Write the failing component tests**

Create `apps/web/tests/components/fleet-analytics-components.spec.ts`:

```ts
import { describe, expect, it } from '@jest/globals'
import { readdirSync, readFileSync } from 'node:fs'
import { nextTick } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'

const dir = webFile('components', 'fleet', 'analytics')
const file = (name: string): string => webFile('components', 'fleet', 'analytics', name)
const globals = { useI18n: () => enI18n() }
const mount = (name: string, props: Record<string, unknown>) => mountSfc(file(name), { props, components: uiStubs, globals })
const byId = (app: ReturnType<typeof mountSfc>, id: string) => app.find(`[data-testid="${id}"]`)

describe('analytics components never render HTML from data (D398)', () => {
  it('no component in components/fleet/analytics uses v-html', () => {
    for (const name of readdirSync(dir).filter((f) => f.endsWith('.vue'))) {
      expect({ name, vHtml: readFileSync(file(name), 'utf-8').includes('v-html') }).toEqual({ name, vHtml: false })
    }
  })
})

describe('FleetAnalyticsPanel', () => {
  it('shows loading, empty and error states, and asks for a retry', () => {
    expect(byId(mount('Panel.vue', { title: 'Spend', status: 'loading', testid: 'p' }), 'p-loading')).toHaveLength(1)
    const empty = mount('Panel.vue', { title: 'Spend', status: 'empty', testid: 'p', emptyText: 'No spend yet' })
    expect(empty.textOf(byId(empty, 'p-empty')[0])).toBe('No spend yet')
    const failed = mount('Panel.vue', { title: 'Spend', status: 'error', testid: 'p' })
    expect(failed.text()).toContain('Could not load this panel.')
    byId(failed, 'p-retry')[0].props.onClick()
    expect(failed.emitted('retry')).toHaveLength(1)
    const ready = mount('Panel.vue', { title: 'Spend', status: 'ready', testid: 'p' })
    expect(byId(ready, 'p')[0].props['data-status']).toBe('ready')
    expect(byId(ready, 'p-loading')).toHaveLength(0)
  })
})

describe('FleetAnalyticsBarList', () => {
  it('renders label, unchanged value text and width per row', () => {
    const app = mount('BarList.vue', {
      testid: 'bars', label: 'By stage',
      rows: [{ key: 'run', label: 'run', value: '$0.1200', share: 1 }, { key: 'review', label: 'review', value: '$0.0300', share: 0.25 }],
    })
    const rows = byId(app, 'bars-row')
    expect(rows.map((r) => [r.props['data-key'], r.props['data-share']])).toEqual([['run', 1], ['review', 0.25]])
    expect(byId(app, 'bars-value').map((n) => app.textOf(n))).toEqual(['$0.1200', '$0.0300'])
    expect(byId(app, 'bars')[0].props['aria-label']).toBe('By stage')
  })
})

describe('FleetAnalyticsSeriesLegend', () => {
  it('lists every series with money unchanged and shows a hostile label as text', () => {
    const app = mount('SeriesLegend.vue', {
      testid: 'legend',
      series: [
        { key: '<img src=x onerror=alert(1)>', label: '<img src=x onerror=alert(1)>', folded: false, color: 'var(--chart-1)', costUsd: '0.0044', tokens: 1234 },
        { key: 'other', label: 'Other', folded: true, color: 'var(--chart-other)', costUsd: '0.0001', tokens: 5 },
      ],
    })
    const rows = byId(app, 'legend-row')
    expect(rows.map((r) => r.props['data-folded'])).toEqual(['false', 'true'])
    expect(app.text()).toContain('<img src=x onerror=alert(1)>')
    expect(app.text()).toContain('$0.0044')
    expect(app.text()).toContain('1,234')
  })
})

describe('FleetAnalyticsChartDataTable', () => {
  it('renders a captioned table with one row per bucket', () => {
    const app = mount('ChartDataTable.vue', {
      testid: 'data', caption: 'Spend over time', columns: ['m1', 'm1'],
      rows: [{ key: '1', label: '10-01', cells: ['$0.0044', '$0.0000'] }, { key: '2', label: '10-02', cells: ['$0.0000', '$0.0000'] }],
    })
    expect(byId(app, 'data-row')).toHaveLength(2)
    expect(app.text()).toContain('Show data')
    expect(app.text()).toContain('Spend over time')
  })
})

describe('FleetAnalyticsSummaryTiles', () => {
  it('shows each tile value as given', () => {
    const app = mount('SummaryTiles.vue', { tiles: [{ id: 'spend', label: 'Total spend', value: '$0.1334' }, { id: 'median', label: 'Median', value: '-' }] })
    expect(app.textOf(byId(app, 'fleet-analytics-tile-spend')[0])).toContain('$0.1334')
    expect(app.textOf(byId(app, 'fleet-analytics-tile-median')[0])).toContain('-')
  })
})

describe('FleetAnalyticsRangePicker (D392)', () => {
  it('emits a preset and marks the active one', () => {
    const app = mount('RangePicker.vue', { modelValue: { kind: 'preset', days: 30 } })
    expect(byId(app, 'fleet-analytics-range-30')[0].props['aria-pressed']).toBe(true)
    byId(app, 'fleet-analytics-range-7')[0].props.onClick()
    expect(app.emitted('update:modelValue')).toEqual([[{ kind: 'preset', days: 7 }]])
  })

  it('opens the custom inputs and emits both dates on apply', async () => {
    const app = mount('RangePicker.vue', { modelValue: { kind: 'preset', days: 30 } })
    expect(byId(app, 'fleet-analytics-range-from')).toHaveLength(0)
    byId(app, 'fleet-analytics-range-custom')[0].props.onClick()
    await nextTick()
    byId(app, 'fleet-analytics-range-from')[0].props.onInput({ target: { value: '2026-09-01' } })
    byId(app, 'fleet-analytics-range-to')[0].props.onInput({ target: { value: '2026-09-30' } })
    await nextTick()
    byId(app, 'fleet-analytics-range-apply')[0].props.onClick()
    expect(app.emitted('update:modelValue')).toEqual([[{ kind: 'custom', from: '2026-09-01', to: '2026-09-30' }]])
  })

  it('starts open on a custom range and shows the invalid message', () => {
    const app = mount('RangePicker.vue', { modelValue: { kind: 'custom', from: '2026-10-02', to: '2026-10-01' }, invalid: true })
    expect(byId(app, 'fleet-analytics-range-from')[0].props.value).toBe('2026-10-02')
    expect(byId(app, 'fleet-analytics-range-invalid')).toHaveLength(1)
  })
})
```

- [ ] **Step 4: Run them to verify they fail**

Run: `cd apps/web && bun run test -- tests/components/fleet-analytics-components.spec.ts`
Expected: FAIL (`mount-sfc: cannot resolve` / files missing).

- [ ] **Step 5: Write the components**

Create `apps/web/components/fleet/analytics/Panel.vue`:

```vue
<script setup lang="ts">
import type { PanelStatus } from '~/composables/useAnalyticsPanel'

/** D393: one analytics panel; its own loading, empty and error states, so one failure never blanks the page. */
defineProps<{ title: string; status: PanelStatus; testid: string; emptyText?: string }>()
const emit = defineEmits<{ retry: [] }>()
const { t } = useI18n()
</script>

<template>
  <section class="space-y-3 rounded-md border border-border p-4" :data-testid="testid" :data-status="status">
    <h2 class="text-sm font-medium">{{ title }}</h2>
    <p v-if="status === 'loading' || status === 'idle'" class="text-sm text-muted-foreground" :data-testid="`${testid}-loading`">{{ t('common.loading') }}</p>
    <div v-else-if="status === 'error'" class="flex flex-wrap items-center gap-3 text-sm" role="alert" :data-testid="`${testid}-error`">
      <span class="text-destructive">{{ t('fleet.analytics.panelError') }}</span>
      <Button variant="outline" size="sm" :data-testid="`${testid}-retry`" @click="emit('retry')">{{ t('common.retry') }}</Button>
    </div>
    <p v-else-if="status === 'empty'" class="text-sm text-muted-foreground" :data-testid="`${testid}-empty`">{{ emptyText ?? t('fleet.analytics.panelEmpty') }}</p>
    <slot v-else />
  </section>
</template>
```

Create `apps/web/components/fleet/analytics/BarList.vue`:

```vue
<script setup lang="ts">
import type { BarRow } from '~/lib/fleet-analytics-chart'

/** One measure across categories (D390): a single hue, value text beside every bar, the title as tooltip. */
defineProps<{ rows: readonly BarRow[]; testid: string; label: string }>()
</script>

<template>
  <ul class="space-y-2 text-sm" :data-testid="testid" :aria-label="label">
    <li
      v-for="row in rows"
      :key="row.key"
      class="grid grid-cols-[minmax(0,10rem)_1fr_auto] items-center gap-3"
      :title="`${row.label}: ${row.value}`"
      :data-testid="`${testid}-row`"
      :data-key="row.key"
      :data-share="row.share"
    >
      <span class="truncate">{{ row.label }}</span>
      <span class="h-2 rounded-sm bg-muted" aria-hidden="true">
        <span class="block h-2 rounded-sm" :style="{ width: `${Math.round(row.share * 1000) / 10}%`, backgroundColor: 'var(--chart-1)' }" />
      </span>
      <span class="tabular-nums" :data-testid="`${testid}-value`">{{ row.value }}</span>
    </li>
  </ul>
</template>
```

Create `apps/web/components/fleet/analytics/SeriesLegend.vue`:

```vue
<script setup lang="ts">
import type { ChartSeries } from '~/lib/fleet-analytics-chart'
import { tokenText, usd } from '~/lib/fleet-analytics-format'

/** The legend is also the totals table for the spend chart (identity never by color alone). */
defineProps<{ series: readonly ChartSeries[]; testid: string }>()
const { t } = useI18n()
</script>

<template>
  <div class="overflow-x-auto">
    <table class="w-full text-sm" :data-testid="testid">
      <thead>
        <tr class="text-left text-muted-foreground">
          <th scope="col" class="py-1 font-normal">{{ t('fleet.analytics.legend.group') }}</th>
          <th scope="col" class="py-1 text-right font-normal">{{ t('fleet.analytics.legend.cost') }}</th>
          <th scope="col" class="py-1 text-right font-normal">{{ t('fleet.analytics.legend.tokens') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="s in series"
          :key="`${s.folded ? 'fold' : 'key'}:${s.key}`"
          :data-testid="`${testid}-row`"
          :data-key="s.key"
          :data-folded="s.folded ? 'true' : 'false'"
        >
          <td class="py-1 break-all">
            <span class="mr-2 inline-block h-2.5 w-2.5 rounded-sm align-middle" :style="{ backgroundColor: s.color }" aria-hidden="true" />{{ s.label }}
          </td>
          <td class="py-1 text-right tabular-nums">{{ usd(s.costUsd) }}</td>
          <td class="py-1 text-right tabular-nums">{{ tokenText(s.tokens) }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
```

Create `apps/web/components/fleet/analytics/ChartDataTable.vue`:

```vue
<script setup lang="ts">
import type { TableRow } from '~/lib/fleet-analytics-chart'

/** Spec §5.5: every chart's numbers are also available as a table. */
defineProps<{ columns: readonly string[]; rows: readonly TableRow[]; caption: string; testid: string }>()
const { t } = useI18n()
</script>

<template>
  <details class="text-sm" :data-testid="testid">
    <summary class="cursor-pointer text-muted-foreground">{{ t('fleet.analytics.chart.showData') }}</summary>
    <div class="mt-2 overflow-x-auto">
      <table class="w-full">
        <caption class="sr-only">{{ caption }}</caption>
        <thead>
          <tr class="text-muted-foreground">
            <th scope="col" class="py-1 text-left font-normal">{{ t('fleet.analytics.chart.bucket') }}</th>
            <th v-for="(column, i) in columns" :key="i" scope="col" class="py-1 text-right font-normal break-all">{{ column }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.key" :data-testid="`${testid}-row`">
            <th scope="row" class="py-1 text-left font-normal">{{ row.label }}</th>
            <td v-for="(cell, i) in row.cells" :key="i" class="py-1 text-right tabular-nums">{{ cell }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </details>
</template>
```

Create `apps/web/components/fleet/analytics/SummaryTiles.vue`:

```vue
<script setup lang="ts">
/** D393: each tile is one API value, `-` until its panel is ready. */
defineProps<{ tiles: ReadonlyArray<{ id: string; label: string; value: string }> }>()
</script>

<template>
  <dl class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5" data-testid="fleet-analytics-tiles">
    <div v-for="tile in tiles" :key="tile.id" class="rounded-md border border-border p-3" :data-testid="`fleet-analytics-tile-${tile.id}`">
      <dt class="text-xs text-muted-foreground">{{ tile.label }}</dt>
      <dd class="mt-1 text-xl font-semibold">{{ tile.value }}</dd>
    </div>
  </dl>
</template>
```

Create `apps/web/components/fleet/analytics/RangePicker.vue`:

```vue
<script setup lang="ts">
import { ref, watch } from 'vue'
import { RANGE_PRESETS } from '~/lib/fleet-analytics-range'
import type { RangePreset, RangeState } from '~/lib/fleet-analytics-range'

/** D392: presets plus a custom from/to (inclusive). Native date inputs; the page validates the span. */
const props = defineProps<{ modelValue: RangeState; invalid?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: RangeState] }>()
const { t } = useI18n()

const customOpen = ref(props.modelValue.kind === 'custom')
const from = ref(props.modelValue.kind === 'custom' ? props.modelValue.from : '')
const to = ref(props.modelValue.kind === 'custom' ? props.modelValue.to : '')

watch(() => props.modelValue, (value) => {
  if (value.kind !== 'custom') return
  customOpen.value = true
  from.value = value.from
  to.value = value.to
})

const isActive = (days: RangePreset): boolean => props.modelValue.kind === 'preset' && props.modelValue.days === days
const inputValue = (event: Event): string => (event.target as HTMLInputElement | null)?.value ?? ''

function pick(days: RangePreset): void {
  customOpen.value = false
  emit('update:modelValue', { kind: 'preset', days })
}

function onFrom(event: Event): void {
  from.value = inputValue(event)
}

function onTo(event: Event): void {
  to.value = inputValue(event)
}

function apply(): void {
  if (from.value && to.value) emit('update:modelValue', { kind: 'custom', from: from.value, to: to.value })
}
</script>

<template>
  <div class="flex flex-wrap items-end gap-2" role="group" :aria-label="t('fleet.analytics.range.label')" data-testid="fleet-analytics-range">
    <Button
      v-for="days in RANGE_PRESETS"
      :key="days"
      size="sm"
      :variant="isActive(days) ? 'default' : 'outline'"
      :aria-pressed="isActive(days)"
      :data-testid="`fleet-analytics-range-${days}`"
      @click="pick(days)"
    >
      {{ t(`fleet.analytics.range.d${days}`) }}
    </Button>
    <Button
      size="sm"
      :variant="modelValue.kind === 'custom' ? 'default' : 'outline'"
      :aria-pressed="modelValue.kind === 'custom'"
      data-testid="fleet-analytics-range-custom"
      @click="customOpen = !customOpen"
    >
      {{ t('fleet.analytics.range.custom') }}
    </Button>
    <template v-if="customOpen">
      <label class="flex flex-col gap-1 text-xs text-muted-foreground">
        {{ t('fleet.analytics.range.from') }}
        <input type="date" :value="from" class="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground" data-testid="fleet-analytics-range-from" @input="onFrom">
      </label>
      <label class="flex flex-col gap-1 text-xs text-muted-foreground">
        {{ t('fleet.analytics.range.to') }}
        <input type="date" :value="to" class="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground" data-testid="fleet-analytics-range-to" @input="onTo">
      </label>
      <Button size="sm" :disabled="!from || !to" data-testid="fleet-analytics-range-apply" @click="apply()">{{ t('fleet.analytics.range.apply') }}</Button>
    </template>
    <p v-if="invalid" class="w-full text-sm text-destructive" role="alert" data-testid="fleet-analytics-range-invalid">{{ t('fleet.analytics.range.invalid') }}</p>
  </div>
</template>
```

(No `v-model` on the native inputs: the test renderer has no DOM for `vModelText`; `:value` + `@input` behaves the
same in the browser.)

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd apps/web && bun run test -- tests/components/fleet-analytics-components.spec.ts tests/i18n`
Expected: PASS. If `used-keys-exist` reports a missing key, the locale block in Step 1 was not merged into both files.

- [ ] **Step 7: Commit**

```bash
git add apps/web/i18n/locales/en.json apps/web/i18n/locales/zh.json apps/web/tests/i18n/fleet-locale-parity.spec.ts apps/web/tests/helpers/mount-sfc.ts apps/web/components/fleet/analytics apps/web/tests/components/fleet-analytics-components.spec.ts
git commit -m "feat(web): analytics locale keys and presentational components (S2b slice 2, D391-D393)"
```

---

### Task 7: The two chart components (unovis, client-only)

**Files:**
- Create: `apps/web/components/fleet/analytics/SpendAreaChart.client.vue`
- Create: `apps/web/components/fleet/analytics/RateLineChart.client.vue`
- Test: `apps/web/tests/components/fleet-analytics-charts.spec.ts`

**Interfaces:**
- Consumes: Task 4 (`AreaRow`, `ChartSeries`, `RateRow`, `crosshairHtml`, `rateHtml`), Task 3 (`axisUsd`, `bucketLabel`).
- Produces:
  - `FleetAnalyticsSpendAreaChart` props `{ rows: readonly AreaRow[]; series: readonly ChartSeries[]; bucket: AnalyticsBucket; label: string }`
    root `data-testid="fleet-analytics-spend-chart"`.
  - `FleetAnalyticsRateLineChart` props `{ rows: readonly RateRow[]; bucket: AnalyticsBucket; label: string; seriesLabel: string }`
    root `data-testid="fleet-analytics-first-pass-chart"`.
  - Both render nothing on the server (`.client.vue`); Jest never mounts them (`@unovis/*` is ESM and needs a DOM):
    pages are tested with stubs, the charts by source checks here and by the E2E in Task 12.

- [ ] **Step 1: Write the failing source checks**

Create `apps/web/tests/components/fleet-analytics-charts.spec.ts`:

```ts
import { describe, expect, it } from '@jest/globals'
import { readFileSync } from 'node:fs'
import { webFile } from '../helpers/mount-sfc'

const read = (name: string): string => readFileSync(webFile('components', 'fleet', 'analytics', name), 'utf-8')

describe('chart components (D389, D398, spec §5.5)', () => {
  const area = read('SpendAreaChart.client.vue')
  const line = read('RateLineChart.client.vue')

  it('are client-only unovis wrappers with an accessible summary', () => {
    for (const source of [area, line]) {
      expect(source).toContain("from '@unovis/vue'")
      expect(source).toContain('role="img"')
      expect(source).toContain(':aria-label="label"')
      expect(source).not.toContain('v-html')
    }
  })

  it('build every tooltip through the escaping helpers, never from raw labels', () => {
    expect(area).toContain('crosshairHtml(d, props.series, props.bucket)')
    expect(line).toContain('rateHtml(d, props.bucket, props.seriesLabel)')
  })

  it('stack one area per series in its slot color and pin the rate axis to 0..1', () => {
    expect(area).toContain('<VisArea :x="x" :y="y" :color="color" />')
    expect(area).toContain("props.series[i]?.color ?? 'var(--chart-other)'")
    expect(line).toContain(':y-domain="[0, 1]"')
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/web && bun run test -- tests/components/fleet-analytics-charts.spec.ts`
Expected: FAIL (`ENOENT`).

- [ ] **Step 3: Write the chart components**

Create `apps/web/components/fleet/analytics/SpendAreaChart.client.vue`:

```vue
<script setup lang="ts">
import { computed } from 'vue'
import { VisArea, VisAxis, VisCrosshair, VisTooltip, VisXYContainer } from '@unovis/vue'
import { crosshairHtml } from '~/lib/fleet-analytics-chart'
import type { AreaRow, ChartSeries } from '~/lib/fleet-analytics-chart'
import { axisUsd, bucketLabel } from '~/lib/fleet-analytics-format'
import type { AnalyticsBucket } from '~/lib/fleet-analytics-types'

/** Spec §5.1-5.2: stacked spend per group over time. Client-only: unovis needs the DOM. */
const props = defineProps<{ rows: readonly AreaRow[]; series: readonly ChartSeries[]; bucket: AnalyticsBucket; label: string }>()

const data = computed(() => [...props.rows])
const x = (d: AreaRow): number => d.t
const y = computed(() => props.series.map((_, i) => (d: AreaRow): number => d.values[i] ?? 0))
const color = (_d: unknown, i: number): string => props.series[i]?.color ?? 'var(--chart-other)'
const xTick = (v: number): string => bucketLabel(v, props.bucket)
const yTick = (v: number): string => axisUsd(v)
const template = (d: AreaRow): string => crosshairHtml(d, props.series, props.bucket)
</script>

<template>
  <div role="img" :aria-label="label" data-testid="fleet-analytics-spend-chart">
    <VisXYContainer :data="data" :height="240">
      <VisArea :x="x" :y="y" :color="color" />
      <VisAxis type="x" :tick-format="xTick" :num-ticks="6" :grid-line="false" />
      <VisAxis type="y" :tick-format="yTick" :num-ticks="4" />
      <VisCrosshair :template="template" :color="color" />
      <VisTooltip />
    </VisXYContainer>
  </div>
</template>
```

Create `apps/web/components/fleet/analytics/RateLineChart.client.vue`:

```vue
<script setup lang="ts">
import { computed } from 'vue'
import { VisAxis, VisCrosshair, VisLine, VisTooltip, VisXYContainer } from '@unovis/vue'
import { rateHtml } from '~/lib/fleet-analytics-chart'
import type { RateRow } from '~/lib/fleet-analytics-chart'
import { bucketLabel } from '~/lib/fleet-analytics-format'
import type { AnalyticsBucket } from '~/lib/fleet-analytics-types'

/** Spec §5.2: first-pass rate per bucket; a bucket with no stories is a gap. Single series, no legend. */
const props = defineProps<{ rows: readonly RateRow[]; bucket: AnalyticsBucket; label: string; seriesLabel: string }>()

const data = computed(() => [...props.rows])
const x = (d: RateRow): number => d.t
const y = (d: RateRow): number | undefined => d.rate
const xTick = (v: number): string => bucketLabel(v, props.bucket)
const yTick = (v: number): string => `${Math.round(v * 100)}%`
const template = (d: RateRow): string => rateHtml(d, props.bucket, props.seriesLabel)
</script>

<template>
  <div role="img" :aria-label="label" data-testid="fleet-analytics-first-pass-chart">
    <VisXYContainer :data="data" :height="180" :y-domain="[0, 1]">
      <VisLine :x="x" :y="y" color="var(--chart-1)" />
      <VisAxis type="x" :tick-format="xTick" :num-ticks="6" :grid-line="false" />
      <VisAxis type="y" :tick-format="yTick" :num-ticks="3" />
      <VisCrosshair :template="template" color="var(--chart-1)" />
      <VisTooltip />
    </VisXYContainer>
  </div>
</template>
```

- [ ] **Step 4: Run the source checks, the type check and a production build**

Run: `cd apps/web && bun run test -- tests/components/fleet-analytics-charts.spec.ts`
Expected: PASS.

Run: `cd apps/web && bun run type-check`
Expected: no errors. If unovis rejects an accessor type (for example `y` returning `number | undefined`), fix the
accessor's declared type to what the unovis `.d.ts` asks for, without changing behavior (a missing value must
stay a gap).

Run (repo root): `bunx turbo run build --filter=@nathapp/koda-web --force`
Expected: the Nuxt build succeeds. It proves the `.client.vue` charts compile and stay out of the server
bundle. If the server build fails importing `@unovis/*`, add `build: { transpile: ['@unovis/vue', '@unovis/ts'] }`
to `apps/web/nuxt.config.ts` and rebuild. If it still fails, stop and report: do not switch chart libraries.

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/fleet/analytics/SpendAreaChart.client.vue apps/web/components/fleet/analytics/RateLineChart.client.vue apps/web/tests/components/fleet-analytics-charts.spec.ts
git commit -m "feat(web): client-only unovis spend and first-pass charts (S2b slice 2, D389)"
```

(Add `apps/web/nuxt.config.ts` to the commit only if Step 4 needed the transpile entry.)

---

### Task 8: Top tables and the ingest notice

**Files:**
- Create: `apps/web/components/fleet/analytics/StoryTable.vue`, `JobTable.vue`, `IngestNotice.vue`
- Test: `apps/web/tests/components/fleet-analytics-tables.spec.ts`

**Interfaces:**
- Consumes: Task 3 (`usd`, `timeText`, types), `codeLabel` (`lib/fleet-i18n.ts`).
- Produces:
  - `FleetAnalyticsStoryTable` props `{ slug: string; rows: readonly StoryAnalyticsRowDto[]; testid: string }`; rows link to `/<slug>/fleet/jobs/<jobId>`.
  - `FleetAnalyticsJobTable` props `{ slug: string; rows: readonly JobAnalyticsRowDto[]; testid: string }`.
  - `FleetAnalyticsIngestNotice` props `{ pending: number; failed: number; admin: boolean }`; renders nothing when both are 0.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/tests/components/fleet-analytics-tables.spec.ts`:

```ts
import { describe, expect, it } from '@jest/globals'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'

const file = (name: string): string => webFile('components', 'fleet', 'analytics', name)
const mount = (name: string, props: Record<string, unknown>) => mountSfc(file(name), { props, components: uiStubs, globals: { useI18n: () => enI18n() } })
const byId = (app: ReturnType<typeof mountSfc>, id: string) => app.find(`[data-testid="${id}"]`)

describe('FleetAnalyticsStoryTable', () => {
  it('links each story to its job and shows attempts, first pass and unchanged cost', () => {
    const app = mount('StoryTable.vue', {
      slug: 'koda', testid: 'stories',
      rows: [{ jobId: 'j1', leaseEpoch: 1, featureName: 'multiply', storyId: 'US-001', attempts: 3, firstPassSuccess: false, success: true, costUsd: '0.1395', completedAt: null }],
    })
    const row = byId(app, 'stories-row')[0]
    expect(app.find('[data-stub="nuxt-link"]', row)[0].props.to).toBe('/koda/fleet/jobs/j1')
    expect(app.textOf(row)).toContain('US-001')
    expect(app.textOf(row)).toContain('multiply')
    expect(app.textOf(row)).toContain('3')
    expect(app.textOf(row)).toContain('No')
    expect(app.textOf(row)).toContain('$0.1395')
  })
})

describe('FleetAnalyticsJobTable', () => {
  it('shows cost, ledger and drift as given and a dash before ingest', () => {
    const app = mount('JobTable.vue', {
      slug: 'koda', testid: 'jobs',
      rows: [
        { jobId: 'j1', command: 'RUN', featureName: 'substract', state: 'ESCALATED', costUsd: '0.1573', ledgerCostUsd: '0.1573', driftUsd: '0.0000', finishedAt: null },
        { jobId: 'j2', command: 'PLAN', featureName: 'subtract', state: 'COMPLETED', costUsd: '0.0044', ledgerCostUsd: null, driftUsd: null, finishedAt: null },
      ],
    })
    const [first, second] = byId(app, 'jobs-row')
    expect(app.find('[data-stub="nuxt-link"]', first)[0].props.to).toBe('/koda/fleet/jobs/j1')
    expect(app.textOf(first)).toContain('Escalated')
    expect(app.textOf(first)).toContain('$0.1573')
    expect(app.textOf(first)).toContain('$0.0000')
    expect(app.textOf(second)).toContain('-')
  })
})

describe('FleetAnalyticsIngestNotice (D401)', () => {
  it('stays hidden with nothing pending or failed', () => {
    expect(byId(mount('IngestNotice.vue', { pending: 0, failed: 0, admin: true }), 'fleet-analytics-ingest-notice')).toHaveLength(0)
  })

  it('counts both and links admins to ingest health', () => {
    const member = mount('IngestNotice.vue', { pending: 2, failed: 1, admin: false })
    expect(member.text()).toContain('2 runs not yet analysed, 1 failed.')
    expect(byId(member, 'fleet-analytics-ingest-link')).toHaveLength(0)
    const admin = mount('IngestNotice.vue', { pending: 0, failed: 1, admin: true })
    expect(byId(admin, 'fleet-analytics-ingest-link')[0].props.to).toBe('/admin/fleet/analytics')
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/web && bun run test -- tests/components/fleet-analytics-tables.spec.ts`
Expected: FAIL (files missing).

- [ ] **Step 3: Write the components**

Create `apps/web/components/fleet/analytics/StoryTable.vue`:

```vue
<script setup lang="ts">
import { timeText, usd } from '~/lib/fleet-analytics-format'
import type { StoryAnalyticsRowDto } from '~/lib/fleet-analytics-types'

/** Spec §5.2: most expensive / most-looping stories; each row opens its job. */
defineProps<{ slug: string; rows: readonly StoryAnalyticsRowDto[]; testid: string }>()
const { t } = useI18n()
</script>

<template>
  <div class="overflow-x-auto">
    <table class="w-full text-sm" :data-testid="testid">
      <thead>
        <tr class="text-left text-muted-foreground">
          <th scope="col" class="py-1 font-normal">{{ t('fleet.analytics.table.story') }}</th>
          <th scope="col" class="py-1 font-normal">{{ t('fleet.analytics.table.feature') }}</th>
          <th scope="col" class="py-1 text-right font-normal">{{ t('fleet.analytics.table.attempts') }}</th>
          <th scope="col" class="py-1 font-normal">{{ t('fleet.analytics.table.firstPass') }}</th>
          <th scope="col" class="py-1 text-right font-normal">{{ t('fleet.analytics.table.cost') }}</th>
          <th scope="col" class="py-1 font-normal">{{ t('fleet.analytics.table.completed') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="`${row.jobId}:${row.leaseEpoch}:${row.storyId}`" :data-testid="`${testid}-row`">
          <td class="py-1">
            <NuxtLink :to="`/${slug}/fleet/jobs/${row.jobId}`" class="font-mono text-xs text-primary underline-offset-4 hover:underline">{{ row.storyId }}</NuxtLink>
          </td>
          <td class="py-1 break-all">{{ row.featureName }}</td>
          <td class="py-1 text-right tabular-nums">{{ row.attempts }}</td>
          <td class="py-1">{{ row.firstPassSuccess ? t('fleet.analytics.table.yes') : t('fleet.analytics.table.no') }}</td>
          <td class="py-1 text-right tabular-nums">{{ usd(row.costUsd) }}</td>
          <td class="py-1 whitespace-nowrap">{{ timeText(row.completedAt) }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
```

Create `apps/web/components/fleet/analytics/JobTable.vue`:

```vue
<script setup lang="ts">
import { timeText, usd } from '~/lib/fleet-analytics-format'
import type { JobAnalyticsRowDto } from '~/lib/fleet-analytics-types'
import { codeLabel } from '~/lib/fleet-i18n'

/** Spec §5.2, D382: most expensive jobs with the ledger and drift (null before ingest). */
defineProps<{ slug: string; rows: readonly JobAnalyticsRowDto[]; testid: string }>()
const { t, te } = useI18n()
const stateLabel = (state: string): string => codeLabel(t, te, 'fleet.state', state)
</script>

<template>
  <div class="overflow-x-auto">
    <table class="w-full text-sm" :data-testid="testid">
      <thead>
        <tr class="text-left text-muted-foreground">
          <th scope="col" class="py-1 font-normal">{{ t('fleet.analytics.table.job') }}</th>
          <th scope="col" class="py-1 font-normal">{{ t('fleet.analytics.table.command') }}</th>
          <th scope="col" class="py-1 font-normal">{{ t('fleet.analytics.table.state') }}</th>
          <th scope="col" class="py-1 text-right font-normal">{{ t('fleet.analytics.table.cost') }}</th>
          <th scope="col" class="py-1 text-right font-normal">{{ t('fleet.analytics.table.ledger') }}</th>
          <th scope="col" class="py-1 text-right font-normal">{{ t('fleet.analytics.table.drift') }}</th>
          <th scope="col" class="py-1 font-normal">{{ t('fleet.analytics.table.finished') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.jobId" :data-testid="`${testid}-row`" :data-job="row.jobId">
          <td class="py-1 break-all">
            <NuxtLink :to="`/${slug}/fleet/jobs/${row.jobId}`" class="text-primary underline-offset-4 hover:underline">{{ row.featureName }}</NuxtLink>
          </td>
          <td class="py-1">{{ row.command }}</td>
          <td class="py-1">{{ stateLabel(row.state) }}</td>
          <td class="py-1 text-right tabular-nums">{{ usd(row.costUsd) }}</td>
          <td class="py-1 text-right tabular-nums">{{ usd(row.ledgerCostUsd) }}</td>
          <td class="py-1 text-right tabular-nums">{{ usd(row.driftUsd) }}</td>
          <td class="py-1 whitespace-nowrap">{{ timeText(row.finishedAt) }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
```

Create `apps/web/components/fleet/analytics/IngestNotice.vue`:

```vue
<script setup lang="ts">
/** Spec §5.2, D401: runs in this window whose bundles are not analysed yet, or failed to ingest. */
defineProps<{ pending: number; failed: number; admin: boolean }>()
const { t } = useI18n()
</script>

<template>
  <div v-if="pending + failed > 0" class="rounded-md border border-border p-3 text-sm" role="status" data-testid="fleet-analytics-ingest-notice">
    {{ t('fleet.analytics.ingestNotice', { pending, failed }) }}
    <NuxtLink v-if="admin" to="/admin/fleet/analytics" class="ml-2 text-primary underline-offset-4 hover:underline" data-testid="fleet-analytics-ingest-link">
      {{ t('fleet.analytics.ingestNoticeLink') }}
    </NuxtLink>
  </div>
</template>
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/web && bun run test -- tests/components/fleet-analytics-tables.spec.ts tests/components/fleet-analytics-components.spec.ts tests/i18n`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/fleet/analytics/StoryTable.vue apps/web/components/fleet/analytics/JobTable.vue apps/web/components/fleet/analytics/IngestNotice.vue apps/web/tests/components/fleet-analytics-tables.spec.ts
git commit -m "feat(web): analytics top tables and ingest notice (S2b slice 2, D401)"
```

---
### Task 9: Project Analytics page, navigation and breadcrumb

**Files:**
- Create: `apps/web/pages/[project]/fleet/analytics.vue`
- Modify: `apps/web/layouts/default.vue`
- Modify: `apps/web/tests/layouts/fleet-jobs-nav.spec.ts`, `apps/web/tests/layouts/default-fleet-nav.spec.ts`
- Test: `apps/web/tests/pages/fleet-analytics-page.spec.ts`

**Interfaces:**
- Consumes: Tasks 3-8 (every name in their Produces blocks), `FleetNativeSelect` (`components/fleet/NativeSelect.vue`:
  props `modelValue`, `options`, `testid`; emits `update:modelValue`), `PageHeader`, `useAuth` (`auth.user.value.role`).
- Produces: the page at `/<project>/fleet/analytics` with test ids `fleet-analytics-spend`, `fleet-analytics-stage`,
  `fleet-analytics-role`, `fleet-analytics-quality`, `fleet-analytics-costly-stories`, `fleet-analytics-looping-stories`,
  `fleet-analytics-costly-jobs` (panels; `-retry`, `-empty`, `-error` suffixes from `FleetAnalyticsPanel`),
  `fleet-analytics-legend`, `fleet-analytics-stage-bars`, `fleet-analytics-role-bars`, `fleet-analytics-reviewers`,
  `fleet-analytics-outcomes`, `fleet-analytics-reasons`, `fleet-analytics-costly-jobs-table`, `fleet-analytics-group`;
  nav links to `/<project>/fleet/analytics` and `/admin/fleet/analytics`; breadcrumb leaf `fleet.analytics.title`.

- [ ] **Step 1: Write the failing page test**

Create `apps/web/tests/pages/fleet-analytics-page.spec.ts`:

```ts
import { afterEach, describe, expect, jest, test } from '@jest/globals'
import * as Vue from 'vue'
import { computed, h, reactive, ref, watch } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import type { FleetComponentName } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'

const page = webFile('pages', '[project]', 'fleet', 'analytics.vue')
const DAY = 86_400_000
const W = { from: '2026-09-28T00:00:00.000Z', to: '2026-10-05T00:00:00.000Z' }
const point = (costUsd: string) => ({ t: W.from, costUsd, tokens: 1 })

const spendFor = (group: string, empty = false) => ({
  window: W, bucket: 'day', groupBy: group,
  totals: empty
    ? { costUsd: '0.0000', tokens: 0, cacheShare: null, jobs: 0, medianJobCostUsd: null }
    : { costUsd: '0.1334', tokens: 330, cacheShare: 0, jobs: 2, medianJobCostUsd: '0.0667' },
  series: empty ? [] : [
    { key: `${group}-a`, label: `${group}-a`, folded: false, costUsd: '0.1200', tokens: 200, points: [point('0.1200')] },
    { key: 'other', label: 'other', folded: true, costUsd: '0.0134', tokens: 130, points: [point('0.0134')] },
  ],
})
const QUALITY = {
  window: W, bucket: 'day', stories: 4, firstPassRate: 0.75, avgAttempts: 1.5,
  reviewByReviewer: [{ reviewer: 'semantic', runs: 4, passRate: 0.5, findingsBySeverity: { error: 2 } }],
  finishOutcomes: { opened: 1, promoted: 2, escalated: 1, skipped: 0, other: 0 },
  topEscalationReasons: [{ reason: 'review omitted WALK', count: 1 }], firstPassSeries: [{ t: W.from, rate: 0.75 }],
}
const EMPTY_QUALITY = {
  ...QUALITY, stories: 0, firstPassRate: null, avgAttempts: null, reviewByReviewer: [], topEscalationReasons: [],
  finishOutcomes: { opened: 0, promoted: 0, escalated: 0, skipped: 0, other: 0 }, firstPassSeries: [{ t: W.from, rate: null }],
}
const STORY = { jobId: 'j1', leaseEpoch: 1, featureName: 'multiply', storyId: 'US-001', attempts: 3, firstPassSuccess: false, success: true, costUsd: '0.1395', completedAt: null }
const JOB = { jobId: 'j1', command: 'RUN', featureName: 'multiply', state: 'COMPLETED', costUsd: '0.1395', ledgerCostUsd: '0.1582', driftUsd: '0.0187', finishedAt: null }

interface Data {
  spend: (group: string) => unknown
  quality: () => unknown
  stories: unknown
  jobs: unknown
  ingest: unknown
}
const FULL: Data = { spend: (g) => spendFor(g), quality: () => QUALITY, stories: { window: W, rows: [STORY] }, jobs: { window: W, rows: [JOB] }, ingest: { window: W, pending: 2, failed: 1 } }
const EMPTY: Data = { spend: (g) => spendFor(g, true), quality: () => EMPTY_QUALITY, stories: { window: W, rows: [] }, jobs: { window: W, rows: [] }, ingest: { window: W, pending: 0, failed: 0 } }

type Query = Record<string, string>
type Get = jest.Mock<(path: string, opts?: { query?: Query }) => Promise<unknown>>

function makeGet(data: Data): Get {
  return jest.fn(async (path: string, opts?: { query?: Query }) => {
    if (path.endsWith('/analytics/spend')) return data.spend(opts?.query?.groupBy ?? '')
    if (path.endsWith('/analytics/quality')) return data.quality()
    if (path.endsWith('/analytics/stories')) return data.stories
    if (path.endsWith('/analytics/jobs')) return data.jobs
    if (path.endsWith('/analytics/ingest')) return data.ingest
    throw new Error(`unexpected ${path}`)
  }) as Get
}

/** unovis needs a DOM; the page is tested with chart stubs that expose what they were given. */
const chartStub = (stub: string) => ({
  name: `Stub-${stub}`,
  props: ['rows', 'series', 'bucket', 'label', 'seriesLabel'],
  setup(props: { rows?: unknown[]; series?: unknown[]; label?: string }) {
    return () => h('x-stub-stub', { 'data-stub': stub, 'data-series': props.series?.length ?? 0, 'data-rows': props.rows?.length ?? 0, 'aria-label': props.label })
  },
})

const REAL: FleetComponentName[] = [
  'FleetAnalyticsPanel', 'FleetAnalyticsBarList', 'FleetAnalyticsSeriesLegend', 'FleetAnalyticsChartDataTable', 'FleetAnalyticsSummaryTiles',
  'FleetAnalyticsRangePicker', 'FleetAnalyticsStoryTable', 'FleetAnalyticsJobTable', 'FleetAnalyticsIngestNotice', 'FleetNativeSelect',
]

function mountPage(get: Get, query: Record<string, unknown> = {}, role = 'MEMBER') {
  const route = reactive({ params: { project: 'koda' }, query: { ...query } })
  const replace = jest.fn(async (to: { query: Query }) => { route.query = { ...to.query } })
  const hook: { visible?: () => void } = {}
  const app = mountSfc(page, {
    components: { ...uiStubs, FleetAnalyticsSpendAreaChart: chartStub('spend-chart'), FleetAnalyticsRateLineChart: chartStub('rate-chart') },
    fleetComponents: REAL,
    alias: {
      '~/composables/useRefetchOnVisible': { useRefetchOnVisible: (fn: () => void) => { hook.visible = fn }, watchVisible: () => () => undefined },
    },
    globals: {
      ref, computed, watch, onMounted: Vue.onMounted, onBeforeUnmount: Vue.onBeforeUnmount,
      useI18n: () => enI18n(),
      useApi: () => ({ $api: { get } }),
      useRoute: () => route,
      useRouter: () => ({ replace }),
      useAuth: () => ({ user: ref({ role }) }),
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
  const text = (id: string): string => app.textOf(byId(id)[0])
  const status = (id: string): unknown => byId(id)[0]?.props['data-status']
  const calls = (suffix: string) => get.mock.calls.filter(([path]) => path.endsWith(suffix)).map(([, opts]) => opts?.query ?? {})
  return { app, route, replace, settle, byId, text, status, calls, visible: () => hook.visible?.() }
}

describe('project Analytics page (spec §5.2)', () => {
  afterEach(() => jest.clearAllMocks())

  test('loads every panel once for the last 30 days, the main spend with top=7 and no bucket (D388, D392)', async () => {
    const p = mountPage(makeGet(FULL))
    await p.settle()
    const [main, stage, role] = p.calls('/analytics/spend')
    expect(main).toMatchObject({ groupBy: 'model', top: '7' })
    expect(Date.parse(main.to) - Date.parse(main.from)).toBe(30 * DAY)
    expect(main).not.toHaveProperty('bucket')
    expect(stage).toMatchObject({ groupBy: 'stage' })
    expect(stage).not.toHaveProperty('top')
    expect(role).toMatchObject({ groupBy: 'role' })
    expect(p.calls('/analytics/stories').map((q) => [q.sort, q.limit])).toEqual([['cost', '10'], ['attempts', '10']])
    expect(p.calls('/analytics/quality')).toHaveLength(1)
    expect(p.calls('/analytics/jobs')).toEqual([expect.objectContaining({ sort: 'cost', limit: '10' })])
    expect(p.calls('/analytics/ingest')).toHaveLength(1)
    p.app.unmount()
  })

  test('shows the API values unchanged in tiles, chart summary, legend, bars and tables (A7)', async () => {
    const p = mountPage(makeGet(FULL))
    await p.settle()
    expect(p.text('fleet-analytics-tile-spend')).toContain('$0.1334')
    expect(p.text('fleet-analytics-tile-jobs')).toContain('2')
    expect(p.text('fleet-analytics-tile-median')).toContain('$0.0667')
    expect(p.text('fleet-analytics-tile-firstPass')).toContain('75.0%')
    expect(p.text('fleet-analytics-tile-escalations')).toContain('1')
    const chart = p.app.find('[data-stub="spend-chart"]')[0]
    expect(chart.props['data-series']).toBe(2)
    expect(String(chart.props['aria-label'])).toContain('$0.1334')
    expect(p.byId('fleet-analytics-legend-row').map((r) => r.props['data-key'])).toEqual(['model-a', 'other'])
    expect(p.text('fleet-analytics-legend')).toContain('Other')
    expect(p.byId('fleet-analytics-stage-bars-row').map((r) => r.props['data-key'])).toEqual(['stage-a', 'other'])
    expect(p.text('fleet-analytics-reviewers')).toContain('50.0% of 4 runs')
    expect(p.text('fleet-analytics-reasons')).toContain('review omitted WALK')
    expect(p.text('fleet-analytics-costly-stories')).toContain('US-001')
    expect(p.text('fleet-analytics-costly-jobs')).toContain('$0.1582')
    expect(p.text('fleet-analytics-ingest-notice')).toContain('2 runs not yet analysed, 1 failed.')
    expect(p.byId('fleet-analytics-ingest-link')).toHaveLength(0)
    p.app.unmount()
  })

  test('an empty project shows empty panels, zero money, dashes and no chart (Review Focus 2)', async () => {
    const p = mountPage(makeGet(EMPTY))
    await p.settle()
    expect(p.status('fleet-analytics-spend')).toBe('empty')
    expect(p.text('fleet-analytics-spend-empty')).toBe('No fleet spend in this window.')
    expect(p.status('fleet-analytics-stage')).toBe('empty')
    expect(p.status('fleet-analytics-quality')).toBe('empty')
    expect(p.status('fleet-analytics-costly-jobs')).toBe('empty')
    expect(p.app.find('[data-stub="spend-chart"]')).toHaveLength(0)
    expect(p.text('fleet-analytics-tile-spend')).toContain('$0.0000')
    expect(p.text('fleet-analytics-tile-median')).toContain('-')
    expect(p.text('fleet-analytics-tile-firstPass')).toContain('-')
    expect(p.byId('fleet-analytics-ingest-notice')).toHaveLength(0)
    p.app.unmount()
  })

  test('one failing query blanks only its panel and tiles; Retry refetches that panel alone (Review Focus 3)', async () => {
    const state = { failQuality: true }
    const get = makeGet({ ...FULL, quality: () => { if (state.failQuality) throw new Error('500'); return QUALITY } })
    const p = mountPage(get)
    await p.settle()
    expect(p.status('fleet-analytics-quality')).toBe('error')
    expect(p.status('fleet-analytics-spend')).toBe('ready')
    expect(p.text('fleet-analytics-tile-spend')).toContain('$0.1334')
    expect(p.text('fleet-analytics-tile-firstPass')).toContain('-')
    expect(p.text('fleet-analytics-tile-escalations')).toContain('-')
    const spendCalls = p.calls('/analytics/spend').length
    state.failQuality = false
    p.byId('fleet-analytics-quality-retry')[0].props.onClick()
    await p.settle()
    expect(p.status('fleet-analytics-quality')).toBe('ready')
    expect(p.calls('/analytics/quality')).toHaveLength(2)
    expect(p.calls('/analytics/spend')).toHaveLength(spendCalls)
    p.app.unmount()
  })

  test('a hand-edited URL never reaches the API with a bad window (Review Focus 4)', async () => {
    const reversedGet = makeGet(FULL)
    const reversed = mountPage(reversedGet, { from: '2026-10-02', to: '2026-10-01' })
    await reversed.settle()
    expect(reversed.byId('fleet-analytics-range-invalid')).toHaveLength(1)
    expect(reversedGet).not.toHaveBeenCalled()
    reversed.app.unmount()

    const longGet = makeGet(FULL)
    const long = mountPage(longGet, { from: '2024-01-01', to: '2026-01-01' })
    await long.settle()
    expect(longGet).not.toHaveBeenCalled()
    long.app.unmount()

    const junk = mountPage(makeGet(FULL), { range: 'abc', group: 'project', from: '2026-13-40', to: '2026-01-01' })
    await junk.settle()
    const [main] = junk.calls('/analytics/spend')
    expect(main.groupBy).toBe('model')
    expect(Date.parse(main.to) - Date.parse(main.from)).toBe(30 * DAY)
    junk.app.unmount()
  })

  test('a custom range is sent with its end date exclusive', async () => {
    const p = mountPage(makeGet(FULL), { from: '2026-09-01', to: '2026-09-30' })
    await p.settle()
    expect(p.calls('/analytics/quality')).toEqual([{ from: '2026-09-01', to: '2026-10-01' }])
    p.app.unmount()
  })

  test('changing the group rewrites the URL and refetches only the main spend', async () => {
    const p = mountPage(makeGet(FULL))
    await p.settle()
    const before = p.calls('/analytics/spend').length
    p.byId('fleet-analytics-group')[0].props.onChange({ target: { value: 'stage' } })
    expect(p.replace).toHaveBeenCalledWith({ query: { group: 'stage' } })
    await p.settle()
    const after = p.calls('/analytics/spend')
    expect(after).toHaveLength(before + 1)
    expect(after[after.length - 1]).toMatchObject({ groupBy: 'stage', top: '7' })
    expect(p.calls('/analytics/quality')).toHaveLength(1)
    p.app.unmount()
  })

  test('picking a range refetches every panel; the tab becoming visible refetches too (no polling)', async () => {
    const p = mountPage(makeGet(FULL))
    await p.settle()
    p.byId('fleet-analytics-range-7')[0].props.onClick()
    expect(p.replace).toHaveBeenCalledWith({ query: { range: '7' } })
    await p.settle()
    expect(p.calls('/analytics/quality')).toHaveLength(2)
    const last = p.calls('/analytics/quality')[1]
    expect(Date.parse(last.to) - Date.parse(last.from)).toBe(7 * DAY)
    p.visible()
    await p.settle()
    expect(p.calls('/analytics/quality')).toHaveLength(3)
    p.app.unmount()
  })

  test('admins get a link from the ingest notice to ingest health (D401)', async () => {
    const p = mountPage(makeGet(FULL), {}, 'ADMIN')
    await p.settle()
    expect(p.byId('fleet-analytics-ingest-link')[0].props.to).toBe('/admin/fleet/analytics')
    p.app.unmount()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/web && bun run test -- tests/pages/fleet-analytics-page.spec.ts`
Expected: FAIL (`mount-sfc: cannot resolve` the page).

- [ ] **Step 3: Write the page**

Create `apps/web/pages/[project]/fleet/analytics.vue`:

```vue
<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, watch } from 'vue'
import { useAnalyticsPanel } from '~/composables/useAnalyticsPanel'
import { ANALYTICS_TABLE_LIMIT, SPEND_TOP, useFleetAnalytics } from '~/composables/useFleetAnalytics'
import type { WindowQuery } from '~/composables/useFleetAnalytics'
import { useRefetchOnVisible } from '~/composables/useRefetchOnVisible'
import {
  areaRows, assignSlots, chartSeries, costBars, countBars, rateBars, rateRows, rateTableRows, spendTableRows,
} from '~/lib/fleet-analytics-chart'
import { pct, usd } from '~/lib/fleet-analytics-format'
import { parseGroup, parseRange, rangeWindow, routeQuery } from '~/lib/fleet-analytics-range'
import type { RangeState } from '~/lib/fleet-analytics-range'
import { FINISH_OUTCOMES, PROJECT_GROUPS } from '~/lib/fleet-analytics-types'
import type { ProjectGroupBy, QualityAnalyticsDto } from '~/lib/fleet-analytics-types'

definePageMeta({ layout: 'default' })

/** Fleet S2b spec §5.2: where the money goes and what it buys, for one project and one window. */
const DEFAULT_GROUP: ProjectGroupBy = 'model'

const route = useRoute()
const router = useRouter()
const { t } = useI18n()
const auth = useAuth()
const slug = route.params.project as string
const api = useFleetAnalytics(slug)

const range = computed(() => parseRange(route.query))
const group = computed(() => parseGroup(route.query.group, PROJECT_GROUPS, DEFAULT_GROUP))
const groupOptions = computed(() => PROJECT_GROUPS.map((g) => ({ value: g, label: t(`fleet.analytics.groupBy.${g}`) })))
const win = ref<WindowQuery | null>(null)
const invalidRange = ref(false)
const isAdmin = computed(() => auth.user.value?.role === 'ADMIN')

/** Panels run only after refreshAll set a valid window. */
function current(): WindowQuery {
  if (win.value === null) throw new Error('analytics window not set')
  return win.value
}

const noSeries = (d: { series: unknown[] }): boolean => d.series.length === 0
const noRows = (d: { rows: unknown[] }): boolean => d.rows.length === 0
const noQuality = (d: QualityAnalyticsDto): boolean =>
  d.stories === 0 && d.reviewByReviewer.length === 0 && d.topEscalationReasons.length === 0
  && FINISH_OUTCOMES.every((k) => d.finishOutcomes[k] === 0)

const spend = useAnalyticsPanel(() => api.spend(current(), group.value, SPEND_TOP), noSeries)
const byStage = useAnalyticsPanel(() => api.spend(current(), 'stage'), noSeries)
const byRole = useAnalyticsPanel(() => api.spend(current(), 'role'), noSeries)
const quality = useAnalyticsPanel(() => api.quality(current()), noQuality)
const costlyStories = useAnalyticsPanel(() => api.stories(current(), 'cost', ANALYTICS_TABLE_LIMIT), noRows)
const loopingStories = useAnalyticsPanel(() => api.stories(current(), 'attempts', ANALYTICS_TABLE_LIMIT), noRows)
const costlyJobs = useAnalyticsPanel(() => api.jobs(current(), ANALYTICS_TABLE_LIMIT), noRows)
const ingest = useAnalyticsPanel(() => api.ingest(current()), () => false)
const panels = [spend, byStage, byRole, quality, costlyStories, loopingStories, costlyJobs, ingest]

/** D392: recompute the window (a preset ends now) and refetch every panel; an invalid custom range fetches nothing. */
function refreshAll(): void {
  const next = rangeWindow(range.value, new Date())
  if (!next.ok) {
    invalidRange.value = true
    return
  }
  invalidRange.value = false
  win.value = { from: next.from, to: next.to }
  for (const panel of panels) void panel.run()
}

function setRange(state: RangeState): void {
  void router.replace({ query: routeQuery(state, group.value, DEFAULT_GROUP) })
}

function setGroup(value: string): void {
  void router.replace({ query: routeQuery(range.value, parseGroup(value, PROJECT_GROUPS, DEFAULT_GROUP), DEFAULT_GROUP) })
}

onMounted(refreshAll)
useRefetchOnVisible(refreshAll)
watch(() => JSON.stringify(range.value), refreshAll)
watch(group, () => {
  if (win.value !== null && !invalidRange.value) void spend.run()
})

/** D390: color follows the entity across refetches. */
const slots = shallowRef(new Map<string, number>())
watch(() => spend.data.value, (data) => {
  slots.value = assignSlots(slots.value, (data?.series ?? []).filter((s) => !s.folded).map((s) => s.key))
})
const otherLabel = computed(() => t('fleet.analytics.other'))
const spendSeries = computed(() => chartSeries(spend.data.value?.series ?? [], slots.value, otherLabel.value))
const spendRows = computed(() => areaRows(spend.data.value?.series ?? []))
const spendBucket = computed(() => spend.data.value?.bucket ?? 'day')
const spendColumns = computed(() => spendSeries.value.map((s) => s.label))
const spendTable = computed(() => spendTableRows(spendRows.value, spendBucket.value))
const spendSummary = computed(() =>
  t('fleet.analytics.chart.spendSummary', { total: usd(spend.data.value?.totals.costUsd), count: spendSeries.value.length }))
const stageBars = computed(() => costBars(byStage.data.value?.series ?? [], otherLabel.value))
const roleBars = computed(() => costBars(byRole.data.value?.series ?? [], otherLabel.value))

const qualityData = computed(() => quality.data.value)
const firstPass = computed(() => rateRows(qualityData.value?.firstPassSeries ?? []))
const qualityBucket = computed(() => qualityData.value?.bucket ?? 'day')
const rateColumns = computed(() => [t('fleet.analytics.chart.rate')])
const rateTable = computed(() => rateTableRows(firstPass.value, qualityBucket.value))
const rateSummary = computed(() => t('fleet.analytics.chart.rateSummary', { rate: pct(qualityData.value?.firstPassRate) }))
const reviewerBars = computed(() => rateBars((qualityData.value?.reviewByReviewer ?? []).map((r) => ({
  key: r.reviewer,
  label: r.reviewer,
  rate: r.passRate,
  detail: t('fleet.analytics.reviewerDetail', { rate: pct(r.passRate), runs: r.runs }),
}))))
const outcomeBars = computed(() => countBars(FINISH_OUTCOMES.map((k) => ({
  key: k, label: t(`fleet.analytics.outcome.${k}`), count: qualityData.value?.finishOutcomes[k] ?? 0,
}))))
const reasons = computed(() => qualityData.value?.topEscalationReasons ?? [])

/** D393: one API value per tile, `-` until its panel has data. */
const tiles = computed(() => {
  const totals = spend.data.value?.totals
  const q = qualityData.value
  return [
    { id: 'spend', label: t('fleet.analytics.tiles.spend'), value: totals ? usd(totals.costUsd) : '-' },
    { id: 'jobs', label: t('fleet.analytics.tiles.jobs'), value: totals ? String(totals.jobs) : '-' },
    { id: 'median', label: t('fleet.analytics.tiles.median'), value: totals ? usd(totals.medianJobCostUsd) : '-' },
    { id: 'firstPass', label: t('fleet.analytics.tiles.firstPass'), value: q ? pct(q.firstPassRate) : '-' },
    { id: 'escalations', label: t('fleet.analytics.tiles.escalations'), value: q ? String(q.finishOutcomes.escalated) : '-' },
  ]
})
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('fleet.analytics.title')" :subtitle="t('fleet.analytics.subtitle')" />

    <div class="flex flex-wrap items-end justify-between gap-4">
      <FleetAnalyticsRangePicker :model-value="range" :invalid="invalidRange" @update:model-value="setRange" />
      <label class="flex w-48 flex-col gap-1 text-xs text-muted-foreground">
        {{ t('fleet.analytics.groupLabel') }}
        <FleetNativeSelect :model-value="group" :options="groupOptions" testid="fleet-analytics-group" @update:model-value="setGroup" />
      </label>
    </div>

    <FleetAnalyticsIngestNotice v-if="ingest.data.value" :pending="ingest.data.value.pending" :failed="ingest.data.value.failed" :admin="isAdmin" />
    <FleetAnalyticsSummaryTiles :tiles="tiles" />

    <FleetAnalyticsPanel :title="t('fleet.analytics.panels.spend')" :status="spend.status.value" :empty-text="t('fleet.analytics.empty')" testid="fleet-analytics-spend" @retry="spend.run()">
      <FleetAnalyticsSpendAreaChart :rows="spendRows" :series="spendSeries" :bucket="spendBucket" :label="spendSummary" />
      <FleetAnalyticsSeriesLegend :series="spendSeries" testid="fleet-analytics-legend" />
      <FleetAnalyticsChartDataTable :columns="spendColumns" :rows="spendTable" :caption="spendSummary" testid="fleet-analytics-spend-data" />
    </FleetAnalyticsPanel>

    <div class="grid gap-6 lg:grid-cols-2">
      <FleetAnalyticsPanel :title="t('fleet.analytics.panels.byStage')" :status="byStage.status.value" testid="fleet-analytics-stage" @retry="byStage.run()">
        <FleetAnalyticsBarList :rows="stageBars" :label="t('fleet.analytics.panels.byStage')" testid="fleet-analytics-stage-bars" />
      </FleetAnalyticsPanel>
      <FleetAnalyticsPanel :title="t('fleet.analytics.panels.byRole')" :status="byRole.status.value" testid="fleet-analytics-role" @retry="byRole.run()">
        <FleetAnalyticsBarList :rows="roleBars" :label="t('fleet.analytics.panels.byRole')" testid="fleet-analytics-role-bars" />
      </FleetAnalyticsPanel>
    </div>

    <FleetAnalyticsPanel :title="t('fleet.analytics.panels.quality')" :status="quality.status.value" testid="fleet-analytics-quality" @retry="quality.run()">
      <div class="grid gap-6 lg:grid-cols-2">
        <div class="space-y-2">
          <h3 class="text-xs font-medium text-muted-foreground">{{ t('fleet.analytics.panels.firstPass') }}</h3>
          <FleetAnalyticsRateLineChart :rows="firstPass" :bucket="qualityBucket" :label="rateSummary" :series-label="t('fleet.analytics.chart.rate')" />
          <FleetAnalyticsChartDataTable :columns="rateColumns" :rows="rateTable" :caption="rateSummary" testid="fleet-analytics-first-pass-data" />
        </div>
        <div class="space-y-4">
          <div class="space-y-2">
            <h3 class="text-xs font-medium text-muted-foreground">{{ t('fleet.analytics.panels.reviewers') }}</h3>
            <FleetAnalyticsBarList :rows="reviewerBars" :label="t('fleet.analytics.panels.reviewers')" testid="fleet-analytics-reviewers" />
          </div>
          <div class="space-y-2">
            <h3 class="text-xs font-medium text-muted-foreground">{{ t('fleet.analytics.panels.outcomes') }}</h3>
            <FleetAnalyticsBarList :rows="outcomeBars" :label="t('fleet.analytics.panels.outcomes')" testid="fleet-analytics-outcomes" />
          </div>
          <div class="space-y-2">
            <h3 class="text-xs font-medium text-muted-foreground">{{ t('fleet.analytics.panels.reasons') }}</h3>
            <ol class="space-y-1 text-sm" data-testid="fleet-analytics-reasons">
              <li v-for="r in reasons" :key="r.reason" class="flex justify-between gap-3">
                <span class="min-w-0 break-words">{{ r.reason }}</span>
                <span class="shrink-0 text-muted-foreground">{{ t('fleet.analytics.reasonCount', { count: r.count }) }}</span>
              </li>
            </ol>
          </div>
        </div>
      </div>
    </FleetAnalyticsPanel>

    <FleetAnalyticsPanel :title="t('fleet.analytics.panels.expensiveStories')" :status="costlyStories.status.value" testid="fleet-analytics-costly-stories" @retry="costlyStories.run()">
      <FleetAnalyticsStoryTable :slug="slug" :rows="costlyStories.data.value?.rows ?? []" testid="fleet-analytics-costly-stories-table" />
    </FleetAnalyticsPanel>
    <FleetAnalyticsPanel :title="t('fleet.analytics.panels.loopingStories')" :status="loopingStories.status.value" testid="fleet-analytics-looping-stories" @retry="loopingStories.run()">
      <FleetAnalyticsStoryTable :slug="slug" :rows="loopingStories.data.value?.rows ?? []" testid="fleet-analytics-looping-stories-table" />
    </FleetAnalyticsPanel>
    <FleetAnalyticsPanel :title="t('fleet.analytics.panels.expensiveJobs')" :status="costlyJobs.status.value" testid="fleet-analytics-costly-jobs" @retry="costlyJobs.run()">
      <FleetAnalyticsJobTable :slug="slug" :rows="costlyJobs.data.value?.rows ?? []" testid="fleet-analytics-costly-jobs-table" />
    </FleetAnalyticsPanel>
  </div>
</template>
```

- [ ] **Step 4: Run the page test**

Run: `cd apps/web && bun run test -- tests/pages/fleet-analytics-page.spec.ts`
Expected: PASS. If a test sees a stale status, raise the `settle()` loop count (the page chains a watcher, a
panel promise and a render per refetch); do not add sleeps.

- [ ] **Step 5: Add the navigation and breadcrumb (D399)**

In `apps/web/layouts/default.vue`:

1. Add `BarChart3` to the `lucide-vue-next` import (after `Inbox`).
2. In `fleetLeaf`, add before `return t('fleet.jobs.detail.title')`:

```ts
  if (path === `/${project}/fleet/analytics`) return t('fleet.analytics.title')
```

3. After the admin approvals link line
   (`<NuxtLink v-if="isGlobalAdmin" to="/admin/fleet/approvals" ...>...</NuxtLink>`), add:

```vue
        <NuxtLink v-if="isGlobalAdmin" to="/admin/fleet/analytics" :class="navLinkClass" :active-class="activeClass"><BarChart3 class="h-4 w-4 shrink-0" />{{ t('nav.fleetAnalytics') }}</NuxtLink>
```

4. Inside `<template v-if="projectSlug">`, right after the Fleet jobs `NuxtLink` block (the one ending with
   `{{ t('nav.fleetJobs') }}` and `</NuxtLink>`), add:

```vue
          <NuxtLink
            :to="`/${projectSlug}/fleet/analytics`"
            :class="navLinkClass"
            :active-class="activeClass"
          >
            <BarChart3 class="h-4 w-4 shrink-0" />
            {{ t('nav.fleetAnalytics') }}
          </NuxtLink>
```

In `apps/web/tests/layouts/fleet-jobs-nav.spec.ts`, append inside the `describe`:

```ts
  test('a project link to /:project/fleet/analytics with BarChart3 for every member, and its breadcrumb leaf (S2b D399)', () => {
    expect(projectLinks).toContain(':to="`/${projectSlug}/fleet/analytics`"')
    expect(projectLinks).toMatch(/<BarChart3 class="h-4 w-4 shrink-0" \/>\s*\{\{ t\('nav\.fleetAnalytics'\) \}\}/)
    expect(layout).toContain("if (path === `/${project}/fleet/analytics`) return t('fleet.analytics.title')")
  })
```

In `apps/web/tests/layouts/default-fleet-nav.spec.ts`, in the test
`a global admin sees Runners, Repos and Budgets links with their nav labels`, add after the approvals expectation:

```ts
    expect(html.match(/<a href="\/admin\/fleet\/analytics"[^>]*>[\s\S]*?<\/a>/)?.[0]).toContain('nav.fleetAnalytics')
```

Run: `cd apps/web && bun run test -- tests/layouts tests/pages/fleet-analytics-page.spec.ts tests/i18n tests/lib/api-path-guard.spec.ts`
Expected: PASS (the non-admin test in `default-fleet-nav.spec.ts` keeps proving no `/admin/fleet/` link leaks).

- [ ] **Step 6: Commit**

```bash
git add 'apps/web/pages/[project]/fleet/analytics.vue' apps/web/layouts/default.vue apps/web/tests/layouts/fleet-jobs-nav.spec.ts apps/web/tests/layouts/default-fleet-nav.spec.ts apps/web/tests/pages/fleet-analytics-page.spec.ts
git commit -m "feat(web): project fleet Analytics page and navigation (S2b slice 2, D390-D394, D399)"
```

---

### Task 10: Job page "Cost & quality" section

**Files:**
- Create: `apps/web/components/fleet/JobAnalytics.vue`
- Modify: `apps/web/pages/[project]/fleet/jobs/[id]/index.vue`
- Modify: `apps/web/tests/pages/fleet-job-detail.spec.ts`
- Test: `apps/web/tests/components/fleet-job-analytics.spec.ts`

**Interfaces:**
- Consumes: Task 5 `useFleetAnalytics(slug).job(jobId)`, Task 3 (`usd`, `ingestVariant`, `skippedFiles`, `JobAnalyticsDto`),
  Task 4 `costBars`, Task 6 `FleetAnalyticsBarList`, `codeLabel` (`lib/fleet-i18n.ts`).
- Produces: `FleetJobAnalytics` (`components/fleet/JobAnalytics.vue`) props `{ slug: string; jobId: string; reloadKey: number }`,
  root `data-testid="fleet-job-analytics"` rendered only when the response has an `ingest` row; inner ids
  `fleet-job-analytics-ingest`, `-error`, `-retry`, `-files`, `-ingest-error`, `-corrected`, `-ledger`, `-stage`,
  `-role`, `-model` (bar lists), `-story`, `-review` (table rows).

- [ ] **Step 1: Write the failing tests**

Create `apps/web/tests/components/fleet-job-analytics.spec.ts`:

```ts
import { afterEach, describe, expect, jest, test } from '@jest/globals'
import { readFileSync } from 'node:fs'
import * as Vue from 'vue'
import { computed, ref, watch } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'

const component = webFile('components', 'fleet', 'JobAnalytics.vue')

const DATA = {
  jobId: 'j1',
  ingest: { leaseEpoch: 1, status: 'done', files: { cost: 'done', metrics: 'done', review: 'done', finish: 'done' }, ingestedAt: '2026-10-05T00:00:00.000Z', error: null },
  byStage: [{ key: 'run', costUsd: '0.1200', tokens: 220 }, { key: 'review', costUsd: '0.0134', tokens: 110 }],
  byRole: [{ key: 'implementer', costUsd: '0.1200', tokens: 200 }],
  byModel: [{ key: 'm-e2e-a', costUsd: '0.1334', tokens: 330 }],
  stories: [{ leaseEpoch: 1, featureName: 'f', storyId: 'US-001', attempts: 2, firstPassSuccess: false, success: true, costUsd: '0.1334', durationMs: 1000, completedAt: null }],
  reviews: [{ leaseEpoch: 1, storyId: 'US-001', reviewer: '<b>semantic</b>', passed: false, failOpen: false, findingCount: 1, findingsBySeverity: { error: 1 }, advisoryCount: 0, at: '2026-10-05T00:00:00.000Z' }],
  liveCostUsd: '0.0000',
  ledgerCostUsd: '0.1334',
  corrected: true,
}

type Get = jest.Mock<(path: string) => Promise<unknown>>

function mount(get: Get) {
  const app = mountSfc(component, {
    props: { slug: 'koda', jobId: 'j1', reloadKey: 0 },
    components: uiStubs,
    fleetComponents: ['FleetAnalyticsBarList'],
    globals: { ref, computed, watch, onMounted: Vue.onMounted, useI18n: () => enI18n(), useApi: () => ({ $api: { get } }) },
  })
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 4; i += 1) {
      await new Promise((resolve) => { setImmediate(resolve) })
      await Vue.nextTick()
    }
  }
  const byId = (id: string) => app.find(`[data-testid="${id}"]`)
  return { app, settle, byId }
}

describe('FleetJobAnalytics (spec §5.4, D396)', () => {
  afterEach(() => jest.clearAllMocks())

  test('stays hidden until the job has an ingest row', async () => {
    const m = mount(jest.fn(async () => ({ ...DATA, ingest: null })) as Get)
    await m.settle()
    expect(m.byId('fleet-job-analytics')).toHaveLength(0)
    m.app.unmount()
  })

  test('shows the ingest status, the correction, live vs ledger, cost bars, stories and reviews', async () => {
    const get = jest.fn(async () => DATA) as Get
    const m = mount(get)
    await m.settle()
    expect(get).toHaveBeenCalledWith('/projects/koda/fleet/jobs/j1/analytics')
    expect(m.app.textOf(m.byId('fleet-job-analytics-ingest')[0])).toContain('Done')
    expect(m.byId('fleet-job-analytics-corrected')).toHaveLength(1)
    expect(m.app.textOf(m.byId('fleet-job-analytics-ledger')[0])).toBe('Live $0.0000 / ledger $0.1334')
    expect(m.byId('fleet-job-analytics-stage-row').map((r) => r.props['data-key'])).toEqual(['run', 'review'])
    expect(m.byId('fleet-job-analytics-stage-value').map((n) => m.app.textOf(n))).toEqual(['$0.1200', '$0.0134'])
    expect(m.app.textOf(m.byId('fleet-job-analytics-story')[0])).toContain('US-001')
    const review = m.app.textOf(m.byId('fleet-job-analytics-review')[0])
    expect(review).toContain('<b>semantic</b>')
    expect(review).toContain('error 1')
    m.app.unmount()
  })

  test('lists skipped files for a partial ingest and the error for a failed one; equal live and ledger say nothing', async () => {
    const partial = mount(jest.fn(async () => ({
      ...DATA, corrected: false, liveCostUsd: '0.1334',
      ingest: { ...DATA.ingest, status: 'partial', files: { cost: 'done', review: 'skipped:v3', deleted: '2026-10-01T00:00:00.000Z' } },
    })) as Get)
    await partial.settle()
    expect(partial.app.textOf(partial.byId('fleet-job-analytics-files')[0])).toBe('Skipped files: review (skipped:v3)')
    expect(partial.byId('fleet-job-analytics-corrected')).toHaveLength(0)
    expect(partial.byId('fleet-job-analytics-ledger')).toHaveLength(0)
    partial.app.unmount()

    const failed = mount(jest.fn(async () => ({ ...DATA, ingest: { ...DATA.ingest, status: 'failed', error: 'corrupt gzip' } })) as Get)
    await failed.settle()
    expect(failed.app.textOf(failed.byId('fleet-job-analytics-ingest-error')[0])).toBe('corrupt gzip')
    failed.app.unmount()
  })

  test('a failed reload keeps the section, shows an inline retry, and the retry recovers (Review Focus 5)', async () => {
    const state = { fail: false }
    const get = jest.fn(async () => { if (state.fail) throw new Error('503'); return DATA }) as Get
    const m = mount(get)
    await m.settle()
    expect(m.byId('fleet-job-analytics-retry')).toHaveLength(0)

    state.fail = true
    // The refresh button runs the same load() that a live event (reloadKey) triggers.
    m.byId('fleet-job-analytics-reload')[0].props.onClick()
    await m.settle()
    expect(m.byId('fleet-job-analytics')).toHaveLength(1)
    expect(m.byId('fleet-job-analytics-error')).toHaveLength(1)
    expect(m.byId('fleet-job-analytics-corrected')).toHaveLength(1)

    state.fail = false
    m.byId('fleet-job-analytics-retry')[0].props.onClick()
    await m.settle()
    expect(m.byId('fleet-job-analytics-error')).toHaveLength(0)
    expect(get).toHaveBeenCalledTimes(3)
    const source = readFileSync(component, 'utf-8')
    expect(source).toContain('watch(() => props.reloadKey, load)')
    expect(source).not.toContain('useAppToast')
    m.app.unmount()
  })
})
```

(`mountSfc` cannot change a root prop after mount, so the `reloadKey` watch is pinned by the source check above;
the refresh button, `fleet-job-analytics-reload`, runs the same `load()` and lets the test fail a reload after a
success.)

In `apps/web/tests/pages/fleet-job-detail.spec.ts`, append inside `describe('job detail', ...)`:

```ts
  test('S2b: the cost and quality section reloads with every live reload (D396)', () => {
    expect(detail).toContain("import FleetJobAnalytics from '~/components/fleet/JobAnalytics.vue'")
    expect(detail).toContain('<FleetJobAnalytics :slug="slug" :job-id="jobId" :reload-key="analyticsReload" />')
    expect(detail).toMatch(/async function reloadSilently\(\): Promise<void> \{\s*analyticsReload\.value \+= 1/)
  })
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/web && bun run test -- tests/components/fleet-job-analytics.spec.ts tests/pages/fleet-job-detail.spec.ts`
Expected: FAIL (component missing; page not wired).

- [ ] **Step 3: Write the component**

Create `apps/web/components/fleet/JobAnalytics.vue`:

```vue
<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useFleetAnalytics } from '~/composables/useFleetAnalytics'
import { costBars } from '~/lib/fleet-analytics-chart'
import { ingestVariant, skippedFiles, usd } from '~/lib/fleet-analytics-format'
import type { JobAnalyticsDto } from '~/lib/fleet-analytics-types'
import { codeLabel } from '~/lib/fleet-i18n'

/**
 * Fleet S2b spec §5.4, D396: the job's cost and quality once its bundle is ingested. `reloadKey` is bumped by the
 * page on every live reload; a failed fetch keeps what is shown and offers a retry, never a toast.
 */
const props = defineProps<{ slug: string; jobId: string; reloadKey: number }>()
const { t, te } = useI18n()
const api = useFleetAnalytics(props.slug)

const data = ref<JobAnalyticsDto | null>(null)
const failed = ref(false)
let latest = 0

async function load(): Promise<void> {
  const id = ++latest
  try {
    const next = await api.job(props.jobId)
    if (id !== latest) return
    data.value = next
    failed.value = false
  } catch {
    if (id !== latest) return
    failed.value = true
  }
}

onMounted(load)
watch(() => props.reloadKey, load)

const ingest = computed(() => data.value?.ingest ?? null)
const statusLabel = computed(() => (ingest.value ? codeLabel(t, te, 'fleet.analytics.ingestStatus', ingest.value.status) : ''))
const skipped = computed(() => (ingest.value ? skippedFiles(ingest.value.files) : ''))
const showLedger = computed(() => {
  const d = data.value
  return d !== null && d.liveCostUsd !== null && d.ledgerCostUsd !== null && d.liveCostUsd !== d.ledgerCostUsd
})
const otherLabel = computed(() => t('fleet.analytics.other'))
const blocks = computed(() => [
  { id: 'stage', title: t('fleet.analytics.job.byStage'), rows: costBars(data.value?.byStage ?? [], otherLabel.value) },
  { id: 'role', title: t('fleet.analytics.job.byRole'), rows: costBars(data.value?.byRole ?? [], otherLabel.value) },
  { id: 'model', title: t('fleet.analytics.job.byModel'), rows: costBars(data.value?.byModel ?? [], otherLabel.value) },
])
const yesNo = (v: boolean): string => (v ? t('fleet.analytics.table.yes') : t('fleet.analytics.table.no'))
function severityText(counts: Readonly<Record<string, number>>): string {
  const found = Object.entries(counts).filter(([, n]) => n > 0)
  return found.length === 0 ? t('fleet.analytics.job.noFindings') : found.map(([severity, n]) => `${severity} ${n}`).join(', ')
}
</script>

<template>
  <section v-if="ingest" class="space-y-4" data-testid="fleet-job-analytics" :data-ingest="ingest.status">
    <div class="flex flex-wrap items-center gap-2">
      <h2 class="text-sm font-medium">{{ t('fleet.analytics.job.title') }}</h2>
      <Badge :variant="ingestVariant(ingest.status)" data-testid="fleet-job-analytics-ingest">{{ t('fleet.analytics.job.analysis') }}: {{ statusLabel }}</Badge>
      <Button variant="ghost" size="sm" data-testid="fleet-job-analytics-reload" @click="load()">{{ t('fleet.analytics.job.refresh') }}</Button>
    </div>

    <div v-if="failed" class="flex flex-wrap items-center gap-2 text-sm" role="alert" data-testid="fleet-job-analytics-error">
      <span class="text-destructive">{{ t('fleet.analytics.job.loadFailed') }}</span>
      <Button variant="outline" size="sm" data-testid="fleet-job-analytics-retry" @click="load()">{{ t('common.retry') }}</Button>
    </div>
    <p v-if="ingest.status === 'partial' && skipped" class="text-sm text-muted-foreground" data-testid="fleet-job-analytics-files">{{ t('fleet.analytics.job.files', { files: skipped }) }}</p>
    <p v-if="ingest.status === 'failed' && ingest.error" class="whitespace-pre-wrap text-sm text-destructive" data-testid="fleet-job-analytics-ingest-error">{{ ingest.error }}</p>
    <p v-if="data?.corrected" class="text-sm" data-testid="fleet-job-analytics-corrected">{{ t('fleet.analytics.job.corrected') }}</p>
    <p v-if="showLedger" class="text-sm text-muted-foreground" data-testid="fleet-job-analytics-ledger">{{ t('fleet.analytics.job.liveLedger', { live: usd(data?.liveCostUsd), ledger: usd(data?.ledgerCostUsd) }) }}</p>

    <div class="grid gap-4 md:grid-cols-3">
      <div v-for="block in blocks" :key="block.id" class="space-y-2">
        <h3 class="text-xs font-medium text-muted-foreground">{{ block.title }}</h3>
        <FleetAnalyticsBarList :rows="block.rows" :label="block.title" :testid="`fleet-job-analytics-${block.id}`" />
      </div>
    </div>

    <div v-if="data && data.stories.length > 0" class="space-y-2">
      <h3 class="text-xs font-medium text-muted-foreground">{{ t('fleet.analytics.job.stories') }}</h3>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="text-left text-muted-foreground">
              <th scope="col" class="py-1 font-normal">{{ t('fleet.analytics.table.story') }}</th>
              <th scope="col" class="py-1 text-right font-normal">{{ t('fleet.analytics.table.attempts') }}</th>
              <th scope="col" class="py-1 font-normal">{{ t('fleet.analytics.table.firstPass') }}</th>
              <th scope="col" class="py-1 font-normal">{{ t('fleet.analytics.table.success') }}</th>
              <th scope="col" class="py-1 text-right font-normal">{{ t('fleet.analytics.table.cost') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="story in data.stories" :key="`${story.leaseEpoch}:${story.storyId}`" data-testid="fleet-job-analytics-story">
              <td class="py-1 font-mono text-xs">{{ story.storyId }}</td>
              <td class="py-1 text-right tabular-nums">{{ story.attempts }}</td>
              <td class="py-1">{{ yesNo(story.firstPassSuccess) }}</td>
              <td class="py-1">{{ yesNo(story.success) }}</td>
              <td class="py-1 text-right tabular-nums">{{ usd(story.costUsd) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div v-if="data && data.reviews.length > 0" class="space-y-2">
      <h3 class="text-xs font-medium text-muted-foreground">{{ t('fleet.analytics.job.reviews') }}</h3>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="text-left text-muted-foreground">
              <th scope="col" class="py-1 font-normal">{{ t('fleet.analytics.job.reviewer') }}</th>
              <th scope="col" class="py-1 font-normal">{{ t('fleet.analytics.table.story') }}</th>
              <th scope="col" class="py-1 font-normal">{{ t('fleet.analytics.job.passed') }}</th>
              <th scope="col" class="py-1 font-normal">{{ t('fleet.analytics.job.findings') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(review, i) in data.reviews" :key="`${review.at}:${i}`" data-testid="fleet-job-analytics-review">
              <td class="py-1 break-all">{{ review.reviewer }}</td>
              <td class="py-1 font-mono text-xs">{{ review.storyId ?? '-' }}</td>
              <td class="py-1">{{ yesNo(review.passed) }}</td>
              <td class="py-1">{{ severityText(review.findingsBySeverity) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </section>
</template>
```

- [ ] **Step 4: Wire it into the job page**

In `apps/web/pages/[project]/fleet/jobs/[id]/index.vue`:

1. After `import FleetJobApprovals from '~/components/fleet/JobApprovals.vue'`, add:

```ts
import FleetJobAnalytics from '~/components/fleet/JobAnalytics.vue'
```

2. Just above `async function reloadSilently(): Promise<void> {`, add:

```ts
/** D396: bumped on every live reload; the Cost & quality section refetches on it (ingest completion publishes one). */
const analyticsReload = ref(0)
```

and make the function's first statement the bump, so it reads:

```ts
async function reloadSilently(): Promise<void> {
  analyticsReload.value += 1
  try {
```

3. In the template, right after the escalation callout (the `<div v-if="job.escalationReason" ... data-testid="fleet-job-escalation">`
   block, before `<FleetJobApprovals ...`), add:

```vue
      <FleetJobAnalytics :slug="slug" :job-id="jobId" :reload-key="analyticsReload" />
```

- [ ] **Step 5: Run the tests**

Run: `cd apps/web && bun run test -- tests/components/fleet-job-analytics.spec.ts tests/pages/fleet-job-detail.spec.ts tests/i18n`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/components/fleet/JobAnalytics.vue 'apps/web/pages/[project]/fleet/jobs/[id]/index.vue' apps/web/tests/components/fleet-job-analytics.spec.ts apps/web/tests/pages/fleet-job-detail.spec.ts
git commit -m "feat(web): job page cost and quality section (S2b slice 2, D396)"
```

---
### Task 11: Admin Analytics page and the ingest health table

**Files:**
- Create: `apps/web/components/fleet/analytics/IngestTable.vue`
- Create: `apps/web/pages/admin/fleet/analytics.vue`
- Test: `apps/web/tests/components/fleet-ingest-table.spec.ts`, `apps/web/tests/pages/admin-fleet-analytics.spec.ts`

**Interfaces:**
- Consumes: Task 5 `useFleetAnalyticsAdmin()`, `SPEND_TOP`; Tasks 3-8 helpers and components; `isForbidden`
  (`composables/useFleetBudgetPage.ts`), `extractApiError` (`composables/useApi.ts`), `useAppToast`, `FleetPage`.
- Produces: `FleetAnalyticsIngestTable` props `{ rows: readonly IngestRowDto[]; busyJobId: string | null }`, emits
  `rerun` with the job id; rows `data-testid="fleet-ingest-row"` with `data-job` and `data-status`. The page at
  `/admin/fleet/analytics` with ids `fleet-analytics-admin-only`, `fleet-ingest`, `fleet-ingest-status`,
  `fleet-ingest-backfill`, `fleet-ingest-rerun-outdated`, `fleet-ingest-prev`, `fleet-ingest-next`, `fleet-ingest-empty`,
  plus the spend panels and tiles of Task 9 (`fleet-analytics-spend`, `-stage`, `-role`, `fleet-analytics-tile-*`).

- [ ] **Step 1: Write the failing tests**

Create `apps/web/tests/components/fleet-ingest-table.spec.ts`:

```ts
import { describe, expect, it } from '@jest/globals'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'

const table = webFile('components', 'fleet', 'analytics', 'IngestTable.vue')
const row = (over: Record<string, unknown> = {}) => ({
  id: 'i1', jobId: 'job-1', leaseEpoch: 2, projectId: 'proj-1', status: 'failed', attempts: 5, parserVersion: 1,
  files: {}, error: 'corrupt gzip', ingestedAt: null, updatedAt: '2026-10-05T00:00:00.000Z', ...over,
})

describe('FleetAnalyticsIngestTable (D397)', () => {
  it('shows status, ids as text, attempts and error, and asks to re-run a row', () => {
    const app = mountSfc(table, { props: { rows: [row(), row({ id: 'i2', jobId: 'job-2', status: 'done', error: null })], busyJobId: null }, components: uiStubs, globals: { useI18n: () => enI18n() } })
    const rows = app.find('[data-testid="fleet-ingest-row"]')
    expect(rows.map((r) => [r.props['data-job'], r.props['data-status']])).toEqual([['job-1', 'failed'], ['job-2', 'done']])
    expect(app.textOf(rows[0])).toContain('Failed')
    expect(app.textOf(rows[0])).toContain('job-1')
    expect(app.textOf(rows[0])).toContain('proj-1')
    expect(app.textOf(rows[0])).toContain('corrupt gzip')
    expect(app.textOf(rows[1])).toContain('Done')
    app.find('[data-testid="fleet-ingest-rerun"]')[1].props.onClick()
    expect(app.emitted('rerun')).toEqual([['job-2']])
  })

  it('disables the button of the row being re-run', () => {
    const app = mountSfc(table, { props: { rows: [row()], busyJobId: 'job-1' }, components: uiStubs, globals: { useI18n: () => enI18n() } })
    expect(app.find('[data-testid="fleet-ingest-rerun"]')[0].props.disabled).toBe(true)
  })
})
```

Create `apps/web/tests/pages/admin-fleet-analytics.spec.ts`:

```ts
import { afterEach, describe, expect, jest, test } from '@jest/globals'
import * as Vue from 'vue'
import { computed, h, reactive, ref, watch } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import type { FleetComponentName } from '../helpers/mount-sfc'
import { enI18n, toastRecorder, uiStubs } from '../helpers/fleet-harness'
import * as apiModule from '../../composables/useApi'
import { ApiError } from '../../composables/useApi'

const page = webFile('pages', 'admin', 'fleet', 'analytics.vue')
const W = { from: '2026-09-28T00:00:00.000Z', to: '2026-10-05T00:00:00.000Z' }
const SPEND = (group: string) => ({
  window: W, bucket: 'day', groupBy: group,
  totals: { costUsd: '4.2500', tokens: 10, cacheShare: 0.25, jobs: 2, medianJobCostUsd: '2.1250' },
  series: [{ key: `${group}-a`, label: `${group}-a`, folded: false, costUsd: '4.2500', tokens: 10, points: [{ t: W.from, costUsd: '4.2500', tokens: 10 }] }],
})
const ROW = { id: 'i1', jobId: 'job-1', leaseEpoch: 1, projectId: 'proj-1', status: 'failed', attempts: 5, parserVersion: 1, files: {}, error: 'corrupt gzip', ingestedAt: null, updatedAt: W.to }
const PAGE = (over: Record<string, unknown> = {}) => ({ records: [ROW], total: 21, current: 1, size: 20, hasNext: true, hasPrev: false, ...over })

type Query = Record<string, string>
type Get = jest.Mock<(path: string, opts?: { query?: Query }) => Promise<unknown>>
type Post = jest.Mock<(path: string) => Promise<unknown>>

const chartStub = { name: 'StubSpendChart', props: ['rows', 'series', 'bucket', 'label'], setup() { return () => h('x-stub-stub', { 'data-stub': 'spend-chart' }) } }
const REAL: FleetComponentName[] = [
  'FleetAnalyticsPanel', 'FleetAnalyticsBarList', 'FleetAnalyticsSeriesLegend', 'FleetAnalyticsChartDataTable', 'FleetAnalyticsSummaryTiles',
  'FleetAnalyticsRangePicker', 'FleetAnalyticsIngestTable', 'FleetNativeSelect',
]

function makeGet(ingest: () => unknown): Get {
  return jest.fn(async (path: string, opts?: { query?: Query }) => {
    if (path === '/fleet/analytics/spend') return SPEND(opts?.query?.groupBy ?? '')
    if (path === '/fleet/ingest') return ingest()
    throw new Error(`unexpected ${path}`)
  }) as Get
}

function mountAdmin(get: Get, confirmAnswer = true) {
  const route = reactive({ params: {}, query: {} as Query })
  const replace = jest.fn(async (to: { query: Query }) => { route.query = { ...to.query } })
  const post = jest.fn(async () => ({ queued: 1 })) as Post
  const toasts = toastRecorder()
  globalThis.window = { confirm: () => confirmAnswer } as never
  const app = mountSfc(page, {
    components: { ...uiStubs, FleetAnalyticsSpendAreaChart: chartStub },
    fleetComponents: REAL,
    alias: {
      '~/composables/useApi': apiModule,
      '~/composables/useRefetchOnVisible': { useRefetchOnVisible: () => undefined, watchVisible: () => () => undefined },
    },
    globals: {
      ref, computed, watch, onMounted: Vue.onMounted, onBeforeUnmount: Vue.onBeforeUnmount,
      useI18n: () => enI18n(), useAppToast: () => toasts, useApi: () => ({ $api: { get, post } }),
      useRoute: () => route, useRouter: () => ({ replace }), definePageMeta: () => undefined,
    },
  })
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 6; i += 1) {
      await new Promise((resolve) => { setImmediate(resolve) })
      await Vue.nextTick()
    }
  }
  const byId = (id: string) => app.find(`[data-testid="${id}"]`)
  const ingestCalls = () => get.mock.calls.filter(([p]) => p === '/fleet/ingest').map(([, o]) => o?.query ?? {})
  return { app, settle, byId, post, toasts, ingestCalls, get }
}

describe('admin fleet Analytics page (spec §5.3, D395)', () => {
  afterEach(() => jest.clearAllMocks())

  test('loads cross-project spend grouped by project, stage and role spend, and the first ingest page', async () => {
    const m = mountAdmin(makeGet(() => PAGE()))
    await m.settle()
    const spend = m.get.mock.calls.filter(([p]) => p === '/fleet/analytics/spend').map(([, o]) => o?.query ?? {})
    expect(spend.map((q) => [q.groupBy, q.top])).toEqual([['project', '7'], ['stage', undefined], ['role', undefined]])
    expect(m.ingestCalls()).toEqual([{ size: '20' }])
    expect(m.app.textOf(m.byId('fleet-analytics-tile-spend')[0])).toContain('$4.2500')
    expect(m.app.textOf(m.byId('fleet-analytics-tile-median')[0])).toContain('$2.1250')
    expect(m.app.textOf(m.byId('fleet-analytics-tile-cacheShare')[0])).toContain('25.0%')
    expect(m.byId('fleet-ingest-row')).toHaveLength(1)
    expect(m.app.text()).toContain('21 rows')
    expect(m.get.mock.calls.some(([p]) => p.includes('/quality'))).toBe(false)
    m.app.unmount()
  })

  test('a non-admin sees only the admin-only note', async () => {
    const m = mountAdmin(makeGet(() => { throw new ApiError(40003, 'Forbidden') }))
    await m.settle()
    expect(m.byId('fleet-analytics-admin-only')).toHaveLength(1)
    expect(m.byId('fleet-analytics-tiles')).toHaveLength(0)
    expect(m.byId('fleet-ingest')).toHaveLength(0)
    m.app.unmount()
  })

  test('filters by status from page 1 and pages forward', async () => {
    const m = mountAdmin(makeGet(() => PAGE()))
    await m.settle()
    m.byId('fleet-ingest-next')[0].props.onClick()
    await m.settle()
    m.byId('fleet-ingest-status')[0].props.onChange({ target: { value: 'failed' } })
    await m.settle()
    expect(m.ingestCalls()).toEqual([{ size: '20' }, { size: '20', current: '2' }, { size: '20', status: 'failed' }])
    m.app.unmount()
  })

  test('re-runs one job, reports the queued count and refreshes the list', async () => {
    const m = mountAdmin(makeGet(() => PAGE()))
    await m.settle()
    m.byId('fleet-ingest-rerun')[0].props.onClick()
    await m.settle()
    expect(m.post).toHaveBeenCalledWith('/fleet/ingest/jobs/job-1/rerun')
    expect(m.toasts.successes).toEqual(['Queued 1 bundles.'])
    expect(m.ingestCalls()).toHaveLength(2)
    m.app.unmount()
  })

  test('backfill posts at once; re-run all asks first and does nothing when declined', async () => {
    const declined = mountAdmin(makeGet(() => PAGE()), false)
    await declined.settle()
    declined.byId('fleet-ingest-rerun-outdated')[0].props.onClick()
    await declined.settle()
    expect(declined.post).not.toHaveBeenCalled()
    declined.byId('fleet-ingest-backfill')[0].props.onClick()
    await declined.settle()
    expect(declined.post).toHaveBeenCalledWith('/fleet/ingest/backfill')
    declined.app.unmount()

    const confirmed = mountAdmin(makeGet(() => PAGE()), true)
    await confirmed.settle()
    confirmed.byId('fleet-ingest-rerun-outdated')[0].props.onClick()
    await confirmed.settle()
    expect(confirmed.post).toHaveBeenCalledWith('/fleet/ingest/rerun-outdated')
    confirmed.app.unmount()
  })

  test('an ingest list failure shows its own error while spend still renders', async () => {
    const m = mountAdmin(makeGet(() => { throw new ApiError(50000, 'boom') }))
    await m.settle()
    expect(m.app.find('[data-stub="error-state"]')).toHaveLength(1)
    expect(m.byId('fleet-analytics-spend')[0].props['data-status']).toBe('ready')
    m.app.unmount()
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/web && bun run test -- tests/components/fleet-ingest-table.spec.ts tests/pages/admin-fleet-analytics.spec.ts`
Expected: FAIL (files missing).

- [ ] **Step 3: Write the ingest table**

Create `apps/web/components/fleet/analytics/IngestTable.vue`:

```vue
<script setup lang="ts">
import { ingestVariant, timeText } from '~/lib/fleet-analytics-format'
import type { IngestRowDto } from '~/lib/fleet-analytics-types'
import { codeLabel } from '~/lib/fleet-i18n'

/** Spec §5.3, D397: ingest health with a per-row Re-run. Ids are text: the ingest list carries no slug. */
defineProps<{ rows: readonly IngestRowDto[]; busyJobId: string | null }>()
const emit = defineEmits<{ rerun: [jobId: string] }>()
const { t, te } = useI18n()
const statusLabel = (status: string): string => codeLabel(t, te, 'fleet.analytics.ingestStatus', status)
</script>

<template>
  <div class="overflow-x-auto">
    <table class="w-full text-sm" data-testid="fleet-ingest-table">
      <thead>
        <tr class="text-left text-muted-foreground">
          <th scope="col" class="py-1 font-normal">{{ t('fleet.analytics.ingest.status') }}</th>
          <th scope="col" class="py-1 font-normal">{{ t('fleet.analytics.ingest.job') }}</th>
          <th scope="col" class="py-1 font-normal">{{ t('fleet.analytics.ingest.project') }}</th>
          <th scope="col" class="py-1 text-right font-normal">{{ t('fleet.analytics.ingest.attempts') }}</th>
          <th scope="col" class="py-1 font-normal">{{ t('fleet.analytics.ingest.error') }}</th>
          <th scope="col" class="py-1 font-normal">{{ t('fleet.analytics.ingest.updated') }}</th>
          <th scope="col" class="py-1"><span class="sr-only">{{ t('fleet.analytics.ingest.rerun') }}</span></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.id" data-testid="fleet-ingest-row" :data-job="row.jobId" :data-status="row.status">
          <td class="py-1"><Badge :variant="ingestVariant(row.status)">{{ statusLabel(row.status) }}</Badge></td>
          <td class="py-1 font-mono text-xs break-all">{{ row.jobId }} <span class="text-muted-foreground">#{{ row.leaseEpoch }}</span></td>
          <td class="py-1 font-mono text-xs break-all">{{ row.projectId }}</td>
          <td class="py-1 text-right tabular-nums">{{ row.attempts }}</td>
          <td class="max-w-xs py-1"><span class="block truncate" :title="row.error ?? ''">{{ row.error ?? '-' }}</span></td>
          <td class="py-1 whitespace-nowrap">{{ timeText(row.updatedAt) }}</td>
          <td class="py-1 text-right">
            <Button variant="outline" size="sm" :disabled="busyJobId === row.jobId" data-testid="fleet-ingest-rerun" @click="emit('rerun', row.jobId)">{{ t('fleet.analytics.ingest.rerun') }}</Button>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
```

- [ ] **Step 4: Write the admin page**

Create `apps/web/pages/admin/fleet/analytics.vue`:

```vue
<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, watch } from 'vue'
import { extractApiError } from '~/composables/useApi'
import { useAnalyticsPanel } from '~/composables/useAnalyticsPanel'
import { SPEND_TOP, useFleetAnalyticsAdmin } from '~/composables/useFleetAnalytics'
import type { WindowQuery } from '~/composables/useFleetAnalytics'
import { isForbidden } from '~/composables/useFleetBudgetPage'
import { useRefetchOnVisible } from '~/composables/useRefetchOnVisible'
import { areaRows, assignSlots, chartSeries, costBars, spendTableRows } from '~/lib/fleet-analytics-chart'
import { pct, usd } from '~/lib/fleet-analytics-format'
import { parseGroup, parseRange, rangeWindow, routeQuery } from '~/lib/fleet-analytics-range'
import type { RangeState } from '~/lib/fleet-analytics-range'
import { ADMIN_GROUPS, INGEST_STATUSES } from '~/lib/fleet-analytics-types'
import type { AdminGroupBy, IngestRowDto, IngestStatus } from '~/lib/fleet-analytics-types'
import type { FleetPage } from '~/lib/fleet-types'

definePageMeta({ layout: 'default' })

/** Fleet S2b spec §5.3, D395: spend across projects and bundle ingest health (global ADMIN). No polling. */
const DEFAULT_GROUP: AdminGroupBy = 'project'

const route = useRoute()
const router = useRouter()
const { t } = useI18n()
const toast = useAppToast()
const api = useFleetAnalyticsAdmin()

const range = computed(() => parseRange(route.query))
const group = computed(() => parseGroup(route.query.group, ADMIN_GROUPS, DEFAULT_GROUP))
const groupOptions = computed(() => ADMIN_GROUPS.map((g) => ({ value: g, label: t(`fleet.analytics.groupBy.${g}`) })))
const win = ref<WindowQuery | null>(null)
const invalidRange = ref(false)
const forbidden = ref(false)

function current(): WindowQuery {
  if (win.value === null) throw new Error('analytics window not set')
  return win.value
}

const noSeries = (d: { series: unknown[] }): boolean => d.series.length === 0
const spend = useAnalyticsPanel(() => api.spend(current(), group.value, SPEND_TOP), noSeries)
const byStage = useAnalyticsPanel(() => api.spend(current(), 'stage'), noSeries)
const byRole = useAnalyticsPanel(() => api.spend(current(), 'role'), noSeries)

const statusFilter = ref('')
const page = ref(1)
const ingestPage = shallowRef<FleetPage<IngestRowDto> | null>(null)
const ingestFailed = ref(false)
const busyJobId = ref<string | null>(null)
const busyAll = ref(false)
const statusOptions = computed(() => [
  { value: '', label: t('fleet.analytics.ingest.all') },
  ...INGEST_STATUSES.map((s) => ({ value: s, label: t(`fleet.analytics.ingestStatus.${s}`) })),
])
const asStatus = (value: string): IngestStatus | undefined => INGEST_STATUSES.find((s) => s === value)

/** A 403 means the viewer is not a global admin: the page shows the admin-only note (as admin budgets). */
async function refreshIngest(): Promise<void> {
  try {
    ingestPage.value = await api.ingestList(asStatus(statusFilter.value), page.value)
    ingestFailed.value = false
  } catch (err: unknown) {
    if (isForbidden(err)) {
      forbidden.value = true
      return
    }
    ingestFailed.value = true
  }
}

function refreshAll(): void {
  const next = rangeWindow(range.value, new Date())
  if (next.ok) {
    invalidRange.value = false
    win.value = { from: next.from, to: next.to }
    for (const panel of [spend, byStage, byRole]) void panel.run()
  } else {
    invalidRange.value = true
  }
  void refreshIngest()
}

function setRange(state: RangeState): void {
  void router.replace({ query: routeQuery(state, group.value, DEFAULT_GROUP) })
}

function setGroup(value: string): void {
  void router.replace({ query: routeQuery(range.value, parseGroup(value, ADMIN_GROUPS, DEFAULT_GROUP), DEFAULT_GROUP) })
}

function setStatus(value: string): void {
  statusFilter.value = value
  page.value = 1
  void refreshIngest()
}

function go(delta: number): void {
  page.value = Math.max(1, page.value + delta)
  void refreshIngest()
}

async function rerun(jobId: string): Promise<void> {
  busyJobId.value = jobId
  try {
    const result = await api.rerun(jobId)
    toast.success(t('fleet.analytics.ingest.queued', { n: result.queued }))
    await refreshIngest()
  } catch (err: unknown) {
    toast.error(extractApiError(err))
  } finally {
    busyJobId.value = null
  }
}

async function bulk(action: 'backfill' | 'rerunOutdated'): Promise<void> {
  if (action === 'rerunOutdated' && !window.confirm(t('fleet.analytics.ingest.confirmRerunOutdated'))) return
  busyAll.value = true
  try {
    const result = action === 'backfill' ? await api.backfill() : await api.rerunOutdated()
    toast.success(t('fleet.analytics.ingest.queued', { n: result.queued }))
    await refreshIngest()
  } catch (err: unknown) {
    toast.error(extractApiError(err))
  } finally {
    busyAll.value = false
  }
}

onMounted(refreshAll)
useRefetchOnVisible(refreshAll)
watch(() => JSON.stringify(range.value), refreshAll)
watch(group, () => {
  if (win.value !== null && !invalidRange.value) void spend.run()
})

const slots = shallowRef(new Map<string, number>())
watch(() => spend.data.value, (data) => {
  slots.value = assignSlots(slots.value, (data?.series ?? []).filter((s) => !s.folded).map((s) => s.key))
})
const otherLabel = computed(() => t('fleet.analytics.other'))
const spendSeries = computed(() => chartSeries(spend.data.value?.series ?? [], slots.value, otherLabel.value))
const spendRows = computed(() => areaRows(spend.data.value?.series ?? []))
const spendBucket = computed(() => spend.data.value?.bucket ?? 'day')
const spendColumns = computed(() => spendSeries.value.map((s) => s.label))
const spendTable = computed(() => spendTableRows(spendRows.value, spendBucket.value))
const spendSummary = computed(() =>
  t('fleet.analytics.chart.spendSummary', { total: usd(spend.data.value?.totals.costUsd), count: spendSeries.value.length }))
const stageBars = computed(() => costBars(byStage.data.value?.series ?? [], otherLabel.value))
const roleBars = computed(() => costBars(byRole.data.value?.series ?? [], otherLabel.value))

const tiles = computed(() => {
  const totals = spend.data.value?.totals
  return [
    { id: 'spend', label: t('fleet.analytics.tiles.spend'), value: totals ? usd(totals.costUsd) : '-' },
    { id: 'jobs', label: t('fleet.analytics.tiles.jobs'), value: totals ? String(totals.jobs) : '-' },
    { id: 'median', label: t('fleet.analytics.tiles.median'), value: totals ? usd(totals.medianJobCostUsd) : '-' },
    { id: 'cacheShare', label: t('fleet.analytics.tiles.cacheShare'), value: totals ? pct(totals.cacheShare) : '-' },
  ]
})
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('fleet.analytics.title')" :subtitle="t('fleet.analytics.subtitleAdmin')" />

    <p v-if="forbidden" class="text-sm text-muted-foreground" data-testid="fleet-analytics-admin-only">{{ t('fleet.common.adminOnly') }}</p>
    <template v-else>
      <div class="flex flex-wrap items-end justify-between gap-4">
        <FleetAnalyticsRangePicker :model-value="range" :invalid="invalidRange" @update:model-value="setRange" />
        <label class="flex w-48 flex-col gap-1 text-xs text-muted-foreground">
          {{ t('fleet.analytics.groupLabel') }}
          <FleetNativeSelect :model-value="group" :options="groupOptions" testid="fleet-analytics-group" @update:model-value="setGroup" />
        </label>
      </div>

      <FleetAnalyticsSummaryTiles :tiles="tiles" />

      <FleetAnalyticsPanel :title="t('fleet.analytics.panels.spend')" :status="spend.status.value" :empty-text="t('fleet.analytics.empty')" testid="fleet-analytics-spend" @retry="spend.run()">
        <FleetAnalyticsSpendAreaChart :rows="spendRows" :series="spendSeries" :bucket="spendBucket" :label="spendSummary" />
        <FleetAnalyticsSeriesLegend :series="spendSeries" testid="fleet-analytics-legend" />
        <FleetAnalyticsChartDataTable :columns="spendColumns" :rows="spendTable" :caption="spendSummary" testid="fleet-analytics-spend-data" />
      </FleetAnalyticsPanel>

      <div class="grid gap-6 lg:grid-cols-2">
        <FleetAnalyticsPanel :title="t('fleet.analytics.panels.byStage')" :status="byStage.status.value" testid="fleet-analytics-stage" @retry="byStage.run()">
          <FleetAnalyticsBarList :rows="stageBars" :label="t('fleet.analytics.panels.byStage')" testid="fleet-analytics-stage-bars" />
        </FleetAnalyticsPanel>
        <FleetAnalyticsPanel :title="t('fleet.analytics.panels.byRole')" :status="byRole.status.value" testid="fleet-analytics-role" @retry="byRole.run()">
          <FleetAnalyticsBarList :rows="roleBars" :label="t('fleet.analytics.panels.byRole')" testid="fleet-analytics-role-bars" />
        </FleetAnalyticsPanel>
      </div>

      <section class="space-y-3 rounded-md border border-border p-4" data-testid="fleet-ingest">
        <div class="flex flex-wrap items-end justify-between gap-3">
          <h2 class="text-sm font-medium">{{ t('fleet.analytics.ingest.title') }}</h2>
          <div class="flex flex-wrap items-end gap-2">
            <label class="flex w-44 flex-col gap-1 text-xs text-muted-foreground">
              {{ t('fleet.analytics.ingest.statusFilter') }}
              <FleetNativeSelect :model-value="statusFilter" :options="statusOptions" testid="fleet-ingest-status" @update:model-value="setStatus" />
            </label>
            <Button variant="outline" size="sm" :disabled="busyAll" data-testid="fleet-ingest-backfill" @click="bulk('backfill')">{{ t('fleet.analytics.ingest.backfill') }}</Button>
            <Button variant="outline" size="sm" :disabled="busyAll" data-testid="fleet-ingest-rerun-outdated" @click="bulk('rerunOutdated')">{{ t('fleet.analytics.ingest.rerunOutdated') }}</Button>
          </div>
        </div>
        <ErrorState v-if="ingestFailed" @retry="refreshIngest()" />
        <LoadingState v-else-if="ingestPage === null" />
        <p v-else-if="ingestPage.records.length === 0" class="text-sm text-muted-foreground" data-testid="fleet-ingest-empty">{{ t('fleet.analytics.ingest.empty') }}</p>
        <template v-else>
          <FleetAnalyticsIngestTable :rows="ingestPage.records" :busy-job-id="busyJobId" @rerun="rerun" />
          <div class="flex items-center justify-between text-sm text-muted-foreground">
            <span>{{ t('fleet.analytics.ingest.total', { total: ingestPage.total }) }}</span>
            <div class="flex gap-2">
              <Button variant="outline" size="sm" :disabled="!ingestPage.hasPrev" data-testid="fleet-ingest-prev" @click="go(-1)">{{ t('fleet.analytics.ingest.previous') }}</Button>
              <Button variant="outline" size="sm" :disabled="!ingestPage.hasNext" data-testid="fleet-ingest-next" @click="go(1)">{{ t('fleet.analytics.ingest.next') }}</Button>
            </div>
          </div>
        </template>
      </section>
    </template>
  </div>
</template>
```

- [ ] **Step 5: Run the tests**

Run: `cd apps/web && bun run test -- tests/components/fleet-ingest-table.spec.ts tests/pages/admin-fleet-analytics.spec.ts tests/i18n tests/lib/api-path-guard.spec.ts tests/toast-import-pattern.spec.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/components/fleet/analytics/IngestTable.vue apps/web/pages/admin/fleet/analytics.vue apps/web/tests/components/fleet-ingest-table.spec.ts apps/web/tests/pages/admin-fleet-analytics.spec.ts
git commit -m "feat(web): admin fleet analytics page with ingest health (S2b slice 2, D395, D397)"
```

---

### Task 12: E2E — a scripted runner's bundle reaches the job, Analytics and admin pages

**Files:**
- Create: `apps/web/tests/e2e/fleet-analytics.e2e.spec.ts`

**Interfaces:**
- Consumes: `login`, `E2E_ADMIN` (`tests/e2e/fixtures/api-client.ts`); `call`, `dispatchRun`, `repoIdOf`
  (`tests/e2e/fixtures/fleet-budgets-api.ts`); `waitForHydration`, `webLogin` (`tests/e2e/fixtures/page-helpers.ts`);
  `ScriptedRunner` (`tests/e2e/fixtures/scripted-runner.ts`: `enroll`, `heartbeat`, `acceptAssign`, `report`,
  `uploadTarBundle`, `id`); the ingest parsers' formats (`apps/api/src/fleet/ingest/parsers/parsers.spec.ts`);
  the test ids of Tasks 9-11.
- Produces: nothing other tasks use.

- [ ] **Step 1: Write the E2E spec**

Create `apps/web/tests/e2e/fleet-analytics.e2e.spec.ts`:

```ts
import { test, expect } from '@playwright/test';
import { login, E2E_ADMIN } from './fixtures/api-client';
import { call, dispatchRun, repoIdOf } from './fixtures/fleet-budgets-api';
import { waitForHydration, webLogin } from './fixtures/page-helpers';
import { ScriptedRunner } from './fixtures/scripted-runner';

/**
 * Fleet S2b slice 2 (spec §6 E2E, D400): a scripted runner uploads a bundle for a RUN that ends COMPLETED. Ingest
 * corrects it to ESCALATED from its finish-audit, raises its cost to the ledger and records the breakdown; the job
 * page, the Analytics page and the admin ingest table show it. Only this spec uploads cost ledgers, and every
 * assertion keys on this run's unique feature name or job id, so other specs and retries cannot change them.
 * API polls stay at one request per 2 s (the global throttle is 100 a minute; /fleet/runner/* is exempt).
 */
const SLUG = 'fleet-e2e';
const POLL = { intervals: [2_000] };

test.describe('Fleet analytics (scripted runner bundle)', () => {
  let token = '';
  let runner: ScriptedRunner;
  let repoId = '';
  const suffix = Date.now().toString().slice(-6);
  const feature = `analytics-${suffix}`;
  const runId = `run-e2e-${suffix}`;
  const prUrl = `https://github.com/acme/e2e-app/pull/${suffix}`;

  test.beforeAll(async () => {
    const session = await login(E2E_ADMIN.email, E2E_ADMIN.password);
    token = session.token;
    runner = await ScriptedRunner.enroll(token, `e2e-analytics-runner-${suffix}`);
    repoId = await repoIdOf(token, SLUG, 'acme/e2e-app');
  });

  /** A nax-out tree in the formats the slice 1a parsers read (cost ledger v8, metrics, review audit, finish audit). */
  function bundle(at: number): Record<string, string> {
    const iso = new Date(at).toISOString();
    const cost = (callId: string, stage: string, sessionRole: string, model: string, costUsd: number): string => JSON.stringify({
      ts: at, runId, projectKey: 'e2e', schemaVersion: 8, agentName: 'native', model, modelTier: 'fast', profile: 'koda-job-e2e',
      stage, sessionRole, featureName: feature, storyId: 'US-001', callId, scopeId: 's',
      tokens: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 },
      estimatedCostUsd: costUsd, exactCostUsd: costUsd, costUsd, confidence: 'exact', pricingSource: 'catalog', durationMs: 100,
    });
    return {
      'nax-out/status.json': JSON.stringify({ run: { id: runId, status: 'completed' } }),
      [`nax-out/cost/${runId}.jsonl`]: `${[
        cost('c1', 'run', 'implementer', 'm-e2e-a', 0.12),
        cost('c2', 'review', 'reviewer', 'm-e2e-b', 0.0134),
        cost('c3', 'run', 'test-writer', 'm-e2e-a', 0.00004),
      ].join('\n')}\n`,
      'nax-out/metrics.json': JSON.stringify([{
        runId, feature, totalCost: 0.13344,
        stories: [{
          storyId: 'US-001', attempts: 2, success: true, firstPassSuccess: false, cost: 0.13344, durationMs: 1000,
          startedAt: iso, completedAt: iso,
          tokens: { inputTokens: 300, outputTokens: 30, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
        }],
      }]),
      [`nax-out/review-audit/${feature}/1-semantic.json`]: JSON.stringify({
        timestamp: iso, runId, storyId: 'US-001', reviewer: 'semantic', recordId: `rec-${suffix}`, passed: false, failOpen: false,
        result: { passed: false, findings: [{ severity: 'error' }] }, advisoryFindings: [],
      }),
      [`nax-out/finish-audit/${feature}/${runId}.result.json`]: JSON.stringify({
        feature, status: 'escalated', escalationReason: 'quality review omitted WALK', branch: `feat/${feature}`,
        headSha: 'abc1234', url: prUrl, rounds: [],
      }),
    };
  }

  test('an escalated finish shows as ESCALATED with its breakdown on the job, Analytics and admin pages', async ({ page }) => {
    test.setTimeout(150_000);
    await runner.heartbeat();
    const jobId = await dispatchRun(token, SLUG, { repoId, feature, maxCostUsd: 3, pinnedRunnerId: runner.id });
    const lease = await runner.acceptAssign(jobId);
    await runner.report(lease, [{ type: 'state', payload: { to: 'RUNNING' } }]);
    await runner.report(lease, [{ type: 'state', payload: { to: 'UPLOADING' } }]);
    await runner.uploadTarBundle(lease, bundle(Date.now() - 60_000));
    await runner.report(lease, [{ type: 'state', payload: { to: 'COMPLETED', exitCode: 0 } }]);
    // D400: the upload's kick ran before the job was terminal; kick again now rather than wait for the 30 s sweeper.
    await call('POST', `/fleet/ingest/jobs/${jobId}/rerun`, token);
    await expect.poll(
      async () => (await call<{ ingest: { status: string } | null }>('GET', `/projects/${SLUG}/fleet/jobs/${jobId}/analytics`, token)).ingest?.status,
      { timeout: 45_000, ...POLL },
    ).toBe('done');

    await webLogin(page);
    await page.goto(`/${SLUG}/fleet/jobs/${jobId}`);
    await waitForHydration(page);
    await expect(page.getByTestId('fleet-job-state')).toHaveAttribute('data-state', 'ESCALATED');
    await expect(page.getByTestId('fleet-job-pr')).toHaveAttribute('href', prUrl);
    await expect(page.getByTestId('fleet-job-analytics')).toBeVisible();
    await expect(page.getByTestId('fleet-job-analytics-corrected')).toBeVisible();
    await expect(page.locator('[data-testid="fleet-job-analytics-stage-row"][data-key="run"]')).toContainText('$0.1200');
    await expect(page.locator('[data-testid="fleet-job-analytics-stage-row"][data-key="review"]')).toContainText('$0.0134');
    await expect(page.getByTestId('fleet-job-analytics-story')).toContainText('US-001');

    await page.goto(`/${SLUG}/fleet/analytics?group=feature`);
    await waitForHydration(page);
    await expect(page.locator(`[data-testid="fleet-analytics-legend-row"][data-key="${feature}"]`)).toContainText('$0.1334', { timeout: 15_000 });
    await expect(page.getByTestId('fleet-analytics-spend-chart').locator('svg').first()).toBeVisible();
    await expect(page.getByTestId('fleet-analytics-costly-stories-table-row').filter({ hasText: feature })).toContainText('$0.1334');

    await page.goto('/admin/fleet/analytics');
    await waitForHydration(page);
    await expect(page.locator(`[data-testid="fleet-ingest-row"][data-job="${jobId}"]`)).toHaveAttribute('data-status', 'done');
  });
});
```

Expected values: the three cost lines sum to 0.13344, shown `$0.1334` (sum before rounding, A7); stage `run` =
0.12 + 0.00004 = `$0.1200`; stage `review` = `$0.0134`.

- [ ] **Step 2: Ask for the database reset consent, then run the E2E**

The run resets `koda_e2e` (`prisma migrate reset --force`). **Ask the user** for consent to reset the `koda_e2e`
test database and wait for the answer. Then:

```bash
cd apps/api && bun run test:db:up
cd ../web && PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION="<the user's exact consent message>" bunx playwright test tests/e2e/fleet-analytics.e2e.spec.ts --reporter=line
```

Expected: `1 passed`. Then the whole fleet suite (it must stay green with the new pages and nav):

```bash
PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION="<the user's exact consent message>" bunx playwright test tests/e2e/fleet-*.e2e.spec.ts --reporter=line
```

Expected: every fleet spec passes (10 tests: the 9 existing plus this one). If the chart `svg` assertion fails only in
`nuxt dev` mode, rerun with `E2E_WEB_MODE=build` after `bunx turbo run build --filter=@nathapp/koda-web` before
concluding anything (dev-mode flakes need a production build).

- [ ] **Step 3: Commit**

```bash
git add apps/web/tests/e2e/fleet-analytics.e2e.spec.ts
git commit -m "test(e2e): fleet analytics from a scripted runner bundle to the pages (S2b slice 2, D400)"
```

---

### Task 13: Docs, full verification, review gate and PR

**Files:**
- Modify: `docs/superpowers/specs/2026-10-04-fleet-s2b-d-analytics-design.md`
- Modify: `.nax/mono/apps/web/context.md`, `.nax/mono/apps/api/context.md`, then regenerate agent files

- [ ] **Step 1: Apply the spec changes**

In the spec:

- §4.2 spend bullet: append "Both spend routes also take `top` (1..12, default 12: series kept before the fold), and
  `totals` carries `medianJobCostUsd`, the median of per-job unrounded spend in the window (plan D388)."
- §4.2: add a bullet after the jobs bullet: "`GET /projects/:slug/fleet/analytics/ingest?from&to` -> `{ window, pending, failed }`:
  ingest rows of the project's jobs finished in the window; `pending` counts pending and running (plan D388)."
- §5.1: replace "through shadcn-vue's chart components (the library shadcn-vue's charts are built on)" with "in two
  thin client-only wrappers (stacked area, line); bar lists, tiles and tables are plain HTML (plan D389)", and
  replace "A categorical palette of at most 12 series plus \"other\" (matches 4.2's top-12 fold)" with "The 8-slot
  categorical palette: the spend chart asks for `top=7`, so at most 7 named series plus \"other\" (plan D390)".
- §5.3: append "The admin page shows spend only (tiles, spend over time, where it goes); quality and the top tables
  are project-only, and delete-on-demand stays API-only (plan D395)."

- [ ] **Step 2: Document the code in the agent context**

In `.nax/mono/apps/web/context.md`, in the route list, add after the `/:project/fleet/jobs/:id/logs` line:

```markdown
- `/:project/fleet/analytics` and `/admin/fleet/analytics` (fleet cost and quality analytics, S2b: window and group in the URL, one panel per query, no polling)
```

and add at the end of the file:

```markdown
## Fleet analytics (S2b)

- Pure logic lives in `lib/fleet-analytics-{types,format,range,chart}.ts`; composables `useFleetAnalytics`,
  `useAnalyticsPanel`, `useRefetchOnVisible`; components in `components/fleet/analytics/` plus
  `components/fleet/JobAnalytics.vue` (the job page section).
- Money arrives as 4-place strings: show it with `usd()` and never sum or re-round it in the browser (A7).
- Charts are `@unovis/vue` in `*.client.vue` wrappers only; Jest cannot mount them, so pages are tested with chart
  stubs. Tooltip HTML goes through `crosshairHtml`/`rateHtml`, which escape every label (keys come from bundles).
- Colors are `--chart-1`..`--chart-8` and `--chart-other` (globals.css, light and dark); `assignSlots` keeps a key's
  color across refetches.
```

In `.nax/mono/apps/api/context.md`, in the `src/fleet/analytics/` bullet, append to its last sentence: " Spend takes
`top` (1..12) and reports `medianJobCostUsd`; `analytics/ingest` counts pending and failed ingests for the project
page notice."

Run (repo root): `nax generate` and then `nax generate --all-packages`. `git status` must show only the two context
files, the spec, and generated agent files (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `codex.md`, `.cursorrules`,
`.windsurfrules`, `.aider.conf.yml`, at the root and under `apps/*`). Never hand-edit a generated file.

- [ ] **Step 3: Full verification**

Run, from the repo root:

```bash
bun run lint -- --force
bun run type-check -- --force
cd apps/api && bun run test:unit && bun run test:db:up && bun run test:scoped test/integration/fleet
cd ../cli && bun run test
cd ../web && bun run test
cd ../.. && bunx turbo run build --filter=@nathapp/koda-web --force
```

Expected: all green (`--force` bypasses the turbo cache, which can replay a stale green). The E2E ran in Task 12;
rerun it only if anything after Task 12 touched `apps/web` or `apps/api`. Fix any failure before continuing
(login-throttle failures: rerun that file alone after a minute).

- [ ] **Step 4: Commit the docs**

```bash
git add docs/superpowers/specs/2026-10-04-fleet-s2b-d-analytics-design.md .nax/mono/apps/web/context.md .nax/mono/apps/api/context.md
git add -u -- AGENTS.md CLAUDE.md GEMINI.md codex.md .cursorrules .windsurfrules .aider.conf.yml 'apps/*/AGENTS.md' 'apps/*/CLAUDE.md' 'apps/*/GEMINI.md' 'apps/*/codex.md' 'apps/*/.cursorrules' 'apps/*/.windsurfrules' 'apps/*/.aider.conf.yml'
git status --short   # must be empty except files unrelated to this branch
git commit -m "docs(fleet): S2b slice 2 spec changes (D388, D389, D390, D395) and agent context"
```

- [ ] **Step 5: Review before push (required)**

Run the `nax-toolkit:post-impl-review` skill with `--phase full` against this spec
(`docs/superpowers/specs/2026-10-04-fleet-s2b-d-analytics-design.md`, §5 and the §6 web and E2E rows), then a code
review of `git diff main...HEAD` (`code-review` skill or the `code-reviewer` agent). Fix CRITICAL and HIGH findings,
at most 2 fix rounds; list anything left in the PR body. Then **stop and ask the user for approval** before pushing.

- [ ] **Step 6: Push and open the PR (after approval)**

```bash
git push -u origin feat/fleet-s2b-analytics-web
gh pr create --title "feat(fleet): S2b slice 2 — analytics web pages, job cost and quality, E2E (D388-D401)" --body "$(cat <<'EOF'
## Summary
- Project Analytics page (`/<project>/fleet/analytics`): window and grouping in the URL, summary tiles, spend over time (unovis, client-only), where it goes by stage and role, quality (first-pass, reviewers, finish outcomes, escalation reasons), top stories and jobs, ingest notice. One panel per query; no polling.
- Admin page (`/admin/fleet/analytics`): cross-project spend and the ingest health table (status filter, paging, Re-run, Backfill, Re-run all).
- Job page "Cost & quality" section once the bundle is ingested; reloads on live events.
- API: spend `top`, `totals.medianJobCostUsd`, `GET analytics/ingest` (D388); OpenAPI and CLI client regenerated.
- Money is shown exactly as the API rounds it (A7); tooltips escape bundle-provided labels (D398); 8-color validated palette, light and dark (D390).

## Test plan
- [ ] API unit + PG integration (median, top, ingest counts, contract)
- [ ] Web unit: lib (format, range, chart), composables, components, both pages, job section, nav, i18n parity
- [ ] Nuxt production build
- [ ] E2E `fleet-analytics.e2e.spec.ts` + the fleet suite
- [ ] After deploy to koda-wk: the 2026-10-04 sandbox jobs show on the Analytics page and their job pages
EOF
)"
```

---

## Self-review notes

- Spec §5.1 (unovis, tokens, palette, ClientOnly, light/dark) -> Tasks 3, 4, 7 (D389, D390). §5.2 page: window
  picker -> Tasks 3, 6, 9; tiles -> Tasks 1, 6, 9 (D393); spend over time + group selector -> Tasks 4, 7, 9; where
  it goes -> Task 9 (D394); quality -> Tasks 4, 7, 9; tables -> Tasks 8, 9; ingest notice -> Tasks 2, 8, 9 (D401);
  empty and per-panel error states -> Tasks 5, 6, 9; refetch on load, window change, tab focus, no polling -> Tasks
  5, 9. §5.3 admin -> Task 11 (D395, D397). §5.4 job section -> Task 10 (D396). §5.5 i18n and access -> Tasks 6,
  6-11 (aria-labels, data tables, header cells). §6 web and E2E rows -> Tasks 3-12. §7 slice 2 -> this plan.
- Review Focus: 1 -> Tasks 4, 6; 2 -> Tasks 4, 9; 3 -> Task 9; 4 -> Tasks 3, 9; 5 -> Task 10.
- Plan-only: no task code was run while writing this plan; snippets follow the files read on 2026-10-05
  (`b2909436`). The palette was checked with the dataviz validator against the app's surfaces (Task 3 Step 6 note).
