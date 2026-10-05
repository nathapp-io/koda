# Fleet S2b (j) Slice 2 — Story Graph Web Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On a fleet job's page, replace the flat story list with a story dependency graph (Graph | List toggle) and, for RUN jobs, a `Stories -> Acceptance -> Regression -> Finish` stage strip fed by the `postRun` field slice 1 added.

**Architecture:** Pure TypeScript helpers (`lib/fleet-story-graph.ts`, `lib/fleet-story-view.ts`) do all the logic: dependency parsing, longest-path layering with cycle breaking, barycentre ordering, edge geometry, edge/node emphasis, stage-state mapping and view persistence. Four presentational components under `components/fleet/story-graph/` render it: HTML node cards in flex columns, an SVG edge overlay drawn from measured node boxes after mount, a chip strip, and a wrapper that owns the toggle. The job page swaps `<FleetJobStories>` for `<FleetJobPipeline>`; live updates keep flowing through the page's existing debounced job reload.

**Tech Stack:** Nuxt 3 + Vue 3.5 (`<script setup>`), Tailwind 3, shadcn-vue `Badge`/`Button`, `lucide-vue-next`, `@nuxtjs/i18n` (en + zh), Jest 29 in node env with the repo's `mountSfc` fake renderer (no DOM), Playwright with the fleet `ScriptedRunner`.

**Spec:** `docs/superpowers/specs/2026-10-05-fleet-s2b-j-story-graph-design.md` (§2 web, §3 web unit + E2E, §4 slice 2, D430-D432). Slice 1 (data, D427-D429, D433-D438) merged as #219 `bcf72345`: `FleetJobDto.postRun` is already served by `GET /projects/:slug/fleet/jobs/:id`.

## Global Constraints

- Branch: `feat/fleet-s2b-story-graph-web` (cut from main `bcf72345`; it holds this plan). Never switch branches during execution.
- No API, CLI, runner or protocol change. `apps/web/**` and docs only.
- The web has no generated client: wire types are hand-written in `apps/web/lib/fleet-types.ts`.
- Layout (D430): longest-path layering + one barycentre pass; cycles broken by iterative DFS back edges; never throws on bad data; O(V + E). 100 stories x 10 deps lays out well under 5 ms.
- Edges (D431) are drawn client-side from measured node boxes; SSR and the Jest harness render nodes without edges.
- View choice (D432) persisted per browser in `localStorage` key `koda.fleet.storyView`, best-effort: every storage access is wrapped in try/catch and the page works without it.
- Default view: Graph at the Tailwind `md` breakpoint (`(min-width: 768px)`) and wider, List below.
- Stage values (D429) are nax strings: known ones (`not-run`, `running`, `passed`, `failed`, `skipped`) map to translated states (`not-run` -> `pending`); any other string is shown raw on an `outline` badge.
- Live updates only through the existing path (snapshot -> `fleet_job` live event -> 300 ms debounced `reloadSilently()` in the job page). No new stream, no polling, no timer.
- Agent-written text (story ids, titles, raw stage values) is rendered with `{{ }}` interpolation only, never `v-html`.
- Tailwind does not scan `apps/web/lib/`: every class string lives in a `.vue` file. Lib helpers return semantic values (`'dim'`, `'active'`, badge variant names), never class names.
- i18n: every new key in both `apps/web/i18n/locales/en.json` and `zh.json`; no `|` or `@` in any value under `fleet` (`tests/i18n/fleet-locale-parity.spec.ts`). Subtrees rendered through dynamic keys are pinned in that spec's `ENUMS` map.
- No emojis; no `console.log` in `apps/web` sources; build new objects and arrays, never mutate inputs or props (local accumulators inside a pure function are fine).
- Web lint runs with `--max-warnings=0`; `bun run type-check` (`nuxt typecheck`) must pass. `*.spec.ts` files are excluded from type-check but still linted.
- E2E resets the `koda_e2e` database (`prisma migrate reset`). Prisma refuses that from an AI agent without the user's consent: **ask the user first**, then run with `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION="<their exact consent message>"`.
- Every snippet names real files and helpers. If a name in a snippet does not exist in the code, that is a plan defect: stop and report it.

## Review Focus

- **Bad dependency data from a real PRD** (a cycle `US-002 <-> US-003`, a dependency on a story cut by truncation, a duplicate id): the graph still renders every received story, drops only the offending edge, and the affected node says "Depends on X (not shown)" or "(cycle, not drawn)". Pinned in Task 2 (layout table) and Task 4 (node notes).
- **Private browsing / blocked storage** (`localStorage` getter or `setItem` throws): the toggle still switches views and the default still follows the viewport. Pinned in Task 5 (throwing storage mount test).
- **A later snapshot that changes the story set** (a story decomposed into new ids, or the list grows): no edge may point at a box of a story that is gone. `edgePaths` drops an edge whose endpoint has no measured box, and edges always come from the current layout. Pinned in Task 2 (`edgePaths` test) and Task 7 (E2E second snapshot).
- **A PRD where every story is `decomposed`, `skipped` or `regression-failed` next to `passed` ones**: the Stories chip must read Passed, not sit at Pending forever (D442). An unknown future story status keeps the chip below Passed. Pinned in Task 3.
- **A terminal job whose runner never sent `postRun`** (an older runner, or a crash before post-run): later stages read Unknown, not Pending; an active job without it reads Pending. Pinned in Task 3.

## Decisions (D439-D447)

Numbered from D439 (slice 1 ended at D438).

| # | Decision | Why |
|:--|:--|:--|
| D439 | `StoryRow` gains `dependsOn: string[]`: non-empty strings only, de-duplicated in first-seen order, the story's own id removed. `storyRows()` stays the single parse for list and graph. | Spec §2.1. A self-reference never reaches the layout. |
| D440 | The view toggle is two `Button`s with `aria-pressed` inside `role="group"`, not a `radix-vue` toggle group. **Spec §2.2 correction.** | The repo ships no toggle-group primitive (`components/ui/` has none) and `RangePicker.vue` already uses this exact pattern; the Jest harness stubs `Button` but cannot drive radix internals. |
| D441 | Before mount the view is `null`: both views render, Graph wrapped in `hidden md:block` and List in `md:hidden`, so SSR and hydration agree and the first paint already matches the viewport. On mount the view becomes the stored choice, else `matchMedia('(min-width: 768px)')`, else stays `null`. Only an explicit click writes storage. | Spec §2.2 default "Graph at md+, List below" without a hydration mismatch or a flash of the wrong view. |
| D442 | The Stories chip counts `passed`, `skipped`, `decomposed` and `regression-failed` as done. `failed` anywhere -> `failed`; all done -> `passed`; active job with any `in-progress` -> `running`; else `pending`. **Spec §2.1 refinement** (spec listed `passed`/`skipped` only). | A decomposed parent's work is carried by its children, so a PRD with one would never read Passed; a `regression-failed` story passed its own gates and its failure belongs to the Regression chip. Other unknown statuses still count as not done. |
| D443 | Section heading and the truncation note move from `FleetJobStories.vue` to `FleetJobPipeline.vue` (shared by both views); `FleetJobStories` becomes the List view, takes `rows: StoryRow[]` and keeps its `fleet-job-stories` / `fleet-job-story` test ids. | One heading and one "showing N" note whichever view is on. |
| D444 | Layout, geometry and emphasis are pure helpers: `layoutStoryGraph`, `edgePath`, `edgePaths`, `neighbourhood`. Components only measure DOM boxes and map semantic emphasis to classes. | Spec §2.1; the harness has no DOM, so logic must be testable without one. |
| D445 | Nodes carry `data-status` and `data-emphasis` in addition to the spec's `data-story`, `data-column`, `data-current`; edges carry `data-testid="fleet-story-edge"`, `data-from`, `data-to`, `data-active`. | E2E asserts status flips and edge highlight without reading classes. |
| D446 | Node `aria-label`: "`{id} {title}. {status}. Depends on {deps}.`" (or "`No dependencies.`"); each column is an `<ol>` labelled "Step n"; the edge `<svg>` is `aria-hidden`. | Spec success criterion 6. |
| D447 | E2E `tests/e2e/fleet-story-graph.e2e.spec.ts`: a pinned RUN job, five stories (diamond US-001 -> US-002, US-003 -> US-004, plus isolated root US-005), US-002 `in-progress`, `postRun.acceptance: running`; asserts columns, edges, focus highlight, strip states, toggle, then a second snapshot (US-002 passed, US-003 current) updates the page without a navigation (`window.__noReload` marker, as `fleet-dispatch.e2e.spec.ts`). | Spec §3 E2E. Keyed on the job id, immune to other specs' data. |

## File Structure

| File | Responsibility |
|---|---|
| `apps/web/lib/fleet-types.ts` (modify) | `FleetJobPostRunDto`, `FleetJobDto.postRun` |
| `apps/web/lib/fleet-jobs.ts` (modify) | `StoryRow.dependsOn`, `dependsOnOf()` |
| `apps/web/lib/fleet-story-graph.ts` (create) | `layoutStoryGraph`, `edgePath`, `edgePaths`, `neighbourhood`, `pipelineStages`, types |
| `apps/web/lib/fleet-story-view.ts` (create) | `StoryView`, `STORY_VIEW_KEY`, `readStoryView`, `writeStoryView`, `wideViewport`, `initialStoryView` |
| `apps/web/components/fleet/story-graph/StoryNode.vue` (create) | one focusable node card |
| `apps/web/components/fleet/story-graph/StoryGraph.vue` (create) | columns, measurement, SVG edges, hover/focus emphasis |
| `apps/web/components/fleet/story-graph/PipelineStrip.vue` (create) | four stage chips |
| `apps/web/components/fleet/story-graph/FleetJobPipeline.vue` (create) | heading, toggle, strip, selected view, truncation note |
| `apps/web/components/fleet/FleetJobStories.vue` (modify) | List view: `rows` prop, "depends on" line |
| `apps/web/pages/[project]/fleet/jobs/[id]/index.vue` (modify) | swap the component |
| `apps/web/i18n/locales/en.json`, `zh.json` (modify) | `fleet.jobs.detail.pipeline.*` |
| `apps/web/tests/lib/fleet-jobs.spec.ts` (modify) | `dependsOn` parse |
| `apps/web/tests/lib/fleet-story-graph.spec.ts`, `tests/lib/fleet-story-view.spec.ts` (create) | helper tables |
| `apps/web/tests/components/fleet-story-graph.spec.ts` (create) | StoryGraph / StoryNode mount tests |
| `apps/web/tests/components/fleet-job-pipeline.spec.ts` (create) | FleetJobPipeline / PipelineStrip mount tests |
| `apps/web/tests/components/fleet-job-stories.spec.ts` (modify) | List view on `rows` |
| `apps/web/tests/pages/fleet-job-detail.spec.ts` (modify) | page wiring |
| `apps/web/tests/i18n/fleet-locale-parity.spec.ts` (modify) | `ENUMS` pins |
| `apps/web/tests/e2e/fleet-story-graph.e2e.spec.ts` (create) | E2E |
| `.nax/mono/apps/web/context.md`, generated `apps/web/{CLAUDE,AGENTS,GEMINI,codex}.md`, `docs/ux/redesign/MASTER-PLAN.md`, the spec (modify) | docs |

Test commands (run from `apps/web`): `bunx jest <path>`; lint `bunx eslint <files> --max-warnings=0`.

---

### Task 1: Wire type and `dependsOn` parse

**Files:**
- Modify: `apps/web/lib/fleet-types.ts` (after `export interface FleetJobStoryDto {...}`; inside `FleetJobDto` after `storiesTruncated: boolean`)
- Modify: `apps/web/lib/fleet-jobs.ts:87-126` (`StoryRow`, `storyRows`)
- Test: `apps/web/tests/lib/fleet-jobs.spec.ts` (`job()` fixture line 28; `describe('storyRows')`)

**Interfaces:**
- Produces: `FleetJobPostRunDto { acceptance?: string; regression?: string; finish?: string }`; `FleetJobDto.postRun: FleetJobPostRunDto | null`; `StoryRow.dependsOn: string[]` (Tasks 2-7 rely on it).

- [ ] **Step 1: Write the failing tests**

In `apps/web/tests/lib/fleet-jobs.spec.ts`, in the `job()` fixture, change `stories: null, storiesTruncated: false,` to `stories: null, storiesTruncated: false, postRun: null,`.

In the `describe('storyRows', ...)` block, change the expected junk row (the line that expects `{ id: 'US-9', title: '', status: 'pending', attempts: 0, current: false, phase: null, variant: 'outline' }`) to:

```ts
      { id: 'US-9', title: '', status: 'pending', attempts: 0, current: false, phase: null, variant: 'outline', dependsOn: [] },
```

and add at the end of the same `describe`:

```ts
  test('dependsOn keeps non-empty string ids once each, in order, never the story itself (D439)', () => {
    const odd = [
      { id: 'US-001', title: 'a', status: 'passed', attempts: 1, dependsOn: [] },
      { id: 'US-002', title: 'b', status: 'pending', attempts: 0, dependsOn: ['US-001', 'US-001', '', 7, null, 'US-002', 'US-404'] },
      { id: 'US-003', title: 'c', status: 'pending', attempts: 0, dependsOn: 'US-001' },
      { id: 'US-004', title: 'd', status: 'pending', attempts: 0 },
    ] as unknown as FleetJobDto['stories']
    expect(storyRows(job({ stories: odd })).map(r => [r.id, r.dependsOn])).toEqual([
      ['US-001', []],
      ['US-002', ['US-001', 'US-404']],
      ['US-003', []],
      ['US-004', []],
    ])
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/web && bunx jest tests/lib/fleet-jobs.spec.ts`
Expected: FAIL: the junk-row `toEqual` reports a missing `dependsOn`, and the new test reports `undefined` dependsOn values.

- [ ] **Step 3: Implement**

In `apps/web/lib/fleet-types.ts`, directly after the closing `}` of `export interface FleetJobStoryDto`, add:

```ts
/** S2b (j): nax post-run stage statuses (`postRun.<stage>.status`), each at most 32 printable ASCII; null when unknown. */
export interface FleetJobPostRunDto {
  acceptance?: string
  regression?: string
  finish?: string
}
```

In `FleetJobDto`, after `storiesTruncated: boolean`, add:

```ts
  /** S2b (j) D433: null when unknown and on list pages. */
  postRun: FleetJobPostRunDto | null
```

In `apps/web/lib/fleet-jobs.ts`, add to `StoryRow` after `variant: ...`:

```ts
  /** S2b (j) D439: ids this story waits on; strings only, de-duplicated, never itself. */
  dependsOn: string[]
```

Directly above `/** S1b §1.4: the job page's story checklist. ...` add:

```ts
/** D439: the PRD's dependsOn as clean ids; anything that is not a non-empty string is dropped. */
const dependsOnOf = (value: unknown, self: string): string[] =>
  Array.isArray(value)
    ? [...new Set(value.filter((dep): dep is string => typeof dep === 'string' && dep.length > 0 && dep !== self))]
    : []
```

and in `storyRows`, after `variant: STORY_VARIANTS[status] ?? 'outline',` add:

```ts
      dependsOn: dependsOnOf(s.dependsOn, id),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/web && bunx jest tests/lib/fleet-jobs.spec.ts tests/components/fleet-job-stories.spec.ts`
Expected: PASS (the stories component still reads `storyRows(props.job)` until Task 5).

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/fleet-types.ts apps/web/lib/fleet-jobs.ts apps/web/tests/lib/fleet-jobs.spec.ts
git commit -m "feat(web): story dependsOn parse and postRun wire type (S2b j, D439)"
```

---

### Task 2: Graph layout and edge geometry

**Files:**
- Create: `apps/web/lib/fleet-story-graph.ts`
- Test: `apps/web/tests/lib/fleet-story-graph.spec.ts`

**Interfaces:**
- Consumes: `StoryRow` from `~/lib/fleet-jobs` (Task 1).
- Produces:
  - `interface StoryEdge { from: string; to: string }` (from = dependency, to = dependent)
  - `interface UnresolvedDep { story: string; dep: string; reason: 'unknown' | 'cycle' }`
  - `interface StoryGraphLayout { columns: StoryRow[][]; edges: StoryEdge[]; unresolved: UnresolvedDep[] }`
  - `layoutStoryGraph(rows: readonly StoryRow[]): StoryGraphLayout`
  - `interface Box { x: number; y: number; width: number; height: number }`
  - `interface EdgePath extends StoryEdge { d: string }`
  - `edgePath(from: Box, to: Box): string`
  - `edgePaths(edges: readonly StoryEdge[], boxes: Readonly<Record<string, Box>>): EdgePath[]`
  - `neighbourhood(edges: readonly StoryEdge[], activeId: string | null): ReadonlySet<string> | null`

- [ ] **Step 1: Write the failing tests**

Create `apps/web/tests/lib/fleet-story-graph.spec.ts`:

```ts
import { describe, test, expect } from '@jest/globals'
import { edgePath, edgePaths, layoutStoryGraph, neighbourhood } from '~/lib/fleet-story-graph'
import type { StoryRow } from '~/lib/fleet-jobs'

const row = (id: string, dependsOn: string[] = []): StoryRow => ({
  id, title: id, status: 'pending', attempts: 0, current: false, phase: null, variant: 'outline', dependsOn,
})
const ids = (columns: StoryRow[][]): string[][] => columns.map(column => column.map(r => r.id))

describe('layoutStoryGraph (D430)', () => {
  test('no rows give an empty layout', () => {
    expect(layoutStoryGraph([])).toEqual({ columns: [], edges: [], unresolved: [] })
  })

  test('linear chain: one story per column', () => {
    const layout = layoutStoryGraph([row('A'), row('B', ['A']), row('C', ['B'])])
    expect(ids(layout.columns)).toEqual([['A'], ['B'], ['C']])
    expect(layout.edges).toEqual([{ from: 'A', to: 'B' }, { from: 'B', to: 'C' }])
    expect(layout.unresolved).toEqual([])
  })

  test('diamond and isolated roots: column = 1 + deepest dependency', () => {
    const layout = layoutStoryGraph([row('A'), row('B', ['A']), row('C', ['A']), row('D', ['B', 'C']), row('E')])
    expect(ids(layout.columns)).toEqual([['A', 'E'], ['B', 'C'], ['D']])
    expect(layout.edges).toHaveLength(4)
  })

  test('a story sits right of its DEEPEST dependency, not its first', () => {
    const layout = layoutStoryGraph([row('A'), row('B', ['A']), row('C', ['A', 'B'])])
    expect(ids(layout.columns)).toEqual([['A'], ['B'], ['C']])
  })

  test('fan-in and fan-out', () => {
    expect(ids(layoutStoryGraph([row('A'), row('B'), row('C'), row('D', ['A', 'B', 'C'])]).columns)).toEqual([['A', 'B', 'C'], ['D']])
    expect(ids(layoutStoryGraph([row('A'), row('B', ['A']), row('C', ['A']), row('D', ['A'])]).columns)).toEqual([['A'], ['B', 'C', 'D']])
  })

  test('a dependency on an unknown id is reported, not drawn', () => {
    const layout = layoutStoryGraph([row('A'), row('B', ['A', 'GONE'])])
    expect(ids(layout.columns)).toEqual([['A'], ['B']])
    expect(layout.edges).toEqual([{ from: 'A', to: 'B' }])
    expect(layout.unresolved).toEqual([{ story: 'B', dep: 'GONE', reason: 'unknown' }])
  })

  test('a 2-cycle is broken at the back edge and every story still renders', () => {
    const layout = layoutStoryGraph([row('A', ['B']), row('B', ['A'])])
    expect(layout.columns.flat().map(r => r.id).sort()).toEqual(['A', 'B'])
    expect(layout.edges).toHaveLength(1)
    expect(layout.unresolved).toEqual([{ story: 'B', dep: 'A', reason: 'cycle' }])
  })

  test('a 3-cycle is broken once', () => {
    const layout = layoutStoryGraph([row('A', ['C']), row('B', ['A']), row('C', ['B'])])
    expect(layout.columns.flat()).toHaveLength(3)
    expect(layout.edges).toHaveLength(2)
    expect(layout.unresolved.filter(u => u.reason === 'cycle')).toHaveLength(1)
  })

  test('a self-loop that reaches the layout is treated as a cycle', () => {
    const layout = layoutStoryGraph([row('A', ['A'])])
    expect(ids(layout.columns)).toEqual([['A']])
    expect(layout.edges).toEqual([])
    expect(layout.unresolved).toEqual([{ story: 'A', dep: 'A', reason: 'cycle' }])
  })

  test('duplicate ids: the first occurrence wins', () => {
    const first = { ...row('A'), title: 'first' }
    const layout = layoutStoryGraph([first, { ...row('A'), title: 'second' }, row('B', ['A'])])
    expect(layout.columns.flat().map(r => r.title)).toEqual(['first', 'B'])
  })

  test('barycentre: a column is ordered by the mean position of its dependencies', () => {
    // PRD order puts C (depends on B) before D (depends on A); A sits above B, so D goes first.
    const layout = layoutStoryGraph([row('A'), row('B'), row('C', ['B']), row('D', ['A'])])
    expect(ids(layout.columns)).toEqual([['A', 'B'], ['D', 'C']])
  })

  test('barycentre ties keep PRD order', () => {
    expect(ids(layoutStoryGraph([row('A'), row('C', ['A']), row('B', ['A'])]).columns)).toEqual([['A'], ['C', 'B']])
  })

  test('the input rows are not mutated', () => {
    const rows = [row('A', ['B']), row('B', ['A'])]
    const before = JSON.stringify(rows)
    layoutStoryGraph(rows)
    expect(JSON.stringify(rows)).toBe(before)
  })

  test('100 stories x 10 dependencies lay out well under 5 ms (median of 20 runs)', () => {
    const rows = Array.from({ length: 100 }, (_, i) =>
      row(`US-${i}`, Array.from({ length: Math.min(i, 10) }, (_, k) => `US-${i - k - 1}`)))
    const times = Array.from({ length: 20 }, () => {
      const start = performance.now()
      layoutStoryGraph(rows)
      return performance.now() - start
    }).sort((a, b) => a - b)
    expect(times[10]).toBeLessThan(5)
    expect(layoutStoryGraph(rows).columns).toHaveLength(100)
  })
})

describe('edge geometry (D431, D444)', () => {
  const a = { x: 0, y: 0, width: 100, height: 40 }
  const b = { x: 200, y: 60, width: 100, height: 40 }

  test('a cubic from the right middle of the dependency to the left middle of the dependent', () => {
    expect(edgePath(a, b)).toBe('M 100 20 C 150 20, 150 80, 200 80')
  })

  test('close columns still bend by at least 24 px', () => {
    expect(edgePath(a, { x: 120, y: 0, width: 100, height: 40 })).toBe('M 100 20 C 124 20, 96 20, 120 20')
  })

  test('an edge whose endpoint has no measured box is dropped', () => {
    const paths = edgePaths([{ from: 'A', to: 'B' }, { from: 'A', to: 'GONE' }], { A: a, B: b })
    expect(paths).toEqual([{ from: 'A', to: 'B', d: 'M 100 20 C 150 20, 150 80, 200 80' }])
  })
})

describe('neighbourhood', () => {
  const edges = [{ from: 'A', to: 'B' }, { from: 'B', to: 'C' }, { from: 'X', to: 'Y' }]

  test('nothing active means no emphasis', () => {
    expect(neighbourhood(edges, null)).toBeNull()
  })

  test('the active story plus its direct dependencies and dependents', () => {
    expect([...(neighbourhood(edges, 'B') ?? [])].sort()).toEqual(['A', 'B', 'C'])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/web && bunx jest tests/lib/fleet-story-graph.spec.ts`
Expected: FAIL with `Cannot find module '~/lib/fleet-story-graph'`.

- [ ] **Step 3: Implement**

Create `apps/web/lib/fleet-story-graph.ts`:

```ts
import type { StoryRow } from '~/lib/fleet-jobs'

/** `from` is the dependency, `to` the story that waits on it. */
export interface StoryEdge {
  from: string
  to: string
}

export interface UnresolvedDep {
  story: string
  dep: string
  reason: 'unknown' | 'cycle'
}

export interface StoryGraphLayout {
  /** Column 0 holds the roots. */
  columns: StoryRow[][]
  edges: StoryEdge[]
  unresolved: UnresolvedDep[]
}

const edgeKey = (story: string, dep: string): string => `${story}\u0000${dep}`

interface Frame {
  id: string
  next: number
}

/**
 * D430: an iterative DFS in PRD order. A dependency that is still on the stack closes a cycle; that back edge is cut
 * and reported. A story's column is fixed when it leaves the stack, after all its remaining dependencies did.
 */
function assignColumns(
  stories: readonly StoryRow[],
  depsOf: ReadonlyMap<string, readonly string[]>,
): { columnOf: Map<string, number>; cut: Set<string>; cycles: UnresolvedDep[] } {
  const state = new Map<string, 'open' | 'done'>()
  const columnOf = new Map<string, number>()
  const cut = new Set<string>()
  const cycles: UnresolvedDep[] = []
  for (const root of stories) {
    if (state.has(root.id)) continue
    const stack: Frame[] = [{ id: root.id, next: 0 }]
    state.set(root.id, 'open')
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]
      const deps = depsOf.get(frame.id) ?? []
      if (frame.next < deps.length) {
        const dep = deps[frame.next]
        stack[stack.length - 1] = { id: frame.id, next: frame.next + 1 }
        const seen = state.get(dep)
        if (seen === 'open') {
          cut.add(edgeKey(frame.id, dep))
          cycles.push({ story: frame.id, dep, reason: 'cycle' })
        }
        else if (seen === undefined) {
          state.set(dep, 'open')
          stack.push({ id: dep, next: 0 })
        }
        continue
      }
      stack.pop()
      state.set(frame.id, 'done')
      const depColumns = deps.filter(dep => !cut.has(edgeKey(frame.id, dep))).map(dep => columnOf.get(dep) ?? 0)
      columnOf.set(frame.id, depColumns.length === 0 ? 0 : 1 + Math.max(...depColumns))
    }
  }
  return { columnOf, cut, cycles }
}

/** D430: longest-path layering, then one barycentre pass per column, left to right. Never throws. */
export function layoutStoryGraph(rows: readonly StoryRow[]): StoryGraphLayout {
  const byId = new Map<string, StoryRow>()
  for (const row of rows) {
    if (!byId.has(row.id)) byId.set(row.id, row)
  }
  const stories = [...byId.values()]
  const prdIndex = new Map(stories.map((story, index) => [story.id, index]))
  const depsOf = new Map(stories.map(story => [story.id, story.dependsOn.filter(dep => byId.has(dep))]))
  const unknown: UnresolvedDep[] = stories.flatMap(story =>
    story.dependsOn.filter(dep => !byId.has(dep)).map(dep => ({ story: story.id, dep, reason: 'unknown' as const })))

  const { columnOf, cut, cycles } = assignColumns(stories, depsOf)
  const liveDeps = (id: string): string[] => (depsOf.get(id) ?? []).filter(dep => !cut.has(edgeKey(id, dep)))
  const edges = stories.flatMap(story => liveDeps(story.id).map(dep => ({ from: dep, to: story.id })))

  const width = stories.length === 0 ? 0 : 1 + Math.max(...stories.map(story => columnOf.get(story.id) ?? 0))
  const layered = Array.from({ length: width }, (_, column) => stories.filter(story => columnOf.get(story.id) === column))
  const columns = layered.reduce<StoryRow[][]>((placed, column) => {
    if (placed.length === 0) return [column]
    const position = new Map(placed.flatMap(col => col.map((story, index) => [story.id, index] as const)))
    const weight = (story: StoryRow): number => {
      const positions = liveDeps(story.id).map(dep => position.get(dep) ?? 0)
      return positions.length === 0 ? 0 : positions.reduce((sum, p) => sum + p, 0) / positions.length
    }
    const order = (story: StoryRow): number => prdIndex.get(story.id) ?? 0
    return [...placed, [...column].sort((a, b) => weight(a) - weight(b) || order(a) - order(b))]
  }, [])

  return { columns, edges, unresolved: [...unknown, ...cycles] }
}

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

export interface EdgePath extends StoryEdge {
  d: string
}

const round = (n: number): number => Math.round(n * 10) / 10

/** A cubic from the dependency's right middle to the dependent's left middle; bends by at least 24 px. */
export function edgePath(from: Box, to: Box): string {
  const sx = from.x + from.width
  const sy = from.y + from.height / 2
  const ex = to.x
  const ey = to.y + to.height / 2
  const dx = Math.max(24, (ex - sx) / 2)
  return `M ${round(sx)} ${round(sy)} C ${round(sx + dx)} ${round(sy)}, ${round(ex - dx)} ${round(ey)}, ${round(ex)} ${round(ey)}`
}

/** D431: only edges whose two ends were measured; a story that left the layout draws nothing. */
export function edgePaths(edges: readonly StoryEdge[], boxes: Readonly<Record<string, Box>>): EdgePath[] {
  return edges.flatMap((edge) => {
    const from = boxes[edge.from]
    const to = boxes[edge.to]
    return from && to ? [{ ...edge, d: edgePath(from, to) }] : []
  })
}

/** The focused or hovered story with its direct dependencies and dependents; null when nothing is active. */
export function neighbourhood(edges: readonly StoryEdge[], activeId: string | null): ReadonlySet<string> | null {
  if (activeId === null) return null
  const linked = edges.flatMap((edge) => {
    if (edge.from === activeId) return [edge.to]
    if (edge.to === activeId) return [edge.from]
    return []
  })
  return new Set([activeId, ...linked])
}
```

Note the 2-cycle expectation: DFS starts at A (PRD first), descends to its dependency B, whose dependency A is still open, so the cut edge is `B -> A` (`{ story: 'B', dep: 'A' }`), B lands in column 0 and A in column 1.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/web && bunx jest tests/lib/fleet-story-graph.spec.ts`
Expected: PASS (all).

- [ ] **Step 5: Lint and commit**

```bash
cd apps/web && bunx eslint lib/fleet-story-graph.ts tests/lib/fleet-story-graph.spec.ts --max-warnings=0 && cd ../..
git add apps/web/lib/fleet-story-graph.ts apps/web/tests/lib/fleet-story-graph.spec.ts
git commit -m "feat(web): story graph layout and edge geometry helpers (S2b j, D430 D431 D444)"
```

---

### Task 3: Stage strip mapping and view persistence helpers

**Files:**
- Modify: `apps/web/lib/fleet-story-graph.ts` (append)
- Create: `apps/web/lib/fleet-story-view.ts`
- Test: `apps/web/tests/lib/fleet-story-graph.spec.ts` (append), `apps/web/tests/lib/fleet-story-view.spec.ts` (create)

**Interfaces:**
- Consumes: `storyRows`, `isActiveJobState`, `StoryRow` from `~/lib/fleet-jobs`; `FleetJobDto` from `~/lib/fleet-types` (Task 1).
- Produces:
  - `type StageKey = 'stories' | 'acceptance' | 'regression' | 'finish'`; `STAGE_KEYS: readonly StageKey[]`
  - `KNOWN_STAGE_STATES = ['pending', 'running', 'passed', 'failed', 'skipped', 'unknown'] as const`
  - `interface PipelineStage { key: StageKey; state: string; known: boolean; variant: StoryRow['variant'] }`
  - `pipelineStages(job: Pick<FleetJobDto, 'command' | 'state' | 'postRun' | 'stories' | 'currentStoryId' | 'currentPhase'>): PipelineStage[]`
  - `type StoryView = 'graph' | 'list'`; `STORY_VIEW_KEY = 'koda.fleet.storyView'`; `WIDE_QUERY = '(min-width: 768px)'`
  - `readStoryView(): StoryView | null`; `writeStoryView(view: StoryView): void`; `wideViewport(): boolean | null`; `initialStoryView(stored: StoryView | null, wide: boolean | null): StoryView | null`

- [ ] **Step 1: Write the failing tests**

Append to `apps/web/tests/lib/fleet-story-graph.spec.ts` (and add `pipelineStages` to its import from `~/lib/fleet-story-graph`, plus `import type { FleetJobDto } from '~/lib/fleet-types'`):

```ts
describe('pipelineStages (spec §2.1, D442)', () => {
  type StageJob = Parameters<typeof pipelineStages>[0]
  const story = (id: string, status: string) => ({ id, title: id, status, attempts: 1, dependsOn: [] })
  const run = (over: Partial<StageJob> = {}): StageJob => ({
    command: 'RUN', state: 'RUNNING', postRun: null, currentStoryId: null, currentPhase: null,
    stories: [story('US-001', 'passed'), story('US-002', 'in-progress')], ...over,
  })
  const states = (job: StageJob): string[][] => pipelineStages(job).map(s => [s.key, s.state])

  test('PLAN jobs have no strip', () => {
    expect(pipelineStages(run({ command: 'PLAN' }))).toEqual([])
  })

  test('an active RUN with a story in progress and no postRun yet', () => {
    expect(states(run())).toEqual([['stories', 'running'], ['acceptance', 'pending'], ['regression', 'pending'], ['finish', 'pending']])
  })

  test('postRun values map: not-run -> pending, known values kept', () => {
    const job = run({ postRun: { acceptance: 'passed', regression: 'running', finish: 'not-run' } })
    expect(states(job).slice(1)).toEqual([['acceptance', 'passed'], ['regression', 'running'], ['finish', 'pending']])
    expect(pipelineStages(job).map(s => s.variant)).toEqual(['secondary', 'default', 'secondary', 'outline'])
  })

  test('an unknown nax value is kept raw and marked unknown to the copy', () => {
    const stage = pipelineStages(run({ postRun: { finish: 'escalated' } }))[3]
    expect(stage).toEqual({ key: 'finish', state: 'escalated', known: false, variant: 'outline' })
  })

  test('a terminal job without postRun reads unknown, not pending', () => {
    expect(states(run({ state: 'COMPLETED' })).slice(1).map(([, s]) => s)).toEqual(['unknown', 'unknown', 'unknown'])
  })

  test('Stories: any failed story fails the stage', () => {
    expect(states(run({ stories: [story('US-001', 'passed'), story('US-002', 'failed')] }))[0]).toEqual(['stories', 'failed'])
  })

  test('Stories: passed, skipped, decomposed and regression-failed all count as done (D442)', () => {
    const done = [story('A', 'passed'), story('B', 'skipped'), story('C', 'decomposed'), story('D', 'regression-failed')]
    expect(states(run({ stories: done }))[0]).toEqual(['stories', 'passed'])
  })

  test('Stories: an unknown story status is not done', () => {
    expect(states(run({ state: 'COMPLETED', stories: [story('A', 'passed'), story('B', 'mystery')] }))[0]).toEqual(['stories', 'pending'])
  })

  test('Stories: in-progress on a terminal job is not running', () => {
    expect(states(run({ state: 'CANCELLED' }))[0]).toEqual(['stories', 'pending'])
  })

  test('no story list keeps the Stories chip pending', () => {
    expect(states(run({ stories: null }))[0]).toEqual(['stories', 'pending'])
  })

  test('typed on the real DTO', () => {
    const dto = { command: 'RUN', state: 'QUEUED', postRun: null, stories: null, currentStoryId: null, currentPhase: null } as unknown as FleetJobDto
    expect(pipelineStages(dto)).toHaveLength(4)
  })
})
```

Create `apps/web/tests/lib/fleet-story-view.spec.ts`:

```ts
import { afterEach, describe, test, expect } from '@jest/globals'
import { initialStoryView, readStoryView, STORY_VIEW_KEY, wideViewport, writeStoryView } from '~/lib/fleet-story-view'

type Patch = Record<string, unknown>
const originals = new Map<string, PropertyDescriptor | undefined>()

/** Replaces a global for one test; afterEach restores the exact original descriptor. */
function setGlobal(name: string, value: unknown): void {
  if (!originals.has(name)) originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
}

afterEach(() => {
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete (globalThis as Patch)[name]
  }
  originals.clear()
})

const memoryStorage = (initial: Record<string, string> = {}) => {
  const data = new Map(Object.entries(initial))
  return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v) } }
}
const throwingStorage = {
  getItem: () => { throw new Error('SecurityError') },
  setItem: () => { throw new Error('QuotaExceededError') },
}

describe('story view persistence (D432)', () => {
  test('reads only the two known values', () => {
    setGlobal('localStorage', memoryStorage({ [STORY_VIEW_KEY]: 'list' }))
    expect(readStoryView()).toBe('list')
    setGlobal('localStorage', memoryStorage({ [STORY_VIEW_KEY]: 'kanban' }))
    expect(readStoryView()).toBeNull()
  })

  test('writes under koda.fleet.storyView', () => {
    const storage = memoryStorage()
    setGlobal('localStorage', storage)
    writeStoryView('graph')
    expect(storage.data.get('koda.fleet.storyView')).toBe('graph')
  })

  test('throwing or missing storage is ignored', () => {
    setGlobal('localStorage', throwingStorage)
    expect(readStoryView()).toBeNull()
    expect(() => writeStoryView('list')).not.toThrow()
    setGlobal('localStorage', undefined)
    expect(readStoryView()).toBeNull()
  })

  test('wideViewport asks the md media query; null without matchMedia', () => {
    const queries: string[] = []
    setGlobal('matchMedia', (q: string) => { queries.push(q); return { matches: true } })
    expect(wideViewport()).toBe(true)
    expect(queries).toEqual(['(min-width: 768px)'])
    setGlobal('matchMedia', undefined)
    expect(wideViewport()).toBeNull()
    setGlobal('matchMedia', () => { throw new Error('boom') })
    expect(wideViewport()).toBeNull()
  })

  test('initial view: stored choice, else by width, else undecided', () => {
    expect(initialStoryView('list', true)).toBe('list')
    expect(initialStoryView(null, true)).toBe('graph')
    expect(initialStoryView(null, false)).toBe('list')
    expect(initialStoryView(null, null)).toBeNull()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/web && bunx jest tests/lib/fleet-story-graph.spec.ts tests/lib/fleet-story-view.spec.ts`
Expected: FAIL: `pipelineStages` is not exported; `Cannot find module '~/lib/fleet-story-view'`.

- [ ] **Step 3: Implement**

In `apps/web/lib/fleet-story-graph.ts`, change the import line to:

```ts
import { isActiveJobState, storyRows } from '~/lib/fleet-jobs'
import type { StoryRow } from '~/lib/fleet-jobs'
import type { FleetJobDto } from '~/lib/fleet-types'
```

and append:

```ts
export type StageKey = 'stories' | 'acceptance' | 'regression' | 'finish'
export const STAGE_KEYS: readonly StageKey[] = ['stories', 'acceptance', 'regression', 'finish']
/** Translated under fleet.jobs.detail.pipeline.state; any other value is nax text shown raw (D429). */
export const KNOWN_STAGE_STATES = ['pending', 'running', 'passed', 'failed', 'skipped', 'unknown'] as const

export interface PipelineStage {
  key: StageKey
  state: string
  known: boolean
  variant: StoryRow['variant']
}

const STAGE_VARIANTS: Readonly<Record<string, StoryRow['variant']>> = {
  passed: 'default',
  running: 'secondary',
  failed: 'destructive',
}

/** D442: statuses whose story work is finished as far as the Stories stage is concerned. */
const STORY_DONE: ReadonlySet<string> = new Set(['passed', 'skipped', 'decomposed', 'regression-failed'])

function storiesState(rows: readonly StoryRow[], active: boolean): string {
  if (rows.some(row => row.status === 'failed')) return 'failed'
  if (rows.length > 0 && rows.every(row => STORY_DONE.has(row.status))) return 'passed'
  if (active && rows.some(row => row.status === 'in-progress')) return 'running'
  return 'pending'
}

function postRunState(value: unknown, active: boolean): string {
  if (typeof value !== 'string' || value.length === 0) return active ? 'pending' : 'unknown'
  return value === 'not-run' ? 'pending' : value
}

type StageJob = Pick<FleetJobDto, 'command' | 'state' | 'postRun' | 'stories' | 'currentStoryId' | 'currentPhase'>

/** Spec §2.1: the RUN strip; PLAN jobs have none. Stale nax values are shown as stored, never inferred. */
export function pipelineStages(job: StageJob): PipelineStage[] {
  if (job.command !== 'RUN') return []
  const active = isActiveJobState(job.state)
  const post = job.postRun ?? {}
  const states: Record<StageKey, string> = {
    stories: storiesState(storyRows(job), active),
    acceptance: postRunState(post.acceptance, active),
    regression: postRunState(post.regression, active),
    finish: postRunState(post.finish, active),
  }
  return STAGE_KEYS.map((key) => {
    const state = states[key]
    return {
      key,
      state,
      known: (KNOWN_STAGE_STATES as readonly string[]).includes(state),
      variant: STAGE_VARIANTS[state] ?? 'outline',
    }
  })
}
```

Create `apps/web/lib/fleet-story-view.ts`:

```ts
/** S2b (j) D432: which view the job page shows; remembered per browser, best effort. */
export type StoryView = 'graph' | 'list'

export const STORY_VIEW_KEY = 'koda.fleet.storyView'
/** Tailwind's `md` breakpoint: Graph from here up, List below (spec §2.2). */
export const WIDE_QUERY = '(min-width: 768px)'

interface StorageLike {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

type BrowserGlobals = { localStorage?: StorageLike; matchMedia?: (query: string) => { matches: boolean } }
const browser = (): BrowserGlobals => globalThis as unknown as BrowserGlobals

export function readStoryView(): StoryView | null {
  try {
    const value = browser().localStorage?.getItem(STORY_VIEW_KEY)
    return value === 'graph' || value === 'list' ? value : null
  }
  catch {
    return null
  }
}

export function writeStoryView(view: StoryView): void {
  try {
    browser().localStorage?.setItem(STORY_VIEW_KEY, view)
  }
  catch {
    // Storage is optional (private mode, blocked site data): the choice lasts for this visit only.
  }
}

/** True at md and wider; null when the environment cannot tell (SSR, tests). */
export function wideViewport(): boolean | null {
  try {
    const matchMedia = browser().matchMedia
    return typeof matchMedia === 'function' ? matchMedia.call(globalThis, WIDE_QUERY).matches : null
  }
  catch {
    return null
  }
}

/** D441: the stored choice wins; otherwise the viewport decides; null leaves the CSS default in place. */
export function initialStoryView(stored: StoryView | null, wide: boolean | null): StoryView | null {
  if (stored !== null) return stored
  if (wide === null) return null
  return wide ? 'graph' : 'list'
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/web && bunx jest tests/lib/fleet-story-graph.spec.ts tests/lib/fleet-story-view.spec.ts`
Expected: PASS.

- [ ] **Step 5: Lint and commit**

```bash
cd apps/web && bunx eslint lib/fleet-story-graph.ts lib/fleet-story-view.ts tests/lib/fleet-story-graph.spec.ts tests/lib/fleet-story-view.spec.ts --max-warnings=0 && cd ../..
git add apps/web/lib/fleet-story-graph.ts apps/web/lib/fleet-story-view.ts apps/web/tests/lib/fleet-story-graph.spec.ts apps/web/tests/lib/fleet-story-view.spec.ts
git commit -m "feat(web): pipeline stage mapping and story view persistence (S2b j, D432 D441 D442)"
```

---

### Task 4: i18n keys, StoryNode and StoryGraph

**Files:**
- Modify: `apps/web/i18n/locales/en.json`, `apps/web/i18n/locales/zh.json` (inside `fleet.jobs.detail`, after the `stories` object)
- Modify: `apps/web/tests/i18n/fleet-locale-parity.spec.ts` (`ENUMS`)
- Create: `apps/web/components/fleet/story-graph/StoryNode.vue`
- Create: `apps/web/components/fleet/story-graph/StoryGraph.vue`
- Test: `apps/web/tests/components/fleet-story-graph.spec.ts`

**Interfaces:**
- Consumes: `layoutStoryGraph`, `edgePaths`, `neighbourhood`, `StoryGraphLayout`, `UnresolvedDep`, `Box`, `EdgePath` (Task 2); `StoryRow` (Task 1); `codeLabel` from `~/lib/fleet-i18n`.
- Produces:
  - `StoryGraph.vue` props `{ layout: StoryGraphLayout }`; root `div[data-testid="fleet-story-graph"]` (`overflow-x-auto`).
  - `StoryNode.vue` props `{ row: StoryRow; column: number; notes: readonly UnresolvedDep[]; emphasis: 'normal' | 'active' | 'dim' }`, emits `activate: [id: string | null]`; root `li[data-testid="fleet-story-node"]` with `data-story`, `data-column`, `data-current`, `data-status`, `data-emphasis` (D445).
  - i18n keys under `fleet.jobs.detail.pipeline` (used by Task 5 too).

- [ ] **Step 1: Add the i18n keys**

In `apps/web/i18n/locales/en.json`, replace

```json
          "truncated": "List truncated: showing the first {count} stories."
        },
        "cancelRequested": "Cancel requested at {at}",
```

with

```json
          "truncated": "List truncated: showing the first {count} stories."
        },
        "pipeline": {
          "title": "Run pipeline",
          "graphLabel": "Story dependency graph",
          "column": "Step {n}",
          "view": {
            "label": "Story view",
            "graph": "Graph",
            "list": "List"
          },
          "stage": {
            "stories": "Stories",
            "acceptance": "Acceptance",
            "regression": "Regression",
            "finish": "Finish"
          },
          "state": {
            "pending": "Pending",
            "running": "Running",
            "passed": "Passed",
            "failed": "Failed",
            "skipped": "Skipped",
            "unknown": "Unknown"
          },
          "dependsOn": "Depends on {ids}",
          "notShown": "Depends on {id} (not shown)",
          "cycle": "Depends on {id} (cycle, not drawn)",
          "nodeLabel": "{id} {title}. {status}. Depends on {deps}.",
          "nodeLabelRoot": "{id} {title}. {status}. No dependencies."
        },
        "cancelRequested": "Cancel requested at {at}",
```

In `apps/web/i18n/locales/zh.json`, replace

```json
          "truncated": "列表已截断：仅显示前 {count} 个故事。"
        },
        "cancelRequested": "已于 {at} 请求取消",
```

with

```json
          "truncated": "列表已截断：仅显示前 {count} 个故事。"
        },
        "pipeline": {
          "title": "运行流水线",
          "graphLabel": "故事依赖图",
          "column": "第 {n} 步",
          "view": {
            "label": "故事视图",
            "graph": "图",
            "list": "列表"
          },
          "stage": {
            "stories": "故事",
            "acceptance": "验收",
            "regression": "回归",
            "finish": "收尾"
          },
          "state": {
            "pending": "待处理",
            "running": "运行中",
            "passed": "已通过",
            "failed": "失败",
            "skipped": "已跳过",
            "unknown": "未知"
          },
          "dependsOn": "依赖：{ids}",
          "notShown": "依赖 {id}（未显示）",
          "cycle": "依赖 {id}（循环依赖，未绘制）",
          "nodeLabel": "{id} {title}。{status}。依赖：{deps}。",
          "nodeLabelRoot": "{id} {title}。{status}。无依赖。"
        },
        "cancelRequested": "已于 {at} 请求取消",
```

In `apps/web/tests/i18n/fleet-locale-parity.spec.ts`, inside `ENUMS`, after the `'fleet.dashboard.attention.condition.credential': [...]` line, add:

```ts
  'fleet.jobs.detail.pipeline.stage': ['stories', 'acceptance', 'regression', 'finish'],
  'fleet.jobs.detail.pipeline.state': ['pending', 'running', 'passed', 'failed', 'skipped', 'unknown'],
  'fleet.jobs.detail.pipeline.view': ['label', 'graph', 'list'],
```

Run: `cd apps/web && bunx jest tests/i18n`
Expected: PASS (parity, enum pins, no `|`/`@`).

- [ ] **Step 2: Write the failing component tests**

Create `apps/web/tests/components/fleet-story-graph.spec.ts`:

```ts
import { describe, test, expect } from '@jest/globals'
import { nextTick } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'
import { layoutStoryGraph } from '~/lib/fleet-story-graph'
import type { StoryRow } from '~/lib/fleet-jobs'

const file = webFile('components', 'fleet', 'story-graph', 'StoryGraph.vue')
const row = (id: string, dependsOn: string[] = [], over: Partial<StoryRow> = {}): StoryRow => ({
  id, title: `Title ${id}`, status: 'pending', attempts: 0, current: false, phase: null, variant: 'outline', dependsOn, ...over,
})
const diamond = [
  row('US-001', [], { status: 'passed', variant: 'default', attempts: 1 }),
  row('US-002', ['US-001'], { status: 'in-progress', variant: 'secondary', current: true, phase: 'implement', attempts: 2 }),
  row('US-003', ['US-001']),
  row('US-004', ['US-002', 'US-003', 'US-999']),
  row('US-005'),
]
const mount = (rows: StoryRow[] = diamond) =>
  mountSfc(file, { props: { layout: layoutStoryGraph(rows) }, globals: { useI18n: enI18n }, components: uiStubs })
const nodes = (app: ReturnType<typeof mount>) => app.find('[data-testid="fleet-story-node"]')
const nodeOf = (app: ReturnType<typeof mount>, id: string) => nodes(app).find(n => n.props['data-story'] === id)

describe('StoryGraph (spec §2.2)', () => {
  test('one column per layer, in layout order', () => {
    const app = mount()
    expect(nodes(app).map(n => [n.props['data-story'], n.props['data-column']])).toEqual([
      ['US-001', '0'], ['US-005', '0'], ['US-002', '1'], ['US-003', '1'], ['US-004', '2'],
    ])
    expect(app.find('ol').map(ol => ol.props['aria-label'])).toEqual(['Step 1', 'Step 2', 'Step 3'])
    app.unmount()
  })

  test('the container scrolls horizontally on its own and is labelled', () => {
    const app = mount()
    const root = app.one('[data-testid="fleet-story-graph"]')
    expect(String(root?.props.class)).toContain('overflow-x-auto')
    expect(root?.props['aria-label']).toBe('Story dependency graph')
    app.unmount()
  })

  test('a node shows id, title, translated status, attempts and, when current, the phase', () => {
    const app = mount()
    const current = nodeOf(app, 'US-002')
    expect(current).toBeDefined()
    const text = app.textOf(current!)
    for (const part of ['US-002', 'Title US-002', 'In progress', 'Attempts: 2', 'Now: implement']) expect(text).toContain(part)
    expect(current!.props['data-current']).toBe('true')
    expect(current!.props['aria-current']).toBe('step')
    expect(current!.props['data-status']).toBe('in-progress')
    expect(nodeOf(app, 'US-003')!.props['aria-current']).toBeUndefined()
    expect(app.find('[data-testid="fleet-story-node-phase"]')).toHaveLength(1)
    app.unmount()
  })

  test('nodes are focusable and their label names status and dependencies (D446)', () => {
    const app = mount()
    expect(nodeOf(app, 'US-004')!.props.tabindex).toBe('0')
    expect(nodeOf(app, 'US-004')!.props['aria-label']).toBe('US-004 Title US-004. Pending. Depends on US-002, US-003, US-999.')
    expect(nodeOf(app, 'US-001')!.props['aria-label']).toBe('US-001 Title US-001. Passed. No dependencies.')
    app.unmount()
  })

  test('the full title is kept in the title attribute for the 2-line clamp', () => {
    const app = mount()
    const title = app.find('p', nodeOf(app, 'US-003')).find(p => String(p.props.class).includes('line-clamp-2'))
    expect(title?.props.title).toBe('Title US-003')
    app.unmount()
  })

  test('unknown and cyclic dependencies are called out on the node, not drawn', () => {
    const app = mount([...diamond, row('US-006', ['US-007']), row('US-007', ['US-006'])])
    // DFS from US-006 cuts US-007 -> US-006; US-007 lands in column 0, so its note renders before US-004's.
    const notes = app.find('[data-testid="fleet-story-node-note"]')
    expect(notes.map(n => [n.props['data-reason'], app.textOf(n)])).toEqual([
      ['cycle', 'Depends on US-006 (cycle, not drawn)'],
      ['unknown', 'Depends on US-999 (not shown)'],
    ])
    app.unmount()
  })

  test('without a DOM no edges are drawn (D431)', () => {
    const app = mount()
    expect(app.find('[data-testid="fleet-story-edge"]')).toHaveLength(0)
    expect(app.find('svg')).toHaveLength(0)
    app.unmount()
  })

  test('focusing a node keeps its neighbours and dims the rest; blur clears it', async () => {
    const app = mount()
    expect(nodes(app).map(n => n.props['data-emphasis'])).toEqual(['normal', 'normal', 'normal', 'normal', 'normal'])
    ;(nodeOf(app, 'US-002')!.props.onFocus as () => void)()
    await nextTick()
    expect(Object.fromEntries(nodes(app).map(n => [n.props['data-story'], n.props['data-emphasis']]))).toEqual({
      'US-001': 'active', 'US-002': 'active', 'US-003': 'dim', 'US-004': 'active', 'US-005': 'dim',
    })
    ;(nodeOf(app, 'US-002')!.props.onBlur as () => void)()
    await nextTick()
    expect(nodes(app).every(n => n.props['data-emphasis'] === 'normal')).toBe(true)
    app.unmount()
  })

  test('hover works like focus', async () => {
    const app = mount()
    ;(nodeOf(app, 'US-005')!.props.onMouseenter as () => void)()
    await nextTick()
    expect(nodeOf(app, 'US-001')!.props['data-emphasis']).toBe('dim')
    ;(nodeOf(app, 'US-005')!.props.onMouseleave as () => void)()
    await nextTick()
    expect(nodeOf(app, 'US-001')!.props['data-emphasis']).toBe('normal')
    app.unmount()
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd apps/web && bunx jest tests/components/fleet-story-graph.spec.ts`
Expected: FAIL: the SFC file does not exist (`ENOENT ... StoryGraph.vue`).

- [ ] **Step 4: Implement**

Create `apps/web/components/fleet/story-graph/StoryNode.vue`:

```vue
<script setup lang="ts">
import { computed } from 'vue'
import { codeLabel } from '~/lib/fleet-i18n'
import type { StoryRow } from '~/lib/fleet-jobs'
import type { UnresolvedDep } from '~/lib/fleet-story-graph'

const props = defineProps<{
  row: StoryRow
  column: number
  notes: readonly UnresolvedDep[]
  emphasis: 'normal' | 'active' | 'dim'
}>()
const emit = defineEmits<{ activate: [id: string | null] }>()
const { t, te } = useI18n()

const statusLabel = computed(() => codeLabel(t, te, 'fleet.storyStatus', props.row.status))
/** D446: screen readers hear the status and every dependency, since edges are decorative. */
const label = computed(() => {
  const base = { id: props.row.id, title: props.row.title, status: statusLabel.value }
  return props.row.dependsOn.length > 0
    ? t('fleet.jobs.detail.pipeline.nodeLabel', { ...base, deps: props.row.dependsOn.join(', ') })
    : t('fleet.jobs.detail.pipeline.nodeLabelRoot', base)
})
const noteText = (note: UnresolvedDep): string =>
  t(note.reason === 'cycle' ? 'fleet.jobs.detail.pipeline.cycle' : 'fleet.jobs.detail.pipeline.notShown', { id: note.dep })
</script>

<template>
  <li
    tabindex="0"
    class="relative w-56 shrink-0 space-y-1 rounded-md border border-border bg-background p-2 text-sm outline-none transition-opacity focus-visible:ring-2 focus-visible:ring-ring"
    :class="[row.current ? 'ring-2 ring-primary' : '', emphasis === 'dim' ? 'opacity-40' : '']"
    data-testid="fleet-story-node"
    :data-story="row.id"
    :data-column="String(column)"
    :data-current="row.current ? 'true' : 'false'"
    :data-status="row.status"
    :data-emphasis="emphasis"
    :aria-current="row.current ? 'step' : undefined"
    :aria-label="label"
    @focus="emit('activate', row.id)"
    @blur="emit('activate', null)"
    @mouseenter="emit('activate', row.id)"
    @mouseleave="emit('activate', null)"
  >
    <div class="flex items-center justify-between gap-2">
      <span class="font-mono text-xs">{{ row.id }}</span>
      <Badge :variant="row.variant">{{ statusLabel }}</Badge>
    </div>
    <p class="line-clamp-2 break-words" :title="row.title">{{ row.title }}</p>
    <p class="text-xs text-muted-foreground">{{ t('fleet.jobs.detail.stories.attempts', { count: row.attempts }) }}</p>
    <p v-if="row.current && row.phase" class="text-xs text-muted-foreground" data-testid="fleet-story-node-phase">
      {{ t('fleet.jobs.detail.stories.phase', { phase: row.phase }) }}
    </p>
    <p
      v-for="note in notes"
      :key="`${note.reason}:${note.dep}`"
      class="text-xs text-muted-foreground"
      data-testid="fleet-story-node-note"
      :data-reason="note.reason"
    >
      {{ noteText(note) }}
    </p>
  </li>
</template>
```

Create `apps/web/components/fleet/story-graph/StoryGraph.vue`:

```vue
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import StoryNode from '~/components/fleet/story-graph/StoryNode.vue'
import { edgePaths, neighbourhood } from '~/lib/fleet-story-graph'
import type { Box, EdgePath, StoryGraphLayout } from '~/lib/fleet-story-graph'

const props = defineProps<{ layout: StoryGraphLayout }>()
const { t } = useI18n()

const wrapEl = ref<HTMLElement | null>(null)
const boxes = ref<Readonly<Record<string, Box>>>({})
const size = ref({ width: 0, height: 0 })
const activeId = ref<string | null>(null)

const paths = computed(() => edgePaths(props.layout.edges, boxes.value))
const near = computed(() => neighbourhood(props.layout.edges, activeId.value))

const notesFor = (id: string) => props.layout.unresolved.filter(note => note.story === id)
const nodeEmphasis = (id: string): 'normal' | 'active' | 'dim' => {
  const set = near.value
  if (set === null) return 'normal'
  return set.has(id) ? 'active' : 'dim'
}
const edgeActive = (edge: EdgePath): boolean =>
  activeId.value !== null && (edge.from === activeId.value || edge.to === activeId.value)
const edgeClass = (edge: EdgePath): string => {
  if (activeId.value === null) return 'stroke-border'
  return edgeActive(edge) ? 'stroke-primary' : 'stroke-border opacity-30'
}

/** D431: edges come from measured node boxes, so they exist only in a browser after mount. */
function measure(): void {
  const wrap = wrapEl.value
  if (!wrap || typeof wrap.getBoundingClientRect !== 'function') return
  const origin = wrap.getBoundingClientRect()
  const nodes = Array.from(wrap.querySelectorAll<HTMLElement>('[data-testid="fleet-story-node"]'))
  boxes.value = Object.fromEntries(nodes.flatMap((el) => {
    const id = el.dataset.story
    if (!id) return []
    const rect = el.getBoundingClientRect()
    return [[id, { x: rect.left - origin.left, y: rect.top - origin.top, width: rect.width, height: rect.height }]]
  }))
  size.value = { width: wrap.scrollWidth, height: wrap.scrollHeight }
}

let observer: ResizeObserver | null = null
onMounted(() => {
  if (typeof ResizeObserver === 'undefined' || !wrapEl.value) return
  observer = new ResizeObserver(() => measure())
  observer.observe(wrapEl.value)
  measure()
})
// A live reload builds a new layout object; status lines can change node heights, so measure again.
watch(() => props.layout, () => { void nextTick(measure) })
onBeforeUnmount(() => observer?.disconnect())
</script>

<template>
  <div class="overflow-x-auto pb-2" data-testid="fleet-story-graph" role="group" :aria-label="t('fleet.jobs.detail.pipeline.graphLabel')">
    <div ref="wrapEl" class="relative inline-flex min-w-full gap-12 p-1">
      <svg
        v-if="paths.length > 0"
        class="pointer-events-none absolute left-0 top-0"
        :width="size.width"
        :height="size.height"
        aria-hidden="true"
        focusable="false"
      >
        <path
          v-for="edge in paths"
          :key="`${edge.from}>${edge.to}`"
          :d="edge.d"
          fill="none"
          stroke-width="1.5"
          :class="edgeClass(edge)"
          data-testid="fleet-story-edge"
          :data-from="edge.from"
          :data-to="edge.to"
          :data-active="edgeActive(edge) ? 'true' : 'false'"
        />
      </svg>
      <ol
        v-for="(column, index) in layout.columns"
        :key="index"
        class="relative flex flex-col justify-center gap-4"
        :aria-label="t('fleet.jobs.detail.pipeline.column', { n: index + 1 })"
      >
        <StoryNode
          v-for="row in column"
          :key="row.id"
          :row="row"
          :column="index"
          :notes="notesFor(row.id)"
          :emphasis="nodeEmphasis(row.id)"
          @activate="activeId = $event"
        />
      </ol>
    </div>
  </div>
</template>
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/web && bunx jest tests/components/fleet-story-graph.spec.ts tests/i18n`
Expected: PASS. If `nodeOf(...)!.props.tabindex` reads a number, the template attribute was written as `:tabindex`; keep it a static `tabindex="0"`.

- [ ] **Step 6: Lint and commit**

```bash
cd apps/web && bunx eslint components/fleet/story-graph/StoryNode.vue components/fleet/story-graph/StoryGraph.vue tests/components/fleet-story-graph.spec.ts tests/i18n/fleet-locale-parity.spec.ts --max-warnings=0 && cd ../..
git add apps/web/i18n/locales/en.json apps/web/i18n/locales/zh.json apps/web/tests/i18n/fleet-locale-parity.spec.ts apps/web/components/fleet/story-graph/StoryNode.vue apps/web/components/fleet/story-graph/StoryGraph.vue apps/web/tests/components/fleet-story-graph.spec.ts
git commit -m "feat(web): story graph and node components with i18n (S2b j, D431 D445 D446)"
```

---

### Task 5: List view, stage strip and the pipeline wrapper

**Files:**
- Modify: `apps/web/components/fleet/FleetJobStories.vue` (whole file)
- Create: `apps/web/components/fleet/story-graph/PipelineStrip.vue`
- Create: `apps/web/components/fleet/story-graph/FleetJobPipeline.vue`
- Modify: `apps/web/tests/components/fleet-job-stories.spec.ts` (whole file)
- Test: `apps/web/tests/components/fleet-job-pipeline.spec.ts` (create)

**Interfaces:**
- Consumes: `storyRows`, `StoryRow` (Task 1); `layoutStoryGraph`, `pipelineStages`, `PipelineStage` (Tasks 2-3); `initialStoryView`, `readStoryView`, `wideViewport`, `writeStoryView`, `StoryView` (Task 3); `StoryGraph.vue` (Task 4).
- Produces: `FleetJobPipeline.vue` props `{ job: FleetJobDto }` (Task 6 mounts it on the page); `FleetJobStories.vue` props `{ rows: readonly StoryRow[] }`; `PipelineStrip.vue` props `{ stages: readonly PipelineStage[] }`. Test ids: `fleet-job-pipeline`, `fleet-story-view-toggle`, `fleet-story-view-graph`, `fleet-story-view-list`, `fleet-pipeline-strip`, `fleet-pipeline-stage` (`data-stage`, `data-state`), `fleet-job-stories-truncated`, `fleet-job-story-deps`.

- [ ] **Step 1: Write the failing tests**

Replace `apps/web/tests/components/fleet-job-stories.spec.ts` with:

```ts
import { describe, test, expect } from '@jest/globals'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'
import { storyRows } from '~/lib/fleet-jobs'
import type { FleetJobDto } from '../../lib/fleet-types'

const file = webFile('components', 'fleet', 'FleetJobStories.vue')
const base = {
  state: 'RUNNING', currentStoryId: 'US-002', currentPhase: 'implement', storiesTruncated: false,
  stories: [
    { id: 'US-001', title: 'Login form', status: 'passed', attempts: 1, dependsOn: [] },
    { id: 'US-002', title: 'Session cookie', status: 'in-progress', attempts: 2, dependsOn: ['US-001'] },
  ],
} as unknown as FleetJobDto
const mount = (over: Partial<FleetJobDto> = {}) =>
  mountSfc(file, { props: { rows: storyRows({ ...base, ...over }) }, globals: { useI18n: enI18n }, components: uiStubs })

describe('FleetJobStories, the List view (S1b §1.4, D443)', () => {
  test('one row per story with title, translated status and attempts', () => {
    const { find, textOf, unmount } = mount()
    const rows = find('[data-testid="fleet-job-story"]')
    expect(rows.map(r => r.props['data-story'])).toEqual(['US-001', 'US-002'])
    expect(textOf(rows[0])).toContain('Login form')
    expect(textOf(rows[0])).toContain('Passed')
    expect(textOf(rows[0])).toContain('Attempts: 1')
    expect(find('[data-stub="badge"]').map(b => b.props.variant)).toEqual(['default', 'secondary'])
    unmount()
  })

  test('highlights the current story with its phase while the job is active', () => {
    const { find, textOf, unmount } = mount()
    expect(find('[data-testid="fleet-job-story"]').map(r => r.props['data-current'])).toEqual(['false', 'true'])
    const phase = find('[data-testid="fleet-job-story-phase"]')
    expect(phase).toHaveLength(1)
    expect(textOf(phase[0])).toContain('implement')
    unmount()
  })

  test('a finished job highlights nothing', () => {
    const { find, unmount } = mount({ state: 'FAILED' })
    expect(find('[data-testid="fleet-job-story"]').map(r => r.props['data-current'])).toEqual(['false', 'false'])
    expect(find('[data-testid="fleet-job-story-phase"]')).toHaveLength(0)
    unmount()
  })

  test('a muted "depends on" line only for stories that have dependencies', () => {
    const { find, textOf, unmount } = mount()
    const deps = find('[data-testid="fleet-job-story-deps"]')
    expect(deps).toHaveLength(1)
    expect(textOf(deps[0])).toBe('Depends on US-001')
    unmount()
  })
})
```

Create `apps/web/tests/components/fleet-job-pipeline.spec.ts`:

```ts
import { afterEach, describe, test, expect } from '@jest/globals'
import { nextTick } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'
import type { FleetJobDto } from '../../lib/fleet-types'

const file = webFile('components', 'fleet', 'story-graph', 'FleetJobPipeline.vue')
const base = {
  command: 'RUN', state: 'RUNNING', currentStoryId: 'US-002', currentPhase: 'implement', storiesTruncated: false,
  postRun: { acceptance: 'running' },
  stories: [
    { id: 'US-001', title: 'Login form', status: 'passed', attempts: 1, dependsOn: [] },
    { id: 'US-002', title: 'Session cookie', status: 'in-progress', attempts: 2, dependsOn: ['US-001'] },
  ],
} as unknown as FleetJobDto

const originals = new Map<string, PropertyDescriptor | undefined>()
function setGlobal(name: string, value: unknown): void {
  if (!originals.has(name)) originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
}
afterEach(() => {
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete (globalThis as Record<string, unknown>)[name]
  }
  originals.clear()
})
const wide = (matches: boolean) => setGlobal('matchMedia', () => ({ matches }))
const memoryStorage = (initial: Record<string, string> = {}) => {
  const data = new Map(Object.entries(initial))
  return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v) } }
}

const mount = async (over: Partial<FleetJobDto> = {}) => {
  const app = mountSfc(file, { props: { job: { ...base, ...over } }, globals: { useI18n: enI18n }, components: uiStubs })
  await nextTick()
  return app
}
const has = (app: Awaited<ReturnType<typeof mount>>, id: string): boolean => app.find(`[data-testid="${id}"]`).length > 0
const click = async (app: Awaited<ReturnType<typeof mount>>, id: string): Promise<void> => {
  (app.one(`[data-testid="${id}"]`)!.props.onClick as () => void)()
  await nextTick()
}

describe('FleetJobPipeline (spec §2.2, D440-D443)', () => {
  test('no story rows: the whole section is hidden', async () => {
    const app = await mount({ stories: null })
    expect(has(app, 'fleet-job-pipeline')).toBe(false)
    app.unmount()
  })

  test('one heading for both views', async () => {
    wide(true)
    const app = await mount()
    expect(app.find('h2').map(h => app.textOf(h))).toEqual(['Stories'])
    app.unmount()
  })

  test('RUN jobs get the four-stage strip; PLAN jobs none', async () => {
    wide(true)
    const run = await mount()
    expect(run.find('[data-testid="fleet-pipeline-stage"]').map(s => [s.props['data-stage'], s.props['data-state']])).toEqual([
      ['stories', 'running'], ['acceptance', 'running'], ['regression', 'pending'], ['finish', 'pending'],
    ])
    expect(run.textOf(run.one('[data-testid="fleet-pipeline-strip"]')!)).toContain('Acceptance')
    run.unmount()
    const plan = await mount({ command: 'PLAN' })
    expect(has(plan, 'fleet-pipeline-strip')).toBe(false)
    expect(has(plan, 'fleet-story-graph')).toBe(true)
    plan.unmount()
  })

  test('an unknown stage value is shown raw', async () => {
    wide(true)
    const app = await mount({ postRun: { finish: 'half-done' } })
    const finish = app.find('[data-testid="fleet-pipeline-stage"]').find(s => s.props['data-stage'] === 'finish')
    expect(app.textOf(finish!)).toContain('half-done')
    app.unmount()
  })

  test('wide viewport defaults to Graph, narrow to List (D441)', async () => {
    wide(true)
    const graph = await mount()
    expect([has(graph, 'fleet-story-graph'), has(graph, 'fleet-job-stories')]).toEqual([true, false])
    expect(graph.one('[data-testid="fleet-story-view-graph"]')!.props['aria-pressed']).toBe(true)
    graph.unmount()
    wide(false)
    const list = await mount()
    expect([has(list, 'fleet-story-graph'), has(list, 'fleet-job-stories')]).toEqual([false, true])
    expect(list.one('[data-testid="fleet-story-view-list"]')!.props['aria-pressed']).toBe(true)
    list.unmount()
  })

  test('before the viewport is known both views render and CSS picks one (SSR, D441)', async () => {
    const app = await mount()
    expect(String(app.one('[data-testid="fleet-story-graph"]')!.props.class)).toContain('hidden md:block')
    expect(String(app.one('[data-testid="fleet-job-stories"]')!.props.class)).toContain('md:hidden')
    app.unmount()
  })

  test('the stored choice beats the viewport', async () => {
    wide(true)
    setGlobal('localStorage', memoryStorage({ 'koda.fleet.storyView': 'list' }))
    const app = await mount()
    expect([has(app, 'fleet-story-graph'), has(app, 'fleet-job-stories')]).toEqual([false, true])
    app.unmount()
  })

  test('clicking the toggle switches the view and remembers it', async () => {
    wide(true)
    const storage = memoryStorage()
    setGlobal('localStorage', storage)
    const app = await mount()
    await click(app, 'fleet-story-view-list')
    expect([has(app, 'fleet-story-graph'), has(app, 'fleet-job-stories')]).toEqual([false, true])
    expect(storage.data.get('koda.fleet.storyView')).toBe('list')
    await click(app, 'fleet-story-view-graph')
    expect([has(app, 'fleet-story-graph'), has(app, 'fleet-job-stories')]).toEqual([true, false])
    expect(storage.data.get('koda.fleet.storyView')).toBe('graph')
    app.unmount()
  })

  test('throwing storage: the toggle still works (Review Focus)', async () => {
    wide(true)
    setGlobal('localStorage', {
      getItem: () => { throw new Error('SecurityError') },
      setItem: () => { throw new Error('QuotaExceededError') },
    })
    const app = await mount()
    expect(has(app, 'fleet-story-graph')).toBe(true)
    await click(app, 'fleet-story-view-list')
    expect(has(app, 'fleet-job-stories')).toBe(true)
    app.unmount()
  })

  test('the toggle is a labelled button group (D440)', async () => {
    wide(true)
    const app = await mount()
    const group = app.one('[data-testid="fleet-story-view-toggle"]')!
    expect([group.props.role, group.props['aria-label']]).toEqual(['group', 'Story view'])
    app.unmount()
  })

  test('the truncation note shows only when the list was cut, in either view', async () => {
    wide(true)
    const plain = await mount()
    expect(has(plain, 'fleet-job-stories-truncated')).toBe(false)
    plain.unmount()
    const cut = await mount({ storiesTruncated: true })
    expect(cut.textOf(cut.one('[data-testid="fleet-job-stories-truncated"]')!)).toContain('first 2 stories')
    cut.unmount()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/web && bunx jest tests/components/fleet-job-stories.spec.ts tests/components/fleet-job-pipeline.spec.ts`
Expected: FAIL: `FleetJobStories` still reads `props.job` (rows undefined), and `FleetJobPipeline.vue` does not exist.

- [ ] **Step 3: Implement**

Replace `apps/web/components/fleet/FleetJobStories.vue` with:

```vue
<script setup lang="ts">
import { codeLabel } from '~/lib/fleet-i18n'
import type { StoryRow } from '~/lib/fleet-jobs'

/** D443: the List view of FleetJobPipeline; the heading and truncation note live there. */
defineProps<{ rows: readonly StoryRow[] }>()
const { t, te } = useI18n()

const statusLabel = (status: string): string => codeLabel(t, te, 'fleet.storyStatus', status)
</script>

<template>
  <ul class="divide-y divide-border rounded-md border border-border text-sm" data-testid="fleet-job-stories">
    <li
      v-for="row in rows"
      :key="row.id"
      class="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2"
      :class="row.current ? 'bg-muted' : ''"
      data-testid="fleet-job-story"
      :data-story="row.id"
      :data-current="row.current ? 'true' : 'false'"
      :aria-current="row.current ? 'step' : undefined"
    >
      <span class="font-mono text-xs">{{ row.id }}</span>
      <span class="min-w-0 flex-1 break-words">{{ row.title }}</span>
      <span v-if="row.current && row.phase" class="text-xs text-muted-foreground" data-testid="fleet-job-story-phase">{{ t('fleet.jobs.detail.stories.phase', { phase: row.phase }) }}</span>
      <span class="text-xs text-muted-foreground">{{ t('fleet.jobs.detail.stories.attempts', { count: row.attempts }) }}</span>
      <Badge :variant="row.variant">{{ statusLabel(row.status) }}</Badge>
      <span v-if="row.dependsOn.length > 0" class="basis-full text-xs text-muted-foreground" data-testid="fleet-job-story-deps">
        {{ t('fleet.jobs.detail.pipeline.dependsOn', { ids: row.dependsOn.join(', ') }) }}
      </span>
    </li>
  </ul>
</template>
```

Create `apps/web/components/fleet/story-graph/PipelineStrip.vue`:

```vue
<script setup lang="ts">
import { ChevronRight } from 'lucide-vue-next'
import type { PipelineStage } from '~/lib/fleet-story-graph'

defineProps<{ stages: readonly PipelineStage[] }>()
const { t } = useI18n()

/** D429: a value nax may add later is shown as nax wrote it. */
const stateLabel = (stage: PipelineStage): string =>
  stage.known ? t(`fleet.jobs.detail.pipeline.state.${stage.state}`) : stage.state
</script>

<template>
  <ol class="flex flex-wrap items-center gap-2 text-sm" data-testid="fleet-pipeline-strip" :aria-label="t('fleet.jobs.detail.pipeline.title')">
    <li
      v-for="(stage, index) in stages"
      :key="stage.key"
      class="flex items-center gap-2"
      data-testid="fleet-pipeline-stage"
      :data-stage="stage.key"
      :data-state="stage.state"
    >
      <ChevronRight v-if="index > 0" class="h-4 w-4 text-muted-foreground" aria-hidden="true" />
      <span>{{ t(`fleet.jobs.detail.pipeline.stage.${stage.key}`) }}</span>
      <Badge :variant="stage.variant">{{ stateLabel(stage) }}</Badge>
    </li>
  </ol>
</template>
```

Create `apps/web/components/fleet/story-graph/FleetJobPipeline.vue`:

```vue
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import FleetJobStories from '~/components/fleet/FleetJobStories.vue'
import PipelineStrip from '~/components/fleet/story-graph/PipelineStrip.vue'
import StoryGraph from '~/components/fleet/story-graph/StoryGraph.vue'
import { storyRows } from '~/lib/fleet-jobs'
import { layoutStoryGraph, pipelineStages } from '~/lib/fleet-story-graph'
import { initialStoryView, readStoryView, wideViewport, writeStoryView } from '~/lib/fleet-story-view'
import type { StoryView } from '~/lib/fleet-story-view'
import type { FleetJobDto } from '~/lib/fleet-types'

const props = defineProps<{ job: FleetJobDto }>()
const { t } = useI18n()

const rows = computed(() => storyRows(props.job))
const layout = computed(() => layoutStoryGraph(rows.value))
const stages = computed(() => pipelineStages(props.job))
/** D441: null until mounted; meanwhile CSS shows Graph at md+ and List below, so SSR and hydration agree. */
const view = ref<StoryView | null>(null)

onMounted(() => {
  view.value = initialStoryView(readStoryView(), wideViewport())
})

function choose(next: StoryView): void {
  view.value = next
  writeStoryView(next)
}
</script>

<template>
  <section v-if="rows.length > 0" class="space-y-3" data-testid="fleet-job-pipeline">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <h2 class="text-sm font-medium">{{ t('fleet.jobs.detail.stories.title') }}</h2>
      <div class="flex gap-1" role="group" :aria-label="t('fleet.jobs.detail.pipeline.view.label')" data-testid="fleet-story-view-toggle">
        <Button
          size="sm"
          :variant="view === 'graph' ? 'default' : 'outline'"
          :aria-pressed="view === 'graph'"
          data-testid="fleet-story-view-graph"
          @click="choose('graph')"
        >
          {{ t('fleet.jobs.detail.pipeline.view.graph') }}
        </Button>
        <Button
          size="sm"
          :variant="view === 'list' ? 'default' : 'outline'"
          :aria-pressed="view === 'list'"
          data-testid="fleet-story-view-list"
          @click="choose('list')"
        >
          {{ t('fleet.jobs.detail.pipeline.view.list') }}
        </Button>
      </div>
    </div>
    <PipelineStrip v-if="stages.length > 0" :stages="stages" />
    <StoryGraph v-if="view !== 'list'" :layout="layout" :class="view === null ? 'hidden md:block' : ''" />
    <FleetJobStories v-if="view !== 'graph'" :rows="rows" :class="view === null ? 'md:hidden' : ''" />
    <p v-if="job.storiesTruncated" class="text-xs text-muted-foreground" data-testid="fleet-job-stories-truncated">
      {{ t('fleet.jobs.detail.stories.truncated', { count: rows.length }) }}
    </p>
  </section>
</template>
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/web && bunx jest tests/components/fleet-job-stories.spec.ts tests/components/fleet-job-pipeline.spec.ts tests/components/fleet-story-graph.spec.ts`
Expected: PASS. If the class assertions in the "before the viewport is known" test fail because the harness does not merge fallthrough `class` onto the child root, check what `props.class` holds on the child root (it may be an array or object); assert on `JSON.stringify(props.class)` containing the string instead, and do not weaken the behaviour under test.

- [ ] **Step 5: Lint and commit**

```bash
cd apps/web && bunx eslint components/fleet/FleetJobStories.vue components/fleet/story-graph/PipelineStrip.vue components/fleet/story-graph/FleetJobPipeline.vue tests/components/fleet-job-stories.spec.ts tests/components/fleet-job-pipeline.spec.ts --max-warnings=0 && cd ../..
git add apps/web/components/fleet/FleetJobStories.vue apps/web/components/fleet/story-graph/PipelineStrip.vue apps/web/components/fleet/story-graph/FleetJobPipeline.vue apps/web/tests/components/fleet-job-stories.spec.ts apps/web/tests/components/fleet-job-pipeline.spec.ts
git commit -m "feat(web): pipeline strip, graph/list toggle and list view (S2b j, D440-D443)"
```

---

### Task 6: Put the pipeline on the job page

**Files:**
- Modify: `apps/web/pages/[project]/fleet/jobs/[id]/index.vue:10` (import) and `:270` (template)
- Test: `apps/web/tests/pages/fleet-job-detail.spec.ts` (the `renders the story checklist under the progress block` test)

**Interfaces:**
- Consumes: `FleetJobPipeline.vue` (Task 5).

- [ ] **Step 1: Write the failing test**

In `apps/web/tests/pages/fleet-job-detail.spec.ts`, replace the test

```ts
  test('renders the story checklist under the progress block', () => {
    expect(detail).toMatch(/<FleetJobProgress :job="job" \/>\s*<FleetJobStories :job="job" \/>/)
  })
```

with

```ts
  test('renders the story pipeline (graph/list) under the progress block (S2b j, spec J3)', () => {
    expect(detail).toContain("import FleetJobPipeline from '~/components/fleet/story-graph/FleetJobPipeline.vue'")
    expect(detail).toMatch(/<FleetJobProgress :job="job" \/>\s*<FleetJobPipeline :job="job" \/>/)
    expect(detail).not.toContain('FleetJobStories')
  })

  test('the pipeline follows live updates through the existing job reload only', () => {
    expect(liveHandlers(detail)).toContain('if (event.jobId === jobId) liveReload.trigger()')
    expect(detail).toMatch(/async function reloadSilently\(\)[\s\S]*?job\.value = await jobsApi\.get\(jobId\)/)
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web && bunx jest tests/pages/fleet-job-detail.spec.ts`
Expected: FAIL on the new import / tag assertions (the second new test already passes; it pins existing wiring).

- [ ] **Step 3: Implement**

In `apps/web/pages/[project]/fleet/jobs/[id]/index.vue`, replace

```ts
import FleetJobStories from '~/components/fleet/FleetJobStories.vue'
```

with

```ts
import FleetJobPipeline from '~/components/fleet/story-graph/FleetJobPipeline.vue'
```

and replace

```vue
      <FleetJobStories :job="job" />
```

with

```vue
      <FleetJobPipeline :job="job" />
```

- [ ] **Step 4: Run the web suite and type-check**

Run: `cd apps/web && bunx jest && bun run type-check`
Expected: all Jest suites PASS (including `tests/i18n/used-keys-exist.spec.ts`); `nuxt typecheck` reports no error in the changed files. If type-check reports the pre-existing `server/utils/api.ts` auto-import errors noted in `docs/ux/redesign/MASTER-PLAN.md` §3, compare with `git stash && bun run type-check && git stash pop` on main: only new errors block.

- [ ] **Step 5: Lint and commit**

```bash
cd apps/web && bunx eslint "pages/[project]/fleet/jobs/[id]/index.vue" tests/pages/fleet-job-detail.spec.ts --max-warnings=0 && cd ../..
git add "apps/web/pages/[project]/fleet/jobs/[id]/index.vue" apps/web/tests/pages/fleet-job-detail.spec.ts
git commit -m "feat(web): job page shows the story pipeline instead of the flat list (S2b j, J3)"
```

---

### Task 7: E2E with a scripted runner

**Files:**
- Create: `apps/web/tests/e2e/fleet-story-graph.e2e.spec.ts`

**Interfaces:**
- Consumes: `ScriptedRunner`, `Lease` (`tests/e2e/fixtures/scripted-runner.ts`); `call`, `dispatchRun`, `repoIdOf` (`tests/e2e/fixtures/fleet-budgets-api.ts`); `login`, `E2E_ADMIN` (`fixtures/api-client.ts`); `waitForHydration`, `webLogin` (`fixtures/page-helpers.ts`). Seed project `fleet-e2e` with repo `acme/e2e-app` (as `fleet-dashboard.e2e.spec.ts`).

- [ ] **Step 1: Write the E2E spec**

Create `apps/web/tests/e2e/fleet-story-graph.e2e.spec.ts`:

```ts
import { test, expect } from '@playwright/test';
import { login, E2E_ADMIN } from './fixtures/api-client';
import { dispatchRun, repoIdOf } from './fixtures/fleet-budgets-api';
import { waitForHydration, webLogin } from './fixtures/page-helpers';
import { ScriptedRunner } from './fixtures/scripted-runner';
import type { Lease } from './fixtures/scripted-runner';

/**
 * Fleet S2b (j) slice 2 (spec §3 E2E, D447): a pinned RUN job reports a five-story PRD (diamond US-001 -> US-002,
 * US-003 -> US-004, plus the isolated root US-005) with US-002 in progress and acceptance running. The job page draws
 * the graph and the strip; a second snapshot moves the run on and the page follows without a navigation.
 * Every locator is scoped to this job's page, so other specs' data cannot change it.
 */
const SLUG = 'fleet-e2e';

const story = (id: string, status: string, dependsOn: string[] = [], attempts = 0) =>
  ({ id, title: `Story ${id}`, status, attempts, dependsOn });

test.describe('Fleet story graph (scripted runner)', () => {
  let token = '';
  let runner: ScriptedRunner;
  let repoId = '';
  const suffix = Date.now().toString().slice(-6);
  const feature = `graph-${suffix}`;

  test.beforeAll(async () => {
    token = (await login(E2E_ADMIN.email, E2E_ADMIN.password)).token;
    runner = await ScriptedRunner.enroll(token, `e2e-graph-runner-${suffix}`);
    repoId = await repoIdOf(token, SLUG, 'acme/e2e-app');
  });

  test('graph, strip, focus highlight, toggle, and a live status change', async ({ page }) => {
    test.setTimeout(120_000);
    await runner.heartbeat();
    const jobId = await dispatchRun(token, SLUG, { repoId, feature, maxCostUsd: 3, pinnedRunnerId: runner.id });
    const lease: Lease = await runner.acceptAssign(jobId);

    try {
      await runner.report(lease, [
        { type: 'state', payload: { to: 'RUNNING' } },
        {
          type: 'snapshot',
          payload: {
            heartbeatAt: new Date().toISOString(), currentStoryId: 'US-002', currentPhase: 'implement',
            stories: [
              story('US-001', 'passed', [], 1),
              story('US-002', 'in-progress', ['US-001'], 1),
              story('US-003', 'pending', ['US-001']),
              story('US-004', 'pending', ['US-002', 'US-003']),
              story('US-005', 'pending'),
            ],
            postRun: { acceptance: 'running' },
          },
        },
      ]);

      await webLogin(page);
      await page.goto(`/${SLUG}/fleet/jobs/${jobId}`);
      await waitForHydration(page);

      const node = (id: string) => page.locator(`[data-testid="fleet-story-node"][data-story="${id}"]`);
      await expect(page.getByTestId('fleet-story-graph')).toBeVisible({ timeout: 15_000 });
      for (const [id, column] of [['US-001', '0'], ['US-005', '0'], ['US-002', '1'], ['US-003', '1'], ['US-004', '2']]) {
        await expect(node(id)).toHaveAttribute('data-column', column);
      }
      await expect(node('US-002')).toHaveAttribute('data-current', 'true');
      await expect(node('US-002')).toHaveAttribute('aria-current', 'step');
      await expect(node('US-004')).toHaveAttribute('aria-label', /Depends on US-002, US-003/);

      // D431: edges are measured after mount; four dependencies, four paths.
      await expect(page.getByTestId('fleet-story-edge')).toHaveCount(4);

      const stage = (key: string) => page.locator(`[data-testid="fleet-pipeline-stage"][data-stage="${key}"]`);
      await expect(stage('stories')).toHaveAttribute('data-state', 'running');
      await expect(stage('acceptance')).toHaveAttribute('data-state', 'running');
      await expect(stage('regression')).toHaveAttribute('data-state', 'pending');
      await expect(stage('finish')).toHaveAttribute('data-state', 'pending');

      // Focus highlights the node's own edges only.
      await node('US-004').focus();
      await expect(page.locator('[data-testid="fleet-story-edge"][data-active="true"]')).toHaveCount(2);
      await expect(node('US-005')).toHaveAttribute('data-emphasis', 'dim');
      await node('US-004').blur();

      // Toggle to List and back.
      await page.getByTestId('fleet-story-view-list').click();
      await expect(page.getByTestId('fleet-story-graph')).toHaveCount(0);
      await expect(page.locator('[data-testid="fleet-job-story"][data-story="US-004"]')).toContainText('Depends on US-002, US-003');
      await page.getByTestId('fleet-story-view-graph').click();
      await expect(page.getByTestId('fleet-story-graph')).toBeVisible();

      // Live: the next snapshot moves the run on; the page updates in place.
      await page.evaluate(() => { (window as unknown as { __noReload: boolean }).__noReload = true; });
      await runner.report(lease, [
        {
          type: 'snapshot',
          payload: {
            heartbeatAt: new Date().toISOString(), currentStoryId: 'US-003', currentPhase: 'implement',
            stories: [
              story('US-001', 'passed', [], 1),
              story('US-002', 'passed', ['US-001'], 1),
              story('US-003', 'in-progress', ['US-001'], 1),
              story('US-004', 'pending', ['US-002', 'US-003']),
              story('US-005', 'pending'),
            ],
            postRun: { acceptance: 'passed' },
          },
        },
      ]);
      await expect(node('US-002')).toHaveAttribute('data-status', 'passed', { timeout: 15_000 });
      await expect(node('US-003')).toHaveAttribute('data-current', 'true');
      await expect(node('US-002')).toHaveAttribute('data-current', 'false');
      await expect(stage('acceptance')).toHaveAttribute('data-state', 'passed');
      await expect(page.getByTestId('fleet-story-edge')).toHaveCount(4);
      expect(await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload)).toBe(true);
    } finally {
      await runner.report(lease, [
        { type: 'state', payload: { to: 'UPLOADING' } },
        { type: 'state', payload: { to: 'COMPLETED', exitCode: 0 } },
      ]).catch(() => undefined);
    }
  });
});
```

- [ ] **Step 2: Lint and list**

Run: `cd apps/web && bunx eslint tests/e2e/fleet-story-graph.e2e.spec.ts --max-warnings=0 && bunx playwright test tests/e2e/fleet-story-graph.e2e.spec.ts --list`
Expected: lint clean; one test listed.

- [ ] **Step 3: Run it (ask the user first)**

The run resets `koda_e2e`. **Ask the user for consent**, then (test Postgres up: `cd apps/api && bun run test:db:up`):

```bash
cd apps/web && PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION="<the user's exact consent message>" bunx playwright test tests/e2e/fleet-story-graph.e2e.spec.ts --reporter=line
```

Expected: 1 passed. Then the fleet E2E group, to prove the job page change broke no neighbour (`fleet-dispatch.e2e.spec.ts` reads `fleet-job-story` from the progress block):

```bash
PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION="<the user's exact consent message>" bunx playwright test tests/e2e/fleet-*.e2e.spec.ts --reporter=line
```

Expected: all passed. If the edge count stays 0, check in the trace that `ResizeObserver` fired and `[data-testid="fleet-story-node"]` elements are inside `wrapEl`; do not loosen the assertion.

- [ ] **Step 4: Commit**

```bash
git add apps/web/tests/e2e/fleet-story-graph.e2e.spec.ts
git commit -m "test(web): story graph E2E with a scripted runner (S2b j, D447)"
```

---

### Task 8: Docs, full verification, review and hand-off

**Files:**
- Modify: `.nax/mono/apps/web/context.md` (new section after "Fleet overview (S2b (c))")
- Modify (generated): `apps/web/CLAUDE.md`, `apps/web/AGENTS.md`, `apps/web/GEMINI.md`, `apps/web/codex.md`
- Modify: `docs/ux/redesign/MASTER-PLAN.md` (§10 Decisions log)
- Modify: `docs/superpowers/specs/2026-10-05-fleet-s2b-j-story-graph-design.md` (Decisions table)

- [ ] **Step 1: Record the spec corrections**

In the spec's `## Decisions` table, append after the D433 row:

```markdown
| D440 | (slice 2 correction of §2.2) The view toggle is two `Button`s with `aria-pressed` in a `role="group"`, like `RangePicker.vue`; the repo has no toggle-group primitive. |
| D442 | (slice 2 refinement of §2.1) The Stories stage counts `passed`, `skipped`, `decomposed` and `regression-failed` as done. |
```

- [ ] **Step 2: Add the web agent guidance**

In `.nax/mono/apps/web/context.md`, after the "Fleet overview (S2b (c))" section (it ends with the "project scope never shows credential chips" bullet), add:

```markdown
## Fleet story graph (S2b (j))

- The job page renders `components/fleet/story-graph/FleetJobPipeline.vue`: heading, Graph | List toggle, the RUN
  stage strip (`PipelineStrip`), and either `StoryGraph` or the list (`FleetJobStories`). It re-renders from the
  job DTO the page reloads on `fleet_job` live events; it has no stream or timer of its own.
- All logic is pure in `lib/fleet-story-graph.ts` (`layoutStoryGraph`, `edgePaths`, `neighbourhood`,
  `pipelineStages`) and `lib/fleet-story-view.ts` (view persistence, `koda.fleet.storyView`). Keep class names in
  the `.vue` files: Tailwind does not scan `lib/`.
- Edges are measured from DOM boxes after mount (`ResizeObserver`), so Jest mount tests and SSR see nodes only;
  assert edges in E2E (`tests/e2e/fleet-story-graph.e2e.spec.ts`).
- Raw nax values (story statuses, `postRun` stage strings) show through `codeLabel` or as raw text; a new known
  stage state needs its key under `fleet.jobs.detail.pipeline.state` and its pin in
  `tests/i18n/fleet-locale-parity.spec.ts`.
```

- [ ] **Step 3: Log the UX decision**

In `docs/ux/redesign/MASTER-PLAN.md` §10 Decisions log, append a row at the end of the table:

```markdown
| 2026-10-05 | Fleet job page: the flat story list becomes a Graph \| List toggle (Graph default at `md`+, choice kept in `localStorage` `koda.fleet.storyView`) with a RUN stage strip above it | Fleet S2b (j) (spec `docs/superpowers/specs/2026-10-05-fleet-s2b-j-story-graph-design.md` J3); slice 4 (fleet pages) restyles it with the rest |
```

- [ ] **Step 4: Regenerate every agent file**

Run from the repo root: `nax generate && nax generate --all-packages`
Expected: `CLAUDE.md`/`AGENTS.md`/`GEMINI.md`/`codex.md` under `apps/web` change; root files unchanged or metadata-only. Never hand-edit them and never regenerate a single `--package` only. If `nax generate` also writes `.cursorrules`, `.windsurfrules` or `.aider.conf.yml`, commit those too.

- [ ] **Step 5: Full verification**

Run from the repo root:

```bash
bun run lint
bun run type-check
bun run test
cd apps/web && bun run build
```

Expected: everything PASS. No API, CLI or runner file changed, so their test counts match main. Record the web test counts and the Task 7 E2E result for the PR body. Do not mark this done on a red run; fix and re-run.

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/specs/2026-10-05-fleet-s2b-j-story-graph-design.md docs/ux/redesign/MASTER-PLAN.md .nax/mono/apps/web/context.md apps/web/CLAUDE.md apps/web/AGENTS.md apps/web/GEMINI.md apps/web/codex.md
git commit -m "docs(fleet): S2b (j) slice 2 spec corrections, UX log and web agent guidance"
```

Adjust the `git add` list to the files `git status` shows as changed by `nax generate`.

- [ ] **Step 7: Whole-branch review, then hand off (no push without approval)**

Request a whole-branch code review of `main..feat/fleet-s2b-story-graph-web` against the spec (superpowers:requesting-code-review), including the Review Focus list at the top of this plan. Fix Critical and Important findings, at most 2 fix rounds. Then report to the user: test counts, the E2E result, deferred minors, and the proposed PR title `feat(fleet): S2b (j) slice 2 — story graph and pipeline strip on the job page (D439-D447)`. **Do not push or open the PR until the user approves.** After merge, with the user's approval: comment on #206 that the koda-side stage strip is done and per-story phase waits on nax#2356 (spec §4); the koda-wk deploy (`~/koda-wk/scripts/build-images.sh <sha>` then `deploy.sh`) is a separate approved step; no migration ships in this slice.
