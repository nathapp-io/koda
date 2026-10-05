# Fleet S2b (j) — Story Graph and Pipeline View — Design

Builds the third S2b sub-project of the fleet plan: design doc §3 (j), "pipeline/run visualization". S2b order
(ruling A1 of the (d) analytics spec): (d) analytics (done, #210 #213 #214), (c) dashboard (done, #217 #218),
**(j) story graph (this document)**, C9 ticket work products.

## Goal

On a RUN or PLAN job's page, a user sees at a glance where the run is: the PRD's stories as a dependency graph
(what is done, what is running, what is blocked on what) and, for RUN jobs, the run-level pipeline
`Stories -> Acceptance -> Regression -> Finish`. It replaces the flat story list as the default view, and is the base
a later post-mortem view (per-story timings, attempt history) builds on.

## Success criteria

1. A RUN job page shows the stories as a left-to-right layered graph: a story sits one column right of its
   deepest dependency; edges show `dependsOn`; each node shows id, title, status, attempts, and (current story only)
   the nax phase.
2. Above the graph, a RUN job shows a four-stage strip whose acceptance, regression and finish states come from nax's
   `status.json` `postRun` block, as mirrored by the runner.
3. A Graph | List toggle switches to the existing flat list (kept, gains a "depends on" line). Below the `md`
   breakpoint the default is List.
4. Status changes arrive through the existing live-reload path (snapshot -> `fleet_job` live event -> debounced
   reload); no new stream, no polling.
5. Truncated story lists, dependencies on unknown stories and dependency cycles render without error and are
   called out on the affected node.
6. The graph is keyboard and screen-reader usable: nodes are focusable DOM elements with labels that name their
   dependencies; edges are decorative.

## Rulings (user, 2026-10-05)

| # | Ruling |
|---|---|
| J1 | **Live first, post-mortem later** (option C): build the live view now on a graph the post-mortem view can reuse. |
| J2 | **Graph + stage strip, fold in the koda side of #206** (option A): the runner mirrors nax `postRun` stage statuses; whatever nax does not write is a nax issue, filed as **nax#2356** (per-story phase stuck at `routing`, `parallel.activeStories` never written, post-run transitions persisted only on the 60 s heartbeat). |
| J3 | **Replace the flat story list on the job detail page**, with a Graph/List toggle; no new tab or route. |
| J4 | **Hand-rolled layered layout** (approach A): pure TS layout function, HTML node cards, SVG edge overlay. Not Unovis Graph/dagre, not a new library. |

## Ground truth (verified on main `c737717e` and nax main `f3256a7b6`)

- The runner already mirrors PRD stories: `SnapshotStory {id, title, status, attempts, dependsOn}`
  (`packages/fleet-protocol/src/index.ts:90`), at most 100 stories, 10 deps each, 8 KiB, `storiesTruncated` flag;
  stored on `FleetJob.stories Json?` / `storiesTruncated` (`apps/api/prisma/schema.prisma`).
- `currentStoryId` / `currentPhase` come from `status.current` (`apps/runner/src/watcher/status-snapshot.ts`).
- nax sets `current.phase` once, to the literal `"routing"` (`packages/nax/src/execution/iteration-runner.ts:233`),
  and clears `current` between stories; this is the blank-phase symptom of #206. Not fixable in koda (nax#2356).
- nax declares `parallel.activeStories` (`execution/status-file.ts:202`) but never writes it (nax#2356).
- nax writes `postRun.acceptance` / `postRun.regression` `{status: not-run|running|passed|failed|skipped, ...}`
  in memory on each transition; they reach disk on the 60 s heartbeat or the final `update()`. `postRun.finish` is
  persisted at the end since nax#2348 (#2353). So stage states can lag up to 60 s and a short `running` may never be seen.
- The runner reads only `postRun.finish` today (`apps/runner/src/verdict/status-view.ts:15`).
- The runner re-sends a snapshot whenever `JSON.stringify(payload)` changes (`apps/runner/src/watcher/watcher.ts:54`),
  so a new payload field is diffed for free.
- Server-side snapshot validation lives in `apps/api/src/fleet/sync/event-payloads.ts`; a mirrored snapshot emits a
  `fleet_job` live event (`job-report.processor.ts:111`) carrying ids and state only. The job page reloads the job
  DTO on that event (300 ms debounce, `pages/[project]/fleet/jobs/[id]/index.vue:159`).
- The web parses stories via `storyRows()` (`apps/web/lib/fleet-jobs.ts:106`), which today drops `dependsOn`.
- `@unovis/ts` 1.7.1 (with dagre) is installed for analytics charts; not used here (J4).

## Out of scope

- Post-mortem data: per-story start/end times, attempt history, events.jsonl ingestion.
- Parallel lanes / concurrent-story highlighting (needs nax#2356 `parallel.activeStories`).
- Any change to per-story phase mapping: `currentPhase` passes through as today; real phases appear with no koda
  change once nax#2356 ships.
- Graph on the fleet dashboard or job lists; zoom/pan; drag.
- Changes to the timeline's snapshot entries (they ignore the new field).

## 1. Data path (slice 1)

### 1.1 Runner

- `StatusView.postRun` widens to `{ acceptance?: StageView; regression?: StageView; finish?: FinishView }` with
  `StageView = { status?: string }`. `parseStatusView` reads `postRun.acceptance.status` and
  `postRun.regression.status` when they are strings; other fields dropped. `FinishView` unchanged (`status` already read).
- `mapStatusToSnapshot` adds `postRun`: an object with the keys `acceptance`, `regression`, `finish` whose status is a
  string, each clipped with `clip(..., 32)`. Omitted entirely when no key has a status (so "absent = unchanged" holds).
- No other runner change. The watcher's whole-payload key picks the field up.

### 1.2 Protocol

Additive optional field on `SnapshotEventPayload`:

```ts
/** S2b (j): nax post-run stage statuses (`postRun.<stage>.status`), passed through.
 *  Each at most 32 printable ASCII chars. Absent = unchanged. */
postRun?: { acceptance?: string; regression?: string; finish?: string };
```

Older runners never send it. The runner is unreleased (D320 lifted, not yet published), so no version gate.

### 1.3 API

- Migration: `FleetJob.postRun Json?` (nullable, no default, no backfill).
- `event-payloads.ts`: `postRunStages(v)` returns an object with only the known keys whose value matches
  `^[\x20-\x7E]{1,32}$`; returns `undefined` (field ignored) when `v` is not a plain object or no key survives.
  Unknown keys are dropped silently, invalid values drop that key only.
- Mirror semantics match the other snapshot fields: present -> **replace** the stored object (not merge; the runner
  always sends every stage it has a status for); absent -> unchanged.
- **D427:** requeue clears `postRun` to `null`, alongside `stories`, `progress`, `currentPhase` and the other
  per-attempt fields it already resets (`apps/api/src/fleet/jobs/fleet-jobs.service.ts:209-215`, `extra` block),
  so a new attempt never shows the previous attempt's stages. The repository writes `null` as `Prisma.DbNull`, as for
  `stories` (`prisma-fleet-job.repository.ts:113`).
- `FleetJobDomain` / repository types and the mirror field list (`fleet-job.domain.ts:109`) gain `postRun`.
- `FleetJobDto.postRun: FleetJobPostRunDto | null` with three optional string properties; `null` on list pages,
  like `stories` (D149).
- Regenerate `openapi.json`, the web/CLI generated clients, and nax-generated agent docs per repo convention.

## 2. Web (slice 2)

### 2.1 Pure helpers (`apps/web/lib/fleet-story-graph.ts`, no Vue)

- `storyRows()` (`lib/fleet-jobs.ts`) gains `dependsOn: string[]` (strings only, de-duplicated, self-references
  removed). The list and graph share this one parse.
- `layoutStoryGraph(rows: StoryRow[]): StoryGraphLayout`:

  ```ts
  interface StoryGraphLayout {
    columns: StoryRow[][];                       // column 0 = roots
    edges: Array<{ from: string; to: string }>;  // from = dependency, to = dependent
    unresolved: Array<{ story: string; dep: string; reason: 'unknown' | 'cycle' }>;
  }
  ```

  1. Index rows by id (first occurrence wins; duplicate ids after the first are dropped).
  2. Edges to ids not in the index -> `unresolved` (`unknown`).
  3. Cycle breaking: iterative DFS in PRD order; a back edge -> `unresolved` (`cycle`) and removed. Never recursive,
     always terminates.
  4. Column = longest path from a root over the remaining DAG (topological order, `col(s) = 0` if no deps else
     `1 + max(col(dep))`).
  5. Order within a column: PRD order, then one barycentre pass (stable sort by mean row index of the story's
     dependencies in earlier columns; roots keep PRD order).
  6. Complexity O(V + E); 100 stories x 10 deps well under 5 ms (tested).
- `pipelineStages(job): PipelineStage[]` for RUN jobs, `[]` for PLAN:
  - `stories`: `failed` if any story status is `failed`; `passed` if every story is `passed` or `skipped`;
    `running` if the job is active and any story is `in-progress`; else `pending`. Unknown story statuses count as
    not passed.
  - `acceptance` / `regression` / `finish`: `job.postRun?.<stage>` mapped `not-run -> pending`, known values kept,
    unknown strings kept as raw text (`outline` badge). Missing value -> `pending` while the job is active,
    `unknown` once terminal.

### 2.2 Components (`apps/web/components/fleet/story-graph/`, presentational, props only)

| Component | Role |
|---|---|
| `FleetJobPipeline.vue` | Replaces `<FleetJobStories>` on the job page. Hidden when there are no story rows (as today). Holds the Graph \| List toggle (`radix-vue` toggle group; choice in `localStorage` key `koda.fleet.storyView`, wrapped in try/catch, default Graph at `md`+ and List below), the strip, and the selected view. |
| `PipelineStrip.vue` | Four chips joined by arrows, existing `Badge` variants; RUN only. |
| `StoryGraph.vue` | CSS grid, one column per layout column; an absolutely positioned SVG overlay draws edges as cubic paths between node right/left mid-points, measured with `ResizeObserver` on mount and resize. SSR renders nodes only; edges appear on mount. Container scrolls horizontally (`overflow-x-auto`), never the page. Hover/focus on a node highlights its in/out edges and dims the rest. |
| `StoryNode.vue` | Focusable card: id, title (2-line clamp, full title in `title` attr), status badge, attempts, phase line when current, "depends on X (not shown)" note for `unresolved` entries. Current story: ring + `aria-current="step"`. `aria-label` includes status and "depends on US-001, US-003". |
| `FleetJobStories.vue` | Becomes the List view: unchanged plus a muted "depends on ..." line. |

`data-testid`s: `fleet-job-pipeline`, `fleet-pipeline-stage` (`data-stage`, `data-state`), `fleet-story-graph`,
`fleet-story-node` (`data-story`, `data-column`, `data-current`), `fleet-story-view-toggle`; existing list test ids kept.

### 2.3 i18n

New keys under `fleet.jobs.detail.pipeline.*` (title, view toggle labels, stage names, stage states incl. `unknown`,
"depends on", "not shown", cycle note) in every locale file the repo ships, following the existing `codeLabel`
pattern for raw nax values.

### 2.4 Edge cases

| Case | Behaviour |
|---|---|
| No stories (PLAN before `prd.json`, queued job) | Section hidden, as today |
| `storiesTruncated` | Graph of received stories + existing "showing N" note; deps on cut stories -> `unknown` note |
| `postRun` null | Later stages `pending` while active, `unknown` once terminal |
| Stale `postRun` (up to 60 s nax lag) | Shown as stored; no client-side inference |
| Unknown nax status strings | `outline` badge with the raw text |
| Terminal job | No current ring; final statuses only |
| Duplicate story ids | First wins (layout step 1) |

## 3. Testing

- **Runner unit:** `parseStatusView` reads acceptance/regression status, ignores non-string and non-object values;
  `mapStatusToSnapshot` emits `postRun` only when some stage has a status and clips each to 32 chars.
- **API unit:** `postRunStages` table test (non-object, unknown keys, empty string, 33 chars, non-ASCII, mixed
  valid/invalid). **Integration:** snapshot with `postRun` stored; later snapshot without it leaves it; later
  snapshot with it replaces it; job DTO returns it; list DTO returns `null`; requeue clears it (D427).
- **Web unit (Jest):** `layoutStoryGraph` table tests: linear chain, diamond, fan-in, fan-out, isolated nodes,
  unknown dep, self-loop (removed in `storyRows`), 2-cycle, 3-cycle, duplicate ids, 100 stories x 10 deps within a
  time bound; barycentre ordering on a crossing-prone fixture. `pipelineStages` mapping table. `storyRows` dependsOn
  parse. Mount tests: toggle switches view and persists (with throwing `localStorage`), `aria-current`, node
  `aria-label`, edge highlight class on focus.
- **E2E** (`apps/web/tests/e2e/fleet-story-graph.e2e.spec.ts`, existing fleet harness that posts runner snapshots):
  five-story diamond PRD, one story `in-progress`, `postRun.acceptance: running`; asserts `data-column` placement,
  current node, strip states, toggle to List and back; a second snapshot flips the running story to `passed` and the
  graph updates without a page reload.

## 4. Slices

1. **Slice 1 — data** (one PR): protocol field, runner parse + map, migration, API validation + mirror + DTO, OpenAPI
   and client regeneration, docs (runner/protocol notes). Mergeable and deployable alone (nothing reads it yet).
   Deploy order: API first, then runner builds that send it.
2. **Slice 2 — web** (one PR): helpers, components, job-page swap, i18n, E2E, UX MASTER-PLAN log entry. On merge,
   comment on #206: koda-side stage strip done; per-story phase waits on nax#2356.

## Decisions

| # | Decision |
|---|---|
| D427 | Requeue clears `postRun` with the other per-attempt fields. |
| D428 | `postRun` snapshot field **replaces** the stored object when present (no per-key merge). |
| D429 | Stage values are nax strings passed through (≤ 32 printable ASCII); the web maps known values and shows unknown ones raw. |
| D430 | Layout = longest-path layering + one barycentre pass; cycles broken by iterative DFS back edges; never throws on bad data. |
| D431 | Edges are drawn client-side from measured node boxes; SSR shows nodes without edges. |
| D432 | View choice persisted per browser in `localStorage` (`koda.fleet.storyView`), best-effort. |
| D433 | `FleetJobDto.postRun` is `null` on list endpoints, like `stories` (D149). |
| D440 | (slice 2 correction of §2.2) The view toggle is two `Button`s with `aria-pressed` in a `role="group"`, like `RangePicker.vue`; the repo has no toggle-group primitive. |
| D442 | (slice 2 refinement of §2.1) The Stories stage counts `passed`, `skipped`, `decomposed` and `regression-failed` as done. |
